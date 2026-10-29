// タイトル画面の本編タブ（章・第n話・特殊ブロック・メモ）と章ページの E2E テスト。
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

async function openTitle(page: Page, titleId: string): Promise<void> {
  await openApp(page, `/t/${titleId}`)
  await expect(page.getByTestId('title-name')).toBeVisible()
}

/** 一覧（ツリーなら全体）の話の表記を上から順に */
function labelsIn(scope: Locator): Promise<string[]> {
  return scope.getByTestId('piece-label').allTextContents()
}

function subtitlesIn(scope: Locator): Promise<string[]> {
  return scope.getByTestId('piece-subtitle').allTextContents()
}

function storyList(page: Page): Locator {
  return page.getByTestId('story-list')
}

function rows(page: Page): Locator {
  return storyList(page).getByTestId('piece-row')
}

/** 保留中の保存を書き込んでから再読み込みする（保存は少し遅れて行われるため） */
async function flushAndReload(page: Page): Promise<void> {
  await page.evaluate(() => window.__ns.flushNow())
  await page.reload()
}

function dialog(page: Page): Locator {
  return page.getByRole('dialog')
}

async function confirmIn(page: Page, buttonName: string): Promise<void> {
  await dialog(page).getByRole('button', { name: buttonName, exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
}

/** ＋追加 → 話数追加 → 作成。原稿画面に移るのでタイトル画面に戻る */
async function addEpisodeViaDialog(page: Page, expected: string, subtitle?: string): Promise<void> {
  await page.getByTestId('add-button').click()
  await page.getByTestId('add-kind-episode').click()
  await expect(page.getByTestId('episode-preview')).toContainText(`${expected}が作成されます`)
  if (subtitle) await page.getByTestId('add-subtitle').fill(subtitle)
  await page.getByTestId('add-submit').click()
  await expect(page).toHaveURL(/#\/t\/[^/]+\/p\/[^/?]+/)
  await page.goBack()
  await expect(page.getByTestId('title-name')).toBeVisible()
}

test.describe('タイトル画面・本編', () => {
  test('タイトルに入ると設定項目が表示され、追加は必ず種類を選ぶ。話数追加は第1話から順に作られる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('星の海')
      const cat = Object.values(getData().settingCategories).find((c) => c.titleId === id && c.name === 'キャラクター')!
      actions.addEntry(cat.id, '主人公')
      actions.addEntry(cat.id, 'ライバル')
      return id
    })
    await openTitle(page, titleId)

    // タブと帯は「設定項目」（アプリの設定と区別する）。あらすじは押して書く
    await expect(page.getByTestId('tab-settings')).toHaveText('設定項目')
    await expect(page.getByTestId('settings-strip').getByRole('link', { name: '設定項目を開く' })).toBeVisible()
    await expect(page.getByTestId('synopsis-toggle')).toContainText('未記入（押して書く）')

    // 設定項目の帯
    const chips = page.getByTestId('setting-chip')
    await expect(chips).toHaveCount(2)
    await expect(chips.nth(0)).toContainText('キャラクター')
    await expect(chips.nth(0)).toContainText('2')
    await expect(chips.nth(1)).toContainText('世界観')

    // 空の状態
    await expect(page.getByTestId('story-empty')).toContainText('まだ話がありません')

    // 種類を選ぶまで作成できない
    await page.getByTestId('add-button').click()
    await expect(page.getByTestId('add-dialog')).toBeVisible()
    await expect(page.getByTestId('add-submit')).toBeDisabled()
    await expect(page.getByTestId('add-kind-episode')).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('add-kind-episode').click()
    await expect(page.getByTestId('add-kind-episode')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('add-submit')).toBeEnabled()
    await expect(page.getByTestId('add-submit')).toHaveText('第1話を作成')
    await page.getByTestId('add-subtitle').fill('はじまり')
    await page.getByTestId('add-submit').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/p\/[^/?]+/)
    await page.goBack()

    await addEpisodeViaDialog(page, '第2話')
    await addEpisodeViaDialog(page, '第3話', '旅立ち')

    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '第3話'])
    await expect(rows(page).nth(0)).toContainText('はじまり')
    await expect(rows(page).nth(2)).toContainText('旅立ち')
    await expect(rows(page).nth(0)).toContainText('採用: 第1稿・0字')
    await expect(page.getByTestId('stat-episodes')).toContainText('全3話')

    // 設定項目のチップから設定タブへ
    await chips.nth(1).click()
    await expect(page).toHaveURL(/tab=settings&cat=/)
    await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('tab-story').click()
    await expect(page.getByTestId('tab-story')).toHaveAttribute('aria-selected', 'true')
    await expect(page).not.toHaveURL(/tab=/)
  })

  test('タブの状態は URL に保存される', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, 'タブ', ['本文'])
    await openTitle(page, titleId)
    await page.getByTestId('tab-strategy').click()
    await expect(page).toHaveURL(/tab=strategy/)
    await flushAndReload(page)
    await expect(page.getByTestId('tab-strategy')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('tab-ideas').click()
    await expect(page).toHaveURL(/tab=ideas/)
    await expect(page.getByTestId('tab-ideas')).toHaveAttribute('aria-selected', 'true')
    // キーボードでも切り替えられる
    await page.getByTestId('tab-ideas').press('ArrowLeft')
    await expect(page.getByTestId('tab-critique')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tab-critique')).toBeFocused()
    await page.getByTestId('tab-critique').press('ArrowLeft')
    await expect(page.getByTestId('tab-strategy')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tab-strategy')).toBeFocused()
  })

  test('特殊追加のプロローグは先頭に入り、話数を消費しない', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '特殊', ['一', '二', '三'])
    await openTitle(page, titleId)

    await page.getByTestId('add-button').click()
    await page.getByTestId('add-kind-special').click()
    await expect(page.getByTestId('special-label')).toHaveValue('プロローグ')
    await expect(page.getByTestId('special-position').locator('option:checked')).toContainText('先頭')
    await page.getByTestId('add-submit').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/p\//)
    await page.goBack()

    await expect.poll(() => labelsIn(storyList(page))).toEqual(['プロローグ', '第1話', '第2話', '第3話'])
    await expect(rows(page).nth(0)).toHaveAttribute('data-kind', 'special')
    await expect(rows(page).nth(0).locator('.badge-special')).toHaveText('特殊')

    // エピローグを選ぶと末尾が既定になる
    await page.getByTestId('add-button').click()
    await page.getByTestId('add-kind-special').click()
    await dialog(page).getByRole('button', { name: 'エピローグ' }).click()
    await expect(page.getByTestId('special-label')).toHaveValue('エピローグ')
    await expect(page.getByTestId('special-position').locator('option:checked')).toContainText('末尾')
    await page.getByTestId('add-submit').click()
    await page.goBack()
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['プロローグ', '第1話', '第2話', '第3話', 'エピローグ'])

    // その後の話数追加は最新話（第3話）の直後に入る
    await addEpisodeViaDialog(page, '第4話')
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['プロローグ', '第1話', '第2話', '第3話', '第4話', 'エピローグ'])
    await expect(page.getByTestId('stat-episodes')).toContainText('全4話')
    await expect(page.getByTestId('stat-episodes')).toContainText('特殊 2')
  })

  test('メモはタイトル画面に留まって作られ、本編より下に表示される', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, 'メモ', ['一', '二'])
    await openTitle(page, titleId)
    const url = page.url()

    await page.getByTestId('add-button').click()
    await page.getByTestId('add-kind-memo').click()
    await expect(page.getByTestId('add-submit')).toBeDisabled()
    await page.getByTestId('memo-name').fill('伏線リスト')
    await page.getByTestId('add-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    expect(page.url()).toBe(url)

    const card = page.getByTestId('memo-card')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('伏線リスト')
    const listBox = await storyList(page).boundingBox()
    const memoBox = await page.getByTestId('memo-section').boundingBox()
    expect(listBox && memoBox).toBeTruthy()
    expect(memoBox!.y).toBeGreaterThan(listBox!.y + listBox!.height)

    // メモの中身へ
    await card.getByRole('link').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/m\//)
  })

  test('編集モード: 途中の話は削除できず、最後の話だけ削除できる', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '削除', ['一', '二', '三', '四'])
    await openTitle(page, titleId)

    await expect(rows(page).first().getByTestId('piece-delete')).toHaveCount(0)
    await page.getByTestId('edit-toggle').click()
    await expect(page.getByTestId('edit-help')).toContainText('最後の話だけ')

    const middle = rows(page).nth(1).getByTestId('piece-delete')
    await expect(middle).toBeDisabled()
    await expect(middle).toHaveAttribute('title', /途中の話数は削除できません/)
    // 押すと理由が表示される
    await middle.click({ force: true })
    await expect(page.getByRole('alert').filter({ hasText: '途中の話数は削除できません' })).toBeVisible()

    const last = rows(page).nth(3).getByTestId('piece-delete')
    await expect(last).toBeEnabled()
    await last.click()
    await expect(dialog(page)).toContainText('第4話')
    await confirmIn(page, '削除')
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '第3話'])
    // 新しい最後の話が削除できるようになる
    await expect(rows(page).nth(2).getByTestId('piece-delete')).toBeEnabled()
  })

  test('並べ替えると話数が並び順どおりに振り直され、題は話と一緒に動く', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => {
      const id = actions.createTitle('並べ替え')
      ;['出会い', '別れ', '再会'].forEach((s) => {
        const pid = actions.addEpisode(id)
        actions.updatePiece(pid, { subtitle: s })
      })
      return id
    })
    await openTitle(page, titleId)
    await page.getByTestId('edit-toggle').click()

    await expect(rows(page).nth(0).getByTestId('piece-up')).toBeDisabled()
    await expect(rows(page).nth(2).getByTestId('piece-down')).toBeDisabled()

    await rows(page).nth(2).getByTestId('piece-up').click()
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '第3話'])
    await expect.poll(() => subtitlesIn(storyList(page))).toEqual(['出会い', '再会', '別れ'])

    // 位置を選んで移動
    await rows(page).nth(0).getByTestId('piece-move').click()
    await expect(page.getByTestId('move-dialog')).toBeVisible()
    await expect(page.getByTestId('move-submit')).toBeDisabled()
    const select = page.getByTestId('move-target')
    const lastValue = await select.locator('option').last().getAttribute('value')
    await select.selectOption(lastValue!)
    await expect(page.getByTestId('move-dialog')).toContainText('「第3話」になります')
    await page.getByTestId('move-submit').click()
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '第3話'])
    await expect.poll(() => subtitlesIn(storyList(page))).toEqual(['再会', '別れ', '出会い'])
  })

  test('採用原稿がない話にはバッジが表示される', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '未採用', ['一話の本文です。', '二話の本文'])
    await seed(
      page,
      ({ actions, getData }, a: { titleId: string }) => {
        const second = Object.values(getData().pieces).filter((p) => p.titleId === a.titleId)
        const target = second.find((p) => getData().versions[p.versionIds[0]].body === '二話の本文')!
        actions.setActiveVersion(target.id, null)
      },
      { titleId },
    )
    await openTitle(page, titleId)
    await expect(rows(page).nth(0).getByTestId('piece-adopted')).toContainText('採用: 第1稿・8字')
    await expect(rows(page).nth(0)).toContainText('一話の本文です。')
    await expect(rows(page).nth(1).getByTestId('piece-missing')).toHaveText('採用原稿なし')
    await expect(page.getByTestId('stat-missing')).toContainText('採用原稿なし 1話')
    await expect(page.getByTestId('stat-chars')).toContainText('採用原稿 8字')
  })

  test('章管理: オンにすると第1章ができ、章の追加・章への話数追加・章ごとの話数・章ページ・章の解除ができる', async ({
    page,
  }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '大長編', ['一', '二'])
    await openTitle(page, titleId)

    // オンにする（確認あり）
    await page.getByTestId('chapters-switch').click()
    await expect(dialog(page)).toContainText('「第1章」を作成し')
    await confirmIn(page, '章で管理する')
    await expect(page.getByRole('switch', { name: '章で管理する' })).toBeChecked()
    await expect(page.getByTestId('stat-chapters')).toHaveText('章あり')

    const blocks = page.getByTestId('chapter-block')
    await expect(blocks).toHaveCount(1)
    await expect(blocks.nth(0).getByTestId('chapter-name')).toHaveText('第1章')
    await expect.poll(() => labelsIn(blocks.nth(0))).toEqual(['第1話', '第2話'])

    // 折りたたみ
    await blocks.nth(0).getByTestId('chapter-collapse').click()
    await expect(blocks.nth(0).getByTestId('piece-row').first()).toBeHidden()
    await expect(blocks.nth(0).getByTestId('chapter-collapse')).toHaveAttribute('aria-expanded', 'false')
    await blocks.nth(0).getByTestId('chapter-collapse').click()
    await expect(blocks.nth(0).getByTestId('piece-row').first()).toBeVisible()

    // 章を追加して、その章に話数追加
    await page.getByTestId('add-chapter').click()
    await expect(blocks).toHaveCount(2)
    await expect(blocks.nth(1).getByTestId('chapter-name')).toHaveText('第2章')
    await expect(blocks.nth(1)).toContainText('この章にはまだ話がありません')
    await blocks.nth(1).getByTestId('chapter-add-episode').click()
    await expect(page.getByTestId('add-kind-episode')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('episode-target').locator('option:checked')).toHaveText('第2章')
    await expect(page.getByTestId('episode-preview')).toContainText('第3話が作成されます')
    await page.getByTestId('add-submit').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/p\//)
    await page.goBack()
    await expect.poll(() => labelsIn(blocks.nth(1))).toEqual(['第3話'])

    // 通し番号では、最新話より前の章（第1章）には話数追加できない
    await expect(blocks.nth(0).getByTestId('chapter-add-episode')).toHaveAttribute('aria-disabled', 'true')

    // 章ごとに第1話から
    await page.getByTestId('numbering-perChapter').click()
    await expect(dialog(page)).toContainText('振り直されます')
    await confirmIn(page, '振り直す')
    await expect(page.getByTestId('numbering-perChapter')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => labelsIn(blocks.nth(0))).toEqual(['第1話', '第2話'])
    await expect.poll(() => labelsIn(blocks.nth(1))).toEqual(['第1話'])
    await expect(blocks.nth(0).getByTestId('chapter-add-episode')).toHaveAttribute('aria-disabled', 'false')

    // 章ページ
    await blocks.nth(1).getByTestId('chapter-name').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/c\/[^/?]+/)
    await expect(page.getByTestId('chapter-name-input')).toHaveValue('第2章')
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話'])
    await expect(page.getByTestId('chapter-read-link')).toHaveAttribute('href', /read\?chapter=/)
    await expect(page.getByTestId('chapter-prev')).toContainText('第1章')
    await page.goBack()
    await expect(blocks).toHaveCount(2)

    // 名前変更
    await page.getByTestId('edit-toggle').click()
    await blocks.nth(1).getByTestId('chapter-rename').click()
    await dialog(page).getByRole('textbox').fill('第2章　旅路')
    await confirmIn(page, '変更')
    await expect(blocks.nth(1).getByTestId('chapter-name')).toHaveText('第2章　旅路')

    // 章を解除しても話は残る
    await blocks.nth(0).getByTestId('chapter-remove').click()
    await expect(dialog(page)).toContainText('削除されません')
    await confirmIn(page, '章を解除')
    await expect(blocks).toHaveCount(1)
    await expect(rows(page)).toHaveCount(3)
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '第1話'])
    await expect(blocks.nth(0).getByTestId('chapter-name')).toHaveText('第2章　旅路')
  })

  test('章をオフにしても章構成は保持され、オンに戻すと元の構成で表示される', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('切り替え')
      actions.addEpisode(id)
      actions.setChaptersEnabled(id, true)
      const ch2 = actions.addChapter(id)
      actions.addEpisode(id, ch2)
      return { titleId: id }
    })
    await openTitle(page, titleId)
    await expect(page.getByTestId('chapter-block')).toHaveCount(2)

    await page.getByTestId('chapters-switch').click()
    await expect(dialog(page)).toContainText('保存され')
    await confirmIn(page, '章をオフにする')
    await expect(page.getByTestId('chapter-block')).toHaveCount(0)
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話'])

    // キャンセルすると変わらない
    await page.getByTestId('chapters-switch').click()
    await expect(dialog(page)).toContainText('以前の章の構成（2章）')
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click()
    await expect(page.getByRole('switch', { name: '章で管理する' })).not.toBeChecked()

    await page.getByTestId('chapters-switch').click()
    await confirmIn(page, '章で管理する')
    await expect(page.getByTestId('chapter-block')).toHaveCount(2)
  })

  test('章ページ: 章のメモ・話数追加（この章）・特殊追加（この章の中）', async ({ page }) => {
    await openApp(page)
    const { titleId, chapterId } = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('章ページ')
      actions.addEpisode(id)
      actions.setChaptersEnabled(id, true)
      const chapterId = getData().titles[id].structure[0].id
      return { titleId: id, chapterId }
    })
    await openApp(page, `/t/${titleId}/c/${chapterId}`)
    await expect(page.getByTestId('chapter-page')).toBeVisible()
    // スマホでも「章を通し読み」（タイトル全体の通し読みと区別する）
    await expect(page.getByTestId('chapter-read-link')).toHaveText('章を通し読み')
    await page.getByTestId('chapter-note').fill('この章では主人公が旅に出る')
    await page.getByTestId('chapter-note').blur()

    await page.getByTestId('chapter-page-add-special').click()
    await expect(page.getByTestId('add-kind-special')).toHaveAttribute('aria-pressed', 'true')
    // 差し込み位置はこの章の中だけ
    await expect(dialog(page).getByText('差し込む位置（この章の中）')).toBeVisible()
    const options = await page.getByTestId('special-position').locator('option').allTextContents()
    expect(options.every((o) => o.includes('「第1章」'))).toBe(true)
    await page.getByTestId('special-label').fill('幕間')
    await page.getByTestId('special-position').selectOption({ index: options.length - 1 })
    await page.getByTestId('add-submit').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/p\//)
    await page.goBack()
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '幕間'])

    await page.getByTestId('chapter-page-add-episode').click()
    await expect(page.getByTestId('episode-preview')).toContainText('第2話が作成されます')
    await page.getByTestId('add-submit').click()
    await page.goBack()
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '幕間'])

    await flushAndReload(page)
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '幕間'])
    await expect(page.getByTestId('chapter-note')).toHaveValue('この章では主人公が旅に出る')
  })

  test('存在しないタイトル・章は「見つかりません」と表示される', async ({ page }) => {
    await openApp(page, '/t/nope')
    await expect(page.getByText('タイトルが見つかりません。')).toBeVisible()
    await openApp(page, '/t/nope/c/none')
    await expect(page.getByText('章が見つかりません。')).toBeVisible()
  })
})

test.describe('タイトル画面・本編（細部）', () => {
  test('同じ見出しの特殊ブロックが並んでも、移動先は現在の位置が選ばれ、差し込み位置は区別できる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => {
      const id = actions.createTitle('幕間つき')
      for (let i = 0; i < 4; i++) actions.addEpisode(id)
      actions.addSpecial(id, { chapterId: null, index: 1 }, '幕間')
      actions.addSpecial(id, { chapterId: null, index: 3 }, '幕間')
      return id
    })
    await openTitle(page, titleId)
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '幕間', '第2話', '幕間', '第3話', '第4話'])

    await page.getByTestId('edit-toggle').click()
    await rows(page).nth(4).getByTestId('piece-move').click()
    const select = page.getByTestId('move-target')
    await expect(select.locator('option:checked')).toContainText('（現在の位置）')
    await expect(select.locator('option:checked')).toContainText('「幕間」の後（「第4話」の前）')
    await expect(page.getByTestId('move-submit')).toBeDisabled()
    const moveOptions = await select.locator('option').allTextContents()
    expect(new Set(moveOptions).size).toBe(moveOptions.length)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await page.getByTestId('add-button').click()
    await page.getByTestId('add-kind-special').click()
    const position = page.getByTestId('special-position')
    const options = await position.locator('option').allTextContents()
    expect(new Set(options).size).toBe(options.length)
    expect(options).toContain('「幕間」の後（「第3話」の前）')
    expect(options).toContain('「幕間」の後（「第2話」の前）')
    await page.getByTestId('special-label').fill('回想')
    await position.selectOption({ label: '「幕間」の後（「第3話」の前）' })
    await page.getByTestId('add-submit').click()
    await expect(page).toHaveURL(/#\/t\/[^/]+\/p\//)
    await page.goBack()
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '幕間', '第2話', '幕間', '回想', '第3話', '第4話'])
  })

  test('スマホ幅（360px）: 長い設定項目名は省略表示され、横スクロールしない（全文は title で読める）', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await openApp(page)
    const longName = '世界観・歴史・地理・魔法体系・用語をまとめた総合資料'
    expect(Array.from(longName)).toHaveLength(26)
    const titleId = await seed(
      page,
      ({ actions }, a: { name: string }) => {
        const id = actions.createTitle('設定の多い作品')
        actions.addCategory(id, a.name)
        return id
      },
      { name: longName },
    )
    await openTitle(page, titleId)
    const chip = page.getByTestId('setting-chip').filter({ hasText: '世界観・歴史' })
    await expect(chip).toHaveAttribute('title', longName)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const box = await chip.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    // 件数のバッジは省略されずに見えている
    await expect(chip.locator('.story-settings-chip-count')).toBeVisible()
    const countBox = await chip.locator('.story-settings-chip-count').boundingBox()
    expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(360)
  })

  test('↑↓で折りたたんだ章へ入ると、その章が開いて知らせが出る', async ({ page }) => {
    await openApp(page)
    const { titleId, chapterId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('第二部あり')
      for (let i = 0; i < 4; i++) actions.addEpisode(id)
      actions.setChaptersEnabled(id, true)
      const ch = actions.addChapter(id, '第二部')
      // 第二部の後ろ（タイトル直下）に第5話
      actions.addEpisode(id, null)
      return { titleId: id, chapterId: ch }
    })
    await openTitle(page, titleId)
    const second = page.locator(`[data-testid="chapter-block"][data-chapter-id="${chapterId}"]`)
    await second.getByTestId('chapter-collapse').click()
    await expect(second.getByTestId('chapter-collapse')).toHaveAttribute('aria-expanded', 'false')

    await page.getByTestId('edit-toggle').click()
    const root = storyList(page).locator(':scope > [data-testid="piece-row"]')
    await expect(root).toHaveCount(1)
    await root.getByTestId('piece-up').click()
    await expect(page.getByRole('status').filter({ hasText: '「第5話」を「第二部」へ移動しました' })).toBeVisible()
    await expect(second.getByTestId('chapter-collapse')).toHaveAttribute('aria-expanded', 'true')
    await expect(second.getByTestId('piece-row')).toBeVisible()
    await expect.poll(() => labelsIn(second)).toEqual(['第5話'])
    // 行が章の中に作り直されても、押したボタンにフォーカスが戻る
    await expect(second.getByTestId('piece-up')).toBeFocused()

    // 「移動…」で折りたたんだ章へ動かしても、その章が開く
    await second.getByTestId('chapter-collapse').click()
    await expect(second.getByTestId('chapter-collapse')).toHaveAttribute('aria-expanded', 'false')
    const first = page.getByTestId('chapter-block').first()
    await first.getByTestId('piece-row').last().getByTestId('piece-move').click()
    await page.getByTestId('move-target').selectOption({ label: '「第二部」の先頭' })
    await page.getByTestId('move-submit').click()
    await expect(second.getByTestId('chapter-collapse')).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => labelsIn(second)).toEqual(['第4話', '第5話'])
  })

  test('特殊追加: 見出しに「エピローグ」と入力しても末尾が選ばれる（位置を自分で選んだ後は変えない）', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '見出し入力', ['一', '二', '三'])
    await openTitle(page, titleId)
    await page.getByTestId('add-button').click()
    await page.getByTestId('add-kind-special').click()
    const position = page.getByTestId('special-position')
    await expect(position.locator('option:checked')).toContainText('先頭')

    await page.getByTestId('special-label').fill('エピローグ')
    await expect(position.locator('option:checked')).toContainText('末尾')
    await page.getByTestId('special-label').fill('プロローグ')
    await expect(position.locator('option:checked')).toContainText('先頭')

    // 位置を自分で選んだら、見出しを打ち直しても位置は変わらない
    await position.selectOption({ index: 1 })
    await page.getByTestId('special-label').fill('あとがき')
    await expect(position.locator('option:checked')).toContainText('「第1話」の後')
  })

  test('章ごとの話数で章を解除すると、振り直される話数が確認とトーストに出る', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('章ごと')
      const ids = [0, 1, 2].map(() => actions.addEpisode(id))
      actions.updatePiece(ids[1], { subtitle: '旅立ち' })
      actions.updatePiece(ids[2], { subtitle: '嵐' })
      actions.setChaptersEnabled(id, true)
      actions.movePiece(ids[0], { chapterId: null, index: 0 })
      actions.setNumbering(id, 'perChapter')
      return { titleId: id, chapterId: getData().titles[id].structure[1].id }
    })
    await openTitle(page, titleId)
    const block = page.getByTestId('chapter-block')
    await expect.poll(() => labelsIn(block)).toEqual(['第1話', '第2話'])

    await page.getByTestId('edit-toggle').click()
    await block.getByTestId('chapter-remove').click()
    await expect(dialog(page)).toContainText('話数が振り直されます')
    await expect(dialog(page)).toContainText('第1話「旅立ち」→第2話')
    await expect(dialog(page)).toContainText('第2話「嵐」→第3話')
    await confirmIn(page, '章を解除')
    await expect(page.getByRole('status').filter({ hasText: '話数を振り直しました' })).toContainText('第1話「旅立ち」→第2話')
    await expect.poll(() => labelsIn(storyList(page))).toEqual(['第1話', '第2話', '第3話'])
  })

  test('通し番号で章を解除しても話数は変わらないので、振り直しの説明は出ない', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('通し')
      actions.addEpisode(id)
      actions.addEpisode(id)
      actions.setChaptersEnabled(id, true)
      return { titleId: id }
    })
    await openTitle(page, titleId)
    await page.getByTestId('edit-toggle').click()
    await page.getByTestId('chapter-remove').click()
    await expect(dialog(page)).toContainText('削除されません')
    await expect(dialog(page)).not.toContainText('振り直')
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click()
  })

  test('メモの「並べ替え・削除」は本編の編集モードとは別に切り替わる', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('メモ編集')
      actions.addEpisode(id)
      actions.addMemo(id, '一つ目')
      actions.addMemo(id, '二つ目')
      return { titleId: id }
    })
    await openTitle(page, titleId)
    const memoToggle = page.getByTestId('memo-edit-toggle')
    await memoToggle.click()
    await expect(memoToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('memo-delete')).toHaveCount(2)
    // 本編は編集モードにならない
    await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('edit-help')).toHaveCount(0)
    await expect(rows(page).first().getByTestId('piece-up')).toHaveCount(0)

    // 本編の編集はメモに影響しない
    await memoToggle.click()
    await page.getByTestId('edit-toggle').click()
    await expect(page.getByTestId('edit-help')).toBeVisible()
    await expect(page.getByTestId('memo-delete')).toHaveCount(0)
    await expect(memoToggle).toHaveAttribute('aria-pressed', 'false')
  })

  test('採用原稿なしは話と特殊ブロックを分けて数える（タイトル・章ブロック・章ページ）', async ({ page }) => {
    await openApp(page)
    const { titleId, chapterId } = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('未採用の内訳')
      const e1 = actions.addEpisode(id)
      actions.addEpisode(id)
      const sp = actions.addSpecial(id, { chapterId: null, index: 0 }, 'プロローグ')
      actions.setActiveVersion(e1, null)
      actions.setActiveVersion(sp, null)
      actions.setChaptersEnabled(id, true)
      return { titleId: id, chapterId: getData().titles[id].structure[0].id }
    })
    await openTitle(page, titleId)
    await expect(page.getByTestId('stat-missing')).toHaveText('採用原稿なし 1話＋特殊1')
    await expect(page.getByTestId('chapter-block').getByTestId('chapter-missing')).toHaveText('採用原稿なし 1話＋特殊1')
    await openApp(page, `/t/${titleId}/c/${chapterId}`)
    await expect(page.getByTestId('chapter-stat-missing')).toHaveText('採用原稿なし 1話＋特殊1')
  })

  test('話数追加のプレビューは、どこに入るかも表示する', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('配置')
      actions.addEpisode(id)
      actions.addEpisode(id)
      actions.addSpecial(id, { chapterId: null, index: 2 }, 'エピローグ')
      return { titleId: id }
    })
    await openTitle(page, titleId)
    await page.getByTestId('add-button').click()
    await page.getByTestId('add-kind-episode').click()
    await expect(page.getByTestId('episode-preview')).toContainText('第3話が作成されます')
    await expect(page.getByTestId('episode-placement')).toHaveText('「第2話」の後（「エピローグ」の前）に入ります。')
  })

  test('↑を続けて押すと、動かした話が押した指の下に残り、第6話を第2話まで動かせる（章の出入りも）', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('並べ替え続けて')
      for (const s of ['A', 'B', 'C', 'D', 'E', 'F']) {
        const pid = actions.addEpisode(id)
        actions.updatePiece(pid, { subtitle: s })
      }
      // 下にスクロールできる余地を作る
      for (let i = 0; i < 24; i++) actions.addMemo(id, `メモ${i + 1}`)
      return { titleId: id }
    })
    await openTitle(page, titleId)
    await page.getByTestId('edit-toggle').click()
    const moved = rows(page).filter({ hasText: 'F' })
    // 上へ動かせる余地を作るため、動かす行を画面の上の方へ
    await moved.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120))
    const up = (await moved.getByTestId('piece-up').boundingBox())!
    const expected = [
      ['A', 'B', 'C', 'D', 'F', 'E'],
      ['A', 'B', 'C', 'F', 'D', 'E'],
      ['A', 'B', 'F', 'C', 'D', 'E'],
      ['A', 'F', 'B', 'C', 'D', 'E'],
    ]
    for (const order of expected) {
      // 同じ場所を押し続ける
      await page.mouse.click(up.x + up.width / 2, up.y + up.height / 2)
      await expect.poll(() => subtitlesIn(storyList(page))).toEqual(order)
    }
    await expect(moved.getByTestId('piece-label')).toHaveText('第2話')
    const after = (await moved.getByTestId('piece-up').boundingBox())!
    expect(Math.abs(after.y - up.y)).toBeLessThan(2)
    await expect(moved.getByTestId('piece-up')).toBeFocused()

    // キーボードでも続けて動かせる。端に着いて押せなくなったら反対向きのボタンにフォーカスが移る
    await page.keyboard.press('Enter')
    await expect.poll(() => subtitlesIn(storyList(page))).toEqual(['F', 'A', 'B', 'C', 'D', 'E'])
    await expect(moved.getByTestId('piece-up')).toBeDisabled()
    await expect(moved.getByTestId('piece-down')).toBeFocused()
  })

  test('章の出入りで行が作り直されても、動かした話は指の下に残る。章の↑↓・メモの↑↓も同じ', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('章をまたぐ')
      for (const s of ['A', 'B', 'C']) actions.updatePiece(actions.addEpisode(id), { subtitle: s })
      actions.setChaptersEnabled(id, true)
      const ch2 = actions.addChapter(id, '第二部')
      for (const s of ['D', 'E', 'F']) actions.updatePiece(actions.addEpisode(id, ch2), { subtitle: s })
      actions.addChapter(id, '第三部')
      actions.addChapter(id, '第四部')
      for (let i = 0; i < 24; i++) actions.addMemo(id, `メモ${i + 1}`)
      actions.updateChapter(getData().titles[id].structure[0].id, { name: '第一部' })
      return { titleId: id }
    })
    await openTitle(page, titleId)
    await page.getByTestId('edit-toggle').click()
    const blocks = page.getByTestId('chapter-block')
    const moved = storyList(page).locator('[data-testid="piece-row"]').filter({ hasText: 'D' })
    await moved.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 160))
    const up = (await moved.getByTestId('piece-up').boundingBox())!
    const checkInPlace = async () => {
      const box = (await moved.getByTestId('piece-up').boundingBox())!
      expect(Math.abs(box.y - up.y)).toBeLessThan(2)
      await expect(moved.getByTestId('piece-up')).toBeFocused()
    }

    // 第二部の先頭から↑: 章の外（第一部と第二部の間）へ出る
    await page.mouse.click(up.x + up.width / 2, up.y + up.height / 2)
    await expect(storyList(page).locator(':scope > [data-testid="piece-row"]')).toHaveText(/D/)
    await checkInPlace()
    // もう一度↑: 第一部の末尾に入る
    await page.mouse.click(up.x + up.width / 2, up.y + up.height / 2)
    await expect.poll(() => subtitlesIn(blocks.nth(0))).toEqual(['A', 'B', 'C', 'D'])
    await checkInPlace()
    // もう一度↑: 第一部の中で C の前へ
    await page.mouse.click(up.x + up.width / 2, up.y + up.height / 2)
    await expect.poll(() => subtitlesIn(blocks.nth(0))).toEqual(['A', 'B', 'D', 'C'])
    await expect(moved.getByTestId('piece-label')).toHaveText('第3話')
    await checkInPlace()

    // 章の↓も、動かした章が指の下に残る
    const chapterNames = () => blocks.getByTestId('chapter-name').allTextContents()
    const first = blocks.filter({ has: page.getByRole('link', { name: '第一部', exact: true }) })
    await first.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80))
    const down = (await first.getByTestId('chapter-down').boundingBox())!
    await page.mouse.click(down.x + down.width / 2, down.y + down.height / 2)
    await expect.poll(chapterNames).toEqual(['第二部', '第一部', '第三部', '第四部'])
    await page.mouse.click(down.x + down.width / 2, down.y + down.height / 2)
    await expect.poll(chapterNames).toEqual(['第二部', '第三部', '第一部', '第四部'])
    const afterDown = (await first.getByTestId('chapter-down').boundingBox())!
    expect(Math.abs(afterDown.y - down.y)).toBeLessThan(2)
    await expect(first.getByTestId('chapter-down')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(chapterNames).toEqual(['第二部', '第三部', '第四部', '第一部'])
    await expect(first.getByTestId('chapter-up')).toBeFocused()

    // メモの↑↓: 押したボタンにフォーカスが残り、続けて動かせる
    const memoNames = async () => (await page.getByTestId('memo-card').locator('.story-memo-name').allTextContents()).slice(0, 4)
    await page.getByTestId('memo-edit-toggle').click()
    const memo = page.getByTestId('memo-card').filter({ has: page.locator('.story-memo-name', { hasText: /^メモ1$/ }) })
    await memo.getByTestId('memo-down').focus()
    await page.keyboard.press('Enter')
    await expect.poll(memoNames).toEqual(['メモ2', 'メモ1', 'メモ3', 'メモ4'])
    await expect(memo.getByTestId('memo-down')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(memoNames).toEqual(['メモ2', 'メモ3', 'メモ1', 'メモ4'])
    await expect(memo.getByTestId('memo-down')).toBeFocused()
  })

  test('メモの削除の確認はゴミ箱へ移ることを伝え、更新日時は「…に更新」と表示する', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seed(page, ({ actions }) => {
      const id = actions.createTitle('メモ削除')
      actions.addMemo(id, '消すメモ')
      return { titleId: id }
    })
    await openTitle(page, titleId)
    await expect(page.getByTestId('memo-card')).toContainText('たった今更新')
    await page.getByTestId('memo-edit-toggle').click()
    await page.getByTestId('memo-delete').click()
    await expect(dialog(page)).toContainText('ゴミ箱に移します。30日後に完全に削除されます（それまではゴミ箱から元に戻せます）。')
    await confirmIn(page, '削除')
    await expect(page.getByTestId('memo-card')).toHaveCount(0)
  })

  test('横持ちのスマホ（高さ 390px）: 追加の種類を選ぶと、入力欄が見える位置に出る', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '横持ち', ['一', '二'])
    await openTitle(page, titleId)
    await page.getByTestId('add-button').click()
    const scrollBehind = await page.evaluate(() => window.scrollY)
    await page.getByTestId('add-kind-special').click()
    await expect(page.getByTestId('special-label')).toBeInViewport()
    await page.getByTestId('add-kind-episode').click()
    await expect(page.getByTestId('episode-preview')).toBeInViewport()
    await expect(page.getByTestId('add-subtitle')).toBeInViewport()
    await page.getByTestId('add-kind-memo').click()
    await expect(page.getByTestId('memo-name')).toBeInViewport()
    await expect(page.getByTestId('memo-name')).toBeFocused()
    // 後ろの画面はスクロールしない
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBehind)
  })
})

test('スマホ幅（360px）でも横スクロールしない', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await openApp(page)
  const { titleId, chapterId } = await seed(page, ({ actions }) => {
    const id = actions.createTitle('とても長いタイトル名のテスト用作品・副題もかなり長めに付けてみる')
    const p1 = actions.addEpisode(id)
    actions.updatePiece(p1, { subtitle: 'とても長い話の題がついていても一覧からはみ出さないことを確かめるための題' })
    actions.addEpisode(id)
    actions.addSpecial(id, { chapterId: null, index: 0 }, 'プロローグ（とても長い見出しの特殊ブロック）')
    actions.setChaptersEnabled(id, true)
    const ch = actions.addChapter(id, 'とても長い章の名前がついている第二章・旅立ちと別れと再会の物語')
    actions.addEpisode(id, ch)
    actions.addMemo(id, 'とても長いメモのタイトルがついていてもはみ出さない')
    return { titleId: id, chapterId: ch }
  })
  const noHorizontalScroll = async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  }
  await openTitle(page, titleId)
  await noHorizontalScroll()
  // 章の名前（章ページへのリンク）も指で押せる高さ
  for (const box of await page
    .getByTestId('chapter-name')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
    expect(box).toBeGreaterThanOrEqual(34)
  }
  await page.getByTestId('edit-toggle').click()
  await noHorizontalScroll()
  await page.getByTestId('add-button').click()
  await page.getByTestId('add-kind-special').click()
  await noHorizontalScroll()
  await page.keyboard.press('Escape')
  await openApp(page, `/t/${titleId}/c/${chapterId}`)
  await expect(page.getByTestId('chapter-page')).toBeVisible()
  await expect(page.getByTestId('chapter-read-link')).toHaveText('章を通し読み')
  await page.getByTestId('edit-toggle').click()
  await noHorizontalScroll()
})

test.describe('画面のスクリーンショット', () => {
  test('本編タブ・追加ダイアログ・章ページ', async ({ page }, info) => {
    const project = info.project.name
    if (project === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
    await openApp(page)
    const { titleId, chapterId } = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('月下の図書館')
      actions.updateTitle(id, {
        synopsis: '廃墟となった図書館で、司書の少女と記憶をなくした青年が、失われた物語を一冊ずつ取り戻していく。',
      })
      const bodies = [
        '　月の光が、崩れた天窓から斜めに差し込んでいた。埃の舞う閲覧室の奥で、少女はひとり、背表紙の消えた本を撫でていた。',
        '　青年が目を覚ましたのは、書架と書架のあいだの狭い通路だった。名前も、ここへ来た理由も思い出せない。',
        '　「この図書館には、まだ読まれていない物語が眠っているの」と少女は言った。',
        '　地下書庫への階段は、思っていたよりもずっと長かった。',
      ]
      const subs = ['月明かりの閲覧室', '名前のない青年', '眠る物語', '地下書庫へ']
      const ids = bodies.map((b, i) => {
        const pid = actions.addEpisode(id)
        actions.updatePiece(pid, { subtitle: subs[i] })
        actions.updateVersion(getData().pieces[pid].versionIds[0], { body: b.repeat(8) })
        return pid
      })
      actions.addVersion(ids[0], { body: '別案' })
      const prologue = actions.addSpecial(id, { chapterId: null, index: 0 }, 'プロローグ')
      actions.setActiveVersion(ids[3], null)
      actions.setChaptersEnabled(id, true)
      actions.movePiece(prologue, { chapterId: null, index: 0 })
      const ch2 = actions.addChapter(id, '第2章　地下書庫')
      const ep5 = actions.addEpisode(id, ch2)
      actions.updatePiece(ep5, { subtitle: '灯りの消えた階段' })
      actions.addChapter(id, '第3章')
      const cats = Object.values(getData().settingCategories).filter((c) => c.titleId === id)
      actions.addEntry(cats[0].id, '栞')
      actions.addEntry(cats[0].id, 'ユウ')
      actions.addCategory(id, '用語集')
      const m1 = actions.addMemo(id, '伏線リスト')
      actions.updateMemo(m1, { body: '・天窓の鍵\n・少女の持つ栞の由来\n・青年の腕時計が止まった時刻' })
      actions.addMemo(id, '参考資料')
      return { titleId: id, chapterId: ch2 }
    })

    const dir = 'e2e/artifacts/screens'
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await openTitle(page, titleId)
      await page.screenshot({ path: `${dir}/story-${project}-title-${scheme}.png`, fullPage: true })
      await page.getByTestId('synopsis-toggle').click()
      await expect(page.getByTestId('synopsis')).toBeVisible()
      await page.screenshot({ path: `${dir}/story-${project}-synopsis-${scheme}.png` })
      await page.getByTestId('synopsis-toggle').click()

      await page.getByTestId('edit-toggle').click()
      await page.screenshot({ path: `${dir}/story-${project}-edit-${scheme}.png`, fullPage: true })
      await page.getByTestId('edit-toggle').click()

      await page.getByTestId('add-button').click()
      await page.screenshot({ path: `${dir}/story-${project}-add-${scheme}.png` })
      await page.getByTestId('add-kind-episode').click()
      await page.screenshot({ path: `${dir}/story-${project}-add-episode-${scheme}.png` })
      await page.getByTestId('add-kind-special').click()
      await page.screenshot({ path: `${dir}/story-${project}-add-special-${scheme}.png` })
      await page.keyboard.press('Escape')

      await page.getByTestId('chapters-switch').click()
      await page.screenshot({ path: `${dir}/story-${project}-confirm-${scheme}.png` })
      await dialog(page).getByRole('button', { name: 'キャンセル' }).click()

      await openApp(page, `/t/${titleId}/c/${chapterId}`)
      await expect(page.getByTestId('chapter-page')).toBeVisible()
      await page.screenshot({ path: `${dir}/story-${project}-chapter-${scheme}.png`, fullPage: true })
    }
  })
})
