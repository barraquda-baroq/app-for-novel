import { describe, expect, it } from 'vitest'
import { addPointAt, displayValue, normalizedOffset, previewActs, rawOffset, segmentsOf } from './separateLogic'

describe('セパレート画面の計算', () => {
  it('入力欄の位置（改行は LF）と元の本文（CRLF）の位置を行き来できる', () => {
    const raw = 'あ\r\nい\rう\nえ'
    expect(displayValue(raw)).toBe('あ\nい\nう\nえ')
    // 「い」の前
    expect(rawOffset(raw, 2)).toBe(3)
    expect(normalizedOffset(raw, 3)).toBe(2)
    for (let n = 0; n <= displayValue(raw).length; n++) expect(normalizedOffset(raw, rawOffset(raw, n))).toBe(n)
    expect(rawOffset('', 3)).toBe(0)
  })

  it('区切りと、分けた後の幕の一覧（最初の行・文字数）', () => {
    const body = '一行目\n続き\n\n二幕目の始まり'
    const segs = segmentsOf(body, [7])
    expect(segs.map((s) => s.text)).toEqual(['一行目\n続き\n', '\n二幕目の始まり'])
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 7],
      [7, body.length],
    ])
    expect(previewActs(segs)).toEqual([
      { number: 1, firstLine: '一行目', chars: 5 },
      { number: 2, firstLine: '二幕目の始まり', chars: 7 },
    ])
    expect(previewActs(segs, 3).map((p) => p.number)).toEqual([3, 4])
    expect(previewActs(segmentsOf('あ'.repeat(50), []), 1, 10)[0].firstLine).toBe(`${'あ'.repeat(10)}…`)
  })

  it('カーソルの位置に分割点を足す（先頭・末尾・同じ位置・CRLF の本文）', () => {
    const body = '第一\r\n第二\r\n第三'
    // 区切り0の「第二」の前（入力欄では 3 文字目）
    const r = addPointAt(body, [], 0, 3)
    expect(r).toEqual({ ok: true, points: [4] })
    if (!r.ok) return
    // 区切り1（「第二\r\n第三」）の「第三」の前
    const r2 = addPointAt(body, r.points, 1, 3)
    expect(r2).toEqual({ ok: true, points: [4, 8] })
    expect(addPointAt(body, [], 0, 0)).toEqual({ ok: false, message: '先頭では区切れません' })
    expect(addPointAt(body, [], 0, displayValue(body).length)).toEqual({ ok: false, message: '末尾では区切れません' })
    // 区切りの先頭（＝今ある分割点）
    expect(addPointAt(body, [4], 1, 0)).toEqual({ ok: false, message: 'そこはもう区切ってあります' })
    expect(addPointAt(body, [4], 0, 3)).toEqual({ ok: false, message: 'そこはもう区切ってあります' })
    expect(addPointAt(body, [], 5, 0)).toEqual({ ok: false, message: '区切りたい所にカーソルを置いてください' })
  })
})
