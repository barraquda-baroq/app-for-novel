// ホーム（タイトル群・アイデア領域）、タイトルのアイデアタブ、アプリの設定・バックアップの E2E テスト。
import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

const UNASSIGNED = 'どのタイトルにも属さない'

/** 2列表示にならない幅（スマホ・タブレット）か */
function isNarrow(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 900
}

async function showTitles(page: Page): Promise<void> {
  if (isNarrow(page)) await page.getByTestId('home-tab-titles').click()
  await expect(page.getByTestId('title-group')).toBeVisible()
}

async function showIdeas(page: Page): Promise<void> {
  if (isNarrow(page)) await page.getByTestId('home-tab-ideas').click()
  await expect(page.getByTestId('idea-area')).toBeVisible()
}

function section(page: Page, key: string): Locator {
  return page.locator(`[data-testid="idea-section"][data-section="${key}"]`)
}

function cardsIn(scope: Locator): Locator {
  return scope.getByTestId('idea-card')
}

function sectionNames(page: Page): Promise<string[]> {
  return page.getByTestId('idea-area').getByTestId('idea-section-name').allTextContents()
}

function titleCardNames(page: Page): Promise<string[]> {
  return page.getByTestId('title-card-name').allTextContents()
}

function dialog(page: Page): Locator {
  return page.getByRole('dialog')
}

async function clickInDialog(page: Page, name: string): Promise<void> {
  await dialog(page).getByRole('button', { name, exact: true }).click()
}

async function goHome(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'ホーム（アイデアとタイトル一覧）' }).click()
  await expect(page.getByTestId('home')).toBeVisible()
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

async function ideasInData(page: Page): Promise<{ heading: string; body: string; titleId: string | null; order: number }[]> {
  return page.evaluate(() =>
    Object.values(window.__ns.getData().ideas)
      .map((i) => ({ heading: i.heading, body: i.body, titleId: i.titleId, order: i.order }))
      .sort((a, b) => a.order - b.order),
  )
}

test.describe('ホーム', () => {
  test('起動するとタイトル群とアイデア領域が表示され、タイトルがなくても「どのタイトルにも属さない」仕切りがある', async ({ page }) => {
    await openApp(page)
    await expect(page).toHaveTitle('Novel Studio')
    if (isNarrow(page)) {
      await expect(page.getByTestId('home-switch')).toBeVisible()
      await expect(page.getByTestId('home-tab-titles')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('idea-area')).toBeHidden()
    } else {
      await expect(page.getByTestId('home-switch')).toHaveCount(0)
      await expect(page.getByTestId('idea-area')).toBeVisible()
    }
    await expect(page.getByTestId('title-group')).toBeVisible()
    await expect(page.getByTestId('titles-empty')).toHaveText(/まだタイトルがありません。「＋新しいタイトル」から始めましょう。/)

    await showIdeas(page)
    await expect(page.getByTestId('idea-area').getByTestId('idea-section')).toHaveCount(1)
    expect(await sectionNames(page)).toEqual([UNASSIGNED])
    await expect(section(page, 'none').getByTestId('idea-section-empty')).toBeVisible()
    await expect(page.getByTestId('quick-capture')).toBeVisible()
    await noHorizontalScroll(page)
  })

  test('タイトルを作るとアイデアの仕切りがタイトル順に増え、「どのタイトルにも属さない」は最後のまま', async ({ page }) => {
    await openApp(page)
    for (const name of ['星の海', '風の街']) {
      await showTitles(page)
      await page.getByTestId('new-title').click()
      await dialog(page).getByRole('textbox').fill(name)
      await clickInDialog(page, '作成')
      await expect(page).toHaveURL(/#\/t\/[^/?]+$/)
      await expect(page.getByTestId('title-name')).toHaveValue(name)
      await goHome(page)
    }
    await showTitles(page)
    expect(await titleCardNames(page)).toEqual(['星の海', '風の街'])
    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['星の海', '風の街', UNASSIGNED])

    // タイトルの並びを変えると仕切りの並びも変わる
    await showTitles(page)
    await page.getByTestId('titles-edit-toggle').click()
    const cards = page.getByTestId('title-card')
    await expect(cards.nth(0).getByTestId('title-up')).toBeDisabled()
    await expect(cards.nth(1).getByTestId('title-down')).toBeDisabled()
    await cards.nth(1).getByTestId('title-up').click()
    expect(await titleCardNames(page)).toEqual(['風の街', '星の海'])
    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['風の街', '星の海', UNASSIGNED])

    // 名前の変更も仕切りに反映される
    await showTitles(page)
    await cards.nth(0).getByTestId('title-rename').click()
    await dialog(page).getByRole('textbox').fill('風の街の物語')
    await clickInDialog(page, '変更')
    await expect(cards.nth(0).getByTestId('title-card-name')).toHaveText('風の街の物語')
    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['風の街の物語', '星の海', UNASSIGNED])

    // 再読み込みしても残っている
    await page.evaluate(() => window.__ns.flushNow())
    await page.reload()
    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['風の街の物語', '星の海', UNASSIGNED])
  })

  test('アイデアを追加・編集し、別のタイトルの仕切りへ移動し、並べ替えて削除できる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => actions.createTitle('星の海'))
    await showIdeas(page)
    const none = section(page, 'none')
    const target = section(page, titleId)

    // 見出し＋内容で追加（どちらも空なら保存できない）
    await none.getByTestId('idea-add').click()
    await expect(dialog(page)).toContainText(UNASSIGNED)
    await expect(page.getByTestId('idea-save')).toBeDisabled()
    await page.getByTestId('idea-heading-input').fill('記憶を売る古書店')
    await expect(page.getByTestId('idea-save')).toBeEnabled()
    await page.getByTestId('idea-body-input').fill('客は自分の記憶を一冊の本にして売る。\n店主はそれを決して読まない。')
    await page.getByTestId('idea-save').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(none)).toHaveCount(1)
    await expect(none.getByTestId('idea-heading')).toHaveText('記憶を売る古書店')
    await expect(none.getByTestId('idea-body')).toContainText('店主はそれを決して読まない。')

    // 内容だけ・Ctrl+Enter で追加
    await none.getByTestId('idea-add').click()
    await page.getByTestId('idea-body-input').fill('雨の日にだけ開く駅')
    await page.getByTestId('idea-body-input').press('Control+Enter')
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(none)).toHaveCount(2)
    await expect(none.getByTestId('idea-section-count')).toHaveAttribute('data-count', '2')

    // 並べ替え
    await expect(cardsIn(none).nth(0).getByTestId('idea-up')).toBeDisabled()
    await expect(cardsIn(none).nth(1).getByTestId('idea-down')).toBeDisabled()
    await cardsIn(none).nth(1).getByTestId('idea-up').click()
    await expect(cardsIn(none).nth(0)).toContainText('雨の日にだけ開く駅')
    await expect(cardsIn(none).nth(1)).toContainText('記憶を売る古書店')
    await cardsIn(none).nth(0).getByTestId('idea-down').click()
    await expect(cardsIn(none).nth(0)).toContainText('記憶を売る古書店')
    await cardsIn(none).nth(1).getByTestId('idea-up').click()
    await expect(cardsIn(none).nth(0)).toContainText('雨の日にだけ開く駅')

    // 編集
    await cardsIn(none).nth(0).getByTestId('idea-edit').click()
    await expect(page.getByTestId('idea-body-input')).toHaveValue('雨の日にだけ開く駅')
    await page.getByTestId('idea-heading-input').fill('雨の駅')
    await page.getByTestId('idea-save').click()
    await expect(cardsIn(none).nth(0).getByTestId('idea-heading')).toHaveText('雨の駅')

    // 編集中に閉じようとすると確認される
    await cardsIn(none).nth(0).getByTestId('idea-edit').click()
    await page.getByTestId('idea-body-input').fill('書きかけ')
    await page.getByTestId('idea-cancel').click()
    await expect(dialog(page).filter({ hasText: '編集中の内容を破棄しますか？' })).toBeVisible()
    await clickInDialog(page, '破棄する')
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(none).nth(0)).toContainText('雨の日にだけ開く駅')

    // 移動（今いる仕切りは選べない）
    await cardsIn(none).filter({ hasText: '記憶を売る古書店' }).getByTestId('idea-move').click()
    const options = page.getByTestId('idea-move-option')
    await expect(options).toHaveCount(2)
    await expect(page.locator('[data-testid="idea-move-option"][data-section="none"]')).toBeDisabled()
    await page.locator(`[data-testid="idea-move-option"][data-section="${titleId}"]`).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(target)).toHaveCount(1)
    await expect(cardsIn(target).nth(0)).toContainText('記憶を売る古書店')
    await expect(cardsIn(none)).toHaveCount(1)
    // 「この案でタイトルを作る」は「どのタイトルにも属さない」のアイデアだけ
    await expect(target.getByTestId('idea-make-title')).toHaveCount(0)
    await expect(none.getByTestId('idea-make-title')).toHaveCount(1)

    const stored = await ideasInData(page)
    expect(stored.find((i) => i.heading === '記憶を売る古書店')?.titleId).toBe(titleId)
    expect(stored.find((i) => i.heading === '雨の駅')?.titleId).toBeNull()

    // 削除
    await cardsIn(target).nth(0).getByTestId('idea-delete').click()
    await expect(dialog(page)).toContainText('記憶を売る古書店')
    await clickInDialog(page, '削除')
    await expect(cardsIn(target)).toHaveCount(0)
    await expect(target.getByTestId('idea-section-empty')).toBeVisible()
  })

  test('長いアイデアは折りたたまれ、「続きを表示」で全文を読める。仕切りは折りたためる', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      const long = Array.from({ length: 12 }, (_, i) => `${i + 1}行目のメモ`).join('\n')
      actions.addIdea(null, '長い案', long)
      actions.addIdea(null, '', '短い案')
    })
    await showIdeas(page)
    const none = section(page, 'none')
    const longCard = cardsIn(none).filter({ hasText: '長い案' })
    await expect(longCard.getByTestId('idea-more')).toHaveText('続きを表示')
    await expect(cardsIn(none).filter({ hasText: '短い案' }).getByTestId('idea-more')).toHaveCount(0)
    const collapsedHeight = await longCard.getByTestId('idea-body').evaluate((el) => el.clientHeight)
    await longCard.getByTestId('idea-more').click()
    await expect(longCard.getByTestId('idea-more')).toHaveText('折りたたむ')
    const expandedHeight = await longCard.getByTestId('idea-body').evaluate((el) => el.clientHeight)
    expect(expandedHeight).toBeGreaterThan(collapsedHeight)

    await none.getByTestId('idea-section-toggle').click()
    await expect(none.getByTestId('idea-section-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(cardsIn(none).first()).toBeHidden()
    // 折りたたみは覚えている
    await page.reload()
    await showIdeas(page)
    await expect(section(page, 'none').getByTestId('idea-section-toggle')).toHaveAttribute('aria-expanded', 'false')
    await section(page, 'none').getByTestId('idea-section-toggle').click()
    await expect(cardsIn(section(page, 'none')).first()).toBeVisible()
  })

  test('すばやく追加: 追加先を選んで Ctrl+Enter かボタンで追加できる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => actions.createTitle('星の海'))
    await showIdeas(page)
    const input = page.getByTestId('quick-idea-input')
    const targetSelect = page.getByTestId('quick-idea-target')
    await expect(targetSelect).toHaveValue('none')
    await expect(page.getByTestId('quick-idea-add')).toBeDisabled()

    await input.fill('ふと思いついた台詞「それでも、灯りは消さない」')
    await input.press('Control+Enter')
    await expect(input).toHaveValue('')
    await expect(cardsIn(section(page, 'none'))).toHaveCount(1)
    await expect(cardsIn(section(page, 'none')).nth(0)).toContainText('それでも、灯りは消さない')

    await targetSelect.selectOption(titleId)
    await input.fill('星の海の続編案')
    await page.getByTestId('quick-idea-add').click()
    await expect(cardsIn(section(page, titleId))).toHaveCount(1)
    await expect(page.getByTestId('idea-total')).toHaveText('2')
  })

  test('「この案でタイトルを作る」で新しいタイトルを作り、アイデアがその仕切りへ移る', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      actions.addIdea(null, '', '灯台守の少女が\n嵐の夜に流れ着いた手紙を拾う')
    })
    await showIdeas(page)
    await cardsIn(section(page, 'none')).nth(0).getByTestId('idea-make-title').click()
    await expect(dialog(page).getByRole('textbox')).toHaveValue('灯台守の少女が')
    await dialog(page).getByRole('textbox').fill('灯台守の手紙')
    await clickInDialog(page, '作成')
    await expect(page).toHaveURL(/#\/t\/[^/?]+$/)
    await expect(page.getByTestId('title-name')).toHaveValue('灯台守の手紙')
    const titleId = page.url().split('/t/')[1]
    const stored = await ideasInData(page)
    expect(stored[0].titleId).toBe(titleId)

    await goHome(page)
    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['灯台守の手紙', UNASSIGNED])
    await expect(cardsIn(section(page, titleId))).toHaveCount(1)
    await expect(cardsIn(section(page, 'none'))).toHaveCount(0)
  })

  test('タイトルを削除すると、そのアイデアは「どのタイトルにも属さない」へ移る', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '消える物語', ['一話', '二話'])
    await seed(
      page,
      ({ actions }, id: string) => {
        actions.createTitle('残る物語')
        actions.addIdea(null, '', '最初からどこにも属さない案')
        actions.addIdea(id, '案A', '消える物語のアイデア1')
        actions.addIdea(id, '案B', '消える物語のアイデア2')
      },
      titleId,
    )
    await showIdeas(page)
    await expect(cardsIn(section(page, titleId))).toHaveCount(2)
    await expect(cardsIn(section(page, 'none'))).toHaveCount(1)

    await showTitles(page)
    await page.getByTestId('titles-edit-toggle').click()
    await page.getByTestId('title-card').filter({ hasText: '消える物語' }).getByTestId('title-delete').click()
    await expect(dialog(page)).toContainText('「消える物語」を削除しますか？')
    await expect(dialog(page)).toContainText('すべての話・推敲バージョン・設定・戦略・メモが削除されます')
    await expect(dialog(page)).toContainText('全2話')
    await expect(dialog(page)).toContainText('アイデア（2件）は削除されず、「どのタイトルにも属さない」へ移ります')
    await clickInDialog(page, '削除')
    await expect(page.getByTestId('title-card')).toHaveCount(1)
    expect(await titleCardNames(page)).toEqual(['残る物語'])

    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['残る物語', UNASSIGNED])
    const none = section(page, 'none')
    await expect(cardsIn(none)).toHaveCount(3)
    await expect(cardsIn(none).nth(0)).toContainText('最初からどこにも属さない案')
    await expect(cardsIn(none).nth(1)).toContainText('案A')
    await expect(cardsIn(none).nth(2)).toContainText('案B')
    const pieces = await page.evaluate(() => Object.keys(window.__ns.getData().pieces).length)
    expect(pieces).toBe(0)
  })

  test('タイトルカードに話数・文字数・採用原稿なし・章ありが表示され、押すとタイトルに入る', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '星の海', ['一話目の本文', '二話目'])
    await showTitles(page)
    const card = page.getByTestId('title-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId('title-card-episodes')).toHaveText('全2話')
    await expect(card.getByTestId('title-card-chars')).toHaveText('9字')
    await expect(card.getByTestId('title-card-missing')).toHaveCount(0)
    await expect(card.getByTestId('title-card-chapters')).toHaveCount(0)
    await expect(card).toContainText('あらすじは未記入です')

    await seed(
      page,
      ({ actions }, a: { titleId: string; second: string }) => {
        actions.updateTitle(a.titleId, { synopsis: '星の海を渡る少年の物語。' })
        actions.setActiveVersion(a.second, null)
        actions.addSpecial(a.titleId, { chapterId: null, index: 0 }, 'プロローグ')
        actions.setChaptersEnabled(a.titleId, true)
        actions.addIdea(a.titleId, '', 'アイデア')
      },
      { titleId, second: pieceIds[1] },
    )
    await expect(card.getByTestId('title-card-episodes')).toHaveText('全2話＋特殊1')
    await expect(card.getByTestId('title-card-chars')).toHaveText('6字')
    await expect(card.getByTestId('title-card-missing')).toHaveText('採用原稿なし 1話')
    await expect(card.getByTestId('title-card-chapters')).toHaveText('章あり')
    await expect(card).toContainText('星の海を渡る少年の物語。')
    await expect(card).toContainText('アイデア 1')
    await expect(card).toContainText('更新')

    await card.getByTestId('title-card-link').click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}$`))
    await expect(page.getByTestId('title-name')).toHaveValue('星の海')
  })

  test('スマホ幅では上部の切り替えでタイトルとアイデアを行き来でき、最後の選択を覚えている', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      const id = actions.createTitle('星の海')
      actions.addIdea(id, '', '星の海のアイデア')
      actions.addIdea(null, '', 'どこにも属さないアイデア')
    })
    const titlesTab = page.getByTestId('home-tab-titles')
    const ideasTab = page.getByTestId('home-tab-ideas')
    await expect(titlesTab).toHaveAttribute('aria-selected', 'true')
    await expect(titlesTab).toContainText('1')
    await expect(ideasTab).toContainText('2')
    await expect(page.getByTestId('title-group')).toBeVisible()
    await expect(page.getByTestId('idea-area')).toBeHidden()

    await ideasTab.click()
    await expect(ideasTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('idea-area')).toBeVisible()
    await expect(page.getByTestId('title-group')).toBeHidden()
    await noHorizontalScroll(page)

    await page.reload()
    await expect(page.getByTestId('home-tab-ideas')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('idea-area')).toBeVisible()

    // キーボードでも切り替えられる
    await page.getByTestId('home-tab-ideas').focus()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('home-tab-titles')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('home-tab-titles')).toBeFocused()
    await expect(page.getByTestId('title-group')).toBeVisible()
    await noHorizontalScroll(page)

    // 広い画面では左右に並ぶ
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('home-switch')).toHaveCount(0)
    await expect(page.getByTestId('title-group')).toBeVisible()
    await expect(page.getByTestId('idea-area')).toBeVisible()
    const titlesBox = await page.getByTestId('title-group').boundingBox()
    const ideasBox = await page.getByTestId('idea-area').boundingBox()
    expect(titlesBox && ideasBox && titlesBox.x < ideasBox.x).toBeTruthy()
  })
})

test.describe('タイトル画面のアイデアタブ', () => {
  test('そのタイトルの仕切りだけが表示され、追加・移動・並べ替えができ、すべてのアイデアへ戻れる', async ({ page }) => {
    await openApp(page)
    const { a, b } = await seed(page, ({ actions }) => {
      const a = actions.createTitle('星の海')
      const b = actions.createTitle('風の街')
      actions.addIdea(a, '案1', '星の海の案1')
      actions.addIdea(a, '案2', '星の海の案2')
      actions.addIdea(b, '', '風の街の案')
      actions.addIdea(null, '', 'どこにも属さない案')
      return { a, b }
    })
    await openApp(page, `/t/${a}?tab=ideas`)
    await expect(page.getByTestId('tab-ideas')).toHaveAttribute('aria-selected', 'true')
    const tab = page.getByTestId('title-ideas')
    await expect(tab).toContainText('「どのタイトルにも属さない」へ移せます')
    await expect(tab.getByTestId('idea-section')).toHaveCount(1)
    await expect(tab.getByTestId('idea-section')).toHaveAttribute('data-section', a)
    await expect(cardsIn(tab)).toHaveCount(2)
    await expect(tab).not.toContainText('風の街の案')
    await expect(tab.getByTestId('idea-make-title')).toHaveCount(0)

    // 追加（ダイアログ）
    await tab.getByTestId('idea-add').click()
    await expect(dialog(page)).toContainText('星の海')
    await page.getByTestId('idea-body-input').fill('星の海の案3')
    await page.getByTestId('idea-save').click()
    await expect(cardsIn(tab)).toHaveCount(3)

    // すばやく追加（このタイトルに固定）
    await expect(page.getByTestId('quick-idea-target')).toHaveCount(0)
    await page.getByTestId('quick-idea-input').fill('星の海の案4')
    await page.getByTestId('quick-idea-input').press('Control+Enter')
    await expect(cardsIn(tab)).toHaveCount(4)
    await expect(cardsIn(tab).nth(3)).toContainText('星の海の案4')

    // 並べ替え
    await cardsIn(tab).nth(0).getByTestId('idea-down').click()
    await expect(cardsIn(tab).nth(0)).toContainText('案2')
    await expect(cardsIn(tab).nth(1)).toContainText('案1')

    // 別のタイトルへ移動
    await cardsIn(tab).nth(0).getByTestId('idea-move').click()
    await expect(page.getByTestId('idea-move-option')).toHaveCount(3)
    await page.locator(`[data-testid="idea-move-option"][data-section="${b}"]`).click()
    await expect(cardsIn(tab)).toHaveCount(3)
    // 「どのタイトルにも属さない」へ移動
    await cardsIn(tab).nth(0).getByTestId('idea-move').click()
    await page.locator('[data-testid="idea-move-option"][data-section="none"]').click()
    await expect(cardsIn(tab)).toHaveCount(2)
    const stored = await ideasInData(page)
    expect(stored.filter((i) => i.titleId === a).map((i) => i.body)).toEqual(['星の海の案3', '星の海の案4'])
    expect(stored.find((i) => i.heading === '案2')?.titleId).toBe(b)
    expect(stored.find((i) => i.heading === '案1')?.titleId).toBeNull()

    // すべてのアイデアを見る（スマホでもアイデア側が開く）
    await expect(page.getByTestId('all-ideas-link')).toHaveAttribute('href', new RegExp(`view=ideas&focus=${a}`))
    await page.getByTestId('all-ideas-link').click()
    await expect(page.getByTestId('idea-area')).toBeVisible()
    // 指定は一度だけ使い、URL からは消える
    await expect(page).toHaveURL(/#\/$/)
    await expect(section(page, a)).toBeInViewport()
    await expect(cardsIn(section(page, b))).toHaveCount(2)
    await expect(cardsIn(section(page, 'none'))).toHaveCount(2)
    await noHorizontalScroll(page)
  })
})

test.describe('アプリの設定', () => {
  test('表示の設定を変えるとすぐに反映され、再読み込みしても残る', async ({ page }) => {
    await openApp(page, '/settings')
    await expect(page).toHaveTitle('設定 — Novel Studio')
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('設定')
    const html = page.locator('html')

    await page.getByTestId('theme-dark').click()
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('theme-light').click()
    await expect(html).toHaveAttribute('data-theme', 'light')
    await page.getByTestId('theme-system').click()
    await expect(html).not.toHaveAttribute('data-theme', /.*/)
    await page.getByTestId('theme-dark').click()

    const preview = page.getByTestId('font-preview')
    await page.getByTestId('font-gothic').click()
    await expect(page.getByTestId('font-gothic')).toHaveAttribute('aria-pressed', 'true')
    const gothic = await preview.evaluate((el) => getComputedStyle(el).fontFamily)
    await page.getByTestId('font-mincho').click()
    const mincho = await preview.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(gothic).not.toEqual(mincho)
    await page.getByTestId('font-gothic').click()

    await page.getByTestId('font-size').fill('22')
    await expect(page.getByTestId('font-size-value')).toHaveText('22px')
    await expect(preview).toHaveCSS('font-size', '22px')

    await page.getByTestId('split-vertical').click()
    await expect(page.getByTestId('split-vertical')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('split-auto')).toHaveAttribute('aria-pressed', 'false')
    const diff = page.getByTestId('diff-switch').getByRole('switch')
    await expect(diff).not.toBeChecked()
    await page.getByTestId('diff-switch').click()
    await expect(diff).toBeChecked()

    await page.reload()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('font-gothic')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('font-size-value')).toHaveText('22px')
    await expect(page.getByTestId('split-vertical')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('diff-switch').getByRole('switch')).toBeChecked()
    await noHorizontalScroll(page)
  })

  test('バックアップを書き出すと、データを含む JSON がダウンロードされる', async ({ page }) => {
    await openApp(page)
    await seedTitleWithEpisodes(page, 'バックアップの星', ['大切な本文'])
    await seed(page, ({ actions }) => void actions.addIdea(null, '控えの案', ''))
    await openApp(page, '/settings')
    await expect(page.getByTestId('data-counts')).toContainText('タイトル1')
    await expect(page.getByTestId('last-backup')).toContainText('まだバックアップを書き出していません')

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('export-backup').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^novel-studio-backup-\d{8}-\d{4}\.json$/)
    const file = await download.path()
    const json = JSON.parse(await readFile(file, 'utf8')) as {
      app: string
      schemaVersion: number
      data: { titles: Record<string, { name: string }>; versions: Record<string, { body: string }>; ideas: Record<string, { heading: string }> }
    }
    expect(json.app).toBe('novel-studio')
    expect(json.schemaVersion).toBe(1)
    expect(Object.values(json.data.titles).map((t) => t.name)).toEqual(['バックアップの星'])
    expect(Object.values(json.data.versions).map((v) => v.body)).toEqual(['大切な本文'])
    expect(Object.values(json.data.ideas).map((i) => i.heading)).toEqual(['控えの案'])
    await expect(page.getByTestId('last-backup')).toContainText('最後に書き出した日時')
  })

  test('バックアップから復元すると、確認のうえ現在のデータが置き換わる。壊れたファイルはエラーになる', async ({ page }) => {
    await openApp(page)
    await seedTitleWithEpisodes(page, '今のタイトル', ['今の本文'])
    await openApp(page, '/settings')

    // 壊れたファイル
    let chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('restore-backup').click()
    let chooser = await chooserPromise
    await chooser.setFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": "world"}') })
    await expect(page.getByRole('alert').filter({ hasText: 'Novel Studio のバックアップファイルではありません' })).toBeVisible()
    await expect(dialog(page)).toHaveCount(0)

    const ts = Date.parse('2026-01-02T03:04:00Z')
    const backup = {
      app: 'novel-studio',
      schemaVersion: 1,
      exportedAt: new Date(ts).toISOString(),
      data: {
        titles: {
          t1: {
            id: 't1',
            name: '復元された物語',
            synopsis: '',
            chaptersEnabled: false,
            numbering: 'continuous',
            structure: [],
            strategyNote: '',
            order: 0,
            createdAt: ts,
            updatedAt: ts,
          },
        },
        ideas: {
          i1: { id: 'i1', titleId: 't1', heading: '復元されたアイデア', body: '', order: 0, createdAt: ts, updatedAt: ts },
          i2: { id: 'i2', titleId: null, heading: '', body: 'どこにも属さない復元案', order: 0, createdAt: ts, updatedAt: ts },
        },
      },
    }

    // キャンセルすると何も変わらない
    chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('restore-backup').click()
    chooser = await chooserPromise
    await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })
    await expect(dialog(page)).toContainText('バックアップから復元しますか？')
    await clickInDialog(page, 'キャンセル')
    expect(await page.evaluate(() => Object.values(window.__ns.getData().titles).map((t) => t.name))).toEqual(['今のタイトル'])

    chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('restore-backup').click()
    chooser = await chooserPromise
    await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })
    const confirm = dialog(page)
    await expect(confirm).toContainText('置き換えられます')
    await expect(confirm).toContainText('タイトル 1件')
    await expect(confirm).toContainText('話 0件')
    await expect(confirm).toContainText('アイデア 2件')
    await expect(confirm).toContainText('書き出し日時: 2026/01/0')
    await clickInDialog(page, '置き換えて復元')
    await expect(page.getByRole('status').filter({ hasText: 'バックアップから復元しました' })).toBeVisible()
    expect(await page.evaluate(() => Object.values(window.__ns.getData().titles).map((t) => t.name))).toEqual(['復元された物語'])
    expect(await page.evaluate(() => Object.keys(window.__ns.getData().pieces).length)).toBe(0)

    // 再読み込みしても復元後のデータ
    await page.reload()
    await expect(page.getByTestId('data-counts')).toContainText('タイトル1')
    await goHome(page)
    await showTitles(page)
    expect(await titleCardNames(page)).toEqual(['復元された物語'])
    await showIdeas(page)
    expect(await sectionNames(page)).toEqual(['復元された物語', UNASSIGNED])
    await expect(cardsIn(section(page, 't1'))).toHaveCount(1)
    await expect(cardsIn(section(page, 'none'))).toHaveCount(1)
  })

  test('すべてのデータを削除するには「削除」の入力が必要', async ({ page }) => {
    await openApp(page)
    await seedTitleWithEpisodes(page, '消すタイトル', ['本文'])
    await openApp(page, '/settings')
    await expect(page.getByTestId('storage-usage')).not.toHaveText('')
    await expect(page.getByTestId('storage-persisted')).not.toHaveText('')

    await page.getByTestId('delete-all').click()
    await expect(dialog(page)).toContainText('すべてのデータを削除しますか？')
    await expect(dialog(page)).toContainText('タイトル 1件')
    await clickInDialog(page, '削除へ進む')
    await dialog(page).getByRole('textbox').fill('けす')
    await clickInDialog(page, 'すべて削除')
    await expect(page.getByRole('alert').filter({ hasText: '削除を中止しました' })).toBeVisible()
    expect(await page.evaluate(() => Object.keys(window.__ns.getData().titles).length)).toBe(1)

    await page.getByTestId('delete-all').click()
    await clickInDialog(page, '削除へ進む')
    await dialog(page).getByRole('textbox').fill('削除')
    await clickInDialog(page, 'すべて削除')
    await expect(page.getByRole('status').filter({ hasText: 'すべてのデータを削除しました' })).toBeVisible()
    expect(await page.evaluate(() => Object.keys(window.__ns.getData().titles).length)).toBe(0)
    await page.reload()
    await expect(page.getByTestId('data-counts')).toContainText('タイトル0')
    await goHome(page)
    await expect(page.getByTestId('titles-empty')).toBeVisible()
  })

  test('インストールの案内が表示され、ブラウザの提案があれば「インストール」ボタンが出る', async ({ page }) => {
    await openApp(page, '/settings')
    const help = page.getByTestId('install-help')
    await expect(help).toContainText('ホーム画面に追加')
    await expect(help).toContainText('共有')
    await expect(page.getByTestId('install-button')).toHaveCount(0)
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<void>
        userChoice: Promise<{ outcome: string }>
      }
      e.prompt = () => Promise.resolve()
      e.userChoice = Promise.resolve({ outcome: 'dismissed' })
      window.dispatchEvent(e)
    })
    await expect(page.getByTestId('install-button')).toBeVisible()
    await page.getByTestId('install-button').click()
    await expect(page.getByTestId('install-button')).toHaveCount(0)
  })
})

test.describe('画面のスクリーンショット', () => {
  test('ホーム・アイデアタブ・設定', async ({ page }, info) => {
    const project = info.project.name
    if (project === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
    await openApp(page)
    const { titleId } = await seed(page, ({ actions, getData }) => {
      const a = actions.createTitle('月下の図書館')
      actions.updateTitle(a, {
        synopsis: '廃墟となった図書館で、司書の少女と記憶をなくした青年が、失われた物語を一冊ずつ取り戻していく。静かな夜と古い紙の匂いの物語。',
      })
      const bodies = ['　月の光が、崩れた天窓から斜めに差し込んでいた。', '　青年が目を覚ましたのは、書架と書架のあいだだった。', '　「この図書館には、まだ読まれていない物語が眠っているの」']
      const ids = bodies.map((b) => {
        const pid = actions.addEpisode(a)
        actions.updateVersion(getData().pieces[pid].versionIds[0], { body: b.repeat(30) })
        return pid
      })
      actions.setActiveVersion(ids[2], null)
      actions.addSpecial(a, { chapterId: null, index: 0 }, 'プロローグ')
      actions.setChaptersEnabled(a, true)

      const b = actions.createTitle('風の街のパン屋')
      actions.updateTitle(b, { synopsis: '坂の上の小さなパン屋に、毎朝ひとつだけ売れ残るパンがある。' })
      const p = actions.addEpisode(b)
      actions.updateVersion(getData().pieces[p].versionIds[0], { body: '　朝の五時、店の灯りがともる。'.repeat(20) })
      actions.createTitle('無人駅の幽霊')

      actions.addIdea(a, '地下書庫の鍵', '第2章の終わりで、少女が鍵を青年に渡す。\n鍵には持ち主の記憶が残っている。')
      actions.addIdea(
        a,
        '',
        Array.from({ length: 9 }, (_, i) => `・伏線${i + 1}: 天窓、栞、止まった時計、読めない題名のどれかと結びつける`).join('\n'),
      )
      actions.addIdea(b, 'パンの名前', '売れ残るパンには名前がない。最終話で名前が付く。')
      actions.addIdea(null, '記憶を売る古書店', '客は自分の記憶を一冊の本にして売る。店主はそれを決して読まない。')
      actions.addIdea(null, '', '雨の日にだけ開く駅')
      return { titleId: a }
    })

    const dir = 'e2e/artifacts/screens'
    // ハッシュでの画面遷移ではスクロール位置が残るので、撮る前に先頭へ戻す
    const shot = async (name: string, fullPage = false) => {
      if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `${dir}/home-${project}-${name}.png`, fullPage })
    }
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await openApp(page)
      if (project === 'mobile') await page.getByTestId('home-tab-titles').click()
      await shot(scheme, true)
      if (project === 'mobile') {
        await page.getByTestId('home-tab-ideas').click()
        await shot(`ideas-${scheme}`, true)
      }
      await showTitles(page)
      await page.getByTestId('titles-edit-toggle').click()
      await shot(`titles-edit-${scheme}`)
      await page.getByTestId('titles-edit-toggle').click()

      await showIdeas(page)
      await section(page, 'none').getByTestId('idea-add').click()
      await page.getByTestId('idea-body-input').fill('思いついたこと')
      await shot(`idea-editor-${scheme}`)
      await page.getByTestId('idea-cancel').click()
      await clickInDialog(page, '破棄する')
      await cardsIn(section(page, 'none')).nth(0).getByTestId('idea-move').click()
      await shot(`idea-move-${scheme}`)
      await page.keyboard.press('Escape')

      await openApp(page, `/t/${titleId}?tab=ideas`)
      await shot(`title-ideas-${scheme}`, true)

      await openApp(page, '/settings')
      await shot(`settings-${scheme}`, true)
    }
    // 空の状態
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(async () => {
      const { replaceAllData } = window.__ns as unknown as { replaceAllData: (d: unknown) => Promise<void> }
      await replaceAllData({
        titles: {},
        chapters: {},
        pieces: {},
        versions: {},
        memos: {},
        ideas: {},
        settingCategories: {},
        settingEntries: {},
        submissions: {},
      })
    })
    await openApp(page)
    await shot('empty-light', true)
  })
})
