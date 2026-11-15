// @vitest-environment node
// vite.config.ts の埋め込む値。Web 版の本番のビルド（npm run build・npm run deploy）は、アプリが変わっていなければ毎回同じ中身になること
// （ビルドの日時を入れると、ビルドのたびにチャンクの名前と sw.js が変わり、使っている端末すべてに更新の知らせが出て全部を読み込み直す）
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import config, { PWA_ICONS, buildTimeDefine, inlineScripts } from '../vite.config.ts'

// VitePWA に渡した設定（vite-plugin-pwa は受け取った設定をプラグインの中に閉じ込めて、解決した設定からは読めないので、
// 渡す所で写しを取る。プラグインはそのまま作る）
const pwa = vi.hoisted(() => ({ options: [] }))
vi.mock('vite-plugin-pwa', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    VitePWA: (options) => {
      pwa.options.push(options)
      return mod.VitePWA(options)
    },
  }
})

/** vite の設定を、コマンドとモードを指定して作る */
const resolve = (command, mode) => config({ command, mode, isSsrBuild: false, isPreview: false })
const builtTime = (command, mode) => JSON.parse(resolve(command, mode).define.__BUILD_TIME__)

describe('__BUILD_TIME__', () => {
  it('Web 版の本番のビルドには入れない（null）', () => {
    expect(builtTime('build', 'production')).toBeNull()
  })

  it('アプリのビルド（npm run build:native）・開発サーバー・テストには今の日時を入れる', () => {
    const before = Date.now()
    for (const [command, mode] of [
      ['build', 'native'],
      ['serve', 'development'],
      ['serve', 'test'],
    ]) {
      const t = builtTime(command, mode)
      expect(typeof t).toBe('number')
      expect(t).toBeGreaterThanOrEqual(before)
      expect(t).toBeLessThanOrEqual(Date.now())
    }
  })

  it('buildTimeDefine', () => {
    expect(buildTimeDefine('build', false, 123)).toBeNull()
    expect(buildTimeDefine('build', true, 123)).toBe(123)
    expect(buildTimeDefine('serve', false, 123)).toBe(123)
  })
})

// 外観と起動アニメーション（src/launch/launch.js）を index.html に埋め込む（読み込みを増やさず、アプリの本体より先に動かす）
describe('inlineScripts（index.html の <script data-inline>）', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../src/launch/launch.js', import.meta.url), 'utf8')
  /** 埋め込んだ script の中身 */
  const scriptOf = (out) => out.slice(out.indexOf('<script>') + '<script>'.length, out.indexOf('</script>'))

  it('開発サーバーでは、ファイルをそのまま埋め込み、その後に index.html の呼び出しを置く', async () => {
    const out = await inlineScripts(html, root, false)
    expect(out).not.toMatch(/<script data-inline/)
    const code = scriptOf(out)
    expect(code).toContain(source.trim())
    expect(code.trim().endsWith('NovelStudioLaunch.boot()')).toBe(true)
    // アプリの本体より前（<head> の中）
    expect(out.indexOf('NovelStudioLaunch.boot()')).toBeLessThan(out.indexOf('</head>'))
  })

  it('ビルドではコメントを除いて縮め、そのまま動く', async () => {
    const out = await inlineScripts(html, root, true)
    const code = scriptOf(out)
    expect(code.length).toBeLessThan(source.length / 2)
    expect(code).not.toContain('起動アニメーション')
    // 動かすと window.NovelStudioLaunch ができる（boot は呼ばずに確かめる）
    const lib = code.slice(0, code.lastIndexOf('NovelStudioLaunch.boot()'))
    const win = {}
    new Function('window', 'document', lib)(win, {})
    expect(typeof win.NovelStudioLaunch.boot).toBe('function')
    expect(
      win.NovelStudioLaunch.decide({
        enabled: true,
        native: false,
        webdriver: false,
        forced: false,
        shownInSession: false,
        reducedMotion: true,
      }),
    ).toBe('still')
  })

  it('埋め込む場所が無ければ何もしない', async () => {
    expect(await inlineScripts('<html><head></head></html>', root, true)).toBe('<html><head></head></html>')
  })
})

// インストールした Web 版のアイコン（manifest の icons。画像は scripts/render-icons.mjs が public/ に書き出す）
describe('PWA_ICONS（manifest のアイコン）', () => {
  const file = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url))
  /** PNG の幅と高さ（IHDR） */
  const pngSize = (buf) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`

  it('どの画像も public/ にあり、書いてある大きさの PNG', () => {
    for (const icon of PWA_ICONS) {
      const buf = file(icon.src)
      expect(buf.subarray(1, 4).toString()).toBe('PNG')
      expect(pngSize(buf), icon.src).toBe(icon.sizes)
      expect(icon.type).toBe('image/png')
    }
  })

  it('any（スタートメニュー・タスクバー・ウインドウ）はふだんのアイコン、maskable は別の画像（NS を小さめにしたもの）', () => {
    const any = PWA_ICONS.filter((i) => i.purpose === 'any')
    const maskable = PWA_ICONS.filter((i) => i.purpose === 'maskable')
    expect(any.map((i) => i.sizes)).toEqual(['32x32', '192x192', '512x512'])
    expect(maskable.map((i) => i.sizes)).toEqual(['192x192', '512x512'])
    for (const m of maskable) {
      expect(m.src).toMatch(/^pwa-maskable-/)
      const a = any.find((i) => i.sizes === m.sizes)
      expect(a.src).not.toBe(m.src)
      expect(file(a.src).equals(file(m.src))).toBe(false)
    }
    // 1つの画像を any と maskable の両方には使わない
    expect(new Set(PWA_ICONS.map((i) => i.src)).size).toBe(PWA_ICONS.length)
  })
})

// サービスワーカーの事前キャッシュ（workbox の globPatterns）。数字の書体（Roboto Mono の woff2。src/fonts/）も入れ、オフラインでも等幅の字で出す
describe('事前キャッシュ（VitePWA の workbox）', () => {
  /** コマンドとモードを指定して設定を作った時に、VitePWA に渡した設定 */
  const optionsFor = (command, mode) => {
    pwa.options.length = 0
    resolve(command, mode)
    expect(pwa.options).toHaveLength(1)
    return pwa.options[0]
  }
  const fonts = readdirSync(new URL('../src/fonts/roboto-mono/', import.meta.url))
    .filter((f) => f.endsWith('.woff2'))
    .sort()

  it('Web 版のビルドでは js・css・html と書体の woff2 を入れる', () => {
    const options = optionsFor('build', 'production')
    expect(options.disable).toBe(false)
    const patterns = options.workbox.globPatterns
    expect(patterns.some((p) => p.includes('woff2'))).toBe(true)
    const cached = (file) => patterns.some((p) => path.matchesGlob(file, p))
    // ビルドした書体（assets/ に名前の後ろにハッシュを付けて出る）
    expect(fonts.map((f) => f.replace(/\.woff2$/, ''))).toEqual([
      'roboto-mono-latin-400-normal',
      'roboto-mono-latin-500-normal',
      'roboto-mono-latin-600-normal',
    ])
    for (const f of fonts) expect(cached(`assets/${f.replace(/\.woff2$/, '-AbC_12-x.woff2')}`), f).toBe(true)
    // 既定の js・css・html も入ったまま
    for (const f of ['index.html', 'assets/index-AbC12.js', 'assets/index-AbC12.css']) expect(cached(f), f).toBe(true)
    // ライセンスの全文（txt）は事前キャッシュに入れない（アプリの中では js のチャンクとして読む）
    expect(cached('assets/OFL.txt')).toBe(false)
  })

  it('アプリ（npm run build:native）ではサービスワーカーを入れない', () => {
    expect(optionsFor('build', 'native').disable).toBe(true)
  })
})
