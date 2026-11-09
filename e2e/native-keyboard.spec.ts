// iPhone のアプリ（Capacitor）のキーボード: 画面は縮まず、キーボードの高さがアプリから届く（--kb-native。src/platform/keyboard.ts）。
// 開発用フック __ns.setNativeKeyboard で届いたことにして、記号バー・ダイアログ・ほかの画面の下端がキーボードの上に来ることを確かめる。
// Chromium（desktop・mobile）と、E2E_WEBKIT=1 の時は WebKit でも動かす（playwright.config.ts）。
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed } from './helpers'

const W = 390
const H = 844
const KB = 336

const setKeyboard = (page: Page, px: number) => page.evaluate((h) => window.__ns.setNativeKeyboard(h), px)

const bottomOf = async (l: Locator) => {
  const b = (await l.boundingBox())!
  return Math.round(b.y + b.height)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: W, height: H })
})

test('原稿画面: 記号バーがキーボードのすぐ上に来て、閉じると画面の下に戻る', async ({ page }) => {
  await openApp(page)
  const ids = await seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('猫の物語')
    const pieceId = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: '吾輩は猫である。\n名前はまだ無い。' })
    return { titleId, pieceId }
  })
  await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
  const bar = page.getByTestId('symbol-bar')
  const editor = page.getByTestId('active-editor')
  await expect(bar).toBeVisible()
  // ブラウザ（Web 版）には「キーボードを閉じる」を出さない（iPhone のアプリだけ）
  await expect(page.getByTestId('symbol-close-keyboard')).toHaveCount(0)
  await expect.poll(() => bottomOf(bar)).toBe(H)

  await editor.click()
  await setKeyboard(page, KB)
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(H)
  await expect.poll(() => bottomOf(bar)).toBe(H - KB)
  // 本文は記号バーの上で終わる（キーボードに隠れない）
  const bar1 = (await bar.boundingBox())!
  expect(await bottomOf(editor)).toBeLessThanOrEqual(Math.round(bar1.y) + 1)
  // 記号バーを押してもフォーカスは外れない
  await page.getByTestId('symbol-dash').click()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(/――/)
  // ページそのものはスクロールしない（キーボードの分を二重に詰めない・余白も足さない）
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(H)

  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(bar)).toBe(H)
})

test('原稿画面: 括弧の一覧はキーボードの上の記号バーの上に開き、「キーボードを閉じる」があっても記号バーは1行に収まる', async ({
  page,
}) => {
  await openApp(page)
  const ids = await seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('猫の物語')
    const pieceId = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: '吾輩は猫である。' })
    return { titleId, pieceId }
  })
  await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
  const bar = page.getByTestId('symbol-bar')
  const editor = page.getByTestId('active-editor')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('あ')
  await setKeyboard(page, KB)
  await expect.poll(() => bottomOf(bar)).toBe(H - KB)

  await page.getByTestId('symbol-brackets').click()
  const menu = page.getByTestId('bracket-menu')
  await expect(menu).toBeVisible()
  await expect(editor).toBeFocused()
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const barTop = Math.round((await bar.boundingBox())!.y)
  expect(await bottomOf(menu)).toBeLessThanOrEqual(barTop)
  expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(0)
  await page.getByTestId('bracket-kagi').click()
  await expect(editor).toHaveValue('吾輩は猫である。あ「」')
  await expect(editor).toBeFocused()
  // 開いている間にキーボードが閉じたら（下へ動いた）記号バーの上に置き直す
  await page.getByTestId('symbol-brackets').click()
  await expect(menu).toBeVisible()
  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(bar)).toBe(H)
  await expect.poll(async () => (await bottomOf(menu)) - Math.round((await bar.boundingBox())!.y)).toBeLessThanOrEqual(0)
  await expect.poll(() => bottomOf(menu)).toBeGreaterThan(H - KB)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await setKeyboard(page, KB)

  // iPhone のアプリでは「キーボードを閉じる」も並ぶ（ブラウザでは出ないので、同じ形のボタンを足して測る）。
  // 幅 375（SE・mini）と 390 でも、どのボタンも記号バーからはみ出さない
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="symbol-bar"]')!
    const stand = b.querySelector('[data-testid="undo-button"]')!.cloneNode(true) as HTMLElement
    stand.dataset.testid = 'stand-in-close-keyboard'
    b.appendChild(stand)
  })
  for (const width of [W, 375]) {
    await page.setViewportSize({ width, height: H })
    await expect
      .poll(() =>
        page.evaluate((w) => {
          const b = document.querySelector<HTMLElement>('[data-testid="symbol-bar"]')!
          const right = Math.max(...[...b.querySelectorAll('button')].map((x) => x.getBoundingClientRect().right))
          return b.scrollWidth <= b.clientWidth && right <= w
        }, width),
      )
      .toBe(true)
  }
  await setKeyboard(page, 0)
})

test('ダイアログ: 背景とダイアログの下端がキーボードの上に来る', async ({ page }) => {
  await openApp(page)
  await page.locator('[data-testid="idea-section"][data-section="none"]').getByTestId('idea-add').click()
  const body = page.getByTestId('idea-body-input')
  await expect(body).toBeVisible()
  await body.click()
  await setKeyboard(page, KB)
  const backdrop = page.locator('.modal-backdrop')
  await expect.poll(() => bottomOf(backdrop)).toBe(H - KB)
  await expect.poll(() => bottomOf(page.locator('.modal'))).toBeLessThanOrEqual(H - KB)
  // 保存ボタン（ダイアログの下端）もキーボードに隠れない
  expect(await bottomOf(page.getByTestId('idea-save'))).toBeLessThanOrEqual(H - KB)
  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(backdrop)).toBe(H)
})

test('ほかの画面: いちばん下の欄までキーボードの上にスクロールできる', async ({ page }) => {
  await openApp(page, '/settings')
  await expect(page.getByTestId('app-settings')).toBeVisible()
  const before = await page.evaluate(() => document.documentElement.scrollHeight)
  await setKeyboard(page, KB)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(before + KB)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const main = page.getByTestId('app-settings')
  await expect.poll(() => bottomOf(main)).toBeLessThanOrEqual(H - KB)
  await setKeyboard(page, 0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(before)
})

test('原稿画面: 検索窓と見つけた所がキーボードの上にある', async ({ page }) => {
  await openApp(page)
  const ids = await seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('猫の物語')
    const pieceId = actions.addEpisode(titleId)
    const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}行目の文章です。`)
    lines[90] = '91行目に目印がある。'
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: lines.join('\n') })
    return { titleId, pieceId }
  })
  await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
  // WebKit（Desktop Safari の UA は Mac なので ⌘F になる）でも同じに動くよう、ショートカットではなくボタンで開く
  await page.getByTestId('active-search-toggle').click()
  const input = page.getByTestId('active-search-input')
  await expect(input).toBeFocused()
  await page.keyboard.type('目印')
  await expect(page.getByTestId('active-search-count')).toHaveText('1／1')
  await setKeyboard(page, KB)
  const bar = page.getByTestId('symbol-bar')
  await expect.poll(() => bottomOf(bar)).toBe(H - KB)
  expect(await bottomOf(page.getByTestId('active-search'))).toBeLessThanOrEqual(H - KB)
  // キーボードが出て本文欄が縮んでも、見つけた所は本文欄の見えている所（キーボードの上）にある
  const rect = page.getByTestId('active-search-hit').locator('.pw-hit-rect')
  const editor = page.getByTestId('active-editor')
  await expect
    .poll(async () => {
      const r = await rect.boundingBox()
      const e = await editor.boundingBox()
      return r !== null && e !== null && r.y >= e.y && r.y + r.height <= e.y + e.height && r.y + r.height <= H - KB
    })
    .toBe(true)
  await expect(input).toBeFocused()
  await setKeyboard(page, 0)
})
