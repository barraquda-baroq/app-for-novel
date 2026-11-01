import { describe, expect, it } from 'vitest'
import { addClaudeRecords } from '../domain/claudeOps'
import { novel, splitEpisode } from '../test/claudeFixture'
import type { AppData, ID } from '../domain/types'
import {
  critiqueResultsOf,
  openProofSuggestionsFor,
  partMarkOf,
  proofStoryRank,
  proofSuggestionsOf,
  sortProofSuggestions,
  strategyNotesOf,
} from './order'
import { buildCritiquePrompt, buildCritiqueResult, buildProofreading, buildStrategyNote, RECORD_LIMITS } from './records'

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

describe('分けて記録した批評の結果・戦略メモ（「（1/3）」…）は、まとめて番号の順', () => {
  const DAY = Date.UTC(2026, 9, 28, 3) // 2026-10-28（日本時間の昼）

  /** コネクタと同じ作り方で批評の結果を足す（now に作る） */
  function addResult(n: { data: AppData; titleId: ID }, markdown: string, now: number, extra: Record<string, unknown> = {}) {
    const r = buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: markdown, ...extra }, { source: 'claude', now })
    expect(r.ok && r.items[0].status).toBe('created')
    n.data = addClaudeRecords(n.data, r.records).data
  }

  const heads = (n: { data: AppData; titleId: ID }) =>
    critiqueResultsOf(n.data, n.titleId).map((r) => r.resultMarkdown.split('\n')[0])

  it('番号の読み方（本文）: 1行目の先頭の「（i/k）」だけ（半角・全角・前置きの字・Markdown の記号・「**結論**：」の後ろも）', () => {
    // 先頭
    expect(partMarkOf('（1/3）\n## 総評', 'body')).toEqual({ index: 1, count: 3 })
    expect(partMarkOf('\n\n（2／3）', 'body')).toEqual({ index: 2, count: 3 })
    expect(partMarkOf('(前半 1/2) 批評', 'body')).toEqual({ index: 1, count: 2 })
    expect(partMarkOf('（２/２）続き', 'body')).toEqual({ index: 2, count: 2 })
    expect(partMarkOf('## （1/2）総評', 'body')).toEqual({ index: 1, count: 2 })
    expect(partMarkOf('> （2/2）', 'body')).toEqual({ index: 2, count: 2 })
    expect(partMarkOf('**（1/2）** 構成', 'body')).toEqual({ index: 1, count: 2 })
    // 見出し語とコロン1つの後ろ
    expect(partMarkOf('**結論**：（1/2）前半の要点', 'body')).toEqual({ index: 1, count: 2 })
    expect(partMarkOf('**要点：** （2/2）', 'body')).toEqual({ index: 2, count: 2 })
    expect(partMarkOf('結論:（１/２）', 'body')).toEqual({ index: 1, count: 2 })
    // 行の途中・末尾は番号ではない（「12項目中（7/12）」や日付の「（3/5）」で並べ替えないように）
    expect(partMarkOf('**結論**：12項目中（7/12）が届き、残りは弱い', 'body')).toBeNull()
    expect(partMarkOf('3月の打ち合わせ（3/5）で決めたこと', 'body')).toBeNull()
    expect(partMarkOf('## 総評（2／3）', 'body')).toBeNull()
    expect(partMarkOf('# 批評 (前半 1/2)', 'body')).toBeNull()
    expect(partMarkOf('**結論**：**要点**：（1/2）', 'body')).toBeNull()
    // 番号でないもの・2行目以降
    expect(partMarkOf('（3/5点）の評価', 'body')).toBeNull()
    expect(partMarkOf('**結論**：（3/5点）', 'body')).toBeNull()
    expect(partMarkOf('## 総評\n（1/2）', 'body')).toBeNull()
    expect(partMarkOf('（3/2）', 'body')).toBeNull()
    expect(partMarkOf('（1/1）', 'body')).toBeNull()
    expect(partMarkOf('', 'body')).toBeNull()
  })

  it('番号の読み方（見出し・名前）: 先頭か末尾の「（i/k）」。途中や「（3/5点）」は番号ではない', () => {
    expect(partMarkOf('応募戦略（1/3）', 'heading')).toEqual({ index: 1, count: 3 })
    expect(partMarkOf('応募戦略 (２／３) ', 'heading')).toEqual({ index: 2, count: 3 })
    expect(partMarkOf('## 総評（2／3）', 'heading')).toEqual({ index: 2, count: 3 })
    expect(partMarkOf('# 批評 (前半 1/2)', 'heading')).toEqual({ index: 1, count: 2 })
    expect(partMarkOf('（3/3）応募戦略', 'heading')).toEqual({ index: 3, count: 3 })
    expect(partMarkOf('応募戦略（1/3）の続き', 'heading')).toBeNull()
    expect(partMarkOf('12項目中（7/12）が届く', 'heading')).toBeNull()
    expect(partMarkOf('総評（3/5点）', 'heading')).toBeNull()
    expect(partMarkOf('総評（1/1）', 'heading')).toBeNull()
    // 200字を超える行は、末尾を見ない（途中で切った所を末尾と読まないように）
    expect(partMarkOf(`${'あ'.repeat(195)}（1/2）の続き`, 'heading')).toBeNull()
    expect(partMarkOf(`${'あ'.repeat(190)}（1/2）`, 'heading')).toEqual({ index: 1, count: 2 })
    expect(partMarkOf('', 'heading')).toBeNull()
  })

  it('同じ日の結果の1行目の途中にある「（7/12）」「（3/12）」では並べ替えない（新しい順のまま）', () => {
    const n = novel(['本文'])
    addResult(n, '**結論**：12項目中（3/12）が届いていない\n本文', DAY + 1_000)
    addResult(n, '**結論**：12項目中（7/12）が届き、残りは弱い\n本文', DAY + 2_000)
    addResult(n, '**結論**：（2/2）後半\n本文', DAY + 4_000)
    addResult(n, '**結論**：（1/2）前半\n本文', DAY + 3_000)
    expect(heads(n)).toEqual([
      '**結論**：（1/2）前半',
      '**結論**：（2/2）後半',
      '**結論**：12項目中（7/12）が届き、残りは弱い',
      '**結論**：12項目中（3/12）が届いていない',
    ])
  })

  it('Claude が1つ目から順に送った部分は、新しい順の中でも（1/3）→（3/3）の順。前後の結果の並びはそのまま', () => {
    const n = novel(['本文'])
    addResult(n, '## 前の日の批評', DAY - 86_400_000)
    addResult(n, '## 同じ日の前の批評', DAY)
    for (let i = 1; i <= 3; i++) addResult(n, `（${i}/3）\n## 第${i}部`, DAY + i * 1_000)
    addResult(n, '## 後で足した批評', DAY + 10_000)
    expect(heads(n)).toEqual(['## 後で足した批評', '（1/3）', '（2/3）', '（3/3）', '## 同じ日の前の批評', '## 前の日の批評'])
  })

  it('逆の順・同じ時刻（1回の貼り付け）で届いた部分も番号の順。同じ日に2回分けて記録したものは別のまとまり', () => {
    const n = novel(['本文'])
    addResult(n, '（2/2）\n前の回の後半', DAY + 1_000)
    addResult(n, '（1/2）\n前の回の前半', DAY + 2_000)
    addResult(n, '（1/2）\n後の回の前半', DAY + 5_000)
    addResult(n, '（2/2）\n後の回の後半', DAY + 5_000)
    expect(critiqueResultsOf(n.data, n.titleId).map((r) => r.resultMarkdown.split('\n')[1])).toEqual([
      '後の回の前半',
      '後の回の後半',
      '前の回の前半',
      '前の回の後半',
    ])
  })

  it('違うプロンプト・違う日の結果や、片方しかない部分はまとめない', () => {
    const n = novel(['本文'])
    const promptIds = ['A', 'B'].map((name) => {
      const r = buildCritiquePrompt(
        n.data,
        { scope: 'title', title_id: n.titleId, name, body: `${name} を見て` },
        { source: 'claude', now: DAY },
      )
      n.data = addClaudeRecords(n.data, r.records).data
      return r.items[0].id!
    })
    addResult(n, '（1/2）\nAの前半', DAY + 1_000, { prompt_id: promptIds[0] })
    addResult(n, '（2/2）\nBの後半', DAY + 2_000, { prompt_id: promptIds[1] })
    addResult(n, '（1/2）\n前の日の前半', DAY - 86_400_000, { prompt_id: promptIds[0] })
    expect(heads(n)).toEqual(['（2/2）', '（1/2）', '（1/2）'])
    expect(critiqueResultsOf(n.data, n.titleId).map((r) => r.promptName)).toEqual(['B', 'A', 'A'])
  })

  it('大きすぎてコネクタが分けるように答えた結果を、答えのとおりに分けて送ると、読む順に並ぶ（アプリとコネクタの一覧で同じ）', () => {
    const n = novel(['本文'])
    const markdown = Array.from(
      { length: 60 },
      (_, i) => `## 第${i + 1}章\n${'人物の弧がはっきりしています。'.repeat(250)}`,
    ).join('\n\n')
    const big = buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: markdown }, { source: 'claude', now: DAY })
    const hint = big.ok ? (big.items[0].hint ?? '') : ''
    expect(hint).toContain('「（1/')
    const k = Number(/result_markdown を(\d+)つ以上に分け/.exec(hint)![1])
    const chapters = markdown.split('\n\n')
    const per = Math.ceil(chapters.length / k)
    for (let i = 0; i < k; i++) {
      const part = `（${i + 1}/${k}）\n${chapters.slice(i * per, (i + 1) * per).join('\n\n')}`
      expect(part.length).toBeLessThan(RECORD_LIMITS.recordJson)
      addResult(n, part, DAY + (i + 1) * 1_000)
    }
    const listed = critiqueResultsOf(n.data, n.titleId)
    expect(listed.map((r) => r.resultMarkdown.split('\n')[0])).toEqual(Array.from({ length: k }, (_, i) => `（${i + 1}/${k}）`))
    expect(listed.map((r) => r.resultMarkdown.slice(r.resultMarkdown.indexOf('\n') + 1)).join('\n\n')).toBe(markdown)
  })

  it('戦略メモも、見出しの番号の順', () => {
    const n = novel(['本文'])
    const add = (heading: string, now: number, body = `${heading}の本文`) => {
      const r = buildStrategyNote(n.data, { title_id: n.titleId, heading, body }, { source: 'claude', now })
      n.data = addClaudeRecords(n.data, r.records).data
    }
    add('前のメモ', DAY)
    add('応募戦略（1/3）', DAY + 1_000)
    add('応募戦略（2/3）', DAY + 2_000)
    add('応募戦略（3/3）', DAY + 3_000)
    expect(strategyNotesOf(n.data, n.titleId).map((x) => x.heading)).toEqual([
      '応募戦略（1/3）',
      '応募戦略（2/3）',
      '応募戦略（3/3）',
      '前のメモ',
    ])
    // 見出しに番号が無ければ本文の1行目の先頭の番号。本文の行の途中の「（7/12）」は番号ではない
    const NEXT = DAY + 86_400_000
    add('公募の候補', NEXT + 1_000, '（1/2）前半')
    add('公募の候補', NEXT + 2_000, '（2/2）後半')
    add('振り返り', NEXT + 3_000, '**結論**：12項目中（3/12）が届いていない')
    add('振り返り', NEXT + 4_000, '**結論**：12項目中（7/12）が届いた')
    expect(
      strategyNotesOf(n.data, n.titleId)
        .slice(0, 4)
        .map((x) => x.body),
    ).toEqual(['**結論**：12項目中（7/12）が届いた', '**結論**：12項目中（3/12）が届いていない', '（1/2）前半', '（2/2）後半'])
  })
})
