import { describe, expect, it } from 'vitest'
import { addBenchAnalysis, addBenchWork, addTitleBenchWork, deleteBenchAnalysis, deleteBenchWork } from '../domain/benchOps'
import { addClaudeRecords } from '../domain/claudeOps'
import { setTitleClaudeAccess } from '../domain/claudeOps'
import { listTrash, restoreTrashEntry } from '../domain/trash'
import type { AppData, BenchAnalysis } from '../domain/types'
import { decodeRecord, encodeRecord } from '../sync/codec'
import { novel } from '../test/claudeFixture'
import { comparisonMaterial, resolveBenchWork, workAnalysesText } from './bench'
import { benchAnalysesOf, benchViewpointGroups } from './benchOrder'
import { previewPaste } from './paste'
import { benchAnalysisPrompt, buildManualParts, critiqueConnectorPrompt, DEFAULT_BENCH_VIEWPOINTS } from './prompts'
import {
  buildBenchAnalysis,
  buildCritiqueResult,
  RECORD_LIMITS,
  trashedBenchNamesOf,
  trashedIdsOf,
  type BuildContext,
} from './records'
import { benchWorkId } from './derivedId'
import { refKey, shortId } from './refs'
import { claudeView } from './visibility'

const NOW = Date.UTC(2026, 9, 30, 3, 0)
const claude: BuildContext = { source: 'claude', now: NOW }
const paste: BuildContext = { source: 'paste', now: NOW }

function sample() {
  const n = novel(['冒頭の本文。', '二話の本文。'], { name: '星の庭' })
  const w = addBenchWork(n.data, { name: '銀河の果て', author: '山田', pdfPlace: 'プロジェクト「相対比較」' })
  return { ...n, data: w.data, workId: w.result }
}

const add = (data: AppData, records: Parameters<typeof addClaudeRecords>[1]) => addClaudeRecords(data, records).data

describe('相対比較の分析（novel_add_bench_analysis）', () => {
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

  it('相対比較に無い作品は new_work を付けた時だけ作る（分析を1つでも作る時だけ。作品が先）。同じ作品名・著者なら同じ作品', () => {
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
    expect(r.notes.join()).toContain(
      `作品 ${shortId('benchWork', r.records[0].record.id)}『星を継ぐ』（佐藤） を相対比較に追加しました`,
    )
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

  it('手で足して削除した作品（ゴミ箱に同じ作品名）は new_work で作り直さない。ゴミ箱から戻せばその作品に足す', () => {
    const n = sample()
    const hand = addBenchWork(n.data, { name: '銀河', author: '山田' })
    const withAnalysis = addBenchAnalysis(hand.data, hand.result, { viewpoint: '構成', body: '三幕', runDate: '2026-10-01' }).data
    const deleted = deleteBenchWork(withAnalysis, hand.result)
    const input = {
      work: '銀河',
      new_work: { name: '銀河', author: '山田' },
      items: [{ viewpoint: '文体', body_markdown: '短文', run_date: '2026-10-30' }],
    }
    const ctxOf = (data: AppData, base: BuildContext): BuildContext => ({
      ...base,
      wasDeleted: trashedIdsOf(data),
      trashedBenchWorkNamed: trashedBenchNamesOf(data),
    })
    for (const base of [claude, paste]) {
      const r = buildBenchAnalysis(deleted, input, ctxOf(deleted, base))
      expect(r.ok).toBe(false)
      expect(r.error).toContain('以前に削除されています')
      expect(r.error).toContain('ゴミ箱から戻してください')
      expect(r.records).toHaveLength(0)
    }
    // 前後の空白・正規化の違いがあっても同じ作品名
    expect(trashedBenchNamesOf(deleted)(' 銀河 ')).toBe(true)
    expect(trashedBenchNamesOf(deleted)('銀河の果て')).toBe(false)
    // 貼り付け（タイトルの画面）でも同じ
    const text = `\`\`\`novel-studio-v1\n${JSON.stringify({ tool: 'novel_add_bench_analysis', input })}\n\`\`\``
    const p = previewPaste(deleted, text, { titleId: n.titleId, now: NOW })
    expect(p.ok && p.created).toBe(0)
    expect(p.ok && p.calls[0].result.error).toContain('以前に削除されています')
    // ゴミ箱から戻せば、その作品（手で足した id）に足す
    const entry = listTrash(deleted.trashEntries).find((e) => e.kind === 'benchWork')!
    const restored = restoreTrashEntry(deleted, entry.id).data
    const back = buildBenchAnalysis(restored, input, ctxOf(restored, claude))
    expect(back.records.map((x) => x.table)).toEqual(['benchAnalyses'])
    expect((back.records[0].record as BenchAnalysis).workId).toBe(hand.result)
    expect(Object.values(restored.benchWorks).filter((w) => w.name === '銀河')).toHaveLength(1)
  })

  it('作品名は全角と半角・全角の空白・続く空白の違いを問わない（タイトル名で指す時と同じ）。同じ作品を2つ作らない', () => {
    const n = sample()
    const up = addBenchWork(n.data, { name: '銀河の果て　上', author: '山田' })
    const sf = addBenchWork(up.data, { name: 'ＳＦ傑作選', author: '' })
    const data = sf.data
    for (const [ref, id] of [
      ['銀河の果て 上', up.result],
      ['銀河の果て  上', up.result],
      ['SF傑作選', sf.result],
      [' ＳＦ傑作選 ', sf.result],
    ] as const) {
      const r = resolveBenchWork(data, ref)
      expect(r.ok && r.value.id).toBe(id)
    }
    // new_work を付けても、棚の作品に足す（作品は作らない）。作品名はそのまま
    const r = buildBenchAnalysis(
      data,
      {
        work: '銀河の果て 上',
        new_work: { name: '銀河の果て 上', author: '山田' },
        items: [{ viewpoint: '構成', body_markdown: '三幕', run_date: '2026-10-30' }],
      },
      claude,
    )
    expect(r.records.map((x) => x.table)).toEqual(['benchAnalyses'])
    expect((r.records[0].record as BenchAnalysis).workId).toBe(up.result)
    expect(data.benchWorks[up.result].name).toBe('銀河の果て　上')
    const s2 = buildBenchAnalysis(
      data,
      { work: 'SF傑作選', new_work: { name: 'SF傑作選', author: '' }, items: [{ viewpoint: '文体', body_markdown: '短文' }] },
      paste,
    )
    expect(s2.records.map((x) => x.table)).toEqual(['benchAnalyses'])
    expect((s2.records[0].record as BenchAnalysis).workId).toBe(sf.result)
    // Claude が作る作品の id も同じ比べ方（全角と半角・続く空白の違いは同じ id）
    expect(benchWorkId('ＳＦ傑作選', '')).toBe(benchWorkId('SF傑作選', ''))
    expect(benchWorkId('銀河の果て　上', '山田')).toBe(benchWorkId('銀河の果て  上 ', ' 山田'))
    expect(benchWorkId('銀河の果て', '山田')).not.toBe(benchWorkId('銀河の果て', '佐藤'))
    expect(refKey('ＳＦ　傑作選 ')).toBe('SF 傑作選')
    // ゴミ箱の作品名も同じ比べ方
    const gone = deleteBenchWork(data, sf.result)
    expect(trashedBenchNamesOf(gone)('SF傑作選')).toBe(true)
    const again = buildBenchAnalysis(
      gone,
      { work: 'SF傑作選', new_work: { name: 'SF傑作選', author: '' }, items: [{ viewpoint: '文体', body_markdown: '短文' }] },
      { ...claude, wasDeleted: trashedIdsOf(gone), trashedBenchWorkNamed: trashedBenchNamesOf(gone) },
    )
    expect(again.ok).toBe(false)
    expect(again.error).toContain('以前に削除されています')
  })

  it('new_work の著者が作品名で見つけた作品の著者と違えば、同じ作品名の別の作品として作る（短い id で指した時はその作品に足す）', () => {
    const n = sample()
    const sato = addBenchWork(n.data, { name: '海', author: '佐藤' })
    const items = [{ viewpoint: '構成', body_markdown: '田中の『海』の構成', run_date: '2026-10-30' }]
    const tanaka = { work: '海', new_work: { name: '海', author: '田中' }, items }
    const r = buildBenchAnalysis(sato.data, tanaka, claude)
    expect(r.ok).toBe(true)
    expect(r.records.map((x) => x.table)).toEqual(['benchWorks', 'benchAnalyses'])
    expect(r.records[0].record).toMatchObject({ name: '海', author: '田中' })
    const analysis = r.records[1].record as BenchAnalysis
    expect(analysis.workId).toBe(r.records[0].record.id)
    expect(analysis.workId).not.toBe(sato.result)
    expect(r.notes.join('\n')).toContain(
      `著者の違う同名の作品 ${shortId('benchWork', sato.result)}『海』（佐藤） があるため、別の作品として足しました`,
    )

    // 作った後: 同じ作品名・著者で呼べばその作品に足す。著者を付けずに作品名だけなら、短い id で指してもらう
    const both = add(sato.data, r.records)
    const more = buildBenchAnalysis(both, { ...tanaka, items: [{ viewpoint: '文体', body_markdown: '短文' }] }, claude)
    expect(more.records.map((x) => x.table)).toEqual(['benchAnalyses'])
    expect((more.records[0].record as BenchAnalysis).workId).toBe(analysis.workId)
    const bare = buildBenchAnalysis(both, { work: '海', items }, claude)
    expect(bare.ok).toBe(false)
    expect(bare.error).toContain('相対比較に作品名「海」の作品が2件あります')
    expect(bare.candidates).toHaveLength(2)

    // 著者が同じ・new_work の著者が空・棚の作品の著者が空なら、棚の作品に足す
    for (const author of ['佐藤', ' 佐藤 ', '']) {
      const same = buildBenchAnalysis(sato.data, { work: '海', new_work: { name: '海', author }, items }, claude)
      expect(same.records.map((x) => x.table)).toEqual(['benchAnalyses'])
      expect((same.records[0].record as BenchAnalysis).workId).toBe(sato.result)
      expect(same.notes.join()).not.toContain('別の作品')
    }
    const noAuthor = addBenchWork(n.data, { name: '海', author: '' })
    const filled = buildBenchAnalysis(noAuthor.data, tanaka, claude)
    expect(filled.records.map((x) => x.table)).toEqual(['benchAnalyses'])
    expect((filled.records[0].record as BenchAnalysis).workId).toBe(noAuthor.result)

    // 短い id・id で指した時は、著者が違ってもその作品に足し、違うことを知らせる
    for (const work of [shortId('benchWork', sato.result), sato.result]) {
      const byId = buildBenchAnalysis(sato.data, { ...tanaka, work }, claude)
      expect(byId.records.map((x) => x.table)).toEqual(['benchAnalyses'])
      expect((byId.records[0].record as BenchAnalysis).workId).toBe(sato.result)
      expect(byId.notes.join()).toContain(
        `new_work の著者（田中）は、指した作品 ${shortId('benchWork', sato.result)}『海』（佐藤） と違います（指した作品に足しました）`,
      )
    }
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

describe('貼り付け（相対比較の作品の画面）', () => {
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
      error: '相対比較の作品が見つかりません',
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

  it('分析の文・相対比較する作品の材料・作品の指し方', () => {
    const n = analysed()
    const text = workAnalysesText(n.data, n.data.benchWorks[n.workId], ['構成'])
    expect(text).toContain(`=== 相対比較の作品 ${shortId('benchWork', n.workId)}『銀河の果て』（山田） ===`)
    expect(text).toContain('--- 観点「構成」（3件）---')
    expect(text).not.toContain('文体・新しい')
    expect(comparisonMaterial(n.data, [n.workId, 'gone'])).toContain('=== 相対比較する作品の分析（1作品）===')
    expect(comparisonMaterial(n.data, [])).toBe('')
    expect(resolveBenchWork(n.data, 'なし').ok).toBe(false)
  })

  it('依頼文: 分析の依頼（観点・コードブロック）、手動の作品批評に分析を追加、コネクタへの批評の依頼', () => {
    const n = analysed()
    const work = n.data.benchWorks[n.workId]
    const p = benchAnalysisPrompt(work, ['構成', '人物'], '2026-10-30')
    expect(p).toContain('このプロジェクトのナレッジにある作品『銀河の果て』（山田）の PDF')
    expect(p).toContain('- 構成\n- 人物')
    expect(p).toContain('```novel-studio-v1')
    expect(p).toContain(`"work":"${shortId('benchWork', n.workId)}"`)
    expect(p).toContain('プロジェクト「相対比較」')
    expect(p).toContain('Novel Studio の相対比較の作品の画面に貼り付けて')
    expect(benchAnalysisPrompt(work, [], '2026-10-30')).toContain(DEFAULT_BENCH_VIEWPOINTS.map((v) => `- ${v}`).join('\n'))

    const parts = buildManualParts(n.data, n.titleId, { task: 'critique', today: '2026-10-30', benchWorkIds: [n.workId] })
    expect(parts.ok).toBe(true)
    if (!parts.ok) return
    const all = parts.parts.join('\n')
    expect(all).toContain('## 相対比較する作品')
    expect(all).toContain('相対比較する作品（作者が比べたい既存の作品）の分析を、依頼のすぐ後に送ります')
    expect(all).toContain('=== 相対比較する作品の分析（1作品）===')
    expect(all).not.toContain('ベンチ作品')
    expect(all).toContain('文体・新しい')
    expect(all).toContain('"bench_works":["w:')
    expect(all.indexOf('文体・新しい')).toBeLessThan(all.indexOf('冒頭の本文。'))
    const without = buildManualParts(n.data, n.titleId, { task: 'critique', today: '2026-10-30' })
    expect(without.ok && without.parts.join('\n')).not.toContain('相対比較')

    const prompt = { id: 'p1', name: '構成', body: '構成を見て' }
    const withBench = critiqueConnectorPrompt(n.data.titles[n.titleId], prompt, [work])
    expect(withBench).toContain('novel_get_bench_analysis')
    expect(withBench).toContain(`## 相対比較する作品\n相対比較する作品: ${shortId('benchWork', n.workId)}『銀河の果て』（山田）`)
    expect(withBench).not.toContain('ベンチ作品')
    expect(critiqueConnectorPrompt(n.data.titles[n.titleId], prompt)).not.toContain('相対比較')
  })

  it('Claude に見せる内容: 相対比較の作品はタイトルの設定と関係なく見せる（見せないタイトルの相対比較する作品の印は出ない）', () => {
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
