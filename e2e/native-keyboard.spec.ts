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
