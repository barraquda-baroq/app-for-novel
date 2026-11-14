// 名作分析のプロンプト V30 が頼っている、既存のツールの答えの形（.handoff の決定「守ること」）。2.8 でアイデアのツールを足しても、
// ここの答えは 2.7 と1字も違わない（版の数だけは定数から作る）。2.9 は novel_add_bench_analysis の答えの「- 追加」の行の下に
// 字数の行（「    字数: n字（空白・改行を除く。アプリと同じ数え方）」）を足すだけ（V30 は「- 追加」の行だけを写し、ほかの行は読まない。
// 「- 追加」「補足:」の行と作品の文は 2.7 のまま）。
// - novel_status の1〜9行目（2.8 は最後に「アイデアへの追記の依頼」の行を足すだけ）
// - novel_list_bench_works の見出し・「タグ（作品の数）: 」の行・作品ごとの行・続きの cursor の行
// - novel_add_bench_analysis の「- 追加」「- 重複」「- 以前に削除」「- 形が違う」「補足:」の行と作品の文（2.9 から「- 追加」の下に字数の行）
// - novel_get_bench_analysis の先頭（「=== 」の行・書誌・「タグ: 」の行・「--- 観点「」「#### 観点名（」）
// - novel_move_cards_to_trash（n:・k:）の「カードをゴミ箱へ移す: 移す n件・移さない n件」「- 移す」「- 移さない」の行と結び
import { describe, expect, it } from 'vitest'
import { addBenchAnalysis, addBenchWork, setBenchWorkTags } from '../../../src/domain/benchOps'
import { addMaterial } from '../../../src/domain/materialOps'
import { benchAnalysisId } from '../../../src/claude/derivedId'
import { shortId } from '../../../src/claude/refs'
import type { AppData } from '../../../src/domain/types'
import { novel } from '../../../src/test/claudeFixture'
import { CONNECTOR_MODEL, CONNECTOR_VERSION } from '../../src/version'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, pairedCore } from '../support/harness'

/** 棚: タグと分析のある作品・何も無い作品・資料（作者が手で足したもの） */
function shelf(extraWorks = 0) {
  const n = novel(['冒頭の本文。'], { name: '星の庭' })
  let data: AppData = n.data
  const a = addBenchWork(data, { name: '銀河の果て', author: '山田', year: '2019', genre: 'SF', pdfPlace: 'プロジェクト「相対比較」' })
  data = setBenchWorkTags(a.data, a.result, ['SF', '喪失'])
  const b = addBenchWork(data, { name: '海の記憶', author: '佐藤' })
  data = b.data
  const r = addBenchAnalysis(data, a.result, { viewpoint: '構成', body: '## 構成\n三幕。', runDate: '2026-10-01' })
  data = r.data
  for (let i = 0; i < extraWorks; i++) data = addBenchWork(data, { name: `作品${String(i).padStart(2, '0')}`, author: `著者${i}` }).data
  const m = addMaterial(data, { name: '外科の歴史', author: '高橋' })
  return { data: m.data, workA: a.result, workB: b.result, manual: r.result }
}

const text = (r: { text: string }) => r.text

describe('V30 が頼る答えの形（2.7 と1字も違わない）', () => {
  it('novel_status: 1〜9行目', async () => {
    const fake = new FakeFirebase()
    const { core, clock } = await pairedCore(fake, shelf().data)
    await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い。', run_date: '2026-10-30' }],
    })
    clock.now += 1_000
    const lines = text(await core.callTool('novel_status', {})).split('\n')
    expect(lines.slice(0, 9)).toEqual([
      `Novel Studio コネクタ ${CONNECTOR_VERSION}（データの形 ${CONNECTOR_MODEL}）`,
      '連携: 済み（2026-10-29 12:00 日本時間）',
      '書き込み: 許可',
      `アプリのデータの形: ${CONNECTOR_MODEL}（一致）`,
      '取り込み: 完了（記録 10件・削除の印 0件・最後に新しくした時刻 12:00:00）',
      '読めなかった記録: 0件',
      '今日（太平洋時間 2026-10-28）の読み取り 18 / 15,000・書き込み 1 / 5,000（日本時間16時に戻ります）',
      'Claude に見せていないタイトル: 0件',
      'ゴミ箱へ移す依頼: アプリの同期待ち 0件・今日（日本時間）0 / 100件',
    ])
  })

  it('novel_status: 初回の取り込み中・書き込みの停止・データの形が違う時の行', async () => {
    const fake = new FakeFirebase()
    const { core } = await pairedCore(fake, shelf().data, { writes: false, model: CONNECTOR_MODEL - 1, warm: false })
    const lines = text(await core.callTool('novel_status', {})).split('\n')
    expect(lines[2]).toBe('書き込み: 停止中（アプリの 設定 → Claude 連携 →「書き込みを許可」）')
    expect(lines[3]).toBe(`アプリのデータの形: ${CONNECTOR_MODEL - 1}（コネクタは ${CONNECTOR_MODEL}。書き込みは止まります）`)
    expect(lines[4]).toMatch(/^取り込み: 初回の取り込み中（\d+件）。少し待ってから、もう一度試してください。$/)
  })

  it('novel_list_bench_works: 見出し・タグ（作品の数）・作品の行・タグ・分析・続きの cursor の行', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    expect(text(await core.callTool('novel_list_bench_works', {}))).toBe(
      [
        '=== 相対比較（2作品。作者が比べるために読む既存の作品）===',
        'タグ（作品の数）: SF 1・喪失 1',
        `${shortId('benchWork', s.workA)}『銀河の果て』（山田） 山田・2019・SF`,
        '  タグ: SF・喪失',
        '  分析 1件（9字）: 構成 1件（最新 2026-10-01）',
        '  PDF の置き場所: プロジェクト「相対比較」',
        `${shortId('benchWork', s.workB)}『海の記憶』（佐藤） 佐藤`,
        '  分析 0件',
        '分析の本文は novel_get_bench_analysis（work に w:…）で読んでください。',
      ].join('\n'),
    )
    // 長い棚は作品の切れ目で切り、最後の行に続きの cursor
    const long = await pairedCore(new FakeFirebase(), shelf(60).data)
    const page = text(await long.core.callTool('novel_list_bench_works', { char_budget: 2_000 })).split('\n')
    expect(page[0]).toBe('=== 相対比較（62作品。作者が比べるために読む既存の作品）===')
    expect(page[1]).toBe('タグ（作品の数）: SF 1・喪失 1')
    expect(page.at(-1)).toMatch(/^続き: cursor="[^"]+"（結果が長いため、ここで切りました。残り\d+作品は、この cursor で読めます）$/)
  })

  it('novel_add_bench_analysis: 追加・補足・作品の文、重複・形が違う、以前に削除、新しい作品', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const work = shortId('benchWork', s.workA)
    const style = benchAnalysisId({ workId: s.workA, viewpoint: '文体', runDate: '2026-10-30', body: '## 文体\n短い。' })
    const people = benchAnalysisId({ workId: s.workA, viewpoint: '人物', runDate: '2026-10-29', body: '主人公。' })
    const add = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [
        { viewpoint: '文体', body_markdown: '## 文体\n短い。', run_date: '2026-10-30' },
        { viewpoint: '人物', body_markdown: '主人公。', run_date: '2026-13-01' },
      ],
    })
    expect(text(add)).toBe(
      [
        '相対比較に分析を追加: 追加 2件',
        `- 追加 ${shortId('benchAnalysis', style)} 『銀河の果て』の「文体」`,
        '    字数: 7字（空白・改行を除く。アプリと同じ数え方）',
        `- 追加 ${shortId('benchAnalysis', people)} 『銀河の果て』の「人物」`,
        '    字数: 4字（空白・改行を除く。アプリと同じ数え方）',
        "補足: 日付 '2026-13-01' は YYYY-MM-DD でないため、今日の日付にしました",
        `補足: 相対比較の作品 ${work}『銀河の果て』（山田） に追加しました`,
        'アプリのホームの「相対比較」に、各端末が同期すると出ます。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    const dup = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [
        { viewpoint: '文体', body_markdown: '## 文体\n短い。', run_date: '2026-10-30' },
        { viewpoint: '', body_markdown: 'x' },
      ],
    })
    expect(text(dup)).toBe(
      [
        '相対比較に分析を追加: 重複 1件・形が違う 1件',
        '- 重複 『銀河の果て』の「文体」: 同じ内容の記録がもうあります（追加しません）',
        '- 形が違う 『銀河の果て』の分析: viewpoint が空です',
        `補足: 相対比較の作品 ${work}『銀河の果て』（山田） には何も追加していません`,
      ].join('\n'),
    )
    // 作者がアプリで削除し、ゴミ箱からも消した（削除の印だけ）
    fake.tombstone(OWNER, 'benchAnalyses', people)
    clock.now += 20_000
    const deleted = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '人物', body_markdown: '主人公。', run_date: '2026-10-29' }],
    })
    expect(text(deleted)).toBe(
      [
        '相対比較に分析を追加: 以前に削除 1件',
        '- 以前に削除 『銀河の果て』の「人物」: 以前に削除された記録です（追加しません）',
        `補足: 相対比較の作品 ${work}『銀河の果て』（山田） には何も追加していません`,
      ].join('\n'),
    )
    const created = await core.callTool('novel_add_bench_analysis', {
      work: '風の街',
      new_work: { name: '風の街', author: '中村' },
      items: [{ viewpoint: '構成', body_markdown: '二部構成。', run_date: '2026-10-30' }],
    })
    const lines = text(created).split('\n')
    expect(lines[0]).toBe('相対比較に分析を追加: 追加 1件')
    expect(lines[1]).toMatch(/^- 追加 n:[0-9a-z]{8} 『風の街』の「構成」$/)
    expect(lines[2]).toBe('    字数: 5字（空白・改行を除く。アプリと同じ数え方）')
    expect(lines[3]).toMatch(/^補足: 作品 w:[0-9a-z]{8}『風の街』（中村） を相対比較に追加しました$/)
    expect(lines[4]).toBe('アプリのホームの「相対比較」に、各端末が同期すると出ます。本文（稿）は書き換えていません。')
  })

  it('novel_get_bench_analysis: 先頭の「=== 」の行・書誌・タグ、観点ごとの「--- 観点「」と「#### 観点名（」', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い。', run_date: '2026-10-30' }],
    })
    const style = benchAnalysisId({ workId: s.workA, viewpoint: '文体', runDate: '2026-10-30', body: '## 文体\n短い。' })
    expect(text(await core.callTool('novel_get_bench_analysis', { work: '銀河の果て' }))).toBe(
      [
        `=== 相対比較の作品 ${shortId('benchWork', s.workA)}『銀河の果て』（山田） ===`,
        '山田・2019・SF',
        'タグ: SF・喪失',
        '--- 観点「文体」（1件）---',
        `#### 文体（2026-10-30・Claude）[${shortId('benchAnalysis', style)}]`,
        '## 文体',
        '短い。',
        '--- 観点「構成」（1件）---',
        `#### 構成（2026-10-01・手で記録）[${shortId('benchAnalysis', s.manual)}]`,
        '## 構成',
        '三幕。',
      ].join('\n'),
    )
  })

  it('novel_move_cards_to_trash（n:・k:）: 入力は cards、移す・移さない・依頼済みの行と結びの文', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const a = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い。', run_date: '2026-10-30' }],
    })
    const n = (a.structured as { created: { id: string }[] }).created[0].id
    const k = await core.callTool('novel_add_material_notes', {
      material: '外科の歴史',
      items: [{ section: '要約', body_markdown: '第1章 外科の始まり。', run_date: '2026-10-31' }],
    })
    const kid = (k.structured as { created: { id: string }[] }).created[0].id
    const manual = shortId('benchAnalysis', s.manual)
    const first = await core.callTool('novel_move_cards_to_trash', { cards: [n, kid, manual] })
    expect(text(first)).toBe(
      [
        'カードをゴミ箱へ移す: 移す 2件・移さない 1件',
        `- 移す ${n} 相対比較『銀河の果て』の「文体」（2026-10-30）`,
        `- 移す ${kid} 資料『外科の歴史』の「要約」（2026-10-31）`,
        `- 移さない ${manual} 『銀河の果て』の「構成」（2026-10-01）（Claude が作ったカードでない）: Claude がこのコネクタで作ったカードではありません（作者が書いた・貼り付けたカードは移せません。作者がアプリで削除してください）`,
        '移すカードは、もう Claude からは見えません。アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）。移した後30日は、作者がアプリのゴミ箱から元に戻せます。',
        '今日（日本時間）はあと 98件移せます。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    const again = await core.callTool('novel_move_cards_to_trash', { cards: [n, 'n:zzzzzzzz'] })
    expect(text(again)).toBe(
      [
        'カードをゴミ箱へ移す: 移す 1件・移さない 1件',
        `- 移す ${n} 相対比較『銀河の果て』の「文体」（2026-10-30）（依頼済み）`,
        '- 移さない n:zzzzzzzz（見つからない）: 見つかりません（novel_get_bench_analysis・novel_get_material で id を確かめてください）',
        '移すカードは、もう Claude からは見えません。アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）。移した後30日は、作者がアプリのゴミ箱から元に戻せます。',
        '今日（日本時間）はあと 98件移せます。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
  })
})
