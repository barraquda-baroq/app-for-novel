import { describe, expect, it } from 'vitest'
import { parseRuby, stripRuby } from './ruby'
import { countChars, textStats } from './text'

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
})
