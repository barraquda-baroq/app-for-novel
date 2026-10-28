// 同期の E2E テスト（Firebase エミュレーター）。2つのブラウザの文脈を2台の端末に見立てる。
import { expect, test, type Browser, type Page } from '@playwright/test'
import { openApp, seed } from './helpers'

async function device(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await openApp(page)
  return page
}

async function signIn(page: Page, user: string): Promise<void> {
  await page.evaluate((u) => window.__ns.signInForTest(u), user)
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-tone', 'ok', { timeout: 20_000 })
}

test('ログインしていない端末ではヘッダーに同期の表示を出さず、設定からログインできる', async ({ browser }) => {
  const page = await device(browser)
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0)
  await page.goto('/#/settings')
  await expect(page.getByTestId('sync-signin')).toBeVisible()
  await signIn(page, `e2e-${Date.now()}`)
  await expect(page.getByTestId('sync-account')).toContainText('@example.com')
  await expect(page.getByTestId('sync-state')).toContainText('同期済み')
})

test('片方の端末の編集が、もう片方にリアルタイムで届く', async ({ browser }) => {
  const user = `e2e-${Date.now()}`
  const a = await device(browser)
  const b = await device(browser)
  // ログインする前に書いていた作品も、ログインするとクラウドに上がる
  await seed(a, ({ actions }) => actions.createTitle('ログイン前の作品'))
  await signIn(a, user)
  await signIn(b, user)
  await expect(b.getByTestId('title-group').getByText('ログイン前の作品')).toBeVisible({ timeout: 15_000 })

  // A で作ったタイトルと本文が B に届く
  const ids = await seed(a, ({ actions, getData }) => {
    const titleId = actions.createTitle('同期の作品')
    const pieceId = actions.addEpisode(titleId)
    const versionId = getData().pieces[pieceId].versionIds[0]
    actions.updateVersion(versionId, { body: 'Aで書いた本文' })
    return { titleId, pieceId, versionId }
  })
  await expect(b.getByTestId('title-group').getByText('同期の作品')).toBeVisible({ timeout: 15_000 })
  await b.goto(`/#/t/${ids.titleId}/p/${ids.pieceId}`)
  await expect(b.getByLabel('採用原稿の本文')).toHaveValue('Aで書いた本文', { timeout: 15_000 })

  // B で書き足すと A に届く
  await seed(b, ({ actions }, versionId) => actions.updateVersion(versionId, { body: 'Bで書き足した本文' }), ids.versionId)
  await expect
    .poll(() => a.evaluate((v) => window.__ns.getData().versions[v]?.body, ids.versionId), { timeout: 15_000 })
    .toBe('Bで書き足した本文')
  await expect(a.getByTestId('sync-indicator')).toHaveAttribute('data-tone', 'ok')
})
