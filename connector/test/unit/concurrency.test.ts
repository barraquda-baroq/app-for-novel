// 同時の呼び出し（2.9 の複数の接続）: 写しの取り込みは同時に1つだけ（ほかの呼び出しは待って相乗りする）、遅れて届いた古いページで
// 写しを戻さない、取り込みの途中の写しを読まない、書き込みの順番（#mutex）と取り込みが待ち合って止まらない。
// fetch は小さな Firebase の答えを送った時に作り、届けるのを止めておける（gate.ts。Durable Object は答えを待つ間にほかの呼び出しも進める）。
import { describe, expect, it } from 'vitest'
import { addBenchWork } from '../../../src/domain/benchOps'
import type { AppData, ID, Version } from '../../../src/domain/types'
import { novel } from '../../../src/test/claudeFixture'
import type { GrantProps } from '../../src/vault/core'
import type { QuotaCounts } from '../../src/vault/quota'
import { FakeFirebase } from '../support/fakeFirebase'
import { errorResponse, gatedFetch, settle, syncPage, within } from '../support/gate'
import { OWNER, addConnection, makeCore, pairedCore } from '../support/harness'

/** 2つ（以上）の接続で連携した Vault（A = caaa、B = cbbb、C = cccc） */
async function accounts(data: AppData | null, opts: Parameters<typeof pairedCore>[2] = {}) {
  const fake = new FakeFirebase()
  const gate = gatedFetch(fake)
  const made = await pairedCore(fake, data, { cid: 'caaa', fetch: gate.fetch, ...opts })
  const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', pairedAt: made.clock.now })
  const c = await addConnection(fake, made.core, made.uid, { cid: 'cccc', pairedAt: made.clock.now })
  return { fake, gate, ...made, a: made.grant, b, c }
}

/** 話の採用稿 */
function versionOf(data: AppData, pieceId: ID): Version {
  return data.versions[data.pieces[pieceId].activeVersionId!]
}

/** 端末が稿の本文を保存した（同じ稿の記録を書き直す） */
function saveBody(fake: FakeFirebase, v: Version, body: string, opts: { chunkSize?: number } = {}): void {
  fake.putRecord(OWNER, 'versions', { ...v, body, updatedAt: v.updatedAt + body.length } as never, opts)
}

/** 知らない表の記録（写しは保存するだけ。ページを埋める） */
function fillers(fake: FakeFirebase, n: number, prefix: string): void {
  fake.putMany(
    OWNER,
    Array.from({ length: n }, (_, i) => ({ table: 'zzFiller', rec: { id: `${prefix}${String(i).padStart(4, '0')}` } as never })),
  )
}

const docsOf = (fake: FakeFirebase, table: string) => fake.recordDocs(OWNER).filter((d) => d.name.includes(`/${table}:`))

const reads = (core: { store: { getMeta: <T>(k: string) => T | null } }) => core.store.getMeta<QuotaCounts>('quota')?.reads ?? 0

const read = (core: Awaited<ReturnType<typeof accounts>>['core'], grant: GrantProps, name: string, args: Record<string, unknown> = {}) =>
  core.callTool(name, args, { grant })

const benchAdd = (work: string) => ({
  work,
  new_work: { name: work, author: '高橋' },
  items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い文。', run_date: '2026-10-30' }],
})

describe('写しの取り込みは同時に1つだけ（L2-1・L5-1・L2-6・L2-9・L3-2・L5-6）', () => {
  it('U2: A の書き込みの取り込みの答えを待つ間、B の読み取りは自分では問い合わせず待つ。遅れて届いた答えで写しを戻さない', async () => {
    const V1 = '一つ目の本文。短い。'
    const V2 = '二つ目の本文。こちらがいまの原稿で、前よりかなり長くなっている。'
    const n = novel(['最初の本文。'])
    const { core, fake, gate, clock, sql, a, b } = await accounts(n.data)
    const v = versionOf(n.data, n.ids[0])
    clock.now += 20_000
    saveBody(fake, v, V1)
    // A の書き込みの取り込み（V1 を読んだ答え）を止める
    const holdA = gate.hold(syncPage)
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: a })
    await holdA.sent
    // その間に端末が V2 を保存し、ほかの記録も 60 件届いた（B が自分で取り込むなら2ページ。2ページ目を止める）
    saveBody(fake, v, V2)
    fillers(fake, 60, 'f')
    const pages = gate.count(syncPage)
    const holdB2 = gate.hold(syncPage, { skip: 1 })
    const pB = read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: '#1' })
    await settle()
    // B は自分では問い合わせない（A の取り込みを待つ）
    expect(gate.count(syncPage) - pages).toBe(0)
    holdA.release()
    await settle()
    holdB2.release()
    const [ra, rb] = await Promise.all([pA, pB])
    expect(ra.text).toContain('追加 1件')
    // B は A の取り込みの結果（V1 の時点。読むのは 15 秒まで遅れてよい）を読んだ
    expect(rb.isError).toBeUndefined()
    // 次の取り込みからは V2（遅れて届いた V1 の答えで、写しも取り込んだ位置も戻っていない）
    clock.now += 16_000
    const later = await read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: '#1' })
    expect(later.text).toContain(V2)
    expect(later.text).toContain(`第1稿・${[...V2].length}字`)
    expect(await core.nightly()).toBe('ok')
    expect((await read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: '#1' })).text).toContain(V2)
    // 作り直した Vault（同じ SQLite）でも V2 と V2 の字数
    const cold = makeCore(fake, { sql, clock, fetch: gate.fetch })
    const coldText = (await cold.core.callTool('novel_read_text', { title_id: n.titleId, from: '#1', to: '#1' })).text
    expect(coldText).toContain(V2)
    expect(coldText).toContain(`第1稿・${[...V2].length}字`)
  })

  it('写しの守り: 重なった取り込みで遅れて届いた古いページは、新しい記録（分割文書も）を戻さず、取り込んだ位置も戻さない', async () => {
    // VaultCore を通さずに、写しの取り込みを2つ重ねる（VaultCore は重ねないが、写しの側でも守る）
    const n = novel(['最初の本文。', '二話目の本文。'])
    const fake = new FakeFirebase()
    const gate = gatedFetch(fake)
    const { core, clock, sql } = await pairedCore(fake, n.data, { fetch: gate.fetch })
    const v = versionOf(n.data, n.ids[0])
    const big = versionOf(n.data, n.ids[1])
    const V1 = 'あ'.repeat(30)
    const V2 = 'い'.repeat(30)
    const opts = { maxPages: 8, workBudget: 300_000, takeReads: () => true }
    saveBody(fake, v, V1)
    saveBody(fake, big, `古${'う'.repeat(59)}`, { chunkSize: 20 })
    const hold = gate.hold(syncPage)
    const first = core.mirror.sync(opts)
    await hold.sent
    saveBody(fake, v, V2)
    saveBody(fake, big, `新${'え'.repeat(59)}`, { chunkSize: 20 })
    expect((await core.mirror.sync(opts)).done).toBe(true)
    const cursor = core.mirror.cursor()
    hold.release()
    await first
    expect(core.mirror.cursor()).toEqual(cursor)
    expect(core.mirror.data().versions[v.id].body).toBe(V2)
    expect(core.mirror.data().versions[big.id].body).toBe(`新${'え'.repeat(59)}`)
    // 作り直した Vault（同じ SQLite）: 本文も、取り込んだ時に数えた字数も V2
    const cold = makeCore(fake, { sql, clock, fetch: gate.fetch })
    const text = (await cold.core.callTool('novel_read_text', { title_id: n.titleId, from: '#1', to: '#2' })).text
    expect(text).toContain(V2)
    expect(text).toContain(`第1稿・30字`)
    expect(text).toContain(`新${'え'.repeat(59)}`)
    expect(cold.core.mirror.unreadableCount()).toBe(0)
  })

  it('写しの守り: 取り込みの途中で写しを消した（夜の確かめで数が合わない）時は、その取り込みの続きを捨てる（消した後に位置・取り込み済みの印を書かない）', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, clock, b } = await accounts(n.data)
    clock.now += 20_000
    fillers(fake, 3, 'r')
    const hold = gate.hold(syncPage)
    const pB = read(core, b, 'novel_list_titles')
    await hold.sent
    core.mirror.reset()
    hold.release()
    const r = await pB
    // 写しは取り込み直し（読むツールは「初回の取り込み中」）。消した後の写しに、前の位置・取り込み済みの印は無い
    expect(r.isError).toBe(true)
    expect(r.text).toContain('初回の取り込み中')
    expect(core.mirror.cursor()).toBeNull()
    expect(core.mirror.warm().done).toBe(false)
    for (let i = 0; i < 20 && (await core.alarm()) !== null; i++);
    expect(core.mirror.warm().done).toBe(true)
    expect(await core.nightly()).toBe('ok')
    expect((await read(core, b, 'novel_list_titles')).text).toContain('『星の庭』')
  })

  it('L2-6: A の書き込みの取り込みがページの間にいる時、B の読み取り（15秒以内で取り込まない）は終わるのを待つ（端末の1回の変更の一部だけを見せない）', async () => {
    const count = 60
    const n = novel(Array.from({ length: count }, (_, i) => `第${i + 1}話の古い本文。`))
    const { core, fake, gate, clock, a, b } = await accounts(n.data)
    clock.now += 20_000
    expect((await read(core, b, 'novel_list_titles')).isError).toBeUndefined()
    clock.now += 3_000
    // 端末が 60 話の本文を1回の書き込みで送った（2ページ）。A の書き込みの取り込みの2ページ目を止める
    fake.putMany(
      OWNER,
      n.ids.map((id, i) => ({ table: 'versions', rec: { ...versionOf(n.data, id), body: `第${i + 1}話の新しい本文。` } as never })),
    )
    const hold = gate.hold(syncPage, { skip: 1 })
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: a })
    await hold.sent
    const pB = read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: `#${count}` })
    await settle()
    hold.release()
    const [ra, rb] = await Promise.all([pA, pB])
    expect(ra.text).toContain('追加 1件')
    expect(rb.text.match(/古い本文/g) ?? []).toHaveLength(0)
    expect(rb.text.match(/新しい本文/g) ?? []).toHaveLength(count)
  })

  /** 端末が n 話の本文を1回の書き込みで送った（同じ時刻の1つの変更） */
  const pushAll = (fake: FakeFirebase, n: ReturnType<typeof novel>, word: string) =>
    fake.putMany(
      OWNER,
      n.ids.map((id, i) => ({ table: 'versions', rec: { ...versionOf(n.data, id), body: `第${i + 1}話の${word}本文。` } as never })),
    )
  const PARTIAL = '（端末からの変更が多いため、取り込みの途中の内容です）'
  /** 読んだ本文が、端末の1回の変更の途中まで（古い本文と新しい本文が混ざる）を知らせなしに見せていないこと */
  const notTorn = (text: string, old: RegExp, neu: RegExp) => {
    const o = (text.match(old) ?? []).length
    const n = (text.match(neu) ?? []).length
    expect(o + n).toBeGreaterThan(100)
    if (o && n) expect(text).toContain(PARTIAL)
  }

  it('L2-6: 書き込みが取り込みの途中で断った（catching_up）後は、最後まで読んでから15秒以内でも、読むツールは1歩進めて途中なら知らせる', async () => {
    const count = 300
    const n = novel(Array.from({ length: count }, (_, i) => `第${i + 1}話の古い本文。`))
    // 1歩は 1,000 字ほどで止める（1ページ）。書き込みの前の5歩で 250 件しか読めない
    const { core, fake, gate, clock, a, b } = await accounts(n.data, { config: { workBudgetChars: 1_000 } })
    expect((await read(core, b, 'novel_list_titles')).isError).toBeUndefined()
    clock.now += 2_000
    pushAll(fake, n, '新しい')
    const w = await core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: a })
    expect(w.isError).toBe(true)
    expect(w.text).toMatch(/^端末からの変更を取り込んでいる途中です（この呼び出しで 250件を取り込みました）。/)
    // 前は、15秒以内なので取り込まずに、250 話だけ新しい写しを知らせなしに読ませていた
    clock.now += 1_000
    const pages = gate.count(syncPage)
    const r = await read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: `#${count}` })
    expect(r.isError).toBeUndefined()
    expect(gate.count(syncPage) - pages).toBe(1)
    expect(r.text.split('\n')[0]).toBe(PARTIAL)
    notTorn(r.text, /古い本文/g, /新しい本文/g)
    // 取り込み終えた後は、知らせなしで新しい本文だけ。その後の15秒は取り込まずに読む
    for (let i = 0; i < 20 && (await core.alarm()) !== null; i++);
    const after = gate.count(syncPage)
    const done = await read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: '#40' })
    expect(gate.count(syncPage) - after).toBe(0)
    expect(done.text).not.toContain('取り込みの途中')
    expect(done.text).not.toContain('古い本文')
    expect(done.text.match(/新しい本文/g) ?? []).toHaveLength(40)
  })

  it('L2-6: alarm の1歩が途中で終わった後（次の alarm まで1秒あく）も、読むツールは途中の写しを知らせなしに見せない', async () => {
    const count = 300
    const n = novel(Array.from({ length: count }, (_, i) => `第${i + 1}話の古い本文。`))
    const { core, fake, clock, a, b } = await accounts(n.data, { config: { workBudgetChars: 1_000 } })
    expect((await read(core, b, 'novel_list_titles')).isError).toBeUndefined()
    clock.now += 2_000
    pushAll(fake, n, '新しい')
    expect(await core.alarm()).not.toBeNull()
    clock.now += 500
    const r = await read(core, a, 'novel_read_text', { title_id: n.titleId, from: '#1', to: `#${count}` })
    expect(r.isError).toBeUndefined()
    expect(r.text.split('\n')[0]).toBe(PARTIAL)
    notTorn(r.text, /古い本文/g, /新しい本文/g)
  })

  it('L2-6: 取り込みの1歩がページの途中で失敗した（1ページ目を入れた後）後も、15秒以内の読むツールは途中の写しを知らせなしに見せない', async () => {
    const count = 60
    const n = novel(Array.from({ length: count }, (_, i) => `第${i + 1}話の古い本文。`))
    const { core, fake, gate, clock, a, b } = await accounts(n.data)
    clock.now += 20_000
    expect((await read(core, b, 'novel_list_titles')).isError).toBeUndefined()
    clock.now += 3_000
    pushAll(fake, n, '新しい')
    // A の書き込みの取り込みの2ページ目が 503（2回の試し直しも）。1ページ目（50話）は入った
    gate.failNext(syncPage, 3, () => errorResponse(503, 'UNAVAILABLE'), { skip: 1 })
    const w = await core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: a })
    expect(w.isError).toBe(true)
    expect(w.text).toContain('一時的に Novel Studio のクラウドに接続できません')
    clock.now += 1_000
    const r = await read(core, b, 'novel_read_text', { title_id: n.titleId, from: '#1', to: `#${count}` })
    expect(r.isError).toBeUndefined()
    // 前は、取り込まずに 50 話だけ新しい本文を知らせなしに出していた。いまは残りを取り込んでから読む
    expect(r.text.match(/古い本文/g) ?? []).toHaveLength(0)
    expect(r.text.match(/新しい本文/g) ?? []).toHaveLength(count)
    expect(r.text).not.toContain('取り込みの途中')
    // 取り込み終えた後の15秒は、また取り込まずに読む
    const pages = gate.count(syncPage)
    clock.now += 1_000
    expect((await read(core, b, 'novel_list_titles')).isError).toBeUndefined()
    expect(gate.count(syncPage) - pages).toBe(0)
  })

  it('L3-2・L2-9: 端末が 200 件書いた後に3つの接続が同時に読むと、取り込むのは1回分（読み取りの数も1回分）', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, clock, a, b, c } = await accounts(n.data)
    for (let i = 0; i < 5; i++) fillers(fake, 40, `g${i}-`)
    clock.now += 20_000
    const before = reads(core)
    const pages = gate.count(syncPage)
    const rs = await Promise.all([a, b, c].map((g) => read(core, g, 'novel_list_titles')))
    for (const r of rs) {
      expect(r.isError).toBeUndefined()
      expect(r.text).not.toContain('取り込みの途中')
    }
    // 50件ずつ4ページと、残りが無いことを確かめる1ページ（読み取りは 4 × (50 + 2) + (1 + 2) = 211）
    expect(gate.count(syncPage) - pages).toBe(5)
    expect(reads(core) - before).toBe(211)
  })

  it('取り込みが失敗したら、相乗りしたすべての呼び出しに届き、取り込みの順番は空く（次の呼び出しは自分で取り込む）', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, clock, a, b, c } = await accounts(n.data)
    clock.now += 20_000
    fillers(fake, 3, 'h')
    const hold = gate.hold(syncPage, { respond: () => errorResponse(429, 'RESOURCE_EXHAUSTED') })
    const pages = gate.count(syncPage)
    const p1 = read(core, a, 'novel_list_titles')
    await hold.sent
    const p2 = read(core, b, 'novel_list_titles')
    const p3 = read(core, c, 'novel_get_outline', { title_id: n.titleId })
    const pAlarm = core.alarm()
    // 書き込みは、先に始まった取り込みに相乗りせず、終わるのを待つ（その取り込みが失敗したら、同じ失敗を受け取る）
    const pW = core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: b })
    await settle()
    expect(gate.count(syncPage) - pages).toBe(1)
    hold.release()
    const [r1, r2, r3, next, w] = await within(Promise.all([p1, p2, p3, pAlarm, pW]), 2_000, '相乗りした呼び出し')
    for (const r of [r1, r2, r3]) {
      expect(r.isError).toBeUndefined()
      expect(r.text).toContain('Firebase の今日の無料枠を使い切ったため、前に取り込んだ内容です')
    }
    // 続き（alarm）は枠が戻る時刻の後に
    expect(next! - clock.now).toBeGreaterThan(60 * 60_000)
    expect(w.isError).toBe(true)
    expect(w.text).toContain('Firebase の今日の無料枠を使い切りました')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)
    // 順番は空いている: 次の読み取りは自分で取り込み、次の書き込みも書ける
    clock.now += 20_000
    const after = gate.count(syncPage)
    const r = await within(read(core, a, 'novel_list_titles'), 2_000, '次の読み取り')
    expect(r.text).not.toContain('前に取り込んだ内容')
    expect(gate.count(syncPage) - after).toBe(1)
    expect((await within(core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: b }), 2_000, '次の書き込み')).text).toContain(
      '追加 1件',
    )
  })
})

describe('書き込みの順番（#mutex）と取り込みは待ち合って止まらない', () => {
  it('A の書き込みが順番を持ったまま（書き込みの答えを待つ）でも、alarm・夜の確かめ・B の読み取りの取り込みは進む', async () => {
    const n = novel(['本文。'])
    const { core, fake, gate, clock, a, b } = await accounts(n.data)
    const hold = gate.hold((r) => r.op === 'commit')
    const pA = core.callTool('novel_add_bench_analysis', benchAdd('星を継ぐ'), { grant: a })
    await hold.sent
    clock.now += 20_000
    fillers(fake, 3, 'k')
    expect(await within(core.alarm(), 2_000, 'alarm')).toBeNull()
    expect(await within(core.nightly(), 2_000, '夜の確かめ')).toBe('ok')
    clock.now += 20_000
    fillers(fake, 3, 'm')
    const pages = gate.count(syncPage)
    const r = await within(read(core, b, 'novel_list_titles'), 2_000, 'B の読み取り')
    expect(r.isError).toBeUndefined()
    expect(gate.count(syncPage) - pages).toBe(1)
    hold.release()
    expect((await within(pA, 2_000, 'A の書き込み')).text).toContain('追加 1件')
  })

  it('先に始まった取り込み（alarm）の答えを待つ間に呼ばれた書き込みは、終わるのを待ってから自分で取り込む（その間の削除を見る）', async () => {
    const n = novel(['本文。'])
    const w = addBenchWork(n.data, { name: '作品Z', author: '山田' })
    const { core, fake, gate, clock, a } = await accounts(w.data)
    clock.now += 20_000
    fillers(fake, 2, 'p')
    const hold = gate.hold(syncPage)
    const pAlarm = core.alarm()
    await hold.sent
    // alarm の問い合わせの後に、作者が作品Z を削除した
    fake.tombstone(OWNER, 'benchWorks', w.result)
    const pages = gate.count(syncPage)
    const pW = core.callTool(
      'novel_add_bench_analysis',
      { work: '作品Z', items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い。', run_date: '2026-10-30' }] },
      { grant: a },
    )
    await settle()
    // alarm の取り込みが終わるまで、書き込みは問い合わせない（取り込みは同時に1つ）
    expect(gate.count(syncPage) - pages).toBe(0)
    hold.release()
    const [, rw] = await within(Promise.all([pAlarm, pW]), 2_000, 'alarm と書き込み')
    expect(gate.count(syncPage) - pages).toBe(1)
    expect(rw.isError).toBe(true)
    expect(rw.text).toContain('見つかりません')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)
  })
})
