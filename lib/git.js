/**
 * Git 操作层：把 git 命令封装成结构化结果。
 *
 * 设计约束：
 * - 不拼接 shell 字符串。所有命令以 argv 数组交给 ctx.subprocess.spawn，
 *   用户输入的路径/分支/提交信息永远作为独立参数，避免注入。
 * - 只读命令（status/log/diff/branch 等）与写命令（add/commit/checkout/push...）
 *   分开导出，写命令由上层做确认。
 * - git 的退出码非 0 不一定代表失败（例如 `git diff --quiet`），
 *   所以返回结构里同时给出 exitCode 与 stdout/stderr，让调用方判断。
 */

/** 单次 git 调用允许的最大输出字节数；超出由 provider 截断并给出 spill 路径。 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 默认超时：本地 git 命令通常很快，网络命令另有更长的超时。 */
export const LOCAL_TIMEOUT_MS = 20_000;
export const NETWORK_TIMEOUT_MS = 120_000;

/**
 * 参数校验：git 接受的 ref 名不允许以 '-' 开头，否则会被当作选项解析。
 * 这是防止「把 `--upload-pack=...` 当分支名传进来」这类选项注入的关键检查。
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
export function assertRef(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitError('INVALID_ARGUMENT', `${label} 不能为空`);
  }
  if (value.length > 512) {
    throw new GitError('INVALID_ARGUMENT', `${label} 过长`);
  }
  if (value.startsWith('-')) {
    throw new GitError('INVALID_ARGUMENT', `${label} 不能以 '-' 开头`);
  }
  // 控制字符会破坏 git 的输出解析，且没有任何合法用途。
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new GitError('INVALID_ARGUMENT', `${label} 含控制字符`);
  }
  return value;
}

/** 供上层区分「参数错误」「不是仓库」「git 缺失」等情况。 */
export class GitError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ stderr?: string, exitCode?: number }} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = detail.stderr;
    this.exitCode = detail.exitCode;
  }
}

/**
 * 一个受管的 git 执行器。
 *
 * 之所以做成类而不是一组函数：需要缓存的 `isRepo` 探测结果、
 * 需要在卸载时统一终止仍在跑的子进程。
 */
export class GitRunner {
  /**
   * @param {object} deps
   * @param {any} deps.subprocess  ctx.subprocess 服务
   * @param {any} deps.fs          ctx.fs 服务，用于判断目录是否存在
   */
  constructor({ subprocess, fs }) {
    this.subprocess = subprocess;
    this.fs = fs;
    /** 每个 cwd 的仓库根缓存，避免每次操作都重新探测。 */
    this.rootCache = new Map();
    /**
     * 当前操作的默认环境（例如一次带令牌的 fetch）。
     * 用「环绕」而不是逐层传参：operations 里每个函数都多一个 env 参数
     * 会让签名膨胀，且容易漏传——这里统一在 execute 周围设置。
     */
    this.envStack = [];
  }

  /**
   * 在给定环境下执行一段操作，结束后恢复。
   * 用栈而不是单值：网络操作内部可能再触发只读操作，嵌套是安全的。
   * @template T
   * @param {Record<string,string>|undefined} env
   * @param {() => Promise<T>} body
   * @returns {Promise<T>}
   */
  async withEnv(env, body) {
    this.envStack.push(env);
    try {
      return await body();
    } finally {
      this.envStack.pop();
    }
  }

  /** 当前生效的操作环境。 */
  get currentEnv() {
    for (let index = this.envStack.length - 1; index >= 0; index--) {
      const env = this.envStack[index];
      if (env) return env;
    }
    return undefined;
  }

  /**
   * 执行一条 git 命令。
   * @param {string} cwd
   * @param {readonly string[]} args
   * @param {{ timeoutMs?: number, env?: Record<string, string>, signal?: AbortSignal }} [options]
   * @returns {Promise<{ exitCode: number|null, signal: string|null, stdout: string, stderr: string, lossy: boolean, spillPath?: string }>}
   */
  async run(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;
    const env = options.env ?? this.currentEnv;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let handle;
    try {
      handle = this.subprocess.spawn({
        argv: ['git', ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_OUTPUT_BYTES } },
          stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_OUTPUT_BYTES } },
        },
        graceMs: 2000,
        signal: controller.signal,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    // 收集是非消费式的：独立读者的游标互不影响，这里各自从头读一次。
    const outcome = await handle.done;
    const out = readAll(handle.collected.stdout);
    const err = readAll(handle.collected.stderr);
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: out.text,
      stderr: err.text,
      lossy: out.lossy || err.lossy,
      ...(out.spillPath ? { spillPath: out.spillPath } : {}),
    };
  }

  /**
   * 执行 git 并要求退出码为 0，否则抛 GitError。
   * @param {string} cwd
   * @param {readonly string[]} args
   * @param {object} [options]
   */
  async runOrThrow(cwd, args, options = {}) {
    const result = await this.run(cwd, args, options);
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `git ${args[0]} 失败`;
      throw new GitError('GIT_FAILED', message, {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    return result;
  }

  /**
   * 把一个目录解析成 git 仓库根。工作区子目录里执行 git 也是常见用法，
   * 所以这里向上查找，而不是要求恰好是仓库根。
   * @param {string} dir
   * @returns {Promise<string|null>} 仓库根，或 null
   */
  async findRoot(dir) {
    if (this.rootCache.has(dir)) return this.rootCache.get(dir);
    let root = null;
    try {
      const result = await this.run(dir, ['rev-parse', '--show-toplevel']);
      if (result.exitCode === 0) {
        const candidate = result.stdout.trim();
        if (candidate) root = candidate;
      }
    } catch {
      // git 不存在或目录不可访问，都按「不是仓库」处理。
      root = null;
    }
    this.rootCache.set(dir, root);
    return root;
  }

  /** 写入类操作会改变工作区，缓存必须失效。 */
  invalidate(dir) {
    if (dir === undefined) this.rootCache.clear();
    else this.rootCache.delete(dir);
  }

  /**
   * 仓库概览：分支、上游、ahead/behind、工作区是否干净。
   * 一次 `status --porcelain=v2 --branch` 就能拿到全部信息，不必多次调用。
   * @param {string} root
   */
  async summary(root) {
    const status = await this.run(root, [
      'status', '--porcelain=v2', '--branch', '--untracked-files=normal',
    ]);
    if (status.exitCode !== 0) {
      throw new GitError('GIT_FAILED', status.stderr.trim() || 'git status 失败');
    }
    return parseStatusV2(status.stdout);
  }
}

/**
 * 读取一个收集式输出读者的全部内容。
 * @param {any} reader
 */
function readAll(reader) {
  if (!reader) return { text: '', lossy: false };
  const read = reader.readFrom(0);
  return {
    text: read.text,
    lossy: read.lossy,
    ...(read.spillPath ? { spillPath: read.spillPath } : {}),
  };
}

/**
 * 解析 `git status --porcelain=v2 --branch`。
 *
 * 选 v2 而不是 v1 是因为它把分支信息与文件状态放在同一份输出里，
 * 且记录了 rename 的原始路径；对一个要展示「工作区状态」的 UI 更有用。
 * @param {string} text
 */
export function parseStatusV2(text) {
  const result = {
    branch: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      result.detached = head === '(detached)';
      result.branch = result.detached ? null : head;
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      result.oid = oid === '(initial)' ? null : oid;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      const fields = line.split(' ');
      const xy = fields[1] ?? '';
      const pathPart = fields.slice(8).join(' ');
      const [path, origPath] = pathPart.split('\t');
      const entry = { path, xy, ...(origPath ? { origPath } : {}) };
      classify(result, entry);
      continue;
    }
    if (line.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = line.split(' ');
      result.conflicted.push({ path: fields.slice(10).join(' ') });
      continue;
    }
    if (line.startsWith('? ')) {
      result.untracked.push({ path: line.slice(2) });
      continue;
    }
    if (line.startsWith('! ')) continue; // ignored
  }
  return result;
}

/** 按 XY 把一条记录放进 staged / unstaged（X 是暂存区差异，Y 是工作区差异）。 */
function classify(result, entry) {
  const [x, y] = entry.xy;
  if (x && x !== '.') result.staged.push(entry);
  if (y && y !== '.') result.unstaged.push(entry);
}
