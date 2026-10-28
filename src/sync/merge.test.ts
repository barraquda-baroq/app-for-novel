import { describe, expect, it } from 'vitest'
import { decodeRecord, encodeRecord, hashRecord, splitJson, type ChunkDoc, type RecordDoc } from './codec'
import { contentEqual, deepEqual, mergeFields, mergeList, mergeRemote, stableStringify } from './merge'

const D = { device: 'テスト端末' }

describe('比較', () => {
  it('キーの順番と undefined の項目は問わない', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1, x: undefined }, { a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}')
  })
  it('contentEqual は更新日時を見ない', () => {
    expect(contentEqual({ id: 'a', updatedAt: 1 }, { id: 'a', updatedAt: 2 })).toBe(true)
    expect(contentEqual(null, null)).toBe(true)
    expect(contentEqual(null, { id: 'a' })).toBe(false)
  })
})

describe('並びのマージ', () => {
  const id = (x: unknown) => String(x)
  it('片方だけが変えたらその並び', () => {
    expect(mergeList(['a', 'b'], ['b', 'a'], ['a', 'b'], id)).toEqual(['b', 'a'])
    expect(mergeList(['a', 'b'], ['a', 'b'], ['a', 'b', 'c'], id)).toEqual(['a', 'b', 'c'])
  })
  it('両方が足したら両方入る（相手が足したものは相手の並びでの直前の要素の後ろ）', () => {
    expect(mergeList(['a', 'b'], ['a', 'b', 'm'], ['a', 't', 'b'], id)).toEqual(['a', 't', 'b', 'm'])
    expect(mergeList(['a'], ['m', 'a'], ['t', 'a'], id)).toEqual(['t', 'm', 'a'])
  })
  it('相手が消したものは消え、こちらが消したものは戻らない', () => {
    expect(mergeList(['a', 'b', 'c'], ['c', 'b', 'a'], ['a', 'c', 'd'], id)).toEqual(['c', 'd', 'a'])
    expect(mergeList(['a', 'b'], ['a'], ['b', 'a', 'x'], id)).toEqual(['a', 'x'])
  })
  it('中身を持つ要素は、こちらが変えていなければ相手の中身を使う', () => {
    const byId = (x: unknown) => (x as { id: string }).id
    const base = [
      { id: '1', v: 'a' },
      { id: '2', v: 'b' },
    ]
    const mine = [
      { id: '2', v: 'b' },
      { id: '1', v: 'a' },
    ]
    const theirs = [
      { id: '1', v: 'A' },
      { id: '2', v: 'b' },
      { id: '3', v: 'c' },
    ]
    expect(mergeList(base, mine, theirs, byId)).toEqual([
      { id: '2', v: 'b' },
      { id: '3', v: 'c' },
      { id: '1', v: 'A' },
    ])
  })
})

describe('レコードのマージ', () => {
  const base = { id: 't', name: '元', synopsis: '', structure: [{ type: 'piece', id: 'p1' }], updatedAt: 1 }
  it('別々の項目の変更は両方残る', () => {
    const mine = { ...base, name: 'こちら', updatedAt: 3 }
    const theirs = { ...base, synopsis: 'あちら', updatedAt: 2 }
    const r = mergeFields('titles', base, mine, theirs, D).record as typeof base
    expect(r.name).toBe('こちら')
    expect(r.synopsis).toBe('あちら')
    expect(r.updatedAt).toBe(3)
  })
  it('構成の並びは要素ごとに合わせる', () => {
    const mine = { ...base, structure: [...base.structure, { type: 'piece', id: 'm' }] }
    const theirs = { ...base, structure: [{ type: 'piece', id: 't' }, ...base.structure] }
    const r = mergeFields('titles', base, mine, theirs, D).record as typeof base
    expect(r.structure.map((n) => n.id)).toEqual(['t', 'p1', 'm'])
  })
  it('稿の本文が両方で変わっていたら、クラウド側を採って競合を知らせる', () => {
    const v = { id: 'v', body: '元', note: '', updatedAt: 1 }
    const mine = { ...v, body: 'こちら', note: 'メモ' }
    const theirs = { ...v, body: 'あちら' }
    const r = mergeRemote('versions', v, mine, theirs, D)
    expect((r.record as typeof v).body).toBe('あちら')
    expect((r.record as typeof v).note).toBe('メモ')
    expect((r.bodyConflict as typeof v).body).toBe('こちら')
  })
  it('同じ本文に変えていたら競合にしない', () => {
    const v = { id: 'v', body: '元', updatedAt: 1 }
    const mine = { ...v, body: '同じ' }
    const theirs = { ...v, body: '同じ', updatedAt: 5 }
    const r = mergeRemote('versions', v, mine, theirs, D)
    expect(r.bodyConflict).toBeUndefined()
  })
  it('削除と編集がぶつかったら削除を優先し、編集された内容を返す', () => {
    const m = { id: 'm', body: '元', updatedAt: 1 }
    const edited = { ...m, body: '追記' }
    expect(mergeRemote('memos', m, edited, null, D)).toEqual({ record: null, deletedEdit: edited })
    expect(mergeRemote('memos', m, null, edited, D)).toEqual({ record: null, deletedEdit: edited })
  })
  it('この端末で作ったもの（クラウドに無かったもの）は消さない', () => {
    const m = { id: 'm', body: '新しい' }
    expect(mergeRemote('memos', null, m, null, D)).toEqual({ record: m })
  })
  it('変えていなければクラウドの内容、クラウドが変わっていなければこの端末の内容', () => {
    const m = { id: 'm', body: '元', updatedAt: 1 }
    const t = { ...m, body: 'あちら', updatedAt: 2 }
    expect(mergeRemote('memos', m, m, t, D).record).toBe(t)
    const mine = { ...m, body: 'こちら' }
    expect(mergeRemote('memos', m, mine, { ...m, updatedAt: 9 }, D).record).toBe(mine)
  })
})

describe('文書の形', () => {
  it('大きなレコードは分割し、つなぎ直すと元に戻る（サロゲートペアを切らない）', () => {
    const rec = { id: 'v1', body: 'あ𠮷'.repeat(100) }
    const enc = encodeRecord(rec, 7)
    expect(enc.json).toBeNull()
    expect(enc.parts.length).toBeGreaterThan(10)
    for (const p of enc.parts) {
      const last = p.charCodeAt(p.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    const doc: RecordDoc = {
      table: 'versions',
      id: 'v1',
      json: null,
      chunks: enc.parts.length,
      deleted: false,
      hash: enc.hash,
      updated: null,
      device: 'd',
    }
    const chunk = (i: number): ChunkDoc => ({
      table: '_chunk',
      parent: 'versions:v1',
      index: i,
      json: enc.parts[i],
      hash: enc.hash,
      updated: null,
      device: 'd',
    })
    expect(decodeRecord(doc, chunk)).toEqual(rec)
    // 分割文書が揃わない・別の版の分割文書なら読み直しが要る
    expect(decodeRecord(doc, (i) => (i === 3 ? undefined : chunk(i)))).toBeUndefined()
    expect(decodeRecord(doc, (i) => ({ ...chunk(i), hash: 'old' }))).toBeUndefined()
  })
  it('指紋は内容が同じなら同じ', () => {
    const r1 = { id: 'a', x: 1, y: 2 }
    const r2 = { y: 2, id: 'a', x: 1 }
    const r3 = { id: 'a', x: 2 }
    expect(hashRecord(r1)).toBe(hashRecord(r2))
    expect(hashRecord(r1)).not.toBe(hashRecord(r3))
    expect(hashRecord(null)).toBe('')
    expect(splitJson('abcdef', 4)).toEqual(['abcd', 'ef'])
  })
})

describe('共通の履歴が無い時（初めてのログイン・アカウントの切り替え）', () => {
  const N = { device: 'iPhone', noHistory: true }
  it('クラウド側を採り、この端末にしか無い文章は控える', () => {
    const cloud = { id: 'm', body: '新しい', updatedAt: 5 }
    const local = { id: 'm', body: '古い', updatedAt: 9 }
    expect(mergeRemote('memos', null, local, cloud, N)).toEqual({ record: cloud, keptCopy: local })
    const mineV = { id: 'v', body: 'こちら' }
    const theirV = { id: 'v', body: 'あちら' }
    const v = mergeRemote('versions', null, mineV, theirV, N)
    expect(v.record).toEqual({ id: 'v', body: 'あちら' })
    expect(v.bodyConflict).toEqual({ id: 'v', body: 'こちら' })
  })
  it('同じ内容なら控えない。クラウドで削除されていれば削除を優先して控える', () => {
    const a = { id: 'm', body: '同じ', updatedAt: 1 }
    expect(mergeRemote('memos', null, a, { ...a, updatedAt: 2 }, N)).toEqual({ record: { ...a, updatedAt: 2 } })
    expect(mergeRemote('memos', null, a, null, N)).toEqual({ record: null, deletedEdit: a })
  })
  it('並びにはこの端末にしか無い要素を足す', () => {
    const cloud = { id: 'p', versionIds: ['v1', 'v2'] }
    const local = { id: 'p', versionIds: ['v1', 'mine'] }
    expect((mergeRemote('pieces', null, local, cloud, N).record as typeof cloud).versionIds).toEqual(['v1', 'mine', 'v2'])
  })
})

describe('長い文章の項目が両方で書き換えられた時', () => {
  it('クラウド側の文章の後ろに、この端末の文章を印付きでつなぐ', () => {
    const base = { id: 'm', name: 'メモ', body: '元', updatedAt: 1 }
    const mine = { ...base, body: 'こちらの追記' }
    const theirs = { ...base, body: 'あちらの追記' }
    const r = mergeRemote('memos', base, mine, theirs, D)
    expect((r.record as typeof base).body).toBe(
      'あちらの追記\n\n――――（同期の競合: テスト端末で同時に書かれた内容）――――\nこちらの追記',
    )
    expect(r.joined).toEqual(['body'])
  })
  it('名前のような短い項目は、この端末を優先する', () => {
    const base = { id: 'm', name: '元', body: '', updatedAt: 1 }
    const mine = { ...base, name: 'こちら' }
    const theirs = { ...base, name: 'あちら' }
    const r = mergeRemote('memos', base, mine, theirs, D)
    expect((r.record as typeof base).name).toBe('こちら')
    expect(r.joined).toBeUndefined()
  })
  it('同じ内容になっていれば、クラウドの内容そのもの（更新日時も）を使う', () => {
    const base = { id: 'm', body: '元', updatedAt: 1 }
    const theirs = { ...base, body: '同じ', updatedAt: 7 }
    const mine = { ...base, body: '同じ', updatedAt: 9 }
    expect(mergeRemote('memos', base, mine, theirs, D).record).toBe(theirs)
  })
})
