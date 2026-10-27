// 入力した直後に再読み込み・画面を閉じても原稿が消えないこと
import { expect, test } from '@playwright/test'
import { openApp, seedTitleWithEpisodes } from './helpers'

test.describe('入力直後の保存', () => {
  test('原稿を打った直後に再読み込みしても消えない', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '保存の確認', ['始まり。'])
    await openApp(page, `/t/${titleId}/p/${pieceIds[0]}`)
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await page.keyboard.press('End')
    await editor.press('Control+End')
    await page.keyboard.type('直後に閉じても残る一文。')
    // 待たずに再読み込み
    await page.reload()
    await page.waitForFunction(() => Boolean(window.__ns))
    await expect(page.getByTestId('active-editor')).toHaveValue('始まり。直後に閉じても残る一文。')
  })

  test('打ち続けている途中でも一定時間ごとに反映され、保存状態は「保存済み」にならない', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '連続入力', [''])
    await openApp(page, `/t/${titleId}/p/${pieceIds[0]}`)
    await page.getByTestId('active-editor').click()
    await page.keyboard.type('あいうえおかきくけこさしすせそ', { delay: 150 })
    // 打ち終わった直後（まだ下書きが残っている間）は「保存済み」と表示しない
    await expect(page.locator('.save-status')).not.toHaveClass(/\bsaved\b/)
    const stored = await page.evaluate(
      (id) => {
        const d = window.__ns.getData()
        const p = d.pieces[id]
        return d.versions[p.activeVersionId!].body
      },
      pieceIds[0],
    )
    // 1.5 秒ごとには反映されるので、途中までは必ずストアに入っている
    expect(stored.length).toBeGreaterThan(0)
    await page.reload()
    await page.waitForFunction(() => Boolean(window.__ns))
    await expect(page.getByTestId('active-editor')).toHaveValue('あいうえおかきくけこさしすせそ')
  })
})
