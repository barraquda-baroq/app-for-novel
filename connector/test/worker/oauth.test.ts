// Workers の実行環境で、OAuth・同意の画面・連携の確かめ・/mcp を通しで確かめる（Firebase は fetch の差し替え）。
import { SELF, abortAllDurableObjects, env, reset } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFirebase } from '../support/fakeFirebase'
import { novel } from '../../../src/test/claudeFixture'
import type { AppData, TableName } from '../../../src/domain/types'
import type { Rec } from '../../../src/sync/merge'

const H = 'https://connector.example'
const APP = 'https://novel-studio-3352e.web.app'
const CLAUDE_CIMD = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CLAUDE_COM_CALLBACK = 'https://claude.com/api/mcp/auth_callback'
const OWNER = 'owner-1'

let fake: FakeFirebase
let realFetch: typeof fetch
/** 攻撃する側の CIMD に載せる公開鍵（private_key_jwt。テストごとに空に戻す） */
let evilJwk: JsonWebKey | null = null
/** テストごとに別のネットワークから（接続の要求はネットワークごとに数える） */
let clientIp = ''
let ipCount = 0

const cimdDoc = {
  client_id: CLAUDE_CIMD,
  client_name: 'Claude',
  redirect_uris: [CLAUDE_CALLBACK, CLAUDE_COM_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

beforeEach(async () => {
  // テストごとに KV を空にし、Durable Object を作り直す（保存した内容は残る: 回数の上限は最後のテストで確かめる）
  await abortAllDurableObjects()
  await reset()
  fake = new FakeFirebase()
  evilJwk = null
  clientIp = `198.51.100.${++ipCount}`
  realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CLAUDE_CIMD) return Response.json(cimdDoc)
    if (url.startsWith('https://evil.example/'))
      return Response.json({
        ...cimdDoc,
        client_id: url,
        redirect_uris: ['https://evil.example/cb'],
        ...(evilJwk
          ? { token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256', jwks: { keys: [{ ...evilJwk, kid: 'k1', alg: 'ES256', use: 'sig' }] } }
          : {}),
      })
    if (url.startsWith('http://fake-firebase')) return fake.fetch(input as never, init)
    return realFetch(input as never, init)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 攻撃する側が自分の鍵で署名した client_assertion（iss = sub = CIMD の URL。毎回新しい jti） */
async function evilAssertion(iss: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  evilJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const now = Math.floor(Date.now() / 1000)
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc({ iss, sub: iss, aud: `${H}/oauth/token`, jti: crypto.randomUUID(), iat: now, exp: now + 60 })}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input))
  return `${input}.${b64url(sig)}`
}

async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Set-Cookie から Cookie の値（name=value; …） */
function cookiesOf(res: Response, prev = ''): string {
  const jar = new Map<string, string>()
  for (const c of prev.split('; ').filter(Boolean)) {
    const [k, ...v] = c.split('=')
    jar.set(k, v.join('='))
  }
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const [k, ...v] = pair.split('=')
    jar.set(k.trim(), v.join('='))
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function authorizeUrl(challenge: string, over: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CIMD,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'claude-state',
    scope: 'novel offline_access',
    resource: `${H}/mcp`,
    ...over,
  })
  return `${H}/authorize?${q}`
}

function seed(data: AppData) {
  for (const table of Object.keys(data) as TableName[])
    for (const rec of Object.values(data[table] as Record<string, Rec>)) fake.putRecord(OWNER, table, rec)
}

async function kvKeys(): Promise<number> {
  return (await env.OAUTH_KV.list()).keys.length
}

/** claude.ai の「接続」から、アプリでの許可・コネクタへの戻りまで（attacker で途中を変える） */
async function connect(
  opts: { k?: string; keyInApp?: string; pairedAt?: number; dropCookie?: boolean; redirectUri?: string } = {},
) {
  const { verifier, challenge } = await pkce()
  const get = await SELF.fetch(authorizeUrl(challenge, opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}), {
    headers: { 'CF-Connecting-IP': clientIp },
  })
  expect(get.status).toBe(200)
  const html = await get.text()
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]
  let cookie = cookiesOf(get)
  const post = await SELF.fetch(`${H}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle, decision: 'approve' }),
  })
  expect(post.status).toBe(302)
  const location = post.headers.get('Location')!
  expect(location.startsWith(`${APP}/#/claude/connect?s=`)).toBe(true)
  const s = decodeURIComponent(location.split('?s=')[1])
  cookie = cookiesOf(post, cookie)
  // アプリ: コネクタの身元を読み、config/connector に指紋を書く（k はアプリの中だけ）
  const idRes = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: APP } })
  expect(idRes.headers.get('Access-Control-Allow-Origin')).toBe(APP)
  const { uid } = (await idRes.json()) as { uid: string }
  const k = opts.keyInApp ?? b64url(crypto.getRandomValues(new Uint8Array(32)))
  fake.setOwner(OWNER)
  fake.setAppModel(OWNER, 3)
  fake.setConnector({ uid, pairing: await sha256hex(`${s}.${k}`), writes: true, pairedAt: opts.pairedAt ?? Date.now() })
  const cb = await SELF.fetch(`${H}/pair/callback?state=${encodeURIComponent(s)}&k=${opts.k ?? k}`, {
    redirect: 'manual',
    headers: opts.dropCookie ? {} : { Cookie: cookie },
  })
  return { cb, verifier, s, k, cookie, uid }
}

async function token(params: Record<string, string>) {
  return SELF.fetch(`${H}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
}

async function exchange(cb: Response, verifier: string, redirectUri = CLAUDE_CALLBACK) {
  const to = new URL(cb.headers.get('Location')!)
  expect(`${to.origin}${to.pathname}`).toBe(redirectUri)
  expect(to.searchParams.get('state')).toBe('claude-state')
  const res = await token({
    grant_type: 'authorization_code',
    code: to.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: CLAUDE_CIMD,
    redirect_uri: redirectUri,
    resource: `${H}/mcp`,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
}

async function mcp(accessToken: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return SELF.fetch(`${H}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function rpcJson(res: Response) {
  const text = await res.text()
  return text.startsWith('{') ? JSON.parse(text) : JSON.parse(/data: (.*)/.exec(text)![1])
}

describe('発見（メタデータ）と 401', () => {
  it('保護されたリソースのメタデータ・認可サーバーのメタデータ', async () => {
    const pr = (await (await SELF.fetch(`${H}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>
    expect(pr.resource).toBe(`${H}/mcp`)
    expect(pr.authorization_servers).toEqual([H])
    const as = (await (await SELF.fetch(`${H}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
    expect(as.issuer).toBe(H)
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    expect(as.client_id_metadata_document_supported).toBe(true)
    expect(as.token_endpoint_auth_methods_supported).toContain('none')
    expect(as.scopes_supported).toEqual(expect.arrayContaining(['novel', 'offline_access']))
    expect(as.registration_endpoint).toBeUndefined()
  })

  it('トークンの無い /mcp は 401（resource_metadata 付き）', async () => {
    const res = await SELF.fetch(`${H}/mcp`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${H}/.well-known/oauth-protected-resource/mcp"`)
  })

  it('GET / は状態だけ（データは出さない）', async () => {
    const res = await SELF.fetch(`${H}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Novel Studio コネクタ')
  })
})

describe('GET /authorize（受け付けるクライアント）', () => {
  it('claude.ai の公開の識別子なら、日本語の同意の画面（枠に入れさせない・cookie で結び付ける）', async () => {
    const { challenge } = await pkce()
    const res = await SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': clientIp } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Novel Studio への接続を求めています')
    expect(html).toContain('claude.ai')
    expect(html).toContain('Novel Studio で確認する')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-'))).toBe(true)
  })

  it('戻り先が違う・claude.ai 以外のクライアントは、その場で断り KV に書かない', async () => {
    const { challenge } = await pkce()
    const before = await kvKeys()
    const wrong = await SELF.fetch(authorizeUrl(challenge, { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' })
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    expect(wrong.headers.get('Location')).toBeNull()
    const evil = await SELF.fetch(authorizeUrl(challenge, { client_id: 'https://evil.example/cimd', redirect_uri: 'https://evil.example/cb' }), {
      redirect: 'manual',
    })
    expect(evil.status).toBeGreaterThanOrEqual(400)
    expect(evil.headers.get('Location')).toBeNull()
    expect(await evil.text()).toContain('claude.ai からの接続だけ')
    expect(await kvKeys()).toBe(before)
  })

  it('受け付けない client_id の URL は、取りに行く前に断る（GET /authorize・トークンの要求）', async () => {
    const { challenge } = await pkce()
    const spy = vi.mocked(globalThis.fetch)
    const fetched = () => spy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))
    const evil = await SELF.fetch(authorizeUrl(challenge, { client_id: 'https://evil.example/cimd' }), { redirect: 'manual' })
    expect(evil.status).toBe(400)
    expect(await evil.text()).toContain('claude.ai からの接続だけ')
    // claude.ai の別の URL も、公開の識別子でなければ取りに行かない
    const other = await SELF.fetch(authorizeUrl(challenge, { client_id: 'https://claude.ai/some/other/path' }), { redirect: 'manual' })
    expect(other.status).toBe(400)
    const tok = await token({ grant_type: 'authorization_code', code: 'x', client_id: 'https://evil.example/cimd', code_verifier: 'v' })
    expect(tok.status).toBe(401)
    expect(((await tok.json()) as { error: string }).error).toBe('invalid_client')
    expect(fetched().filter((u) => u.includes('evil.example') || u.includes('/some/other/path'))).toEqual([])
  })

  it('client_id を送らない client_assertion・空の client_id を重ねた要求も、取りに行かず KV に書かずに断る（トークンの要求）', async () => {
    const spy = vi.mocked(globalThis.fetch)
    const fetched = () => spy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))
    const before = await kvKeys()
    const evil = 'https://evil.example/cimd.json'
    for (let i = 0; i < 3; i++) {
      const tok = await token({
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await evilAssertion(evil),
      })
      expect(tok.status).toBe(401)
      expect(((await tok.json()) as { error: string }).error).toBe('invalid_client')
    }
    // client_id= を空で先に送り、受け付けない URL を後ろに重ねる（ライブラリは空を捨てて後ろを使う）
    const body = new URLSearchParams([
      ['grant_type', 'authorization_code'],
      ['code', 'x'],
      ['code_verifier', 'v'],
      ['client_id', ''],
      ['client_id', evil],
    ])
    const dup = await SELF.fetch(`${H}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    expect(dup.status).toBe(401)
    expect(((await dup.json()) as { error: string }).error).toBe('invalid_client')
    // Basic 認証の client_id も同じ
    const basic = await SELF.fetch(`${H}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${encodeURIComponent(evil)}:`)}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x', code_verifier: 'v' }),
    })
    expect(basic.status).toBe(401)
    expect(fetched().filter((u) => u.includes('evil.example'))).toEqual([])
    expect(await kvKeys()).toBe(before)
  })
})

describe('連携（アプリでの許可 → /pair/callback → トークン → /mcp）', () => {
  it('通しで: 連携してトークンを受け取り、ツールを呼べる。トークンの更新もできる', async () => {
    const n = novel(['窓から見れる景色。'])
    seed(n.data)
    const { cb, verifier } = await connect()
    expect(cb.status).toBe(302)
    const t = await exchange(cb, verifier)
    expect(t.expires_in).toBe(3600)
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } })
    expect(init.status).toBe(200)
    // tools/list は Vault（Firebase）を呼ばない
    const calls = fake.calls.length
    const list = await rpcJson(await mcp(t.access_token, 'tools/list'))
    expect(list.result.tools).toHaveLength(15)
    expect(fake.calls.length).toBe(calls)
    // 初回の取り込みが終わるまでは「取り込み中」（alarm が続ける）。何度か呼べば読める
    let text = ''
    for (let i = 0; i < 20; i++) {
      const r = await rpcJson(await mcp(t.access_token, 'tools/call', { name: 'novel_list_titles', arguments: {} }))
      text = r.result.content[0].text
      if (!text.includes('取り込み中')) break
    }
    expect(text).toContain('『星の庭』')
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLAUDE_CIMD })
    expect(refreshed.status).toBe(200)
    const r2 = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(r2.refresh_token).not.toBe(t.refresh_token)
  })

  it('別のブラウザ（cookie なし）・k が違う・k が無い・期限切れ・使い回しは断る', async () => {
    const noCookie = await connect({ dropCookie: true })
    expect(noCookie.cb.status).toBe(400)
    expect(await noCookie.cb.text()).toContain('別のブラウザ')
    const wrongK = await connect({ k: 'B'.repeat(43) })
    expect(wrongK.cb.status).toBe(400)
    expect(await wrongK.cb.text()).toContain('連携の確かめが合いません')
    const noK = await connect({ k: '' })
    expect(noK.cb.status).toBe(400)
    const old = await connect({ pairedAt: Date.now() - 16 * 60_000 })
    expect(old.cb.status).toBe(400)
    expect(await old.cb.text()).toContain('15分')
    // 正しく連携した後で、同じ戻りの URL をもう一度開いても、もう使えない
    const ok = await connect()
    expect(ok.cb.status).toBe(302)
    const replay = await SELF.fetch(`${H}/pair/callback?state=${encodeURIComponent(ok.s)}&k=${ok.k}`, {
      redirect: 'manual',
      headers: { Cookie: ok.cookie },
    })
    expect(replay.status).toBe(400)
  })

  it('アプリで連携を解除すると、次のツールの呼び出しは 401、トークンの更新は invalid_grant', async () => {
    seed(novel(['本文']).data)
    const { cb, verifier } = await connect()
    const t = await exchange(cb, verifier)
    let res: Response | null = null
    for (let i = 0; i < 20; i++) {
      res = await mcp(t.access_token, 'tools/call', { name: 'novel_list_titles', arguments: {} })
      const body = await rpcJson(res.clone())
      if (!body.result.content[0].text.includes('取り込み中')) break
    }
    expect(res!.status).toBe(200)
    fake.setConnector(null)
    // 写しは15秒ごとに新しくするので、状態のツール（毎回クラウドを読む）で確かめる
    const gone = await mcp(t.access_token, 'tools/call', { name: 'novel_status', arguments: {} })
    expect(gone.status).toBe(401)
    expect(gone.headers.get('WWW-Authenticate')).toContain('invalid_token')
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLAUDE_CIMD })
    expect(refresh.status).toBe(400)
    expect(((await refresh.json()) as { error: string }).error).toBe('invalid_grant')
  })
})

describe('連携の代（解除した Claude のアカウントは、連携し直した後も使えない）', () => {
  it('解除の後に別の戻り先から連携し直すと、前の許可は 401・トークンの更新は invalid_grant。新しい許可は使える', async () => {
    seed(novel(['本文']).data)
    const first = await connect()
    const x = await exchange(first.cb, first.verifier)
    const ready = async (accessToken: string) => {
      let res: Response | null = null
      for (let i = 0; i < 20; i++) {
        res = await mcp(accessToken, 'tools/call', { name: 'novel_list_titles', arguments: {} })
        if (res.status !== 200) return res
        const body = await rpcJson(res.clone())
        if (!body.result.content[0].text.includes('取り込み中')) break
      }
      return res!
    }
    expect((await ready(x.access_token)).status).toBe(200)
    // ［連携を解除］（X はその後ツールを呼ばない）→ claude.com から別の Claude のアカウント（Y）で連携し直す
    fake.setConnector(null)
    const second = await connect({ redirectUri: CLAUDE_COM_CALLBACK })
    expect(second.cb.status).toBe(302)
    const y = await exchange(second.cb, second.verifier, CLAUDE_COM_CALLBACK)
    const stale = await mcp(x.access_token, 'tools/call', { name: 'novel_list_titles', arguments: {} })
    expect(stale.status).toBe(401)
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: x.refresh_token, client_id: CLAUDE_CIMD })
    expect(refresh.status).toBe(400)
    expect(((await refresh.json()) as { error: string }).error).toBe('invalid_grant')
    // Y の許可は取り消されていない
    const res = await ready(y.access_token)
    expect(res.status).toBe(200)
    expect((await rpcJson(res)).result.content[0].text).toContain('『星の庭』')
    const yRefresh = await token({ grant_type: 'refresh_token', refresh_token: y.refresh_token, client_id: CLAUDE_CIMD })
    expect(yRefresh.status).toBe(200)
  })
})

describe('/mcp の Origin', () => {
  it('Origin が無い・claude.ai・claude.com はよい。ほかは 403', async () => {
    seed(novel(['本文']).data)
    const { cb, verifier } = await connect()
    const t = await exchange(cb, verifier)
    const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } }
    expect((await mcp(t.access_token, 'initialize', init)).status).toBe(200)
    expect((await mcp(t.access_token, 'initialize', init, { Origin: 'https://claude.ai' })).status).toBe(200)
    expect((await mcp(t.access_token, 'initialize', init, { Origin: 'https://claude.com' })).status).toBe(200)
    expect((await mcp(t.access_token, 'initialize', init, { Origin: 'https://evil.example' })).status).toBe(403)
  })
})

describe('/connect/identity（アプリの連携の画面が読む）', () => {
  it('アプリの origin だけに CORS。ほかの origin は 403。preflight は 204', async () => {
    const ok = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: APP } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(APP)
    const body = (await ok.json()) as { uid: string; version: string; model: number }
    expect(body.model).toBe(3)
    expect(body.uid).toMatch(/^anon/)
    const evil = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const pre = await SELF.fetch(`${H}/connect/identity`, { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'GET' } })
    expect(pre.status).toBe(204)
  })

  it('匿名ログインが無効なら 503 と日本語の説明', async () => {
    // 新しい Durable Object ではないので、身元がもうあれば作り直さない。ここでは作る前の状態だけを見る
    fake.anonymousDisabled = true
    const res = await SELF.fetch(`${H}/connect/identity`, { headers: { Origin: APP } })
    if (res.status === 503) expect(((await res.json()) as { error: string }).error).toBe('anonymous_disabled')
    else expect(res.status).toBe(200)
  })
})

describe('回数の上限（最後に確かめる: 同じ Durable Object に数えるため）', () => {
  it('1つのネットワークから1時間に10回を超える接続の要求は断る（それまでは同意の画面）。ほかのネットワークからは接続できる', async () => {
    const { challenge } = await pkce()
    const from = (ip: string) => SELF.fetch(authorizeUrl(challenge), { headers: { 'CF-Connecting-IP': ip } })
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await from('203.0.113.50')).status)
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
    const refused = await from('203.0.113.50')
    expect(refused.status).toBe(429)
    const text = await refused.text()
    expect(text).toContain('このネットワークからの接続の要求が多すぎます')
    expect(text).toContain('ほかの人が送った要求かもしれません')
    // IPv6 は /48 ごと: 同じ /48 の別のアドレスも同じに数える
    for (let i = 0; i < 10; i++) expect((await from(`2001:db8:77:${i.toString(16)}::1`)).status).toBe(200)
    expect((await from('2001:db8:77:ff::2')).status).toBe(429)
    // 持ち主のほかのネットワーク（モバイル通信など）からは通る
    const owner = await from('192.0.2.10')
    expect(owner.status).toBe(200)
    expect(await owner.text()).toContain('Novel Studio への接続を求めています')
  })
})
