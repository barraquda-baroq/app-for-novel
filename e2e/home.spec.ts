// ホーム（タイトル群・アイデア領域）、タイトルのアイデアタブ、アプリの設定・バックアップの E2E テスト。
import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

const UNASSIGNED = 'どのタイトルにも属さない'

/** 上下に積む幅（スマホ）か。721px からは左右2列 */
function isStacked(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) <= 720
}

/** タイトル群もアイデア領域も常に表示されている（どちらかを隠す切り替えはない） */
async function showTitles(page: Page): Promise<void> {
  await expect(page.getByTestId('title-group')).toBeVisible()
}

async function showIdeas(page: Page): Promise<void> {
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

/** この端末だけに保存している状態（書きかけ・折りたたみ・復旧用の控えなど）と、ほかのサイトのキーを用意する */
async function seedLocalState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('novel-studio:idea-draft:home', 'すばやく追加の書きかけ')
    localStorage.setItem('novel-studio:idea-modal-draft:new:none', JSON.stringify({ heading: '', body: '追加の書きかけ' }))
    localStorage.setItem('novel-studio:idea-collapsed', '["none"]')
    localStorage.setItem('novel-studio:collapsed-chapters:t0', '["c1"]')
    localStorage.setItem('novel-studio:recovery:old-tab', JSON.stringify({ at: Date.now(), puts: {}, dels: {} }))
    localStorage.setItem('novel-studio:last-backup', String(Date.now()))
    if (!localStorage.getItem('novel-studio:prefs')) localStorage.setItem('novel-studio:prefs', '{}')
    localStorage.setItem('other-app:keep', '1')
  })
}

/** このアプリが localStorage に保存しているキー（並べ替え済み） */
function appLocalKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('novel-studio:'))
      .sort(),
  )
}

async function ideasInData(page: Page): Promise<{ heading: string; body: string; titleId: string | null; order: number }[]> {
  return page.evaluate(() =>
    Object.values(window.__ns.getData().ideas)
      .map((i) => ({ heading: i.heading, body: i.body, titleId: i.titleId, order: i.order }))
      .sort((a, b) => a.order - b.order),
  )
}

test.describe('ホーム', () => {
  test('起動するとタイトル群とアイデア領域が表示され、タイトルがなくても「どのタイトルにも属さない」仕切りがある', async ({
    page,
  }) => {
    await openApp(page)
    await expect(page).toHaveTitle('Novel Studio')
    // どの幅でも両方が表示される（スマホでもどちらかを隠さない）
    await expect(page.getByTestId('title-group')).toBeVisible()
    await expect(page.getByTestId('idea-area')).toBeVisible()
    if (isStacked(page)) await expect(page.getByTestId('home-jump')).toBeVisible()
    else await expect(page.getByTestId('home-jump')).toHaveCount(0)
    await expect(page.getByTestId('titles-empty')).toHaveText(/まだタイトルがありません。「＋新しいタイトル」から始めましょう。/)

    await expect(page.getByTestId('idea-area').getByTestId('idea-section')).toHaveCount(1)
    await expect.poll(() => sectionNames(page)).toEqual([UNASSIGNED])
    await expect(section(page, 'none').getByTestId('idea-section-empty')).toBeVisible()
    await expect(page.getByTestId('quick-capture')).toBeVisible()
    // 仕切りが1つだけの時は仕切りの一覧を出さない
    await expect(page.getByTestId('idea-index')).toHaveCount(0)
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
    await expect.poll(() => titleCardNames(page)).toEqual(['星の海', '風の街'])
    await showIdeas(page)
    await expect.poll(() => sectionNames(page)).toEqual(['星の海', '風の街', UNASSIGNED])

    // タイトルの並びを変えると仕切りの並びも変わる
    await showTitles(page)
    await page.getByTestId('titles-edit-toggle').click()
    const cards = page.getByTestId('title-card')
    await expect(cards.nth(0).getByTestId('title-up')).toBeDisabled()
    await expect(cards.nth(1).getByTestId('title-down')).toBeDisabled()
    await cards.nth(1).getByTestId('title-up').click()
    await expect.poll(() => titleCardNames(page)).toEqual(['風の街', '星の海'])
    await showIdeas(page)
    await expect.poll(() => sectionNames(page)).toEqual(['風の街', '星の海', UNASSIGNED])

    // 名前の変更も仕切りに反映される
    await showTitles(page)
    await cards.nth(0).getByTestId('title-rename').click()
    await dialog(page).getByRole('textbox').fill('風の街の物語')
    await clickInDialog(page, '変更')
    await expect(cards.nth(0).getByTestId('title-card-name')).toHaveText('風の街の物語')
    await showIdeas(page)
    await expect.poll(() => sectionNames(page)).toEqual(['風の街の物語', '星の海', UNASSIGNED])

    // 再読み込みしても残っている
    await page.evaluate(() => window.__ns.flushNow())
    await page.reload()
    await showIdeas(page)
    await expect.poll(() => sectionNames(page)).toEqual(['風の街の物語', '星の海', UNASSIGNED])
  })

  test('アイデアを追加・編集し、別のタイトルの仕切りへ移動し、並べ替えて削除できる（見出しの入力欄はない）', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => actions.createTitle('星の海'))
    await showIdeas(page)
    const none = section(page, 'none')
    const target = section(page, titleId)

    // 内容だけで追加（空なら保存できない）。見出しの入力欄はない
    await none.getByTestId('idea-add').click()
    await expect(dialog(page)).toContainText(UNASSIGNED)
    await expect(page.getByTestId('idea-heading-input')).toHaveCount(0)
    await expect(page.getByTestId('idea-save')).toBeDisabled()
    await page
      .getByTestId('idea-body-input')
      .fill('記憶を売る古書店\n客は自分の記憶を一冊の本にして売る。\n店主はそれを決して読まない。')
    await expect(page.getByTestId('idea-save')).toBeEnabled()
    await page.getByTestId('idea-save').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(none)).toHaveCount(1)
    await expect(none.getByTestId('idea-heading')).toHaveCount(0)
    // 2行以上あるアイデアは1行目を少し目立たせる
    await expect(none.getByTestId('idea-lead')).toHaveText('記憶を売る古書店')
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
    await expect(page.getByTestId('idea-heading-merged')).toHaveCount(0)
    await page.getByTestId('idea-body-input').fill('雨の駅\n雨の日にだけ開く駅')
    await page.getByTestId('idea-save').click()
    await expect(cardsIn(none).nth(0).getByTestId('idea-lead')).toHaveText('雨の駅')

    // 編集中に閉じようとすると確認される
    await cardsIn(none).nth(0).getByTestId('idea-edit').click()
    await page.getByTestId('idea-body-input').fill('書きかけ')
    await page.getByTestId('idea-cancel').click()
    await expect(dialog(page).filter({ hasText: '編集中の内容を破棄しますか？' })).toBeVisible()
    await clickInDialog(page, '破棄する')
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(none).nth(0)).toContainText('雨の日にだけ開く駅')

    // 移動（今いる仕切りには印が付き、既定はほかの仕切りの末尾）
    await cardsIn(none).filter({ hasText: '記憶を売る古書店' }).getByTestId('idea-move').click()
    const options = page.getByTestId('idea-move-option')
    await expect(options).toHaveCount(2)
    await expect(page.locator('[data-testid="idea-move-option"][data-section="none"]')).toContainText('現在の場所')
    await page.locator(`[data-testid="idea-move-option"][data-section="${titleId}"]`).click()
    await page.getByTestId('idea-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsIn(target)).toHaveCount(1)
    await expect(cardsIn(target).nth(0)).toContainText('記憶を売る古書店')
    await expect(cardsIn(none)).toHaveCount(1)
    // 「この案でタイトルを作る」は「どのタイトルにも属さない」のアイデアだけ
    await expect(target.getByTestId('idea-make-title')).toHaveCount(0)
    await expect(none.getByTestId('idea-make-title')).toHaveCount(1)

    const stored = await ideasInData(page)
    expect(stored.find((i) => i.body.startsWith('記憶を売る古書店\n'))?.titleId).toBe(titleId)
    expect(stored.find((i) => i.body.startsWith('雨の駅\n'))?.titleId).toBeNull()
    expect(stored.map((i) => i.heading)).toEqual(['', ''])

    // 削除
    await cardsIn(target).nth(0).getByTestId('idea-delete').click()
    await expect(dialog(page)).toContainText('記憶を売る古書店')
    await clickInDialog(page, '削除')
    await expect(cardsIn(target)).toHaveCount(0)
    await expect(target.getByTestId('idea-section-empty')).toBeVisible()
  })

  test('アイデアを済みにすると斜線＋グレーで仕切りの下へ沈み、外すと済みでないものの末尾に戻る（削除とは別）', async ({
    page,
  }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      for (const body of ['案A', '案B', '案C']) actions.addIdea(null, '', body)
    })
    await showIdeas(page)
    const none = section(page, 'none')
    const texts = () => cardsIn(none).getByTestId('idea-body').allTextContents()
    const card = (text: string) => cardsIn(none).filter({ hasText: text })

    const boxA = card('案A').getByTestId('idea-check')
    await expect(boxA).toHaveAccessibleName('「案A」を済みにする')
    // 押せる大きさ（34px 以上）
    const tap = (await card('案A').locator('.idea-check').boundingBox())!
    expect(Math.min(tap.width, tap.height)).toBeGreaterThanOrEqual(34)
    await boxA.check()
    await expect.poll(texts).toEqual(['案B', '案C', '案A'])
    const done = card('案A')
    await expect(done).toHaveAttribute('data-checked', 'true')
    await expect(done.getByTestId('idea-check')).toBeChecked()
    await expect(done.getByTestId('idea-check')).toHaveAccessibleName('「案A」の済みを外す')
    // 斜線＋グレー。並べ替えのボタンは済みでないものだけ
    const look = await done.getByTestId('idea-body').evaluate((el) => {
      const s = getComputedStyle(el)
      return { line: s.textDecorationLine, color: s.color }
    })
    const openColor = await card('案B')
      .getByTestId('idea-body')
      .evaluate((el) => getComputedStyle(el).color)
    expect(look.line).toContain('line-through')
    expect(look.color).not.toBe(openColor)
    await expect(done.getByTestId('idea-up')).toHaveCount(0)
    await expect(done.getByTestId('idea-down')).toHaveCount(0)
    await expect(card('案C').getByTestId('idea-down')).toBeDisabled()
    await expect(none.getByTestId('idea-done-divider')).toHaveText('済み 1件')
    // 件数は済みも含めた数
    await expect(none.getByTestId('idea-section-count')).toHaveAttribute('data-count', '3')
    await expect(page.getByTestId('idea-total')).toHaveText('3')

    // 新しく済みにしたものから並ぶ。再読み込みしても同じ
    await card('案B').getByTestId('idea-check').check()
    await expect.poll(texts).toEqual(['案C', '案B', '案A'])
    await expect(none.getByTestId('idea-done-divider')).toHaveText('済み 2件')
    await page.reload()
    await showIdeas(page)
    await expect.poll(texts).toEqual(['案C', '案B', '案A'])

    // 外すと済みでないものの末尾へ戻る
    await card('案A').getByTestId('idea-check').uncheck()
    await expect.poll(texts).toEqual(['案C', '案A', '案B'])
    await expect(card('案A')).toHaveAttribute('data-checked', 'false')
    await expect(card('案A').getByTestId('idea-up')).toBeEnabled()
    const stored = await page.evaluate(() =>
      Object.values(window.__ns.getData().ideas).map((i) => ({ body: i.body, checked: i.checked, checkedAt: i.checkedAt })),
    )
    expect(stored.find((i) => i.body === '案A')).toEqual({ body: '案A', checked: false, checkedAt: null })
    expect(stored.find((i) => i.body === '案B')?.checked).toBe(true)

    // 削除は済みとは別（ゴミ箱へ）
    await card('案B').getByTestId('idea-delete').click()
    await clickInDialog(page, '削除')
    await expect.poll(texts).toEqual(['案C', '案A'])
    await expect(none.getByTestId('idea-done-divider')).toHaveCount(0)
    await noHorizontalScroll(page)
  })

  test('古い版で見出しを付けたアイデアは、見出しのまま表示し、編集して保存すると見出しを内容の1行目にまとめる', async ({
    page,
  }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    const id = await seed(page, ({ actions }) => actions.addIdea(null, '記憶を売る古書店', '客は記憶を売る。\n店主は読まない。'))
    await showIdeas(page)
    const card = cardsIn(section(page, 'none')).first()
    const stored = () => page.evaluate((i) => window.__ns.getData().ideas[i], id)
    await expect(card.getByTestId('idea-heading')).toHaveText('記憶を売る古書店')
    await expect(card.getByTestId('idea-lead')).toHaveCount(0)

    // 開くと見出しを1行目にまとめた内容。閉じただけでは変えない
    await card.getByTestId('idea-edit').click()
    await expect(page.getByTestId('idea-heading-input')).toHaveCount(0)
    await expect(page.getByTestId('idea-body-input')).toHaveValue('記憶を売る古書店\n客は記憶を売る。\n店主は読まない。')
    await expect(page.getByTestId('idea-heading-merged')).toContainText('見出しは内容の1行目に入れました')
    await page.getByTestId('idea-cancel').click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await stored()).toMatchObject({ heading: '記憶を売る古書店', body: '客は記憶を売る。\n店主は読まない。' })
    await expect(card.getByTestId('idea-heading')).toHaveText('記憶を売る古書店')

    // 保存すると見出しは空になり、内容の1行目になる
    await card.getByTestId('idea-edit').click()
    await page.getByTestId('idea-save').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(card.getByTestId('idea-heading')).toHaveCount(0)
    await expect(card.getByTestId('idea-lead')).toHaveText('記憶を売る古書店')
    expect(await stored()).toMatchObject({ heading: '', body: '記憶を売る古書店\n客は記憶を売る。\n店主は読まない。' })
    await noHorizontalScroll(page)
  })

  test('300件のアイデアがある仕切りでも、済みにするとすぐ下へ沈む', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      for (let i = 0; i < 300; i++) actions.addIdea(null, '', `案${i + 1}\n${'思いついたことのメモ。'.repeat(3)}`)
    })
    await showIdeas(page)
    const none = section(page, 'none')
    await expect(cardsIn(none)).toHaveCount(300)
    const target = cardsIn(none).nth(1)
    await expect(target.getByTestId('idea-lead')).toHaveText('案2')
    const ms = await target.getByTestId('idea-check').evaluate(async (el) => {
      const t0 = performance.now()
      ;(el as HTMLInputElement).click()
      const list = el.closest('ul')!
      while ((list.lastElementChild as HTMLElement | null)?.dataset.checked !== 'true')
        await new Promise((r) => requestAnimationFrame(r))
      return performance.now() - t0
    })
    await expect(cardsIn(none).last().getByTestId('idea-lead')).toHaveText('案2')
    await expect(cardsIn(none).nth(1).getByTestId('idea-lead')).toHaveText('案3')
    expect(ms).toBeLessThan(1500)
  })

  test('画面より長い仕切りで済みにしても、通知で知らせて移った先のカードを目立たせる（消えたように見えない）', async ({
    page,
  }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      for (let i = 0; i < 40; i++) actions.addIdea(null, '', `案${i + 1}`)
    })
    await showIdeas(page)
    const none = section(page, 'none')
    await expect(cardsIn(none)).toHaveCount(40)
    const id = await cardsIn(none).nth(1).getAttribute('data-idea-id')
    const moved = none.locator(`[data-testid="idea-card"][data-idea-id="${id}"]`)
    await expect(moved.getByTestId('idea-body')).toHaveText('案2')

    await moved.getByTestId('idea-check').check()
    await expect(page.locator('.toasts').getByText('「案2」を済みにしました（下の「済み」へ移しました）')).toBeVisible()
    await expect(page.locator('.toasts')).toHaveAttribute('aria-live', 'assertive')
    await expect(moved).toHaveClass(/is-revealed/)
    await expect(cardsIn(none).last()).toHaveAttribute('data-idea-id', id!)
    // 済みの所は画面の外（スクロールはしない）。通知がなければ消えたように見える
    await expect(moved).not.toBeInViewport()
    await expect(cardsIn(none).nth(1).getByTestId('idea-body')).toHaveText('案3')

    await moved.getByTestId('idea-check').uncheck()
    await expect(page.locator('.toasts').getByText('「案2」の済みを外しました（済みでないものの末尾へ戻しました）')).toBeVisible()
    await expect(moved).toHaveClass(/is-revealed/)
    await expect(moved).toHaveAttribute('data-checked', 'false')
    await expect(cardsIn(none).last()).toHaveAttribute('data-idea-id', id!)
    await noHorizontalScroll(page)
  })

  test('キーボードで続けて消し込める: 済みにするとフォーカスは空いた所に来たカードへ移り、画面の外へ行かない', async ({
    page,
  }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      for (let i = 0; i < 30; i++) actions.addIdea(null, '', `案${i + 1}`)
    })
    await showIdeas(page)
    const none = section(page, 'none')
    await expect(cardsIn(none)).toHaveCount(30)
    const box = (n: number) => cardsIn(none).nth(n).getByTestId('idea-check')

    await box(2).focus()
    await expect(cardsIn(none).nth(2).getByTestId('idea-body')).toHaveText('案3')
    await page.keyboard.press('Space')
    // 案3は済みの所（画面の外）へ。フォーカスは同じ位置に来た案4
    await expect(cardsIn(none).last().getByTestId('idea-body')).toHaveText('案3')
    await expect(box(2)).toBeFocused()
    await expect(box(2)).toHaveAccessibleName('「案4」を済みにする')
    await expect(box(2)).toBeInViewport()
    await page.keyboard.press('Space')
    await expect(box(2)).toBeFocused()
    await expect(box(2)).toHaveAccessibleName('「案5」を済みにする')
    await expect(none.getByTestId('idea-done-divider')).toHaveText('済み 2件')
    // Shift+Tab は画面に出ている1つ前のカードの操作へ（ページの下へ飛ばない）
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator(':focus')).toBeInViewport()
    await expect(cardsIn(none).nth(1).locator(':focus')).toHaveCount(1)
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

  test('タイトルの仕切りの「タイトルへ」でタイトル画面に入れる（「開く」は折りたたみの意味で使うので使わない）', async ({
    page,
  }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => actions.createTitle('星の海'))
    await showIdeas(page)
    const link = section(page, titleId).getByTestId('idea-section-open')
    await expect(link).toHaveText('タイトルへ')
    await expect(link).toHaveAccessibleName('タイトルへ（星の海）')
    await expect(section(page, 'none').getByTestId('idea-section-open')).toHaveCount(0)
    await noHorizontalScroll(page)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}$`))
    await expect(page.getByTestId('title-name')).toHaveValue('星の海')
  })

  test('Ctrl/⌘+Enter の案内は、指で操作する端末では横向きの広い画面でも出さない', async ({ page }, info) => {
    await openApp(page)
    const touch = info.project.name === 'mobile'
    // スマホの横向き（幅が 720px を超える）
    if (touch) await page.setViewportSize({ width: 844, height: 390 })
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(touch)
    await showIdeas(page)
    const hint = page.getByTestId('quick-idea-hint')
    await expect(hint).toHaveCount(1)
    if (touch) await expect(hint).toBeHidden()
    else await expect(hint).toHaveText(/^(Ctrl|⌘)\+Enter$/)
    await section(page, 'none').getByTestId('idea-add').click()
    const editorHint = dialog(page).getByTestId('idea-editor-hint')
    await expect(editorHint).toHaveCount(1)
    if (touch) await expect(editorHint).toBeHidden()
    else await expect(editorHint).toBeVisible()
  })

  test('原稿があるのにバックアップを書き出していない時は、ホームで書き出しを勧める（「後で」で7日間出さない）', async ({
    page,
  }) => {
    await openApp(page)
    const reminder = page.getByTestId('backup-reminder')
    // 原稿の本文がないうちは出さない
    const titleId = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の海')
      actions.addEpisode(t)
      actions.addIdea(null, '', 'アイデアだけ')
      return t
    })
    await expect(page.getByTestId('title-card')).toHaveCount(1)
    await expect(reminder).toHaveCount(0)

    await seed(
      page,
      ({ actions, getData }, id: string) => {
        const piece = Object.values(getData().pieces).find((p) => p.titleId === id)!
        actions.updateVersion(piece.versionIds[0], { body: '大切な本文' })
      },
      titleId,
    )
    await expect(reminder).toBeVisible()
    await expect(reminder).toContainText('この端末にだけ保存されています。バックアップを書き出しておきましょう')
    await expect(page.getByTestId('backup-reminder-last')).toHaveText('まだ一度も書き出していません')
    await noHorizontalScroll(page)

    // 「後で」: 消えて、押したボタンの代わりにタイトルの見出しへフォーカスが移る。再読み込みしても出ない
    await page.getByTestId('backup-reminder-later').click()
    await expect(reminder).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'タイトル', exact: true })).toBeFocused()
    await page.reload()
    await expect(page.getByTestId('title-card')).toHaveCount(1)
    await expect(reminder).toHaveCount(0)

    // 7日を過ぎるとまた出る。最後の書き出しが14日以上前の時も出す
    await page.evaluate(() => {
      const day = 24 * 60 * 60 * 1000
      localStorage.setItem('novel-studio:backup-reminder-snoozed', String(Date.now() - 8 * day))
      localStorage.setItem('novel-studio:last-backup', String(Date.now() - 20 * day))
    })
    await page.reload()
    await expect(reminder).toBeVisible()
    await expect(page.getByTestId('backup-reminder-last')).toHaveText(/^最後の書き出し: \d{4}\/\d{2}\/\d{2}$/)

    // 「書き出す」は設定画面と同じバックアップを書き出し、お知らせは消える
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('backup-reminder-export').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^novel-studio-backup-\d{8}-\d{4}\.json$/)
    const json = JSON.parse(await readFile(await download.path(), 'utf8')) as {
      app: string
      data: { versions: Record<string, { body: string }> }
    }
    expect(json.app).toBe('novel-studio')
    expect(Object.values(json.data.versions).map((v) => v.body)).toEqual(['大切な本文'])
    await expect(reminder).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'バックアップを書き出しました' })).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('title-card')).toHaveCount(1)
    await expect(reminder).toHaveCount(0)
    await openApp(page, '/settings')
    await expect(page.getByTestId('last-backup')).toContainText('最後に書き出した日時')
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
    await expect.poll(() => sectionNames(page)).toEqual(['灯台守の手紙', UNASSIGNED])
    await expect(cardsIn(section(page, titleId))).toHaveCount(1)
    await expect(cardsIn(section(page, 'none'))).toHaveCount(0)
  })

  test('「この案でタイトルを作る」の候補は、長い文でも「…」を付けずに文の区切りで切り、選択した状態で出す', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      actions.addIdea(
        null,
        '',
        '雨の日にだけ開く駅のホームで、少女は毎朝、来ないはずの列車を待ち続けている。そして十年が過ぎた。',
      )
    })
    await cardsIn(section(page, 'none')).nth(0).getByTestId('idea-make-title').click()
    const input = dialog(page).getByRole('textbox')
    const suggestion = '雨の日にだけ開く駅のホームで、少女は毎朝、来ないはずの列車を待ち続けている'
    await expect(input).toHaveValue(suggestion)
    await expect(input).not.toHaveValue(/…/)
    // そのまま打てば置き換えられるように、候補の文字は選択されている
    await expect
      .poll(() => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, suggestion.length])
    await page.keyboard.type('雨の駅')
    await expect(input).toHaveValue('雨の駅')
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
    await expect(dialog(page)).toContainText('すべての話・推敲バージョン・設定項目・戦略・メモ')
    await expect(dialog(page)).toContainText('をまとめてゴミ箱に移します')
    await expect(dialog(page)).toContainText('全2話')
    await expect(dialog(page)).toContainText('アイデア（2件）は削除されず、「どのタイトルにも属さない」へ移ります')
    await clickInDialog(page, '削除')
    await expect(page.getByTestId('title-card')).toHaveCount(1)
    await expect.poll(() => titleCardNames(page)).toEqual(['残る物語'])

    await showIdeas(page)
    await expect.poll(() => sectionNames(page)).toEqual(['残る物語', UNASSIGNED])
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
    // 「たった今に更新」ではなく「たった今更新」
    await expect(card.getByTestId('title-card-updated')).toHaveText('たった今更新')

    // 特殊ブロックは「話」に数えない
    await seed(
      page,
      ({ actions, getData }, a: { titleId: string; second: string }) => {
        const special = Object.values(getData().pieces).find((p) => p.titleId === a.titleId && p.kind === 'special')!
        actions.setActiveVersion(special.id, null)
      },
      { titleId, second: pieceIds[1] },
    )
    await expect(card.getByTestId('title-card-missing')).toHaveText('採用原稿なし 1話＋特殊1')
    await seed(
      page,
      ({ actions, getData }, second: string) => actions.setActiveVersion(second, getData().pieces[second].versionIds[0]),
      pieceIds[1],
    )
    await expect(card.getByTestId('title-card-missing')).toHaveText('採用原稿なし 特殊1')

    await card.getByTestId('title-card-link').click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}$`))
    await expect(page.getByTestId('title-name')).toHaveValue('星の海')
  })

  test('スマホ幅でも両方が上下に表示され（タイトルが先）、上部の切り替えで各領域の先頭へ移れる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openApp(page)
    await seed(page, ({ actions }) => {
      const ids = Array.from({ length: 8 }, (_, i) => actions.createTitle(`タイトル${i + 1}`))
      actions.updateTitle(ids[0], { synopsis: 'あらすじ' })
      actions.addIdea(ids[0], '', '星の海のアイデア')
      actions.addIdea(null, '', 'どこにも属さないアイデア')
    })
    const jumpTitles = page.getByTestId('home-jump-titles')
    const jumpIdeas = page.getByTestId('home-jump-ideas')
    await expect(jumpTitles).toContainText('8')
    await expect(jumpIdeas).toContainText('2')
    await expect(jumpTitles).toHaveAttribute('aria-current', 'true')
    // 両方とも表示されていて、タイトルが上、アイデアがその下
    await expect(page.getByTestId('title-group')).toBeVisible()
    await expect(page.getByTestId('idea-area')).toBeVisible()
    const titlesBox = await page.getByTestId('title-group').boundingBox()
    const ideasBox = await page.getByTestId('idea-area').boundingBox()
    expect(titlesBox && ideasBox && titlesBox.y + titlesBox.height <= ideasBox.y).toBeTruthy()
    // 小さめのカード: あらすじは省く
    await expect(page.getByTestId('title-card').first().locator('.home-title-synopsis')).toBeHidden()

    // 切り替えはスクロールして移るだけ（隠さない）
    const ideasHeading = page.getByRole('heading', { name: 'アイデア', level: 2 })
    await jumpIdeas.click()
    await expect(ideasHeading).toBeInViewport()
    await expect(ideasHeading).toBeFocused()
    await expect(jumpIdeas).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('title-group')).toBeVisible()
    await noHorizontalScroll(page)

    await jumpTitles.click()
    await expect(page.getByRole('heading', { name: 'タイトル', level: 2 })).toBeInViewport()
    await expect(jumpTitles).toHaveAttribute('aria-current', 'true')

    // 721px からは左右2列（切り替えなし）
    for (const width of [800, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(page.getByTestId('home-jump')).toHaveCount(0)
      const t = await page.getByTestId('title-group').boundingBox()
      const i = await page.getByTestId('idea-area').boundingBox()
      expect(t && i && t.x + t.width <= i.x).toBeTruthy()
      await expect(page.getByTestId('title-card').first().locator('.home-title-synopsis')).toBeVisible()
      await noHorizontalScroll(page)
    }
  })

  test('仕切りが多くても、仕切りの一覧から目的の仕切りへ移れ、すべて折りたたむ／開くができる', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      const ids = Array.from({ length: 15 }, (_, i) => actions.createTitle(`タイトル${i + 1}`))
      for (let i = 0; i < 100; i++) actions.addIdea(i < 95 ? ids[i % 15] : null, `案${i + 1}`, `本文${i + 1}`)
    })
    const index = page.getByTestId('idea-index')
    const chips = index.getByTestId('idea-index-chip')
    await expect(chips).toHaveCount(16)
    // 一番下にある「どのタイトルにも属さない」は一覧の先頭に置く
    await expect(chips.first()).toHaveAttribute('data-section', 'none')
    await expect(chips.first()).toContainText(UNASSIGNED)
    await expect(chips.first()).toContainText('5')
    await expect(chips.nth(1)).toContainText('タイトル1')
    await expect(chips.nth(1)).toContainText('7')
    await noHorizontalScroll(page)

    const none = section(page, 'none')
    await expect(none.getByTestId('idea-section-toggle')).not.toBeInViewport()
    await chips.first().click()
    await expect(none.getByTestId('idea-section-toggle')).toBeInViewport()
    await expect(none.getByTestId('idea-section-toggle')).toBeFocused()

    // すべて折りたたむ → 一覧から選ぶと、その仕切りは開いて表示される
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByTestId('idea-collapse-all').click()
    const toggles = page.getByTestId('idea-area').getByTestId('idea-section-toggle')
    await expect(toggles.and(page.locator('[aria-expanded="true"]'))).toHaveCount(0)
    await expect(page.getByTestId('idea-collapse-all')).toBeDisabled()
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(5000)
    const target = (await chips.nth(10).getAttribute('data-section'))!
    await chips.nth(10).click()
    await expect(section(page, target).getByTestId('idea-section-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(section(page, target).getByTestId('idea-section-toggle')).toBeInViewport()
    await expect(cardsIn(section(page, target)).first()).toBeVisible()
    // 折りたたみは覚えている
    await page.reload()
    await expect(toggles.and(page.locator('[aria-expanded="true"]'))).toHaveCount(1)
    await page.getByTestId('idea-expand-all').click()
    await expect(toggles.and(page.locator('[aria-expanded="false"]'))).toHaveCount(0)
    await expect(page.getByTestId('idea-expand-all')).toBeDisabled()
  })

  test('すばやく追加したら「表示」で追加したカードへ移り、少しの間目立たせる（折りたたんだ仕切りは開く）', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      const ids = Array.from({ length: 6 }, (_, i) => actions.createTitle(`タイトル${i + 1}`))
      for (let i = 0; i < 40; i++) actions.addIdea(ids[i % 6], `案${i + 1}`, `本文${i + 1}`)
    })
    await section(page, 'none').getByTestId('idea-section-toggle').click()
    await expect(section(page, 'none').getByTestId('idea-section-toggle')).toHaveAttribute('aria-expanded', 'false')
    await page.evaluate(() => window.scrollTo(0, 0))

    const input = page.getByTestId('quick-idea-input')
    await input.fill('灯台守の少女')
    await input.press('Control+Enter')
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await expect(page.getByTestId('quick-idea-status')).toContainText(`「${UNASSIGNED}」に追加しました`)
    const card = cardsIn(section(page, 'none')).filter({ hasText: '灯台守の少女' })
    await expect(card).toHaveCount(1)
    await expect(card).toBeHidden()

    await page.getByTestId('quick-idea-show').click()
    await expect(section(page, 'none').getByTestId('idea-section-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(card).toBeInViewport()
    await expect(card).toHaveClass(/is-revealed/)
    await expect(card).toBeFocused()
    await expect(page.getByTestId('quick-idea-show')).toHaveCount(0)
    await expect(card).not.toHaveClass(/is-revealed/, { timeout: 5000 })
  })

  test('ほかの画面から「戻る」と、ホームのスクロール位置に戻る', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions }) => {
      const ids = Array.from({ length: 6 }, (_, i) => actions.createTitle(`タイトル${i + 1}`))
      for (let i = 0; i < 60; i++) actions.addIdea(ids[i % 6], `案${i + 1}`, `本文${i + 1}`)
    })
    const open = page.getByTestId('idea-area').locator('.idea-section-open').nth(4)
    await open.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
    await page.waitForTimeout(300)
    const before = await page.evaluate(() => window.scrollY)
    await open.click()
    await expect(page.getByTestId('title-name')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.goBack()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 5)
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(before + 5)

    // 新しく開いた時（リンク）は先頭から
    await page.getByRole('link', { name: 'アプリの設定・バックアップ' }).click()
    await expect(page.getByTestId('app-settings')).toBeVisible()
    await goHome(page)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('↑↓で並べ替えても動かしたカードは指の下に残り、続けて押すとそのまま動かし続けられる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の海')
      for (let i = 0; i < 6; i++) actions.addIdea(t, `案${i + 1}`, `本文${i + 1}`)
      // 下にスクロールできる余地を作る
      for (let i = 0; i < 30; i++) actions.addIdea(null, '', `どこにも属さない${i + 1}`)
      return t
    })
    const sec = section(page, titleId)
    const headings = () => sec.getByTestId('idea-heading').allTextContents()
    await cardsIn(sec).nth(1).scrollIntoViewIfNeeded()
    // 同じ場所を3回押すと、同じカードが3つ下へ動く（押した位置にカードが残る）
    const down = (await cardsIn(sec).nth(0).getByTestId('idea-down').boundingBox())!
    const expected = [
      ['案2', '案1', '案3', '案4', '案5', '案6'],
      ['案2', '案3', '案1', '案4', '案5', '案6'],
      ['案2', '案3', '案4', '案1', '案5', '案6'],
    ]
    for (const order of expected) {
      await page.mouse.click(down.x + down.width / 2, down.y + down.height / 2)
      await expect.poll(headings).toEqual(order)
    }
    const moved = cardsIn(sec).filter({ hasText: '案1' })
    const after = (await moved.getByTestId('idea-down').boundingBox())!
    expect(Math.abs(after.y - down.y)).toBeLessThan(2)
    await expect(moved.getByTestId('idea-down')).toBeFocused()

    // キーボードでも続けて動かせる。端に着いて押せなくなったら反対向きのボタンにフォーカスが移る
    await page.keyboard.press('Enter')
    await expect.poll(headings).toEqual(['案2', '案3', '案4', '案5', '案1', '案6'])
    await page.keyboard.press('Enter')
    await expect.poll(headings).toEqual(['案2', '案3', '案4', '案5', '案6', '案1'])
    await expect(moved.getByTestId('idea-down')).toBeDisabled()
    await expect(moved.getByTestId('idea-up')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(headings).toEqual(['案2', '案3', '案4', '案5', '案1', '案6'])
    await expect(moved.getByTestId('idea-up')).toBeFocused()

    // タイトルも同じ
    await seed(page, ({ actions }) => {
      for (let i = 0; i < 4; i++) actions.createTitle(`追加${i + 1}`)
    })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByTestId('titles-edit-toggle').click()
    const tdown = (await page.getByTestId('title-card').nth(0).getByTestId('title-down').boundingBox())!
    await page.mouse.click(tdown.x + tdown.width / 2, tdown.y + tdown.height / 2)
    await expect.poll(() => titleCardNames(page)).toEqual(['追加1', '星の海', '追加2', '追加3', '追加4'])
    await page.mouse.click(tdown.x + tdown.width / 2, tdown.y + tdown.height / 2)
    await expect.poll(() => titleCardNames(page)).toEqual(['追加1', '追加2', '星の海', '追加3', '追加4'])
    await expect(page.getByTestId('title-card').nth(2).getByTestId('title-down')).toBeFocused()
  })

  test('位置を選んで移動: タイトルの並びと、アイデアの移動先の仕切り・その中の位置を選べる', async ({ page }) => {
    await openApp(page)
    const { a, b } = await seed(page, ({ actions }) => {
      const a = actions.createTitle('星の海')
      const b = actions.createTitle('風の街')
      actions.createTitle('無人駅')
      for (const h of ['A1', 'A2', 'A3']) actions.addIdea(a, h, '')
      for (const h of ['B1', 'B2']) actions.addIdea(b, h, '')
      return { a, b }
    })
    // タイトル: 先頭を末尾へ
    await page.getByTestId('titles-edit-toggle').click()
    await page.getByTestId('title-card').nth(0).getByTestId('title-move').click()
    const target = page.getByTestId('title-move-target')
    await expect(target.locator('option')).toHaveText([
      '先頭（「風の街」の前）（現在の位置）',
      '「風の街」の後',
      '末尾（「無人駅」の後）',
    ])
    await expect(page.getByTestId('title-move-submit')).toBeDisabled()
    await target.selectOption({ label: '末尾（「無人駅」の後）' })
    await page.getByTestId('title-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => titleCardNames(page)).toEqual(['風の街', '無人駅', '星の海'])
    await expect.poll(() => sectionNames(page)).toEqual(['風の街', '無人駅', '星の海', UNASSIGNED])

    // アイデア: 別の仕切りの先頭へ（既定は末尾）
    await cardsIn(section(page, a)).filter({ hasText: 'A3' }).getByTestId('idea-move').click()
    await page.locator(`[data-testid="idea-move-option"][data-section="${b}"]`).click()
    const position = page.getByTestId('idea-move-position')
    await expect(position).toHaveValue('2')
    await expect(position.locator('option')).toHaveText(['先頭（「B1」の前）', '「B1」の後', '末尾（「B2」の後）'])
    await position.selectOption({ label: '先頭（「B1」の前）' })
    await expect(page.getByTestId('idea-move-summary')).toContainText('「風の街」の先頭（「B1」の前）に入ります')
    await page.getByTestId('idea-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => section(page, b).getByTestId('idea-heading').allTextContents()).toEqual(['A3', 'B1', 'B2'])

    // 同じ仕切りの中で位置だけ変える
    await cardsIn(section(page, a)).filter({ hasText: 'A1' }).getByTestId('idea-move').click()
    const current = page.locator(`[data-testid="idea-move-option"][data-section="${a}"]`)
    await expect(current).toContainText('現在の場所')
    await current.click()
    await expect(position.locator('option')).toHaveText(['先頭（「A2」の前）（現在の位置）', '末尾（「A2」の後）'])
    await page.getByTestId('idea-move-submit').click()
    await expect.poll(() => section(page, a).getByTestId('idea-heading').allTextContents()).toEqual(['A2', 'A1'])
    // 現在の位置を選ぶと移動できない
    await cardsIn(section(page, a)).filter({ hasText: 'A1' }).getByTestId('idea-move').click()
    await current.click()
    await expect(page.getByTestId('idea-move-submit')).toBeDisabled()
    await expect(page.getByTestId('idea-move-summary')).toContainText('現在の位置です')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    // 済みのアイデアは位置を選ばずに移る（移動先でも済みのまま下にまとまる）。位置の候補には済みのアイデアを数えない
    await cardsIn(section(page, a)).filter({ hasText: 'A2' }).getByTestId('idea-check').check()
    await cardsIn(section(page, a)).filter({ hasText: 'A2' }).getByTestId('idea-move').click()
    await expect(page.getByTestId('idea-move-position')).toHaveCount(0)
    await page.locator(`[data-testid="idea-move-option"][data-section="${a}"]`).click()
    await expect(page.getByTestId('idea-move-submit')).toBeDisabled()
    await page.locator(`[data-testid="idea-move-option"][data-section="${b}"]`).click()
    await expect(page.getByTestId('idea-move-summary')).toContainText('「風の街」に移ります。済みのまま')
    await page.getByTestId('idea-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => section(page, b).getByTestId('idea-heading').allTextContents()).toEqual(['A3', 'B1', 'B2', 'A2'])
    await expect(cardsIn(section(page, b)).last()).toHaveAttribute('data-checked', 'true')
    await cardsIn(section(page, b)).filter({ hasText: 'B1' }).getByTestId('idea-move').click()
    await page.locator(`[data-testid="idea-move-option"][data-section="${b}"]`).click()
    await expect(position.locator('option')).toHaveText(['先頭（「A3」の前）', '「A3」の後（現在の位置）', '末尾（「B2」の後）'])
  })

  test('追加・編集ダイアログの書きかけは、戻る操作やアプリを閉じた後も同じダイアログを開くと復元される', async ({ page }) => {
    // 設定画面からホームへ来て、ダイアログを開いたまま「戻る」→「進む」
    await openApp(page, '/settings')
    const titleId = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の海')
      actions.addIdea(t, '既存の案', '元の本文')
      return t
    })
    await goHome(page)
    const none = section(page, 'none')
    await none.getByTestId('idea-add').click()
    await page.getByTestId('idea-body-input').fill('大事な思いつき')
    await page.goBack()
    await expect(page.getByTestId('app-settings')).toBeVisible()
    await page.goForward()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(dialog(page)).toHaveCount(0)
    await none.getByTestId('idea-add').click()
    await expect(page.getByTestId('idea-draft-restored')).toContainText('下書きを復元しました')
    await expect(page.getByTestId('idea-body-input')).toHaveValue('大事な思いつき')

    // アプリを閉じた（再読み込み）後も残っている。ほかの仕切りの追加には出ない
    await page.reload()
    await expect(page.getByTestId('home')).toBeVisible()
    await section(page, titleId).getByTestId('idea-add').click()
    await expect(page.getByTestId('idea-draft-restored')).toHaveCount(0)
    await expect(page.getByTestId('idea-body-input')).toHaveValue('')
    await page.getByTestId('idea-cancel').click()
    await none.getByTestId('idea-add').click()
    await expect(page.getByTestId('idea-draft-restored')).toBeVisible()
    await expect(page.getByTestId('idea-body-input')).toHaveValue('大事な思いつき')
    // 保存すると下書きは消える
    await page.getByTestId('idea-save').click()
    await expect(cardsIn(none)).toHaveCount(1)
    await none.getByTestId('idea-add').click()
    await expect(page.getByTestId('idea-draft-restored')).toHaveCount(0)
    await expect(page.getByTestId('idea-body-input')).toHaveValue('')
    await page.getByTestId('idea-cancel').click()

    // 編集: 再読み込みしても書きかけが戻る。「下書きを破棄して元に戻す」で元の内容に戻る
    // （古い版で見出しを付けたアイデアなので、見出しを1行目にまとめた内容で開く）
    await cardsIn(section(page, titleId)).first().getByTestId('idea-edit').click()
    await expect(page.getByTestId('idea-body-input')).toHaveValue('既存の案\n元の本文')
    await page.getByTestId('idea-body-input').fill('既存の案\n直しかけの本文')
    await page.reload()
    await cardsIn(section(page, titleId)).first().getByTestId('idea-edit').click()
    await expect(page.getByTestId('idea-draft-restored')).toBeVisible()
    await expect(page.getByTestId('idea-body-input')).toHaveValue('既存の案\n直しかけの本文')
    await page.getByTestId('idea-draft-discard').click()
    await expect(page.getByTestId('idea-body-input')).toHaveValue('既存の案\n元の本文')
    await expect(page.getByTestId('idea-draft-restored')).toHaveCount(0)
    await page.getByTestId('idea-cancel').click()
    await expect(dialog(page)).toHaveCount(0)
    const drafts = () =>
      page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('novel-studio:idea-modal-draft:')))
    expect(await drafts()).toEqual([])

    // 破棄を確認して閉じても消える
    await none.getByTestId('idea-add').click()
    await page.getByTestId('idea-body-input').fill('やっぱりやめる')
    expect(await drafts()).toHaveLength(1)
    await page.getByTestId('idea-cancel').click()
    await clickInDialog(page, '破棄する')
    expect(await drafts()).toEqual([])
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
    await page.getByTestId('idea-move-submit').click()
    await expect(cardsIn(tab)).toHaveCount(3)
    // 「どのタイトルにも属さない」へ移動
    await cardsIn(tab).nth(0).getByTestId('idea-move').click()
    await page.locator('[data-testid="idea-move-option"][data-section="none"]').click()
    await page.getByTestId('idea-move-submit').click()
    await expect(cardsIn(tab)).toHaveCount(2)
    const stored = await ideasInData(page)
    expect(stored.filter((i) => i.titleId === a).map((i) => i.body)).toEqual(['星の海の案3', '星の海の案4'])
    expect(stored.find((i) => i.heading === '案2')?.titleId).toBe(b)
    expect(stored.find((i) => i.heading === '案1')?.titleId).toBeNull()

    // 済みにすると、タイトルのアイデアタブでも下へ沈む。外すと済みでないものの末尾へ
    await cardsIn(tab).nth(0).getByTestId('idea-check').check()
    await expect.poll(() => cardsIn(tab).getByTestId('idea-body').allTextContents()).toEqual(['星の海の案4', '星の海の案3'])
    await expect(cardsIn(tab).nth(1)).toHaveAttribute('data-checked', 'true')
    await expect(tab.getByTestId('idea-done-divider')).toHaveText('済み 1件')
    await expect(cardsIn(tab).nth(0).getByTestId('idea-down')).toBeDisabled()
    await cardsIn(tab).nth(1).getByTestId('idea-check').uncheck()
    await expect.poll(() => cardsIn(tab).getByTestId('idea-body').allTextContents()).toEqual(['星の海の案4', '星の海の案3'])
    await expect(tab.getByTestId('idea-done-divider')).toHaveCount(0)
    await noHorizontalScroll(page)

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
    await expect(page).toHaveTitle('アプリの設定 — Novel Studio')
    await expect(page.getByRole('navigation', { name: '現在地' })).toContainText('アプリの設定')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('アプリの設定')
    const html = page.locator('html')

    await page.getByTestId('theme-dark').click()
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('theme-white').click()
    await expect(html).toHaveAttribute('data-theme', 'white')
    await page.getByTestId('theme-system').click()
    // 端末の設定（テストではライト）に合わせる
    await expect(html).toHaveAttribute('data-theme', 'white')
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
    const text = await readFile(file, 'utf8')
    // 小さいデータは読みやすいようにインデントを付ける
    expect(text).toContain('\n  "app": "novel-studio"')
    const json = JSON.parse(text) as {
      app: string
      schemaVersion: number
      data: {
        titles: Record<string, { name: string }>
        versions: Record<string, { body: string }>
        ideas: Record<string, { heading: string }>
      }
    }
    expect(json.app).toBe('novel-studio')
    expect(json.schemaVersion).toBe(2)
    expect(Object.values(json.data.titles).map((t) => t.name)).toEqual(['バックアップの星'])
    expect(Object.values(json.data.versions).map((v) => v.body)).toEqual(['大切な本文'])
    expect(Object.values(json.data.ideas).map((i) => i.heading)).toEqual(['控えの案'])
    await expect(page.getByTestId('last-backup')).toContainText('最後に書き出した日時')
    // 件数に内部の表（応募時の原稿の控え）は出さない
    await expect(page.getByTestId('data-counts')).not.toContainText('控え')
  })

  test('大きいデータはインデントなしで書き出し、書き出している間は「書き出し中…」と表示する', async ({ page }) => {
    await openApp(page)
    await seed(page, ({ actions, getData }) => {
      const t = actions.createTitle('大長編')
      for (let i = 0; i < 3; i++) {
        const id = actions.addEpisode(t)
        actions.updateVersion(getData().pieces[id].versionIds[0], { body: `${'あ'.repeat(400_000)}${i + 1}` })
      }
    })
    await openApp(page, '/settings')
    const button = page.getByTestId('export-backup')
    // すぐに終わることもあるので、ボタンの表記の移り変わりを記録しておく
    await button.evaluate((el) => {
      const w = window as unknown as { __exportLabels: string[] }
      w.__exportLabels = []
      new MutationObserver(() => w.__exportLabels.push(el.textContent ?? '')).observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    })
    const downloadPromise = page.waitForEvent('download')
    await button.click()
    const download = await downloadPromise
    const text = await readFile(await download.path(), 'utf8')
    expect(text.startsWith('{"app":"novel-studio","schemaVersion":2,"exportedAt":"')).toBe(true)
    expect(text).not.toContain('\n')
    const json = JSON.parse(text) as { data: { versions: Record<string, { body: string }> } }
    expect(
      Object.values(json.data.versions)
        .map((v) => v.body.slice(-1))
        .sort(),
    ).toEqual(['1', '2', '3'])
    expect(Object.values(json.data.versions).every((v) => v.body.length === 400_001)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { __exportLabels: string[] }).__exportLabels)).toContain('書き出し中…')
    await expect(button).toHaveText('バックアップを書き出す')
    await expect(page.getByRole('status').filter({ hasText: 'バックアップを書き出しました' })).toBeVisible()
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
    await expect(confirm).toContainText('表示の設定（外観・文字サイズなど）は残ります')
    await seedLocalState(page)
    await clickInDialog(page, '置き換えて復元')
    await expect(page.getByRole('status').filter({ hasText: 'バックアップから復元しました' })).toBeVisible()
    expect(await page.evaluate(() => Object.values(window.__ns.getData().titles).map((t) => t.name))).toEqual(['復元された物語'])
    expect(await page.evaluate(() => Object.keys(window.__ns.getData().pieces).length)).toBe(0)
    // 以前のデータ向けの書きかけ・折りたたみ・復旧用の控えは消え、表示の設定と最後に書き出した日時は残る
    expect(await appLocalKeys(page)).toEqual(['novel-studio:last-backup', 'novel-studio:prefs'])
    expect(await page.evaluate(() => localStorage.getItem('other-app:keep'))).toBe('1')

    // 再読み込みしても復元後のデータ
    await page.reload()
    await expect(page.getByTestId('data-counts')).toContainText('タイトル1')
    await goHome(page)
    await showTitles(page)
    await expect.poll(() => titleCardNames(page)).toEqual(['復元された物語'])
    await showIdeas(page)
    await expect.poll(() => sectionNames(page)).toEqual(['復元された物語', UNASSIGNED])
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

    // 書きかけ・折りたたみ・ほかのタブの復旧用の控え（消したはずのタイトルを含む）も消える
    await page.getByTestId('theme-dark').click()
    await seedLocalState(page)
    await page.reload()
    await expect(page.getByTestId('last-backup')).toContainText('最後に書き出した日時')
    await page.evaluate(() => {
      const ts = Date.now()
      const ghost = {
        id: 'ghost',
        name: '消したはずのタイトル',
        synopsis: '',
        chaptersEnabled: false,
        numbering: 'continuous',
        structure: [],
        strategyNote: '',
        order: 5,
        createdAt: ts,
        updatedAt: ts,
      }
      localStorage.setItem('novel-studio:recovery:other-tab', JSON.stringify({ at: ts, puts: { titles: [ghost] }, dels: {} }))
    })
    await page.getByTestId('delete-all').click()
    await expect(dialog(page)).toContainText('表示の設定（外観・文字サイズなど）は残ります')
    await clickInDialog(page, '削除へ進む')
    await dialog(page).getByRole('textbox').fill('削除')
    await clickInDialog(page, 'すべて削除')
    await expect(page.getByRole('status').filter({ hasText: 'すべてのデータを削除しました' })).toBeVisible()
    expect(await page.evaluate(() => Object.keys(window.__ns.getData().titles).length)).toBe(0)
    expect(await appLocalKeys(page)).toEqual(['novel-studio:prefs'])
    expect(await page.evaluate(() => localStorage.getItem('other-app:keep'))).toBe('1')
    await expect(page.getByTestId('last-backup')).toContainText('まだバックアップを書き出していません')
    await page.reload()
    await expect(page.getByTestId('data-counts')).toContainText('タイトル0')
    // 表示の設定は残っている
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await goHome(page)
    await expect(page.getByTestId('titles-empty')).toBeVisible()
    await expect(page.getByTestId('quick-idea-input')).toHaveValue('')
    await expect(section(page, 'none').getByTestId('idea-section-toggle')).toHaveAttribute('aria-expanded', 'true')
    await section(page, 'none').getByTestId('idea-add').click()
    await expect(page.getByTestId('idea-body-input')).toHaveValue('')
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
        synopsis:
          '廃墟となった図書館で、司書の少女と記憶をなくした青年が、失われた物語を一冊ずつ取り戻していく。静かな夜と古い紙の匂いの物語。',
      })
      const bodies = [
        '　月の光が、崩れた天窓から斜めに差し込んでいた。',
        '　青年が目を覚ましたのは、書架と書架のあいだだった。',
        '　「この図書館には、まだ読まれていない物語が眠っているの」',
      ]
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
        Array.from({ length: 9 }, (_, i) => `・伏線${i + 1}: 天窓、栞、止まった時計、読めない題名のどれかと結びつける`).join(
          '\n',
        ),
      )
      // 済み（没にした案）は斜線＋グレーで下へ
      actions.setIdeaChecked(actions.addIdea(a, '', '青年の正体は最初の司書だった\n読者に早く気づかれすぎるので没'), true)
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
      await shot(scheme, true)
      if (project === 'mobile') {
        await page.getByTestId('home-jump-ideas').click()
        await shot(`ideas-${scheme}`)
        await page.getByTestId('home-jump-titles').click()
      }
      await showTitles(page)
      await page.getByTestId('titles-edit-toggle').click()
      await shot(`titles-edit-${scheme}`)
      await page.getByTestId('title-card').nth(1).getByTestId('title-move').click()
      await shot(`title-move-${scheme}`)
      await page.keyboard.press('Escape')
      await page.getByTestId('titles-edit-toggle').click()

      await showIdeas(page)
      await page.getByTestId('quick-idea-input').fill('ふと思いついた台詞')
      await page.getByTestId('quick-idea-add').click()
      await page.getByTestId('quick-capture').scrollIntoViewIfNeeded()
      await shot(`quick-added-${scheme}`)
      await page.getByTestId('quick-idea-show').click()
      await shot(`quick-revealed-${scheme}`)
      await cardsIn(section(page, 'none')).last().getByTestId('idea-delete').click()
      await clickInDialog(page, '削除')

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
