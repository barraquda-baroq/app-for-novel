import { describe, expect, it } from 'vitest'
import { addBenchAnalysis, addBenchWork, addTitleBenchWork, deleteBenchAnalysis, deleteBenchWork } from '../domain/benchOps'
import { addClaudeRecords } from '../domain/claudeOps'
import { setTitleClaudeAccess } from '../domain/claudeOps'
import type { AppData, BenchAnalysis } from '../domain/types'
import { decodeRecord, encodeRecord } from '../sync/codec'
import { novel } from '../test/claudeFixture'
import { comparisonMaterial, resolveBenchWork, workAnalysesText } from './bench'
import { benchAnalysesOf, benchViewpointGroups } from './benchOrder'
import { previewPaste } from './paste'
import { benchAnalysisPrompt, buildManualParts, critiqueConnectorPrompt, DEFAULT_BENCH_VIEWPOINTS } from './prompts'
import { buildBenchAnalysis, buildCritiqueResult, RECORD_LIMITS, trashedIdsOf, type BuildContext } from './records'
import { shortId } from './refs'
import { claudeView } from './visibility'

const NOW = Date.UTC(2026, 9, 30, 3, 0)
const claude: BuildContext = { source: 'claude', now: NOW }
const paste: BuildContext = { source: 'paste', now: NOW }

function sample() {
  const n = novel(['冒頭の本文。', '二話の本文。'], { name: '星の庭' })
  const w = addBenchWork(n.data, { name: '銀河の果て', author: '山田', pdfPlace: 'プロジェクト「ベンチ」' })
  return { ...n, data: w.data, workId: w.result }
}

const add = (data: AppData, records: Parameters<typeof addClaudeRecords>[1]) => addClaudeRecords(data, records).data

describe('ベンチ作品の分析（novel_add_bench_analysis）', () => {
  it('作品を id・短い id・作品名で指し、観点ごとの分析を作る（同じ呼び出しの分析は送った順に1ずつずらした時刻）', () => {
    const n = sample()
    for (const work of [n.workId, shortId('benchWork', n.workId), ' 銀河の果て ']) {
      const r = buildBenchAnalysis(
        n.data,
        {
          work,
          items: [
            { viewpoint: '構成', body_markdown: '## 構成\n三幕', run_date: '2026-10-29' },
            { viewpoint: '文体', body_markdown: '## 文体\n短文' },
          ],
          model: 'claude-opus',
        },
        claude,
      )
      expect(r.ok).toBe(true)
      expect(r.items.map((i) => i.status)).toEqual(['created', 'created'])
      const recs = r.records.map((x) => x.record as BenchAnalysis)
      expect(recs.map((x) => [x.workId, x.viewpoint, x.runDate, x.source, x.model, x.createdAt])).toEqual([
        [n.workId, '構成', '2026-10-29', 'claude', 'claude-opus', NOW],
        [n.workId, '文体', '2026-10-30', 'claude', 'claude-opus', NOW + 1],
      ])
      expect(r.items[0].label).toBe('『銀河の果て』の「構成」')
    }
  })

  it('同じ内容をもう一度送っても作らない（duplicate）。削除した分析は previously_deleted', () => {
    const n = sample()
    const input = { work: n.workId, items: [{ viewpoint: '人物', body_markdown: '主人公の弧', run_date: '2026-10-30' }] }
    const first = buildBenchAnalysis(n.data, input, paste)
    const data = add(n.data, first.records)
    const again = buildBenchAnalysis(data, input, paste)
    expect(again.items[0].status).toBe('duplicate')
    expect(again.records).toHaveLength(0)
    const id = first.records[0].record.id
    const gone = deleteBenchAnalysis(data, id)
    const after = buildBenchAnalysis(gone, input, { ...paste, wasDeleted: trashedIdsOf(gone) })
    expect(after.items[0].status).toBe('previously_deleted')
  })

  it('棚に無い作品は new_work を付けた時だけ作る（分析を1つでも作る時だけ。作品が先）。同じ作品名・著者なら同じ作品', () => {
    const n = sample()
    const none = buildBenchAnalysis(n.data, { work: '星を継ぐ', items: [{ viewpoint: '構成', body_markdown: 'x' }] }, claude)
    expect(none.ok).toBe(false)
    expect(none.error).toContain('new_work')
    expect(none.candidates?.[0]).toContain('『銀河の果て』')
    const input = {
      work: '星を継ぐ',
      new_work: {
        name: '星を継ぐ',
        author: '佐藤',
        publisher: '海出版',
        year: '1980',
        genre: 'SF',
        pdf_place: 'プロジェクト「SF」',
      },
      items: [{ viewpoint: '冒頭の掴み', body_markdown: '最初の一文' }],
    }
    const r = buildBenchAnalysis(n.data, input, claude)
    expect(r.records.map((x) => x.table)).toEqual(['benchWorks', 'benchAnalyses'])
    expect(r.records[0].record).toMatchObject({
      name: '星を継ぐ',
      author: '佐藤',
      publisher: '海出版',
      year: '1980',
      genre: 'SF',
      pdfPlace: 'プロジェクト「SF」',
      order: 1,
      source: 'claude',
    })
    expect(r.notes.join()).toContain('を棚に足しました')
    const data = add(n.data, r.records)
    expect(Object.keys(data.benchWorks)).toHaveLength(2)
    expect((r.records[1].record as BenchAnalysis).workId).toBe(r.records[0].record.id)
    // もう一度: 作品は作らず、分析は重複
    const again = buildBenchAnalysis(data, input, claude)
    expect(again.records).toHaveLength(0)
    expect(again.items[0].status).toBe('duplicate')
    // 分析を作れない時は作品も作らない
    const bad = buildBenchAnalysis(n.data, { ...input, items: [{ viewpoint: '', body_markdown: 'x' }] }, claude)
    expect(bad.records).toHaveLength(0)
    // 削除した作品は作り直さない
    const workId = r.records[0].record.id
    const deleted = deleteBenchWork(data, workId)
    const back = buildBenchAnalysis(deleted, input, { ...claude, wasDeleted: trashedIdsOf(deleted) })
    expect(back.ok).toBe(false)
    expect(back.error).toContain('以前に削除されています')
  })

  it('同じ作品名が2つあれば短い id で指してもらう。入力の形・件数・観点の長さ・日付', () => {
    const n = sample()
    const twin = addBenchWork(n.data, { name: '銀河の果て', author: '別人' }).data
    const amb = buildBenchAnalysis(twin, { work: '銀河の果て', items: [{ viewpoint: '構成', body_markdown: 'x' }] }, claude)
    expect(amb.ok).toBe(false)
    expect(amb.error).toContain('2件あります')
    expect(amb.candidates).toHaveLength(2)
    expect(buildBenchAnalysis(n.data, { work: n.workId, items: [] }, claude).error).toContain('items がありません')
    const many = Array.from({ length: 21 }, (_, i) => ({ viewpoint: `観点${i}`, body_markdown: 'x' }))
    expect(buildBenchAnalysis(n.data, { work: n.workId, items: many }, claude).error).toContain('20 件まで')
    const r = buildBenchAnalysis(
      n.data,
      {
        work: n.workId,
        items: [
          { viewpoint: 'あ'.repeat(41), body_markdown: 'x' },
          { viewpoint: '構成', body_markdown: '' },
          { viewpoint: '構成', body_markdown: 'x', run_date: '10/30' },
        ],
      },
      claude,
    )
    expect(r.items.map((i) => i.status)).toEqual(['invalid', 'invalid', 'created'])
    expect(r.items[0].hint).toContain('40字まで')
    expect(r.notes.join()).toContain("日付 '10/30' は YYYY-MM-DD でないため")
    expect(RECORD_LIMITS.viewpoint).toBe(40)
  })

  it('コネクタ: 1件が 200,000字を超える時は作らず、番号を付けて分けるよう返す（貼り付けはそのまま）', () => {
    const n = sample()
    const body = 'あ'.repeat(250_000)
    const input = { work: n.workId, items: [{ viewpoint: '文体', body_markdown: body }] }
    const r = buildBenchAnalysis(n.data, input, claude)
    expect(r.items[0].status).toBe('invalid')
    expect(r.items[0].hint).toContain('body_markdown を2つ以上に分け')
    expect(r.items[0].hint).toContain('（1/2）')
    expect(buildBenchAnalysis(n.data, input, paste).items[0].status).toBe('created')
    // 作った記録は同期の形にしてもそのまま読める
    const ok = buildBenchAnalysis(n.data, { work: n.workId, items: [{ viewpoint: '文体', body_markdown: '短い' }] }, claude)
    const rec = ok.records[0].record
    const enc = encodeRecord(rec as never)
    expect(enc.parts).toHaveLength(0)
    const doc = { table: 'benchAnalyses' as const, id: rec.id, json: enc.json, hash: enc.hash, chunks: 0, deleted: false }
    expect(decodeRecord({ ...doc, updated: null, device: 'claude-connector' }, () => undefined)).toEqual(rec)
  })
})

describe('作品批評の比べた作品（bench_works）', () => {
  it('作品の id にして記録する（見つからない作品は外して知らせる）', () => {
    const n = sample()
    const r = buildCritiqueResult(
      n.data,
      {
        title_id: n.titleId,
        result_markdown: '## 総評',
        bench_works: [shortId('benchWork', n.workId), '銀河の果て', '無い作品'],
      },
      claude,
    )
    expect(r.records[0].record).toMatchObject({ benchWorkIds: [n.workId] })
    expect(r.notes.join()).toContain("bench_works の '無い作品' は見つからないため外しました")
    const plain = buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: '## 総評' }, claude)
    expect('benchWorkIds' in plain.records[0].record).toBe(false)
    const bad = buildCritiqueResult(n.data, { title_id: n.titleId, result_markdown: 'x', bench_works: 'x' as never }, claude)
    expect(bad.items[0].status).toBe('invalid')
  })
})

describe('貼り付け（ベンチ作品の画面）', () => {
  const answer = (work = 'w:dummy') =>
    [
      '分析しました。',
      '```novel-studio-v1',
      JSON.stringify({
        tool: 'novel_add_bench_analysis',
        input: {
          work,
          new_work: { name: '別の作品', author: 'x' },
          items: [
            { viewpoint: '構成', body_markdown: '## 構成\n…', run_date: '2026-10-30' },
            { viewpoint: '人物', body_markdown: '## 人物\n…', run_date: '2026-10-30' },
          ],
        },
      }),
      '```',
    ].join('\n')

  it('その作品の分析として受け付け（work・new_work は使わない）、2回貼り付けても増えない', () => {
    const n = sample()
    const p = previewPaste(n.data, answer(), { benchWorkId: n.workId, now: NOW, expect: ['novel_add_bench_analysis'] })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.created).toBe(2)
    expect(p.records.every((r) => r.table === 'benchAnalyses' && (r.record as BenchAnalysis).workId === n.workId)).toBe(true)
    expect(p.records.every((r) => (r.record as BenchAnalysis).source === 'paste')).toBe(true)
    const data = add(n.data, p.records)
    expect(Object.keys(data.benchWorks)).toHaveLength(1)
    const again = previewPaste(data, answer(), { benchWorkId: n.workId, now: NOW + 60_000, expect: ['novel_add_bench_analysis'] })
    expect(again.ok && again.created).toBe(0)
    expect(again.ok && again.calls[0].summary).toBe('重複 2件')
  })

  it('ほかのツールは受け付けない。タイトルの画面のツールは、タイトル無しでは貼り付けられない', () => {
    const n = sample()
    const other = '```novel-studio-v1\n{"tool":"novel_add_revision_ideas","input":{"title_id":"x","items":[]}}\n```'
    const p = previewPaste(n.data, other, { benchWorkId: n.workId, now: NOW, expect: ['novel_add_bench_analysis'] })
    expect(p.ok).toBe(false)
    const q = previewPaste(n.data, other, { benchWorkId: n.workId, now: NOW })
    expect(q.ok && q.calls[0].result.error).toContain('タイトルの画面の「結果を貼り付け」で')
    expect(previewPaste(n.data, answer(), { benchWorkId: 'gone', now: NOW })).toEqual({
      ok: false,
      error: 'ベンチ作品が見つかりません',
    })
  })

  it('作品批評の画面: 結果の bench_works を受け付ける', () => {
    const n = sample()
    const text = `\`\`\`novel-studio-v1\n${JSON.stringify({
      tool: 'novel_add_critique_result',
      input: { title_id: 'x', result_markdown: '## 比べると', bench_works: ['銀河の果て'] },
    })}\n\`\`\``
    const p = previewPaste(n.data, text, { titleId: n.titleId, now: NOW, plainCritique: {} })
    expect(p.ok && p.records[0].record).toMatchObject({ benchWorkIds: [n.workId] })
  })
})

describe('並び・Claude に渡す形', () => {
  function analysed() {
    const n = sample()
    let data = n.data
    const at = (viewpoint: string, body: string, runDate: string, createdAt: number) => {
      const r = addBenchAnalysis(data, n.workId, { viewpoint, body, runDate })
      data = {
        ...r.data,
        benchAnalyses: { ...r.data.benchAnalyses, [r.result]: { ...r.data.benchAnalyses[r.result], createdAt } },
      }
      return r.result
    }
    at('文体', '文体・古い', '2026-10-01', 1)
    at('構成', '構成・古い', '2026-10-01', 2)
    at('文体', '文体・新しい', '2026-10-20', 3)
    at(' 構成', '（2/2）構成・後半', '2026-10-25', 5)
    at('構成', '（1/2）構成・前半', '2026-10-25', 4)
    at('冒頭の掴み', '冒頭', '2026-10-25', 6)
    return { ...n, data }
  }

  it('観点ごとにまとめ、まとまりは最初に分析した順、中は新しい日付から（分けたものは番号の順）', () => {
    const n = analysed()
    const groups = benchViewpointGroups(benchAnalysesOf(n.data, n.workId))
    expect(groups.map((g) => g.viewpoint)).toEqual(['文体', '構成', '冒頭の掴み'])
    expect(groups[0].items.map((a) => a.body)).toEqual(['文体・新しい', '文体・古い'])
    expect(groups[1].items.map((a) => a.body)).toEqual(['（1/2）構成・前半', '（2/2）構成・後半', '構成・古い'])
  })

  it('分析の文・比べる作品の材料・作品の指し方', () => {
    const n = analysed()
    const text = workAnalysesText(n.data, n.data.benchWorks[n.workId], ['構成'])
    expect(text).toContain(`=== ベンチ作品 ${shortId('benchWork', n.workId)}『銀河の果て』（山田） ===`)
    expect(text).toContain('--- 観点「構成」（3件）---')
    expect(text).not.toContain('文体・新しい')
    expect(comparisonMaterial(n.data, [n.workId, 'gone'])).toContain('=== 比べるベンチ作品の分析（1作品）===')
    expect(comparisonMaterial(n.data, [])).toBe('')
    expect(resolveBenchWork(n.data, 'なし').ok).toBe(false)
  })

  it('依頼文: 分析の依頼（観点・コードブロック）、手動の作品批評に分析を足す、コネクタへの批評の依頼', () => {
    const n = analysed()
    const work = n.data.benchWorks[n.workId]
    const p = benchAnalysisPrompt(work, ['構成', '人物'], '2026-10-30')
    expect(p).toContain('このプロジェクトのナレッジにある作品『銀河の果て』（山田）の PDF')
    expect(p).toContain('- 構成\n- 人物')
    expect(p).toContain('```novel-studio-v1')
    expect(p).toContain(`"work":"${shortId('benchWork', n.workId)}"`)
    expect(p).toContain('プロジェクト「ベンチ」')
    expect(benchAnalysisPrompt(work, [], '2026-10-30')).toContain(DEFAULT_BENCH_VIEWPOINTS.map((v) => `- ${v}`).join('\n'))

    const parts = buildManualParts(n.data, n.titleId, { task: 'critique', today: '2026-10-30', benchWorkIds: [n.workId] })
    expect(parts.ok).toBe(true)
    if (!parts.ok) return
    const all = parts.parts.join('\n')
    expect(all).toContain('## 比べる作品')
    expect(all).toContain('=== 比べるベンチ作品の分析（1作品）===')
    expect(all).toContain('文体・新しい')
    expect(all).toContain('"bench_works":["w:')
    expect(all.indexOf('文体・新しい')).toBeLessThan(all.indexOf('冒頭の本文。'))
    const without = buildManualParts(n.data, n.titleId, { task: 'critique', today: '2026-10-30' })
    expect(without.ok && without.parts.join('\n')).not.toContain('比べる作品')

    const prompt = { id: 'p1', name: '構成', body: '構成を見て' }
    expect(critiqueConnectorPrompt(n.data.titles[n.titleId], prompt, [work])).toContain('novel_get_bench_analysis')
    expect(critiqueConnectorPrompt(n.data.titles[n.titleId], prompt)).not.toContain('ベンチ')
  })

  it('Claude に見せる内容: ベンチ作品はタイトルの設定と関係なく見せる（見せないタイトルの比べる作品の印は出ない）', () => {
    const n = sample()
    let data = addTitleBenchWork(n.data, n.titleId, n.workId)
    data = addBenchAnalysis(data, n.workId, { viewpoint: '構成', body: 'x' }).data
    data = setTitleClaudeAccess(data, n.titleId, 'none')
    const view = claudeView(data)
    expect(Object.keys(view.titles)).toHaveLength(0)
    expect(Object.keys(view.benchWorks)).toEqual([n.workId])
    expect(Object.keys(view.benchAnalyses)).toHaveLength(1)
  })
})
