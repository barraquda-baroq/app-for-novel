// セパレート（幕）の E2E テスト: 一覧の右クリック・長押し・「…」のメニュー、分割点を置いて幕に分ける、
// 幕の画面での編集と保存、次の幕とつなぐ、セパレート解除（できない時とできる時）、通し読みの幕の見出し、スマホ。
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { openApp, seed } from './helpers'

const isDesktop = (info: TestInfo) => info.project.name === 'desktop'

const ACT1 = '一幕目の文。雨が降っていた。\n'
const ACT2 = '二幕目の文。晴れた。\n'
const ACT3 = '三幕目の文。終わり。'
const BODY = ACT1 + ACT2 + ACT3

interface Ids {
  titleId: string
  pieceId: string
  secondId: string
}

/** 第1話（題「雨の日」・本文 BODY）と第2話のタイトル */
async function seedWork(page: Page): Promise<Ids> {
  await openApp(page)
  return seed(
    page,
    ({ actions, getData }, a: { body: string }) => {
      const titleId = actions.createTitle('幕の作品')
      const pieceId = actions.addEpisode(titleId)
      actions.updatePiece(pieceId, { subtitle: '雨の日' })
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: a.body })
      const secondId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[secondId].versionIds[0], { body: '第2話の本文。' })
      return { titleId, pieceId, secondId }
    },
    { body: BODY },
  )
}

/** 第1話を3幕に分けておく（戻り値は幕の id） */
async function seedSplit(page: Page, ids: Ids): Promise<string[]> {
  return seed(page, ({ actions }, a: { pieceId: string; offsets: number[] }) => actions.separatePiece(a.pieceId, a.offsets), {
    pieceId: ids.pieceId,
    offsets: [ACT1.length, ACT1.length + ACT2.length],
  })
}

function dialog(page: Page): Locator {
  return page.getByRole('dialog')
}

async function confirmIn(page: Page, buttonName: string): Promise<void> {
  await dialog(page).getByRole('button', { name: buttonName, exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
}

/** 入力欄の position の位置にカーソルを置く（クリック・タップで置いたのと同じ） */
async function placeCaret(area: Locator, position: number): Promise<void> {
  await area.evaluate((el: HTMLTextAreaElement, p) => {
    el.focus()
    el.setSelectionRange(p, p)
    el.dispatchEvent(new Event('select', { bubbles: true }))
  }, position)
}

/** 原稿画面の上部バーの「幕」メニューを開いて、項目を押す */
async function actsMenu(page: Page, item: string): Promise<void> {
  await page.getByTestId('acts-menu-button').click()
  await page.getByTestId('acts-menu').getByTestId(item).click()
}

/** 幕の本文（読む順。採用稿がなければ null） */
async function actBodies(page: Page, pieceId: string): Promise<(string | null)[]> {
  return page.evaluate((id) => {
    const d = window.__ns.getData()
    return (d.pieces[id].actIds ?? []).map((a) => {
      const act = d.pieces[a]
      return act?.activeVersionId ? (d.versions[act.activeVersionId]?.body ?? null) : null
    })
  }, pieceId)
}

/** 文字の選択と iOS の長押しメニューが出ないこと */
async function expectNoCallout(target: Locator): Promise<void> {
  const style = await target.evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string }
    return { userSelect: cs.userSelect || cs.webkitUserSelect, callout: cs.webkitTouchCallout ?? 'none' }
  })
  expect(style.userSelect).toBe('none')
  expect(style.callout).toBe('none')
}

async function noHorizontalScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0)
}

test.describe('セパレート（幕）', () => {
  test('一覧の「…」からセパレートを開き、カーソル＋Enter と「ここで区切る」で2か所区切って幕に分ける', async ({ page }) => {
    const ids = await seedWork(page)
    await openApp(page, `/t/${ids.titleId}`)
    const row = page.getByTestId('piece-row').first()
    await row.getByTestId('piece-more').click()
    const menu = page.getByTestId('row-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('menu-separate')).toBeVisible()
    await menu.getByTestId('menu-separate').click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.pieceId}/separate$`))
    await expect(page.getByTestId('separate-heading')).toHaveText('第1話　雨の日')
    const apply = page.getByTestId('separate-apply')
    await expect(apply).toBeDisabled()

    const areas = page.getByTestId('separate-text')
    await expect(areas).toHaveCount(1)
    // 先頭では区切れない
    await placeCaret(areas.first(), 0)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('separate-message')).toHaveText('先頭では区切れません')
    await expect(page.getByTestId('split-divider')).toHaveCount(0)

    // 1か所目: カーソルを置いて Enter
    await placeCaret(areas.first(), ACT1.length)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('split-divider')).toHaveCount(1)
    await expect(page.getByTestId('split-divider').first()).toContainText('ここから第2幕')
    await expect(areas).toHaveCount(2)
    await expect(apply).toBeEnabled()

    // 2か所目: カーソルを置いて「ここで区切る」（決定）
    await placeCaret(areas.nth(1), ACT2.length)
    await page.getByTestId('separate-decide').click()
    await expect(page.getByTestId('split-divider')).toHaveCount(2)
    await expect(page.getByTestId('split-divider').nth(1)).toContainText('ここから第3幕')

    // 同じ位置（区切りの先頭）は区切れない
    await placeCaret(areas.nth(2), 0)
    await page.getByTestId('separate-decide').click()
    await expect(page.getByTestId('separate-message')).toHaveText('そこはもう区切ってあります')
    // 末尾も区切れない
    await placeCaret(areas.nth(2), ACT3.length)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('separate-message')).toHaveText('末尾では区切れません')

    // 分けた後の一覧（第x幕・最初の行・文字数）
    if (!isDesktop(test.info())) await page.getByTestId('separate-summary').click()
    const preview = page.getByTestId('separate-preview-item')
    await expect(preview).toHaveCount(3)
    await expect(preview.nth(0)).toContainText('第1幕')
    await expect(preview.nth(0)).toContainText('一幕目の文。雨が降っていた。')
    await expect(preview.nth(2)).toContainText('第3幕')
    await expect(preview.nth(2)).toContainText('10字')

    // 区切りを外して、また置く
    await page.getByTestId('remove-split').nth(1).click()
    await expect(page.getByTestId('split-divider')).toHaveCount(1)
    await expect(preview).toHaveCount(2)
    await placeCaret(areas.nth(1), ACT2.length)
    await page.keyboard.press('Enter')
    await expect(preview).toHaveCount(3)

    await apply.click()
    // 話の画面は幕の一覧になる（話数は増えない）
    await expect(page).toHaveURL(new RegExp(`/p/${ids.pieceId}$`))
    await expect(page.getByTestId('episode-folder')).toBeVisible()
    await expect(page.getByTestId('folder-act-count')).toHaveText('3幕')
    await expect(page.getByTestId('folder-total')).toContainText('合計 34字')
    await expect(page.getByTestId('act-row')).toHaveCount(3)
    expect(await actBodies(page, ids.pieceId)).toEqual([ACT1, ACT2, ACT3])

    // 一覧ではフォルダのような行の下に幕の行が並ぶ
    await openApp(page, `/t/${ids.titleId}`)
    const split = page.locator('[data-testid="piece-row"][data-split="true"]')
    await expect(split).toHaveCount(1)
    await expect(split.getByTestId('piece-act-count')).toContainText('3幕')
    await expect(split.getByTestId('act-label')).toHaveText(['第1幕', '第2幕', '第3幕'])
    await expect(page.getByTestId('piece-row')).toHaveCount(2)
    await expect(page.getByTestId('piece-label')).toHaveText(['第1話', '第2話'])
    // 折りたたむ・開く
    await split.getByTestId('acts-toggle').click()
    await expect(split.getByTestId('act-list')).toBeHidden()
    await split.getByTestId('acts-toggle').click()
    await expect(split.getByTestId('act-row')).toHaveCount(3)
  })

  test('右クリックで操作メニューを開く（話: セパレート／セパレート解除、幕: さらに分ける・次の幕とつなぐ）。キーボードでも開ける', async ({
    page,
  }, info) => {
    test.skip(!isDesktop(info), '右クリックはデスクトップのみ')
    const ids = await seedWork(page)
    await openApp(page, `/t/${ids.titleId}`)
    const first = page.getByTestId('piece-row').first()
    await first.locator('.story-row-link').click({ button: 'right' })
    const menu = page.getByTestId('row-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText(['開く', /^セパレート/, '移動…', '削除'])
    // 開いた時は最初の項目にフォーカスし、矢印キーで動ける。Esc で閉じる
    await expect(menu.getByTestId('menu-open')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByTestId('menu-separate')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    // 右クリックではリンクを開かない
    await expect(page).toHaveURL(new RegExp(`/t/${ids.titleId}$`))

    // 「…」はキーボードでも開け、閉じたら「…」に戻る
    const more = first.getByTestId('piece-more')
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()

    // 幕に分けた話はセパレート解除、幕の行は さらに分ける・次の幕とつなぐ（最後の幕には つなぐ がない）
    await seedSplit(page, ids)
    await first.locator('.story-row-link').click({ button: 'right' })
    await expect(menu.getByTestId('menu-unseparate')).toBeVisible()
    await expect(menu.getByTestId('menu-separate')).toHaveCount(0)
    await page.keyboard.press('Escape')
    const acts = page.getByTestId('act-row')
    await acts.nth(0).locator('.story-act-link').click({ button: 'right' })
    await expect(menu.getByRole('menuitem')).toHaveText(['開く', 'さらに分ける', '次の幕とつなぐ'])
    await page.keyboard.press('Escape')
    await acts.nth(2).getByTestId('act-more').click()
    await expect(menu.getByRole('menuitem')).toHaveText(['開く', 'さらに分ける'])
    await menu.getByTestId('menu-split-act').click()
    await expect(page).toHaveURL(/\/separate$/)
    await expect(page.getByTestId('separate-heading')).toHaveText('第1話　雨の日　第3幕')
    // キャンセルで開いた元（一覧）へ戻る
    await page.getByTestId('separate-cancel').click()
    await expect(page).toHaveURL(new RegExp(`/t/${ids.titleId}$`))
    await expect(page.getByTestId('act-row')).toHaveCount(3)
  })

  test('長押しで操作メニューを開く（移動・離すとやめる。リンクは開かず、文字の選択やブラウザのメニューも出さない）', async ({
    page,
  }, info) => {
    test.skip(isDesktop(info), '長押しはスマホ（タッチ操作）のみ')
    const ids = await seedWork(page)
    await seedSplit(page, ids)
    await openApp(page, `/t/${ids.titleId}`)
    const cdp = await page.context().newCDPSession(page)
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
    const first = page.getByTestId('piece-row').first()
    const link = first.locator('.story-row-link')
    await expectNoCallout(link)
    await link.scrollIntoViewIfNeeded()
    const box = (await link.boundingBox())!
    const x = box.x + box.width / 3
    const y = box.y + box.height / 2
    const menu = page.getByTestId('row-menu')

    // 長押し: メニューが出て、離してもリンクは開かない
    await touch('touchStart', x, y)
    await page.waitForTimeout(800)
    await expect(menu).toBeVisible()
    await touch('touchEnd', x, y)
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(new RegExp(`/t/${ids.titleId}$`))
    await expect(menu.getByTestId('menu-unseparate')).toBeVisible()
    // 文字は選ばれていない
    expect(await page.evaluate(() => String(window.getSelection() ?? ''))).toBe('')
    // 外側（一覧の上の説明）をタップすると閉じる
    const legend = (await page.getByTestId('progress-legend').boundingBox())!
    await touch('touchStart', legend.x + 10, legend.y + 5)
    await touch('touchEnd', legend.x + 10, legend.y + 5)
    await expect(menu).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/t/${ids.titleId}$`))

    // 指が動いた（スクロールした）: 長く触れていてもメニューは出ない
    await touch('touchStart', x, y)
    await touch('touchMove', x + 30, y)
    await page.waitForTimeout(800)
    await touch('touchEnd', x + 30, y)
    await expect(menu).toHaveCount(0)

    // 幕の行の長押し
    const act = page.getByTestId('act-row').nth(1).locator('.story-act-link')
    await expectNoCallout(act)
    await act.scrollIntoViewIfNeeded()
    const ab = (await act.boundingBox())!
    await touch('touchStart', ab.x + 20, ab.y + ab.height / 2)
    await page.waitForTimeout(800)
    await touch('touchEnd', ab.x + 20, ab.y + ab.height / 2)
    await expect(menu.getByRole('menuitem')).toHaveText(['開く', 'さらに分ける', '次の幕とつなぐ'])
    await expect(page).toHaveURL(new RegExp(`/t/${ids.titleId}$`))
    // メニューから幕の画面を開く
    await menu.getByTestId('menu-open').click()
    await expect(page.getByTestId('piece-workspace')).toBeVisible()
    await expect(page.getByTestId('act-label')).toHaveText('第2幕')
  })

  test('幕の画面: 見出し「第1話　題　第2幕」・幕の文字数・前後の幕。編集して保存すると話の本文（つないだ本文）に反映される', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (t: string) => {
            ;(window as unknown as { __copied: string }).__copied = t
          },
        },
      })
    })
    const copied = () => page.evaluate(() => (window as unknown as { __copied?: string }).__copied)
    const ids = await seedWork(page)
    const acts = await seedSplit(page, ids)
    await openApp(page, `/t/${ids.titleId}`)
    await page.getByTestId('act-row').nth(1).locator('.story-act-link').click()
    await expect(page).toHaveURL(new RegExp(`/p/${acts[1]}$`))
    await expect(page.getByTestId('piece-workspace')).toBeVisible()
    await expect(page.getByTestId('piece-label')).toContainText('第1話')
    await expect(page.getByTestId('act-label')).toHaveText('第2幕')
    await expect(page.getByTestId('subtitle-input')).toHaveValue('雨の日')
    await expect(page.getByTestId('active-count')).toContainText('10字')
    const crumbs = page.locator('.breadcrumbs')
    if (isDesktop(test.info())) await expect(crumbs).toContainText('第1話')
    await expect(crumbs).toContainText('第2幕')

    // 編集して保存
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('虹が出た。')
    await editor.blur()
    await expect(page.getByTestId('save-button')).toBeEnabled()
    await page.getByTestId('save-button').click()
    await expect(page.getByTestId('save-button')).toBeDisabled()
    await expect(page.getByTestId('active-count')).toContainText('15字')
    expect(await actBodies(page, ids.pieceId)).toEqual([ACT1, `${ACT2}虹が出た。`, ACT3])

    // 見出し付きのコピー
    const more = page.getByTestId('active-more-button')
    if (await more.isVisible()) await more.click()
    await page.getByTestId('copy-active').click()
    await expect.poll(copied).toBe(`第1話　雨の日　第2幕\n\n${ACT2}虹が出た。`)

    // 上部バーの「幕」メニュー（もう一度押すと閉じる）
    const menuButton = page.getByTestId('acts-menu-button')
    await menuButton.click()
    await expect(page.getByTestId('acts-menu').getByRole('menuitem')).toHaveText([
      'さらに分ける',
      '次の幕とつなぐ',
      /^セパレート解除/,
      '幕の一覧（第1話）',
    ])
    await menuButton.click()
    await expect(page.getByTestId('acts-menu')).toHaveCount(0)

    // 前後の幕（同じ話の中）
    await page.getByTestId('next-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${acts[2]}$`))
    await expect(page.getByTestId('act-label')).toHaveText('第3幕')
    await expect(page.getByTestId('next-piece')).toBeDisabled()
    await page.getByTestId('prev-piece').click()
    await page.getByTestId('prev-piece').click()
    await expect(page.getByTestId('act-label')).toHaveText('第1幕')
    await expect(page.getByTestId('prev-piece')).toBeDisabled()

    // 話の画面（幕の一覧）の合計
    await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
    await expect(page.getByTestId('folder-total')).toContainText('合計 39字')

    // 保存していない編集があれば、さらに分ける前に保存するか聞く
    await openApp(page, `/t/${ids.titleId}/p/${acts[0]}`)
    await page.getByTestId('active-editor').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('追記。')
    await page.getByTestId('active-editor').blur()
    await actsMenu(page, 'separate-button')
    await expect(dialog(page)).toContainText('保存してから続けますか')
    await confirmIn(page, '保存して続ける')
    await expect(page).toHaveURL(new RegExp(`/p/${acts[0]}/separate$`))
    expect((await actBodies(page, ids.pieceId))[0]).toBe(`${ACT1}追記。`)
  })

  test('次の幕とつなぐ: 「第n稿（つないだ稿）」を採用し、次の幕の採用していなかった稿はゴミ箱へ', async ({ page }) => {
    const ids = await seedWork(page)
    const acts = await seedSplit(page, ids)
    await seed(page, ({ actions }, a: { act: string }) => actions.addVersion(a.act, { body: '二幕目の別案。' }), { act: acts[1] })
    await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
    await page.getByTestId('act-row').nth(0).getByTestId('act-more').click()
    await page.getByTestId('row-menu').getByTestId('menu-join').click()
    await expect(dialog(page)).toContainText('第1幕と第2幕をつなぎますか？')
    await expect(dialog(page)).toContainText('第2幕の採用していない稿（1稿）')
    await confirmIn(page, 'つなぐ')
    await expect(page.getByTestId('act-row')).toHaveCount(2)
    await expect(page.getByTestId('act-row').nth(0).getByTestId('act-adopted')).toContainText('第2稿（つないだ稿）')
    expect(await actBodies(page, ids.pieceId)).toEqual([ACT1 + ACT2, ACT3])

    // 幕の画面の「次の幕とつなぐ」（最後の1幕だけになる）
    await page.getByTestId('act-row').nth(0).locator('.story-act-link').click()
    await expect(page.getByTestId('active-editor')).toBeVisible()
    await actsMenu(page, 'join-next-button')
    await confirmIn(page, 'つなぐ')
    await expect(page.getByTestId('next-piece')).toBeDisabled()
    expect(await actBodies(page, ids.pieceId)).toEqual([BODY])

    // 幕の画面からのセパレート解除（解除すると話の画面へ移る）
    await actsMenu(page, 'unseparate-act-button')
    await confirmIn(page, 'セパレート解除')
    await expect(page).toHaveURL(new RegExp(`/p/${ids.pieceId}$`))
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY)

    // つないだ時・解除した時の採用していなかった稿は、それぞれゴミ箱に1件
    await openApp(page, '/trash')
    await expect(page.getByTestId('trash-row')).toHaveCount(2)
    await expect(page.getByTestId('trash-row').filter({ hasText: '第2幕の採用していなかった稿（1稿）' })).toHaveCount(1)
    await expect(page.getByTestId('trash-row').filter({ hasText: '各幕の採用していなかった稿（2稿）' })).toHaveCount(1)
  })

  test('セパレート解除: 採用稿のない幕があると解除できず、すべての幕に採用稿があれば各幕をつないだ稿を採用して戻す', async ({
    page,
  }) => {
    const ids = await seedWork(page)
    const acts = await seedSplit(page, ids)
    await seed(page, ({ actions }, a: { act: string }) => actions.addVersion(a.act, { body: '三幕目の別案。' }), { act: acts[2] })
    // 第2幕の採用を外す（幕の画面）
    await openApp(page, `/t/${ids.titleId}/p/${acts[1]}`)
    const more = page.getByTestId('active-more-button')
    if (await more.isVisible()) await more.click()
    await page.getByTestId('unadopt-button').click()
    await expect(dialog(page)).toContainText('セパレートを解除できません')
    await confirmIn(page, '採用を解除')
    await expect(page.getByTestId('no-active')).toBeVisible()

    // 解除できない（採用稿のない幕を伝える）
    await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
    await expect(page.getByTestId('folder-missing')).toHaveText('採用原稿なし 1幕')
    await page.getByTestId('unseparate-button').click()
    await expect(page.locator('.toast.error')).toContainText('第2幕に採用原稿がないため、セパレートを解除できません')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByTestId('episode-folder')).toBeVisible()

    // 第2幕の稿をまた採用する
    await page.getByTestId('act-row').nth(1).locator('.story-act-link').click()
    await expect(page.getByTestId('piece-workspace')).toBeVisible()
    await page.getByTestId('row-adopt-button').first().click()
    await expect(page.getByTestId('active-editor')).toHaveValue(ACT2)

    // 一覧の右クリック／長押しの代わりに「…」から解除する
    await openApp(page, `/t/${ids.titleId}`)
    await page.getByTestId('piece-row').first().getByTestId('piece-more').click()
    await page.getByTestId('row-menu').getByTestId('menu-unseparate').click()
    await expect(dialog(page)).toContainText('第2稿（幕をつないだ稿）')
    await confirmIn(page, 'セパレート解除')
    await expect(page.locator('[data-testid="piece-row"][data-split="true"]')).toHaveCount(0)
    await expect(page.getByTestId('act-row')).toHaveCount(0)
    await expect(page.getByTestId('piece-adopted').first()).toContainText('第2稿（幕をつないだ稿）')

    // 話の画面は普通の原稿画面に戻る
    await page.getByTestId('piece-row').first().locator('.story-row-link').click()
    await expect(page.getByTestId('piece-workspace')).toBeVisible()
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY)
    await expect(page.getByTestId('active-version-name')).toHaveValue('第2稿（幕をつないだ稿）')
    // 第3幕の採用していなかった稿はゴミ箱へ
    await openApp(page, '/trash')
    await expect(page.getByTestId('trash-row').first()).toContainText('各幕の採用していなかった稿（1稿）')
  })

  test('通し読み: 幕に分けた話は幕の見出し（第1幕…）の下に各幕を出し、目次にも幕が並ぶ', async ({ page }) => {
    const ids = await seedWork(page)
    const acts = await seedSplit(page, ids)
    await seed(page, ({ actions }, a: { act: string }) => actions.setActiveVersion(a.act, null), { act: acts[2] })
    await openApp(page, `/t/${ids.titleId}/read`)
    const piece = page.getByTestId('read-piece').first()
    await expect(piece.getByTestId('read-piece-label')).toHaveText('第1話')
    await expect(piece.getByTestId('read-act-label')).toHaveText(['第1幕', '第2幕', '第3幕'])
    await expect(piece.getByTestId('read-act').nth(0).getByTestId('read-text')).toHaveText(ACT1.trim())
    await expect(piece.getByTestId('read-act').nth(2).getByTestId('no-active')).toHaveText('採用原稿がありません。')
    await expect(page.getByTestId('read-missing')).toHaveText('採用原稿なし 1幕')
    if (!isDesktop(test.info())) await page.getByTestId('toc-toggle').click()
    await expect(page.getByTestId('toc-act-link')).toHaveCount(3)
    await page.getByTestId('toc-act-link').nth(1).click()
    await expect(page.locator(`#rt-act-${acts[1]} [data-heading]`)).toBeFocused()
    // 縦書きでも幕の見出しが出る
    await page.getByTestId('vertical-toggle').click()
    await expect(piece.getByTestId('read-act-label')).toHaveCount(3)
    await expect(piece.getByTestId('read-act-label').first()).toBeVisible()
  })
})

test.describe('セパレート（スマホ）', () => {
  test.skip(({ isMobile }) => !isMobile, 'スマホ（タッチ操作）のみ')

  test('幅360pxでも横にスクロールせず、タップで置いたカーソルを「ここで区切る」で区切れる（キーボードは出さない）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    const ids = await seedWork(page)
    await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}/separate`)
    const area = page.getByTestId('separate-text').first()
    await expect(area).toHaveAttribute('readonly', '')
    await expect(area).toHaveAttribute('inputmode', 'none')
    // 「ここで区切る」は画面の下に見えている
    const decide = page.getByTestId('separate-decide')
    const box = (await decide.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(740)
    expect(box.height).toBeGreaterThanOrEqual(34)
    await noHorizontalScroll(page)

    // タップで2行目の始まりにカーソルを置く（位置は入力欄の中の座標から）
    await area.tap({ position: { x: 20, y: 10 } })
    await placeCaret(area, ACT1.length)
    await decide.tap()
    await expect(page.getByTestId('split-divider')).toHaveCount(1)
    const remove = page.getByTestId('remove-split').first()
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(34)
    await noHorizontalScroll(page)
    await page.getByTestId('separate-apply').tap()
    await expect(page.getByTestId('episode-folder')).toBeVisible()
    await noHorizontalScroll(page)
    expect(await actBodies(page, ids.pieceId)).toEqual([ACT1, ACT2 + ACT3])

    // 一覧・幕の画面も横にスクロールしない。押せる所は34px以上
    await openApp(page, `/t/${ids.titleId}`)
    await noHorizontalScroll(page)
    for (const id of ['piece-more', 'acts-toggle', 'act-more']) {
      const b = (await page.getByTestId(id).first().boundingBox())!
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(34)
    }
    await page.getByTestId('act-row').nth(1).locator('.story-act-link').tap()
    await expect(page.getByTestId('piece-workspace')).toBeVisible()
    await expect(page.getByTestId('act-label')).toHaveText('第2幕')
    await noHorizontalScroll(page)
    const mb = (await page.getByTestId('acts-menu-button').boundingBox())!
    expect(Math.min(mb.width, mb.height)).toBeGreaterThanOrEqual(34)
    expect(mb.x + mb.width).toBeLessThanOrEqual(360)
  })
})
