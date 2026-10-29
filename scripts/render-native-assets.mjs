// iPhone / Android アプリ（2.4）のアイコンと起動画面の元の画像を、public/icon.svg から作る（Playwright の Chromium で描く）。
// 使い方（リポジトリの直下で。ふだんは要らない。アイコンを変えた時だけ）:
//   node scripts/render-native-assets.mjs
//   npx @capacitor/assets@3.0.5 generate --ios --android --iconBackgroundColor '#2f3a4f' --iconBackgroundColorDark '#2f3a4f' --splashBackgroundColor '#2f3a4f' --splashBackgroundColorDark '#2f3a4f'
//   （--pwa は付けない。Web 版のアイコンは vite-plugin-pwa と render-icons.mjs。
//    整形だけ変わった android/app/src/main/AndroidManifest.xml と AppIcon の Contents.json は元に戻してよい）
// できるもの（assets/）:
//   icon-only.png        1024px、角を丸めない正方形（iPhone のアイコン。角は iOS が丸める。透明にしない）
//   icon-foreground.png  1024px、透明の上に絵だけ（Android のアダプティブアイコン。@capacitor/assets が周りに余白を付け、端末が丸などに切り抜く）
//   icon-background.png  1024px、背景の色だけ
//   splash.png           2732px、起動画面（背景の色の中央に絵）
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const BACKGROUND = '#2f3a4f'
const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8')
// 背景の角丸の四角と、絵（<g> から最後まで）に分ける
const art = svg.slice(svg.indexOf('<g'), svg.lastIndexOf('</svg>'))
if (!svg.includes('rx="112"') || !art.startsWith('<g'))
  throw new Error('public/icon.svg の形が変わりました（このスクリプトを直してください）')

/** 512 の絵を、size の正方形の中央に scale の大きさで描く SVG */
function compose(size, { background, scale }) {
  const box = 512 / scale
  const at = (512 - box) / 2
  const bg = background ? `<rect x="${at}" y="${at}" width="${box}" height="${box}" fill="${background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${at} ${at} ${box} ${box}">${bg}${art}</svg>`
}

const outputs = [
  ['icon-only.png', 1024, { background: BACKGROUND, scale: 1 }],
  ['icon-foreground.png', 1024, { background: null, scale: 1 }],
  ['icon-background.png', 1024, { background: BACKGROUND, scale: 1, empty: true }],
  ['splash.png', 2732, { background: BACKGROUND, scale: 800 / 2732 }],
]

await mkdir(new URL('../assets/', import.meta.url), { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [name, size, opt] of outputs) {
  await page.setViewportSize({ width: size, height: size })
  const body = opt.empty ? `<div style="width:${size}px;height:${size}px;background:${BACKGROUND}"></div>` : compose(size, opt)
  await page.setContent(`<html><body style="margin:0;background:transparent">${body}</body></html>`)
  await page.screenshot({
    path: new URL(`../assets/${name}`, import.meta.url).pathname,
    omitBackground: !opt.background,
    clip: { x: 0, y: 0, width: size, height: size },
  })
}
await browser.close()
console.log('assets/ にアイコンと起動画面の元の画像を作りました')
