// 原稿画面の欄ごとの検索（採用原稿・推敲バージョン）の E2E テスト。
// 印（今の一致1か所）が本文欄の見えている所に出ること、遠くの一致へスクロールすること、閉じると選ぶこと、
// 差分の表示でも探せること、話を移っても語が残ること、スマホでキーボード（フォーカス）を外さないことを確かめる
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { openApp, seed } from './helpers'

const isDesktop = (info: TestInfo) => info.project.name === 'desktop'

/** 何百段落かの長い本文（ルビ・傍点・全角の英数字・半角カナを含む） */
function longBody(): string {
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}行目の文章です。`)
  lines[4] = '５行目に｜漢字《かんじ》のルビ。'
  lines[149] = '150行目は遠くの《《目印》》。'
  lines[279] = '280行目はＡＢＣとｶﾞｷの目印。'
  return lines.join('\n')
}

interface Ids {
  titleId: string
  pieceId: string
  secondId: string
  v1: string
  v2: string
  body: string
}

async function seedWork(page: Page): Promise<Ids> {
  await openApp(page)
  return seed(
    page,
    ({ actions, getData }, body: string) => {
      const titleId = actions.createTitle('検索の作品')
      const pieceId = actions.addEpisode(titleId)
      const v1 = getData().pieces[pieceId].versionIds[0]
      actions.updateVersion(v1, { body })
      // 推敲バージョンは150行目を書き換えた稿（差分の表示で、削除された「遠くの」と足した「書き換え」が出る）
      const v2 = actions.addVersion(pieceId, { body: body.replace('遠くの《《目印》》', '書き換えた') })
      const secondId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[secondId].versionIds[0], { body: '二話目にも目印。\nさらに目印。\nもう一つ目印。' })
      return { titleId, pieceId, secondId, v1, v2, body }
    },
    longBody(),
  )
}

async function openPiece(page: Page, ids: Ids, pieceId: string, versionId?: string) {
  await openApp(page, `/t/${ids.titleId}/p/${pieceId}${versionId ? `?v=${versionId}` : ''}`)
  await expect(page.getByTestId('piece-workspace')).toBeVisible()
}

/** 印の矩形が、本文欄の見えている範囲の中にある */
async function hitInside(rect: Locator, field: Locator): Promise<boolean> {
  const r = await rect.boundingBox()
  const f = await field.boundingBox()
  if (!r || !f) return false
  return (
    r.width > 0 && r.y >= f.y - 1 && r.y + r.height <= f.y + f.height + 1 && r.x >= f.x - 1 && r.x + r.width <= f.x + f.width + 1
  )
}

test.describe('パソコン', () => {
  test.skip(({ isMobile }) => isMobile, 'パソコンのみ')

  test('Ctrl+F で開き、遠くの一致へスクロールして印を出す。Enter で移り、Esc で本文欄に戻って選ぶ', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+f')
    const input = page.getByTestId('active-search-input')
    await expect(input).toBeFocused()
    // 検索窓は本文欄のすぐ上
    const bar = (await page.getByTestId('active-search').boundingBox())!
    expect(Math.round(bar.y + bar.height)).toBeLessThanOrEqual(Math.round((await editor.boundingBox())!.y) + 1)

    await page.keyboard.type('目印')
    const count = page.getByTestId('active-search-count')
    await expect(count).toHaveText('1／2')
    const rect = page.getByTestId('active-search-hit').locator('.pw-hit-rect')
    await expect(rect).toHaveCount(1)
    await expect.poll(() => editor.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect.poll(() => hitInside(rect, editor)).toBe(true)
    const firstTop = await editor.evaluate((el) => el.scrollTop)

    await page.keyboard.press('Enter')
    await expect(count).toHaveText('2／2')
    await expect.poll(() => editor.evaluate((el) => el.scrollTop)).toBeGreaterThan(firstTop)
    await expect.poll(() => hitInside(rect, editor)).toBe(true)
    // 本文欄をスクロールすると、印も付いていく
    const before = (await rect.boundingBox())!.y
    await editor.evaluate((el) => (el.scrollTop -= 40))
    await expect.poll(async () => Math.round((await rect.boundingBox())!.y - before)).toBe(40)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('active-search')).toHaveCount(0)
    await expect(editor).toBeFocused()
    const at = ids.body.lastIndexOf('目印')
    expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([at, at + 2])

    // ルビの親文字・全角と半角（ＡＢＣ・ｶﾞｷ）
    await page.keyboard.press('Control+f')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('漢字の')
    await expect(count).toHaveText('1／1')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('abcとガキ')
    await expect(count).toHaveText('1／1')
    await expect.poll(() => hitInside(rect, editor)).toBe(true)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('かんじ')
    await expect(count).toHaveText('見つかりません')
  })

  test('日本語入力の変換中は探さず、確定してから探す', async ({ page }, info) => {
    test.skip(!isDesktop(info), 'Chromium の日本語入力の再現（CDP）はデスクトップで行う')
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    await page.getByTestId('active-search-toggle').click()
    const input = page.getByTestId('active-search-input')
    await expect(input).toBeFocused()
    const cdp = await page.context().newCDPSession(page)
    for (const text of ['め', 'めじ', 'めじる', '目印'])
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await expect(page.getByTestId('active-search-count')).toHaveText('')
    await cdp.send('Input.insertText', { text: '目印' })
    await expect(page.getByTestId('active-search-count')).toHaveText('1／2')
  })

  test('推敲バージョンの差分の表示でも探せ、話を移っても語が残る', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    await expect(page.getByTestId('compare-editor')).toBeVisible()
    await page.locator('label:has([data-testid="diff-toggle"])').click()
    const diff = page.getByTestId('diff-view')
    await expect(diff.locator('.diff-del').first()).toBeVisible()
    await page.getByTestId('compare-search-toggle').click()
    await page.keyboard.type('遠くの')
    await expect(page.getByTestId('compare-search-count')).toHaveText('1／1')
    const hit = page.getByTestId('diff-search-hit')
    await expect(hit).toBeVisible()
    await expect.poll(() => hitInside(hit, diff)).toBe(true)
    await expect(hit).toHaveText('遠くの')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('書き換え')
    await expect(page.getByTestId('compare-search-count')).toHaveText('1／1')
    await expect(hit).toHaveText('書き換え')
    await expect.poll(() => hitInside(hit, diff)).toBe(true)
    // 採用原稿の検索は別の語
    await page.getByTestId('active-search-toggle').click()
    await page.keyboard.type('目印')
    await expect(page.getByTestId('active-search-count')).toHaveText('1／2')
    await expect(page.getByTestId('compare-search-input')).toHaveValue('書き換え')

    await page.getByTestId('next-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.secondId}`))
    await expect(page.getByTestId('active-editor')).toHaveValue(/^二話目にも目印/)
    await expect(page.getByTestId('active-search-input')).toHaveValue('目印')
    await expect(page.getByTestId('active-search-count')).toHaveText('3件')
    await page.getByTestId('active-search-input').press('Enter')
    await expect(page.getByTestId('active-search-count')).toHaveText('1／3')
  })
})

test.describe('スマホ', () => {
  test.skip(({ isMobile }) => !isMobile, 'スマホ（タッチ操作）のみ')

  test('「検索」を押すと検索窓にフォーカスが移り、次へ・前へを押してもフォーカスは外れない。キーボードが出ても記号バーと重ならない', async ({
    page,
  }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const vp = page.viewportSize()!
    await page.getByTestId('active-search-toggle').tap()
    const input = page.getByTestId('active-search-input')
    await expect(input).toBeFocused()
    // 書いている間（集中モード）も検索窓は隠さない
    await expect(page.getByTestId('piece-workspace')).toHaveClass(/is-focus-mode/)
    await page.keyboard.type('目印')
    await expect(page.getByTestId('active-search-count')).toHaveText('1／2')
    await page.getByTestId('active-search-next').tap()
    await expect(input).toBeFocused()
    await expect(page.getByTestId('active-search-count')).toHaveText('2／2')
    await page.getByTestId('active-search-prev').tap()
    await expect(input).toBeFocused()
    await expect(page.getByTestId('active-search-count')).toHaveText('1／2')

    // Android: キーボードの分だけ画面が縮む。検索窓と印は記号バーの上に見えている
    await page.setViewportSize({ width: vp.width, height: Math.round(vp.height / 2) })
    const symbols = page.getByTestId('symbol-bar')
    await expect
      .poll(async () => Math.round((await symbols.boundingBox())!.y + (await symbols.boundingBox())!.height))
      .toBe(Math.round(vp.height / 2))
    const bar = (await page.getByTestId('active-search').boundingBox())!
    expect(bar.y).toBeGreaterThanOrEqual(0)
    expect(bar.y + bar.height).toBeLessThanOrEqual((await symbols.boundingBox())!.y + 1)
    const editor = page.getByTestId('active-editor')
    const rect = page.getByTestId('active-search-hit').locator('.pw-hit-rect')
    await expect.poll(() => hitInside(rect, editor)).toBe(true)
    await page.getByTestId('active-search-next').tap()
    await expect(input).toBeFocused()
    await expect.poll(() => hitInside(rect, editor)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width)
  })

  test('狭い画面でもヘッダーと検索窓が1行に収まる', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    await page.getByTestId('compare-search-toggle').tap()
    await page.keyboard.type('目印')
    await expect(page.getByTestId('compare-search-count')).toHaveText('1／1')
    for (const id of ['active-search-toggle', 'compare-search-toggle', 'compare-more-button', 'adopt-button']) {
      const b = (await page.getByTestId(id).boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(360)
    }
    const search = (await page.getByTestId('compare-search').boundingBox())!
    expect(search.height).toBeLessThan(50)
    for (const id of ['compare-search-prev', 'compare-search-next', 'compare-search-close']) {
      const b = (await page.getByTestId(id).boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(360)
      expect(b.y).toBeGreaterThanOrEqual(search.y)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  })
})
