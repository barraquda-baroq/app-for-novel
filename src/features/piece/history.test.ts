// 巻き戻し／進むの履歴: まとめ方・区切り方・30手・カーソル位置
import { describe, expect, it } from 'vitest'
import {
  COALESCE_MS,
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  kindOfInput,
  record,
  redo,
  seal,
  spliceOf,
  undo,
  type History,
  type Sel,
} from './history'

const caret = (n: number): Sel => ({ start: n, end: n })

/** 1文字ずつ打つ（at から dt ミリ秒ごと） */
function typeChars(h: History, value: string, pos: number, text: string, at: number, dt = 100) {
  let v = value
  let p = pos
  let t = at
  for (const ch of text) {
    const next = v.slice(0, p) + ch + v.slice(p)
    h = record(h, { before: v, after: next, selBefore: caret(p), selAfter: caret(p + 1), inputType: 'insertText', at: t })
    v = next
    p += 1
    t += dt
  }
  return { h, value: v, pos: p, at: t }
}

describe('差分（1か所の置き換え）', () => {
  it('入力・削除・置き換えを求める', () => {
    expect(spliceOf('あいう', 'あいう')).toBeNull()
    expect(spliceOf('あう', 'あいう', 2, caret(1))).toEqual({ start: 1, removed: '', inserted: 'い' })
    expect(spliceOf('あいう', 'あう', 1, caret(2))).toEqual({ start: 1, removed: 'い', inserted: '' })
    expect(spliceOf('あいう', 'あXう', 2, { start: 1, end: 2 })).toEqual({ start: 1, removed: 'い', inserted: 'X' })
  })

  it('同じ文字が並ぶ所でも、カーソルの手前に入れたものとして求める', () => {
    // 「ああ|あ」に「あ」を足した（カーソルは3）
    expect(spliceOf('あああ', 'ああああ', 3)).toEqual({ start: 2, removed: '', inserted: 'あ' })
    // 選択範囲が分からなくても、カーソルの位置から求める
    expect(spliceOf('abcc', 'abccc', 4)).toEqual({ start: 3, removed: '', inserted: 'c' })
  })

  it('変更前の選択範囲が合わない時は、前後の一致から求める', () => {
    expect(spliceOf('春は曙', '春はあけぼの', 6, caret(0))).toEqual({ start: 2, removed: '曙', inserted: 'あけぼの' })
  })
})

describe('変更の種類', () => {
  it('inputType から決める（分からなければ差分から）', () => {
    const s = { start: 0, removed: '', inserted: 'a' }
    expect(kindOfInput('insertText', s)).toBe('type')
    expect(kindOfInput('insertLineBreak', { ...s, inserted: '\n' })).toBe('newline')
    expect(kindOfInput('insertText', { ...s, inserted: '\n' })).toBe('newline')
    expect(kindOfInput('insertFromPaste', s)).toBe('paste')
    expect(kindOfInput('deleteByCut', { ...s, removed: 'a', inserted: '' })).toBe('cut')
    expect(kindOfInput('deleteContentBackward', { ...s, removed: 'a', inserted: '' })).toBe('delete')
    expect(kindOfInput(undefined, { ...s, removed: 'a', inserted: '' })).toBe('delete')
    expect(kindOfInput(undefined, s)).toBe('type')
    expect(kindOfInput(undefined, { ...s, inserted: 'abc' })).toBe('other')
  })
})

describe('続けて打った文字をまとめる', () => {
  it('続けて打った文字は1手。巻き戻すと打つ前に戻り、カーソルも戻る', () => {
    const r = typeChars(EMPTY_HISTORY, '始まり。', 4, 'あいうえお', 1000)
    expect(r.value).toBe('始まり。あいうえお')
    expect(r.h.undo).toHaveLength(1)
    const u = undo(r.h, r.value)!
    expect(u.value).toBe('始まり。')
    expect(u.selection).toEqual(caret(4))
    const re = redo(u.history, u.value)!
    expect(re.value).toBe('始まり。あいうえお')
    expect(re.selection).toEqual(caret(9))
  })

  it('1秒以上の間が空いたら別の手にする', () => {
    let r = typeChars(EMPTY_HISTORY, '', 0, 'あい', 0)
    r = typeChars(r.h, r.value, r.pos, 'う', r.at + COALESCE_MS + 1)
    expect(r.h.undo).toHaveLength(2)
    expect(undo(r.h, r.value)!.value).toBe('あい')
  })

  it('改行・記号の挿入・カーソルの移動で区切る', () => {
    let r = typeChars(EMPTY_HISTORY, '', 0, 'あい', 0)
    // 改行
    let h = record(r.h, {
      before: r.value,
      after: 'あい\n',
      selBefore: caret(2),
      selAfter: caret(3),
      inputType: 'insertLineBreak',
      at: r.at,
    })
    r = typeChars(h, 'あい\n', 3, 'うえ', r.at + 10)
    expect(r.h.undo.map((s) => s.inserted)).toEqual(['あい', '\n', 'うえ'])
    // 記号の挿入
    h = record(r.h, { before: r.value, after: r.value + '――', selBefore: caret(5), selAfter: caret(7), kind: 'symbol', at: r.at })
    r = typeChars(h, r.value + '――', 7, 'お', r.at + 10)
    expect(r.h.undo.map((s) => s.inserted)).toEqual(['あい', '\n', 'うえ', '――', 'お'])
    // カーソルを動かした（同じ位置に戻って続けても別の手）
    r = typeChars(seal(r.h), r.value, r.pos, 'か', r.at + 10)
    expect(r.h.undo.map((s) => s.inserted)).toEqual(['あい', '\n', 'うえ', '――', 'お', 'か'])
  })

  it('離れた位置に打ったら別の手にする', () => {
    let r = typeChars(EMPTY_HISTORY, 'あいう', 3, 'え', 0)
    r = typeChars(r.h, r.value, 0, '「', r.at)
    expect(r.h.undo).toHaveLength(2)
  })

  it('Backspace・Delete を続けたら1手', () => {
    let h: History = EMPTY_HISTORY
    let v = 'あいうえお'
    // Backspace を3回（お・え・う）
    for (let p = 5; p > 2; p--) {
      const next = v.slice(0, p - 1) + v.slice(p)
      h = record(h, {
        before: v,
        after: next,
        selBefore: caret(p),
        selAfter: caret(p - 1),
        inputType: 'deleteContentBackward',
        at: 10 * p,
      })
      v = next
    }
    expect(h.undo).toHaveLength(1)
    expect(h.undo[0]).toMatchObject({ start: 2, removed: 'うえお', inserted: '' })
    expect(undo(h, v)!.value).toBe('あいうえお')
    // Delete を続けた
    let h2: History = EMPTY_HISTORY
    let w = 'あいうえお'
    for (let i = 0; i < 2; i++) {
      const next = w.slice(0, 1) + w.slice(2)
      h2 = record(h2, {
        before: w,
        after: next,
        selBefore: caret(1),
        selAfter: caret(1),
        inputType: 'deleteContentForward',
        at: i,
      })
      w = next
    }
    expect(h2.undo).toHaveLength(1)
    expect(h2.undo[0]).toMatchObject({ start: 1, removed: 'いう' })
  })

  it('打った後の削除・貼り付け・日本語入力の確定は別の手', () => {
    const r = typeChars(EMPTY_HISTORY, '', 0, 'あい', 0)
    let h = record(r.h, {
      before: 'あい',
      after: 'あ',
      selBefore: caret(2),
      selAfter: caret(1),
      inputType: 'deleteContentBackward',
      at: r.at,
    })
    h = record(h, {
      before: 'あ',
      after: 'あ貼り付け',
      selBefore: caret(1),
      selAfter: caret(5),
      inputType: 'insertFromPaste',
      at: r.at,
    })
    // 日本語入力は変換を確定した時の1手（続けて確定しても別の手）
    h = record(h, {
      before: 'あ貼り付け',
      after: 'あ貼り付け漢字',
      selBefore: caret(5),
      selAfter: caret(7),
      kind: 'ime',
      at: r.at,
    })
    h = record(h, {
      before: 'あ貼り付け漢字',
      after: 'あ貼り付け漢字変換',
      selBefore: caret(7),
      selAfter: caret(9),
      kind: 'ime',
      at: r.at,
    })
    expect(h.undo.map((s) => s.kind)).toEqual(['type', 'delete', 'paste', 'ime', 'ime'])
    expect(undo(h, 'あ貼り付け漢字変換')!.value).toBe('あ貼り付け漢字')
  })

  it('選択範囲を置き換えて打ち始めた文字も、続けた分は1手', () => {
    let h = record(EMPTY_HISTORY, {
      before: 'あいう',
      after: 'あXう',
      selBefore: { start: 1, end: 2 },
      selAfter: caret(2),
      inputType: 'insertText',
      at: 0,
    })
    h = record(h, { before: 'あXう', after: 'あXYう', selBefore: caret(2), selAfter: caret(3), inputType: 'insertText', at: 50 })
    expect(h.undo).toHaveLength(1)
    const u = undo(h, 'あXYう')!
    expect(u.value).toBe('あいう')
    // 選択していた範囲に戻る
    expect(u.selection).toEqual({ start: 1, end: 2 })
  })
})

describe('30手まで', () => {
  it('古い手から捨て、30手だけ戻せる。戻した手は進むでやり直せる', () => {
    let h: History = EMPTY_HISTORY
    let v = ''
    for (let i = 0; i < 35; i++) {
      const next = `${v}――`
      h = record(h, { before: v, after: next, selBefore: caret(v.length), selAfter: caret(next.length), kind: 'symbol', at: i })
      v = next
    }
    expect(h.undo).toHaveLength(HISTORY_LIMIT)
    let value = v
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      const u = undo(h, value)!
      h = u.history
      value = u.value
    }
    expect(value).toBe('――'.repeat(5))
    expect(undo(h, value)).toBeNull()
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      const r = redo(h, value)!
      h = r.history
      value = r.value
    }
    expect(value).toBe(v)
    expect(redo(h, value)).toBeNull()
  })

  it('戻した後に書くと、進むの履歴は消える', () => {
    const r = typeChars(EMPTY_HISTORY, '', 0, 'あ', 0)
    const u = undo(r.h, r.value)!
    expect(u.history.redo).toHaveLength(1)
    const h = record(u.history, {
      before: '',
      after: 'い',
      selBefore: caret(0),
      selAfter: caret(1),
      inputType: 'insertText',
      at: 10_000,
    })
    expect(h.redo).toHaveLength(0)
  })
})
