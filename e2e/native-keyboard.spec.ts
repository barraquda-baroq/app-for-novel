// iPhone のアプリ（Capacitor）のキーボード: 画面は縮まず、キーボードの高さがアプリから届く（--kb-native。src/platform/keyboard.ts）。
// 開発用フック __ns.setNativeKeyboard で届いたことにして、記号バー・ダイアログ・ほかの画面の下端がキーボードの上に来ることを確かめる。
// iPhone の Safari・ホーム画面版（画面は縮まず、見えている範囲 visualViewport だけが縮む）は、偽の visualViewport で確かめる
// （src/platform/viewportKeyboard.ts の --kb・--kb-top）。
// Chromium（desktop・mobile）と、E2E_WEBKIT=1 の時は WebKit でも動かす（playwright.config.ts）。
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, openHomeBands, seed } from './helpers'

const W = 390
const H = 844
const KB = 336

const setKeyboard = (page: Page, px: number) => page.evaluate((h) => window.__ns.setNativeKeyboard(h), px)

const bottomOf = async (l: Locator) => {
  const b = (await l.boundingBox())!
  return Math.round(b.y + b.height)
}

const topOf = async (l: Locator) => Math.round((await l.boundingBox())!.y)

/** ホームのアイデアの帯の「どれにも属さない」の仕切りの［＋ フォルダ］で、フォルダの名前のダイアログを開く */
async function openFolderPrompt(page: Page): Promise<void> {
  await openApp(page)
  await openHomeBands(page, 'ideas')
  await page.locator('[data-testid="idea-section"][data-section="none"]').getByTestId('idea-folder-create').click()
  await expect(page.getByTestId('prompt-input')).toBeFocused()
}

/** シート（題・入力欄・［作る］）がすべて top〜bottom の間（キーボードの上の見えている範囲）にある */
async function expectSheetWithin(page: Page, top: number, bottom: number): Promise<void> {
  const backdrop = page.locator('.modal-backdrop')
  await expect.poll(() => bottomOf(backdrop)).toBe(bottom)
  expect(await topOf(backdrop)).toBe(top)
  const sheet = page.locator('.modal')
  await expect.poll(() => bottomOf(sheet)).toBeLessThanOrEqual(bottom)
  expect(await topOf(sheet)).toBeGreaterThanOrEqual(top)
  for (const l of [
    page.getByRole('heading', { name: 'フォルダを作る' }),
    page.getByTestId('prompt-input'),
    page.getByTestId('prompt-ok'),
  ]) {
    expect(await topOf(l)).toBeGreaterThanOrEqual(top)
    expect(await bottomOf(l)).toBeLessThanOrEqual(bottom)
  }
}

/** 名前を打って Enter で作る。ダイアログが閉じ、フォルダができる */
async function typeAndCreate(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId('prompt-input')).toBeFocused()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(page.locator('.modal-backdrop')).toHaveCount(0)
  await expect(page.locator('[data-testid="idea-folder-name"]', { hasText: name })).toBeVisible()
}

const kbVar = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--kb'))

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: W, height: H })
})

test('原稿画面: 記号バーがキーボードのすぐ上に来て、閉じると画面の下に戻る', async ({ page }) => {
  await openApp(page)
  const ids = await seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('猫の物語')
    const pieceId = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: '吾輩は猫である。\n名前はまだ無い。' })
    return { titleId, pieceId }
  })
  await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
  const bar = page.getByTestId('symbol-bar')
  const editor = page.getByTestId('active-editor')
  await expect(bar).toBeVisible()
  // ブラウザ（Web 版）には「キーボードを閉じる」を出さない（iPhone のアプリだけ）
  await expect(page.getByTestId('symbol-close-keyboard')).toHaveCount(0)
  await expect.poll(() => bottomOf(bar)).toBe(H)

  await editor.click()
  await setKeyboard(page, KB)
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(H)
  await expect.poll(() => bottomOf(bar)).toBe(H - KB)
  // 本文は記号バーの上で終わる（キーボードに隠れない）
  const bar1 = (await bar.boundingBox())!
  expect(await bottomOf(editor)).toBeLessThanOrEqual(Math.round(bar1.y) + 1)
  // 記号バーを押してもフォーカスは外れない
  await page.getByTestId('symbol-dash').click()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(/――/)
  // ページそのものはスクロールしない（キーボードの分を二重に詰めない・余白も足さない）
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(H)

  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(bar)).toBe(H)
})

test('原稿画面: 括弧の一覧はキーボードの上の記号バーの上に開き、「キーボードを閉じる」があっても記号バーは1行に収まる', async ({
  page,
}) => {
  await openApp(page)
  const ids = await seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('猫の物語')
    const pieceId = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: '吾輩は猫である。' })
    return { titleId, pieceId }
  })
  await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
  const bar = page.getByTestId('symbol-bar')
  const editor = page.getByTestId('active-editor')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('あ')
  await setKeyboard(page, KB)
  await expect.poll(() => bottomOf(bar)).toBe(H - KB)

  await page.getByTestId('symbol-brackets').click()
  const menu = page.getByTestId('bracket-menu')
  await expect(menu).toBeVisible()
  await expect(editor).toBeFocused()
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const barTop = Math.round((await bar.boundingBox())!.y)
  expect(await bottomOf(menu)).toBeLessThanOrEqual(barTop)
  expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(0)
  await page.getByTestId('bracket-kagi').click()
  await expect(editor).toHaveValue('吾輩は猫である。あ「」')
  await expect(editor).toBeFocused()
  // 開いている間にキーボードが閉じたら（下へ動いた）記号バーの上に置き直す
  await page.getByTestId('symbol-brackets').click()
  await expect(menu).toBeVisible()
  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(bar)).toBe(H)
  await expect.poll(async () => (await bottomOf(menu)) - Math.round((await bar.boundingBox())!.y)).toBeLessThanOrEqual(0)
  await expect.poll(() => bottomOf(menu)).toBeGreaterThan(H - KB)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await setKeyboard(page, KB)

  // iPhone のアプリでは「キーボードを閉じる」も並ぶ（ブラウザでは出ないので、同じ形のボタンを足して測る）。
  // 幅 375（SE・mini）と 390 でも、どのボタンも記号バーからはみ出さない
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="symbol-bar"]')!
    const stand = b.querySelector('[data-testid="undo-button"]')!.cloneNode(true) as HTMLElement
    stand.dataset.testid = 'stand-in-close-keyboard'
    b.appendChild(stand)
  })
  for (const width of [W, 375]) {
    await page.setViewportSize({ width, height: H })
    await expect
      .poll(() =>
        page.evaluate((w) => {
          const b = document.querySelector<HTMLElement>('[data-testid="symbol-bar"]')!
          const right = Math.max(...[...b.querySelectorAll('button')].map((x) => x.getBoundingClientRect().right))
          return b.scrollWidth <= b.clientWidth && right <= w
        }, width),
      )
      .toBe(true)
  }
  await setKeyboard(page, 0)
})

test('ダイアログ: 背景とダイアログの下端がキーボードの上に来る', async ({ page }) => {
  await openApp(page)
  await openHomeBands(page, 'ideas')
  await page.locator('[data-testid="idea-section"][data-section="none"]').getByTestId('idea-add').click()
  const body = page.getByTestId('idea-body-input')
  await expect(body).toBeVisible()
  await body.click()
  await setKeyboard(page, KB)
  const backdrop = page.locator('.modal-backdrop')
  await expect.poll(() => bottomOf(backdrop)).toBe(H - KB)
  await expect.poll(() => bottomOf(page.locator('.modal'))).toBeLessThanOrEqual(H - KB)
  // 保存ボタン（ダイアログの下端）もキーボードに隠れない
  expect(await bottomOf(page.getByTestId('idea-save'))).toBeLessThanOrEqual(H - KB)
  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(backdrop)).toBe(H)
})

test('フォルダの名前のダイアログ: 題・入力欄・［作る］がキーボードの上に来て、名前を付けて作れる', async ({ page }) => {
  await openFolderPrompt(page)
  await setKeyboard(page, KB)
  await expectSheetWithin(page, 0, H - KB)
  await setKeyboard(page, 0)
  await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(H)
  await setKeyboard(page, KB)
  await typeAndCreate(page, '港町の相談')
  await setKeyboard(page, 0)
})

test('ほかの画面: いちばん下の欄までキーボードの上にスクロールできる', async ({ page }) => {
  await openApp(page, '/settings')
  await expect(page.getByTestId('app-settings')).toBeVisible()
  const before = await page.evaluate(() => document.documentElement.scrollHeight)
  await setKeyboard(page, KB)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(before + KB)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const main = page.getByTestId('app-settings')
  await expect.poll(() => bottomOf(main)).toBeLessThanOrEqual(H - KB)
  await setKeyboard(page, 0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(before)
})

test('原稿画面: 検索窓と見つけた所がキーボードの上にある', async ({ page }) => {
  await openApp(page)
  const ids = await seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('猫の物語')
    const pieceId = actions.addEpisode(titleId)
    const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}行目の文章です。`)
    lines[90] = '91行目に目印がある。'
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: lines.join('\n') })
    return { titleId, pieceId }
  })
  await openApp(page, `/t/${ids.titleId}/p/${ids.pieceId}`)
  // WebKit（Desktop Safari の UA は Mac なので ⌘F になる）でも同じに動くよう、ショートカットではなくボタンで開く
  await page.getByTestId('active-search-toggle').click()
  const input = page.getByTestId('active-search-input')
  await expect(input).toBeFocused()
  await page.keyboard.type('目印')
  await expect(page.getByTestId('active-search-count')).toHaveText('1／1')
  await setKeyboard(page, KB)
  const bar = page.getByTestId('symbol-bar')
  await expect.poll(() => bottomOf(bar)).toBe(H - KB)
  expect(await bottomOf(page.getByTestId('active-search'))).toBeLessThanOrEqual(H - KB)
  // キーボードが出て本文欄が縮んでも、見つけた所は本文欄の見えている所（キーボードの上）にある
  const rect = page.getByTestId('active-search-hit').locator('.pw-hit-rect')
  const editor = page.getByTestId('active-editor')
  await expect
    .poll(async () => {
      const r = await rect.boundingBox()
      const e = await editor.boundingBox()
      return r !== null && e !== null && r.y >= e.y && r.y + r.height <= e.y + e.height && r.y + r.height <= H - KB
    })
    .toBe(true)
  await expect(input).toBeFocused()
  await setKeyboard(page, 0)
})

test.describe('ブラウザ（iPhone の Safari・ホーム画面版）: 見えている範囲だけが縮む', () => {
  /**
   * 見えている範囲を kb だけ縮め、top だけ下げたことにする（偽の visualViewport。resize と scroll を送る）。
   * quiet: 知らせずに値だけ変える（次の画面の大きさの変化と同時に変わったことにする）
   */
  const setVisible = (page: Page, kb: number, top = 0, quiet = false) =>
    page.evaluate(
      ([k, t, q]) => (window as unknown as { __vv: (kb: number, top: number, quiet: boolean) => void }).__vv(k, t, q),
      [kb, top, quiet] as const,
    )

  test.beforeEach(async ({ page }) => {
    // WebKit は interactive-widget=resizes-content を使わず、レイアウトの表示領域（innerHeight）はそのまま、visualViewport だけが縮む。
    // 初期化のスクリプトの時点では document.documentElement はまだ無いので、window だけを触る
    await page.addInitScript(() => {
      const st = { kb: 0, top: 0 }
      const t = new EventTarget()
      const fake = {
        get height() {
          return innerHeight - st.kb
        },
        get width() {
          return innerWidth
        },
        get offsetTop() {
          return st.top
        },
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
        addEventListener: t.addEventListener.bind(t),
        removeEventListener: t.removeEventListener.bind(t),
        dispatchEvent: t.dispatchEvent.bind(t),
      }
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake })
      ;(window as unknown as { __vv: (kb: number, top?: number, quiet?: boolean) => void }).__vv = (kb, top = 0, quiet) => {
        st.kb = kb
        st.top = top
        if (quiet) return
        t.dispatchEvent(new Event('resize'))
        t.dispatchEvent(new Event('scroll'))
      }
    })
  })

  test('フォルダの名前のダイアログ: 見えている範囲に収まり、Safari が範囲を下げても追う。名前を付けて作れる', async ({
    page,
  }) => {
    await openFolderPrompt(page)
    await setVisible(page, KB)
    await expectSheetWithin(page, 0, H - KB)
    // Safari が入力欄を見せるために見えている範囲を 120px 下げた（シートも一緒に下がり、上にはみ出さない）
    await setVisible(page, KB, 120)
    await expectSheetWithin(page, 120, H - KB + 120)
    // ツールバーほどの差（100px 未満）はキーボードと見なさない
    await setVisible(page, 60)
    await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(H)
    expect(await topOf(page.locator('.modal-backdrop'))).toBe(0)
    await setVisible(page, KB)
    await typeAndCreate(page, '港町の相談')
    // ダイアログを閉じて入力欄も無くなったら測らない
    await expect.poll(() => kbVar(page)).toBe('')
    await setVisible(page, 0)
  })

  test('入力欄にフォーカスが無く、ダイアログも無い時は測らない。入力欄に入ると測る', async ({ page }) => {
    await openApp(page)
    await openHomeBands(page, 'ideas')
    await setVisible(page, KB)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect(await kbVar(page)).toBe('')
    await page.getByTestId('quick-idea-input').focus()
    await expect.poll(() => kbVar(page)).toBe(`${KB}px`)
    // 通知の出る所もキーボードの上（下から 16px）
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.toasts')!.getBoundingClientRect().bottom))
      .toBe(H - KB - 16)
    await page.getByTestId('quick-idea-input').blur()
    await expect.poll(() => kbVar(page)).toBe('')
    await setVisible(page, 0)
  })

  test('アプリから届いた高さと測った高さが両方あっても、二重に上げない', async ({ page }) => {
    await openFolderPrompt(page)
    await setKeyboard(page, KB)
    await setVisible(page, KB)
    await expectSheetWithin(page, 0, H - KB)
    await setVisible(page, 0)
    await setKeyboard(page, 0)
    await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(H)
  })

  /** field のうち、.modal-body の中で、しかもキーボードの上（bottom より上）に見えている高さ */
  const shownIn = async (page: Page, field: Locator, bottom: number) => {
    const f = (await field.boundingBox())!
    const b = (await page.locator('.modal-body').boundingBox())!
    return Math.round(Math.min(f.y + f.height, b.y + b.height, bottom) - Math.max(f.y, b.y, 0))
  }

  test('横向きにした時（キーボードは低くなるが、見えている範囲はもっと低くなる）も、フォーカスしている欄が見える所に出る', async ({
    page,
  }) => {
    // フォルダの名前のダイアログ（入力欄は1つ）
    await openFolderPrompt(page)
    await setVisible(page, KB)
    await expectSheetWithin(page, 0, H - KB)
    // 390×844 → 844×390。キーボードは 336 → 200 になり、見えている範囲は 508 → 190（端末では画面とキーボードが一緒に変わる）
    const LKB = 200
    await setVisible(page, LKB, 0, true)
    await page.setViewportSize({ width: H, height: W })
    await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(W - LKB)
    const input = page.getByTestId('prompt-input')
    await expect(input).toBeFocused()
    const inputH = Math.round((await input.boundingBox())!.height)
    await expect.poll(() => shownIn(page, input, W - LKB)).toBeGreaterThanOrEqual(inputH - 1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)

    // 入力欄の多いダイアログ（資料を追加）のメモ欄。欄が見えている範囲より高い時は、欄の上から見える所に出る
    await setVisible(page, 0)
    await page.setViewportSize({ width: W, height: H })
    await openHomeBands(page, 'materials')
    await page.getByTestId('new-material').click()
    const memo = page.getByTestId('material-memo')
    await memo.click()
    await expect(memo).toBeFocused()
    await setVisible(page, KB)
    await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(H - KB)
    await setVisible(page, LKB, 0, true)
    await page.setViewportSize({ width: H, height: W })
    await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(W - LKB)
    await expect(memo).toBeFocused()
    const memoH = Math.round((await memo.boundingBox())!.height)
    const bodyH = Math.round((await page.locator('.modal-body').boundingBox())!.height)
    await expect.poll(() => shownIn(page, memo, W - LKB)).toBeGreaterThanOrEqual(Math.min(memoH, bodyH) - 1)
    await setVisible(page, 0)
  })

  test('指で操作する端末: ダイアログと書きとめる欄の入力欄は 16px 未満にしない（Safari が拡大して測れなくならない）', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'mobile', '指で操作する端末（pointer: coarse）だけ')
    /** 文字を打つ欄・選ぶ欄の字の大きさ（px） */
    const sizes = (selector: string) =>
      page.evaluate(
        (sel) =>
          [...document.querySelectorAll<HTMLElement>(sel)]
            .filter((e) => !(e instanceof HTMLInputElement) || !['checkbox', 'radio', 'hidden'].includes(e.type))
            .map((e) => parseFloat(getComputedStyle(e).fontSize)),
        selector,
      )
    const fields = '.modal input, .modal textarea, .modal select'
    // 書きとめる欄: 横向き（幅が 720px より広い）でも
    await openApp(page)
    await openHomeBands(page, 'ideas')
    await page.setViewportSize({ width: H, height: W })
    const capture = await sizes('.idea-capture-input, .idea-capture-select')
    expect(capture).toHaveLength(2)
    for (const px of capture) expect(px).toBeGreaterThanOrEqual(16)
    await page.setViewportSize({ width: W, height: H })
    // フォルダの名前のダイアログ
    await page.locator('[data-testid="idea-section"][data-section="none"]').getByTestId('idea-folder-create').click()
    await expect(page.getByTestId('prompt-input')).toBeFocused()
    expect(await sizes(fields)).toEqual([16])
    await page.keyboard.press('Escape')
    // 設定タブの項目を足すダイアログ（テンプレートの欄は、画面では 15px）
    const titleId = await seed(page, ({ actions }) => actions.createTitle('星の海'))
    await openApp(page, `/t/${titleId}?tab=settings`)
    await page.getByTestId('add-category').first().click()
    await expect(page.getByTestId('category-template-input')).toBeVisible()
    const dialog = await sizes(fields)
    expect(dialog.length).toBeGreaterThanOrEqual(2)
    for (const px of dialog) expect(px).toBeGreaterThanOrEqual(16)
  })

  test('入力欄の多いダイアログ（資料を追加）: フォーカスした欄がキーボードの上の見える所に出る', async ({ page }) => {
    await openApp(page)
    await openHomeBands(page, 'materials')
    await page.getByTestId('new-material').click()
    const memo = page.getByTestId('material-memo')
    await memo.click()
    await expect(memo).toBeFocused()
    await setVisible(page, KB)
    await expect.poll(() => bottomOf(page.locator('.modal-backdrop'))).toBe(H - KB)
    const body = page.locator('.modal-body')
    await expect
      .poll(async () => {
        const m = (await memo.boundingBox())!
        const b = (await body.boundingBox())!
        return m.y >= Math.max(0, b.y - 1) && m.y + m.height <= Math.min(H - KB, b.y + b.height) + 1
      })
      .toBe(true)
    // 保存のボタン（シートの下端）もキーボードに隠れない
    expect(await bottomOf(page.getByTestId('material-save'))).toBeLessThanOrEqual(H - KB)
    await setVisible(page, 0)
  })
})
