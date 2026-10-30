// iPhone / Android アプリのアイコンの元の画像を、アイコン「ドットの NS」（scripts/icon-art.mjs）から作る（Playwright の Chromium で描く）。
// 使い方（リポジトリの直下で。ふだんは要らない。アイコンを変えた時だけ）:
//   node scripts/render-native-assets.mjs
//   npx @capacitor/assets@3.0.5 generate --ios --android
//   （--pwa は付けない。Web 版のアイコンは scripts/render-icons.mjs。
//    整形だけ変わった android/app/src/main/AndroidManifest.xml と AppIcon の Contents.json は元に戻してよい）
// できるもの（assets/）:
//   icon-only.png        1024px、角を丸めない正方形（iPhone のアイコンと、Android 7 までのアイコン。角は端末が丸める。透明にしない）
//   icon-foreground.png  1024px、透明の上に点だけ（Android 8 以降のアダプティブアイコンの前景。@capacitor/assets が周りに余白を付け、
//                        端末が丸などに切り抜く。NS は切り抜かれても欠けない真ん中の円に収まっている）
//   icon-background.png  1024px、黒地だけ（アダプティブアイコンの背景）
// 起動の画面（スプラッシュ）は画像を使わない無地（端末のライト／ダークに合わせた色。起動アニメーションの最初の絵と同じ色）なので、
// 元の画像は無い（Android は res/values・values-night の launch_background、iPhone は LaunchBackground の色。docs/SPEC-2.md の 10.）
import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
import { iconSvg } from './icon-art.mjs'

const out = (name) => new URL(`../assets/${name}`, import.meta.url)

await mkdir(out(''), { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
for (const [name, layer] of [
  ['icon-only.png', 'all'],
  ['icon-foreground.png', 'art'],
  ['icon-background.png', 'background'],
]) {
  await page.setContent(`<html><body style="margin:0;background:transparent">${iconSvg({ layer })}</body></html>`)
  await page.screenshot({
    path: out(name).pathname,
    omitBackground: layer === 'art',
    clip: { x: 0, y: 0, width: 1024, height: 1024 },
  })
}
await browser.close()
// 2.4 の起動の画面の元の画像（ロゴ入り）は使わない
await rm(out('splash.png'), { force: true })
console.log('assets/ にアイコンの元の画像を作りました')
