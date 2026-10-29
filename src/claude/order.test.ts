import { describe, expect, it } from 'vitest'
import { addClaudeRecords } from '../domain/claudeOps'
import { novel, splitEpisode } from '../test/claudeFixture'
import { openProofSuggestionsFor, proofStoryRank, proofSuggestionsOf, sortProofSuggestions } from './order'
import { buildProofreading } from './records'

describe('推敲案の並び（1回の追加の中は読む順）', () => {
  /** 1回の追加で、#3・#1・#2 の順に返した推敲案 */
  function oneRun() {
    const n = novel(['一話の見れる景色。', '二話の来れる日。二話の食べれる物。', '三話の寝れる夜。'])
    const r = buildProofreading(
      n.data,
      {
        title_id: n.titleId,
        run_label: 'ら抜き',
        items: [
          { piece: '#3', excerpt: '寝れる', category: 'ra_nuki', reason: 'ら抜き' },
          { piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' },
          { piece: '#2', excerpt: '食べれる', category: 'ra_nuki', reason: 'ら抜き' },
          { piece: '#2', excerpt: '来れる', category: 'ra_nuki', reason: 'ら抜き' },
        ],
      },
      { source: 'claude', now: 1_000 },
    )
    n.data = addClaudeRecords(n.data, r.records).data
    return n
  }

  it('同じ時に作った推敲案は、話の順 → 本文の位置の順', () => {
    const n = oneRun()
    expect(proofSuggestionsOf(n.data, n.titleId).map((s) => s.excerpt)).toEqual(['見れる', '来れる', '食べれる', '寝れる'])
    // 原稿画面の一覧も本文の位置の順
    expect(openProofSuggestionsFor(n.data, n.ids[1]).map((s) => s.excerpt)).toEqual(['来れる', '食べれる'])
    // rank を渡さなければ、これまでどおり（id の順）
    const plain = sortProofSuggestions(Object.values(n.data.proofSuggestions)).map((s) => s.id)
    expect(plain).toEqual([...plain].sort())
  })

  it('チェック・フラグ・新しい追加の順はそのまま。幕は幕の順', () => {
    const n = oneRun()
    const later = buildProofreading(
      n.data,
      { title_id: n.titleId, items: [{ piece: '#3', excerpt: '三話の', category: 'other', reason: '重複' }] },
      { source: 'claude', now: 2_000 },
    )
    n.data = addClaudeRecords(n.data, later.records).data
    expect(proofSuggestionsOf(n.data, n.titleId).map((s) => s.excerpt)).toEqual([
      '三話の',
      '見れる',
      '来れる',
      '食べれる',
      '寝れる',
    ])
    // 幕に分けた話: 第1幕 → 第2幕
    const { acts } = splitEpisode(n, n.ids[1], [8])
    const rank = proofStoryRank(n.data, n.titleId)
    const inActs = Object.values(n.data.proofSuggestions).map((s) =>
      s.excerpt === '食べれる'
        ? { ...s, pieceId: acts[1], parentId: n.ids[1], anchor: s.anchor && { ...s.anchor, offset: 0 } }
        : s,
    )
    expect(sortProofSuggestions(inActs, rank).map((s) => s.excerpt)).toEqual(['三話の', '見れる', '来れる', '食べれる', '寝れる'])
  })
})
