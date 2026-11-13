// Claude 用のコネクタとの連携の E2E テスト（Firebase エミュレーター）。コネクタは仮のもので、ページの通信を横取りして答える
// （/connect/identity と /pair/callback。答えの形・CORS は本物のコネクタと同じ。本物のコネクタとの通しは e2e/pairing.sync.spec.ts）。連携の記録（config/connector）には k の指紋だけが書かれ、k そのものは
// コネクタへ移る URL にだけ入ること、タイトルの「Claude に見せる」の変更を送ってから移ること、設定の Claude 連携で
// 「書き込みを許可」を変えても指紋・時刻が変わらないこと、［連携をすべて解除］で記録が消えることを確かめる。
// 2.9: 2つ目の接続（既定の名前は「接続2」・前の接続は切れない）と、設定の接続の一覧（名前を変える・1つ解除する）も確かめる。
import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { trashRequestId } from '../src/claude/derivedId'
import { ideaReadMark } from '../src/claude/ideaAppend'
import { buildAddIdeas, buildIdeaAppend } from '../src/claude/ideaWrite'
import { shortId } from '../src/claude/refs'
import { buildTrashRequests } from '../src/claude/trashRequest'
import { claudeView } from '../src/claude/visibility'
import type { Idea } from '../src/domain/types'
import { DATA_MODEL } from '../src/sync/appModel'
import { encodeRecord } from '../src/sync/codec'
import type { Rec } from '../src/sync/merge'
import { darkSurfaces, noHorizontalScroll, openApp, openHomeBands, seed, seedTitleWithEpisodes, tapSize } from './helpers'

const DOCS = 'http://127.0.0.1:8080/v1/projects/demo-novel-studio/databases/(default)/documents'
// エミュレーターでアクセスルールを通さずに読み書きする
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

type Value = {
  stringValue?: string
  booleanValue?: boolean
  integerValue?: string
  timestampValue?: string
  mapValue?: { fields: Fields }
}
type Fields = Record<string, Value>

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

test('連携の画面: 持ち主が許可すると、指紋だけを記録し、送ってから仮のコネクタへ移る。2つ目の接続も足せ、設定で名前を変え、1つ・すべて解除できる', async ({
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
      // 2.9: コネクタがアプリより古い版なら許可させないので、アプリと同じデータの形を答える
      body: JSON.stringify({ uid: 'anon-e2e-connector', version: 'e2e', model: DATA_MODEL }),
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
  expect(conn!.v.integerValue).toBe('2')
  expect(conn!.approvedOn.stringValue).toBeTruthy()
  expect(conn!.pairedAt.timestampValue).toBeTruthy()
  // 2.9: 接続の一覧（初めての接続は「接続1」。指紋・時刻は上と同じ）
  const cid = conn!.pairingCid.stringValue!
  expect(cid).toMatch(/^c[0-9a-z]{12}$/)
  const entries = conn!.connections.mapValue!.fields
  expect(Object.keys(entries)).toEqual([cid])
  expect(entries[cid].mapValue!.fields.name.stringValue).toBe('接続1')
  expect(entries[cid].mapValue!.fields.pairing.stringValue).toBe(conn!.pairing.stringValue)
  expect(entries[cid].mapValue!.fields.pairedAt.timestampValue).toBe(conn!.pairedAt.timestampValue)
  expect(JSON.stringify(conn)).not.toContain(k)

  // タイトルの「Claude に見せる」の変更は、コネクタへ移る前に送られている
  const record = await readDoc(`users/${uid}/records/titles:${titleId}`)
  expect(record?.json.stringValue).toContain('"claudeAccess":"read"')

  // 2.9: 2つ目の接続（別の claude.ai のアカウント）。前の接続は切れず、既定の名前は「接続2」。15分以内の許可は入れ替えを勧める
  callback = ''
  const state2 = 'e2e-state-2'
  await page.goto(`/#/claude/connect?s=${state2}`)
  const form2 = page.getByTestId('connect-form')
  await expect(form2).toBeVisible({ timeout: 20_000 })
  const section = form2.getByTestId('connect-connection')
  await expect(section.getByTestId('connect-connection-count')).toHaveText('1 / 10')
  await expect(section.getByTestId('connect-name')).toHaveValue('接続2')
  await expect(section.getByTestId('connect-recent')).toContainText('15分以内に許可した「接続1」があります。')
  await section.locator('summary').click()
  await expect(section.getByTestId('connect-connection-row')).toHaveCount(1)
  // 360px・ディープダーク
  await noHorizontalScroll(page)
  await tapSize(section.getByTestId('connect-name'), 'connect-name')
  await tapSize(section.locator('label:has([data-testid="connect-mode-add"])'), 'connect-mode-add', false)
  await tapSize(section.locator('.cn-conn-option:has([data-testid="connect-mode-replace"])'), 'connect-mode-replace', false)
  await tapSize(section.getByTestId('connect-replace-target'), 'connect-replace-target')
  await tapSize(section.locator('summary'), 'connect-connections-summary', false)
  await tapSize(section.getByTestId('connect-connection-remove'), 'connect-connection-remove')
  await darkSurfaces(page, ['.cn-conn', '.cn-conn-mode', '.cl-conn', '.cn-notice', '.select'])
  await form2.getByTestId('connect-approve').click()
  await expect.poll(() => callback, { timeout: 20_000 }).not.toBe('')
  const k2 = new URL(callback).searchParams.get('k')!
  const conn2 = (await readDoc('config/connector'))!
  const cid2 = conn2.pairingCid.stringValue!
  expect(cid2).not.toBe(cid)
  expect(conn2.pairing.stringValue).toBe(sha256(`${state2}.${k2}`))
  const entries2 = conn2.connections.mapValue!.fields
  expect(Object.keys(entries2).sort()).toEqual([cid, cid2].sort())
  expect(entries2[cid].mapValue!.fields.pairing.stringValue).toBe(conn!.pairing.stringValue)
  expect(entries2[cid2].mapValue!.fields.name.stringValue).toBe('接続2')

  // 設定 → Claude 連携
  const settings = await context.newPage()
  await openApp(settings, '/settings')
  const info = settings.getByTestId('claude-pairing-info')
  await expect(info).toBeVisible({ timeout: 20_000 })
  const rows = info.getByTestId('claude-connection')
  await expect(rows.getByTestId('claude-connection-name')).toHaveText(['接続1', '接続2'])
  await expect(info.getByTestId('claude-connection-count')).toContainText('接続 2 / 10')
  // 360px・ディープダーク（同じブラウザなので外観の設定も同じ）
  await settings.setViewportSize({ width: 360, height: 760 })
  await noHorizontalScroll(settings)
  await tapSize(settings.locator('label:has([data-testid="claude-writes-toggle"])'), 'claude-writes-toggle', false)
  await tapSize(settings.getByTestId('claude-unpair'), 'claude-unpair')
  await tapSize(rows.first().getByTestId('claude-connection-rename'), 'claude-connection-rename')
  await tapSize(rows.first().getByTestId('claude-connection-remove'), 'claude-connection-remove')
  await darkSurfaces(settings, ['.cl-pairing', '.cl-conn', '.btn', '.segmented'])
  await expect(info.getByTestId('claude-writes-state')).toHaveText('許可')
  await settings.locator('label:has([data-testid="claude-writes-toggle"])').click()
  await expect(info.getByTestId('claude-writes-state')).toHaveText('停止中（読むだけ）', { timeout: 20_000 })
  // サーバーが受け取ってから知らせる
  await expect(settings.getByText('Claude の書き込みを止めました（読むことはできます）')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await readDoc('config/connector'))?.writes.booleanValue, { timeout: 20_000 }).toBe(false)
  const after = await readDoc('config/connector')
  expect(after!.pairing.stringValue).toBe(conn2.pairing.stringValue)
  expect(after!.pairedAt.timestampValue).toBe(conn2.pairedAt.timestampValue)

  // 名前を変える（同じ名前は断る）
  await rows.nth(1).getByTestId('claude-connection-rename').click()
  const rename = settings.getByRole('dialog')
  await rename.getByTestId('prompt-input').fill('接続１')
  await expect(rename.getByTestId('prompt-problem')).toHaveText('同じ名前の接続があります')
  await rename.getByTestId('prompt-input').fill('仕事用')
  await rename.getByTestId('prompt-ok').click()
  await expect(settings.getByText('接続の名前を「仕事用」にしました')).toBeVisible({ timeout: 20_000 })
  await expect(rows.getByTestId('claude-connection-name')).toHaveText(['接続1', '仕事用'], { timeout: 20_000 })
  const renamed = (await readDoc('config/connector'))!
  expect(renamed.connections.mapValue!.fields[cid2].mapValue!.fields.name.stringValue).toBe('仕事用')
  expect(renamed.pairing.stringValue).toBe(conn2.pairing.stringValue)

  // 1つ解除する（ほかの接続はそのまま）
  await rows.first().getByTestId('claude-connection-remove').click()
  await settings.getByRole('dialog').getByRole('button', { name: 'この接続を解除' }).click()
  await expect(settings.getByText('「接続1」の接続を解除しました')).toBeVisible({ timeout: 20_000 })
  await expect(rows.getByTestId('claude-connection-name')).toHaveText(['仕事用'], { timeout: 20_000 })
  expect(Object.keys((await readDoc('config/connector'))!.connections.mapValue!.fields)).toEqual([cid2])

  // 連携をすべて解除
  await settings.getByTestId('claude-unpair').click()
  await settings.getByRole('dialog').getByRole('button', { name: '連携をすべて解除' }).click()
  await expect(settings.getByText('Claude との連携をすべて解除しました')).toBeVisible({ timeout: 20_000 })
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

test('Claude のアイデア（2.8）: コネクタが作ったアイデアが済みでないアイデアの先頭に「Claude が作成」の印つきで出る。追記の依頼でカードの終わりに足され、ゴミ箱へ移す依頼でゴミ箱へ移り、戻せる', async ({
  browser,
}) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await openApp(page)
  // ホームのアイデアの帯（2.9。起動した時は閉じている）を開いておく
  await openHomeBands(page, 'ideas')
  const uid = await signIn(page, `e2e-ideas-${Date.now()}`)
  const titleId = await seed(page, ({ actions }) => {
    const t = actions.createTitle('灰の庭')
    actions.addIdea(null, '', 'ホームの作者の案')
    actions.addIdea(t, '', 'タイトルの作者の案')
    return t
  })
  await expect.poll(() => readDoc(`users/${uid}/records/titles:${titleId}`), { timeout: 20_000 }).not.toBeNull()
  // コネクタがホームと『灰の庭』にアイデアを作った（コネクタと同じ buildAddIdeas。2026/11/12 14:32 日本時間）
  const madeAt = Date.UTC(2026, 10, 12, 5, 32)
  const data = await page.evaluate(() => window.__ns.getData())
  const add = (title_id: string | undefined, name: string, content: string): Idea => {
    const built = buildAddIdeas(
      data,
      claudeView(data),
      { title_id, placement: 'outside', items: [{ name, content }] },
      { now: madeAt, wasDeleted: () => false },
    )
    expect(built.items.map((i) => i.status)).toEqual(['created'])
    return built.records[0].record as Idea
  }
  const home = add(undefined, '第3章の動機', '【動機】\n・兄を探す')
  const inTitle = add(titleId, '', '【場面】\n・灰の降る庭で再会する')
  for (const rec of [home, inTitle]) await putConnectorRecord(uid, 'ideas', rec as unknown as Rec)
  const homeCards = page.locator('[data-testid="idea-section"][data-section="none"]').getByTestId('idea-card')
  const titleCards = page.locator(`[data-testid="idea-section"][data-section="${titleId}"]`).getByTestId('idea-card')
  await expect(homeCards).toHaveCount(2, { timeout: 20_000 })
  await expect(titleCards).toHaveCount(2, { timeout: 20_000 })
  // どちらも済みでないアイデアの先頭に、「Claude が作成」の印つきで出る（作者のアイデアには付かない）
  for (const [cards, lead] of [
    [homeCards, '2026/11/12 14:32　第3章の動機'],
    [titleCards, '2026/11/12 14:32'],
  ] as const) {
    await expect(cards.first()).toHaveAttribute('data-source', 'claude')
    await expect(cards.first().getByTestId('idea-by-claude')).toHaveText('Claude が作成')
    await expect(cards.first().getByTestId('idea-lead')).toHaveText(lead)
    await expect(cards.nth(1).getByTestId('idea-by-claude')).toHaveCount(0)
  }
  const card = page.locator(`[data-idea-id="${home.id}"]`)

  // Claude が追記の依頼を作った（コネクタと同じ buildIdeaAppend。読んだ印は Claude に見せる内容から）
  const before = await page.evaluate(() => window.__ns.getData())
  const view = claudeView(before)
  const content = '【変更】\n・兄ではなく姉を探す'
  const appendAt = Date.UTC(2026, 10, 12, 6, 0)
  const built = buildIdeaAppend(
    before,
    view,
    { idea_id: shortId('idea', home.id), read_mark: ideaReadMark(view.ideas[home.id].body), content },
    { now: appendAt, wasDeleted: () => false },
  )
  expect(built.status).toBe('created')
  const req = built.records[0].record
  await putConnectorRecord(uid, 'ideaAppends', req as unknown as Rec)
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました' }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(card.getByTestId('idea-body')).toContainText('2026/11/12のセッションで以下の内容へ変更')
  const appended = `${home.body}\n\n2026/11/12のセッションで以下の内容へ変更\n${content}`
  const after = (await page.evaluate((id) => window.__ns.getData().ideas[id], home.id))!
  expect(after.body).toBe(appended)
  // 並びの位置・済み・場所は変わらない（まだ先頭で、印も付いたまま）
  expect([after.order, after.checked, after.checkedAt, after.titleId]).toEqual([before.ideas[home.id].order, false, null, null])
  expect(after.appendIds).toEqual([req.id])
  await expect(homeCards.first()).toHaveAttribute('data-idea-id', home.id)
  await expect(card.getByTestId('idea-by-claude')).toBeVisible()
  // クラウドでも、依頼は削除の印・アイデアは追記した後の本文
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/ideaAppends:${req.id}`))?.deleted?.booleanValue, { timeout: 20_000 })
    .toBe(true)
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/ideas:${home.id}`))?.json?.stringValue, { timeout: 20_000 })
    .toContain(req.id)

  // 作者に頼まれた Claude が、ゴミ箱へ移す依頼を作った（コネクタと同じ buildTrashRequests。i:…）
  const now = await page.evaluate(() => window.__ns.getData())
  const trash = buildTrashRequests(
    claudeView(now),
    { cards: [shortId('idea', home.id)] },
    { now: Date.now(), trash: now.trashRecords, wasDeleted: () => false, dailyLeft: 100 },
  )
  expect(trash.items.map((i) => i.status)).toEqual(['requested'])
  const trashReq = trash.records[0].record
  await putConnectorRecord(uid, 'trashRequests', trashReq as unknown as Rec)
  await expect(
    page.getByRole('status').filter({ hasText: 'Claude の依頼で、アイデア1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）' }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(card).toHaveCount(0)
  await expect(homeCards).toHaveCount(1)
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/trashRequests:${trashReq.id}`))?.deleted?.booleanValue, {
      timeout: 20_000,
    })
    .toBe(true)
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/ideas:${home.id}`))?.deleted?.booleanValue, { timeout: 20_000 })
    .toBe(true)
  // ゴミ箱に「Claude の依頼」の札。元に戻すと、追記した後の形で Claude のアイデアとして戻る
  await page.goto('/#/trash')
  const row = page.getByTestId('trash-row').filter({ hasText: '2026/11/12 14:32　第3章の動機' })
  await expect(row.getByTestId('trash-kind')).toHaveText('アイデア')
  await expect(row.getByTestId('trash-by-claude')).toHaveText('Claude の依頼')
  await expect(row.getByTestId('trash-place')).toHaveText('どのタイトルにも属さない')
  await row.getByTestId('trash-restore').click()
  await page.goto('/#/')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByTestId('idea-by-claude')).toHaveText('Claude が作成')
  await expect(card.getByTestId('idea-body')).toContainText('2026/11/12のセッションで以下の内容へ変更')
  expect((await page.evaluate((id) => window.__ns.getData().ideas[id], home.id))!.body).toBe(appended)
  await expect
    .poll(async () => (await readDoc(`users/${uid}/records/ideas:${home.id}`))?.deleted?.booleanValue, { timeout: 20_000 })
    .toBe(false)
  await ctx.close()
})
