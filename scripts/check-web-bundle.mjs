// Web 版（npm run build の dist）に、アプリ（iPhone / Android）でだけ使うものが入っていないことを確かめる（CI のビルドの後）。
// Google ログインのプラグイン（@capacitor-firebase/authentication）の Web 版の実装は firebase/auth のほぼ全部（電話番号のログイン・
// reCAPTCHA など）を引き込み、ログインしている人が起動のたびに読む Firebase のチャンクが 3 割ほど大きくなる（src/platform/nativeAuth.ts）。
// あわせて、数字の書体（Roboto Mono の woff2。src/fonts/）の3つの太さ（400・500・600）が、サービスワーカー（sw.js）の事前キャッシュに入っていることも
// 確かめる（入っていないと、オフラインで開いた時に数字が等幅の字で出ない。vite.config.ts の workbox の globPatterns）。
//   node scripts/check-web-bundle.mjs [dist]
import fs from 'node:fs'
import path from 'node:path'

const dist = process.argv[2] ?? 'dist'
const assets = path.join(dist, 'assets')
if (!fs.existsSync(assets)) {
  console.error(`${assets} がありません（先に npm run build）`)
  process.exit(1)
}

/** 入っていてはいけないもの（プラグインの Web 版の実装と、それが引き込む firebase/auth の部分にだけある文字） */
const MARKERS = [
  ['プラグインの Web 版の実装', 'phoneCodeSent'],
  ['プラグインの Web 版の実装', 'recaptchaVerifier must be provided'],
  ['firebase/auth の reCAPTCHA Enterprise', 'recaptcha-enterprise'],
]

const files = fs.readdirSync(assets).filter((f) => f.endsWith('.js'))
const firebase = files.filter((f) => /^firebase-.*\.js$/.test(f))
if (firebase.length === 0) {
  console.error(`${assets} に Firebase のチャンク（firebase-*.js）が見つかりません`)
  process.exit(1)
}

const problems = []
for (const f of files) {
  const text = fs.readFileSync(path.join(assets, f), 'utf8')
  for (const [what, marker] of MARKERS) if (text.includes(marker)) problems.push(`${f}: ${what}（${marker}）`)
}
for (const f of firebase) console.log(`${f}: ${(fs.statSync(path.join(assets, f)).size / 1000).toFixed(2)} kB`)
if (problems.length) {
  console.error('Web 版にアプリでだけ使うものが入っています（src/platform/nativeAuth.ts の読み込み方を確かめる）:')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('Web 版に、アプリでだけ使うログインのプラグインは入っていません')

/** 事前キャッシュに入れる書体（src/fonts/roboto-mono/ の woff2。ビルドすると assets/ に名前の後ろにハッシュを付けて出る） */
const FONT_WEIGHTS = [400, 500, 600]
const sw = path.join(dist, 'sw.js')
if (!fs.existsSync(sw)) {
  console.error(`${sw} がありません（Web 版のビルドにはサービスワーカーが要る。vite.config.ts の VitePWA）`)
  process.exit(1)
}
const swText = fs.readFileSync(sw, 'utf8')
const fonts = fs.readdirSync(assets).filter((f) => f.endsWith('.woff2'))
const missing = []
for (const w of FONT_WEIGHTS) {
  const name = `roboto-mono-latin-${w}-normal`
  const file = fonts.find((f) => f.startsWith(`${name}-`) || f === `${name}.woff2`)
  if (!file) missing.push(`${name}.woff2（${assets} にありません）`)
  else if (!swText.includes(`assets/${file}`)) missing.push(`assets/${file}`)
}
if (missing.length) {
  console.error(
    'サービスワーカーの事前キャッシュに書体が入っていません（vite.config.ts の workbox の globPatterns に woff2 があるか確かめる）:',
  )
  for (const m of missing) console.error(`  ${m}`)
  process.exit(1)
}
console.log(`サービスワーカーの事前キャッシュに書体（Roboto Mono の ${FONT_WEIGHTS.join('・')}）が入っています`)
