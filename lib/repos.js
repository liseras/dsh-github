/**
 * 仓库发现：把「你有哪些仓库」变成一个列表，而不是让用户手填路径。
 *
 * 两个来源：
 *   1. 本地 —— 扫描已知的根目录，找 .git
 *   2. 远程 —— 问 GitHub 要当前令牌可见的仓库
 *
 * 设计取舍：
 * - 本地扫描**限定深度和根目录**，不做全盘遍历。手机上全盘 find 代价太大，
 *   而且用户的工作区通常在少数几个位置。
 * - 本地与远程按「仓库名」粗匹配，标出哪些已经在本地（可对照 remote URL 精确匹配）。
 * - 远程失败（无令牌/网络不通）不抛错，只是远程分组为空，本地仍可用。
 */
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

/**
 * 本地扫描的候选根目录，按用户实际使用习惯排列。
 *
 * 刻意不含 `/root` 本身：那里近 300 个目录，绝大多数是配置与依赖，
 * 扫它既慢又几乎不会有仓库。真正的工作区在下面这几个位置。
 */
const LOCAL_ROOTS = [
  '/root/Documents/deepseek-harness/default-workspace',
  '/root/Documents',
  '/root/projects',
  '/root/repos',
  '/workspace',
];

/** 扫描深度。够覆盖 workspace/<repo> 与 workspace/<group>/<repo> 两种布局。 */
const MAX_DEPTH = 3;

/** 单次扫描最多访问的目录数，防止在意外的大目录上卡住。 */
const MAX_VISITS = 400;

/** 跳过这些目录名：既不是仓库，又可能非常大。 */
const SKIP = new Set([
  'node_modules', '.git', '.cache', 'dist', 'build', 'out', 'target',
  'vendor', 'venv', '.venv', '__pycache__', '.next', '.nuxt', 'coverage',
]);

/**
 * 扫描本地 git 仓库。
 *
 * 性能是这里的主要约束：实测扫 /root 深度 3 会访问近 300 个目录、耗时约
 * 5 秒——在手机上每次打开面板等 5 秒不可接受。三条优化：
 *   1. 先做一次快速的顶层检查，命中的直接返回，不再深入；
 *   2. 同一层的子目录**并行**递归，而不是串行 await；
 *   3. 深度限制严格，且跳过一切以 . 开头的目录。
 *
 * @param {string[]} roots
 * @returns {Promise<Array<{ path: string, name: string }>>}
 */
export async function scanLocalRepos(roots = LOCAL_ROOTS) {
  const found = new Map();
  let visits = 0;

  /** 该目录自身是不是仓库（只看有没有 .git）。 */
  async function isRepo(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return { repo: entries.some((e) => e.name === '.git'), entries };
    } catch {
      return { repo: false, entries: [] };
    }
  }

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || visits >= MAX_VISITS) return;
    visits++;
    const { repo, entries } = await isRepo(dir);
    if (repo) {
      if (!found.has(dir)) found.set(dir, { path: dir, name: basename(dir) });
      return; // 仓库内不嵌套仓库，不再深入
    }
    // 同层并行，避免串行等待累积
    const children = entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink())
        && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => walk(join(dir, e.name), depth + 1));
    await Promise.all(children);
  }

  await Promise.all(roots.map((root) => walk(root, 0)));
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 取 GitHub 上当前令牌可见的仓库。
 *
 * 令牌无效、网络不通、权限不足都返回空列表——远程不可用不该让整个面板失败。
 *
 * @param {string} token
 * @returns {Promise<{ repos: Array<object>, error?: string }>}
 */
export async function fetchGithubRepos(token) {
  if (typeof token !== 'string' || token === '') {
    return { repos: [], error: 'NO_TOKEN' };
  }
  const url = 'https://api.github.com/user/repos'
    + '?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-github',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return { repos: [], error: `GitHub 返回 ${response.status}` };
    }
    const list = await response.json();
    if (!Array.isArray(list)) return { repos: [], error: 'Unexpected response' };
    return {
      repos: list.map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner?.login ?? '',
        private: r.private === true,
        description: typeof r.description === 'string' ? r.description : '',
        language: typeof r.language === 'string' ? r.language : '',
        updatedAt: typeof r.updated_at === 'string' ? r.updated_at : '',
        defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
        cloneUrl: typeof r.clone_url === 'string' ? r.clone_url : '',
        htmlUrl: typeof r.html_url === 'string' ? r.html_url : '',
        size: typeof r.size === 'number' ? r.size : 0,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { repos: [], error: message };
  }
}

/**
 * 把本地仓库和远程仓库合并成一个列表。
 *
 * 匹配策略：先用 remote URL 精确匹配（最可靠），再用仓库名兜底。
 * 每个条目带 `localPath`（已在本地时）供 UI 决定是「打开」还是「克隆」。
 *
 * @param {Array<{path: string, name: string}>} local
 * @param {Array<object>} remote
 * @param {(path: string) => Promise<string|null>} remoteUrlOf 取本地仓库的 origin URL
 */
export async function mergeRepos(local, remote, remoteUrlOf) {
  // 建立本地索引：路径 → 信息，以及 remote URL → 路径
  const byUrl = new Map();
  const byName = new Map();
  for (const entry of local) {
    byName.set(entry.name.toLowerCase(), entry.path);
    try {
      const url = await remoteUrlOf(entry.path);
      if (url) byUrl.set(normalizeUrl(url), entry.path);
    } catch {
      // 读不到 remote 不影响本地可用性
    }
  }

  const usedLocal = new Set();
  const items = [];

  for (const repo of remote) {
    const match = byUrl.get(normalizeUrl(repo.cloneUrl)) ?? byName.get(repo.name.toLowerCase());
    if (match) usedLocal.add(match);
    items.push({
      kind: 'github',
      id: repo.fullName,
      name: repo.name,
      owner: repo.owner,
      private: repo.private,
      description: repo.description,
      language: repo.language,
      updatedAt: repo.updatedAt,
      defaultBranch: repo.defaultBranch,
      cloneUrl: repo.cloneUrl,
      htmlUrl: repo.htmlUrl,
      size: repo.size,
      localPath: match ?? null,
    });
  }

  // 本地独有（GitHub 上没有，或令牌看不到的）也列出来
  for (const entry of local) {
    if (usedLocal.has(entry.path)) continue;
    items.push({
      kind: 'local',
      id: entry.path,
      name: entry.name,
      localPath: entry.path,
    });
  }

  return items;
}

/** 归一化 git URL，让 https/ssh/带 .git 的形式能匹配上。 */
export function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/**
 * 目标克隆路径：工作区下的仓库名，重名时加后缀。
 * @param {string} workspace
 * @param {string} name
 */
export async function cloneTargetPath(workspace, name) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '') || 'repo';
  let candidate = join(workspace, safe);
  let suffix = 1;
  // 避免覆盖已有目录：重名就加 -2、-3…
  for (;;) {
    try {
      await stat(candidate);
      candidate = join(workspace, `${safe}-${++suffix}`);
    } catch {
      return candidate;
    }
  }
}
