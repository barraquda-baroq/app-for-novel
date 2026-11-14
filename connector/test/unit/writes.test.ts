// 書き込みの守り（2.9 の複数の接続で、ほかの接続と同じ時に書く）: 取り込みの途中で書かない・「書き込みを許可」をオンに戻したら
// すぐ書ける・順番を待つ間に外された接続は書かない・記録を分けて書いた時に後の組が書けなかったら、書けた分を答えて、数えるのは
// 書けた分だけ。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../../../src/domain/benchOps'
import { addMaterial } from '../../../src/domain/materialOps'
import type { AppData } from '../../../src/domain/types'
import { novel } from '../../../src/test/claudeFixture'
import { TOOL_DEFS } from '../../src/mcp/tools'
import { MESSAGES } from '../../src/vault/errors'
import type { QuotaCounts } from '../../src/vault/quota'
import { CONNECTOR_MODEL } from '../../src/version'
import { COMMIT_GROUP, groups } from '../../src/vault/writer'
import { FakeFirebase } from '../support/fakeFirebase'
import { commit, errorResponse, gatedFetch, settle, within } from '../support/gate'
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
    // 後の組は 5xx が続いた（クラウドが書いたか分からない）ので、数えたまま（少なく数えない）
    expect(writes(core) - before).toBe(101)
    // もう一度送る（確かめた話 covered が無くても、実行の記録も作る）
    const again = await core.callTool('novel_add_proofreading', input, { grant: b })
    expect(again.isError).toBeUndefined()
    expect(again.text.split('\n')[0]).toBe('推敲案を追加: 追加 49件・重複 51件')
    expect(again.text).toContain('- 実行の記録（確認した話・追加した案）を残しました')
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(100)
    expect(docsOf(fake, 'proofBatches')).toHaveLength(1)
    expect(writes(core) - before).toBe(151)
  })

  it('後の組が初めの試しで断られた（Firebase の無料枠 429。何も書いていない）時は、その組を数えない', async () => {
    const { n, input } = hundred()
    const { core, fake, gate, b } = await accounts(n.data)
    const before = writes(core)
    gate.failNext(commit, 1, () => errorResponse(429, 'RESOURCE_EXHAUSTED'), { skip: 1 })
    const r = await core.callTool('novel_add_proofreading', input, { grant: b })
    expect(r.text.split('\n')[0]).toBe('推敲案を追加: 追加 51件・書けなかった 49件')
    expect(r.text).toContain('理由: Firebase の今日の無料枠を使い切りました')
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(51)
    expect(writes(core) - before).toBe(51)
  })

  /** commit の1回の試しの答え方（send はクラウド（小さな Firebase）に送って書く） */
  type CommitTry = (send: () => Promise<Response>) => Promise<Response>
  /** 書けたのに答えが 503（届かない） */
  const lost: CommitTry = async (send) => {
    const res = await send()
    return res.ok ? errorResponse(503, 'UNAVAILABLE') : res
  }
  /** 書かずに断る */
  const refuse =
    (status: number, code: string): CommitTry =>
    async () =>
      errorResponse(status, code)

  /** commit の試しを、決めた順に答える fetch（plan(...) で足す。決めた分の後は、ふつうにクラウドが答える） */
  async function scriptedCommits(data: AppData) {
    const fake = new FakeFirebase()
    const tries: CommitTry[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const send = () => (fake.fetch as typeof globalThis.fetch)(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const next = url.endsWith(':commit') ? tries.shift() : undefined
      return next ? next(send) : send()
    }) as typeof globalThis.fetch
    const made = await pairedCore(fake, data, { cid: 'caaa', fetch })
    const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', pairedAt: made.clock.now })
    return { fake, ...made, b, plan: (...t: CommitTry[]) => tries.push(...t) }
  }

  /** 推敲案10件（実行の記録と1つの組で 11件） */
  const ten = (s: ReturnType<typeof hundred>) => ({ ...s.input, items: s.input.items.slice(0, 10) })

  it('書けたのに答えが届かなかった組（5xx の試し直しが「もうある」）は、この呼び出しで書けた分として「追加」と答え、数えたまま', async () => {
    const { n, input } = hundred()
    const { core, fake, b, plan } = await scriptedCommits(n.data)
    const before = writes(core)
    // 1つ目の組（51件）は書けたが答えが 503。FirestoreRest が試し直すと「もうある」（409）
    plan(lost)
    const r = await core.callTool('novel_add_proofreading', input, { grant: b })
    expect(r.isError).toBeUndefined()
    // 前は「追加 49件・重複 51件」で、数えたのは 50（書いたのは 101）
    expect(r.text.split('\n')[0]).toBe('推敲案を追加: 追加 100件')
    expect(r.text.split('\n').filter((l) => /^- 追加 x:\S+ #1 第1話 ¶\d+「【\d+】海が見れる」$/.test(l))).toHaveLength(100)
    expect(r.text).toContain('- 実行の記録（確認した話・追加した案）を残しました')
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(100)
    expect(docsOf(fake, 'proofBatches')).toHaveLength(1)
    expect(writes(core) - before).toBe(101)
    // 1つの組（推敲案10件と実行の記録）でも同じ
    const small = hundred()
    const one = await scriptedCommits(small.n.data)
    const start = writes(one.core)
    one.plan(lost)
    const r2 = await one.core.callTool('novel_add_proofreading', ten(small), { grant: one.b })
    expect(r2.text.split('\n')[0]).toBe('推敲案を追加: 追加 10件')
    expect(docsOf(one.fake, 'proofSuggestions')).toHaveLength(10)
    expect(writes(one.core) - start).toBe(11)
    // 初めの試しの「もうある」（何も書いていない）は今までどおり数えない: 上の L3-8 のテスト
  })

  it('書けたのに答えが届かず、試し直しで「重複」から「追加」にした分析にも、字数の行と chars を出す（送った本文から数える）', async () => {
    const n = novel(['本文。'])
    const { core, b, plan } = await scriptedCommits(n.data)
    plan(lost)
    const r = await core.callTool(
      'novel_add_bench_analysis',
      {
        work: '作品A',
        new_work: { name: '作品A', author: '高橋' },
        items: [
          { viewpoint: '文体', body_markdown: '## 文体\n\n| 観点 | 評価 |\n| --- | --- |\n| 文 | 短い |', run_date: '2026-10-30' },
          { viewpoint: '人物', body_markdown: '　主人公は｜漢字《かんじ》を読む。', run_date: '2026-10-30' },
        ],
      },
      { grant: b },
    )
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('相対比較に分析を追加: 追加 2件')
    expect(lines[1]).toMatch(/^- 追加 n:\S+ 『作品A』の「文体」$/)
    // ##文体 4・|観点|評価| 7・|---|---| 9・|文|短い| 6
    expect(lines[2]).toBe('    字数: 26字（空白・改行を除く。アプリと同じ数え方）')
    expect(lines[3]).toMatch(/^- 追加 n:\S+ 『作品A』の「人物」$/)
    expect(lines[4]).toBe('    字数: 10字（空白・改行を除く。アプリと同じ数え方）')
    expect((r.structured as { created: { chars?: number }[] }).created.map((c) => c.chars)).toEqual([26, 10])
  })

  it('5xx が3回続き、最後の試しだけ書けていた（504 で待ち切ったなど）組は、書けたか分からないので数えたまま。もう一度送ると重複になり、数は増えない', async () => {
    const s = hundred()
    const { core, fake, b, plan } = await scriptedCommits(s.n.data)
    const start = writes(core)
    plan(refuse(503, 'UNAVAILABLE'), refuse(503, 'UNAVAILABLE'), lost)
    const r = await core.callTool('novel_add_proofreading', ten(s), { grant: b })
    expect(r.isError).toBe(true)
    expect(r.text).toBe(MESSAGES.unavailable)
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(10)
    expect(docsOf(fake, 'proofBatches')).toHaveLength(1)
    // 前は 0（書けなかったとして戻していた）
    expect(writes(core) - start).toBe(11)
    const again = await core.callTool('novel_add_proofreading', ten(s), { grant: b })
    expect(again.text.split('\n')[0]).toBe('推敲案を追加: 重複 10件')
    expect(writes(core) - start).toBe(11)
  })

  it('書けたのに答えが 503 で、試し直しが Firebase の無料枠（429）で断られた組も数えたまま', async () => {
    const s = hundred()
    const { core, fake, b, plan } = await scriptedCommits(s.n.data)
    const start = writes(core)
    plan(lost, refuse(429, 'RESOURCE_EXHAUSTED'))
    const r = await core.callTool('novel_add_proofreading', ten(s), { grant: b })
    expect(r.text).toContain('Firebase の今日の無料枠を使い切りました')
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(10)
    // 前は 0
    expect(writes(core) - start).toBe(11)
  })

  it('書けたのに答えが 503 で、その間に作者が「書き込みを許可」をオフにした（試し直しは 403）組は、停止中と答え、数えたまま', async () => {
    const s = hundred()
    const { core, fake, b, plan } = await scriptedCommits(s.n.data)
    const start = writes(core)
    plan(lost, async () => {
      fake.setWrites(false)
      return errorResponse(403, 'PERMISSION_DENIED')
    })
    const r = await core.callTool('novel_add_proofreading', ten(s), { grant: b })
    expect(r.text).toContain('書き込みは停止中です')
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(10)
    // 前は 0
    expect(writes(core) - start).toBe(11)
  })

  it('答えが来ない（待ち切った）commit の組は、クラウドに届いたか分からないので数えたまま（送っていない後の組だけ戻す）。もう一度送ると残りだけ足す', async () => {
    const { n, input } = hundred()
    const { core, fake, gate, b } = await accounts(n.data, { timeoutMs: 100 })
    const before = writes(core)
    // 1つ目の組（51件）はクラウドに届いたが、答えが来ない
    const hang = gate.hold(commit)
    const r = await within(core.callTool('novel_add_proofreading', input, { grant: b }), 3_000, '答えの来ない commit')
    expect(r.isError).toBe(true)
    expect(r.text).toBe(MESSAGES.unavailable)
    expect(docsOf(fake, 'proofSuggestions')).toHaveLength(51)
    // 前は 0（書けなかったとして戻していた）
    expect(writes(core) - before).toBe(51)
    hang.release()
    const again = await core.callTool('novel_add_proofreading', input, { grant: b })
    expect(again.text.split('\n')[0]).toBe('推敲案を追加: 追加 49件・重複 51件')
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

describe('追加の答えの字数（2.9。アプリと同じ数え方: 空白・改行・ルビの記法と読みを除く）', () => {
  const line = (n: string) => `    字数: ${n}字（空白・改行を除く。アプリと同じ数え方）`
  /** 空白・改行込みでは 66字、アプリの数え方では 39字（##文体 4・|観点|評価| 7・|---|---| 9・|文の長さ|短い| 9・主人公は漢字を読む。 10） */
  const TABLE = '## 文体\n\n| 観点 | 評価 |\n| --- | --- |\n| 文の長さ | 短い |\n\n　主人公は｜漢字《かんじ》を読む。\n'
  /** 3,019字（空白・改行込み）→ 2,980字: 149字の行が20行、各行の頭に全角の空白 */
  const LONG = Array.from({ length: 20 }, () => `　${'あ'.repeat(149)}`).join('\n')
  const created = (r: { structured?: unknown }) => (r.structured as { created: { id: string; chars?: number }[] }).created

  it('相対比較の分析・資料の記録: 「- 追加」の行（そのまま）の下に、記録ごとの字数の行。分けた部はそれぞれ。重複には出さない', async () => {
    expect(TABLE.length).toBe(66)
    expect(LONG.length).toBe(3_019)
    const n = novel(['本文。'])
    const data = addMaterial(addBenchWork(n.data, { name: '銀河の果て', author: '山田' }).data, { name: '外科の歴史', author: '高橋' }).data
    const { core } = await pairedCore(new FakeFirebase(), data)
    const input = {
      work: '銀河の果て',
      items: [
        { viewpoint: '文体', body_markdown: TABLE, run_date: '2026-10-30' },
        { viewpoint: '16 現実の成果データ', body_markdown: `（1/2）\n${LONG}`, run_date: '2026-10-30' },
        { viewpoint: '16 現実の成果データ', body_markdown: '（2/2）\n続き。', run_date: '2026-10-30' },
      ],
    }
    const r = await core.callTool('novel_add_bench_analysis', input)
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('相対比較に分析を追加: 追加 3件')
    expect(lines.slice(1, 7).map((l) => l.replace(/^- 追加 n:[0-9a-z]{8} /, '- 追加 n:… '))).toEqual([
      '- 追加 n:… 『銀河の果て』の「文体」',
      line('39'),
      '- 追加 n:… 『銀河の果て』の「16 現実の成果データ」',
      line('2,985'),
      '- 追加 n:… 『銀河の果て』の「16 現実の成果データ」',
      line('8'),
    ])
    expect(lines[7]).toMatch(/^補足: 相対比較の作品 w:[0-9a-z]{8}『銀河の果て』（山田） に追加しました$/)
    expect(created(r).map((c) => c.chars)).toEqual([39, 2_985, 8])
    // 同じ内容をもう一度: 重複の行には字数を出さない
    const dup = await core.callTool('novel_add_bench_analysis', input)
    expect(dup.text).not.toContain('字数:')
    expect(created(dup)).toEqual([])

    const k = await core.callTool('novel_add_material_notes', {
      material: '外科の歴史',
      items: [{ section: '要約', body_markdown: LONG, run_date: '2026-10-31' }],
    })
    const kl = k.text.split('\n')
    expect(kl[1]).toMatch(/^- 追加 k:[0-9a-z]{8} 『外科の歴史』の「要約」$/)
    expect(kl[2]).toBe(line('2,980'))
    expect(created(k)[0].chars).toBe(2_980)
  })

  it('批評の結果（Markdown だけ数える。URL だけなら出さない）・戦略メモ・改稿案（見出しは数えない）。推敲案には出さない', async () => {
    const n = novel(['海が見れる。'])
    const { core } = await pairedCore(new FakeFirebase(), n.data)
    const t = n.titleId
    const result = await core.callTool('novel_add_critique_result', {
      title_id: t,
      prompt_text: '長いプロンプトの控え　'.repeat(20),
      result_markdown: TABLE,
      run_date: '2026-10-30',
    })
    expect(result.text.split('\n').slice(1, 3)).toEqual([expect.stringMatching(/^- 追加 a:[0-9a-z]{8} 作品批評の結果$/), line('39')])
    expect(created(result)[0].chars).toBe(39)
    const url = await core.callTool('novel_add_critique_result', { title_id: t, artifact_url: 'https://claude.ai/x', run_date: '2026-10-30' })
    expect(url.text.split('\n')[1]).toMatch(/^- 追加 a:/)
    expect(url.text).not.toContain('字数:')
    expect(created(url)[0]).not.toHaveProperty('chars')

    const note = await core.callTool('novel_add_strategy_note', { title_id: t, heading: '応募戦略（とても長い見出し）', body: LONG })
    expect(note.text.split('\n').slice(1, 3)).toEqual([expect.stringMatching(/^- 追加 g:[0-9a-z]{8} 「応募戦略/), line('2,980')])
    expect(created(note)[0].chars).toBe(2_980)

    const ideas = await core.callTool('novel_add_revision_ideas', {
      title_id: t,
      items: [
        { heading: '冒頭', body: TABLE },
        { heading: '結末', body: '余韻を　残す。\n' },
      ],
    })
    expect(ideas.text.split('\n').slice(1, 5)).toEqual([
      expect.stringMatching(/^- 追加 r:[0-9a-z]{8} 「冒頭」$/),
      line('39'),
      expect.stringMatching(/^- 追加 r:[0-9a-z]{8} 「結末」$/),
      line('6'),
    ])
    expect(created(ideas).map((c) => c.chars)).toEqual([39, 6])

    const proof = await core.callTool('novel_add_proofreading', {
      title_id: t,
      items: [{ piece: '#1', excerpt: '海が見れる', category: 'ra_nuki', suggestion: '海が見られる', reason: 'ら抜き言葉' }],
    })
    expect(proof.text).toContain('追加 1件')
    expect(proof.text).not.toContain('字数:')
    expect(created(proof)[0]).not.toHaveProperty('chars')
  })

  it('相対比較の一覧の「  分析 n件（n字）」は V30 のまま空白・改行・ルビの記法も数える（同じ分析で「字数: 39字」と 66字）。一覧のツールの説明がその違いを言う', async () => {
    const n = novel(['本文。'])
    const data = addMaterial(addBenchWork(n.data, { name: '銀河の果て', author: '山田' }).data, { name: '外科の歴史', author: '高橋' }).data
    const { core } = await pairedCore(new FakeFirebase(), data)
    const add = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '文体', body_markdown: TABLE, run_date: '2026-10-30' }],
    })
    expect(add.text.split('\n')[2]).toBe(line('39'))
    expect(created(add)[0].chars).toBe(39)
    // 一覧の行は 2.7 のまま（V30 が読むので1字も変えない）: 空白・改行・ルビの記法と読みも数えた 66字
    const list = await core.callTool('novel_list_bench_works', {})
    expect(list.text).toContain('\n  分析 1件（66字）: 文体 1件（最新 2026-10-30）')
    // ほかの一覧（資料の「  記録 n件（n字）」）はアプリの数え方
    await core.callTool('novel_add_material_notes', { material: '外科の歴史', items: [{ section: '要約', body_markdown: TABLE, run_date: '2026-10-31' }] })
    expect((await core.callTool('novel_list_materials', {})).text).toContain('\n  記録 1件（39字）')
    // Claude が 66字をアプリの字数と取り違えないよう、一覧のツールの説明に数え方の違いと、上限は「字数:」で確かめることを書く
    const desc = TOOL_DEFS.find((t) => t.name === 'novel_list_bench_works')!.description
    expect(desc).toContain(
      '分析の数（後ろの（n字）は、ほかの一覧と違って空白・改行・ルビの記法と読みも数えた本文の長さの合計なので、アプリの作品の画面の「合計 n字」や追加の答えの「字数:」より大きい。プロンプトの「n字以内」は追加の答えの「字数:」で確かめる）と観点ごとの数・最新の日付',
    )
  })
})
