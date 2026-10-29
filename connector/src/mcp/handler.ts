// /mcp（OAuth のライブラリがトークンを確かめた後に呼ぶ apiHandler）。
// - Origin: 無い・claude.ai・claude.com・このコネクタ自身だけ（ほかは 403。ログには host だけ）
// - 本文は 1MB まで。2025 年版の呼び出し（initialize あり）も 2026-07-28 版も、状態を持たずに1回ずつ答える
// - ツールの呼び出しには OAuth の許可の props（持ち主・連携の代）を渡す。前の連携の許可・連携が解除された・身元を失った時は、
//   このトークンの許可だけを取り消して HTTP 401 にする（claude.ai がトークンを更新しようとして invalid_grant になり、接続し直しを
//   求める）。持ち主のすべての許可は取り消さない（連携し直した新しい許可まで取り消さないように。ほかの古い許可は、それぞれの
//   呼び出し・トークンの更新の時に断られる）
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server'
import { workerConfig, type Env } from '../env'
import { json } from '../http'
import { log, logError } from '../log'
import { vault } from '../vault/Vault'
import type { GrantProps } from '../vault/core'
import type { ToolResult } from '../vault/tools/common'
import { createServer } from './server'
import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'

export const MAX_BODY = 1_000_000

interface RequestState {
  authProblem: boolean
  userAgent?: string
  grant: GrantProps
}

/** 1つの Worker の中で使い回す（リクエストごとのことは authInfo.extra で渡す） */
let handler: ReturnType<typeof createMcpHandler> | null = null

function mcpHandler(env: Env) {
  if (handler) return handler
  handler = createMcpHandler(
    (rc) => {
      const state = (rc.authInfo?.extra?.state ?? { authProblem: false, grant: {} }) as RequestState
      return createServer(
        async (name, args, opts) => {
          // Durable Object の RPC の戻り値は構造化複製（型は ToolResult のまま）
          const r = (await vault(env).callTool(name, args, { ...opts, grant: state.grant })) as unknown as ToolResult
          if (r.auth) state.authProblem = true
          return r
        },
        { userAgent: state.userAgent },
      )
    },
    { legacy: 'stateless', maxRequestBodySize: MAX_BODY, responseMode: 'json', onerror: (e) => log('mcp_error', { name: e.name }) },
  )
  return handler
}

/** テストで使い回しを外す */
export function resetMcpHandler(): void {
  handler = null
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return '[origin]'
  }
}

function allowedOrigin(origin: string, env: Env, url: string): boolean {
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const own = new URL(workerConfig(env, url).publicOrigin).host
  return host === 'claude.ai' || host === 'claude.com' || host === own
}

export function unauthorized(env: Env, url: string, description: string): Response {
  const cfg = workerConfig(env, url)
  // ヘッダーは ASCII だけ（日本語の説明は本文に）
  const h = new Headers({
    'WWW-Authenticate': `Bearer error="invalid_token", error_description="connector unpaired", resource_metadata="${cfg.publicOrigin}/.well-known/oauth-protected-resource/mcp"`,
  })
  return json({ error: 'invalid_token', error_description: description }, { status: 401 }, h)
}

/** ツールの呼び出し（tools/call）を含む POST か（その時だけ、応答を待ってから 401 にするかを決める） */
async function hasToolCall(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false
  try {
    const text = await request.clone().text()
    if (text.length > MAX_BODY) return false
    const msg = JSON.parse(text) as unknown
    const list = Array.isArray(msg) ? msg : [msg]
    return list.some((m) => (m as { method?: unknown })?.method === 'tools/call')
  } catch {
    return false
  }
}

/** アクセストークン（`${userId}:${grantId}:${秘密}`）の許可の id */
export function grantIdOf(token: string | undefined): string | null {
  const parts = (token ?? '').split(':')
  return parts.length === 3 && parts[1] ? parts[1] : null
}

/** このトークンの OAuth の許可だけを取り消す（トークンそのものはログに出さない） */
export async function revokeGrantOf(
  env: Env,
  options: OAuthProviderOptions<Env>,
  userId: string | undefined,
  token: string | undefined,
): Promise<void> {
  const grantId = grantIdOf(token)
  if (!userId || !grantId) return
  try {
    await getOAuthApi(options, env).revokeGrant(grantId, userId)
    log('grant_revoked')
  } catch (e) {
    logError('grant_revoke_failed', e)
  }
}

export function createMcpFetch(options: () => OAuthProviderOptions<Env>) {
  return async function mcpFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin')
    if (origin && !allowedOrigin(origin, env, request.url)) {
      log('mcp_origin_refused', { host: safeHost(origin) })
      return json({ error: 'forbidden_origin' }, { status: 403 })
    }
    const props = ((ctx as unknown as { props?: GrantProps }).props ?? {}) as GrantProps
    const auth = (
      ctx as unknown as { auth?: { token?: string; userId?: string; clientId?: string; scope?: string[]; expiresAt?: number } }
    ).auth
    const state: RequestState = {
      authProblem: false,
      userAgent: request.headers.get('User-Agent') ?? undefined,
      grant: { ownerUid: props.ownerUid, gen: props.gen },
    }
    const authInfo: AuthInfo = {
      token: '',
      clientId: auth?.clientId ?? 'claude',
      scopes: auth?.scope ?? [],
      ...(auth?.expiresAt ? { expiresAt: auth.expiresAt } : {}),
      extra: { state },
    }
    const call = await hasToolCall(request)
    const res = await mcpHandler(env).fetch(request, { authInfo })
    if (!call) return res
    // ツールの呼び出しは、答えが出るまで待ってから（連携が解除されていたら 401 にする）
    const body = await res.arrayBuffer()
    if (!state.authProblem) return new Response(body, { status: res.status, headers: res.headers })
    ctx.waitUntil(revokeGrantOf(env, options(), auth?.userId, auth?.token))
    return unauthorized(env, request.url, 'Novel Studio 側で連携が解除されています')
  }
}
