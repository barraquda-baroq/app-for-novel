// Claude 用のコネクタ（Cloudflare Worker）との連携の決まり（docs/SPEC-2.md §7、コネクタの側と同じ手順）。
// 1. コネクタが claude.ai の接続の途中で `${アプリ}/#/claude/connect?s=<state>` を開く（s はコネクタが渡す、意味を持たない印）
// 2. アプリは、ビルドの時に決めたコネクタの origin（URL からは受け取らない）の /connect/identity から
//    コネクタの匿名のアカウント {uid, version, model} を受け取る（URL に書かれた uid も使わない）
// 3. 持ち主が［許可する］を押すと、k（32バイトの乱数。base64url）を作り、config/connector に
//    {uid, pairing: sha256hex(s + '.' + k), pairedAt: サーバー時刻, approvedOn: 端末の呼び名, writes, v: 1} を書く（k そのものは書かない）
// 4. 送信待ちを送ってから、`${コネクタ}/pair/callback?state=<s>&k=<k>` へ移る（コネクタが指紋を確かめて接続を終える）
// データ・通信は外から渡す（テストで差し替える）。
import type { ClaudeAccess, ID } from '../../domain/types'

/** ビルドの時に決めたコネクタの origin（vite.config.ts。未設定は空） */
export const CONNECTOR_ORIGIN: string = normalizeOrigin(typeof __CONNECTOR_ORIGIN__ === 'string' ? __CONNECTOR_ORIGIN__ : '')

/** https の origin（開発中は http://localhost も）だけを受け付ける。それ以外は空 */
export function normalizeOrigin(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    if (u.protocol !== 'https:' && !local) return ''
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return ''
    return u.origin
  } catch {
    return ''
  }
}

/** claude.ai に登録するコネクタの URL */
export const connectorMcpUrl = (origin: string) => `${origin}/mcp`
export const identityUrl = (origin: string) => `${origin}/connect/identity`

/** 連携を終えるためにコネクタへ移る URL（state と k は URL の引数として正しく書く） */
export function callbackUrl(origin: string, state: string, k: string): string {
  const q = new URLSearchParams({ state, k })
  return `${origin}/pair/callback?${q.toString()}`
}

/** 連携の印 s（コネクタが渡す。空白・制御文字の無い 1〜2048 文字）。違えば null */
export function validState(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null
  if (s.length < 1 || s.length > 2048) return null
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

/** コネクタの匿名のアカウント（/connect/identity の答え） */
export interface ConnectorIdentity {
  uid: string
  version: string
  /** コネクタが書くデータの形の版（アプリの DATA_MODEL と違えば、コネクタは書き込まない） */
  model: number | null
}

/** /connect/identity の答えを読む（形が違えば null） */
export function parseIdentity(v: unknown): ConnectorIdentity | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(o.uid)) return null
  const version = typeof o.version === 'string' ? o.version.slice(0, 40) : ''
  const model = typeof o.model === 'number' && Number.isInteger(o.model) ? o.model : null
  return { uid: o.uid, version, model }
}

/** 答えの中の短い説明（エラーの時。HTML としては出さない） */
function serverMessage(v: unknown): string {
  if (!v || typeof v !== 'object') return ''
  const o = v as Record<string, unknown>
  const m = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : ''
  return m.replace(/\s+/g, ' ').trim().slice(0, 200)
}

export type IdentityResult = { ok: true; identity: ConnectorIdentity } | { ok: false; error: string }

/**
 * コネクタの匿名のアカウントを受け取る。行き先はビルドの時に決めた origin だけ（Cookie などは送らない）。
 * 15秒で答えが無ければやめる
 */
export async function fetchIdentity(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<IdentityResult> {
  if (!origin) return { ok: false, error: 'コネクタの場所が設定されていません。' }
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(identityUrl(origin), {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json' },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (!res.ok) {
      const m = serverMessage(body)
      return { ok: false, error: `コネクタが連携を受け付けませんでした（${res.status}${m ? `: ${m}` : ''}）。` }
    }
    const identity = parseIdentity(body)
    if (!identity) return { ok: false, error: 'コネクタの答えの形が違います。コネクタを更新してください。' }
    return { ok: true, identity }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      error: aborted
        ? 'コネクタから答えがありませんでした。しばらくしてからもう一度お試しください。'
        : 'コネクタにつながりませんでした。インターネットの接続と、コネクタを公開したか（docs/CONNECTOR.md）を確かめてください。',
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** バイト列を base64url（= なし）にする */
export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 連携の鍵 k（32バイトの乱数の base64url。43文字）。このブラウザからコネクタへ URL で渡すだけで、どこにも保存しない */
export function randomPairingKey(random: (a: Uint8Array<ArrayBuffer>) => unknown = (a) => crypto.getRandomValues(a)): string {
  const bytes = new Uint8Array(32)
  random(bytes)
  return base64url(bytes)
}

export async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** config/connector に書く連携の指紋（コネクタも同じ式で確かめる） */
export const pairingHash = (state: string, k: string) => sha256hex(`${state}.${k}`)

/** config/connector に書く内容（pairedAt はサーバー時刻を書く側で足す） */
export interface ConnectorWrite {
  uid: string
  pairing: string
  approvedOn: string
  writes: boolean
  v: 1
}

/** config/connector の内容（設定の Claude 連携に出す） */
export interface ConnectorStatus {
  uid: string
  /** 連携した時刻（サーバー時刻。書いた直後で届いていなければ null） */
  pairedAt: number | null
  approvedOn: string
  writes: boolean
}

/** config/connector の文書を読む（形が違えば null） */
export function parseConnectorDoc(v: unknown): ConnectorStatus | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.uid !== 'string' || !o.uid) return null
  const at = o.pairedAt as { toMillis?: () => number } | number | null | undefined
  const pairedAt = typeof at === 'number' ? at : at && typeof at.toMillis === 'function' ? at.toMillis() : null
  return {
    uid: o.uid,
    pairedAt,
    approvedOn: typeof o.approvedOn === 'string' ? o.approvedOn : '',
    writes: o.writes === true,
  }
}

/** 連携に使う外の働き（画面では Firestore・同期・画面の移動、テストでは差し替える） */
export interface PairingDeps {
  /** ビルドの時に決めたコネクタの origin */
  origin: string
  /** config/connector を書き、サーバーが受け取るまで待つ */
  writeConnector(doc: ConnectorWrite): Promise<void>
  /** タイトルの「Claude に見せる」を変える（ふつうの同期する編集） */
  setAccess(titleId: ID, access: ClaudeAccess): void
  /** 送信待ちを送る（limitMs まで待つ） */
  flush(limitMs: number): Promise<void>
  /** コネクタへ移る（ページごと） */
  navigate(url: string): void
  randomKey(): string
  deviceLabel(): string
}

export interface PairingInput {
  state: string
  identity: ConnectorIdentity
  /** 持ち主のアカウント（コネクタのアカウントと同じなら連携しない） */
  ownerUid: string
  writes: boolean
  /** 変えたタイトルの「Claude に見せる」 */
  access: readonly { titleId: ID; access: ClaudeAccess }[]
}

export type PairingResult = { ok: true; url: string } | { ok: false; error: string }

/** 送信待ちを送るのを待つ長さの上限 */
export const FLUSH_LIMIT_MS = 10_000

/**
 * ［許可する］: タイトルの設定を変え、config/connector に連携の指紋を書き、送信待ちを送ってからコネクタへ移る。
 * k はコネクタへ移る URL にだけ入れる（Firestore には指紋だけ）
 */
export async function approvePairing(deps: PairingDeps, input: PairingInput): Promise<PairingResult> {
  const origin = deps.origin
  if (!origin) return { ok: false, error: 'コネクタの場所が設定されていません。' }
  const state = validState(input.state)
  if (!state) return { ok: false, error: '連携の印が正しくありません。claude.ai のコネクタの画面からやり直してください。' }
  if (!input.identity.uid || input.identity.uid === input.ownerUid)
    return { ok: false, error: 'コネクタのアカウントが正しくありません。コネクタを更新してください。' }
  for (const a of input.access) deps.setAccess(a.titleId, a.access)
  const k = deps.randomKey()
  const pairing = await pairingHash(state, k)
  try {
    await deps.writeConnector({
      uid: input.identity.uid,
      pairing,
      approvedOn: deps.deviceLabel().slice(0, 100),
      writes: input.writes,
      v: 1,
    })
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
    return {
      ok: false,
      error:
        code === 'permission-denied'
          ? '連携を記録できませんでした（アクセスルールが古いか、持ち主のアカウントではありません）。docs/CONNECTOR.md の手順でアクセスルールを公開してください。'
          : '連携を記録できませんでした。インターネットの接続を確かめて、もう一度お試しください。',
    }
  }
  await deps.flush(FLUSH_LIMIT_MS).catch(() => undefined)
  const url = callbackUrl(origin, state, k)
  deps.navigate(url)
  return { ok: true, url }
}
