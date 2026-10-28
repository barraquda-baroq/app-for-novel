// ルビ・傍点の表示（通し読み・一覧の抜粋）、記法を除いた文字数、各話の進捗の E2E テスト。
import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed } from './helpers'

const BODY = '　彼は｜魔法使い《ウィザード》だった。\n東京《とうきょう》の空に《《星》》が落ちた。\n作品名は｜《銀河》です。'
/** 表示される文字（記号とルビの読みを除く）: 空白・改行を除いて数える */
const BODY_CHARS = Array.from('彼は魔法使いだった。東京の空に星が落ちた。作品名は《銀河》です。').length

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** ルビの親文字（ruby の最初の文字）と読み（rt）の位置 */
function rubyBoxes(ruby: Locator): Promise<{ base: Box; rt: Box }> {
  return ruby.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.firstChild!)
    const b = range.getBoundingClientRect()
    const r = el.querySelector('rt')!.getBoundingClientRect()
    const box = (x: DOMRect) => ({ left: x.left, right: x.right, top: x.top, bottom: x.bottom })
    return { base: box(b), rt: box(r) }
  })
}

async function seedRubyTitle(page: Page): Promise<string> {
  return seed(
    page,
    ({ actions, getData }, a: { body: string }) => {
      const titleId = actions.createTitle('星降る街')
      const p1 = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[p1].versionIds[0], { body: a.body })
      const p2 = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[p2].versionIds[0], { body: '二話目。' })
      return titleId
    },
    { body: BODY },
  )
}

test.describe('ルビ・傍点', () => {
  test('通し読みでは、ルビは ruby/rt、傍点は黒ゴマの圏点で表示する（横書き・縦書き）。書き出しは記法のまま', async ({ page }) => {
    await openApp(page)
    const titleId = await seedRubyTitle(page)
    await openApp(page, `/t/${titleId}/read`)
    const text = page.getByTestId('read-text').first()
    await expect(text).toBeVisible()

    const rubies = text.locator('ruby')
    await expect(rubies).toHaveCount(2)
    await expect(rubies.locator('rt')).toHaveText(['ウィザード', 'とうきょう'])
    // 括弧（rp）は表示しない
    await expect(rubies.first().locator('rp').first()).toBeHidden()
    const bouten = text.locator('em.rb-bouten')
    await expect(bouten).toHaveText('星')
    const emphasis = await bouten.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { style: cs.textEmphasisStyle, position: cs.textEmphasisPosition, fontStyle: cs.fontStyle }
    })
    expect(emphasis.style).toContain('sesame')
    expect(emphasis.style).not.toContain('open')
    // 横書きでは上・縦書きでは右（Chromium は既定の right を省いて over と返す）
    expect(emphasis.position).toMatch(/^over( right)?$/)
    expect(emphasis.fontStyle).toBe('normal')
    // 記号は出さない。｜《 は《そのもの
    const shown = (await text.innerText()).replace(/ウィザード|とうきょう/g, '')
    expect(shown).not.toContain('｜')
    expect(shown).toContain('作品名は《銀河》です。')
    // 文字数は記号と読みを除く
    await expect(page.getByTestId('read-total')).toHaveText(`採用原稿 ${BODY_CHARS + 4}字`)

    // 横書き: 読みは親文字の上
    let { base, rt } = await rubyBoxes(rubies.first())
    expect(rt.bottom).toBeLessThanOrEqual(base.top + 2)
    expect(rt.left).toBeGreaterThanOrEqual(base.left - 2)
    expect(rt.right).toBeLessThanOrEqual(base.right + 2)
    await page.screenshot({ path: `e2e/artifacts/screens/ruby-${test.info().project.name}-horizontal.png` })

    // 縦書き: 読みは親文字の右
    await page.getByTestId('vertical-toggle').click()
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'vertical-rl')
    ;({ base, rt } = await rubyBoxes(rubies.first()))
    expect(rt.left).toBeGreaterThanOrEqual(base.right - 2)
    expect(rt.top).toBeGreaterThanOrEqual(base.top - 2)
    expect(rt.bottom).toBeLessThanOrEqual(base.bottom + 2)
    expect(await bouten.evaluate((el) => getComputedStyle(el).textEmphasisPosition)).toMatch(/^over( right)?$/)
    await page.screenshot({ path: `e2e/artifacts/screens/ruby-${test.info().project.name}-vertical.png` })
    await page.getByTestId('vertical-toggle').click()

    // テキストの書き出しは記法のまま
    await page.evaluate(() => {
      const w = window as unknown as { __names?: string[] }
      w.__names = []
      const original = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.download) w.__names!.push(this.download)
        return original.call(this)
      }
    })
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-text').click()])
    const exported = readFileSync(await download.path(), 'utf8')
    expect(exported).toContain(BODY)
  })

  test('本編の一覧の抜粋もルビ・傍点を表示し、文字数は記号と読みを除く（ホーム・一覧・章ページ・戦略）', async ({ page }) => {
    await openApp(page)
    const titleId = await seedRubyTitle(page)
    const total = BODY_CHARS + 4

    await openApp(page, '/')
    await expect(page.getByTestId('title-card-chars')).toHaveText(`${total}字`)

    await openApp(page, `/t/${titleId}`)
    await expect(page.getByTestId('stat-chars')).toContainText(`採用原稿 ${total}字`)
    const row = page.getByTestId('piece-row').first()
    await expect(row.getByTestId('piece-adopted')).toHaveText(`採用: 第1稿・${BODY_CHARS}字`)
    const excerpt = row.getByTestId('piece-excerpt')
    await expect(excerpt.locator('ruby rt')).toHaveText(['ウィザード', 'とうきょう'])
    await expect(excerpt.locator('em.rb-bouten')).toHaveText('星')
    // 1行の抜粋でも、読みが行の枠で切れない
    const clipped = await excerpt.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const rt = el.querySelector('rt')!.getBoundingClientRect()
      return rt.top < box.top - 0.5
    })
    expect(clipped).toBe(false)

    // 章ページ
    const chapterId = await seed(
      page,
      ({ actions, getData }, a: { titleId: string }) => {
        actions.setChaptersEnabled(a.titleId, true)
        return getData().titles[a.titleId].structure[0].id
      },
      { titleId },
    )
    await openApp(page, `/t/${titleId}/c/${chapterId}`)
    await expect(page.getByTestId('chapter-page')).toContainText(`採用原稿 ${total}字`)

    // 戦略（現在の原稿）
    await openApp(page, `/t/${titleId}?tab=strategy`)
    await expect(page.getByTestId('summary-chars')).toHaveText(`${total}字`)
  })

  test('ルビの多い長編でも、ルビの要素は画面の近くの話にだけ作る（目次で移動した先・印刷では表示する）', async ({ page }) => {
    test.setTimeout(90_000)
    await openApp(page)
    const para = '　｜彼女《かのじょ》は振り返らずに、静かに扉《とびら》を閉めた。《《待って》》と言う声がした。\n'
    const titleId = await seed(
      page,
      ({ actions, getData }, a: { para: string }) => {
        const id = actions.createTitle('長い物語')
        for (let i = 0; i < 60; i++) {
          const p = actions.addEpisode(id)
          actions.updateVersion(getData().pieces[p].versionIds[0], { body: a.para.repeat(60) })
        }
        return id
      },
      { para },
    )
    await openApp(page, `/t/${titleId}/read`)
    const pieces = page.getByTestId('read-piece')
    await expect(pieces).toHaveCount(60)
    await expect.poll(() => pieces.first().locator('ruby').count()).toBeGreaterThan(0)
    // 遠くの話は、記号と読みを除いた文字だけ（ルビの要素はまだない）
    const far = pieces.nth(50)
    expect(await far.locator('ruby, em').count()).toBe(0)
    const farText = await far.getByTestId('read-text').evaluate((el) => el.textContent ?? '')
    expect(farText).toContain('彼女は振り返らずに、静かに扉を閉めた。待ってと言う声がした。')
    expect(farText).not.toMatch(/[｜《》]/)

    // 目次から移動すると、その話はルビ・傍点で表示され、話の頭が読み始めの位置に来る
    if (!(await page.getByTestId('toc-link').first().isVisible())) await page.getByTestId('toc-toggle').click()
    await page.getByTestId('toc-link').nth(50).click()
    await expect(far.locator('h3')).toBeFocused()
    await expect.poll(() => far.locator('ruby rt').count()).toBe(120)
    await expect(far.locator('em.rb-bouten')).toHaveCount(60)
    const offset = () => far.evaluate((el) => el.getBoundingClientRect().top - parseFloat(getComputedStyle(el).scrollMarginTop))
    await expect.poll(async () => Math.abs(await offset())).toBeLessThanOrEqual(2)

    // 縦書き（本文の枠の中を横にスクロールする）でも、移動した先の話は表示する
    const other = pieces.nth(30)
    expect(await other.locator('ruby').count()).toBe(0)
    await page.getByTestId('vertical-toggle').click()
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'vertical-rl')
    if (!(await page.getByTestId('toc-link').first().isVisible())) await page.getByTestId('toc-toggle').click()
    await page.getByTestId('toc-link').nth(30).click()
    await expect(other.locator('h3')).toBeFocused()
    await expect.poll(() => other.locator('ruby rt').count()).toBe(120)
    await page.getByTestId('vertical-toggle').click()

    // 印刷する前には、すべての話をルビ・傍点で表示する
    expect(await pieces.nth(20).locator('ruby').count()).toBe(0)
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
    await expect(pieces.nth(20).locator('ruby')).toHaveCount(120)
    expect(await page.getByTestId('read-body').locator('[data-testid="read-text"] ruby').count()).toBe(60 * 120)
  })
})

test.describe('各話の進捗', () => {
  test('本編の一覧と章ページの各話に、その話の終わりがタイトル全体（採用原稿）の何 % の位置かを出す', async ({ page }) => {
    await openApp(page)
    const { titleId, chapterId } = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('進捗の物語')
      // 100・200（ルビの読みは数えない）・採用なし・700字
      const bodies = ['あ'.repeat(100), `｜長い《ながいながい》${'い'.repeat(198)}`, '', 'う'.repeat(700)]
      const ids = bodies.map((body) => {
        const p = actions.addEpisode(id)
        actions.updateVersion(getData().pieces[p].versionIds[0], { body })
        return p
      })
      actions.setActiveVersion(ids[2], null)
      actions.setChaptersEnabled(id, true)
      const ch2 = actions.addChapter(id, '第二部')
      actions.movePiece(ids[3], { chapterId: ch2, index: 0 })
      actions.movePiece(ids[2], { chapterId: ch2, index: 0 })
      return { titleId: id, chapterId: ch2 }
    })
    await openApp(page, `/t/${titleId}`)
    const progress = page.getByTestId('piece-progress')
    await expect(progress).toHaveText(['10%', '30%', '30%', '100%'])
    // ％の意味（達成率ではなく位置）は、マウスを乗せられないスマホでも読めるように一覧の上に出す
    const legend = page.getByTestId('progress-legend')
    await expect(legend).toBeVisible()
    await expect(legend).toContainText('タイトル全体（採用原稿）のどこにあるか')
    const second = progress.nth(1)
    await expect(second).toHaveAttribute('aria-label', 'この話の終わりは、タイトル全体（採用原稿）の 30% の位置です')
    await expect(second).toHaveAttribute('title', 'この話の終わりは、タイトル全体（採用原稿）の 30% の位置です')
    await expect(second).toHaveAttribute('role', 'img')
    // 採用原稿のない話も位置を出す（0字として数える）。書き上がった話に見えないよう棒は淡い色
    await expect(progress.nth(2)).toHaveAttribute('aria-label', /0字として数えています/)
    const fillColor = (i: number) =>
      progress
        .nth(i)
        .locator('.story-row-progress-fill')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await fillColor(2)).not.toBe(await fillColor(1))
    expect(await fillColor(2)).toBe(
      await page.evaluate(() => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-faint)'
        document.body.append(probe)
        const c = getComputedStyle(probe).color
        probe.remove()
        return c
      }),
    )
    // 細い棒は位置の分だけ伸びる
    const fill = await second
      .locator('.story-row-progress-fill')
      .evaluate((el) => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width)
    expect(fill).toBeCloseTo(0.3, 1)
    await page.screenshot({ path: `e2e/artifacts/screens/progress-${test.info().project.name}-title.png`, fullPage: true })

    // 章ページでも、タイトル全体の中での位置
    await openApp(page, `/t/${titleId}/c/${chapterId}`)
    await expect(page.getByTestId('chapter-page').getByTestId('piece-progress')).toHaveText(['30%', '100%'])
    // 章の中での割合ではなく、タイトル全体での位置
    const chapterLegend = page.getByTestId('chapter-page').getByTestId('progress-legend')
    await expect(chapterLegend).toBeVisible()
    await expect(chapterLegend).toContainText('全体')
    await expect(chapterLegend).toContainText('章の中での割合ではありません')
  })

  test('幅 360px でも進捗は行からはみ出さない', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await openApp(page)
    const titleId = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('とても長いタイトル名のテスト用作品')
      for (let i = 0; i < 3; i++) {
        const p = actions.addEpisode(id)
        actions.updatePiece(p, { subtitle: 'とても長い話の題がついていても一覧からはみ出さないことを確かめる' })
        actions.updateVersion(getData().pieces[p].versionIds[0], { body: `｜第${i + 1}話《だいいちわ》の本文。`.repeat(40) })
      }
      return id
    })
    await openApp(page, `/t/${titleId}`)
    await expect(page.getByTestId('piece-progress')).toHaveText(['33%', '67%', '100%'])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const el of await page.getByTestId('piece-progress').all()) {
      const box = (await el.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(360)
    }
    await page.screenshot({ path: `e2e/artifacts/screens/progress-360.png`, fullPage: true })
  })
})
