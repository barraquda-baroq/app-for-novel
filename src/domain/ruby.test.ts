import { describe, expect, it } from 'vitest'
import { parseRuby, strippedBody, stripRuby, stripRubyMap, stripRubyPositions } from './ruby'
import { bodyMetrics, countChars, textStats } from './text'

describe('ルビ・傍点の記法', () => {
  it('｜で始まるルビ・漢字の直後のルビ・傍点を分ける', () => {
    expect(parseRuby('彼は｜魔法使い《ウィザード》だった')).toEqual([
      { type: 'text', text: '彼は' },
      { type: 'ruby', base: '魔法使い', reading: 'ウィザード' },
      { type: 'text', text: 'だった' },
    ])
    expect(parseRuby('あの東京《とうきょう》へ')).toEqual([
      { type: 'text', text: 'あの' },
      { type: 'ruby', base: '東京', reading: 'とうきょう' },
      { type: 'text', text: 'へ' },
    ])
    expect(parseRuby('これは《《大事》》な話')).toEqual([
      { type: 'text', text: 'これは' },
      { type: 'bouten', text: '大事' },
      { type: 'text', text: 'な話' },
    ])
  })

  it('漢字でない文字の後の《》や、閉じていない記号はそのまま', () => {
    expect(stripRuby('あいう《えお》')).toBe('あいう《えお》')
    expect(stripRuby('｜途中《で改行\nした》')).toBe('｜途中《で改行\nした》')
    expect(stripRuby('《《閉じない')).toBe('《《閉じない')
  })

  it('｜《 は《そのもの', () => {
    expect(stripRuby('作品名は｜《銀河》です')).toBe('作品名は《銀河》です')
  })

  it('人名のような「々」や拡張漢字にも振れる', () => {
    expect(parseRuby('佐々木《ささき》')[0]).toEqual({ type: 'ruby', base: '佐々木', reading: 'ささき' })
    expect(parseRuby('𠮷野《よしの》')[0]).toEqual({ type: 'ruby', base: '𠮷野', reading: 'よしの' })
  })

  it('文字数は記号とルビの読みを除いて数える', () => {
    expect(countChars('｜魔法使い《ウィザード》と《《東京》》')).toBe(7)
    expect(countChars('東京《とうきょう》')).toBe(2)
    expect(textStats('｜魔法《まほう》\n《《傍点》》').chars).toBe(4)
  })

  it('稿などのレコードの、記号と読みを除いた本文はレコードごとに1回だけ作り、文字数と分け合う', () => {
    const record = { body: '｜魔法使い《ウィザード》と《《東京》》' }
    const first = strippedBody(record)
    expect(first).toBe('魔法使いと東京')
    expect(strippedBody(record)).toBe(first)
    // 同じ本文でも別のレコードなら作り直す（編集すると稿は新しいオブジェクトになる）
    expect(strippedBody({ body: '東京《とうきょう》' })).toBe('東京')
    // 記法のない本文は、そのままの文字列（写しを持たない）
    const plain = { body: 'ただの本文' }
    expect(strippedBody(plain)).toBe(plain.body)
  })

  it('記号を除くのは1回だけ（｜《 の後ろに漢字があっても、2回目の除き方でルビにしない）', () => {
    // 漢字｜《かな》 → 漢字《かな》（もう一度除くと「漢字」になってしまう）
    const record = { body: '漢字｜《かな》' }
    expect(strippedBody(record)).toBe('漢字《かな》')
    expect(bodyMetrics(record).chars).toBe(6)
    expect(textStats(record.body).chars).toBe(6)
    expect(bodyMetrics({ body: '漢字｜《かな》' }).chars).toBe(6)
  })
})

describe('stripRubyPositions（記法を除いた各文字の、元の本文での位置）', () => {
  const samples = [
    '',
    '地の文だけ',
    '彼は｜漢字《かんじ》を書く',
    '|半角《はんかく》の縦棒',
    '東京《とうきょう》へ行く',
    'これは《《強調》》な話',
    '｜《そのまま》と漢字｜《かな》',
    '《《閉じていない',
    '漢字《かんじ\n》改行をまたぐ',
    '｜途中《で改行\nした》',
    '𠮟《しか》られた𠮷',
    `｜${'長'.repeat(51)}《ながい》`,
    `漢字《${'よ'.repeat(101)}》`,
    '前｜漢字《かん》後《《点》》終',
  ]
  it('stripRuby と同じ本文になり、各文字は元の本文の同じ文字を指し、位置は前から順に増える', () => {
    for (const s of samples) {
      const m = stripRubyPositions(s)
      expect(m.text).toBe(stripRuby(s))
      expect(m.at.length).toBe(m.text.length)
      for (let i = 0; i < m.text.length; i++) {
        expect(s[m.at[i]]).toBe(m.text[i])
        if (i > 0) expect(m.at[i]).toBeGreaterThan(m.at[i - 1])
      }
      // 記法の範囲（stripRubyMap）の中にある
      const r = stripRubyMap(s)
      for (let i = 0; i < m.text.length; i++) {
        expect(m.at[i]).toBeGreaterThanOrEqual(r.start[i])
        expect(m.at[i]).toBeLessThan(r.end[i])
      }
    }
  })

  it('ルビの親文字・傍点の文字は記法の中のその文字を指し、読み・記号は出ない', () => {
    expect([...stripRubyPositions('彼は｜漢字《かんじ》を書く').at]).toEqual([0, 1, 3, 4, 10, 11, 12])
    expect([...stripRubyPositions('東京《とうきょう》へ').at]).toEqual([0, 1, 9])
    expect([...stripRubyPositions('これは《《強調》》な').at]).toEqual([0, 1, 2, 5, 6, 9])
    // ｜《 の《は《の位置
    const p = stripRubyPositions('a｜《b')
    expect(p.text).toBe('a《b')
    expect([...p.at]).toEqual([0, 2, 3])
    // サロゲートペアの漢字のルビ
    expect([...stripRubyPositions('𠮟《しか》る').at]).toEqual([0, 1, 6])
  })

  it('記法の無い本文は、位置がそのまま', () => {
    const m = stripRubyPositions('ただの本文')
    expect(m.text).toBe('ただの本文')
    expect([...m.at]).toEqual([0, 1, 2, 3, 4])
  })
})
