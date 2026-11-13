// 書き込みの守り（2.9 の複数の接続で、ほかの接続と同じ時に書く）: 取り込みの途中で書かない・「書き込みを許可」をオンに戻したら
// すぐ書ける・順番を待つ間に外された接続は書かない・記録を分けて書いた時に後の組が書けなかったら、書けた分を答えて、数えるのは
// 書けた分だけ。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../../../src/domain/benchOps'
import type { AppData } from '../../../src/domain/types'
import { novel } from '../../../src/test/claudeFixture'
import type { QuotaCounts } from '../../src/vault/quota'
import { CONNECTOR_MODEL } from '../../src/version'
import { COMMIT_GROUP, groups } from '../../src/vault/writer'
import { FakeFirebase } from '../support/fakeFirebase'
import { commit, errorResponse, gatedFetch, settle } from '../support/gate'
import { OWNER, addConnection, pairedCore } from '../support/harness'

async function accounts(data: AppData | null, opts: Parameters<typeof pairedCore>[2] = {}) {
  const fake = new FakeFirebase()
  const gate = gatedFetch(fake)
  const made = await pairedCore(fake, data, { cid: 'caaa', fetch: gate.fetch, ...opts })
  const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', pairedAt: made.clock.now })
  return { fake, gate, ...made, a: made.grant, b }
}

const writes = (core: { store: { getMeta: <T>(k: string) => T | null } }) => core.store.getMeta<QuotaCounts>('quota')?.writes ?? 0
const docsOf = (fake: FakeFirebase, table: string) => fake.recordDocs(OWNER).filter((d) => d.name.includes(`/${table}:`))

const benchAdd = (work: string, withNew = true) => ({
  work,
  ...(withNew ? { new_work: { name: work, author: '高橋' } } : {}),
  items: [{ viewpoint: '文体', body_markdown: `## 文体\n${work}は短い文。`, run_date: '2026-10-30' }],
})

describe('L5-2: 書き込みの前の取り込みが終わらない時は書かない', () => {
  it('端末からの大量の変更を5歩で取り込み切れなければ、何も書かずに断り、続きは alarm で取り込む（作者が削除した作品に分析を足さない）', async () => {
    const n = novel(['本文。'])
    const w = addBenchWork(n.data, { name: '作品Z', author: '山田' })
    // 1歩は 1,000 字ほどで止める（1ページ）。5歩で 250 件しか読めない
    const { core, fake, clock, scheduled, a, b } = await accounts(w.data, { config: { workBudgetChars: 1_000 } })
    clock.now += 20_000
    for (let i = 0; i < 20; i++)
      fake.putMany(
        OWNER,
        Array.from({ length: 40 }, (_, k) => ({ table: 'zzFiller', rec: { id: `z${i}-${k}`, text: 'あ'.repeat(100) } as never })),
      )
    fake.tombstone(OWNER, 'benchWorks', w.result)
    scheduled.length = 0
    const r = await core.callTool('novel_add_bench_analysis', benchAdd('作品Z', false), { grant: a })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^端末からの変更を取り込んでいる途中です（この呼び出しで 250件を取り込みました）。何も書いていません。/)
    expect(r.text).toContain('少し待ってから、もう一度試してください')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)
    expect(scheduled.some((at) => at !== null && at > clock.now)).toBe(true)
    // ゴミ箱へ移す依頼・アイデアも同じ
    const idea = await core.callTool('novel_add_ideas', { items: [{ content: '案' }], placement: 'outside' }, { grant: b })
    expect(idea.isError).toBe(true)
    expect(idea.text).toContain('端末からの変更を取り込んでいる途中です')
    // 読むのは、今までどおり途中の内容で答える
    const list = await core.callTool('novel_list_bench_works', {}, { grant: b })
    expect(list.isError).toBeUndefined()
    expect(list.text).toContain('（端末からの変更が多いため、取り込みの途中の内容です）')
    // 続き（alarm）で取り込み終えれば、削除を見て断る
    for (let i = 0; i < 20 && (await core.alarm()) !== null; i++);
    const again = await core.callTool('novel_add_bench_analysis', benchAdd('作品Z', false), { grant: a })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('見つかりません')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)
  })
})

describe('L5-3: 「書き込みを許可」をオンに戻した・アプリを更新した後は、数秒で書ける', () => {
  it('停止中（前に読んだ内容）で断るのは5秒まで。それより前に読んだ内容なら、断る前に読み直す（どの接続も）', async () => {
    const n = novel(['本文。'])
    const { core, fake, clock, a, b } = await accounts(n.data, { writes: false })
    clock.now += 20_000
    const off = await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    expect(off.text).toContain('書き込みは停止中です')
    // 作者がオンにした
    fake.setWrites(true)
    clock.now += 6_000
    expect((await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })).text).toContain('追加 1件')
    expect((await core.callTool('novel_add_bench_analysis', benchAdd('作品B'), { grant: b })).text).toContain('追加 1件')
    // オフにした直後（5秒以内に読んだ内容）は、読み直さずに断る（オフはクラウドが断るので、前に読んだ内容がオンでも書けない）
    fake.setWrites(false)
    const offAgain = await core.callTool('novel_add_bench_analysis', benchAdd('作品C'), { grant: b })
    expect(offAgain.text).toContain('書き込みは停止中です')
    const reads = fake.calls.filter((c) => c.op === 'batchGet').length
    clock.now += 1_000
    expect((await core.callTool('novel_add_bench_analysis', benchAdd('作品C'), { grant: a })).text).toContain('書き込みは停止中です')
    expect(fake.calls.filter((c) => c.op === 'batchGet').length).toBe(reads)
  })

  it('データの形の版が違う（前に読んだ内容）で断るのも5秒まで', async () => {
    const n = novel(['本文。'])
    const { core, fake, clock, a } = await accounts(n.data)
    fake.setAppModel(OWNER, CONNECTOR_MODEL + 1)
    clock.now += 61_000
    const old = await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    expect(old.text).toContain('コネクタを更新')
    fake.setAppModel(OWNER, CONNECTOR_MODEL)
    clock.now += 6_000
    expect((await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })).text).toContain('追加 1件')
  })
})

describe('L5-8: ほかの接続の書き込みの後ろで待つ間に外された接続は、書かない', () => {
  it('待つ間に一覧から外され（1分を過ぎて読み直した）、すべて解除して連携し直された時は 401。待たせた接続の書き込みはそのまま', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, clock, a, b } = await accounts(n.data)
    const hold = gate.hold(commit)
    const pB = core.callTool('novel_add_bench_analysis', benchAdd('作品B'), { grant: b })
    await hold.sent
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    await settle()
    fake.removeConnection('caaa')
    clock.now += 90_000
    hold.release()
    const [rb, ra] = await Promise.all([pB, pA])
    expect(rb.text).toContain('追加 1件')
    expect(ra.isError).toBe(true)
    expect(ra.auth).toBe(true)
    expect(ra.text).toContain('連携が解除されています')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
  })

  it('待つ間に、ほかの接続の novel_status が読み直した一覧に無ければ（1分たっていなくても）書かない', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, a, b } = await accounts(n.data)
    const hold = gate.hold(commit)
    const pB = core.callTool('novel_add_bench_analysis', benchAdd('作品B'), { grant: b })
    await hold.sent
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    await settle()
    fake.removeConnection('caaa')
    expect((await core.callTool('novel_status', {}, { grant: b })).text).toContain('この接続: cbbb')
    hold.release()
    const [rb, ra] = await Promise.all([pB, pA])
    expect(rb.text).toContain('追加 1件')
    expect(ra.auth).toBe(true)
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
  })

  it('待つ間に［連携をすべて解除］して連携し直した（代が変わった）時は、同じ cid が一覧にあっても前の代の許可では書かない', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, uid, clock, a, b } = await accounts(n.data)
    const hold = gate.hold(commit)
    const pB = core.callTool('novel_add_bench_analysis', benchAdd('作品B'), { grant: b })
    await hold.sent
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    await settle()
    fake.setConnector(null)
    const again = await addConnection(fake, core, uid, { cid: 'caaa', pairedAt: clock.now, state: 'state-again' })
    expect(again.gen).not.toBe(a.gen)
    hold.release()
    const [, ra] = await Promise.all([pB, pA])
    expect(ra.auth).toBe(true)
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    // 新しい代の許可は書ける
    expect((await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: again })).text).toContain('追加 1件')
  })
})

describe('L5-4・L5-9・L3-8: 書けなかった分', () => {
  /** 100 か所の「見れる」がある1話 */
  function hundred() {
    const lines = Array.from({ length: 100 }, (_, i) => `【${i + 1}】海が見れる。`)
    const n = novel([lines.join('\n')])
    const input = {
      title_id: n.titleId,
      run_label: 'ら抜き',
      items: lines.map((_, i) => ({
        piece: '#1',
        excerpt: `【${i + 1}】海が見れる`,
        category: 'ra_nuki',
        suggestion: `【${i + 1}】海が見られる`,
        reason: 'ら抜き言葉',
      })),
    }
    return { n, input }
  }

  it('推敲案 100件と実行の記録を2つの組（51件・50件）に分けて書き、後の組が書けなかったら、書けた分をふつうの答えで返す。もう一度送ると残りと実行の記録を足す', async () => {
    const { n, input } = hundred()
    const { core, fake, gate, b } = await accounts(n.data)
    const before = writes(core)
    // 1つ目の組は書け、2つ目の組は 503（2回の試し直しも）
    gate.failNext(commit, 3, () => errorResponse(503, 'UNAVAILABLE'), { skip: 1 })
    const r = await core.callTool('novel_add_proofreading', input, { grant: b })
    expect(r.isError).toBeUndefined()
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('推敲案を追加: 追加 51件・書けなかった 49件')
    expect(lines.filter((l) => /^- 追加 x:\S+ #1 第1話 ¶\d+「【\d+】海が見れる」$/.test(l))).toHaveLength(51)
    expect(lines.filter((l) => /^- 書けなかった #1 第1話 ¶\d+「【\d+】海が見れる」$/.test(l))).toHaveLength(49)
    expect(r.text).not.toContain('実行の記録（確認した話・追加した案）を残しました')
    expect(r.text).toContain(
      '補足: 残りの 49件と実行の記録（確認した話・追加した案）は書けませんでした。理由: 一時的に Novel Studio のクラウドに接続できません。少し待ってから、もう一度試してください。同じ呼び出しをもう一度送ると、残りだけ追加します（書けた分は重複として飛ばします）。',
    )
    expect(r.text).toContain('アプリのタイトルの「戦略 → 推敲案」に、各端末が同期すると出ます。')
    const st = r.structured as { created: unknown[]; skipped: { reason: string }[] }
    expect(st.created).toHaveLength(51)
    expect(st.skipped.filter((s) => s.reason === 'not_written')).toHaveLength(49)
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(51)
    expect(docsOf(fake, 'proofBatches')).toHaveLength(0)
    // 数えるのは書けた分だけ
    expect(writes(core) - before).toBe(51)
    // もう一度送る（確かめた話 covered が無くても、実行の記録も作る）
    const again = await core.callTool('novel_add_proofreading', input, { grant: b })
    expect(again.isError).toBeUndefined()
    expect(again.text.split('\n')[0]).toBe('推敲案を追加: 追加 49件・重複 51件')
    expect(again.text).toContain('- 実行の記録（確認した話・追加した案）を残しました')
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(100)
    expect(docsOf(fake, 'proofBatches')).toHaveLength(1)
    expect(writes(core) - before).toBe(101)
  })

  it('記録は 100件までの組に、同じくらいの数で分ける（最後の組が小さくならない。実行の記録だけの組を作らない）', () => {
    const sizes = (n: number) => groups(Array.from({ length: n }, (_, i) => i)).map((g) => g.length)
    expect(COMMIT_GROUP).toBe(100)
    expect(sizes(0)).toEqual([])
    expect(sizes(1)).toEqual([1])
    expect(sizes(100)).toEqual([100])
    expect(sizes(101)).toEqual([51, 50])
    expect(sizes(201)).toEqual([67, 67, 67])
    expect(groups([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8], [9, 10]])
  })

  it('書けなかった書き込み（Firebase の無料枠・書き込みの停止で断られた）は数えず、試し直しで書けた記録は1回だけ数える', async () => {
    const n = novel(['本文。'])
    const { core, fake, clock, a, b } = await accounts(n.data)
    const before = writes(core)
    fake.failNextCommit = { status: 429, code: 'RESOURCE_EXHAUSTED' }
    const quota = await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: a })
    expect(quota.text).toContain('Firebase の今日の無料枠を使い切りました')
    expect(writes(core) - before).toBe(0)
    // アプリでオフにした（前に読んだ内容はオン。クラウドが断る）
    fake.setWrites(false)
    const off = await core.callTool('novel_add_bench_analysis', benchAdd('作品A'), { grant: b })
    expect(off.text).toContain('書き込みは停止中です')
    expect(writes(core) - before).toBe(0)
    fake.setWrites(true)
    clock.now += 6_000
    // 同じ時に同じ記録が作られた（409）: 読み直して書き直す。数えるのは書けた1回だけ
    fake.failNextCommit = { status: 409, code: 'ALREADY_EXISTS' }
    const r = await core.callTool('novel_add_strategy_note', { title_id: n.titleId, heading: '公募', body: '本文' }, { grant: a })
    expect(r.text).toContain('追加 1件')
    expect(writes(core) - before).toBe(1)
  })
})
