// 通し読みの縦書きのページ表示（字数×行数・全nページ（目安）・目次のページ番号・本のように右から左へ並ぶページ・
// ルビ・話の画面の「この話を通し読み」・スマホ）の E2E テスト。
import { expect, test, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

/** 1段落 400字・1000字・短い話（字数×行数ごとのページ数を数えやすいように、句読点のない字だけ） */
const BODIES = ['あ'.repeat(400), 'い'.repeat(1000), '三話の本文。']

async function seedBook(page: Page) {
  const ids = await seedTitleWithEpisodes(page, '頁の本', BODIES)
  await seed(page, ({ actions }, a: { id: string }) => actions.updatePiece(a.id, { subtitle: '長い話' }), { id: ids.pieceIds[1] })
  return ids
}

async function reloadApp(page: Page): Promise<void> {
  await page.evaluate(() => window.__ns.flushNow())
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__ns))
  await expect(page.getByText('読み込み中…')).toHaveCount(0)
}

async function openToc(page: Page): Promise<void> {
  if (!(await page.getByTestId('toc-link').first().isVisible())) await page.getByTestId('toc-toggle').click()
}

async function closeToc(page: Page): Promise<void> {
  const toggle = page.getByTestId('toc-toggle')
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
}

async function chooseSetup(page: Page, testId: string): Promise<void> {
  await page.getByTestId('page-setup-button').click()
  await expect(page.getByTestId('page-setup-menu')).toBeVisible()
  await page.getByTestId(testId).click()
  await expect(page.getByTestId('page-setup-menu')).toHaveCount(0)
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/artifacts/screens/read-pages-${test.info().project.name}-${name}.png` })

test.describe('通し読みの縦書きのページ表示', () => {
  test('字数×行数は縦書きの時だけ選べ、変えると全nページ（目安）と目次のページ番号が変わり、開き直しても残る', async ({
    page,
  }) => {
    await openApp(page)
    const { titleId } = await seedBook(page)
    await openApp(page, `/t/${titleId}/read`)

    // 横書き: 字数×行数・ページ数・目次のページ番号は出さない（今までどおり）
    await expect(page.getByTestId('read-piece')).toHaveCount(3)
    await expect(page.getByTestId('page-setup-button')).toHaveCount(0)
    await expect(page.getByTestId('read-pages')).toHaveCount(0)
    await expect(page.getByTestId('read-page-sheet')).toHaveCount(0)
    await openToc(page)
    await expect(page.getByTestId('toc-page')).toHaveCount(0)
    await closeToc(page)

    // 縦書き: 既定は 40字×32行。話ごとに新しいページから（見出し・空行・本文）
    await page.getByTestId('vertical-toggle').click()
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'vertical-rl')
    await expect(page.getByTestId('page-setup-button')).toBeVisible()
    await expect(page.getByTestId('page-setup-value')).toHaveText('40字×32行')
    await expect(page.getByTestId('read-pages')).toHaveText('・全3ページ（目安）')
    await expect(page.locator('.rt-pages-note')).toBeVisible()
    await expect(page.getByTestId('read-page-sheet')).toHaveCount(3)
    await expect(page.getByTestId('page-number')).toHaveText(['1', '2', '3'])
    await openToc(page)
    await expect(page.getByTestId('toc-page')).toHaveText(['p.1', 'p.2', 'p.3'])
    await closeToc(page)
    // 本のように、次のページは左
    const sheets = page.getByTestId('read-page-sheet')
    const x = async (n: number) => (await sheets.nth(n).boundingBox())!.x
    expect(await x(1)).toBeLessThan(await x(0))
    expect(await x(2)).toBeLessThan(await x(1))
    await shot(page, 'default')

    // 20字×20行: 400字 = 20行 + 見出しと空行 → 2ページ、1000字 = 50行 + 2 → 3ページ
    await chooseSetup(page, 'page-setup-20x20')
    await expect(page.getByTestId('page-setup-value')).toHaveText('20字×20行')
    await expect(page.getByTestId('read-pages')).toHaveText('・全6ページ（目安）')
    await expect(sheets).toHaveCount(6)
    await openToc(page)
    await expect(page.getByTestId('toc-page')).toHaveText(['p.1', 'p.3', 'p.6'])
    await closeToc(page)
    // 1ページは20行、1行は20字
    const firstPage = page.getByTestId('read-page-sheet').first()
    await expect(firstPage.locator('.pg-line')).toHaveCount(20)
    await expect(firstPage.locator('.pg-line.is-text').first()).toHaveText('あ'.repeat(20))
    await shot(page, '20x20')

    // 開き直しても残る（タイトルの設定）
    await reloadApp(page)
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'vertical-rl')
    await expect(page.getByTestId('page-setup-value')).toHaveText('20字×20行')
    await expect(page.getByTestId('read-pages')).toHaveText('・全6ページ（目安）')
    expect(await page.evaluate((id) => window.__ns.getData().titles[id].pageSetup, titleId)).toEqual({ chars: 20, lines: 20 })

    // 自由に入力: 範囲の外は知らせる。全角の数字も読む
    await page.getByTestId('page-setup-button').click()
    await expect(page.getByTestId('page-setup-20x20')).toContainText('20字×20行')
    await page.getByTestId('page-setup-custom').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('page-setup-chars').fill('70')
    await dialog.getByTestId('page-setup-apply').click()
    await expect(dialog.getByTestId('page-setup-error')).toHaveText('1行の字数は 10〜60 の数で入れてください')
    await dialog.getByTestId('page-setup-chars').fill('３０')
    await dialog.getByTestId('page-setup-lines').fill('3')
    await dialog.getByTestId('page-setup-lines').press('Enter')
    await expect(dialog.getByTestId('page-setup-error')).toHaveText('1ページの行数は 5〜60 の数で入れてください')
    await dialog.getByTestId('page-setup-lines').fill('10')
    await dialog.getByTestId('page-setup-apply').click()
    await expect(dialog).toHaveCount(0)
    // 30字×10行: 400字 = 14行 + 2 → 2ページ、1000字 = 34行 + 2 → 4ページ、短い話 1ページ
    await expect(page.getByTestId('page-setup-value')).toHaveText('30字×10行')
    await expect(page.getByTestId('read-pages')).toHaveText('・全7ページ（目安）')
    await page.getByTestId('page-setup-button').click()
    await expect(page.getByTestId('page-setup-custom')).toContainText('今は 30字×10行')
    await page.keyboard.press('Escape')

    // 横書きに戻すと、字数×行数は出さない
    await page.getByTestId('vertical-toggle').click()
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'horizontal-tb')
    await expect(page.getByTestId('page-setup-button')).toHaveCount(0)
    await expect(page.getByTestId('read-pages')).toHaveCount(0)
    await expect(page.getByTestId('read-piece').nth(1)).toContainText('い'.repeat(50))
  })

  test('話の画面の「この話を通し読み」はその話だけを開き、ページ数はその話の分', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedBook(page)
    await seed(page, ({ actions }, a: { id: string }) => actions.setTitlePageSetup(a.id, { chars: 20, lines: 20 }), {
      id: titleId,
    })
    await openApp(page, `/t/${titleId}/p/${pieceIds[1]}`)
    await page.getByTestId('read-episode-link').click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}/read\\?piece=${pieceIds[1]}$`))
    await expect(page.locator('.breadcrumbs')).toContainText('第2話')
    await expect(page.locator('.breadcrumbs')).toContainText('通し読み')

    const pieces = page.getByTestId('read-piece')
    await expect(pieces).toHaveCount(1)
    await expect(pieces.first()).toContainText('長い話')
    await expect(page.getByText('三話の本文。')).toHaveCount(0)
    await expect(page.getByTestId('read-scope')).toHaveValue(':piece')
    await expect(page.getByTestId('read-scope').locator('option:checked')).toHaveText('第2話　長い話')

    // 縦書き: その話のページだけ（1ページ目から）
    if ((await page.getByTestId('vertical-toggle').getAttribute('aria-pressed')) !== 'true') {
      await page.getByTestId('vertical-toggle').click()
    }
    await expect(page.getByTestId('read-pages')).toHaveText('・全3ページ（目安）')
    await expect(page.getByTestId('page-number')).toHaveText(['1', '2', '3'])
    await openToc(page)
    await expect(page.getByTestId('toc-link')).toHaveCount(1)
    await expect(page.getByTestId('toc-page')).toHaveText(['p.1'])
    await closeToc(page)

    // 範囲を「全体」にすると、すべての話
    await page.getByTestId('read-scope').selectOption('')
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}/read$`))
    await expect(pieces).toHaveCount(3)
    await expect(page.getByTestId('read-pages')).toHaveText('・全6ページ（目安）')
  })

  test('ルビ・傍点は字の右に小さく付き、マスを取らない', async ({ page }) => {
    await openApp(page)
    // 親文字（1字）より長い読み（8字の半分の大きさ = 4字分）。2行目は同じ字のルビなし
    const body = '｜火《ファイアーボール》が《《星》》を見た。\n火が星を見た。'
    const { titleId } = await seedTitleWithEpisodes(page, 'ルビの本', [body])
    await openApp(page, `/t/${titleId}/read`)
    await page.getByTestId('vertical-toggle').click()
    const lines = page.locator('.pg-line.is-text')
    await expect(lines).toHaveCount(2)
    const line = lines.first()
    await expect(line.locator('.pg-ruby .pg-rt')).toHaveText('ファイアーボール')
    await expect(line.locator('em.rb-bouten')).toHaveText('星')
    await expect(lines.nth(1)).toHaveText('火が星を見た。')
    const box = await page.evaluate(() => {
      const [withRuby, plain] = [...document.querySelectorAll('.pg-line.is-text')]
      const rt = withRuby.querySelector('.pg-rt')!
      // 行の字の並ぶ長さ（読みを除く）
      const extent = (el: Element) => {
        let top = Infinity
        let bottom = -Infinity
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (rt.contains(n)) continue
          const range = document.createRange()
          range.selectNodeContents(n)
          for (const r of range.getClientRects()) {
            top = Math.min(top, r.top)
            bottom = Math.max(bottom, r.bottom)
          }
        }
        return bottom - top
      }
      const base = withRuby.querySelector('.pg-ruby')!.getBoundingClientRect()
      const r = rt.getBoundingClientRect()
      return {
        baseRight: base.right,
        rtLeft: r.left,
        rtWidth: r.width,
        glyph: parseFloat(getComputedStyle(withRuby).fontSize),
        withRuby: extent(withRuby),
        plain: extent(plain),
      }
    })
    // 読みは親文字の右に、半分の大きさで
    expect(box.rtLeft).toBeGreaterThanOrEqual(box.baseRight - 1)
    expect(box.rtWidth).toBeLessThanOrEqual(box.glyph * 0.6)
    // 行の長さはルビのない同じ字の行と同じ（読みの分は延びない）
    expect(Math.abs(box.withRuby - box.plain)).toBeLessThanOrEqual(1)
    await shot(page, 'ruby')
  })

  test('スマホ: ページの高さは画面に収まり、横にスクロールして読む', async ({ page, isMobile }) => {
    const bodies = Array.from(
      { length: 6 },
      (_, i) => `第${i + 1}話の本文。\n` + '　夜明け前の港には、まだ誰の足音もなかった。\n'.repeat(40),
    )
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '持ち歩く本', bodies)
    await openApp(page, `/t/${titleId}/read`)
    await page.getByTestId('vertical-toggle').click()
    const doc = page.getByTestId('read-body')
    await expect(doc).toHaveCSS('writing-mode', 'vertical-rl')
    await expect(page.getByTestId('read-page-sheet').first()).toBeVisible()

    const fit = async () =>
      doc.evaluate((el) => {
        const cs = getComputedStyle(el)
        const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
        const sheet = el.querySelector('[data-testid="read-page-sheet"]')!.getBoundingClientRect()
        return { inner, sheet: sheet.height, scrollable: el.scrollWidth > el.clientWidth, overflowY: cs.overflowY }
      })
    let f = await fit()
    expect(f.sheet).toBeLessThanOrEqual(f.inner + 1)
    expect(f.scrollable).toBe(true)
    expect(f.overflowY).toBe('hidden')
    // ページの外（画面全体）は横にスクロールしない
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0)

    if (isMobile) {
      // スマホの高さでは 40字×32行のページはもう枠の高さいっぱい（［＋］は押せない）
      await expect(page.getByTestId('font-larger')).toBeDisabled()
      await shot(page, 'phone-40x32')
    }

    // 20字×20行にして、文字を大きくしてもページは枠の高さまで（それ以上は［＋］を押せない）
    await chooseSetup(page, 'page-setup-20x20')
    await expect(page.getByTestId('page-setup-value')).toHaveText('20字×20行')
    for (let i = 0; i < 16 && (await page.getByTestId('font-larger').isEnabled()); i++)
      await page.getByTestId('font-larger').click()
    f = await fit()
    expect(f.sheet).toBeLessThanOrEqual(f.inner + 1)
    if (isMobile) await expect(page.getByTestId('font-larger')).toBeDisabled()
    // 小さくするとページごと小さくなる（字数×行数は同じ）
    const before = f.sheet
    await page.getByTestId('font-smaller').click()
    await page.getByTestId('font-smaller').click()
    await expect.poll(async () => (await fit()).sheet).toBeLessThan(before - 1)
    await expect(page.getByTestId('read-page-sheet').first().locator('.pg-line').first()).toBeVisible()
    await shot(page, 'phone')

    // 横にスクロールすると次のページが出る（遠くのページも画面の近くに来たら行を組む）
    const last = page.getByTestId('read-page-sheet').last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toHaveAttribute('data-near', 'true')
    await expect(last.locator('.pg-line').first()).toBeVisible()
  })

  test('枠の高さが変わってページの大きさが変わっても（目次の開け閉め・画面の大きさ・向き）、読んでいたページを出す', async ({
    page,
    isMobile,
  }) => {
    const bodies = Array.from(
      { length: 12 },
      (_, i) => `第${i + 1}話の本文。\n` + '　夜明け前の港には、まだ誰の足音もなかった。\n'.repeat(40),
    )
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '持ち歩く本', bodies)
    await openApp(page, `/t/${titleId}/read`)
    await page.getByTestId('vertical-toggle').click()
    const doc = page.getByTestId('read-body')
    await expect(doc).toHaveCSS('writing-mode', 'vertical-rl')
    await expect(page.getByTestId('read-page-sheet').first()).toBeVisible()

    /** 読み始めの線（本文の枠の右端の少し内側）にかかるページの番号と、1ページの高さ */
    const reading = () =>
      doc.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const line = r.right - 30
        const sheets = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="read-page-sheet"]'))
        const hit =
          sheets.find((s) => {
            const b = s.getBoundingClientRect()
            return b.left <= line && b.right >= line
          }) ?? sheets.find((s) => s.getBoundingClientRect().right < line)
        return { page: hit ? Number(hit.dataset.page) : null, height: sheets[0].getBoundingClientRect().height }
      })
    // 8割ほど読み進める（縦書きでは scrollLeft は 0 から負の方向へ）
    await doc.evaluate((el) => (el.scrollLeft = -(el.scrollWidth - el.clientWidth) * 0.8))
    await expect.poll(async () => (await reading()).page).toBeGreaterThan(10)
    const start = await reading()

    if (isMobile) {
      // 目次を本文の上に開いている間はページを縮めず、閉じても同じページ
      await page.getByTestId('toc-toggle').click()
      await expect(page.getByTestId('toc-link').first()).toBeVisible()
      expect((await reading()).height).toBeCloseTo(start.height, 0)
      await page.getByTestId('toc-toggle').click()
      await expect(page.getByTestId('toc-link').first()).toBeHidden()
      await expect.poll(async () => (await reading()).page).toBe(start.page)
      expect((await reading()).height).toBeCloseTo(start.height, 0)
    }

    // 画面を低くする（スマホは横向き）とページは小さくなり、戻すと元の大きさ。どちらでも同じページを出す
    const size = page.viewportSize()!
    await page.setViewportSize(isMobile ? { width: size.height, height: size.width } : { width: size.width, height: 600 })
    await expect.poll(async () => (await reading()).height).toBeLessThan(start.height - 20)
    await expect.poll(async () => (await reading()).page).toBe(start.page)
    await page.setViewportSize(size)
    await expect.poll(async () => (await reading()).height).toBeCloseTo(start.height, 0)
    await expect.poll(async () => (await reading()).page).toBe(start.page)
  })
})
