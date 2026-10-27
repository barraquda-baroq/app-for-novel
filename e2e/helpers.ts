// E2E テスト用のヘルパー。開発サーバーでは window.__ns から actions を呼んでデータを用意できる。
import { expect, type Page } from '@playwright/test'
import type { Actions } from '../src/store/actions'
import type { AppData } from '../src/domain/types'

interface DevHook {
  actions: Actions
  getData: () => AppData
  flushNow: () => Promise<void>
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
export async function seedTitleWithEpisodes(page: Page, name: string, bodies: string[]): Promise<{ titleId: string; pieceIds: string[] }> {
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
