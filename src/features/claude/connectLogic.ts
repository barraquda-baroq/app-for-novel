// Claude 用のコネクタ（Cloudflare Worker）との連携の決まり（docs/SPEC-2.md §7、コネクタの側と同じ手順）。
// 1. コネクタが claude.ai の接続の途中で `${アプリ}/#/claude/connect?s=<state>` を開く（s はコネクタが渡す、意味を持たない印）
// 2. アプリは、ビルドの時に決めたコネクタの origin（URL からは受け取らない）の /connect/identity から
//    コネクタの匿名のアカウント {uid, version, model} を受け取る（URL に書かれた uid も使わない）
// 3. 持ち主が［許可する］を押すと、k（32バイトの乱数。base64url）を作り、config/connector の接続の一覧（2.9。10まで）に
//    接続 {name, pairing: sha256hex(s + '.' + k), pairedAt: サーバー時刻, approvedOn: 端末の呼び名} を足す（トランザクション。
//    上の pairing・pairedAt・approvedOn・pairingCid は最後に許可した接続のもの。k そのものは書かない）。2.8 までの v: 1 の記録は、
//    その接続を c0「接続1」として一覧に移す（作られた時刻は変わらないので、2.8 の許可はそのまま使える）。
//    その前に、タイトルの「Claude に見せる」などの送信待ちがクラウドに届いたことを確かめる（届かなければ何も書かない）
// 4. `${コネクタ}/pair/callback?state=<s>&k=<k>` へ移る（コネクタが指紋を確かめて接続を終える）
// データ・通信は外から渡す（テストで差し替える）。
import {
  callbackUrl,
  connectionsOf,
  identityUrl,
  isPairingKey,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  validState,
  APPROVED_ON_MAX_LENGTH,
  CONNECTION_ID,
  CONNECTION_NAME_MAX,
  CONNECTOR_DOC_VERSION,
  LEGACY_CONNECTION_ID,
  LEGACY_CONNECTION_NAME,
  MAX_CONNECTIONS,
  type ConnectionApproval,
  type ConnectionInfo,
  type ConnectorIdentity,
} from '../../claude/pairing'
import type { ClaudeAccess, ID } from '../../domain/types'

// 連携の決まりそのもの（URL の形・k・指紋・身元の形）は、コネクタと同じ src/claude/pairing.ts
export {
  base64url,
  callbackUrl,
  connectorMcpUrl,
  identityUrl,
  isPairingKey,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  randomPairingKey,
  sha256hex,
  validState,
  type ConnectionApproval,
  type ConnectionInfo,
  type ConnectorIdentity,
} from '../../claude/pairing'

/** ビルドの時に決めたコネクタの origin（vite.config.ts。未設定は空） */
export const CONNECTOR_ORIGIN: string = normalizeOrigin(typeof __CONNECTOR_ORIGIN__ === 'string' ? __CONNECTOR_ORIGIN__ : '')

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

/** 同期が揃うのを待つ長さ（連携の画面） */
export const SYNC_WAIT_MS = 90_000

/** 連携の画面で［許可する］を出す前の確かめに使う外の働き（画面では Firestore・同期、テストでは差し替える） */
export interface PrepareDeps {
  /** ビルドの時に決めたコネクタの origin */
  origin: string
  /** クラウドの持ち主のアカウント（config/owner。記録が無ければ null。読めなければ throw） */
  readOwnerUid(): Promise<string | null>
  /** 同期が「同期済み」になるまで待つ（limitMs まで。なれば true） */
  waitSynced(limitMs: number): Promise<boolean>
  /** コネクタの身元を受け取る（ふつうは fetchIdentity） */
  fetchIdentity(origin: string): Promise<IdentityResult>
  /** いまの連携の記録（config/connector。サーバーから読む。無ければ null。読めなければ throw） */
  readConnector(): Promise<ConnectorStatus | null>
  /** このアプリのデータの形の版（DATA_MODEL。コネクタがこれより古ければ許可させない） */
  dataModel: number
  /** 画面を離れた・やり直した（true なら先へ進まない。コネクタにも問い合わせない） */
  cancelled(): boolean
  /** いまの段階（画面の表示） */
  onStep?(step: 'checking' | 'sync' | 'identity'): void
}

export type PrepareResult =
  | {
      step: 'ready'
      identity: ConnectorIdentity
      ownerUid: string
      /** いまの連携の記録（無ければ null） */
      existing: ConnectorStatus | null
      /** いまの連携の記録を読めなかった（許可はできる。記録はトランザクションでもう一度読む） */
      existingError: boolean
    }
  | { step: 'connectorOld'; identity: ConnectorIdentity }
  | { step: 'notOwner' }
  | { step: 'noOwner' }
  | { step: 'ownerError' }
  | { step: 'syncTimeout' }
  | { step: 'identityError'; error: string }
  | { step: 'cancelled' }

/**
 * ログインしているアカウント（uid）で連携を始められるか確かめる:
 * 1. クラウドの持ち主か（config/owner。違えば notOwner）
 * 2. 同期が揃うのを待つ（見せるタイトルを正しく出し、連携の記録を書く前に）。初めての同期なら、持ち主をもう一度読む
 * 3. ビルドの時に決めた origin のコネクタから身元を受け取る（持ち主と同じアカウントなら断る）
 * 4. コネクタのデータの形の版がこのアプリより古ければ許可させない（2.8 までのコネクタは、許可するとほかの接続の許可を
 *    取り消してしまい、接続の id の無い許可を作るため）
 * 5. いまの連携の記録（接続の一覧）を読む（読めなくても許可はできる）
 */
export async function prepareConnect(deps: PrepareDeps, uid: string): Promise<PrepareResult> {
  const step = (s: 'checking' | 'sync' | 'identity') => {
    if (!deps.cancelled()) deps.onStep?.(s)
  }
  step('checking')
  let owner: string | null
  try {
    owner = await deps.readOwnerUid()
  } catch {
    return { step: 'ownerError' }
  }
  if (owner && owner !== uid) return { step: 'notOwner' }
  if (deps.cancelled()) return { step: 'cancelled' }
  step('sync')
  if (!(await deps.waitSynced(SYNC_WAIT_MS))) return { step: 'syncTimeout' }
  if (deps.cancelled()) return { step: 'cancelled' }
  if (!owner) {
    // 初めての同期で持ち主が記録されたところ
    owner = await deps.readOwnerUid().catch(() => null)
    if (!owner) return { step: 'noOwner' }
    if (owner !== uid) return { step: 'notOwner' }
  }
  // 画面を離れた・やり直した後は、コネクタに問い合わせない（問い合わせると、コネクタは匿名のアカウントを作る）
  if (deps.cancelled()) return { step: 'cancelled' }
  step('identity')
  const r = await deps.fetchIdentity(deps.origin)
  if (!r.ok) return { step: 'identityError', error: r.error }
  if (r.identity.uid === uid)
    return { step: 'identityError', error: 'コネクタのアカウントが正しくありません。コネクタを更新してください。' }
  if (r.identity.model === null || r.identity.model < deps.dataModel) return { step: 'connectorOld', identity: r.identity }
  if (deps.cancelled()) return { step: 'cancelled' }
  let existing: ConnectorStatus | null = null
  let existingError = false
  try {
    existing = await deps.readConnector()
  } catch {
    existingError = true
  }
  return { step: 'ready', identity: r.identity, ownerUid: owner, existing, existingError }
}

/** 連携の記録を読めなかった時（連携の画面。許可はできる） */
export const EXISTING_READ_ERROR = 'いまの接続の一覧を読めませんでした（許可はできます）'

/** config/connector の内容（設定の Claude 連携・連携の画面に出す） */
export interface ConnectorStatus {
  /** コネクタの匿名のアカウント */
  uid: string
  /** 最後に許可した時刻（サーバー時刻。書いた直後で届いていなければ null） */
  pairedAt: number | null
  /** 最後に許可した端末 */
  approvedOn: string
  /** 「書き込みを許可」（すべての接続に効く） */
  writes: boolean
  /** 接続の一覧（許可した時刻の順、同じなら cid の順。2.8 までの記録は c0「接続1」1つ） */
  connections: ConnectionInfo[]
  /** 最後に許可した接続（2.8 までの記録は c0。読めなければ null） */
  pairingCid: string | null
}

/** Firestore の時刻（Timestamp）・ms の数を ms にする（読めなければ null） */
export function timeMillis(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = v as { toMillis?: () => number } | null | undefined
  if (t && typeof t.toMillis === 'function') {
    const n = t.toMillis()
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** config/connector の文書を読む（形が違う・正しい接続が1つも無い v2 は null = 連携していない。コネクタと同じ読み方） */
export function parseConnectorDoc(v: unknown): ConnectorStatus | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.uid !== 'string' || !o.uid) return null
  const connections = connectionsOf(o, timeMillis)
  if (!connections) return null
  return {
    uid: o.uid,
    pairedAt: timeMillis(o.pairedAt),
    approvedOn: typeof o.approvedOn === 'string' ? o.approvedOn : '',
    writes: o.writes === true,
    connections,
    pairingCid:
      o.connections === undefined
        ? LEGACY_CONNECTION_ID
        : typeof o.pairingCid === 'string' && CONNECTION_ID.test(o.pairingCid)
          ? o.pairingCid
          : null,
  }
}

// ---------- 2.9: 接続の一覧を書き換える（connectorDoc.ts のトランザクションの中で使う。Firebase は読み込まない） ----------

/** 連携の記録が別のコネクタ（身元を作り直したコネクタ）のもの。記録を消してから新しく作る */
export class IdentityChangedError extends Error {
  constructor() {
    super('コネクタの身元が変わりました')
    this.name = 'IdentityChangedError'
  }
}

/** 接続が10ある（入れ替える接続を選ぶか、1つ解除する） */
export class ConnectionLimitError extends Error {
  constructor() {
    super('接続が10あります')
    this.name = 'ConnectionLimitError'
  }
}

/** 名前を変える接続が、もう一覧に無い（ほかの端末で解除した） */
export class ConnectionGoneError extends Error {
  constructor() {
    super('その接続はもうありません')
    this.name = 'ConnectionGoneError'
  }
}

/** 接続が10ある時（連携はまだ記録していない） */
export const CONNECTION_LIMIT_ERROR = `接続が${MAX_CONNECTIONS}あります（同時に${MAX_CONNECTIONS}まで）。入れ替える接続を選ぶか、一覧で1つ解除してから、もう一度［許可する］を押してください（連携はまだ記録していません）。`
/** 接続の名前が空・長すぎる時 */
export const CONNECTION_NAME_ERROR = `接続の名前は1〜${CONNECTION_NAME_MAX}字にしてください。`

/** 接続の名前を整える（前後の空白を除く）。空・20字を超える・制御文字を含むなら null */
export function cleanNewConnectionName(name: string): string | null {
  const s = name.trim()
  const n = Array.from(s).length
  // eslint-disable-next-line no-control-regex
  if (n < 1 || n > CONNECTION_NAME_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return null
  return s
}

type Raw = Record<string, unknown>
const isMap = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 記録の接続の map（書き戻す形。時刻は読んだ値そのまま）。v1（connections が無い）は c0「接続1」に移す（記録の pairing・pairedAt・
 * approvedOn）。鍵が接続の id の形でない・値が map でないものは外す（コネクタも数えない。一覧に出ず解除もできない枠を残さない）
 */
export function connectionEntries(cur: Raw): Record<string, Raw> {
  if (cur.connections === undefined)
    return {
      [LEGACY_CONNECTION_ID]: {
        name: LEGACY_CONNECTION_NAME,
        pairing: typeof cur.pairing === 'string' ? cur.pairing : '',
        pairedAt: cur.pairedAt ?? null,
        approvedOn: typeof cur.approvedOn === 'string' ? cur.approvedOn : '',
      },
    }
  const out: Record<string, Raw> = {}
  if (!isMap(cur.connections)) return out
  for (const [cid, v] of Object.entries(cur.connections)) if (CONNECTION_ID.test(cid) && isMap(v)) out[cid] = { ...v }
  return out
}

/** 一覧を編集した後の記録（身元・書き込みの許可・最後の許可の指紋・時刻・接続はそのまま。2.8 の記録は v2 の形に移す） */
function editedDoc(cur: Raw, list: Record<string, Raw>): Raw {
  return {
    uid: cur.uid,
    writes: cur.writes === true,
    v: CONNECTOR_DOC_VERSION,
    pairing: cur.pairing,
    pairedAt: cur.pairedAt,
    approvedOn: typeof cur.approvedOn === 'string' ? cur.approvedOn : '',
    pairingCid: typeof cur.pairingCid === 'string' ? cur.pairingCid : LEGACY_CONNECTION_ID,
    connections: list,
  }
}

/**
 * 接続を足す（入れ替える）時に書く記録。serverTime はサーバー時刻の値（Firestore の serverTimestamp()）。
 * 別のコネクタの記録なら IdentityChangedError、入れ替えても10を超えるなら ConnectionLimitError（どちらも何も書かない）。
 * 同じ cid（記録に失敗した後のやり直し）は上書きする（重ならない）
 */
export function addedConnectorDoc(cur: Raw | null, a: ConnectionApproval, serverTime: unknown): Raw {
  if (cur && cur.uid !== a.uid) throw new IdentityChangedError()
  const list = cur ? connectionEntries(cur) : {}
  if (a.replaceCid) delete list[a.replaceCid]
  delete list[a.cid]
  if (Object.keys(list).length >= MAX_CONNECTIONS) throw new ConnectionLimitError()
  list[a.cid] = { name: a.name, pairing: a.pairing, pairedAt: serverTime, approvedOn: a.approvedOn }
  return {
    uid: a.uid,
    writes: a.writes,
    v: CONNECTOR_DOC_VERSION,
    pairing: a.pairing,
    pairedAt: serverTime,
    approvedOn: a.approvedOn,
    pairingCid: a.cid,
    connections: list,
  }
}

/** 接続の名前を変えた記録（無い接続なら ConnectionGoneError。名前が正しくなければ例外） */
export function renamedConnectorDoc(cur: Raw | null, cid: string, name: string): Raw {
  const clean = cleanNewConnectionName(name)
  if (clean === null) throw new Error(CONNECTION_NAME_ERROR)
  const list = cur ? connectionEntries(cur) : {}
  if (!cur || !list[cid]) throw new ConnectionGoneError()
  list[cid] = { ...list[cid], name: clean }
  return editedDoc(cur, list)
}

/**
 * 接続を1つ解除した記録。最後の1つなら 'delete'（記録を消す = 連携をすべて解除。次の許可は新しい代になる）。
 * もう無い接続・記録なら 'none'
 */
export function removedConnectorDoc(
  cur: Raw | null,
  cid: string,
): { kind: 'set'; doc: Raw } | { kind: 'delete' } | { kind: 'none' } {
  if (!cur) return { kind: 'none' }
  const list = connectionEntries(cur)
  if (!list[cid]) return { kind: 'none' }
  delete list[cid]
  if (!Object.keys(list).length) return { kind: 'delete' }
  return { kind: 'set', doc: editedDoc(cur, list) }
}

/** 連携に使う外の働き（画面では Firestore・同期・画面の移動、テストでは差し替える） */
export interface PairingDeps {
  /** ビルドの時に決めたコネクタの origin */
  origin: string
  /** config/connector の一覧に接続を足す（トランザクション。サーバーが受け取るまで待つ） */
  addConnection(a: ConnectionApproval): Promise<void>
  /** config/connector を消す（コネクタの身元が変わった時。前の接続はどれも使えなくなっている） */
  deleteConnector(): Promise<void>
  /** タイトルの「Claude に見せる」を変える（ふつうの同期する編集） */
  setAccess(titleId: ID, access: ClaudeAccess): void
  /**
   * 送信待ちを送る（limitMs まで待つ）。送信待ちがすべてサーバーに受け取られた（何も残っていない）時だけ true
   * （送れない・送るのを止めている・時間切れは false）
   */
  flush(limitMs: number): Promise<boolean>
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
  /** 足す接続の id（画面を開くごとに1つ作り、やり直しでは同じものを使う） */
  cid: string
  /** 接続の名前（1〜20字） */
  name: string
  /** 入れ替える接続（前の接続は使えなくなる） */
  replaceCid?: string | null
}

export type PairingResult = { ok: true; url: string } | { ok: false; error: string }

/** 送信待ちを送るのを待つ長さの上限 */
export const FLUSH_LIMIT_MS = 10_000

/** 送信待ちを送れなかった時（連携はまだ記録していない） */
export const NOT_SENT_ERROR =
  'タイトルの「Claude に見せる」などの変更を、まだクラウドへ送れていません。インターネットの接続を確かめて、もう一度［許可する］を押してください（連携はまだ記録していません）。'

/**
 * ［許可する］: タイトルの設定を変え、送信待ちがクラウドに届いたのを確かめてから、config/connector の一覧に接続（連携の指紋）を
 * 足し、コネクタへ移る。k はコネクタへ移る URL にだけ入れる（Firestore には指紋だけ）。名前・接続の id は送る前に確かめる。
 * 送信待ちが届かなければ（時間切れ・送るのを止めている時も）連携の記録を書かず、移らない。コネクタは連携の直後に
 * クラウドのタイトルを読むので、見せない・読むだけにした設定が届く前に連携すると、そのタイトルが Claude に見えてしまう。
 * この画面で変えていなくても確かめる（記録に失敗した後のやり直しでは、変えた設定はもう端末内にあり、送信待ちに残っていることがある）
 */
export async function approvePairing(deps: PairingDeps, input: PairingInput): Promise<PairingResult> {
  const origin = deps.origin
  if (!origin) return { ok: false, error: 'コネクタの場所が設定されていません。' }
  const state = validState(input.state)
  if (!state) return { ok: false, error: '連携の印が正しくありません。claude.ai のコネクタの画面からやり直してください。' }
  if (!input.identity.uid || input.identity.uid === input.ownerUid)
    return { ok: false, error: 'コネクタのアカウントが正しくありません。コネクタを更新してください。' }
  const name = cleanNewConnectionName(input.name)
  if (name === null) return { ok: false, error: CONNECTION_NAME_ERROR }
  if (!CONNECTION_ID.test(input.cid) || input.cid === LEGACY_CONNECTION_ID)
    return { ok: false, error: '接続の id を作れませんでした。画面を読み込み直してください。' }
  const k = deps.randomKey()
  if (!isPairingKey(k)) return { ok: false, error: '連携の鍵を作れませんでした。もう一度お試しください。' }
  for (const a of input.access) deps.setAccess(a.titleId, a.access)
  const sent = await deps.flush(FLUSH_LIMIT_MS).catch(() => false)
  if (!sent) return { ok: false, error: NOT_SENT_ERROR }
  const pairing = await pairingHash(state, k)
  const approval: ConnectionApproval = {
    uid: input.identity.uid,
    pairing,
    approvedOn: deps.deviceLabel().slice(0, APPROVED_ON_MAX_LENGTH),
    writes: input.writes,
    cid: input.cid,
    name,
    replaceCid: input.replaceCid ?? null,
  }
  try {
    try {
      await deps.addConnection(approval)
    } catch (e) {
      if (!(e instanceof IdentityChangedError)) throw e
      // コネクタが用意し直された: 前の記録（前のコネクタの接続）を消してから、新しく作る（新しい代になり、前の許可は戻らない）
      await deps.deleteConnector()
      await deps.addConnection({ ...approval, replaceCid: null })
    }
  } catch (e) {
    if (e instanceof ConnectionLimitError) return { ok: false, error: CONNECTION_LIMIT_ERROR }
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
    return {
      ok: false,
      error:
        code === 'permission-denied'
          ? '連携を記録できませんでした（アクセスルールが古いか、持ち主のアカウントではありません）。docs/CONNECTOR.md の手順でアクセスルールを公開してください。'
          : '連携を記録できませんでした。インターネットの接続を確かめて、もう一度お試しください。',
    }
  }
  const url = callbackUrl(origin, state, k)
  deps.navigate(url)
  return { ok: true, url }
}
