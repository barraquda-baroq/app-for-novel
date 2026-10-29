// Vault の中身（身元・連携・写し・ツール・書き込み）を、小さな Firebase（fetch の差し替え）で確かめる。
import { describe, expect, it } from 'vitest'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { emptyData } from '../../../src/domain/types'
import { addPrologue, novel, splitEpisode } from '../../../src/test/claudeFixture'
import { pairingHash } from '../../src/vault/crypto'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, SECRET, call, makeCore, pairedCore } from '../support/harness'

describe('コネクタの身元（匿名のアカウント）', () => {
  it('初めて要る時に作り、更新用トークンは暗号化して保存する', async () => {
    const fake = new FakeFirebase()
    const { core, sql } = makeCore(fake)
    const a = await core.connectIdentity()
    expect(a.uid).toMatch(/^anon/)
    expect(a.model).toBe(3)
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
    fake.setAppModel(OWNER, 3)
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
    expect(core.grantCurrent(old)).toBe(true)
    expect((await core.callTool('novel_list_titles', {}, { grant: old })).isError).toBeFalsy()
    // 解除（記録を消す）→ 別の Claude のアカウントで連携し直す（作り直した記録は作られた時刻が変わる）
    fake.setConnector(null)
    clock.now += 1_000
    const hash = await pairingHash('state-2', 'm'.repeat(43))
    fake.setConnector({ uid, pairing: hash, writes: true, pairedAt: clock.now })
    const r = await core.verifyPairing(hash)
    if (!r.ok) throw new Error(r.reason)
    expect(r.gen).not.toBe(gen)
    expect(core.grantCurrent(old)).toBe(false)
    for (const tool of ['novel_status', 'novel_list_titles', 'novel_add_revision_ideas']) {
      const res = await core.callTool(tool, { title_id: n.titleId, items: [{ heading: '案', body: '本文' }] }, { grant: old })
      expect(res, tool).toMatchObject({ isError: true, auth: true })
    }
    const fresh = { ownerUid: OWNER, gen: r.gen }
    expect(core.grantCurrent(fresh)).toBe(true)
    expect(await call(core, 'novel_list_titles')).toContain('『星の庭』')
    expect((await core.callTool('novel_list_titles', {}, { grant: fresh })).isError).toBeFalsy()
    // 持ち主が違う許可・代の無い許可（前の版の許可）も使えない
    expect(core.grantCurrent({ ownerUid: 'other-owner', gen: r.gen })).toBe(false)
    expect(core.grantCurrent({ ownerUid: OWNER })).toBe(false)
    expect(core.grantCurrent(undefined)).toBe(false)
  })

  it('解除しないで上書き（別の Claude を足す）・「書き込みを許可」の切り替えでは、前の許可も使える', async () => {
    const fake = new FakeFirebase()
    const n = novel(['本文です。'])
    const { core, uid, clock } = await pairedCore(fake, n.data)
    const old = { ownerUid: OWNER, gen: core.pairing().gen! }
    const hash = await pairingHash('state-3', 'n'.repeat(43))
    fake.setConnector({ uid, pairing: hash, writes: false, pairedAt: clock.now })
    const r = await core.verifyPairing(hash)
    if (!r.ok) throw new Error(r.reason)
    expect(core.grantCurrent(old)).toBe(true)
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

  it('ゴミ箱・応募時の原稿の控え・どのタイトルにも属さないアイデアは見せない', async () => {
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

  it('状態（novel_status）', async () => {
    const fake = new FakeFirebase()
    const { core } = await pairedCore(fake, novel(['本文']).data)
    const text = await call(core, 'novel_status')
    expect(text).toContain('連携: 済み')
    expect(text).toContain('書き込み: 許可')
    expect(text).toContain('アプリのデータの形: 3（一致）')
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
    fake.setAppModel(OWNER, 4)
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
