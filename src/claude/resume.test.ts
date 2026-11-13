import { describe, expect, it } from 'vitest'
import { blockAt, findNear, joinBlocks, prefixPrint, relocate } from './resume'

const items = (...keys: string[]) => keys.map((key) => ({ key }))

describe('続きの区切りを id で探し直す（relocate）', () => {
  // 前回: A B | C D（A・B を読み、続きは C）
  const before = items('A', 'B', 'C', 'D')
  const print = prefixPrint(before, 2)

  it('前に読んだ区切りの集まりが同じなら黙って続ける（読んだ区切り同士・まだの区切り同士の並べ替え、後ろに足した区切りは問わない）', () => {
    expect(relocate(before, 2, print, true)).toEqual({ kind: 'same', index: 2 })
    const now = items('B', 'A', 'C', 'E', 'D')
    expect(relocate(now, findNear(now, 'C', 2), print, false)).toEqual({ kind: 'same', index: 2 })
  })

  it('区切りの始めからなら、まだ読んでいない区切りが前へ動いて入っても、読んだ区切りのすぐ後から黙って続ける', () => {
    const now = items('A', 'B', 'D', 'C')
    expect(relocate(now, 3, print, true)).toEqual({ kind: 'same', index: 2 })
    // 区切りの途中まで読んでいたら、その区切りの続きから（前に入った区切りを知らせる）
    expect(relocate(now, 3, print, false)).toEqual({ kind: 'added', index: 3, item: 2 })
  })

  it('前に1つ入った・読んだ1つが後ろへ動いた・それ以外', () => {
    const added = items('P', 'A', 'B', 'C', 'D')
    expect(relocate(added, 3, print, true)).toEqual({ kind: 'added', index: 3, item: 0 })
    const again = items('B', 'C', 'A', 'D')
    expect(relocate(again, 1, print, true)).toEqual({ kind: 'again', index: 1, item: 2 })
    // 読んだ区切りが削除された（どこにも無い）: 何が変わったかは分からないので、それ以外
    const removed = items('B', 'C', 'D')
    expect(relocate(removed, 1, print, true)).toEqual({ kind: 'changed', index: 1 })
    const many = items('P', 'Q', 'A', 'B', 'C', 'D')
    expect(relocate(many, 4, print, true)).toEqual({ kind: 'changed', index: 4 })
  })

  it('続きの区切りが無い: 前に読んだ区切りが同じなら、そのすぐ後（次の区切り）から', () => {
    expect(relocate(items('A', 'B', 'D'), -1, print, true)).toEqual({ kind: 'gone', index: 2, same: true })
    expect(relocate(items('A', 'B'), -1, print, true)).toEqual({ kind: 'gone', index: 2, same: true })
    expect(relocate(items('B', 'D'), -1, print, true)).toEqual({ kind: 'gone', index: 2, same: false })
  })

  it('指紋が読めなければ null。同じ id の区切りがいくつかあれば、前回の番号に近いもの', () => {
    expect(relocate(before, 2, 'xyz', true)).toBeNull()
    expect(relocate(before, 2, undefined, true)).toBeNull()
    expect(findNear(items('C', 'A', 'B', 'C'), 'C', 2)).toBe(3)
    expect(findNear(items('A'), 'C', 0)).toBe(-1)
  })
})

describe('つないだ文の中の区切り（joinBlocks・blockAt）', () => {
  it('頭・まとまりの見出し・区切りを改行でつなぎ、区切りごとの位置を返す（まとまりの最初の区切りは見出しの行から読み直す）', () => {
    const r = joinBlocks('=== 頭 ===', [
      {
        title: '--- 観点「構成」（2件）---',
        items: [
          { key: 'a1', text: '#### 構成\n本文1' },
          { key: 'a2', text: '#### 構成\n本文2' },
        ],
      },
      { title: '--- 観点「文体」（1件）---', items: [{ key: 'a3', text: '#### 文体\n本文3' }] },
    ])
    expect(r.text).toBe(
      [
        '=== 頭 ===',
        '--- 観点「構成」（2件）---',
        '#### 構成\n本文1',
        '#### 構成\n本文2',
        '--- 観点「文体」（1件）---',
        '#### 文体\n本文3',
      ].join('\n'),
    )
    expect(r.blocks.map((b) => b.key)).toEqual(['', 'a1', 'a2', 'a3'])
    for (const b of r.blocks.slice(1)) expect(r.text.slice(b.start, b.start + b.text.length)).toBe(b.text)
    expect(r.text.slice(r.blocks[1].from).startsWith('--- 観点「構成」')).toBe(true)
    expect(r.blocks[2].from).toBe(r.blocks[2].start)
    expect(r.text.slice(r.blocks[3].from).startsWith('--- 観点「文体」')).toBe(true)
    expect(blockAt(r.blocks, 0)).toBe(0)
    expect(blockAt(r.blocks, r.blocks[1].from)).toBe(1)
    expect(blockAt(r.blocks, r.blocks[2].start + 3)).toBe(2)
    expect(blockAt(r.blocks, r.text.length)).toBe(3)
  })
})
