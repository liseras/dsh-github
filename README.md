# dsh-github

当前工作区的 Git 集成插件：给 Harness 加上一个 **Git 面板**、一个 **`git` 工具**，以及**条件性的仓库状态上下文注入**。

## 功能

**面板**（左侧栏 → Git 图标，占满中栏）

- 顶部可填任意仓库目录并加载；填 `..` 之类不会逃出仓库根。
- 状态条：当前分支 / 游离 HEAD、上游分支、领先落后数。
- 四个页签：
  - **改动** —— 已暂存 / 未暂存 / 未跟踪 / 冲突分组列出；点文件名看该文件的 diff。「全部暂存」按钮执行 `git add --all`。
  - **历史** —— 最近 40 条提交（短哈希、标题、作者、日期）。
  - **分支** —— 本地分支及上游、领先落后。
  - **远端** —— 远端名与 URL。
- 底部提交框：填信息后点「提交」。**提交、暂存、推送等写操作一律先弹确认框。**

**工具**（模型可用）

一个 `git` 工具，用 `action` 参数覆盖全部操作：

| 类别 | action |
|---|---|
| 只读 | `status` `log` `diff` `branches` `remotes` |
| 写 | `stage` `unstage` `commit` `checkout` `createBranch` `fetch` `pull` `push` `stash` |

写操作默认**禁止**模型执行，需要在设置里开启「允许模型执行写操作」。关闭时模型只能读。

**上下文注入**

当会话的工作目录确实是一个 git 仓库时，把分支、上游同步状态、改动文件列表作为运行时上下文注入。非 git 会话**完全不注入**，不为无关请求增加 token。

**设置页**（设置 → GitHub）

- Personal Access Token 的保存 / 清除 / 验证（验证调用 `GET /user`，只回状态与账号名，不回内容）。
- 三个开关：是否注入上下文、注入的文件数上限、是否允许模型写。

## 认证

令牌存在 Harness 的凭据存储里（`CredentialKey` 记录式），不是环境变量、不写入 `cordis.patch.yml`。

远端操作用 `GIT_ASKPASS` 传递凭据，而不是把令牌放进远端 URL —— URL 会出现在 `.git/config`、`git remote -v` 和 git 自己的错误输出里。askpass 脚本每次操作用完即删，权限 0700。

任何回给 UI 或模型的 git 输出都会过一遍脱敏：`https://user:token@host` 与裸 `ghp_*` 都会被遮蔽。

## 结构

```
lib/git.js         git 子进程执行 + porcelain v2 解析 + 参数校验
lib/operations.js  语义操作（UI 与工具共用的唯一实现）
lib/auth.js        令牌存取 + git 认证环境
lib/config.js      Config 形状 + 工具 schema（零依赖）
lib/index.js       装配：服务、工具、条件上下文注入、HTTP 路由
client.js          浏览器半：侧栏图标 + 主面板 + 设置页
```

## 两条调用路径，一份实现

Agent 走 `git` 工具，UI 走同源 HTTP 路由 `/api/dsh-github`，两者都调用 `lib/index.js` 里同一个服务对象。不在 UI 里复制一份操作逻辑。

## 依赖说明

**不 import 任何 `@deepseek-ai/*` 运行时包。** 插件装在 `${DSH_HOME}/profiles/<profile>/node_modules` 下，那个目录没有 dsh 的内部依赖；直接 import schemastery 或 dsh-tools 会在导入期失败（`dsh-github: failed to import`）。因此：

- `Config` 在 `lib/config.js` 里手写，实现宿主需要的三条契约（缺一不可）：
  1. `Config['~standard'].validate(raw)` —— cordis 的 `resolveConfig` 用它校验配置。**缺了它该行状态会变成 `unsupported`**，设置页拿不到真实值，开关会退回到客户端兜底初值。
  2. `Config.toJSON()` —— dsh-settings 的 `describe()` 用它生成表单。
  3. 顶层 `meta.volatile: true` —— 表示字段可实时编辑，无需重启。
- 工具用宿主原生的 `ToolDefinition` 格式注册，`parameters` / `output.schema` 都在宿主支持的 JSON Schema 子集内（`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + 注解）。

## 设置读写

Client 侧读写设置走 `ctx.remote.settings`，两个容易踩的点：

- `describe()` 返回 `{ writable, hasDocument, namespaces: [...] }`，**不是数组**。每个 namespace 视图是 `{ ns, value, user, schema, revision, ... }`，`ns` 就是 cordis 行 id（`dsh-github`）。
- 取 remote 一律用 `ctx.get(...)`。属性式 `ctx.remote` 读取会在 `apply()` 内抛错，导致整条 Client 条目激活失败。

同步失败时开关保持未选中态，而不是落到 `true`——把默认关闭的写权限显示成「已开启」是危险的误导。

## 两个已踩过的坑

**1. `inject` 漏声明只在调用时暴露**

Cordis 的服务代理要求先在 `inject` 里声明，才能读 `ctx.<service>`；否则抛出
`cannot get property "credentials" without inject`。这个错误**装配期看不出来**——
插件能正常加载、UI 能正常渲染，只有真正调用的那一刻才炸。

本插件因此漏过 `credentials`，导致令牌保存永远失败（错误显示在设置页，
而令牌从未写入）。验证方式：用 Proxy 模拟服务代理，未声明的属性直接抛错，
然后跑一遍真实调用路径——普通对象做的假 ctx 抓不到这类问题。

**2. 系统密码管理器会抢 `type="password"` 输入框**

令牌框用 `type="password"` 时，手机的系统密码管理器（实测小米
`com.miui.passwords`）会弹出自动填充界面接管，打断保存流程。
令牌是一次性粘贴的 API 凭据、不是登录密码，所以默认明文显示，
配一个「显示/隐藏」切换，并加 `autoComplete="new-password"` 与
`data-form-type="other"` 阻断识别。

## 安全边界

- 所有 git 调用走 argv 数组，不拼 shell 字符串；用户输入永远作为独立参数。
- ref / 远端名不得以 `-` 开头（挡住 `--upload-pack=…` 这类选项注入）。
- 路径只接受仓库内相对路径，拒绝绝对路径与 `..`。
- 推送的强制模式只允许 `--force-with-lease`，不允许裸 `--force`。
- `pull` 默认 `--ff-only`，不替用户选择合并策略。
- HTTP 路由只接受 GET/POST，请求体上限 64 KiB。
