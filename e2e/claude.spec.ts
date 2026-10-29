// 2.3 の Claude 連携の E2E テスト: 改稿案・推敲案（貼り付け・フラグ・チェック・本文の箇所へ）・作品批評・手動連携のコピー・
// タイトルの「Claude に見せる」・設定の Claude 連携・連携の画面（仮のコネクタ。ページの通信を横取りして答える）・
// 360px の画面・ディープダーク。連携の記録を書くところまでは、エミュレーターを使う e2e/claude.sync.spec.ts で確かめる。
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { darkSurfaces, noHorizontalScroll, openApp, seed, seedTitleWithEpisodes, tapSize } from './helpers'

const fence = (v: unknown) => '```novel-studio-v1\n' + JSON.stringify(v) + '\n```'

const proofAnswer = fence({
  tool: 'novel_add_proofreading',
  input: {
    title_id: 't:ignored',
    run_label: 'ワードサーチ（第1〜2話）',
    covered: ['#1', '#2'],
    items: [
      { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き言葉' },
      { piece: '#2', excerpt: 'ありきたりな夕焼け', category: 'cliche', reason: '既成表現' },
      { piece: '#2', excerpt: '来れる', category: 'ra_nuki', suggestion: '来られる', reason: 'ら抜き言葉', important: true },
    ],
  },
})

async function seedNovel(page: Page) {
  return seedTitleWithEpisodes(page, '星の海の図書館', [
    '最初の段落。\n\n窓から見れる景色は、いつもと同じだった。',
    'ありきたりな夕焼けだった。明日も来れる。',
  ])
}

/** 「結果を貼り付け」で Claude の答えを貼り、追加する */
async function pasteAnswer(page: Page, opener: string, text: string, expectCreated: number) {
  await page.getByTestId(opener).click()
  const dialog = page.getByTestId('paste-dialog')
  await dialog.getByTestId('paste-input').fill(text)
  await expect(page.getByTestId('paste-add')).toHaveText(`追加（${expectCreated}件）`)
  await page.getByTestId('paste-add').click()
  await expect(dialog).toHaveCount(0)
}

test.describe('Claude 連携（2.3）', () => {
  test('改稿案: 書いてチェックすると斜線で下へ沈み、外すと戻る', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedNovel(page)
    await openApp(page, `/t/${titleId}?tab=strategy`)
    for (const heading of ['冒頭の場面を削る', '終盤の伏線を回収する']) {
      await page.getByTestId('add-revision-idea').click()
      await expect(page.getByTestId('revision-heading-input').last()).toBeFocused()
      await page.keyboard.type(heading)
      await page.getByTestId('revision-body-input').last().fill(`${heading}理由。\n`.repeat(30))
      await page.getByTestId('revision-toggle').last().click()
    }
    const headings = page.getByTestId('revision-heading')
    await expect(headings).toHaveText(['冒頭の場面を削る', '終盤の伏線を回収する'])
    await page.getByTestId('revision-check').first().check()
    await expect(headings).toHaveText(['終盤の伏線を回収する', '冒頭の場面を削る'])
    const sunk = page.getByTestId('revision-idea').last()
    await expect(sunk).toHaveAttribute('data-checked', 'true')
    expect(await sunk.getByTestId('revision-heading').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe(
      'line-through',
    )
    await sunk.getByTestId('revision-check').uncheck()
    await expect(page.getByTestId('revision-idea').last()).toHaveAttribute('data-checked', 'false')
    // 再読み込みしても残る
    await page.reload()
    await expect(page.getByTestId('revision-heading')).toHaveText(['終盤の伏線を回収する', '冒頭の場面を削る'])
  })

  test('推敲案: 貼り付け → フラグが一番上・チェックで下へ・押すと本文の箇所を選ぶ。2回貼り付けても増えない', async ({
    page,
    isMobile,
  }) => {
    await openApp(page)
    const { titleId, pieceIds } = await seedNovel(page)
    await openApp(page, `/t/${titleId}?tab=strategy`)
    await pasteAnswer(page, 'proof-claude-paste', `推敲案を3つ挙げます。\n\n${proofAnswer}`, 3)
    const items = page.getByTestId('proof-item')
    await expect(items).toHaveCount(3)
    // important は最初からフラグ付きで一番上
    await expect(items.first()).toContainText('来れる')
    await expect(items.first()).toHaveAttribute('data-flagged', 'true')
    await expect(page.getByTestId('proof-runs')).toContainText('ワードサーチ（第1〜2話） 3件')
    await expect(page.getByTestId('proof-coverage')).toContainText('すべて確認済み')

    // 夕焼けにフラグ → 2つのフラグの中で新しい順（同じ追加なので並びは保つ）。外すと戻る
    const sunset = items.filter({ hasText: 'ありきたりな夕焼け' })
    await sunset.getByTestId('proof-flag').click()
    await expect(sunset).toHaveAttribute('data-flagged', 'true')
    await sunset.getByTestId('proof-flag').click()
    await expect(sunset).toHaveAttribute('data-flagged', 'false')

    // チェックすると下へ沈む
    await items.first().getByTestId('proof-check').check()
    await expect(items.last()).toContainText('来れる')
    await expect(items.last()).toHaveAttribute('data-done', 'true')

    // もう一度同じ答えを貼り付けても増えない
    await page.getByTestId('proof-claude-paste').click()
    await page.getByTestId('paste-input').fill(proofAnswer)
    await expect(page.getByTestId('paste-item').first()).toHaveAttribute('data-status', 'duplicate')
    await expect(page.getByTestId('paste-add')).toBeDisabled()
    await page.getByTestId('modal-close').click()

    // 押すと話を開き、抜き出した箇所を選ぶ
    const mieru = items.filter({ hasText: '見れる' })
    await expect(mieru.getByTestId('proof-location')).toHaveText('第1話 ¶2')
    await mieru.getByTestId('proof-jump').click()
    await expect(page).toHaveURL(new RegExp(`#/t/${titleId}/p/${pieceIds[0]}$`))
    const editor = page.getByTestId('active-editor')
    await expect
      .poll(() => editor.evaluate((e: HTMLTextAreaElement) => e.value.slice(e.selectionStart, e.selectionEnd)))
      .toBe('見れる')
    if (isMobile) await expect(page.getByTestId('proof-panel')).toHaveCount(0)
    else await expect(page.getByTestId('proof-panel')).toBeVisible()
    await expect(page.getByTestId('proof-chip-count')).toHaveText('1')

    // 本文を直すと「本文が変わりました」
    await seed(
      page,
      ({ actions, getData }, id) => actions.updateVersion(getData().pieces[id].versionIds[0], { body: '窓から見られる景色。' }),
      pieceIds[0],
    )
    await openApp(page, `/t/${titleId}?tab=strategy`)
    await expect(page.getByTestId('proof-item').filter({ hasText: '見れる' }).getByTestId('proof-location')).toContainText(
      '本文が変わりました（直した可能性）',
    )

    // チェック済みを削除（1件のゴミ箱の件）
    await page.getByTestId('proof-delete-checked').click()
    await page.getByRole('dialog').getByRole('button', { name: '削除' }).click()
    await expect(page.getByTestId('proof-item')).toHaveCount(2)
    await openApp(page, '/trash')
    await expect(page.getByTestId('trash-kind').first()).toHaveText('推敲案')
  })

  test('作品批評: プロンプトを書いて Claude 用にコピーし、Markdown と URL を貼り付けると日付ごとに残る', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'クリップボードの読み取りは Chromium だけ')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openApp(page)
    const { titleId } = await seedNovel(page)
    await openApp(page, `/t/${titleId}?tab=critique`)
    await expect(page.getByTestId('tab-critique')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('add-title-prompt').click()
    await expect(page.getByTestId('prompt-name-input')).toBeFocused()
    await page.keyboard.type('全体の構成')
    await page.getByTestId('prompt-body-input').fill('構成・人物・文章の3つの観点で批評してください。')
    await page.getByTestId('prompt-toggle').click()
    await page.getByTestId('prompt-copy').click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('構成・人物・文章の3つの観点で批評してください。')

    await page.getByTestId('critique-paste').click()
    await page
      .getByTestId('paste-input')
      .fill('## 総評\n人物の弧がはっきりしています。\n\n<script>window.__bad = 1</script>\n\n[参考](https://example.com/ref)')
    await page.getByTestId('paste-url').fill('https://claude.ai/public/artifacts/abc')
    await expect(page.getByTestId('paste-add')).toHaveText('追加（1件）')
    await page.getByTestId('paste-add').click()
    const result = page.getByTestId('critique-result')
    await expect(result.getByTestId('critique-result-title')).toHaveText('全体の構成')
    await expect(result.getByTestId('critique-result-body').locator('h2')).toHaveText('総評')
    await expect(result.getByTestId('critique-result-body').locator('a')).toHaveAttribute('rel', 'noopener noreferrer')
    expect(await page.evaluate(() => (window as unknown as { __bad?: number }).__bad)).toBeUndefined()
    await expect(result.getByTestId('critique-result-url')).toHaveValue('https://claude.ai/public/artifacts/abc')
    await expect(result.getByTestId('critique-result-manuscript')).toContainText('2話の時点（現在と同じ）')
    await expect(page.getByTestId('critique-day')).toHaveCount(1)

    // URL は https だけ
    await result.getByTestId('critique-result-url').fill('http://example.com')
    await result.getByTestId('critique-result-url').press('Enter')
    await expect(result).toContainText('https:// で始まる URL')
  })

  test('Claude に頼む（手動）: 依頼文と本文を 50,000 字以内のパートに分けてコピーし、.txt で保存できる', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'クリップボードの読み取りは Chromium だけ')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '長い作品', [
      'あ'.repeat(30_000),
      'い'.repeat(30_000),
      'う'.repeat(30_000),
    ])
    await openApp(page, `/t/${titleId}?tab=strategy`)
    await page.getByTestId('proof-claude-manual').click()
    const dialog = page.getByTestId('manual-dialog')
    await expect(dialog.getByTestId('manual-task-proofreading')).toHaveAttribute('aria-pressed', 'true')
    const parts = dialog.getByTestId('manual-copy-part')
    const count = await parts.count()
    expect(count).toBeGreaterThanOrEqual(2)
    await expect(parts.first()).toContainText(`パート 1/${count} をコピー`)
    await parts.nth(1).click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied.startsWith(`【Novel Studio パート 2/${count}】`)).toBe(true)
    expect(copied.length).toBeLessThanOrEqual(50_000)
    await expect(parts.nth(1)).toHaveClass(/is-copied/)

    // ファイル名はリンクの download 属性で確かめる（ヘッドレスのブラウザは日本語のファイル名を渡さないことがある）
    await page.evaluate(() => {
      const w = window as unknown as { __downloadNames?: string[] }
      w.__downloadNames = []
      const original = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.download) w.__downloadNames!.push(this.download)
        return original.call(this)
      }
    })
    const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByTestId('manual-save-txt').click()])
    const name = await page.evaluate(() => (window as unknown as { __downloadNames: string[] }).__downloadNames.at(-1) ?? '')
    expect(name).toMatch(/^\d{8}長い作品_ワードサーチの依頼\.txt$/)
    const text = readFileSync((await file.path())!, 'utf8')
    expect(text.startsWith('【Novel Studio パート 1/1】')).toBe(true)
    expect(text).toContain('あ'.repeat(30_000))
    expect(text).toContain('う'.repeat(30_000))

    // 「結果を貼り付け」へ進める
    await page.getByTestId('manual-open-paste').click()
    await expect(page.getByTestId('paste-dialog')).toBeVisible()
  })

  test('タイトルの「Claude に見せる」と、設定の Claude 連携（コネクタの URL）', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedNovel(page)
    await openApp(page, `/t/${titleId}`)
    const chip = page.getByTestId('claude-access-chip')
    await expect(chip).toContainText('読む＋書き込む')
    await chip.click()
    await page.getByTestId('claude-access-none').click()
    await expect(chip).toContainText('見せない')
    expect(await page.evaluate((id) => window.__ns.getData().titles[id].claudeAccess, titleId)).toBe('none')

    await openApp(page, '/settings')
    const origin = await page.evaluate(() => window.__ns.connectorOrigin)
    await expect(page.getByTestId('claude-connector-url')).toHaveText(`${origin}/mcp`)
    await expect(page.getByTestId('claude-pairing-signin')).toBeVisible()
  })

  test('連携の画面: ログインしていなければログインを促し、コネクタには問い合わせない（URL の uid・origin は使わない）', async ({
    page,
  }) => {
    await openApp(page)
    const origin = await page.evaluate(() => window.__ns.connectorOrigin)
    const requests: string[] = []
    await page.route(`${origin}/**`, async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 500, body: '{}' })
    })
    await page.route('https://evil.example/**', async (route) => {
      requests.push(route.request().url())
      await route.abort()
    })
    await openApp(page, '/claude/connect?s=e2e-state&uid=attacker&origin=https://evil.example')
    await expect(page.getByTestId('connect-host')).toHaveText(`コネクタ: ${new URL(origin).host}`)
    await expect(page.getByTestId('connect-signin')).toBeVisible()
    await expect(page.getByTestId('connect-signin-button')).toBeVisible()
    await noHorizontalScroll(page)
    expect(requests).toEqual([])

    await openApp(page, '/claude/connect')
    await expect(page.getByTestId('connect-no-state')).toBeVisible()
  })

  test('360px の画面: 戦略・作品批評・連携の画面が横にはみ出さず、押す所は 34px 以上', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 })
    await openApp(page)
    const { titleId, pieceIds } = await seedNovel(page)
    await page.evaluate(([t, a]) => window.__ns.pasteClaude(t, a), [titleId, proofAnswer] as const)
    await seed(
      page,
      ({ actions }, a) => {
        actions.addRevisionIdea(a.t, {
          heading: '改稿案の見出しがとても長い場合にも折り返して表示されることを確かめる',
          body: '本文',
          pieceIds: [a.p],
        })
        actions.addCritiquePrompt(a.t, { name: '全体', body: '批評してください' })
      },
      { t: titleId, p: pieceIds[0] },
    )
    // タイトル画面の「Claude に見せる」
    await openApp(page, `/t/${titleId}`)
    await tapSize(page.getByTestId('claude-access-chip'), 'claude-access-chip', false)
    await openApp(page, `/t/${titleId}?tab=strategy`)
    await expect(page.getByTestId('proof-item')).toHaveCount(3)
    await noHorizontalScroll(page)
    for (const id of ['proof-check', 'proof-flag', 'proof-more-button', 'revision-check', 'revision-up']) {
      const target = id.endsWith('check') ? page.getByTestId(id).first().locator('xpath=..') : page.getByTestId(id).first()
      const box = await target.boundingBox()
      expect(box?.height, id).toBeGreaterThanOrEqual(34)
      expect(box?.width, id).toBeGreaterThanOrEqual(34)
    }
    // 改稿案の関係する話のチップと「外す」
    await tapSize(page.getByTestId('revision-piece-chip').first(), 'revision-piece-chip', false)
    await page.getByTestId('revision-toggle').first().click()
    await tapSize(page.getByTestId('revision-piece-chip').first(), 'revision-piece-chip（編集中）', false)
    await tapSize(page.getByTestId('revision-piece-remove').first(), 'revision-piece-remove')
    await noHorizontalScroll(page)
    await page.getByTestId('proof-claude-manual').click()
    await noHorizontalScroll(page)
    await page.getByTestId('manual-close').click()
    await openApp(page, `/t/${titleId}?tab=critique`)
    await expect(page.getByTestId('critique-prompt')).toHaveCount(1)
    await noHorizontalScroll(page)
    await openApp(page, '/claude/connect?s=abc')
    await noHorizontalScroll(page)
    await openApp(page, '/settings')
    await noHorizontalScroll(page)
  })

  test('ディープダーク: 2.3 の画面に白い面が出ない（スクリーンショット）', async ({ page }, testInfo) => {
    await openApp(page, '/settings')
    await page.getByTestId('theme-deep-dark').click()
    const { titleId, pieceIds } = await seedNovel(page)
    await page.evaluate(([t, a]) => window.__ns.pasteClaude(t, a), [titleId, proofAnswer] as const)
    await page.evaluate(
      ([t]) =>
        window.__ns.pasteClaude(
          t,
          '```novel-studio-v1\n' +
            JSON.stringify([
              {
                tool: 'novel_add_strategy_note',
                input: {
                  title_id: t,
                  heading: '新人賞を軸に',
                  body: '## 狙い\n長編の新人賞。',
                  contests: [{ name: '星海小説大賞', deadline: '2027-03-31', fit: '相性が良い' }],
                },
              },
              { tool: 'novel_save_critique_prompt', input: { scope: 'shared', name: '全体', body: '批評して' } },
              {
                tool: 'novel_add_critique_result',
                input: { title_id: t, result_markdown: '## 総評\n良い。\n\n> 引用\n\n`code`' },
              },
            ]) +
            '\n```',
        ),
      [titleId] as const,
    )
    await seed(page, ({ actions }, t) => void actions.addRevisionIdea(t, { heading: '改稿案', body: '本文' }), titleId)
    const project = testInfo.project.name
    const dir = 'e2e/artifacts/screens'
    const surfaces = (selectors: string[]) => darkSurfaces(page, selectors)
    await openApp(page, `/t/${titleId}?tab=strategy`)
    await expect(page.getByTestId('proof-item')).toHaveCount(3)
    await surfaces([
      '.sx-card',
      '.ps-list',
      '.ps-item',
      '.sn-contest',
      '.ps-runs',
      '.badge',
      '.btn',
      '.sx-jump',
      '.tabs [role="tab"]',
    ])
    await page.screenshot({ path: `${dir}/claude-${project}-deep-dark-strategy.png`, fullPage: true })
    await openApp(page, `/t/${titleId}?tab=critique`)
    await expect(page.getByTestId('critique-result')).toHaveCount(1)
    await surfaces(['.cq-intro', '.sx-card', '.cq-snapshot', '.md code', '.input', '.textarea', '.badge'])
    await page.screenshot({ path: `${dir}/claude-${project}-deep-dark-critique.png`, fullPage: true })
    await page.getByTestId('critique-manual').click()
    await surfaces(['.modal', '.modal-foot', '.segmented', '.select', '.btn'])
    await page.screenshot({ path: `${dir}/claude-${project}-deep-dark-manual.png` })
    await page.getByTestId('manual-close').click()
    await openApp(page, `/t/${titleId}/p/${pieceIds[0]}`)
    await page.getByTestId('proof-chip').click()
    await surfaces(['.pw-proof-panel', '.pw-proof-btn'])
    await page.screenshot({ path: `${dir}/claude-${project}-deep-dark-editor.png` })
    await openApp(page, '/claude/connect?s=abc')
    await surfaces(['.cn-block', '.btn'])
    await page.screenshot({ path: `${dir}/claude-${project}-deep-dark-connect.png` })
  })
})
