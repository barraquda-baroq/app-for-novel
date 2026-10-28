// タイトル画面の設定タブ・戦略タブと、通し読み画面の E2E テスト。
import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, seed, seedTitleWithEpisodes } from './helpers'

function dialog(page: Page): Locator {
  return page.getByRole('dialog')
}

async function flushAndReload(page: Page): Promise<void> {
  await page.evaluate(() => window.__ns.flushNow())
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__ns))
}

/** ページ全体が横にスクロールしない（スマホ幅でのはみ出しチェック） */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/**
 * 書き出しボタンを押してダウンロードされたファイル名と内容を返す。
 * ファイル名は <a download> の値を見る（UTF-8 でないロケールのヘッドレス Chromium では
 * 日本語のファイル名が suggestedFilename() で "download" になってしまうため）。
 */
async function exportAndRead(page: Page, button: Locator): Promise<{ name: string; text: string }> {
  await page.evaluate(() => {
    const w = window as unknown as { __downloadNames?: string[] }
    if (w.__downloadNames) return
    w.__downloadNames = []
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.__downloadNames!.push(this.download)
      return original.call(this)
    }
  })
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  const name = await page.evaluate(() => (window as unknown as { __downloadNames: string[] }).__downloadNames.at(-1) ?? '')
  return { name, text: readFileSync(await download.path(), 'utf8') }
}

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysFromToday(n: number): Date {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d
}

// ---------------------------------------------------------------------------
test.describe('設定タブ', () => {
  test('項目をプリセットや任意の名前で後から追加でき、エントリとフィールドを編集できる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => actions.createTitle('星の海'))
    await openApp(page, `/t/${titleId}?tab=settings`)

    const items = page.getByTestId('category-item')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('キャラクター')
    await expect(items.nth(1)).toContainText('世界観')
    // 既定は最初の項目
    await expect(items.nth(0)).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('category-title')).toHaveText('キャラクター')
    await expect(page.getByTestId('entries-empty')).toContainText('まだエントリがありません')
    await expect(page.getByTestId('template-keys')).toHaveText('読み・年齢・性別・立場・役割・性格・外見・背景')

    // プリセットから追加
    await page.getByTestId('add-category').click()
    await expect(page.getByTestId('category-submit')).toBeDisabled()
    await dialog(page)
      .getByRole('button', { name: /用語集/ })
      .click()
    await expect(page.getByTestId('category-name-input')).toHaveValue('用語集')
    await expect(page.getByTestId('category-template-input')).toHaveValue('読み\n意味')
    await page.getByTestId('category-submit').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(items).toHaveCount(3)
    await expect(items.nth(2)).toHaveAttribute('aria-current', 'true')
    await expect(page).toHaveURL(/tab=settings&cat=/)
    await expect(page.getByTestId('category-title')).toHaveText('用語集')

    // 任意の名前で追加（テンプレートなし）
    await page.getByTestId('add-category').click()
    await page.getByTestId('category-name-input').fill('魔導列車の路線')
    await page.getByTestId('category-name-input').press('Enter')
    await expect(items).toHaveCount(4)
    await expect(page.getByTestId('category-title')).toHaveText('魔導列車の路線')
    await expect(page.getByText('なし（自由記述のみ）')).toBeVisible()

    // キャラクターにエントリを追加
    await items.nth(0).click()
    await expect(page).toHaveURL(/tab=settings/)
    await page.getByTestId('add-entry').click()
    const card = page.getByTestId('entry-card').first()
    await expect(card.getByTestId('entry-name')).toBeFocused()
    await card.getByTestId('entry-name').fill('ミナト')
    await card.getByTestId('entry-name').press('Enter')
    const fields = card.getByTestId('entry-field')
    await expect(fields).toHaveCount(7)
    await expect(fields.nth(0).getByTestId('field-key')).toHaveValue('読み')
    await fields.nth(0).getByTestId('field-value').fill('みなと')
    await fields.nth(1).getByTestId('field-value').fill('17')
    await card.getByTestId('entry-body').fill('灯台守の孫。\n星図を読むのが得意。')
    // フィールドを追加して名前を付ける
    await card.getByTestId('add-field').click()
    await expect(fields).toHaveCount(8)
    await expect(fields.nth(7).getByTestId('field-key')).toBeFocused()
    await fields.nth(7).getByTestId('field-key').fill('口癖')
    await fields.nth(7).getByTestId('field-value').fill('「まあ、なんとかなるさ」')
    // 空のフィールドは確認なしで削除できる（並べ替え・削除はフィールドごとの「…」メニュー）
    await fields.nth(2).getByTestId('field-menu').click()
    await fields.nth(2).getByTestId('field-remove').click()
    await expect(fields).toHaveCount(7)
    // 並べ替え（口癖を1つ上へ）
    await fields.nth(6).getByTestId('field-menu').click()
    await fields.nth(6).getByTestId('field-up').click()
    await expect(fields.nth(5).getByTestId('field-key')).toHaveValue('口癖')
    await card.getByTestId('entry-close').click()
    await expect(card.getByTestId('entry-summary')).toContainText('読み：みなと')
    await expect(card.getByTestId('entry-summary')).toContainText('年齢：17')
    await expect(items.nth(0)).toContainText('1')

    await flushAndReload(page)
    const saved = await page.evaluate(() => Object.values(window.__ns.getData().settingEntries)[0])
    expect(saved.name).toBe('ミナト')
    expect(saved.body).toBe('灯台守の孫。\n星図を読むのが得意。')
    expect(saved.fields.map((f) => f.key)).toEqual(['読み', '年齢', '立場・役割', '性格', '外見', '口癖', '背景'])
    expect(saved.fields.find((f) => f.key === '口癖')?.value).toBe('「まあ、なんとかなるさ」')
  })

  test('エントリの並べ替え・別の項目への移動・削除、項目の名前変更・テンプレート編集・削除', async ({ page }) => {
    await openApp(page)
    const ids = await seed(page, ({ actions, getData }) => {
      const titleId = actions.createTitle('灯台')
      const cats = Object.values(getData().settingCategories).filter((c) => c.titleId === titleId)
      const chara = cats.find((c) => c.name === 'キャラクター')!.id
      const world = cats.find((c) => c.name === '世界観')!.id
      const a = actions.addEntry(chara, 'アオイ')
      const b = actions.addEntry(chara, 'ベニ')
      actions.addEntry(chara, 'クロ')
      return { titleId, chara, world, a, b }
    })
    await openApp(page, `/t/${ids.titleId}?tab=settings&cat=${ids.chara}`)
    const names = () => page.getByTestId('entry-name-label').allTextContents()
    await expect(page.getByTestId('entry-name-label')).toHaveText(['アオイ', 'ベニ', 'クロ'])

    // ベニを上へ
    const beni = page.getByTestId('entry-card').nth(1)
    await beni.getByTestId('entry-toggle').click()
    await beni.getByTestId('entry-up').click()
    await expect.poll(names).toEqual(['ベニ', 'アオイ', 'クロ'])

    // ベニを世界観へ移動
    await page.getByTestId('entry-card').nth(0).getByTestId('entry-move').selectOption({ label: '世界観' })
    await expect.poll(names).toEqual(['アオイ', 'クロ'])
    await expect(page.getByText('「ベニ」を「世界観」へ移動しました')).toBeVisible()
    await page.getByTestId('category-item').nth(1).click()
    await expect(page).toHaveURL(new RegExp(`cat=${ids.world}`))
    await expect(page.getByTestId('category-title')).toHaveText('世界観')
    await expect(page.getByTestId('entry-name-label')).toHaveText(['ベニ'])
    await page.getByTestId('category-item').nth(0).click()
    await expect(page.getByTestId('entry-name-label')).toHaveText(['アオイ', 'クロ'])

    // クロを削除（確認あり）
    const kuro = page.getByTestId('entry-card').nth(1)
    await kuro.getByTestId('entry-toggle').click()
    await kuro.getByTestId('entry-name').fill('クロ（編集中）')
    await kuro.getByTestId('entry-delete').click()
    await expect(dialog(page)).toContainText('削除しますか')
    await dialog(page).getByRole('button', { name: '削除', exact: true }).click()
    await expect.poll(names).toEqual(['アオイ'])
    await expect(page.locator('.toast.error')).toHaveCount(0)

    // 名前を変更
    await page.getByTestId('category-menu').click()
    await page.getByTestId('category-rename').click()
    await dialog(page).getByRole('textbox').fill('登場人物')
    await dialog(page).getByRole('button', { name: '変更' }).click()
    await expect(page.getByTestId('category-title')).toHaveText('登場人物')
    await expect(page.getByTestId('category-item').nth(0)).toContainText('登場人物')

    // テンプレートを編集し、既存のエントリにも足りない項目を足す
    await page.getByTestId('template-edit').click()
    await expect(page.getByTestId('template-dialog')).toContainText('新しく作るエントリに最初から用意される項目です')
    await page.getByTestId('template-input').fill('読み\n二つ名\n\n読み')
    await page.getByTestId('template-fill').check()
    await page.getByTestId('template-save').click()
    await expect(page.getByTestId('template-keys')).toHaveText('読み・二つ名')
    const aoi = page.getByTestId('entry-card').nth(0)
    await aoi.getByTestId('entry-toggle').click()
    // テンプレートから作られた既存の7項目はそのまま、足りない「二つ名」だけが末尾に増える
    await expect(aoi.getByTestId('field-key')).toHaveCount(8)
    await expect(aoi.getByTestId('field-key').nth(7)).toHaveValue('二つ名')

    // 項目の並べ替え（メニューから下へ）
    await page.getByTestId('category-menu').click()
    await expect(page.getByTestId('category-up')).toBeDisabled()
    await page.getByTestId('category-down').click()
    await expect(page.getByTestId('category-item').nth(1)).toContainText('登場人物')
    await expect(page.getByTestId('category-item').nth(1)).toHaveAttribute('aria-current', 'true')

    // 項目を削除すると中のエントリも消える
    await page.getByTestId('category-menu').click()
    await page.getByTestId('category-delete').click()
    await expect(dialog(page)).toContainText('エントリ（1件）もすべて削除されます')
    await dialog(page).getByRole('button', { name: '削除', exact: true }).click()
    await expect(page.getByTestId('category-item')).toHaveCount(1)
    await expect(page.getByTestId('category-title')).toHaveText('世界観')
    const left = await page.evaluate(() => Object.values(window.__ns.getData().settingEntries).map((e) => e.name))
    expect(left).toEqual(['ベニ'])
  })

  test('本編タブの設定チップから項目を選んだ状態で開ける。項目がないときの表示', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('チップ')
      const world = Object.values(getData().settingCategories).find((c) => c.titleId === id && c.name === '世界観')!
      actions.addEntry(world.id, '浮遊大陸')
      return id
    })
    await openApp(page, `/t/${titleId}`)
    await page.getByTestId('setting-chip').nth(1).click()
    await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('category-title')).toHaveText('世界観')
    await expect(page.getByTestId('entry-name-label')).toHaveText(['浮遊大陸'])

    // すべて削除すると空の表示になる
    await seed(
      page,
      ({ actions, getData }, id: string) => {
        for (const c of Object.values(getData().settingCategories).filter((x) => x.titleId === id)) actions.deleteCategory(c.id)
      },
      titleId,
    )
    await expect(page.getByTestId('settings-empty')).toContainText('まだ設定項目がありません')
    await page.getByTestId('add-category').click()
    await dialog(page)
      .getByRole('button', { name: /キャラクター/ })
      .click()
    await page.getByTestId('category-submit').click()
    await expect(page.getByTestId('category-title')).toHaveText('キャラクター')
    await expectNoHorizontalScroll(page)
  })

  test('キーボードでフィールドを続けて入力できる（Enter で内容へ、操作は「…」メニュー1か所）。重複キーの警告を出さない', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await openApp(page)
    const ids = await seed(page, ({ actions, getData }) => {
      const titleId = actions.createTitle('鍵盤')
      const chara = Object.values(getData().settingCategories).find((c) => c.titleId === titleId && c.name === 'キャラクター')!.id
      const entryId = actions.addEntry(chara, '澪')
      return { titleId, entryId }
    })
    await openApp(page, `/t/${ids.titleId}?tab=settings`)
    await page.getByTestId('entry-toggle').click()
    const fields = page.getByTestId('entry-field')
    await expect(fields).toHaveCount(7)

    // 項目名で Enter → 内容 → Tab で「…」→ Tab で次の項目名
    await fields.nth(0).getByTestId('field-key').fill('よみがな')
    await fields.nth(0).getByTestId('field-key').press('Enter')
    await expect(fields.nth(0).getByTestId('field-value')).toBeFocused()
    await page.keyboard.type('みお')
    await page.keyboard.press('Tab')
    await expect(fields.nth(0).getByTestId('field-menu')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(fields.nth(1).getByTestId('field-key')).toBeFocused()
    await page.keyboard.press('Tab')
    await page.keyboard.type('26')
    await page.keyboard.press('Tab')
    await expect(fields.nth(1).getByTestId('field-menu')).toBeFocused()

    // メニューもキーボードで操作できる（年齢を下へ）
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('field-up')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(fields.nth(2).getByTestId('field-key')).toHaveValue('年齢')
    await expect(fields.nth(2).getByTestId('field-menu')).toBeFocused()

    await page.evaluate(() => window.__ns.flushNow())
    const saved = await page.evaluate((id) => window.__ns.getData().settingEntries[id].fields, ids.entryId)
    expect(saved.slice(0, 3).map((f) => [f.key, f.value])).toEqual([
      ['よみがな', 'みお'],
      ['性別', ''],
      ['年齢', '26'],
    ])
    expect(errors.filter((e) => e.includes('same key'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
test.describe('戦略タブ', () => {
  test('全体戦略・現在の原稿・応募計画（規定文字数・締切・スナップショット・応募順）', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '海の記憶', [
      'あ'.repeat(1200),
      'い'.repeat(800),
      'う'.repeat(500),
    ])
    await seed(page, ({ actions }, id: string) => actions.setActiveVersion(id, null), pieceIds[2])
    await openApp(page, `/t/${titleId}?tab=strategy`)

    // 現在の原稿
    await expect(page.getByTestId('summary-chars')).toHaveText('2,000字')
    await expect(page.getByTestId('summary-episodes')).toHaveText('3話')
    await expect(page.getByTestId('summary-pages')).toHaveText('約5枚')
    await expect(page.getByTestId('summary-missing')).toContainText('採用原稿なし 1話')

    // 全体戦略
    await page.getByTestId('strategy-note').fill('まずはWeb小説の長編賞で反応を見る。')
    await page.getByTestId('strategy-note').blur()
    await expect
      .poll(() => page.evaluate((id) => window.__ns.getData().titles[id].strategyNote, titleId))
      .toBe('まずはWeb小説の長編賞で反応を見る。')

    // 応募先を追加
    await expect(page.getByTestId('submissions-empty')).toBeVisible()
    await page.getByTestId('add-submission').click()
    await dialog(page).getByRole('textbox').fill('海風小説大賞')
    await dialog(page).getByRole('button', { name: '追加' }).click()
    const cards = page.getByTestId('submission-card')
    await expect(cards).toHaveCount(1)
    const first = cards.nth(0)
    await expect(first.getByTestId('submission-editor')).toBeVisible()
    await expect(first.getByTestId('submission-number')).toContainText('1')
    await expect(first.getByTestId('submission-name')).toHaveText('海風小説大賞')
    await expect(first.getByTestId('submission-status')).toHaveText('検討中')

    // 規定文字数（下限）を入れると不足が出る
    await first.getByTestId('submission-min').fill('3,200')
    await first.getByTestId('submission-min').press('Enter')
    await expect(first.getByTestId('submission-limit')).toHaveText('あと1,200字必要')
    await expect(first.getByTestId('submission-limit-detail')).toContainText('現在の採用原稿 2,000字 → あと1,200字必要')
    // 上限を超えると超過
    await first.getByTestId('submission-min').fill('')
    await first.getByTestId('submission-min').press('Enter')
    await first.getByTestId('submission-max').fill('1500')
    await first.getByTestId('submission-max').press('Enter')
    await expect(first.getByTestId('submission-limit')).toHaveText('500字超過')
    await first.getByTestId('submission-max').fill('1万')
    await first.getByTestId('submission-max').press('Enter')
    await expect(first.getByTestId('submission-limit')).toHaveText('規定内')
    await expect(first.getByTestId('submission-max')).toHaveValue('10000')
    // 数字として読めない入力は保存しない
    await first.getByTestId('submission-max').fill('たくさん')
    await first.getByTestId('submission-max').press('Enter')
    await expect(page.locator('.toast.error')).toContainText('数字で入力してください')
    await expect(first.getByTestId('submission-max')).toHaveValue('10000')

    // 締切
    const deadline = daysFromToday(65)
    await first.getByTestId('submission-deadline-input').fill(ymd(deadline))
    await expect(first.getByTestId('submission-deadline')).toHaveText(`締切 ${ymd(deadline).replace(/-/g, '/')}（あと65日）`)
    // 応募済みにすると応募時の原稿の記録をすすめられる（ここでは記録しない）
    await first.getByTestId('submission-status-select').selectOption('submitted')
    await expect(dialog(page)).toContainText('応募した原稿として記録します')
    await dialog(page).getByRole('button', { name: '記録しない' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(first.getByTestId('submission-status')).toHaveText('応募済み')
    // 応募後は締切を出さない
    await expect(first.getByTestId('submission-deadline')).toHaveCount(0)
    await first.getByTestId('submission-stage').fill('一次選考通過')
    await first.getByTestId('submission-stage').press('Enter')
    await first.getByTestId('submission-url').fill('https://example.com/contest')
    await first.getByTestId('submission-url').press('Enter')
    await expect(first.getByTestId('submission-url-open')).toHaveAttribute('href', 'https://example.com/contest')
    await first.getByTestId('submission-overview').fill('長編ファンタジー部門。賞金50万円。')
    await first.getByTestId('submission-revision').fill('中盤のテンポを上げる')
    await first.getByTestId('submission-revision').blur()

    // 応募時の原稿を記録
    await first.getByTestId('snapshot-record').click()
    await expect(first.getByTestId('snapshot-info')).toContainText('記録・2,000字・約5枚・3話')
    await expect(first.getByTestId('snapshot-diff')).toContainText('変わっていません')
    // 採用原稿を変えると、変わった話の数が出る
    await seed(
      page,
      ({ actions, getData }, id: string) => {
        const v = actions.addVersion(id, { body: '新しい原稿' })
        actions.setActiveVersion(id, v)
        return getData().pieces[id].activeVersionId
      },
      pieceIds[2],
    )
    await expect(first.getByTestId('snapshot-diff')).toContainText('記録した後に変わったもの：稿の切り替え 1件')
    await expect(first.getByTestId('snapshot-piece').nth(2)).toContainText('稿が変わった')
    // 記録し直すときは確認する
    await first.getByTestId('snapshot-record').click()
    await expect(dialog(page)).toContainText('上書きされます')
    await dialog(page).getByRole('button', { name: '記録し直す' }).click()
    await expect(first.getByTestId('snapshot-diff')).toContainText('変わっていません')
    await expect(first.getByTestId('snapshot-info')).toContainText('2,005字')

    // 2件目・3件目を追加して応募順を入れ替える
    for (const name of ['潮騒文庫新人賞', '灯火ネット小説コン']) {
      await page.getByTestId('add-submission').click()
      await dialog(page).getByRole('textbox').fill(name)
      await dialog(page).getByRole('button', { name: '追加' }).click()
    }
    await expect(cards).toHaveCount(3)
    const contestNames = () => page.getByTestId('submission-name').allTextContents()
    await expect(page.getByTestId('submission-name')).toHaveText(['海風小説大賞', '潮騒文庫新人賞', '灯火ネット小説コン'])
    await cards
      .nth(2)
      .getByTestId('submission-deadline-input')
      .fill(ymd(daysFromToday(-3)))
    await expect(cards.nth(2).getByTestId('submission-deadline')).toContainText('締切を過ぎています')
    await cards.nth(2).getByRole('button', { name: '応募順を上げる' }).click()
    await expect.poll(contestNames).toEqual(['海風小説大賞', '灯火ネット小説コン', '潮騒文庫新人賞'])
    await expect(cards.nth(1).getByTestId('submission-number')).toContainText('2')
    await expect(cards.nth(0).getByRole('button', { name: '応募順を上げる' })).toBeDisabled()

    // 締切順（応募前で締切が近いもの → 締切未定 → 応募済み → 締切を過ぎたもの）で見ても応募順は変わらない
    await page.getByTestId('sort-deadline').click()
    await expect.poll(contestNames).toEqual(['潮騒文庫新人賞', '海風小説大賞', '灯火ネット小説コン'])
    await expect(cards.nth(0).getByTestId('submission-number')).toContainText('3')
    await expect(page.getByRole('button', { name: '応募順を上げる' })).toHaveCount(0)
    await page.getByTestId('sort-order').click()
    await expect.poll(contestNames).toEqual(['海風小説大賞', '灯火ネット小説コン', '潮騒文庫新人賞'])

    // 削除
    await cards.nth(2).getByTestId('submission-delete').click()
    await dialog(page).getByRole('button', { name: '削除', exact: true }).click()
    await expect(cards).toHaveCount(2)

    await flushAndReload(page)
    const subs = await page.evaluate((id) => {
      return Object.values(window.__ns.getData().submissions)
        .filter((s) => s.titleId === id)
        .sort((a, b) => a.order - b.order)
    }, titleId)
    expect(subs.map((s) => s.contestName)).toEqual(['海風小説大賞', '灯火ネット小説コン'])
    expect(subs[0]).toMatchObject({
      status: 'submitted',
      stage: '一次選考通過',
      minChars: null,
      maxChars: 10000,
      deadline: ymd(deadline),
      url: 'https://example.com/contest',
      overview: '長編ファンタジー部門。賞金50万円。',
      revisionPlan: '中盤のテンポを上げる',
    })
    expect(subs[0].snapshot?.charCount).toBe(2005)
    await expectNoHorizontalScroll(page)
  })

  test('応募済みにすると応募した原稿を記録でき、内訳・読む・書き出し・状態ごとの見出し・枚数の規定が使える', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '灯台守', ['一話の本文。', 'あ'.repeat(1992)])
    const ids = await seed(
      page,
      ({ actions, getData }, a: { titleId: string; pieceIds: string[] }) => {
        actions.updatePiece(a.pieceIds[0], { subtitle: '霧笛' })
        const pro = actions.addSpecial(a.titleId, { chapterId: null, index: 0 }, 'プロローグ')
        actions.updateVersion(getData().pieces[pro].versionIds[0], { body: '序。' })
        const sub = actions.addSubmission(a.titleId, '潮風文学賞')
        actions.updateSubmission(sub, { status: 'planned', minChars: 2100 })
        const done = actions.addSubmission(a.titleId, '去年の賞')
        actions.updateSubmission(done, {
          status: 'rejected',
          deadline: '2020-01-01',
          minChars: 999999,
          result: '一次落選。会話が多いとの講評。',
        })
        return { sub, done }
      },
      { titleId, pieceIds },
    )
    await openApp(page, `/t/${titleId}?tab=strategy`)
    const cards = page.getByTestId('submission-card')
    const card = cards.nth(0)
    // 応募前は現在の原稿（2,000字）で判定
    await expect(card.getByTestId('submission-limit')).toHaveText('あと100字必要')
    // 終了した応募先は締切・規定の注意を出さず、結果の抜粋を出す
    await expect(cards.nth(1).getByTestId('submission-deadline')).toHaveCount(0)
    await expect(cards.nth(1).getByTestId('submission-limit')).toHaveCount(0)
    await expect(cards.nth(1).getByTestId('submission-followup').nth(0)).toHaveText('結果・講評一次落選。会話が多いとの講評。')

    // 応募済みにして、応募した原稿を記録する（応募日に今日が入る）
    await card.getByTestId('submission-toggle').click()
    await card.getByTestId('submission-status-select').selectOption('submitted')
    await expect(dialog(page)).toContainText('現在の採用原稿（2,000字・2話＋特殊1）')
    await dialog(page).getByRole('button', { name: '記録する' }).click()
    await expect(card.getByTestId('snapshot-info')).toContainText('記録・2,000字・約7枚・2話＋特殊1')
    await expect(card.getByTestId('submission-submitted-input')).toHaveValue(ymd(new Date()))
    await expect(card.getByTestId('snapshot-piece')).toHaveText([
      'プロローグ第1稿・2字',
      '第1話霧笛第1稿・6字',
      '第2話第1稿・1,992字',
    ])

    // 応募後に原稿を直しても、規定の判定は応募した原稿で行い、変わった話に印が付く
    await seed(
      page,
      ({ actions, getData }, id: string) =>
        actions.updateVersion(getData().pieces[id].activeVersionId!, { body: 'あ'.repeat(2200) }),
      pieceIds[1],
    )
    await expect(card.getByTestId('snapshot-piece').nth(2)).toContainText('本文を編集')
    await expect(card.getByTestId('submission-limit')).toHaveText('あと100字必要')
    await expect(card.getByTestId('submission-limit-detail')).toHaveText('応募時の原稿 2,000字 → あと100字必要')

    // 書き出しと読む
    const exported = await exportAndRead(page, card.getByTestId('snapshot-export'))
    expect(exported.name).toBe('灯台守_潮風文学賞_応募時の原稿.txt')
    expect(exported.text).toBe(
      `灯台守\n\nプロローグ\n\n序。\n\n\n第1話　霧笛\n\n一話の本文。\n\n\n第2話\n\n${'あ'.repeat(1992)}\n`,
    )
    await card.getByTestId('snapshot-read').click()
    await expect(page.getByTestId('snapshot-reader')).toContainText('一話の本文。')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('snapshot-reader')).toHaveCount(0)

    // 規定を原稿用紙換算の枚数にする
    await card.getByTestId('limit-unit-pages').click()
    await card.getByTestId('submission-min').fill('10')
    await card.getByTestId('submission-min').press('Enter')
    await expect(card.getByTestId('submission-limit')).toHaveText('あと3枚必要')
    await expect(card.getByTestId('submission-limit-detail')).toHaveText('応募時の原稿 約7枚 → あと3枚必要')
    // 数字でない値を入れて Tab で移っても、移った先の欄にフォーカスが残る
    await card.getByTestId('submission-min').fill('たくさん')
    await page.keyboard.press('Tab')
    await expect(card.getByTestId('submission-max')).toBeFocused()
    await expect(card.getByTestId('submission-min')).toHaveValue('10')

    // 結果発表までの日数
    await card.getByTestId('submission-result-on-input').fill(ymd(daysFromToday(12)))
    await expect(card.getByTestId('submission-result-on')).toContainText('結果発表まであと12日')

    await page.evaluate(() => window.__ns.flushNow())
    const saved = await page.evaluate((id) => window.__ns.getData().submissions[id], ids.sub)
    expect(saved).toMatchObject({ status: 'submitted', limitUnit: 'pages', minChars: 10, submittedOn: ymd(new Date()) })
    expect(saved.snapshot?.pieces && Object.keys(saved.snapshot.pieces)).toHaveLength(3)
    await expectNoHorizontalScroll(page)
  })

  test('現在の原稿の数字は桁の途中で折り返さない', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '大長編', ['あ'.repeat(1_234_567)])
    for (const width of [1400, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await openApp(page, `/t/${titleId}?tab=strategy`)
      const chars = page.getByTestId('summary-chars')
      await expect(chars).toHaveText('1,234,567字')
      const box = await chars.evaluate((el) => {
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
        const parent = el.parentElement!.getBoundingClientRect()
        const self = el.getBoundingClientRect()
        return { height: self.height, lineHeight, overflow: self.right - parent.right }
      })
      // 1行に収まり、枠からはみ出さない
      expect(box.height).toBeLessThan(box.lineHeight * 1.5)
      expect(box.overflow).toBeLessThanOrEqual(0)
      await expectNoHorizontalScroll(page)
    }
  })
})

// ---------------------------------------------------------------------------
test.describe('通し読み', () => {
  test('採用原稿だけが表示され、採用原稿のない話には「採用原稿がありません。」と出る', async ({ page }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedTitleWithEpisodes(page, '月の庭', [
      '一話の本文です。',
      '二話の本文です。',
      '三話の本文です。',
    ])
    await seed(
      page,
      ({ actions, getData }, a: { titleId: string; pieceIds: string[] }) => {
        // 第2話は採用を外す。別案（採用していない稿）は通し読みに出ない
        actions.addVersion(a.pieceIds[0], { body: '採用していない別案' })
        actions.setActiveVersion(a.pieceIds[1], null)
        const sp = actions.addSpecial(a.titleId, { chapterId: null, index: 0 }, 'プロローグ')
        actions.updatePiece(sp, { subtitle: '始まりの夜' })
        actions.updateVersion(getData().pieces[sp].versionIds[0], { body: 'プロローグの本文。' })
        actions.updatePiece(a.pieceIds[2], { subtitle: '満ち欠け' })
      },
      { titleId, pieceIds },
    )

    await openApp(page, `/t/${titleId}`)
    await page.getByTestId('read-through-link').click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}/read$`))
    await expect(page.locator('.breadcrumbs')).toContainText('月の庭')
    await expect(page.locator('.breadcrumbs')).toContainText('通し読み')

    const pieces = page.getByTestId('read-piece')
    await expect(pieces).toHaveCount(4)
    await expect(page.getByTestId('read-piece-label')).toHaveText(['プロローグ', '第1話', '第2話', '第3話'])
    await expect(pieces.nth(0)).toHaveAttribute('data-kind', 'special')
    await expect(pieces.nth(0)).toContainText('始まりの夜')
    await expect(pieces.nth(0)).toContainText('プロローグの本文。')
    await expect(pieces.nth(1)).toContainText('一話の本文です。')
    await expect(page.getByText('採用していない別案')).toHaveCount(0)
    await expect(pieces.nth(2).getByTestId('no-active')).toHaveText('採用原稿がありません。')
    await expect(page.getByTestId('no-active')).toHaveCount(1)
    await expect(pieces.nth(3)).toContainText('満ち欠け')
    await expect(page.getByTestId('read-missing')).toHaveText('採用原稿なし 1話')
    await expect(page.getByTestId('read-total')).toHaveText('採用原稿 25字')

    // 目次から移動できる
    const toc = page.getByTestId('toc-link')
    if (!(await toc.first().isVisible())) await page.getByTestId('toc-toggle').click()
    await expect(toc).toHaveCount(4)
    await toc.nth(3).click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}/read$`))
    await expect(pieces.nth(3).locator('h3')).toBeFocused()

    // 編集リンクで原稿画面へ
    await pieces.nth(2).getByTestId('read-edit').click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}/p/${pieceIds[1]}`))
  })

  test('章で絞り込み、縦書き・文字サイズを切り替え、テキストで書き出せる', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openApp(page)
    const ids = await seed(page, ({ actions, getData }) => {
      const titleId = actions.createTitle('風の便り')
      const body = (n: number) => `第${n}話の採用原稿。\n　二行目。` + '\n　風が吹いて、木々の葉がさらさらと鳴った。'.repeat(12)
      const p = [1, 2, 3, 4].map((n) => {
        const id = actions.addEpisode(titleId)
        actions.updateVersion(getData().pieces[id].versionIds[0], { body: body(n) })
        return id
      })
      actions.setChaptersEnabled(titleId, true)
      const ch1 = getData().titles[titleId].structure[0].id
      actions.updateChapter(ch1, { name: '第一章　旅立ち' })
      const ch2 = actions.addChapter(titleId, '第二章　帰郷')
      actions.movePiece(p[3], { chapterId: ch2, index: 0 })
      actions.movePiece(p[2], { chapterId: ch2, index: 0 })
      actions.setActiveVersion(p[3], null)
      return { titleId, ch1, ch2, p }
    })
    await openApp(page, `/t/${ids.titleId}/read`)
    await expect(page.getByTestId('read-chapter')).toHaveText(['第一章　旅立ち', '第二章　帰郷'])
    await expect(page.getByTestId('read-piece')).toHaveCount(4)

    // 章で絞り込む
    await page.getByTestId('read-scope').selectOption({ label: '第二章　帰郷' })
    await expect(page).toHaveURL(new RegExp(`read\\?chapter=${ids.ch2}`))
    await expect(page.getByTestId('read-chapter')).toHaveText(['第二章　帰郷'])
    await expect(page.getByTestId('read-piece-label')).toHaveText(['第3話', '第4話'])
    await expect(page.locator('.breadcrumbs')).toContainText('第二章　帰郷')
    await expect(page.getByTestId('no-active')).toHaveCount(1)

    // 書き出し（この章だけ）
    const chapterExport = await exportAndRead(page, page.getByTestId('export-text'))
    expect(chapterExport.name).toBe('風の便り_第二章　帰郷.txt')
    const chapterText = chapterExport.text
    expect(chapterText).toContain('■ 第二章　帰郷')
    expect(chapterText).toContain('第3話の採用原稿。')
    expect(chapterText).toContain('採用原稿がありません。')
    expect(chapterText).not.toContain('第1話の採用原稿。')

    // 全体に戻して書き出し
    await page.getByTestId('read-scope').selectOption({ label: '全体' })
    await expect(page).toHaveURL(new RegExp(`#/t/${ids.titleId}/read$`))
    await expect(page.getByTestId('read-piece')).toHaveCount(4)
    const whole = await exportAndRead(page, page.getByTestId('export-text'))
    expect(whole.name).toBe('風の便り.txt')
    const text = whole.text
    expect(text.startsWith('風の便り\n')).toBe(true)
    expect(text).toContain('第1話の採用原稿。')
    expect(text).toContain('第3話の採用原稿。')
    expect(text).toContain('第4話\n\n採用原稿がありません。')

    // 全文コピー
    await page.getByTestId('copy-all').click()
    await expect(page.getByText('全文をコピーしました')).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(text)

    // 文字サイズ
    const body = page.getByTestId('read-body')
    await expect(page.getByTestId('font-size')).toContainText('17')
    await page.getByTestId('font-larger').click()
    await page.getByTestId('font-larger').click()
    await expect(page.getByTestId('font-size')).toContainText('19')
    await expect(body).toHaveCSS('font-size', '19px')
    for (let i = 0; i < 20; i++) {
      if (await page.getByTestId('font-smaller').isDisabled()) break
      await page.getByTestId('font-smaller').click()
    }
    await expect(page.getByTestId('font-size')).toContainText('14')
    await expect(page.getByTestId('font-smaller')).toBeDisabled()

    // 縦書き
    await expect(body).toHaveCSS('writing-mode', 'horizontal-tb')
    await page.getByTestId('vertical-toggle').click()
    await expect(page.getByTestId('vertical-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(body).toHaveCSS('writing-mode', 'vertical-rl')
    // ページではなく本文の枠の中で横にスクロールする
    const box = await body.evaluate((el) => ({
      sw: el.scrollWidth,
      cw: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }))
    expect(box.overflowX).toBe('auto')
    expect(box.sw).toBeGreaterThan(box.cw)
    await expectNoHorizontalScroll(page)
    // 設定は保存される
    await page.reload()
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'vertical-rl')
    await page.getByTestId('vertical-toggle').click()
    await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'horizontal-tb')
  })

  test('話がないタイトルと、存在しないタイトル', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions }) => actions.createTitle('白紙'))
    await openApp(page, `/t/${titleId}/read`)
    await expect(page.getByTestId('read-empty')).toContainText('まだ話がありません。')
    await expect(page.getByTestId('export-text')).toBeDisabled()
    await openApp(page, '/t/no-such-title/read')
    await expect(page.getByText('タイトルが見つかりません。')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
test.describe('スクリーンショット', () => {
  test('設定・戦略・通し読み（ライト・ダーク）', async ({ page }, info) => {
    test.setTimeout(120_000)
    const project = info.project.name
    if (project === 'desktop') await page.setViewportSize({ width: 1400, height: 900 })
    else await page.setViewportSize({ width: 390, height: 844 })

    await openApp(page)
    const ids = await seed(page, ({ actions, getData }) => {
      const titleId = actions.createTitle('夜明けの図書館')
      actions.updateTitle(titleId, {
        strategyNote:
          'まずはライト文芸系の長編新人賞を本命に。落選した場合は講評を踏まえて改稿し、Web小説コンテストへ再応募する。\n書籍化までに10万字前後の完成稿を2本用意する。',
      })
      const lines = [
        '　朝の光が書架の隙間から差し込み、埃がゆっくりと舞っていた。',
        '　司書の澪は、誰もいない閲覧室で一冊の古い本を開いた。表紙は擦り切れ、題名はもう読めない。',
        '「また、ここに戻ってきたのね」',
        '　声に出してみると、それは思っていたよりもずっと小さく響いた。',
        '　ページをめくるたびに、紙の匂いと一緒に、遠い夏の記憶がよみがえる。祖母の家の縁側、蝉の声、冷えた麦茶のグラス。',
      ]
      const body = Array.from({ length: 3 }, () => lines.join('\n')).join('\n\n')
      const subtitles = ['朝の閲覧室', '鍵のかかった扉', '地下書庫', '灯りの消えた階段', '天窓']
      const pieces = subtitles.map((s) => {
        const id = actions.addEpisode(titleId)
        actions.updatePiece(id, { subtitle: s })
        actions.updateVersion(getData().pieces[id].versionIds[0], { body })
        return id
      })
      const pro = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
      actions.updatePiece(pro, { subtitle: '鍵' })
      actions.updateVersion(getData().pieces[pro].versionIds[0], { body: lines.slice(0, 3).join('\n') })
      actions.setActiveVersion(pieces[3], null)
      actions.setChaptersEnabled(titleId, true)
      const ch1 = getData().titles[titleId].structure.find((n) => n.type === 'chapter')!.id
      actions.updateChapter(ch1, { name: '第一章　閲覧室' })
      actions.movePiece(pro, { chapterId: null, index: 0 })
      const ch2 = actions.addChapter(titleId, '第二章　地下書庫')
      actions.movePiece(pieces[4], { chapterId: ch2, index: 0 })
      actions.movePiece(pieces[3], { chapterId: ch2, index: 0 })
      actions.movePiece(pieces[2], { chapterId: ch2, index: 0 })

      const cats = Object.values(getData().settingCategories).filter((c) => c.titleId === titleId)
      const chara = cats.find((c) => c.name === 'キャラクター')!.id
      const mio = actions.addEntry(chara, '澪（みお）')
      const f = getData().settingEntries[mio].fields
      actions.updateEntry(mio, {
        fields: f.map((x) =>
          x.key === '読み'
            ? { ...x, value: 'みお' }
            : x.key === '年齢'
              ? { ...x, value: '26' }
              : x.key === '立場・役割'
                ? { ...x, value: '市立図書館の司書。物語の語り手。' }
                : x.key === '性格'
                  ? { ...x, value: '穏やかだが頑固。本の修繕になると周りが見えなくなる。' }
                  : x,
        ),
        body: '祖母の遺した蔵書を探して、この図書館に勤めはじめた。',
      })
      actions.addEntry(chara, '館長')
      const kai = actions.addEntry(chara, '灰崎 透')
      actions.updateEntry(kai, {
        fields: getData().settingEntries[kai].fields.map((x) => (x.key === '年齢' ? { ...x, value: '31' } : x)),
      })
      actions.addCategory(titleId, '用語集', ['読み', '意味'])
      actions.addCategory(titleId, '地理・地名', ['読み', '概要'])
      actions.addCategory(titleId, '組織・勢力', ['目的', '構成員', '拠点'])

      const pad = (n: number) => String(n).padStart(2, '0')
      const day = (offset: number) => {
        const d = new Date()
        d.setDate(d.getDate() + offset)
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      }
      const s1 = actions.addSubmission(titleId, '夜明けライト文芸大賞')
      actions.updateSubmission(s1, {
        organizer: '暁出版',
        url: 'https://example.com/award',
        deadline: day(65),
        status: 'planned',
        minChars: 80000,
        maxChars: 120000,
        overview: '長編ライト文芸。賞金100万円・書籍化確約。一次は編集部、最終は作家3名による選考。',
        revisionPlan: '第3話の地下書庫の場面を膨らませて、全体で8万字を超えるようにする。',
      })
      const s2 = actions.addSubmission(titleId, '星灯Web小説コンテスト')
      actions.updateSubmission(s2, {
        organizer: '星灯ノベル',
        deadline: day(-20),
        submittedOn: day(-25),
        status: 'reviewing',
        stage: '一次選考通過',
        maxChars: 150000,
      })
      actions.recordSubmissionSnapshot(s2)
      const s3 = actions.addSubmission(titleId, '潮騒文庫新人賞')
      actions.updateSubmission(s3, {
        status: 'rejected',
        deadline: day(-120),
        result: '設定は魅力的だが、中盤の展開が遅いとの講評。',
      })
      actions.addSubmission(titleId, '青嵐短編賞')
      return { titleId, ch2, s1, s2 }
    })

    const dir = 'e2e/artifacts/screens'
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const shot = async (name: string, fullPage = false) => {
        // 固定ヘッダーがページの途中に写り込まないよう、全体を撮るときは先頭に戻す
        if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
        await page.waitForTimeout(150)
        await page.screenshot({ path: `${dir}/title-tabs-${project}-${scheme}-${name}.png`, fullPage })
      }

      // 設定タブ
      await openApp(page, `/t/${ids.titleId}?tab=settings`)
      await expect(page.getByTestId('entry-card')).toHaveCount(3)
      await shot('settings', true)
      await expectNoHorizontalScroll(page)
      await page.getByTestId('entry-card').nth(0).getByTestId('entry-toggle').click()
      await shot('settings-entry', true)
      await expectNoHorizontalScroll(page)
      await page.getByTestId('category-menu').click()
      await shot('settings-menu')
      await page.keyboard.press('Escape')
      await page.getByTestId('entry-field').nth(1).getByTestId('field-menu').click()
      await shot('settings-field-menu')
      await page.keyboard.press('Escape')
      await page.getByTestId('add-category').click()
      await dialog(page)
        .getByRole('button', { name: /キャラクター/ })
        .click()
      await shot('settings-add')
      await page.keyboard.press('Escape')

      // 戦略タブ
      await openApp(page, `/t/${ids.titleId}?tab=strategy`)
      await expect(page.getByTestId('submission-card')).toHaveCount(4)
      await shot('strategy', true)
      await expectNoHorizontalScroll(page)
      await page.getByTestId('submission-card').nth(1).getByTestId('submission-toggle').click()
      await shot('strategy-open', true)
      await expectNoHorizontalScroll(page)
      await page.getByTestId('submission-card').nth(1).getByTestId('snapshot-read').click()
      await shot('strategy-snapshot-read')
      await page.keyboard.press('Escape')
      await page.getByTestId('sort-deadline').click()
      await shot('strategy-deadline', true)
      await page.getByTestId('sort-order').click()

      // 通し読み
      await openApp(page, `/t/${ids.titleId}/read`)
      await expect(page.getByTestId('read-piece')).toHaveCount(6)
      await shot('read')
      await expectNoHorizontalScroll(page)
      if (project !== 'desktop') {
        await page.getByTestId('toc-toggle').click()
        await shot('read-toc')
        await page.getByTestId('toc-toggle').click()
      }
      await page.getByTestId('read-piece').nth(4).scrollIntoViewIfNeeded()
      await shot('read-missing')
      await page.getByTestId('vertical-toggle').click()
      await expect(page.getByTestId('read-body')).toHaveCSS('writing-mode', 'vertical-rl')
      await shot('read-vertical')
      await expectNoHorizontalScroll(page)
      await page.getByTestId('vertical-toggle').click()
      await openApp(page, `/t/${ids.titleId}/read?chapter=${ids.ch2}`)
      await shot('read-chapter')
    }
  })
})
