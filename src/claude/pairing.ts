// アプリ（連携の画面 #/claude/connect）と Claude 用のコネクタ（connector/ の Worker）の連携の決まり（DECISIONS 9）。
// 両方がこのファイルを使う（React・Dexie・Firebase・Zustand を読み込まない。Worker にもそのまま入る）。
//   1. コネクタ: POST /authorize（同意）→ 302 `${アプリ}/#/claude/connect?s=<state>`（connectPageUrl）
//   2. アプリ: GET `${コネクタ}/connect/identity`（identityUrl。CORS はアプリの origin だけ）→ { uid, version, model }（parseIdentity）
//   3. アプリ: config/connector = { uid, writes, v: 2, pairing, pairedAt, approvedOn（最後の許可）, pairingCid,
//      connections: { [cid]: { name, pairing, pairedAt, approvedOn } } }（トランザクションで足す・入れ替える）。
//      pairing = pairingHash(s, k)・pairedAt はサーバー時刻（k = 32バイトの乱数の base64url。k そのものはどこにも書かない）。
//      2.8 までの v: 1（connections が無い）は、接続 c0「接続1」1つとして読む（connectionsOf）
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

// ---------- 2.9: 複数の接続（claude.ai のアカウントごと） ----------

/** 1つの Novel Studio に同時に接続できる数（firestore.rules と同じ） */
export const MAX_CONNECTIONS = 10
/** 接続の名前の長さの上限（アプリの入力。ルールは 40 字まで受け、コネクタは出す時に 40 字で切る） */
export const CONNECTION_NAME_MAX = 20
/** 記録から読む時の名前の長さの上限（ルールが受ける長さ） */
const CONNECTION_NAME_READ_MAX = 40
/** 2.8 までの許可（OAuth の許可の props に cid が無い）と、v1 の記録の接続 */
export const LEGACY_CONNECTION_ID = 'c0'
export const LEGACY_CONNECTION_NAME = '接続1'
/** 接続の id の形（firestore.rules と同じ） */
export const CONNECTION_ID = /^c[0-9a-z]{1,31}$/
/** 名前が読めない接続の呼び名 */
const BROKEN_CONNECTION_NAME = '接続'

/** 新しい接続の id: 'c' と乱数の base36 12字（'c0' にも表示の番号にもならない。使い回さない） */
export function newConnectionId(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n))),
): string {
  let out = 'c'
  for (const b of randomBytes(12).slice(0, 12)) out += (b % 36).toString(36)
  // 乱数が足りない時（テストの差し替えなど）も 12 字にそろえる
  return out.padEnd(13, '0')
}

/**
 * 接続の名前の重なりを見るための形（画面で同じ名前を断る）。src/claude/refs.ts の refKey と同じ式（字の幅・空白の違いは同じ）。
 * このファイルは vite.config.ts・Worker からも読むので、refs.ts（domain を読む）は読み込まない（同じ式かはテストで確かめる）
 */
export const connectionNameKey = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .trim()

/** 空いている一番小さい n の「接続n」（NFKC で /^接続(\d+)$/ を見る） */
export function defaultConnectionName(names: readonly string[]): string {
  const used = new Set<number>()
  for (const name of names) {
    const m = /^接続(\d+)$/.exec(connectionNameKey(name))
    if (m) used.add(Number(m[1]))
  }
  let n = 1
  while (used.has(n)) n++
  return `接続${n}`
}

export interface ConnectionInfo {
  cid: string
  name: string
  pairing: string
  /** 許可した時刻（ms。読めなければ null） */
  pairedAt: number | null
  approvedOn: string
}

/** 記録の時刻を ms にする（既定: 数だけ。Firestore の Timestamp などは呼ぶ側が変換の関数を渡す） */
export type ToMillis = (v: unknown) => number | null
const numberMillis: ToMillis = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 読んだ名前を整える（制御文字を除き、40 字まで。空・文字列でなければ「接続」） */
function cleanConnectionName(v: unknown): string {
  if (typeof v !== 'string') return BROKEN_CONNECTION_NAME
  // eslint-disable-next-line no-control-regex
  const s = Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim())
    .slice(0, CONNECTION_NAME_READ_MAX)
    .join('')
    .trim()
  return s || BROKEN_CONNECTION_NAME
}

const textOf = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * 記録の接続（許可した時刻の順、同じなら cid の順）。時刻は呼ぶ側で ms にそろえてから渡すか、変換の関数を渡す。
 * v1（connections が無い）は [c0 接続1（記録の pairing・pairedAt・approvedOn）]。
 * v2 は鍵が CONNECTION_ID に合い、値が map のものだけ（名前が壊れていれば「接続」、制御文字は除き 40 字まで）。v2 で1つも無ければ null
 * （解除と同じ）。ほかの項目は持ち主が書いたものなので、ここで用心して読む（ルールが確かめるのは新しく許可した接続だけ）
 */
export function connectionsOf(
  doc: { v?: unknown; pairing?: unknown; pairedAt?: unknown; approvedOn?: unknown; connections?: unknown },
  toMillis: ToMillis = numberMillis,
): ConnectionInfo[] | null {
  const ms = (v: unknown) => {
    const n = toMillis(v)
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  }
  if (doc.connections === undefined)
    return [
      {
        cid: LEGACY_CONNECTION_ID,
        name: LEGACY_CONNECTION_NAME,
        pairing: textOf(doc.pairing, 128),
        pairedAt: ms(doc.pairedAt),
        approvedOn: textOf(doc.approvedOn, APPROVED_ON_MAX_LENGTH),
      },
    ]
  const map = doc.connections
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  const out: ConnectionInfo[] = []
  for (const [cid, v] of Object.entries(map as Record<string, unknown>)) {
    if (!CONNECTION_ID.test(cid) || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const c = v as Record<string, unknown>
    out.push({
      cid,
      name: cleanConnectionName(c.name),
      pairing: textOf(c.pairing, 128),
      pairedAt: ms(c.pairedAt),
      approvedOn: textOf(c.approvedOn, APPROVED_ON_MAX_LENGTH),
    })
  }
  if (!out.length) return null
  return out.sort((a, b) => (a.pairedAt ?? 0) - (b.pairedAt ?? 0) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0))
}

/** config/connector に書く内容（pairedAt はサーバー時刻を書く側で足す） */
export interface ConnectorWrite {
  uid: string
  pairing: string
  approvedOn: string
  writes: boolean
  v: typeof CONNECTOR_DOC_VERSION
}
