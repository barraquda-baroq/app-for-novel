// ベンチ作品（2.5）のツール: 一覧・分析を読む・分析を足す、作品批評の比べるベンチ作品・比べた作品（bench_works）。
// ベンチ作品はタイトルの「Claude に見せる」と関係なく見せ、書き込みは「書き込みを許可」の時だけ。
import { describe, expect, it } from 'vitest'
import { addBenchAnalysis, addBenchWork, addTitleBenchWork, deleteBenchWork } from '../../../src/domain/benchOps'
import { addClaudeRecords, setTitleClaudeAccess } from '../../../src/domain/claudeOps'
import { buildCritiqueResult } from '../../../src/claude/records'
import { createTitle } from '../../../src/domain/entityOps'
import { shortId } from '../../../src/claude/refs'
import type { AppData } from '../../../src/domain/types'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { novel } from '../../../src/test/claudeFixture'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, call, pairedCore } from '../support/harness'

/** 棚に2作品（1つは分析つき）と、比べる作品にしたタイトル・見せないタイトル */
function shelf() {
  const n = novel(['冒頭の本文。'], { name: '星の庭' })
  let data: AppData = n.data
  const a = addBenchWork(data, { name: '銀河の果て', author: '山田', year: '2019', pdfPlace: 'プロジェクト「ベンチ」' })
  data = a.data
  const b = addBenchWork(data, { name: '海の記憶', author: '佐藤' })
  data = b.data
  const at = (viewpoint: string, body: string, runDate: string, createdAt: number) => {
    const r = addBenchAnalysis(data, a.result, { viewpoint, body, runDate })
    data = { ...r.data, benchAnalyses: { ...r.data.benchAnalyses, [r.result]: { ...r.data.benchAnalyses[r.result], createdAt } } }
    return r.result
  }
  const first = at('構成', '## 構成\n三幕で、第一幕の終わりに転機。', '2026-10-01', 1)
  at('文体', '## 文体\n短い文を重ねる。', '2026-10-02', 2)
  at('構成', '## 構成（読み直し）\n伏線の回収が早い。', '2026-10-20', 3)
  data = addTitleBenchWork(data, n.titleId, a.result)
  const hidden = createTitle(data, '内緒の話')
  data = setTitleClaudeAccess(addTitleBenchWork(hidden.data, hidden.result, b.result), hidden.result, 'none')
  return { data, titleId: n.titleId, hiddenId: hidden.result, workA: a.result, workB: b.result, firstAnalysis: first }
}

describe('読む（novel_list_bench_works・novel_get_bench_analysis）', () => {
  it('一覧: 作品・著者・観点ごとの数と最新の日付・比べるタイトル（見せないタイトルは出さない）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const text = await call(core, 'novel_list_bench_works')
    expect(text).toContain('=== ベンチ作品（2作品。作者が比べるために読む既存の作品）===')
    expect(text).toContain(`${shortId('benchWork', s.workA)}『銀河の果て』（山田） 山田・2019`)
    expect(text).toContain('分析 3件')
    expect(text).toContain('構成 2件（最新 2026-10-20）・文体 1件（最新 2026-10-02）')
    expect(text).toContain('PDF の置き場所: プロジェクト「ベンチ」')
    expect(text).toContain(`比べるタイトル: 『星の庭』[${shortId('title', s.titleId)}]`)
    expect(text).toContain(`${shortId('benchWork', s.workB)}『海の記憶』（佐藤）`)
    expect(text).not.toContain('内緒の話')
  })

  it('タイトルをすべて見せなくても、ベンチ作品は読める', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const data = setTitleClaudeAccess(s.data, s.titleId, 'none')
    const { core } = await pairedCore(fake, data)
    expect(await call(core, 'novel_list_titles')).toContain('（ありません')
    expect(await call(core, 'novel_list_bench_works')).toContain('『銀河の果て』')
  })

  it('分析: 作品名・短い id で指し、観点ごとに新しい日付から。観点で絞る・1つだけ読む・知らない作品は候補', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const all = await call(core, 'novel_get_bench_analysis', { work: '銀河の果て' })
    expect(all).toContain('--- 観点「構成」（2件）---')
    expect(all.indexOf('伏線の回収が早い')).toBeLessThan(all.indexOf('第一幕の終わりに転機'))
    expect(all.indexOf('--- 観点「構成」')).toBeLessThan(all.indexOf('--- 観点「文体」'))
    const only = await call(core, 'novel_get_bench_analysis', { work: shortId('benchWork', s.workA), viewpoints: ['文体'] })
    expect(only).toContain('短い文を重ねる')
    expect(only).not.toContain('三幕')
    const one = await call(core, 'novel_get_bench_analysis', {
      work: s.workA,
      analysis_id: shortId('benchAnalysis', s.firstAnalysis),
    })
    expect(one).toContain('第一幕の終わりに転機')
    expect(one).not.toContain('伏線')
    const none = await core.callTool('novel_get_bench_analysis', { work: '無い作品' })
    expect(none.isError).toBe(true)
    expect(none.text).toContain('『銀河の果て』')
    const noViewpoint = await core.callTool('novel_get_bench_analysis', { work: s.workA, viewpoints: ['人物'] })
    expect(noViewpoint.isError).toBe(true)
    expect(noViewpoint.text).toContain('観点「構成」')
    expect(await call(core, 'novel_get_bench_analysis', { work: '海の記憶' })).toContain('分析はまだありません')
  })

  it('長い分析は char_budget 字ずつ、cursor で続きを読む（観点の絞り込みも続く）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const long = Array.from({ length: 80 }, (_, i) => `段落${i + 1}。${'あ'.repeat(95)}`).join('\n')
    const data = addBenchAnalysis(s.data, s.workA, { viewpoint: '人物', body: long, runDate: '2026-10-25' }).data
    const { core } = await pairedCore(fake, data)
    const first = await call(core, 'novel_get_bench_analysis', { work: s.workA, viewpoints: ['人物'], char_budget: 2_000 })
    const cursor = /続き: cursor="([^"]+)"/.exec(first)![1]
    expect(first).toContain('段落1。')
    expect(first).not.toContain('段落80。')
    let text = first
    let next: string | undefined = cursor
    for (let i = 0; next && i < 20; i++) {
      const page = await call(core, 'novel_get_bench_analysis', { cursor: next, char_budget: 2_000 })
      expect(page).toContain('『銀河の果て』の分析の続き')
      expect(page).not.toContain('短い文を重ねる')
      text += page
      next = /続き: cursor="([^"]+)"/.exec(page)?.[1]
    }
    expect(next).toBeUndefined()
    expect(text).toContain('段落80。')
    expect((await core.callTool('novel_get_bench_analysis', { cursor: 'xyz' })).isError).toBe(true)
  })
})

describe('作品批評（novel_get_critique・novel_add_critique_result）', () => {
  it('タイトルの比べるベンチ作品を観点つきで出し、比べた作品を bench_works で記録する', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const text = await call(core, 'novel_get_critique', { title_id: s.titleId })
    expect(text).toContain('--- 比べるベンチ作品（1作品。作者が比べたい既存の作品）---')
    expect(text).toContain(`${shortId('benchWork', s.workA)}『銀河の果て』（山田） 分析 3件: 構成・文体`)
    expect(text).toContain('novel_get_bench_analysis')
    const r = await core.callTool('novel_add_critique_result', {
      title_id: s.titleId,
      result_markdown: '## 『銀河の果て』と比べて\n…',
      bench_works: [shortId('benchWork', s.workA), '無い作品'],
    })
    expect(r.text).toContain('追加 1件')
    expect(r.text).toContain("bench_works の '無い作品' は見つからないため外しました")
    const docs = fake.recordDocs(OWNER).filter((d) => d.name.includes('/critiqueResults:'))
    const f = docs[0].fields
    const rec = decodeRecord(
      {
        table: 'critiqueResults',
        id: f.id.stringValue,
        json: f.json.stringValue,
        chunks: 0,
        deleted: false,
        hash: f.hash.stringValue,
        updated: null,
        device: 'claude-connector',
      } as unknown as RecordDoc,
      () => undefined,
    )
    expect(rec).toMatchObject({ benchWorkIds: [s.workA] })

    // 読み返すと、結果ごとに比べた作品が出る（一覧と result_id の全文）
    const compared = `比べた作品: ${shortId('benchWork', s.workA)}『銀河の果て』（山田）`
    const list = await call(core, 'novel_get_critique', { title_id: s.titleId })
    expect(list).toContain(`・${compared}`)
    const full = await call(core, 'novel_get_critique', { title_id: s.titleId, result_id: shortId('critiqueResult', String(f.id.stringValue)) })
    expect(full).toContain(`\n${compared}\n`)
    expect(full).not.toContain('棚から削除されています')
  })

  it('比べた作品が棚から削除されていれば、その数を添える。比べた作品の無い結果には出さない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const built = buildCritiqueResult(
      s.data,
      { title_id: s.titleId, result_markdown: '## 二作と比べて', bench_works: [s.workA, s.workB] },
      { source: 'claude', now: Date.UTC(2026, 9, 30, 3) },
    )
    const plain = buildCritiqueResult(
      s.data,
      { title_id: s.titleId, result_markdown: '## 比べずに', run_date: '2026-10-01' },
      { source: 'claude', now: Date.UTC(2026, 9, 1, 3) },
    )
    let data = addClaudeRecords(s.data, [...built.records, ...plain.records]).data
    data = deleteBenchWork(data, s.workB)
    const { core } = await pairedCore(fake, data)
    const list = await call(core, 'novel_get_critique', { title_id: s.titleId })
    expect(list).toContain(`比べた作品: ${shortId('benchWork', s.workA)}『銀河の果て』（山田）（ほか1作品は棚から削除されています）`)
    expect(list.match(/比べた作品:/g)).toHaveLength(1)
    const id = built.records[0].record.id
    const full = await call(core, 'novel_get_critique', { title_id: s.titleId, result_id: shortId('critiqueResult', id) })
    expect(full).toContain('（ほか1作品は棚から削除されています）')
    const other = await call(core, 'novel_get_critique', {
      title_id: s.titleId,
      result_id: shortId('critiqueResult', plain.records[0].record.id),
    })
    expect(other).not.toContain('比べた作品')
  })
})

describe('書き込み（novel_add_bench_analysis）', () => {
  /** コネクタが作った文書（棚に置いておいた作品は端末が書いたもの） */
  const docsOf = (fake: FakeFirebase, table: string) =>
    fake
      .recordDocs(OWNER)
      .filter((d) => d.name.includes(`/${table}:`) && d.fields.device?.stringValue === 'claude-connector')

  it('棚に無い作品は new_work を付けた時だけ作り、分析を観点ごとに作る（同じ内容は重複）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const items = [
      { viewpoint: '構成', body_markdown: '## 構成\n四部構成。', run_date: '2026-10-30' },
      { viewpoint: '冒頭の掴み', body_markdown: '## 冒頭\n一文目で謎を置く。', run_date: '2026-10-30' },
    ]
    const missing = await core.callTool('novel_add_bench_analysis', { work: '星を継ぐ', items })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('new_work')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)

    const input = { work: '星を継ぐ', new_work: { name: '星を継ぐ', author: '高橋', pdf_place: 'プロジェクト「SF」' }, items }
    const r = await core.callTool('novel_add_bench_analysis', input)
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('ベンチ作品の分析を追加: 追加 2件')
    expect(r.text).toContain('を棚に足しました')
    expect(r.text).toContain('アプリのホームの「ベンチ作品」に、各端末が同期すると出ます')
    expect(r.structured).toMatchObject({ created: [{ id: expect.stringMatching(/^n:/) }, { id: expect.stringMatching(/^n:/) }] })
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(2)
    expect(docsOf(fake, 'benchWorks')[0].fields.device).toEqual({ stringValue: 'claude-connector' })
    // 一覧にもすぐ出る（自分の書き込みを写しに入れる）
    expect(await call(core, 'novel_list_bench_works')).toContain('『星を継ぐ』（高橋）')
    clock.now += 20_000
    const again = await core.callTool('novel_add_bench_analysis', input)
    expect(again.text).toContain('重複 2件')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(2)
    // 作品名で指せば、作品はもう作らない
    const more = await core.callTool('novel_add_bench_analysis', {
      work: '星を継ぐ',
      items: [{ viewpoint: '人物', body_markdown: '主人公の弧' }],
    })
    expect(more.text).toContain('追加 1件')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
  })

  it('作品名の全角と半角・全角の空白の違いでは、別の作品を作らない（棚の作品に足す）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const up = addBenchWork(s.data, { name: '銀河の果て　上', author: '山田' })
    const sf = addBenchWork(up.data, { name: 'ＳＦ傑作選', author: '' })
    const { core } = await pairedCore(fake, sf.data)
    for (const name of ['銀河の果て 上', 'SF傑作選']) {
      const r = await core.callTool('novel_add_bench_analysis', {
        work: name,
        new_work: { name, author: name === 'SF傑作選' ? '' : '山田' },
        items: [{ viewpoint: '構成', body_markdown: `## 構成\n${name}`, run_date: '2026-10-30' }],
      })
      expect(r.text).toContain('追加 1件')
      expect(r.text).not.toContain('を棚に足しました')
    }
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)
    const list = await call(core, 'novel_list_bench_works')
    expect(list.match(/『銀河の果て/g)).toHaveLength(2)
    expect(list).toContain(`${shortId('benchWork', up.result)}『銀河の果て　上』（山田）`)
    expect(list).not.toContain('『SF傑作選』')
  })

  it('作品名が同じでも new_work の著者が違えば別の作品として作り、同じ作品名・著者ならその作品に足す', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    // 棚の『海の記憶』は佐藤。田中の同名の作品は別の作品
    const input = {
      work: '海の記憶',
      new_work: { name: '海の記憶', author: '田中' },
      items: [{ viewpoint: '構成', body_markdown: '## 構成\n田中の『海の記憶』', run_date: '2026-10-30' }],
    }
    const r = await core.callTool('novel_add_bench_analysis', input)
    expect(r.text).toContain('追加 1件')
    expect(r.text).toContain('『海の記憶』（田中） を棚に足しました')
    expect(r.text).toContain(`著者の違う同名の作品 ${shortId('benchWork', s.workB)}『海の記憶』（佐藤） があるため、別の作品として足しました`)
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    clock.now += 20_000
    const again = await core.callTool('novel_add_bench_analysis', {
      ...input,
      items: [{ viewpoint: '文体', body_markdown: '## 文体\n短文', run_date: '2026-10-30' }],
    })
    expect(again.text).toContain('追加 1件')
    expect(again.text).not.toContain('を棚に足しました')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    // 佐藤の作品には何も足していない
    const sato = await call(core, 'novel_get_bench_analysis', { work: shortId('benchWork', s.workB) })
    expect(sato).not.toContain('田中')
    const list = await call(core, 'novel_list_bench_works')
    expect(list).toContain('『海の記憶』（田中）')
    expect(list).toContain('『海の記憶』（佐藤）')
  })

  it('手で足して削除した作品（ゴミ箱に同じ作品名）は new_work で作り直さない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    // 「海の記憶」（佐藤）は棚で手で足した作品（id は内容から作った id ではない）。削除してゴミ箱へ
    const { core } = await pairedCore(fake, deleteBenchWork(s.data, s.workB))
    const r = await core.callTool('novel_add_bench_analysis', {
      work: '海の記憶',
      new_work: { name: '海の記憶', author: '佐藤' },
      items: [{ viewpoint: '構成', body_markdown: '## 構成\n二部構成。', run_date: '2026-10-30' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('以前に削除されています')
    expect(r.text).toContain('ゴミ箱から戻してください')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)
    // 棚にある作品はそのまま書ける
    const ok = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '人物', body_markdown: '主人公の弧' }],
    })
    expect(ok.text).toContain('追加 1件')
  })

  it('大きすぎる分析は作らず、番号を付けて分けるよう返す。「書き込みを許可」が外れていれば書かない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const big = await core.callTool('novel_add_bench_analysis', {
      work: s.workA,
      items: [{ viewpoint: '文体', body_markdown: 'あ'.repeat(250_000) }],
    })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('body_markdown を2つ以上に分け')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)

    const fake2 = new FakeFirebase()
    const off = await pairedCore(fake2, s.data, { writes: false })
    const r = await off.core.callTool('novel_add_bench_analysis', {
      work: s.workA,
      items: [{ viewpoint: '人物', body_markdown: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込みは停止中')
    expect(await call(off.core, 'novel_list_bench_works')).toContain('『銀河の果て』')
  })
})
