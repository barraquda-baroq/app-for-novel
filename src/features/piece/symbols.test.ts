// 記号ボタン: 入る文字と、入れた後のカーソル位置
import { describe, expect, it } from 'vitest'
import { parseRuby } from '../../domain/ruby'
import { countChars } from '../../domain/text'
import { EMPTY_HISTORY, record, redo, undo } from './history'
import { applySymbol, BRACKETS, DASH, ELLIPSIS, FULL_SPACE, isBracketKind, TOOLBAR, type InsertKind } from './symbols'

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

describe('括弧', () => {
  it('5種類をこの順で固定して持つ（《》は入れない）', () => {
    expect(BRACKETS.map((b) => b.kind)).toEqual(['kagi', 'nijukagi', 'maru', 'yama', 'nonome'])
    expect(BRACKETS.map((b) => [b.open.codePointAt(0), b.close.codePointAt(0)])).toEqual([
      [0x300c, 0x300d],
      [0x300e, 0x300f],
      [0xff08, 0xff09],
      [0x3008, 0x3009],
      [0x301d, 0x301f],
    ])
    expect(BRACKETS.map((b) => b.open + b.close).join('')).toBe('「」『』（）〈〉〝〟')
    expect(BRACKETS.some((b) => b.open === '《' || b.close === '》')).toBe(false)
    expect(BRACKETS.map((b) => b.name)).toEqual(['かぎ括弧', '二重かぎ括弧', '丸括弧', '山括弧', 'ちょんちょん括弧'])
    expect(isBracketKind('kagi')).toBe(true)
    expect(isBracketKind('ruby')).toBe(false)
  })

  it('記号バーの並びでは、空白とルビの間に「括弧」を置く', () => {
    expect(TOOLBAR).toEqual(['dash', 'ellipsis', 'space', 'brackets', 'ruby', 'bouten'])
  })

  it('選んでいない時は組を入れ、カーソルは間', () => {
    const r = applySymbol('あいう', 1, 1, 'kagi')
    expect(r.value).toBe('あ「」いう')
    expect(r.selection).toEqual({ start: 2, end: 2 })
    expect(r.splice).toEqual({ start: 1, removed: '', inserted: '「」' })
    expect(applySymbol('', 0, 0, 'nonome')).toMatchObject({ value: '〝〟', selection: { start: 1, end: 1 } })
    expect(applySymbol('あ', 1, 1, 'maru')).toMatchObject({ value: 'あ（）', selection: { start: 2, end: 2 } })
  })

  it('選んでいる時は選んだ文字を囲み、カーソルは閉じ括弧の後ろ', () => {
    const r = applySymbol('彼は猫だ', 2, 3, 'nijukagi')
    expect(r.value).toBe('彼は『猫』だ')
    expect(r.selection).toEqual({ start: 5, end: 5 })
    expect(r.splice).toEqual({ start: 2, removed: '猫', inserted: '『猫』' })
    // ルビ・傍点の記法を含んでいても、そのまま囲む
    expect(applySymbol('｜漢字《かんじ》', 0, 8, 'yama').value).toBe('〈｜漢字《かんじ》〉')
  })

  it('逆向きの選択・範囲外の位置も扱う', () => {
    expect(applySymbol('あいう', 2, 1, 'kagi')).toMatchObject({ value: 'あ「い」う', selection: { start: 4, end: 4 } })
    expect(applySymbol('あ', 9, 9, 'kagi')).toMatchObject({ value: 'あ「」', selection: { start: 2, end: 2 } })
    expect(applySymbol('あいう', -3, 99, 'maru').value).toBe('（あいう）')
  })

  it('選んだ範囲の終わりの改行は囲まずに、閉じ括弧の後ろに残す', () => {
    const r = applySymbol('一行目\n二行目\n', 0, 4, 'kagi')
    expect(r.value).toBe('「一行目」\n二行目\n')
    expect(r.selection).toEqual({ start: 5, end: 5 })
    expect(r.splice).toEqual({ start: 0, removed: '一行目', inserted: '「一行目」' })
    // 続いた改行もすべて外に残す。途中の改行は囲む
    expect(applySymbol('あ\nい\n\nう', 0, 5, 'maru').value).toBe('（あ\nい）\n\nう')
    // 改行だけを選んでいた時は、改行を消さずに範囲の初めに組を入れる
    expect(applySymbol('あ\n\nい', 1, 3, 'kagi')).toMatchObject({ value: 'あ「」\n\nい', selection: { start: 2, end: 2 } })
  })

  it('入れた手を巻き戻すと元の文字と選んでいた範囲に戻り、進むと囲んだ文字とカーソルに戻る', () => {
    const before = '彼は猫だ'
    const sel = { start: 2, end: 3 }
    for (const kind of BRACKETS.map((b) => b.kind) as InsertKind[]) {
      const r = applySymbol(before, sel.start, sel.end, kind)
      const h = record(EMPTY_HISTORY, {
        before,
        after: r.value,
        selBefore: sel,
        selAfter: r.selection,
        kind: 'symbol',
        splice: r.splice,
        at: 0,
      })
      const back = undo(h, r.value)!
      expect(back.value).toBe(before)
      expect(back.selection).toEqual(sel)
      const again = redo(back.history, back.value)!
      expect(again.value).toBe(r.value)
      expect(again.selection).toEqual(r.selection)
    }
  })

  it('今の記号の動きは変えない', () => {
    expect(applySymbol('あいう', 1, 2, 'space')).toMatchObject({ value: 'あ　う', selection: { start: 2, end: 2 } })
    expect(applySymbol('あ\n', 0, 2, 'bouten').value).toBe('《《あ\n》》')
  })
})
