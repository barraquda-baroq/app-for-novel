import { describe, expect, it, vi } from 'vitest'
import {
  critiquePromptsOf,
  critiqueResultsOf,
  openProofSuggestionsFor,
  proofCoverage,
  proofRunsOf,
  proofSuggestionsOf,
  revisionIdeasOf,
  sortProofSuggestions,
  strategyNotesOf,
} from '../claude/order'
import { buildProofreading, buildStrategyNote } from '../claude/records'
import { manuscriptLabel, manuscriptOf } from '../claude/snapshot'
import { novel, splitEpisode } from '../test/claudeFixture'
import { toBackup, parseBackup } from './backup'
import {
  addClaudeRecords,
  addCritiquePrompt,
  addCritiqueResult,
  addProofSuggestion,
  addRevisionIdea,
  appendStrategyNoteToTitle,
  contestToSubmission,
  deleteCheckedProofSuggestions,
  deleteCritiquePrompt,
  deleteCritiqueResult,
  deleteProofSuggestion,
  deleteRevisionIdea,
  deleteStrategyNote,
  moveCritiquePromptStep,
  moveRevisionIdeaStep,
  moveRevisionIdeaTo,
  setProofDone,
  setProofFlagged,
  setRevisionIdeaChecked,
  setTitleClaudeAccess,
  updateCritiqueResult,
  updateProofSuggestion,
  updateRevisionIdea,
} from './claudeOps'
import { deleteTitle, titleLastEdited } from './entityOps'
import { repairData } from './repair'
import { updateVersion } from './storyOps'
import { listTrash, restoreTrashEntry, trashContents } from './trash'
import { DomainError, type AppData, type ProofSuggestion } from './types'

const errorOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.message
    throw e
  }
  throw new Error('DomainError が投げられませんでした')
}

/** 時刻を ms ずつ進めながら操作する（並びが作った順・チェックした順で決まるため） */
function clock(start = Date.UTC(2026, 9, 28, 3, 0)) {
  let t = start
  vi.useFakeTimers()
  vi.setSystemTime(t)
  return () => {
    t += 1000
    vi.setSystemTime(t)
    return t
  }
}

describe('改稿案', () => {
  it('足す・直す・チェックすると下へ沈み、外すとチェックしていない案の末尾へ戻る・並べ替え', () => {
    const tick = clock()
    const n = novel(['本文'])
    let data = n.data
    const ids: string[] = []
    for (const h of ['A', 'B', 'C']) {
      tick()
      const r = addRevisionIdea(data, n.titleId, { heading: h, body: `${h}の案`, pieceIds: [n.ids[0], n.ids[0]] })
      data = r.data
      ids.push(r.result)
    }
    expect(data.revisionIdeas[ids[0]]).toMatchObject({ source: 'manual', v: 1, checked: false, pieceIds: [n.ids[0]], order: 0 })
    const heads = () => revisionIdeasOf(data, n.titleId).map((r) => `${r.heading}${r.checked ? '✓' : ''}`)
    tick()
    data = setRevisionIdeaChecked(data, ids[0], true)
    expect(heads()).toEqual(['B', 'C', 'A✓'])
    tick()
    data = setRevisionIdeaChecked(data, ids[1], true)
    expect(heads()).toEqual(['C', 'A✓', 'B✓'])
    expect(data.revisionIdeas[ids[1]].checkedAt).toBeGreaterThan(data.revisionIdeas[ids[0]].checkedAt!)
    tick()
    data = setRevisionIdeaChecked(data, ids[0], false)
    expect(heads()).toEqual(['C', 'A', 'B✓'])
    expect(data.revisionIdeas[ids[0]].checkedAt).toBeNull()
    data = moveRevisionIdeaStep(data, ids[0], -1)
    expect(heads()).toEqual(['A', 'C', 'B✓'])
    data = moveRevisionIdeaTo(data, ids[0], 5)
    expect(heads()).toEqual(['C', 'A', 'B✓'])
    expect(errorOf(() => moveRevisionIdeaTo(data, ids[1], 0))).toContain('チェックした')
    data = updateRevisionIdea(data, ids[2], { body: 'x'.repeat(300_000) })
    expect(data.revisionIdeas[ids[2]].body).toHaveLength(300_000)
    vi.useRealTimers()
  })
  it('削除するとゴミ箱へ、戻すと元の位置へ', () => {
    const n = novel(['本文'])
    let data = n.data
    const ids = ['A', 'B', 'C'].map((h) => {
      const r = addRevisionIdea(data, n.titleId, { heading: h })
      data = r.data
      return r.result
    })
    data = deleteRevisionIdea(data, ids[1])
    expect(revisionIdeasOf(data, n.titleId).map((r) => r.heading)).toEqual(['A', 'C'])
    const entry = listTrash(data.trashEntries)[0]
    expect(entry).toMatchObject({ kind: 'revisionIdea', label: 'B', titleName: '星の庭' })
    data = restoreTrashEntry(data, entry.id).data
    expect(revisionIdeasOf(data, n.titleId).map((r) => r.heading)).toEqual(['A', 'B', 'C'])
  })
})

describe('推敲案', () => {
  function withSuggestions() {
    const tick = clock()
    const n = novel(['窓から見れる景色。', '食べれる。来れる。'])
    tick()
    const r = buildProofreading(
      n.data,
      {
        title_id: n.titleId,
        run_label: 'ワードサーチ',
        covered: ['#1', '#2'],
        items: [
          { piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' },
          { piece: '#2', excerpt: '食べれる', category: 'ra_nuki', reason: 'ら抜き', important: true },
        ],
      },
      { source: 'claude', now: Date.now() },
    )
    let data = addClaudeRecords(n.data, r.records).data
    tick()
    const m = addProofSuggestion(data, n.titleId, { pieceId: n.ids[1], excerpt: '来れる', suggestion: '来られる', category: 'ra_nuki' })
    data = m.data
    return { n, data, tick, ids: [r.items[0].id!, r.items[1].id!, m.result] }
  }
  it('並び: フラグ → 新しい順、チェックしたものは下へ', () => {
    const { n, data: d0, tick, ids } = withSuggestions()
    let data = d0
    const order = () => proofSuggestionsOf(data, n.titleId).map((s) => ids.indexOf(s.id))
    expect(order()).toEqual([1, 2, 0])
    tick()
    data = setProofFlagged(data, ids[0], true)
    // 同じ時に作った2件はどちらもフラグ付き（並びは id の順）、手で足した案はその後ろ
    expect(order().slice(2)).toEqual([2])
    tick()
    data = setProofDone(data, ids[1], true)
    expect(order()).toEqual([0, 2, 1])
    expect(data.proofSuggestions[ids[1]].doneAt).not.toBeNull()
    data = setProofDone(data, ids[1], false)
    expect(data.proofSuggestions[ids[1]].doneAt).toBeNull()
    expect(sortProofSuggestions([])).toEqual([])
    vi.useRealTimers()
  })
  it('手で足した推敲案も場所を控える。直す・種類を変えると名前も変わる', () => {
    const { data, ids } = withSuggestions()
    const s = data.proofSuggestions[ids[2]]
    expect(s).toMatchObject({ source: 'manual', categoryLabel: 'ら抜き', runId: null, batchId: null })
    expect(s.anchor?.offset).toBe(5)
    const next = updateProofSuggestion(data, ids[2], { category: 'typo' })
    expect(next.proofSuggestions[ids[2]]).toMatchObject({ category: 'typo', categoryLabel: '誤字脱字・変換ミス' })
    vi.useRealTimers()
  })
  it('「チェック済みを削除」はゴミ箱の1件にまとめ、戻すとまとめて戻る', () => {
    const { n, data: d0, ids } = withSuggestions()
    let data = setProofDone(setProofDone(d0, ids[0], true), ids[2], true)
    data = deleteCheckedProofSuggestions(data, n.titleId)
    expect(Object.keys(data.proofSuggestions)).toEqual([ids[1]])
    const entries = listTrash(data.trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'proofSuggestion', label: 'チェック済みの推敲案（2件）' })
    expect(trashContents(data, entries[0])).toHaveLength(2)
    expect(deleteCheckedProofSuggestions(data, n.titleId)).toBe(data)
    data = restoreTrashEntry(data, entries[0].id).data
    expect(Object.keys(data.proofSuggestions).sort()).toEqual([...ids].sort())
    vi.useRealTimers()
  })
  it('1件の削除。原稿画面の「推敲案 n」は話とその幕のもの', () => {
    const { n, data: d0, ids } = withSuggestions()
    let data = deleteProofSuggestion(d0, ids[0])
    expect(listTrash(data.trashEntries)[0]).toMatchObject({ label: '「見れる」', parentLabel: '第1話' })
    expect(openProofSuggestionsFor(data, n.ids[1]).map((s) => s.id).sort()).toEqual([ids[1], ids[2]].sort())
    const ns = { ...n, data }
    const { acts } = splitEpisode(ns, n.ids[1], [5])
    const r = addProofSuggestion(ns.data, n.titleId, { pieceId: n.ids[1], excerpt: '来れる' })
    data = r.data
    expect(data.proofSuggestions[r.result]).toMatchObject({ pieceId: acts[1], parentId: n.ids[1] })
    expect(openProofSuggestionsFor(data, acts[1]).map((s) => s.id)).toEqual([r.result])
    expect(openProofSuggestionsFor(data, n.ids[1])).toHaveLength(3)
    vi.useRealTimers()
  })
  it('実行の記録と確かめた範囲（本文が変わった話）', () => {
    const { n, data: d0 } = withSuggestions()
    expect(proofRunsOf(d0, n.titleId)).toMatchObject([{ runLabel: 'ワードサーチ', count: 2 }])
    expect(proofCoverage(d0, n.titleId).text).toBe('すべて確認済み')
    const data = updateVersion(d0, d0.pieces[n.ids[1]].versionIds[0], { body: '食べられる。' })
    expect(proofCoverage(data, n.titleId).text).toBe('本文が変わった話 #2')
    expect(proofCoverage(n.data, n.titleId)).toMatchObject({ any: false, text: '' })
    vi.useRealTimers()
  })
})

describe('作品批評', () => {
  it('批評プロンプト: タイトルのものと共通のもの・並べ替え・削除して戻す', () => {
    const n = novel(['本文'])
    let data = n.data
    const add = (titleId: string | null, name: string) => {
      const r = addCritiquePrompt(data, titleId, { name, body: `${name}の依頼` })
      data = r.data
      return r.result
    }
    const a = add(n.titleId, 'A')
    const b = add(n.titleId, 'B')
    const s = add(null, '共通')
    const names = () => {
      const p = critiquePromptsOf(data, n.titleId)
      return [p.title.map((x) => x.name), p.shared.map((x) => x.name)]
    }
    expect(names()).toEqual([['A', 'B'], ['共通']])
    data = moveCritiquePromptStep(data, b, -1)
    expect(names()).toEqual([['B', 'A'], ['共通']])
    data = deleteCritiquePrompt(data, s)
    expect(listTrash(data.trashEntries)[0]).toMatchObject({ kind: 'critiquePrompt', parentLabel: '共通の批評プロンプト' })
    data = restoreTrashEntry(data, listTrash(data.trashEntries)[0].id).data
    expect(names()).toEqual([['B', 'A'], ['共通']])
    // タイトルを削除しても共通のものは残る
    data = deleteTitle(data, n.titleId)
    expect(Object.values(data.critiquePrompts).map((p) => p.name)).toEqual(['共通'])
    expect(a).toBeTruthy()
  })
  it('批評結果: プロンプトと原稿の控え、URL は https だけ、削除', () => {
    const n = novel(['一二三四五'])
    const p = addCritiquePrompt(n.data, n.titleId, { name: '構成', body: '構成を見て' })
    const r = addCritiqueResult(p.data, n.titleId, { promptId: p.result, resultMarkdown: '## 総評', runDate: '2026-10-28' })
    let data = r.data
    expect(data.critiqueResults[r.result]).toMatchObject({ promptName: '構成', promptText: '構成を見て', manuscript: { chars: 5, pieces: 1 } })
    data = updateCritiqueResult(data, r.result, { artifactUrl: ' https://claude.ai/public/artifacts/x ', note: 'メモ' })
    expect(data.critiqueResults[r.result]).toMatchObject({ artifactUrl: 'https://claude.ai/public/artifacts/x', note: 'メモ' })
    expect(errorOf(() => updateCritiqueResult(data, r.result, { artifactUrl: 'javascript:alert(1)' }))).toContain('https')
    data = updateCritiqueResult(data, r.result, { artifactUrl: '' })
    expect(data.critiqueResults[r.result].artifactUrl).toBe('')
    expect(critiqueResultsOf(data, n.titleId)).toHaveLength(1)
    const m = data.critiqueResults[r.result].manuscript!
    const later = updateVersion(data, data.pieces[n.ids[0]].versionIds[0], { body: '一二三四五六七' })
    expect(manuscriptLabel(m, manuscriptOf(later, n.titleId, 0))).toBe('5字・1話の時点（現在 +2字）')
    expect(manuscriptLabel(m, manuscriptOf(data, n.titleId, 0))).toBe('5字・1話の時点（現在と同じ）')
    data = deleteCritiqueResult(data, r.result)
    expect(listTrash(data.trashEntries)[0]).toMatchObject({ kind: 'critiqueResult', label: '2026-10-28 構成の結果' })
  })
})

describe('戦略メモ', () => {
  function withNote() {
    const n = novel(['本文'])
    const r = buildStrategyNote(
      n.data,
      {
        title_id: n.titleId,
        heading: '公募の狙い',
        body: '長編賞を狙う',
        run_date: '2026-10-27',
        contests: [{ name: '〇〇大賞', organizer: '〇〇社', url: 'https://example.com', deadline: '2027-03-31', limit: { min: 100, max: 200, unit: 'pages' }, fit: '合う', plan: '削る' }],
      },
      { source: 'claude', now: Date.UTC(2026, 9, 27) },
    )
    const data = addClaudeRecords(n.data, r.records).data
    return { n, data, noteId: r.items[0].id! }
  }
  it('［全体戦略に追記］は「【Claude 日付】」を付けて足し、追記した日時を控える', () => {
    const { n, data: d0, noteId } = withNote()
    let data = { ...d0, titles: { [n.titleId]: { ...d0.titles[n.titleId], strategyNote: '前からの方針\n' } } }
    data = appendStrategyNoteToTitle(data, noteId)
    expect(data.titles[n.titleId].strategyNote).toBe('前からの方針\n\n【Claude 2026-10-27】公募の狙い\n長編賞を狙う')
    expect(data.strategyNotes[noteId].appliedAt).not.toBeNull()
  })
  it('［応募計画にする］は応募計画を作り、もう一度押しても同じ応募計画', () => {
    const { n, data: d0, noteId } = withNote()
    const r = contestToSubmission(d0, noteId, 'k0')
    expect(r.data.submissions[r.result]).toMatchObject({
      titleId: n.titleId,
      contestName: '〇〇大賞',
      organizer: '〇〇社',
      url: 'https://example.com',
      deadline: '2027-03-31',
      minChars: 100,
      maxChars: 200,
      limitUnit: 'pages',
      overview: '合う',
      revisionPlan: '削る',
      status: 'considering',
    })
    expect(r.data.strategyNotes[noteId].contests[0].submissionId).toBe(r.result)
    expect(contestToSubmission(r.data, noteId, 'k0').result).toBe(r.result)
    expect(errorOf(() => contestToSubmission(r.data, noteId, 'k9'))).toContain('見つかりません')
    expect(strategyNotesOf(r.data, n.titleId)).toHaveLength(1)
  })
  it('削除するとゴミ箱へ', () => {
    const { data: d0, noteId } = withNote()
    const data = deleteStrategyNote(d0, noteId)
    expect(listTrash(data.trashEntries)[0]).toMatchObject({ kind: 'strategyNote', label: '公募の狙い' })
  })
})

describe('タイトル・ゴミ箱・バックアップ・修復', () => {
  function full(): { data: AppData; titleId: string } {
    const n = novel(['窓から見れる景色。'])
    let data = n.data
    data = addRevisionIdea(data, n.titleId, { heading: '案' }).data
    data = addCritiquePrompt(data, n.titleId, { name: 'P' }).data
    data = addCritiquePrompt(data, null, { name: '共通' }).data
    data = addCritiqueResult(data, n.titleId, { resultMarkdown: 'R' }).data
    const p = buildProofreading(
      data,
      { title_id: n.titleId, covered: ['#1'], items: [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'x' }] },
      { source: 'claude', now: 1 },
    )
    data = addClaudeRecords(data, p.records).data
    const s = buildStrategyNote(data, { title_id: n.titleId, heading: 'H', body: 'B' }, { source: 'claude', now: 1 })
    data = addClaudeRecords(data, s.records).data
    return { data, titleId: n.titleId }
  }
  it('Claude に見せるか', () => {
    const { data, titleId } = full()
    expect(setTitleClaudeAccess(data, titleId, 'read').titles[titleId].claudeAccess).toBe('read')
  })
  it('タイトルの削除は 2.3 の記録もタイトルのゴミ箱の1件に入れ（共通の批評プロンプトは残す）、戻すとすべて戻る', () => {
    const { data: d0, titleId } = full()
    const counts = (d: AppData) =>
      ['proofSuggestions', 'proofBatches', 'revisionIdeas', 'strategyNotes', 'critiquePrompts', 'critiqueResults'].map(
        (t) => Object.keys(d[t as keyof AppData]).length,
      )
    expect(counts(d0)).toEqual([1, 1, 1, 1, 2, 1])
    let data = deleteTitle(d0, titleId)
    expect(counts(data)).toEqual([0, 0, 0, 0, 1, 0])
    const entry = listTrash(data.trashEntries)[0]
    expect(trashContents(data, entry).map((r) => r.table)).toEqual(
      expect.arrayContaining(['proofSuggestions', 'proofBatches', 'revisionIdeas', 'strategyNotes', 'critiquePrompts', 'critiqueResults']),
    )
    data = restoreTrashEntry(data, entry.id).data
    expect(counts(data)).toEqual([1, 1, 1, 1, 2, 1])
  })
  it('2.3 の記録はタイトルの最終更新に入れない', () => {
    const { data, titleId } = full()
    const before = titleLastEdited(data, titleId)
    const later = { ...data, revisionIdeas: Object.fromEntries(Object.entries(data.revisionIdeas).map(([k, v]) => [k, { ...v, updatedAt: before + 10_000 }])) }
    expect(titleLastEdited(later, titleId)).toBe(before)
  })
  it('バックアップは版 2 で書き出し、2.3 の記録も戻る。版 1（2.2 まで）のバックアップも読める', () => {
    const { data } = full()
    const back = parseBackup(JSON.stringify(toBackup(data)))
    expect(back.proofSuggestions).toEqual(data.proofSuggestions)
    expect(back.critiqueResults).toEqual(data.critiqueResults)
    const old = JSON.stringify({ app: 'novel-studio', schemaVersion: 1, exportedAt: '', data: { titles: data.titles } })
    const parsed = parseBackup(old)
    expect(parsed.revisionIdeas).toEqual({})
    expect(Object.keys(parsed.titles)).toHaveLength(1)
    expect(() => parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 3, exportedAt: '', data: {} }))).toThrow()
  })
  it('修復: 足りない項目を補い、知らない項目・知らない種類は残し、タイトルの無い記録は見えなくする', () => {
    const { data, titleId } = full()
    const [sid] = Object.keys(data.proofSuggestions)
    const raw = data.proofSuggestions[sid] as unknown as Record<string, unknown>
    const { flagged: _f, anchor: _a, ...rest } = raw
    void _f
    void _a
    const broken: AppData = {
      ...data,
      proofSuggestions: { [sid]: { ...rest, category: 'future_kind', extra: { x: 1 } } as unknown as ProofSuggestion },
      revisionIdeas: {
        ...data.revisionIdeas,
        orphan: { ...Object.values(data.revisionIdeas)[0], id: 'orphan', titleId: 'gone' },
      },
      critiquePrompts: {
        ...data.critiquePrompts,
        shared2: { ...Object.values(data.critiquePrompts).find((p) => p.titleId === null)!, id: 'shared2' },
      },
    }
    const r = repairData(broken)
    const s = r.data.proofSuggestions[sid] as ProofSuggestion & { extra?: unknown }
    expect(s.flagged).toBe(false)
    expect(s.anchor).toBeNull()
    expect(s.category).toBe('future_kind')
    expect(s.extra).toEqual({ x: 1 })
    expect(r.data.revisionIdeas.orphan).toBeUndefined()
    expect(r.data.critiquePrompts.shared2).toBeDefined()
    expect(r.fixes.length).toBeGreaterThan(0)
    // 壊れていなければ同じオブジェクト
    expect(repairData(data).data).toBe(data)
    expect(titleId).toBeTruthy()
  })
})
