// 原稿画面（採用原稿と推敲バージョンの比較）とメモ画面の E2E テスト
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

const BODY1 =
  '吾輩は猫である。名前はまだ無い。\nどこで生れたかとんと見当がつかぬ。\n何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。'
const BODY2 = '二話目の本文。'

const isDesktop = (info: TestInfo) => info.project.name === 'desktop'

async function openPiece(page: Page, titleId: string, pieceId: string, versionId?: string) {
  await openApp(page, `/t/${titleId}/p/${pieceId}${versionId ? `?v=${versionId}` : ''}`)
  await expect(page.getByTestId('piece-workspace')).toBeVisible()
}

async function seedBasic(page: Page) {
  await openApp(page)
  return seedTitleWithEpisodes(page, '猫の物語', [BODY1, BODY2])
}

function activeRegion(page: Page): Locator {
  return page.getByRole('region', { name: '採用原稿' })
}

function versionsRegion(page: Page): Locator {
  return page.getByRole('region', { name: '推敲バージョン' })
}

async function boxes(page: Page) {
  const a = await activeRegion(page).boundingBox()
  const b = await versionsRegion(page).boundingBox()
  if (!a || !b) throw new Error('ペインが見つかりません')
  return { a, b }
}

async function flush(page: Page) {
  await page.evaluate(() => window.__ns.flushNow())
}

/** 原稿画面の編集は「保存」で確定する（スマホでは保存していない編集がある時だけヘッダーに出る） */
async function saveEdits(page: Page) {
  await page.getByTestId('save-button').click()
  await expect(page.getByTestId('save-button')).toBeDisabled()
  await flush(page)
}

/** 保存していない編集があるまま採用・削除などをすると、先に保存するか聞かれる */
async function saveAndContinue(page: Page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('保存していない編集があります。保存してから続けますか？')
  await dialog.getByRole('button', { name: '保存して続ける' }).click()
}

async function activeBodyOf(page: Page, pieceId: string): Promise<string | null> {
  return page.evaluate((pid) => {
    const d = window.__ns.getData()
    const p = d.pieces[pid]
    return p.activeVersionId ? d.versions[p.activeVersionId].body : null
  }, pieceId)
}

/** ページを読み込み直し、データの読み込みが終わるまで待つ */
async function reload(page: Page) {
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__ns))
  await expect(page.getByText('読み込み中…')).toHaveCount(0)
}

/** 狭いペインでは、比較中のバージョンの操作（複製・コピー・削除・名前）は「…」の中にある */
async function compareTool(page: Page, testId: string): Promise<Locator> {
  const more = page.getByTestId('compare-more-button')
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  return page.getByTestId(testId)
}

/** 狭いペインでは、採用原稿のコピー・採用を解除は「…」のメニューの中にある */
async function activeTool(page: Page, testId: string): Promise<Locator> {
  const more = page.getByTestId('active-more-button')
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  return page.getByTestId(testId)
}

/** n 行の本文の話と、その複製（推敲バージョン）を作る */
async function seedLines(page: Page, lines: number) {
  await openApp(page)
  return seed(
    page,
    ({ actions, getData }, n: number) => {
      const body = Array.from({ length: n }, (_, i) => `${i + 1}行目の文章です。`).join('\n')
      const titleId = actions.createTitle('長い作品')
      const pieceId = actions.addEpisode(titleId)
      const v1 = getData().pieces[pieceId].versionIds[0]
      actions.updateVersion(v1, { body })
      const v2 = actions.duplicateVersion(v1)
      return { titleId, pieceId, v1, v2 }
    },
    lines,
  )
}

/** 本文欄のうち画面に見えている行数（上の余白を除く） */
async function visibleLines(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const top = Math.max(r.top + parseFloat(cs.paddingTop), 0)
    const bottom = Math.min(r.bottom, window.innerHeight)
    return (bottom - top) / parseFloat(cs.lineHeight)
  })
}

/** 本文欄の外側（ペイン・画面全体）がスクロールしていないか */
async function outerScrolls(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).evaluate((editor) => {
    const out: string[] = []
    for (let el = editor.parentElement; el; el = el.parentElement) {
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) out.push(`${el.className}: ${el.scrollTop}`)
    }
    if (window.scrollY !== 0) out.push(`window: ${window.scrollY}`)
    return out
  })
}

test.describe('原稿画面', () => {
  test('採用原稿が表示され、推敲バージョンの一覧で第1稿が採用中になっている', async ({ page }) => {
    const { titleId, pieceIds } = await seedBasic(page)
    await openPiece(page, titleId, pieceIds[0])

    await expect(page.getByTestId('active-editor')).toHaveValue(BODY1)
    await expect(page.getByTestId('piece-label')).toContainText('第1話')
    await expect(page.locator('.breadcrumbs')).toContainText('猫の物語')
    await expect(page.getByTestId('versions-heading')).toHaveText('推敲バージョン（1）')
    const rows = page.getByTestId('version-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('第1稿')
    await expect(rows.first()).toContainText('採用中')
    // 採用中の行には「採用する」ボタンを出さない
    await expect(rows.first().getByTestId('row-adopt-button')).toHaveCount(0)
    // 文字数（空白・改行を除く）と原稿用紙換算
    await expect(page.getByTestId('active-count')).toContainText('字・原稿用紙')
    // ページ自体は横にも縦にもスクロールしない
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }))
    expect(overflow.x).toBeLessThanOrEqual(0)
    expect(overflow.y).toBeLessThanOrEqual(0)
  })

  test('複製して比較・編集し、「採用する」で採用原稿が入れ替わる', async ({ page }, info) => {
    const { titleId, pieceIds } = await seedBasic(page)
    const pid = pieceIds[0]
    await openPiece(page, titleId, pid)
    const firstVersionId = await page.evaluate((p) => window.__ns.getData().pieces[p].versionIds[0], pid)

    await page.getByTestId('duplicate-active').click()
    const compare = page.getByTestId('compare-editor')
    await expect(compare).toBeVisible()
    await expect(compare).toHaveValue(BODY1)
    await expect(page).toHaveURL(/\?v=/)
    await expect(page.getByTestId('version-select')).toContainText('第2稿（第1稿を複製）')

    // デスクトップは左右（推敲バージョンが右）、スマホは上下（推敲バージョンが下）
    const { a, b } = await boxes(page)
    if (isDesktop(info)) {
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 2)
      expect(Math.abs(b.y - a.y)).toBeLessThan(2)
    } else {
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 2)
      expect(Math.abs(b.x - a.x)).toBeLessThan(2)
    }

    // 推敲バージョンを編集（両方のエディタが同時に見えている）
    const revised = '吾輩は猫である。名前はまだ無い。\n生まれた場所には、まるで見当がつかない。'
    await compare.fill(revised)
    await expect(page.getByTestId('active-editor')).toBeVisible()
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY1)

    // 採用する → 保存していない編集を保存してから、採用原稿が入れ替わり、比較対象はそれまでの採用原稿（第1稿）になる
    await page.getByTestId('adopt-button').click()
    await saveAndContinue(page)
    await expect(page.getByText('第2稿（第1稿を複製）を採用しました')).toBeVisible()
    await expect(page.getByTestId('active-editor')).toHaveValue(revised)
    await expect(page.getByTestId('version-select')).toHaveValue(firstVersionId)
    await expect(page.getByTestId('compare-editor')).toHaveValue(BODY1)
    await expect(page).toHaveURL(new RegExp(`\\?v=${firstVersionId}`))
    await expect.poll(() => activeBodyOf(page, pid)).toBe(revised)

    // 一覧に戻ると2件、新しい順で第2稿が採用中
    await page.getByTestId('back-to-list').click()
    const rows = page.getByTestId('version-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('第2稿')
    await expect(rows.nth(0)).toContainText('採用中')
    await expect(rows.nth(1)).toContainText('第1稿')
    await expect(page).not.toHaveURL(/\?v=/)

    // 保存後に読み込み直しても採用原稿は第2稿のまま
    await flush(page)
    await reload(page)
    await expect(page.getByTestId('active-editor')).toHaveValue(revised)
  })

  test('スライダーと境界のドラッグで表示比率が変わり、分割の向きも切り替えられる', async ({ page }, info) => {
    const { titleId, pieceIds } = await seedBasic(page)
    await openPiece(page, titleId, pieceIds[0])
    const horizontal = isDesktop(info)
    const share = async () => {
      const { a, b } = await boxes(page)
      return horizontal ? a.width / (a.width + b.width) : a.height / (a.height + b.height)
    }
    await expect.poll(() => share()).toBeCloseTo(0.5, 1)

    const slider = page.getByTestId('ratio-slider')
    await slider.fill('30')
    await expect.poll(share).toBeLessThan(0.33)
    await expect.poll(() => share()).toBeGreaterThan(0.27)

    await slider.fill('80')
    await expect.poll(share).toBeGreaterThan(0.77)

    // 境界をドラッグ
    const divider = page.getByTestId('split-divider')
    const d = await divider.boundingBox()
    const split = await page.locator('.pw-split').boundingBox()
    if (!d || !split) throw new Error('境界が見つかりません')
    const startX = d.x + d.width / 2
    const startY = d.y + d.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    if (horizontal) await page.mouse.move(split.x + split.width * 0.4, startY, { steps: 8 })
    else await page.mouse.move(startX, split.y + split.height * 0.4, { steps: 8 })
    await page.mouse.up()
    await expect.poll(share).toBeLessThan(0.45)
    await expect.poll(() => share()).toBeGreaterThan(0.35)
    await expect(slider).toHaveValue(/^(3[5-9]|4[0-5])$/)

    // 分割の向きを切り替える（スマホでは「表示の設定」から）
    const openMenu = async () => {
      if (!horizontal) await page.getByTestId('view-menu-button').click()
    }
    await openMenu()
    await page.getByRole('button', { name: horizontal ? '上下' : '左右', exact: true }).click()
    {
      const { a, b } = await boxes(page)
      if (horizontal) expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 2)
      else expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 2)
    }
    if (!horizontal) await page.keyboard.press('Escape')
    await openMenu()
    await page.getByRole('button', { name: '自動', exact: true }).click()
    {
      const { a, b } = await boxes(page)
      if (horizontal) expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 2)
      else expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 2)
    }
  })

  test('「採用を解除」すると「採用原稿がありません。」になり、一覧から採用し直せる', async ({ page }) => {
    const { titleId, pieceIds } = await seedBasic(page)
    const pid = pieceIds[0]
    await openPiece(page, titleId, pid)

    await (await activeTool(page, 'unadopt-button')).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('採用原稿がありません。')
    await dialog.getByRole('button', { name: '採用を解除' }).click()

    await expect(page.getByTestId('no-active')).toContainText('採用原稿がありません。')
    // ヘッダーのバッジは「採用原稿なし」（「未採用」と見出し「採用原稿」を並べない）
    await expect(page.getByTestId('no-active-badge')).toHaveText('採用原稿なし')
    await expect(page.getByTestId('active-pane')).not.toContainText('未採用')
    await expect(page.getByTestId('active-editor')).toHaveCount(0)
    await expect.poll(() => activeBodyOf(page, pid)).toBeNull()
    await expect(page.getByTestId('duplicate-active-list')).toBeDisabled()

    // バージョン自体は残っていて、一覧から採用し直せる
    const row = page.getByTestId('version-row').first()
    await expect(row).not.toContainText('採用中')
    await row.getByTestId('row-adopt-button').click()
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY1)
    await expect.poll(() => activeBodyOf(page, pid)).toBe(BODY1)

    // 解除してから「白紙の稿を作って採用」
    await (await activeTool(page, 'unadopt-button')).click()
    await page.getByRole('dialog').getByRole('button', { name: '採用を解除' }).click()
    await page.getByTestId('create-and-adopt').click()
    await expect(page.getByTestId('active-editor')).toHaveValue('')
    await expect(page.getByTestId('versions-heading')).toHaveText('推敲バージョン（2）')
  })

  test('操作の名前は両ペインで「複製して推敲」に揃い、狭いペインでも短い文字（推敲・白紙）が見える。更新日時は「たった今更新」', async ({
    page,
  }, info) => {
    const { titleId, pieceIds } = await seedBasic(page)
    await openPiece(page, titleId, pieceIds[0])
    const wide = isDesktop(info)
    // 見えている文字（狭いペインでは「複製して」「の稿」を省く）
    const visibleText = (testId: string) => page.getByTestId(testId).evaluate((el) => (el as HTMLElement).innerText.trim())
    expect(await visibleText('duplicate-active')).toBe(wide ? '複製して推敲' : '推敲')
    expect(await visibleText('duplicate-active-list')).toBe(wide ? '複製して推敲' : '推敲')
    expect(await visibleText('add-blank-version')).toBe(wide ? '白紙の稿' : '白紙')
    // 文字は見た目の上でも隠していない（幅がある）
    for (const id of ['duplicate-active', 'duplicate-active-list', 'add-blank-version']) {
      const label = page.getByTestId(id).locator('.pw-tlabel')
      expect((await label.boundingBox())!.width).toBeGreaterThan(20)
    }
    await expect(page.getByText('採用原稿を複製', { exact: true })).toHaveCount(0)

    // 更新日時（狭いペインでは「…」のメニューの中）
    if (wide) {
      await expect(page.getByTestId('copy-active')).toBeVisible()
      await expect(page.getByTestId('unadopt-button')).toBeVisible()
      await expect(page.getByTestId('active-more-button')).toBeHidden()
      await expect(page.getByTestId('active-pane').locator('.pw-meta')).toContainText('たった今更新')
    } else {
      await page.getByTestId('active-more-button').click()
      await expect(page.locator('.pw-amore')).toContainText('たった今更新')
      await expect(page.locator('.pw-amore')).toContainText('原稿用紙')
      await page.keyboard.press('Escape')
    }
    await expect(page.locator('body')).not.toContainText('たった今に更新')

    // 比較: 稿の名前・文字数・更新日時（狭いペインでは「…」の中）
    await page.getByTestId('duplicate-active').click()
    await expect(page.getByTestId('compare-editor')).toBeVisible()
    await compareTool(page, 'selected-version-name')
    await expect(page.getByTestId('compare-pane').locator('.pw-updated')).toHaveText('たった今更新')
  })

  test('第n話の表記は編集できず、特殊ブロックの見出しは編集できる。話の題は読み込み直しても残る', async ({ page }) => {
    await openApp(page)
    const { titleId, episodeId, specialId } = await seed(page, ({ actions }) => {
      const titleId = actions.createTitle('見出しの作品')
      const episodeId = actions.addEpisode(titleId)
      const specialId = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
      return { titleId, episodeId, specialId }
    })

    await openPiece(page, titleId, episodeId)
    const label = page.getByTestId('piece-label')
    await expect(label).toContainText('第1話')
    await expect(label.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0)
    await expect(page.getByTestId('special-label-input')).toHaveCount(0)
    await expect(label).toHaveAttribute('title', '話数は並び順で自動的に決まり、変更できません')

    const subtitle = page.getByTestId('subtitle-input')
    await expect(subtitle).toHaveAttribute('placeholder', '話の題（任意）')
    await subtitle.fill('旅立ち')
    await subtitle.press('Enter')
    await saveEdits(page)
    await reload(page)
    await expect(page.getByTestId('subtitle-input')).toHaveValue('旅立ち')
    await expect(page.locator('.breadcrumbs')).toContainText('第1話')

    // 特殊ブロック: 見出しを自由に編集できる（前の話ボタンで移動）
    await page.getByTestId('prev-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${specialId}$`))
    const special = page.getByTestId('special-label-input')
    await expect(special).toHaveValue('プロローグ')
    await expect(page.locator('.pw-label-special .badge-special')).toHaveText('特殊')
    await special.fill('序章')
    await special.press('Enter')
    // 保存するまではストアに入らない
    expect(await page.evaluate((id) => window.__ns.getData().pieces[id].label, specialId)).toBe('プロローグ')
    await saveEdits(page)
    expect(await page.evaluate((id) => window.__ns.getData().pieces[id].label, specialId)).toBe('序章')
    await reload(page)
    await expect(page.getByTestId('special-label-input')).toHaveValue('序章')
    await expect(page.getByTestId('prev-piece')).toBeDisabled()
  })

  test('差分表示: 採用原稿との違いを色分けし、追加・削除の文字数を出す', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceId, versionId } = await seed(page, ({ actions, getData }) => {
      const titleId = actions.createTitle('差分の作品')
      const pieceId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: '春は曙。\nやうやう白くなりゆく山際。' })
      const versionId = actions.addVersion(pieceId, { body: '春は曙。\nようやく白くなっていく山際。' })
      actions.updateVersion(versionId, { note: '現代語に寄せる\n二行目' })
      return { titleId, pieceId, versionId }
    })
    await openPiece(page, titleId, pieceId)

    // 一覧: 文字数の差と推敲メモの1行目
    const row = page.getByTestId('version-row').first()
    await expect(row).toContainText('第2稿')
    await expect(row).toContainText('+1字')
    await expect(row).toContainText('現代語に寄せる')
    await expect(row).not.toContainText('二行目')

    await expect(page.getByTestId('diff-toggle')).toBeDisabled()
    await row.getByRole('button', { name: /を開いて比較する/ }).click()
    await expect(page).toHaveURL(new RegExp(`\\?v=${versionId}`))
    await expect(page.getByTestId('compare-editor')).toBeVisible()

    await page.locator('label:has([data-testid="diff-toggle"])').click()
    const diff = page.getByTestId('diff-view')
    await expect(diff).toBeVisible()
    await expect(page.getByTestId('compare-editor')).toHaveCount(0)
    await expect(diff.locator('.diff-add').first()).toBeVisible()
    await expect(diff.locator('.diff-del').first()).toBeVisible()
    await expect(page.getByTestId('diff-summary')).toContainText(/追加 \+\d+字/)
    await expect(page.getByTestId('diff-summary')).toContainText(/削除 −\d+字/)

    // 差分をオフにすると編集に戻る
    await page.locator('label:has([data-testid="diff-toggle"])').click()
    await expect(page.getByTestId('compare-editor')).toHaveValue('春は曙。\nようやく白くなっていく山際。')

    // 推敲メモ
    await page.getByTestId('note-toggle').click()
    await expect(page.getByTestId('version-note')).toHaveValue('現代語に寄せる\n二行目')
  })

  test('推敲バージョンの削除・無効な ?v・前後の話への移動・存在しない話', async ({ page }) => {
    const { titleId, pieceIds } = await seedBasic(page)
    await openPiece(page, titleId, pieceIds[0], 'no-such-version')
    await expect(page).not.toHaveURL(/\?v=/)
    await expect(page.getByTestId('versions-heading')).toBeVisible()

    // 白紙の稿を作る → 選ばれる → 削除して一覧へ戻る
    await page.getByTestId('add-blank-version').click()
    await expect(page.getByTestId('compare-editor')).toHaveValue('')
    await page.getByTestId('compare-editor').fill('消す予定の稿')
    await (await compareTool(page, 'delete-version')).click()
    await saveAndContinue(page)
    await expect(page.getByRole('dialog')).toContainText('削除しますか？')
    await expect(page.getByRole('dialog')).not.toContainText('応募時の原稿')
    await page.getByRole('dialog').getByRole('button', { name: '削除' }).click()
    await expect(page.getByTestId('versions-heading')).toHaveText('推敲バージョン（1）')
    await expect(page.locator('.toast.error')).toHaveCount(0)

    // 採用中のバージョンを選ぶと読み取り専用で表示される
    await page
      .getByTestId('version-row')
      .first()
      .getByRole('button', { name: /を開いて比較する/ })
      .click()
    await expect(page.getByTestId('compare-readonly')).toHaveValue(BODY1)
    await expect(page.getByText('このバージョンは採用中です')).toBeVisible()
    await expect(page.getByTestId('adopt-button')).toBeDisabled()

    // 前後の話（?v は引き継がない）
    await expect(page.getByTestId('prev-piece')).toBeDisabled()
    await page.getByTestId('next-piece').click()
    await expect(page).toHaveURL(new RegExp(`/p/${pieceIds[1]}$`))
    await expect(page.getByTestId('piece-label')).toContainText('第2話')
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY2)
    await expect(page.getByTestId('next-piece')).toBeDisabled()

    await openApp(page, `/t/${titleId}/p/missing-piece`)
    await expect(page.getByText('話が見つかりません。削除された可能性があります。')).toBeVisible()
  })

  test('スクロール同期をオンにすると、採用原稿のスクロールに推敲バージョンが追従する', async ({ page }, info) => {
    await openApp(page)
    const long = Array.from({ length: 120 }, (_, i) => `${i + 1}行目の文章です。`).join('\n')
    const { titleId, pieceId, versionId } = await seed(
      page,
      ({ actions, getData }, body: string) => {
        const titleId = actions.createTitle('長い作品')
        const pieceId = actions.addEpisode(titleId)
        actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body })
        const versionId = actions.addVersion(pieceId, { body })
        return { titleId, pieceId, versionId }
      },
      long,
    )
    await openPiece(page, titleId, pieceId, versionId)
    if (!isDesktop(info)) await page.getByTestId('view-menu-button').click()
    await page.locator('label:has([data-testid="scroll-sync-toggle"])').click()
    await expect(page.getByTestId('scroll-sync-toggle')).toBeChecked()
    if (!isDesktop(info)) await page.keyboard.press('Escape')

    await page.getByTestId('active-editor').evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
      el.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(() =>
        page.getByTestId('compare-editor').evaluate((el) => el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)),
      )
      .toBeCloseTo(0.5, 1)
  })

  test('Ctrl+S で入力中の本文もすぐに保存される', async ({ page }) => {
    const { titleId, pieceIds } = await seedBasic(page)
    await openPiece(page, titleId, pieceIds[0])
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type('追記。')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByText('保存しました').first()).toBeVisible()
    await expect.poll(() => activeBodyOf(page, pieceIds[0])).toContain('追記。')

    // 話の題を入力中（自動保存の待ち時間内）でもすぐに保存される
    // （スマホでは本文の編集中は上部バーを畳んでいるので、本文から離れてから）
    await editor.blur()
    await page.getByTestId('subtitle-input').click()
    await page.keyboard.type('はじまり')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => page.evaluate((id) => window.__ns.getData().pieces[id].subtitle, pieceIds[0])).toBe('はじまり')
    await expect(page.getByTestId('subtitle-input')).toBeFocused()
  })

  test('章が有効なときはパンくずに章名が出る', async ({ page }) => {
    const { titleId, pieceIds } = await seedBasic(page)
    await seed(page, ({ actions }, id: string) => actions.setChaptersEnabled(id, true), titleId)
    await openPiece(page, titleId, pieceIds[1])
    const crumbs = page.locator('.breadcrumbs')
    await expect(crumbs).toContainText('猫の物語')
    await expect(crumbs).toContainText('第1章')
    await expect(crumbs).toContainText('第2話')
    await expect(crumbs.getByRole('link', { name: '第1章' })).toHaveAttribute('href', /#\/t\/[^/]+\/c\/[^/]+$/)
  })

  test('一覧から開いた比較は、ブラウザの「戻る」で一覧に戻る（バージョンの切り替えは履歴に積まない）', async ({ page }) => {
    const { titleId, pieceId, v1, v2 } = await seedLines(page, 3)
    await openPiece(page, titleId, pieceId)
    await page
      .getByTestId('version-row')
      .first()
      .getByRole('button', { name: /を開いて比較する/ })
      .click()
    await expect(page).toHaveURL(new RegExp(`\\?v=${v2}$`))
    await page.getByTestId('version-select').selectOption(v1)
    await expect(page).toHaveURL(new RegExp(`\\?v=${v1}$`))

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/p/${pieceId}$`))
    await expect(page.getByTestId('versions-heading')).toBeVisible()
    await page.goForward()
    await expect(page.getByTestId('compare-pane')).toBeVisible()

    // 「一覧」ボタンも同じ履歴を戻るので、もう一度戻ると話を離れる
    await page.getByTestId('back-to-list').click()
    await expect(page).toHaveURL(new RegExp(`/p/${pieceId}$`))
    await page.goBack()
    await expect(page).not.toHaveURL(/\/p\//)
  })

  test('応募の記録に使われている稿を削除する時は、確認文でそのことを知らせる', async ({ page }) => {
    const { titleId, pieceId, v1 } = await seedLines(page, 3)
    await seed(
      page,
      ({ actions }, id: string) => {
        const s = actions.addSubmission(id, '星降る文学賞')
        actions.recordSubmissionSnapshot(s)
      },
      titleId,
    )
    await openPiece(page, titleId, pieceId, v1)
    await (await compareTool(page, 'delete-version')).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('この稿は「星降る文学賞」の応募時の原稿として記録されています。')
    await expect(dialog).toContainText('削除しても応募時の原稿は残ります。')
    await dialog.getByRole('button', { name: 'キャンセル' }).click()
  })

  test('差分表示中に採用原稿を書いても、差分の計算で入力が止まらない', async ({ page }, info) => {
    test.skip(!isDesktop(info), '計測はデスクトップだけで行う')
    await openApp(page)
    const { titleId, pieceId, v2 } = await seed(page, ({ actions, getData }) => {
      // 1万5千字の原稿と、すべての行に手を入れた推敲バージョン（差分の計算が重い）
      const sentences = [
        '朝の光が書架の隙間から差し込み、埃がゆっくりと舞っていた。',
        '司書の澪は、誰もいない閲覧室で一冊の古い本を開いた。',
        '「また、ここに戻ってきたのね」',
        'ページをめくるたびに、紙の匂いと一緒に、遠い夏の記憶がよみがえる。',
      ]
      const lines: string[] = []
      for (let i = 0; lines.join('\n').length < 15000; i++) lines.push(sentences[(i * 7) % 4] + sentences[(i * 3 + 1) % 4])
      const a = lines.join('\n')
      const b = lines.map((l, i) => l.replace('の', i % 2 ? 'が' : 'を').replace('、', '。')).join('\n')
      const titleId = actions.createTitle('長編')
      const pieceId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: a })
      const v2 = actions.addVersion(pieceId, { body: b })
      return { titleId, pieceId, v2 }
    })
    await openPiece(page, titleId, pieceId, v2)
    await page.locator('label:has([data-testid="diff-toggle"])').click()
    await expect(page.getByTestId('diff-view').locator('.diff-add').first()).toBeVisible()

    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] }
      w.__longTasks = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration))
      }).observe({ type: 'longtask' })
    })
    await page.getByTestId('active-editor').click()
    await page.keyboard.press('ControlOrMeta+End')
    for (let i = 0; i < 3; i++) {
      await page.keyboard.type('書き足しています。', { delay: 50 })
      await page.waitForTimeout(700)
    }
    // 書き足した分も、少し待てば差分に出る
    await expect(page.getByTestId('diff-view')).toContainText('書き足しています。書き足しています。書き足しています。')
    await expect(page.getByTestId('diff-stale')).toHaveText('')
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks)
    expect(Math.max(0, ...longTasks)).toBeLessThan(200)
  })

  test('長い原稿でも、記号・巻き戻し・進むのたびに全文を組み直さない（カーソルの行は段落ごとの高さを控えて測る）', async ({
    page,
  }, info) => {
    test.skip(!isDesktop(info), '計測はデスクトップだけで行う')
    await openApp(page)
    const { titleId, pieceId } = await seed(page, ({ actions, getData }) => {
      const sentences = [
        '朝の光が書架の隙間から差し込み、埃がゆっくりと舞っていた。',
        '司書の澪は、誰もいない閲覧室で一冊の古い本を開いた。',
        '「また、ここに戻ってきたのね」',
        'ページをめくるたびに、紙の匂いと一緒に、遠い夏の記憶がよみがえる。',
      ]
      const lines: string[] = []
      for (let i = 0; lines.join('\n').length < 15000; i++)
        lines.push(i % 9 === 4 ? '' : sentences[(i * 7) % 4] + sentences[(i * 3 + 1) % 4])
      const titleId = actions.createTitle('長編')
      const pieceId = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: lines.join('\n') })
      return { titleId, pieceId }
    })
    await openPiece(page, titleId, pieceId)
    const editor = page.getByTestId('active-editor')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')

    // 段落ごとに測った位置が、全文を組んで測った位置（前の測り方）と同じこと。2回目からは速いこと
    const r = await editor.evaluate(async (el: HTMLTextAreaElement, url: string) => {
      const { caretLine } = (await import(/* @vite-ignore */ url)) as typeof import('../src/features/piece/caret')
      const props = [
        'boxSizing',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'fontFamily',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'fontVariant',
        'fontFeatureSettings',
        'letterSpacing',
        'lineHeight',
        'textTransform',
        'wordSpacing',
        'textIndent',
        'tabSize',
        'wordBreak',
        'lineBreak',
      ] as const
      const full = (pos: number) => {
        const cs = getComputedStyle(el)
        const m = document.createElement('div')
        for (const p of props) m.style[p] = cs[p]
        Object.assign(m.style, {
          position: 'absolute',
          visibility: 'hidden',
          top: '0',
          left: '-99999px',
          boxSizing: 'border-box',
          border: '0',
          width: `${el.clientWidth}px`,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
        })
        m.textContent = el.value.slice(0, pos)
        const mark = document.createElement('span')
        mark.textContent = el.value.slice(pos, pos + 1).replace('\n', '') || '\u200b'
        m.appendChild(mark)
        document.body.appendChild(m)
        const top = m.getBoundingClientRect().top
        const t = mark.getBoundingClientRect().top - top
        m.remove()
        return t
      }
      const v = el.value
      const end = v.length
      caretLine(el, end)
      const times: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        caretLine(el, end)
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      const samples = [0, 1, end]
      for (let i = 397; i < end; i += 997) samples.push(i)
      for (let i = v.indexOf('\n'); i >= 0 && samples.length < 40; i = v.indexOf('\n', i + 400)) samples.push(i + 1)
      const diffs = samples.map((pos) => Math.abs(caretLine(el, pos).top - full(pos)))
      return { median: times[2], maxDiff: Math.max(...diffs), length: end }
    }, '/src/features/piece/caret.ts')
    expect(r.length).toBeGreaterThan(15000)
    expect(r.maxDiff).toBeLessThanOrEqual(1)
    expect(r.median).toBeLessThan(10)

    // 記号・巻き戻し・進むを続けて押しても、画面が止まらない
    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] }
      w.__longTasks = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration))
      }).observe({ type: 'longtask' })
    })
    for (let i = 0; i < 10; i++) await page.getByTestId('symbol-dash').click()
    for (let i = 0; i < 10; i++) await page.getByTestId('undo-button').click()
    for (let i = 0; i < 10; i++) await page.getByTestId('redo-button').click()
    await expect(editor).toHaveValue(/(――){10}$/)
    await expect(editor).toBeFocused()
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks)
    expect(Math.max(0, ...longTasks)).toBeLessThan(200)
  })
})

test.describe('スマホでの表示', () => {
  test.skip(({ isMobile }) => !isMobile, 'スマホ（タッチ操作）のみ')

  test('縦持ち: ペインのヘッダーは1行。編集中は画面上部を畳み（集中モード）、キーボードが出ても上下に分けたまま', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 664 })
    const { titleId, pieceId, v2 } = await seedLines(page, 60)
    await openPiece(page, titleId, pieceId, v2)

    for (const pane of ['active-pane', 'compare-pane']) {
      const head = await page.getByTestId(pane).locator('.pw-head').first().boundingBox()
      expect(head!.height).toBeLessThanOrEqual(50)
    }
    // 採用原稿の1行目が画面の上から 210px 以内（以前は 238px）
    const firstLine = await page
      .getByTestId('active-editor')
      .evaluate((el) => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop))
    expect(firstLine).toBeLessThan(210)
    expect(await page.getByTestId('active-count').textContent()).toContain('字')

    // 本文を触ると、ヘッダーと上部バーを畳む。採用中の表示と稿の名前は残る
    const root = page.getByTestId('piece-workspace')
    await page.getByTestId('active-editor').tap()
    await expect(root).toHaveClass(/is-focus-mode/)
    await expect(page.locator('.app-header')).toBeHidden()
    await expect(page.getByTestId('piece-bar')).toBeHidden()
    await expect(page.getByTestId('active-pane').locator('.badge-active')).toBeVisible()
    await expect(page.getByTestId('active-version-name')).toBeVisible()
    expect(await visibleLines(page, 'active-editor')).toBeGreaterThan(7)

    // キーボード（約300px）が出て画面が低くなっても、上下に分けたまま各ペインに3行以上
    await page.setViewportSize({ width: 390, height: 364 })
    {
      const { a, b } = await boxes(page)
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 2)
    }
    expect(await visibleLines(page, 'active-editor')).toBeGreaterThanOrEqual(3)
    expect(await visibleLines(page, 'compare-editor')).toBeGreaterThanOrEqual(3)

    // 推敲バージョン側でも同じ
    await page.getByTestId('compare-editor').tap()
    await expect(root).toHaveClass(/is-focus-mode/)

    // 本文以外を触ると元に戻る
    await page.setViewportSize({ width: 390, height: 664 })
    await page.getByTestId('active-pane').locator('.badge-active').tap()
    await expect(root).not.toHaveClass(/is-focus-mode/)
    await expect(page.locator('.app-header')).toBeVisible()
    await expect(page.getByTestId('piece-bar')).toBeVisible()

    // 話の題の入力中にキーボードが出ても、上部バーは畳まず、分割の向きも変えない
    await page.getByTestId('subtitle-input').tap()
    await page.setViewportSize({ width: 390, height: 364 })
    await expect(page.getByTestId('subtitle-input')).toBeVisible()
    await expect(root).not.toHaveClass(/is-focus-mode/)
    {
      const { a, b } = await boxes(page)
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 2)
    }
    expect((await page.getByTestId('subtitle-input').boundingBox())!.width).toBeGreaterThan(150)
  })

  test('縦持ち: 採用原稿の「…」にコピー・採用を解除が文字付きで入る。Esc・外側で閉じ、閉じた後は「…」にフォーカスが戻る', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const { titleId, pieceIds } = await seedBasic(page)
    await openPiece(page, titleId, pieceIds[0])
    const more = page.getByTestId('active-more-button')
    const copy = page.getByTestId('copy-active')
    const unadopt = page.getByTestId('unadopt-button')

    // ヘッダーは1行: 採用中・稿の名前・文字数・推敲・「…」
    const head = await page.getByTestId('active-pane').locator('.pw-head').boundingBox()
    expect(head!.height).toBeLessThanOrEqual(50)
    await expect(page.getByRole('button', { name: '推敲', exact: true })).toHaveCount(2)
    await expect(copy).toBeHidden()
    await expect(unadopt).toBeHidden()

    // 開くと文字付きのボタンが並ぶ（指で操作する端末ではツールチップが出ないので）
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(copy).toBeVisible()
    await expect(unadopt).toBeVisible()
    expect(await copy.innerText()).toBe('コピー')
    expect(await unadopt.innerText()).toBe('採用を解除')
    for (const b of [copy, unadopt]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(34)
    // ページは横にスクロールしない
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0)

    // Esc で閉じる（メニュー内のボタンにいたら「…」に戻る）
    await unadopt.focus()
    await page.keyboard.press('Escape')
    await expect(unadopt).toBeHidden()
    await expect(more).toBeFocused()

    // 外側を押しても閉じる
    await more.click()
    await expect(copy).toBeVisible()
    await page.getByTestId('versions-heading').click()
    await expect(copy).toBeHidden()

    // 採用を解除 → キャンセルすると「…」にフォーカスが戻る
    await more.click()
    await unadopt.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('採用を解除しますか？')
    await expect(unadopt).toBeHidden()
    await dialog.getByRole('button', { name: 'キャンセル' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(more).toBeFocused()

    // 採用を解除 → 確定すると採用原稿なしになる
    await more.click()
    await unadopt.click()
    await page.getByRole('dialog').getByRole('button', { name: '採用を解除' }).click()
    await expect(page.getByTestId('no-active-badge')).toHaveText('採用原稿なし')
  })

  test('横持ち: 上部バーは1行で採用原稿に6行・推敲バージョンに5行以上。キーボード表示中も3行以上見え、比率は表示の設定で変えられる', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    const { titleId, pieceId, v2 } = await seedLines(page, 60)
    await openPiece(page, titleId, pieceId, v2)

    // 左右に並ぶ
    const { a, b } = await boxes(page)
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 2)
    expect((await page.getByTestId('piece-bar').boundingBox())!.height).toBeLessThanOrEqual(50)
    expect(await visibleLines(page, 'active-editor')).toBeGreaterThanOrEqual(6)
    // 推敲バージョンは、推敲メモの行と、いちばん下の記号バーの分だけ少ない
    expect(await visibleLines(page, 'compare-editor')).toBeGreaterThanOrEqual(5)
    await expect(page.getByTestId('symbol-bar')).toBeVisible()

    // 比率は「表示の設定」の中
    const slider = page.getByTestId('ratio-slider')
    await expect(slider).toBeHidden()
    await page.getByTestId('view-menu-button').click()
    await slider.fill('30')
    await page.keyboard.press('Escape')
    await expect(slider).toBeHidden()
    await expect
      .poll(async () => {
        const { a, b } = await boxes(page)
        return a.width / (a.width + b.width)
      })
      .toBeCloseTo(0.3, 1)
    await page.getByTestId('view-menu-button').click()
    await slider.fill('50')
    await page.keyboard.press('Escape')

    // 稿の名前・文字数・操作は「…」の中
    await expect(page.getByTestId('selected-version-name')).toBeHidden()
    await (await compareTool(page, 'selected-version-name')).fill('朝の場面を削った稿')
    await expect(page.getByTestId('compare-count')).toContainText('原稿用紙')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('selected-version-name')).toBeHidden()
    await expect(page.getByTestId('version-select')).toContainText('朝の場面を削った稿')

    // キーボード（約200px）が出ても、各ペインに3行以上
    await page.getByTestId('active-editor').tap()
    await page.setViewportSize({ width: 844, height: 190 })
    await expect(page.locator('.app-header')).toBeHidden()
    expect(await visibleLines(page, 'active-editor')).toBeGreaterThanOrEqual(3)
    expect(await visibleLines(page, 'compare-editor')).toBeGreaterThanOrEqual(3)
    expect(await outerScrolls(page, 'active-editor')).toEqual([])
  })

  for (const [name, size] of [
    ['縦持ち', { width: 390, height: 664 }],
    ['横持ち', { width: 844, height: 390 }],
  ] as const) {
    test(`${name}: 末尾で改行を打ち続けても、ペインや画面がスクロールしてヘッダーや先頭が隠れない`, async ({ page }) => {
      await page.setViewportSize(size)
      const { titleId, pieceId, v2 } = await seedLines(page, 60)
      await openPiece(page, titleId, pieceId, v2)
      for (const editor of ['active-editor', 'compare-editor']) {
        await page.getByTestId(editor).tap()
        await page.keyboard.press('ControlOrMeta+End')
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Enter')
          await page.keyboard.type(`追加${i}`)
        }
        expect(await outerScrolls(page, editor)).toEqual([])
        // 本文欄の中はスクロールして末尾が見えている
        expect(await page.getByTestId(editor).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
        // ペインのヘッダーは画面内に全部見えている
        const pane = page.getByTestId(editor === 'active-editor' ? 'active-pane' : 'compare-pane')
        const head = await pane.locator('.pw-head').first().boundingBox()
        const region = await (editor === 'active-editor' ? activeRegion(page) : versionsRegion(page)).boundingBox()
        expect(head!.y).toBeGreaterThanOrEqual(0)
        expect(Math.abs(head!.y - region!.y)).toBeLessThan(1)
      }
    })
  }

  test('境界の広い当たり判定が、すぐ上下・左右のボタンや入力欄に重ならない', async ({ page }) => {
    const { titleId, pieceId, v2 } = await seedLines(page, 3)
    const overlapped = () =>
      page.evaluate(() => {
        const bad: string[] = []
        for (const el of document.querySelectorAll<HTMLElement>('.pw-split .pw-head :is(button, select, input)')) {
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          for (const fx of [0.05, 0.5, 0.95]) {
            for (const fy of [0.05, 0.5, 0.95]) {
              const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
              if (hit?.closest('[data-testid="split-divider"]')) bad.push(el.dataset.testid ?? el.className)
            }
          }
        }
        return [...new Set(bad)]
      })
    for (const size of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size)
      await openPiece(page, titleId, pieceId)
      expect(await overlapped()).toEqual([])
      // 採用原稿の「…」のメニュー（コピー・採用を解除）も
      await page.getByTestId('active-more-button').click()
      await expect(page.getByTestId('unadopt-button')).toBeVisible()
      expect(await overlapped()).toEqual([])
      await page.keyboard.press('Escape')
      await openPiece(page, titleId, pieceId, v2)
      expect(await overlapped()).toEqual([])
    }
    // 境界はドラッグできる（縦持ち: 上下）
    await page.setViewportSize({ width: 390, height: 844 })
    await openPiece(page, titleId, pieceId, v2)
    const d = (await page.getByTestId('split-divider').boundingBox())!
    const split = (await page.locator('.pw-split').boundingBox())!
    await page.mouse.move(d.x + d.width / 2 + 60, d.y - 12)
    await page.mouse.down()
    await page.mouse.move(d.x + d.width / 2 + 60, split.y + split.height * 0.35, { steps: 6 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const { a, b } = await boxes(page)
        return a.height / (a.height + b.height)
      })
      .toBeLessThan(0.4)
  })
})

test.describe('メモ', () => {
  test('メモの名前と本文を編集し、削除するとタイトル画面に戻る', async ({ page }) => {
    await openApp(page)
    const { titleId, memoId } = await seed(page, ({ actions }) => {
      const titleId = actions.createTitle('メモの作品')
      const memoId = actions.addMemo(titleId, '伏線メモ')
      return { titleId, memoId }
    })
    await openApp(page, `/t/${titleId}/m/${memoId}`)
    await expect(page.locator('.breadcrumbs')).toContainText('メモの作品')
    await expect(page.locator('.breadcrumbs')).toContainText('メモ: 伏線メモ')
    await expect(page.getByTestId('memo-name')).toHaveValue('伏線メモ')

    await page.getByTestId('memo-name').fill('伏線と小道具')
    await page.getByTestId('memo-name').press('Enter')
    await page.getByTestId('memo-body').fill('懐中時計は第3話で再登場させる。')
    await page.getByTestId('memo-body').blur()
    await flush(page)
    await reload(page)
    await expect(page.getByTestId('memo-name')).toHaveValue('伏線と小道具')
    await expect(page.getByTestId('memo-body')).toHaveValue('懐中時計は第3話で再登場させる。')
    await expect(page.locator('.breadcrumbs')).toContainText('メモ: 伏線と小道具')
    await expect(page.getByTestId('memo-sheet')).toContainText('たった今更新')
    await expect(page.getByTestId('memo-sheet')).not.toContainText('に更新')

    // 編集中のまま削除しても、削除後に保存エラーが出ない
    await page.getByTestId('memo-body').fill('削除直前の追記')
    await page.getByTestId('memo-delete').click()
    await expect(page.getByRole('dialog')).toContainText('このメモをゴミ箱に移します。30日後に完全に削除されます')
    await page.getByRole('dialog').getByRole('button', { name: '削除' }).click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}$`))
    await expect(page.locator('.toast.error')).toHaveCount(0)
    expect(await page.evaluate((id) => window.__ns.getData().memos[id], memoId)).toBeUndefined()

    await openApp(page, `/t/${titleId}/m/${memoId}`)
    await expect(page.getByText('メモが見つかりません。削除された可能性があります。')).toBeVisible()
  })
})

test.describe('スクリーンショット', () => {
  test('原稿画面とメモ画面（ライト・ダーク）', async ({ page }, info) => {
    test.setTimeout(90_000)
    const project = info.project.name
    if (project === 'desktop') await page.setViewportSize({ width: 1400, height: 900 })
    else await page.setViewportSize({ width: 390, height: 844 })

    await openApp(page)
    const ids = await seed(page, ({ actions, getData }) => {
      const titleId = actions.createTitle('夜明けの図書館')
      const lines = [
        '　朝の光が書架の隙間から差し込み、埃がゆっくりと舞っていた。',
        '　司書の澪は、誰もいない閲覧室で一冊の古い本を開いた。表紙は擦り切れ、題名はもう読めない。',
        '「また、ここに戻ってきたのね」',
        '　声に出してみると、それは思っていたよりもずっと小さく響いた。',
        '　ページをめくるたびに、紙の匂いと一緒に、遠い夏の記憶がよみがえる。祖母の家の縁側、蝉の声、冷えた麦茶のグラス。',
        '　澪は本を閉じ、窓の外を見た。街はまだ眠っている。',
      ]
      const body = Array.from({ length: 6 }, () => lines.join('\n')).join('\n\n')
      const pieceId = actions.addEpisode(titleId)
      actions.updatePiece(pieceId, { subtitle: '朝の閲覧室' })
      const v1 = getData().pieces[pieceId].versionIds[0]
      actions.updateVersion(v1, { body })
      const v2 = actions.duplicateVersion(v1)
      actions.updateVersion(v2, {
        body: body
          .replace('埃がゆっくりと舞っていた', '細かな埃が光の筋の中で踊っていた')
          .replace('「また、ここに戻ってきたのね」\n', ''),
        note: '冒頭の描写を具体的に。台詞を一つ削った。',
      })
      const v3 = actions.addVersion(pieceId, { body: '　（書き直し中）\n　朝の光。' })
      actions.updateVersion(v3, { note: '視点を変えて全面的に書き直す案' })
      const second = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[second].versionIds[0], { body: '二話目' })
      const specialId = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
      actions.updatePiece(specialId, { subtitle: '鍵のかかった扉' })
      const memoId = actions.addMemo(titleId, '登場人物の口調')
      actions.updateMemo(memoId, {
        body: '澪：丁寧語。感情が高ぶると関西の言葉が少し出る。\n館長：ぶっきらぼう。語尾を伸ばさない。\n\n第3話までに、祖母の家の描写をもう一度入れること。',
      })
      return { titleId, pieceId, v2, specialId, memoId }
    })

    const dir = 'e2e/artifacts/screens'
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      const shot = async (name: string) => {
        await page.waitForTimeout(150)
        await page.screenshot({ path: `${dir}/piece-${project}-${scheme}-${name}.png` })
      }
      await openPiece(page, ids.titleId, ids.pieceId)
      await shot('list')
      await openPiece(page, ids.titleId, ids.pieceId, ids.v2)
      await expect(page.getByTestId('compare-editor')).toBeVisible()
      await shot('compare')
      await page.locator('label:has([data-testid="diff-toggle"])').click()
      await expect(page.getByTestId('diff-view').locator('.diff-add').first()).toBeVisible()
      await page.getByTestId('note-toggle').click()
      await shot('diff')
      await page.getByTestId('note-toggle').click()
      await page.locator('label:has([data-testid="diff-toggle"])').click()
      if (project !== 'desktop') {
        await page.getByTestId('view-menu-button').click()
        await shot('view-menu')
        await page.keyboard.press('Escape')
        await page.getByTestId('compare-more-button').click()
        await shot('compare-more')
        await page.keyboard.press('Escape')
        await page.getByTestId('active-more-button').click()
        await shot('active-more')
        await page.keyboard.press('Escape')
        // 編集中（集中モード）
        await page.getByTestId('compare-editor').tap()
        await shot('focus')
        await page.getByTestId('compare-editor').blur()
        // 横持ち
        await page.setViewportSize({ width: 844, height: 390 })
        await shot('landscape-compare')
        await page.getByTestId('view-menu-button').click()
        await shot('landscape-view-menu')
        await page.keyboard.press('Escape')
        await page.getByTestId('active-editor').tap()
        await page.setViewportSize({ width: 844, height: 190 })
        await shot('landscape-keyboard')
        await page.getByTestId('active-editor').blur()
        await page.setViewportSize({ width: 390, height: 844 })
        await page.getByTestId('view-menu-button').click()
        await expect(page.getByTestId('ratio-slider')).toBeVisible()
        await page.keyboard.press('Escape')
      }
      await page.getByTestId('ratio-slider').fill('28')
      await shot('ratio28')
      await page.getByTestId('ratio-slider').fill('50')
      await openPiece(page, ids.titleId, ids.specialId)
      await shot('special')
      await (await activeTool(page, 'unadopt-button')).click()
      await shot('unadopt-dialog')
      await page.getByRole('dialog').getByRole('button', { name: '採用を解除' }).click()
      await shot('empty')
      await page.getByTestId('version-row').first().getByTestId('row-adopt-button').click()
      await openApp(page, `/t/${ids.titleId}/m/${ids.memoId}`)
      await expect(page.getByTestId('memo-sheet')).toBeVisible()
      await shot('memo')
    }
  })
})
