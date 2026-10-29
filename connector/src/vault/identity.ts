// コネクタ自身の Firebase のアカウント（匿名）。持ち主のアカウントのトークンは持たない。
// - 初めて要る時に accounts:signUp で作る。更新用トークン（期限なし）は TOKEN_ENC_KEY で暗号化して保存し、
//   ID トークン（1時間）はメモリにだけ置く（残り5分を切ったら更新する）
// - 更新用トークンが使えない（削除・無効・鍵が変わった）時は identity_lost: 身元を消し、連携を解除した扱いにする。
//   次に Claude が接続し直すと新しい身元を作り、持ち主がアプリでもう一度許可する
import { ConnectorError, MESSAGES } from './errors'
import { DecryptError, KeyMissingError, seal, unseal } from './crypto'
import type { MirrorStore } from './store'
import { safeError, log } from '../log'

export interface IdentityDeps {
  fetch: typeof fetch
  identityUrl: string
  tokenUrl: string
  apiKey: string
  secret: string | undefined
  store: MirrorStore
  now: () => number
  sleep?: (ms: number) => Promise<void>
  /** 身元を失った時（連携の状態を unpaired にする） */
  onLost: () => void
}

interface StoredIdentity {
  uid: string
  sealed: string
  createdAt: number
}

const LOST = new Set(['INVALID_REFRESH_TOKEN', 'USER_NOT_FOUND', 'USER_DISABLED', 'TOKEN_EXPIRED', 'INVALID_ID_TOKEN'])
const DISABLED = new Set(['OPERATION_NOT_ALLOWED', 'ADMIN_ONLY_OPERATION'])

/** Firebase Auth の REST の失敗の印（INVALID_REFRESH_TOKEN など。": 説明" は外す） */
async function authErrorCode(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } | string }
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? '')
    return m.split(/[ :]/)[0].toUpperCase()
  } catch {
    return `HTTP_${res.status}`
  }
}

export class Identity {
  readonly #d: IdentityDeps
  #idToken: { token: string; exp: number } | null = null
  #refreshing: Promise<string> | null = null

  constructor(deps: IdentityDeps) {
    this.#d = deps
  }

  #stored(): StoredIdentity | null {
    return this.#d.store.getMeta<StoredIdentity>('identity')
  }

  /** 身元の uid（まだ作っていなければ null） */
  uid(): string | null {
    return this.#stored()?.uid ?? null
  }

  /** 身元を消す（identity_lost・連携し直す時） */
  wipe(): void {
    this.#d.store.deleteMeta('identity')
    this.#idToken = null
  }

  async #retrying(fn: () => Promise<Response>): Promise<Response> {
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    let last: unknown
    for (const wait of [0, 200, 800]) {
      if (wait) await sleep(wait)
      try {
        const res = await fn()
        if (res.status < 500) return res
        last = new Error(`HTTP ${res.status}`)
      } catch (e) {
        last = e
      }
    }
    log('identity_unavailable', { error: safeError(last) })
    throw new ConnectorError('unavailable', MESSAGES.unavailable)
  }

  /** 身元を確かめる（無ければ作る）。uid を返す */
  async ensure(): Promise<string> {
    const cur = this.#stored()
    if (cur) return cur.uid
    if (!this.#d.secret || this.#d.secret.length < 16) throw new ConnectorError('key_missing', MESSAGES.keyMissing)
    const res = await this.#retrying(() =>
      this.#d.fetch(`${this.#d.identityUrl}/accounts:signUp?key=${encodeURIComponent(this.#d.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      }),
    )
    if (!res.ok) {
      const code = await authErrorCode(res)
      log('identity_signup_failed', { code, status: res.status })
      if (DISABLED.has(code)) throw new ConnectorError('anonymous_disabled', MESSAGES.anonymousDisabled)
      throw new ConnectorError('unavailable', MESSAGES.unavailable)
    }
    const j = (await res.json()) as { localId?: string; idToken?: string; refreshToken?: string; expiresIn?: string }
    if (!j.localId || !j.refreshToken || !j.idToken) throw new ConnectorError('unavailable', MESSAGES.unavailable)
    const sealed = await this.#seal(j.refreshToken)
    this.#d.store.setMeta('identity', { uid: j.localId, sealed, createdAt: this.#d.now() } satisfies StoredIdentity)
    this.#idToken = { token: j.idToken, exp: this.#d.now() + Number(j.expiresIn ?? 3600) * 1000 }
    log('identity_created')
    return j.localId
  }

  async #seal(token: string): Promise<string> {
    try {
      return await seal(this.#d.secret, token)
    } catch (e) {
      if (e instanceof KeyMissingError) throw new ConnectorError('key_missing', MESSAGES.keyMissing)
      throw e
    }
  }

  #lost(reason: string): never {
    log('identity_lost', { reason })
    this.wipe()
    this.#d.onLost()
    throw new ConnectorError('identity_lost', MESSAGES.identityLost)
  }

  /** ID トークン（Firestore を呼ぶ時に使う）。force = 期限に関わらず更新する */
  async idToken(force = false): Promise<string> {
    const cached = this.#idToken
    if (!force && cached && cached.exp - this.#d.now() > 5 * 60_000) return cached.token
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = this.#refresh().finally(() => {
      this.#refreshing = null
    })
    return this.#refreshing
  }

  async #refresh(): Promise<string> {
    const cur = this.#stored()
    if (!cur) throw new ConnectorError('unpaired', MESSAGES.unpaired)
    let refreshToken: string
    try {
      refreshToken = await unseal(this.#d.secret, cur.sealed)
    } catch (e) {
      if (e instanceof KeyMissingError) throw new ConnectorError('key_missing', MESSAGES.keyMissing)
      if (e instanceof DecryptError) this.#lost('decrypt')
      throw e
    }
    const res = await this.#retrying(() =>
      this.#d.fetch(`${this.#d.tokenUrl}/token?key=${encodeURIComponent(this.#d.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      }),
    )
    if (!res.ok) {
      const code = await authErrorCode(res)
      if (LOST.has(code)) this.#lost(code)
      log('identity_refresh_failed', { code, status: res.status })
      throw new ConnectorError('unavailable', MESSAGES.unavailable)
    }
    const j = (await res.json()) as { id_token?: string; refresh_token?: string; expires_in?: string; user_id?: string }
    if (!j.id_token) throw new ConnectorError('unavailable', MESSAGES.unavailable)
    if (j.user_id && j.user_id !== cur.uid) this.#lost('uid_changed')
    // 返ってきた更新用トークンをいつも保存する（同じこともある）
    if (j.refresh_token && j.refresh_token !== refreshToken)
      this.#d.store.setMeta('identity', { ...cur, sealed: await this.#seal(j.refresh_token) } satisfies StoredIdentity)
    this.#idToken = { token: j.id_token, exp: this.#d.now() + Number(j.expires_in ?? 3600) * 1000 }
    return j.id_token
  }
}
