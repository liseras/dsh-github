/**
 * Config 形状与工具 schema，零外部依赖。
 *
 * 为什么不用 schemastery 定义 Config：
 * 插件装在 `${DSH_HOME}/profiles/<p>/node_modules` 下，那个目录里没有
 * dsh 的内部包，导入期就会失败（实测导致 `failed to import`）。
 *
 * settings 服务对一个可编辑 Config 的要求有**三条**（读自 cordis 的
 * resolveConfig 与 dsh-settings 的 schema()）：
 *
 * 1. `Config['~standard'].validate(raw)` —— Loader 激活时用它校验并规范化配置。
 *    缺了它 `resolveConfig` 会抛错，该行状态变成 `unsupported`，
 *    设置页拿不到真实值（开关会退回到客户端的兜底初值）。
 *    这是 Standard Schema 接口，见 https://standardschema.dev。
 * 2. `Config.toJSON()` 返回 schemastery 风格的节点树（有 `type`、`dict`、`meta`）。
 * 3. 顶层 `meta.volatile` 为真，表示这些字段可以实时编辑。
 *
 * 三条都按契约手写，行为与 `z.object({...}).volatile()` 一致。
 */

/** 一个布尔字段节点。 */
function booleanNode(description, defaultValue) {
  return {
    type: 'boolean',
    meta: { description, default: defaultValue, required: false },
  };
}

/** 一个数字字段节点，带上下界。 */
function numberNode(description, defaultValue, min, max) {
  return {
    type: 'number',
    meta: { description, default: defaultValue, required: false, min, max },
  };
}

/** 按节点类型把原始值规整成合法值；非法值退回默认值，而不是抛错。 */
function coerce(node, value) {
  const fallback = node.meta.default;
  switch (node.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : fallback;
    case 'number': {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return fallback;
      const { min, max } = node.meta;
      return Math.min(max ?? number, Math.max(min ?? number, number));
    }
    case 'string':
      return typeof value === 'string' ? value : fallback;
    default:
      return value === undefined ? fallback : value;
  }
}

const dict = {
  injectContext: booleanNode(
    '在当前会话涉及 git 时，把分支、改动与上游状态作为运行时上下文提供给模型。',
    true,
  ),
  injectMaxFiles: numberNode(
    '上下文注入中包含的改动文件条数上限。',
    12,
    1,
    50,
  ),
  allowWriteOperations: booleanNode(
    '允许模型直接执行提交、推送、切换分支等写操作。关闭时模型只能读取仓库状态。',
    false,
  ),
};

/**
 * 插件的 Config。
 *
 * `meta.volatile` 是设置表单能实时编辑这些字段的前提；
 * 插件里读值必须走 `readConfig(config)`，因为 volatile 的 config
 * 是一个带 `.get()` 的引用，不是普通对象。
 */
export const Config = {
  type: 'object',
  meta: { volatile: true, required: false },
  dict,

  /**
   * Standard Schema 接口。Loader 在激活时调用它校验配置，
   * 成功返回 `{ value }`，失败返回 `{ issues }`。
   *
   * 这里不做严格拒绝：配置来自用户手写的 patch 或设置表单，
   * 一个字段写错不该让整个插件拒绝加载。非法值一律规整成默认值，
   * 于是行始终能激活，设置页也总能读到真实值。
   */
  '~standard': {
    version: 1,
    vendor: 'dsh-github',
    validate(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const value = {};
      for (const [key, node] of Object.entries(dict)) {
        value[key] = coerce(node, source[key]);
      }
      return { value };
    },
  },

  /**
   * dsh-settings 通过 `toJSON()` 读取形状。
   * 深拷一层，避免调用方改到内部节点。
   */
  toJSON() {
    return {
      type: this.type,
      meta: { ...this.meta },
      dict: Object.fromEntries(
        Object.entries(this.dict).map(([key, node]) => [key, { ...node, meta: { ...node.meta } }]),
      ),
    };
  },
};

/** 默认值，供未配置时使用。 */
export const CONFIG_DEFAULTS = Object.freeze({
  injectContext: true,
  injectMaxFiles: 12,
  allowWriteOperations: false,
});

/**
 * 读取 config，兼容三种形态：
 * - volatile 引用（`{ get() }`，本插件 Config 的实际形态）
 * - 普通对象（直接调用 apply 传配置的测试路径）
 * - undefined（未配置）
 * @param {unknown} config
 * @returns {{ injectContext: boolean, injectMaxFiles: number, allowWriteOperations: boolean }}
 */
export function readConfig(config) {
  let raw = config;
  if (raw && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      raw = raw.get();
    } catch {
      raw = undefined;
    }
  }
  if (raw === null || typeof raw !== 'object') raw = {};
  const files = Number(raw.injectMaxFiles);
  return {
    injectContext: raw.injectContext !== false,
    injectMaxFiles: Number.isFinite(files)
      ? Math.min(50, Math.max(1, Math.trunc(files)))
      : CONFIG_DEFAULTS.injectMaxFiles,
    allowWriteOperations: raw.allowWriteOperations === true,
  };
}

/**
 * 工具参数 schema。
 *
 * 宿主对工具参数只支持一个受限子集：
 * `type / oneOf / properties / required / additionalProperties / items / enum / const`
 * 外加注解（description/title/default/examples）。超出子集的键会在注册时抛错，
 * 所以这里不做任何花哨写法。
 */
export const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: '要执行的操作。只读操作始终可用；写操作需要用户已开启写权限。',
      enum: [
        'status', 'log', 'diff', 'branches', 'remotes',
        'stage', 'unstage', 'commit', 'checkout', 'createBranch',
        'fetch', 'pull', 'push', 'stash',
      ],
    },
    dir: {
      type: 'string',
      description: '仓库内或仓库下的目录；省略时使用当前会话的工作目录。',
    },
    args: {
      type: 'object',
      description: '操作参数，例如 { "paths": ["a.js"] }、{ "message": "fix: …" }。',
      additionalProperties: true,
      properties: {},
    },
  },
  required: ['action'],
  additionalProperties: false,
};

/** 工具输出 schema。结果形态随 action 变化，因此留成开放对象。 */
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};
