// Claude 用のコネクタとアプリの連携を、本物どうしで通しで確かめる E2E テスト（Firebase エミュレーター）。
// - コネクタ: connector/ の Worker を wrangler の createTestHarness でこのテストの中に立ち上げる（workerd。Durable Object・KV も本物）。
//   ブラウザからコネクタ（https://connector.e2e.test）への通信は、ページの通信を横取りしてこの Worker に渡す
//   （ブラウザの cookie の代わりに、このテストが連携を始めたブラウザの cookie を持つ）
// - コネクタの Firebase: 匿名のアカウントを Auth エミュレーターに作り、Firestore エミュレーターを REST で読む・書く
// - アプリ: 開発サーバーの本物の画面（#/claude/connect の連携の画面、設定の Claude 連携）
// - claude.ai: このテストが代わりに務める（DCR で登録したクライアント。claude.ai の公開の識別子（CIMD）を取りに行く所だけは、
//   この環境から claude.ai につながらないので、connector/test/worker の workerd のテストで確かめている）
// 流れ: 接続（/authorize）→ 同意［Novel Studio で確認する］→ アプリで見せるタイトルを選んで［許可する］→ /pair/callback
//   → claude.ai へ code → トークン → ツール（見せないタイトルは出ない・書いた改稿案がアプリに届く）
//   → 設定で「書き込みを許可」を切る（書き込みは断られる）→［連携を解除］（ツールは 401）
// コネクタの部品（npm --prefix connector ci）が無ければ、このテストは飛ばす。
import { expect, test, type BrowserContext, type Route } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openApp, seedTitleWithEpisodes } from './helpers'

const here = path.dirname(fileURLToPath(import.meta.url))
const connectorDir = path.resolve(here, '../connector')
const DOCS = 'http://127.0.0.1:8080/v1/projects/demo-novel-studio/databases/(default)/documents'
// エミュレーターでアクセスルールを通さずに読み書きする
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

/** wrangler の createTestHarness（使う所だけ） */
interface Harness {
  listen(): Promise<{ url: URL }>
  fetch(input: string, init?: RequestInit & { redirect?: 'manual' | 'follow' }): Promise<Response>
  close(): Promise<void>
}

function wranglerEntry(): string | null {
  try {
    return createRequire(path.join(connectorDir, 'package.json')).resolve('wrangler')
  } catch {
    return null
  }
}

const entry = fs.existsSync(path.join(connectorDir, 'package.json')) ? wranglerEntry() : null
// CI ではコネクタの部品を必ず入れる（無ければ飛ばさずに失敗させる。.github/workflows/ci.yml）
if (!entry && process.env.CI) throw new Error('コネクタの部品がありません（CI では npm --prefix connector ci が必要）')
test.skip(!entry, 'コネクタの部品がありません（npm --prefix connector ci）')

let harness: Harness | null = null
/** ブラウザから見たコネクタの origin（ビルドの時にアプリへ入れたもの。https://connector.e2e.test） */
let origin = ''
/**
 * 立ち上げた Worker の origin（http://127.0.0.1:…）。ブラウザからの通信はここへ渡す
 * （テストの道具は https の URL を http にして渡すので、OAuth のライブラリが受け付ける http はループバックの時だけ）
 */
let workerOrigin = ''

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const b64url = (b: Buffer) => b.toString('base64url')

async function readDoc(p: string): Promise<Record<string, Record<string, string | boolean>> | null> {
  const res = await fetch(`${DOCS}/${p}`, { headers: ADMIN })
  if (res.status === 404) return null
  expect(res.ok).toBe(true)
  return ((await res.json()) as { fields: Record<string, Record<string, string | boolean>> }).fields
}

async function deleteDoc(p: string): Promise<void> {
  await fetch(`${DOCS}/${p}`, { method: 'DELETE', headers: ADMIN })
}

async function setOwner(uid: string): Promise<void> {
  const res = await fetch(`${DOCS}/config/owner`, {
    method: 'PATCH',
    headers: ADMIN,
    body: JSON.stringify({ fields: { uid: { stringValue: uid }, createdAt: { timestampValue: new Date().toISOString() } } }),
  })
  expect(res.ok).toBe(true)
}

/** 連携を始めたブラウザの cookie（コネクタの origin の分）。Set-Cookie を受け取り、次の通信に付ける */
class CookieJar {
  #jar = new Map<string, string>()
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ''
      if (gone) this.#jar.delete(name)
      else this.#jar.set(name, value)
    }
  }
  header(): string {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

interface ProxyEvents {
  /** アプリがコネクタへ戻った URL（/pair/callback?state=…&k=…） */
  onCallback(url: string): void
  /** コネクタが claude.ai へ戻した URL（ブラウザは claude.ai へは行かせない） */
  onClaude(url: string): void
}

/**
 * ブラウザからコネクタへの通信を、立ち上げた Worker に渡す（ブラウザが送る Origin などはそのまま）。
 * 横取りして返した 302 の行き先はブラウザがそのまま通信する（横取りされない）ので、claude.ai へ戻す 302 だけは
 * ここで受け取り、ブラウザには「claude.ai に戻った」ページを返す
 */
async function routeConnector(context: BrowserContext, jar: CookieJar, seen: string[], events: ProxyEvents) {
  const keep = [
    'accept',
    'content-type',
    'origin',
    'referer',
    'user-agent',
    'access-control-request-method',
    'access-control-request-headers',
  ]
  await context.route(`${origin}/**`, async (route: Route) => {
    const req = route.request()
    const all = await req.allHeaders()
    const headers: Record<string, string> = {}
    for (const k of keep) if (all[k]) headers[k] = all[k]
    const cookie = jar.header()
    if (cookie) headers.cookie = cookie
    const url = new URL(req.url())
    seen.push(`${req.method()} ${url.pathname}`)
    if (url.pathname === '/pair/callback') events.onCallback(req.url())
    const body = req.postDataBuffer()
    const res = await harness!.fetch(`${workerOrigin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers,
      body: body && req.method() !== 'GET' ? new Uint8Array(body) : undefined,
      redirect: 'manual',
    })
    jar.take(res)
    const location = res.headers.get('location') ?? ''
    if (res.status >= 300 && res.status < 400 && location.startsWith('https://claude.ai/')) {
      events.onClaude(location)
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><title>Claude</title><p data-testid="claude-returned">claude.ai に戻りました</p>',
      })
    }
    const out: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') out[k] = v
    })
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) })
  })
}

/** claude.ai の MCP の呼び出し（JSON か SSE の答え） */
async function mcp(accessToken: string, method: string, params: Record<string, unknown> = {}) {
  const res = await harness!.fetch(`${workerOrigin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  const body = res.status === 200 ? JSON.parse(text.startsWith('{') ? text : /data: (.*)/.exec(text)![1]) : null
  return { status: res.status, body }
}

async function callTool(accessToken: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(accessToken, 'tools/call', { name, arguments: args })
  if (r.status !== 200) return { status: r.status, text: '', isError: true }
  const result = r.body.result as { content: { text: string }[]; isError?: boolean }
  return { status: r.status, text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true }
}

test.beforeAll(async ({}, testInfo) => {
  const appOrigin = new URL(String(testInfo.project.use.baseURL)).origin
  const { createTestHarness } = (await import(pathToFileURL(entry!).href)) as {
    createTestHarness(o: unknown): Harness
  }
  harness = createTestHarness({
    root: connectorDir,
    workers: [
      {
        configPath: './wrangler.jsonc',
        vars: {
          // コネクタの Firebase はエミュレーター（アプリの開発サーバーと同じ demo-novel-studio）
          FIREBASE_EMULATOR_HOST: '127.0.0.1',
          FIREBASE_PROJECT_ID: 'demo-novel-studio',
          FIREBASE_API_KEY: 'fake-api-key',
          // アプリ（この開発サーバー）。/connect/identity の CORS と、同意の後に開く連携の画面
          APP_ORIGIN: appOrigin,
          // claude.ai の代わりにこのテストがクライアントを登録する
          ENABLE_DCR: 'true',
        },
        secrets: { TOKEN_ENC_KEY: b64url(randomBytes(32)) },
      },
    ],
  })
  workerOrigin = (await harness.listen()).url.origin
})

test.afterAll(async () => {
  await harness?.close()
  harness = null
})

test.afterEach(async () => {
  await deleteDoc('config/connector')
  await deleteDoc('config/owner')
})

test('本物のコネクタと: claude.ai の接続 → アプリで許可 → トークン → ツール → 書き込みの停止 → 連携の解除', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const context = await browser.newContext()
  const page = await context.newPage()
  await openApp(page)
  origin = await page.evaluate(() => window.__ns.connectorOrigin)
  expect(origin).toMatch(/^https:\/\//)
  const shown = await seedTitleWithEpisodes(page, '見せる作品', ['窓から見れる景色。'])
  const hidden = await seedTitleWithEpisodes(page, '隠す作品', ['まだ誰にも見せない原稿。'])

  // 持ち主としてログインし、同期が終わるのを待つ
  await page.evaluate((u) => window.__ns.signInForTest(u), `e2e-pair-${Date.now()}`)
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-tone', 'ok', { timeout: 30_000 })
  const ownerUid = (await page.evaluate(() => window.__ns.syncUid()))!
  expect(ownerUid).toBeTruthy()
  await setOwner(ownerUid)

  const jar = new CookieJar()
  const seen: string[] = []
  let pairUrl = ''
  let claudeCallback = ''
  await routeConnector(context, jar, seen, { onCallback: (u) => (pairUrl = u), onClaude: (u) => (claudeCallback = u) })
  // 本物の claude.ai へは行かない
  await context.route('https://claude.ai/**', (route) => route.abort())

  // claude.ai: クライアントを登録して、ブラウザで接続を始める
  const reg = await harness!.fetch(`${workerOrigin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  expect(reg.status).toBe(201)
  const clientId = ((await reg.json()) as { client_id: string }).client_id
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'claude-state',
    scope: 'novel offline_access',
    resource: `${workerOrigin}/mcp`,
  })
  await page.goto(`${origin}/authorize?${q}`)
  await expect(page.getByText('Novel Studio への接続を求めています')).toBeVisible()
  await page.getByTestId('consent-approve').click()

  // アプリの連携の画面（コネクタが渡した印だけ。uid・origin は URL から受け取らない）
  const form = page.getByTestId('connect-form')
  await expect(form).toBeVisible({ timeout: 60_000 })
  const appUrl = new URL(page.url())
  expect(appUrl.origin).toBe(new URL(String(test.info().project.use.baseURL)).origin)
  const state = new URLSearchParams(appUrl.hash.split('?')[1]).get('s')!
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(seen).toContain('GET /connect/identity')
  const hiddenRow = form.getByTestId('connect-title').filter({ hasText: '隠す作品' })
  await hiddenRow.getByTestId('connect-access-none').click()
  await expect(form.getByTestId('connect-writes')).toBeChecked()
  await form.getByTestId('connect-approve').click()

  // コネクタが指紋を確かめて claude.ai へ戻す
  await expect.poll(() => claudeCallback, { timeout: 60_000 }).not.toBe('')
  await expect(page.getByTestId('claude-returned')).toBeVisible()
  const back = new URL(claudeCallback)
  expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK)
  expect(back.searchParams.get('state')).toBe('claude-state')
  const code = back.searchParams.get('code')!
  expect(code).toBeTruthy()
  // アプリはビルドの時に決めたコネクタへ、印と k を URL の引数で渡した
  const pair = new URL(pairUrl)
  expect(pair.origin).toBe(origin)
  expect(pair.searchParams.get('state')).toBe(state)
  const k = pair.searchParams.get('k')!
  expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)

  // 連携の記録: コネクタの匿名のアカウントと指紋だけ（k は書かない）
  const conn = (await readDoc('config/connector'))!
  const connectorUid = conn.uid.stringValue as string
  expect(connectorUid).toBeTruthy()
  expect(connectorUid).not.toBe(ownerUid)
  expect(conn.writes.booleanValue).toBe(true)
  expect(conn.pairing.stringValue).toBe(sha256(`${state}.${k}`))
  expect(JSON.stringify(conn)).not.toContain(k)
  // 隠したタイトルの設定は、連携の前に送られている
  const hiddenRecord = await readDoc(`users/${ownerUid}/records/titles:${hidden.titleId}`)
  expect(String(hiddenRecord?.json.stringValue)).toContain('"claudeAccess":"none"')

  // claude.ai: code をトークンにする
  const tokenRes = await harness!.fetch(`${workerOrigin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      resource: `${workerOrigin}/mcp`,
    }).toString(),
  })
  expect(tokenRes.status).toBe(200)
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }

  // 同じ戻りの URL はもう使えない（一度だけ）
  const replay = await harness!.fetch(`${workerOrigin}${pair.pathname}${pair.search}`, {
    redirect: 'manual',
    headers: { cookie: jar.header() },
  })
  expect(replay.status).toBeGreaterThanOrEqual(400)

  // ツール: 見せるタイトルだけが出る（初回の取り込みが終わるまで待つ）
  let titles = ''
  await expect
    .poll(
      async () => {
        titles = (await callTool(accessToken, 'novel_list_titles', {})).text
        return titles.includes('『見せる作品』')
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true)
  expect(titles).not.toContain('隠す作品')

  // ツールで改稿案を書くと、アプリに届く
  const added = await callTool(accessToken, 'novel_add_revision_ideas', {
    title_id: shown.titleId,
    items: [{ heading: 'コネクタからの改稿案', body: '冒頭を景色から始める' }],
  })
  expect(added.isError).toBe(false)
  // （連携を終えたタブは claude.ai に移ったので、アプリを開き直す。ログインと同期はそのまま続く）
  const app = await context.newPage()
  await openApp(app, `/t/${shown.titleId}?tab=strategy`)
  await expect
    .poll(() => app.evaluate(() => Object.values(window.__ns.getData().revisionIdeas).map((r) => `${r.source}:${r.heading}`)), {
      timeout: 30_000,
    })
    .toEqual(['claude:コネクタからの改稿案'])
  await expect(app.getByTestId('revision-idea').getByTestId('revision-heading')).toHaveText('コネクタからの改稿案')

  // 設定 → Claude 連携: 書き込みを止めると、コネクタの書き込みは断られる（読むのは続く）
  const settings = app
  await openApp(settings, '/settings')
  const info = settings.getByTestId('claude-pairing-info')
  await expect(info).toBeVisible({ timeout: 30_000 })
  await settings.locator('label:has([data-testid="claude-writes-toggle"])').click()
  await expect(info.getByTestId('claude-writes-state')).toHaveText('停止中（読むだけ）', { timeout: 30_000 })
  const refused = await callTool(accessToken, 'novel_add_revision_ideas', {
    title_id: shown.titleId,
    items: [{ heading: '止めた後の改稿案', body: '届かない' }],
  })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('書き込みは停止中')
  expect((await callTool(accessToken, 'novel_list_titles', {})).text).toContain('『見せる作品』')

  // ［連携を解除］: その場でコネクタは読めなくなり、claude.ai には接続し直しを求める（401）
  await settings.getByTestId('claude-unpair').click()
  await settings.getByRole('dialog').getByRole('button', { name: '連携を解除' }).click()
  await expect(settings.getByTestId('claude-pairing-none')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await callTool(accessToken, 'novel_status', {})).status, { timeout: 30_000 }).toBe(401)
  await context.close()
})
