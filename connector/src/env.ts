// Worker の環境（wrangler.jsonc の vars・秘密・バインディング）。設定の読み方は config.ts。
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { ConfigEnv } from './config'

export { vaultConfig, workerConfig, type VaultConfig, type WorkerConfig } from './config'

export interface Env extends ConfigEnv {
  OAUTH_KV: KVNamespace
  VAULT: DurableObjectNamespace
  /** OAuth のライブラリが入れる（defaultHandler の中で使える） */
  OAUTH_PROVIDER?: OAuthHelpers
}
