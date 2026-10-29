// E2E テスト用のヘルパー。開発サーバーでは window.__ns から actions を呼んでデータを用意できる。
import { expect, type Locator, type Page } from '@playwright/test'
import type { Actions } from '../src/store/actions'
import type { AppData } from '../src/domain/types'

interface DevHook {
  actions: Actions
  getData: () => AppData
  flushNow: () => Promise<boolean>
  replaceAllData: (data: AppData) => Promise<void>
  /** エミュレーターにつないでいる時だけ: 仮のアカウントでログインする */
  signInForTest: (sub: string) => Promise<void>
  /** ログインしているアカウント（同期のテスト用） */
  syncUid: () => string | null
  /** ビルドの時に決めた Claude 用のコネクタの origin */
  connectorOrigin: string
  /** 手動連携の貼り付けと同じ作り方で Claude の記録を足す（戻り値は足した数） */
  pasteClaude: (titleId: string, text: string, now?: number) => Promise<number>
}

declare global {
  interface Window {
    __ns: DevHook
  }
}

/** アプリを開き、データの読み込みが終わるまで待つ */
export async function openApp(page: Page, hash = '/'): Promise<void> {
  await page.goto(`/#${hash}`)
  await page.waitForFunction(() => Boolean(window.__ns))
  await expect(page.getByText('読み込み中…')).toHaveCount(0)
}

/**
 * 画面を通さずにデータを用意する。fn はブラウザ内で実行される（外の変数は arg で渡す）。
 *   const titleId = await seed(page, ({ actions }) => actions.createTitle('作品'))
 */
export async function seed<R, A = undefined>(page: Page, fn: (hook: DevHook, arg: A) => R, arg?: A): Promise<R> {
  const result = await page.evaluate(
    async ({ src, arg }) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const f = new Function(`return (${src})`)() as (h: DevHook, a: unknown) => unknown
      const r = await f(window.__ns, arg)
      await window.__ns.flushNow()
      return r
    },
    { src: fn.toString(), arg: arg as unknown },
  )
  return result as R
}

/** タイトルと話をまとめて作る。戻り値は titleId と pieceId の配列 */
export async function seedTitleWithEpisodes(
  page: Page,
  name: string,
  bodies: string[],
): Promise<{ titleId: string; pieceIds: string[] }> {
  return seed(
    page,
    ({ actions, getData }, a: { name: string; bodies: string[] }) => {
      const titleId = actions.createTitle(a.name)
      const pieceIds = a.bodies.map((body) => {
        const id = actions.addEpisode(titleId)
        const vid = getData().pieces[id].versionIds[0]
        actions.updateVersion(vid, { body })
        return id
      })
      return { titleId, pieceIds }
    },
    { name, bodies },
  )
}

/** 横にはみ出していない（横スクロールが出ない） */
export async function noHorizontalScroll(page: Page): Promise<void> {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  expect(scroll).toBeLessThanOrEqual(width)
}

/** 'rgb(r, g, b)' の相対輝度 */
export function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** ディープダーク: 選んだ要素の背景がほぼ黒（白い面が出ない。透明は飛ばす） */
export async function darkSurfaces(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const els = page.locator(sel)
    const n = await els.count()
    for (let i = 0; i < n; i++) {
      const bg = await els.nth(i).evaluate((e) => getComputedStyle(e).backgroundColor)
      if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue
      expect(luminance(bg), `${sel} ${bg}`).toBeLessThan(0.05)
    }
  }
}

/** 押す所の大きさ（34px 以上。width も見る時は both） */
export async function tapSize(target: Locator, label: string, both = true): Promise<void> {
  await expect(target).toBeVisible()
  const box = await target.boundingBox()
  expect(box?.height, label).toBeGreaterThanOrEqual(34)
  if (both) expect(box?.width, label).toBeGreaterThanOrEqual(34)
}
