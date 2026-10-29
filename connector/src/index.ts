// Novel Studio の Claude 用コネクタ（Cloudflare Worker）。
// - OAuth 2.1 の認可サーバー（@cloudflare/workers-oauth-provider）: claude.ai の公開の識別子（CIMD）で受け付ける。DCR は
//   ENABLE_DCR の時だけ。同意は毎回聞く（覚えない）
// - /mcp: MCP のサーバー（@modelcontextprotocol/server）。トークンのある呼び出しだけ
// - Vault（Durable Object）: コネクタ自身の匿名の Firebase のアカウント・持ち主の記録の写し・数の記録
// - 毎日 4:17（日本時間）: 期限切れの OAuth の記録の片付けと、写しの数の確かめ
import OAuthProvider, { GrantType, OAuthError, getOAuthApi, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'
import { allowedCimdId, checkRegistration } from './auth/clientPolicy'
import { SCOPES_SUPPORTED, appFetch } from './auth/routes'
import { workerConfig, type Env } from './env'
import { log, logError } from './log'
import { createMcpFetch } from './mcp/handler'
import type { GrantProps } from './vault/core'
import { vault } from './vault/Vault'

export { Vault } from './vault/Vault'

/** OAuth のライブラリの設定（MCP の URL ごと。最初の公開では URL がまだ決まっていないので、リクエストの URL から決める） */
export function oauthOptions(env: Env, requestUrl?: string): OAuthProviderOptions<Env> {
  const cfg = workerConfig(env, requestUrl)
  const options: OAuthProviderOptions<Env> = {
    apiRoute: '/mcp',
    apiHandler: { fetch: createMcpFetch(() => options) as never },
    defaultHandler: { fetch: appFetch as never },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    ...(cfg.enableDcr
      ? {
          clientRegistrationEndpoint: '/oauth/register',
          clientRegistrationCallback: async ({ clientMetadata }) => {
            const policy = checkRegistration(clientMetadata, cfg)
            if (!policy.ok) {
              log('register_refused', { reason: policy.reason })
              return { code: 'invalid_redirect_uri', description: policy.message, status: 400 }
            }
            if (!(await vault(env).takeRate('register'))) {
              log('register_rate_limited')
              return { code: 'invalid_client_metadata', description: 'too many registrations today', status: 429 }
            }
          },
        }
      : {}),
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES_SUPPORTED,
    requiredScopes: ['novel'],
    resourceMetadata: { resource: cfg.mcpResource, resource_name: 'Novel Studio' },
    accessTokenTTL: 3600,
    refreshTokenTTL: 180 * 86_400,
    refreshTokenIdleTTL: 180 * 86_400,
    tokenExchangeCallback: async ({ grantType, env: e, props }) => {
      // 連携が解除された・前の連携の許可（解除した後に連携し直した・持ち主が変わった）なら、更新用トークンを断る
      // （この許可はライブラリが取り消し、claude.ai は接続し直しを求める）。毎回 Vault に確かめる（キャッシュしない）
      if (grantType !== GrantType.REFRESH_TOKEN) return
      let current: boolean
      try {
        current = await vault(e).grantCurrent(props as GrantProps)
      } catch (err) {
        // Vault に届かない一時的な失敗では接続を切らない
        logError('grant_check_failed', err)
        return
      }
      if (!current) {
        log('refresh_refused')
        throw new OAuthError('invalid_grant', { description: 'Novel Studio connector is unpaired' })
      }
    },
    onError: ({ code, status, internal }) => {
      log('oauth_error', { code, status, category: internal?.category, reason: internal?.reason })
    },
  }
  return options
}

let cached: { key: string; provider: OAuthProvider<Env> } | null = null

function provider(env: Env, url: string): OAuthProvider<Env> {
  const cfg = workerConfig(env, url)
  const key = `${cfg.mcpResource}|${cfg.enableDcr}|${cfg.allowClaudeCode}`
  if (!cached || cached.key !== key) cached = { key, provider: new OAuthProvider<Env>(oauthOptions(env, url)) }
  return cached.provider
}

/**
 * トークンの要求の client_id（ライブラリと同じ読み方: 本文の client_id はすべて・Basic 認証。クライアント認証の値の空はライブラリが
 * 捨てるので数えない）と、client_assertion を送ったか（claude.ai の CIMD は token_endpoint_auth_method "none" で、送らない）
 */
async function tokenClient(request: Request): Promise<{ ids: string[]; assertion: boolean }> {
  let form: FormData | null = null
  try {
    form = await request.clone().formData()
  } catch {
    form = null
  }
  const sent = (k: string) => (form?.getAll(k) ?? []).filter((v) => v !== '')
  const ids = sent('client_id').filter((v): v is string => typeof v === 'string')
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '')
  if (basic) {
    try {
      ids.push(decodeURIComponent((atob(basic[1].trim()).split(':')[0] ?? '').replace(/\+/g, ' ')))
    } catch {
      // 読めない Basic 認証はライブラリが断る（取りに行かない）
    }
  }
  return { ids, assertion: sent('client_assertion').length > 0 || sent('client_assertion_type').length > 0 }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // トークンの要求でも、受け付けない公開の識別子（URL の client_id）はライブラリが取りに行く前に断る。client_assertion
    // （private_key_jwt）も断る: client_id が無いとライブラリは assertion の iss の URL を取りに行き、jti を KV に書く
    if (request.method === 'POST' && new URL(request.url).pathname === '/oauth/token') {
      const client = await tokenClient(request)
      const cfg = workerConfig(env, request.url)
      if (client.assertion || !client.ids.every((id) => allowedCimdId(id, cfg))) {
        log('token_client_refused')
        return Response.json(
          { error: 'invalid_client', error_description: 'client is not accepted by this connector' },
          { status: 401, headers: { 'Cache-Control': 'no-store' } },
        )
      }
    }
    return provider(env, request.url).fetch(request, env, ctx)
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 片付けは MCP の URL に関わらないので、URL がまだ決まっていなくても仮の URL で設定を作る
    const base = workerConfig(env).publicOrigin || 'https://novel-studio-connector.invalid'
    ctx.waitUntil(
      (async () => {
        try {
          const r = await getOAuthApi(oauthOptions(env, `${base}/`), env).purgeExpiredData()
          log('oauth_purged', { complete: (r as { complete?: boolean }).complete })
        } catch (e) {
          logError('oauth_purge_failed', e)
        }
        try {
          log('nightly', { result: await vault(env).nightly() })
        } catch (e) {
          logError('nightly_failed', e)
        }
      })(),
    )
  },
} satisfies ExportedHandler<Env>
