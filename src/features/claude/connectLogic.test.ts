import { describe, expect, it, vi } from 'vitest'
import {
  approvePairing,
  base64url,
  callbackUrl,
  connectorMcpUrl,
  fetchIdentity,
  normalizeOrigin,
  pairingHash,
  parseConnectorDoc,
  parseIdentity,
  prepareConnect,
  randomPairingKey,
  validState,
  type ConnectorWrite,
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
  const written: ConnectorWrite[] = []
  const access: [string, string][] = []
  let navigated = ''
  const d: PairingDeps = {
    origin: ORIGIN,
    writeConnector: vi.fn(async (doc: ConnectorWrite) => {
      calls.push('write')
      written.push(doc)
    }),
    setAccess: (titleId, a) => {
      calls.push('access')
      access.push([titleId, a])
    },
    flush: vi.fn(async () => {
      calls.push('flush')
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
    })
    expect(r.ok).toBe(true)
    const k = 'K'.repeat(43)
    expect(t.written).toEqual([{ uid: 'anonUid123', pairing: await sha(`st-1.${k}`), approvedOn: 'Mac', writes: true, v: 1 }])
    expect(JSON.stringify(t.written)).not.toContain(k)
    expect(t.access).toEqual([['t1', 'read']])
    // タイトルの設定 → 連携の記録 → 送信 → 移動 の順
    expect(t.calls).toEqual(['access', 'write', 'flush', 'navigate'])
    const url = new URL(t.navigated())
    expect(url.origin).toBe(ORIGIN)
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('k')).toBe(k)
  })

  it('書き込みを許可しない時は writes: false', async () => {
    const t = deps()
    await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: false, access: [] })
    expect(t.written[0].writes).toBe(false)
  })

  it('コネクタのアカウントが持ち主と同じ・印が正しくない・場所が無い時は何も書かない', async () => {
    for (const [over, input] of [
      [{}, { state: 's', identity: { ...identity, uid: 'owner' }, ownerUid: 'owner' }],
      [{}, { state: 'a b', identity, ownerUid: 'owner' }],
      [{ origin: '' }, { state: 's', identity, ownerUid: 'owner' }],
    ] as const) {
      const t = deps(over)
      const r = await approvePairing(t.d, { ...input, writes: true, access: [] })
      expect(r.ok).toBe(false)
      expect(t.calls).toEqual([])
    }
  })

  it('記録できなければ移らない（アクセスルールが古い時の説明）', async () => {
    const t = deps({
      writeConnector: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission-denied' })
      },
    })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('アクセスルール')
    expect(t.calls).not.toContain('navigate')
  })

  it('送れなくても（10秒で諦めて）移る', async () => {
    const t = deps({ flush: async () => Promise.reject(new Error('offline')) })
    const r = await approvePairing(t.d, { state: 's', identity, ownerUid: 'o', writes: true, access: [] })
    expect(r.ok).toBe(true)
    expect(t.calls).toContain('navigate')
  })
})

describe('連携の記録を読む', () => {
  it('サーバー時刻・書き込みの可否', () => {
    expect(
      parseConnectorDoc({ uid: 'u', pairing: 'p', pairedAt: { toMillis: () => 123 }, approvedOn: 'Mac', writes: true, v: 1 }),
    ).toEqual({ uid: 'u', pairedAt: 123, approvedOn: 'Mac', writes: true })
    expect(parseConnectorDoc({ uid: 'u', writes: 'yes' })).toEqual({ uid: 'u', pairedAt: null, approvedOn: '', writes: false })
    expect(parseConnectorDoc({})).toBeNull()
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
      cancelled: () => false,
      onStep: (s) => steps.push(s),
      ...over,
    }
    return { d, steps, asked }
  }

  it('持ち主なら同期を待ってから、ビルドの時に決めた origin にだけ問い合わせる', async () => {
    const t = prep()
    expect(await prepareConnect(t.d, 'owner')).toEqual({ step: 'ready', identity, ownerUid: 'owner' })
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
    const r = await approvePairing(t.d, { state: F.state, identity: F.identity, ownerUid: 'owner', writes: true, access: [] })
    expect(r).toEqual({ ok: true, url: F.callbackUrl })
    expect(t.written[0].pairing).toBe(F.hash)
    expect(t.written[0].uid).toBe(F.identity.uid)
  })

  it('作った k の形が違えば何も書かない', async () => {
    const t = deps({ randomKey: () => 'short' })
    const r = await approvePairing(t.d, { state: F.state, identity, ownerUid: 'owner', writes: true, access: [] })
    expect(r.ok).toBe(false)
    expect(t.calls).toEqual([])
  })
})
