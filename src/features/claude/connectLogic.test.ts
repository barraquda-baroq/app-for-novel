import { describe, expect, it, vi } from 'vitest'
import {
  addedConnectorDoc,
  approvePairing,
  base64url,
  callbackUrl,
  cleanNewConnectionName,
  connectionEntries,
  connectorMcpUrl,
  fetchIdentity,
  normalizeOrigin,
  pairingHash,
  parseConnectorDoc,
  parseIdentity,
  prepareConnect,
  randomPairingKey,
  removedConnectorDoc,
  renamedConnectorDoc,
  validState,
  ConnectionGoneError,
  ConnectionLimitError,
  CONNECTION_LIMIT_ERROR,
  CONNECTION_NAME_ERROR,
  IdentityChangedError,
  NOT_SENT_ERROR,
  type ConnectionApproval,
  type ConnectorStatus,
  type PairingDeps,
  type PrepareDeps,
} from './connectLogic'
import { PAIRING_FIXTURE as F } from '../../test/pairingFixture'

const ORIGIN = 'https://novel-studio-connector.example.workers.dev'
/** 実装とは別に crypto.subtle で数える（式が sha256hex(s + '.' + k) であることを確かめる） */
async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function deps(over: Partial<PairingDeps> = {}) {
  const calls: string[] = []
  const written: ConnectionApproval[] = []
  const access: [string, string][] = []
  let navigated = ''
  const d: PairingDeps = {
    origin: ORIGIN,
    addConnection: vi.fn(async (a: ConnectionApproval) => {
      calls.push('write')
      written.push(a)
    }),
    deleteConnector: vi.fn(async () => {
      calls.push('delete')
    }),
    setAccess: (titleId, a) => {
      calls.push('access')
      access.push([titleId, a])
    },
    flush: vi.fn(async () => {
      calls.push('flush')
      return true
    }),
    navigate: (url) => {
      calls.push('navigate')
      navigated = url
    },
    randomKey: () => 'K'.repeat(43),
    deviceLabel: () => 'Mac',
    ...over,
  }
  return { d, calls, written, access, navigated: () => navigated }
}

const identity = { uid: 'anonUid123', version: '1.0.0', model: 3 }
/** ［許可する］の入力の接続（画面を開いた時に作った id と名前） */
const conn = { cid: 'cabc123def456', name: '接続2' }

describe('コネクタの場所（ビルドの時に決める）', () => {
  it('https の origin だけを受け付ける（パス・引数・http は不可。開発中の localhost は可）', () => {
    expect(normalizeOrigin(' https://a.example.workers.dev/ ')).toBe('https://a.example.workers.dev')
    expect(normalizeOrigin('https://a.example.workers.dev/mcp')).toBe('')
    expect(normalizeOrigin('https://a.example.workers.dev/?x=1')).toBe('')
    expect(normalizeOrigin('http://a.example.workers.dev')).toBe('')
    expect(normalizeOrigin('javascript:alert(1)')).toBe('')
    expect(normalizeOrigin('https://user:pw@a.example.workers.dev')).toBe('')
    expect(normalizeOrigin('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeOrigin('')).toBe('')
    expect(connectorMcpUrl(ORIGIN)).toBe(`${ORIGIN}/mcp`)
  })

  it('連携の印 s は空白・制御文字の無い 1〜2048 文字', () => {
    expect(validState('abc-_.~XYZ019')).toBe('abc-_.~XYZ019')
    expect(validState('')).toBeNull()
    expect(validState(null)).toBeNull()
    expect(validState('a b')).toBeNull()
    expect(validState('a\nb')).toBeNull()
    expect(validState('x'.repeat(2049))).toBeNull()
  })

  it('コネクタへ戻る URL は state と k を引数として書く', () => {
    const url = new URL(callbackUrl(ORIGIN, 'st+/=&x', 'k_-1'))
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/pair/callback')
    expect(url.searchParams.get('state')).toBe('st+/=&x')
    expect(url.searchParams.get('k')).toBe('k_-1')
  })
})

describe('コネクタの匿名のアカウント（/connect/identity）', () => {
  it('答えの形を確かめる', () => {
    expect(parseIdentity({ uid: 'abcDEF_-123', version: '1.2', model: 3 })).toEqual({
      uid: 'abcDEF_-123',
      version: '1.2',
      model: 3,
    })
    expect(parseIdentity({ uid: 'abc', model: 'x' })).toEqual({ uid: 'abc', version: '', model: null })
    expect(parseIdentity({ uid: '' })).toBeNull()
    expect(parseIdentity({ uid: 'a/b' })).toBeNull()
    expect(parseIdentity(null)).toBeNull()
    expect(parseIdentity([])).toBeNull()
  })

  it('ビルドの時に決めた origin だけに、Cookie を付けずに問い合わせる', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ uid: 'anonUid', version: '1', model: 3 }), { status: 200 }))
    const r = await fetchIdentity(ORIGIN, fetchImpl as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, identity: { uid: 'anonUid', version: '1', model: 3 } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/connect/identity`)
    expect(init.credentials).toBe('omit')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
  })

  it('コネクタのエラー（匿名ログインが無効など）は短い説明にする', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'anonymous_disabled', message: '匿名ログインを有効にしてください' }), {
          status: 503,
        }),
    )
    const r = await fetchIdentity(ORIGIN, fetchImpl as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('匿名ログインを有効にしてください')
    const offline = await fetchIdentity(ORIGIN, (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch)
    expect(offline.ok).toBe(false)
    const bad = await fetchIdentity(ORIGIN, (async () => new Response('{"x":1}', { status: 200 })) as unknown as typeof fetch)
    expect(bad.ok).toBe(false)
    expect((await fetchIdentity('', vi.fn() as unknown as typeof fetch)).ok).toBe(false)
  })
})

describe('連携の鍵と指紋', () => {
  it('k は 32 バイトの乱数の base64url（43 文字）', () => {
    const k = randomPairingKey()
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomPairingKey()).not.toBe(k)
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-')
  })

  it("指紋は sha256hex(s + '.' + k)（コネクタと同じ式）", async () => {
    expect(await pairingHash('state1', 'key1')).toBe(await sha('state1.key1'))
    // 知られている値（SHA-256 の 'abc'）
    expect(await sha('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('［許可する］', () => {
  it('k は Firestore に書かず指紋だけを書き、送ってからコネクタへ移る', async () => {
    const t = deps()
    const r = await approvePairing(t.d, {
      state: 'st-1',
      identity,
      ownerUid: 'ownerUid',
      writes: true,
      access: [{ titleId: 't1', access: 'read' }],
      ...conn,
    })
    expect(r.ok).toBe(true)
    const k = 'K'.repeat(43)
    expect(t.written).toEqual([
      {
        uid: 'anonUid123',
        pairing: await sha(`st-1.${k}`),
        approvedOn: 'Mac',
        writes: true,
        cid: 'cabc123def456',
        name: '接続2',
        replaceCid: null,
      },
    ])
    expect(JSON.stringify(t.written)).not.toContain(k)
    expect(t.access).toEqual([['t1', 'read']])
    // タイトルの設定 → 送信（届いたのを確かめる）→ 連携の記録 → 移動 の順
    expect(t.calls).toEqual(['access', 'flush', 'write', 'navigate'])
    const url = new URL(t.navigated())
    expect(url.origin).toBe(ORIGIN)
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('k')).toBe(k)
  })

  it('書き込みを許可しない時は writes: false', async () => {
    const t = deps()
    await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: false, access: [], ...conn })
    expect(t.written[0].writes).toBe(false)
  })

  it('コネクタのアカウントが持ち主と同じ・印が正しくない・場所が無い時は何も書かない', async () => {
    for (const [over, input] of [
      [{}, { state: 's', identity: { ...identity, uid: 'owner' }, ownerUid: 'owner' }],
      [{}, { state: 'a b', identity, ownerUid: 'owner' }],
      [{ origin: '' }, { state: 's', identity, ownerUid: 'owner' }],
    ] as const) {
      const t = deps(over)
      const r = await approvePairing(t.d, { ...input, writes: true, access: [], ...conn })
      expect(r.ok).toBe(false)
      expect(t.calls).toEqual([])
    }
  })

  it('記録できなければ移らない（アクセスルールが古い時の説明）', async () => {
    const t = deps({
      addConnection: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission-denied' })
      },
    })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('アクセスルール')
    expect(t.calls).not.toContain('navigate')
  })

  it('送信待ちが届かなければ（時間切れ・失敗）連携を記録せず、移らない', async () => {
    for (const flush of [async () => false, async () => Promise.reject(new Error('offline'))]) {
      const t = deps({
        flush: async () => {
          t.calls.push('flush')
          return flush()
        },
      })
      // この画面で変えていなくても（やり直しの時は、変えた設定がもう端末内にあって送信待ちに残っていることがある）
      const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn })
      expect(r).toEqual({ ok: false, error: NOT_SENT_ERROR })
      expect(t.calls).toEqual(['flush'])
      expect(t.written).toEqual([])
    }
  })

  it('見せないにしたタイトルが届かなければ、連携を記録せず、移らない', async () => {
    const t = deps({
      flush: async () => {
        t.calls.push('flush')
        return false
      },
    })
    const r = await approvePairing(t.d, {
      state: 's',
      identity,
      ownerUid: 'o',
      writes: true,
      access: [{ titleId: 't1', access: 'none' }],
      ...conn,
    })
    expect(r.ok).toBe(false)
    expect(t.access).toEqual([['t1', 'none']])
    expect(t.calls).toEqual(['access', 'flush'])
    expect(t.calls).not.toContain('write')
    expect(t.calls).not.toContain('navigate')
    expect(t.navigated()).toBe('')
  })
})

/** Firestore の Timestamp の代わり（toMillis だけ） */
const ts = (ms: number) => ({ toMillis: () => ms })

describe('連携の記録を読む', () => {
  it('2.8 までの記録（v1）は c0「接続1」1つ。最後の許可の時刻・書き込みの可否', () => {
    expect(parseConnectorDoc({ uid: 'u', pairing: 'p', pairedAt: ts(123), approvedOn: 'Mac', writes: true, v: 1 })).toEqual({
      uid: 'u',
      pairedAt: 123,
      approvedOn: 'Mac',
      writes: true,
      connections: [{ cid: 'c0', name: '接続1', pairing: 'p', pairedAt: 123, approvedOn: 'Mac' }],
      pairingCid: 'c0',
    })
    expect(parseConnectorDoc({ uid: 'u', writes: 'yes' })).toMatchObject({
      uid: 'u',
      pairedAt: null,
      approvedOn: '',
      writes: false,
      pairingCid: 'c0',
    })
    expect(parseConnectorDoc({})).toBeNull()
  })

  it('2.9 の記録（v2）は接続の一覧（許可した時刻の順）。形の違う接続は外し、正しい接続が無ければ連携していない', () => {
    const doc = {
      uid: 'u',
      v: 2,
      pairing: 'p3',
      pairedAt: ts(300),
      approvedOn: 'iPhone',
      writes: false,
      pairingCid: 'cbbb',
      connections: {
        cbbb: { name: '仕事用', pairing: 'p3', pairedAt: ts(300), approvedOn: 'iPhone' },
        caaa: { name: '接続1', pairing: 'p1', pairedAt: ts(100), approvedOn: 'Mac' },
        'bad key': { name: 'x', pairing: 'x', pairedAt: ts(1), approvedOn: '' },
        cnot: 'map でない',
      },
    }
    const s = parseConnectorDoc(doc)!
    expect(s.connections.map((c) => [c.cid, c.name, c.pairedAt])).toEqual([
      ['caaa', '接続1', 100],
      ['cbbb', '仕事用', 300],
    ])
    expect(s).toMatchObject({ uid: 'u', pairedAt: 300, approvedOn: 'iPhone', writes: false, pairingCid: 'cbbb' })
    expect(parseConnectorDoc({ ...doc, pairingCid: 'X' })!.pairingCid).toBeNull()
    expect(parseConnectorDoc({ ...doc, connections: { 'bad key': {} } })).toBeNull()
    expect(parseConnectorDoc({ ...doc, connections: {} })).toBeNull()
  })
})

describe('接続の一覧を書き換える（トランザクションの中身）', () => {
  const SERVER = { server: true }
  const approval = (over: Partial<ConnectionApproval> = {}): ConnectionApproval => ({
    uid: 'anon',
    pairing: 'h-new',
    approvedOn: 'Mac',
    writes: true,
    cid: 'cnew',
    name: '接続2',
    replaceCid: null,
    ...over,
  })
  const v1 = { uid: 'anon', pairing: 'h-old', pairedAt: ts(100), approvedOn: 'iPad', writes: false, v: 1 }
  const entry = (name: string, pairing = `h-${name}`) => ({ name, pairing, pairedAt: ts(1), approvedOn: 'Mac' })
  const v2 = (n: number, over: Record<string, unknown> = {}) => ({
    uid: 'anon',
    v: 2,
    pairing: 'h-last',
    pairedAt: ts(5),
    approvedOn: 'Mac',
    writes: true,
    pairingCid: 'c1',
    connections: Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, entry(`接続${i + 1}`)])),
    ...over,
  })

  it('記録が無ければ、その接続1つの v2 の記録を作る（時刻はサーバー時刻）', () => {
    expect(addedConnectorDoc(null, approval(), SERVER)).toEqual({
      uid: 'anon',
      writes: true,
      v: 2,
      pairing: 'h-new',
      pairedAt: SERVER,
      approvedOn: 'Mac',
      pairingCid: 'cnew',
      connections: { cnew: { name: '接続2', pairing: 'h-new', pairedAt: SERVER, approvedOn: 'Mac' } },
    })
  })

  it('2.8 の記録（v1）は、その接続を c0「接続1」（指紋・時刻・端末はそのまま）として一覧に移してから足す', () => {
    const d = addedConnectorDoc(v1, approval({ writes: false }), SERVER)
    expect(d.connections).toEqual({
      c0: { name: '接続1', pairing: 'h-old', pairedAt: v1.pairedAt, approvedOn: 'iPad' },
      cnew: { name: '接続2', pairing: 'h-new', pairedAt: SERVER, approvedOn: 'Mac' },
    })
    expect(d).toMatchObject({ v: 2, pairing: 'h-new', pairedAt: SERVER, pairingCid: 'cnew', writes: false })
  })

  it('ほかの接続は読んだ値のまま残す。入れ替える接続・同じ id（やり直し）は外してから足す', () => {
    const cur = v2(3)
    const added = addedConnectorDoc(cur, approval(), SERVER)
    expect(Object.keys(added.connections as object)).toEqual(['c1', 'c2', 'c3', 'cnew'])
    expect((added.connections as Record<string, unknown>).c1).toEqual(cur.connections.c1)
    const replaced = addedConnectorDoc(cur, approval({ replaceCid: 'c2' }), SERVER)
    expect(Object.keys(replaced.connections as object)).toEqual(['c1', 'c3', 'cnew'])
    const retried = addedConnectorDoc(added, approval({ pairing: 'h-retry' }), SERVER)
    expect(Object.keys(retried.connections as object)).toEqual(['c1', 'c2', 'c3', 'cnew'])
    expect((retried.connections as Record<string, { pairing: string }>).cnew.pairing).toBe('h-retry')
  })

  it('10 あれば足さない（入れ替えなら足せる）。別のコネクタの記録なら身元が変わった', () => {
    expect(() => addedConnectorDoc(v2(10), approval(), SERVER)).toThrow(ConnectionLimitError)
    expect(Object.keys(addedConnectorDoc(v2(10), approval({ replaceCid: 'c4' }), SERVER).connections as object)).toHaveLength(10)
    // 入れ替える接続がもう無い（ほかの端末で解除した）: 10 のままなら足さない
    expect(() => addedConnectorDoc(v2(10), approval({ replaceCid: 'cgone' }), SERVER)).toThrow(ConnectionLimitError)
    // 形の違う項目は数えない（一覧に出ず、解除もできないため）
    const junk = v2(9, { connections: { ...v2(9).connections, 'BAD KEY': entry('x'), cjunk: 'x' } })
    expect(Object.keys(addedConnectorDoc(junk, approval(), SERVER).connections as object)).toHaveLength(10)
    expect(() => addedConnectorDoc({ ...v1, uid: 'other' }, approval(), SERVER)).toThrow(IdentityChangedError)
  })

  it('名前を変える: 身元・書き込み・最後の許可の指紋・時刻・接続はそのまま。2.8 の記録は c0 の一覧の形に移す', () => {
    const cur = v2(2, { writes: false })
    const d = renamedConnectorDoc(cur, 'c2', '  仕事用 ')
    expect(d).toEqual({ ...cur, connections: { ...cur.connections, c2: { ...cur.connections.c2, name: '仕事用' } } })
    expect(renamedConnectorDoc(v1, 'c0', '前の Mac')).toEqual({
      uid: 'anon',
      writes: false,
      v: 2,
      pairing: 'h-old',
      pairedAt: v1.pairedAt,
      approvedOn: 'iPad',
      pairingCid: 'c0',
      connections: { c0: { name: '前の Mac', pairing: 'h-old', pairedAt: v1.pairedAt, approvedOn: 'iPad' } },
    })
    expect(() => renamedConnectorDoc(cur, 'cgone', '名前')).toThrow(ConnectionGoneError)
    expect(() => renamedConnectorDoc(null, 'c1', '名前')).toThrow(ConnectionGoneError)
    expect(() => renamedConnectorDoc(cur, 'c1', ' ')).toThrow(CONNECTION_NAME_ERROR)
    expect(() => renamedConnectorDoc(cur, 'c1', 'あ'.repeat(21))).toThrow(CONNECTION_NAME_ERROR)
  })

  it('1つ解除する: 一覧から外す（最後に許可した接続でも、pairingCid はそのまま）。最後の1つなら記録を消す', () => {
    const cur = v2(2, { pairingCid: 'c2' })
    const r = removedConnectorDoc(cur, 'c2')
    expect(r).toEqual({ kind: 'set', doc: { ...cur, connections: { c1: cur.connections.c1 } } })
    expect(removedConnectorDoc(v2(1), 'c1')).toEqual({ kind: 'delete' })
    expect(removedConnectorDoc(v1, 'c0')).toEqual({ kind: 'delete' })
    expect(removedConnectorDoc(cur, 'cgone')).toEqual({ kind: 'none' })
    expect(removedConnectorDoc(null, 'c1')).toEqual({ kind: 'none' })
    // 正しい接続だけが残る（形の違う項目だけになれば、記録を消す）
    expect(removedConnectorDoc(v2(1, { connections: { c1: entry('a'), cjunk: 1 } }), 'c1')).toEqual({ kind: 'delete' })
  })

  it('記録の接続の map: v1 は c0、v2 は形の合うものだけ', () => {
    expect(connectionEntries(v1)).toEqual({ c0: { name: '接続1', pairing: 'h-old', pairedAt: v1.pairedAt, approvedOn: 'iPad' } })
    expect(connectionEntries({ ...v2(1), connections: 'x' })).toEqual({})
    expect(Object.keys(connectionEntries(v2(3)))).toEqual(['c1', 'c2', 'c3'])
  })

  it('接続の名前は前後の空白を除いて1〜20字（制御文字は不可）', () => {
    expect(cleanNewConnectionName(' 仕事用 ')).toBe('仕事用')
    expect(cleanNewConnectionName('あ'.repeat(20))).toBe('あ'.repeat(20))
    expect(cleanNewConnectionName('あ'.repeat(21))).toBeNull()
    expect(cleanNewConnectionName('　')).toBeNull()
    expect(cleanNewConnectionName('a\nb')).toBeNull()
  })
})

describe('［許可する］（2.9: 接続の一覧）', () => {
  it('名前が空・長すぎる・接続の id が正しくなければ、何も書かず送らない', async () => {
    for (const over of [{ name: '' }, { name: 'あ'.repeat(21) }, { cid: 'c0' }, { cid: 'X1' }]) {
      const t = deps()
      const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn, ...over })
      expect(r.ok).toBe(false)
      if (over.name !== undefined && !r.ok) expect(r.error).toBe(CONNECTION_NAME_ERROR)
      expect(t.calls).toEqual([])
    }
  })

  it('入れ替える接続を渡す', async () => {
    const t = deps()
    await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn, replaceCid: 'cold' })
    expect(t.written[0]).toMatchObject({ cid: 'cabc123def456', name: '接続2', replaceCid: 'cold' })
  })

  it('コネクタの身元が変わっていたら、記録を消してから新しく作る（1回だけ）', async () => {
    let n = 0
    const t = deps()
    t.d.addConnection = async (a) => {
      t.calls.push('write')
      if (n++ === 0) throw new IdentityChangedError()
      t.written.push(a)
    }
    const r = await approvePairing(t.d, {
      state: 's',
      identity,
      ownerUid: 'o',
      writes: true,
      access: [],
      ...conn,
      replaceCid: 'cold',
    })
    expect(r.ok).toBe(true)
    expect(t.calls).toEqual(['flush', 'write', 'delete', 'write', 'navigate'])
    expect(t.written[0]).toMatchObject({ cid: conn.cid, replaceCid: null })
    // 2回目も変わっていれば（同時に別の許可）、移らない
    const u = deps({
      addConnection: async () => {
        u.calls.push('write')
        throw new IdentityChangedError()
      },
    })
    expect((await approvePairing(u.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn })).ok).toBe(false)
    expect(u.calls).toEqual(['flush', 'write', 'delete', 'write'])
  })

  it('接続が10ある時は、入れ替えるか解除するように知らせ、移らない', async () => {
    const t = deps({
      addConnection: async () => {
        throw new ConnectionLimitError()
      },
    })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn })
    expect(r).toEqual({ ok: false, error: CONNECTION_LIMIT_ERROR })
    expect(CONNECTION_LIMIT_ERROR).toBe(
      '接続が10あります（同時に10まで）。入れ替える接続を選ぶか、一覧で1つ解除してから、もう一度［許可する］を押してください（連携はまだ記録していません）。',
    )
    expect(t.calls).not.toContain('navigate')
  })

  it('やり直し（記録に失敗した後）は同じ接続の id で足す（一覧に重ならない）', async () => {
    let fail = true
    const t = deps()
    t.d.addConnection = async (a) => {
      if (fail) {
        fail = false
        throw Object.assign(new Error('x'), { code: 'unavailable' })
      }
      t.written.push(a)
    }
    const input = { state: 's', identity, ownerUid: 'o', writes: true, access: [], ...conn }
    expect((await approvePairing(t.d, input)).ok).toBe(false)
    expect((await approvePairing(t.d, input)).ok).toBe(true)
    expect(t.written.map((a) => a.cid)).toEqual([conn.cid])
  })
})

describe('［許可する］の前の確かめ（持ち主・同期・コネクタの身元）', () => {
  function prep(over: Partial<PrepareDeps> = {}) {
    const steps: string[] = []
    const asked: string[] = []
    const d: PrepareDeps = {
      origin: ORIGIN,
      readOwnerUid: async () => 'owner',
      waitSynced: async () => true,
      fetchIdentity: async (origin) => {
        asked.push(origin)
        return { ok: true, identity }
      },
      readConnector: async () => null,
      dataModel: 3,
      cancelled: () => false,
      onStep: (s) => steps.push(s),
      ...over,
    }
    return { d, steps, asked }
  }

  it('持ち主なら同期を待ってから、ビルドの時に決めた origin にだけ問い合わせる', async () => {
    const t = prep()
    expect(await prepareConnect(t.d, 'owner')).toEqual({
      step: 'ready',
      identity,
      ownerUid: 'owner',
      existing: null,
      existingError: false,
    })
    expect(t.steps).toEqual(['checking', 'sync', 'identity'])
    expect(t.asked).toEqual([ORIGIN])
  })

  it('持ち主でない・持ち主が読めない・同期が終わらない時は、コネクタに問い合わせない', async () => {
    for (const [over, step] of [
      [{ readOwnerUid: async () => 'someone-else' }, 'notOwner'],
      [{ readOwnerUid: async () => Promise.reject(new Error('offline')) }, 'ownerError'],
      [{ waitSynced: async () => false }, 'syncTimeout'],
      [{ readOwnerUid: async () => null }, 'noOwner'],
      [{ cancelled: () => true }, 'cancelled'],
    ] as const) {
      const t = prep(over)
      expect((await prepareConnect(t.d, 'owner')).step).toBe(step)
      expect(t.asked).toEqual([])
    }
  })

  it('初めての同期で持ち主が記録されたら、もう一度読んで確かめる', async () => {
    let n = 0
    const t = prep({ readOwnerUid: async () => (n++ === 0 ? null : 'owner') })
    expect((await prepareConnect(t.d, 'owner')).step).toBe('ready')
    let m = 0
    const u = prep({ readOwnerUid: async () => (m++ === 0 ? null : 'someone-else') })
    expect((await prepareConnect(u.d, 'owner')).step).toBe('notOwner')
    expect(u.asked).toEqual([])
  })

  it('いまの連携の記録（接続の一覧）を渡す。読めなくても許可はできる', async () => {
    const existing: ConnectorStatus = {
      uid: 'anonUid123',
      pairedAt: 1,
      approvedOn: 'Mac',
      writes: false,
      connections: [{ cid: 'c0', name: '接続1', pairing: 'p', pairedAt: 1, approvedOn: 'Mac' }],
      pairingCid: 'c0',
    }
    const t = prep({ readConnector: async () => existing })
    expect(await prepareConnect(t.d, 'owner')).toMatchObject({ step: 'ready', existing, existingError: false })
    const u = prep({ readConnector: async () => Promise.reject(new Error('offline')) })
    expect(await prepareConnect(u.d, 'owner')).toMatchObject({ step: 'ready', existing: null, existingError: true })
  })

  it('コネクタのデータの形がこのアプリより古い・分からない時は許可させない（記録も読まない）', async () => {
    for (const model of [2, null]) {
      const readConnector = vi.fn(async () => null)
      const t = prep({ fetchIdentity: async () => ({ ok: true, identity: { ...identity, model } }), readConnector })
      expect(await prepareConnect(t.d, 'owner')).toEqual({ step: 'connectorOld', identity: { ...identity, model } })
      expect(readConnector).not.toHaveBeenCalled()
    }
    // 新しい版のコネクタ（アプリが古い）は許可できる（画面で書き込めないことを知らせる）
    const newer = prep({ fetchIdentity: async () => ({ ok: true, identity: { ...identity, model: 4 } }) })
    expect((await prepareConnect(newer.d, 'owner')).step).toBe('ready')
  })

  it('コネクタの身元が持ち主と同じアカウント・答えられない時は先へ進まない', async () => {
    const same = prep({ fetchIdentity: async () => ({ ok: true, identity: { ...identity, uid: 'owner' } }) })
    expect((await prepareConnect(same.d, 'owner')).step).toBe('identityError')
    const down = prep({ fetchIdentity: async () => ({ ok: false, error: '匿名ログインが無効です' }) })
    expect(await prepareConnect(down.d, 'owner')).toEqual({ step: 'identityError', error: '匿名ログインが無効です' })
  })
})

describe('コネクタと同じ値（src/test/pairingFixture.ts）', () => {
  it('印・k・指紋・戻る URL がコネクタの確かめと同じになる', async () => {
    const t = deps({ origin: F.connectorOrigin, randomKey: () => F.k })
    const r = await approvePairing(t.d, {
      state: F.state,
      identity: F.identity,
      ownerUid: 'owner',
      writes: true,
      access: [],
      ...conn,
    })
    expect(r).toEqual({ ok: true, url: F.callbackUrl })
    expect(t.written[0].pairing).toBe(F.hash)
    expect(t.written[0].uid).toBe(F.identity.uid)
  })

  it('作った k の形が違えば何も書かない', async () => {
    const t = deps({ randomKey: () => 'short' })
    const r = await approvePairing(t.d, { state: F.state, identity, ownerUid: 'owner', writes: true, access: [], ...conn })
    expect(r.ok).toBe(false)
    expect(t.calls).toEqual([])
  })
})
