// ゴミ箱の E2E テスト: 削除したものがゴミ箱に並び、元に戻すと元の場所へ戻る。完全に削除・空にする・30日での自動削除。
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'
import type { AppData, TrashEntry, TrashRecord } from '../src/domain/types'

function dialog(page: Page): Locator {
  return page.getByRole('dialog')
}

async function confirmIn(page: Page, buttonName: string): Promise<void> {
  await dialog(page).getByRole('button', { name: buttonName, exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
}

function trashRows(page: Page): Locator {
  return page.getByTestId('trash-row')
}

/** ホームの右上のアイコンからゴミ箱を開く */
async function openTrashFromHome(page: Page): Promise<void> {
  await page.getByTestId('trash-link').click()
  await expect(page).toHaveURL(/#\/trash$/)
  await expect(page.getByTestId('trash-page')).toBeVisible()
}

/** ゴミ箱の1件を直接用意する（同期の競合で残した内容や、古いものの確認用） */
async function seedTrashEntry(
  page: Page,
  entry: Partial<TrashEntry>,
  record: TrashRecord['record'],
  table: TrashRecord['table'],
) {
  await seed(
    page,
    async ({ getData, replaceAllData }, a: { entry: Partial<TrashEntry>; record: TrashRecord['record']; table: string }) => {
      const data = getData()
      const ts = a.entry.deletedAt ?? Date.now()
      const rec = {
        id: `rec-${a.record.id}`,
        entryId: `entry-${a.record.id}`,
        table: a.table,
        record: a.record,
        createdAt: ts,
        updatedAt: ts,
      }
      const e = {
        id: rec.entryId,
        kind: 'memo',
        label: '',
        titleName: '',
        origin: { titleId: null, index: 0 },
        recordIds: [rec.id],
        reason: 'deleted',
        deletedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        ...a.entry,
      }
      await replaceAllData({
        ...data,
        trashEntries: { ...data.trashEntries, [e.id]: e },
        trashRecords: { ...data.trashRecords, [rec.id]: rec },
      } as AppData)
    },
    { entry, record, table },
  )
}

test.describe('ゴミ箱', () => {
  test('話を削除するとゴミ箱に入り、元に戻すと元の場所に戻る', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '旅の記録', ['一話目の本文', '二話目の本文', '三話目の本文'])
    await seed(page, ({ actions }, id: string) => actions.updatePiece(id, { subtitle: '旅立ち' }), pieceIds[2])

    // 本編タブで第3話を削除する（確認文はゴミ箱に移ることを伝える）
    await openApp(page, `/t/${titleId}`)
    await page.getByTestId('edit-toggle').click()
    await page.getByTestId('piece-row').nth(2).getByTestId('piece-delete').click()
    await expect(dialog(page)).toContainText('ゴミ箱に移します。30日後に完全に削除されます')
    await confirmIn(page, '削除')
    await expect(page.getByRole('status').filter({ hasText: '「第3話　旅立ち」をゴミ箱に移しました' })).toBeVisible()
    await expect(page.getByTestId('piece-row')).toHaveCount(2)

    // ホームのアイコンからゴミ箱を開くと、今日の欄に並んでいる
    await page.getByRole('link', { name: 'ホーム（アイデアとタイトル一覧）' }).click()
    await openTrashFromHome(page)
    await expect(page.getByTestId('trash-day-label')).toHaveText(['今日'])
    await expect(trashRows(page)).toHaveCount(1)
    const row = trashRows(page).first()
    await expect(row.getByTestId('trash-kind')).toHaveText('話')
    await expect(row.getByTestId('trash-label')).toHaveText('第3話　旅立ち')
    await expect(row.getByTestId('trash-place')).toHaveText('旅の記録')
    await expect(row.getByTestId('trash-time')).toContainText('に削除')
    await expect(row.getByTestId('trash-days-left')).toHaveText('あと30日で完全に削除')
    await expect(row.getByTestId('trash-conflict')).toHaveCount(0)

    // 元に戻す
    await row.getByTestId('trash-restore').click()
    await expect(page.getByRole('status').filter({ hasText: '「第3話　旅立ち」を元の場所に戻しました' })).toBeVisible()
    await expect(trashRows(page)).toHaveCount(0)
    await expect(page.getByTestId('trash-empty')).toBeVisible()
    await expect(page.getByTestId('trash-empty-all')).toBeDisabled()

    // タイトルに戻ると第3話がある（本文もそのまま）。再読み込みしても残っている
    await page.evaluate(() => window.__ns.flushNow())
    await openApp(page, `/t/${titleId}`)
    await expect(page.getByTestId('piece-label')).toHaveText(['第1話', '第2話', '第3話'])
    await expect(page.getByTestId('piece-subtitle')).toHaveText(['旅立ち'])
    const body = await page.evaluate((id) => {
      const d = window.__ns.getData()
      return d.versions[d.pieces[id].activeVersionId!].body
    }, pieceIds[2])
    expect(body).toBe('三話目の本文')
  })

  test('完全に削除・ゴミ箱を空にするは確認してから消す。戻せない時は理由を出す', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => {
      const id = actions.createTitle('消すもの')
      const memo = actions.addMemo(id, '古いメモ')
      actions.deleteMemo(memo)
      const idea = actions.addIdea(null, '捨てた案')
      actions.deleteIdea(idea)
      const ep = actions.addEpisode(id)
      const v = actions.addVersion(ep)
      actions.deleteVersion(v)
      return id
    })
    // 稿の話ごと消す（稿は話がないと戻せない）
    await seed(
      page,
      ({ actions, getData }, id: string) => {
        const piece = Object.values(getData().pieces).find((p) => p.titleId === id)!
        actions.deletePiece(piece.id)
      },
      titleId,
    )

    await openApp(page, '/trash')
    await expect(trashRows(page)).toHaveCount(4)
    const versionRow = trashRows(page).filter({ has: page.getByTestId('trash-kind').filter({ hasText: '推敲バージョン' }) })
    await expect(versionRow.getByTestId('trash-place')).toHaveText('消すもの › 第1話')
    await versionRow.getByTestId('trash-restore').click()
    await expect(
      page.getByRole('alert').filter({ hasText: '元の話がないため戻せません。先に話を戻してください。' }),
    ).toBeVisible()
    await expect(trashRows(page)).toHaveCount(4)

    const ideaRow = trashRows(page).filter({ hasText: '捨てた案' })
    await expect(ideaRow.getByTestId('trash-place')).toHaveText('どのタイトルにも属さない')
    await ideaRow.getByTestId('trash-delete').click()
    await expect(dialog(page)).toContainText('「捨てた案」を完全に削除しますか？')
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click()
    await expect(trashRows(page)).toHaveCount(4)
    await ideaRow.getByTestId('trash-delete').click()
    await confirmIn(page, '完全に削除')
    await expect(trashRows(page)).toHaveCount(3)
    // 消えた行の次の行へフォーカスが移る
    await expect(page.locator(':focus')).toHaveAttribute('data-testid', /trash-restore/)

    await page.getByTestId('trash-empty-all').click()
    await expect(dialog(page)).toContainText('ゴミ箱の3件をすべて完全に削除します')
    await confirmIn(page, '空にする')
    await expect(page.getByTestId('trash-empty')).toBeVisible()
    const left = await page.evaluate(() => {
      const d = window.__ns.getData()
      return Object.keys(d.trashEntries).length + Object.keys(d.trashRecords).length
    })
    expect(left).toBe(0)
  })

  test('同期の競合で残した内容には印が付き、同じものが残っていれば複製として戻る', async ({ page }) => {
    await openApp(page)
    const { titleId, memoId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('競合')
      const m = actions.addMemo(id, '取材メモ')
      actions.updateMemo(m, { body: 'この端末の本文' })
      return { titleId: id, memoId: m }
    })
    const memo = await page.evaluate((id) => window.__ns.getData().memos[id], memoId)
    await seedTrashEntry(
      page,
      { kind: 'memo', label: '取材メモ', titleName: '競合', reason: 'conflict', origin: { titleId, index: 0, prevId: null } },
      { ...memo, body: '別の端末の本文' },
      'memos',
    )
    await openApp(page, '/trash')
    const row = trashRows(page).first()
    await expect(row.getByTestId('trash-conflict')).toHaveText('同期の競合で残した内容')
    await row.getByTestId('trash-restore').click()
    await expect(page.getByRole('status').filter({ hasText: '「取材メモ」を複製として元の場所に戻しました' })).toBeVisible()
    const bodies = await page.evaluate(
      (id) =>
        Object.values(window.__ns.getData().memos)
          .filter((m) => m.titleId === id)
          .sort((a, b) => a.order - b.order)
          .map((m) => m.body),
      titleId,
    )
    expect(bodies).toEqual(['別の端末の本文', 'この端末の本文'])
  })

  test('削除してから30日たったものは、起動した時に完全に削除される', async ({ page }) => {
    await openApp(page)
    const day = 24 * 60 * 60 * 1000
    await seedTrashEntry(
      page,
      { kind: 'idea', label: '古い案', deletedAt: Date.now() - 31 * day },
      { id: 'old-idea', titleId: null, heading: '古い案', body: '', order: 0, createdAt: 0, updatedAt: 0 },
      'ideas',
    )
    await seedTrashEntry(
      page,
      { kind: 'idea', label: '新しい案', deletedAt: Date.now() - 29.5 * day },
      { id: 'new-idea', titleId: null, heading: '新しい案', body: '', order: 1, createdAt: 0, updatedAt: 0 },
      'ideas',
    )
    // 読み込み直すと（起動時の整理で）古いものだけが消える
    await openApp(page, '/trash')
    await page.reload()
    await expect(page.getByTestId('trash-page')).toBeVisible()
    await expect(trashRows(page)).toHaveCount(1)
    await expect(trashRows(page).first().getByTestId('trash-label')).toHaveText('新しい案')
    await expect(trashRows(page).first().getByTestId('trash-days-left')).toHaveText('あと1日で完全に削除')
    const ids = await page.evaluate(() => Object.keys(window.__ns.getData().trashEntries))
    expect(ids).toEqual(['entry-new-idea'])
  })

  test('アプリの設定からも開ける', async ({ page }) => {
    await openApp(page, '/settings')
    await expect(page.getByTestId('trash-settings')).toContainText('ゴミ箱に30日間残り')
    await page.getByTestId('open-trash').click()
    await expect(page).toHaveURL(/#\/trash$/)
    await expect(page.locator('.breadcrumbs')).toContainText('ゴミ箱')
  })

  test('幅 360px でも横にはみ出さず、ボタンは押しやすい大きさ', async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      const id = actions.createTitle('とても長いタイトル名のついた物語をここに書いておくとどうなるか')
      for (let i = 0; i < 2; i++) {
        const m = actions.addMemo(id, `とても長い名前のメモ${i}をゴミ箱に入れても横にはみ出さないことを確かめるためのメモ`)
        actions.deleteMemo(m)
      }
      const s = actions.addSubmission(id, 'ずいぶん長い名前のコンテスト大賞2026')
      actions.deleteSubmission(s)
    })
    await openApp(page)
    await openTrashFromHome(page)
    await expect(trashRows(page)).toHaveCount(3)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const id of ['trash-restore', 'trash-delete', 'trash-empty-all']) {
      const box = await page.getByTestId(id).first().boundingBox()
      expect(box!.height, id).toBeGreaterThanOrEqual(34)
    }
    await page.screenshot({ path: `e2e/artifacts/screens/trash-${info.project.name}-360.png`, fullPage: true })
  })
})
