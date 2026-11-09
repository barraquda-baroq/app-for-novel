// Claude 用のコネクタとの連携の E2E テスト（Firebase エミュレーター）。コネクタは仮のもので、ページの通信を横取りして答える
// （/connect/identity と /pair/callback。答えの形・CORS は本物のコネクタと同じ。本物のコネクタとの通しは e2e/pairing.sync.spec.ts）。連携の記録（config/connector）には k の指紋だけが書かれ、k そのものは
// コネクタへ移る URL にだけ入ること、タイトルの「Claude に見せる」の変更を送ってから移ること、設定の Claude 連携で
// 「書き込みを許可」を変えても指紋・時刻が変わらないこと、［連携を解除］で記録が消えることを確かめる。
import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { trashRequestId } from '../src/claude/derivedId'
import { encodeRecord } from '../src/sync/codec'
import type { Rec } from '../src/sync/merge'
import { darkSurfaces, noHorizontalScroll, openApp, seed, seedTitleWithEpisodes, tapSize } from './helpers'

const DOCS = 'http://127.0.0.1:8080/v1/projects/demo-novel-studio/databases/(default)/documents'
// エミュレーターでアクセスルールを通さずに読み書きする
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

type Fields = Record<string, { stringValue?: string; booleanValue?: boolean; integerValue?: string; timestampValue?: string }>

/** コネクタと同じ形の記録（device: claude-connector）を、アクセスルールを通さずに置く */
async function putConnectorRecord(uid: string, table: string, rec: Rec): Promise<void> {
  const enc = encodeRecord(rec)
  const res = await fetch(`${DOCS}/users/${uid}/records/${table}:${rec.id}`, {
    method: 'PATCH',
    headers: ADMIN,
    body: JSON.stringify({
      fields: {
        table: { stringValue: table },
        id: { stringValue: rec.id },
        json: { stringValue: enc.json },
        chunks: { integerValue: '0' },
        deleted: { booleanValue: false },
        hash: { stringValue: enc.hash },
        updated: { timestampValue: new Date().toISOString() },
        device: { stringValue: 'claude-connector' },
      },
    }),
  })
  expect(res.ok).toBe(true)
}

async function readDoc(path: string): Promise<Fields | null> {
  const res = await fetch(`${DOCS}/${path}`, { headers: ADMIN })
  if (res.status === 404) return null
  expect(res.ok).toBe(true)
  return ((await res.json()) as { fields: Fields }).fields
}

async function setOwner(uid: string): Promise<void> {
  const res = await fetch(`${DOCS}/config/owner`, {
    method: 'PATCH',
    headers: ADMIN,
    body: JSON.stringify({ fields: { uid: { stringValue: uid }, createdAt: { timestampValue: new Date().toISOString() } } }),
  })
  expect(res.ok).toBe(true)
}

async function deleteDoc(path: string): Promise<void> {
  await fetch(`${DOCS}/${path}`, { method: 'DELETE', headers: ADMIN })
}

async function signIn(page: Page, user: string): Promise<string> {
  await page.evaluate((u) => window.__ns.signInForTest(u), user)
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-tone', 'ok', { timeout: 20_000 })
  const uid = await page.evaluate(() => window.__ns.syncUid())
  expect(uid).toBeTruthy()
  return uid!
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

test.afterEach(async () => {
  await deleteDoc('config/connector')
  await deleteDoc('config/owner')
})

test('連携の画面: 持ち主が許可すると、指紋だけを記録し、送ってから仮のコネクタへ移る。設定で書き込みの許可を変え、解除できる', async ({
  browser,
}) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await openApp(page)
  const { titleId } = await seedTitleWithEpisodes(page, '連携する作品', ['窓から見れる景色。'])
  const uid = await signIn(page, `e2e-claude-${Date.now()}`)
  await setOwner(uid)
  const origin = await page.evaluate(() => window.__ns.connectorOrigin)
  expect(origin).toMatch(/^https:\/\//)

  // 仮のコネクタ
  const identityRequests: string[] = []
  let callback = ''
  const appOrigin = new URL(page.url()).origin
  await context.route(`${origin}/connect/identity`, async (route) => {
    identityRequests.push(route.request().url())
    // 本物のコネクタと同じく、アプリの origin だけに答える（Cookie は送られない）
    const from = (await route.request().allHeaders()).origin
    expect(from).toBe(appOrigin)
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': from, vary: 'Origin' },
      body: JSON.stringify({ uid: 'anon-e2e-connector', version: 'e2e', model: 3 }),
    })
  })
  await context.route(`${origin}/pair/callback**`, async (route) => {
    callback = route.request().url()
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><p>paired</p>' })
  })

  // 連携の画面はディープダーク・360px の画面でも確かめる
  await openApp(page, '/settings')
  await page.getByTestId('theme-deep-dark').click()
  const state = 'e2e-state.1_2~3'
  await page.goto(`/#/claude/connect?s=${encodeURIComponent(state)}&uid=attacker`)
  const form = page.getByTestId('connect-form')
  await expect(form).toBeVisible({ timeout: 20_000 })
  expect(identityRequests).toEqual([`${origin}/connect/identity`])
  const row = form.getByTestId('connect-title').filter({ hasText: '連携する作品' })
  await expect(row.getByTestId('connect-access-write')).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 360, height: 760 })
  await noHorizontalScroll(page)
  for (const id of ['connect-access-none', 'connect-access-read', 'connect-access-write']) await tapSize(row.getByTestId(id), id)
  await tapSize(form.getByTestId('connect-writes').locator('xpath=..'), 'connect-writes', false)
  await tapSize(form.getByTestId('connect-cancel'), 'connect-cancel')
  await tapSize(form.getByTestId('connect-approve'), 'connect-approve')
  await darkSurfaces(page, ['.cn-form', '.cn-box', '.cn-title-row', '.segmented.cn-seg', '.cn-actions .btn', '.cn-warn'])
  await row.getByTestId('connect-access-read').click()
  await form.getByTestId('connect-approve').click()

  await expect.poll(() => callback, { timeout: 20_000 }).not.toBe('')
  const url = new URL(callback)
  expect(url.origin).toBe(origin)
  expect(url.pathname).toBe('/pair/callback')
  expect(url.searchParams.get('state')).toBe(state)
  const k = url.searchParams.get('k')!
  expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)

  const conn = await readDoc('config/connector')
  expect(conn).not.toBeNull()
  expect(conn!.uid.stringValue).toBe('anon-e2e-connector')
  expect(conn!.pairing.stringValue).toBe(sha256(`${state}.${k}`))
  expect(conn!.writes.booleanValue).toBe(true)
  expect(conn!.v.integerValue).toBe('1')
  expect(conn!.approvedOn.stringValue).toBeTruthy()
  expect(conn!.pairedAt.timestampValue).toBeTruthy()
  expect(JSON.stringify(conn)).not.toContain(k)

  // タイトルの「Claude に見せる」の変更は、コネクタへ移る前に送られている
  const record = await readDoc(`users/${uid}/records/titles:${titleId}`)
  expect(record?.json.stringValue).toContain('"claudeAccess":"read"')

  // 設定 → Claude 連携
  const settings = await context.newPage()
  await openApp(settings, '/settings')
  const info = settings.getByTestId('claude-pairing-info')
  await expect(info).toBeVisible({ timeout: 20_000 })
  // 360px・ディープダーク（同じブラウザなので外観の設定も同じ）
  await settings.setViewportSize({ width: 360, height: 760 })
  await noHorizontalScroll(settings)
  await tapSize(settings.locator('label:has([data-testid="claude-writes-toggle"])'), 'claude-writes-toggle', false)
  await tapSize(settings.getByTestId('claude-unpair'), 'claude-unpair')
  await darkSurfaces(settings, ['.cl-pairing', '.btn', '.segmented'])
  await expect(info.getByTestId('claude-writes-state')).toHaveText('許可')
  await settings.locator('label:has([data-testid="claude-writes-toggle"])').click()
  await expect(info.getByTestId('claude-writes-state')).toHaveText('停止中（読むだけ）', { timeout: 20_000 })
  // サーバーが受け取ってから知らせる
  await expect(settings.getByText('Claude の書き込みを止めました（読むことはできます）')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await readDoc('config/connector'))?.writes.booleanValue, { timeout: 20_000 }).toBe(false)
  const after = await readDoc('config/connector')
  expect(after!.pairing.stringValue).toBe(conn!.pairing.stringValue)
  expect(after!.pairedAt.timestampValue).toBe(conn!.pairedAt.timestampValue)

  await settings.getByTestId('claude-unpair').click()
  await settings.getByRole('dialog').getByRole('button', { name: '連携を解除' }).click()
  await expect(settings.getByText('Claude との連携を解除しました')).toBeVisible({ timeout: 20_000 })
  await expect(settings.getByTestId('claude-pairing-none')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => readDoc('config/connector'), { timeout: 20_000 }).toBeNull()
  await context.close()
})

test('連携の画面: 持ち主ではないアカウントでは、コネクタに問い合わせず何も記録しない', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await openApp(page)
  await signIn(page, `e2e-claude-other-${Date.now()}`)
  await setOwner('someone-else')
  const origin = await page.evaluate(() => window.__ns.connectorOrigin)
  const requests: string[] = []
  await context.route(`${origin}/**`, async (route) => {
    requests.push(route.request().url())
    await route.abort()
  })
  await page.goto('/#/claude/connect?s=e2e-state-2')
  await expect(page.getByTestId('connect-not-owner')).toBeVisible({ timeout: 20_000 })
  expect(requests).toEqual([])
  expect(await readDoc('config/connector')).toBeNull()
  await context.close()
})

test('ゴミ箱へ移す依頼（2.7）: Claude の依頼が届くと、同期の後にカードがゴミ箱へ移り、トーストと「Claude の依頼」の札が出る。戻すと作品の画面に戻る', async ({
  browser,
}) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await openApp(page)
  const uid = await signIn(page, `e2e-trash-${Date.now()}`)
  const workId = await seed(page, ({ actions }) => actions.addBenchWork({ name: '銀河の果て', author: '山田' }))
  await expect.poll(() => readDoc(`users/${uid}/records/benchWorks:${workId}`), { timeout: 20_000 }).not.toBeNull()
  // コネクタが分析を作った
  const card = {
    id: 'cn-e2e.trash.1',
    workId,
    viewpoint: '構成',
    body: '三幕で、第一幕の終わりに転機。',
    runDate: '2026-10-30',
    source: 'claude',
    v: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
  await putConnectorRecord(uid, 'benchAnalyses', card as unknown as Rec)
  await page.goto(`/#/bench/${workId}`)
  await expect(page.locator(`[data-analysis-id="${card.id}"]`)).toBeVisible({ timeout: 20_000 })
  // 作者に頼まれた Claude が、ゴミ箱へ移す依頼を作った
  const reqId = trashRequestId('benchAnalyses', card.id)
  await putConnectorRecord(uid, 'trashRequests', {
    id: reqId,
    table: 'benchAnalyses',
    targetId: card.id,
    parentId: workId,
    targetUpdatedAt: card.updatedAt,
    label: '『銀河の果て』の「構成」（2026-10-30）',
    source: 'claude',
    v: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Rec)
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Claude の依頼で、相対比較の分析1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）' }),
  ).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.locator(`[data-analysis-id="${card.id}"]`)).toHaveCount(0)
  // クラウドでも、依頼とカードは削除の印になる
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/trashRequests:${reqId}`))?.deleted?.booleanValue, { timeout: 20_000 })
    .toBe(true)
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/benchAnalyses:${card.id}`))?.deleted?.booleanValue, {
      timeout: 20_000,
    })
    .toBe(true)
  // ゴミ箱に「Claude の依頼」の札。元に戻すと作品の画面に戻る
  await page.goto('/#/trash')
  const row = page.getByTestId('trash-row').filter({ hasText: '構成（2026-10-30）' })
  await expect(row.getByTestId('trash-kind')).toHaveText('相対比較の分析')
  await expect(row.getByTestId('trash-by-claude')).toHaveText('Claude の依頼')
  await expect(row.getByTestId('trash-place')).toHaveText('相対比較 › 銀河の果て')
  await row.getByTestId('trash-restore').click()
  await page.goto(`/#/bench/${workId}`)
  await expect(page.locator(`[data-analysis-id="${card.id}"]`)).toBeVisible()
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/benchAnalyses:${card.id}`))?.deleted?.booleanValue, {
      timeout: 20_000,
    })
    .toBe(false)
  await ctx.close()
})
