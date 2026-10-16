/**
 * dsh-github —— 面向当前工作区的 Git 集成。
 *
 * 这个插件让用户和模型都能操作**本机工作区里的 git 仓库**：
 * 查看状态与历史、比较改动、管理分支、提交、以及与远端同步。
 * 远端认证使用 GitHub Personal Access Token。
 *
 * 结构：
 *   lib/git.js         git 命令执行与 porcelain v2 解析
 *   lib/operations.js  语义操作（UI 与工具共用的唯一实现）
 *   lib/auth.js        令牌存取与 git 认证环境
 *   lib/config.js      Config 形状与读写
 *   lib/index.js       装配：服务、工具、条件上下文注入（本文件）
 *
 * 两条调用路径共享同一份实现：Agent 通过工具调用，UI 通过同源 HTTP
 * 路由调用同一个服务。不在 UI 里复制一份操作逻辑。
 *
 * 依赖说明：本插件不 import 任何 @deepseek-ai/* 运行时包。
 * 插件装在 profile 的 node_modules 下，那里没有 dsh 的内部依赖；
 * `${DSH_HOME}/profiles/<p>/node_modules` 只有 profile 自己的包，
 * 因此在插件里直接 import schemastery / dsh-tools 会在导入期失败
 * （实测：`dsh-github: failed to import`）。工具定义与 Config 形状
 * 都按宿主公开的契约自己实现，见 lib/config.js 与下面的 TOOL_* 常量。
 */
import { GitError, GitRunner } from './git.js';
import { execute, OPERATIONS, redact } from './operations.js';
import {
  clearToken,
  gitAuthEnv,
  readToken,
  tokenStatus,
  writeToken,
} from './auth.js';
import { Config, readConfig, TOOL_PARAMETERS, TOOL_OUTPUT_SCHEMA } from './config.js';

export { Config };

export const name = 'dsh-github';
// `credentials` 必须在这里声明：Cordis 的服务代理要求先 inject 才能读
// `ctx.credentials`，否则抛出 `cannot get property "credentials" without inject`。
// 漏掉它会让令牌的保存/读取全部失败（而这个错误只在调用时暴露，装配期看不出来）。
export const inject = ['tools', 'fs', 'subprocess', 'webServer', 'credentials'];

export function apply(ctx, config = {}) {
  const runner = new GitRunner({ subprocess: ctx.subprocess, fs: ctx.fs });

  // ---------------------------------------------------------------- 服务
  //
  // 服务是两条调用路径的唯一实现：工具直接调用，浏览器经 HTTP 路由调用。
  const service = {
    /** 解析一个工作目录所属的仓库根。 */
    async resolve(dir) {
      const target = typeof dir === 'string' && dir !== '' ? dir : process.cwd();
      const root = await runner.findRoot(target);
      return root;
    },

    /**
     * 列出一个目录可见的仓库信息，供面板初始化。
     * 不是仓库时返回 { repository: null }，而不是抛错——那是正常状态。
     */
    async overview(dir) {
      const probe = dir ?? process.cwd();
      const root = await runner.findRoot(probe);
      // 不是仓库时也回报**探测过哪个目录**：面板据此告诉用户
      // "我查的是这里"，而不是只显示一句"不是仓库"让人猜。
      if (root === null) return { repository: null, probed: probe };
      const [status, remotes] = await Promise.all([
        runner.summary(root),
        execute(runner, root, 'remotes', {}, {}),
      ]);
      const token = await tokenStatus(ctx.credentials);
      return {
        repository: { root, ...status },
        remotes: remotes.remotes,
        auth: token,
        probed: probe,
      };
    },

    /** 执行一条操作。 */
    async run(root, action, params, context = {}) {
      return execute(runner, root, action, params, context);
    },

    /** 带令牌环境的网络操作（fetch/pull/push）。 */
    async runAuthenticated(root, action, params, context = {}) {
      const token = await readToken(ctx.credentials);
      if (token === null) {
        throw new GitError(
          'NO_CREDENTIAL',
          '尚未配置 GitHub 令牌，请先在设置中填入 Personal Access Token。',
        );
      }
      const auth = await gitAuthEnv(token);
      try {
        return await execute(runner, root, action, params, {
          ...context,
          env: auth.env,
        });
      } finally {
        await auth.cleanup();
      }
    },

    /** 令牌状态 / 写入 / 清除——供设置页使用。 */
    async tokenState() {
      return tokenStatus(ctx.credentials);
    },
    async setToken(key, username) {
      await writeToken(ctx.credentials, key, username);
      return tokenStatus(ctx.credentials);
    },
    async clearToken() {
      await clearToken(ctx.credentials);
      return tokenStatus(ctx.credentials);
    },

    /** 验证令牌是否可用：调用一次 GitHub API，只回状态不回内容。 */
    async verifyToken() {
      const token = await readToken(ctx.credentials);
      if (token === null) return { ok: false, reason: '尚未配置令牌' };
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token.key}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'dsh-github',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          return { ok: false, reason: `GitHub 返回 ${response.status}` };
        }
        const body = await response.json();
        return { ok: true, login: typeof body?.login === 'string' ? body.login : undefined };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  // 挂成一个服务，供同进程的其它 Host 插件按名取用。
  const disposeService = ctx.reflect.provide('github', service);

  // ---------------------------------------------------------------- 浏览器接口
  //
  // UI 通过一条同源 HTTP 路由访问上面的服务。
  //
  // 为什么不用 `@Remote`：Remote 要求服务继承 TypertRemoteService 并走
  // 装饰器 + 类型网关，本插件只有一条读、一条写的交互，引入整套网关
  // 不值得。同源路由复用了 Harness 已有的连接层（浏览器已经通过
  // 同一个 origin 与 Host 通信），且没有额外的活动部件。
  //
  // 路由挂载在 /api 前缀下，与 Harness 自身的 API 命名空间一致，
  // 因此浏览器的同源与鉴权行为不需要任何额外处理。
  // 面板的默认目录：优先用「最近进入过的会话工作区」。
  //
  // 为什么不能直接用 process.cwd()：那是 Harness 的启动目录，
  // 通常不是 git 仓库，面板会显示"不是 git 仓库"并留白。
  // 用户在会话里工作，他期望看到的是**当前会话的工作区**。
  //
  // 顺序：最近 active 的会话 → 任意已知会话 → undefined（由调用方回落）。
  const workspaceDirs = new Map();
  const rememberWorkspace = (sessionId, cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return;
    // 重新插入以维持 Map 的插入序 = 最近使用序（Map 保序）。
    workspaceDirs.delete(sessionId);
    workspaceDirs.set(sessionId, cwd);
  };
  const defaultWorkspaceDir = () => {
    // 先问活跃 agent：那是用户此刻真正在用的会话。
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }
    // 其次用最近记录过的会话工作区（倒序取最后一个）。
    const recorded = Array.from(workspaceDirs.values());
    return recorded.length > 0 ? recorded[recorded.length - 1] : undefined;
  };

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-github',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname.slice('/api/dsh-github'.length) || '/';
      const send = (status, body) => {
        const text = JSON.stringify(body);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        // 令牌不经过这个响应，但接口本身读的是仓库内容，
        // 明确禁止被其它源嵌入读取。
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(text);
      };
      const readBody = async () => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          // 请求体只有令牌和一个目录路径，64 KiB 足够且能挡住异常输入。
          if (size > 64 * 1024) throw new Error('请求体过大');
          chunks.push(chunk);
        }
        if (chunks.length === 0) return {};
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      };

      try {
        // 只接受同源的 GET/POST；其余方法直接拒绝，
        // 避免未来有人把这个端点当通用网关用。
        if (req.method !== 'GET' && req.method !== 'POST') {
          send(405, { error: '只支持 GET 与 POST' });
          return;
        }
        if (req.method === 'GET' && route === '/overview') {
          // dir 由 UI 传入：面板需要能查看任意工作区。
          //
          // 没传时回落到**当前活跃会话的工作区**，而不是 Host 进程的 cwd。
          // Host 的 cwd 是 Harness 的启动目录（通常是 /root 之类），
          // 那里几乎不会是 git 仓库，面板会因此显示"不是 git 仓库"并留白——
          // 这是最初版本的缺陷，用户看到的就是一片空白。
          const dir = url.searchParams.get('dir') || defaultWorkspaceDir() || process.cwd();
          send(200, await service.overview(dir));
          return;
        }
        if (req.method === 'GET' && route === '/token') {
          send(200, await service.tokenState());
          return;
        }
        if (req.method === 'POST' && route === '/token') {
          const body = await readBody();
          send(200, await service.setToken(String(body.key ?? ''), body.username));
          return;
        }
        if (req.method === 'POST' && route === '/token/verify') {
          send(200, await service.verifyToken());
          return;
        }
        if (req.method === 'POST' && route === '/token/clear') {
          send(200, await service.clearToken());
          return;
        }
        if (req.method === 'POST' && route === '/run') {
          const body = await readBody();
          const root = String(body.root ?? '');
          const action = String(body.action ?? '');
          // 写操作由 UI 确认后才会发出，但确认发生在浏览器里，
          // 因此这里再按配置检查一次：确认是用户的意图，配置是用户的授权。
          const operation = OPERATIONS[action];
          if (!operation) {
            send(400, { error: `不支持的操作：${action}` });
            return;
          }
          if (operation.writes && readConfig(config).allowWriteOperations !== true
              && body.confirmed !== true) {
            send(403, { error: '写操作需要确认，或先在设置中开启。' });
            return;
          }
          const isNetwork = action === 'fetch' || action === 'pull' || action === 'push';
          const result = isNetwork
            ? await service.runAuthenticated(root, action, body.params ?? {}, {})
            : await service.run(root, action, body.params ?? {}, {});
          send(200, { result });
          return;
        }
        send(404, { error: '未知的接口' });
      } catch (error) {
        // 失败原因回给 UI，但不回传堆栈或任何命令原文——git 的 stderr
        // 可能内嵌带凭据的 URL，统一走 redact。
        const message = error instanceof GitError
          ? redact(error.message)
          : error instanceof Error
            ? redact(error.message)
            : '操作失败';
        send(200, { error: message });
      }
    },
  });

  // ---------------------------------------------------------------- 工具
  //
  // 一个工具 + action 参数覆盖全部 git 操作：相关操作共享一个工具，
  // 比注册十几个近义工具更容易让模型选对。
  const WRITE_ACTIONS = Object.entries(OPERATIONS)
    .filter(([, operation]) => operation.writes)
    .map(([action]) => action);
  const READ_ACTIONS = Object.entries(OPERATIONS)
    .filter(([, operation]) => !operation.writes)
    .map(([action]) => action);

  const disposeTool = ctx.tools.register({
    name: 'git',
    description: [
      '在当前工作区的 git 仓库上执行操作。',
      `只读操作：${READ_ACTIONS.join(', ')}。`,
      `写操作：${WRITE_ACTIONS.join(', ')}（需要用户已开启写权限）。`,
      '操作自动作用于当前工作目录所属的仓库；用 dir 指定其它目录。',
      '常见 args：stage/unstage 用 { paths: ["a.js"] } 或 { all: true }；',
      'commit 用 { message: "fix: …" }；diff 用 { target: "working"|"staged"|"range", range, path }；',
      'createBranch 用 { name, checkout }；push 用 { remote, branch, setUpstream }。',
    ].join('\n'),
    // 参数与输出都是宿主受限子集内的标准 JSON Schema，
    // 见 lib/config.js 的说明（宿主只接受 type/oneOf/properties/required/
    // additionalProperties/items/enum/const 与注解）。
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (callArgs, value) => {
        if (value && typeof value === 'object' && 'error' in value) {
          return [{ type: 'text', text: `git ${callArgs.action} 失败：${value.error}` }];
        }
        return [{ type: 'text', text: renderResult(callArgs.action, value) }];
      },
    },
    async execute(args, exec) {
      const settings = readConfig(config);
      const directory = typeof args.dir === 'string' && args.dir !== ''
        ? args.dir
        : exec.agent?.session?.header?.cwd ?? process.cwd();
      const params = args.args && typeof args.args === 'object' ? args.args : {};

      const root = await runner.findRoot(directory);
      if (root === null) {
        return { error: `${directory} 不是一个 git 仓库` };
      }

      const operation = OPERATIONS[args.action];
      if (operation.writes && !settings.allowWriteOperations) {
        return {
          error: `写操作 "${args.action}" 未启用。请在 GitHub 插件设置中开启「允许模型执行写操作」，或由用户在面板中手动执行。`,
        };
      }

      try {
        const isNetwork = args.action === 'fetch' || args.action === 'pull' || args.action === 'push';
        if (isNetwork) {
          return await service.runAuthenticated(root, args.action, params, {});
        }
        return await execute(runner, root, args.action, params, {});
      } catch (error) {
        if (error instanceof GitError) return { error: redact(error.message) };
        throw error;
      }
    },
    presentCall: (callArgs) => ({
      card: 'generic',
      title: `git ${callArgs.action}`,
      kind: callArgs.action === 'commit' || callArgs.action === 'push' ? 'edit' : 'read',
      rawInput: callArgs.args,
    }),
    isConcurrencySafe: (callArgs) => OPERATIONS[callArgs.action]?.writes !== true,
    timeoutMs: 180_000,
  });

  // ---------------------------------------------------------------- 上下文注入
  //
  // 条件注入：只有当前会话的工作目录确实是一个 git 仓库时才注入，
  // 因此不碰 git 的会话完全不受影响，也就不会为每次请求增加 token。
  //
  // 实现方式：探测仓库要 await，而 prompt 的 text 回调是同步的，
  // 所以在会话事件里异步刷新一份缓存，组装时只读缓存。
  // 缓存未命中（首次请求、或刚从非仓库切过来）时不注入，下一轮自然补上——
  // 宁可少注入一轮，也不让组装流程阻塞在 git 命令上。
  const stateCache = new Map();

  /** 缓存条目多久算过期。git 状态在会话之间就可能变化。 */
  const STALE_MS = 60_000;
  /** 刷新扫描的间隔。真正的刷新只针对已过期的条目。 */
  const REFRESH_INTERVAL_MS = 20_000;

  const refreshCache = (sessionId, cwd) => {
    const settings = readConfig(config);
    if (!settings.injectContext || !cwd) {
      stateCache.delete(sessionId);
      return;
    }
    // 记录 cwd 供后续刷新使用；先写入再探测，避免同一会话并发触发多次探测。
    const previous = stateCache.get(sessionId);
    if (previous?.pending) return;
    stateCache.set(sessionId, { ...(previous ?? {}), cwd, pending: true, at: Date.now() });
    probe(cwd, settings.injectMaxFiles)
      .then((value) => {
        if (value === null) stateCache.delete(sessionId);
        else stateCache.set(sessionId, { ...value, cwd, pending: false, at: Date.now() });
      })
      .catch(() => stateCache.delete(sessionId));
  };

  /** 探测一个目录的 git 状态，生成注入文本需要的摘要。 */
  const probe = async (cwd, maxFiles) => {
    const root = await runner.findRoot(cwd);
    if (root === null) return null;
    const status = await runner.summary(root);
    const changed = [
      ...status.staged.map((entry) => ({ path: entry.path, area: '已暂存' })),
      ...status.unstaged.map((entry) => ({ path: entry.path, area: '未暂存' })),
      ...status.untracked.map((entry) => ({ path: entry.path, area: '未跟踪' })),
    ];
    return {
      root,
      branch: status.branch,
      detached: status.detached,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      total: changed.length,
      files: changed.slice(0, maxFiles),
    };
  };

  /** 渲染注入文本。空字符串表示不注入。 */
  const renderContext = (sessionId) => {
    const state = stateCache.get(sessionId);
    // 尚未探测完成（或探测失败后残留）的条目不含仓库信息，不注入。
    if (!state || state.pending || state.root === undefined) return '';
    const lines = [];
    const branch = state.detached ? `detached HEAD` : `分支 ${state.branch ?? '未知'}`;
    lines.push(`当前工作区是一个 git 仓库：${state.root}`);
    lines.push(`当前处于 ${branch}`);
    if (state.upstream) {
      const sync = [];
      if (state.ahead > 0) sync.push(`领先 ${state.ahead}`);
      if (state.behind > 0) sync.push(`落后 ${state.behind}`);
      lines.push(
        sync.length > 0
          ? `上游 ${state.upstream}（${sync.join('、')}）`
          : `与上游 ${state.upstream} 一致`,
      );
    } else {
      lines.push('尚未设置上游分支');
    }
    if (state.total === 0) {
      lines.push('工作区没有未提交的改动');
    } else {
      lines.push(`工作区有 ${state.total} 个改动文件：`);
      for (const file of state.files) lines.push(`  - [${file.area}] ${file.path}`);
      if (state.total > state.files.length) {
        lines.push(`  … 另有 ${state.total - state.files.length} 个`);
      }
    }
    return lines.join('\n');
  };

  // 会话进入时刷新缓存。用 `agent/created`：它覆盖新建与恢复两种情况，
  // 且比 `session/created` 更靠近「马上要发请求」的时刻。
  ctx.on('agent/created', ({ agent }) => {
    const cwd = agent?.session?.header?.cwd;
    if (!cwd) return;
    // 同时记下面板要用的默认工作区。
    rememberWorkspace(String(agent.id), cwd);
    refreshCache(String(agent.id), cwd);
  });

  // 状态刷新：只对**已经进入过缓存**的会话做，且间隔较长。
  //
  // 为什么不轮询所有活跃 agent：绝大多数会话与 git 无关，对它们跑
  // `git status` 是纯浪费——这是手机上，子进程开销实打实。
  // 所以第一轮由 `agent/created` 建立缓存，之后只刷新已知是仓库的那些。
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, entry] of stateCache) {
        if (now - entry.at < STALE_MS) continue;
        refreshCache(sessionId, entry.cwd);
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, 'dsh-github: 状态刷新');

  // 把缓存的文本接进组装流程。
  //
  // 用 `system-prompt/assemble` 而不是 `context()`：context 的 text 是同步的，
  // 拿不到已经 await 好的缓存；waterfall 里可以直接拿到本次组装的 agent。
  //
  // 必须保留 next() 的结果并只在 contexts 上追加：其他插件的贡献、
  // complete section 的强制恢复都由上游处理，这里只做加法。
  const disposeAssemble = ctx.on(
    'system-prompt/assemble',
    async (assembly, assembleContext, next) => {
      const result = await next();
      const agent = assembleContext?.agent;
      if (!agent || agent.id === undefined) return result;
      const text = renderContext(String(agent.id));
      if (text === '') return result;
      return {
        ...result,
        contexts: [...result.contexts, { name: 'dsh-github:repository-state', text }],
      };
    },
  );

  // 卸载时清理。
  ctx.effect(() => () => {
    disposeAssemble();
    disposeRoute?.();
    disposeTool();
    disposeService();
    stateCache.clear();
    runner.invalidate();
  }, 'dsh-github: 装配清理');
}

/** 把操作结果压缩成一行可读文本，供工具卡片展示。 */
function renderResult(action, value) {
  if (!value || typeof value !== 'object') return `git ${action} 已执行`;
  switch (value.kind) {
    case 'status': {
      const parts = [];
      parts.push(value.detached ? 'detached HEAD' : `分支 ${value.branch ?? '未知'}`);
      if (value.upstream) parts.push(`上游 ${value.upstream}`);
      parts.push(`${value.staged.length} 已暂存 / ${value.unstaged.length} 未暂存 / ${value.untracked.length} 未跟踪`);
      return parts.join('，');
    }
    case 'log':
      return `返回 ${value.commits.length} 条提交`;
    case 'diff':
      return value.empty ? '没有差异' : `差异 ${value.text.split('\n').length} 行`;
    case 'branches':
      return `共 ${value.branches.length} 个分支`;
    case 'remotes':
      return value.remotes.length === 0 ? '没有配置远端' : `远端：${value.remotes.map((r) => r.name).join('、')}`;
    case 'commit':
      return `已提交 ${value.hash ?? ''}`.trim();
    default:
      return `git ${action} 已执行`;
  }
}
