// ゴミ箱へ移す依頼（2.7）をアプリで処理する: 確かめてから作者の削除と同じ形でゴミ箱へ入れ、依頼を消す。
import { describe, expect, it } from 'vitest'
import { trashRequestId } from '../claude/derivedId'
import { buildTrashRequests } from '../claude/trashRequest'
import { addBenchWork, deleteBenchAnalysis, updateBenchAnalysis } from './benchOps'
import { applyTrashRequests, trashRequestNotice, type TrashRequestOutcome } from './claudeTrash'
import { addMaterial } from './materialOps'
import { restoreTrashEntry } from './trash'
import { emptyData, type AppData, type BenchAnalysis, type MaterialNote, type TrashRequest } from './types'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 9, 3, 0, 0)

function analysis(workId: string, id: string, over: Partial<BenchAnalysis> = {}): BenchAnalysis {
  return {
    id,
    workId,
    viewpoint: '構成',
    body: '三幕。',
    runDate: '2026-10-30',
    source: 'claude',
    v: 1,
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

function note(materialId: string, id: string): MaterialNote {
  return {
    id,
    materialId,
    section: '要約',
    body: '第1章。',
    runDate: '2026-10-31',
    source: 'claude',
    v: 1,
    createdAt: 100,
    updatedAt: 100,
  }
}

/** 作品と資料に Claude のカードがあり、コネクタが依頼を作った（依頼は作った順に1ずつ時刻をずらす） */
function requested(cards: string[], extra: Record<string, BenchAnalysis> = {}) {
  const w = addBenchWork(emptyData(), { name: '銀河の果て', author: '山田' })
  const m = addMaterial(w.data, { name: '外科の歴史', author: '高橋' })
  let data: AppData = {
    ...m.data,
    benchAnalyses: { a1: analysis(w.result, 'a1'), a2: analysis(w.result, 'a2', { viewpoint: '文体' }), ...extra },
    materialNotes: { k1: note(m.result, 'k1') },
  }
  const built = buildTrashRequests(data, { cards }, { now: NOW - 1000, trash: {}, wasDeleted: () => false, dailyLeft: 100 })
  const reqs: Record<string, TrashRequest> = {}
  built.records.forEach((r, i) => (reqs[r.record.id] = { ...r.record, createdAt: r.record.createdAt + i }))
  data = { ...data, trashRequests: reqs }
  return { data, workId: w.result, materialId: m.result }
}

const statuses = (r: TrashRequestOutcome[]) => r.map((o) => [o.targetId, o.status])

describe('applyTrashRequests', () => {
  it('分析と記録を作者の削除と同じ形でゴミ箱へ移し、Claude の依頼の印と依頼から決めた id を付け、依頼を消す', () => {
    const s = requested(['a1', 'k1'])
    const reqA = trashRequestId('benchAnalyses', 'a1')
    const reqK = trashRequestId('materialNotes', 'k1')
    const r = applyTrashRequests(s.data, NOW)
    expect(statuses(r.result)).toEqual([
      ['a1', 'moved'],
      ['k1', 'moved'],
    ])
    const d = r.data
    expect(d.trashRequests).toEqual({})
    expect(d.benchAnalyses.a1).toBeUndefined()
    expect(d.benchAnalyses.a2).toBeDefined()
    expect(d.materialNotes.k1).toBeUndefined()
    expect(d.trashEntries[`te-${reqA}`]).toEqual({
      id: `te-${reqA}`,
      kind: 'benchAnalysis',
      label: '構成（2026-10-30）',
      titleName: '',
      parentLabel: '銀河の果て',
      origin: { titleId: null, index: -1, workId: s.workId },
      recordIds: [`tr-${reqA}`],
      reason: 'deleted',
      by: 'claude',
      deletedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(d.trashRecords[`tr-${reqA}`]).toMatchObject({
      entryId: `te-${reqA}`,
      table: 'benchAnalyses',
      record: s.data.benchAnalyses.a1,
    })
    expect(d.trashEntries[`te-${reqK}`]).toMatchObject({
      kind: 'materialNote',
      parentLabel: '外科の歴史',
      origin: { titleId: null, index: -1, materialId: s.materialId },
      by: 'claude',
    })
    // 作者の削除と、印と id のほかは同じ形
    const byAuthor = deleteBenchAnalysis(s.data, 'a1')
    const authorEntry = Object.values(byAuthor.trashEntries)[0]
    const { id: _a, by: _b, deletedAt: _c, createdAt: _d, updatedAt: _e, recordIds: _f, ...shape } = d.trashEntries[`te-${reqA}`]
    const { id: _g, deletedAt: _h, createdAt: _i, updatedAt: _j, recordIds: _k, ...authorShape } = authorEntry
    void [_a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k]
    expect(shape).toEqual(authorShape)
    expect(authorEntry.by).toBeUndefined()
    // ゴミ箱から戻せる
    const back = restoreTrashEntry(d, `te-${reqA}`)
    expect(back.data.benchAnalyses.a1).toEqual(s.data.benchAnalyses.a1)
  })

  it('カードが無い・もうゴミ箱にある・Claude でない・直した・依頼の後に直した時は、依頼だけ消して移さない', () => {
    const s = requested(['a1', 'a2', 'k1'])
    let data = deleteBenchAnalysis(s.data, 'a1')
    data = updateBenchAnalysis(data, 'a2', { body: '作者が直した' })
    data = { ...data, materialNotes: {} }
    const r = applyTrashRequests(data, NOW)
    expect(statuses(r.result)).toEqual([
      ['a1', 'in_trash'],
      ['a2', 'edited'],
      ['k1', 'not_found'],
    ])
    expect(r.data.trashRequests).toEqual({})
    expect(r.data.benchAnalyses.a2.body).toBe('作者が直した')
    expect(Object.values(r.data.trashEntries).filter((e) => e.by === 'claude')).toEqual([])

    const t = requested(['a1'], { m1: analysis('x', 'm1', { source: 'manual' }) })
    const forged = { ...Object.values(t.data.trashRequests)[0], id: 'cz-forged', targetId: 'm1', parentId: 'x' }
    const changed = { ...Object.values(t.data.trashRequests)[0], id: 'cz-changed', targetUpdatedAt: 50 }
    const r2 = applyTrashRequests({ ...t.data, trashRequests: { [forged.id]: forged, [changed.id]: changed } }, NOW)
    expect(r2.result.map((o) => o.status).sort()).toEqual(['changed', 'not_claude'])
    expect(r2.data.benchAnalyses.m1).toBeDefined()
    expect(r2.data.benchAnalyses.a1).toBeDefined()
  })

  it('その日（日本時間）に Claude の依頼で移した件が100件になったら、残りは移さない（日付が変われば戻る）', () => {
    const s = requested(['a1', 'a2'])
    const entries: AppData['trashEntries'] = {}
    for (let i = 0; i < 99; i++)
      entries[`e${i}`] = {
        id: `e${i}`,
        kind: 'benchAnalysis',
        label: 'x',
        titleName: '',
        origin: { titleId: null, index: -1 },
        recordIds: [],
        reason: 'deleted',
        by: 'claude',
        deletedAt: NOW - 60_000,
        createdAt: NOW - 60_000,
        updatedAt: NOW - 60_000,
      }
    const data = { ...s.data, trashEntries: entries }
    const r = applyTrashRequests(data, NOW)
    expect(statuses(r.result)).toEqual([
      ['a1', 'moved'],
      ['a2', 'over_limit'],
    ])
    expect(r.data.benchAnalyses.a2).toBeDefined()
    // 次の日は数え直す
    const next = applyTrashRequests(data, NOW + DAY)
    expect(statuses(next.result)).toEqual([
      ['a1', 'moved'],
      ['a2', 'moved'],
    ])
  })

  it('新しい版の依頼は触らずに残し、形の違う依頼は消す。何も変わらなければ同じ data を返す', () => {
    const s = requested(['a1'])
    const req = Object.values(s.data.trashRequests)[0]
    const newer = { ...req, id: 'cz-newer', v: 2 }
    const broken = { id: 'cz-broken', table: 'titles' } as unknown as TrashRequest
    const data = { ...s.data, trashRequests: { [newer.id]: newer, [broken.id]: broken } }
    const r = applyTrashRequests(data, NOW)
    expect(r.result).toEqual([{ requestId: 'cz-broken', status: 'invalid' }])
    expect(Object.keys(r.data.trashRequests)).toEqual(['cz-newer'])
    expect(r.data.benchAnalyses.a1).toBeDefined()
    const again = applyTrashRequests(r.data, NOW)
    expect(again.data).toBe(r.data)
    expect(again.result).toEqual([])
    const empty = emptyData()
    expect(applyTrashRequests(empty, NOW).data).toBe(empty)
  })

  it('同じ依頼を2つの端末が処理しても、同じ id のゴミ箱の1件になる', () => {
    const s = requested(['a1'])
    const a = applyTrashRequests(s.data, NOW)
    const b = applyTrashRequests(s.data, NOW + 5_000)
    expect(Object.keys(a.data.trashEntries)).toEqual(Object.keys(b.data.trashEntries))
    expect(Object.keys(a.data.trashRecords)).toEqual(Object.keys(b.data.trashRecords))
  })
})

describe('trashRequestNotice', () => {
  it('移した数を表ごとに、移さなかった数を理由ごとに（カードが無い・もうゴミ箱にあるは知らせない）', () => {
    const o = (status: TrashRequestOutcome['status'], table: 'benchAnalyses' | 'materialNotes' = 'benchAnalyses') =>
      ({ requestId: 'x', status, table }) as TrashRequestOutcome
    expect(trashRequestNotice([o('moved'), o('moved'), o('moved', 'materialNotes')])).toBe(
      'Claude の依頼で、相対比較の分析2件・資料の記録1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）',
    )
    expect(trashRequestNotice([o('moved'), o('edited'), o('edited'), o('over_limit')])).toBe(
      'Claude の依頼で、相対比較の分析1件をゴミ箱へ移しました（30日はゴミ箱から戻せます）。Claude の依頼のうち3件は移しませんでした（作者が直したカード2件・1日の上限（100件）を超えた1件）',
    )
    expect(trashRequestNotice([o('not_found'), o('in_trash')])).toBe('')
    expect(trashRequestNotice([])).toBe('')
  })
})
