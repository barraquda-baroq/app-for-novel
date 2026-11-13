// アイデアのフォルダ（2.9）の E2E テスト: 作る・名前を変える・並べ替える・削除してゴミ箱から戻す、2段目（日付から始まる名前）、
// フォルダを移す（ほかの1段目へ・1段目にする・1段目をほかの1段目の中へ）、カードをフォルダへ出し入れする、選んで移す、
// 移した後にカードを見せるのは一度だけ、スマホの上の切り替えと選んで移すの帯の重なり、開け閉めを覚える、Claude が作ったフォルダの印、
// 360px の幅。
import { expect, test, type Locator, type Page } from '@playwright/test'
import { homeBandToggle, noHorizontalScroll, openApp, openHomeBands, seed, tapSize } from './helpers'
import type { AppData, Idea, IdeaFolder } from '../src/domain/types'

const UNASSIGNED = 'どのタイトルにも属さない'

function dialog(page: Page): Locator {
  return page.getByRole('dialog')
}

function section(page: Page, key: string): Locator {
  return page.locator(`[data-testid="idea-section"][data-section="${key}"]`)
}

/** 名前（そのままの文字）でフォルダを探す */
function folder(scope: Locator, name: string): Locator {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return scope
    .getByTestId('idea-folder-name')
    .filter({ hasText: exact })
    .first()
    .locator('xpath=ancestor::section[@data-testid="idea-folder"][1]')
}

function folderById(page: Page, id: string): Locator {
  return page.locator(`[data-testid="idea-folder"][data-folder-id="${id}"]`)
}

/** フォルダの見出しの部品（中のフォルダの見出しを含めない） */
function head(f: Locator, testId: string): Locator {
  return f.locator(`:scope > .idea-folder-head [data-testid="${testId}"]`)
}

/** その入れ物（フォルダ）にじかに入っているカード */
function cardsDirectlyIn(f: Locator): Locator {
  return f.locator(':scope > .idea-folder-body > .idea-list > [data-testid="idea-card"]')
}

/** 仕切りのフォルダの外のカード */
function looseCards(s: Locator): Locator {
  return s.locator(':scope > .idea-section-body > .idea-list > [data-testid="idea-card"]')
}

/** 1つの入れ物のフォルダの名前（並び順） */
function folderNames(scope: Locator): Promise<string[]> {
  return scope.evaluate((el) => {
    const box = el.matches('[data-testid="idea-folder"]')
      ? el.querySelector(':scope > .idea-folder-body > .idea-folders')
      : el.querySelector('[data-testid="idea-folders"]')
    if (!box) return []
    return [...box.querySelectorAll(':scope > [data-testid="idea-folder"]')].map(
      (f) => f.querySelector(':scope > .idea-folder-head [data-testid="idea-folder-name"]')?.textContent ?? '',
    )
  })
}

async function openMenu(page: Page, f: Locator): Promise<Locator> {
  // メニューはスクロールすると閉じる。ボタンが画面の端（スマホの上の切り替え・下端）に半分かかっていると、押してフォーカスが
  // 移った時のスクロールで、開いたメニューがすぐ閉じてしまうので、先に画面の中ほどへ出して、描画を待ってから押す
  const button = head(f, 'idea-folder-menu')
  await button.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await button.click()
  const menu = page.getByTestId('idea-folder-menu-popup')
  await expect(menu).toBeVisible()
  return menu
}

async function toast(page: Page, text: string): Promise<void> {
  await expect(page.locator('.toasts').getByText(text, { exact: true })).toBeVisible()
}

/** 日本時間の今日（「2026/11/13」） */
function today(): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  )
}

/** Claude がコネクタで作ったアイデア（cy-…）・フォルダ（cf-…）を、同期で届いたことにして入れる */
async function putClaudeRecords(page: Page, ideas: Partial<Idea>[], folders: Partial<IdeaFolder>[] = []): Promise<void> {
  await page.evaluate(
    async ({ ideas, folders }) => {
      const ns = window.__ns
      const data = ns.getData()
      const now = Date.now()
      const nextIdeas = { ...data.ideas }
      ideas.forEach((p, i) => {
        nextIdeas[p.id!] = {
          titleId: null,
          heading: '',
          body: '',
          checked: false,
          checkedAt: null,
          order: -100 + i,
          source: 'claude',
          v: 1,
          claudeHash: 'x',
          createdAt: now,
          updatedAt: now,
          ...p,
        } as Idea
      })
      const nextFolders = { ...data.ideaFolders }
      folders.forEach((p) => {
        nextFolders[p.id!] = {
          titleId: null,
          parentId: null,
          name: '',
          order: -1,
          source: 'claude',
          v: 1,
          createdAt: now,
          updatedAt: now,
          ...p,
        } as IdeaFolder
      })
      await ns.replaceAllData({ ...data, ideas: nextIdeas, ideaFolders: nextFolders } as AppData)
    },
    { ideas, folders },
  )
}

test.describe('アイデアのフォルダ', () => {
  test('作る・名前を変える・並べ替える・中に足す（済みはフォルダの中で沈む）・削除するとゴミ箱の1件になり、中のカードと一緒に戻る', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page, 'ideas')
    await seed(page, ({ actions }) => actions.addIdea(null, '', 'フォルダの外の案'))
    const none = section(page, 'none')

    // 作る（ホームのフォルダの名前は Claude にも見えることを添える）
    await none.getByTestId('idea-folder-create').click()
    await expect(dialog(page).getByRole('heading', { name: 'フォルダを作る' })).toBeVisible()
    await expect(dialog(page)).toContainText('フォルダの名前（40字まで）')
    await expect(dialog(page)).toContainText('Claude と連携していると Claude にも見えます')
    await expect(page.getByTestId('prompt-ok')).toBeDisabled()
    await page.getByTestId('prompt-input').fill('新作の相談')
    await page.getByTestId('prompt-ok').click()
    await toast(page, 'フォルダ「新作の相談」を作りました')
    const shinsaku = folder(none, '新作の相談')
    await expect(shinsaku).toHaveAttribute('data-depth', '1')
    await expect(head(shinsaku, 'idea-folder-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(head(shinsaku, 'idea-folder-toggle')).toBeFocused()
    await expect(shinsaku.getByTestId('idea-folder-empty')).toContainText('まだカードはありません。')
    // フォルダは上、フォルダの外のカードはその下
    await expect(none.getByTestId('idea-card')).toHaveCount(1)
    const order = await none.evaluate((el) => {
      const f = el.querySelector('[data-testid="idea-folder"]')!
      const c = el.querySelector('[data-testid="idea-card"]')!
      return Boolean(f.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)

    // 新しく作ったフォルダは上に入る
    await none.getByTestId('idea-folder-create').click()
    await page.getByTestId('prompt-input').fill('場面の相談')
    await page.getByTestId('prompt-ok').click()
    await expect.poll(() => folderNames(none)).toEqual(['場面の相談', '新作の相談'])

    // 同じ段に同じ名前（字の幅・空白の違いは同じ。前後の全角の空白は除く）は作れない
    await none.getByTestId('idea-folder-create').click()
    await page.getByTestId('prompt-input').fill('\u3000新作の相談')
    await expect(page.getByTestId('prompt-problem')).toHaveText('同じ名前のフォルダがもうあります')
    await expect(page.getByTestId('prompt-ok')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    // 名前を変える（今の名前を選んだ状態で開く）
    const bamen = folder(none, '場面の相談')
    let menu = await openMenu(page, bamen)
    await expect(menu.getByTestId('idea-folder-up')).toBeDisabled()
    await menu.getByTestId('idea-folder-rename').click()
    await expect(dialog(page).getByRole('heading', { name: 'フォルダの名前を変える' })).toBeVisible()
    const input = page.getByTestId('prompt-input')
    await expect(input).toHaveValue('場面の相談')
    await expect
      .poll(() => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, '場面の相談'.length])
    await page.keyboard.type('場面の相談（第1部）')
    await page.getByTestId('prompt-ok').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => folderNames(none)).toEqual(['場面の相談（第1部）', '新作の相談'])

    // 並べ替え（「下へ」。端では押せない）
    menu = await openMenu(page, folder(none, '場面の相談（第1部）'))
    await menu.getByTestId('idea-folder-down').click()
    await expect.poll(() => folderNames(none)).toEqual(['新作の相談', '場面の相談（第1部）'])
    menu = await openMenu(page, folder(none, '場面の相談（第1部）'))
    await expect(menu.getByTestId('idea-folder-down')).toBeDisabled()
    await expect(menu.getByTestId('idea-folder-up')).toBeEnabled()
    await page.keyboard.press('Escape')

    // フォルダに足す（追加先は「仕切り › フォルダ」）
    await head(shinsaku, 'idea-folder-add').click()
    await expect(dialog(page).locator('.idea-editor-place-name')).toHaveText(`${UNASSIGNED} › 新作の相談`)
    await page.getByTestId('idea-body-input').fill('港町の少女')
    await page.getByTestId('idea-save').click()
    await toast(page, '「新作の相談」にアイデアを追加しました')
    await head(shinsaku, 'idea-folder-add').click()
    await page.getByTestId('idea-body-input').fill('灯台の手紙')
    await page.getByTestId('idea-save').click()
    await expect(cardsDirectlyIn(shinsaku)).toHaveCount(2)
    await expect(head(shinsaku, 'idea-folder-count')).toHaveAttribute('data-count', '2')
    // 済みはそのフォルダの中で下へ沈む（仕切りのフォルダの外の並びは変わらない）
    const texts = () => cardsDirectlyIn(shinsaku).getByTestId('idea-body').allTextContents()
    await expect.poll(texts).toEqual(['港町の少女', '灯台の手紙'])
    await cardsDirectlyIn(shinsaku).filter({ hasText: '港町の少女' }).getByTestId('idea-check').check()
    await expect.poll(texts).toEqual(['灯台の手紙', '港町の少女'])
    await expect(shinsaku.getByTestId('idea-done-divider')).toHaveText('済み 1件')
    await expect(head(shinsaku, 'idea-folder-count')).toHaveAttribute('title', '2件（うち済み 1件）')
    await expect(none.getByTestId('idea-section-count')).toHaveAttribute('data-count', '3')

    // 削除: 中のカードも一緒にゴミ箱の1件へ
    menu = await openMenu(page, shinsaku)
    await menu.getByTestId('idea-folder-delete').click()
    await expect(dialog(page)).toContainText('フォルダを削除しますか？')
    await expect(dialog(page)).toContainText('フォルダ「新作の相談」と、中のカード2件を')
    await dialog(page).getByRole('button', { name: '削除', exact: true }).click()
    await toast(page, 'フォルダ「新作の相談」をゴミ箱に移しました')
    await expect.poll(() => folderNames(none)).toEqual(['場面の相談（第1部）'])
    await expect(none.getByTestId('idea-card')).toHaveCount(1)
    // 次のフォルダの見出しへフォーカスが移る
    await expect(head(folder(none, '場面の相談（第1部）'), 'idea-folder-toggle')).toBeFocused()

    // ゴミ箱: 種類・場所・中身の数。戻すと中のカードと一緒に（済みのまま）戻る
    await page.getByTestId('trash-link').click()
    const row = page.getByTestId('trash-row').filter({ hasText: '新作の相談' })
    await expect(row.getByTestId('trash-kind')).toHaveText('アイデアのフォルダ')
    await expect(row.getByTestId('trash-place')).toHaveText(UNASSIGNED)
    await expect(row.getByTestId('trash-detail')).toHaveText('カード2件')
    await row.getByTestId('trash-restore').click()
    await toast(page, '「新作の相談」を元の場所に戻しました')
    await page.getByRole('link', { name: 'ホーム（アイデアとタイトル一覧）' }).click()
    await expect.poll(() => folderNames(none)).toEqual(['新作の相談', '場面の相談（第1部）'])
    await expect.poll(texts).toEqual(['灯台の手紙', '港町の少女'])
    await expect(cardsDirectlyIn(shinsaku).last()).toHaveAttribute('data-checked', 'true')
  })

  test('2段目は日付から始まる名前で作る。2段目をほかの1段目へ移す・1段目にする。中にフォルダの無い1段目はほかの1段目の中へ入れられる', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page, 'ideas')
    const ids = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の庭')
      const bamen = actions.createIdeaFolder(t, null, '場面の相談')
      const jinbutsu = actions.createIdeaFolder(t, null, '人物の相談')
      actions.addIdea(t, '', '雨の駅で待つ', bamen)
      return { t, bamen, jinbutsu }
    })
    const sec = section(page, ids.t)
    await expect.poll(() => folderNames(sec)).toEqual(['人物の相談', '場面の相談'])

    // 2段目: 名前は今日の日付と全角の空白から始まる（選ばずに、続けて書ける）
    let menu = await openMenu(page, folderById(page, ids.bamen))
    await menu.getByTestId('idea-folder-new-sub').click()
    await expect(dialog(page).getByRole('heading', { name: '『場面の相談』の中にフォルダを作る' })).toBeVisible()
    const input = page.getByTestId('prompt-input')
    const prefix = `${today()}　`
    expect(await input.inputValue()).toBe(prefix)
    await expect
      .poll(() => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([prefix.length, prefix.length])
    // ホームでないので、Claude に見える説明は出さない
    await expect(dialog(page)).not.toContainText('Claude にも見えます')
    await page.keyboard.type('雨の駅')
    await page.getByTestId('prompt-ok').click()
    await expect(dialog(page)).toHaveCount(0)
    const sub = folderById(page, ids.bamen).locator('[data-testid="idea-folder"][data-depth="2"]')
    await expect(sub).toHaveCount(1)
    expect(await head(sub, 'idea-folder-name').textContent()).toBe(`${prefix}雨の駅`)
    const subId = (await sub.getAttribute('data-folder-id'))!
    // 2段目の中には作れない（メニューに無い）
    menu = await openMenu(page, folderById(page, subId))
    await expect(menu.getByTestId('idea-folder-new-sub')).toHaveCount(0)

    // 2段目をほかの1段目へ
    await menu.getByTestId('idea-folder-move').click()
    const move = page.getByTestId('idea-folder-move-dialog')
    await expect(dialog(page).getByRole('heading', { name: 'フォルダを移動' })).toBeVisible()
    await expect(move.locator(`[data-testid="idea-folder-move-option"][data-parent="${ids.bamen}"]`)).toContainText('現在の場所')
    await move.locator(`[data-testid="idea-folder-move-option"][data-parent="${ids.jinbutsu}"]`).click()
    await expect(page.getByTestId('idea-folder-move-summary')).toContainText('を「人物の相談」の中の先頭に移します')
    await page.getByTestId('idea-folder-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(folderById(page, ids.jinbutsu).locator(`[data-folder-id="${subId}"]`)).toHaveAttribute('data-depth', '2')
    await expect(folderById(page, ids.bamen).locator('[data-testid="idea-folder"]')).toHaveCount(0)
    await expect(head(folderById(page, subId), 'idea-folder-toggle')).toBeFocused()

    // 1段目にする（仕切りの「（1段目にする）」）
    menu = await openMenu(page, folderById(page, subId))
    await menu.getByTestId('idea-folder-move').click()
    const root = move.locator(`[data-testid="idea-folder-move-option"][data-section="${ids.t}"][data-parent=""]`)
    await expect(root).toContainText('星の庭（1段目にする）')
    await root.click()
    await page.getByTestId('idea-folder-move-submit').click()
    await expect(folderById(page, subId)).toHaveAttribute('data-depth', '1')
    await expect.poll(() => folderNames(sec)).toEqual([`${prefix}雨の駅`, '人物の相談', '場面の相談'])

    // 中にフォルダの無い1段目（場面の相談）は、ほかの1段目の中へ入れられる（中のカードも一緒に）
    menu = await openMenu(page, folderById(page, ids.bamen))
    await menu.getByTestId('idea-folder-move').click()
    await move.locator(`[data-testid="idea-folder-move-option"][data-parent="${ids.jinbutsu}"]`).click()
    await expect(page.getByTestId('idea-folder-move-summary')).toContainText('（中のカード 1件も一緒に移ります）')
    await page.getByTestId('idea-folder-move-submit').click()
    await expect(folderById(page, ids.bamen)).toHaveAttribute('data-depth', '2')
    await expect(cardsDirectlyIn(folderById(page, ids.bamen))).toHaveCount(1)
    await expect(head(folderById(page, ids.jinbutsu), 'idea-folder-count')).toHaveAttribute('data-count', '1')

    // 中にフォルダがある1段目は、ほかのフォルダの中へは移せない（3段目は作れない）
    menu = await openMenu(page, folderById(page, ids.jinbutsu))
    await menu.getByTestId('idea-folder-move').click()
    await expect(page.getByTestId('idea-folder-move-note')).toHaveText(
      '中にフォルダがあるので、ほかのフォルダの中へは移せません（3段目は作れません）',
    )
    await expect(move.locator(`[data-testid="idea-folder-move-option"][data-parent="${subId}"] input`)).toBeDisabled()
    // ほかの仕切りへも移せる（仕切りが変わることを添える）
    await move.locator('[data-testid="idea-folder-move-option"][data-section="none"][data-parent=""]').click()
    await expect(page.getByTestId('idea-folder-move-summary')).toContainText(`（「${UNASSIGNED}」へ移ります）`)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await noHorizontalScroll(page)
  })

  test('カードをフォルダへ移す・フォルダから出す（移動先は木の形。2段目には新しいフォルダを作れない）', async ({ page }) => {
    await openApp(page)
    await openHomeBands(page, 'ideas')
    const ids = await seed(page, ({ actions }) => {
      const top = actions.createIdeaFolder(null, null, '新作の相談')
      const port = actions.createIdeaFolder(null, top, '港町')
      const a = actions.addIdea(null, '', '案A')
      actions.addIdea(null, '', '案B')
      return { top, port, a }
    })
    const none = section(page, 'none')
    const cardA = page.locator(`[data-testid="idea-card"][data-idea-id="${ids.a}"]`)

    // 港町（2段目）へ
    await cardA.getByTestId('idea-move').click()
    // 仕切り → 1段目 → 2段目の順に、段を下げて並ぶ
    await expect(page.locator(`[data-testid="idea-move-option"][data-folder="${ids.top}"]`)).toHaveAttribute('data-depth', '1')
    await expect(page.locator(`[data-testid="idea-move-option"][data-section="none"][data-folder=""]`)).toContainText(
      '現在の場所',
    )
    const portRow = page.locator(`[data-testid="idea-move-option"][data-folder="${ids.port}"]`)
    await expect(portRow).toHaveAttribute('data-depth', '2')
    await portRow.click()
    await expect(page.getByTestId('idea-move-new-folder')).toBeDisabled()
    await expect(page.getByTestId('idea-move-new-note')).toHaveText('3段目は作れません')
    await expect(page.getByTestId('idea-move-summary')).toContainText(`「${UNASSIGNED} › 新作の相談 › 港町」の`)
    await page.getByTestId('idea-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsDirectlyIn(folderById(page, ids.port))).toHaveCount(1)
    await expect(cardA).toBeInViewport()
    await expect(head(folderById(page, ids.top), 'idea-folder-count')).toHaveAttribute('data-count', '1')
    expect(await page.evaluate((id) => window.__ns.getData().ideas[id].folderId, ids.a)).toBe(ids.port)

    // フォルダから出す（フォルダの中のカードの既定は、その仕切りのフォルダの外）
    await cardA.getByTestId('idea-move').click()
    await expect(page.locator(`[data-testid="idea-move-option"][data-folder="${ids.port}"]`)).toContainText('現在の場所')
    await expect(
      page.locator('[data-testid="idea-move-option"][data-section="none"][data-folder=""] input[type=radio]'),
    ).toBeChecked()
    await page.getByTestId('idea-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsDirectlyIn(folderById(page, ids.port))).toHaveCount(0)
    await expect(looseCards(none)).toHaveCount(2)
    // 項目ごと消える（null は書かない）
    expect(await page.evaluate((id) => 'folderId' in window.__ns.getData().ideas[id], ids.a)).toBe(false)
  })

  test('選んで移す: Claude の8枚を選び、新しいフォルダを作ってまとめる（並びはそのまま。作者のカードは残る）', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page, 'ideas')
    await seed(page, ({ actions }) => actions.addIdea(null, '', '作者の案'))
    const ideas = Array.from({ length: 8 }, (_, i) => ({
      id: `cy-port000${i + 1}`,
      body: `2026/11/12 14:32　港町の相談 ${i + 1}\n【案】\n・${i + 1}つ目`,
    }))
    await putClaudeRecords(page, ideas)
    const none = section(page, 'none')
    await expect(none.getByTestId('idea-card')).toHaveCount(9)

    await none.getByTestId('idea-select-start').click()
    await expect(none.getByTestId('idea-select-start')).toHaveAttribute('aria-pressed', 'true')
    const bar = none.getByTestId('idea-select-bar')
    await expect(bar.getByTestId('idea-select-count')).toHaveText('0件を選択中')
    await expect(bar.getByTestId('idea-select-hint')).toBeVisible()
    await expect(bar.getByTestId('idea-select-move')).toBeDisabled()
    // 選んでいる間は「済み」の□の代わりに選ぶ□
    await expect(none.getByTestId('idea-check')).toHaveCount(0)
    for (const { id } of ideas) await page.locator(`[data-idea-id="${id}"]`).getByTestId('idea-select').check()
    await expect(bar.getByTestId('idea-select-count')).toHaveText('8件を選択中')
    await expect(none.locator('.idea-card.is-selected')).toHaveCount(8)

    await bar.getByTestId('idea-select-move').click()
    await expect(dialog(page).getByRole('heading', { name: '8件のアイデアを移動' })).toBeVisible()
    await expect(page.getByTestId('idea-move-submit')).toBeDisabled()
    await expect(page.getByTestId('idea-move-position')).toHaveCount(0)
    await page.locator('[data-testid="idea-move-option"][data-section="none"][data-folder=""]').click()
    await page.getByTestId('idea-move-new-folder').click()
    await expect(dialog(page).getByRole('heading', { name: 'フォルダを作る' })).toBeVisible()
    await page.getByTestId('prompt-input').fill('2026/11/12　港町の相談')
    await page.getByTestId('prompt-ok').click()
    await expect(page.locator('.toasts')).toContainText('8件を「どのタイトルにも属さない › 2026/11/12')
    await expect(dialog(page)).toHaveCount(0)
    // 選ぶのは終わる
    await expect(none.getByTestId('idea-select-bar')).toHaveCount(0)
    await expect(none.getByTestId('idea-select-start')).toHaveAttribute('aria-pressed', 'false')

    const made = none.locator('[data-testid="idea-folder"][data-depth="1"]')
    await expect(made).toHaveCount(1)
    expect(await head(made, 'idea-folder-name').textContent()).toBe('2026/11/12　港町の相談')
    // 作者が作ったフォルダなので印は無い。中のカードは Claude の印のまま、前の並びのまま
    await expect(head(made, 'idea-folder-by')).toHaveCount(0)
    await expect(head(made, 'idea-folder-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(() => cardsDirectlyIn(made).evaluateAll((els) => els.map((e) => e.getAttribute('data-idea-id'))))
      .toEqual(ideas.map((i) => i.id))
    await expect(cardsDirectlyIn(made).getByTestId('idea-by-claude')).toHaveCount(8)
    await expect(looseCards(none)).toHaveCount(1)
    await expect(looseCards(none)).toContainText('作者の案')

    // 見出しの□で、フォルダの中をまとめて選べる（閉じていても）
    await head(made, 'idea-folder-toggle').click()
    await none.getByTestId('idea-select-start').click()
    await head(made, 'idea-folder-select').check()
    await expect(none.getByTestId('idea-select-count')).toHaveText('8件を選択中')
    await page.keyboard.press('Escape')
    await expect(none.getByTestId('idea-select-bar')).toHaveCount(0)
  })

  test('移した後にカードを見せるのは一度だけ: ほかの画面からホームのリンクで戻った時・帯を閉じて開き直した時は、スクロールもフォーカスもしない', async ({
    page,
  }) => {
    await openApp(page)
    const ids = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の庭')
      for (let i = 0; i < 12; i++) actions.addIdea(t, '', `星の案${i + 1}`)
      const top = actions.createIdeaFolder(null, null, '新作の相談')
      const a = actions.addIdea(null, '', '移す案')
      for (let i = 0; i < 6; i++) actions.addIdea(null, '', `ホームの案${i + 1}`)
      return { t, top, a }
    })
    await openHomeBands(page, 'ideas')
    const card = page.locator(`[data-testid="idea-card"][data-idea-id="${ids.a}"]`)
    const scrollY = () => page.evaluate(() => window.scrollY)

    // 移した直後は、移した先（フォルダの中で描き直したカード）を見せる
    await card.getByTestId('idea-move').click()
    await page.locator(`[data-testid="idea-move-option"][data-folder="${ids.top}"]`).click()
    await page.getByTestId('idea-move-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cardsDirectlyIn(folderById(page, ids.top))).toHaveCount(1)
    await expect(card).toHaveClass(/is-revealed/)
    await expect(card).toBeFocused()
    await expect(card).toBeInViewport()
    await expect.poll(scrollY).toBeGreaterThan(0)
    await expect(card).not.toHaveClass(/is-revealed/, { timeout: 5000 })

    // 先頭に戻ってタイトルの画面へ行き、ホームのリンクで戻る（新しく開いたホームは先頭から。カードへは動かない）
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      window.scrollTo(0, 0)
    })
    await expect.poll(scrollY).toBe(0)
    await section(page, ids.t).getByTestId('idea-section-open').click()
    await expect(page.getByTestId('title-name')).toHaveValue('星の庭')
    await page.getByRole('link', { name: 'ホーム（アイデアとタイトル一覧）' }).click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(card).toBeAttached()
    // 見せてしまうなら、この間にスクロールしてフォーカスする
    await page.waitForTimeout(1000)
    expect(await scrollY()).toBe(0)
    await expect(card).not.toBeFocused()
    await expect(card).not.toHaveClass(/is-revealed/)

    // 帯を閉じて開き直しても同じ
    await homeBandToggle(page, 'ideas').click()
    await expect(card).toHaveCount(0)
    const y = await scrollY()
    await homeBandToggle(page, 'ideas').click()
    await expect(card).toBeAttached()
    await page.waitForTimeout(1000)
    expect(await scrollY()).toBe(y)
    await expect(card).not.toBeFocused()
    await expect(card).not.toHaveClass(/is-revealed/)
  })

  test('スマホ: 選んで移すの下の帯は、上の切り替え（タイトル・アイデア・相対比較・資料）の下を通り、押す所を取らない', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの上の切り替えで確かめる')
    await openApp(page)
    const ids = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の庭')
      for (let i = 0; i < 6; i++) actions.addIdea(t, '', `星の案${i + 1}`)
      for (let i = 0; i < 15; i++) actions.addIdea(null, '', `ホームの案${i + 1}`)
      return { t }
    })
    // 選ぶ仕切りの後ろにも中身がある（どのタイトルにも属さない・相対比較・資料）
    await openHomeBands(page, 'ideas', 'bench', 'materials')
    const sec = section(page, ids.t)
    await sec.getByTestId('idea-select-start').click()
    await expect(sec.getByTestId('idea-select-bar')).toBeVisible()
    // 仕切りの終わりの帯を、上の切り替えの真ん中の高さまでスクロールして、そこを押した時に当たる要素を見る
    const hit = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="home-jump"]')!
      const bar = document.querySelector('[data-testid="idea-select-bar"]')!
      const center = () => {
        const r = nav.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      for (let i = 0; i < 6; i++) {
        const b = bar.getBoundingClientRect()
        window.scrollBy(0, b.top + b.height / 2 - center().y)
      }
      const { x, y } = center()
      const b = bar.getBoundingClientRect()
      const el = document.elementFromPoint(x, y)
      return {
        barUnderNav: b.top <= y && b.bottom >= y,
        inNav: Boolean(el?.closest('[data-testid="home-jump"]')),
        inBar: Boolean(el?.closest('[data-testid="idea-select-bar"]')),
      }
    })
    expect(hit).toEqual({ barUnderNav: true, inNav: true, inBar: false })
  })

  test('フォルダの開け閉めは、読み込み直しても覚えている（帯・仕切りの開け閉めとは別）', async ({ page }) => {
    await openApp(page)
    const ids = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の庭')
      const a = actions.createIdeaFolder(t, null, '場面の相談')
      const b = actions.createIdeaFolder(t, a, '雨の駅')
      actions.addIdea(t, '', '中の案', b)
      return { t, a, b }
    })
    await openHomeBands(page, 'ideas')
    const toggle = (id: string) => head(folderById(page, id), 'idea-folder-toggle')
    await toggle(ids.b).click()
    await expect(toggle(ids.b)).toHaveAttribute('aria-expanded', 'false')
    await expect(folderById(page, ids.b).getByTestId('idea-card')).toBeHidden()
    // 「すべて折りたたむ」は仕切りだけ（フォルダの開け閉めは消さない）
    await page.getByTestId('idea-collapse-all').click()
    await page.getByTestId('idea-expand-all').click()
    await expect(toggle(ids.a)).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(ids.b)).toHaveAttribute('aria-expanded', 'false')

    await page.reload()
    // 帯は閉じて始まるが、開くとフォルダは前のまま
    await expect(page.getByTestId('idea-sections')).toHaveCount(0)
    await openHomeBands(page, 'ideas')
    await expect(toggle(ids.a)).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(ids.b)).toHaveAttribute('aria-expanded', 'false')
    await toggle(ids.b).click()
    await expect(folderById(page, ids.b).getByTestId('idea-card')).toBeVisible()
    // タイトルのアイデアタブでも同じ状態
    await toggle(ids.b).click()
    await openApp(page, `/t/${ids.t}?tab=ideas`)
    await expect(toggle(ids.b)).toHaveAttribute('aria-expanded', 'false')
  })

  test('Claude が作ったフォルダ（cf-…）には「Claude が作成」の印。名前を変えても印は残る', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    await openHomeBands(page, 'ideas')
    await putClaudeRecords(
      page,
      [
        { id: 'cy-claude001', body: '2026/11/12 14:32　港町\n・灯台', folderId: 'cf-1abc.port' },
        { id: 'cy-claude002', body: '2026/11/12 14:32　港町\n・手紙', folderId: 'cf-1abc.port' },
      ],
      [{ id: 'cf-1abc.port', name: '2026/11/12　港町の新作' }],
    )
    const f = folderById(page, 'cf-1abc.port')
    await expect(cardsDirectlyIn(f)).toHaveCount(2)
    const badge = head(f, 'idea-folder-by')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('title', 'Claude がコネクタで作ったフォルダ')
    await expect(badge).toContainText('Claude が作成')
    // 狭い画面では印はアイコンだけ（文字は読み上げに残す）
    const label = badge.locator('.idea-claude-badge-label')
    if (info.project.name === 'mobile') expect((await label.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
    else await expect(label).toBeVisible()
    await noHorizontalScroll(page)

    const menu = await openMenu(page, f)
    await menu.getByTestId('idea-folder-rename').click()
    await page.getByTestId('prompt-input').fill('港町の新作')
    await page.getByTestId('prompt-ok').click()
    await expect(head(f, 'idea-folder-name')).toHaveText('港町の新作')
    await expect(head(f, 'idea-folder-by')).toBeVisible()
    // 作者のフォルダ（UUID）には付かない。source が claude でも cf- でなければ付かない
    await seed(page, ({ actions }) => actions.createIdeaFolder(null, null, '作者のフォルダ'))
    await expect(head(folder(section(page, 'none'), '作者のフォルダ'), 'idea-folder-by')).toHaveCount(0)
  })

  test('幅 360px: 横にはみ出さず、フォルダの見出し・選んで移すのボタンは押しやすい大きさ（明・暗のスクリーンショット）', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの幅で確かめる')
    await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    const ids = await seed(page, ({ actions }) => {
      const t = actions.createTitle('星の庭')
      const a = actions.createIdeaFolder(t, null, 'とても長い名前の付いた場面の相談のフォルダ（第一部の山場）')
      const b = actions.createIdeaFolder(t, a, '2026/11/12　雨の駅で待ち続ける少女の場面の案')
      actions.addIdea(t, '', '雨の駅で待つ少女', b)
      actions.setIdeaChecked(actions.addIdea(t, '', '没にした案', b), true)
      actions.addIdea(t, '', 'フォルダの外の案')
      const home = actions.createIdeaFolder(null, null, '新作の相談')
      actions.addIdea(null, '', '港町の少女', home)
      return { t, a, b }
    })
    await putClaudeRecords(
      page,
      [{ id: 'cy-narrow01', body: '2026/11/12 14:32　港町\n・灯台', folderId: 'cf-2narrow' }],
      [{ id: 'cf-2narrow', name: '2026/11/12　港町の新作の相談（Claude）' }],
    )
    await openHomeBands(page, 'ideas')
    await noHorizontalScroll(page)
    const top = folderById(page, ids.a)
    for (const id of ['idea-folder-add', 'idea-folder-menu']) await tapSize(head(top, id), id)
    await tapSize(head(top, 'idea-folder-toggle'), 'idea-folder-toggle', false)
    await tapSize(section(page, ids.t).getByTestId('idea-folder-create'), 'idea-folder-create')
    await tapSize(section(page, ids.t).getByTestId('idea-select-start'), 'idea-select-start', false)
    // 名前は折り返して収まる
    const box = (await head(top, 'idea-folder-name').boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(360)

    const dir = 'e2e/artifacts/screens'
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await section(page, ids.t).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${dir}/idea-folders-mobile-${scheme}.png`, fullPage: true })
    }
    await page.emulateMedia({ colorScheme: 'light' })

    // 選んで移す: 見出しの□・カードの□・下の帯
    await section(page, ids.t).getByTestId('idea-select-start').click()
    await tapSize(top.locator(':scope > .idea-folder-head label.idea-folder-select'), 'idea-folder-select')
    await tapSize(section(page, ids.t).locator('label.idea-select').first(), 'idea-select')
    const bar = section(page, ids.t).getByTestId('idea-select-bar')
    for (const id of ['idea-select-move', 'idea-select-cancel']) await tapSize(bar.getByTestId(id), id, false)
    await noHorizontalScroll(page)
    await page.screenshot({ path: `${dir}/idea-folders-mobile-select.png` })
    await bar.getByTestId('idea-select-cancel').click()

    // メニュー・移動のダイアログ
    await openMenu(page, top)
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await openMenu(page, folderById(page, ids.b)).then((m) => m.getByTestId('idea-folder-move').click())
    await expect(page.getByTestId('idea-folder-move-dialog')).toBeVisible()
    await noHorizontalScroll(page)
    await page.screenshot({ path: `${dir}/idea-folders-mobile-move.png` })
  })
})
