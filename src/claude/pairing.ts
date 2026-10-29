// アプリ（連携の画面 #/claude/connect）と Claude 用のコネクタ（connector/ の Worker）の連携の決まり（DECISIONS 9）。
// 両方がこのファイルを使う（React・Dexie・Firebase・Zustand を読み込まない。Worker にもそのまま入る）。
//   1. コネクタ: POST /authorize（同意）→ 302 `${アプリ}/#/claude/connect?s=<state>`（connectPageUrl）
//   2. アプリ: GET `${コネクタ}/connect/identity`（identityUrl。CORS はアプリの origin だけ）→ { uid, version, model }（parseIdentity）
//   3. アプリ: config/connector = { uid, pairing: pairingHash(s, k), pairedAt: サーバー時刻, approvedOn, writes, v: 1 }
//      （k = 32バイトの乱数の base64url。k そのものはどこにも書かない）
//   4. アプリ: ページごと `${コネクタ}/pair/callback?state=<s>&k=<k>` へ移る（callbackUrl）
//   5. コネクタ: claude.ai で始めたブラウザの cookie と、k の指紋・uid・15分以内・一度だけ を確かめて、claude.ai へ戻す
// コネクタの origin はビルドの時に決める（アプリは URL に書かれた origin・uid を使わない）。

/** アプリの連携の画面のパス（HashRouter の中） */
export const CONNECT_ROUTE = '/claude/connect'
/** 連携の画面に渡す連携の印（コネクタの state）の引数の名前 */
export const CONNECT_STATE_PARAM = 's'
/** コネクタの身元（CORS でアプリの origin だけに答える） */
export const IDENTITY_PATH = '/connect/identity'
/** アプリからコネクタへ戻るパス（?state=…&k=…） */
export const CALLBACK_PATH = '/pair/callback'
/** k のバイト数（base64url で 43 文字） */
export const PAIRING_KEY_BYTES = 32
/** アプリが config/connector を書いてから、コネクタが確かめるまでの期限 */
export const PAIRING_TTL_MS = 15 * 60_000
/** 連携の印 s の長さの上限 */
export const STATE_MAX_LENGTH = 2048
/** config/connector の形の版 */
export const CONNECTOR_DOC_VERSION = 1
/** config/connector に書くキー（firestore.rules の validConnector と同じ） */
export const CONNECTOR_DOC_KEYS = ['uid', 'pairing', 'pairedAt', 'approvedOn', 'writes', 'v'] as const
/** approvedOn（連携した端末の呼び名）の長さの上限（firestore.rules と同じ） */
export const APPROVED_ON_MAX_LENGTH = 100

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * コネクタ・アプリの origin を整える。https の origin（開発中は http://localhost・127.0.0.1 も）だけを受け付け、
 * パス・引数・# ・ユーザー名のあるものは空にする（vite.config.ts のビルドの時の値と、アプリの画面で同じ決まり）
 */
export function normalizeOrigin(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    const local = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)
    if (u.protocol !== 'https:' && !local) return ''
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return ''
    return u.origin
  } catch {
    return ''
  }
}

/** claude.ai に登録するコネクタの URL */
export const connectorMcpUrl = (origin: string) => `${origin}/mcp`
export const identityUrl = (origin: string) => `${origin}${IDENTITY_PATH}`

/** コネクタが同意の後に開く、アプリの連携の画面の URL */
export function connectPageUrl(appOrigin: string, state: string): string {
  return `${appOrigin}/#${CONNECT_ROUTE}?${CONNECT_STATE_PARAM}=${encodeURIComponent(state)}`
}

/** 連携の画面の URL（connectPageUrl で作ったもの）から、連携の印を取り出す。違う形なら null */
export function stateFromConnectUrl(url: string): string | null {
  let hash: string
  try {
    hash = new URL(url).hash
  } catch {
    return null
  }
  const prefix = `#${CONNECT_ROUTE}?`
  if (!hash.startsWith(prefix)) return null
  return validState(new URLSearchParams(hash.slice(prefix.length)).get(CONNECT_STATE_PARAM))
}

/** 連携を終えるためにコネクタへ移る URL（state と k は URL の引数として正しく書く） */
export function callbackUrl(origin: string, state: string, k: string): string {
  const q = new URLSearchParams({ state, k })
  return `${origin}${CALLBACK_PATH}?${q.toString()}`
}

/** 連携の印 s（コネクタが渡す。空白・制御文字の無い 1〜2048 文字）。違えば null */
export function validState(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null
  if (s.length < 1 || s.length > STATE_MAX_LENGTH) return null
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

/** k の形（32 バイトの乱数の base64url = 43 字） */
export function isPairingKey(k: unknown): k is string {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k)
}

/** バイト列を base64url（= なし）にする */
export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 連携の鍵 k（32バイトの乱数の base64url。43文字）。アプリからコネクタへ URL で渡すだけで、どこにも保存しない */
export function randomPairingKey(random: (a: Uint8Array<ArrayBuffer>) => unknown = (a) => crypto.getRandomValues(a)): string {
  const bytes = new Uint8Array(new ArrayBuffer(PAIRING_KEY_BYTES))
  random(bytes)
  return base64url(bytes)
}

export async function sha256hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** config/connector に書く連携の指紋（コネクタも同じ式で確かめる）: sha256hex(s + '.' + k) */
export function pairingHash(state: string, k: string): Promise<string> {
  return sha256hex(`${state}.${k}`)
}

/** 指紋の形（SHA-256 の16進 64 文字） */
export function isPairingHash(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

/** コネクタの匿名のアカウント（/connect/identity の答え） */
export interface ConnectorIdentity {
  uid: string
  /** コネクタの版（2.3.0 など） */
  version: string
  /** コネクタが知っているデータの形の版（アプリの DATA_MODEL と違えば、コネクタは書き込まない） */
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

/** /connect/identity がうまくいかない時の答え（{ error: 種類, message: 日本語の説明 }） */
export interface IdentityError {
  error: string
  message: string
}

/** config/connector に書く内容（pairedAt はサーバー時刻を書く側で足す） */
export interface ConnectorWrite {
  uid: string
  pairing: string
  approvedOn: string
  writes: boolean
  v: typeof CONNECTOR_DOC_VERSION
}
