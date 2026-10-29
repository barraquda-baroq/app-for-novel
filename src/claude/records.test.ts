import { describe, expect, it } from 'vitest'
import { decodeRecord, encodeRecord } from '../sync/codec'
import { stableStringify } from '../sync/merge'
import { addClaudeRecords, deleteProofSuggestion } from '../domain/claudeOps'
import type { AppData } from '../domain/types'
import { novel, splitEpisode } from '../test/claudeFixture'
import {
  buildCritiquePrompt,
  buildCritiqueResult,
  buildProofreading,
  buildRevisionIdeas,
  buildStrategyNote,
  charLength,
  isHttpsUrl,
  recordFits,
  RECORD_LIMITS,
  summarizeItems,
  trashedIdsOf,
  type BuildContext,
  type NewRecord,
} from './records'
import { shortId } from './refs'

const NOW = Date.UTC(2026, 9, 28, 3, 0)
const claude: BuildContext = { source: 'claude', now: NOW }

function sample() {
  const n = novel(
    [
      '窓から見れる景色は美しい。\n彼は｜東京《とうきょう》駅へ。',
      '猫が来た。猫が来た。',
      '第一幕の本文。\n第二幕の食べれる本文。',
    ],
    {
      subtitles: ['出発', '', '雨'],
    },
  )
  const { acts } = splitEpisode(n, n.ids[2], [8])
  return { ...n, acts }
}

const add = (data: AppData, records: readonly NewRecord[]) => addClaudeRecords(data, records).data

describe('推敲案（novel_add_proofreading）', () => {
  it('採用原稿で場所を探し、推敲案と実行の記録を作る', () => {
    const n = sample()
    const r = buildProofreading(
      n.data,
      {
        title_id: shortId('title', n.titleId),
        run_label: 'ワードサーチ（第1〜3話）',
        covered: ['#1', '#2', '#3'],
        items: [
          { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き', important: true },
          { piece: '第1話', excerpt: '東京駅', category: 'notation', reason: 'ルビの位置' },
          { piece: '#3', excerpt: '食べれる', category: 'ra_nuki', suggestion: '食べられる', reason: 'ら抜き' },
          { piece: '#2', excerpt: '来た', category: 'repetition', reason: '重複' },
          { piece: '#2', excerpt: '去った', category: 'typo', reason: 'x' },
          { piece: '#9', excerpt: 'x', category: 'typo', reason: 'x' },
          { piece: '#1', excerpt: 'あ'.repeat(101), category: 'typo', reason: 'x' },
        ],
      },
      claude,
    )
    expect(r.ok).toBe(true)
    expect(r.items.map((x) => x.status)).toEqual([
      'created',
      'created',
      'created',
      'ambiguous',
      'not_found',
      'not_found',
      'invalid',
    ])
    const recs = r.records.map((x) => x.record) as AppData['proofSuggestions'][string][]
    expect(r.records.map((x) => x.table)).toEqual(['proofSuggestions', 'proofSuggestions', 'proofSuggestions', 'proofBatches'])
    const [a, b, c] = recs
    expect(a).toMatchObject({
      source: 'claude',
      v: 1,
      titleId: n.titleId,
      pieceId: n.ids[0],
      parentId: null,
      pieceLabel: '第1話　出発',
      category: 'ra_nuki',
      categoryLabel: 'ら抜き',
      flagged: true,
      done: false,
      createdAt: NOW,
    })
    expect(a.anchor).toMatchObject({ offset: 3, length: 3, paragraph: 1 })
    expect(b.anchor?.paragraph).toBe(2)
    expect(c).toMatchObject({ pieceId: n.acts[1], parentId: n.ids[2], pieceLabel: '第3話　雨　第2幕' })
    const batch = r.records[3].record as AppData['proofBatches'][string]
    expect(batch).toMatchObject({ runLabel: 'ワードサーチ（第1〜3話）', runDate: '2026-10-28', runId: a.runId })
    expect(batch.covered.map((x) => x.pieceId)).toEqual(n.ids)
    expect(batch.covered[2].versionId).toBeNull()
    expect(batch.itemIds).toEqual([a.id, b.id, c.id])
    expect(recs.slice(0, 3).every((x) => x.batchId === batch.id)).toBe(true)
    expect(r.items[3].candidates).toHaveLength(2)
    expect(r.items[3].hint).toContain('context_before')
    expect(summarizeItems(r.items)).toBe('追加 3件・見つからない 2件・場所が決まらない 1件・形が違う 1件')
  })
  it('同じ内容をもう一度送っても作らない（duplicate）。以前に削除したものは previously_deleted', () => {
    const n = sample()
    const input = {
      title_id: n.titleId,
      items: [
        { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' },
        { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き（同じ）' },
      ],
    }
    const first = buildProofreading(n.data, input, claude)
    expect(first.items.map((x) => x.status)).toEqual(['created', 'duplicate'])
    const data = add(n.data, first.records)
    const again = buildProofreading(data, input, { ...claude, now: NOW + 1000 })
    expect(again.items.map((x) => x.status)).toEqual(['duplicate', 'duplicate'])
    expect(again.records).toEqual([])
    const id = first.items[0].id!
    const deleted = deleteProofSuggestion(data, id)
    const third = buildProofreading(deleted, input, { ...claude, wasDeleted: trashedIdsOf(deleted) })
    expect(third.items.map((x) => x.status)).toEqual(['previously_deleted', 'previously_deleted'])
    expect(third.records).toEqual([])
    // ゴミ箱にある id は、アプリの addClaudeRecords でも入れない
    expect(addClaudeRecords(deleted, first.records).result).toEqual([])
  })
  it('知らない種類は other にして名前を残す。書き込めないタイトルはコネクタからは書けない（貼り付けは書ける）', () => {
    const n = sample()
    const r = buildProofreading(
      n.data,
      { title_id: n.titleId, items: [{ piece: '#1', excerpt: '見れる', category: 'kanji', reason: 'x' }] },
      claude,
    )
    expect(r.records[0].record).toMatchObject({ category: 'other', categoryLabel: 'kanji' })
    expect(r.notes[0]).toContain('other')
    const ro: AppData = { ...n.data, titles: { [n.titleId]: { ...n.data.titles[n.titleId], claudeAccess: 'read' } } }
    const denied = buildProofreading(ro, { title_id: n.titleId, items: [] }, claude)
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('書き込み不可')
    expect(denied.error).toContain('タイトル画面の「Claude に見せる」')
    expect(buildProofreading(ro, { title_id: n.titleId, items: [] }, { ...claude, source: 'paste' }).ok).toBe(true)
  })
  it('確かめた話だけでも実行の記録を残す。多すぎる入力は受け付けない', () => {
    const n = sample()
    const r = buildProofreading(n.data, { title_id: n.titleId, covered: ['#1', '#7'], items: [] }, claude)
    expect(r.records.map((x) => x.table)).toEqual(['proofBatches'])
    expect(r.notes.join()).toContain('#7')
    const many = buildProofreading(n.data, { title_id: n.titleId, items: Array(101).fill({}) }, claude)
    expect(many.ok).toBe(false)
  })
  it('作った記録は同期の形にしてもそのまま読める（分割文書なし・200,000字以内）', () => {
    const n = sample()
    const r = buildProofreading(
      n.data,
      { title_id: n.titleId, items: [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'x' }], covered: ['#1'] },
      claude,
    )
    for (const { table, record } of r.records) {
      const enc = encodeRecord(record as never)
      expect(enc.parts).toHaveLength(0)
      expect(enc.json!.length).toBeLessThanOrEqual(RECORD_LIMITS.recordJson)
      const back = decodeRecord(
        {
          table,
          id: record.id,
          json: enc.json,
          hash: enc.hash,
          chunks: 0,
          deleted: false,
          updated: null,
          device: 'claude-connector',
        },
        () => undefined,
      )
      expect(back).toEqual(record)
    }
  })
})

describe('改稿案・戦略メモ・批評プロンプト・批評結果', () => {
  it('改稿案: 見つからない話は外して知らせる。order は今ある案の後ろ', () => {
    const n = sample()
    const r = buildRevisionIdeas(
      n.data,
      {
        title_id: n.titleId,
        items: [
          { heading: '冒頭を短く', body: '第1話の冒頭を削る', pieces: ['#1', '#99'] },
          { heading: '', body: 'x' },
          { heading: 'あ'.repeat(RECORD_LIMITS.revisionHeading + 1), body: 'x' },
        ],
      },
      claude,
    )
    expect(r.items.map((x) => x.status)).toEqual(['created', 'invalid', 'invalid'])
    expect(r.items[2].hint).toBe('heading が長すぎます（80字まで。いま 81字）')
    expect(r.items[0].hint).toContain('#99')
    expect(r.records[0].record).toMatchObject({
      heading: '冒頭を短く',
      checked: false,
      checkedAt: null,
      pieceIds: [n.ids[0]],
      order: 0,
    })
  })
  it('戦略メモ: コンテストの URL は https だけ、締切は YYYY-MM-DD だけ', () => {
    const n = sample()
    const r = buildStrategyNote(
      n.data,
      {
        title_id: n.titleId,
        heading: '応募戦略',
        body: '## 狙い\n長編賞',
        contests: [
          {
            name: '〇〇大賞',
            url: 'http://example.com',
            deadline: '2027-03-31',
            limit: { min: 80000, max: 150000, unit: 'chars' },
            fit: '合う',
            plan: '削る',
          },
          { name: '△△賞', url: 'https://example.com/a', deadline: '3月末' },
          { organizer: '名前なし' } as never,
        ],
      },
      claude,
    )
    expect(r.items[0].status).toBe('created')
    const note = r.records[0].record as AppData['strategyNotes'][string]
    expect(note.contests.map((c) => [c.id, c.name, c.url, c.deadline])).toEqual([
      ['k0', '〇〇大賞', '', '2027-03-31'],
      ['k1', '△△賞', 'https://example.com/a', ''],
    ])
    expect(note.contests[0]).toMatchObject({
      minChars: 80000,
      maxChars: 150000,
      limitUnit: 'chars',
      fit: '合う',
      plan: '削る',
      submissionId: null,
    })
    expect(note.runDate).toBe('2026-10-28')
    expect(r.notes).toHaveLength(3)
  })
  it('批評プロンプト: 共通のもの（titleId = null）とタイトルのもの', () => {
    const n = sample()
    const shared = buildCritiquePrompt(n.data, { scope: 'shared', name: '構成', body: '構成を見て' }, claude)
    expect(shared.records[0].record).toMatchObject({ titleId: null, name: '構成', order: 0 })
    const own = buildCritiquePrompt(n.data, { scope: 'title', title_id: n.titleId, name: '構成', body: '構成を見て' }, claude)
    expect(own.records[0].record).toMatchObject({ titleId: n.titleId })
    expect(own.records[0].record.id).not.toBe(shared.records[0].record.id)
    expect(buildCritiquePrompt(n.data, { scope: 'title', name: 'x', body: 'y' }, claude).ok).toBe(false)
  })
  it('批評結果: プロンプトの控え・範囲・原稿の控え。結果か URL のどちらかが要る', () => {
    const n = sample()
    const p = buildCritiquePrompt(n.data, { scope: 'shared', name: '構成', body: '構成を見て' }, claude)
    const data = add(n.data, p.records)
    const r = buildCritiqueResult(
      data,
      {
        title_id: n.titleId,
        prompt_id: shortId('critiquePrompt', p.records[0].record.id),
        result_markdown: '## 総評\nよい',
        artifact_url: 'https://claude.ai/public/artifacts/abc',
        scope: { from: '#1', to: '#2' },
        model: 'claude-opus-5-5',
      },
      claude,
    )
    expect(r.items[0].status).toBe('created')
    expect(r.records[0].record).toMatchObject({
      promptId: p.records[0].record.id,
      promptName: '構成',
      promptText: '構成を見て',
      runDate: '2026-10-28',
      scope: { kind: 'range', fromPieceId: n.ids[0], toPieceId: n.ids[1], label: '第1話　出発〜第2話' },
      model: 'claude-opus-5-5',
      note: '',
      manuscript: { pieces: 3, at: NOW },
    })
    expect(buildCritiqueResult(data, { title_id: n.titleId }, claude).items[0].status).toBe('invalid')
    expect(buildCritiqueResult(data, { title_id: n.titleId, artifact_url: 'javascript:alert(1)' }, claude).items[0].status).toBe(
      'invalid',
    )
    expect(buildCritiqueResult(data, { title_id: n.titleId, prompt_id: 'q:zzzz', result_markdown: 'x' }, claude).ok).toBe(false)
  })
})

describe('長さ: 長い文章には上限が無い（短い項目と件数だけ）', () => {
  const paste: BuildContext = { source: 'paste', now: NOW }
  /** 段落に分けた長い文章（全部で chars 字） */
  const long = (label: string, chars: number) => {
    const line = `${label}の段落。${'あ'.repeat(93)}\n`
    return line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
  }

  it('貼り付け: 25万字の批評の結果・プロンプト・改稿案・戦略メモもそのまま記録にする（切り詰めない・分割文書で同期できる）', () => {
    const n = sample()
    const promptBody = long('依頼', 250_000)
    const p = buildCritiquePrompt(n.data, { scope: 'title', title_id: n.titleId, name: '長い依頼', body: promptBody }, paste)
    expect(p.items[0].status).toBe('created')
    expect((p.records[0].record as AppData['critiquePrompts'][string]).body).toBe(promptBody)
    const data = add(n.data, p.records)
    const markdown = long('批評', 250_000)
    const r = buildCritiqueResult(
      data,
      { title_id: n.titleId, prompt_id: shortId('critiquePrompt', p.records[0].record.id), result_markdown: markdown },
      paste,
    )
    expect(r.items[0].status).toBe('created')
    const result = r.records[0].record as AppData['critiqueResults'][string]
    expect(result.resultMarkdown).toBe(markdown)
    expect(result.promptText).toBe(promptBody)
    // 端末の同期: 1つの文書に入らない大きさは分割文書に分けて送り、そのまま読み戻せる
    const enc = encodeRecord(result as never)
    expect(enc.json).toBeNull()
    expect(enc.parts.length).toBeGreaterThan(1)
    const back = decodeRecord(
      {
        table: 'critiqueResults',
        id: result.id,
        json: null,
        hash: enc.hash,
        chunks: enc.parts.length,
        deleted: false,
        updated: null,
        device: 'd',
      },
      (i) => ({
        table: '_chunk',
        parent: `critiqueResults:${result.id}`,
        index: i,
        json: enc.parts[i],
        hash: enc.hash,
        updated: null,
        device: 'd',
        deleted: false,
      }),
    )
    expect(back && stableStringify(back) === stableStringify(result)).toBe(true)

    const idea = buildRevisionIdeas(data, { title_id: n.titleId, items: [{ heading: '書き直し', body: markdown }] }, paste)
    expect(idea.items[0].status).toBe('created')
    expect((idea.records[0].record as AppData['revisionIdeas'][string]).body).toBe(markdown)
    const fit = 'あ'.repeat(5_000)
    const plan = 'い'.repeat(20_000)
    const note = buildStrategyNote(
      data,
      { title_id: n.titleId, heading: '戦略', body: markdown, contests: [{ name: '〇〇賞', fit, plan }] },
      paste,
    )
    expect(note.items[0].status).toBe('created')
    const rec = note.records[0].record as AppData['strategyNotes'][string]
    expect(rec.body).toBe(markdown)
    expect(rec.contests[0]).toMatchObject({ fit, plan })
  })

  it('コネクタ: 前の上限（結果 60,000・プロンプト 20,000・改稿案 50,000・戦略メモ 30,000・方針 2,000字）を超えても、1件が 200,000字に入れば作る', () => {
    const n = sample()
    const p = buildCritiquePrompt(n.data, { scope: 'shared', name: '依頼', body: long('依頼', 40_000) }, claude)
    expect(p.items[0].status).toBe('created')
    const data = add(n.data, p.records)
    const r = buildCritiqueResult(
      data,
      {
        title_id: n.titleId,
        prompt_id: shortId('critiquePrompt', p.records[0].record.id),
        result_markdown: long('批評', 120_000),
      },
      claude,
    )
    expect(r.items[0].status).toBe('created')
    expect(recordFits(r.records[0].record)).toBe(true)
    const idea = buildRevisionIdeas(data, { title_id: n.titleId, items: [{ heading: '案', body: long('案', 150_000) }] }, claude)
    expect(idea.items[0].status).toBe('created')
    const note = buildStrategyNote(
      data,
      {
        title_id: n.titleId,
        heading: '戦略',
        body: long('戦略', 100_000),
        contests: [{ name: '賞', fit: 'あ'.repeat(1_000), plan: 'い'.repeat(10_000) }],
      },
      claude,
    )
    expect(note.items[0].status).toBe('created')
  })

  it('コネクタ: 1件が 200,000字を超える時は作らず、いまの大きさと何件に分ければよいかを返す', () => {
    const n = sample()
    const markdown = long('批評', 250_000)
    const r = buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: markdown }, claude)
    expect(r.ok).toBe(true)
    expect(r.records).toEqual([])
    expect(r.items[0].status).toBe('invalid')
    const hint = r.items[0].hint!
    expect(hint).toContain('批評の結果が大きすぎて1件の記録に入りません')
    expect(hint).toContain('JSON にして 200,000字まで')
    expect(hint).toMatch(/いま 2\d\d,\d{3}字/)
    expect(hint).toContain('result_markdown を2つ以上に分け')
    expect(hint).toContain('novel_add_critique_result を分けて呼んでください')
    // 分けた数のとおりに分ければ、どの部分も入る
    const k = Number(/result_markdown を(\d+)つ以上/.exec(hint)![1])
    const size = Math.ceil(markdown.length / k)
    for (let i = 0; i < k; i++) {
      const part = `（${i + 1}/${k}）\n${markdown.slice(i * size, (i + 1) * size)}`
      expect(buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: part }, claude).items[0].status).toBe('created')
    }
    // 3倍なら少なくとも4つ
    const huge = buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: long('批評', 600_000) }, claude)
    expect(Number(/result_markdown を(\d+)つ以上/.exec(huge.items[0].hint!)![1])).toBeGreaterThanOrEqual(4)
    // プロンプトの控えだけで入らない時は、控えを短くするように言う
    const prompt = buildCritiqueResult(
      n.data,
      { title_id: n.titleId, prompt_text: long('依頼', 210_000), result_markdown: '短い' },
      claude,
    )
    expect(prompt.items[0].hint).toContain('prompt_text に依頼の要約')
    // 改稿案・戦略メモ・批評プロンプトも
    const idea = buildRevisionIdeas(n.data, { title_id: n.titleId, items: [{ heading: '案', body: markdown }] }, claude)
    expect(idea.items[0]).toMatchObject({ status: 'invalid' })
    expect(idea.items[0].hint).toContain('別々の改稿案にして送ってください')
    const note = buildStrategyNote(n.data, { title_id: n.titleId, heading: '戦略', body: markdown }, claude)
    expect(note.items[0].hint).toContain('novel_add_strategy_note を分けて呼んでください')
    const p = buildCritiquePrompt(n.data, { scope: 'shared', name: '依頼', body: markdown }, claude)
    expect(p.records).toEqual([])
    expect(p.items[0].hint).toContain('批評プロンプトに分けて保存してください')
  })

  it('短い項目の上限はそのまま（コネクタでも貼り付けでも）', () => {
    const n = sample()
    for (const ctx of [claude, paste]) {
      const proof = buildProofreading(
        n.data,
        {
          title_id: n.titleId,
          items: [
            { piece: '#1', excerpt: 'あ'.repeat(RECORD_LIMITS.excerpt + 1), category: 'typo', reason: 'x' },
            { piece: '#1', excerpt: '見れる', context_before: 'あ'.repeat(31), category: 'typo', reason: 'x' },
            { piece: '#1', excerpt: '見れる', category: 'other', category_label: 'あ'.repeat(21), reason: 'x' },
            { piece: '#1', excerpt: '見れる', category: 'typo', suggestion: 'あ'.repeat(501), reason: 'x' },
            { piece: '#1', excerpt: '見れる', category: 'typo', reason: 'あ'.repeat(301) },
          ],
        },
        ctx,
      )
      expect(proof.items.map((x) => x.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid'])
      expect(proof.items.map((x) => /(\w+) が長すぎます/.exec(x.hint!)?.[1])).toEqual([
        'excerpt',
        'context_before',
        'category_label',
        'suggestion',
        'reason',
      ])
      expect(buildProofreading(n.data, { title_id: n.titleId, run_label: 'あ'.repeat(61), items: [] }, ctx).ok).toBe(false)
      const note = buildStrategyNote(n.data, { title_id: n.titleId, heading: 'あ'.repeat(81), body: 'x' }, ctx)
      expect(note.items[0].hint).toContain('heading が長すぎます（80字まで')
      const contest = buildStrategyNote(
        n.data,
        {
          title_id: n.titleId,
          heading: '戦略',
          body: 'x',
          contests: [{ name: 'あ'.repeat(81) }, { name: '賞', organizer: 'あ'.repeat(81) }],
        },
        ctx,
      )
      expect((contest.records[0].record as AppData['strategyNotes'][string]).contests).toEqual([])
      expect(contest.notes.join()).toContain('name が長すぎます')
      expect(contest.notes.join()).toContain('organizer が長すぎます')
      const prompt = buildCritiquePrompt(n.data, { scope: 'shared', name: 'あ'.repeat(61), body: 'x' }, ctx)
      expect(prompt.items[0].hint).toContain('name が長すぎます（60字まで')
      const url = buildCritiqueResult(
        n.data,
        { title_id: n.titleId, artifact_url: `https://claude.ai/${'a'.repeat(RECORD_LIMITS.url)}` },
        ctx,
      )
      expect(url.items[0].status).toBe('invalid')
    }
  })
})

describe('小さな道具', () => {
  it('文字数はコードポイントで数える・https の URL だけ・記録の大きさ', () => {
    expect(charLength('𠮷野家')).toBe(3)
    expect(isHttpsUrl('https://claude.ai/x')).toBe(true)
    expect(isHttpsUrl('http://claude.ai/x')).toBe(false)
    expect(isHttpsUrl('nope')).toBe(false)
    expect(recordFits({ id: 'x', body: 'a'.repeat(190_000) } as never)).toBe(true)
    expect(recordFits({ id: 'x', body: '\n'.repeat(110_000) } as never)).toBe(false)
  })
})
