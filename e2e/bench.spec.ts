// 相対比較（2.5。内部名は bench）の E2E テスト: ホームの棚（追加・並べ替え・削除して戻す）、作品の画面（分析を追加・開閉・
// 全文・直す）、手動の依頼文のコピーと結果の貼り付け（2回目は増えない）、作品批評タブの「相対比較する作品」と手動の依頼の分析、
// 自分の原稿の分析（原稿ごとにまとめたカード・同じ原稿の分析）、作品のタグ（ジャンル。2.7。作品の画面の「ジャンル」・
// 「14 検索用タグ」からの自動のタグ・棚のタグの絞り込みとタグの管理）、360px の画面、ディープダーク。
import { expect, test, type Page } from '@playwright/test'
import { darkSurfaces, homeBandToggle, noHorizontalScroll, openApp, openHomeBands, seed, tapSize } from './helpers'

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
    // 作品のタグ（ジャンル。2.7）
    actions.setBenchWorkTags(workId, ['SF', '宇宙', 'スペースオペラ'])
    return { titleId, workId }
  })
}

/** V29 の 02 が登録する「14 検索用タグ」を、作品の画面の「結果を貼り付け」で貼る答え */
const genreAnswer = (sub: string, runDate: string) =>
  [
    '登録しました。',
    '```novel-studio-v1',
    JSON.stringify({
      tool: 'novel_add_bench_analysis',
      input: {
        work: 'w:dummy',
        items: [
          {
            viewpoint: '14 検索用タグ',
            body_markdown: [
              '**結論**：港町の喫茶店を舞台に、喪失から立ち直る二人を描く恋愛小説',
              '担当：編集長（マーケター案を確定）',
              '',
              '- 判定したジャンル：恋愛',
              '- 適性のある賞（選んだ理由）：架空の恋愛小説新人賞（理由）',
              '※この2行には、役割の前の判定をそのまま写す。「ジャンル／サブジャンル」のジャンルは、判定したジャンルと同じ名前にする。',
              `- ジャンル／サブジャンル：${sub}`,
              '- トーン（例：静謐、疾走、乾いた、湿った、ユーモア）：静謐',
            ].join('\n'),
            run_date: runDate,
          },
        ],
      },
    }),
    '```',
  ].join('\n')

/** 作品の画面の「ジャンル」のタグ */
const workTags = (page: Page) => page.getByTestId('bench-work-tag').allTextContents()

/** 作品の画面で「結果を貼り付け」から貼る */
async function pasteAnswer(page: Page, answer: string) {
  await page.getByTestId('bench-paste').click()
  await page.getByTestId('paste-input').fill(answer)
  await page.getByTestId('paste-add').click()
  await expect(page.getByRole('status').filter({ hasText: '1件を追加しました' }).last()).toBeVisible()
}

const cardNames = (page: Page) => page.getByTestId('bench-card').getByTestId('bench-card-name').allTextContents()

/** 自分の原稿を3回分析した作品（Claude が作った時と同じく、1回の分析を1つの作品に。作った時刻を決める）と、ほかの作品 */
async function seedManuscript(page: Page) {
  return seed(page, ({ actions }) => {
    const other = actions.addBenchWork({ name: '銀河の果て', author: '山田' })
    const run = (id: string, name: string, order: number, createdAt: number, analyses: number) => {
      actions.addClaudeRecords([
        {
          table: 'benchWorks',
          record: { id, name, author: '自分', pdfPlace: '', note: '', order, createdAt, updatedAt: createdAt, source: 'claude' },
        },
      ])
      for (let i = 0; i < analyses; i++)
        actions.addBenchAnalysis(id, { viewpoint: `観点${i + 1}`, body: `## 観点${i + 1}\n本文。`, runDate: '2026-11-02' })
      return id
    }
    const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).getTime()
    const r1 = run('e2e-run-1', '【原稿】星の庭（第1稿）', 10, at(1, 9, 0), 2)
    const r3 = run('e2e-run-3', '【原稿】星の庭（第2稿・2回目）', 11, at(2, 14, 5), 1)
    const r2 = run('e2e-run-2', '【原稿】星の庭（第2稿）', 12, at(2, 8, 30), 3)
    return { other, r1, r2, r3 }
  })
}

test.describe('相対比較', () => {
  test('ホームの「相対比較」: 作品を追加・並べ替え・削除するとゴミ箱へ。戻すと相対比較と相対比較する作品に戻る', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    const { titleId, workId } = await seedShelf(page)
    await openApp(page)
    await openHomeBands(page)
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
      await expect(homeBandToggle(page, 'bench')).toBeFocused()
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
    await openHomeBands(page)
    await expect.poll(() => cardNames(page)).toEqual(['銀河の果て', '海の記憶'])
    await expect(page.getByTestId('bench-card').first().getByTestId('bench-card-count')).toHaveText('分析 2件')
    expect(await page.evaluate((t) => window.__ns.getData().titles[t].benchWorkIds, titleId)).toEqual([workId])
    await noHorizontalScroll(page)
  })

  test('作品の画面: 観点ごとの分析を開閉し、長い分析は「全文を表示」。分析を追加・直す・削除する', async ({ page }) => {
    await openApp(page)
    await openHomeBands(page)
    const { workId } = await seedShelf(page)
    await openApp(page, `/bench/${workId}`)
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('ホーム')
    await expect(page.getByTestId('bench-work-pdf-place')).toHaveText('プロジェクト「相対比較」')
    await expect(page.getByTestId('bench-work-edit')).toHaveText('作品の情報を直す')
    const groups = page.getByTestId('bench-group')
    await expect(groups).toHaveCount(2)
    const structure = page.locator('[data-testid="bench-group"][data-viewpoint="構成"]').getByTestId('bench-analysis')
    await expect(structure.getByTestId('bench-analysis-body')).toHaveCount(0)
    // 字数はアプリの数え方（空白・改行を除く。空白・改行込みでは 6,218字・14字）。カードの頭に出す
    await expect(page.getByTestId('bench-analyses-total')).toHaveText('合計 6,166字')
    await expect(structure.getByTestId('bench-analysis-chars')).toHaveText('6,154字')
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
    await expect(opening.getByTestId('bench-analysis-chars')).toHaveText('13字')
    await expect(page.getByTestId('bench-analyses-total')).toHaveText('合計 6,179字')
    await expect(groups).toHaveCount(3)
    // 直す
    await opening.getByTestId('bench-analysis-edit').click()
    await page.getByTestId('bench-analysis-input').fill('## 冒頭\n会話から始まる。')
    await page.getByTestId('bench-analysis-save').click()
    await expect(opening.getByTestId('bench-analysis-body')).toContainText('会話から始まる。')
    await expect(opening.getByTestId('bench-analysis-chars')).toHaveText('12字')
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
    await openHomeBands(page)
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
    await openHomeBands(page)
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

  test('自分の原稿の分析: 原稿ごとに1枚にまとめ、開くと新しい回から。回の画面の「同じ原稿の分析」でほかの回へ', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    const { r1, r2, r3 } = await seedManuscript(page)
    await openApp(page)
    await openHomeBands(page)
    const shelf = page.getByTestId('bench-shelf')
    await expect(shelf.getByTestId('bench-count')).toHaveText('4')
    await expect(shelf.getByTestId('bench-list').locator(':scope > li')).toHaveCount(2)
    await expect(shelf.getByTestId('bench-card').getByTestId('bench-card-name')).toHaveText(['銀河の果て'])
    const card = shelf.getByTestId('bench-manuscript')
    await expect(card.getByTestId('bench-manuscript-name')).toHaveText('【原稿】星の庭')
    await expect(card.getByTestId('bench-manuscript-runs')).toHaveText('3回の分析')
    await expect(card.getByTestId('bench-manuscript-latest')).toHaveText('最新 2026/11/02 14:05')
    await expect(card.getByTestId('bench-run')).toHaveCount(0)

    // 開くと新しい回から（回の札・作った日時・分析の数）
    await card.getByTestId('bench-manuscript-toggle').click()
    await expect(card.getByTestId('bench-manuscript-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByTestId('bench-run-label')).toHaveText(['第2稿・2回目', '第2稿', '第1稿'])
    await expect(card.getByTestId('bench-run-date')).toHaveText(['2026/11/02 14:05', '2026/11/02 08:30', '2026/11/01 09:00'])
    await expect(card.getByTestId('bench-run-count')).toHaveText(['分析 1件', '分析 3件', '分析 2件'])
    await tapSize(card.getByTestId('bench-run-link').first(), 'bench-run-link', false)
    await noHorizontalScroll(page)

    // 回の画面: 「同じ原稿の分析」（いまの回に印、ほかの回へ）
    await card.getByTestId('bench-run-link').nth(1).click()
    await expect(page).toHaveURL(new RegExp(`#/bench/${r2}$`))
    await expect(page.getByTestId('bench-work-title')).toHaveText('【原稿】星の庭（第2稿）')
    const runs = page.getByTestId('bench-work-runs')
    await expect(runs.getByRole('heading', { name: '同じ原稿の分析' })).toBeVisible()
    await expect(runs.getByTestId('bench-work-run-label')).toHaveText(['第2稿・2回目', '第2稿', '第1稿'])
    await expect(runs.locator('[data-current="true"]')).toHaveAttribute('data-work-id', r2)
    await expect(runs.locator('[data-current="true"]')).toContainText('表示中')
    await expect(runs.getByTestId('bench-work-run-link')).toHaveCount(2)
    await expect(page.getByTestId('bench-analysis')).toHaveCount(3)
    await noHorizontalScroll(page)
    await runs.getByTestId('bench-work-run-link').last().click()
    await expect(page).toHaveURL(new RegExp(`#/bench/${r1}$`))
    await expect(page.getByTestId('bench-work-title')).toHaveText('【原稿】星の庭（第1稿）')
    await expect(page.getByTestId('bench-work-runs').locator('[data-current="true"]')).toHaveAttribute('data-work-id', r1)
    await expect(page.getByTestId('bench-analysis')).toHaveCount(2)

    // 棚へ戻ると、開いたまま
    await page.getByRole('navigation', { name: '現在地' }).getByRole('link', { name: '相対比較', exact: true }).click()
    await expect(card.getByTestId('bench-run')).toHaveCount(3)
    // 並べ替え・編集の間は1つずつ（回ごとに動かす・削除できる）
    await page.getByTestId('bench-edit-toggle').click()
    await expect(shelf.getByTestId('bench-manuscript')).toHaveCount(0)
    await expect
      .poll(() => cardNames(page))
      .toEqual(['銀河の果て', '【原稿】星の庭（第1稿）', '【原稿】星の庭（第2稿・2回目）', '【原稿】星の庭（第2稿）'])
    await shelf.locator(`[data-work-id="${r3}"]`).getByTestId('bench-delete').click()
    await dialog(page).getByRole('button', { name: '削除' }).click()
    await expect.poll(() => cardNames(page)).toEqual(['銀河の果て', '【原稿】星の庭（第1稿）', '【原稿】星の庭（第2稿）'])
    await page.getByTestId('bench-edit-toggle').click()
    await expect(card.getByTestId('bench-manuscript-runs')).toHaveText('2回の分析')
    await expect(card.getByTestId('bench-manuscript-latest')).toHaveText('最新 2026/11/02 08:30')
    await expect(card.getByTestId('bench-run-label')).toHaveText(['第2稿', '第1稿'])
  })

  test('作品のタグ: 「ジャンル」で付ける・外す。「14 検索用タグ」を貼ると数秒で付き、外したタグは読み込み直しても戻らず、新しい 14 で足される', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    const ids = await seed(page, ({ actions }) => ({
      work: actions.addBenchWork({ name: '港の喫茶店', author: '山田' }),
      control: actions.addBenchWork({ name: '【対照】港の喫茶店', author: '山田' }),
    }))
    await openApp(page, `/bench/${ids.work}`)
    await expect(page.getByTestId('bench-work-no-tags')).toHaveText('タグなし')
    await page.getByTestId('bench-edit-tags').click()
    await page.getByTestId('bench-tag-input').fill('港町、')
    await page.getByTestId('bench-tags-save').click()
    await expect.poll(() => workTags(page)).toEqual(['港町'])
    // 「結果を貼り付け」で 14 を貼ると、少し待ってから判定したジャンル・サブジャンルが付く
    await pasteAnswer(page, genreAnswer('恋愛／青春・喪失', '2026-11-01'))
    await expect.poll(() => workTags(page), { timeout: 10_000 }).toEqual(['港町', '恋愛', '青春', '喪失'])
    // 1つ外す。読み込み直しても戻らない
    await page.getByTestId('bench-edit-tags').click()
    await dialog(page).getByRole('button', { name: 'タグ「青春」を外す' }).click()
    await page.getByTestId('bench-tags-save').click()
    await expect.poll(() => workTags(page)).toEqual(['港町', '恋愛', '喪失'])
    await openApp(page, `/bench/${ids.work}`)
    await page.waitForTimeout(2500)
    expect(await workTags(page)).toEqual(['港町', '恋愛', '喪失'])
    // もっと新しい日付の 14 を貼ると、そのジャンルが足される（外したタグは戻らない）
    await pasteAnswer(page, genreAnswer('恋愛／大人・手紙', '2026-11-05'))
    await expect.poll(() => workTags(page), { timeout: 10_000 }).toEqual(['港町', '恋愛', '喪失', '大人', '手紙'])
    // 【対照】の作品には貼っても付かない（タグを付けるボタンも無い）
    await openApp(page, `/bench/${ids.control}`)
    await expect(page.getByTestId('bench-work-tagless')).toContainText('【対照】【監査】【横断】の作品にはタグを付けません')
    await expect(page.getByTestId('bench-edit-tags')).toHaveCount(0)
    await pasteAnswer(page, genreAnswer('恋愛／青春', '2026-11-01'))
    await page.waitForTimeout(2500)
    await expect(page.getByTestId('bench-work-no-tags')).toBeVisible()
  })

  test('ホームの棚: タグのチップで絞る（2つ選ぶとすべて持つ作品）。タグを管理で名前を変える・削除する', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      const a = actions.addBenchWork({ name: '作品A' })
      const b = actions.addBenchWork({ name: '作品B' })
      const c = actions.addBenchWork({ name: '作品C' })
      actions.setBenchWorkTags(a, ['恋愛', '青春'])
      actions.setBenchWorkTags(b, ['恋愛', '家族'])
      actions.setBenchWorkTags(c, ['ミステリー'])
      actions.addMaterial({ name: '資料', tags: ['軍事'] })
    })
    // ?view=bench（作品の画面のパンくず）は、閉じていた相対比較の帯（2.9）を開いて、見出しのボタンにフォーカスする
    await openApp(page, '/?view=bench')
    await expect(homeBandToggle(page, 'bench')).toHaveAttribute('aria-expanded', 'true')
    await expect(homeBandToggle(page, 'bench')).toBeFocused()
    await expect(homeBandToggle(page, 'titles')).toHaveAttribute('aria-expanded', 'false')
    await expect(homeBandToggle(page, 'materials')).toHaveAttribute('aria-expanded', 'false')
    const chip = (tag: string) => page.locator(`[data-testid="bench-tag-chip"][data-tag="${tag}"]`)
    await expect(page.getByTestId('bench-tag-chip')).toHaveCount(4)
    await expect(page.locator('[data-testid="bench-tag-chip"][data-tag="軍事"]')).toHaveCount(0)
    await chip('恋愛').click()
    await expect(page.getByTestId('bench-filter-count')).toHaveText('2作品／全3作品')
    await chip('青春').click()
    await expect(page.getByTestId('bench-filter-count')).toHaveText('1作品／全3作品')
    expect(await cardNames(page)).toEqual(['作品A'])
    // 作品の画面から戻っても絞り込みは残る
    await page.getByTestId('bench-card-link').first().click()
    await expect(page.getByTestId('bench-page')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('bench-filter-count')).toHaveText('1作品／全3作品')
    await page.getByTestId('bench-filter-clear').click()
    await expect(page.getByTestId('bench-card')).toHaveCount(3)
    // タグを管理: 名前を変える・削除
    await page.getByTestId('bench-manage-tags-open').click()
    const manage = page.getByTestId('bench-manage-tags')
    await manage.locator('[data-testid="bench-manage-tag"][data-tag="家族"]').getByTestId('bench-manage-rename').click()
    const prompt = page.getByRole('dialog', { name: 'タグ「家族」の名前を変える' })
    await prompt.getByRole('textbox').fill('家族もの')
    await prompt.getByRole('button', { name: '名前を変える' }).click()
    await expect(manage.locator('[data-testid="bench-manage-tag"][data-tag="家族もの"]')).toHaveCount(1)
    await manage.locator('[data-testid="bench-manage-tag"][data-tag="ミステリー"]').getByTestId('bench-manage-delete').click()
    const confirm = page.getByRole('dialog', { name: 'タグ「ミステリー」を削除しますか？' })
    await expect(confirm).toContainText('1作品からタグ「ミステリー」を外します。作品とその分析は消えません')
    await confirm.getByRole('button', { name: '削除' }).click()
    await expect(manage.locator('[data-testid="bench-manage-tag"][data-tag="ミステリー"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(chip('家族もの')).toHaveCount(1)
    await expect(chip('ミステリー')).toHaveCount(0)
    expect(await cardNames(page)).toEqual(['作品A', '作品B', '作品C'])
  })

  test('幅 360px でも横にはみ出さず、ボタンは押しやすい大きさ', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの幅で確かめる')
    await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    await openHomeBands(page)
    const { titleId, workId } = await seedShelf(page)
    await openApp(page)
    await openHomeBands(page)
    await expect(page.getByTestId('home-jump-bench')).toBeVisible()
    await noHorizontalScroll(page)
    // タグのチップは横にはみ出さない（1行にして横にスクロール）
    await expect(page.getByTestId('bench-tag-chip')).toHaveCount(3)
    await tapSize(page.getByTestId('bench-tag-chip').first(), 'bench-tag-chip', false)
    await page.getByTestId('bench-edit-toggle').click()
    await tapSize(page.getByTestId('bench-up').first(), 'bench-up')
    await tapSize(page.getByTestId('bench-delete').first(), 'bench-delete', false)
    await noHorizontalScroll(page)
    await page.getByTestId('new-bench-work').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await openApp(page, `/bench/${workId}`)
    await noHorizontalScroll(page)
    for (const id of ['bench-work-edit', 'bench-edit-tags', 'bench-add-analysis', 'bench-manual', 'bench-paste'])
      await tapSize(page.getByTestId(id), id, false)
    await page.getByTestId('bench-edit-tags').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
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
    await openHomeBands(page)
    await darkSurfaces(page, ['.home-bench-card', '.bw-chip', '.badge', '.btn', '.home-mat-tag', '.home-mat-cardtag'])
    await page.getByTestId('bench-shelf').screenshot({ path: `${dir}/bench-${project}-deep-dark-shelf.png` })
    await openApp(page, `/bench/${workId}`)
    await page.getByTestId('bench-toggle-all').click()
    await darkSurfaces(page, ['.bw-head', '.bw-note', '.sx-card', '.bw-chip', '.badge', '.btn', '.md code', '.mt-tag-chip'])
    await page.screenshot({ path: `${dir}/bench-${project}-deep-dark-work.png`, fullPage: true })
    await page.getByTestId('bench-manual').click()
    await darkSurfaces(page, ['.modal', '.bw-suggest-chip', '.input', '.btn'])
    await page.keyboard.press('Escape')
    await openApp(page, `/t/${titleId}?tab=critique`)
    await darkSurfaces(page, ['.bw-compare', '.bw-compare-chip', '.select'])
    await page.getByTestId('critique-bench').screenshot({ path: `${dir}/bench-${project}-deep-dark-critique.png` })
  })
})
