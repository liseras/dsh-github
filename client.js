/**
 * dsh-github 的浏览器半。
 *
 * 渲染位置：左侧栏全局面板图标（`sidebar.panellist`）+ 中栏面板（`main` 的
 * `github` key）+ 设置页（`settings.section`）。
 *
 * 三条自我约束：
 * 1. 只用 `--dsw-*` 主题令牌着色，不写死颜色，因此浅色/深色自动一致。
 * 2. 不 import 任何 Harness Client 包（primitives 等）。控件自己写。
 * 3. 所有 Host 访问都经 `ctx.get(...)` 惰性获取并容忍缺失——属性式
 *    `ctx.remote` 读取会在 apply() 内抛错并使整条 Client 条目激活失败。
 */
window.__ModuleLoader__.load({
  id: 'dsh-github',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-github';
    const API = '/api/dsh-github';

    // ------------------------------------------------------------ 文案
    const zh = {
      'panel.title': 'Git',
      'panel.subtitle': '当前工作区的仓库',
      'empty.notRepo': '当前目录不是一个 git 仓库。',
      'empty.hint': '在下方填入仓库目录，或把会话的工作区切到一个 git 仓库。',
      'field.dir': '仓库目录',
      'action.load': '加载',
      'state.branch': '分支',
      'state.detached': '游离 HEAD',
      'state.upstream': '上游',
      'state.none': '未设置',
      'state.sync': '同步',
      'state.ahead': '领先 {n}',
      'state.behind': '落后 {n}',
      'state.clean': '工作区干净',
      'tab.changes': '改动',
      'tab.history': '历史',
      'tab.branches': '分支',
      'tab.remotes': '远端',
      'changes.staged': '已暂存',
      'changes.unstaged': '未暂存',
      'changes.untracked': '未跟踪',
      'changes.conflicted': '冲突',
      'changes.none': '没有改动',
      'history.none': '没有提交记录',
      'branches.none': '没有分支',
      'remotes.none': '没有配置远端',
      'action.stageAll': '全部暂存',
      'action.refresh': '刷新',
      'action.commit': '提交',
      'commit.placeholder': '提交信息',
      'commit.empty': '请先填写提交信息',
      'diff.title': '差异',
      'diff.staged': '已暂存差异',
      'diff.working': '工作区差异',
      'diff.empty': '没有差异',
      'confirm.title': '确认执行',
      'confirm.cancel': '取消',
      'confirm.ok': '确认',
      'loading': '正在加载…',
      'error': '出错了',
      'settings.title': 'GitHub',
      'settings.desc': 'Git 集成与 GitHub 访问令牌。',
      'settings.token': 'Personal Access Token',
      'settings.token.placeholder': '粘贴 GitHub 令牌',
      'settings.token.saved': '已配置',
      'settings.token.missing': '未配置',
      'settings.token.save': '保存',
      'settings.token.clear': '清除',
      'settings.token.verify': '验证',
      'settings.token.verified': '令牌有效，账号 {login}',
      'settings.token.invalid': '令牌无效：{reason}',
      'settings.token.show': '显示',
      'settings.token.hide': '隐藏',
      'settings.token.hint': '令牌保存在 Harness 的凭据存储中，不会写入配置文件，也不会出现在日志里。',
      'settings.username': '用户名（可选）',
      'settings.inject': '把仓库状态提供给模型',
      'settings.inject.desc': '当会话的工作区是 git 仓库时，把分支、改动与上游状态作为运行时上下文注入。',
      'settings.injectMaxFiles.desc': '改动文件多于这个数量时，只列出前几条，其余以总数提示。数值越大占用的上下文越多。',
      'settings.injectMaxFiles': '上下文中列出的改动文件数上限（1–50）',
      'settings.write': '允许模型执行写操作',
      'settings.write.desc': '允许模型直接提交、推送、切换分支。关闭时模型只能读取仓库状态。',
    };
    const en = {
      'panel.title': 'Git',
      'panel.subtitle': 'Repository of the current workspace',
      'empty.notRepo': 'This directory is not a git repository.',
      'empty.hint': 'Enter a repository path below, or point the session workspace at one.',
      'field.dir': 'Repository directory',
      'action.load': 'Load',
      'state.branch': 'Branch',
      'state.detached': 'Detached HEAD',
      'state.upstream': 'Upstream',
      'state.none': 'None',
      'state.sync': 'Sync',
      'state.ahead': '{n} ahead',
      'state.behind': '{n} behind',
      'state.clean': 'Working tree clean',
      'tab.changes': 'Changes',
      'tab.history': 'History',
      'tab.branches': 'Branches',
      'tab.remotes': 'Remotes',
      'changes.staged': 'Staged',
      'changes.unstaged': 'Unstaged',
      'changes.untracked': 'Untracked',
      'changes.conflicted': 'Conflicted',
      'changes.none': 'No changes',
      'history.none': 'No commits',
      'branches.none': 'No branches',
      'remotes.none': 'No remotes',
      'action.stageAll': 'Stage all',
      'action.refresh': 'Refresh',
      'action.commit': 'Commit',
      'commit.placeholder': 'Commit message',
      'commit.empty': 'Enter a commit message first',
      'diff.title': 'Diff',
      'diff.staged': 'Staged diff',
      'diff.working': 'Working diff',
      'diff.empty': 'No differences',
      'confirm.title': 'Confirm action',
      'confirm.cancel': 'Cancel',
      'confirm.ok': 'Confirm',
      'loading': 'Loading…',
      'error': 'Something went wrong',
      'settings.title': 'GitHub',
      'settings.desc': 'Git integration and GitHub access token.',
      'settings.token': 'Personal Access Token',
      'settings.token.placeholder': 'Paste a GitHub token',
      'settings.token.saved': 'Configured',
      'settings.token.missing': 'Not configured',
      'settings.token.save': 'Save',
      'settings.token.clear': 'Clear',
      'settings.token.verify': 'Verify',
      'settings.token.verified': 'Token is valid, account {login}',
      'settings.token.invalid': 'Token rejected: {reason}',
      'settings.token.show': 'Show',
      'settings.token.hide': 'Hide',
      'settings.token.hint': 'The token is stored in the Harness credential store. It is never written to configuration files or logs.',
      'settings.username': 'Username (optional)',
      'settings.inject': 'Provide repository state to the model',
      'settings.inject.desc': 'When the session workspace is a git repository, inject branch, changes, and upstream state as runtime context.',
      'settings.injectMaxFiles.desc': 'When more files changed, only the first few are listed and the rest are reported as a count. Larger values cost more context.',
      'settings.injectMaxFiles': 'Maximum changed files listed in context (1-50)',
      'settings.write': 'Allow the model to write',
      'settings.write.desc': 'Allow the model to commit, push, and switch branches directly. When off, the model can only read repository state.',
    };

    // ------------------------------------------------------------ 样式
    //
    // 只引用主题令牌，不写死颜色。字号与间距对齐宿主设置页的实测取值
    // （正文 14px / 说明 12px、区块内 16px 纵向节奏、圆角用 --dsw-radius-*），
    // 这样插件页与旁边的「自定义背景」「Agent 预设」看起来是一套东西。
    const CSS = `
.dshgh-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:14px; }
.dshgh-bar { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; flex-wrap:wrap; }
.dshgh-title { font-weight:600; }
.dshgh-sub { color:var(--dsw-alias-label-secondary); font-size:12px; }
.dshgh-spacer { flex:1; }
.dshgh-body { flex:1; min-height:0; overflow:auto; padding:4px 14px 20px; }
.dshgh-empty { padding:32px 14px; text-align:center; color:var(--dsw-alias-label-secondary); }
.dshgh-empty p { margin:0 0 14px; }

.dshgh-input { background:var(--dsw-alias-bg-layer-2); color:inherit; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-sm,8px); padding:8px 10px; font:inherit; font-size:13px; min-width:0; }
.dshgh-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }

.dshgh-btn { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-sm,8px); padding:7px 13px; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.dshgh-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.dshgh-btn:disabled { opacity:.45; cursor:default; }
.dshgh-btn-primary { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); border-color:transparent; }
/* 主按钮禁用时退回中性底色：品牌色实底叠半透明会在窄屏上糊成一块看不清文字的灰块。 */
.dshgh-btn-primary:disabled { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); opacity:1; }

/* 状态概览：一个独立卡片，让「我现在在哪个分支」一眼可见。 */
.dshgh-state { display:flex; flex-wrap:wrap; gap:4px 20px; padding:12px 14px; margin:12px 0 4px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md,10px); background:var(--dsw-alias-bg-layer-1); }
.dshgh-state dt { color:var(--dsw-alias-label-secondary); font-size:11px; margin:0 0 3px; }
.dshgh-state dd { margin:0; font-size:13px; font-variant-numeric:tabular-nums; }

.dshgh-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l1); margin:12px 0 4px; }
.dshgh-tab { background:none; border:none; border-bottom:2px solid transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; padding:8px 10px; cursor:pointer; margin-bottom:-1px; }
.dshgh-tab[aria-selected="true"] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-brand-primary); }
.dshgh-tab:hover[aria-selected="false"] { color:var(--dsw-alias-label-primary); }

.dshgh-group { margin:14px 0; }
.dshgh-group h4 { margin:0 0 6px; font-size:12px; color:var(--dsw-alias-label-secondary); font-weight:600; }
.dshgh-row { display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:var(--dsw-radius-sm,7px); }
.dshgh-row:hover { background:var(--dsw-alias-bg-layer-2); }
.dshgh-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; text-align:left; background:none; border:none; color:inherit; padding:0; cursor:pointer; }
.dshgh-badge { flex:none; font-size:11px; padding:2px 7px; border-radius:var(--dsw-radius-sm,6px); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dshgh-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--dsw-alias-label-secondary); }

.dshgh-diff { margin:12px 0; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md,10px); background:var(--dsw-alias-bg-layer-1); max-height:340px; overflow:auto; }
.dshgh-diff header { position:sticky; top:0; background:var(--dsw-alias-bg-layer-1); padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshgh-diff pre { margin:0; padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; white-space:pre; overflow:auto; }

.dshgh-commit { display:flex; gap:8px; margin:14px 0 0; }
.dshgh-commit .dshgh-input { flex:1; }
.dshgh-err { color:var(--dsw-alias-state-error-primary); margin:10px 0 0; font-size:13px; }

/* ---------- 设置页 ---------- */
.dshgh-set { padding:2px 0; }
/* 分组卡片：宿主的设置页把相关项收在一个圆角容器里，这里照做。 */
.dshgh-card { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md,10px); background:var(--dsw-alias-bg-layer-1); padding:4px 14px 10px; margin:0 0 16px; }
.dshgh-card-head { font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); padding:10px 0 2px; }
.dshgh-set h4 { margin:0 0 4px; font-size:14px; font-weight:600; }
.dshgh-set p { margin:0 0 10px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.dshgh-set-row { display:flex; align-items:center; gap:12px; padding:10px 0; flex-wrap:wrap; }
.dshgh-set-row + .dshgh-set-row { border-top:1px solid var(--dsw-alias-border-l1); }
.dshgh-set-row label { flex:1; min-width:0; font-size:13px; }
.dshgh-field { display:flex; flex-direction:column; gap:5px; padding:8px 0 10px; }
.dshgh-field .dshgh-input { width:100%; box-sizing:border-box; }
.dshgh-field-label { color:var(--dsw-alias-label-secondary); font-size:12px; }
/* 令牌框与「显示/隐藏」按钮同排；按钮不用独立行，避免占掉本来就窄的宽度。 */
.dshgh-input-wrap { display:flex; align-items:center; gap:6px; }
.dshgh-input-wrap .dshgh-input { flex:1; min-width:0; }
.dshgh-reveal { flex:none; background:none; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-sm,8px); color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; padding:8px 10px; cursor:pointer; }
.dshgh-reveal:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.dshgh-input-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; letter-spacing:.02em; }
.dshgh-hint { margin:8px 0 0; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
.dshgh-ok { color:var(--dsw-alias-state-success-primary); font-size:12px; margin:8px 0 0; }

.dshgh-toggle { width:42px; height:24px; border-radius:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); position:relative; cursor:pointer; flex:none; padding:0; }
.dshgh-toggle[aria-checked="true"] { background:var(--dsw-alias-brand-primary); border-color:transparent; }
.dshgh-toggle i { position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:var(--dsw-alias-bg-base); transition:left .15s; }
.dshgh-toggle[aria-checked="true"] i { left:20px; }

.dshgh-modal { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; background:color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent); }
.dshgh-modal-card { background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-panel,14px); padding:18px; max-width:420px; min-width:280px; }
.dshgh-modal-card h3 { margin:0 0 8px; font-size:14px; font-weight:600; }
.dshgh-modal-card p { margin:0 0 16px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; white-space:pre-wrap; }
.dshgh-modal-actions { display:flex; gap:8px; justify-content:flex-end; }
`;

    // ------------------------------------------------------------ 工具
    /** 惰性、容错地取一个跨插件服务；缺失时返回 undefined 而不是抛错。 */
    function serviceOf(ctx, key) {
      try {
        const value = ctx.get?.(key);
        return value ?? undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 调用 Host 接口。
     * 失败统一抛 Error（带可读信息），调用方只处理一种失败形态。
     */
    async function call(path, options) {
      const init = { method: options?.method ?? 'GET', headers: {}, cache: 'no-store' };
      if (options?.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(API + path, init);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`服务返回了非 JSON 响应（${response.status}）`);
      }
      if (!response.ok) throw new Error(payload?.error ?? `请求失败（${response.status}）`);
      if (payload?.error) throw new Error(payload.error);
      return payload?.result !== undefined ? payload.result : payload;
    }

    /** 一个极小的订阅 store；面板与设置页共享实例，避免各自重复拉取。 */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
          for (const listener of Array.from(listeners)) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function useStore(store) {
      const [state, setState] = React.useState(store.get());
      React.useEffect(() => store.subscribe(() => setState(store.get())), [store]);
      return state;
    }

    /** 内联的全局样式：随组件挂载/卸载增删，不留残渣。 */
    function Styles() {
      return h('style', { 'data-dsh-github': '' }, CSS);
    }

    /** 开关：role="switch" + aria-checked，带键盘行为。 */
    function Toggle({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'dshgh-toggle',
        onClick: () => onChange(!checked),
      }, h('i', null));
    }

    /**
     * 确认对话框。
     * 写操作在执行前必须经此确认；Escape 关闭、打开时聚焦确认按钮，
     * 这些是用户对模态框的既有预期。
     */
    function Confirm({ text, t, onCancel, onConfirm }) {
      const confirmRef = React.useRef(null);
      React.useEffect(() => {
        confirmRef.current?.focus();
        const onKey = (event) => { if (event.key === 'Escape') onCancel(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onCancel]);
      return h('div', { className: 'dshgh-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'dshgh-modal-card' },
          h('h3', null, t('confirm.title')),
          h('p', null, text),
          h('div', { className: 'dshgh-modal-actions' },
            h('button', { type: 'button', className: 'dshgh-btn', onClick: onCancel }, t('confirm.cancel')),
            h('button', { ref: confirmRef, type: 'button', className: 'dshgh-btn dshgh-btn-primary', onClick: onConfirm }, t('confirm.ok')))));
    }

    /** 差异文本渲染。用 pre 保留原始空白，不加语法着色以免引入色彩假设。 */
    function DiffView({ title, text }) {
      return h('div', { className: 'dshgh-diff' },
        h('header', null, title),
        h('pre', null, text));
    }

    // ------------------------------------------------------------ 主面板
    function GithubPanel(props) {
      const ctx = props.ctx;
      const store = props.store;
      const t = props.t;
      const state = useStore(store);

      const [dir, setDir] = React.useState(state.dir);
      const [tab, setTab] = React.useState('changes');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState(null);
      const [diff, setDiff] = React.useState(null);
      const [message, setMessage] = React.useState('');

      const overview = state.overview;
      const repo = overview?.repository ?? null;

      const load = React.useCallback(async (target) => {
        const where = target ?? dir;
        setBusy(true);
        setError('');
        try {
          const value = await call(`/overview?dir=${encodeURIComponent(where)}`);
          store.set({ dir: where, overview: value });
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, [dir, store]);

      // 首次挂载时自动探测；只在还没有结果时执行。
      React.useEffect(() => {
        if (store.get().overview === null) load(store.get().dir);
      }, [load, store]);

      /** 执行一条操作；写操作先弹确认。 */
      const run = React.useCallback(async (action, params, confirmText) => {
        if (confirmText) {
          setPending({ action, params, confirmText });
          return;
        }
        setBusy(true);
        setError('');
        try {
          await call('/run', { method: 'POST', body: { root: repo?.root, action, params } });
          await load();
          if (action === 'diff') { /* diff 单独处理 */ }
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, [repo?.root, load]);

      const showDiff = React.useCallback(async (target, path) => {
        setBusy(true);
        setError('');
        try {
          const value = await call('/run', {
            method: 'POST',
            body: { root: repo?.root, action: 'diff', params: { target, path } },
          });
          setDiff({ title: target === 'staged' ? t('diff.staged') : t('diff.working'), text: value.text || t('diff.empty') });
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }, [repo?.root, t]);

      const t2 = (key, vars) => {
        let text = t(key);
        for (const [name, value] of Object.entries(vars ?? {})) {
          text = text.replace(`{${name}}`, String(value));
        }
        return text;
      };

      // 目录选择条始终在顶部：面板可能落在任意工作区。
      const bar = h('div', { className: 'dshgh-bar' },
        h('span', { className: 'dshgh-title' }, t('panel.title')),
        h('input', {
          className: 'dshgh-input',
          style: { flex: '1', maxWidth: '420px' },
          value: dir,
          spellCheck: false,
          'aria-label': t('field.dir'),
          placeholder: t('field.dir'),
          onChange: (event) => setDir(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') load(); },
        }),
        h('button', { type: 'button', className: 'dshgh-btn', disabled: busy, onClick: () => load() }, t('action.load')),
        h('span', { className: 'dshgh-spacer' }),
        repo ? h('button', {
          type: 'button', className: 'dshgh-btn', disabled: busy, onClick: () => load(),
        }, t('action.refresh')) : null);

      if (repo === null) {
        return h('div', { className: 'dshgh-root' },
          h(Styles),
          bar,
          h('div', { className: 'dshgh-empty' },
            h('p', null, t('empty.notRepo')),
            h('p', null, t('empty.hint')),
            error ? h('p', { className: 'dshgh-err' }, error) : null));
      }

      const sync = [];
      if (repo.ahead > 0) sync.push(t2('state.ahead', { n: repo.ahead }));
      if (repo.behind > 0) sync.push(t2('state.behind', { n: repo.behind }));

      const stateRow = h('dl', { className: 'dshgh-state' },
        h('div', null,
          h('dt', null, repo.detached ? t('state.detached') : t('state.branch')),
          h('dd', null, repo.detached ? (repo.oid ?? '').slice(0, 10) : (repo.branch ?? t('state.none')))),
        h('div', null,
          h('dt', null, t('state.upstream')),
          h('dd', null, repo.upstream ?? t('state.none'))),
        h('div', null,
          h('dt', null, t('state.sync')),
          h('dd', null, sync.length > 0 ? sync.join('、') : t('state.clean'))));

      const tabs = [
        ['changes', t('tab.changes')],
        ['history', t('tab.history')],
        ['branches', t('tab.branches')],
        ['remotes', t('tab.remotes')],
      ];
      const tabBar = h('div', { className: 'dshgh-tabs', role: 'tablist' },
        tabs.map(([id, label]) => h('button', {
          key: id, type: 'button', role: 'tab', className: 'dshgh-tab',
          'aria-selected': tab === id ? 'true' : 'false',
          onClick: () => setTab(id),
        }, label)));

      let body = null;
      if (tab === 'changes') {
        const groups = [
          [t('changes.staged'), repo.staged, 'staged'],
          [t('changes.unstaged'), repo.unstaged, 'working'],
          [t('changes.untracked'), repo.untracked, null],
          [t('changes.conflicted'), repo.conflicted, null],
        ].filter(([, list]) => list.length > 0);
        body = groups.length === 0
          ? h('p', { className: 'dshgh-mono' }, t('changes.none'))
          : groups.map(([label, list, diffTarget]) => h('div', { className: 'dshgh-group', key: label },
            h('h4', null, `${label} · ${list.length}`),
            list.map((entry) => h('div', { className: 'dshgh-row', key: entry.path },
              diffTarget
                ? h('button', {
                    type: 'button', className: 'dshgh-path', title: entry.path,
                    onClick: () => showDiff(diffTarget, entry.path),
                  }, entry.path)
                : h('span', { className: 'dshgh-path', title: entry.path }, entry.path),
              entry.xy ? h('span', { className: 'dshgh-badge' }, entry.xy) : null))));
      } else if (tab === 'history') {
        const commits = state.log?.commits ?? [];
        body = commits.length === 0
          ? h('p', { className: 'dshgh-mono' }, t('history.none'))
          : commits.map((commit) => h('div', { className: 'dshgh-row', key: commit.hash },
            h('span', { className: 'dshgh-mono', style: { flex: 'none' } }, commit.short),
            h('span', { className: 'dshgh-path', title: commit.subject }, commit.subject),
            h('span', { className: 'dshgh-badge' }, commit.author),
            h('span', { className: 'dshgh-mono' }, (commit.date ?? '').slice(0, 10))));
      } else if (tab === 'branches') {
        const branches = state.branches?.branches ?? [];
        body = branches.length === 0
          ? h('p', { className: 'dshgh-mono' }, t('branches.none'))
          : branches.map((branch) => h('div', { className: 'dshgh-row', key: branch.name },
            h('span', { className: 'dshgh-path' }, branch.name),
            branch.current ? h('span', { className: 'dshgh-badge' }, 'HEAD') : null,
            branch.upstream ? h('span', { className: 'dshgh-mono' }, branch.upstream) : null));
      } else {
        const remotes = overview?.remotes ?? [];
        body = remotes.length === 0
          ? h('p', { className: 'dshgh-mono' }, t('remotes.none'))
          : remotes.map((remote) => h('div', { className: 'dshgh-row', key: remote.name },
            h('span', { className: 'dshgh-badge' }, remote.name),
            h('span', { className: 'dshgh-path', title: remote.fetchUrl ?? '' }, remote.fetchUrl ?? '')));
      }

      // 切换 tab 时按需加载该 tab 的数据。
      React.useEffect(() => {
        if (repo === null) return;
        let cancelled = false;
        (async () => {
          try {
            if (tab === 'history' && !store.get().log) {
              const log = await call('/run', { method: 'POST', body: { root: repo.root, action: 'log', params: { limit: 40 } } });
              if (!cancelled) store.set({ log });
            }
            if (tab === 'branches' && !store.get().branches) {
              const branches = await call('/run', { method: 'POST', body: { root: repo.root, action: 'branches', params: {} } });
              if (!cancelled) store.set({ branches });
            }
          } catch (err) {
            if (!cancelled) setError(err.message);
          }
        })();
        return () => { cancelled = true; };
      }, [tab, repo, store]);

      const commitRow = h('div', { className: 'dshgh-commit' },
        h('input', {
          className: 'dshgh-input',
          value: message,
          placeholder: t('commit.placeholder'),
          spellCheck: false,
          'aria-label': t('commit.placeholder'),
          onChange: (event) => setMessage(event.target.value),
        }),
        h('button', {
          type: 'button', className: 'dshgh-btn dshgh-btn-primary', disabled: busy || message.trim() === '',
          onClick: () => run('commit', { message }, `${t('action.commit')}: ${message}`),
        }, t('action.commit')));

      return h('div', { className: 'dshgh-root' },
        h(Styles),
        bar,
        h('div', { className: 'dshgh-body' },
          stateRow,
          h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
            h('button', {
              type: 'button', className: 'dshgh-btn', disabled: busy,
              onClick: () => {
                const count = repo.unstaged.length + repo.untracked.length;
                run('stage', { all: true }, `${t('action.stageAll')}（${count} 个文件）`);
              },
            }, t('action.stageAll'))),
          tabBar,
          body,
          diff ? h(DiffView, { title: diff.title, text: diff.text }) : null,
          commitRow,
          error ? h('p', { className: 'dshgh-err' }, error) : null,
          busy ? h('p', { className: 'dshgh-mono' }, t('loading')) : null),
        pending ? h(Confirm, {
          t,
          text: pending.confirmText,
          onCancel: () => setPending(null),
          onConfirm: async () => {
            const { action, params } = pending;
            setPending(null);
            setBusy(true);
            setError('');
            try {
              await call('/run', { method: 'POST', body: { root: repo.root, action, params, confirmed: true } });
              store.set({ log: null, branches: null });
              await load();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          },
        }) : null);
    }

    // ------------------------------------------------------------ 图标
    /** 侧栏图标：分支符号。owner 传入 size 与选中态。 */
    function GitIcon({ size = 16, active = false }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: active ? 1 : 0.85 },
      },
        h('circle', { cx: 4.5, cy: 3.5, r: 1.9 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.9 }),
        h('circle', { cx: 11.5, cy: 6.5, r: 1.9 }),
        h('path', { d: 'M4.5 5.4v5.2' }),
        h('path', { d: 'M11.5 8.4c0 2.2-3 2.6-5.2 3.1' }));
    }

    // ------------------------------------------------------------ 设置页
    function GithubSettings(props) {
      const t = props.t;
      const store = props.store;
      const state = useStore(store);
      const [token, setToken] = React.useState('');
      const [tokenVisible, setTokenVisible] = React.useState(false);
      const [username, setUsername] = React.useState('');
      const [status, setStatus] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      // 挂载时读一次令牌状态（只回是否已配置）。
      React.useEffect(() => {
        let cancelled = false;
        call('/token').then((value) => { if (!cancelled) store.set({ auth: value }); }).catch(() => {});
        return () => { cancelled = true; };
      }, [store]);

      const guard = async (fn) => {
        setBusy(true);
        setError('');
        setStatus('');
        try {
          await fn();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      const configured = state.auth?.configured === true;

      // 第一张卡片：令牌。它比其他设置项复杂（输入 + 三个动作 + 状态），
      // 因此单独成卡，与下面三个纯开关项分开。
      const cards = h('div', { className: 'dshgh-card' },
        h('div', { className: 'dshgh-set-row' },
          h('label', { htmlFor: 'dshgh-token' }, t('settings.token')),
          h('span', { className: 'dshgh-badge' }, configured ? t('settings.token.saved') : t('settings.token.missing'))),
        // 令牌独占一行：手机竖屏下与用户名并排会把占位符和内容一起截断，
        // 而令牌是最需要看清自己填了什么的一栏。等宽字体便于核对字符。
        //
        // 默认明文显示，而不是 type="password"：后者会让手机的系统密码管理器
        // （实测小米的 com.miui.passwords）弹出自动填充界面接管这个框，
        // 打断保存流程。令牌是一次性粘贴的 API 凭据，不是登录密码，
        // 明文便于核对字符；需要遮挡时用右侧的切换按钮。
        h('div', { className: 'dshgh-field' },
          h('div', { className: 'dshgh-input-wrap' },
            h('input', {
              id: 'dshgh-token',
              className: 'dshgh-input dshgh-input-mono',
              type: tokenVisible ? 'text' : 'password',
              value: token,
              spellCheck: false,
              autoComplete: 'new-password',
              autoCorrect: 'off',
              autoCapitalize: 'off',
              'data-form-type': 'other',
              'data-lpignore': 'true',
              placeholder: t('settings.token.placeholder'),
              onChange: (event) => setToken(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'dshgh-reveal',
              'aria-label': tokenVisible ? t('settings.token.hide') : t('settings.token.show'),
              'aria-pressed': tokenVisible ? 'true' : 'false',
              onClick: () => setTokenVisible((value) => !value),
            }, tokenVisible ? t('settings.token.hide') : t('settings.token.show')))),
        h('div', { className: 'dshgh-field' },
          h('label', { className: 'dshgh-field-label', htmlFor: 'dshgh-username' }, t('settings.username')),
          h('input', {
            id: 'dshgh-username', className: 'dshgh-input',
            value: username, spellCheck: false, autoComplete: 'off',
            placeholder: t('settings.username'),
            onChange: (event) => setUsername(event.target.value),
          })),
        h('div', { className: 'dshgh-set-row' },
          h('button', {
            type: 'button', className: 'dshgh-btn dshgh-btn-primary', disabled: busy || token.trim() === '',
            onClick: () => guard(async () => {
              const auth = await call('/token', { method: 'POST', body: { key: token, username } });
              store.set({ auth });
              setToken('');
              setStatus(t('settings.token.saved'));
            }),
          }, t('settings.token.save')),
          h('button', {
            type: 'button', className: 'dshgh-btn', disabled: busy || !configured,
            onClick: () => guard(async () => {
              const auth = await call('/token/clear', { method: 'POST', body: {} });
              store.set({ auth });
              setStatus('');
            }),
          }, t('settings.token.clear')),
          h('button', {
            type: 'button', className: 'dshgh-btn', disabled: busy || !configured,
            onClick: () => guard(async () => {
              const result = await call('/token/verify', { method: 'POST', body: {} });
              setStatus(result.ok
                ? t('settings.token.verified').replace('{login}', result.login ?? '')
                : t('settings.token.invalid').replace('{reason}', result.reason ?? ''));
            }),
          }, t('settings.token.verify'))),
        h('p', { className: 'dshgh-hint' }, t('settings.token.hint')),
        status ? h('p', { className: 'dshgh-ok' }, status) : null,
        error ? h('p', { className: 'dshgh-err' }, error) : null);

      // 第二、三、四张卡片是设置项：标题 + 说明 + 右侧控件，与宿主设置页同构。
      // `extra` 用于数字输入框那种「控件不是开关」的情况。
      const settingCard = (title, desc, key, checked, extra) =>
        h('div', { className: 'dshgh-card' },
          h('div', { className: 'dshgh-set-row' },
            h('label', null, title),
            extra ?? null,
            checked === null ? null : h(Toggle, {
              label: title,
              checked,
              onChange: (value) => { store.set({ [key]: value }); props.onConfig({ [key]: value }); },
            })),
          h('p', { className: 'dshgh-hint' }, desc));

      return h('div', { className: 'dshgh-set' },
        h(Styles),
        h('p', { className: 'dshgh-hint', style: { margin: '0 0 14px' } }, t('settings.desc')),
        cards,
        settingCard(
          t('settings.inject'),
          t('settings.inject.desc'),
          'injectContext',
          state.injectContext !== false,
        ),
        settingCard(
          t('settings.injectMaxFiles'),
          t('settings.injectMaxFiles.desc'),
          'injectMaxFiles',
          // 这一项用输入框而不是开关，所以不渲染 Toggle。
          null,
          h('input', {
            id: 'dshgh-maxfiles', className: 'dshgh-input', style: { width: '84px', flex: 'none' },
            type: 'number', min: 1, max: 50, inputMode: 'numeric',
            'aria-label': t('settings.injectMaxFiles'),
            value: state.injectMaxFiles ?? 12,
            onChange: (event) => {
              const value = Math.min(50, Math.max(1, Number(event.target.value) || 12));
              store.set({ injectMaxFiles: value });
              props.onConfig({ injectMaxFiles: value });
            },
          }),
        ),
        settingCard(
          t('settings.write'),
          t('settings.write.desc'),
          'allowWriteOperations',
          state.allowWriteOperations === true,
        ));
    }

    // ------------------------------------------------------------ 装配
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-github: zh');
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-github: en');

        // 面板与设置页共享一个 store：两者都读它、写它，不各自拉取。
        // 目录留空表示「让 Host 用它自己的 cwd」，面板加载时由 Host 回填。
        const store = createStore({
          dir: '',
          overview: null,
          log: null,
          branches: null,
          auth: null,
          injectContext: null,
          injectMaxFiles: null,
          allowWriteOperations: null,
        });

        // 把设置项同步回 Host 的 Config。
        // 走 settings remote（宿主提供时）；不可用时静默降级——
        // 面板与 git 工具仍然可用，只是设置改动不落盘。
        // 取 settings remote。两种宿主形状都试：
        // 直接注册为 `remote.settings` 服务，或注册 `remote` 网关后按命名空间取属性。
        // 全部走 ctx.get()——属性式 `ctx.remote` 读取会抛错并让整条 Client 条目激活失败。
        const settingsRemote = (() => {
          const usable = (value) => value && typeof value.mutate === 'function' && typeof value.describe === 'function';
          try {
            const direct = ctx.get?.('remote.settings');
            if (usable(direct)) return direct;
          } catch { /* 宿主不提供时的正常路径 */ }
          try {
            const gateway = ctx.get?.('remote');
            const viaGateway = gateway ? gateway.settings : undefined;
            if (usable(viaGateway)) return viaGateway;
          } catch { /* 同上 */ }
          return undefined;
        })();

        // 用 Host 的真实配置初始化三个开关。
        //
        // describe() 返回的是 { writable, hasDocument, namespaces: [...] }，
        // 不是数组——每个 namespace 视图带 { ns, value, user, revision, ... }，
        // ns 就是 cordis 的行 id（这里是 dsh-github）。
        //
        // 同步失败时保持 null：开关会落在未选中态，而不是错误地显示成
        // 「已开启」——把默认关闭的写权限显示为开启是危险的误导。
        const applyConfig = (patch) => {
          if (!patch || typeof patch !== 'object') return;
          store.set({
            injectContext: patch.injectContext !== false,
            injectMaxFiles: Number(patch.injectMaxFiles) || 12,
            allowWriteOperations: patch.allowWriteOperations === true,
          });
        };

        if (settingsRemote && typeof settingsRemote.describe === 'function') {
          Promise.resolve(settingsRemote.describe())
            .then((result) => {
              const rows = Array.isArray(result?.namespaces) ? result.namespaces : [];
              const row = rows.find((entry) => entry?.ns === 'dsh-github');
              if (row) applyConfig(row.value);
            })
            .catch(() => {});
        }

        const onConfig = (patch) => {
          if (!settingsRemote || typeof settingsRemote.mutate !== 'function') return;
          Promise.resolve(settingsRemote.mutate('dsh-github', Object.entries(patch).map(
            ([key, value]) => ({ op: 'set', path: [key], value }),
          ))).catch(() => {});
        };

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'github',
          order: 15,
          label: () => t('panel.title'),
        }, GitIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'github',
          inject: () => ({ ctx, store, t }),
        }, GithubPanel));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-github',
          order: 30,
          label: () => t('settings.title'),
          inject: () => ({ store, t, onConfig }),
        }, GithubSettings));
      },
    };
  },
});
