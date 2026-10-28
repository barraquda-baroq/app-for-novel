import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, migratePrefs, PREFS_VERSION, resolveAppearance } from './uiStore'

const KEY = 'novel-studio:prefs'

describe('表示の設定の移し替え（migratePrefs）', () => {
  it('1.x の外観は ライト → ホワイト、ダーク → ダーク に移し、ほかの設定はそのまま残す', () => {
    const light = migratePrefs({
      splitRatio: 0.3,
      splitOrientation: 'vertical',
      theme: 'light',
      editorFont: 'gothic',
      editorFontSize: 21,
      showDiff: true,
      verticalReading: true,
    })
    expect(light).toEqual({
      splitRatio: 0.3,
      splitOrientation: 'vertical',
      theme: 'white',
      editorFont: 'gothic',
      editorFontSize: 21,
      showDiff: true,
      verticalReading: true,
    })
    expect(migratePrefs({ theme: 'dark' }).theme).toBe('dark')
    expect(migratePrefs({ theme: 'system' }).theme).toBe('system')
  })

  it('1.x の書体は新しい既定（ゴシック）にする（1.x では既定の明朝と選んだ明朝を区別できない）', () => {
    expect(DEFAULT_PREFS.editorFont).toBe('gothic')
    expect(migratePrefs({ theme: 'dark', editorFont: 'mincho' }).editorFont).toBe('gothic')
    expect(migratePrefs({ editorFont: 'gothic' }).editorFont).toBe('gothic')
  })

  it('2.0 の形で保存した設定はそのまま読む（明朝・ディープダークも残る）', () => {
    const prefs = migratePrefs({ version: PREFS_VERSION, theme: 'deep-dark', editorFont: 'mincho', editorFontSize: 19 })
    expect(prefs.theme).toBe('deep-dark')
    expect(prefs.editorFont).toBe('mincho')
    expect(prefs.editorFontSize).toBe(19)
    expect(migratePrefs({ version: PREFS_VERSION, theme: 'white' }).theme).toBe('white')
    // 保存形式の版は設定の値には含めない
    expect(prefs).not.toHaveProperty('version')
  })

  it('知らない値・型の違う値・壊れたデータは既定値にする', () => {
    expect(migratePrefs({ version: PREFS_VERSION, theme: 'sepia', editorFont: 'serif' })).toEqual(DEFAULT_PREFS)
    expect(migratePrefs({ version: PREFS_VERSION, theme: 'light' }).theme).toBe('system')
    expect(migratePrefs({ editorFontSize: '20', showDiff: 'yes', extra: 1 })).toEqual(DEFAULT_PREFS)
    expect(migratePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(migratePrefs('dark')).toEqual(DEFAULT_PREFS)
    expect(migratePrefs([1, 2])).toEqual(DEFAULT_PREFS)
  })
})

describe('外観の決定（resolveAppearance）', () => {
  it('「端末の設定に合わせる」は端末がダークならダーク、そうでなければホワイト', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('white')
  })

  it('選んだ外観は端末の設定によらずそのまま', () => {
    for (const systemDark of [true, false]) {
      expect(resolveAppearance('white', systemDark)).toBe('white')
      expect(resolveAppearance('dark', systemDark)).toBe('dark')
      expect(resolveAppearance('deep-dark', systemDark)).toBe('deep-dark')
    }
  })
})

describe('起動時の読み込みと保存', () => {
  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('1.x の保存内容を読み込み、次に保存する時は新しい形（版つき）で書く', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'light', editorFont: 'mincho', editorFontSize: 20, showDiff: true }))
    vi.resetModules()
    const { usePrefs } = await import('./uiStore')
    expect(usePrefs.getState().theme).toBe('white')
    expect(usePrefs.getState().editorFont).toBe('gothic')
    expect(usePrefs.getState().editorFontSize).toBe(20)
    expect(usePrefs.getState().showDiff).toBe(true)

    usePrefs.getState().setPrefs({ editorFont: 'mincho' })
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    expect(stored).toMatchObject({ version: PREFS_VERSION, theme: 'white', editorFont: 'mincho', editorFontSize: 20 })

    // 保存し直した後は、選んだ明朝がそのまま残る
    vi.resetModules()
    const again = await import('./uiStore')
    expect(again.usePrefs.getState().editorFont).toBe('mincho')
    expect(again.usePrefs.getState().theme).toBe('white')
  })

  it('保存内容が壊れていても既定値で起動する', async () => {
    localStorage.setItem(KEY, '{not json')
    vi.resetModules()
    const { usePrefs } = await import('./uiStore')
    expect(usePrefs.getState().theme).toBe('system')
    expect(usePrefs.getState().editorFont).toBe('gothic')
  })
})
