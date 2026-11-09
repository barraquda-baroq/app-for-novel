// ゴミ箱へ移す依頼（2.7）のデータの扱い: Claude に見せる内容（依頼中のカードを外す）・作品と資料の行・自動のタグ・
// ゴミ箱へ入れる時の id と印・修復・バックアップ。
import { describe, expect, it } from 'vitest'
import { parseBackup, toBackup } from '../domain/backup'
import { addBenchWork, deleteBenchAnalysis, trashBenchAnalysis } from '../domain/benchOps'
import { applyAutoGenreTags } from '../domain/benchTags'
import { addMaterial, deleteMaterialNote } from '../domain/materialOps'
import { repairData } from '../domain/repair'
import { putInTrash } from '../domain/trash'
import { transact } from '../domain/tx'
import { emptyData, type AppData, type BenchAnalysis, type MaterialNote, type TrashRequest } from '../domain/types'
import { benchWorkLine } from './bench'
import { materialLine } from './material'
import { pendingTrashLine } from './trashTargets'
import { claudeView } from './visibility'

function card<T extends BenchAnalysis | MaterialNote>(rec: Omit<T, 'source' | 'v' | 'createdAt' | 'updatedAt'>): T {
  return { ...rec, source: 'claude', v: 1, createdAt: 100, updatedAt: 100 } as T
}

function request(
  table: TrashRequest['table'],
  targetId: string,
  parentId: string,
  over: Partial<TrashRequest> = {},
): TrashRequest {
  return {
    id: `cz-${targetId}`,
    table,
    targetId,
    parentId,
    targetUpdatedAt: 100,
    label: '「構成」',
    source: 'claude',
    v: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const genre14 = (genre: string, sub: string) => `- 判定したジャンル：${genre}\n- ジャンル／サブジャンル：${sub}`

function shelf() {
  const w = addBenchWork(emptyData(), { name: '銀河の果て', author: '山田' })
  const m = addMaterial(w.data, { name: '外科の歴史', author: '高橋' })
  const a1 = card<BenchAnalysis>({ id: 'a1', workId: w.result, viewpoint: '構成', body: '三幕。', runDate: '2026-10-30' })
  const a2 = card<BenchAnalysis>({ id: 'a2', workId: w.result, viewpoint: '文体', body: '短い文。', runDate: '2026-10-30' })
  const k1 = card<MaterialNote>({ id: 'k1', materialId: m.result, section: '要約', body: '第1章。', runDate: '2026-10-31' })
  const data: AppData = { ...m.data, benchAnalyses: { a1, a2 }, materialNotes: { k1 } }
  return { data, workId: w.result, materialId: m.result }
}

describe('Claude に見せる内容（claudeView）', () => {
  it('依頼中の分析・記録を外し、依頼は見せる。依頼が無ければ表は同じオブジェクトのまま', () => {
    const s = shelf()
    const plain = claudeView(s.data)
    expect(plain.benchAnalyses).toBe(s.data.benchAnalyses)
    expect(plain.materialNotes).toBe(s.data.materialNotes)
    const data: AppData = {
      ...s.data,
      trashRequests: {
        'cz-a1': request('benchAnalyses', 'a1', s.workId),
        'cz-k1': request('materialNotes', 'k1', s.materialId),
      },
    }
    const v = claudeView(data)
    expect(Object.keys(v.benchAnalyses)).toEqual(['a2'])
    expect(v.materialNotes).toEqual({})
    expect(v.trashRequests).toBe(data.trashRequests)
    // 新しい版の依頼（形が違うかもしれない）では外さない
    const newer = claudeView({ ...s.data, trashRequests: { 'cz-a1': request('benchAnalyses', 'a1', s.workId, { v: 2 }) } })
    expect(newer.benchAnalyses).toBe(s.data.benchAnalyses)
  })

  it('作品・資料の行に「ゴミ箱へ移す依頼中 n件」（分析・記録の数の次。依頼が無ければ出さない）', () => {
    const s = shelf()
    const data: AppData = {
      ...s.data,
      trashRequests: {
        'cz-a1': request('benchAnalyses', 'a1', s.workId),
        'cz-k1': request('materialNotes', 'k1', s.materialId),
      },
    }
    const v = claudeView(data)
    const work = benchWorkLine(v, v.benchWorks[s.workId]).split('\n')
    expect(work[1]).toMatch(/^ {2}分析 1件/)
    expect(work[2]).toBe('  ゴミ箱へ移す依頼中 1件（アプリが同期すると移ります）')
    const mat = materialLine(v, v.materials[s.materialId]).split('\n')
    expect(mat[1]).toBe('  記録 0件')
    expect(mat[2]).toBe('  ゴミ箱へ移す依頼中 1件（アプリが同期すると移ります）')
    expect(benchWorkLine(s.data, s.data.benchWorks[s.workId])).not.toContain('依頼中')
    expect(pendingTrashLine(0)).toBe('')
  })

  it('自動のタグは、依頼中の「14 検索用タグ」を読まない（コネクタに見えるタグと同じ。前の 14 があればそれから）', () => {
    const s = shelf()
    const old = card<BenchAnalysis>({
      id: 'g1',
      workId: s.workId,
      viewpoint: '14 検索用タグ',
      body: genre14('恋愛', '恋愛／青春'),
      runDate: '2026-10-01',
    })
    const latest = card<BenchAnalysis>({
      id: 'g2',
      workId: s.workId,
      viewpoint: '14 検索用タグ',
      body: genre14('SF', 'SF／宇宙'),
      runDate: '2026-11-01',
    })
    const base: AppData = { ...s.data, benchAnalyses: { ...s.data.benchAnalyses, g1: old, g2: latest } }
    expect(applyAutoGenreTags(base).benchWorks[s.workId].tags).toEqual(['SF', '宇宙'])
    const asked: AppData = { ...base, trashRequests: { 'cz-g2': request('benchAnalyses', 'g2', s.workId) } }
    const tagged = applyAutoGenreTags(asked).benchWorks[s.workId]
    expect(tagged.tags).toEqual(['恋愛', '青春'])
    expect(tagged.autoTagsFrom?.analysisId).toBe('g1')
    const onlyAsked: AppData = {
      ...s.data,
      benchAnalyses: { g2: latest },
      trashRequests: { 'cz-g2': request('benchAnalyses', 'g2', s.workId) },
    }
    expect(applyAutoGenreTags(onlyAsked)).toBe(onlyAsked)
  })
})

describe('ゴミ箱へ入れる時の id と印（putInTrash）', () => {
  it('ゴミ箱の件と中身の id、Claude の依頼の印を渡せる（渡さなければ今までどおり）', () => {
    const s = shelf()
    const r = transact(s.data, (tx) =>
      trashBenchAnalysis(tx, s.data.benchAnalyses.a1, { at: 5, entryId: 'te-x', recordId: (i) => `tr-x-${i}`, by: 'claude' }),
    )
    expect(r.result).toBe('te-x')
    expect(r.data.trashEntries['te-x']).toMatchObject({ recordIds: ['tr-x-0'], by: 'claude', deletedAt: 5 })
    expect(r.data.trashRecords['tr-x-0'].entryId).toBe('te-x')
    const plain = transact(s.data, (tx) =>
      putInTrash(tx, {
        kind: 'materialNote',
        label: 'x',
        titleName: '',
        origin: { titleId: null, index: -1 },
        records: [{ table: 'materialNotes', record: s.data.materialNotes.k1 }],
      }),
    )
    const entry = plain.data.trashEntries[plain.result]
    expect('by' in entry).toBe(false)
    expect(entry.id).not.toBe('te-x')
  })

  it('作者の削除（deleteBenchAnalysis・deleteMaterialNote）は今までと同じ形（印なし）', () => {
    const s = shelf()
    const a = Object.values(deleteBenchAnalysis(s.data, 'a1').trashEntries)[0]
    expect(a).toMatchObject({ kind: 'benchAnalysis', label: '構成（2026-10-30）', parentLabel: '銀河の果て', reason: 'deleted' })
    expect(a.origin).toEqual({ titleId: null, index: -1, workId: s.workId })
    expect('by' in a).toBe(false)
    const n = Object.values(deleteMaterialNote(s.data, 'k1').trashEntries)[0]
    expect(n).toMatchObject({ kind: 'materialNote', parentLabel: '外科の歴史' })
    expect(n.origin).toEqual({ titleId: null, index: -1, materialId: s.materialId })
  })
})

describe('修復とバックアップ', () => {
  it('依頼は形が違っても残し（アプリが処理して消せるように）、ゴミ箱の件の印は claude 以外を外す', () => {
    const s = shelf()
    const broken = { id: 'cz-broken', table: 'titles' } as unknown as TrashRequest
    const ok = request('benchAnalyses', 'a1', s.workId)
    const moved = transact(s.data, (tx) => trashBenchAnalysis(tx, s.data.benchAnalyses.a1, { by: 'claude' }))
    const entryId = moved.result
    const odd = { ...moved.data.trashEntries[entryId], by: 'someone' } as unknown as AppData['trashEntries'][string]
    const data: AppData = {
      ...moved.data,
      trashRequests: { [broken.id]: broken, [ok.id]: ok, 'cz-mismatch': { ...ok, id: 'other' } },
      trashEntries: { [entryId]: odd },
    }
    const r = repairData(data).data
    expect(Object.keys(r.trashRequests).sort()).toEqual(['cz-a1', 'cz-broken'])
    expect('by' in r.trashEntries[entryId]).toBe(false)
    const kept = repairData(moved.data)
    expect(kept.data.trashEntries[entryId].by).toBe('claude')
    expect(kept.fixes).toEqual([])
  })

  it('バックアップに依頼は書き出さず、読み込まない（ゴミ箱の件の印は残る）。版は 4 のまま', () => {
    const s = shelf()
    const moved = transact(s.data, (tx) => trashBenchAnalysis(tx, s.data.benchAnalyses.a1, { by: 'claude' }))
    const data: AppData = { ...moved.data, trashRequests: { 'cz-a2': request('benchAnalyses', 'a2', s.workId) } }
    const file = toBackup(data)
    expect(file.schemaVersion).toBe(4)
    expect('trashRequests' in file.data).toBe(false)
    const back = parseBackup(JSON.stringify(file))
    expect(back.trashRequests).toEqual({})
    expect(back.trashEntries[moved.result].by).toBe('claude')
    // 依頼の入った JSON（手で書き足したもの）も、依頼は読まない
    const forged = parseBackup(JSON.stringify({ ...file, data: { ...file.data, trashRequests: data.trashRequests } }))
    expect(forged.trashRequests).toEqual({})
  })
})
