// 見た目（Diary Studio に合わせた外観。docs/SPEC.md の「UI の約束事」）の E2E テスト: ホームの帯の見出し（アイコンを付けず、件数は札にしない
// 等幅の数字）、帯の追加のボタン（枠だけ）、タイトルの画面のタブ・スマホの切り替えの角、流れの中のカードの影（付けない。縦書きの紙の縁と
// ダイアログの影は残す）、色の線がある辺の角、選んだ設定項目・絞り込みのタグ・見出しの数の地、集計の札と「Claude に見せる」の枠、
// 押せないタグの枠、スマホの端の余白と横のはみ出し（通し読みも）、設定の「書体のライセンス」。
import { expect, test, type Locator, type Page } from '@playwright/test'
import { homeBandToggle, luminance, noHorizontalScroll, openApp, openHomeBands, seed, type HomeBand } from './helpers'

const BANDS: HomeBand[] = ['titles', 'ideas', 'bench', 'materials']

/** タイトル（話・設定のエントリ・アイデア）・相対比較の作品（分析・タグ）・資料（記録・タグ）とどのタイトルにも属さないアイデア */
async function seedLook(page: Page) {
  return seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('灯台の町')
    for (const body of ['港に灯がともる。', '霧の朝、船が戻らない。']) {
      const id = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[id].versionIds[0], { body })
    }
    const chara = Object.values(getData().settingCategories).find((c) => c.titleId === titleId && c.name === 'キャラクター')!.id
    for (const name of ['ミナト', 'カイ']) actions.addEntry(chara, name)
    actions.addIdea(titleId, '', '灯台守の日誌を物語の軸にする')
    actions.addIdea(null, '', '霧の町の祭り')
    const workId = actions.addBenchWork({ name: '銀河の果て', author: '山田', year: '2019' })
    actions.addBenchAnalysis(workId, { viewpoint: '構成', body: '## 構成\n三幕。', runDate: '2026-10-01' })
    actions.setBenchWorkTags(workId, ['SF', '宇宙'])
    const materialId = actions.addMaterial({ name: '現代の特殊部隊', author: '山田', tags: ['ミリタリ', '現代'] })
    actions.addMaterialNote(materialId, { section: '要約', body: '特殊部隊の編成と装備。', runDate: '2026-10-02' })
    actions.addMaterial({ name: '戦場の医療', author: '鈴木', tags: ['ミリタリ', '医療'] })
    return { titleId, chara, workId, materialId }
  })
}

/** 外観を選ぶ（アプリの設定） */
async function chooseAppearance(page: Page, value: 'white' | 'dark' | 'deep-dark'): Promise<void> {
  await openApp(page, '/settings')
  await page.getByTestId(`theme-${value}`).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', value)
}

/** 計算した値（getComputedStyle） */
function css(target: Locator, prop: string): Promise<string> {
  return target.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop)
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)'

/**
 * box-shadow が見えるか。none、または全部の影が透明な色か大きさ 0（ずらし・ぼかし・広がりがどれも 0）なら見えない。
 * 流れの中のカードは --shadow: 0 0 #0000（計算すると rgba(0, 0, 0, 0) 0px 0px 0px 0px）
 */
function shadowVisible(value: string): boolean {
  if (value === 'none') return false
  return value.split(/,(?![^(]*\))/).some((layer) => {
    const color = layer.match(/rgba?\(([^)]*)\)/)
    const parts = color ? color[1].split(/[\s,/]+/).filter(Boolean) : []
    const alpha = parts.length >= 4 ? Number(parts[3]) : 1
    const lengths = layer
      .replace(/rgba?\([^)]*\)/, '')
      .match(/-?\d+(\.\d+)?px/g)
      ?.map((v) => parseFloat(v))
    return alpha > 0 && (lengths ?? []).some((v) => v !== 0)
  })
}

async function expectNoShadow(target: Locator, label: string): Promise<void> {
  await expect(target).toBeVisible()
  const shadow = await css(target, 'box-shadow')
  expect(shadowVisible(shadow), `${label}: ${shadow}`).toBe(false)
}

/** 角の丸み（左上・右上・右下・左下） */
function radii(target: Locator): Promise<string[]> {
  return target.evaluate((e) => {
    const s = getComputedStyle(e)
    return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]
  })
}

/** 4つの角がどれも立っている */
async function expectSquare(target: Locator, label: string): Promise<void> {
  expect(await radii(target), label).toEqual(['0px', '0px', '0px', '0px'])
}

/** 左に色の線がある物: 左の2つの角は立て、右の2つは丸める */
async function expectSquareLeft(target: Locator, label: string): Promise<void> {
  await expect(target).toBeVisible()
  const [tl, tr, br, bl] = await radii(target)
  expect([tl, bl], label).toEqual(['0px', '0px'])
  expect(parseFloat(tr), label).toBeGreaterThan(0)
  expect(parseFloat(br), label).toBeGreaterThan(0)
}

/** 押せない札: 枠の線は見えず（透明）、角は 4px（var(--radius-tag)）、地の色は付ける */
async function expectFrameless(target: Locator, label: string): Promise<void> {
  await expect(target).toBeVisible()
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const style = await css(target, `border-${side}-style`)
    const color = await css(target, `border-${side}-color`)
    expect(style === 'none' || color === TRANSPARENT, `${label} ${side}: ${style} ${color}`).toBe(true)
  }
  expect(await radii(target), label).toEqual(['4px', '4px', '4px', '4px'])
  expect(await css(target, 'background-color'), label).not.toBe(TRANSPARENT)
}

/** 計算した font-family の先頭の書体（引用符を除く） */
async function firstFont(target: Locator): Promise<string> {
  const family = await css(target, 'font-family')
  return family
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
}

/** 中身が横にはみ出していない（要素の中で横にスクロールしない） */
async function noInnerOverflow(target: Locator, label: string): Promise<void> {
  const [scroll, client] = await target.evaluate((e) => [e.scrollWidth, e.clientWidth])
  expect(scroll, label).toBeLessThanOrEqual(client)
}

test.describe('見た目（Diary Studio に合わせた外観）', () => {
  test('ホームの帯の見出し: アイコンを付けず、件数は札にしない等幅の数字（Roboto Mono）。追加のボタンは枠だけ', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openApp(page)
    await seedLook(page)
    await openApp(page)

    // 帯の見出しのアイコン（本・電球・棚・開いた本）はやめた。見出しのボタンの中の絵は開け閉めの山形だけ
    await expect(page.locator('.home-pane-icon')).toHaveCount(0)
    for (const area of BANDS) {
      const toggle = homeBandToggle(page, area)
      await expect(toggle.locator('svg')).toHaveCount(1)
      await expect(toggle.locator('svg')).toHaveClass(/\bhome-band-chevron\b/)
    }

    // 件数は丸い札にせず、淡い色の数字だけ。数だけの所なので等幅の英数字
    const counts = page.locator('.home-pane-count')
    await expect(counts).toHaveCount(BANDS.length)
    await expect(page.getByTestId('title-count')).toHaveText('1')
    await expect(page.getByTestId('idea-total')).toHaveText('2')
    await expect(page.getByTestId('bench-count')).toHaveText('1')
    await expect(page.getByTestId('material-count')).toHaveText('2')
    for (let i = 0; i < BANDS.length; i++) {
      const count = counts.nth(i)
      expect(await css(count, 'background-color'), `${BANDS[i]} の件数の地`).toBe(TRANSPARENT)
      expect(await firstFont(count), `${BANDS[i]} の件数の書体`).toBe('Roboto Mono')
    }

    // 書体はアプリに同梱していて、読み込める（件数に使う 400 の太さが読み込み済み）
    expect(
      await page.evaluate(async () => {
        await document.fonts.ready
        return document.fonts.check('12px "Roboto Mono"')
      }),
    ).toBe(true)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          await document.fonts.ready
          return [...document.fonts]
            .filter((f) => f.family.replace(/["']/g, '') === 'Roboto Mono' && f.status === 'loaded')
            .map((f) => f.weight)
        }),
      )
      .toContain('400')

    // 帯の追加のボタン（新しいタイトル・作品を追加・資料を追加）は塗らずに枠だけ（閉じた帯でも出す）
    for (const id of ['new-title', 'new-bench-work', 'new-material']) {
      const button = page.getByTestId(id)
      await expect(button).toBeVisible()
      await expect(button).toHaveClass(/\bbtn\b/)
      await expect(button).not.toHaveClass(/\bbtn-primary\b/)
      expect(await css(button, 'border-top-width'), id).toBe('1px')
      // ホワイトでは白い地（色で塗った地ではない）
      expect(luminance(await css(button, 'background-color')), id).toBeGreaterThan(0.85)
    }
    // 開いても同じ
    await openHomeBands(page)
    for (const id of ['new-title', 'new-bench-work', 'new-material'])
      await expect(page.getByTestId(id)).not.toHaveClass(/\bbtn-primary\b/)
  })

  test('タイトルの画面のタブとスマホの切り替えは角を立てる', async ({ page }, info) => {
    await openApp(page)
    const { titleId } = await seedLook(page)
    await openApp(page, `/t/${titleId}`)
    const tabs = page.locator('.tpage-tabs [role="tab"]')
    await expect(tabs.first()).toBeVisible()
    const n = await tabs.count()
    expect(n).toBeGreaterThanOrEqual(5)
    for (let i = 0; i < n; i++) await expectSquare(tabs.nth(i), `タブ ${await tabs.nth(i).textContent()}`)

    if (info.project.name !== 'mobile') return
    // スマホのホームの上の切り替え（4つの領域へ移る）
    await openApp(page)
    const jump = page.locator('.home-jump-seg button')
    await expect(jump).toHaveCount(BANDS.length)
    for (let i = 0; i < BANDS.length; i++) await expectSquare(jump.nth(i), `切り替え ${BANDS[i]}`)
    await page.getByTestId('home-jump-bench').click()
    await expect(page.getByTestId('home-jump-bench')).toHaveAttribute('aria-current', 'true')
    await expectSquare(page.getByTestId('home-jump-bench'), '表示中の切り替え')
  })

  test('流れの中のカードに影を付けない。縦書きの紙の縁は線で残す（ホワイト・ダーク・ディープダーク）', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedLook(page)

    for (const appearance of ['white', 'dark', 'deep-dark'] as const) {
      await chooseAppearance(page, appearance)
      // 設定のカード（.card）
      await expectNoShadow(page.locator('.aset-card').first(), `${appearance} 設定のカード`)

      // ホームのカード（タイトル・アイデア・相対比較・資料）
      await openApp(page)
      await openHomeBands(page)
      await expectNoShadow(page.getByTestId('title-card').first(), `${appearance} タイトルのカード`)
      await expectNoShadow(page.locator('.idea-card').first(), `${appearance} アイデアのカード`)
      await expectNoShadow(page.getByTestId('bench-card').first(), `${appearance} 相対比較のカード`)
      await expectNoShadow(page.getByTestId('material-card').first(), `${appearance} 資料のカード`)

      // 通し読みの縦書きの紙は、1px の縁（影の広がりで描く）を残す
      await openApp(page, `/t/${titleId}/read`)
      const vertical = page.getByTestId('vertical-toggle')
      if ((await vertical.getAttribute('aria-pressed')) !== 'true') await vertical.click()
      await expect(vertical).toHaveAttribute('aria-pressed', 'true')
      const sheet = page.getByTestId('read-page-sheet').first()
      await expect(sheet).toBeVisible()
      await expect(sheet).toHaveClass(/\bpg-page\b/)
      const edge = await css(sheet, 'box-shadow')
      expect(shadowVisible(edge), `${appearance} 紙の縁: ${edge}`).toBe(true)
    }
  })

  test('選んだ設定項目・絞り込みのタグ・見出しの数には地を付けない', async ({ page }, info) => {
    await openApp(page)
    const { titleId, chara } = await seedLook(page)

    // タイトルの設定タブの項目（キャラクター 2件）
    await openApp(page, `/t/${titleId}?tab=settings&cat=${chara}`)
    const selected = page.locator('.st-cat.is-selected')
    await expect(selected).toHaveCount(1)
    await expect(selected).toHaveAttribute('aria-current', 'true')
    const count = selected.locator('.st-cat-count')
    await expect(count).toHaveText('2')
    expect(await css(count, 'background-color'), '選んだ項目の数').toBe(TRANSPARENT)
    expect(await firstFont(count)).toBe('Roboto Mono')
    const others = page.locator('.st-cat:not(.is-selected) .st-cat-count')
    for (let i = 0; i < (await others.count()); i++)
      expect(await css(others.nth(i), 'background-color'), `選んでいない項目の数 ${i}`).toBe(TRANSPARENT)
    // 広い画面の縦の一覧では、選んだ項目の左に色の線（内側の影）を引くので、左の角を立てる
    if (info.project.name === 'desktop') await expectSquareLeft(selected, '選んだ設定項目')
    // 項目の見出しのエントリの数も札にせず、淡い色の等幅の数字だけ（「件」は読み上げだけ）
    const entryCount = page.getByTestId('category-entry-count')
    await expect(entryCount).toHaveText('2件')
    await expect(entryCount.locator('.visually-hidden')).toHaveText('件')
    expect(await css(entryCount, 'background-color'), '項目の見出しの数').toBe(TRANSPARENT)
    expect(await firstFont(entryCount)).toBe('Roboto Mono')

    // ホームの資料・相対比較の棚のタグで絞り込む
    await openApp(page)
    await openHomeBands(page, 'bench', 'materials')
    // 数の後ろの単位（「件」「作品」）は読み上げだけ
    for (const [prefix, tag, n] of [
      ['material', 'ミリタリ', '2件'],
      ['bench', 'SF', '1作品'],
    ] as const) {
      const chip = page.locator(`[data-testid="${prefix}-tag-chip"][data-tag="${tag}"]`)
      await expect(chip.locator('.home-mat-tag-count')).toHaveText(n)
      await chip.click()
      await expect(chip).toHaveAttribute('aria-pressed', 'true')
      await expect(chip).toHaveClass(/\bis-on\b/)
      const on = chip.locator('.home-mat-tag-count')
      expect(await css(on, 'background-color'), `${prefix} の選んだタグの数`).toBe(TRANSPARENT)
      expect(await firstFont(on)).toBe('Roboto Mono')
    }
    await expect(page.locator('.home-mat-tag.is-on .home-mat-tag-count')).toHaveCount(2)

    // 本編タブの「メモ」の見出しの数（メモはまだ無いので 0）
    await openApp(page, `/t/${titleId}`)
    const memoCount = page.getByTestId('memo-count')
    await expect(memoCount).toHaveText('0件')
    expect(await css(memoCount, 'background-color'), 'メモの見出しの数').toBe(TRANSPARENT)
    expect(await firstFont(memoCount)).toBe('Roboto Mono')
    // 見出しの前のアイコン（付箋）はやめた
    await expect(page.getByTestId('memo-section').locator('.section-head > svg')).toHaveCount(0)
  })

  test('色の線（左 3px）がある本編の幕の行は、左の角を立てる', async ({ page }) => {
    await openApp(page)
    const titleId = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('幕のある作品')
      const pieceId = actions.addEpisode(id)
      actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: '一幕目の本文。二幕目の本文。' })
      actions.separatePiece(pieceId, [7])
      return id
    })
    await openApp(page, `/t/${titleId}`)
    const acts = page.getByTestId('act-row')
    await expect(acts).toHaveCount(2)
    for (let i = 0; i < 2; i++) await expectSquareLeft(acts.nth(i), `幕の行 ${i + 1}`)
    await expectSquareLeft(page.getByTestId('piece-row').first(), '話の行')
  })

  test('押せないタグ（資料・相対比較の画面）は枠を付けない淡い札', async ({ page }) => {
    await openApp(page)
    const { workId, materialId } = await seedLook(page)
    await openApp(page, `/materials/${materialId}`)
    const tags = page.getByTestId('material-tag')
    await expect(tags).toHaveCount(2)
    for (let i = 0; i < 2; i++) {
      await expect(tags.nth(i)).toHaveClass(/\bmt-tag-chip\b/)
      await expect(tags.nth(i)).toHaveClass(/\bis-static\b/)
      await expectFrameless(tags.nth(i), `資料のタグ ${i + 1}`)
    }
    await openApp(page, `/bench/${workId}`)
    const benchTags = page.getByTestId('bench-work-tag')
    await expect(benchTags).toHaveCount(2)
    for (let i = 0; i < 2; i++) await expectFrameless(benchTags.nth(i), `相対比較のタグ ${i + 1}`)
  })

  test('タイトルの画面の集計の札は枠を付けず、押せる「Claude に見せる」だけ 1px の枠', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedLook(page)
    await openApp(page, `/t/${titleId}`)
    await expect(page.getByTestId('stat-episodes')).toContainText('全2話')

    const chips = page.locator('.tpage-chip:not(.cl-access-chip)')
    const n = await chips.count()
    expect(n).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < n; i++) {
      const chip = chips.nth(i)
      const label = `集計の札 ${await chip.textContent()}`
      expect(await css(chip, 'border-top-style'), label).toBe('none')
      expect(await css(chip, 'border-top-width'), label).toBe('0px')
      expect(await css(chip, 'border-left-width'), label).toBe('0px')
    }

    const access = page.getByTestId('claude-access-chip')
    await expect(access).toBeVisible()
    await expect(access).toHaveClass(/\btpage-chip\b/)
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(await css(access, `border-${side}-style`), `Claude に見せる ${side}`).toBe('solid')
      expect(await css(access, `border-${side}-width`), `Claude に見せる ${side}`).toBe('1px')
    }
  })

  test('スマホ: 端の余白は 16px。360px の幅でもホーム・タイトル・相対比較・資料・設定が横にはみ出さない', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの幅で確かめる')
    await openApp(page)
    const { titleId, workId, materialId } = await seedLook(page)

    /** ホームの最初の帯の見出しの左右の余白 */
    const gutters = async () => {
      const head = page.getByTestId('home-band-head').first()
      await expect(head).toBeVisible()
      const box = (await head.boundingBox())!
      const width = await page.evaluate(() => document.documentElement.clientWidth)
      return { left: Math.round(box.x), right: Math.round(width - (box.x + box.width)) }
    }

    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 760 })
      await openApp(page)
      expect(await gutters(), `${width}px 閉じた帯`).toEqual({ left: 16, right: 16 })
      await openHomeBands(page)
      expect(await gutters(), `${width}px 開いた帯`).toEqual({ left: 16, right: 16 })
    }

    // 360px（ホームは4つの帯を開いたまま）
    await noHorizontalScroll(page)
    for (const hash of [
      `/t/${titleId}`,
      `/t/${titleId}?tab=settings`,
      `/bench/${workId}`,
      `/materials/${materialId}`,
      '/settings',
    ]) {
      await openApp(page, hash)
      await expect(page.locator('main').first()).toBeVisible()
      await noHorizontalScroll(page)
    }

    // 通し読み: 横書きの本文とツールバーの左右の余白も 16px。縦書きのページ表示にしても横にはみ出さない
    await openApp(page, `/t/${titleId}/read`)
    await expect(page.getByTestId('vertical-toggle')).toBeVisible()
    for (const selector of ['.rt-toolbar-inner', '.rt-main']) {
      const target = page.locator(selector).first()
      expect(await css(target, 'padding-left'), `${selector} の左`).toBe('16px')
      expect(await css(target, 'padding-right'), `${selector} の右`).toBe('16px')
    }
    await noHorizontalScroll(page)
    const vertical = page.getByTestId('vertical-toggle')
    if ((await vertical.getAttribute('aria-pressed')) !== 'true') await vertical.click()
    await expect(vertical).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('read-page-sheet').first()).toBeVisible()
    await noHorizontalScroll(page)
  })

  test('設定の「書体のライセンス」: Web 版にも出し、「全文を見る」でライセンスの全文を読める（スマホでもはみ出さない）', async ({
    page,
  }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page, '/settings')
    const card = page.getByTestId('font-license')
    await expect(card.getByRole('heading', { name: '書体のライセンス' })).toBeVisible()
    await expect(card.getByTestId('font-credit')).toHaveText(
      'Roboto Mono — Copyright 2015 The Roboto Mono Project Authors（SIL Open Font License 1.1）',
    )
    // Web 版では「ホーム画面に追加」の後、「危険な操作」の前
    const follows = (a: string, b: string) =>
      page.evaluate(
        ([x, y]) => {
          const ex = document.querySelector(`[data-testid="${x}"]`)
          const ey = document.querySelector(`[data-testid="${y}"]`)
          return Boolean(ex && ey && ex.compareDocumentPosition(ey) & Node.DOCUMENT_POSITION_FOLLOWING)
        },
        [a, b],
      )
    expect(await follows('install-help', 'font-license')).toBe(true)
    expect(await follows('font-license', 'danger-zone')).toBe(true)
    await noHorizontalScroll(page)

    await card.getByTestId('font-license-open').click()
    const dialog = page.getByRole('dialog', { name: 'Roboto Mono のライセンス' })
    await expect(dialog).toBeVisible()
    const text = dialog.getByTestId('font-license-text')
    await expect(text).toContainText('SIL OPEN FONT LICENSE Version 1.1')
    await expect(text).toContainText('Copyright 2015 The Roboto Mono Project Authors')
    // ダイアログは浮いている物なので影を残す
    const shadow = await css(page.locator('.modal'), 'box-shadow')
    expect(shadowVisible(shadow), `ダイアログの影: ${shadow}`).toBe(true)
    // 全文（長い URL の行もある）は折り返し、ページもダイアログも横にはみ出さない
    await noHorizontalScroll(page)
    await noInnerOverflow(dialog.locator('.modal-body'), 'ダイアログの中身')
    await noInnerOverflow(text, 'ライセンスの全文')
    const box = (await dialog.boundingBox())!
    const width = await page.evaluate(() => document.documentElement.clientWidth)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5)

    await dialog.getByTestId('font-license-close').click()
    await expect(dialog).toHaveCount(0)
    await expect(card).toBeVisible()
  })
})
