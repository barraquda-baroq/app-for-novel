// Vault の中身（身元・連携・写し・ツール・書き込み）を、小さな Firebase（fetch の差し替え）で確かめる。
import { describe, expect, it } from 'vitest'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { hashJson } from '../../../src/domain/hash'
import { emptyData } from '../../../src/domain/types'
import { addSubmission, updateSubmission } from '../../../src/domain/entityOps'
import { addPrologue, novel, splitEpisode } from '../../../src/test/claudeFixture'
import { pairingHash } from '../../src/vault/crypto'
import { CONNECTOR_MODEL } from '../../src/version'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, SECRET, addConnection, call, makeCore, pairedCore } from '../support/harness'
import type { GrantProps } from '../../src/vault/core'

describe('コネクタの身元（匿名のアカウント）', () => {
  it('初めて要る時に作り、更新用トークンは暗号化して保存する', async () => {
    const fake = new FakeFirebase()
    const { core, sql } = makeCore(fake)
    const a = await core.connectIdentity()
    expect(a.uid).toMatch(/^anon/)
    expect(a.model).toBe(CONNECTOR_MODEL)
    expect((await core.connectIdentity()).uid).toBe(a.uid)
    const rows = sql.all<{ k: string; v: string }>('SELECT k, v FROM meta')
    const all = rows.map((r) => r.v).join('\n')
    expect(all).not.toContain('refresh-')
    expect(all).toContain('v1.')
  })

  it('匿名ログインが無効なら anonymous_disabled', async () => {
    const fake = new FakeFirebase({ anonymousDisabled: true })
    const { core } = makeCore(fake)
    await expect(core.connectIdentity()).rejects.toMatchObject({ code: 'anonymous_disabled' })
    expect(core.health()).toBe('anonymous_disabled')
  })

  it('鍵（TOKEN_ENC_KEY）が無ければ key_missing', async () => {
    const fake = new FakeFirebase()
    const { core } = makeCore(fake, { secret: '' })
    await expect(core.connectIdentity()).rejects.toMatchObject({ code: 'key_missing' })
  })

  it('鍵が変わると、身元を失った扱いになる（identity_lost → 401）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { sql, clock } = await pairedCore(fake, n.data)
    const other = makeCore(fake, { sql, clock, secret: 'another-secret-0123456789abcdef' })
    // ID トークンの期限を過ぎさせて、更新を必要にする
    clock.now += 2 * 3_600_000
    const r = await other.core.callTool('novel_list_titles', {})
    expect(r.auth).toBe(true)
    expect(other.core.pairingState()).toBe('unpaired')
    expect(other.core.identity.uid()).toBeNull()
  })
})

describe('連携の確かめ（/pair/callback）', () => {
  async function setup() {
    const fake = new FakeFirebase()
    const made = makeCore(fake)
    const { uid } = await made.core.connectIdentity()
    fake.setOwner(OWNER)
    fake.setAppModel(OWNER, CONNECTOR_MODEL)
    return { fake, ...made, uid }
  }

  it('uid・指紋・15分以内・まだ使っていない時だけ連携する（同じ指紋は2回使えない）', async () => {
    const { fake, core, uid, clock } = await setup()
    const hash = await pairingHash('s1', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: hash, pairedAt: clock.now })
    expect(await core.verifyPairing(await pairingHash('s1', 'x'.repeat(43)))).toMatchObject({ ok: false, reason: 'hash' })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: true, ownerUid: OWNER })
    expect(core.pairingState()).toBe('paired')
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'used' })
  })

  it('15分を過ぎた記録・別のコネクタの記録・記録が無い時は断る', async () => {
    const { fake, core, uid, clock } = await setup()
    const hash = await pairingHash('s2', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: hash, pairedAt: clock.now - 16 * 60_000 })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'expired' })
    // 別のコネクタの記録・無い記録はアクセスルールで読めない（どちらも not_found）
    fake.setConnector({ uid: 'someone-else', pairing: hash, pairedAt: clock.now })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'not_found' })
    fake.setConnector(null)
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(core.pairingState()).toBe('unpaired')
  })

  it('持ち主がいなければ断る', async () => {
    const fake = new FakeFirebase()
    const { core } = makeCore(fake)
    const { uid } = await core.connectIdentity()
    const hash = await pairingHash('s3', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: hash })
    expect(await core.verifyPairing(hash)).toMatchObject({ ok: false, reason: 'owner' })
  })
})

describe('連携の代（OAuth の許可を、いまの連携に結び付ける）', () => {
  it('［連携を解除］して連携し直した後は、前の許可はどのツールも使えない（新しい許可は使える）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock } = await pairedCore(fake, n.data)
    const gen = core.pairing().gen!
    expect(gen).toBeTruthy()
    const old = { ownerUid: OWNER, gen }
    expect(await core.checkGrant(old)).toBe(true)
    expect((await core.callTool('novel_list_titles', {}, { grant: old })).isError).toBeFalsy()
    // 解除（記録を消す）→ 別の Claude のアカウントで連携し直す（作り直した記録は作られた時刻が変わる）
    fake.setConnector(null)
    clock.now += 1_000
    const hash = await pairingHash('state-2', 'm'.repeat(43))
    fake.setConnector({ uid, pairing: hash, writes: true, pairedAt: clock.now })
    const r = await core.verifyPairing(hash)
    if (!r.ok) throw new Error(r.reason)
    expect(r.gen).not.toBe(gen)
    expect(await core.checkGrant(old)).toBe(false)
    for (const tool of ['novel_status', 'novel_list_titles', 'novel_add_revision_ideas']) {
      const res = await core.callTool(tool, { title_id: n.titleId, items: [{ heading: '案', body: '本文' }] }, { grant: old })
      expect(res, tool).toMatchObject({ isError: true, auth: true })
    }
    const fresh = { ownerUid: OWNER, gen: r.gen }
    expect(await core.checkGrant(fresh)).toBe(true)
    expect(await call(core, 'novel_list_titles')).toContain('『星の庭』')
    expect((await core.callTool('novel_list_titles', {}, { grant: fresh })).isError).toBeFalsy()
    // 持ち主が違う許可・代の無い許可（前の版の許可）も使えない
    expect(await core.checkGrant({ ownerUid: 'other-owner', gen: r.gen })).toBe(false)
    expect(await core.checkGrant({ ownerUid: OWNER })).toBe(false)
    expect(await core.checkGrant(undefined)).toBe(false)
  })

  it('解除しないで上書き（2.8 のアプリで別の Claude を足す）・「書き込みを許可」の切り替えでは、前の許可も使える', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock } = await pairedCore(fake, n.data)
    const old = { ownerUid: OWNER, gen: core.pairing().gen! }
    const hash = await pairingHash('state-3', 'n'.repeat(43))
    fake.setConnector({ uid, pairing: hash, writes: false, pairedAt: clock.now })
    const r = await core.verifyPairing(hash)
    if (!r.ok) throw new Error(r.reason)
    expect(r.cid).toBe('c0')
    expect(await core.checkGrant(old)).toBe(true)
    clock.now += 61_000
    expect((await core.callTool('novel_list_titles', {}, { grant: old })).isError).toBeFalsy()
  })

  it('解除の後に作り直した記録を確かめていなければ（連携し直しに失敗）、1分以内に前の許可で読めなくなる', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock } = await pairedCore(fake, n.data)
    const old = { ownerUid: OWNER, gen: core.pairing().gen! }
    fake.setConnector(null)
    fake.setConnector({ uid, pairing: await pairingHash('state-4', 'p'.repeat(43)), writes: true, pairedAt: clock.now })
    clock.now += 61_000
    const res = await core.callTool('novel_read_text', { title_id: n.titleId }, { grant: old })
    expect(res).toMatchObject({ isError: true, auth: true })
    expect(res.text).not.toContain('本文です。')
    expect(core.pairingState()).toBe('unpaired')
  })
})

describe('複数の接続（2.9。claude.ai のアカウントごとの許可）', () => {
  const MIN = 60_000
  /** config/connector を読んだ回数（Firestore の batchGet のうち、連携の記録） */
  const connectorReads = (fake: FakeFirebase) => fake.calls.filter((c) => c.op === 'batchGet').length

  /**
   * config/connector の読み取り（batchGet）の答えを止めておける fetch。答えは止める前に作る（その時の記録を読んだ答えが、
   * 遅れて届く。Durable Object は答えを待つ間にほかの呼び出しも進める）
   */
  function slowConnectorReads(fake: FakeFirebase) {
    const holds: { reached: () => void; gate: Promise<void>; late: boolean }[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const hold = url.endsWith(':batchGet') && String(init?.body ?? '').includes('/config/connector"') ? holds.shift() : undefined
      if (hold?.late) {
        hold.reached()
        await hold.gate
      }
      const res = await fake.fetch(input, init)
      if (hold && !hold.late) {
        hold.reached()
        await hold.gate
      }
      return res
    }) as typeof globalThis.fetch
    /**
     * 次の読み取りを止める（atRead は止まった時、release で答えを返す）。late なら、止めている間に変えた記録を読んだ答えにする
     * （読み始めてから、記録を読むまでが遅れた時）
     */
    const holdNext = (opts: { late?: boolean } = {}) => {
      let reached!: () => void
      let release!: () => void
      const atRead = new Promise<void>((r) => (reached = r))
      const gate = new Promise<void>((r) => (release = r))
      holds.push({ reached, gate, late: opts.late === true })
      return { atRead, release }
    }
    return { fetch, holdNext }
  }

  async function bare() {
    const fake = new FakeFirebase()
    const made = makeCore(fake)
    const { uid } = await made.core.connectIdentity()
    fake.setOwner(OWNER)
    fake.setAppModel(OWNER, CONNECTOR_MODEL)
    return { fake, ...made, uid }
  }

  it('確かめ: v1 の記録（2.8 のアプリ）は c0。v2 は接続ごとの指紋で、15分の間に2つ許可しても両方確かめられる', async () => {
    const { fake, core, uid, clock } = await bare()
    const h1 = await pairingHash('s1', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: h1, pairedAt: clock.now })
    expect(await core.verifyPairing(h1)).toMatchObject({ ok: true, ownerUid: OWNER, cid: 'c0' })
    expect(core.pairing().cids).toEqual(['c0'])
    const gen = fake.connectorCreateTime()
    // 2.9 のアプリが2つ続けて許可する（2.8 の記録は c0「接続1」に移す。上の pairing は最後の許可のもの）
    const ha = await pairingHash('sa', 'k'.repeat(43))
    const hb = await pairingHash('sb', 'k'.repeat(43))
    fake.addConnection({ uid, cid: 'caaa', name: '接続2', pairing: ha, pairedAt: clock.now })
    clock.now += 5 * MIN
    fake.addConnection({ uid, cid: 'cbbb', name: '接続3', pairing: hb, pairedAt: clock.now })
    expect(fake.connectorCreateTime()).toBe(gen)
    clock.now += 9 * MIN
    // 先に許可した接続の確かめが、後の許可の後に来ても通る（期限はその接続の許可の時刻から）
    const a = await core.verifyPairing(ha)
    expect(a).toMatchObject({ ok: true, cid: 'caaa' })
    const b = await core.verifyPairing(hb)
    expect(b).toMatchObject({ ok: true, cid: 'cbbb' })
    if (!a.ok || !b.ok) throw new Error('連携できません')
    expect(a.gen).toBe(b.gen)
    expect(core.pairing().cids).toEqual(['c0', 'caaa', 'cbbb'])
    // 同じ指紋は2回使えない
    expect(await core.verifyPairing(ha)).toMatchObject({ ok: false, reason: 'used' })
  })

  it('確かめ: 同じ指紋の接続が2つ・指紋の合う接続が無い・その接続の許可が15分より前・正しい接続が無い v2 は断る', async () => {
    const { fake, core, uid, clock } = await bare()
    const now = clock.now
    const hd = await pairingHash('sd', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: hd, pairedAt: now, connections: { c1: { pairing: hd, pairedAt: now }, c2: { pairing: hd, pairedAt: now } } })
    expect(await core.verifyPairing(hd)).toMatchObject({ ok: false, reason: 'hash' })
    // 上の pairing だけが合う（v2 は接続の指紋で確かめる。c0 を作り出さない）
    const hx = await pairingHash('sx', 'k'.repeat(43))
    const hy = await pairingHash('sy', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: hx, pairedAt: now, connections: { c3: { pairing: hy, pairedAt: now } } })
    expect(await core.verifyPairing(hx)).toMatchObject({ ok: false, reason: 'hash' })
    // 上の pairedAt は新しくても、その接続の許可が16分前なら期限切れ
    const he = await pairingHash('se', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: he, pairedAt: now, connections: { c4: { pairing: he, pairedAt: now - 16 * MIN } } })
    expect(await core.verifyPairing(he)).toMatchObject({ ok: false, reason: 'expired' })
    // 2分より先の時刻も断る
    fake.setConnector({ uid, pairing: he, pairedAt: now, connections: { c4: { pairing: he, pairedAt: now + 3 * MIN } } })
    expect(await core.verifyPairing(he)).toMatchObject({ ok: false, reason: 'expired' })
    // 接続の id の形でない鍵だけ・空の一覧は、記録が無いのと同じ
    const hz = await pairingHash('sz', 'k'.repeat(43))
    fake.setConnector({ uid, pairing: hz, pairedAt: now, connections: { 'bad-key': { pairing: hz, pairedAt: now } } })
    expect(await core.verifyPairing(hz)).toMatchObject({ ok: false, reason: 'not_found' })
    fake.setConnector({ uid, pairing: hz, pairedAt: now, connections: {} })
    expect(await core.verifyPairing(hz)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(core.pairingState()).toBe('unpaired')
  })

  it('2つの接続はどちらも使える。1つ解除すると、その許可だけが 401（Vault の連携はそのまま・ほかの接続は使える）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', name: '接続2', pairedAt: clock.now })
    for (const g of [a, b]) {
      expect((await core.callTool('novel_list_titles', {}, { grant: g })).text).toContain('『星の庭』')
      expect(await core.checkGrant(g)).toBe(true)
    }
    fake.removeConnection('caaa')
    clock.now += MIN + 1_000
    const res = await core.callTool('novel_list_titles', {}, { grant: a })
    expect(res).toMatchObject({ isError: true, auth: true })
    expect(res.text).toContain('連携が解除')
    expect(res.text).not.toContain('『星の庭』')
    expect(core.pairingState()).toBe('paired')
    expect(core.pairing().cids).toEqual(['cbbb'])
    expect((await core.callTool('novel_list_titles', {}, { grant: b })).text).toContain('『星の庭』')
    expect(await core.checkGrant(a)).toBe(false)
    expect(await core.checkGrant(b)).toBe(true)
    // 状態のツールも（毎回読む）
    expect(await core.callTool('novel_status', {}, { grant: a })).toMatchObject({ isError: true, auth: true })
    expect((await core.callTool('novel_status', {}, { grant: b })).isError).toBeUndefined()
    expect(core.pairingState()).toBe('paired')
  })

  it('どのツールも（読む・書く・アイデア・ゴミ箱へ移す）、1分を過ぎたら一覧を読み直して、外された接続を断る（何も書かない）', async () => {
    const tools: [string, (t: string) => Record<string, unknown>][] = [
      ['novel_read_text', (t) => ({ title_id: t })],
      ['novel_add_revision_ideas', (t) => ({ title_id: t, items: [{ heading: '案', body: '本文' }] })],
      ['novel_add_ideas', () => ({ placement: 'outside', items: [{ content: '新作の案' }] })],
      ['novel_append_to_idea', () => ({ id: 'i:cy-aaaa', read_mark: 'abcdefgh', content: '追記' })],
      ['novel_move_cards_to_trash', () => ({ cards: ['n:abcdefgh'] })],
    ]
    for (const [tool, args] of tools) {
      const fake = new FakeFirebase()
      const n = novel(['本文です。'])
      const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
      await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
      fake.removeConnection('caaa')
      // 1分以内は前に読んだ一覧のまま（遅くとも1分ほどで気付く）
      clock.now += 30_000
      const reads = connectorReads(fake)
      expect(await core.checkGrant(a), tool).toBe(true)
      expect(connectorReads(fake), tool).toBe(reads)
      clock.now += 31_000
      const before = fake.recordDocs(OWNER).length
      const res = await core.callTool(tool, args(n.titleId), { grant: a })
      expect(res, tool).toMatchObject({ isError: true, auth: true })
      expect(fake.recordDocs(OWNER).length, tool).toBe(before)
      expect(core.pairingState(), tool).toBe('paired')
    }
  })

  it('一覧に無い接続は、5秒より前に読んだ一覧なら読み直してから断る（読めなければ断らない）。5秒以内に読んだ一覧なら読み直さずに断る', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
    // ほかの所で許可された接続（コネクタの一覧にはまだ無い）: 古い一覧では断らず、読み直して通す
    fake.addConnection({ uid, cid: 'cbbb', pairing: await pairingHash('sb', 'k'.repeat(43)), pairedAt: clock.now })
    const b: GrantProps = { ...a, cid: 'cbbb' }
    clock.now += 10_000
    let reads = connectorReads(fake)
    expect((await core.callTool('novel_list_titles', {}, { grant: b })).text).toContain('『星の庭』')
    expect(connectorReads(fake)).toBeGreaterThan(reads)
    // 読んだばかりの一覧に無い接続は、読み直さずに断る
    clock.now += 2_000
    reads = connectorReads(fake)
    const x: GrantProps = { ...a, cid: 'cxxx' }
    expect(await core.callTool('novel_list_titles', {}, { grant: x })).toMatchObject({ isError: true, auth: true })
    expect(await core.checkGrant(x)).toBe(false)
    expect(connectorReads(fake)).toBe(reads)
    // 5秒を過ぎてから、読み直せない（Firebase の無料枠を使い切った）: 断らない（許可を取り消さない）。一覧にある接続は使える
    clock.now += 10_000
    fake.exhausted = true
    const y: GrantProps = { ...a, cid: 'cyyy' }
    const res = await core.callTool('novel_list_titles', {}, { grant: y })
    expect(res.isError).toBe(true)
    expect(res.auth).toBeUndefined()
    expect(res.text).toContain('接続できません')
    expect(await core.checkGrant(y)).toBe(true)
    expect(core.pairingState()).toBe('paired')
    expect((await core.callTool('novel_list_titles', {}, { grant: a })).isError).toBeFalsy()
    fake.exhausted = false
    expect(await core.callTool('novel_list_titles', {}, { grant: y })).toMatchObject({ isError: true, auth: true })
  })

  it('一覧を読めない時（1分を過ぎた・Vault を作り直した）は、前に読んだ一覧・連携の状態に残した一覧のまま続ける', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, sql, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
    clock.now += 2 * MIN
    fake.exhausted = true
    const res = await core.callTool('novel_list_titles', {}, { grant: a })
    expect(res.isError).toBeFalsy()
    expect(res.text).toContain('Firebase の今日の無料枠を使い切ったため')
    expect(await core.checkGrant(b)).toBe(true)
    expect(core.pairingState()).toBe('paired')
    // Durable Object が作り直された（覚えた一覧は無い）: 連携の状態に残した一覧を使う
    const again = makeCore(fake, { sql, clock }).core
    expect(again.pairing().cids).toEqual(['caaa', 'cbbb'])
    expect((await again.callTool('novel_list_titles', {}, { grant: b })).isError).toBeFalsy()
    expect(await again.checkGrant(a)).toBe(true)
    // 残した一覧に無い接続は、読めないので断らない
    const z = await again.callTool('novel_list_titles', {}, { grant: { ...a, cid: 'czzz' } })
    expect(z.isError).toBe(true)
    expect(z.auth).toBeUndefined()
  })

  it('2.8 までの許可（cid が無い）は c0: v1 の記録でも、2.9 のアプリが一覧の形に移した後も使える。c0 を解除すると使えない', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock, grant: legacy } = await pairedCore(fake, n.data)
    expect(legacy.cid).toBeUndefined()
    expect(core.pairing().cids).toEqual(['c0'])
    expect((await core.callTool('novel_list_titles', {}, { grant: legacy })).text).toContain('『星の庭』')
    // 2.8 の Vault の状態（cids が無い）も c0 として読む
    core.store.setMeta('pairing', { ...core.pairing(), cids: undefined })
    expect(await core.checkGrant(legacy)).toBe(true)
    const gen = fake.connectorCreateTime()
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', name: '接続2', pairedAt: clock.now })
    // 記録は作り直さない（作られた時刻 = 連携の代が同じ）ので、2.8 の許可も使える
    expect(fake.connectorCreateTime()).toBe(gen)
    expect(b.gen).toBe(legacy.gen)
    expect(Object.keys(fake.connectorConnections()!)).toEqual(['c0', 'cbbb'])
    clock.now += MIN + 1_000
    expect((await core.callTool('novel_list_titles', {}, { grant: legacy })).text).toContain('『星の庭』')
    expect(await core.checkGrant(legacy)).toBe(true)
    // 名前を変えても使える
    fake.renameConnection('c0', '仕事用')
    clock.now += MIN + 1_000
    expect((await core.callTool('novel_list_titles', {}, { grant: legacy })).isError).toBeFalsy()
    fake.removeConnection('c0')
    clock.now += MIN + 1_000
    expect(await core.callTool('novel_list_titles', {}, { grant: legacy })).toMatchObject({ isError: true, auth: true })
    expect(await core.checkGrant(legacy)).toBe(false)
    expect((await core.callTool('novel_list_titles', {}, { grant: b })).isError).toBeFalsy()
    expect(core.pairingState()).toBe('paired')
  })

  it('解除した接続は、同じ claude.ai のアカウントで接続し直しても新しい cid（前の許可は使えないまま）。入れ替えた接続はすぐ使えない', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
    fake.removeConnection('caaa')
    clock.now += MIN + 1_000
    expect(await core.callTool('novel_list_titles', {}, { grant: a })).toMatchObject({ isError: true, auth: true })
    const c = await addConnection(fake, core, uid, { cid: 'cccc', pairedAt: clock.now })
    expect(c.cid).toBe('cccc')
    expect(await core.callTool('novel_list_titles', {}, { grant: a })).toMatchObject({ isError: true, auth: true })
    expect((await core.callTool('novel_list_titles', {}, { grant: c })).isError).toBeFalsy()
    // 「接続（cbbb）と入れ替える」: 確かめた時に読んだ一覧に cbbb は無いので、読み直さずにすぐ断る
    clock.now += 1_000
    const d = await addConnection(fake, core, uid, { cid: 'cddd', pairedAt: clock.now, replaceCid: 'cbbb' })
    expect(Object.keys(fake.connectorConnections()!).sort()).toEqual(['cccc', 'cddd'])
    expect(await core.callTool('novel_list_titles', {}, { grant: b })).toMatchObject({ isError: true, auth: true })
    expect(await core.checkGrant(b)).toBe(false)
    for (const g of [c, d]) expect((await core.callTool('novel_list_titles', {}, { grant: g })).isError).toBeFalsy()
  })

  it('novel_status: 許可のある呼び出しだけ、最後に「この接続」の行（前の行は1字も変えない）。外された接続は 401', async () => {
    const data = novel(['本文です。']).data
    const run = async () => {
      const fake = new FakeFirebase()
      const made = await pairedCore(fake, data, { cid: 'caaa' })
      const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', name: '接続2', pairedAt: made.clock.now })
      return { ...made, fake, b }
    }
    const one = await run()
    const plain = (await one.core.callTool('novel_status', {})).text.split('\n')
    expect(plain.at(-1)).toMatch(/^アイデアへの追記の依頼: /)
    const two = await run()
    const withGrant = (await two.core.callTool('novel_status', {}, { grant: two.b })).text.split('\n')
    expect(withGrant.slice(0, -1)).toEqual(plain)
    expect(withGrant.at(-1)).toBe('この接続: 接続2（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）')
    expect((await two.core.callTool('novel_status', {}, { grant: two.grant })).text.split('\n').at(-1)).toBe(
      'この接続: 接続1（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
    // 名前を変えるとすぐ出る（状態のツールは毎回読む）
    two.fake.renameConnection('cbbb', '仕事用')
    expect((await two.core.callTool('novel_status', {}, { grant: two.b })).text.split('\n').at(-1)).toBe(
      'この接続: 仕事用（接続 2 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
    // 外された接続は、すぐ（1分を待たずに）連携の解除の答え。Vault の連携とほかの接続はそのまま
    two.fake.removeConnection('cbbb')
    expect(await two.core.callTool('novel_status', {}, { grant: two.b })).toMatchObject({ isError: true, auth: true, text: expect.stringContaining('連携が解除') })
    expect(two.core.pairingState()).toBe('paired')
    expect((await two.core.callTool('novel_status', {}, { grant: two.grant })).text.split('\n').at(-1)).toBe(
      'この接続: 接続1（接続 1 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
    // 2.8 までの許可と記録（v1）は「接続1」
    const fake = new FakeFirebase()
    const legacy = await pairedCore(fake, data)
    expect((await legacy.core.callTool('novel_status', {}, { grant: legacy.grant })).text.split('\n').at(-1)).toBe(
      'この接続: 接続1（接続 1 / 10。名前はアプリの 設定 → Claude 連携 で変えられます）',
    )
  })

  it('記録が消された（連携をすべて解除）・正しい接続が無くなった時は、すべての接続が使えない（Vault の連携を外す）', async () => {
    for (const gone of ['deleted', 'empty'] as const) {
      const fake = new FakeFirebase()
      const n = novel(['本文です。'])
      const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
      const b = await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
      if (gone === 'deleted') fake.setConnector(null)
      else fake.setConnector({ uid, pairing: 'x'.repeat(64), pairedAt: clock.now, connections: {} })
      expect(await core.callTool('novel_status', {}, { grant: a }), gone).toMatchObject({ isError: true, auth: true })
      expect(core.pairingState(), gone).toBe('unpaired')
      expect(await core.callTool('novel_list_titles', {}, { grant: b }), gone).toMatchObject({ isError: true, auth: true })
      expect(await core.checkGrant(a), gone).toBe(false)
      expect(await core.checkGrant(b), gone).toBe(false)
    }
  })

  it('トークンの更新の確かめ（checkGrant）: 1分以内は前に読んだ一覧、過ぎたら読み直す。読めない時は切らない', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa' })
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
    fake.removeConnection('cbbb')
    clock.now += 30_000
    expect(await core.checkGrant(b)).toBe(true)
    clock.now += 31_000
    fake.exhausted = true
    expect(await core.checkGrant(b)).toBe(true)
    fake.exhausted = false
    expect(await core.checkGrant(b)).toBe(false)
    expect(await core.checkGrant(a)).toBe(true)
    // 持ち主・代が違う許可は、クラウドを読まずに断る
    const reads = connectorReads(fake)
    expect(await core.checkGrant({ ...a, gen: 'other' })).toBe(false)
    expect(await core.checkGrant({ ...a, ownerUid: 'other' })).toBe(false)
    expect(connectorReads(fake)).toBe(reads)
  })

  it('遅れて届いた古い一覧で、後から足した接続の一覧を上書きしない（読み始めた順で覚える。足したばかりの接続を断らない）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const slow = slowConnectorReads(fake)
    const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa', fetch: slow.fetch })
    // 接続 A のツールが一覧を読み始め（接続 B を足す前の記録を読む）、答えが遅れる
    clock.now += 2 * MIN
    const held = slow.holdNext()
    const callA = core.callTool('novel_list_titles', {}, { grant: a })
    await held.atRead
    // その間に持ち主が B を許可し、B の /pair/callback が確かめる
    const b = await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
    expect(core.pairing().cids).toEqual(['caaa', 'cbbb'])
    held.release()
    expect((await callA).text).toContain('『星の庭』')
    // 古い一覧（[A]）を新しいものとして覚えていない: B の最初の呼び出しは通り、許可も取り消さない
    clock.now += 2_000
    expect((await core.callTool('novel_list_titles', {}, { grant: b })).text).toContain('『星の庭』')
    expect(await core.checkGrant(b)).toBe(true)
    expect(core.pairing().cids).toEqual(['caaa', 'cbbb'])
    expect(core.pairingState()).toBe('paired')
  })

  it('記録が無い時の答えが、連携し直した後に遅れて届いても、新しい連携を外さない（後から読み始めた確かめがあれば使わない）', async () => {
    // (1) 連携し直した確かめが先に終わった: 遅れた答え（記録が無い）は捨てる
    {
      const fake = new FakeFirebase()
      const n = novel(['本文です。'])
      const slow = slowConnectorReads(fake)
      const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa', fetch: slow.fetch })
      clock.now += 2 * MIN
      fake.setConnector(null)
      const held = slow.holdNext()
      const callA = core.callTool('novel_list_titles', {}, { grant: a })
      await held.atRead
      const b = await addConnection(fake, core, uid, { cid: 'cbbb', pairedAt: clock.now })
      expect(b.gen).not.toBe(a.gen)
      held.release()
      // A（前の連携の許可）は断るが、Vault の連携は外さない
      expect(await callA).toMatchObject({ isError: true, auth: true })
      expect(core.pairingState()).toBe('paired')
      expect(core.pairing().gen).toBe(b.gen)
      expect((await core.callTool('novel_list_titles', {}, { grant: b })).text).toContain('『星の庭』')
      expect(await core.checkGrant(b)).toBe(true)
      expect(await core.checkGrant(a)).toBe(false)
    }
    // (2) 連携し直す確かめがまだ終わっていない: 遅れた答えでは Vault の連携を外さない（その答えで断るのは前の連携の A だけ。
    // 外すかどうかは後から始めた確かめで決まる）
    {
      const fake = new FakeFirebase()
      const n = novel(['本文です。'])
      const slow = slowConnectorReads(fake)
      const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { cid: 'caaa', fetch: slow.fetch })
      clock.now += 2 * MIN
      fake.setConnector(null)
      const heldA = slow.holdNext()
      const callA = core.callTool('novel_list_titles', {}, { grant: a })
      await heldA.atRead
      const hb = await pairingHash('state-cbbb', 'k'.repeat(43))
      fake.addConnection({ uid, cid: 'cbbb', pairing: hb, pairedAt: clock.now })
      const heldB = slow.holdNext()
      const verifying = core.verifyPairing(hb)
      await heldB.atRead
      heldA.release()
      expect(await callA).toMatchObject({ isError: true, auth: true })
      expect(core.pairingState()).toBe('paired')
      heldB.release()
      const v = await verifying
      expect(v).toMatchObject({ ok: true, cid: 'cbbb' })
      if (!v.ok) throw new Error('連携できません')
      const b: GrantProps = { ownerUid: v.ownerUid, gen: v.gen, cid: v.cid }
      expect((await core.callTool('novel_list_titles', {}, { grant: b })).text).toContain('『星の庭』')
      expect(await core.checkGrant(b)).toBe(true)
      // 確かめの後に読み始めた答えで記録が無ければ、いつもどおり連携を外す
      fake.setConnector(null)
      clock.now += 2 * MIN
      expect(await core.callTool('novel_list_titles', {}, { grant: b })).toMatchObject({ isError: true, auth: true })
      expect(core.pairingState()).toBe('unpaired')
    }
  })

  it('読んでいる間にすべて解除して連携し直し、同じ cid（2.8 の記録の c0）がまた一覧にあっても、前の連携の許可は断る', async () => {
    // late: 記録が無い時の答え（すべて解除の後に読んだ） / 連携し直した後の記録を読んだ答え（読むのが遅れた）
    for (const late of [false, true]) {
      for (const tool of ['novel_list_titles', 'novel_status']) {
        const fake = new FakeFirebase()
        const n = novel(['本文です。'])
        const slow = slowConnectorReads(fake)
        // 2.8 の記録（v1）で連携した許可（cid が無い = c0）
        const { core, uid, clock, grant: a } = await pairedCore(fake, n.data, { fetch: slow.fetch })
        clock.now += 2 * MIN
        if (!late) fake.setConnector(null)
        const held = slow.holdNext({ late })
        const callA = core.callTool(tool, {}, { grant: a })
        await held.atRead
        // ［連携をすべて解除］の後に、また v1 の記録で連携し直す（一覧はまた [c0]。代は変わる）
        if (late) fake.setConnector(null)
        const h2 = await pairingHash('state-2', 'k'.repeat(43))
        fake.setConnector({ uid, pairing: h2, pairedAt: clock.now })
        const v = await core.verifyPairing(h2)
        expect(v).toMatchObject({ ok: true, cid: 'c0' })
        if (!v.ok) throw new Error('連携できません')
        expect(v.gen).not.toBe(a.gen)
        held.release()
        const res = await callA
        expect(res, `${tool}${late ? '（記録を読むのが遅れた）' : ''}`).toMatchObject({ isError: true, auth: true })
        expect(res.text).not.toContain('『星の庭』')
        expect(res.text).not.toContain('この接続')
        // 新しい連携はそのまま使える
        expect(core.pairingState()).toBe('paired')
        const b: GrantProps = { ownerUid: v.ownerUid, gen: v.gen }
        expect((await core.callTool('novel_list_titles', {}, { grant: b })).text).toContain('『星の庭』')
        expect(await core.checkGrant(b)).toBe(true)
        expect(await core.checkGrant(a)).toBe(false)
      }
    }
  })
})

describe('写し（差分の読み取り）', () => {
  it('同じ時刻の文書が何ページにもまたがっても、読み直しも取りこぼしも無い', async () => {
    const fake = new FakeFirebase()
    const n = novel(Array.from({ length: 130 }, (_, i) => `第${i + 1}話の本文。`))
    const { core, clock } = await pairedCore(fake, null)
    // 1回の書き込み（同じ時刻）で 130 話分の話と稿（260 文書）
    fake.putMany(OWNER, [
      ...Object.values(n.data.titles).map((rec) => ({ table: 'titles', rec: rec as never })),
      ...Object.values(n.data.pieces).map((rec) => ({ table: 'pieces', rec: rec as never })),
      ...Object.values(n.data.versions).map((rec) => ({ table: 'versions', rec: rec as never })),
    ])
    const before = fake.calls.length
    clock.now += 20_000
    const text = await call(core, 'novel_get_outline', { title_id: n.titleId })
    expect(text).toContain('#130 第130話')
    // 1回の呼び出しで読み切れない分は、続きを予約して読む（alarm）
    for (let i = 0; i < 20 && (await core.alarm()) !== null; i++);
    const view = core.views().view
    expect(Object.keys(view.versions)).toHaveLength(130)
    // 2回目は何も変わっていないので、1回だけの問い合わせ（0件）
    const reads = fake.calls.length
    expect(reads).toBeGreaterThan(before)
    clock.now += 20_000
    const again = await core.callTool('novel_get_outline', { title_id: n.titleId })
    expect(again.isError).toBeUndefined()
  })

  it('分割した大きな記録（端末が書いた分割文書）を、ページをまたいでも組み立てる', async () => {
    const fake = new FakeFirebase()
    const big = '長い本文の段落。\n'.repeat(4_000)
    const n = novel(['短い本文', big])
    const { core, clock } = await pairedCore(fake, null)
    // 分割文書の大きさを小さくして、1つの稿を 8 つに分ける
    const v = n.data.versions[n.data.pieces[n.ids[1]].versionIds[0]]
    fake.putMany(OWNER, [{ table: 'titles', rec: n.data.titles[n.titleId] as never }])
    for (const id of n.ids) fake.putRecord(OWNER, 'pieces', n.data.pieces[id] as never)
    fake.putRecord(OWNER, 'versions', n.data.versions[n.data.pieces[n.ids[0]].versionIds[0]] as never)
    fake.putRecord(OWNER, 'versions', v as never, { chunkSize: 9_000 })
    clock.now += 20_000
    const text = await call(core, 'novel_read_text', { title_id: n.titleId, pieces: ['#2'], char_budget: 60_000 })
    expect(text).toContain('長い本文の段落。')
    expect(core.views().view.versions[v.id].body).toBe(big)
    expect(core.mirror.unreadableCount()).toBe(0)
  })

  it('分割した記録が短くなって分割しなくなったら、写しの分割文書も消す（夜の確かめで数が合う）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['短い本文', '長い本文の段落。\n'.repeat(400)])
    const v = n.data.versions[n.data.pieces[n.ids[1]].versionIds[0]]
    const { core, clock } = await pairedCore(fake, null, { config: { dailyReadBudget: 1_000_000 } })
    fake.putMany(OWNER, [{ table: 'titles', rec: n.data.titles[n.titleId] as never }])
    for (const id of n.ids) fake.putRecord(OWNER, 'pieces', n.data.pieces[id] as never)
    fake.putRecord(OWNER, 'versions', n.data.versions[n.data.pieces[n.ids[0]].versionIds[0]] as never)
    fake.putRecord(OWNER, 'versions', v as never, { chunkSize: 1_000 })
    clock.now += 20_000
    expect(await call(core, 'novel_read_text', { title_id: n.titleId, pieces: ['#2'] })).toContain('長い本文の段落。')
    expect(core.mirror.counts().chunks).toBeGreaterThan(0)
    expect(await core.nightly()).toBe('ok')
    // 端末が短くした: 親の文書を分割せずに書き直し、分割文書は消す（消したことは差分の読み取りに出ない）
    for (const k of [...fake.docs.keys()]) if (k.includes(`/records/versions:${v.id}#`)) fake.docs.delete(k)
    fake.putRecord(OWNER, 'versions', { ...v, body: '短くした本文。', updatedAt: v.updatedAt + 1 } as never)
    clock.now += 20_000
    expect(await call(core, 'novel_read_text', { title_id: n.titleId, pieces: ['#2'] })).toContain('短くした本文。')
    expect(core.mirror.counts().chunks).toBe(0)
    expect(core.views().view.versions[v.id].body).toBe('短くした本文。')
    expect(await core.nightly()).toBe('ok')
    expect(core.mirror.warm().done).toBe(true)
  })

  it('削除の印が届くと写しから消え、以前に削除された記録として覚える', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core, clock } = await pairedCore(fake, n.data)
    const memo = { id: 'm1', titleId: n.titleId, name: 'メモ', body: '中身', order: 0, createdAt: 1, updatedAt: 1 }
    fake.putRecord(OWNER, 'memos', memo as never)
    clock.now += 20_000
    expect(await call(core, 'novel_get_notes', { title_id: n.titleId, kind: 'memos' })).toContain('メモ')
    fake.tombstone(OWNER, 'memos', 'm1')
    clock.now += 20_000
    expect(await call(core, 'novel_get_notes', { title_id: n.titleId, kind: 'memos' })).toContain('（ありません）')
    expect(core.mirror.wasDeleted('memos', 'm1')).toBe(true)
  })

  it('保存に失敗したページの先へは進まない（cursor は同じトランザクションで進める）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['一', '二', '三'])
    const { core, sql } = await pairedCore(fake, null, { warm: false })
    for (const id of n.ids) fake.putRecord(OWNER, 'pieces', n.data.pieces[id] as never)
    const original = sql.transaction.bind(sql)
    let fail = true
    sql.transaction = <T,>(fn: () => T): T =>
      original(() => {
        const out = fn()
        if (fail) throw new Error('disk full')
        return out
      })
    const r = await core.callTool('novel_list_titles', {})
    expect(r.isError).toBe(true)
    expect(core.mirror.cursor()).toBeNull()
    fail = false
    sql.transaction = original
    for (let i = 0; i < 20 && (await core.alarm()) !== null; i++);
    // （タイトルが無いので修復した表示の内容には出ない。写しそのものを見る）
    expect(Object.keys(core.mirror.data().pieces)).toHaveLength(3)
  })

  it('知らない表（新しい版のアプリが足したもの）の文書も保存し、知っている表だけを見せる', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core, sql, clock } = await pairedCore(fake, n.data)
    fake.putRecord(OWNER, 'futureTable', { id: 'f1', titleId: n.titleId } as never)
    clock.now += 20_000
    await call(core, 'novel_list_titles')
    expect(sql.all('SELECT name FROM rec WHERE tbl = ?', 'futureTable')).toHaveLength(1)
    expect((core.views().raw as unknown as Record<string, unknown>).futureTable).toBeUndefined()
  })
})

describe('見せる範囲（Title.claudeAccess）', () => {
  it('none のタイトルは、どのツールにも出ない', async () => {
    const fake = new FakeFirebase()
    const a = novel(['見せる本文'], { name: '見せる' })
    const b = novel(['秘密の本文'], { name: '秘密', data: a.data })
    b.data.titles[b.titleId] = { ...b.data.titles[b.titleId], claudeAccess: 'none' }
    const { core } = await pairedCore(fake, b.data)
    const list = await call(core, 'novel_list_titles')
    expect(list).toContain('『見せる』')
    expect(list).not.toContain('秘密')
    expect(list).toContain('見せていないタイトルが 1件')
    for (const [tool, args] of [
      ['novel_get_outline', {}],
      ['novel_read_text', {}],
      ['novel_search_text', { query: '秘密' }],
      ['novel_get_notes', { kind: 'memos' }],
      ['novel_get_strategy', {}],
      ['novel_get_critique', {}],
      ['novel_list_proofreading', {}],
      ['novel_add_revision_ideas', { items: [{ heading: 'x', body: 'y' }] }],
    ] as const) {
      const r = await core.callTool(tool, { title_id: b.titleId, ...args })
      expect([tool, r.isError]).toEqual([tool, true])
      expect(r.text).not.toContain('秘密の本文')
    }
    const search = await call(core, 'novel_search_text', { title_id: a.titleId, query: '秘密' })
    expect(search).toContain('見つかりません')
  })

  it('read のタイトルは読めるが書き込めない', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    n.data.titles[n.titleId] = { ...n.data.titles[n.titleId], claudeAccess: 'read' }
    const { core } = await pairedCore(fake, n.data)
    expect(await call(core, 'novel_read_text', { title_id: n.titleId })).toContain('本文です。')
    const r = await core.callTool('novel_add_revision_ideas', { title_id: n.titleId, items: [{ heading: '案', body: '本文' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込み不可')
    expect(r.text).toContain('タイトル画面の「Claude に見せる」')
  })

  it('ゴミ箱・応募時の原稿の控え・作者が書いたどのタイトルにも属さないアイデアは見せない', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    n.data.ideas.i1 = { id: 'i1', titleId: null, heading: '宙ぶらりん', body: '属さない', order: 0, createdAt: 1, updatedAt: 1 }
    n.data.snapshotTexts.s1 = { id: 's1', body: '応募した本文' }
    const { core } = await pairedCore(fake, n.data)
    const view = core.views().view
    expect(view.ideas.i1).toBeUndefined()
    expect(view.snapshotTexts.s1).toBeUndefined()
    expect(Object.keys(view.trashEntries)).toHaveLength(0)
  })

  it('Claude が作ったホームのアイデア（2.8）は見せ、まだアプリが足していない追記の依頼を当てた形にする', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const body = '2026/10/28 14:32　新作の案\n【あらすじ】\n・海辺の町'
    const claude = {
      id: 'cy-home0001',
      titleId: null,
      heading: '',
      body,
      checked: false,
      checkedAt: null,
      order: 0,
      source: 'claude' as const,
      v: 1,
      claudeHash: hashJson(body),
      createdAt: 1,
      updatedAt: 1,
    }
    n.data.ideas[claude.id] = claude
    // source が claude でも、id が Claude のアイデアの形でなければ見せない
    n.data.ideas['a1b2c3d4-0000-4000-8000-000000000001'] = { ...claude, id: 'a1b2c3d4-0000-4000-8000-000000000001' }
    n.data.ideas.i1 = {
      id: 'i1',
      titleId: null,
      heading: '',
      body: '作者のホームのアイデア',
      order: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const at = Date.UTC(2026, 9, 29, 1, 0, 0)
    n.data.ideaAppends['cu-a1'] = {
      id: 'cu-a1',
      ideaId: claude.id,
      text: '舞台を山の町に変える',
      readMark: 'abcd1234',
      source: 'claude',
      v: 1,
      createdAt: at,
      updatedAt: at,
    }
    n.data.ideaAppends['cu-a2'] = { ...n.data.ideaAppends['cu-a1'], id: 'cu-a2', ideaId: 'i1' }
    const { core } = await pairedCore(fake, n.data)
    const { raw, view } = core.views()
    expect(Object.keys(view.ideas)).toEqual([claude.id])
    expect(view.ideas[claude.id].body).toBe(`${body}\n\n2026/10/29のセッションで以下の内容へ変更\n舞台を山の町に変える`)
    expect(Object.keys(view.ideaAppends)).toEqual(['cu-a1'])
    // 写し（raw）は書き換えない
    expect(raw.ideas[claude.id].body).toBe(body)
    expect(Object.keys(raw.ideaAppends).sort()).toEqual(['cu-a1', 'cu-a2'])
  })
})

describe('読むツール', () => {
  it('目次・採用原稿・稿の一覧・検索（幕・特殊ブロック・ルビ）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['一話目の本文。\n二段落目。', '｜漢字《かんじ》を見れる景色。\n次の段落。', '三話目。'], { subtitles: ['出発', '雨', ''] })
    addPrologue(n, 'プロローグ', '始まりの本文。')
    splitEpisode(n, n.ids[2], [2])
    const { core } = await pairedCore(fake, n.data)
    const outline = await call(core, 'novel_get_outline', { title_id: n.titleId })
    expect(outline).toContain('#1 プロローグ')
    expect(outline).toMatch(/#4 第3話 .* 幕×2/)
    expect(outline).toContain('  #4.1 第1幕')
    const read = await call(core, 'novel_read_text', { title_id: n.titleId, from: '#3', to: '#3' })
    expect(read).toContain('=== #3 第2話　雨')
    expect(read).toContain('｜漢字《かんじ》を見れる景色。')
    const strip = await call(core, 'novel_read_text', { title_id: n.titleId, pieces: ['第2話'], ruby: 'strip' })
    expect(strip).toContain('漢字を見れる景色。')
    const versions = await call(core, 'novel_list_versions', { title_id: n.titleId, piece: '#4' })
    expect(versions).toContain('幕に分けた話（2幕）')
    const search = await call(core, 'novel_search_text', { title_id: n.titleId, query: '見れる' })
    expect(search).toMatch(/#3 第2話 ¶1 o:\d+ .*【見れる】/)
    const count = await call(core, 'novel_search_text', { title_id: n.titleId, query: '本文', count_only: true })
    expect(count).toContain('件')
  })

  it('戦略（novel_get_strategy）: 応募計画の規定の備考・提出する梗概／キャッチコピー（文字数と規定）・特記事項', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const a = addSubmission(n.data, n.titleId, '海風小説大賞')
    let data = updateSubmission(a.data, a.result, {
      status: 'planned',
      limitNote: 'ルビ不可。\n章タイトル必須。',
      synopsis: '｜海辺《うみべ》の町に住む少女が、\n嘘をつく。',
      synopsisMin: 100,
      synopsisMax: 800,
      catchphrase: 'その嘘は、世界を救うためについた。',
      catchphraseMax: 40,
      specialNotes: '応募フォームのセールスポイント欄にも使う',
    })
    // 古い版で作った応募計画（項目が無い）
    const b = addSubmission(data, n.titleId, '古い賞')
    data = b.data
    const old: Record<string, unknown> = { ...data.submissions[b.result] }
    for (const k of ['limitNote', 'synopsis', 'synopsisMin', 'synopsisMax', 'catchphrase', 'catchphraseMin', 'catchphraseMax', 'specialNotes'])
      delete old[k]
    data = { ...data, submissions: { ...data.submissions, [b.result]: old as unknown as typeof data.submissions[string] } }
    const { core } = await pairedCore(fake, data)
    const list = await call(core, 'novel_get_strategy', { title_id: n.titleId })
    expect(list).toContain(
      [
        '  規定の備考: ルビ不可。 章タイトル必須。',
        '  梗概・あらすじ: 16字（規定 100〜800字・あと84字）',
        '  キャッチコピー: 17字（規定 40字以内・規定内） 「その嘘は、世界を救うためについた。」',
        '  特記事項: 応募フォームのセールスポイント欄にも使う',
      ].join('\n'),
    )
    // 古い応募計画は今までどおり1行
    expect(list).toMatch(/「古い賞」検討中 \/ 締切 未定 \/ 規定 未設定\n/)
    const id = /(o:[0-9a-z]+)「海風小説大賞」/.exec(list)![1]
    const full = await call(core, 'novel_get_strategy', { title_id: n.titleId, submission_id: id })
    expect(full).toContain('--- 規定の備考 ---\nルビ不可。\n章タイトル必須。')
    expect(full).toContain(
      '--- 提出する梗概・あらすじ ---\n16字（空白・改行を除く）・規定 100〜800字 → あと84字\n｜海辺《うみべ》の町に住む少女が、\n嘘をつく。',
    )
    expect(full).toContain('--- 提出するキャッチコピー ---\n17字（空白・改行を除く）・規定 40字以内 → 規定内\nその嘘は、世界を救うためについた。')
    expect(full).toContain('--- 特記事項 ---\n応募フォームのセールスポイント欄にも使う')
    // 概要の後・結果の前
    expect(full.indexOf('--- 概要 ---')).toBeLessThan(full.indexOf('--- 規定の備考 ---'))
    expect(full.indexOf('--- 特記事項 ---')).toBeLessThan(full.indexOf('--- 結果・講評 ---'))
    const oldId = /(o:[0-9a-z]+)「古い賞」/.exec(list)![1]
    const oldFull = await call(core, 'novel_get_strategy', { title_id: n.titleId, submission_id: oldId })
    expect(oldFull).not.toContain('提出する')
    expect(oldFull).not.toContain('特記事項')
  })

  it('知らないタイトル・話は候補を返す', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core } = await pairedCore(fake, n.data)
    const r = await core.callTool('novel_get_outline', { title_id: 't:zzzz' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('候補')
    const p = await core.callTool('novel_read_text', { title_id: n.titleId, pieces: ['#9'] })
    expect(p.isError).toBe(true)
  })

  it('アイデア（novel_get_notes kind=ideas）: 済みは【済】を付けて後ろに並べ、古い版の見出しはそのまま出す', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const t = n.titleId
    const idea = (id: string, o: Partial<(typeof n.data.ideas)[string]>) => ({
      id,
      titleId: t,
      heading: '',
      body: '',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
      ...o,
    })
    n.data.ideas = {
      // 古い版のアイデア（見出しあり・済みの項目なし）
      a: idea('a', { heading: '記憶を売る古書店', body: '客は記憶を売る。', order: 0 }),
      b: idea('b', { body: '雨の駅\n来ない列車を待つ', order: 1, checked: true, checkedAt: 5 }),
      c: idea('c', { body: '天窓の栞', order: 2, checked: false, checkedAt: null }),
      d: idea('d', { body: '止まった時計', order: 3, checked: true, checkedAt: 9 }),
    }
    const { core } = await pairedCore(fake, n.data)
    const list = await call(core, 'novel_get_notes', { title_id: t, kind: 'ideas' })
    expect(list).toContain('アイデア（4件・うち済み 2件）')
    expect(list).toContain('【済】は作者が済み（実装した・没にした）にしたアイデア')
    const lines = list.split('\n').filter((l) => /^i:/.test(l))
    // 済みでないもの（order の順）→ 済み（新しく済みにしたものから）
    expect(lines.map((l) => l.replace(/^i:\S+ /, ''))).toEqual([
      '記憶を売る古書店（8字）: 客は記憶を売る。',
      '天窓の栞（4字）',
      '【済】止まった時計（6字）',
      '【済】雨の駅 来ない列車を待つ（12字）',
    ])
    expect(list).not.toContain('見出しなし')
    const full = await call(core, 'novel_get_notes', { title_id: t, kind: 'ideas', full: true })
    expect(full).toContain('=== アイデア: 記憶を売る古書店 [i:')
    expect(full).toMatch(/=== アイデア【済】 \[i:\S+\] ===\n雨の駅\n来ない列車を待つ/)
    // 名前（見出し、なければ1行目）でも選べる
    const one = await call(core, 'novel_get_notes', { title_id: t, kind: 'ideas', ids: ['雨の駅'] })
    expect(one).toContain('来ない列車を待つ')
  })

  it('状態（novel_status）', async () => {
    const fake = new FakeFirebase()
    const { core } = await pairedCore(fake, novel(['本文']).data)
    const text = await call(core, 'novel_status')
    expect(text).toContain('連携: 済み')
    expect(text).toContain('書き込み: 許可')
    expect(text).toContain(`アプリのデータの形: ${CONNECTOR_MODEL}（一致）`)
    expect(text).toContain('取り込み: 完了')
  })
})

describe('書き込み（作るだけ）', () => {
  it('推敲案: 端末と同じ形の文書を作り、同じ内容は重複・削除したものは以前に削除', async () => {
    const fake = new FakeFirebase()
    const n = novel(['窓から見れる景色は美しい。\n見れる人は少ない。'])
    const { core, clock } = await pairedCore(fake, n.data)
    const input = {
      title_id: n.titleId,
      run_label: 'ワードサーチ',
      covered: ['#1'],
      items: [
        { piece: '#1', excerpt: '見れる景色', category: 'ra_nuki', suggestion: '見られる景色', reason: 'ら抜き', important: true },
        { piece: '#1', excerpt: '存在しない', category: 'typo', reason: 'x' },
      ],
    }
    const r = await core.callTool('novel_add_proofreading', input)
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('追加 1件')
    expect(r.text).toContain('見つからない 1件')
    expect(r.structured).toMatchObject({ created: [{ id: expect.stringMatching(/^x:/) }], skipped: [{ index: 1, reason: 'not_found' }] })
    const docs = fake.recordDocs(OWNER).filter((d) => d.name.includes('/proofSuggestions:'))
    expect(docs).toHaveLength(1)
    const f = docs[0].fields
    expect(Object.keys(f).sort()).toEqual(['chunks', 'deleted', 'device', 'hash', 'id', 'json', 'table', 'updated'])
    expect(f.device).toEqual({ stringValue: 'claude-connector' })
    const doc = {
      table: 'proofSuggestions',
      id: f.id.stringValue,
      json: f.json.stringValue,
      chunks: 0,
      deleted: false,
      hash: f.hash.stringValue,
      updated: null,
      device: 'claude-connector',
    } as unknown as RecordDoc
    expect(decodeRecord(doc, () => undefined)).toMatchObject({ flagged: true, source: 'claude', category: 'ra_nuki', v: 1 })
    expect(fake.recordDocs(OWNER).filter((d) => d.name.includes('/proofBatches:'))).toHaveLength(1)
    // 同じ内容をもう一度: 増えない
    const again = await core.callTool('novel_add_proofreading', input)
    expect(again.text).toContain('重複 1件')
    expect(fake.recordDocs(OWNER).filter((d) => d.name.includes('/proofSuggestions:'))).toHaveLength(1)
    // 端末で削除（削除の印）してからもう一度: 以前に削除
    fake.tombstone(OWNER, 'proofSuggestions', f.id.stringValue as string)
    clock.now += 20_000
    const third = await core.callTool('novel_add_proofreading', input)
    expect(third.text).toContain('以前に削除 1件')
  })

  it('長い批評の結果（前の上限 60,000字を超える）も、1件が 200,000字に入れば作る。超えれば作らず、何件に分けるかを返す', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core, clock } = await pairedCore(fake, n.data)
    const docs = () => fake.recordDocs(OWNER).filter((d) => d.name.includes('/critiqueResults:'))
    const para = (label: string) => `${label}の段落。${'あ'.repeat(93)}\n`
    const long = (label: string, chars: number) => para(label).repeat(Math.ceil(chars / 100)).slice(0, chars)
    const ok = await core.callTool('novel_add_critique_result', { title_id: n.titleId, result_markdown: long('一回目', 150_000) })
    expect(ok.isError).toBeUndefined()
    expect(ok.text).toContain('追加 1件')
    expect(docs()).toHaveLength(1)
    expect((docs()[0].fields.json.stringValue as string).length).toBeLessThanOrEqual(200_000)

    const markdown = long('批評', 250_000)
    const big = await core.callTool('novel_add_critique_result', { title_id: n.titleId, result_markdown: markdown })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('批評の結果が大きすぎて1件の記録に入りません（コネクタが書ける記録は JSON にして 200,000字まで。いま 2')
    expect(big.text).toContain('novel_add_critique_result を分けて呼んでください')
    expect(big.structured).toMatchObject({ created: [], skipped: [{ index: 0, reason: 'invalid' }] })
    expect(docs()).toHaveLength(1)
    // 言われたとおりに分ければ、どれも作れる
    const k = Number(/result_markdown を(\d+)つ以上に分け/.exec(big.text)![1])
    expect(k).toBeGreaterThanOrEqual(2)
    const size = Math.ceil(markdown.length / k)
    for (let i = 0; i < k; i++) {
      // Claude は1つ目から順に、少しずつ時間をおいて送る
      clock.now += 1_000
      const part = await core.callTool('novel_add_critique_result', {
        title_id: n.titleId,
        result_markdown: `（${i + 1}/${k}）\n${markdown.slice(i * size, (i + 1) * size)}`,
      })
      expect(part.text).toContain('追加 1件')
    }
    expect(docs()).toHaveLength(1 + k)
    // 一覧（novel_get_critique）では、分けた部分が（1/k）から読む順に並ぶ（新しい順のままだと（k/k）が先になる）
    const listed = (await core.callTool('novel_get_critique', { title_id: n.titleId })).text
    const order = [...listed.matchAll(/（(\d+)\/\d+）/g)].map((m) => Number(m[1]))
    expect(order).toEqual(Array.from({ length: k }, (_, i) => i + 1))
    expect(listed.indexOf(`（${k}/${k}）`)).toBeLessThan(listed.indexOf('一回目の段落'))
  })

  it('同時に同じ呼び出しが来ても1つしか作らない', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core } = await pairedCore(fake, n.data)
    const input = { title_id: n.titleId, items: [{ heading: '構成', body: '第2幕を前に' }] }
    const [a, b] = await Promise.all([core.callTool('novel_add_revision_ideas', input), core.callTool('novel_add_revision_ideas', input)])
    expect([a.text, b.text].filter((t) => t.includes('追加 1件'))).toHaveLength(1)
    expect([a.text, b.text].filter((t) => t.includes('重複 1件'))).toHaveLength(1)
    expect(fake.recordDocs(OWNER).filter((d) => d.name.includes('/revisionIdeas:'))).toHaveLength(1)
  })

  it('もうある文書（409）は読み直して重複にする', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core } = await pairedCore(fake, n.data)
    const input = { title_id: n.titleId, heading: '公募', body: '本文' }
    // 別の経路（貼り付けの端末）が同じ id の記録を先に作った
    const first = await core.callTool('novel_add_strategy_note', input)
    expect(first.text).toContain('追加 1件')
    const id = (first.structured as { created: { id: string }[] }).created[0].id
    expect(id).toMatch(/^g:/)
    fake.failNextCommit = { status: 409, code: 'ALREADY_EXISTS' }
    const r = await core.callTool('novel_add_critique_result', { title_id: n.titleId, result_markdown: '良い' })
    expect(r.text).toContain('追加 1件')
  })

  it('「書き込みを許可」が外れている・データの形が違う時は書き込まない（読むのは続く）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core, uid, clock } = await pairedCore(fake, n.data, { writes: false })
    const input = { title_id: n.titleId, items: [{ heading: 'a', body: 'b' }] }
    const off = await core.callTool('novel_add_revision_ideas', input)
    expect(off.isError).toBe(true)
    expect(off.text).toContain('書き込みは停止中')
    expect((await core.callTool('novel_list_titles', {})).isError).toBeUndefined()
    fake.setConnector({ uid, pairing: 'x'.repeat(64), writes: true, pairedAt: clock.now })
    fake.setAppModel(OWNER, CONNECTOR_MODEL + 1)
    clock.now += 61_000
    const model = await core.callTool('novel_add_revision_ideas', input)
    expect(model.isError).toBe(true)
    expect(model.text).toContain('コネクタを更新')
  })

  it('連携の記録が消されたら、ツールは 401（auth）を返す', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core, clock } = await pairedCore(fake, n.data)
    fake.setConnector(null)
    clock.now += 20_000
    const r = await core.callTool('novel_list_titles', {})
    expect(r.auth).toBe(true)
    expect(r.text).toContain('連携が解除')
    expect(core.pairingState()).toBe('unpaired')
  })

  it('匿名のアカウントが無効にされたら identity_lost（401）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    const { core, uid, clock } = await pairedCore(fake, n.data)
    fake.disableUser(uid)
    fake.expireTokens()
    clock.now += 2 * 3_600_000
    const r = await core.callTool('novel_list_titles', {})
    expect(r.auth).toBe(true)
    expect(core.identity.uid()).toBeNull()
  })
})

describe('数の上限（太平洋時間の日ごと）', () => {
  it('読み取りの枠を使い切ると止め、回復の時刻を日本時間で出す（11/1 から17時）', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文'])
    // 2026-10-31 12:00 JST（太平洋時間 10/30 20:00・夏時間）
    const clock = { now: Date.UTC(2026, 9, 31, 3, 0, 0) }
    const { core } = await pairedCore(fake, n.data, { clock, config: { dailyReadBudget: 60 } })
    let last = ''
    for (let i = 0; i < 30; i++) {
      clock.now += 20_000
      const r = await core.callTool('novel_list_titles', {})
      last = r.text
      if (r.isError || r.text.includes('読み取り枠')) break
    }
    // 取り込み済みの内容は出し、最新の変更を取り込めていないことを知らせる
    expect(last).toContain('読み取り枠を使い切った')
    expect(last).toContain('日本時間16時')
    // 書き込みは最新を読めないので止める
    const w = await core.callTool('novel_add_revision_ideas', { title_id: n.titleId, items: [{ heading: 'a', body: 'b' }] })
    expect(w.isError).toBe(true)
    expect(w.text).toContain('読み取り枠を使い切りました')
    // 11/1 の 18:00 JST（太平洋時間 11/1 2:00・冬時間に切り替わった後）: 次は17時
    clock.now = Date.UTC(2026, 10, 1, 9, 0, 0)
    const status = await call(core, 'novel_status')
    expect(status).toContain('明日の日本時間17時')
  })
})

describe('Firebase の無料枠を使い切った時', () => {
  it('読むツールは前に取り込んだ内容で答え、書き込みは止める', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, clock } = await pairedCore(fake, n.data)
    fake.exhausted = true
    clock.now += 20_000
    const r = await core.callTool('novel_list_titles', {})
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('前に取り込んだ内容')
    expect(r.text).toContain('『星の庭』')
    const w = await core.callTool('novel_add_revision_ideas', { title_id: n.titleId, items: [{ heading: '案', body: '本文' }] })
    expect(w.isError).toBe(true)
    expect(w.text).toContain('無料枠')
    // 写しを新しくする続き（alarm）は、枠が戻るまで待つ
    const next = await core.alarm()
    expect(next === null || next - clock.now > 60 * 60_000).toBe(true)
  })
})

describe('ログ', () => {
  it('原稿の本文・トークンをログに出さない', async () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
    try {
      const fake = new FakeFirebase()
      const secretText = '誰にも見せない秘密の一文'
      const n = novel([`${secretText}\n二段落目`])
      const { core } = await pairedCore(fake, n.data)
      await core.callTool('novel_read_text', { title_id: n.titleId })
      await core.callTool('novel_add_proofreading', {
        title_id: n.titleId,
        items: [{ piece: '#1', excerpt: '秘密の一文', category: 'typo', reason: secretText }],
      })
      await core.callTool('novel_search_text', { title_id: n.titleId, query: '([' , mode: 'regex' })
    } finally {
      console.log = orig
    }
    const all = lines.join('\n')
    expect(all).not.toContain('秘密')
    expect(all).not.toMatch(/idtoken-|refresh-anon/)
    expect(all).not.toContain(SECRET)
  })
})

describe('空のデータ', () => {
  it('タイトルが無くても答える', async () => {
    const fake = new FakeFirebase()
    const { core } = await pairedCore(fake, emptyData())
    expect(await call(core, 'novel_list_titles')).toContain('（ありません')
  })
})
