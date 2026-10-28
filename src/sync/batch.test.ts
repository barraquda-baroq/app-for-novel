// 1回のトランザクションで送るものの選び方と、書くものの決め方（幕のまとまりは全部か、1つも書かない）
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboxItem } from '../db/persistence'
import { decideBatch, selectBatch, type CloudState } from './batch'
import { hashRecord } from './codec'

const item = (k: string, local: unknown, base: unknown = null, more: Partial<OutboxItem> = {}): OutboxItem => {
  const [table, id] = k.split('/')
  return {
    k,
    table: table as OutboxItem['table'],
    id,
    base: base as OutboxItem['base'],
    local: local as OutboxItem['local'],
    noHistory: false,
    force: false,
    ...more,
  }
}
const limits = { chunkSize: 250_000, maxChars: 1_500_000, maxDocs: 400 }
const same = (it: OutboxItem): CloudState => ({ exists: it.base !== null, hash: hashRecord(it.base) })
const changed: CloudState = { exists: true, hash: 'changed' }

afterEach(() => vi.restoreAllMocks())

describe('送るものを選ぶ', () => {
  it('送る必要の無いものは飛ばし、上限に収まるだけ取る。まとまりは分けない', () => {
    const items = [
      item('memos/a', { id: 'a', body: 'x'.repeat(10) }),
      item('memos/idle', { id: 'idle' }, { id: 'idle' }),
      item('versions/v', { id: 'v', body: 'y'.repeat(30) }, null, { group: 'pieces/E' }),
      item('pieces/E', { id: 'E', actIds: ['a1'] }, { id: 'E' }, { group: 'pieces/E' }),
      item('titles/t', { id: 't' }),
    ]
    expect(selectBatch(items, limits).map((b) => b.it.k)).toEqual(['memos/a', 'versions/v', 'pieces/E', 'titles/t'])
    // 文書の数の上限: まとまりが入らなければ、その前で止める（次の回に送る）
    expect(selectBatch(items, { ...limits, maxDocs: 2 }).map((b) => b.it.k)).toEqual(['memos/a'])
  })

  it('まとまりだけで上限を超える時は、ゴミ箱の件を先に送り、それでも超えれば1件ずつ送る', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const g = { group: 'pieces/E' }
    const items = [
      item('trashRecords/r', { id: 'r' }, null, g),
      item('trashEntries/t', { id: 't' }, null, g),
      item('versions/v', { id: 'v' }, null, g),
      item('pieces/E', { id: 'E', actIds: ['a1'] }, { id: 'E' }, g),
    ]
    const first = selectBatch(items, { ...limits, maxDocs: 3 })
    expect(first.map((b) => b.it.k)).toEqual(['trashRecords/r', 'trashEntries/t'])
    expect(first.every((b) => b.it.group === undefined)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    const rest = selectBatch(items.slice(2), { ...limits, maxDocs: 1 })
    expect(rest.map((b) => b.it.k)).toEqual(['versions/v'])
    expect(rest[0].it.group).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('書くものを決める', () => {
  it('まとまりは全部を書ける時だけ書き、書けなかったものだけを返す', () => {
    const g = { group: 'pieces/E' }
    const batch = selectBatch(
      [
        item('memos/a', { id: 'a', body: 'x' }, { id: 'a' }),
        item('versions/v', { id: 'v' }, null, g),
        item('pieces/E', { id: 'E', actIds: ['a1'] }, { id: 'E' }, g),
      ],
      limits,
    )
    const ok = decideBatch(
      batch,
      batch.map((b) => same(b.it)),
    )
    expect(ok.write).toEqual([true, true, true])
    expect(ok.conflicts).toEqual([])
    // 話がクラウドで変わっていた: 幕の稿も書かない（書けなかったのは話だけ）。まとまりでないものは書く
    const held = decideBatch(batch, [same(batch[0].it), same(batch[1].it), changed])
    expect(held.write).toEqual([true, false, false])
    expect(held.conflicts.map((c) => c.k)).toEqual(['pieces/E'])
  })

  it('共通の履歴が無いものはクラウドに何も無い時だけ、復元の後は必ず書く', () => {
    const batch = selectBatch(
      [
        item('memos/n', { id: 'n' }, null, { noHistory: true }),
        item('memos/f', { id: 'f' }, { id: 'f' }, { force: true }),
        item('memos/d', null, { id: 'd' }),
      ],
      limits,
    )
    const r = decideBatch(batch, [{ exists: true, hash: 'x' }, changed, { exists: true, hash: hashRecord({ id: 'd' }) }])
    expect(r.write).toEqual([false, true, true])
    expect(r.conflicts.map((c) => c.k)).toEqual(['memos/n'])
    // クラウドで削除されていた（削除の印だけ）: base（削除される前の内容）と違うので書かない
    const tomb = decideBatch(batch.slice(2), [{ exists: true, hash: '' }])
    expect(tomb.write).toEqual([false])
  })
})
