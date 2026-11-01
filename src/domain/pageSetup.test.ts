import { describe, expect, it } from 'vitest'
import { parseBackup, toBackup } from './backup'
import { createTitle, setTitlePageSetup } from './entityOps'
import {
  checkPageSetup,
  DEFAULT_PAGE_SETUP,
  hasPageSetup,
  isPresetPageSetup,
  isValidPageSetup,
  PAGE_SETUP_PRESETS,
  pageSetupLabel,
  pageSetupLongLabel,
  pageSetupOf,
  parsePageSetup,
} from './pageSetup'
import { repairData } from './repair'
import { DomainError, emptyData, type Title } from './types'

const errorOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof DomainError ? e.message : String(e)
  }
  return ''
}

describe('縦書きのページ表示の字数×行数', () => {
  it('無い・壊れた・範囲の外の値は既定の 40×32', () => {
    expect(DEFAULT_PAGE_SETUP).toEqual({ chars: 40, lines: 32 })
    expect(pageSetupOf(undefined)).toEqual({ chars: 40, lines: 32 })
    expect(pageSetupOf({})).toEqual({ chars: 40, lines: 32 })
    for (const bad of [
      null,
      'x',
      { chars: 40 },
      { chars: '40', lines: 32 },
      { chars: 9, lines: 32 },
      { chars: 40, lines: 61 },
      { chars: 40.5, lines: 30 },
    ])
      expect(pageSetupOf({ pageSetup: bad as Title['pageSetup'] })).toEqual({ chars: 40, lines: 32 })
    expect(hasPageSetup({ pageSetup: { chars: 99, lines: 32 } })).toBe(false)
    expect(pageSetupOf({ pageSetup: { chars: 20, lines: 20 } })).toEqual({ chars: 20, lines: 20 })
    expect(hasPageSetup({ pageSetup: { chars: 20, lines: 20 } })).toBe(true)
  })

  it('選べる字数×行数と範囲', () => {
    expect(PAGE_SETUP_PRESETS.map(pageSetupLabel)).toEqual(['20×20', '40×30', '40×32', '40×40', '42×34'])
    expect(PAGE_SETUP_PRESETS.every(isValidPageSetup)).toBe(true)
    expect(isPresetPageSetup({ chars: 40, lines: 32 })).toBe(true)
    expect(isPresetPageSetup({ chars: 41, lines: 32 })).toBe(false)
    expect(isValidPageSetup({ chars: 10, lines: 5 })).toBe(true)
    expect(isValidPageSetup({ chars: 60, lines: 60 })).toBe(true)
    expect(isValidPageSetup({ chars: 61, lines: 60 })).toBe(false)
    expect(isValidPageSetup({ chars: 10, lines: 4 })).toBe(false)
    expect(pageSetupLongLabel({ chars: 42, lines: 34 })).toBe('42字×34行')
  })

  it('自由に入れた字数・行数を確かめる（全角の数字も読む）', () => {
    expect(checkPageSetup('38', '３０')).toEqual({ ok: true, setup: { chars: 38, lines: 30 } })
    expect(checkPageSetup(' 20 ', 20)).toEqual({ ok: true, setup: { chars: 20, lines: 20 } })
    expect(checkPageSetup('9', '30')).toEqual({ ok: false, message: '1行の字数は 10〜60 の数で入れてください' })
    expect(checkPageSetup('40', '')).toEqual({ ok: false, message: '1ページの行数は 5〜60 の数で入れてください' })
    expect(checkPageSetup('40.5', '30').ok).toBe(false)
    expect(checkPageSetup('abc', '30').ok).toBe(false)
  })

  it('「40×32」のような1つの入力を読む', () => {
    for (const s of ['40×32', '40x32', '40 X 32', '４０×３２', '40字×32行', '40*32'])
      expect(parsePageSetup(s)).toEqual({ ok: true, setup: { chars: 40, lines: 32 } })
    expect(parsePageSetup('40')).toEqual({ ok: false, message: '「40×32」のように、字数×行数で入れてください' })
    expect(parsePageSetup('100×32').ok).toBe(false)
  })

  it('タイトルに決める・既定に戻す・同じなら何もしない・範囲の外は断る', () => {
    const t = createTitle(emptyData(), '作品')
    const before = t.data.titles[t.result]
    let data = setTitlePageSetup(t.data, t.result, { chars: 20, lines: 20 })
    expect(data.titles[t.result].pageSetup).toEqual({ chars: 20, lines: 20 })
    expect(data.titles[t.result].updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    expect(setTitlePageSetup(data, t.result, { chars: 20, lines: 20 })).toBe(data)
    data = setTitlePageSetup(data, t.result, null)
    expect('pageSetup' in data.titles[t.result]).toBe(false)
    expect(setTitlePageSetup(data, t.result, null)).toBe(data)
    // 既定と同じ値も、決めた値として残す（ほかの端末で既定が変わっても変わらないように）
    expect(setTitlePageSetup(data, t.result, { chars: 40, lines: 32 }).titles[t.result].pageSetup).toEqual({
      chars: 40,
      lines: 32,
    })
    expect(errorOf(() => setTitlePageSetup(data, t.result, { chars: 70, lines: 32 }))).toBe(
      '字数×行数は、1行 10〜60字・1ページ 5〜60行で決めてください',
    )
    expect(errorOf(() => setTitlePageSetup(data, 'nope', { chars: 40, lines: 32 }))).toBe('タイトルが見つかりません')
  })

  it('修復は値を書き換えない（範囲の外の値も残し、読む時に既定として扱う）・バックアップにも残る', () => {
    const t = createTitle(emptyData(), '作品')
    const data = setTitlePageSetup(t.data, t.result, { chars: 42, lines: 34 })
    expect(repairData(data).data.titles[t.result].pageSetup).toEqual({ chars: 42, lines: 34 })
    // 新しい版のアプリが広げた範囲の値など
    const wide = { ...data, titles: { [t.result]: { ...data.titles[t.result], pageSetup: { chars: 80, lines: 40 } } } }
    const r = repairData(wide)
    expect(r.fixes).toEqual([])
    expect(r.data.titles[t.result].pageSetup).toEqual({ chars: 80, lines: 40 })
    expect(pageSetupOf(r.data.titles[t.result])).toEqual({ chars: 40, lines: 32 })
    const restored = parseBackup(JSON.stringify(toBackup(data)))
    expect(restored.titles[t.result].pageSetup).toEqual({ chars: 42, lines: 34 })
  })
})
