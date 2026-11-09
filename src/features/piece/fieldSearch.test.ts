import { describe, expect, it } from 'vitest'
import { stripRuby } from '../../domain/ruby'
import {
  buildSearchIndex,
  findHits,
  firstEndingAfter,
  firstFrom,
  foldQuery,
  foldText,
  hitStatus,
  isFindShortcut,
  lastBefore,
  queryFromSelection,
  type Hit,
} from './fieldSearch'

/** raw の中で q を探した、元の本文の範囲 */
const ranges = (raw: string, q: string) => findHits(buildSearchIndex(raw), foldQuery(q)).hits.map((h) => [h.start, h.end])
const texts = (raw: string, q: string) => ranges(raw, q).map(([s, e]) => raw.slice(s, e))

describe('全角と半角をそろえる（foldText）', () => {
  it('全角の英数字・記号・空白は半角と同じ。英字の大文字と小文字も同じ', () => {
    expect(foldText('ＡＢＣ１２３！').text).toBe('abc123!')
    expect(foldText('AbC').text).toBe('abc')
    expect(foldText('あ　い').text).toBe('あ い')
    expect(ranges('ＡＢＣ１２３', 'abc')).toEqual([[0, 3]])
    expect(ranges('abc123', 'ＢＣ１')).toEqual([[1, 4]])
    expect(ranges('一　二 三', ' ')).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('半角カナは全角に、濁点・半濁点は前の文字と合わせる（元の位置は2文字分）', () => {
    const f = foldText('ｶﾞｷﾞﾊﾟ')
    expect(f.text).toBe('ガギパ')
    expect([...f.from]).toEqual([0, 2, 4])
    expect([...f.to]).toEqual([2, 4, 6])
    expect(ranges('ｶﾞｷﾞ', 'ギ')).toEqual([[2, 4]])
    expect(ranges('ガギ', 'ｷﾞ')).toEqual([[1, 2]])
    // 分解した形（か + 結合文字の濁点）も、合わせた形と同じ
    expect(ranges('がき', 'が')).toEqual([[0, 2]])
    // 合わせられない濁点はそのまま残す
    expect(foldText('aﾞ').text).toBe('a゙')
  })

  it('ひらがなとカタカナは区別する。…と ...、①と 1、〜と ～ は別の文字', () => {
    expect(ranges('かなとカナ', 'かな')).toEqual([[0, 2]])
    expect(ranges('かなとカナ', 'カナ')).toEqual([[3, 5]])
    expect(ranges('それは……', '...')).toEqual([])
    expect(ranges('①と1', '1')).toEqual([[2, 3]])
    expect(ranges('〜と～', '~')).toEqual([[2, 3]])
  })
})

describe('ルビ・傍点の記号を飛ばして探す（buildSearchIndex・findHits）', () => {
  const raw = '彼は｜漢字《かんじ》を書く'
  it('親文字で見つかり、親文字だけを選ぶ。読みでは見つからない', () => {
    expect(ranges(raw, '漢字')).toEqual([[3, 5]])
    expect(ranges(raw, 'は漢')).toEqual([[1, 4]])
    // 読みを挟む一致は、読みも含めて選ぶ
    expect(ranges(raw, '字を')).toEqual([[4, 11]])
    expect(ranges(raw, 'かんじ')).toEqual([])
    expect(ranges('東京《とうきょう》へ', '東京へ')).toEqual([[0, 10]])
  })

  it('傍点の中の文字で見つかる', () => {
    expect(ranges('《《強調》》', '強調')).toEqual([[2, 4]])
    expect(ranges('これは《《大事》》な話', 'は大')).toEqual([[2, 6]])
  })

  it('語に記法を書いても親文字で探す', () => {
    expect(ranges(raw, '｜漢字《かんじ》')).toEqual([[3, 5]])
    expect(foldQuery('《《強調》》')).toBe('強調')
  })

  it('重ねずに数える。空の語は0件。上限を超えたら capped', () => {
    expect(ranges('あああ', 'ああ')).toEqual([[0, 2]])
    expect(ranges('ああああ', 'ああ')).toEqual([
      [0, 2],
      [2, 4],
    ])
    expect(findHits(buildSearchIndex('あいう'), '')).toEqual({ hits: [], capped: false })
    const many = findHits(buildSearchIndex('あ'.repeat(12)), 'あ', 10)
    expect(many.hits).toHaveLength(10)
    expect(many.capped).toBe(true)
    expect(findHits(buildSearchIndex('あ'.repeat(10)), 'あ', 10).capped).toBe(false)
  })

  it('サロゲートペアの途中からは見つけない', () => {
    // 𠮷（D842 DFB7）の下位だけを語にしても見つからない
    expect(findHits(buildSearchIndex('𠮷'), '\udfb7').hits).toEqual([])
    expect(texts('𠮷野家の𠮷', '𠮷')).toEqual(['𠮷', '𠮷'])
  })
})

describe('前へ・次へ（firstFrom・lastBefore）', () => {
  const hits: Hit[] = [
    { start: 2, end: 3 },
    { start: 5, end: 6 },
    { start: 9, end: 10 },
  ]
  it('起点から後ろの最初、前の最後。端では反対の端へ戻る', () => {
    expect(firstFrom(hits, 0)).toBe(0)
    expect(firstFrom(hits, 5)).toBe(1)
    expect(firstFrom(hits, 6)).toBe(2)
    expect(firstFrom(hits, 10)).toBe(0)
    expect(lastBefore(hits, 10)).toBe(2)
    expect(lastBefore(hits, 5)).toBe(0)
    expect(lastBefore(hits, 2)).toBe(2)
    expect(firstFrom([], 0)).toBeNull()
    expect(lastBefore([], 0)).toBeNull()
  })

  it('本文欄のカーソルから次へ（firstEndingAfter）は、カーソルを中に含む一致か、その後ろの最初。端では先頭へ戻る', () => {
    const wide: Hit[] = [
      { start: 2, end: 4 },
      { start: 6, end: 9 },
    ]
    expect(firstEndingAfter(wide, 0)).toBe(0)
    // 一致の始まり・中はその一致、終わりは次の一致
    expect(firstEndingAfter(wide, 2)).toBe(0)
    expect(firstEndingAfter(wide, 3)).toBe(0)
    expect(firstEndingAfter(wide, 4)).toBe(1)
    expect(firstEndingAfter(wide, 7)).toBe(1)
    expect(firstEndingAfter(wide, 9)).toBe(0)
    expect(firstEndingAfter(wide, 20)).toBe(0)
    expect(firstEndingAfter([], 0)).toBeNull()
    // 前へは lastBefore（カーソルを中に含む一致はその一致、一致の始まりはその前）
    expect(lastBefore(wide, 7)).toBe(1)
    expect(lastBefore(wide, 6)).toBe(0)
  })
})

describe('件数の表記（hitStatus）', () => {
  const base = { query: '猫', total: 12, current: null, capped: false, pending: false }
  it('語が無ければ空、計算中・0件・件数・番号', () => {
    expect(hitStatus({ ...base, query: '' })).toBe('')
    expect(hitStatus({ ...base, pending: true })).toBe('差分を計算中…')
    expect(hitStatus({ ...base, total: 0 })).toBe('見つかりません')
    expect(hitStatus(base)).toBe('12件')
    expect(hitStatus({ ...base, current: 2 })).toBe('3／12')
    expect(hitStatus({ ...base, total: 9999, capped: true })).toBe('9,999+件')
    expect(hitStatus({ ...base, total: 9999, capped: true, current: 0 })).toBe('1／9,999+')
  })
})

describe('検索を開くキー（isFindShortcut）', () => {
  const key = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    key: 'f',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  })
  it('Mac は ⌘F だけ（Ctrl+F は1字進むのまま）、ほかは Ctrl+F だけ。Shift・Alt 付きは除く', () => {
    expect(isFindShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isFindShortcut(key({ ctrlKey: true }), true)).toBe(false)
    expect(isFindShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isFindShortcut(key({ key: 'F', ctrlKey: true }), false)).toBe(true)
    expect(isFindShortcut(key({ metaKey: true }), false)).toBe(false)
    expect(isFindShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isFindShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isFindShortcut(key({}), false)).toBe(false)
    expect(isFindShortcut(key({ key: 'g', ctrlKey: true }), false)).toBe(false)
  })
})

describe('選んだ文字を検索の語にする（queryFromSelection）', () => {
  it('1字以上100字以下で改行を含まない時だけ。記法は除く', () => {
    const raw = '彼は｜漢字《かんじ》を書く\n次の行'
    expect(queryFromSelection(raw, 2, 10)).toBe('漢字')
    expect(queryFromSelection(raw, 10, 2)).toBe('漢字')
    expect(queryFromSelection(raw, 3, 3)).toBeNull()
    expect(queryFromSelection(raw, 11, 15)).toBeNull()
    expect(queryFromSelection('あ'.repeat(101), 0, 101)).toBeNull()
    expect(queryFromSelection('あ'.repeat(100), 0, 100)).toBe('あ'.repeat(100))
  })

  it('記法を除いた後に残った《は ｜《 に戻し、探す時にもう一度記法として読んでも、選んだ所の親文字と同じ語になる', () => {
    const raw = '前に漢字｜《かな》と書く。漢字だけ。'
    const q = queryFromSelection(raw, 2, 9)!
    expect(q).toBe('漢字｜《かな》')
    expect(foldQuery(q)).toBe('漢字《かな》')
    expect(findHits(buildSearchIndex(raw), foldQuery(q)).hits).toEqual([{ start: 2, end: 9 }])
    const skill = '発動｜《鑑定》。発動した。'
    expect(ranges(skill, queryFromSelection(skill, 0, 7)!)).toEqual([[0, 7]])
    // 傍点の中の ｜ の後ろに《…》が続く時は、｜《 に戻すとルビと読まれるので、選んだ文字のまま
    expect(queryFromSelection('《《｜あ《い》》》', 0, 9)).toBe('《《｜あ《い》》》')
  })

  it('漢字の後ろでない《…》（記法ではない）は、もう一度読んでも変わらないので ｜ を足さず、選んだ文字のまま', () => {
    expect(queryFromSelection('あ《い》う', 0, 5)).toBe('あ《い》う')
    const raw = '彼は「スキル《鑑定》」を使った'
    const q = queryFromSelection(raw, 3, 10)!
    expect(q).toBe('スキル《鑑定》')
    expect(ranges(raw, q)).toEqual([[3, 10]])
  })

  it('語は100字を超えない（検索窓に打てる長さ）', () => {
    const plain = 'あ《い》'.repeat(25)
    expect(queryFromSelection(plain, 0, 100)).toBe(plain)
    // ｜《 に戻す《と、記法ではない《が混ざっていて、戻すと100字を超える時は、選んだ文字のまま
    const mixed = '漢｜《か》' + 'あ《い》'.repeat(23)
    expect(mixed.length).toBeLessThanOrEqual(100)
    const q = queryFromSelection(mixed, 0, mixed.length)!
    expect(q).toBe(mixed)
    expect(foldQuery(q)).toBe(foldText(stripRuby(mixed)).text)
    // 戻しても100字以内なら ｜《 に戻す
    expect(queryFromSelection('漢｜《か》あ《い》', 0, 9)).toBe('漢｜《か》あ｜《い》')
  })

  it('どこを選んでも、語をそろえたものは選んだ所の記法を除いてそろえたものと同じ', () => {
    const samples = [
      '前に漢字｜《かな》と書く',
      '彼は｜漢字《かんじ》を書く',
      '《《強調》》と《《｜《》》',
      '《《漢字《かな》》》後',
      '｜あ｜《い》う',
      'a|《b》|c《d》',
      '漢《かな》｜｜《x》',
      '東京《とうきょう》へ《行く》',
      '「スキル《鑑定》」と漢｜《か》',
    ]
    for (const raw of samples) {
      for (let s = 0; s < raw.length; s++) {
        for (let e = s + 1; e <= raw.length; e++) {
          const q = queryFromSelection(raw, s, e)
          const base = stripRuby(raw.slice(s, e))
          if (!base) expect(q).toBeNull()
          else expect([raw, s, e, foldQuery(q!)]).toEqual([raw, s, e, foldText(base).text])
          // もう一度読んでも変わらない時は、記法を除いた文字のまま（｜ を足さない）
          if (base && stripRuby(base) === base) expect([raw, s, e, q]).toEqual([raw, s, e, base])
        }
      }
    }
  })
})
