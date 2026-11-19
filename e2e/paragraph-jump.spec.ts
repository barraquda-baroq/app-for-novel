// 原稿画面の「段落」（ペインのヘッダーの「検索」の右）の E2E テスト。
// Claude の推敲の指摘の段落の番号（¶。空行・空白だけの行を数えない。コネクタと同じ）へ移れること、移った段落が本文欄の上の方に見えて
// 印が付くこと、一覧から選べること、保存していない編集で番号がずれること、幕は幕の本文で数えること、狭い画面で横にはみ出さないこと、
// 押す所の大きさ、Esc・Android の「戻る」で閉じることを確かめる（パソコン・スマホ）
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { noHorizontalScroll, openApp, seed } from './helpers'

const isDesktop = (info: TestInfo) => info.project.name === 'desktop'
const press = (l: Locator, info: TestInfo) => (isDesktop(info) ? l.click() : l.tap())

/** 段落の数 */
const COUNT = 400

/**
 * 400段落・約2万字の本文。先頭に空行、段落の間に空行（ところどころ空白だけの行も）、3段落目にルビ・傍点。
 * 段落の頭は全角空白で字下げする
 */
function manyParagraphs(): string {
  const lines: string[] = ['', '']
  for (let i = 1; i <= COUNT; i++) {
    const extra = i === 3 ? '｜漢字《かんじ》と《《傍点》》の' : ''
    lines.push(`　第${i}段落の目印。${extra}ここは折り返しが起きるくらいの長さの地の文です。`)
    lines.push(i % 7 === 0 ? '　 ' : '')
  }
  return lines.join('\n')
}

/** 一覧の行の書き出し（20字。長ければ「…」） */
function head(text: string): string {
  const chars = [...text]
  return chars.length > 20 ? `${chars.slice(0, 20).join('')}…` : text
}

/** n 段落目の地の文（記法を除き、字下げを除いた形） */
const plain = (n: number) => `第${n}段落の目印。${n === 3 ? '漢字と傍点の' : ''}ここは折り返しが起きるくらいの長さの地の文です。`

/** n 段落目の頭の位置（空行・空白だけの行は数えない） */
function paragraphStart(body: string, n: number): number {
  let pos = 0
  let k = 0
  for (const line of body.split('\n')) {
    if (/[^ 　\t]/.test(line)) {
      k += 1
      if (k === n) return pos
    }
    pos += line.length + 1
  }
  throw new Error(`${n} 段落目がありません`)
}

interface Ids {
  titleId: string
  pieceId: string
  v2: string
  actsPieceId: string
  acts: string[]
  body: string
}

async function seedWork(page: Page): Promise<Ids> {
  await openApp(page)
  const body = manyParagraphs()
  return seed(
    page,
    ({ actions, getData }, body: string) => {
      const titleId = actions.createTitle('段落の作品')
      const pieceId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body })
      // 推敲バージョン: 2段落目を書き換えた稿（差分の表示で、削除された文字と足した文字が出る）
      const v2 = actions.addVersion(pieceId, { body: body.replace('第2段落の目印。', '第2段落の書き換えた印。') })
      // 幕に分ける話: 第1幕に3段落、第2幕に2段落
      const act1 = '幕一の一段落目。\n\n幕一の二段落目。\n　\n幕一の三段落目。\n\n'
      const act2 = '幕二の一段落目。\n\n\n幕二の二段落目。'
      const actsPieceId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[actsPieceId].versionIds[0], { body: act1 + act2 })
      const acts = actions.separatePiece(actsPieceId, [act1.length])
      return { titleId, pieceId, v2, actsPieceId, acts, body }
    },
    body,
  )
}

async function openPiece(page: Page, ids: Ids, pieceId: string, versionId?: string) {
  await openApp(page, `/t/${ids.titleId}/p/${pieceId}${versionId ? `?v=${versionId}` : ''}`)
  await expect(page.getByTestId('piece-workspace')).toBeVisible()
}

/** 開いた一覧（パソコンはポップオーバー、スマホは下からのシート） */
const panel = (page: Page) => page.getByTestId('para-jump-panel')

/**
 * 印の最初の行の矩形の真ん中と、その行の字の真ん中の差（px。正なら印が字より下）。印を隠して本文欄を撮り、
 * 暗い点のある行のかたまりのうち、印の矩形にいちばん近いものをその行の字とする
 */
async function markOffsetFromGlyphs(page: Page, rect: Locator, field: Locator): Promise<number> {
  const r = (await rect.boundingBox())!
  const f = (await field.boundingBox())!
  const padLeft = await field.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  const layers = (v: string) =>
    page.evaluate((v) => document.querySelectorAll<HTMLElement>('.pw-hit-layer').forEach((e) => (e.style.visibility = v)), v)
  await layers('hidden')
  // 行の頭（カーソル・字下げ）を避け、字のある所だけを撮る
  const clip = { x: f.x + padLeft + 24, y: Math.max(f.y, r.y - 30), width: Math.min(240, r.width - 32), height: r.height + 60 }
  const png = await page.screenshot({ clip, scale: 'css' })
  await layers('')
  const rows = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    return Array.from({ length: c.height }, (_, y) => {
      let dark = 0
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (d[i] + d[i + 1] + d[i + 2] < 300) dark++
      }
      return dark
    })
  }, png.toString('base64'))
  const bands: [number, number][] = []
  let s = -1
  rows.forEach((v, y) => {
    if (v > 0 && s < 0) s = y
    if (v === 0 && s >= 0) {
      bands.push([s, y - 1])
      s = -1
    }
  })
  if (s >= 0) bands.push([s, rows.length - 1])
  const mid = r.y - clip.y + r.height / 2
  const center = ([a, b]: [number, number]) => (a + b) / 2
  const glyphs = bands.filter(([a, b]) => b - a >= 6).sort((p, q) => Math.abs(center(p) - mid) - Math.abs(center(q) - mid))[0]
  expect(glyphs, '印のそばに字の行がある').toBeTruthy()
  return mid - center(glyphs)
}

/** 本文欄のスクロールの位置（描き直しを2回待ってから読む） */
const scrollTopAfterFrames = (field: Locator) =>
  field.evaluate(
    (el) =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(el.scrollTop), 50))),
      ),
  )

/** 推敲案（チェックしていないもの）を2件足す（採用原稿のヘッダーに「推敲案 2」が出る） */
async function seedProofs(page: Page, ids: Ids): Promise<void> {
  await seed(
    page,
    ({ actions }, a: { titleId: string; pieceId: string }) => {
      for (const n of [3, 4])
        actions.addProofSuggestion(a.titleId, {
          pieceId: a.pieceId,
          excerpt: `第${n}段落の目印。`,
          suggestion: '直す',
          reason: '理由',
        })
    },
    { titleId: ids.titleId, pieceId: ids.pieceId },
  )
}

/** 移った段落の印の最初の行が、本文欄の見えている所の上の方（上から3分の1まで）にある */
async function markNearTop(rect: Locator, field: Locator): Promise<boolean> {
  const r = await rect.boundingBox()
  const f = await field.boundingBox()
  if (!r || !f) return false
  return r.width > 0 && r.y >= f.y - 1 && r.y + r.height <= f.y + f.height + 1 && r.y < f.y + f.height / 3
}

test.describe('段落へ移る', () => {
  test('番号を打って Enter で、その段落（空行を数えない）が本文欄の上の方に見えて印が付く。パソコンはカーソルを段落の頭に、スマホはキーボードを出さない', async ({
    page,
  }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    const toggle = page.getByTestId('active-para-toggle')
    // 「検索」のすぐ右
    const search = (await page.getByTestId('active-search-toggle').boundingBox())!
    const t = (await toggle.boundingBox())!
    expect(Math.abs(t.y - search.y)).toBeLessThan(2)
    expect(t.x).toBeGreaterThan(search.x + search.width - 1)
    expect(t.x - (search.x + search.width)).toBeLessThan(12)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    const opened = Date.now()
    await press(toggle, info)
    await expect(panel(page)).toBeVisible()
    await expect(page.getByTestId('para-jump-item')).toHaveCount(COUNT)
    // 400段落・2万字でも待たせない
    expect(Date.now() - opened).toBeLessThan(3000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('para-jump-total')).toHaveText('全400段落')
    const input = page.getByTestId('para-jump-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('inputmode', 'numeric')

    await page.keyboard.type('28')
    // 打った番号の行に印が付き、見える所に出る
    const row = page.locator('[data-testid="para-jump-item"][data-n="28"]')
    await expect(row).toHaveClass(/is-target/)
    await expect(row).toBeInViewport()
    await expect(row).toHaveText(`¶28　${head(plain(28))}`)
    await page.keyboard.press('Enter')
    await expect(panel(page)).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    const hit = page.getByTestId('active-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '28')
    const start = paragraphStart(ids.body, 28)
    await expect(hit).toHaveAttribute('data-start', String(start))
    expect(Number(await hit.getAttribute('data-end'))).toBe(ids.body.indexOf('\n', start))
    const rect = hit.locator('.pw-para-rect').first()
    await expect.poll(() => markNearTop(rect, editor)).toBe(true)
    await expect(hit.locator('.pw-para-bar')).toHaveCount(1)
    if (isDesktop(info)) {
      await expect(editor).toBeFocused()
      expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([start, start])
      // 印は本文欄にフォーカスがあっても出たまま。キーを押すと消える
      await page.keyboard.press('ArrowDown')
      await expect(hit).toHaveCount(0)
    } else {
      // 開く前に本文欄にいなかったので、本文欄にフォーカスしない（キーボードを出さない）
      await expect(editor).not.toBeFocused()
      expect(await page.evaluate(() => document.activeElement?.matches('input, textarea') ?? false)).toBe(false)
      // 本文欄をスクロールしても印は付いていく（消えない）
      const before = (await rect.boundingBox())!.y
      await editor.evaluate((el) => (el.scrollTop += 40))
      await expect.poll(async () => Math.round(before - (await rect.boundingBox())!.y)).toBe(40)
      // 本文欄を押すと消える
      await editor.tap()
      await expect(hit).toHaveCount(0)
    }
    // 本文は変えない
    await expect(page.getByTestId('save-button')).toBeDisabled()
  })

  test('一覧から ¶3 を選ぶ（書き出しはルビ・傍点の記法を除く）。開き直すと移った段落に印が付いている。無い番号は移らずに言う', async ({
    page,
  }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const toggle = page.getByTestId('active-para-toggle')
    await press(toggle, info)
    await expect(page.getByTestId('para-jump-item').first()).toHaveText(`¶1　${head(plain(1))}`)
    const third = page.locator('[data-testid="para-jump-item"][data-n="3"]')
    await expect(third).toHaveText(`¶3　${head(plain(3))}`)
    await expect(third).not.toContainText('《')
    await press(third, info)
    await expect(panel(page)).toHaveCount(0)
    const hit = page.getByTestId('active-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '3')
    await expect(hit).toHaveAttribute('data-start', String(paragraphStart(ids.body, 3)))
    await expect.poll(() => markNearTop(hit.locator('.pw-para-rect').first(), page.getByTestId('active-editor'))).toBe(true)

    await press(toggle, info)
    const current = page.locator('[data-testid="para-jump-item"][aria-current]')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-n', '3')
    // 範囲の外: 言うだけで移らない（一覧は開いたまま）。言葉を出す所（role="status"）は、空の間も読み上げの対象に残っている
    // （言葉と一緒に現れると読み上げない）
    const status = panel(page).getByRole('status')
    await expect(status).toHaveCount(1)
    await expect(status).toHaveText('')
    const input = page.getByTestId('para-jump-input')
    await input.fill('401')
    await expect(status).toHaveText('¶401 はありません（この稿は全400段落です）')
    await expect(page.getByTestId('para-jump-status')).toHaveText('¶401 はありません（この稿は全400段落です）')
    await input.press('Enter')
    await expect(panel(page)).toBeVisible()
    await expect(hit).toHaveAttribute('data-paragraph', '3')
    // 「¶」付き・全角の数字も受け付ける
    await input.fill('¶４００')
    await expect(page.getByTestId('para-jump-status')).toHaveText('')
    await press(page.getByTestId('para-jump-go'), info)
    await expect(panel(page)).toHaveCount(0)
    await expect(hit).toHaveAttribute('data-paragraph', '400')
    await expect(hit).toHaveAttribute('data-start', String(paragraphStart(ids.body, 400)))
    await expect.poll(async () => (await hit.locator('.pw-para-rect').first().boundingBox()) !== null).toBe(true)
    const r = (await hit.locator('.pw-para-rect').first().boundingBox())!
    const f = (await page.getByTestId('active-editor').boundingBox())!
    expect(r.y).toBeGreaterThanOrEqual(f.y - 1)
    expect(r.y + r.height).toBeLessThanOrEqual(f.y + f.height + 1)
  })

  test('保存していない編集で段落を足すと、番号がずれる（欄の今の本文で数える）。開く前に本文欄にいたら本文欄に戻る', async ({
    page,
  }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    await press(editor, info)
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0))
    await page.keyboard.type('足した段落。')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('save-button')).toBeEnabled()
    const live = await editor.inputValue()

    await press(page.getByTestId('active-para-toggle'), info)
    await expect(page.getByTestId('para-jump-total')).toHaveText('全401段落')
    await expect(page.getByTestId('para-jump-item').first()).toHaveText('¶1　足した段落。')
    // カーソルは足した段落の次の行（空行）なので、次の段落（元の1段落目）に印
    await expect(page.locator('[data-testid="para-jump-item"][aria-current]')).toHaveAttribute('data-n', '2')
    await page.keyboard.type('28')
    await page.keyboard.press('Enter')
    const hit = page.getByTestId('active-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '28')
    const start = paragraphStart(live, 28)
    await expect(hit).toHaveAttribute('data-start', String(start))
    expect(live.slice(start).startsWith('　第27段落の目印。')).toBe(true)
    // 開く前に本文欄にいたので、スマホでも本文欄に戻ってカーソルを段落の頭に置く
    await expect(editor).toBeFocused()
    expect(await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(start)
    // 打つと印は消え、打った文字は段落の頭に入る
    await page.keyboard.type('★')
    await expect(hit).toHaveCount(0)
    expect((await editor.inputValue()).slice(start, start + 2)).toBe('★　')
  })

  test('幕は幕の本文で1から数える', async ({ page }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.acts[1])
    await press(page.getByTestId('active-para-toggle'), info)
    await expect(page.getByTestId('para-jump-total')).toHaveText('全2段落')
    await expect(page.getByTestId('para-jump-item')).toHaveText(['¶1　幕二の一段落目。', '¶2　幕二の二段落目。'])
    await page.keyboard.type('3')
    await expect(page.getByTestId('para-jump-status')).toHaveText('¶3 はありません（この稿は全2段落です）')
    await page.getByTestId('para-jump-input').fill('2')
    await page.keyboard.press('Enter')
    const hit = page.getByTestId('active-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '2')
    const body = await page.getByTestId('active-editor').inputValue()
    await expect(hit).toHaveAttribute('data-start', String(body.indexOf('幕二の二段落目。')))

    // 第1幕は第1幕の本文で数える
    await openPiece(page, ids, ids.acts[0])
    await press(page.getByTestId('active-para-toggle'), info)
    await expect(page.getByTestId('para-jump-total')).toHaveText('全3段落')
    await expect(page.getByTestId('para-jump-item').last()).toHaveText('¶3　幕一の三段落目。')
  })

  test('長い原稿の後ろの方の段落でも、印は字の行に重なる（本文欄の本当の行の送りで測る）', async ({ page }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    const hit = page.getByTestId('active-para-hit')
    for (const n of [2, 380]) {
      await press(page.getByTestId('active-para-toggle'), info)
      await page.getByTestId('para-jump-input').fill(String(n))
      await page.keyboard.press('Enter')
      await expect(hit).toHaveAttribute('data-paragraph', String(n))
      const rect = hit.locator('.pw-para-rect').first()
      await expect.poll(() => markNearTop(rect, editor)).toBe(true)
      expect(Math.abs(await markOffsetFromGlyphs(page, rect, editor)), `¶${n}`).toBeLessThanOrEqual(3)
    }
  })

  test('移った後に本文欄をスクロールして読み進めたら、本文欄の大きさが変わっても段落へ引き戻さない（スクロールしていなければ段落の位置を保つ）', async ({
    page,
  }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    const hit = page.getByTestId('active-para-hit')
    const rect = hit.locator('.pw-para-rect').first()
    const searchToggle = page.getByTestId('active-search-toggle')
    await press(page.getByTestId('active-para-toggle'), info)
    await page.getByTestId('para-jump-input').fill('41')
    await page.keyboard.press('Enter')
    await expect(hit).toHaveAttribute('data-paragraph', '41')
    await expect.poll(() => markNearTop(rect, editor)).toBe(true)
    // スクロールしていなければ、検索窓を開いて本文欄の大きさが変わっても（パソコンは縮み、スマホは上が畳まれて伸びる）段落は上の方のまま
    const before = (await editor.boundingBox())!.height
    await press(searchToggle, info)
    await expect(page.getByTestId('active-search')).toBeVisible()
    await expect.poll(async () => (await editor.boundingBox())!.height).not.toBe(before)
    await expect.poll(() => markNearTop(rect, editor)).toBe(true)
    await press(searchToggle, info)
    await expect(page.getByTestId('active-search')).toHaveCount(0)

    // 読み進めてスクロールした後は、検索窓を開いても戻さない（印は残る）
    const scrolled = await editor.evaluate((el) => (el.scrollTop += 2000))
    await press(searchToggle, info)
    await expect(page.getByTestId('active-search')).toBeVisible()
    expect(Math.abs((await scrollTopAfterFrames(editor)) - scrolled)).toBeLessThanOrEqual(2)
    await expect(hit).toHaveAttribute('data-paragraph', '41')
    // 閉じて本文欄が伸びても戻さない
    await press(searchToggle, info)
    expect(Math.abs((await scrollTopAfterFrames(editor)) - scrolled)).toBeLessThanOrEqual(2)
  })

  test('Esc・Android の「戻る」で閉じる', async ({ page }, info) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const toggle = page.getByTestId('active-para-toggle')
    await press(toggle, info)
    await expect(panel(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    // 開く前に本文欄にいなかったので「段落」へ戻る
    await expect(toggle).toBeFocused()
    await expect(page.getByTestId('active-para-hit')).toHaveCount(0)

    await press(toggle, info)
    await expect(panel(page)).toBeVisible()
    expect(await page.evaluate(() => window.__ns.androidBack())).toBe(true)
    await expect(panel(page)).toHaveCount(0)
    // 欄ごとの検索窓が開いていても、「戻る」1回で閉じるのは上の一覧だけ
    await press(page.getByTestId('active-search-toggle'), info)
    await expect(page.getByTestId('active-search')).toBeVisible()
    await press(toggle, info)
    await expect(panel(page)).toBeVisible()
    expect(await page.evaluate(() => window.__ns.androidBack())).toBe(true)
    await expect(panel(page)).toHaveCount(0)
    await expect(page.getByTestId('active-search')).toBeVisible()
    expect(await page.evaluate(() => window.__ns.androidBack())).toBe(true)
    await expect(page.getByTestId('active-search')).toHaveCount(0)
  })
})

test.describe('パソコン', () => {
  test.skip(({ isMobile }) => isMobile, 'パソコンのみ')

  test('ポップオーバーは「段落」の下に開き、↓↑ で行を動いて Enter で移る。外側を押すと閉じる', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const toggle = page.getByTestId('active-para-toggle')
    await toggle.click()
    const pop = page.getByTestId('para-jump-pop')
    await expect(pop).toBeVisible()
    await expect(pop).toHaveAttribute('role', 'dialog')
    const t = (await toggle.boundingBox())!
    const p = (await pop.boundingBox())!
    expect(p.y).toBeGreaterThanOrEqual(t.y + t.height)
    // 番号の欄は上に残り、一覧だけがスクロールする
    const list = page.getByTestId('para-jump-list')
    await list.evaluate((el) => (el.scrollTop = 2000))
    await expect(page.getByTestId('para-jump-input')).toBeInViewport()
    await list.evaluate((el) => (el.scrollTop = 0))
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-testid="para-jump-item"][data-n="1"]')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-testid="para-jump-item"][data-n="3"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(pop).toHaveCount(0)
    await expect(page.getByTestId('active-para-hit')).toHaveAttribute('data-paragraph', '3')
    await expect(page.getByTestId('active-editor')).toBeFocused()

    await toggle.click()
    await expect(pop).toBeVisible()
    await page.getByTestId('versions-heading').click()
    await expect(pop).toHaveCount(0)
  })

  test('検索窓が開いている時に段落へ移ると、検索窓に戻っても前の一致へ引き戻さず、次に探すとその段落から', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId)
    const editor = page.getByTestId('active-editor')
    await page.getByTestId('active-search-toggle').click()
    const query = page.getByTestId('active-search-input')
    await query.fill('第200段落')
    const searchHit = page.getByTestId('active-search-hit')
    await expect(searchHit).toHaveAttribute('data-start', String(paragraphStart(ids.body, 200) + 1))

    await page.getByTestId('active-para-toggle').click()
    await page.keyboard.type('41')
    await page.keyboard.press('Enter')
    const hit = page.getByTestId('active-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '41')
    await expect.poll(() => markNearTop(hit.locator('.pw-para-rect').first(), editor)).toBe(true)
    const top = await scrollTopAfterFrames(editor)
    // 検索窓に戻っても ¶200 の一致へ戻らない（今の一致は外れる）
    await query.click()
    expect(Math.abs((await scrollTopAfterFrames(editor)) - top)).toBeLessThanOrEqual(2)
    await expect(searchHit).toHaveCount(0)
    await expect(hit).toHaveAttribute('data-paragraph', '41')
    // 次に探すのは ¶41 から（どの段落にもある語）
    await query.fill('段落の目印。')
    await expect(searchHit).toHaveAttribute('data-start', String(paragraphStart(ids.body, 41) + '　第41'.length))
  })

  test('左右に 50:50 で並べても、比較のヘッダーは採用原稿と同じ高さ（「段落」はアイコンだけ）で、本文の始まりが揃う', async ({
    page,
  }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    const active = (await page.getByTestId('active-editor').boundingBox())!
    const compare = (await page.getByTestId('compare-editor').boundingBox())!
    expect(compare.x).toBeGreaterThan(active.x + active.width - 1)
    expect(Math.abs(compare.y - active.y)).toBeLessThanOrEqual(1)
    for (const slot of ['active', 'compare']) {
      const t = (await page.getByTestId(`${slot}-para-toggle`).boundingBox())!
      const s = (await page.getByTestId(`${slot}-search-toggle`).boundingBox())!
      expect(Math.abs(t.y - s.y), slot).toBeLessThan(2)
      expect(t.width, slot).toBeLessThan(40)
      await expect(page.getByTestId(`${slot}-para-toggle`)).toHaveAccessibleName('段落へ移る')
    }
  })

  test('推敲バージョンの欄にもあり、その稿の本文で数える。差分の表示では表示の中の段落に印を付ける', async ({ page }) => {
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    const toggle = page.getByTestId('compare-para-toggle')
    const search = (await page.getByTestId('compare-search-toggle').boundingBox())!
    const t = (await toggle.boundingBox())!
    expect(t.x).toBeGreaterThan(search.x + search.width - 1)
    expect(t.x - (search.x + search.width)).toBeLessThan(12)

    await toggle.click()
    await expect(page.locator('[data-testid="para-jump-item"][data-n="2"]')).toHaveText(
      `¶2　${head(plain(2).replace('目印', '書き換えた印'))}`,
    )
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    const hit = page.getByTestId('compare-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '2')
    await expect(page.getByTestId('compare-editor')).toBeFocused()
    await expect(page.getByTestId('active-para-hit')).toHaveCount(0)

    // 差分の表示: 削除された文字も同じ行なら段落の印に入る
    await page.locator('label:has([data-testid="diff-toggle"])').click()
    const diff = page.getByTestId('diff-view')
    await expect(diff.locator('.diff-del').first()).toBeVisible()
    await toggle.click()
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    const mark = page.getByTestId('diff-para-hit')
    await expect(mark).toHaveAttribute('data-paragraph', '2')
    const text = (await diff.locator('.pw-para').allTextContents()).join('')
    expect(text).toContain('書き換えた')
    expect(text).toContain('ここは折り返しが起きるくらいの長さの地の文です。')
    expect(text).not.toContain('第3段落')
    // 削除された「目」も段落の印の中（表示の位置に写している）
    await expect(diff.locator('.diff-del .pw-para')).toHaveText(['目'])
    await expect(mark).toBeInViewport()
  })
})

test.describe('スマホ', () => {
  test.skip(({ isMobile }) => !isMobile, 'スマホ（タッチ操作）のみ')

  test('下からのシートで開き、押す所は指の大きさ（34px 以上）。幅 360px でも横にはみ出さない', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    const ids = await seedWork(page)
    await openPiece(page, ids, ids.pieceId, ids.v2)
    for (const id of [
      'active-search-toggle',
      'active-para-toggle',
      'active-more-button',
      'compare-search-toggle',
      'compare-para-toggle',
      'compare-more-button',
    ]) {
      const b = (await page.getByTestId(id).boundingBox())!
      expect(b.x + b.width, id).toBeLessThanOrEqual(360)
      expect(b.height, id).toBeGreaterThanOrEqual(34)
      expect(b.width, id).toBeGreaterThanOrEqual(34)
    }
    await noHorizontalScroll(page)

    await page.getByTestId('compare-para-toggle').tap()
    const sheet = page.getByRole('dialog', { name: '段落へ移る' })
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveClass(/modal/)
    await expect(page.getByTestId('para-jump-pop')).toHaveCount(0)
    await expect(page.getByTestId('para-jump-input')).toBeFocused()
    // 開く時の動き（少し縮めて出す）が終わってから測る
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))))
    for (const l of [
      page.getByTestId('para-jump-input'),
      page.getByTestId('para-jump-go'),
      page.getByTestId('modal-close'),
      page.getByTestId('para-jump-item').first(),
      page.getByTestId('para-jump-item').nth(5),
    ]) {
      const b = (await l.boundingBox())!
      const name = String(l)
      expect(b.height, name).toBeGreaterThanOrEqual(34)
      expect(b.width, name).toBeGreaterThanOrEqual(34)
      expect(b.x + b.width, name).toBeLessThanOrEqual(360)
    }
    await noHorizontalScroll(page)
    // 一覧だけがスクロールし、番号の欄は見えたまま
    await page.getByTestId('para-jump-list').evaluate((el) => (el.scrollTop = 3000))
    await expect(page.getByTestId('para-jump-input')).toBeInViewport()
    await page.locator('[data-testid="para-jump-item"][data-n="5"]').scrollIntoViewIfNeeded()
    await page.locator('[data-testid="para-jump-item"][data-n="5"]').tap()
    await expect(sheet).toHaveCount(0)
    const hit = page.getByTestId('compare-para-hit')
    await expect(hit).toHaveAttribute('data-paragraph', '5')
    await expect.poll(() => markNearTop(hit.locator('.pw-para-rect').first(), page.getByTestId('compare-editor'))).toBe(true)
    await expect(page.getByTestId('compare-editor')).not.toBeFocused()
    await noHorizontalScroll(page)
  })

  test('採用原稿のヘッダーの「…」は、推敲案があっても幅 360〜412px の中に収まって押せる（文字数は「…」のメニューに出る）', async ({
    page,
  }) => {
    const ids = await seedWork(page)
    await seedProofs(page, ids)
    for (const [width, height] of [
      [360, 780],
      [375, 812],
      [390, 844],
      [412, 915],
    ]) {
      await page.setViewportSize({ width, height })
      await openPiece(page, ids, ids.pieceId)
      await expect(page.getByTestId('proof-chip-count')).toHaveText('2')
      for (const id of ['proof-chip', 'active-search-toggle', 'active-para-toggle', 'duplicate-active', 'active-more-button']) {
        const b = (await page.getByTestId(id).boundingBox())!
        expect(b.x, `${width} ${id}`).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width, `${width} ${id}`).toBeLessThanOrEqual(width)
        expect(b.width, `${width} ${id}`).toBeGreaterThanOrEqual(34)
      }
      await expect(page.getByTestId('duplicate-active')).toHaveAccessibleName(/推敲/)
      await noHorizontalScroll(page)
      await page.getByTestId('active-more-button').tap()
      await expect(page.getByTestId('copy-active')).toBeVisible()
      await expect(page.locator('.pw-amore-meta')).toContainText('字・原稿用紙')
      await page.getByTestId('active-more-button').tap()
      await expect(page.getByTestId('copy-active')).toBeHidden()
    }
  })
})
