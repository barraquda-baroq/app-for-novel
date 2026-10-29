// @vitest-environment node
// vite.config.ts の埋め込む値。Web 版の本番のビルド（npm run build・npm run deploy）は、アプリが変わっていなければ毎回同じ中身になること
// （ビルドの日時を入れると、ビルドのたびにチャンクの名前と sw.js が変わり、使っている端末すべてに更新の知らせが出て全部を読み込み直す）
import { describe, expect, it } from 'vitest'
import config, { buildTimeDefine } from '../vite.config.ts'

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
