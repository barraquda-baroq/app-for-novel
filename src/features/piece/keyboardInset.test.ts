// 画面キーボードに隠れる高さ（記号バーをキーボードのすぐ上に出すため）
import { describe, expect, it } from 'vitest'
import { keyboardInset } from './keyboardInset'

describe('キーボードに隠れる高さ', () => {
  it('iOS: 画面は縮まず、見えている範囲だけが縮む', () => {
    expect(keyboardInset(844, { height: 514, offsetTop: 0, scale: 1 })).toBe(330)
    // 見えている範囲が下へずれている（入力欄に合わせてスクロールした）分は除く
    expect(keyboardInset(844, { height: 514, offsetTop: 100, scale: 1 })).toBe(230)
  })

  it('Android（画面そのものが縮む）・キーボードを閉じている時は 0', () => {
    expect(keyboardInset(520, { height: 520, offsetTop: 0, scale: 1 })).toBe(0)
    expect(keyboardInset(844, { height: 844, offsetTop: 0, scale: 1 })).toBe(0)
  })

  it('拡大している時は測らない', () => {
    expect(keyboardInset(844, { height: 400, offsetTop: 0, scale: 2 })).toBe(0)
  })
})
