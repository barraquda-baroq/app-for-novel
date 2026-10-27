// public/icon.svg から PWA 用 PNG アイコンを生成する（Playwright の Chromium でレンダリング）
// 使い方: node scripts/render-icons.mjs
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [size, name, pad] of [
  [192, 'pwa-192.png', 0],
  [512, 'pwa-512.png', 0],
  [180, 'apple-touch-icon.png', 0],
]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;padding:${pad}px;box-sizing:border-box">${svg.replace('<svg ', `<svg width="${size - pad * 2}" height="${size - pad * 2}" `)}</div></body></html>`,
  )
  await page.screenshot({ path: new URL(`../public/${name}`, import.meta.url).pathname, omitBackground: true })
}
await browser.close()
console.log('icons rendered')
