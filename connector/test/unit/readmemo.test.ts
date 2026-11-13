// 推敲案の確かめた範囲（covered）は、Claude が読んだ時の本文で残す（L2-2）。
// B が novel_read_text で読んだ後に、作者がアプリでその話を直してから B が novel_add_proofreading で covered に入れると、
// 前は書く時の本文の指紋を残したので「すべて確認済み」になり、直した所は推敲されないまま「本文が変わった話」にも出なかった。
// いまは接続ごとに読んだ時の指紋を控え（SQLite の readmemo）、違えば読んだ時の指紋と補足を残す。
import { describe, expect, it } from 'vitest'
import { hashJson } from '../../../src/domain/hash'
import { updateVersion } from '../../../src/domain/storyOps'
import type { AppData, ProofBatch } from '../../../src/domain/types'
import { novel, splitEpisode } from '../../../src/test/claudeFixture'
import { READ_MEMO_MAX_AGE_MS, READ_MEMO_MAX_ROWS, type GrantProps, type VaultCore } from '../../src/vault/core'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, addConnection, makeCore, pairedCore } from '../support/harness'

/** 2つの接続で連携した Vault（A = caaa、B = cbbb） */
async function accounts(data: AppData) {
  const fake = new FakeFirebase()
  const made = await pairedCore(fake, data, { cid: 'caaa', config: { dailyReadBudget: 1_000_000 } })
  const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', name: '接続2', pairedAt: made.clock.now })
  return { fake, ...made, a: made.grant, b }
}

/** ツールを呼ぶ（失敗なら例外） */
async function tool(core: VaultCore, grant: GrantProps | undefined, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await core.callTool(name, args, grant ? { grant } : {})
  if (r.isError) throw new Error(`${name}: ${r.text}`)
  return r.text
}

/** 作った実行の記録（小さな記録だけ） */
function batches(fake: FakeFirebase): ProofBatch[] {
  return fake
    .recordDocs(OWNER)
    .filter((d) => d.name.includes('/proofBatches:') && d.fields.json && 'stringValue' in d.fields.json)
    .map((d) => JSON.parse((d.fields.json as { stringValue: string }).stringValue) as ProofBatch)
}

const BODIES = ['第一話の本文。', '第二話の本文。', '第三話の本文。\n彼は見れる景色を眺めた。', '第四話の本文。']
const EDITED = '作者が足した段落。食べれる。\n第三話の本文。\n彼は見れる景色を眺めた。'

/** 4話のタイトルと、#3 を作者がアプリで直す関数（端末と同じ形でクラウドに送る） */
async function story() {
  const n = novel(BODIES)
  const acc = await accounts(n.data)
  const v3 = n.data.pieces[n.ids[2]].activeVersionId!
  const edit = (body: string) => {
    const after = updateVersion(n.data, v3, { body })
    acc.fake.putRecord(OWNER, 'versions', after.versions[v3] as never)
    n.data = after
    // 読むツールの前の取り込み（15秒ごと）にも入るように
    acc.clock.now += 20_000
  }
  const read = (grant: GrantProps, args: Record<string, unknown> = {}) =>
    tool(acc.core, grant, 'novel_read_text', { title_id: n.titleId, ...args })
  const proofread = (grant: GrantProps, args: Record<string, unknown> = {}) =>
    tool(acc.core, grant, 'novel_add_proofreading', {
      title_id: n.titleId,
      run_label: '推敲',
      covered: ['#1', '#2', '#3', '#4'],
      items: [{ piece: '#3', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' }],
      ...args,
    })
  const coverage = async (grant: GrantProps) =>
    /確認の範囲: (.*)/.exec(await tool(acc.core, grant, 'novel_list_proofreading', { title_id: n.titleId }))?.[1]
  /** 最後に作った実行の記録の #3 の指紋 */
  const covered3 = () => {
    const list = batches(acc.fake).sort((x, y) => x.createdAt - y.createdAt)
    return list[list.length - 1].covered.find((c) => c.pieceId === n.ids[2])!
  }
  return { n, ...acc, edit, read, proofread, coverage, covered3, v3 }
}

const NOTE = '補足: #3 第3話 は読んだ後に本文が変わっています（変わった所は推敲できていないため、確認の範囲では「本文が変わった話」になります。novel_read_text で読み直して推敲してください）'

describe('推敲案の確かめた範囲は読んだ時の本文で残す（L2-2）', () => {
  it('B が #3 を読み、アプリで #3 を直してから B が covered に入れる: 本文が変わった話になり、補足で知らせる（A の相対比較と同時でも）', async () => {
    const s = await story()
    // U2: B が読む間に A が相対比較の分析を足す
    const [text] = await Promise.all([
      s.read(s.b),
      tool(s.core, s.a, 'novel_add_bench_analysis', {
        work: '星を継ぐ',
        new_work: { name: '星を継ぐ', author: '高橋' },
        items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い文。', run_date: '2026-10-30' }],
      }),
    ])
    expect(text).toContain('彼は見れる景色を眺めた。')
    s.clock.now += 5 * 60_000
    s.edit(EDITED)
    const [added] = await Promise.all([
      s.proofread(s.b),
      tool(s.core, s.a, 'novel_add_bench_analysis', {
        work: '夏への扉',
        new_work: { name: '夏への扉', author: '佐藤' },
        items: [{ viewpoint: '構成', body_markdown: '## 構成\n三部。', run_date: '2026-10-30' }],
      }),
    ])
    expect(added).toContain('追加 1件')
    expect(added).toContain('- 実行の記録（確認した話・追加した案）を残しました')
    expect(added.split('\n')).toContain(NOTE)
    // 読んだ時の指紋（前は書く時の指紋 = 直した後の本文）
    expect(s.covered3()).toMatchObject({ bodyHash: hashJson(BODIES[2]), versionId: s.v3 })
    expect(await s.coverage(s.b)).toBe('本文が変わった話 #3')
    // アプリの表示も同じ（proofCoverage）。A から見ても同じ記録
    expect(await s.coverage(s.a)).toBe('本文が変わった話 #3')
  })

  it('直していなければ確認済み（補足なし・いまの指紋）', async () => {
    const s = await story()
    await s.read(s.b)
    s.clock.now += 5 * 60_000
    const added = await s.proofread(s.b)
    expect(added).not.toContain('読んだ後に本文が変わっています')
    expect(s.covered3().bodyHash).toBe(hashJson(BODIES[2]))
    expect(await s.coverage(s.b)).toBe('すべて確認済み')
  })

  it('ほかの接続（A）が直す前に読んでいて、B は読んでいない: 今までどおり（書く時の指紋で確認済み）。A の読んだ控えは B に効かない', async () => {
    const s = await story()
    await s.read(s.a)
    s.edit(EDITED)
    const added = await s.proofread(s.b)
    expect(added).not.toContain('読んだ後に本文が変わっています')
    expect(s.covered3().bodyHash).toBe(hashJson(EDITED))
    expect(await s.coverage(s.b)).toBe('すべて確認済み')
    // A が同じように covered に入れると、A の読んだ時の指紋（run_label を変えて別の実行の記録にする）
    const byA = await s.proofread(s.a, { run_label: 'A の推敲', items: [] })
    expect(byA.split('\n')).toContain(NOTE)
    expect(s.covered3().bodyHash).toBe(hashJson(BODIES[2]))
    expect(await s.coverage(s.b)).toBe('本文が変わった話 #3')
  })

  it('直した後に読み直すと、いまの指紋で確認済みになる', async () => {
    const s = await story()
    await s.read(s.b)
    s.edit(EDITED)
    expect(await s.read(s.b, { pieces: ['#3'] })).toContain('作者が足した段落。')
    const added = await s.proofread(s.b)
    expect(added).not.toContain('読んだ後に本文が変わっています')
    expect(s.covered3().bodyHash).toBe(hashJson(EDITED))
    expect(await s.coverage(s.b)).toBe('すべて確認済み')
  })

  it('検索（novel_search_text）は読んだことにしない: 直した後に検索で新しい本文を見ても、読んだ時の指紋のまま', async () => {
    const s = await story()
    await s.read(s.b)
    s.edit(EDITED)
    expect(await tool(s.core, s.b, 'novel_search_text', { title_id: s.n.titleId, query: '食べれる' })).toContain('食べれる')
    expect((await s.proofread(s.b)).split('\n')).toContain(NOTE)
    expect(await s.coverage(s.b)).toBe('本文が変わった話 #3')
  })

  it('読んだ後に直されて引用が見つからない時は、引用の仕方ではなく本文が変わったことを言う', async () => {
    const s = await story()
    await s.read(s.b)
    s.edit('第三話の本文。\n彼は見られる景色を眺めた。')
    const r = await s.core.callTool(
      'novel_add_proofreading',
      {
        title_id: s.n.titleId,
        items: [{ piece: '#3', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' }],
      },
      { grant: s.b },
    )
    expect(r.text).toContain(
      '- 見つからない #3 第3話「見れる」: 抜き出した箇所が#3 第3話の採用原稿に見つかりません。読んだ後に本文が変わっています（novel_read_text で読み直して、いまの本文から引用してください）',
    )
    // 読んでいない接続には今までの説明
    const a = await s.core.callTool(
      'novel_add_proofreading',
      { title_id: s.n.titleId, items: [{ piece: '#3', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }] },
      { grant: s.a },
    )
    expect(a.text).toContain('採用原稿から原文どおり（ルビの記法も含めて）引用してください')
  })

  it('長い話を2ページに分けて読み、間に前のページの所が直された: 本文が変わった話（続きの答えも本文が変わったと知らせる）', async () => {
    const long = Array.from({ length: 12 }, (_, k) => `段落${k + 1}。${'あ'.repeat(280)}`).join('\n')
    const n = novel(['第一話。', long])
    const acc = await accounts(n.data)
    const v2 = n.data.pieces[n.ids[1]].activeVersionId!
    const first = await tool(acc.core, acc.b, 'novel_read_text', { title_id: n.titleId, pieces: ['#2'], char_budget: 2_000 })
    const cursor = /続き: cursor="([^"]+)"/.exec(first)![1]
    const edited = long.replace('段落1。', '段落1（直した）。')
    acc.fake.putRecord(OWNER, 'versions', updateVersion(n.data, v2, { body: edited }).versions[v2] as never)
    acc.clock.now += 20_000
    const pages: string[] = []
    for (let c: string | undefined = cursor; c; ) {
      const page = await tool(acc.core, acc.b, 'novel_read_text', { title_id: n.titleId, cursor: c, char_budget: 2_000 })
      pages.push(page)
      c = /続き: cursor="([^"]+)"/.exec(page)?.[1]
    }
    expect(pages[0].split('\n')[0]).toBe('（前回の続きの話の本文が変わっていたため、その段落の始めから読み直しています）')
    const added = await tool(acc.core, acc.b, 'novel_add_proofreading', { title_id: n.titleId, covered: ['#2'], items: [] })
    expect(added).toContain('#2 第2話 は読んだ後に本文が変わっています')
    expect(batches(acc.fake)[0].covered[0].bodyHash).toBe(hashJson(long))
  })

  it('幕に分けた話: まだ読んでいない幕だけが直された時は確認済み、読んだ幕が直された時は本文が変わった話', async () => {
    const n = novel(['第一話。', '第一幕の本文。\n第二幕の本文。\n第三幕の本文。'])
    const { acts } = splitEpisode(n, n.ids[1], [8, 16])
    const acc = await accounts(n.data)
    const versionOf = (act: string) => n.data.pieces[act].activeVersionId!
    const push = (act: string, body: string) => {
      const after = updateVersion(n.data, versionOf(act), { body })
      acc.fake.putRecord(OWNER, 'versions', after.versions[versionOf(act)] as never)
      n.data = after
      acc.clock.now += 20_000
    }
    const read = (pieces: string[]) => tool(acc.core, acc.b, 'novel_read_text', { title_id: n.titleId, pieces })
    const add = (label: string) =>
      tool(acc.core, acc.b, 'novel_add_proofreading', { title_id: n.titleId, run_label: label, covered: ['#2'], items: [] })
    // 第1幕を読み、まだ読んでいない第3幕が直された後に第2・3幕を読む: 読んだのはすべていまの本文
    await read(['#2.1'])
    push(acts[2], '第三幕の本文（直した）。')
    await read(['#2.2', '#2.3'])
    expect(await add('1回目')).not.toContain('読んだ後に本文が変わっています')
    // 第1幕を読み直し、読んだ第1幕が直された後に第2・3幕を読む: 第1幕の直した所を読んでいない
    await read(['#2.1'])
    push(acts[0], '第一幕の本文（直した）。\n')
    await read(['#2.2', '#2.3'])
    expect(await add('2回目')).toContain('#2 第2話 は読んだ後に本文が変わっています')
    expect(await tool(acc.core, acc.b, 'novel_list_proofreading', { title_id: n.titleId })).toContain(
      '確認の範囲: 未確認 #1、本文が変わった話 #2',
    )
  })

  it('Vault を作り直した後（Durable Object がメモリから外れた）も、保存した控えを使う', async () => {
    const s = await story()
    await s.read(s.b)
    s.edit(EDITED)
    const cold = makeCore(s.fake, { sql: s.sql, clock: s.clock, config: { dailyReadBudget: 1_000_000 } })
    const r = await cold.core.callTool(
      'novel_add_proofreading',
      { title_id: s.n.titleId, run_label: '推敲', covered: ['#3'], items: [] },
      { grant: s.b },
    )
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('#3 第3話 は読んだ後に本文が変わっています')
  })

  it('控えが無い時（24時間より前に読んだ・控えの無い Vault）は今までどおり', async () => {
    const s = await story()
    await s.read(s.b)
    s.edit(EDITED)
    s.clock.now += READ_MEMO_MAX_AGE_MS
    expect(await s.proofread(s.b)).not.toContain('読んだ後に本文が変わっています')
    expect(s.covered3().bodyHash).toBe(hashJson(EDITED))
    expect(await s.coverage(s.b)).toBe('すべて確認済み')

    // 控えを失った Vault（控えを置く前の版で読んだ・保存領域を失った）で作り直す
    const t = await story()
    await t.read(t.b)
    t.edit(EDITED)
    t.sql.run('DELETE FROM readmemo')
    const cold = makeCore(t.fake, { sql: t.sql, clock: t.clock, config: { dailyReadBudget: 1_000_000 } })
    const r = await cold.core.callTool(
      'novel_add_proofreading',
      { title_id: t.n.titleId, run_label: '推敲', covered: ['#3'], items: [] },
      { grant: t.b },
    )
    expect(r.text).not.toContain('読んだ後に本文が変わっています')
    expect(r.text).toContain('- 実行の記録（確認した話・追加した案）を残しました')
  })

  it('許可の無い呼び出しは控えない。控えは24時間より古いもの・多すぎる分を片付ける', async () => {
    const s = await story()
    await tool(s.core, undefined, 'novel_read_text', { title_id: s.n.titleId })
    expect(s.core.store.readMemoCount()).toBe(0)
    await s.read(s.b)
    // 4話（幕なし）
    expect(s.core.store.readMemoCount()).toBe(4)
    s.clock.now += READ_MEMO_MAX_AGE_MS + 3_600_000
    await s.read(s.a, { pieces: ['#1'] })
    // B の古い控えは消え、A の1話だけ
    expect(s.core.store.readMemoCount()).toBe(1)
    for (let i = 0; i < READ_MEMO_MAX_ROWS + 10; i++)
      s.core.store.putReadMemo('cx@g', `p${i}`, { hash: 'h', ver: null, parts: '{}', at: s.clock.now - 1_000 + (i % 100) })
    s.core.store.pruneReadMemo(s.clock.now - READ_MEMO_MAX_AGE_MS, READ_MEMO_MAX_ROWS)
    expect(s.core.store.readMemoCount()).toBe(READ_MEMO_MAX_ROWS)
  })
})
