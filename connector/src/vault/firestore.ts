// Firestore の REST API（v1）。コネクタの匿名のアカウントの ID トークンで呼ぶので、アクセスルールがそのまま効く。
// - 使うのは batchGet・runQuery・runAggregationQuery・commit だけ。記録の id には ':' や '#' が入るので、URL のパスには入れない
//   （文書の名前は本文の JSON に入れる）
// - Google 側の一時的な失敗（5xx）は 200ms・800ms 待って2回まで試し直す。401 は ID トークンを更新して1回だけ試し直す
import { safeError } from '../log'
import type { Fields, Value } from './values'

export interface FsDoc {
  /** projects/…/documents/users/{uid}/records/{docId} */
  name: string
  fields: Fields
  createTime?: string
  updateTime: string
}

export class FirestoreError extends Error {
  readonly status: number
  /** PERMISSION_DENIED・ALREADY_EXISTS・FAILED_PRECONDITION・ABORTED・RESOURCE_EXHAUSTED・UNAUTHENTICATED など */
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FirestoreError'
    this.status = status
    this.code = code
  }
}

export interface FirestoreDeps {
  fetch: typeof fetch
  /** https://firestore.googleapis.com/v1（エミュレーターは http://127.0.0.1:8080/v1） */
  baseUrl: string
  projectId: string
  /** ID トークン（force = 更新する） */
  token: (force?: boolean) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

export interface CommitWrite {
  update?: { name: string; fields: Fields }
  delete?: string
  updateTransforms?: { fieldPath: string; setToServerValue: 'REQUEST_TIME' }[]
  currentDocument?: { exists?: boolean; updateTime?: string }
}

export interface CommitResult {
  writeResults: { updateTime?: string; transformResults?: Value[] }[]
  commitTime: string
}

const RETRY_WAITS = [200, 800]

export class FirestoreRest {
  readonly root: string
  readonly #deps: FirestoreDeps
  readonly #sleep: (ms: number) => Promise<void>

  constructor(deps: FirestoreDeps) {
    this.#deps = deps
    this.root = `projects/${deps.projectId}/databases/(default)/documents`
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** 文書の名前（users/{uid}/records/… → projects/…/documents/users/…） */
  name(path: string): string {
    return `${this.root}/${path}`
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.#deps.token(false)
      let res: Response
      try {
        res = await this.#deps.fetch(`${this.#deps.baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
      } catch (e) {
        if (attempt < RETRY_WAITS.length) {
          await this.#sleep(RETRY_WAITS[attempt])
          continue
        }
        throw new FirestoreError(0, 'UNAVAILABLE', safeError(e))
      }
      if (res.ok) return res.json()
      const err = await parseError(res)
      if (res.status === 401 && !refreshed) {
        refreshed = true
        await this.#deps.token(true)
        attempt -= 1
        continue
      }
      if (res.status >= 500 && attempt < RETRY_WAITS.length) {
        await this.#sleep(RETRY_WAITS[attempt])
        continue
      }
      throw err
    }
  }

  /** 名前を指定して読む（無い文書は null） */
  async batchGet(paths: string[]): Promise<Map<string, FsDoc | null>> {
    const out = new Map<string, FsDoc | null>()
    if (!paths.length) return out
    const names = paths.map((p) => this.name(p))
    const res = (await this.#post(`${this.root}:batchGet`, { documents: names })) as {
      found?: FsDoc
      missing?: string
    }[]
    for (const r of res) {
      if (r.found) out.set(r.found.name, { ...r.found, fields: r.found.fields ?? {} })
      else if (r.missing) out.set(r.missing, null)
    }
    // 名前の順に返す（無いと書かれていない名前も null）
    const ordered = new Map<string, FsDoc | null>()
    paths.forEach((p, i) => ordered.set(p, out.get(names[i]) ?? null))
    return ordered
  }

  /** 問い合わせ（parent は users/{uid}） */
  async runQuery(parent: string, structuredQuery: unknown): Promise<FsDoc[]> {
    const res = (await this.#post(`${this.root}/${parent}:runQuery`, { structuredQuery })) as {
      document?: FsDoc
      error?: { code?: number; status?: string; message?: string }
    }[]
    const docs: FsDoc[] = []
    for (const r of res) {
      if (r.error) throw new FirestoreError(r.error.code ?? 500, r.error.status ?? 'UNKNOWN', shortMessage(r.error.message))
      if (r.document) docs.push({ ...r.document, fields: r.document.fields ?? {} })
    }
    return docs
  }

  /** 件数（runAggregationQuery の COUNT） */
  async count(parent: string, structuredQuery: unknown): Promise<number> {
    const res = (await this.#post(`${this.root}/${parent}:runAggregationQuery`, {
      structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: 'n', count: {} }] },
    })) as { result?: { aggregateFields?: Record<string, { integerValue?: string }> } }[]
    for (const r of res) {
      const n = r.result?.aggregateFields?.n?.integerValue
      if (n !== undefined) return Number(n)
    }
    return 0
  }

  async commit(writes: CommitWrite[]): Promise<CommitResult> {
    const res = (await this.#post(`${this.root}:commit`, { writes })) as Partial<CommitResult>
    return { writeResults: res.writeResults ?? [], commitTime: res.commitTime ?? '' }
  }
}

function shortMessage(m: unknown): string {
  return typeof m === 'string' ? m.slice(0, 200) : ''
}

async function parseError(res: Response): Promise<FirestoreError> {
  let code = ''
  let message = ''
  try {
    const j = (await res.json()) as unknown
    const e = (Array.isArray(j) ? j[0]?.error : (j as { error?: unknown })?.error) as
      | { status?: string; message?: string }
      | undefined
    code = e?.status ?? ''
    message = shortMessage(e?.message)
  } catch {
    // 本文が JSON でない
  }
  if (!code)
    code =
      res.status === 401
        ? 'UNAUTHENTICATED'
        : res.status === 403
          ? 'PERMISSION_DENIED'
          : res.status === 409
            ? 'ALREADY_EXISTS'
            : res.status === 429
              ? 'RESOURCE_EXHAUSTED'
              : `HTTP_${res.status}`
  return new FirestoreError(res.status, code, message)
}
