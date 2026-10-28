// 原稿画面の保存ボタン・未保存の警告・端末内の控え・巻き戻し／進む・記号バー・見出し付きコピーの E2E テスト
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { openApp, seed } from './helpers'

const BODY = '吾輩は猫である。名前はまだ無い。'
const isDesktop = (info: TestInfo) => info.project.name === 'desktop'

interface Ids {
  titleId: string
  pieceId: string
  secondId: string
  v1: string
  v2: string
  specialId: string
}

async function seedWork(page: Page): Promise<Ids> {
  await openApp(page)
  return seed(
    page,
    ({ actions, getData }, body: string) => {
      const titleId = actions.createTitle('猫の物語')
      const pieceId = actions.addEpisode(titleId)
      actions.updatePiece(pieceId, { subtitle: '旅立ち' })
      const v1 = getData().pieces[pieceId].versionIds[0]
      actions.updateVersion(v1, { body })
      const v2 = actions.addVersion(pieceId, { body: '推敲中の本文。' })
      const secondId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[secondId].versionIds[0], { body: '二話目の本文。' })
      const specialId = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
      actions.updateVersion(getData().pieces[specialId].versionIds[0], { body: '序の本文。' })
      return { titleId, pieceId, secondId, v1, v2, specialId }
    },
    BODY,
  )
}

async function openPiece(page: Page, ids: Pick<Ids, 'titleId'>, pieceId: string, versionId?: string) {
  await openApp(page, `/t/${ids.titleId}/p/${pieceId}${versionId ? `?v=${versionId}` : ''}`)
  await expect(page.getByTestId('piece-workspace')).toBeVisible()
}

async function storedBody(page: Page, versionId: string): Promise<string | undefined> {
  return page.evaluate((id) => window.__ns.getData().versions[id]?.body, versionId)
}

async function storedSubtitle(page: Page, pieceId: string): Promise<string | undefined> {
  return page.evaluate((id) => window.__ns.getData().pieces[id]?.subtitle, pieceId)
}

/** 本文の末尾に書き足す */
async function appendTo(page: Page, editor: Locator, text: string) {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

/** スマホでは本文の編集中は画面上部（ヘッダー）を畳むので、本文から離れて戻す */
async function leaveEditor(page: Page, editor: Locator) {
  await editor.blur()
  await expect(page.getByTestId('piece-workspace')).not.toHaveClass(/is-focus-mode/)
}

/** 狭いペインでは、コピーなどは「…」のメニューの中にある */
async function menuItem(page: Page, toggle: string, testId: string): Promise<Locator> {
  const more = page.getByTestId(toggle)
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  return page.getByTestId(testId)
}

async function reloadAccepting(page: Page) {
  // 保存していない編集がある間は、閉じる・再読み込みの前にブラウザの確認が出る
  page.once('dialog', (d) => void d.accept())
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__ns))
  await expect(page.getByText('読み込み中…')).toHaveCount(0)
}

test.describe('保存ボタン', () => {
  test('編集は「保存」を押すまでストアに入らず、未保存と出る。保存するとまとめて反映される', async ({ page }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const save = page.getByTestId('save-button')
    if (isDesktop(info)) await expect(save).toBeDisabled()
    else await expect(save).toBeHidden()
    await expect(page.locator('.save-status')).toBeVisible()

    const editor = page.getByTestId('active-editor')
    await appendTo(page, editor, '追記した一文。')
    await leaveEditor(page, editor)
    await page.getByTestId('subtitle-input').fill('旅立ちの朝')
    await expect(save).toBeEnabled()
    if (isDesktop(info)) await expect(page.getByTestId('unsaved-badge')).toHaveText('未保存')
    // 「保存済み」は出さない
    await expect(page.locator('.save-status')).toHaveCount(0)
    // 少し待ってもストアには入らない（ほかの端末にも送らない）
    await page.waitForTimeout(2500)
    expect(await storedBody(page, ids.v1)).toBe(BODY)
    expect(await storedSubtitle(page, ids.pieceId)).toBe('旅立ち')

    await save.click()
    await expect(page.getByText('保存しました').first()).toBeVisible()
    expect(await storedBody(page, ids.v1)).toBe(`${BODY}追記した一文。`)
    expect(await storedSubtitle(page, ids.pieceId)).toBe('旅立ちの朝')
    await expect(page.getByTestId('unsaved-badge')).toHaveCount(0)
    if (isDesktop(info)) await expect(save).toBeDisabled()
    else await expect(save).toBeHidden()
    await expect(page.locator('.save-status')).toBeVisible()
    // 保存した後は、確認なしで移動できる
    await page.getByTestId('next-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.secondId}$`))
  })

  test('「破棄」は確かめてから、保存した時の内容に戻す', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    await appendTo(page, editor, '捨てる')
    await leaveEditor(page, editor)
    await page.getByTestId('discard-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('保存していない編集を破棄しますか？')
    await dialog.getByRole('button', { name: '破棄' }).click()
    await expect(editor).toHaveValue(BODY)
    await expect(page.getByTestId('discard-button')).toHaveCount(0)
  })
})

test.describe('画面を離れる時の確認', () => {
  test('リンク・前後の話・ブラウザの戻るで確かめ、キャンセル・保存せずに移動・保存して移動を選べる', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    const dialog = page.getByRole('dialog')

    // パンくずのタイトル → キャンセルすると留まり、編集も残る
    await appendTo(page, editor, 'その一。')
    await leaveEditor(page, editor)
    await page.locator('.breadcrumbs').getByRole('link', { name: '猫の物語' }).click()
    await expect(dialog).toContainText('保存していない編集があります')
    await expect(dialog.getByRole('button', { name: '保存して移動' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '保存せずに移動' })).toBeVisible()
    await dialog.getByRole('button', { name: 'キャンセル' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/p/${ids.pieceId}$`))
    await expect(editor).toHaveValue(`${BODY}その一。`)

    // 次の話 → 保存せずに移動
    await page.getByTestId('next-piece').click()
    await dialog.getByRole('button', { name: '保存せずに移動' }).click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.secondId}$`))
    expect(await storedBody(page, ids.v1)).toBe(BODY)

    // 前の話に戻って書き、ブラウザの「戻る」→ 保存して移動
    await page.getByTestId('prev-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.pieceId}$`))
    await expect(editor).toHaveValue(BODY)
    await appendTo(page, editor, 'その二。')
    await leaveEditor(page, editor)
    await page.goBack()
    await expect(dialog).toContainText('保存していない編集があります')
    // 確かめている間は元の画面のまま
    await expect(page).toHaveURL(new RegExp(`/p/${ids.pieceId}$`))
    await dialog.getByRole('button', { name: '保存して移動' }).click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.secondId}$`))
    expect(await storedBody(page, ids.v1)).toBe(`${BODY}その二。`)
  })

  test('比較する稿を選び直す（同じ話の中）時は確かめず、編集もそのまま残る', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    const compare = page.getByTestId('compare-editor')
    await appendTo(page, compare, '推敲を足した。')
    await leaveEditor(page, compare)
    await page.getByTestId('version-select').selectOption(ids.v1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByTestId('version-select').selectOption(ids.v2)
    await expect(compare).toHaveValue('推敲中の本文。推敲を足した。')
    await expect(page.getByTestId('save-button')).toBeEnabled()
  })

  test('採用・複製・削除などの前に、保存していない編集を保存するか聞く', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    const compare = page.getByTestId('compare-editor')
    await appendTo(page, compare, '採用前の推敲。')
    await leaveEditor(page, compare)
    await page.getByTestId('adopt-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('保存していない編集があります。保存してから続けますか？')
    await dialog.getByRole('button', { name: 'キャンセル' }).click()
    expect(await page.evaluate((id) => window.__ns.getData().pieces[id].activeVersionId, ids.pieceId)).toBe(ids.v1)
    await page.getByTestId('adopt-button').click()
    await dialog.getByRole('button', { name: '保存して続ける' }).click()
    await expect(page.getByText('を採用しました')).toBeVisible()
    expect(await page.evaluate((id) => window.__ns.getData().pieces[id].activeVersionId, ids.pieceId)).toBe(ids.v2)
    expect(await storedBody(page, ids.v2)).toBe('推敲中の本文。採用前の推敲。')
  })
})

test.describe('端末内の控え', () => {
  test('保存しないまま閉じても、次に開いた時に「復元」で戻せる', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    const compare = page.getByTestId('compare-editor')
    await appendTo(page, compare, '落ちる直前の推敲。')
    await leaveEditor(page, compare)
    await page.getByTestId('subtitle-input').fill('控えの題')
    // 少し待つと端末内に控える（閉じる時にも控える）
    await expect
      .poll(() => page.evaluate((id) => localStorage.getItem(`novel-studio:edit:${id}`) ?? '', ids.pieceId))
      .toContain('控えの題')
    await reloadAccepting(page)

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(/前回保存されなかった編集があります（\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}）。復元しますか？/)
    await expect(dialog).toContainText('第2稿の本文・話の題')
    await dialog.getByTestId('restore-accept').click()
    await expect(page.getByTestId('compare-editor')).toHaveValue('推敲中の本文。落ちる直前の推敲。')
    await expect(page.getByTestId('subtitle-input')).toHaveValue('控えの題')
    await expect(page.getByTestId('save-button')).toBeEnabled()
    // 復元しただけではストアに入らない
    expect(await storedBody(page, ids.v2)).toBe('推敲中の本文。')
    await page.getByTestId('save-button').click()
    await expect(page.getByTestId('save-button')).not.toBeEnabled()
    expect(await storedBody(page, ids.v2)).toBe('推敲中の本文。落ちる直前の推敲。')
    expect(await page.evaluate((id) => localStorage.getItem(`novel-studio:edit:${id}`), ids.pieceId)).toBeNull()
  })

  test('「破棄」を選ぶと控えを消し、保存した時の内容のまま開く', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    await appendTo(page, page.getByTestId('active-editor'), '要らない編集')
    await reloadAccepting(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('restore-discard').click()
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY)
    expect(await page.evaluate((id) => localStorage.getItem(`novel-studio:edit:${id}`), ids.pieceId)).toBeNull()
    // もう聞かない
    await reloadAccepting(page)
    await expect(page.getByTestId('piece-workspace')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('打ち続けている間も、数秒ごとに控える', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    await page.getByTestId('active-editor').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('あいうえおかきくけこさしすせそたちつてと', { delay: 250 })
    // 打ち終わった直後（1秒待つ前）でも、途中までは控えてある
    const draft = await page.evaluate((id) => localStorage.getItem(`novel-studio:edit:${id}`), ids.pieceId)
    expect(draft).toContain('あいうえお')
  })
})

test.describe('巻き戻し／進む', () => {
  test('30手まで戻せて、進むでやり直せる。続けて打った文字は1手', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    const undoBtn = page.getByTestId('undo-button')
    const redoBtn = page.getByTestId('redo-button')
    await expect(undoBtn).toBeDisabled()

    // 続けて打った文字は1手。巻き戻すとカーソルも打つ前の位置に戻る
    await appendTo(page, editor, 'あいうえお')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toHaveValue(BODY)
    expect(await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(BODY.length)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(editor).toHaveValue(`${BODY}あいうえお`)
    await page.keyboard.press('ControlOrMeta+z')

    // 記号の挿入は1回で1手。35手入れて、戻せるのは30手
    for (let i = 0; i < 35; i++) await page.getByTestId('symbol-dash').click()
    await expect(editor).toHaveValue(BODY + '――'.repeat(35))
    await expect(editor).toBeFocused()
    for (let i = 0; i < 30; i++) await undoBtn.click()
    await expect(editor).toHaveValue(BODY + '――'.repeat(5))
    await expect(undoBtn).toBeDisabled()
    await page.keyboard.press('Control+y')
    await expect(editor).toHaveValue(BODY + '――'.repeat(6))
    for (let i = 0; i < 29; i++) await redoBtn.click()
    await expect(editor).toHaveValue(BODY + '――'.repeat(35))
    await expect(redoBtn).toBeDisabled()
  })

  test('日本語入力: 変換中の文字は1手ずつ積まず、確定した時に1手になる', async ({ page }, info) => {
    test.skip(!isDesktop(info), 'Chromium の日本語入力の再現（CDP）はデスクトップで行う')
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    const cdp = await page.context().newCDPSession(page)
    const compose = async (steps: string[], commit: string) => {
      for (const text of steps)
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      await cdp.send('Input.insertText', { text: commit })
    }
    await compose(['か', 'かん', 'かんじ', '漢字'], '漢字')
    await compose(['へ', 'へん', 'へんか', 'へんかん', '変換'], '変換')
    await expect(editor).toHaveValue(`${BODY}漢字変換`)
    // 確定ごとに1手（変換中の「かん」「かんじ」などには戻らない）
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toHaveValue(`${BODY}漢字`)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toHaveValue(BODY)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(editor).toHaveValue(`${BODY}漢字`)
  })

  test('長い本文でも、巻き戻した位置・記号を入れた位置が見えるようにスクロールする', async ({ page }) => {
    await openApp(page)
    const ids = await seed(page, ({ actions, getData }) => {
      const body = Array.from({ length: 200 }, (_, i) => `${i + 1}行目の文章です。`).join('\n')
      const titleId = actions.createTitle('長い作品')
      const pieceId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body })
      return { titleId, pieceId }
    })
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    await appendTo(page, editor, '末尾に足した')
    const scrolledToEnd = () => editor.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - el.clientHeight / 2)
    await editor.evaluate((el) => (el.scrollTop = 0))
    await page.getByTestId('undo-button').click()
    await expect.poll(scrolledToEnd).toBe(true)
    await editor.evaluate((el) => (el.scrollTop = 0))
    await page.getByTestId('symbol-dash').click()
    await expect.poll(scrolledToEnd).toBe(true)
    await expect(editor).toHaveValue(/200行目の文章です。――$/)
  })

  test('巻き戻しは欄ごと（推敲メモと本文は別々に戻る）', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    const compare = page.getByTestId('compare-editor')
    await appendTo(page, compare, '本文に足す')
    await leaveEditor(page, compare)
    await page.getByTestId('note-toggle').click()
    const note = page.getByTestId('version-note')
    await note.click()
    await page.keyboard.type('メモに書く')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(note).toHaveValue('')
    await expect(compare).toHaveValue('推敲中の本文。本文に足す')
  })
})

test.describe('記号バー', () => {
  test('ダッシュ・三点リーダー・全角空白・ルビ・傍点を、カーソルの位置に入れる（フォーカスは本文のまま）', async ({
    page,
  }, info) => {
    test.skip(!isDesktop(info), 'スマホは別のテストで確かめる')
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const bar = page.getByTestId('symbol-bar')
    const editor = page.getByTestId('active-editor')
    // 編集画面のいちばん下にあり、本文に重ならない
    const barBox = (await bar.boundingBox())!
    const viewport = page.viewportSize()!
    expect(Math.abs(barBox.y + barBox.height - viewport.height)).toBeLessThan(1)
    expect((await editor.boundingBox())!.y + (await editor.boundingBox())!.height).toBeLessThanOrEqual(barBox.y + 1)
    for (const id of ['symbol-dash', 'symbol-ellipsis', 'symbol-space', 'symbol-ruby', 'symbol-bouten']) {
      const b = (await page.getByTestId(id).boundingBox())!
      expect(b.height).toBeGreaterThanOrEqual(34)
      // まだどの欄にも書いていない
      await expect(page.getByTestId(id)).toBeDisabled()
    }

    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.getByTestId('symbol-dash').click()
    await page.getByTestId('symbol-ellipsis').click()
    await page.getByTestId('symbol-space').click()
    await expect(editor).toHaveValue(`${BODY}――……　`)
    await expect(editor).toBeFocused()

    // ルビ: 「猫」を選んで ｜猫《》、カーソルは《》の中
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 4))
    await page.getByTestId('symbol-ruby').click()
    await page.keyboard.type('ねこ')
    await expect(editor).toHaveValue(`吾輩は｜猫《ねこ》である。名前はまだ無い。――……　`)
    // 選ばずにルビ: ｜《》 でカーソルは ｜ の直後（親文字を打ってから、→ で《》の中へ）
    await page.keyboard.press('ControlOrMeta+End')
    await page.getByTestId('symbol-ruby').click()
    await page.keyboard.type('漢字')
    await expect(editor).toHaveValue(/――……　｜漢字《》$/)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('かんじ')
    await expect(editor).toHaveValue(/――……　｜漢字《かんじ》$/)
    // 傍点: 選ばずに 《《》》 でカーソルは真ん中
    await page.keyboard.press('ControlOrMeta+End')
    await page.getByTestId('symbol-bouten').click()
    await page.keyboard.type('強調')
    await expect(editor).toHaveValue(/《《強調》》$/)
    // 文字数は記号とルビの読みを数えない（吾輩は猫である。名前はまだ無い。16字＋――……2字＋漢字強調4字。全角空白は数えない）
    await expect(page.getByTestId('active-count')).toContainText('24字')

    // 話の題を書いている間は、記号は使えない（巻き戻しは使える）
    await page.getByTestId('subtitle-input').click()
    await expect(page.getByTestId('symbol-dash')).toBeDisabled()
    await page.keyboard.type('の朝')
    await page.getByTestId('undo-button').click()
    await expect(page.getByTestId('subtitle-input')).toHaveValue('旅立ち')
  })

  test.describe('スマホ', () => {
    test.skip(({ isMobile }) => !isMobile, 'スマホ（タッチ操作）のみ')

    test('キーボードが閉じている時は画面の下、開くとキーボードのすぐ上。押しても本文のフォーカスは外れない', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 780 })
      const ids = await seedWork(page)
      await openPiece(page, ids, ids.pieceId)
      const bar = page.getByTestId('symbol-bar')
      const editor = page.getByTestId('active-editor')
      const bottomOf = async (l: Locator) => {
        const b = (await l.boundingBox())!
        return b.y + b.height
      }
      expect(Math.abs((await bottomOf(bar)) - 780)).toBeLessThan(1)

      // Android: キーボードの分だけ画面が縮む
      await editor.tap()
      await page.setViewportSize({ width: 360, height: 460 })
      await expect.poll(() => bottomOf(bar)).toBeCloseTo(460, 0)
      // 本文（カーソルのある行）を隠さない
      expect(await bottomOf(editor)).toBeLessThanOrEqual((await bar.boundingBox())!.y + 1)
      await page.keyboard.press('ControlOrMeta+End')
      await page.getByTestId('symbol-ellipsis').tap()
      await expect(editor).toBeFocused()
      await expect(page.getByTestId('piece-workspace')).toHaveClass(/is-focus-mode/)
      await expect(editor).toHaveValue(`${BODY}……`)
      for (const id of ['undo-button', 'symbol-dash', 'symbol-ruby', 'symbol-bouten', 'symbol-save']) {
        const b = (await page.getByTestId(id).boundingBox())!
        expect(b.height).toBeGreaterThanOrEqual(34)
        expect(b.width).toBeGreaterThanOrEqual(34)
        // 幅 360px でも1行に収まる（記号バーの中でも横にはみ出さない）
        expect(b.x + b.width).toBeLessThanOrEqual(360)
      }
      // 画面上部を畳んでいる間も保存できる
      await page.getByTestId('symbol-save').tap()
      await expect(editor).toBeFocused()
      expect(await storedBody(page, ids.v1)).toBe(`${BODY}……`)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(0)
    })

    test('iPhone: 画面は縮まず見えている範囲（visualViewport）だけが縮んでも、記号バーをキーボードのすぐ上に出す', async ({
      page,
    }) => {
      // iOS Safari のキーボードを visualViewport の差し替えで再現する
      await page.addInitScript(() => {
        const w = window as unknown as { __kb: number; __setKeyboard: (px: number) => void }
        w.__kb = 0
        const target = new EventTarget()
        const fake = {
          get height() {
            return window.innerHeight - w.__kb
          },
          get width() {
            return window.innerWidth
          },
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1,
          addEventListener: target.addEventListener.bind(target),
          removeEventListener: target.removeEventListener.bind(target),
          dispatchEvent: target.dispatchEvent.bind(target),
        }
        Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake })
        w.__setKeyboard = (px: number) => {
          w.__kb = px
          target.dispatchEvent(new Event('resize'))
        }
      })
      await page.setViewportSize({ width: 390, height: 844 })
      const ids = await seedWork(page)
      await openPiece(page, ids, ids.pieceId)
      const bar = page.getByTestId('symbol-bar')
      const editor = page.getByTestId('active-editor')
      await editor.tap()
      await page.evaluate(() => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(330))
      await expect
        .poll(async () => {
          const b = (await bar.boundingBox())!
          return Math.round(b.y + b.height)
        })
        .toBe(844 - 330)
      const e = (await editor.boundingBox())!
      expect(e.y + e.height).toBeLessThanOrEqual((await bar.boundingBox())!.y + 1)
      await page.getByTestId('symbol-dash').tap()
      await expect(editor).toBeFocused()
      // キーボードを閉じると画面の下に戻る
      await page.evaluate(() => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(0))
      await expect
        .poll(async () => {
          const b = (await bar.boundingBox())!
          return Math.round(b.y + b.height)
        })
        .toBe(844)
    })
  })
})

test.describe('見出し付きのコピー', () => {
  test('採用原稿・推敲バージョン・特殊ブロックを、見出し（第n話　題）と保存していない編集ごとコピーする', async ({ page }) => {
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
    await openPiece(page, ids, ids.pieceId, ids.v2)

    // 採用原稿（保存していない編集を含む）
    const editor = page.getByTestId('active-editor')
    await appendTo(page, editor, '未保存の追記。')
    await leaveEditor(page, editor)
    await (await menuItem(page, 'active-more-button', 'copy-active')).click()
    await expect.poll(copied).toBe(`第1話　旅立ち\n\n${BODY}未保存の追記。`)

    // 採用していない推敲バージョン
    await (await menuItem(page, 'compare-more-button', 'copy-selected')).click()
    await expect.poll(copied).toBe('第1話　旅立ち\n\n推敲中の本文。')

    // 題がなければ「第2話」だけ
    await page.getByTestId('save-button').click()
    await page.getByTestId('next-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${ids.secondId}$`))
    await (await menuItem(page, 'active-more-button', 'copy-active')).click()
    await expect.poll(copied).toBe('第2話\n\n二話目の本文。')

    // 特殊ブロックは見出し（編集中の見出しを使う）
    await openPiece(page, ids, ids.specialId)
    await page.getByTestId('special-label-input').fill('序章')
    await (await menuItem(page, 'active-more-button', 'copy-active')).click()
    await expect.poll(copied).toBe('序章\n\n序の本文。')
  })
})

test.describe('スクリーンショット', () => {
  test('保存していない編集・確認のダイアログ・記号バー（ホワイト・ダーク）', async ({ page }, info) => {
    test.setTimeout(90_000)
    const project = info.project.name
    if (project === 'desktop') await page.setViewportSize({ width: 1400, height: 900 })
    else await page.setViewportSize({ width: 360, height: 760 })
    const ids = await seedWork(page)
    const dir = 'e2e/artifacts/screens'
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      const shot = async (name: string) => {
        await page.waitForTimeout(150)
        await page.screenshot({ path: `${dir}/editing-${project}-${scheme}-${name}.png` })
      }
      await openPiece(page, ids, ids.pieceId, ids.v2)
      await shot('clean')
      const compare = page.getByTestId('compare-editor')
      await appendTo(page, compare, '推敲を足した。')
      await shot('typing')
      await leaveEditor(page, compare)
      await shot('dirty')
      await page.getByTestId('next-piece').click()
      await shot('leave-dialog')
      await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()
      await reloadAccepting(page)
      await shot('restore-dialog')
      await page.getByTestId('restore-discard').click()
    }
  })
})
