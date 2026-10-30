// 相対比較（2.5。内部名は bench）の E2E テスト: ホームの棚（追加・並べ替え・削除して戻す）、作品の画面（分析を追加・開閉・
// 全文・直す）、手動の依頼文のコピーと結果の貼り付け（2回目は増えない）、作品批評タブの「相対比較する作品」と手動の依頼の分析、
// 360px の画面、ディープダーク。
import { expect, test, type Page } from '@playwright/test'
import { darkSurfaces, noHorizontalScroll, openApp, seed, tapSize } from './helpers'

const dialog = (page: Page) => page.getByRole('dialog')

/** 作品と分析（観点: 構成・文体）と、相対比較する作品にしたタイトル */
async function seedShelf(page: Page) {
  return seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('星の庭')
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body: '冒頭の本文。' })
    const workId = actions.addBenchWork({
      name: '銀河の果て',
      author: '山田',
      year: '2019',
      pdfPlace: 'プロジェクト「相対比較」',
    })
    const long = Array.from({ length: 30 }, (_, i) => `段落${i + 1}。${'あ'.repeat(200)}`).join('\n\n')
    actions.addBenchAnalysis(workId, {
      viewpoint: '構成',
      body: `## 構成\n三幕。\n\n${long}\n\n最後の一文。`,
      runDate: '2026-10-01',
    })
    actions.addBenchAnalysis(workId, { viewpoint: '文体', body: '## 文体\n短い文を重ねる。', runDate: '2026-10-02' })
    actions.addTitleBenchWork(titleId, workId)
    return { titleId, workId }
  })
}

const cardNames = (page: Page) => page.getByTestId('bench-card').getByTestId('bench-card-name').allTextContents()

test.describe('相対比較', () => {
  test('ホームの「相対比較」: 作品を追加・並べ替え・削除するとゴミ箱へ。戻すと相対比較と相対比較する作品に戻る', async ({
    page,
  }) => {
    await openApp(page)
    const { titleId, workId } = await seedShelf(page)
    await openApp(page)
    const shelf = page.getByTestId('bench-shelf')
    await expect(shelf.getByRole('heading', { name: '相対比較', level: 2 })).toBeVisible()
    await expect(shelf.getByTestId('new-bench-work')).toHaveText('作品を追加')
    const card = shelf.getByTestId('bench-card')
    await expect(card.getByTestId('bench-card-author')).toHaveText('山田・2019')
    await expect(card.getByTestId('bench-card-count')).toHaveText('分析 2件')
    // 観点のチップ（同じ時刻に作った分析なので、順は問わない）
    await expect
      .poll(async () => (await card.getByTestId('bench-card-viewpoint').allTextContents()).sort())
      .toEqual(['文体', '構成'].sort())
    await expect(card.getByTestId('bench-card-comparing')).toHaveText('比べるタイトル: 『星の庭』')
    // スマホでは上の切り替えにもある
    if (await page.getByTestId('home-jump').isVisible()) {
      await expect(page.getByTestId('home-jump-bench')).toHaveText('相対比較1')
      await page.getByTestId('home-jump-bench').click()
      await expect(shelf.getByRole('heading', { name: '相対比較', level: 2 })).toBeFocused()
      await expect(page.getByTestId('home-jump-bench')).toHaveAttribute('aria-current', 'true')
    }

    // 作品を追加（作品名は必須）。追加すると作品の画面が開く
    await page.getByTestId('new-bench-work').click()
    await expect(dialog(page).getByRole('heading', { name: '作品を追加' })).toBeVisible()
    await expect(page.getByTestId('bench-work-save')).toHaveText('追加')
    await page.getByTestId('bench-work-save').click()
    await expect(dialog(page).getByRole('alert')).toHaveText('作品名を入れてください')
    await page.getByTestId('bench-work-name').fill('海の記憶')
    await page.getByTestId('bench-work-author').fill('佐藤')
    await page.getByTestId('bench-work-pdf').fill('プロジェクト「海」')
    await page.getByTestId('bench-work-save').click()
    await expect(page.getByRole('status').filter({ hasText: '「海の記憶」を相対比較に追加しました' })).toBeVisible()
    await expect(page).toHaveURL(/#\/bench\//)
    await expect(page.getByTestId('bench-work-title')).toHaveText('海の記憶')
    await expect(page).toHaveTitle('相対比較: 海の記憶 — Novel Studio')
    await expect(page.getByTestId('bench-analyses-empty')).toBeVisible()
    // パンくず「ホーム › 相対比較 › 作品名」の「相対比較」で棚へ戻る
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('ホーム')
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('相対比較')
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('海の記憶')
    await page.getByRole('navigation', { name: '現在地' }).getByRole('link', { name: '相対比較', exact: true }).click()
    await expect(shelf.getByRole('heading', { name: '相対比較', level: 2 })).toBeInViewport()
    await expect.poll(() => cardNames(page)).toEqual(['銀河の果て', '海の記憶'])

    // 並べ替え（↑↓・位置を選んで移動）
    await page.getByTestId('bench-edit-toggle').click()
    await shelf.getByTestId('bench-card').nth(1).getByTestId('bench-up').click()
    await expect.poll(() => cardNames(page)).toEqual(['海の記憶', '銀河の果て'])
    await shelf.getByTestId('bench-card').nth(0).getByTestId('bench-move').click()
    await page.getByTestId('bench-move-target').selectOption({ index: 1 })
    await page.getByTestId('bench-move-submit').click()
    await expect.poll(() => cardNames(page)).toEqual(['銀河の果て', '海の記憶'])

    // 削除（分析ごと。相対比較する作品にしているタイトルは書き換えず、ゴミ箱にある間は出ない）→ ゴミ箱 → 戻す
    await shelf.getByTestId('bench-card').nth(0).getByTestId('bench-delete').click()
    await expect(dialog(page)).toContainText('「銀河の果て」を削除しますか？')
    await expect(dialog(page)).toContainText('この作品を相対比較から削除し、分析（2件）もいっしょにゴミ箱に移します。')
    await expect(dialog(page)).toContainText(
      '相対比較する作品にしているタイトル（1件）では、ゴミ箱にある間は相対比較する作品に出ません',
    )
    await dialog(page).getByRole('button', { name: '削除' }).click()
    await expect.poll(() => cardNames(page)).toEqual(['海の記憶'])
    // タイトルは書き換えない（id は残り、作品が無い間は表示から外れる）
    expect(await page.evaluate((t) => window.__ns.getData().titles[t].benchWorkIds, titleId)).toEqual([workId])
    await openApp(page, '/trash')
    const row = page.getByTestId('trash-row').first()
    await expect(row.getByTestId('trash-kind')).toHaveText('相対比較の作品')
    await expect(row.getByTestId('trash-label')).toHaveText('銀河の果て')
    await expect(row.getByTestId('trash-place')).toHaveText('相対比較')
    await row.getByTestId('trash-restore').click()
    await expect(page.getByRole('status').filter({ hasText: '「銀河の果て」を元の場所に戻しました' })).toBeVisible()
    await openApp(page)
    await expect.poll(() => cardNames(page)).toEqual(['銀河の果て', '海の記憶'])
    await expect(page.getByTestId('bench-card').first().getByTestId('bench-card-count')).toHaveText('分析 2件')
    expect(await page.evaluate((t) => window.__ns.getData().titles[t].benchWorkIds, titleId)).toEqual([workId])
    await noHorizontalScroll(page)
  })

  test('作品の画面: 観点ごとの分析を開閉し、長い分析は「全文を表示」。分析を追加・直す・削除する', async ({ page }) => {
    await openApp(page)
    const { workId } = await seedShelf(page)
    await openApp(page, `/bench/${workId}`)
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('ホーム')
    await expect(page.getByTestId('bench-work-pdf-place')).toHaveText('プロジェクト「相対比較」')
    await expect(page.getByTestId('bench-work-edit')).toHaveText('作品の情報を直す')
    const groups = page.getByTestId('bench-group')
    await expect(groups).toHaveCount(2)
    const structure = page.locator('[data-testid="bench-group"][data-viewpoint="構成"]').getByTestId('bench-analysis')
    await expect(structure.getByTestId('bench-analysis-body')).toHaveCount(0)
    await structure.getByTestId('bench-analysis-toggle').click()
    await expect(structure.getByTestId('bench-analysis-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(structure.getByTestId('bench-analysis-body').locator('h2')).toHaveText('構成')
    await expect(structure.getByTestId('bench-analysis-body')).not.toContainText('最後の一文')
    await structure.getByTestId('bench-analysis-more').click()
    await expect(structure.getByTestId('bench-analysis-body')).toContainText('最後の一文')
    await structure.getByTestId('bench-analysis-toggle').click()
    await expect(structure.getByTestId('bench-analysis-body')).toHaveCount(0)

    // 足す（観点の候補から選ぶ）
    await page.getByTestId('bench-add-analysis').click()
    await dialog(page).getByRole('button', { name: '冒頭の掴み' }).click()
    await expect(page.getByTestId('bench-analysis-viewpoint')).toHaveValue('冒頭の掴み')
    await page.getByTestId('bench-analysis-date').fill('2026-10-30')
    await page.getByTestId('bench-analysis-input').fill('## 冒頭\n一文目で謎を置く。')
    await page.getByTestId('bench-analysis-save').click()
    const opening = page.locator('[data-testid="bench-group"][data-viewpoint="冒頭の掴み"]').getByTestId('bench-analysis')
    await expect(opening.getByTestId('bench-analysis-body')).toContainText('一文目で謎を置く。')
    await expect(opening.getByTestId('bench-analysis-date-label')).toHaveText('2026/10/30')
    await expect(groups).toHaveCount(3)
    // 直す
    await opening.getByTestId('bench-analysis-edit').click()
    await page.getByTestId('bench-analysis-input').fill('## 冒頭\n会話から始まる。')
    await page.getByTestId('bench-analysis-save').click()
    await expect(opening.getByTestId('bench-analysis-body')).toContainText('会話から始まる。')
    // 削除（ゴミ箱では「相対比較の分析」、場所は「相対比較 › 作品名」）
    await opening.getByTestId('bench-analysis-delete').click()
    await dialog(page).getByRole('button', { name: '削除' }).click()
    await expect(groups).toHaveCount(2)
    // 作品の情報を直す
    await page.getByTestId('bench-work-edit').click()
    await page.getByTestId('bench-work-genre').fill('SF')
    await page.getByTestId('bench-work-save').click()
    await expect(page.getByTestId('bench-work-biblio')).toHaveText('山田・2019・SF')
    await noHorizontalScroll(page)
    await openApp(page, '/trash')
    const row = page.getByTestId('trash-row').first()
    await expect(row.getByTestId('trash-kind')).toHaveText('相対比較の分析')
    await expect(row.getByTestId('trash-place')).toHaveText('相対比較 › 銀河の果て')
  })

  test('Claude に頼む（手動）: 観点を選んで依頼文をコピーし、結果を貼り付けると分析になる（2回目は増えない）', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'クリップボードの読み取りは Chromium だけ')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openApp(page)
    const { workId } = await seedShelf(page)
    await openApp(page, `/bench/${workId}`)
    await page.getByTestId('bench-manual').click()
    const manual = page.getByTestId('bench-manual-dialog')
    await manual.getByRole('button', { name: '人物' }).click()
    await expect(manual.getByRole('button', { name: '人物' })).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('bench-manual-new-viewpoint').fill('会話の運び')
    await page.getByTestId('bench-manual-add-viewpoint').click()
    await page.getByTestId('bench-manual-copy').click()
    const prompt = await page.evaluate(() => navigator.clipboard.readText())
    expect(prompt).toContain('このプロジェクトのナレッジにある作品『銀河の果て』（山田）の PDF')
    expect(prompt).toContain('- 構成\n- 文体\n- 冒頭の掴み\n- 会話の運び')
    expect(prompt).toContain('```novel-studio-v1')
    await expect(page.getByTestId('bench-manual-copy')).toHaveClass(/is-copied/)

    await page.getByTestId('bench-manual-open-paste').click()
    const answer = [
      '分析しました。',
      '```novel-studio-v1',
      JSON.stringify({
        tool: 'novel_add_bench_analysis',
        input: {
          work: 'w:dummy',
          items: [
            { viewpoint: '会話の運び', body_markdown: '## 会話の運び\n間の取り方が良い。', run_date: '2026-10-30' },
            { viewpoint: '構成', body_markdown: '## 構成（読み直し）\n伏線の回収が早い。', run_date: '2026-10-30' },
          ],
        },
      }),
      '```',
    ].join('\n')
    await page.getByTestId('paste-input').fill(answer)
    await expect(page.getByTestId('paste-add')).toHaveText('追加（2件）')
    await page.getByTestId('paste-add').click()
    await expect(page.getByRole('status').filter({ hasText: '2件を追加しました' })).toBeVisible()
    await expect(page.locator('[data-testid="bench-group"][data-viewpoint="会話の運び"]')).toHaveCount(1)
    await expect(
      page.locator('[data-testid="bench-group"][data-viewpoint="構成"]').getByTestId('bench-analysis-date-label'),
    ).toHaveText(['2026/10/30', '2026/10/01'])
    // 同じ答えをもう一度: 増えない
    await page.getByTestId('bench-paste').click()
    await page.getByTestId('paste-input').fill(answer)
    await expect(page.getByTestId('paste-summary')).toHaveText('重複 2件')
    await expect(page.getByTestId('paste-add')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('bench-analysis')).toHaveCount(4)
  })

  test('作品批評タブ: 相対比較する作品を選ぶ・外す。手動の依頼に分析を入れ、結果に「比べた作品」が出る', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'クリップボードの読み取りは Chromium だけ')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openApp(page)
    const { titleId, workId } = await seedShelf(page)
    const other = await seed(page, ({ actions }) => actions.addBenchWork({ name: '海の記憶', author: '佐藤' }))
    await openApp(page, `/t/${titleId}?tab=critique`)
    const row = page.getByTestId('critique-bench')
    await expect(row.getByRole('heading', { name: '相対比較する作品' })).toBeVisible()
    await expect(row.getByTestId('critique-bench-chip')).toHaveText(['『銀河の果て』'])
    await row.getByTestId('critique-bench-add').selectOption(other)
    await expect(page.getByRole('status').filter({ hasText: '『海の記憶』を相対比較する作品にしました' })).toBeVisible()
    await expect(row.getByTestId('critique-bench-chip')).toHaveText(['『銀河の果て』', '『海の記憶』'])
    await row.getByTestId('critique-bench-chip').nth(1).getByTestId('critique-bench-remove').click()
    await expect(row.getByTestId('critique-bench-chip')).toHaveText(['『銀河の果て』'])

    // 手動の依頼: 分析を入れる（チェックを外すと入れない）
    await page.getByTestId('critique-manual').click()
    await expect(page.getByTestId('manual-include-bench')).toBeChecked()
    await expect(page.locator('label', { has: page.getByTestId('manual-include-bench') })).toHaveText(
      '相対比較する作品の分析も入れる（『銀河の果て』）',
    )
    await page.getByTestId('manual-copy-part').first().click()
    const withBench = await page.evaluate(() => navigator.clipboard.readText())
    expect(withBench).toContain('=== 相対比較する作品の分析（1作品）===')
    expect(withBench).not.toContain('ベンチ作品')
    expect(withBench).toContain('短い文を重ねる。')
    expect(withBench).toContain('"bench_works":["w:')
    await page.getByTestId('manual-include-bench').uncheck()
    await page.getByTestId('manual-copy-part').first().click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('相対比較する作品の分析')
    await page.getByTestId('manual-close').click()

    // 結果を貼り付け（bench_works つき）→「比べた作品」のチップから作品の画面へ
    await page.getByTestId('critique-paste').click()
    await page.getByTestId('paste-input').fill(
      '```novel-studio-v1\n' +
        JSON.stringify({
          tool: 'novel_add_critique_result',
          input: { title_id: 't:x', result_markdown: '## 『銀河の果て』と比べて\n冒頭が弱い。', bench_works: ['銀河の果て'] },
        }) +
        '\n```',
    )
    await page.getByTestId('paste-add').click()
    const chip = page.getByTestId('critique-result').getByTestId('critique-result-bench-chip')
    await expect(chip).toHaveText(['『銀河の果て』'])
    await expect(page.getByTestId('critique-result').getByTestId('critique-result-bench')).toContainText('比べた作品:')
    await chip.click()
    await expect(page).toHaveURL(new RegExp(`#/bench/${workId}$`))
  })

  test('幅 360px でも横にはみ出さず、ボタンは押しやすい大きさ', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの幅で確かめる')
    await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    const { titleId, workId } = await seedShelf(page)
    await openApp(page)
    await expect(page.getByTestId('home-jump-bench')).toBeVisible()
    await noHorizontalScroll(page)
    await page.getByTestId('bench-edit-toggle').click()
    await tapSize(page.getByTestId('bench-up').first(), 'bench-up')
    await tapSize(page.getByTestId('bench-delete').first(), 'bench-delete', false)
    await noHorizontalScroll(page)
    await page.getByTestId('new-bench-work').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await openApp(page, `/bench/${workId}`)
    await noHorizontalScroll(page)
    for (const id of ['bench-work-edit', 'bench-add-analysis', 'bench-manual', 'bench-paste'])
      await tapSize(page.getByTestId(id), id, false)
    await page.getByTestId('bench-analysis-toggle').first().click()
    for (const id of ['bench-analysis-copy', 'bench-analysis-edit', 'bench-analysis-delete'])
      await tapSize(page.getByTestId(id).first(), id, false)
    await noHorizontalScroll(page)
    await page.getByTestId('bench-manual').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('bench-add-analysis').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await openApp(page, `/t/${titleId}?tab=critique`)
    await tapSize(page.getByTestId('critique-bench-remove'), 'critique-bench-remove')
    await noHorizontalScroll(page)
  })

  test('ディープダーク: 相対比較・作品の画面・相対比較する作品に白い面が出ない（スクリーンショット）', async ({
    page,
  }, testInfo) => {
    await openApp(page, '/settings')
    await page.getByTestId('theme-deep-dark').click()
    const { titleId, workId } = await seedShelf(page)
    const project = testInfo.project.name
    const dir = 'e2e/artifacts/screens'
    await openApp(page)
    await darkSurfaces(page, ['.home-bench-card', '.bw-chip', '.badge', '.btn'])
    await page.getByTestId('bench-shelf').screenshot({ path: `${dir}/bench-${project}-deep-dark-shelf.png` })
    await openApp(page, `/bench/${workId}`)
    await page.getByTestId('bench-toggle-all').click()
    await darkSurfaces(page, ['.bw-head', '.bw-note', '.sx-card', '.bw-chip', '.badge', '.btn', '.md code'])
    await page.screenshot({ path: `${dir}/bench-${project}-deep-dark-work.png`, fullPage: true })
    await page.getByTestId('bench-manual').click()
    await darkSurfaces(page, ['.modal', '.bw-suggest-chip', '.input', '.btn'])
    await page.keyboard.press('Escape')
    await openApp(page, `/t/${titleId}?tab=critique`)
    await darkSurfaces(page, ['.bw-compare', '.bw-compare-chip', '.select'])
    await page.getByTestId('critique-bench').screenshot({ path: `${dir}/bench-${project}-deep-dark-critique.png` })
  })
})
