// 環境の変数（wrangler.jsonc の vars・秘密）から読む設定。Workers の型を使わない（Node のテストでも読み込めるように）。

/** 文字列の変数（Env の一部） */
export interface ConfigEnv {
  /** claude.ai に登録する URL（https://….workers.dev/mcp）。空ならリクエストの URL から決める */
  MCP_RESOURCE: string
  /** コネクタの origin（https://….workers.dev）。空ならリクエストの URL から決める */
  PUBLIC_ORIGIN: string
  /** アプリの origin（連携の画面 #/claude/connect がある所） */
  APP_ORIGIN: string
  FIREBASE_PROJECT_ID: string
  FIREBASE_API_KEY: string
  ENABLE_DCR: string
  ALLOW_CLAUDE_CODE: string
  HEAVY_TOOLS: string
  WORK_BUDGET_CHARS: string
  DAILY_READ_BUDGET: string
  DAILY_WRITE_BUDGET: string
  /** 秘密: 匿名のアカウントの更新用トークンを暗号化する鍵（npm run connector:setup が作る） */
  TOKEN_ENC_KEY?: string
  /** テスト・開発用: Firebase エミュレーターのホスト（127.0.0.1 など）。設定するとエミュレーターにつなぐ */
  FIREBASE_EMULATOR_HOST?: string
  /** 開発用: "true" で http://localhost:* のアプリからの /connect/identity を受け付ける */
  ALLOW_LOCALHOST_APP?: string
}

const flag = (v: string | undefined) => v === 'true'
const count = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Vault（Durable Object）が使う設定 */
export interface VaultConfig {
  projectId: string
  apiKey: string
  /** identitytoolkit（匿名のアカウントを作る）の v1 の URL */
  identityUrl: string
  /** securetoken（ID トークンの更新）の v1 の URL */
  tokenUrl: string
  /** Firestore の REST API の v1 の URL */
  firestoreUrl: string
  workBudgetChars: number
  dailyReadBudget: number
  dailyWriteBudget: number
  heavyTools: boolean
}

export function vaultConfig(env: ConfigEnv): VaultConfig {
  const host = env.FIREBASE_EMULATOR_HOST?.trim()
  return {
    projectId: env.FIREBASE_PROJECT_ID || 'novel-studio-3352e',
    apiKey: env.FIREBASE_API_KEY,
    identityUrl: host
      ? `http://${host}:9099/identitytoolkit.googleapis.com/v1`
      : 'https://identitytoolkit.googleapis.com/v1',
    tokenUrl: host ? `http://${host}:9099/securetoken.googleapis.com/v1` : 'https://securetoken.googleapis.com/v1',
    firestoreUrl: host ? `http://${host}:8080/v1` : 'https://firestore.googleapis.com/v1',
    workBudgetChars: count(env.WORK_BUDGET_CHARS, 300_000),
    dailyReadBudget: count(env.DAILY_READ_BUDGET, 15_000),
    dailyWriteBudget: count(env.DAILY_WRITE_BUDGET, 5_000),
    heavyTools: flag(env.HEAVY_TOOLS),
  }
}

/** Worker（OAuth・画面）の設定 */
export interface WorkerConfig {
  /** コネクタの origin（末尾の / なし） */
  publicOrigin: string
  /** MCP の URL（claude.ai に登録するもの） */
  mcpResource: string
  appOrigin: string
  enableDcr: boolean
  allowClaudeCode: boolean
  allowLocalhostApp: boolean
}

export function workerConfig(env: ConfigEnv, requestUrl?: string): WorkerConfig {
  const fromRequest = requestUrl ? new URL(requestUrl).origin : ''
  const publicOrigin = (env.PUBLIC_ORIGIN || fromRequest).replace(/\/+$/, '')
  return {
    publicOrigin,
    mcpResource: env.MCP_RESOURCE || `${publicOrigin}/mcp`,
    appOrigin: (env.APP_ORIGIN || 'https://novel-studio-3352e.web.app').replace(/\/+$/, ''),
    enableDcr: flag(env.ENABLE_DCR),
    allowClaudeCode: flag(env.ALLOW_CLAUDE_CODE),
    allowLocalhostApp: flag(env.ALLOW_LOCALHOST_APP) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicOrigin),
  }
}
