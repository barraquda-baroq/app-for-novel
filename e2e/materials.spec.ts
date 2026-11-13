// 資料（2.6。内部名は materials）の E2E テスト: ホームの棚（追加・並べ替え・削除して戻す）、資料の画面（決まった4つの項目の記録を
// 足す・開閉・全文・直す・削除）、タグ（資料の画面の「タグを付ける」・資料の情報を直すダイアログ。Enter・「、」・「,」で足し、
// ×・Backspace で外す。日本語の入力の変換中は足さない）、棚のタグのチップ（いくつか選ぶと、すべてのタグを持つ資料だけ）・検索の欄・
// 「タグを管理」（名前を変える・まとめる・削除）、手動の依頼文のコピーと結果の貼り付け（2回目は増えない）、360px の画面、ディープダーク。
// タグは作者が付けて管理するもので、Claude（コネクタ・手動の依頼文・貼り付け）は付けない。
import { expect, test, type Page } from '@playwright/test'
import { darkSurfaces, homeBandToggle, openApp, openHomeBands, seed, tapSize } from './helpers'

const dialog = (page: Page) => page.getByRole('dialog')

/**
 * 横にはみ出していない。スマホでは、はみ出すとページ全体が縮んで表示され、window.innerWidth も広がるので、
 * 文書の幅（clientWidth）と比べる
 */
async function noHorizontalScroll(page: Page): Promise<void> {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  expect(scroll).toBeLessThanOrEqual(client)
}

/** 開いたダイアログの動き（少し小さい所から大きくなる）が終わるまで待つ（押す所の大きさを測る前に） */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity),
  )
}

/** 資料（タグ・書誌・記録4件）と、もう1つの資料（タグ「歴史」・メモ） */
async function seedShelf(page: Page) {
  return seed(page, ({ actions }) => {
    const materialId = actions.addMaterial({
      name: '現代の特殊部隊',
      author: '山田',
      publisher: '軍事出版',
      year: '2019',
      tags: ['ミリタリ', '現代', '戦闘'],
      pdfPlace: 'プロジェクト「資料」',
    })
    const long = Array.from({ length: 30 }, (_, i) => `段落${i + 1}。${'あ'.repeat(200)}`).join('\n\n')
    actions.addMaterialNote(materialId, {
      section: '要約',
      body: `## 要約\n第1章は部隊の編成。\n\n${long}\n\n最後の一文。`,
      runDate: '2026-10-01',
    })
    actions.addMaterialNote(materialId, {
      section: '創作に役立つ知識',
      body: '## 創作に役立つ知識\n- 4人1組で動く（第2章）',
      runDate: '2026-10-02',
    })
    actions.addMaterialNote(materialId, {
      section: 'サンプルシーン',
      body: '## 夜明け前\n無線が二度鳴った。',
      runDate: '2026-10-02',
    })
    actions.addMaterialNote(materialId, { section: '用語集', body: '- CQB: 近接戦闘', runDate: '2026-10-03' })
    const otherId = actions.addMaterial({ name: '江戸の町と暮らし', author: '佐藤', tags: ['歴史'], note: '長屋の場面に使う' })
    return { materialId, otherId }
  })
}

/** 棚の絞り込みを確かめる資料（タグ・著者・メモがそれぞれ違う4冊） */
async function seedTagged(page: Page) {
  return seed(page, ({ actions }) => ({
    a: actions.addMaterial({ name: '現代の特殊部隊', author: '山田', tags: ['ミリタリ', '現代', '戦闘'] }),
    b: actions.addMaterial({ name: '戦国の合戦', author: '佐藤', tags: ['歴史', '戦闘'] }),
    c: actions.addMaterial({ name: '戦場の医療', author: '鈴木', tags: ['ミリタリ', '医療'] }),
    d: actions.addMaterial({ name: '江戸の町と暮らし', author: '高橋', note: '長屋の場面に使う' }),
  }))
}

const cardNames = (page: Page) => page.getByTestId('material-card').getByTestId('material-card-name').allTextContents()
const tagsOf = (page: Page, id: string) => page.evaluate((m) => window.__ns.getData().materials[m].tags, id)
const chip = (page: Page, tag: string) => page.locator(`[data-testid="material-tag-chip"][data-tag="${tag}"]`)
const group = (page: Page, section: string) => page.locator(`[data-testid="material-group"][data-section="${section}"]`)

test.describe('資料', () => {
  test('ホームの「資料」: 資料を追加（タグも付ける）・並べ替え・削除するとゴミ箱へ。戻すと元の位置に記録といっしょに戻る', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    await seedShelf(page)
    await openApp(page)
    await openHomeBands(page)
    const shelf = page.getByTestId('material-shelf')
    await expect(shelf.getByRole('heading', { name: '資料', level: 2 })).toBeVisible()
    await expect(shelf.getByTestId('material-count')).toHaveText('2')
    await expect(shelf.getByTestId('new-material')).toHaveText('資料を追加')
    const card = shelf.getByTestId('material-card').first()
    await expect(card.getByTestId('material-card-name')).toHaveText('現代の特殊部隊')
    await expect(card.getByTestId('material-card-biblio')).toHaveText('山田・軍事出版・2019')
    await expect(card.getByTestId('material-card-tag')).toHaveText(['ミリタリ', '現代', '戦闘'])
    await expect(card.getByTestId('material-card-count')).toHaveText('記録 4件')
    // 項目のチップは決まった4つの順（まだ無い「描写に使える部分」は出さない）、ほかの項目は後ろ
    await expect(card.getByTestId('material-card-section')).toHaveText(['要約', '創作に役立つ知識', 'サンプルシーン', '用語集'])
    // スマホでは上の切り替えにもある（4つ目）
    if (await page.getByTestId('home-jump').isVisible()) {
      await expect(page.getByTestId('home-jump').getByRole('button')).toHaveText(['タイトル0', 'アイデア0', '相対比較0', '資料2'])
      await page.getByTestId('home-jump-materials').click()
      await expect(homeBandToggle(page, 'materials')).toBeFocused()
      await expect(page.getByTestId('home-jump-materials')).toHaveAttribute('aria-current', 'true')
    }

    // 資料を追加（資料名は必須。タグも付けられる）。追加すると資料の画面が開く
    await page.getByTestId('new-material').click()
    await expect(dialog(page).getByRole('heading', { name: '資料を追加' })).toBeVisible()
    await expect(page.getByTestId('material-save')).toHaveText('追加')
    await page.getByTestId('material-save').click()
    await expect(dialog(page).getByRole('alert')).toHaveText('資料名を入れてください')
    await page.getByTestId('material-name').fill('戦場の医療')
    await page.getByTestId('material-author').fill('鈴木')
    const tagInput = dialog(page).getByTestId('material-tag-input')
    await tagInput.fill('医療、')
    // 使っているタグを候補に出す（押すと付く）
    await dialog(page).getByRole('button', { name: 'タグ「ミリタリ」を付ける' }).click()
    await expect(dialog(page).getByTestId('material-tag-chip-edit')).toHaveText(['医療', 'ミリタリ'])
    await page.getByTestId('material-pdf').fill('プロジェクト「医療」')
    await page.getByTestId('material-save').click()
    await expect(page.getByRole('status').filter({ hasText: '「戦場の医療」を資料の棚に追加しました' })).toBeVisible()
    await expect(page).toHaveURL(/#\/materials\//)
    await expect(page.getByTestId('material-title')).toHaveText('戦場の医療')
    await expect(page).toHaveTitle('資料: 戦場の医療 — Novel Studio')
    await expect(page.getByTestId('material-tag')).toHaveText(['医療', 'ミリタリ'])
    await expect(page.getByTestId('material-notes-empty')).toBeVisible()
    // パンくず「ホーム › 資料 › 資料名」の「資料」で棚へ戻る。読み込み直して（ホームの帯は4つとも閉じる。2.9）から戻っても、
    // 資料の帯を開いて見出しのボタンにフォーカスする（ほかの帯は閉じたまま）
    await page.reload()
    const crumbs = page.getByRole('navigation', { name: '現在地' })
    await expect(crumbs).toContainText('ホーム')
    await expect(crumbs).toContainText('戦場の医療')
    await crumbs.getByRole('link', { name: '資料', exact: true }).click()
    await expect(homeBandToggle(page, 'materials')).toHaveAttribute('aria-expanded', 'true')
    await expect(shelf.getByRole('heading', { name: '資料', level: 2 })).toBeInViewport()
    await expect(homeBandToggle(page, 'materials')).toBeFocused()
    await expect(homeBandToggle(page, 'titles')).toHaveAttribute('aria-expanded', 'false')
    await expect(homeBandToggle(page, 'bench')).toHaveAttribute('aria-expanded', 'false')
    if (await page.getByTestId('home-jump').isVisible())
      await expect(page.getByTestId('home-jump-materials')).toHaveAttribute('aria-current', 'true')
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊', '江戸の町と暮らし', '戦場の医療'])

    // 並べ替え（↑↓・位置を選んで移動）
    await page.getByTestId('material-edit-toggle').click()
    await shelf.getByTestId('material-card').nth(2).getByTestId('material-up').click()
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊', '戦場の医療', '江戸の町と暮らし'])
    await shelf.getByTestId('material-card').nth(1).getByTestId('material-move').click()
    await page.getByTestId('material-move-target').selectOption({ index: 0 })
    await page.getByTestId('material-move-submit').click()
    await expect.poll(() => cardNames(page)).toEqual(['戦場の医療', '現代の特殊部隊', '江戸の町と暮らし'])

    // 削除（記録ごと。PDF は消えない）→ ゴミ箱 → 戻す（棚の元の位置に、記録もいっしょに）
    await shelf.getByTestId('material-card').nth(1).getByTestId('material-delete').click()
    await expect(dialog(page)).toContainText('「現代の特殊部隊」を削除しますか？')
    await expect(dialog(page)).toContainText('この資料を資料の棚から削除し、記録（4件）もいっしょにゴミ箱に移します。')
    await expect(dialog(page)).toContainText('PDF そのものは claude.ai のプロジェクトにあるので、消えません。')
    await dialog(page).getByRole('button', { name: '削除' }).click()
    await expect.poll(() => cardNames(page)).toEqual(['戦場の医療', '江戸の町と暮らし'])
    await openApp(page, '/trash')
    const row = page.getByTestId('trash-row').first()
    await expect(row.getByTestId('trash-kind')).toHaveText('資料')
    await expect(row.getByTestId('trash-label')).toHaveText('現代の特殊部隊')
    await expect(row.getByTestId('trash-place')).toHaveText('資料')
    await row.getByTestId('trash-restore').click()
    await expect(page.getByRole('status').filter({ hasText: '「現代の特殊部隊」を元の場所に戻しました' })).toBeVisible()
    await openApp(page)
    await openHomeBands(page)
    await expect.poll(() => cardNames(page)).toEqual(['戦場の医療', '現代の特殊部隊', '江戸の町と暮らし'])
    const restored = page.getByTestId('material-card').nth(1)
    await expect(restored.getByTestId('material-card-count')).toHaveText('記録 4件')
    await expect(restored.getByTestId('material-card-tag')).toHaveText(['ミリタリ', '現代', '戦闘'])
    await noHorizontalScroll(page)
  })

  test('資料の画面: 決まった4つの項目の順に記録を出し（まだ無い項目も）、開閉・「全文を表示」。記録を追加・直す・削除する', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    const { materialId } = await seedShelf(page)
    await openApp(page, `/materials/${materialId}`)
    await expect(page.getByTestId('material-biblio')).toHaveText('山田・軍事出版・2019')
    await expect(page.getByTestId('material-pdf-place')).toHaveText('プロジェクト「資料」')
    await expect(page.getByTestId('material-edit')).toHaveText('資料の情報を直す')
    const groups = page.getByTestId('material-group')
    await expect
      .poll(() => groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-section'))))
      .toEqual(['要約', '創作に役立つ知識', '描写に使える部分', 'サンプルシーン', '用語集'])
    // 記録のまだ無い決まった項目は「この項目の記録を追加」
    await expect(group(page, '描写に使える部分').getByTestId('material-group-empty')).toContainText('まだ記録がありません。')

    // 開閉。長い記録は頭だけ（「全文を表示」で全部）
    const summary = group(page, '要約').getByTestId('material-note')
    await expect(summary.getByTestId('material-note-body')).toHaveCount(0)
    await summary.getByTestId('material-note-toggle').click()
    await expect(summary.getByTestId('material-note-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(summary.getByTestId('material-note-body').locator('h2')).toHaveText('要約')
    await expect(summary.getByTestId('material-note-body')).not.toContainText('最後の一文')
    await summary.getByTestId('material-note-more').click()
    await expect(summary.getByTestId('material-note-body')).toContainText('最後の一文')
    await summary.getByTestId('material-note-toggle').click()
    await expect(summary.getByTestId('material-note-body')).toHaveCount(0)

    // まだ無い項目から足す（項目は入っている）
    await group(page, '描写に使える部分').getByTestId('material-group-add').click()
    await expect(page.getByTestId('material-note-section')).toHaveValue('描写に使える部分')
    await page.getByTestId('material-note-date').fill('2026-10-30')
    await page.getByTestId('material-note-input').fill('## 描写\n- 暗視装置の緑の視界（第5章）')
    await page.getByTestId('material-note-save').click()
    const scene = group(page, '描写に使える部分').getByTestId('material-note')
    await expect(scene.getByTestId('material-note-body')).toContainText('暗視装置の緑の視界')
    await expect(scene.getByTestId('material-note-date-label')).toHaveText('2026/10/30')
    // 「記録を追加」から、項目の候補を選んで足す（同じ項目の中は新しい日付から）
    await page.getByTestId('material-add-note').click()
    await dialog(page).getByTestId('material-note-suggestion').filter({ hasText: '創作に役立つ知識' }).click()
    await expect(page.getByTestId('material-note-section')).toHaveValue('創作に役立つ知識')
    await page.getByTestId('material-note-date').fill('2026-10-31')
    await page.getByTestId('material-note-input').fill('## 創作に役立つ知識（続き）\n- 突入の合図は無線で2回')
    await page.getByTestId('material-note-save').click()
    await expect(group(page, '創作に役立つ知識').getByTestId('material-note-date-label')).toHaveText(['2026/10/31', '2026/10/02'])
    await expect(groups).toHaveCount(5)
    // 直す
    await scene.getByTestId('material-note-edit').click()
    await page.getByTestId('material-note-input').fill('## 描写\n- 雨の夜の集合（第6章）')
    await page.getByTestId('material-note-save').click()
    await expect(scene.getByTestId('material-note-body')).toContainText('雨の夜の集合')
    // 削除（ゴミ箱では「資料の記録」、場所は「資料 › 資料名」）
    await scene.getByTestId('material-note-delete').click()
    await expect(dialog(page)).toContainText('「描写に使える部分」の記録を削除しますか？')
    await dialog(page).getByRole('button', { name: '削除' }).click()
    await expect(group(page, '描写に使える部分').getByTestId('material-group-empty')).toBeVisible()
    // 資料の情報を直す
    await page.getByTestId('material-edit').click()
    await page.getByTestId('material-publisher').fill('特殊戦出版')
    await page.getByTestId('material-memo').fill('第3作の突入場面に使う')
    await page.getByTestId('material-save').click()
    await expect(page.getByTestId('material-biblio')).toHaveText('山田・特殊戦出版・2019')
    await expect(page.getByTestId('material-note-text')).toHaveText('第3作の突入場面に使う')
    await noHorizontalScroll(page)
    await openApp(page, '/trash')
    const row = page.getByTestId('trash-row').first()
    await expect(row.getByTestId('trash-kind')).toHaveText('資料の記録')
    await expect(row.getByTestId('trash-label')).toHaveText('描写に使える部分（2026-10-30）')
    await expect(row.getByTestId('trash-place')).toHaveText('資料 › 現代の特殊部隊')
  })

  test('タグ: 資料の画面の「タグを付ける」（Enter・「、」・「,」で足し、×・Backspace で外す。保存するまで変えない）と、資料の情報を直すダイアログ', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    const { id } = await seed(page, ({ actions }) => {
      actions.addMaterial({ name: '戦国の合戦', tags: ['歴史', '戦闘'] })
      return { id: actions.addMaterial({ name: '現代の特殊部隊', author: '山田' }) }
    })
    await openApp(page, `/materials/${id}`)
    await expect(page.getByTestId('material-no-tags')).toHaveText('タグなし')
    await expect(page.getByTestId('material-edit-tags')).toHaveText('タグを付ける')
    await page.getByTestId('material-edit-tags').click()
    await expect(dialog(page).getByRole('heading', { name: '「現代の特殊部隊」のタグ' })).toBeVisible()
    const input = dialog(page).getByTestId('material-tag-input')
    const chips = dialog(page).getByTestId('material-tag-chip-edit')
    await expect(input).toBeFocused()
    await input.pressSequentially('ミリタリ')
    await input.press('Enter')
    await expect(chips).toHaveText(['ミリタリ'])
    await expect(input).toHaveValue('')
    // 「,」「、」で区切る（全角と半角の違いは同じタグ）。打っている途中の文字は残す
    await input.pressSequentially('現代,ﾐﾘﾀﾘ、戦')
    await expect(chips).toHaveText(['ミリタリ', '現代'])
    await expect(input).toHaveValue('戦')
    // 候補は使っているタグのうち、打っている途中の文字を含むもの
    await expect(dialog(page).getByTestId('material-tag-suggestion')).toHaveText(['戦闘'])
    await dialog(page).getByTestId('material-tag-suggestion').click()
    await expect(chips).toHaveText(['ミリタリ', '現代', '戦闘'])
    await expect(input).toBeFocused()
    // 空の入力欄で Backspace は最後のタグを外す。×でも外す
    await input.press('Backspace')
    await expect(chips).toHaveText(['ミリタリ', '現代'])
    await dialog(page).getByRole('button', { name: 'タグ「ミリタリ」を外す' }).click()
    await expect(chips).toHaveText(['現代'])
    // 20字を超えるタグは足さない（理由を伝える）
    await input.fill('あ'.repeat(21))
    await input.press('Enter')
    await expect(dialog(page).getByTestId('material-tag-error')).toContainText('タグは20字までにしてください')
    await expect(chips).toHaveText(['現代'])
    // キャンセルすると何も変えない
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await tagsOf(page, id)).toBeUndefined()

    // 保存（打ちかけのタグも入る）
    await page.getByTestId('material-edit-tags').click()
    await dialog(page).getByTestId('material-tag-input').fill('ミリタリ、現代、特殊部隊')
    await page.getByTestId('material-tags-save').click()
    await expect(page.getByRole('status').filter({ hasText: 'タグを保存しました' })).toBeVisible()
    await expect(page.getByTestId('material-tag')).toHaveText(['ミリタリ', '現代', '特殊部隊'])
    await expect(page.getByTestId('material-edit-tags')).toHaveText('タグを編集')
    expect(await tagsOf(page, id)).toEqual(['ミリタリ', '現代', '特殊部隊'])

    // 資料の情報を直すダイアログでもタグを直せる
    await page.getByTestId('material-edit').click()
    await expect(dialog(page).getByTestId('material-tag-chip-edit')).toHaveText(['ミリタリ', '現代', '特殊部隊'])
    await dialog(page).getByRole('button', { name: 'タグ「特殊部隊」を外す' }).click()
    await dialog(page).getByRole('button', { name: 'タグ「戦闘」を付ける' }).click()
    await page.getByTestId('material-save').click()
    await expect(page.getByTestId('material-tag')).toHaveText(['ミリタリ', '現代', '戦闘'])
    expect(await tagsOf(page, id)).toEqual(['ミリタリ', '現代', '戦闘'])
    await noHorizontalScroll(page)
  })

  test('タグ: 日本語の入力の変換中は「、」・Enter で足さず、確定してから足す', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', '変換中の入力は Chromium の DevTools プロトコルで作る')
    await openApp(page)
    await openHomeBands(page)
    const id = await seed(page, ({ actions }) => actions.addMaterial({ name: '現代の特殊部隊' }))
    await openApp(page, `/materials/${id}`)
    await page.getByTestId('material-edit-tags').click()
    const input = dialog(page).getByTestId('material-tag-input')
    const chips = dialog(page).getByTestId('material-tag-chip-edit')
    await expect(input).toBeFocused()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'みりたり、', selectionStart: 5, selectionEnd: 5 })
    await expect(input).toHaveValue('みりたり、')
    // 変換中の Enter（変換を確定するためのもの）でも足さない
    await input.evaluate((el) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })),
    )
    await expect(chips).toHaveCount(0)
    await expect(dialog(page)).toBeVisible()
    // 確定すると、区切りの前までをタグにする
    await cdp.send('Input.insertText', { text: 'ミリタリ、' })
    await expect(chips).toHaveText(['ミリタリ'])
    await expect(input).toHaveValue('')
    await cdp.detach()
  })

  test('棚: タグのチップで絞る（いくつか選ぶとすべてのタグを持つ資料だけ）・検索の欄・「タグを管理」で名前を変える・まとめる・削除', async ({
    page,
  }) => {
    await openApp(page)
    await openHomeBands(page)
    const { a, b, c } = await seedTagged(page)
    await openApp(page)
    await openHomeBands(page)
    const shelf = page.getByTestId('material-shelf')
    const all = ['現代の特殊部隊', '戦国の合戦', '戦場の医療', '江戸の町と暮らし']
    await expect.poll(() => cardNames(page)).toEqual(all)
    // 使っているタグを資料の数つきで（多い順、同じなら名前の順）
    const chips = shelf.getByTestId('material-tag-chip')
    await expect
      .poll(() => chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-tag'))))
      .toEqual(['ミリタリ', '戦闘', '医療', '現代', '歴史'])
    await expect(chip(page, 'ミリタリ')).toHaveText('ミリタリ2件')
    await expect(shelf.getByTestId('material-filter-count')).toHaveText('')

    // 押すと絞る。もう1つ選ぶと、両方を持つ資料だけ
    await chip(page, 'ミリタリ').click()
    await expect(chip(page, 'ミリタリ')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊', '戦場の医療'])
    await expect(shelf.getByTestId('material-filter-count')).toHaveText('2件／全4件')
    await chip(page, '戦闘').click()
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊'])
    await expect(shelf.getByTestId('material-filter-count')).toHaveText('1件／全4件')
    // もう一度押すと外す（「戦闘」だけになる）
    await chip(page, 'ミリタリ').click()
    await expect(chip(page, 'ミリタリ')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊', '戦国の合戦'])
    // 資料の画面へ行って戻っても、同じ絞り込みのまま
    await shelf.getByTestId('material-card-link').first().click()
    await expect(page.getByTestId('material-title')).toHaveText('現代の特殊部隊')
    await page.getByRole('navigation', { name: '現在地' }).getByRole('link', { name: '資料', exact: true }).click()
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊', '戦国の合戦'])
    await expect(chip(page, '戦闘')).toHaveAttribute('aria-pressed', 'true')
    await shelf.getByTestId('material-tags-clear').click()
    await expect.poll(() => cardNames(page)).toEqual(all)

    // 検索の欄（資料名・著者・タグ・メモの部分一致。全角と半角は同じ）
    const search = shelf.getByTestId('material-search')
    await search.fill('長屋')
    await expect.poll(() => cardNames(page)).toEqual(['江戸の町と暮らし'])
    await search.fill('佐藤')
    await expect.poll(() => cardNames(page)).toEqual(['戦国の合戦'])
    await search.fill('ﾐﾘﾀﾘ')
    await expect.poll(() => cardNames(page)).toEqual(['現代の特殊部隊', '戦場の医療'])
    await expect(shelf.getByTestId('material-filter-count')).toHaveText('2件／全4件')
    // 検索とタグをいっしょに使う。当てはまらなければ「当てはまる資料がありません」
    await chip(page, '歴史').click()
    await expect(shelf.getByTestId('material-no-match')).toContainText('当てはまる資料がありません。')
    await shelf.getByTestId('material-filter-clear').click()
    await expect(search).toHaveValue('')
    await expect.poll(() => cardNames(page)).toEqual(all)
    await expect(chip(page, '歴史')).toHaveAttribute('aria-pressed', 'false')

    // タグを管理: 名前を変える（すべての資料で）
    await chip(page, '歴史').click()
    await expect.poll(() => cardNames(page)).toEqual(['戦国の合戦'])
    await shelf.getByTestId('material-manage-tags-open').click()
    const manage = page.getByTestId('material-manage-tags')
    const rows = manage.getByTestId('material-manage-tag')
    await expect(rows).toHaveCount(5)
    await expect(manage.getByTestId('material-manage-tag-count')).toHaveText(['2件', '2件', '1件', '1件', '1件'])
    const row = (tag: string) => manage.locator(`[data-testid="material-manage-tag"][data-tag="${tag}"]`)
    await row('歴史').getByTestId('material-manage-rename').click()
    const rename = page.getByRole('dialog', { name: 'タグ「歴史」の名前を変える' })
    await rename.getByRole('textbox').fill('戦国')
    await rename.getByRole('button', { name: '名前を変える' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'タグ「歴史」の名前を「戦国」に変えました（1件の資料）' }),
    ).toBeVisible()
    await expect.poll(() => tagsOf(page, b)).toEqual(['戦国', '戦闘'])
    await expect(row('戦国')).toBeVisible()
    // もうあるタグの名前にすると、確かめてからまとめる（両方が付いた資料では1つに）
    await row('ミリタリ').getByTestId('material-manage-rename').click()
    const rename2 = page.getByRole('dialog', { name: 'タグ「ミリタリ」の名前を変える' })
    await rename2.getByRole('textbox').fill('戦闘')
    await rename2.getByRole('button', { name: '名前を変える' }).click()
    const merge = page.getByRole('dialog', { name: 'タグ「戦闘」にまとめますか？' })
    await expect(merge).toContainText('タグ「戦闘」はもう2件の資料に付いています')
    await merge.getByRole('button', { name: 'まとめる' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'タグ「ミリタリ」を「戦闘」にまとめました（2件の資料）' }),
    ).toBeVisible()
    await expect.poll(() => tagsOf(page, a)).toEqual(['戦闘', '現代'])
    expect(await tagsOf(page, c)).toEqual(['戦闘', '医療'])
    await expect(row('戦闘').getByTestId('material-manage-tag-count')).toHaveText('3件')
    // 削除は確かめてから（資料は消えない）
    await row('医療').getByTestId('material-manage-delete').click()
    const confirm = page.getByRole('dialog', { name: 'タグ「医療」を削除しますか？' })
    await expect(confirm).toContainText('1件の資料からタグ「医療」を外します。資料とその記録は消えません')
    await confirm.getByRole('button', { name: '削除' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'タグ「医療」を1件の資料から外しました' })).toBeVisible()
    await expect.poll(() => tagsOf(page, c)).toEqual(['戦闘'])
    await expect(rows).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(manage).toHaveCount(0)
    // 棚のチップも変わる（名前を変えたタグの絞り込みは続く）
    await expect
      .poll(() => chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-tag'))))
      .toEqual(['戦闘', '現代', '戦国'])
    await expect(chip(page, '戦国')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => cardNames(page)).toEqual(['戦国の合戦'])
    await expect(page.getByTestId('material-card').getByTestId('material-card-tag')).toHaveText(['戦国', '戦闘'])
    expect(await page.evaluate(() => Object.keys(window.__ns.getData().materials).length)).toBe(4)
    await noHorizontalScroll(page)
  })

  test('Claude に頼む（手動）: 項目を選んで依頼文をコピーし、結果を貼り付けると記録になる（2回目は増えない。タグは付けない）', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'クリップボードの読み取りは Chromium だけ')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openApp(page)
    await openHomeBands(page)
    const { materialId } = await seedShelf(page)
    await openApp(page, `/materials/${materialId}`)
    await page.getByTestId('material-manual').click()
    const manual = page.getByTestId('material-manual-dialog')
    // 既定は決まった4つ（使ったことのあるほかの項目も選べる）
    await expect(manual.getByTestId('material-manual-section')).toHaveText([
      '要約',
      '創作に役立つ知識',
      '描写に使える部分',
      'サンプルシーン',
      '用語集',
    ])
    await expect(manual.getByRole('button', { name: '用語集' })).toHaveAttribute('aria-pressed', 'false')
    await manual.getByRole('button', { name: 'サンプルシーン' }).click()
    await expect(manual.getByRole('button', { name: 'サンプルシーン' })).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('material-manual-new-section').fill('年表')
    await page.getByTestId('material-manual-add-section').click()
    await expect(page.getByTestId('material-manual-copy')).toHaveText('依頼文をコピー（項目 4つ）')
    await page.getByTestId('material-manual-copy').click()
    const prompt = await page.evaluate(() => navigator.clipboard.readText())
    expect(prompt).toContain('このプロジェクトのナレッジにある資料『現代の特殊部隊』（山田）の PDF')
    expect(prompt).toContain('（PDF の置き場所: プロジェクト「資料」）')
    expect(prompt).toMatch(/- 要約: .+\n- 創作に役立つ知識: .+\n- 描写に使える部分: .+\n- 年表\n/)
    expect(prompt).not.toContain('- サンプルシーン:')
    expect(prompt).toContain('"tool":"novel_add_material_notes"')
    expect(prompt).toContain('```novel-studio-v1')
    // タグは作者が付けるもの（依頼文はタグに触れない）
    expect(prompt).not.toContain('タグ')
    expect(prompt).not.toContain('tags')
    await expect(page.getByTestId('material-manual-copy')).toHaveClass(/is-copied/)

    await page.getByTestId('material-manual-open-paste').click()
    const answer = [
      '記録しました。',
      '```novel-studio-v1',
      JSON.stringify({
        tool: 'novel_add_material_notes',
        input: {
          material: 'd:dummy',
          // 資料の画面では new_material は使わない（タグも付かない）
          new_material: { name: '別の資料', author: '誰か', tags: ['勝手なタグ'] },
          items: [
            { section: '年表', body_markdown: '## 年表\n- 1980 創設', run_date: '2026-10-30' },
            { section: '要約', body_markdown: '## 要約（読み直し）\n第3章が要。', run_date: '2026-10-30' },
          ],
        },
      }),
      '```',
    ].join('\n')
    await page.getByTestId('paste-input').fill(answer)
    await expect(page.getByTestId('paste-add')).toHaveText('追加（2件）')
    await page.getByTestId('paste-add').click()
    await expect(page.getByRole('status').filter({ hasText: '2件を追加しました' })).toBeVisible()
    await expect(group(page, '年表')).toHaveCount(1)
    await expect(group(page, '要約').getByTestId('material-note-date-label')).toHaveText(['2026/10/30', '2026/10/01'])
    // 同じ答えをもう一度: 増えない
    await page.getByTestId('material-paste').click()
    await page.getByTestId('paste-input').fill(answer)
    await expect(page.getByTestId('paste-summary')).toHaveText('重複 2件')
    await expect(page.getByTestId('paste-add')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('material-note')).toHaveCount(6)
    // 資料は増えず、タグも変わらない
    const data = await page.evaluate(() => {
      const d = window.__ns.getData()
      return { names: Object.values(d.materials).map((m) => m.name), tags: Object.values(d.materials).map((m) => m.tags) }
    })
    expect(data.names.sort()).toEqual(['江戸の町と暮らし', '現代の特殊部隊'].sort())
    expect(data.tags.flat()).not.toContain('勝手なタグ')
  })

  test('幅 360px でも横にはみ出さず、ボタンは押しやすい大きさ', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの幅で確かめる')
    await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    await openHomeBands(page)
    const { materialId } = await seedShelf(page)
    await openApp(page)
    await openHomeBands(page)
    // 上の切り替えの4つ（タイトル・アイデア・相対比較・資料）が1列に収まり、名前も数も切れない
    const jump = page.getByTestId('home-jump').getByRole('button')
    await expect(jump).toHaveCount(4)
    for (const id of ['titles', 'ideas', 'bench', 'materials']) {
      const button = page.getByTestId(`home-jump-${id}`)
      await tapSize(button, `home-jump-${id}`)
      expect(await button.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    }
    const tops = await jump.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    expect(new Set(tops).size).toBe(1)
    await page.getByTestId('home-jump-materials').click()
    await expect(page.getByTestId('home-jump-materials')).toHaveAttribute('aria-current', 'true')
    await noHorizontalScroll(page)
    await tapSize(page.getByTestId('material-search'), 'material-search', false)
    await tapSize(chip(page, 'ミリタリ'), 'material-tag-chip', false)
    await tapSize(page.getByTestId('material-manage-tags-open'), 'material-manage-tags-open', false)
    await chip(page, 'ミリタリ').click()
    await tapSize(page.getByTestId('material-tags-clear'), 'material-tags-clear', false)
    await tapSize(page.getByTestId('material-filter-clear'), 'material-filter-clear', false)
    await noHorizontalScroll(page)
    await page.getByTestId('material-filter-clear').click()
    await page.getByTestId('material-edit-toggle').click()
    await tapSize(page.getByTestId('material-up').first(), 'material-up')
    await tapSize(page.getByTestId('material-delete').first(), 'material-delete', false)
    await noHorizontalScroll(page)
    await page.getByTestId('material-manage-tags-open').click()
    await settled(page)
    for (const id of ['material-manage-rename', 'material-manage-delete']) await tapSize(page.getByTestId(id).first(), id, false)
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('new-material').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await openApp(page, `/materials/${materialId}`)
    await noHorizontalScroll(page)
    for (const id of [
      'material-edit',
      'material-delete',
      'material-edit-tags',
      'material-add-note',
      'material-manual',
      'material-paste',
    ])
      await tapSize(page.getByTestId(id), id, false)
    await tapSize(page.getByTestId('material-group-add'), 'material-group-add', false)
    await page.getByTestId('material-note-toggle').first().click()
    for (const id of ['material-note-copy', 'material-note-edit', 'material-note-delete'])
      await tapSize(page.getByTestId(id).first(), id, false)
    await noHorizontalScroll(page)
    // タグの編集: ×・候補・入力欄
    await page.getByTestId('material-edit-tags').click()
    await settled(page)
    await tapSize(dialog(page).getByTestId('material-tag-remove').first(), 'material-tag-remove')
    await tapSize(dialog(page).getByTestId('material-tag-input'), 'material-tag-input', false)
    await tapSize(dialog(page).getByTestId('material-tag-suggestion').first(), 'material-tag-suggestion', false)
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('material-manual').click()
    await settled(page)
    await tapSize(page.getByTestId('material-manual-section').first(), 'material-manual-section', false)
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('material-add-note').click()
    await noHorizontalScroll(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('material-edit').click()
    await noHorizontalScroll(page)
  })

  test('ディープダーク: 資料の棚・資料の画面・タグのダイアログに白い面が出ない（スクリーンショット）', async ({
    page,
  }, testInfo) => {
    await openApp(page, '/settings')
    await page.getByTestId('theme-deep-dark').click()
    const { materialId } = await seedShelf(page)
    const project = testInfo.project.name
    const dir = 'e2e/artifacts/screens'
    await openApp(page)
    await openHomeBands(page)
    await chip(page, 'ミリタリ').click()
    await darkSurfaces(page, [
      '.home-mat-card',
      '.home-mat-tag',
      '.home-mat-cardtag',
      '.home-mat-chip',
      '.home-mat-search .input',
      '.badge',
      '.btn',
    ])
    await page.getByTestId('material-shelf').screenshot({ path: `${dir}/materials-${project}-deep-dark-shelf.png` })
    await page.getByTestId('material-manage-tags-open').click()
    await darkSurfaces(page, ['.modal', '.mt-manage-row', '.btn'])
    await page.keyboard.press('Escape')
    await openApp(page, `/materials/${materialId}`)
    await page.getByTestId('material-toggle-all').click()
    await darkSurfaces(page, ['.mt-head', '.mt-tag-chip', '.mt-note', '.sx-card', '.badge', '.btn', '.md code'])
    await page.screenshot({ path: `${dir}/materials-${project}-deep-dark-page.png`, fullPage: true })
    await page.getByTestId('material-edit-tags').click()
    await darkSurfaces(page, ['.modal', '.mt-tag-chip', '.mt-tag-suggestion', '.input', '.btn'])
    await page.getByRole('dialog').screenshot({ path: `${dir}/materials-${project}-deep-dark-tags.png` })
    await page.keyboard.press('Escape')
    await page.getByTestId('material-manual').click()
    await darkSurfaces(page, ['.modal', '.mt-suggest-chip', '.input', '.btn'])
  })
})
