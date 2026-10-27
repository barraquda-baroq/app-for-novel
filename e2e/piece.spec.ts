// 原稿画面（採用原稿と推敲バージョンの比較）とメモ画面の E2E テスト
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

const BODY1 = '吾輩は猫である。名前はまだ無い。\nどこで生れたかとんと見当がつかぬ。\n何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。'
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

    // 採用する → 採用原稿が入れ替わり、比較対象はそれまでの採用原稿（第1稿）になる
    await page.getByTestId('adopt-button').click()
    await expect(page.getByText('第2稿（第1稿を複製）を採用しました')).toBeVisible()
    await expect(page.getByTestId('active-editor')).toHaveValue(revised)
    await expect(page.getByTestId('version-select')).toHaveValue(firstVersionId)
    await expect(page.getByTestId('compare-editor')).toHaveValue(BODY1)
    await expect(page).toHaveURL(new RegExp(`\\?v=${firstVersionId}`))
    expect(await activeBodyOf(page, pid)).toBe(revised)

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
    expect(await share()).toBeCloseTo(0.5, 1)

    const slider = page.getByTestId('ratio-slider')
    await slider.fill('30')
    await expect.poll(share).toBeLessThan(0.33)
    expect(await share()).toBeGreaterThan(0.27)

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
    expect(await share()).toBeGreaterThan(0.35)
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

    await page.getByTestId('unadopt-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('採用原稿がありません。')
    await dialog.getByRole('button', { name: '採用を解除' }).click()

    await expect(page.getByTestId('no-active')).toContainText('採用原稿がありません。')
    await expect(page.getByTestId('active-editor')).toHaveCount(0)
    expect(await activeBodyOf(page, pid)).toBeNull()
    await expect(page.getByTestId('duplicate-active-list')).toBeDisabled()

    // バージョン自体は残っていて、一覧から採用し直せる
    const row = page.getByTestId('version-row').first()
    await expect(row).not.toContainText('採用中')
    await row.getByTestId('row-adopt-button').click()
    await expect(page.getByTestId('active-editor')).toHaveValue(BODY1)
    expect(await activeBodyOf(page, pid)).toBe(BODY1)

    // 解除してから「白紙の稿を作って採用」
    await page.getByTestId('unadopt-button').click()
    await page.getByRole('dialog').getByRole('button', { name: '採用を解除' }).click()
    await page.getByTestId('create-and-adopt').click()
    await expect(page.getByTestId('active-editor')).toHaveValue('')
    await expect(page.getByTestId('versions-heading')).toHaveText('推敲バージョン（2）')
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
    await flush(page)
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
    await flush(page)
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
    await page.getByTestId('delete-version').click()
    await page.getByRole('dialog').getByRole('button', { name: '削除' }).click()
    await expect(page.getByTestId('versions-heading')).toHaveText('推敲バージョン（1）')
    await expect(page.locator('.toast.error')).toHaveCount(0)

    // 採用中のバージョンを選ぶと読み取り専用で表示される
    await page.getByTestId('version-row').first().getByRole('button', { name: /を開いて比較する/ }).click()
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
    expect(await activeBodyOf(page, pieceIds[0])).toContain('追記。')

    // 話の題を入力中（自動保存の待ち時間内）でもすぐに保存される
    await page.getByTestId('subtitle-input').click()
    await page.keyboard.type('はじまり')
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => page.evaluate((id) => window.__ns.getData().pieces[id].subtitle, pieceIds[0]))
      .toBe('はじまり')
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

    // 編集中のまま削除しても、削除後に保存エラーが出ない
    await page.getByTestId('memo-body').fill('削除直前の追記')
    await page.getByTestId('memo-delete').click()
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
        body: body.replace('埃がゆっくりと舞っていた', '細かな埃が光の筋の中で踊っていた').replace('「また、ここに戻ってきたのね」\n', ''),
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
      await expect(page.getByTestId('diff-view')).toBeVisible()
      await page.getByTestId('note-toggle').click()
      await shot('diff')
      await page.getByTestId('note-toggle').click()
      await page.locator('label:has([data-testid="diff-toggle"])').click()
      if (project !== 'desktop') {
        await page.getByTestId('view-menu-button').click()
        await shot('view-menu')
        await page.keyboard.press('Escape')
      }
      await page.getByTestId('ratio-slider').fill('28')
      await shot('ratio28')
      await page.getByTestId('ratio-slider').fill('50')
      await openPiece(page, ids.titleId, ids.specialId)
      await shot('special')
      await page.getByTestId('unadopt-button').click()
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
