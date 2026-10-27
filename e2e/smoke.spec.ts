import { expect, test } from '@playwright/test'
import { openApp, seedTitleWithEpisodes } from './helpers'

test('アプリが起動し、開発用フックでデータを用意できる', async ({ page }) => {
  await openApp(page)
  const { titleId, pieceIds } = await seedTitleWithEpisodes(page, 'スモーク', ['一話目', '二話目'])
  expect(pieceIds).toHaveLength(2)
  const titles = await page.evaluate(() => Object.values(window.__ns.getData().titles).map((t) => (t as { name: string }).name))
  expect(titles).toEqual(['スモーク'])
  expect(titleId).toBeTruthy()
})
