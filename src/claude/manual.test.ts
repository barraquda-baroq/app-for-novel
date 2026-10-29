// 手動連携: 依頼文とパート分け（prompts.ts）・貼り付け（paste.ts）
import { describe, expect, it } from 'vitest'
import { addClaudeRecords, addCritiquePrompt } from '../domain/claudeOps'
import { addSubmission, updateSubmission } from '../domain/entityOps'
import { novel } from '../test/claudeFixture'
import { extractBlock, parseCalls, PASTE_FENCE, previewPaste } from './paste'
import { buildManualParts, critiqueConnectorPrompt, critiqueManualPrompt, MANUAL_PART_CHARS, strategyPrompt } from './prompts'
import { WRITE_TOOLS } from './records'

const NOW = Date.UTC(2026, 9, 28, 3, 0)

function bigNovel(episodes = 40) {
  return novel(Array.from({ length: episodes }, (_, i) => `${'窓から見れる景色。'.repeat(300)}${i}\n${'猫が来た。'.repeat(200)}`))
}

describe('依頼文とパート分け', () => {
  it('どのパートも 50,000 字以内。1つ目に依頼文、各パートに番号、最後に終わりの印', () => {
    const n = bigNovel()
    const r = buildManualParts(n.data, n.titleId, { task: 'proofreading', today: '2026-10-28' })
    if (!r.ok) throw new Error(r.error)
    const total = r.parts.length
    expect(total).toBeGreaterThan(2)
    r.parts.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(MANUAL_PART_CHARS)
      expect(p.startsWith(`【Novel Studio パート ${i + 1}/${total}】\n`)).toBe(true)
    })
    expect(r.parts[0]).toContain(`${total} 個のパートに分けて送ります`)
    expect(r.parts[0]).toContain('```novel-studio-v1')
    expect(r.parts[0]).toContain('=== #1 第1話')
    expect(r.parts.at(-1)!.endsWith(`【全 ${total} パートの終わり。依頼に取りかかってください】`)).toBe(true)
    // 本文はすべて入っている（見出し・印を除いてつなぐと元の本文）
    const text = r.parts.join('\n')
    expect(text.split('猫が来た。').length - 1).toBe(40 * 200)
  })
  it('依頼文の JSON の例は、貼り付けでそのまま読める形', () => {
    const n = novel(['窓から見れる景色。', '猫が来た。'])
    for (const task of ['proofreading', 'critique', 'strategy'] as const) {
      const r = buildManualParts(n.data, n.titleId, { task, today: '2026-10-28' })
      if (!r.ok) throw new Error(r.error)
      expect(r.parts).toHaveLength(1)
      const block = extractBlock(r.parts[0])
      expect(block.ok).toBe(true)
      if (!block.ok) continue
      const calls = parseCalls(block.json)
      expect(calls.ok).toBe(true)
      if (calls.ok) for (const c of calls.calls) expect(WRITE_TOOLS).toContain(c.tool)
    }
  })
  it('JSON の例の改行は \\n が1つ（文字列の中の改行の書き方と同じ）', () => {
    const c = { title: { id: 'title-1', name: '星の庭' }, rangeLabel: 'タイトル全体', parts: 1, today: '2026-10-28' }
    const crit = critiqueManualPrompt({ ...c, prompt: null })
    const strat = strategyPrompt(c)
    expect(crit).toContain('## 総評\\n…')
    expect(strat).toContain('## 狙い\\n…')
    for (const p of [crit, strat]) expect(p).not.toContain('\\\\n')
  })
  it('作品批評は批評プロンプトの本文を入れ、ルビを除いて送る。戦略は目次・全体戦略・応募計画も送る', () => {
    const n = novel(['｜東京《とうきょう》へ'])
    const p = addCritiquePrompt(n.data, n.titleId, { name: '構成', body: '三幕構成の観点で批評して' })
    const crit = buildManualParts(p.data, n.titleId, {
      task: 'critique',
      today: '2026-10-28',
      prompt: p.data.critiquePrompts[p.result],
    })
    if (!crit.ok) throw new Error(crit.error)
    expect(crit.parts[0]).toContain('三幕構成の観点で批評して')
    expect(crit.parts[0]).toContain('東京へ')
    expect(crit.parts[0]).toContain('"prompt_id":"q:')
    const strat = buildManualParts(p.data, n.titleId, { task: 'strategy', today: '2026-10-28', includeText: false })
    if (!strat.ok) throw new Error(strat.error)
    expect(strat.parts[0]).toContain('=== 目次 ===')
    expect(strat.parts[0]).toContain('=== 全体戦略 ===')
    expect(strat.parts[0]).not.toContain('｜東京')
    expect(critiqueConnectorPrompt(n.data.titles[n.titleId], p.data.critiquePrompts[p.result])).toContain(
      'novel_add_critique_result',
    )
  })
  it('戦略の応募計画には、規定の備考・提出する梗概／キャッチコピーの文字数と規定・特記事項も入る（書いていない項目は出さない）', () => {
    const n = novel(['本文'])
    const a = addSubmission(n.data, n.titleId, '海風小説大賞')
    let data = updateSubmission(a.data, a.result, {
      minChars: 1000,
      limitNote: 'ルビ不可',
      synopsis: 'あ'.repeat(330),
      synopsisMax: 300,
      catchphrase: 'その嘘は、世界を救うためについた。',
      specialNotes: '担当さんに確認',
    })
    const b = addSubmission(data, n.titleId, '空の賞')
    data = b.data
    const r = buildManualParts(data, n.titleId, { task: 'strategy', today: '2026-10-28', includeText: false })
    if (!r.ok) throw new Error(r.error)
    const text = r.parts[0]
    expect(text).toContain(
      [
        '- 海風小説大賞（検討中・規定 1,000〜字）',
        '  規定の備考: ルビ不可',
        '  梗概・あらすじ: 330字（規定 300字以内・30字超えています）',
        '  キャッチコピー: 17字 「その嘘は、世界を救うためについた。」',
        '  特記事項: 担当さんに確認',
        '- 空の賞（検討中）',
      ].join('\n'),
    )
  })
  it('範囲を指定できる', () => {
    const n = novel(['一話', '二話', '三話'])
    const r = buildManualParts(n.data, n.titleId, {
      task: 'proofreading',
      today: '2026-10-28',
      selection: { from: '#2', to: '#3' },
      rangeLabel: '第2話〜第3話',
    })
    if (!r.ok) throw new Error(r.error)
    expect(r.parts[0]).not.toContain('=== #1 第1話')
    expect(r.parts[0]).toContain('=== #3 第3話')
    expect(r.parts[0]).toContain('（第2話〜第3話）')
  })
})

describe('貼り付け', () => {
  const answer = (json: unknown) => `推敲案をまとめました。\n\n\`\`\`${PASTE_FENCE}\n${JSON.stringify(json)}\n\`\`\`\n以上です。`
  it('最後のコードブロックを読む・閉じていなくても読む・JSON だけでも読む', () => {
    const two = '```novel-studio-v1\n{"a":1}\n```\n説明\n```novel-studio-v1\n{"b":2}\n```'
    expect(extractBlock(two)).toEqual({ ok: true, json: '{"b":2}', fenced: true })
    expect(extractBlock('~~~novel-studio-v1\n{"c":3}')).toEqual({ ok: true, json: '{"c":3}', fenced: true })
    expect(extractBlock('  {"d":4}  ')).toEqual({ ok: true, json: '{"d":4}', fenced: false })
    expect(extractBlock('ただの文').ok).toBe(false)
    expect(parseCalls('{"tool":"novel_add_proofreading","title_id":"x","items":[]}')).toEqual({
      ok: true,
      calls: [{ tool: 'novel_add_proofreading', input: { title_id: 'x', items: [] } }],
    })
    expect(parseCalls('{"tool":"novel_delete_everything","input":{}}').ok).toBe(false)
    expect(parseCalls('{"tool":').ok).toBe(false)
  })
  it('1件ごとの結果を出し、［追加］の後にもう一度貼り付けても何も増えない', () => {
    const n = novel(['窓から見れる景色。', '猫が来た。猫が来た。'])
    const text = answer({
      tool: 'novel_add_proofreading',
      input: {
        title_id: 't:別のタイトル',
        covered: ['#1', '#2'],
        items: [
          { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' },
          { piece: '#2', excerpt: '来た', category: 'repetition', reason: '重複' },
          { piece: '#1', excerpt: '無い文', category: 'typo', reason: 'x' },
        ],
      },
    })
    const p = previewPaste(n.data, text, { titleId: n.titleId, now: NOW })
    if (!p.ok) throw new Error(p.error)
    expect(p.calls[0].result.items.map((x) => x.status)).toEqual(['created', 'ambiguous', 'not_found'])
    expect(p.calls[0].summary).toBe('追加 1件・見つからない 1件・場所が決まらない 1件')
    expect(p.created).toBe(1)
    expect(p.records[0].record).toMatchObject({ source: 'paste', titleId: n.titleId })
    const added = addClaudeRecords(n.data, p.records)
    expect(added.result).toHaveLength(2)
    const again = previewPaste(added.data, text, { titleId: n.titleId, now: NOW + 5000 })
    if (!again.ok) throw new Error(again.error)
    expect(again.created).toBe(0)
    expect(again.calls[0].result.items[0].status).toBe('duplicate')
    expect(addClaudeRecords(added.data, again.records).result).toEqual([])
  })
  it('作品批評はコードブロックが無くても、Markdown をそのまま結果にする。ほかの種類の答えは受け付けない', () => {
    const n = novel(['本文'])
    const p = previewPaste(n.data, '## 総評\nよく書けています', {
      titleId: n.titleId,
      now: NOW,
      expect: ['novel_add_critique_result'],
      plainCritique: { artifactUrl: 'https://claude.ai/public/artifacts/x' },
    })
    if (!p.ok) throw new Error(p.error)
    expect(p.plain).toBe(true)
    expect(p.records[0].record).toMatchObject({
      resultMarkdown: '## 総評\nよく書けています',
      artifactUrl: 'https://claude.ai/public/artifacts/x',
    })
    const wrong = previewPaste(n.data, answer({ tool: 'novel_add_revision_ideas', input: { items: [] } }), {
      titleId: n.titleId,
      now: NOW,
      expect: ['novel_add_critique_result'],
    })
    expect(wrong.ok).toBe(false)
    expect(previewPaste(n.data, 'ただの文', { titleId: n.titleId, now: NOW }).ok).toBe(false)
  })
  it('作品批評のコードブロックに URL が無ければ、画面で入れた URL を使う（答えの URL はそのまま）', () => {
    const n = novel(['本文'])
    const typed = 'https://claude.ai/public/artifacts/typed'
    const opts = { titleId: n.titleId, now: NOW, plainCritique: { artifactUrl: typed } }
    const p = previewPaste(n.data, answer({ tool: 'novel_add_critique_result', input: { result_markdown: '## 総評' } }), opts)
    if (!p.ok) throw new Error(p.error)
    expect(p.plain).toBe(false)
    expect(p.records[0].record).toMatchObject({ resultMarkdown: '## 総評', artifactUrl: typed })
    const own = 'https://claude.ai/public/artifacts/own'
    const q = previewPaste(
      n.data,
      answer({ tool: 'novel_add_critique_result', input: { result_markdown: '## 総評', artifact_url: own } }),
      opts,
    )
    if (!q.ok) throw new Error(q.error)
    expect(q.records[0].record).toMatchObject({ artifactUrl: own })
    // https でなければ、1件ごとの結果で断る
    const bad = previewPaste(n.data, answer({ tool: 'novel_add_critique_result', input: { result_markdown: '## 総評' } }), {
      ...opts,
      plainCritique: { artifactUrl: 'http://example.com/x' },
    })
    if (!bad.ok) throw new Error(bad.error)
    expect(bad.created).toBe(0)
  })
  it('戦略は戦略メモと改稿案をまとめて貼り付けられる', () => {
    const n = novel(['本文'])
    const p = previewPaste(
      n.data,
      answer([
        { tool: 'novel_add_strategy_note', input: { heading: '戦略', body: '## 狙い', contests: [{ name: '〇〇賞' }] } },
        { tool: 'novel_add_revision_ideas', input: { items: [{ heading: '冒頭', body: '短く', pieces: ['#1'] }] } },
      ]),
      { titleId: n.titleId, now: NOW },
    )
    if (!p.ok) throw new Error(p.error)
    expect(p.records.map((r) => r.table)).toEqual(['strategyNotes', 'revisionIdeas'])
    expect(p.created).toBe(2)
  })
})
