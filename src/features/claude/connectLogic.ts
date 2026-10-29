// Claude 用のコネクタ（Cloudflare Worker）との連携の決まり（docs/SPEC-2.md §7、コネクタの側と同じ手順）。
// 1. コネクタが claude.ai の接続の途中で `${アプリ}/#/claude/connect?s=<state>` を開く（s はコネクタが渡す、意味を持たない印）
// 2. アプリは、ビルドの時に決めたコネクタの origin（URL からは受け取らない）の /connect/identity から
//    コネクタの匿名のアカウント {uid, version, model} を受け取る（URL に書かれた uid も使わない）
// 3. 持ち主が［許可する］を押すと、k（32バイトの乱数。base64url）を作り、config/connector に
//    {uid, pairing: sha256hex(s + '.' + k), pairedAt: サーバー時刻, approvedOn: 端末の呼び名, writes, v: 1} を書く（k そのものは書かない）
//    その前に、タイトルの「Claude に見せる」などの送信待ちがクラウドに届いたことを確かめる（届かなければ何も書かない）
// 4. `${コネクタ}/pair/callback?state=<s>&k=<k>` へ移る（コネクタが指紋を確かめて接続を終える）
// データ・通信は外から渡す（テストで差し替える）。
import {
  callbackUrl,
  identityUrl,
  isPairingKey,
  normalizeOrigin,
  pairingHash,
  parseIdentity,
  validState,
  APPROVED_ON_MAX_LENGTH,
  CONNECTOR_DOC_VERSION,
  type ConnectorIdentity,
  type ConnectorWrite,
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
  type ConnectorIdentity,
  type ConnectorWrite,
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
  /** 画面を離れた・やり直した（true なら先へ進まない。コネクタにも問い合わせない） */
  cancelled(): boolean
  /** いまの段階（画面の表示） */
  onStep?(step: 'checking' | 'sync' | 'identity'): void
}

export type PrepareResult =
  | { step: 'ready'; identity: ConnectorIdentity; ownerUid: string }
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
  return { step: 'ready', identity: r.identity, ownerUid: owner }
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
}

export type PairingResult = { ok: true; url: string } | { ok: false; error: string }

/** 送信待ちを送るのを待つ長さの上限 */
export const FLUSH_LIMIT_MS = 10_000

/** 送信待ちを送れなかった時（連携はまだ記録していない） */
export const NOT_SENT_ERROR =
  'タイトルの「Claude に見せる」などの変更を、まだクラウドへ送れていません。インターネットの接続を確かめて、もう一度［許可する］を押してください（連携はまだ記録していません）。'

/**
 * ［許可する］: タイトルの設定を変え、送信待ちがクラウドに届いたのを確かめてから、config/connector に連携の指紋を書き、
 * コネクタへ移る。k はコネクタへ移る URL にだけ入れる（Firestore には指紋だけ）。
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
  const k = deps.randomKey()
  if (!isPairingKey(k)) return { ok: false, error: '連携の鍵を作れませんでした。もう一度お試しください。' }
  for (const a of input.access) deps.setAccess(a.titleId, a.access)
  const sent = await deps.flush(FLUSH_LIMIT_MS).catch(() => false)
  if (!sent) return { ok: false, error: NOT_SENT_ERROR }
  const pairing = await pairingHash(state, k)
  try {
    await deps.writeConnector({
      uid: input.identity.uid,
      pairing,
      approvedOn: deps.deviceLabel().slice(0, APPROVED_ON_MAX_LENGTH),
      writes: input.writes,
      v: CONNECTOR_DOC_VERSION,
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
  const url = callbackUrl(origin, state, k)
  deps.navigate(url)
  return { ok: true, url }
}
