// @vitest-environment node
// vite.config.ts の埋め込む値。Web 版の本番のビルド（npm run build・npm run deploy）は、アプリが変わっていなければ毎回同じ中身になること
// （ビルドの日時を入れると、ビルドのたびにチャンクの名前と sw.js が変わり、使っている端末すべてに更新の知らせが出て全部を読み込み直す）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config, { buildTimeDefine, inlineScripts } from '../vite.config.ts'

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
    expect(win.NovelStudioLaunch.decide({ enabled: true, native: false, webdriver: false, forced: false, shownInSession: false, reducedMotion: true })).toBe('still')
  })

  it('埋め込む場所が無ければ何もしない', async () => {
    expect(await inlineScripts('<html><head></head></html>', root, true)).toBe('<html><head></head></html>')
  })
})
