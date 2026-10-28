import { describe, expect, it } from 'vitest'
import { parseRuby, strippedBody, stripRuby } from './ruby'
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
