// 入力した直後に再読み込み・画面を閉じても、書いた内容が消えないこと
import { expect, test, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

async function reloadApp(page: Page) {
  // 原稿画面に保存していない編集がある間は、再読み込みの前にブラウザの確認が出る
  page.once('dialog', (d) => void d.accept())
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__ns))
}

test.describe('入力直後の保存', () => {
  test('原稿を打った直後に再読み込みしても、保存していない編集を端末内の控えから復元できる', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '保存の確認', ['始まり。'])
    await openApp(page, `/t/${titleId}/p/${pieceIds[0]}`)
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await editor.press('Control+End')
    await page.keyboard.type('直後に閉じても残る一文。')
    // 待たずに再読み込み（閉じる時に端末内に控える）
    await reloadApp(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('前回保存されなかった編集があります')
    await dialog.getByRole('button', { name: '復元' }).click()
    await expect(page.getByTestId('active-editor')).toHaveValue('始まり。直後に閉じても残る一文。')
  })

  test('自動保存の画面（メモ）: 打ち続けている途中でも一定時間ごとに反映され、保存状態は「保存済み」にならない', async ({
    page,
  }) => {
    await openApp(page)
    const { titleId, memoId } = await seed(page, ({ actions }) => {
      const titleId = actions.createTitle('連続入力')
      const memoId = actions.addMemo(titleId, '構想メモ')
      return { titleId, memoId }
    })
    await openApp(page, `/t/${titleId}/m/${memoId}`)
    await page.getByTestId('memo-body').click()
    await page.keyboard.type('あいうえおかきくけこさしすせそ', { delay: 150 })
    // 打ち終わった直後（まだ下書きが残っている間）は「保存済み」と表示しない
    await expect(page.locator('.save-status')).not.toHaveClass(/\bsaved\b/)
    const stored = await page.evaluate((id) => window.__ns.getData().memos[id].body, memoId)
    // 1.5 秒ごとには反映されるので、途中までは必ずストアに入っている
    expect(stored.length).toBeGreaterThan(0)
    await reloadApp(page)
    await expect(page.getByTestId('memo-body')).toHaveValue('あいうえおかきくけこさしすせそ')
  })
})
