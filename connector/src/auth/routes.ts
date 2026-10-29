// OAuth のライブラリが受け持たない画面と API（defaultHandler）:
//   GET  /                 状態（準備OK / 匿名ログイン無効 / 未連携）。データは出さない
//   GET  /authorize        受け付けるクライアントか確かめ（KV に書く前）、回数を数え、同意の画面
//   POST /authorize        ［Novel Studio で確認する］→ アプリの連携の画面（#/claude/connect?s=<state>）へ
//   GET  /pair/callback    アプリから戻る（?state=…&k=…）。cookie と k の指紋を確かめて、claude.ai へ許可を返す
//   GET  /connect/identity アプリの連携の画面が読むコネクタの身元 { uid, version, model }（CORS はアプリの origin だけ）
// 連携の決まり（DECISIONS 9。URL の形・k・指紋はアプリと同じ src/claude/pairing.ts）: アプリは config/connector に
// pairing = sha256hex(s + '.' + k) を書き、k は URL でだけ渡す。
// state を持つ cookie は claude.ai から始めたブラウザに、k はアプリを開いた持ち主のブラウザにだけあるので、
// 誰かが自分の state のリンクを持ち主に開かせても、連携は完成しない。
import { AuthorizationError, CimdFetchError, type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { workerConfig, type Env } from '../env'
import { errorPage, escapeHtml, json, page } from '../http'
import { log, logError } from '../log'
import { CONNECTOR_MODEL, CONNECTOR_VERSION } from '../version'
import { CALLBACK_PATH, IDENTITY_PATH, connectPageUrl, isPairingKey, pairingHash, validState } from '../../../src/claude/pairing'
import { vault } from '../vault/Vault'
import { checkClient } from './clientPolicy'
import { consentPage } from './consentPage'

export const SCOPES_SUPPORTED = ['novel', 'offline_access']

/** 許可する範囲（要求された中で使えるもの＋いつも novel） */
export function grantedScopes(requested: readonly string[]): string[] {
  const out = new Set(requested.filter((s) => SCOPES_SUPPORTED.includes(s)))
  out.add('novel')
  return [...out]
}

function helpers(env: Env): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error('OAUTH_PROVIDER がありません')
  return env.OAUTH_PROVIDER
}

const LOCAL_APP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function corsHeaders(origin: string | null, env: Env, url: string): Headers | null {
  const h = new Headers({ Vary: 'Origin' })
  if (!origin) return h
  const cfg = workerConfig(env, url)
  if (origin === cfg.appOrigin || (cfg.allowLocalhostApp && LOCAL_APP.test(origin))) {
    h.set('Access-Control-Allow-Origin', origin)
    h.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
    h.set('Access-Control-Max-Age', '600')
    return h
  }
  return null
}

async function connectIdentity(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request.headers.get('Origin'), env, request.url)
  if (!cors) {
    log('identity_origin_refused', { host: safeHost(request.headers.get('Origin')) })
    return json({ error: 'origin', message: 'この origin からは使えません' }, { status: 403 })
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'GET') return json({ error: 'method' }, { status: 405 }, cors)
  try {
    const id = await vault(env).connectIdentity()
    if (id.ok) return json({ uid: id.uid, version: id.version, model: id.model }, {}, cors)
    return json({ error: id.code, message: id.message }, { status: 503 }, cors)
  } catch (e) {
    logError('identity_failed', e)
    return json({ error: 'unavailable', message: 'コネクタの身元を用意できませんでした' }, { status: 503 }, cors)
  }
}

function safeHost(origin: string | null): string {
  if (!origin) return ''
  try {
    return new URL(origin).host
  } catch {
    return '[origin]'
  }
}

async function health(env: Env): Promise<Response> {
  let state = 'unavailable'
  try {
    state = await vault(env).health()
  } catch (e) {
    logError('health_failed', e)
  }
  const label: Record<string, string> = {
    ready: '準備OK（連携済み）',
    unpaired: '未連携（claude.ai でコネクタに接続し、アプリで許可してください）',
    no_identity: '未連携（まだ一度も接続されていません）',
    anonymous_disabled: '匿名ログイン無効（Firebase コンソールで「匿名」を有効にしてください）',
    key_missing: '鍵（TOKEN_ENC_KEY）が未設定（npm run connector:setup をもう一度実行してください）',
    unavailable: '一時的に Firebase に接続できません',
  }
  return page(
    'Novel Studio コネクタ',
    `<h1>Novel Studio コネクタ</h1><div class="card"><p data-testid="connector-health" data-state="${escapeHtml(state)}">${escapeHtml(label[state] ?? state)}</p><p class="muted">版 ${CONNECTOR_VERSION}・データの形 ${CONNECTOR_MODEL}</p></div>`,
  )
}

async function authorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env)
  const cfg = workerConfig(env, request.url)
  // 外への取得（ライブラリが client_id の URL の公開の識別子を取りに行く）の前に、問い合わせの値だけで受け付けるクライアントか
  // 確かめる（知らない URL を取りに行かない・ログに書かない）。ライブラリが読むのと同じ値（無ければ空）
  const q = new URL(request.url).searchParams
  const pre = checkClient({ clientId: q.get('client_id') ?? '', redirectUri: q.get('redirect_uri') ?? '' }, cfg)
  if (!pre.ok) {
    log('authorize_refused', { reason: pre.reason })
    return errorPage(pre.message, 400)
  }
  let authRequest
  try {
    authRequest = await oauth.parseAuthRequest(request)
  } catch (e) {
    return authFailure(e)
  }
  const policy = checkClient(authRequest, cfg)
  if (!policy.ok) {
    log('authorize_refused', { reason: policy.reason })
    return errorPage(policy.message, 400)
  }
  if (!(await vault(env).takeRate('authorize'))) {
    log('authorize_rate_limited')
    return errorPage('接続の要求が多すぎます。1時間ほど待ってから、claude.ai でもう一度「接続」を押してください。', 429)
  }
  try {
    const details = await oauth.describeConsent(authRequest)
    const consent = await oauth.beginConsent(authRequest)
    return consentPage(details, consent.handle, cfg.appOrigin, consent.headers)
  } catch (e) {
    return authFailure(e)
  }
}

async function authorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env)
  const cfg = workerConfig(env, request.url)
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorPage('送られた内容を読めませんでした。claude.ai でもう一度「接続」を押してください。')
  }
  const handle = String(form.get('handle') ?? '')
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle)
      log('authorize_denied')
      return new Response(null, { status: 302, headers: denied.headers })
    }
    // 同意の画面に範囲の選択は出さない: いつも novel と offline_access（更新用トークン）
    const approved = await oauth.approveConsent(request, handle, { scope: SCOPES_SUPPORTED })
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { t: Date.now() }, headers: approved.headers })
    headers.set('Location', connectPageUrl(cfg.appOrigin, state))
    headers.set('Cache-Control', 'no-store')
    headers.set('Referrer-Policy', 'no-referrer')
    log('authorize_approved')
    return new Response(null, { status: 302, headers })
  } catch (e) {
    return authFailure(e)
  }
}

async function pairCallback(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env)
  const url = new URL(request.url)
  const state = validState(url.searchParams.get('state'))
  const k = url.searchParams.get('k')
  let resumed
  try {
    resumed = await oauth.finishUpstream<{ t?: number }>(request)
  } catch (e) {
    if (e instanceof AuthorizationError) {
      log('pair_callback_refused', { reason: 'upstream' })
      return errorPage(
        '連携の確かめの期限が切れたか、claude.ai で接続を始めたのとは別のブラウザで開かれました。claude.ai で接続を始めたブラウザで、もう一度「接続」からやり直してください。',
      )
    }
    return authFailure(e)
  }
  if (!isPairingKey(k) || !state) {
    log('pair_callback_refused', { reason: 'k' })
    return errorPage('連携の確かめの値がありません。アプリの連携の画面からやり直してください。')
  }
  const check = await vault(env).verifyPairing(await pairingHash(state, k))
  if (!check.ok) return errorPage(check.message)
  try {
    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: check.ownerUid,
      metadata: { label: 'Claude' },
      scope: grantedScopes(resumed.request.scope),
      // 許可を、いまの連携（持ち主・連携の代）に結び付ける（解除した後に連携し直すと、前の許可は使えない）
      props: { ownerUid: check.ownerUid, gen: check.gen },
    })
    resumed.headers.set('Location', redirectTo)
    resumed.headers.set('Cache-Control', 'no-store')
    resumed.headers.set('Referrer-Policy', 'no-referrer')
    log('pair_completed')
    return new Response(null, { status: 302, headers: resumed.headers })
  } catch (e) {
    return authFailure(e)
  }
}

function authFailure(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    log('authorize_error', { description: e.description?.slice(0, 120) })
    return errorPage(`接続を受け付けられませんでした（${e.description || '形が違います'}）。claude.ai でもう一度「接続」を押してください。`)
  }
  if (e instanceof CimdFetchError) {
    log('authorize_cimd_failed', { reason: e.reason })
    return errorPage('claude.ai の公開の識別子を確かめられませんでした。少し待ってから、claude.ai でもう一度「接続」を押してください。', 502)
  }
  logError('authorize_failed', e)
  return errorPage('接続の処理で問題が起きました。少し待ってから、もう一度試してください。', 500)
}

/** defaultHandler の fetch */
export async function appFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  switch (url.pathname) {
    case '/':
      return request.method === 'GET' ? health(env) : new Response(null, { status: 405 })
    case '/authorize':
      if (request.method === 'GET') return authorizeGet(request, env)
      if (request.method === 'POST') return authorizePost(request, env)
      return new Response(null, { status: 405 })
    case CALLBACK_PATH:
      return request.method === 'GET' ? pairCallback(request, env) : new Response(null, { status: 405 })
    case IDENTITY_PATH:
      return connectIdentity(request, env)
    default:
      return new Response('Not found', { status: 404 })
  }
}
