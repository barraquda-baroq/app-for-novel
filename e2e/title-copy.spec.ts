// ホームのタイトルのコピー（第二稿）の E2E テスト: 並べ替え・編集 → コピー → 名前のダイアログ → 元のすぐ後ろに新しいタイトル。
// 写しを開くと同じ話・採用原稿（幕に分けた話も）が読め、元のタイトルは変わらない。
import { expect, test, type Page } from '@playwright/test'
import { noHorizontalScroll, openApp, openHomeBands, seed } from './helpers'

const NAME = '海辺の町'
const COPY = '海辺の町（第二稿）'

interface Ids {
  titleId: string
  ep1: string
  ep2: string
}

/** 「海辺の町」: プロローグ・第1話（第1稿と、採用した第2稿）・第2話（2つの幕）、メモと全体戦略。後ろに「別の話」 */
async function seedWork(page: Page): Promise<Ids> {
  return seed(
    page,
    ({ actions, getData }, a: { name: string }) => {
      const titleId = actions.createTitle(a.name)
      actions.updateTitle(titleId, { synopsis: '港の物語', strategyNote: '新人賞を狙う' })
      const ep1 = actions.addEpisode(titleId)
      actions.updatePiece(ep1, { subtitle: '朝の港' })
      actions.updateVersion(getData().pieces[ep1].activeVersionId!, { body: '一話の初稿。' })
      const v2 = actions.duplicateVersion(getData().pieces[ep1].activeVersionId!)
      actions.updateVersion(v2, { body: '一話の採用稿。' })
      actions.setActiveVersion(ep1, v2)
      const ep2 = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[ep2].activeVersionId!, { body: '前半の幕。後半の幕。' })
      actions.separatePiece(ep2, [5])
      const pro = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
      actions.updateVersion(getData().pieces[pro].activeVersionId!, { body: 'はじまり。' })
      const memo = actions.addMemo(titleId, '構成メモ')
      actions.updateMemo(memo, { body: '三幕構成' })
      actions.createTitle('別の話')
      return { titleId, ep1, ep2 }
    },
    { name: NAME },
  )
}

/** タイトルとその配下のレコード（元のタイトルが変わっていないかを比べる） */
function ownedRecords(page: Page, titleId: string): Promise<string> {
  return page.evaluate((id) => {
    const d = window.__ns.getData()
    const tables = ['chapters', 'pieces', 'versions', 'memos', 'settingCategories', 'settingEntries'] as const
    const out: Record<string, unknown> = { title: d.titles[id] }
    for (const t of tables) {
      out[t] = Object.values(d[t] as Record<string, { id: string; titleId: string }>)
        .filter((r) => r.titleId === id)
        .sort((a, b) => a.id.localeCompare(b.id))
    }
    return JSON.stringify(out)
  }, titleId)
}

function titleCardNames(page: Page): Promise<string[]> {
  return page.getByTestId('title-card-name').allTextContents()
}

test.describe('タイトルのコピー（第二稿）', () => {
  test('並べ替え・編集 → コピー: 名前を聞いて元のすぐ後ろに作り、写しを開くと同じ話と採用原稿。元のタイトルは変わらない', async ({
    page,
  }) => {
    await openApp(page)
    const ids = await seedWork(page)
    const before = await ownedRecords(page, ids.titleId)
    await openHomeBands(page, 'titles')
    await page.getByTestId('titles-edit-toggle').click()
    const original = page.locator(`[data-testid="title-card"][data-title-id="${ids.titleId}"]`)
    await original.getByTestId('title-copy').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText(`「${NAME}」をコピー`)
    await expect(dialog.getByRole('textbox')).toHaveValue(COPY)
    await expect(dialog).toContainText('話・幕の採用原稿と、設定項目・メモ・全体戦略・相対比較する作品をコピーします')
    await expect(dialog).toContainText('採用していない稿・応募計画・推敲案・改稿案・戦略メモ・作品批評・アイデアはコピーしません')
    // 空の名前ではコピーできない
    const ok = dialog.getByRole('button', { name: 'コピーする', exact: true })
    await dialog.getByRole('textbox').fill('')
    await expect(ok).toBeDisabled()
    await dialog.getByRole('textbox').fill(COPY)
    await expect(ok).toBeEnabled()

    // 幅 360px でもダイアログを開いたまま横にスクロールしない
    const size = page.viewportSize()!
    await page.setViewportSize({ width: 360, height: 740 })
    await noHorizontalScroll(page)
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(360)
    await expect(ok).toBeInViewport()
    await page.setViewportSize(size)

    await ok.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: `「${NAME}」をコピーして「${COPY}」を作りました` })).toBeVisible()
    await expect.poll(() => titleCardNames(page)).toEqual([NAME, COPY, '別の話'])
    const copyCard = page.getByTestId('title-card').nth(1)
    await expect(copyCard).toBeInViewport()
    await expect(copyCard.getByTestId('title-card-episodes')).toHaveText('全2話＋特殊1')
    await expect(copyCard.getByTestId('title-card-chars')).toHaveText(await original.getByTestId('title-card-chars').innerText())
    expect(await ownedRecords(page, ids.titleId)).toBe(before)

    // 写しを開くと、同じ話（幕に分けた話も）が並ぶ
    await copyCard.getByTestId('title-card-link').click()
    await expect(page).toHaveURL(/#\/t\/[^/?]+$/)
    const copyId = page.url().split('/t/')[1]
    expect(copyId).not.toBe(ids.titleId)
    await expect(page.getByTestId('title-name')).toHaveValue(COPY)
    const list = page.getByTestId('story-list')
    await expect(list.getByTestId('piece-label')).toHaveText(['プロローグ', '第1話', '第2話'])
    await expect(list.getByTestId('piece-subtitle').first()).toHaveText('朝の港')
    const split = list.locator('[data-testid="piece-row"][data-split="true"]')
    await expect(split.getByTestId('act-label')).toHaveText(['第1幕', '第2幕'])

    // 通し読み: 採用原稿だけ（幕に分けた話は各幕）
    await openApp(page, `/t/${copyId}/read`)
    const pieces = page.getByTestId('read-piece')
    await expect(pieces).toHaveCount(3)
    await expect(pieces.nth(1).getByTestId('read-text')).toHaveText('一話の採用稿。')
    await expect(pieces.nth(2).getByTestId('read-act-label')).toHaveText(['第1幕', '第2幕'])
    await expect(pieces.nth(2).getByTestId('read-text')).toHaveText(['前半の幕。', '後半の幕。'])

    // 第1話: 採用稿だけ（名前もそのまま）
    const copyEp1 = await page.evaluate(({ id }) => window.__ns.getData().titles[id].structure[1].id, { id: copyId })
    await openApp(page, `/t/${copyId}/p/${copyEp1}`)
    await expect(page.getByTestId('active-editor')).toHaveValue('一話の採用稿。')
    const rows = page.getByTestId('version-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('第2稿（第1稿を複製）')
    await expect(rows.first()).toContainText('採用中')

    // 元のタイトルは変わっていない（再読み込みしても）
    await page.evaluate(() => window.__ns.flushNow())
    await page.reload()
    await openApp(page, `/t/${ids.titleId}/p/${ids.ep1}`)
    expect(await ownedRecords(page, ids.titleId)).toBe(before)
    await expect(page.getByTestId('version-row')).toHaveCount(2)
  })

  test('「（第n稿）」で終わる名前は次の番号を出し、キャンセルすると何も作らない。360px の編集の行も横にはみ出さない', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      actions.createTitle('海辺の町（第二稿）')
      actions.createTitle('別の話')
    })
    await openHomeBands(page, 'titles')
    await page.getByTestId('titles-edit-toggle').click()
    await noHorizontalScroll(page)
    const copy = page.getByTestId('title-card').first().getByTestId('title-copy')
    await expect(copy).toBeVisible()
    const box = (await copy.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(34)
    await copy.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('textbox')).toHaveValue('海辺の町（第三稿）')
    await noHorizontalScroll(page)
    await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => titleCardNames(page)).toEqual(['海辺の町（第二稿）', '別の話'])
  })

  test('スマホ: 画面の下の端のタイトルをコピーしても新しいカードは通知に隠れず、長い名前の通知は縮める。2回目のコピーは（第三稿）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await openApp(page)
    const long = '潮騒の聞こえる海辺の町で最後の夏を過ごした少年少女たちの物語'.repeat(3)
    const id = await seed(
      page,
      ({ actions }, a: { long: string }) => {
        for (let i = 1; i <= 8; i++) actions.createTitle(`前の話${i}`)
        const id = actions.createTitle(a.long)
        actions.createTitle('別の話')
        return id
      },
      { long },
    )
    await openHomeBands(page, 'titles')
    await page.getByTestId('titles-edit-toggle').click()
    const original = page.locator(`[data-testid="title-card"][data-title-id="${id}"]`)
    // 指で押す時のように、元のカードを画面の下の端に置いてから押す（写しはその下に入る）
    await original.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await original.getByTestId('title-copy').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('textbox')).toHaveValue(`${long}（第二稿）`)
    await dialog.getByRole('button', { name: 'コピーする', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // 通知は名前の真ん中を縮め、終わりの「（第二稿）」は残す
    const toast = page.getByRole('status').filter({ hasText: 'をコピーして' })
    await expect(toast).toHaveText(
      '「潮騒の聞こえる海辺の町で…少女たちの物語」をコピーして「潮騒の聞こえる海辺の町で…物語（第二稿）」を作りました',
    )
    const copyCard = page.getByTestId('title-card').nth(9)
    await expect(copyCard.getByTestId('title-card-name')).toHaveText(`${long}（第二稿）`)
    // 新しいカード（操作の行も）は画面の中にあり、通知より上に出る
    const row = copyCard.locator('.home-title-edit')
    await expect(row).toBeInViewport({ ratio: 1 })
    await expect
      .poll(async () => {
        const r = await row.boundingBox()
        const t = await toast.boundingBox()
        return r && t ? Math.round(t.y - (r.y + r.height)) : null
      })
      .toBeGreaterThanOrEqual(0)

    // 同じタイトルをもう一度コピーする時は、もうある名前を避けて（第三稿）
    await original.getByTestId('title-copy').click()
    await expect(dialog.getByRole('textbox')).toHaveValue(`${long}（第三稿）`)
    await dialog.getByRole('button', { name: 'コピーする', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await titleCardNames(page)).slice(8, 11))
      .toEqual([long, `${long}（第三稿）`, `${long}（第二稿）`])
  })
})
