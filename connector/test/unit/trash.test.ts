// ゴミ箱へ移すツール（novel_move_cards_to_trash。2.7）: Claude がコネクタで作ったカードだけに「ゴミ箱へ移す依頼」を作る。
// 依頼の後は Claude から見えない（一覧の数・本文・id で指すと「依頼中」）。アプリが処理した後の形・作者が戻した後も確かめる。
// 2.8: Claude が作ったアイデア（i:…）も移せる（分析・記録の答えは 2.7 と1字も違わない）。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../../../src/domain/benchOps'
import { applyClaudeRequests } from '../../../src/domain/claudeRequests'
import { applyTrashRequests } from '../../../src/domain/claudeTrash'
import { createTitle, updateIdea } from '../../../src/domain/entityOps'
import { hashJson } from '../../../src/domain/hash'
import { addMaterial } from '../../../src/domain/materialOps'
import { restoreTrashEntry } from '../../../src/domain/trash'
import type { AppData, BenchAnalysis, Idea } from '../../../src/domain/types'
import { jstDate } from '../../../src/claude/dates'
import { shortId } from '../../../src/claude/refs'
import { claudeIdeaId, ideaAppendId, trashRequestId } from '../../../src/claude/derivedId'
import { claudeIdeaBody, ideaReadMark } from '../../../src/claude/ideaAppend'
import { novel } from '../../../src/test/claudeFixture'
import { cloudData, connectorDocs, pushChanges } from '../support/cloud'
import { FakeFirebase } from '../support/fakeFirebase'
import { call, pairedCore } from '../support/harness'

/** 棚に作者が手で足した作品1つ（分析つき）と資料1つ */
function shelf() {
  const n = novel(['冒頭の本文。'], { name: '星の庭' })
  const w = addBenchWork(n.data, { name: '銀河の果て', author: '山田' })
  const m = addMaterial(w.data, { name: '外科の歴史', author: '高橋' })
  let data: AppData = m.data
  // 作者が手で書いた分析・Claude が作ってから作者が直した分析
  const manual: BenchAnalysis = {
    id: 'manual-analysis-0001',
    workId: w.result,
    viewpoint: '人物',
    body: '作者のメモ',
    runDate: '2026-10-01',
    source: 'manual',
    v: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const edited: BenchAnalysis = { ...manual, id: 'cn-edited0001', viewpoint: '文体', source: 'claude', updatedAt: 2 }
  data = { ...data, benchAnalyses: { [manual.id]: manual, [edited.id]: edited } }
  return { data, workId: w.result, materialId: m.result, manualId: manual.id, editedId: edited.id }
}

/** コネクタが書いたその表の文書 */
const docsOf = connectorDocs

/** Claude が分析を1つ・記録を1つ足す（答えの n:… と k:…） */
async function addCards(core: Awaited<ReturnType<typeof pairedCore>>['core']) {
  const a = await core.callTool('novel_add_bench_analysis', {
    work: '銀河の果て',
    items: [{ viewpoint: '構成', body_markdown: '## 構成\n三幕。', run_date: '2026-10-30' }],
  })
  const n = (a.structured as { created: { id: string }[] }).created[0].id
  const k = await core.callTool('novel_add_material_notes', {
    material: '外科の歴史',
    items: [{ section: '要約', body_markdown: '第1章 外科の始まり。', run_date: '2026-10-31' }],
  })
  const kid = (k.structured as { created: { id: string }[] }).created[0].id
  return { n, k: kid }
}

describe('novel_move_cards_to_trash', () => {
  it('Claude が作ったカードに依頼を作り、答えに id・観点・日付・作品名と「同期すると移り、30日は戻せる」を出す', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const { n, k } = await addCards(core)
    const r = await core.callTool('novel_move_cards_to_trash', { cards: [n, k] })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('カードをゴミ箱へ移す: 移す 2件・移さない 0件')
    expect(r.text).toContain(`- 移す ${n} 相対比較『銀河の果て』の「構成」（2026-10-30）`)
    expect(r.text).toContain(`- 移す ${k} 資料『外科の歴史』の「要約」（2026-10-31）`)
    expect(r.text).toContain('もう Claude からは見えません')
    expect(r.text).toContain('アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）')
    expect(r.text).toContain('30日は、作者がアプリのゴミ箱から元に戻せます')
    expect(r.text).toContain('今日（日本時間）はあと 98件移せます')
    expect(r.structured).toEqual({
      requested: [
        { id: n, label: '相対比較『銀河の果て』の「構成」（2026-10-30）' },
        { id: k, label: '資料『外科の歴史』の「要約」（2026-10-31）' },
      ],
      skipped: [],
    })
    // 依頼だけを作る（カードの削除・ゴミ箱の記録は書かない）
    const reqs = docsOf(fake, 'trashRequests')
    expect(reqs).toHaveLength(2)
    const cards = cloudData(fake)
    expect(Object.keys(cards.benchAnalyses)).toHaveLength(3)
    expect(Object.keys(cards.trashEntries)).toHaveLength(0)
    const req = Object.values(cards.trashRequests).find((x) => x.table === 'benchAnalyses')!
    const card = Object.values(cards.benchAnalyses).find((a) => a.viewpoint === '構成')!
    expect(req).toMatchObject({
      id: trashRequestId('benchAnalyses', card.id),
      targetId: card.id,
      parentId: s.workId,
      targetUpdatedAt: card.updatedAt,
      label: '『銀河の果て』の「構成」（2026-10-30）',
      source: 'claude',
      v: 1,
    })
    expect(String(reqs[0].fields.json.stringValue).length).toBeLessThanOrEqual(2000)
  })

  it('依頼の後は、一覧の数・分析の本文から消え、id で指すと「依頼中」。もう一度頼んでも書かない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const { n, k } = await addCards(core)
    await call(core, 'novel_move_cards_to_trash', { cards: [n, k] })
    clock.now += 20_000
    const list = await call(core, 'novel_list_bench_works')
    expect(list).toContain('分析 2件')
    expect(list).toContain('  ゴミ箱へ移す依頼中 1件（アプリが同期すると移ります）')
    // 行の並び: 分析の数の次
    expect(list.indexOf('分析 2件')).toBeLessThan(list.indexOf('ゴミ箱へ移す依頼中'))
    const all = await call(core, 'novel_get_bench_analysis', { work: s.workId })
    expect(all).not.toContain('三幕')
    const one = await core.callTool('novel_get_bench_analysis', { work: s.workId, analysis_id: n })
    expect(one.isError).toBe(true)
    expect(one.text).toContain(`${n} 『銀河の果て』の「構成」（2026-10-30） はゴミ箱へ移す依頼中です`)
    expect(await call(core, 'novel_list_materials')).toContain('  ゴミ箱へ移す依頼中 1件')
    const note = await core.callTool('novel_get_material', { material: s.materialId, note_id: k })
    expect(note.text).toContain('はゴミ箱へ移す依頼中です')
    expect(await call(core, 'novel_get_material', { material: s.materialId })).not.toContain('外科の始まり')
    // もう一度: 書き込みは0（依頼済み）
    const writes = fake.calls.filter((c) => c.op === 'commit').length
    const again = await core.callTool('novel_move_cards_to_trash', { cards: [n] })
    expect(again.isError).toBeUndefined()
    expect(again.text).toContain(`- 移す ${n} 相対比較『銀河の果て』の「構成」（2026-10-30）（依頼済み）`)
    expect(fake.calls.filter((c) => c.op === 'commit').length).toBe(writes)
    expect(docsOf(fake, 'trashRequests')).toHaveLength(2)
    // 同じ分析を足し直しても、作らずに「以前に削除」
    const re = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '構成', body_markdown: '## 構成\n三幕。', run_date: '2026-10-30' }],
    })
    expect(re.text).toContain('以前に削除')
    // 状態のツール
    expect(await call(core, 'novel_status')).toContain('ゴミ箱へ移す依頼: アプリの同期待ち 2件・今日（日本時間）2 / 100件')
  })

  it('作者が書いた・直したカード、作品・資料そのもの、ほかの種類の記録、見つからない id は断る（理由を返す）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const { n } = await addCards(core)
    const r = await core.callTool('novel_move_cards_to_trash', {
      cards: [
        shortId('benchAnalysis', s.manualId),
        shortId('benchAnalysis', s.editedId),
        shortId('benchWork', s.workId),
        shortId('material', s.materialId),
        'x:12345678',
        'n:zzzzzzzz',
        n,
        n,
      ],
    })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('移す 1件・移さない 7件')
    expect(r.text).toContain('（Claude が作ったカードでない）: Claude がこのコネクタで作ったカードではありません')
    expect(r.text).toContain('（作者が直したカード）: 作者がアプリで直したカードです')
    expect(r.text).toContain(`- 移さない ${shortId('benchWork', s.workId)}（作品・資料そのもの）`)
    expect(r.text).toContain('- 移さない x:12345678（移せない種類）')
    expect(r.text).toContain('- 移さない n:zzzzzzzz（見つからない）')
    expect(r.text).toContain('（同じ指定）')
    expect((r.structured as { skipped: { reason: string }[] }).skipped.map((x) => x.reason)).toEqual([
      'not_claude',
      'edited',
      'shelf_item',
      'shelf_item',
      'not_card',
      'not_found',
      'repeated',
    ])
    expect(docsOf(fake, 'trashRequests')).toHaveLength(1)
    // 1件も移せなければ失敗として返す
    const none = await core.callTool('novel_move_cards_to_trash', { cards: [shortId('benchAnalysis', s.manualId)] })
    expect(none.isError).toBe(true)
  })

  it('21件は呼び出しごと断る。1日100件（日本時間）を超える呼び出しも断り、日付が変われば戻る', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const { n, k } = await addCards(core)
    const many = await core.callTool('novel_move_cards_to_trash', { cards: Array.from({ length: 21 }, () => n) })
    expect(many.isError).toBe(true)
    expect(many.text).toContain('1回に移せるのは20件までです')
    core.store.setMeta('trashDaily', { day: '2026-10-29', count: 99 })
    const over = await core.callTool('novel_move_cards_to_trash', { cards: [n, k] })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('今日（日本時間）ゴミ箱へ移せるのは、あと1件です')
    expect(docsOf(fake, 'trashRequests')).toHaveLength(0)
    // 日本時間の0時（UTC 15時）を過ぎると戻る
    clock.now = Date.UTC(2026, 9, 29, 15, 0, 1)
    const next = await core.callTool('novel_move_cards_to_trash', { cards: [n, k] })
    expect(next.isError).toBeUndefined()
    expect(next.text).toContain('今日（日本時間）はあと 98件移せます')
  })

  it('「書き込みを許可」していない時・データの形が違う時は作らない', async () => {
    const s = shelf()
    const off = await pairedCore(new FakeFirebase(), s.data, { writes: false })
    const r = await off.core.callTool('novel_move_cards_to_trash', { cards: ['n:12345678'] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込み')
    const old = await pairedCore(new FakeFirebase(), s.data, { model: 5 })
    const m = await old.core.callTool('novel_move_cards_to_trash', { cards: ['n:12345678'] })
    expect(m.isError).toBe(true)
    expect(m.text).toContain('データの形')
  })

  it('アプリが処理した後は「もうゴミ箱にある」。作者がゴミ箱から戻した後は、2番目の依頼を作れる', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const { n } = await addCards(core)
    await call(core, 'novel_move_cards_to_trash', { cards: [n] })
    // アプリ: 受け取った依頼を処理して、カードの削除の印・ゴミ箱の件と中身・依頼の削除の印を送る
    const before = cloudData(fake)
    const processed = applyTrashRequests(before, clock.now)
    expect(processed.result.map((o) => o.status)).toEqual(['moved'])
    pushChanges(fake, before, processed.data)
    clock.now += 20_000
    const list = await call(core, 'novel_list_bench_works')
    expect(list).toContain('分析 2件')
    expect(list).not.toContain('依頼中')
    const inTrash = await core.callTool('novel_move_cards_to_trash', { cards: [n] })
    expect(inTrash.text).toContain(`- 移さない ${n}（もうゴミ箱にある）`)
    expect(inTrash.isError).toBeUndefined()
    // 作者がゴミ箱から戻した（カードが生き返り、依頼は削除の印のまま）
    const entryId = Object.keys(processed.data.trashEntries)[0]
    const restored = restoreTrashEntry(processed.data, entryId).data
    pushChanges(fake, processed.data, restored)
    clock.now += 20_000
    expect(await call(core, 'novel_get_bench_analysis', { work: s.workId })).toContain('三幕')
    const again = await core.callTool('novel_move_cards_to_trash', { cards: [n] })
    expect(again.isError).toBeUndefined()
    expect(again.text).toContain(`- 移す ${n}`)
    const cardId = Object.values(restored.benchAnalyses).find((a) => a.viewpoint === '構成')!.id
    expect(docsOf(fake, 'trashRequests').map((d) => d.fields.id.stringValue)).toContain(trashRequestId('benchAnalyses', cardId, 2))
  })
})

describe('novel_move_cards_to_trash: 相対比較の分析・資料の記録の答えは 2.7 と同じ', () => {
  it('移す・移さない・依頼済みの答えの全文', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const { n, k } = await addCards(core)
    const r = await core.callTool('novel_move_cards_to_trash', { cards: [n, k] })
    expect(r.text).toBe(
      [
        'カードをゴミ箱へ移す: 移す 2件・移さない 0件',
        `- 移す ${n} 相対比較『銀河の果て』の「構成」（2026-10-30）`,
        `- 移す ${k} 資料『外科の歴史』の「要約」（2026-10-31）`,
        '移すカードは、もう Claude からは見えません。アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）。移した後30日は、作者がアプリのゴミ箱から元に戻せます。',
        '今日（日本時間）はあと 98件移せます。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    const manual = shortId('benchAnalysis', s.manualId)
    const edited = shortId('benchAnalysis', s.editedId)
    const work = shortId('benchWork', s.workId)
    const again = await core.callTool('novel_move_cards_to_trash', { cards: [n, manual, edited, work, 'n:zzzzzzzz', n] })
    expect(again.text).toBe(
      [
        'カードをゴミ箱へ移す: 移す 1件・移さない 5件',
        `- 移す ${n} 相対比較『銀河の果て』の「構成」（2026-10-30）（依頼済み）`,
        `- 移さない ${manual} 『銀河の果て』の「人物」（2026-10-01）（Claude が作ったカードでない）: Claude がこのコネクタで作ったカードではありません（作者が書いた・貼り付けたカードは移せません。作者がアプリで削除してください）`,
        `- 移さない ${edited} 『銀河の果て』の「文体」（2026-10-01）（作者が直したカード）: 作者がアプリで直したカードです（移せません。作者がアプリで削除してください）`,
        `- 移さない ${work}（作品・資料そのもの）: 作品・資料そのものは移せません（移せるのはカードだけ。作品・資料ごとやり直す時は、作者がアプリで削除してください）`,
        '- 移さない n:zzzzzzzz（見つからない）: 見つかりません（novel_get_bench_analysis・novel_get_material で id を確かめてください）',
        `- 移さない ${n} 『銀河の果て』の「構成」（2026-10-30）（同じ指定）: この呼び出しの中で、前に指定したカードと同じです（1つにまとめました）`,
        '移すカードは、もう Claude からは見えません。アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）。移した後30日は、作者がアプリのゴミ箱から元に戻せます。',
        '今日（日本時間）はあと 98件移せます。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    // 依頼の記録の形（版 1）
    const req = Object.values(cloudData(fake).trashRequests).find((x) => x.table === 'materialNotes')!
    expect(Object.keys(req).sort()).toEqual(
      ['id', 'table', 'targetId', 'parentId', 'targetUpdatedAt', 'label', 'source', 'v', 'createdAt', 'updatedAt'].sort(),
    )
    expect(req.v).toBe(1)
  })
})

// ---------- Claude が作ったアイデア（2.8） ----------

/** コネクタが作る形の Claude のアイデア（作った時刻 at・場所 titleId・名前・中身） */
function claudeIdea(titleId: string | null, name: string, content: string, at: number, order = 0): Idea {
  const body = claudeIdeaBody(at, name, content)
  return {
    id: claudeIdeaId(titleId, jstDate(at), name, content),
    titleId,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: at,
    updatedAt: at,
  }
}

/** shelf に、ホーム・『星の庭』（読む＋書き込む）・『読む庭』（読むだけ）の Claude のアイデアと、作者のアイデアを足す */
function ideaShelf() {
  const s = shelf()
  const titleId = Object.values(s.data.titles).find((t) => t.name === '星の庭')!.id
  const r = createTitle(s.data, '読む庭')
  const at = Date.UTC(2026, 9, 28, 5, 32, 0)
  const home = claudeIdea(null, '第3章の動機', '【動機】\n・兄を探す', at)
  const inTitle = claudeIdea(titleId, '', '星の庭の案', at, 1)
  const readOnly = claudeIdea(r.result, '', '読む庭の案', at)
  const authorHome: Idea = {
    id: 'author-home-0001',
    titleId: null,
    heading: '',
    body: 'ホームの作者の案',
    order: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  const authorTitle: Idea = { ...authorHome, id: 'author-title-001', titleId, body: '星の庭の作者の案' }
  const data: AppData = {
    ...r.data,
    titles: { ...r.data.titles, [r.result]: { ...r.data.titles[r.result], claudeAccess: 'read' } },
    ideas: {
      [home.id]: home,
      [inTitle.id]: inTitle,
      [readOnly.id]: readOnly,
      [authorHome.id]: authorHome,
      [authorTitle.id]: authorTitle,
    },
  }
  return { ...s, data, titleId, home, inTitle, readOnly, authorHome, authorTitle }
}

describe('novel_move_cards_to_trash: Claude が作ったアイデア（i:…）', () => {
  it('ホーム・タイトルのアイデアに依頼を作り、場所と1行目を出す（アイデアだけの時の結び）。依頼の後は見えない', async () => {
    const fake = new FakeFirebase()
    const s = ideaShelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const home = shortId('idea', s.home.id)
    const title = shortId('idea', s.inTitle.id)
    const r = await core.callTool('novel_move_cards_to_trash', { cards: [home, s.inTitle.id] })
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe(
      [
        'カードをゴミ箱へ移す: 移す 2件・移さない 0件',
        `- 移す ${home} ホームのアイデア「2026/10/28 14:32　第3章の動機」`,
        `- 移す ${title} タイトル『星の庭』のアイデア「2026/10/28 14:32」`,
        '移すアイデアは、もう Claude からは見えません。アプリを開いて同期すると、アプリのゴミ箱へ移ります。移した後30日は、作者がアプリのゴミ箱から元に戻せます。',
        '今日（日本時間）はあと 98件移せます。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    expect(r.structured).toEqual({
      requested: [
        { id: home, label: 'ホームのアイデア「2026/10/28 14:32　第3章の動機」' },
        { id: title, label: 'タイトル『星の庭』のアイデア「2026/10/28 14:32」' },
      ],
      skipped: [],
    })
    const reqs = Object.values(cloudData(fake).trashRequests)
    expect(reqs.map((x) => [x.table, x.targetId, x.parentId, x.v]).sort()).toEqual(
      [
        ['ideas', s.home.id, 'home', 2],
        ['ideas', s.inTitle.id, s.titleId, 2],
      ].sort(),
    )
    clock.now += 20_000
    // 見せる内容から外れ、もう一度頼むと「依頼済み」（書かない）
    expect(core.views().view.ideas[s.inTitle.id]).toBeUndefined()
    expect(core.views().view.ideas[s.home.id]).toBeUndefined()
    const notes = await call(core, 'novel_get_notes', { title_id: s.titleId, kind: 'ideas' })
    expect(notes).not.toContain('星の庭の案')
    const writes = fake.calls.filter((c) => c.op === 'commit').length
    const again = await core.callTool('novel_move_cards_to_trash', { cards: [home] })
    expect(again.text).toContain(`- 移す ${home} ホームのアイデア「2026/10/28 14:32　第3章の動機」（依頼済み）`)
    expect(fake.calls.filter((c) => c.op === 'commit').length).toBe(writes)
  })

  it('分析とアイデアを一緒に移す時は、2.7 の結びの文。作者のアイデア・「読むだけ」のタイトル・見えないホームのアイデアは断る', async () => {
    const fake = new FakeFirebase()
    const s = ideaShelf()
    const { core } = await pairedCore(fake, s.data)
    const { n } = await addCards(core)
    const both = await core.callTool('novel_move_cards_to_trash', { cards: [n, shortId('idea', s.home.id)] })
    expect(both.text).toContain('アプリを開いて同期すると、アプリのゴミ箱へ移ります（作品・資料は棚に残ります）')
    expect(both.text).not.toContain('移すアイデアは')
    const r = await core.callTool('novel_move_cards_to_trash', {
      cards: [shortId('idea', s.authorTitle.id), shortId('idea', s.readOnly.id), shortId('idea', s.authorHome.id), 'x:12345678'],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('移す 0件・移さない 4件')
    expect(r.text).toContain(
      `- 移さない ${shortId('idea', s.authorTitle.id)} タイトル『星の庭』のアイデア「星の庭の作者の案」（Claude が作ったカードでない）`,
    )
    expect(r.text).toContain(
      `- 移さない ${shortId('idea', s.readOnly.id)} タイトル『読む庭』のアイデア「2026/10/28 14:32」（書き込めない場所のアイデア）: 「Claude に見せる」が「読む＋書き込む」でないタイトルのアイデアです`,
    )
    // 作者が書いたホームのアイデアは見えない（ある・無いを答えない）
    expect(r.text).toContain(
      `- 移さない ${shortId('idea', s.authorHome.id)}（見つからない）: 見つかりません（novel_get_notes の kind=ideas で id を確かめてください）`,
    )
    expect(r.text).not.toContain('ホームの作者の案')
    expect(r.text).toContain(
      '- 移さない x:12345678（移せない種類）: 移せるのは相対比較の分析（n:…）・資料の記録（k:…）・Claude が作ったアイデア（i:…）だけです',
    )
    expect((r.structured as { skipped: { reason: string }[] }).skipped.map((x) => x.reason)).toEqual([
      'not_claude',
      'not_writable',
      'not_found',
      'not_card',
    ])
  })

  it('作者が直したアイデアは断る。Claude の追記（アプリの同期待ちも）だけなら移せ、アプリは追記してから移す。処理の後は「もうゴミ箱にある」', async () => {
    const fake = new FakeFirebase()
    const s = ideaShelf()
    // 作者がタイトルのアイデアを直した。ホームのアイデアには Claude の追記の依頼（アプリの同期待ち）
    const edited = updateIdea(s.data, s.inTitle.id, { body: `${s.inTitle.body}\n作者の行` })
    const mark = ideaReadMark(s.home.body)
    const append = {
      id: ideaAppendId(s.home.id, mark, '動機を変える'),
      ideaId: s.home.id,
      text: '動機を変える',
      readMark: mark,
      source: 'claude' as const,
      v: 1,
      createdAt: Date.UTC(2026, 9, 29, 1, 0, 0),
      updatedAt: Date.UTC(2026, 9, 29, 1, 0, 0),
    }
    const { core, clock } = await pairedCore(fake, { ...edited, ideaAppends: { [append.id]: append } })
    const shown = core.views().view.ideas[s.home.id].body
    expect(shown).toContain('2026/10/29のセッションで以下の内容へ変更\n動機を変える')
    const r = await core.callTool('novel_move_cards_to_trash', {
      cards: [shortId('idea', s.inTitle.id), shortId('idea', s.home.id)],
    })
    expect(r.text).toContain('移す 1件・移さない 1件')
    expect(r.text).toContain('（作者が直したカード）: 作者がアプリで直したカードです')
    // アプリ: 追記を足してから、ゴミ箱へ移す
    const before = cloudData(fake)
    const processed = applyClaudeRequests(before, clock.now)
    expect(processed.result.appends.map((o) => o.status)).toEqual(['appended'])
    expect(processed.result.trash.map((o) => o.status)).toEqual(['moved'])
    const rec = Object.values(processed.data.trashRecords)[0].record as Idea
    expect(rec.body).toBe(shown)
    pushChanges(fake, before, processed.data)
    clock.now += 20_000
    const inTrash = await core.callTool('novel_move_cards_to_trash', { cards: [shortId('idea', s.home.id)] })
    expect(inTrash.text).toContain(`- 移さない ${shortId('idea', s.home.id)}（もうゴミ箱にある）`)
    // 作者が戻すと、2番目の依頼を作れる
    const entryId = Object.keys(processed.data.trashEntries)[0]
    const restored = restoreTrashEntry(processed.data, entryId).data
    pushChanges(fake, processed.data, restored)
    clock.now += 20_000
    const again = await core.callTool('novel_move_cards_to_trash', { cards: [shortId('idea', s.home.id)] })
    expect(again.text).toContain(`- 移す ${shortId('idea', s.home.id)} ホームのアイデア「2026/10/28 14:32　第3章の動機」`)
    expect(docsOf(fake, 'trashRequests').map((d) => d.fields.id.stringValue)).toContain(trashRequestId('ideas', s.home.id, 2))
  })
})
