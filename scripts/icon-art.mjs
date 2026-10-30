// アプリのアイコン「ドットの NS」（黒地に、緑に光る点の「NS」と、消えている点の並び）を SVG で作る。
// 字は起動アニメーションのロゴと同じ 5×7 の点の字（src/launch/launch.js の GLYPHS）。
// 書き出しは scripts/render-icons.mjs（Web 版）と scripts/render-native-assets.mjs（iPhone / Android）。

/** 点の緑（起動アニメーションのダークのレーザーと同じ） */
export const GREEN = '#2bff73'
/** 地の色（起動アニメーションのダークの地と同じ。PWA の theme_color・background_color も） */
export const BACKGROUND = '#050607'

const N = ['10001', '10001', '11001', '10101', '10011', '10001', '10001']
const S = ['01111', '10000', '10000', '01110', '00001', '00001', '11110']

const r2 = (n) => +(+n).toFixed(2)

/** 字の点の中心（ox, oy は左上、p は点の間隔） */
function glyphPoints(rows, ox, oy, p) {
  const out = []
  rows.forEach((row, j) => [...row].forEach((c, i) => c === '1' && out.push([ox + i * p + p / 2, oy + j * p + p / 2])))
  return out
}

/** 「NS」の点の中心（N と S の間は gap 列あける） */
function nsPoints(ox, oy, p, gap = 1) {
  return glyphPoints(N, ox, oy, p).concat(glyphPoints(S, ox + (5 + gap) * p, oy, p))
}

/** 点いている点: 柔らかい光（halo）＋ 点（中心が明るい）。d は点の大きさ */
function litDots(points, d, { halo = 1.3, rx = 0.14, led = true } = {}) {
  let s = ''
  if (halo)
    s += `<g fill="url(#halo)">${points.map(([x, y]) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(d * halo)}"/>`).join('')}</g>\n`
  s += `<g fill="${led ? 'url(#led)' : GREEN}">`
  s += points
    .map(([x, y]) => `<rect x="${r2(x - d / 2)}" y="${r2(y - d / 2)}" width="${r2(d)}" height="${r2(d)}" rx="${r2(d * rx)}"/>`)
    .join('')
  return s + '</g>\n'
}

/** 消えている点の並び（真ん中から離れるほど薄く） */
function unlitDots(cols, rows, p, d, litSet, { a0 = 0.075, a1 = 0.012, rmax = 720, rx = 0.14 } = {}) {
  let s = `<g fill="${GREEN}">`
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (litSet.has(`${i},${j}`)) continue
      const x = i * p + p / 2
      const y = j * p + p / 2
      const t = Math.min(1, Math.hypot(x - 512, y - 512) / rmax)
      const a = a0 + (a1 - a0) * t * t
      s += `<rect x="${r2(x - d / 2)}" y="${r2(y - d / 2)}" width="${r2(d)}" height="${r2(d)}" rx="${r2(d * rx)}" opacity="${r2(a)}"/>`
    }
  }
  return s + '</g>\n'
}

const DEFS = {
  bg: '<radialGradient id="bg" cx="50%" cy="48%" r="72%"><stop offset="0" stop-color="#0a1810"/><stop offset="1" stop-color="#030404"/></radialGradient>',
  led: `<radialGradient id="led" cx="50%" cy="46%" r="62%"><stop offset="0" stop-color="#e2ffeb"/><stop offset=".42" stop-color="#7dffab"/><stop offset="1" stop-color="${GREEN}"/></radialGradient>`,
  halo: `<radialGradient id="halo"><stop offset="0" stop-color="${GREEN}" stop-opacity="0.42"/><stop offset=".38" stop-color="${GREEN}" stop-opacity="0.13"/><stop offset="1" stop-color="${GREEN}" stop-opacity="0"/></radialGradient>`,
}

/**
 * アプリのアイコン（1024 四方の SVG）。
 *   grid: 点の並びの数（奇数）。15 がふだんのアイコン（PWA の any も）。17 は NS が小さめで、丸などに切り抜かれても欠けない
 *     （PWA の maskable だけ。public/pwa-maskable-*.png）
 *   layer: 'all' | 'background' | 'art'（Android のアダプティブアイコンは背景と絵を別の画像にする）
 *   radius: 角の丸み（0 は四角。public/icon.svg は 224 = 古いアイコンと同じ 21.9%）
 */
export function iconSvg({ grid = 15, layer = 'all', radius = 0 } = {}) {
  const p = 1024 / grid
  const d = p * 0.8
  // NS（11列×7行）を真ん中に
  const gx = (grid - 11) / 2
  const gy = (grid - 7) / 2
  const points = nsPoints(gx * p, gy * p, p)
  const litSet = new Set()
  ;[N, S].forEach((rows, k) =>
    rows.forEach((row, j) => [...row].forEach((c, i) => c === '1' && litSet.add(`${gx + i + k * 6},${gy + j}`))),
  )
  const defs = [radius ? `<clipPath id="round"><rect width="1024" height="1024" rx="${radius}"/></clipPath>` : '']
  let body = ''
  if (layer !== 'art') {
    defs.push(DEFS.bg)
    body += `<g id="background"><rect width="1024" height="1024" fill="${BACKGROUND}"/><rect width="1024" height="1024" fill="url(#bg)"/></g>\n`
  }
  if (layer !== 'background') {
    defs.push(DEFS.led, DEFS.halo)
    body += `<g id="art">\n${unlitDots(grid, grid, p, d, litSet)}${litDots(points, d)}</g>\n`
  }
  const content = radius ? `<g clip-path="url(#round)">\n${body}</g>\n` : body
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n<defs>${defs.join('')}</defs>\n${content}</svg>\n`
}

/** タブのアイコン（32 四方。点を 2 の升目にそろえ、32px・16px でもにじまないようにする） */
export function faviconSvg() {
  const points = nsPoints(4, 8, 2, 2)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">\n' +
    `<rect width="32" height="32" fill="${BACKGROUND}"/>\n` +
    litDots(points, 1.7, { halo: 0, led: false, rx: 0.1 }) +
    '</svg>\n'
  )
}
