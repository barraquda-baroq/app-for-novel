// テスト用の小さな Firebase（Auth の REST・Firestore の REST の、コネクタが使う部分だけ）。fetch として渡す。
// - 文書は名前の順・updated（サーバー時刻）の順に並ぶ。1回の commit の書き込みはすべて同じ時刻
// - アクセスルールの要点だけをまねる: コネクタ（config/connector の uid）は読める・8つの表に作るだけ（writes の時だけ）
// 本物のアクセスルールとの合わせは、エミュレーターの結合テスト（test/emu）で確かめる。
import { encodeRecord, splitJson } from '../../../src/sync/codec'
import type { Rec } from '../../../src/sync/merge'

type Value = Record<string, unknown>

interface Doc {
  name: string
  fields: Record<string, Value>
  updateTime: string
  createTime: string
}

export interface FakeFirebaseOptions {
  project?: string
  anonymousDisabled?: boolean
}

const CLAUDE_TABLES = new Set([
  'proofSuggestions',
  'proofBatches',
  'revisionIdeas',
  'strategyNotes',
  'critiquePrompts',
  'critiqueResults',
  'benchWorks',
  'benchAnalyses',
])

export class FakeFirebase {
  readonly project: string
  readonly root: string
  readonly docs = new Map<string, Doc>()
  /** 呼ばれた回数（Firestore の操作ごと） */
  readonly calls: { op: string; status: number }[] = []
  anonymousDisabled: boolean
  /** 次の commit を、この状態で失敗させる（テスト用） */
  failNextCommit: { status: number; code: string } | null = null
  /** Firebase の1日の無料枠を使い切った（Firestore の呼び出しはすべて 429 RESOURCE_EXHAUSTED） */
  exhausted = false
  #clockUs = Date.UTC(2026, 9, 29, 0, 0, 0) * 1000
  #users = new Map<string, { refresh: string; disabled?: boolean }>()
  #tokens = new Map<string, string>()
  #seq = 0

  constructor(opts: FakeFirebaseOptions = {}) {
    this.project = opts.project ?? 'novel-studio-3352e'
    this.root = `projects/${this.project}/databases/(default)/documents`
    this.anonymousDisabled = opts.anonymousDisabled ?? false
  }

  readonly identityUrl = 'http://fake-auth/identitytoolkit.googleapis.com/v1'
  readonly tokenUrl = 'http://fake-auth/securetoken.googleapis.com/v1'
  readonly firestoreUrl = 'http://fake-fs/v1'

  #tick(): string {
    this.#clockUs += 1000 + Math.floor(Math.random() * 10)
    return isoMicros(this.#clockUs)
  }

  /** 同じ時刻の書き込みを作る（テスト用） */
  sameTime(): string {
    return isoMicros(this.#clockUs)
  }

  name(path: string): string {
    return `${this.root}/${path}`
  }

  // ---------- 端末・持ち主の側の操作（テストの用意） ----------

  setOwner(uid: string): void {
    this.#write([{ path: 'config/owner', fields: { uid: s(uid) } }])
  }

  setConnector(c: { uid: string; pairing: string; writes?: boolean; pairedAt?: number } | null): void {
    if (!c) {
      this.docs.delete(this.name('config/connector'))
      return
    }
    this.#write([
      {
        path: 'config/connector',
        fields: {
          uid: s(c.uid),
          pairing: s(c.pairing),
          pairedAt: { timestampValue: new Date(c.pairedAt ?? Date.now()).toISOString() },
          approvedOn: s('テストの端末'),
          writes: { booleanValue: c.writes ?? true },
          v: { integerValue: '1' },
        },
      },
    ])
  }

  setAppModel(owner: string, model: number | null): void {
    if (model === null) this.docs.delete(this.name(`users/${owner}/meta/app`))
    else
      this.#write([
        {
          path: `users/${owner}/meta/app`,
          fields: { model: { integerValue: String(model) }, appVersion: s('2.3'), updatedAt: { timestampValue: this.sameTime() } },
        },
      ])
  }

  /** 端末と同じ形で記録を書く（大きければ分割文書も同じ時刻で） */
  putRecord(owner: string, table: string, rec: Rec, opts: { device?: string; chunkSize?: number; reset?: boolean } = {}): string {
    return this.#write(this.#recordWrites(owner, table, rec, opts))
  }

  /** いくつもの記録を1回の書き込み（同じ時刻）で */
  putMany(owner: string, items: { table: string; rec: Rec }[], opts: { device?: string; chunkSize?: number } = {}): string {
    return this.#write(items.flatMap((it) => this.#recordWrites(owner, it.table, it.rec, opts)))
  }

  #recordWrites(
    owner: string,
    table: string,
    rec: Rec,
    opts: { device?: string; chunkSize?: number; reset?: boolean },
  ): { path: string; fields: Record<string, Value> }[] {
    const enc = encodeRecord(rec, opts.chunkSize)
    const docId = `${table}:${rec.id}`
    const parts = enc.json === null ? splitJson(stableJson(rec), opts.chunkSize) : []
    const writes: { path: string; fields: Record<string, Value> }[] = [
      {
        path: `users/${owner}/records/${docId}`,
        fields: {
          table: s(table),
          id: s(rec.id),
          json: enc.json === null ? { nullValue: null } : s(enc.json),
          chunks: { integerValue: String(parts.length) },
          deleted: { booleanValue: false },
          hash: s(enc.hash),
          device: s(opts.device ?? 'device-a'),
          ...(opts.reset ? { reset: { booleanValue: true } } : {}),
        },
      },
      ...parts.map((json, i) => ({
        path: `users/${owner}/records/${docId}#${i}`,
        fields: {
          table: s('_chunk'),
          parent: s(docId),
          index: { integerValue: String(i) },
          json: s(json),
          hash: s(enc.hash),
          device: s(opts.device ?? 'device-a'),
          deleted: { booleanValue: false },
        },
      })),
    ]
    return writes
  }

  /** 端末と同じ削除の印 */
  tombstone(owner: string, table: string, id: string, device = 'device-a'): string {
    const docId = `${table}:${id}`
    for (const k of [...this.docs.keys()]) if (k.startsWith(this.name(`users/${owner}/records/${docId}#`))) this.docs.delete(k)
    return this.#write([
      {
        path: `users/${owner}/records/${docId}`,
        fields: {
          table: s(table),
          id: s(id),
          json: { nullValue: null },
          chunks: { integerValue: '0' },
          deleted: { booleanValue: true },
          hash: s(''),
          device: s(device),
        },
      },
    ])
  }

  #write(writes: { path: string; fields: Record<string, Value> }[]): string {
    const t = this.#tick()
    for (const w of writes) {
      const name = this.name(w.path)
      const prev = this.docs.get(name)
      this.docs.set(name, { name, fields: { ...w.fields, updated: { timestampValue: t } }, updateTime: t, createTime: prev?.createTime ?? t })
    }
    return t
  }

  /** 記録の文書の中身（テストで確かめる） */
  record(owner: string, docId: string): Record<string, unknown> | null {
    const d = this.docs.get(this.name(`users/${owner}/records/${docId}`))
    if (!d) return null
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d.fields)) out[k] = Object.values(v)[0]
    return out
  }

  recordDocs(owner: string): Doc[] {
    const prefix = this.name(`users/${owner}/records/`)
    return [...this.docs.values()].filter((d) => d.name.startsWith(prefix))
  }

  // ---------- fetch ----------

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const body = typeof init?.body === 'string' ? init.body : ''
    // ホストではなくパスで分ける（Workers のテストではエミュレーターと同じ形の URL で呼ばれる）
    if (/\/(identitytoolkit|securetoken)\.googleapis\.com\/v1\//.test(url.pathname)) return this.#auth(url, body)
    if (url.pathname.startsWith('/v1/projects/')) {
      if (this.exhausted) {
        this.calls.push({ op: url.pathname.split(':').pop() ?? '', status: 429 })
        return jsonRes({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }, 429)
      }
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      const uid = this.#tokens.get(auth.replace(/^Bearer /, '')) ?? null
      const res = this.#firestore(decodeURIComponent(url.pathname.replace(/^\/v1\//, '')), JSON.parse(body || '{}'), uid)
      this.calls.push({ op: url.pathname.split(':').pop() ?? '', status: res.status })
      return res
    }
    return new Response('not found', { status: 404 })
  }

  #auth(url: URL, body: string): Response {
    if (url.pathname.endsWith('/accounts:signUp')) {
      if (this.anonymousDisabled) return jsonRes({ error: { code: 400, message: 'OPERATION_NOT_ALLOWED' } }, 400)
      const uid = `anon${++this.#seq}`
      const refresh = `refresh-${uid}-${this.#seq}`
      this.#users.set(uid, { refresh })
      const idToken = `idtoken-${uid}-${++this.#seq}`
      this.#tokens.set(idToken, uid)
      return jsonRes({ localId: uid, idToken, refreshToken: refresh, expiresIn: '3600' })
    }
    if (url.pathname.endsWith('/token')) {
      const p = new URLSearchParams(body)
      const refresh = p.get('refresh_token')
      const entry = [...this.#users.entries()].find(([, u]) => u.refresh === refresh)
      if (!entry) return jsonRes({ error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } }, 400)
      if (entry[1].disabled) return jsonRes({ error: { code: 400, message: 'USER_DISABLED' } }, 400)
      const idToken = `idtoken-${entry[0]}-${++this.#seq}`
      this.#tokens.set(idToken, entry[0])
      return jsonRes({ id_token: idToken, refresh_token: refresh, expires_in: '3600', user_id: entry[0] })
    }
    return jsonRes({ error: { message: 'NOT_FOUND' } }, 404)
  }

  /** 匿名のアカウントを消す（更新用トークンが使えなくなる） */
  disableUser(uid: string): void {
    const u = this.#users.get(uid)
    if (u) u.disabled = true
  }

  /** ID トークンを使えなくする（401 を返す） */
  expireTokens(): void {
    this.#tokens.clear()
  }

  #ownerUid(): string | null {
    const d = this.docs.get(this.name('config/owner'))
    return (d?.fields.uid?.stringValue as string | undefined) ?? null
  }

  #connector(): { uid: string; writes: boolean } | null {
    const d = this.docs.get(this.name('config/connector'))
    if (!d) return null
    return { uid: d.fields.uid?.stringValue as string, writes: d.fields.writes?.booleanValue === true }
  }

  /** 読めるか（アクセスルールの要点） */
  #canRead(path: string, uid: string | null): boolean {
    if (!uid) return false
    if (path === 'config/owner') return true
    const conn = this.#connector()
    if (path === 'config/connector') return conn !== null && conn.uid === uid
    const owner = this.#ownerUid()
    const m = /^users\/([^/]+)\//.exec(path)
    if (!m || m[1] !== owner) return false
    return owner === uid || (conn !== null && conn.uid === uid)
  }

  #firestore(path: string, body: Record<string, unknown>, uid: string | null): Response {
    if (!uid) return jsonRes({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'token' } }, 401)
    if (path.endsWith(':batchGet')) {
      const names = (body.documents as string[]) ?? []
      for (const n of names) if (!this.#canRead(n.slice(this.root.length + 1), uid)) return denied()
      return jsonRes(names.map((n) => (this.docs.has(n) ? { found: this.docs.get(n), readTime: this.sameTime() } : { missing: n, readTime: this.sameTime() })))
    }
    if (path.endsWith(':runQuery') || path.endsWith(':runAggregationQuery')) {
      const parent = path.slice(this.root.length + 1).replace(/:run(Aggregation)?Query$/, '')
      if (!this.#canRead(`${parent}/records/x`, uid)) return denied()
      const q = (path.endsWith(':runQuery') ? body.structuredQuery : (body.structuredAggregationQuery as Record<string, unknown>).structuredQuery) as Record<
        string,
        unknown
      >
      let list = [...this.docs.values()].filter((d) => d.name.startsWith(`${this.root}/${parent}/records/`))
      const where = q.where as { fieldFilter?: { field: { fieldPath: string }; op: string; value: Value } } | undefined
      if (where?.fieldFilter) {
        const f = where.fieldFilter
        list = list.filter((d) => JSON.stringify(d.fields[f.field.fieldPath]) === JSON.stringify(f.value))
      }
      if (path.endsWith(':runAggregationQuery'))
        return jsonRes([{ result: { aggregateFields: { n: { integerValue: String(list.length) } } }, readTime: this.sameTime() }])
      if (q.orderBy) {
        list = list.filter((d) => d.fields.updated)
        list.sort((a, b) => cmp(ts(a), ts(b)) || cmp(a.name, b.name))
      }
      const start = q.startAt as { values: Value[]; before: boolean } | undefined
      if (start) {
        const sTs = start.values[0].timestampValue as string
        const sName = start.values[1]?.referenceValue as string | undefined
        list = list.filter((d) => {
          const c = cmp(ts(d), sTs) || (sName ? cmp(d.name, sName) : 0)
          return start.before ? c >= 0 : c > 0
        })
      }
      if (typeof q.limit === 'number') list = list.slice(0, q.limit)
      return jsonRes(list.length ? list.map((d) => ({ document: d, readTime: this.sameTime() })) : [{ readTime: this.sameTime() }])
    }
    if (path.endsWith(':commit')) {
      if (this.failNextCommit) {
        const f = this.failNextCommit
        this.failNextCommit = null
        return jsonRes({ error: { code: f.status, status: f.code, message: 'test' } }, f.status)
      }
      const writes = (body.writes as Record<string, unknown>[]) ?? []
      const owner = this.#ownerUid()
      const conn = this.#connector()
      const isOwner = uid === owner
      for (const w of writes) {
        const upd = w.update as { name: string; fields: Record<string, Value> } | undefined
        if (!upd) return denied()
        const exists = this.docs.has(upd.name)
        const pre = w.currentDocument as { exists?: boolean } | undefined
        if (pre?.exists === false && exists) return jsonRes({ error: { code: 409, status: 'ALREADY_EXISTS', message: 'exists' } }, 409)
        if (isOwner) continue
        // コネクタ: 8つの表に、決まった形で作るだけ
        const f = upd.fields
        const table = f.table?.stringValue as string
        const id = f.id?.stringValue as string
        const keys = Object.keys(f).sort().join(',')
        const ok =
          conn !== null &&
          conn.uid === uid &&
          conn.writes &&
          !exists &&
          CLAUDE_TABLES.has(table) &&
          upd.name === `${this.root}/users/${owner}/records/${table}:${id}` &&
          keys === 'chunks,deleted,device,hash,id,json,table' &&
          f.device?.stringValue === 'claude-connector' &&
          f.chunks?.integerValue === '0' &&
          f.deleted?.booleanValue === false &&
          JSON.stringify(w.updateTransforms) === JSON.stringify([{ fieldPath: 'updated', setToServerValue: 'REQUEST_TIME' }])
        if (!ok) return denied()
      }
      const t = this.#tick()
      const results = writes.map((w) => {
        const upd = w.update as { name: string; fields: Record<string, Value> }
        const prev = this.docs.get(upd.name)
        this.docs.set(upd.name, { name: upd.name, fields: { ...upd.fields, updated: { timestampValue: t } }, updateTime: t, createTime: prev?.createTime ?? t })
        return { updateTime: t, transformResults: [{ timestampValue: t }] }
      })
      return jsonRes({ writeResults: results, commitTime: t })
    }
    return jsonRes({ error: { code: 404, status: 'NOT_FOUND', message: path } }, 404)
  }

  /** Firestore の ID トークンを持つ uid（テストで、持ち主として書く時に使う） */
  tokenFor(uid: string): string {
    const t = `idtoken-${uid}-${++this.#seq}`
    this.#tokens.set(t, uid)
    return t
  }
}

function s(v: string): Value {
  return { stringValue: v }
}

function ts(d: Doc): string {
  return (d.fields.updated?.timestampValue as string) ?? ''
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isoMicros(us: number): string {
  const ms = Math.floor(us / 1000)
  const frac = String(us % 1_000_000).padStart(6, '0')
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac}Z`
}

function stableJson(rec: Rec): string {
  // encodeRecord と同じ JSON（分割する時の元）
  const enc = encodeRecord(rec, Number.MAX_SAFE_INTEGER)
  return enc.json as string
}

function jsonRes(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
}

function denied(): Response {
  return jsonRes({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }, 403)
}
