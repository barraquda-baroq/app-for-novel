// 起動アニメーション（src/launch/launch.js。index.html に埋め込み、アプリの本体より先に動く）の E2E テスト。
// テスト（navigator.webdriver）ではふだん出さないので、URL の launch=1（または localStorage の novel-studio:launch = 'force'）で出す
import { expect, test, type Page } from '@playwright/test'
import { noHorizontalScroll } from './helpers'

const PREFS_KEY = 'novel-studio:prefs'
const overlay = (page: Page) => page.getByTestId('launch-overlay')

/** 重なりが消え始めた理由（'done' | 'skip' | 'cap'）を控える（消え始めて 0.25 秒で取り除かれるので、属性を後から読めないことがある） */
async function recordLaunchEnd(page: Page) {
  await page.addInitScript(() => {
    new MutationObserver((records) => {
      for (const r of records) {
        const reason = (r.target as Element).getAttribute('data-launch-end')
        if (reason) (window as unknown as { __launchEnd: string }).__launchEnd = reason
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-launch-end'] })
  })
}
const launchEnd = (page: Page) => page.evaluate(() => (window as unknown as { __launchEnd?: string }).__launchEnd ?? null)

/** 外観を決めてから開く（localStorage はページを開く前に入れる） */
async function withPrefs(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [PREFS_KEY, JSON.stringify(prefs)])
}

test.describe('起動アニメーション', () => {
  test('強制すると最初に出て、アニメーションが終わりアプリの画面ができたら消えて取り除かれる', async ({ page }) => {
    await recordLaunchEnd(page)
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    const el = overlay(page)
    // 最初の描画の前から画面いっぱいに出ている（読み上げない・押せるものを置かない）
    await expect(el).toBeVisible()
    await expect(el).toHaveAttribute('aria-hidden', 'true')
    await expect(el.locator('canvas')).toHaveCount(1)
    await expect(el.locator('a, button, input, textarea, select, [tabindex]')).toHaveCount(0)
    const box = await el.boundingBox()
    const viewport = page.viewportSize()!
    expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height })
    // アプリはその下で起動している
    await expect(page.getByRole('link', { name: 'アプリの設定・バックアップ' })).toBeAttached({ timeout: 10_000 })

    await expect(el).toHaveCount(0, { timeout: 6000 })
    expect(await launchEnd(page)).toBe('done')
    expect(
      await page.evaluate(() => (window as unknown as { NovelStudioLaunch: { active(): boolean } }).NovelStudioLaunch.active()),
    ).toBe(false)
    // 消えた後はアプリをそのまま操作できる
    await page.getByRole('link', { name: 'アプリの設定・バックアップ' }).click()
    await expect(page.getByTestId('display-settings')).toBeVisible()
  })

  test('押すとすぐ消える（下の画面は押されない）', async ({ page }) => {
    await recordLaunchEnd(page)
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    const el = overlay(page)
    await expect(el).toBeVisible()
    await page.waitForTimeout(300)
    const start = Date.now()
    // 右上（設定のボタンのある所）を押しても、押したのは重なり
    await page.mouse.click(page.viewportSize()!.width - 24, 24)
    await expect(el).toHaveCount(0)
    expect(Date.now() - start).toBeLessThan(1500)
    expect(await launchEnd(page)).toBe('skip')
    await expect(page.getByRole('link', { name: 'アプリの設定・バックアップ' })).toBeVisible()
    await expect(page).toHaveURL(/#\/$/)
  })

  test('指で押しても（タップ・押したまま）すぐ消え、下の画面は押されない', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '指で押せる（hasTouch）スマホだけ')
    await recordLaunchEnd(page)
    const settings = page.getByRole('link', { name: 'アプリの設定・バックアップ' })
    /** 重なりを出し、その下に設定のボタンができて 0.4 秒たつまで待つ（ボタンの真ん中を返す） */
    let opened = 0
    async function open() {
      await page.evaluate(() => sessionStorage.clear())
      // 同じ URL（# だけ違う）だと読み込み直さないので、毎回 URL を変える
      await page.goto(`/?launch=1&n=${++opened}#/`, { waitUntil: 'commit' })
      await expect(overlay(page)).toBeVisible()
      const shown = Date.now()
      await expect(settings).toBeAttached({ timeout: 10_000 })
      await page.waitForTimeout(Math.max(0, 400 - (Date.now() - shown)))
      await expect(overlay(page)).toBeVisible()
      expect(await overlay(page).getAttribute('data-launch-end')).toBeNull()
      const box = (await settings.boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }

    // タップ（指を離した所でクリックが作られる。重なりが先に押せなくなっていると、下のボタンが押される）
    await page.goto('/#/', { waitUntil: 'commit' })
    let p = await open()
    await page.touchscreen.tap(p.x, p.y)
    await expect(overlay(page)).toHaveCount(0)
    expect(await launchEnd(page)).toBe('skip')
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/#\/$/)
    await expect(settings).toBeVisible()

    // 押したまま（重なりが消え始めて取り除かれる時間より長く）から離す
    p = await open()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
    await page.waitForTimeout(350)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(overlay(page)).toHaveCount(0)
    expect(await launchEnd(page)).toBe('skip')
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/#\/$/)
    await expect(settings).toBeVisible()

    // 長押し: 押したままの間は、消えても（見えなくても）重なりが残って押す操作を受け、離してから取り除かれる
    p = await open()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
    await page.waitForTimeout(1000)
    await expect(overlay(page)).toHaveAttribute('data-launch-end', 'skip')
    expect(await overlay(page).evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('auto')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(overlay(page)).toHaveCount(0)
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/#\/$/)
    // 取り除いた後は、ふつうにアプリを押せる
    await settings.tap()
    await expect(page).toHaveURL(/#\/settings$/)
  })

  test('キーを押してもすぐ消える', async ({ page }) => {
    await recordLaunchEnd(page)
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    await expect(overlay(page)).toBeVisible()
    await page.keyboard.press('Shift')
    await expect(overlay(page)).toHaveCount(0)
    expect(await launchEnd(page)).toBe('skip')
  })

  test('同じウインドウで読み込み直すと出ない。新しいタブでは出る', async ({ page, context }) => {
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    await expect(overlay(page)).toBeVisible()
    await page.mouse.click(10, 10)
    await expect(overlay(page)).toHaveCount(0)

    await page.reload({ waitUntil: 'domcontentloaded' })
    // 出すならページを読む途中で作るので、この時点で無ければ出ない
    await expect(overlay(page)).toHaveCount(0)
    expect(await page.evaluate(() => sessionStorage.getItem('novel-studio:launched'))).toBe('1')

    const tab = await context.newPage()
    await tab.goto('/?launch=1#/', { waitUntil: 'commit' })
    await expect(overlay(tab)).toBeVisible()
  })

  test('localStorage の novel-studio:launch = force でも出る（強制しないテストでは出ない）', async ({ page, context }) => {
    await page.goto('/#/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(0)
    await page.evaluate(() => localStorage.setItem('novel-studio:launch', 'force'))
    const tab = await context.newPage()
    await tab.goto('/#/')
    await expect(overlay(tab)).toBeVisible()
  })

  test('設定の「起動アニメーション」をオフにすると出ない。オンに戻すとまた出る', async ({ page, context }) => {
    await page.goto('/#/settings')
    const sw = page.getByTestId('launch-switch')
    await expect(sw.getByRole('switch')).toBeChecked()
    await expect(sw).toContainText('オン')
    await sw.click()
    await expect(sw.getByRole('switch')).not.toBeChecked()
    await expect(sw).toContainText('オフ')
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').launchAnimation, PREFS_KEY)).toBe(false)

    // 新しいタブ（ウインドウを開いた最初の1回）でも出ない
    const off = await context.newPage()
    await off.goto('/?launch=1#/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(off)).toHaveCount(0)
    await off.close()

    await sw.click()
    await expect(sw.getByRole('switch')).toBeChecked()
    const on = await context.newPage()
    await on.goto('/?launch=1#/', { waitUntil: 'commit' })
    await expect(overlay(on)).toBeVisible()
  })

  test('視差効果を減らす設定では動かさずにロゴだけを出し、0.5秒ほどで消える', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(() => {
      const w = window as unknown as { __created?: number; __removed?: number }
      new MutationObserver(() => {
        const el = document.getElementById('ns-launch')
        if (el && w.__created == null) w.__created = performance.now()
        if (!el && w.__created != null && w.__removed == null) w.__removed = performance.now()
      }).observe(document, { childList: true, subtree: true })
    })
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    const el = overlay(page)
    await expect(el).toHaveAttribute('data-launch-mode', 'still')
    await expect(el).toHaveCount(0, { timeout: 6000 })
    const shown = await page.evaluate(() => {
      const w = window as unknown as { __created: number; __removed: number }
      return w.__removed - w.__created
    })
    // 0.5秒（とアプリの最初の画面）を待ち、0.25秒で消える。アニメーション（約1.75秒）は待たない
    expect(shown).toBeGreaterThanOrEqual(700)
    expect(shown).toBeLessThan(1750 + 250)
  })

  test('ふだんは Worker（別のスレッド）で描き、絵が進む', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'OffscreenCanvas を Worker に渡せるブラウザ')
    await page.goto('/?launch=1#/', { waitUntil: 'commit' })
    const el = overlay(page)
    await expect(el).toHaveAttribute('data-launch-renderer', 'worker')
    await page.waitForTimeout(250)
    const a = await el.screenshot()
    await page.waitForTimeout(500)
    const b = await el.screenshot()
    expect(a.equals(b)).toBe(false)
  })

  test('外観ごとの地の色（白・黒・もっと暗い黒）と 360px の見え方', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '画面の写しはスマホの幅だけで撮る')
    await page.setViewportSize({ width: 360, height: 760 })
    // 決まった瞬間の絵を撮るため、ページの中で描かせ（Worker を使わせない）、requestAnimationFrame をテストから進める
    // （アプリの知らせは requestAnimationFrame が来なくても届く）
    await page.context().addInitScript(() => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { value: undefined, configurable: true })
      const w = window as unknown as { __step: (to: number) => void }
      let queue: FrameRequestCallback[] = []
      let now = 0
      window.requestAnimationFrame = (cb) => queue.push(cb)
      window.cancelAnimationFrame = () => {}
      w.__step = (to: number) => {
        while (now < to) {
          now = Math.min(to, now + 16)
          const q = queue
          queue = []
          q.forEach((cb) => cb(now))
        }
      }
    })
    const cases = [
      { theme: 'white', anim: 'light', bg: 'rgb(251, 252, 254)' },
      { theme: 'dark', anim: 'dark', bg: 'rgb(5, 6, 7)' },
      { theme: 'deep-dark', anim: 'deep', bg: 'rgb(0, 0, 0)' },
    ]
    for (const c of cases) {
      const tab = await page.context().newPage()
      await withPrefs(tab, { theme: c.theme, version: 2 })
      await tab.goto('/?launch=1#/', { waitUntil: 'commit' })
      const el = overlay(tab)
      await expect(el).toHaveAttribute('data-launch-theme', c.anim)
      expect(await el.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(c.bg)
      await noHorizontalScroll(tab)
      await expect(el).toHaveAttribute('data-launch-renderer', 'page')
      // 1回目の描画で下ごしらえをし、2回目の描画（32）を 0 秒として数える。
      // 0.62秒（原稿用紙のマス目と「物語を、書く。」）・1.15秒（線が開いてロゴ）・1.74秒（ロゴ）
      for (const [name, t] of [
        ['grid', 620],
        ['open', 1166],
        ['logo', 1740],
      ] as const) {
        await tab.evaluate((ms) => (window as unknown as { __step: (to: number) => void }).__step(32 + ms), t)
        await tab.screenshot({ path: `e2e/artifacts/screens/launch-360-${c.theme}-${name}.png` })
      }
      await tab.close()
    }
  })
})
