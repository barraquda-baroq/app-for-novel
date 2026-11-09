// ゴミ箱へ移す依頼（2.7）の作り方（コネクタの novel_move_cards_to_trash が使う buildTrashRequests）と、依頼の出ているカード。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../domain/benchOps'
import { addMaterial } from '../domain/materialOps'
import { emptyData, type AppData, type BenchAnalysis, type MaterialNote, type TrashRequest } from '../domain/types'
import { trashRequestId } from './derivedId'
import { shortId } from './refs'
import { buildTrashRequests, trashCardLabel, trashEntryIdsOf, trashTargetProblem, type TrashContext } from './trashRequest'
import { isTrashRequest, liveTrashRequests, pendingTrashCount, pendingTrashTargets } from './trashTargets'
import { claudeView } from './visibility'

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

function note(materialId: string, id: string, over: Partial<MaterialNote> = {}): MaterialNote {
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
    ...over,
  }
}

/** 作品1つ（Claude の分析・作者の分析・直した分析）と資料1つ（Claude の記録） */
function shelf() {
  const w = addBenchWork(emptyData(), { name: '銀河の果て', author: '山田' })
  const m = addMaterial(w.data, { name: '外科の歴史', author: '高橋' })
  const data: AppData = {
    ...m.data,
    benchAnalyses: {
      'cn-claude00001': analysis(w.result, 'cn-claude00001'),
      'manual-000001': analysis(w.result, 'manual-000001', { source: 'manual', viewpoint: '人物' }),
      'cp-pasted00001': analysis(w.result, 'cp-pasted00001', { source: 'paste', viewpoint: '文体' }),
      'cn-edited00001': analysis(w.result, 'cn-edited00001', { updatedAt: 200, viewpoint: '冒頭' }),
    },
    materialNotes: { 'ck-claude00001': note(m.result, 'ck-claude00001') },
  }
  return { data, workId: w.result, materialId: m.result }
}

const ctx = (over: Partial<TrashContext> = {}): TrashContext => ({
  now: NOW,
  trash: {},
  wasDeleted: () => false,
  dailyLeft: 100,
  ...over,
})

describe('buildTrashRequests', () => {
  it('n:・k: の短い id と、接頭の無い id そのもので見つかり、依頼の形（作品・資料の id・依頼の時の updatedAt・表記）で作る', () => {
    const s = shelf()
    const r = buildTrashRequests(s.data, { cards: [shortId('benchAnalysis', 'cn-claude00001'), 'ck-claude00001'] }, ctx())
    expect(r.ok).toBe(true)
    expect(r.items.map((i) => i.status)).toEqual(['requested', 'requested'])
    expect(r.records.map((x) => x.record)).toEqual([
      {
        id: trashRequestId('benchAnalyses', 'cn-claude00001'),
        table: 'benchAnalyses',
        targetId: 'cn-claude00001',
        parentId: s.workId,
        targetUpdatedAt: 100,
        label: '『銀河の果て』の「構成」（2026-10-30）',
        source: 'claude',
        v: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      expect.objectContaining({
        id: trashRequestId('materialNotes', 'ck-claude00001'),
        table: 'materialNotes',
        parentId: s.materialId,
        label: '『外科の歴史』の「要約」（2026-10-31）',
      }),
    ])
    expect(r.records.every((x) => isTrashRequest(x.record))).toBe(true)
    expect(r.records[0].record.id).toMatch(/^cz-/)
  })

  it('作者が書いた・貼り付けた・直したカード、作品・資料そのもの、ほかの種類、見つからない・形の違う id は断る', () => {
    const s = shelf()
    const r = buildTrashRequests(
      s.data,
      {
        cards: [
          'manual-000001',
          shortId('benchAnalysis', 'cp-pasted00001'),
          shortId('benchAnalysis', 'cn-edited00001'),
          shortId('benchWork', s.workId),
          shortId('material', s.materialId),
          'x:12345678',
          'a:12345678',
          'n:zzzzzzzz',
          '',
          'あ'.repeat(81),
        ],
      },
      ctx(),
    )
    expect(r.ok).toBe(true)
    expect(r.records).toEqual([])
    expect(r.items.map((i) => i.status)).toEqual([
      'not_claude',
      'not_claude',
      'edited',
      'shelf_item',
      'shelf_item',
      'not_card',
      'not_card',
      'not_found',
      'invalid',
      'invalid',
    ])
    expect(r.items[0].hint).toContain('作者がアプリで削除してください')
  })

  it('ゴミ箱にあるカード・同じ呼び出しの中の重なり・依頼中のカード（書かない）', () => {
    const s = shelf()
    const trash = {
      tr1: {
        id: 'tr1',
        entryId: 'te1',
        table: 'benchAnalyses' as const,
        record: { id: 'cn-intrash0001' },
        createdAt: 1,
        updatedAt: 1,
      },
    } as unknown as AppData['trashRecords']
    const first = buildTrashRequests(s.data, { cards: ['cn-claude00001'] }, ctx())
    const req = first.records[0].record
    const data: AppData = { ...s.data, trashRequests: { [req.id]: req } }
    const r = buildTrashRequests(
      data,
      { cards: [shortId('benchAnalysis', 'cn-intrash0001'), 'cn-claude00001', 'ck-claude00001', 'ck-claude00001'] },
      ctx({ trash }),
    )
    expect(r.items.map((i) => i.status)).toEqual(['in_trash', 'pending', 'requested', 'repeated'])
    expect(r.records).toHaveLength(1)
    // Claude に見せる内容（依頼中のカードは外れている）でも、依頼中と分かる
    const v = buildTrashRequests(claudeView(data), { cards: [shortId('benchAnalysis', 'cn-claude00001')] }, ctx())
    expect(v.items[0]).toMatchObject({ status: 'pending', label: '『銀河の果て』の「構成」（2026-10-30）' })
  })

  it('削除の印のある依頼の id（前の依頼をアプリが処理した）は、次の番号にする', () => {
    const s = shelf()
    const gone = new Set(['trashRequests:' + trashRequestId('benchAnalyses', 'cn-claude00001')])
    const r = buildTrashRequests(s.data, { cards: ['cn-claude00001'] }, ctx({ wasDeleted: (t, id) => gone.has(`${t}:${id}`) }))
    expect(r.records[0].record.id).toBe(trashRequestId('benchAnalyses', 'cn-claude00001', 2))
  })

  it('21件・今日の残りを超える数は、呼び出し全体を断る（一部だけ頼まない）', () => {
    const s = shelf()
    const many = buildTrashRequests(s.data, { cards: Array.from({ length: 21 }, () => 'cn-claude00001') }, ctx())
    expect(many.ok).toBe(false)
    expect(many.error).toContain('20件まで')
    const over = buildTrashRequests(s.data, { cards: ['cn-claude00001', 'ck-claude00001'] }, ctx({ dailyLeft: 1 }))
    expect(over.ok).toBe(false)
    expect(over.error).toContain('あと1件')
    expect(over.records).toEqual([])
    // 依頼中・断るだけなら、残りが 0 でも通る
    const none = buildTrashRequests(s.data, { cards: ['manual-000001'] }, ctx({ dailyLeft: 0 }))
    expect(none.ok).toBe(true)
    expect(buildTrashRequests(s.data, {}, ctx()).ok).toBe(false)
  })
})

describe('依頼の形と依頼中のカード', () => {
  const req = (over: Partial<TrashRequest> = {}): TrashRequest => ({
    id: 'cz-1',
    table: 'benchAnalyses',
    targetId: 'cn-claude00001',
    parentId: 'w1',
    targetUpdatedAt: 100,
    label: '「構成」',
    source: 'claude',
    v: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  it('pendingTrashTargets・liveTrashRequests は、形の違う依頼と新しい版の依頼を数えない', () => {
    const data = {
      trashRequests: {
        'cz-1': req(),
        'cz-2': req({ id: 'cz-2', table: 'materialNotes', targetId: 'k1', parentId: 'd1' }),
        'cz-3': req({ id: 'cz-3', targetId: 'x3', v: 2 }),
        'cz-4': { ...req({ id: 'cz-4', targetId: 'x4' }), table: 'titles' } as unknown as TrashRequest,
        'cz-5': { ...req({ id: 'cz-5', targetId: 'x5' }), source: 'paste' } as unknown as TrashRequest,
      },
    }
    expect([...pendingTrashTargets(data)].sort()).toEqual(['benchAnalyses:cn-claude00001', 'materialNotes:k1'])
    expect(liveTrashRequests(data).map((r) => r.id)).toEqual(['cz-1', 'cz-2'])
    expect(pendingTrashCount(data, 'benchAnalyses', 'w1')).toBe(1)
    expect(pendingTrashCount(data, 'materialNotes', 'w1')).toBe(0)
  })

  it('trashTargetProblem: Claude でない・直した・依頼の後に直した（作品が変わった）', () => {
    const a = analysis('w1', 'cn-claude00001')
    expect(trashTargetProblem('benchAnalyses', a)).toBeNull()
    expect(trashTargetProblem('benchAnalyses', { ...a, source: 'paste' })).toBe('not_claude')
    expect(trashTargetProblem('benchAnalyses', { ...a, updatedAt: 101 })).toBe('edited')
    expect(trashTargetProblem('benchAnalyses', a, req())).toBeNull()
    expect(trashTargetProblem('benchAnalyses', a, req({ targetUpdatedAt: 99 }))).toBe('changed')
    expect(trashTargetProblem('benchAnalyses', a, req({ parentId: 'w2' }))).toBe('changed')
  })

  it('表記とゴミ箱の id（依頼から決める）', () => {
    const s = shelf()
    expect(trashCardLabel(s.data, 'benchAnalyses', s.data.benchAnalyses['cn-claude00001'])).toBe(
      '『銀河の果て』の「構成」（2026-10-30）',
    )
    expect(trashCardLabel(emptyData(), 'materialNotes', note('gone', 'k1', { section: ' ', runDate: '' }))).toBe('「項目なし」')
    expect(trashEntryIdsOf('cz-1')).toMatchObject({ entry: 'te-cz-1' })
    expect(trashEntryIdsOf('cz-1').record(0)).toBe('tr-cz-1')
  })
})
