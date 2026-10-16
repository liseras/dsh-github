/**
 * 语义操作层：UI 与 Agent 工具共用的唯一实现。
 *
 * 每条操作返回结构化结果或抛出 GitError，失败带明确原因。
 * 标为 `writes: true` 的操作会改变仓库状态，调用方（UI 或工具）必须先取得用户确认。
 */
import {
  assertRef,
  GitError,
  LOCAL_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
} from './git.js';

/** 操作清单：既是实现注册表，也是 UI 能列出的动作集合。 */
export const OPERATIONS = {
  status: { writes: false, run: opStatus },
  log: { writes: false, run: opLog },
  diff: { writes: false, run: opDiff },
  branches: { writes: false, run: opBranches },
  remotes: { writes: false, run: opRemotes },
  stage: { writes: true, run: opStage },
  unstage: { writes: true, run: opUnstage },
  commit: { writes: true, run: opCommit },
  checkout: { writes: true, run: opCheckout },
  createBranch: { writes: true, run: opCreateBranch },
  fetch: { writes: true, run: opFetch },
  pull: { writes: true, run: opPull },
  push: { writes: true, run: opPush },
  stash: { writes: true, run: opStash },
};

/**
 * 执行一条操作。
 * @param {import('./git.js').GitRunner} git
 * @param {string} root 仓库根
 * @param {string} action
 * @param {Record<string, any>} params
 * @param {{ signal?: AbortSignal, env?: Record<string,string> }} [context]
 */
export async function execute(git, root, action, params = {}, context = {}) {
  const operation = OPERATIONS[action];
  if (!operation) {
    throw new GitError('UNKNOWN_ACTION', `不支持的操作：${action}`);
  }
  // env 通过 runner 的环绕栈生效，这样 operations 里的每个函数都不必
  // 多带一个参数，也就不会出现「某个网络操作漏传 env」的隐蔽失败。
  return git.withEnv(context.env, () => operation.run(git, root, params, context));
}

// ---------------------------------------------------------------- 只读操作

/** 工作区状态：分支、上游、ahead/behind、各区域文件。 */
async function opStatus(git, root) {
  const summary = await git.summary(root);
  return { kind: 'status', ...summary };
}

/**
 * 提交历史。
 * 用 %x00 分隔字段、%x1e 分隔记录，避免提交信息里的换行破坏解析。
 */
async function opLog(git, root, { limit = 30, ref, path } = {}) {
  const max = clampInt(limit, 1, 200, 30);
  const args = [
    'log',
    `--max-count=${max}`,
    '--date=iso-strict',
    '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b%x1e',
  ];
  if (ref !== undefined) args.push(assertRef(ref, 'ref'));
  if (path !== undefined) {
    args.push('--');
    args.push(assertPath(path));
  }
  const result = await git.runOrThrow(root, args);
  const commits = [];
  for (const record of result.stdout.split('\u001e')) {
    const text = record.replace(/^\n/, '');
    if (!text) continue;
    const [hash, short, author, email, date, subject, ...body] = text.split('\u0000');
    commits.push({
      hash,
      short,
      author,
      email,
      date,
      subject,
      body: body.join('\u0000').trim(),
    });
  }
  return { kind: 'log', commits };
}

/**
 * 差异。支持工作区 / 暂存区 / 指定提交范围三种目标。
 * @param {{ target?: 'working'|'staged'|'range', range?: string, path?: string, context?: number }} params
 */
async function opDiff(git, root, { target = 'working', range, path, context: ctxLines } = {}) {
  const args = ['diff', '--no-color'];
  const lines = contextInteger(ctxLines);
  if (lines !== undefined) args.push(`--unified=${lines}`);
  if (target === 'staged') args.push('--cached');
  else if (target === 'range') {
    if (range === undefined) throw new GitError('INVALID_ARGUMENT', 'range 目标需要 range 参数');
    // 形如 base..head 或单个 ref，两段各自校验。
    for (const part of String(range).split('..')) {
      if (part) assertRef(part, 'range');
    }
    args.push(String(range));
  } else if (target !== 'working') {
    throw new GitError('INVALID_ARGUMENT', `未知的 diff 目标：${target}`);
  }
  if (path !== undefined) {
    args.push('--');
    args.push(assertPath(path));
  }
  const result = await git.run(root, args);
  if (result.exitCode !== 0) {
    throw new GitError('GIT_FAILED', result.stderr.trim() || 'git diff 失败');
  }
  return { kind: 'diff', target, text: result.stdout, empty: result.stdout.trim() === '' };
}

/** 本地与远端分支列表。 */
async function opBranches(git, root) {
  const result = await git.runOrThrow(root, [
    'branch',
    '--list',
    '--format=%(refname:short)%00%(objectname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)',
  ]);
  const branches = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, oid, head, upstream, track] = line.split('\u0000');
      return {
        name,
        oid,
        current: head === '*',
        upstream: upstream || null,
        ahead: aheadFrom(track),
        behind: behindFrom(track),
      };
    });
  return { kind: 'branches', branches };
}

/** 远端及其 URL。 */
async function opRemotes(git, root) {
  const result = await git.runOrThrow(root, ['remote', '-v']);
  const remotes = [];
  const seen = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    let entry = seen.get(name);
    if (!entry) {
      entry = { name, fetchUrl: null, pushUrl: null };
      seen.set(name, entry);
      remotes.push(entry);
    }
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return { kind: 'remotes', remotes };
}

// ---------------------------------------------------------------- 写操作

/** 暂存路径；paths 为空时相当于 `git add -A`，需要显式 allowAll。 */
async function opStage(git, root, { paths, all = false } = {}) {
  if (all) {
    await git.runOrThrow(root, ['add', '--all']);
    git.invalidate(root);
    return { kind: 'stage', staged: ['*'] };
  }
  const list = requirePaths(paths);
  await git.runOrThrow(root, ['add', '--', ...list]);
  git.invalidate(root);
  return { kind: 'stage', staged: list };
}

/** 取消暂存。 */
async function opUnstage(git, root, { paths, all = false } = {}) {
  const args = ['restore', '--staged'];
  if (all) {
    // 在无提交的仓库里 HEAD 不存在，reset 需要退回空树。
    const head = await git.run(root, ['rev-parse', '--verify', 'HEAD']);
    if (head.exitCode === 0) args.push('HEAD', '--');
    else args.push('--source=HEAD', '--');
  } else {
    args.push('--');
    args.push(...requirePaths(paths));
  }
  await git.runOrThrow(root, args);
  git.invalidate(root);
  return { kind: 'unstage', unstaged: all ? ['*'] : paths };
}

/** 提交。信息必须非空；不做任何自动生成，避免产生无意义的提交。 */
async function opCommit(git, root, { message, all = false, amend = false } = {}) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new GitError('INVALID_ARGUMENT', '提交信息不能为空');
  }
  const args = ['commit', '--message', message];
  if (all) args.push('--all');
  if (amend) args.push('--amend');
  const result = await git.run(root, args);
  if (result.exitCode !== 0) {
    throw new GitError('GIT_FAILED', result.stderr.trim() || result.stdout.trim() || 'git commit 失败');
  }
  git.invalidate(root);
  const head = await git.run(root, ['rev-parse', '--short', 'HEAD']);
  return {
    kind: 'commit',
    hash: head.exitCode === 0 ? head.stdout.trim() : null,
    output: result.stdout.trim(),
  };
}

/** 切换分支或提交。 */
async function opCheckout(git, root, { ref, create = false } = {}) {
  const target = assertRef(ref, 'ref');
  const args = create ? ['checkout', '-b', target] : ['checkout', target];
  const result = await git.run(root, args);
  if (result.exitCode !== 0) {
    throw new GitError('GIT_FAILED', result.stderr.trim() || 'git checkout 失败');
  }
  git.invalidate(root);
  return { kind: 'checkout', ref: target, created: create };
}

/** 新建分支但不切换（`git branch`，配合 UI 的「仅创建」意图）。 */
async function opCreateBranch(git, root, { name, ref, checkout = true } = {}) {
  const branch = assertRef(name, 'name');
  if (checkout) {
    const args = ['checkout', '-b', branch];
    if (ref !== undefined) args.push(assertRef(ref, 'ref'));
    const result = await git.run(root, args);
    if (result.exitCode !== 0) {
      throw new GitError('GIT_FAILED', result.stderr.trim() || 'git checkout -b 失败');
    }
    git.invalidate(root);
    return { kind: 'createBranch', name: branch, checkedOut: true };
  }
  const args = ['branch', branch];
  if (ref !== undefined) args.push(assertRef(ref, 'ref'));
  await git.runOrThrow(root, args);
  git.invalidate(root);
  return { kind: 'createBranch', name: branch, checkedOut: false };
}

async function opFetch(git, root, { remote = 'origin', prune = false } = {}) {
  const args = ['fetch', assertRemote(remote)];
  if (prune) args.push('--prune');
  const result = await git.run(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new GitError('GIT_FAILED', redact(result.stderr) || 'git fetch 失败');
  }
  return { kind: 'fetch', remote, output: redact(result.stderr.trim()) };
}

/**
 * 拉取。
 * 有意不使用 --rebase/--ff-only 之外的策略：合并策略属于用户偏好，
 * 不该由插件替用户决定；这里只允许快进或明确要求 rebase。
 */
async function opPull(git, root, { remote = 'origin', branch, rebase = false } = {}) {
  const args = ['pull'];
  if (rebase) args.push('--rebase');
  else args.push('--ff-only');
  args.push(assertRemote(remote));
  if (branch !== undefined) args.push(assertRef(branch, 'branch'));
  const result = await git.run(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new GitError('GIT_FAILED', redact(result.stderr) || 'git pull 失败');
  }
  git.invalidate(root);
  return { kind: 'pull', output: redact(result.stdout.trim() || result.stderr.trim()) };
}

/** 推送。首次推送时用 -u 建立上游。 */
async function opPush(git, root, { remote = 'origin', branch, setUpstream = false, force = false } = {}) {
  const args = ['push'];
  if (force) {
    // 只允许 --force-with-lease：裸 --force 会在别人推过之后静默覆盖。
    args.push('--force-with-lease');
  }
  if (setUpstream) args.push('--set-upstream');
  args.push(assertRemote(remote));
  if (branch !== undefined) args.push(assertRef(branch, 'branch'));
  const result = await git.run(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new GitError('GIT_FAILED', redact(result.stderr) || 'git push 失败');
  }
  git.invalidate(root);
  return { kind: 'push', force, output: redact(result.stderr.trim()) };
}

/** 暂存与恢复工作区改动。 */
async function opStash(git, root, { action = 'push', message, index } = {}) {
  if (action === 'push') {
    const args = ['stash', 'push'];
    if (typeof message === 'string' && message.trim() !== '') args.push('--message', message);
    const result = await git.run(root, args);
    if (result.exitCode !== 0) {
      throw new GitError('GIT_FAILED', result.stderr.trim() || 'git stash 失败');
    }
    git.invalidate(root);
    return { kind: 'stash', action, output: result.stdout.trim() };
  }
  if (action === 'pop' || action === 'apply' || action === 'drop') {
    const args = ['stash', action];
    if (index !== undefined) args.push(`stash@{${clampInt(index, 0, 999, 0)}}`);
    const result = await git.run(root, args);
    if (result.exitCode !== 0) {
      throw new GitError('GIT_FAILED', result.stderr.trim() || `git stash ${action} 失败`);
    }
    git.invalidate(root);
    return { kind: 'stash', action, output: result.stdout.trim() };
  }
  if (action === 'list') {
    const result = await git.runOrThrow(root, ['stash', 'list']);
    return { kind: 'stash', action, entries: result.stdout.split('\n').filter(Boolean) };
  }
  throw new GitError('INVALID_ARGUMENT', `未知的 stash 动作：${action}`);
}

// ---------------------------------------------------------------- 参数辅助

/** 从 %(upstream:track) 解析领先数，形如 "[ahead 2, behind 1]" 或 "[gone]"。 */
function aheadFrom(track) {
  const match = /ahead\s+(\d+)/.exec(track ?? '');
  return match ? Number(match[1]) : 0;
}

/** 从 %(upstream:track) 解析落后数。 */
function behindFrom(track) {
  const match = /behind\s+(\d+)/.exec(track ?? '');
  return match ? Number(match[1]) : 0;
}

/** 路径不能是绝对路径，也不能逃出仓库根。 */
function assertPath(value) {
  if (typeof value !== 'string' || value === '') {
    throw new GitError('INVALID_ARGUMENT', '路径不能为空');
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw new GitError('INVALID_ARGUMENT', '只接受仓库内的相对路径');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.includes('..')) {
    throw new GitError('INVALID_ARGUMENT', '路径不能包含 ..');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new GitError('INVALID_ARGUMENT', '路径含控制字符');
  }
  return value;
}

function requirePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GitError('INVALID_ARGUMENT', '需要至少一个路径，或显式传 all');
  }
  return paths.map(assertPath);
}

/** 远端名同样不能被当成选项。 */
function assertRemote(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new GitError('INVALID_ARGUMENT', '非法的远端名');
  }
  return value;
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function contextInteger(value) {
  if (value === undefined) return undefined;
  return clampInt(value, 0, 100, undefined);
}

/**
 * git 的远端 URL 里可能内嵌凭据（https://user:token@host）。
 * 任何要回给模型或写进日志的文本都先过一遍，避免 token 泄漏到会话记录里。
 */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/(gh[pousr]_[A-Za-z0-9]{16,})/g, '***');
}

/** 提交信息里的 author/email 也可能带凭据式内容，统一出口脱敏。 */
export { LOCAL_TIMEOUT_MS };
