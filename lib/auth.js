/**
 * GitHub 凭据存取。
 *
 * 为什么用 CredentialKey 记录而不是环境变量：
 * 环境变量式（CredentialRef）的写入点在 profile patch / .env，值以明文留在文件里；
 * CredentialKey 的记录式存储由 credentials 服务托管，set/unset 是受控的，
 * 且 describeRecord 能在不暴露值的前提下告知「是否已配置」。
 *
 * 值只在一个地方取用：网络操作前 resolve，用完即弃，从不写入日志或会话。
 */

/**
 * 记录的键，必须是 `<scope>/<id>` 两段式。
 *
 * 这里踩过一个会让**整个 Harness 起不来**的坑：key 曾写成
 * `dsh-github.token`（点号）。写入当时不报错，但下次启动时
 * `credentials-local` 在 `loadInitial` 里解析整个文档，
 * `parseCredentialKey` 对没有斜杠的键直接抛 TypeError：
 *
 *   TypeError: credential key "dsh-github.token" must be "<scope>/<id>"
 *
 * 因为 credentials 是 required 服务，它起不来就导致 connection、
 * authorization、deepseek-account 等一连串插件全部等待服务，
 * 最终 `dsh: startup failed: 1 required plugin did not activate`，
 * Web 界面根本打不开 —— 而且报错里只有 "credentials"，
 * 看不到是哪个插件写坏的键。
 *
 * scope 用插件名，id 用自己的寻址单位；两段都必须匹配
 * KEY_SEGMENT_PATTERN（字母数字与 . _ -）。
 */
export const TOKEN_KEY = 'dsh-github/token';

/** 记录形状：git 认证需要用户名与令牌两段。 */
export const RECORD_KIND = 'api-key';

/**
 * 读取当前令牌。
 * @param {any} credentials ctx.credentials
 * @returns {Promise<{ key: string, username: string } | null>}
 */
export async function readToken(credentials) {
  const record = await credentials.readRecord(TOKEN_KEY);
  if (!record || record.kind !== RECORD_KIND) return null;
  const key = typeof record.key === 'string' ? record.key.trim() : '';
  if (key === '') return null;
  const env = record.env ?? {};
  const username = typeof env.username === 'string' && env.username.trim() !== ''
    ? env.username.trim()
    : 'x-access-token';
  return { key, username };
}

/**
 * 写入令牌。modifyRecord 是唯一的写路径，因为它保证读-改-写是串行的。
 * @param {any} credentials
 * @param {string} key
 * @param {string} [username]
 */
export async function writeToken(credentials, key, username) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('令牌不能为空');
  }
  await credentials.modifyRecord(TOKEN_KEY, async () => ({
    kind: RECORD_KIND,
    key: key.trim(),
    ...(username && username.trim() !== ''
      ? { env: { username: username.trim() } }
      : {}),
  }));
}

/** 清除令牌。 */
export async function clearToken(credentials) {
  await credentials.deleteRecord(TOKEN_KEY);
}

/**
 * 令牌是否已配置（不返回值）。
 * @param {any} credentials
 */
export async function tokenStatus(credentials) {
  const info = await credentials.describeRecord(TOKEN_KEY);
  return { configured: info.configured === true, writable: info.writable === true };
}

/**
 * 构造一次 git 网络操作需要的环境。
 *
 * 用 `GIT_ASKPASS` 指向一个一次性脚本，而不是把令牌塞进远端 URL：
 * URL 会出现在 `.git/config`、`git remote -v`、以及 git 自己的错误信息里；
 * askpass 由 git 在需要时调用，凭据只存在于进程环境与标准输出。
 *
 * @param {{ key: string, username: string }} token
 * @returns {{ env: Record<string, string>, cleanup: () => Promise<void> }}
 */
export async function gitAuthEnv(token) {
  const { mkdtemp, writeFile, rm, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-'));
  const script = join(dir, 'askpass.sh');
  // git 会以 "Username for ..." / "Password for ..." 作为参数调用该脚本。
  const body = [
    '#!/bin/sh',
    'case "$1" in',
    `  Username*) printf '%s\\n' ${shellQuote(token.username)} ;;`,
    `  *) printf '%s\\n' ${shellQuote(token.key)} ;;`,
    'esac',
    '',
  ].join('\n');
  await writeFile(script, body, { mode: 0o700 });
  await chmod(script, 0o700);

  return {
    env: {
      GIT_ASKPASS: script,
      GIT_TERMINAL_PROMPT: '0',
      // 阻止 ssh 方式回退到交互式提示。
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 单引号包裹，内部单引号转义为 '\''。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
