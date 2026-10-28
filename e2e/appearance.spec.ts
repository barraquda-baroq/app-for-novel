// 外観（ホワイト／ダーク／ディープダーク）と原稿の書体の E2E テスト
import { expect, test, type Page } from '@playwright/test'
import { openApp, seedTitleWithEpisodes } from './helpers'

const PREFS_KEY = 'novel-studio:prefs'

function themeColor(page: Page) {
  return page.locator('meta[name="theme-color"]')
}

async function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

/** 'rgb(r, g, b)' の相対輝度（0 = 黒 〜 1 = 白） */
function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

async function chooseAppearance(page: Page, value: 'system' | 'white' | 'dark' | 'deep-dark') {
  await openApp(page, '/settings')
  await page.getByTestId(`theme-${value}`).click()
  await expect(page.getByTestId(`theme-${value}`)).toHaveAttribute('aria-pressed', 'true')
}

test.describe('外観', () => {
  test('外観を切り替えると data-theme とブラウザの枠の色が変わり、再読み込みしても最初から反映される', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openApp(page, '/settings')
    const html = page.locator('html')

    // 既定は「端末の設定に合わせる」。端末の切り替えにもその場で追従する
    await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveAttribute('data-theme', 'white')
    await expect(themeColor(page)).toHaveAttribute('content', '#ffffff')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await expect(themeColor(page)).toHaveAttribute('content', '#17181b')

    // 選んだ外観は端末の設定によらない
    await page.getByTestId('theme-white').click()
    await expect(html).toHaveAttribute('data-theme', 'white')
    expect(luminance(await bodyBackground(page))).toBeGreaterThan(0.85)
    await page.getByTestId('theme-dark').click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await expect(themeColor(page)).toHaveAttribute('content', '#17181b')
    expect(luminance(await bodyBackground(page))).toBeLessThan(0.01)
    await page.getByTestId('theme-deep-dark').click()
    await expect(html).toHaveAttribute('data-theme', 'deep-dark')
    await expect(themeColor(page)).toHaveAttribute('content', '#0e0f11')
    expect(luminance(await bodyBackground(page))).toBeLessThan(0.005)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html).toHaveAttribute('data-theme', 'deep-dark')

    await page.reload()
    await page.waitForFunction(() => Boolean(window.__ns))
    await expect(page.getByTestId('theme-deep-dark')).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveAttribute('data-theme', 'deep-dark')

    // アプリの JS が動く前（index.html のスクリプト）に外観が決まっていて、白い画面が一瞬出ない
    await page.route('**/src/main.tsx', (route) => route.abort())
    await page.reload()
    await expect(html).toHaveAttribute('data-theme', 'deep-dark')
    await expect(themeColor(page)).toHaveAttribute('content', '#0e0f11')
  })

  test('1.x の設定（ライト・ダーク・明朝）を引き継ぐ', async ({ page }) => {
    await openApp(page, '/settings')
    const html = page.locator('html')
    const legacy = async (prefs: Record<string, unknown>) => {
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [PREFS_KEY, JSON.stringify(prefs)])
      await page.reload()
      await page.waitForFunction(() => Boolean(window.__ns))
    }

    await legacy({ theme: 'light', editorFont: 'mincho', editorFontSize: 20, showDiff: true })
    await expect(html).toHaveAttribute('data-theme', 'white')
    await expect(page.getByTestId('theme-white')).toHaveAttribute('aria-pressed', 'true')
    // 書体は新しい既定（ゴシック）。ほかの設定は残る
    await expect(page.getByTestId('font-gothic')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('font-size-value')).toHaveText('20px')
    await expect(page.getByTestId('diff-switch').getByRole('switch')).toBeChecked()

    await legacy({ theme: 'dark', editorFont: 'gothic' })
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')

    // 明朝を選び直すと、次の起動でも明朝のまま
    await page.getByTestId('font-mincho').click()
    await page.reload()
    await page.waitForFunction(() => Boolean(window.__ns))
    await expect(page.getByTestId('font-mincho')).toHaveAttribute('aria-pressed', 'true')
    const editorFont = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--editor-font'))
    expect(editorFont).toContain('Mincho')
  })

  test('タイトル画面のタブは領域ごとに色分けし、ディープダークではほぼ黒にする', async ({ page }) => {
    await openApp(page)
    const { titleId } = await seedTitleWithEpisodes(page, '色分けの確認', ['本文'])
    const tabs = ['story', 'settings', 'strategy', 'ideas'] as const

    const selectedTabColors = async () => {
      const out: { background: string; underline: string }[] = []
      for (const tab of tabs) {
        await openApp(page, `/t/${titleId}${tab === 'story' ? '' : `?tab=${tab}`}`)
        const el = page.getByTestId(`tab-${tab}`)
        await expect(el).toHaveAttribute('aria-selected', 'true')
        out.push(
          await el.evaluate((e) => {
            const s = getComputedStyle(e)
            return { background: s.backgroundColor, underline: s.borderBottomColor }
          }),
        )
      }
      return out
    }

    for (const appearance of ['white', 'dark'] as const) {
      await chooseAppearance(page, appearance)
      const colors = await selectedTabColors()
      // 領域ごとに違う色
      expect(new Set(colors.map((c) => c.underline)).size).toBe(tabs.length)
      expect(new Set(colors.map((c) => c.background)).size).toBe(tabs.length)
    }

    await chooseAppearance(page, 'deep-dark')
    for (const c of await selectedTabColors()) {
      expect(luminance(c.background)).toBeLessThan(0.02)
      expect(luminance(c.underline)).toBeLessThan(0.1)
    }
  })
})
