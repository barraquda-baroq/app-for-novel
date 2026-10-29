import { describe, expect, it } from 'vitest'
import { proofRunsOf, proofSuggestionsOf } from '../../../claude/order'
import { buildProofreading, type ProofItemInput } from '../../../claude/records'
import { joinActWithNext } from '../../../domain/acts'
import { addClaudeRecords, setProofDone } from '../../../domain/claudeOps'
import { deletePiece, updateVersion } from '../../../domain/storyOps'
import type { AppData, ID } from '../../../domain/types'
import { novel, splitEpisode, type Novel } from '../../../test/claudeFixture'
import {
  categoriesIn,
  DEFAULT_PROOF_FILTER,
  filterProofSuggestions,
  linkedPieces,
  MANUAL_RUN,
  previewText,
  proofPlace,
  runLine,
} from './proofLogic'
import { episodeNumbers } from '../../../domain/structure'

const NOW = Date.UTC(2026, 9, 28, 3, 0)

function suggest(n: Novel, items: ProofItemInput[], now = NOW, runLabel = 'ワードサーチ'): AppData {
  const r = buildProofreading(n.data, { title_id: n.titleId, run_label: runLabel, items }, { source: 'paste', now })
  expect(r.ok).toBe(true)
  n.data = addClaudeRecords(n.data, r.records).data
  return n.data
}

const byExcerpt = (data: AppData, titleId: ID, excerpt: string) =>
  proofSuggestionsOf(data, titleId).find((s) => s.excerpt === excerpt)!

describe('推敲案の場所', () => {
  it('いまの本文の段落で「第2話 ¶3」と出し、本文が変わっていれば探し直す', () => {
    const n = novel(['一行目。', '最初の段落。\n\n二つ目。\n\n窓から見れる景色。'])
    suggest(n, [{ piece: '#2', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }])
    const s = byExcerpt(n.data, n.titleId, '見れる')
    expect(proofPlace(n.data, s)).toMatchObject({ state: 'found', label: '第2話 ¶3', pieceId: n.ids[1] })
    // 前に段落を足しても探し直す
    const v = n.data.pieces[n.ids[1]].versionIds[0]
    const moved = updateVersion(n.data, v, { body: `前置き。\n\n${n.data.versions[v].body}` })
    expect(proofPlace(moved, s)).toMatchObject({ state: 'found', label: '第2話 ¶4' })
    // 直したら見つからない
    const fixed = updateVersion(n.data, v, { body: '最初の段落。\n\n窓から見られる景色。' })
    expect(proofPlace(fixed, s)).toMatchObject({ state: 'lost', label: '第2話', pieceId: n.ids[1] })
  })

  it('幕に分けた話の推敲案は「第1話 第2幕 ¶1」。幕をつないだ後も話の本文で探す', () => {
    const n = novel(['前半の文。後半で見れる景色。'])
    const { acts } = splitEpisode(n, n.ids[0], [5])
    suggest(n, [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }])
    const s = byExcerpt(n.data, n.titleId, '見れる')
    expect(s.pieceId).toBe(acts[1])
    expect(proofPlace(n.data, s)).toMatchObject({ state: 'found', label: '第1話 第2幕 ¶1', pieceId: acts[1] })
    const joined = joinActWithNext(n.data, acts[0]).data
    expect(proofPlace(joined, s)).toMatchObject({ state: 'found', label: '第1話 第1幕 ¶1', pieceId: acts[0] })
  })

  it('話が削除されていれば、作った時の表記で「見つからない」', () => {
    const n = novel(['一。', '見れる。'])
    suggest(n, [{ piece: '#2', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }])
    const s = byExcerpt(n.data, n.titleId, '見れる')
    const gone = deletePiece(n.data, n.ids[1])
    expect(proofPlace(gone, s)).toMatchObject({ state: 'missing', label: '第2話', pieceId: null })
  })
})

describe('推敲案の絞り込みと実行', () => {
  it('種類・状態・実行で絞り込み（並びはそのまま）、種類は多い順', () => {
    const n = novel(['見れる。食べれる。', '来れる。紋切り型の表現。'])
    suggest(
      n,
      [
        { piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'a' },
        { piece: '#1', excerpt: '食べれる', category: 'ra_nuki', reason: 'b' },
      ],
      NOW,
      '第1話',
    )
    suggest(
      n,
      [
        { piece: '#2', excerpt: '来れる', category: 'ra_nuki', reason: 'c' },
        { piece: '#2', excerpt: '紋切り型', category: 'cliche', reason: 'd' },
      ],
      NOW + 60_000,
      '第2話',
    )
    let data = n.data
    const all = proofSuggestionsOf(data, n.titleId)
    expect(categoriesIn(all).map((c) => [c.value, c.count])).toEqual([
      ['ra_nuki', 3],
      ['cliche', 1],
    ])
    expect(filterProofSuggestions(all, { ...DEFAULT_PROOF_FILTER, category: 'cliche' }).map((s) => s.excerpt)).toEqual([
      '紋切り型',
    ])
    data = setProofDone(data, byExcerpt(data, n.titleId, '見れる').id, true)
    const after = proofSuggestionsOf(data, n.titleId)
    expect(filterProofSuggestions(after, { ...DEFAULT_PROOF_FILTER, status: 'done' }).map((s) => s.excerpt)).toEqual(['見れる'])
    expect(filterProofSuggestions(after, { ...DEFAULT_PROOF_FILTER, status: 'open' })).toHaveLength(3)
    const runs = proofRunsOf(data, n.titleId)
    expect(runs.map((r) => runLine(r, '2026-10-28'))).toEqual(['10/28 第2話 2件', '10/28 第1話 2件'])
    expect(
      filterProofSuggestions(after, { ...DEFAULT_PROOF_FILTER, runId: runs[1].runId })
        .map((s) => s.excerpt)
        .sort(),
    ).toEqual(['見れる', '食べれる'].sort())
    expect(filterProofSuggestions(after, { ...DEFAULT_PROOF_FILTER, runId: MANUAL_RUN })).toEqual([])
    expect(runLine({ runDate: '2025-10-28', runLabel: '', count: 3 }, '2026-10-28')).toBe('2025/10/28 Claude の推敲案 3件')
  })
})

describe('改稿案の話のチップと抜粋', () => {
  it('消えた話・別のタイトルの話は出さない', () => {
    const n = novel(['一', '二'])
    const other = novel(['別'], { data: n.data })
    const numbers = episodeNumbers(other.data, n.titleId)
    expect(linkedPieces(other.data, n.titleId, [n.ids[1], 'gone', other.ids[0], n.ids[0]], numbers)).toEqual([
      { id: n.ids[1], label: '第2話' },
      { id: n.ids[0], label: '第1話' },
    ])
    expect(previewText('  あ\n\nい  ', 10)).toBe('あ い')
    expect(previewText('あ'.repeat(12), 10)).toBe(`${'あ'.repeat(10)}…`)
  })
})
