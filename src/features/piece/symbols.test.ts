// 記号ボタン: 入る文字と、入れた後のカーソル位置
import { describe, expect, it } from 'vitest'
import { parseRuby } from '../../domain/ruby'
import { countChars } from '../../domain/text'
import { applySymbol, DASH, ELLIPSIS, FULL_SPACE } from './symbols'

describe('記号の挿入', () => {
  it('ダッシュは U+2015 を2つ、三点リーダーは U+2026 を2つ、全角空白は U+3000', () => {
    expect(DASH).toBe('――')
    expect([...DASH].map((c) => c.codePointAt(0))).toEqual([0x2015, 0x2015])
    expect([...ELLIPSIS].map((c) => c.codePointAt(0))).toEqual([0x2026, 0x2026])
    expect(FULL_SPACE.codePointAt(0)).toBe(0x3000)
  })

  it('カーソルの位置に入れ、カーソルは入れた文字の後ろ', () => {
    const r = applySymbol('あいう', 1, 1, 'dash')
    expect(r.value).toBe('あ――いう')
    expect(r.selection).toEqual({ start: 3, end: 3 })
    expect(r.splice).toEqual({ start: 1, removed: '', inserted: '――' })
    expect(applySymbol('あいう', 3, 3, 'ellipsis').value).toBe('あいう……')
    expect(applySymbol('あいう', 0, 0, 'space')).toMatchObject({ value: '　あいう', selection: { start: 1, end: 1 } })
  })

  it('選択範囲は記号で置き換える', () => {
    expect(applySymbol('あいう', 1, 2, 'dash')).toMatchObject({ value: 'あ――う', selection: { start: 3, end: 3 } })
  })

  it('ルビ: 選んだ文字を親文字にして、カーソルは《》の中', () => {
    const r = applySymbol('彼は漢字を読む', 2, 4, 'ruby')
    expect(r.value).toBe('彼は｜漢字《》を読む')
    expect(r.selection).toEqual({ start: 6, end: 6 })
    // 読みを打つとルビになる（記号と読みは文字数に数えない）
    const done = r.value.slice(0, 6) + 'かんじ' + r.value.slice(6)
    expect(parseRuby(done)).toContainEqual({ type: 'ruby', base: '漢字', reading: 'かんじ' })
    expect(countChars(done)).toBe(7)
  })

  it('ルビ: 選んでいなければ ｜《》 を入れ、カーソルは ｜ の直後（親文字から打つ）', () => {
    const r = applySymbol('あいう', 1, 1, 'ruby')
    expect(r.value).toBe('あ｜《》いう')
    expect(r.selection).toEqual({ start: 2, end: 2 })
  })

  it('傍点: 選んだ文字を《《》》で囲む。選んでいなければ《《》》を入れ、カーソルは真ん中', () => {
    const r = applySymbol('とても大事', 3, 5, 'bouten')
    expect(r.value).toBe('とても《《大事》》')
    expect(r.selection).toEqual({ start: 9, end: 9 })
    expect(parseRuby(r.value)).toContainEqual({ type: 'bouten', text: '大事' })
    const empty = applySymbol('あ', 1, 1, 'bouten')
    expect(empty.value).toBe('あ《《》》')
    expect(empty.selection).toEqual({ start: 3, end: 3 })
  })

  it('逆向きの選択・範囲外の位置も扱う', () => {
    expect(applySymbol('あいう', 2, 1, 'bouten').value).toBe('あ《《い》》う')
    expect(applySymbol('あ', 9, 9, 'dash').value).toBe('あ――')
  })
})
