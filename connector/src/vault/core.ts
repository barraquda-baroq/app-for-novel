// Vault の中身（Durable Object の外でも動く。テストでは node:sqlite と Firebase エミュレーターで動かす）。
// 持ち主ごとに1つ（idFromName('owner')）。コネクタの身元・連携の状態・持ち主の記録の写し・数の記録・書き込みの順番を持つ。
import {
  connectionsOf,
  isPairingHash,
  LEGACY_CONNECTION_ID,
  MAX_CONNECTIONS,
  PAIRING_TTL_MS,
  type ConnectionInfo,
} from '../../../src/claude/pairing'
import {
  trashedBenchNamesOf,
  trashedIdsOf,
  trashedMaterialNamesOf,
  buildToolCall,
  isWriteTool,
  type WriteTool,
} from '../../../src/claude/records'
import { buildTrashRequests, TRASH_LIMITS, TRASH_TOOL, type TrashInput } from '../../../src/claude/trashRequest'
import { liveIdeaAppends } from '../../../src/claude/ideaAppend'
import {
  buildAddIdeas,
  buildIdeaAppend,
  IDEA_ADD_TOOL,
  isIdeaTool,
  type AddIdeasInput,
  type AppendIdeaInput,
  type IdeaTool,
} from '../../../src/claude/ideaWrite'
import { liveTrashRequests, pendingTrashTargets } from '../../../src/claude/trashTargets'
import { jstDate } from '../../../src/claude/dates'
import { noteServed, type ReadMemoAccess, type ReadMemoEntry } from '../../../src/claude/readMemo'
import type { ServedPart } from '../../../src/claude/view'
import { claudeView, canClaudeRead } from '../../../src/claude/visibility'
import { repairData } from '../../../src/domain/repair'
import type { AppData } from '../../../src/domain/types'
import type { VaultConfig } from '../config'
import { log, logError } from '../log'
import { CONNECTOR_DEVICE, CONNECTOR_MODEL, CONNECTOR_VERSION } from '../version'
import { ConnectorError, isAuthProblem, MESSAGES, modelMismatchMessage } from './errors'
import { FirestoreError, FirestoreRest } from './firestore'
import { Identity } from './identity'
import { Mirror, type SyncOutcome } from './mirror'
import { Mutex } from './mutex'
import {
  firestoreQuotaMessage,
  freshQuota,
  nextPacificMidnight,
  readBudgetMessage,
  resetLabel,
  writeBudgetMessage,
  writeReadBudgetMessage,
  type QuotaCounts,
} from './quota'
import { claimConsent, takeRate, type RateKind, type RateResult } from './ratelimit'
import { MirrorStore, type SqlRunner } from './store'
import { REQUEST_TIMEOUT_MS, withTimeout } from './timeout'
import { fail, type ToolResult } from './tools/common'
import { ideaAddError, ideaAddResult, ideaAppendResult } from './tools/ideas'
import * as R from './tools/read'
import { trashBuildError, trashResult } from './tools/trash'
import { buildError, writeResult } from './tools/write'
import { fromFields, timestampMillis, type Timestamp } from './values'
import { EncodeError, groups, prepareWrite, rowsOfCommit, type PreparedWrite } from './writer'

export interface VaultDeps {
  sql: SqlRunner
  fetch: typeof fetch
  config: VaultConfig
  /** TOKEN_ENC_KEY */
  secret: string | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 取り込みの続きを予約する（Durable Object の alarm）。null で取り消す */
  schedule?: (at: number | null) => void
  /** 読むツールの前に写しを新しくする間隔（ms。既定 15 秒。テストでは 0） */
  freshMs?: number
  /** Google の API（Firestore・トークン）への1回の要求を待つ上限（ms。既定 REQUEST_TIMEOUT_MS = 15 秒。テストでは短く） */
  timeoutMs?: number
}

export interface PairingMeta {
  state: 'paired' | 'unpaired'
  ownerUid: string | null
  /** 連携した時刻（ms） */
  pairedAt: number | null
  /** 解除した理由（ログ・状態の表示用） */
  reason?: string
  /**
   * 連携の代（確かめた時の config/connector の作られた時刻 createTime）。［連携をすべて解除］で消して作り直すと変わる
   * （「書き込みを許可」の切り替え・接続を足す・入れ替える・名前を変える・1つ解除する、では変わらない）
   */
  gen?: string | null
  /**
   * 2.9: 最後に読んだ config/connector の接続（cid）。無い = 2.8 の状態（[c0]。移し替えずにそのまま使う）。
   * クラウドを読めない時の、許可の接続の確かめに使う（断るのは5秒以内に読み直した一覧に無い時だけ）
   */
  cids?: string[]
}

/** OAuth の許可に入れた値（props）。連携した持ち主と、連携の代と、接続 */
export interface GrantProps {
  ownerUid?: string
  gen?: string
  /** 2.9: 許可した接続（config/connector の connections の鍵）。無い = 2.8 までの許可（c0「接続1」） */
  cid?: string
}

export type PairingCheck =
  | { ok: true; ownerUid: string; gen: string; cid: string }
  | { ok: false; reason: 'not_found' | 'uid' | 'hash' | 'expired' | 'used' | 'owner' | 'error'; message: string }

export type HealthState = 'ready' | 'unpaired' | 'no_identity' | 'anonymous_disabled' | 'key_missing' | 'unavailable'

export interface CallOptions {
  /** クライアントの名前（Claude Code なら本文の既定の文字数を減らす） */
  client?: string
  /** 呼び出しの OAuth の許可の props（渡せば、いまの連携の許可かを確かめる。/mcp からはいつも渡す） */
  grant?: GrantProps
}

/** 読むツールの前に写しを新しくする間隔 */
export const FRESH_MS = 15_000
/** config/connector・meta/app を読み直す間隔（どのツールの前・トークンの更新の前も） */
export const RECHECK_MS = 60_000
/** 許可の接続が一覧に無い時、断る前に読み直す（この時間より前に読んだ一覧では断らない。古い写しで許可を取り消さない） */
export const CONNECTION_FRESH_MS = 5_000
/** 読んだ話・幕の控え（readmemo）を使う期間。これより前に読んだ話は、控えが無いのと同じ（書く時の指紋） */
export const READ_MEMO_MAX_AGE_MS = 24 * 3_600_000
/** 読んだ話・幕の控えの行の数の上限（すべての接続で。超えれば古いものから消す） */
export const READ_MEMO_MAX_ROWS = 5_000
/** 読んだ話・幕の控えの古い行を片付ける間隔 */
const READ_MEMO_PRUNE_MS = 3_600_000

/** config/connector から読んだ、すべての接続に効く「書き込みを許可」と接続の一覧 */
export interface ConnectorState {
  writes: boolean
  /** 一覧の接続の cid（許可した時刻の順） */
  cids: string[]
  /** cid ごとの名前（novel_status の「この接続」） */
  names: Record<string, string>
  /** cid ごとの許可した時刻（ms。novel_status の「連携: 済み（…）」は呼び出した接続の時刻） */
  pairedAt: Record<string, number | null>
}

/**
 * 呼び出しの項目（items・cards の1件）から作るのでない記録の表: 新しい相対比較の作品・資料（new_work・new_material）、推敲案の
 * 実行の記録、新しいアイデアのフォルダ。呼び出しを分けても、最初の呼び出しには要る（書き込みの枠の断りの文）
 */
const NOT_ITEM_TABLES = new Set(['benchWorks', 'materials', 'proofBatches', 'ideaFolders'])

/** 今日（日本時間）ゴミ箱へ移す依頼を作った数（meta 'trashDaily'。日付が変われば 0 から） */
export interface TrashDaily {
  day: string
  count: number
}

const PAIRING_MESSAGES: Record<Exclude<PairingCheck, { ok: true }>['reason'], string> = {
  not_found:
    'アプリで許可された記録（config/connector）が見つからないか、別のコネクタのものです。アプリの連携の画面で［許可する］を押してから戻るか、claude.ai でもう一度「接続」からやり直してください。',
  uid: 'アプリで許可されたコネクタが、このコネクタではありません。claude.ai でもう一度「接続」からやり直してください。',
  hash: '連携の確かめが合いません（別の画面・別のブラウザで始めた接続の可能性）。claude.ai でもう一度「接続」からやり直してください。',
  expired: '連携の確かめの期限（15分）が過ぎました。claude.ai でもう一度「接続」からやり直してください。',
  used: 'この連携の確かめはもう使われています。claude.ai でもう一度「接続」からやり直してください。',
  owner: 'Novel Studio の持ち主（config/owner）が見つかりません。先にアプリで一度ログインして同期を始めてください。',
  error: '連携を確かめられませんでした。少し待ってから、claude.ai でもう一度「接続」からやり直してください。',
}

export class VaultCore {
  readonly store: MirrorStore
  readonly identity: Identity
  readonly fs: FirestoreRest
  readonly mirror: Mirror
  readonly #d: VaultDeps
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  /** 書き込みの順番（#write・#trash・#ideas。すべての接続で1つ）。写しの取り込みの順番（#sync）とは別 */
  readonly #mutex = new Mutex()
  /**
   * 動いている写しの取り込みの1歩（同時に1つだけ。seq は始めた順の番号）。読むツール・alarm は相乗りし、書き込み・夜の確かめは
   * 呼ばれる前に始まった1歩の後に自分の1歩を始める（#syncStep）
   */
  #sync: { seq: number; promise: Promise<SyncOutcome> } | null = null
  /** 始めた取り込みの1歩の数 */
  #syncSeq = 0
  /** 最後に最後まで読み終えた時刻（novel_status の「最後に新しくした時刻」・読むツールの15秒） */
  #lastSync = 0
  /**
   * 写しが端末の変更の途中までしか取り込めていない（最後の1歩が最後まで読まずに終わった・ページの途中で失敗した）。この間は、
   * 15秒以内に最後まで読んでいても、読むツールは取り込みを1歩進める（端末の1回の変更の一部だけを取り込んだ写しを、知らせなしに
   * 読ませない）。1歩を始める時に立て、最後まで読めた時だけ下ろす
   */
  #behind = false
  #views: { version: number; raw: AppData; view: AppData; hidden: number } | null = null
  /**
   * 最後に読めた config/connector（at は読み始めた時刻、seq は読み始めた順の番号）。Durable Object は Firestore の答えを待つ間に
   * ほかの呼び出しも進めるので、遅く届いた古い一覧で、後から読み始めた一覧（足したばかりの接続を含む）を上書きしない
   */
  #connCheck: (ConnectorState & { at: number; seq: number }) | null = null
  /** config/connector を読み始めた数（#readConnector と verifyPairing。読み始めた順の番号に使う） */
  #connSeq = 0
  #modelCheck: { model: number | null; at: number } | null = null
  /** 読んだ話・幕の控えの古い行を最後に片付けた時刻（Durable Object を作り直した後は、最初に控えた時に片付ける） */
  #memoPrunedAt = 0

  constructor(deps: VaultDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => Date.now())
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.store = new MirrorStore(deps.sql)
    // Google の API への要求は、1回ごとに待つ上限を付ける（答えの来ない要求で、書き込みの順番を持ったまま止まらないように）
    const fetch = withTimeout(deps.fetch, deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
    this.identity = new Identity({
      fetch,
      identityUrl: deps.config.identityUrl,
      tokenUrl: deps.config.tokenUrl,
      apiKey: deps.config.apiKey,
      secret: deps.secret,
      store: this.store,
      now: this.#now,
      sleep: this.#sleep,
      onLost: () => this.#setUnpaired('identity_lost'),
    })
    this.fs = new FirestoreRest({
      fetch,
      baseUrl: deps.config.firestoreUrl,
      projectId: deps.config.projectId,
      token: (force) => this.identity.idToken(force),
      sleep: this.#sleep,
    })
    this.mirror = new Mirror(this.store, this.fs, () => {
      const owner = this.pairing().ownerUid
      if (!owner) throw new ConnectorError('unpaired', MESSAGES.unpaired)
      return owner
    })
  }

  // ---------- 連携の状態 ----------

  pairing(): PairingMeta {
    return this.store.getMeta<PairingMeta>('pairing') ?? { state: 'unpaired', ownerUid: null, pairedAt: null }
  }

  pairingState(): 'paired' | 'unpaired' {
    return this.pairing().state === 'paired' && this.identity.uid() ? 'paired' : 'unpaired'
  }

  /**
   * OAuth の許可が、いまの連携（同じ持ち主・同じ代）のものか（写しの状態だけで見る。クラウドは読まない）。［連携をすべて解除］の
   * 後に連携し直した・持ち主が変わった後は、前の許可は使えない（解除した Claude のアカウントが、別の連携で読めるようにならないように）
   */
  #grantMatchesPairing(p: GrantProps | null | undefined): boolean {
    if (this.pairingState() !== 'paired' || !p) return false
    const m = this.pairing()
    return !!m.ownerUid && !!m.gen && p.ownerUid === m.ownerUid && p.gen === m.gen
  }

  /**
   * トークンの更新の前（index.ts の tokenExchangeCallback）: 許可が、いまの連携の、一覧にある接続のものか。
   * 一覧は RECHECK_MS ごとに読み直し、無い接続は5秒以内に読み直してから断る。つながらない・Firebase の無料枠などの一時的な失敗では
   * 切らない（true）。解除された・一覧から外された接続は false（ライブラリがその許可だけを取り消す）
   */
  async checkGrant(p: GrantProps | null | undefined): Promise<boolean> {
    if (!p || !this.#grantMatchesPairing(p)) return false
    try {
      await this.#requireConnection(p)
      return true
    } catch (e) {
      if (e instanceof ConnectorError && isAuthProblem(e.code)) return false
      if (!(e instanceof ConnectorError)) logError('grant_check_failed', e)
      return true
    }
  }

  #setUnpaired(reason: string): void {
    const cur = this.pairing()
    if (cur.state !== 'unpaired') log('pairing_lost', { reason })
    // 持ち主は覚えておく（同じ持ち主と連携し直せば、写しをそのまま使える）
    this.store.setMeta('pairing', { ...cur, state: 'unpaired', reason } satisfies PairingMeta)
    this.#connCheck = null
    this.#modelCheck = null
    this.#d.schedule?.(null)
  }

  // ---------- /connect/identity・GET / ----------

  /** アプリの連携の画面に渡すコネクタの身元（無ければ作る） */
  async connectIdentity(): Promise<{ uid: string; version: string; model: number }> {
    try {
      let uid = await this.identity.ensure()
      // 身元がまだ使えるか確かめる（使えなければ新しい身元を作る。アプリが古い uid で許可しないように）
      try {
        await this.identity.idToken()
      } catch (e) {
        if (!(e instanceof ConnectorError && e.code === 'identity_lost')) throw e
        uid = await this.identity.ensure()
      }
      this.store.deleteMeta('lastIdentityError')
      return { uid, version: CONNECTOR_VERSION, model: CONNECTOR_MODEL }
    } catch (e) {
      if (e instanceof ConnectorError) this.store.setMeta('lastIdentityError', e.code)
      throw e
    }
  }

  health(): HealthState {
    const err = this.store.getMeta<string>('lastIdentityError')
    if (!this.identity.uid()) {
      if (err === 'anonymous_disabled' || err === 'key_missing' || err === 'unavailable') return err
      return 'no_identity'
    }
    return this.pairingState() === 'paired' ? 'ready' : 'unpaired'
  }

  // ---------- 連携の確かめ（/pair/callback） ----------

  /**
   * アプリが書いた config/connector を、コネクタの身元で読んで確かめる: uid がこのコネクタ・指紋が同じ・15分以内・まだ使っていない。
   * 合えば連携した状態にして、写しの取り込みを始める。2.9: 指紋は接続ごと（15分の間に2つ許可しても、それぞれの指紋で確かめられる）。
   * 指紋の合う接続がちょうど1つの時だけ、その接続（cid）の許可にする。v1 の記録（2.8 のアプリ）は c0「接続1」
   */
  async verifyPairing(hash: string): Promise<PairingCheck> {
    const bad = (reason: Exclude<PairingCheck, { ok: true }>['reason']): PairingCheck => {
      log('pairing_refused', { reason })
      return { ok: false, reason, message: PAIRING_MESSAGES[reason] }
    }
    if (!isPairingHash(hash)) return bad('hash')
    const used = this.store.getMeta<string[]>('usedPairings') ?? []
    if (used.includes(hash)) return bad('used')
    let uid: string
    try {
      uid = await this.identity.ensure()
    } catch (e) {
      logError('pairing_identity_failed', e)
      return bad('error')
    }
    let ownerUid: string | null = null
    try {
      const owner = (await this.fs.batchGet(['config/owner'])).get('config/owner')
      ownerUid = owner ? (fromFields(owner.fields).uid as string | null) : null
    } catch (e) {
      logError('pairing_owner_failed', e)
      return bad('error')
    }
    if (!ownerUid) return bad('owner')
    let conn: Record<string, unknown> | null = null
    let gen = ''
    const seq = ++this.#connSeq
    const startedAt = this.#now()
    try {
      const d = (await this.fs.batchGet(['config/connector'])).get('config/connector')
      conn = d ? fromFields(d.fields) : null
      gen = d?.createTime ?? ''
    } catch (e) {
      // 無い記録・自分の uid でない記録は、アクセスルールで読めない（403。どちらかは分からない）
      if (e instanceof FirestoreError && e.status === 403) return bad('not_found')
      logError('pairing_connector_failed', e)
      return bad('error')
    }
    if (!conn || !gen) return bad('not_found')
    if (conn.uid !== uid) return bad('uid')
    // v1（connections が無い）は記録の pairing・pairedAt の c0 だけ。v2 で正しい接続が1つも無ければ、解除と同じ
    const list = connectionsOf(conn, plainMillis)
    if (!list) return bad('not_found')
    const hits = list.filter((c) => c.pairing === hash)
    if (hits.length !== 1) return bad('hash')
    const entry = hits[0]
    // 期限は、その接続の許可の時刻から（ほかの接続・最後の許可の時刻ではなく）
    const pairedAt = entry.pairedAt
    const now = this.#now()
    if (pairedAt === null || now - pairedAt > PAIRING_TTL_MS || pairedAt - now > 2 * 60_000) return bad('expired')
    this.store.setMeta('usedPairings', [...used, hash].slice(-50))
    const prev = this.pairing()
    if (prev.ownerUid && prev.ownerUid !== ownerUid) {
      log('mirror_owner_changed')
      this.mirror.reset()
      this.#views = null
    }
    // 確かめている間に、後から読み始めた同じ記録の一覧が届いていれば、そちらを覚えたままにする（新しい）
    const cached = this.#connCheck
    const state = cached && cached.seq > seq && prev.gen === gen ? cached : { ...connectorState(conn, list), at: startedAt, seq }
    this.store.setMeta('pairing', { state: 'paired', ownerUid, pairedAt, gen, cids: state.cids } satisfies PairingMeta)
    this.#connCheck = state
    this.#modelCheck = null
    log('paired', { writes: state.writes, connections: state.cids.length })
    this.#d.schedule?.(now + 500)
    return { ok: true, ownerUid, gen, cid: entry.cid }
  }

  // ---------- 数の記録（太平洋時間の日ごと） ----------

  #quota(): QuotaCounts {
    return freshQuota(this.#now(), this.store.getMeta<QuotaCounts>('quota'))
  }

  /** 読み取りを数える（負の数で戻す）。上限を超えるなら数えずに false */
  #takeReads(n: number): boolean {
    const q = this.#quota()
    if (n > 0 && q.reads + n > this.#d.config.dailyReadBudget) return false
    this.store.setMeta('quota', { ...q, reads: Math.max(0, q.reads + n) } satisfies QuotaCounts)
    return true
  }

  /** 止めずに数えるだけ（連携の記録・データの形の版など、無いと何もできない読み取り） */
  #countReads(n: number): void {
    const q = this.#quota()
    this.store.setMeta('quota', { ...q, reads: q.reads + n } satisfies QuotaCounts)
  }

  /** 書き込みを数える（負の数で戻す。書けなかった分）。上限を超えるなら数えずに false */
  #takeWrites(n: number): boolean {
    const q = this.#quota()
    if (n > 0 && q.writes + n > this.#d.config.dailyWriteBudget) return false
    this.store.setMeta('quota', { ...q, writes: Math.max(0, q.writes + n) } satisfies QuotaCounts)
    return true
  }

  /**
   * 書く前に、この呼び出しの記録（prepared）の数を書き込みの数に入れる。残り（すべての接続で1つ）に入らなければ、数えずに呼び出し
   * 全体を断る（一部だけは書かない）。断る文には残りとこの呼び出しの数を出す（field は分けて送る入力の名前）。項目でない記録
   * （新しい作品・資料、実行の記録、新しいフォルダ）は分けた呼び出しにも要るので、残りがそれと項目1件より少なければ、分けても
   * 入らないと言う
   */
  #needWrites(prepared: readonly PreparedWrite[], field: 'items' | 'cards'): void {
    const n = prepared.length
    if (this.#takeWrites(n)) return
    const left = this.#d.config.dailyWriteBudget - this.#quota().writes
    const min = Math.min(n, prepared.filter((p) => NOT_ITEM_TABLES.has(p.table)).length + 1)
    throw new ConnectorError('write_budget', writeBudgetMessage(this.#now(), left, n, field, min))
  }

  /**
   * 読み取りの枠が足りずに取り込めなかった。書き込みの前なら、残りがあっても最新の変更を確かめられないので書かないことを言う
   * （読むツールの前は、使い切った時の文）
   */
  #readBudgetError(forWrite: boolean): ConnectorError {
    const now = this.#now()
    if (!forWrite) return new ConnectorError('read_budget', readBudgetMessage(now))
    return new ConnectorError('read_budget', writeReadBudgetMessage(now, this.#d.config.dailyReadBudget - this.#quota().reads))
  }

  // ---------- 写し ----------

  /** Firestore の失敗を、日本語の説明つきの失敗にする（403 は連携が解除されたかを確かめる） */
  async #firestoreFailure(e: unknown): Promise<never> {
    if (e instanceof ConnectorError) throw e
    if (e instanceof FirestoreError) {
      if (e.code === 'RESOURCE_EXHAUSTED' || e.status === 429)
        throw new ConnectorError('firestore_quota', firestoreQuotaMessage(this.#now()))
      if (e.status === 403) {
        if ((await this.#readConnector()) === null) throw new ConnectorError('unpaired', MESSAGES.unpaired)
        throw new ConnectorError('permission', MESSAGES.permission)
      }
      logError('firestore_failed', e, { status: e.status, code: e.code })
      throw new ConnectorError('unavailable', MESSAGES.unavailable)
    }
    logError('vault_failed', e)
    throw new ConnectorError('unavailable', MESSAGES.unavailable)
  }

  /**
   * config/connector を読む。「書き込みを許可」と接続の一覧を返す（読めない・このコネクタのものでない・確かめた連携の後に作り直された・
   * 正しい接続が1つも無い = null。作り直された記録は、連携の画面で許可しただけでまだ確かめていない（/pair/callback を通っていない）
   * ので、前の許可では使わない）。読めた内容は #connCheck に覚え、接続の一覧が変わった時だけ連携の状態にも残す。null の時は連携を外す。
   * 読み始めた順で覚える: 後から読み始めた読み取り・確かめ（verifyPairing）の一覧がもう届いていれば、この答えは捨ててそちらを返す。
   * null の答えも、後から読み取り・確かめを始めていれば連携は外さない（連携し直した後に届いた古い答えで、新しい連携を外さない。
   * 外すかどうかは後の答えで決める）。この時も、後の一覧が届いていても null を返す（読み始めた時の記録はもう無いので、その時の
   * 連携の許可は断ってよい。許可の代は #requireConnection・#status でも読んだ後に確かめる）
   */
  async #readConnector(): Promise<ConnectorState | null> {
    const seq = ++this.#connSeq
    const at = this.#now()
    let state: ConnectorState | null = null
    try {
      this.#countReads(3)
      const d = (await this.fs.batchGet(['config/connector'])).get('config/connector')
      if (d && (d.createTime ?? '') === (this.pairing().gen ?? '')) {
        const f = fromFields(d.fields)
        const list = f.uid === this.identity.uid() ? connectionsOf(f, plainMillis) : null
        if (list) state = connectorState(f, list)
      }
    } catch (e) {
      if (!(e instanceof FirestoreError && e.status === 403)) {
        if (e instanceof ConnectorError) throw e
        logError('connector_read_failed', e)
        throw new ConnectorError('unavailable', MESSAGES.unavailable)
      }
    }
    if (!state) {
      if (seq < this.#connSeq) log('connector_gone_superseded')
      else this.#setUnpaired('connector_gone')
      return null
    }
    const cached = this.#connCheck
    if (cached && cached.seq > seq) return cached
    this.#connCheck = { ...state, at, seq }
    const m = this.pairing()
    const before = m.cids ?? [LEGACY_CONNECTION_ID]
    if (m.state === 'paired' && (before.length !== state.cids.length || before.some((c) => !state.cids.includes(c))))
      this.store.setMeta('pairing', { ...m, cids: state.cids } satisfies PairingMeta)
    return state
  }

  #requirePaired(): void {
    if (this.pairingState() !== 'paired') throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /**
   * 写しを1歩新しくする。同時に動く取り込みは1つだけ（重ねると同じページを何回も読み、遅れて届いた古いページが写しを戻す）。
   * 動いている1歩があれば:
   * - own = false（読むツール・alarm）: その1歩に相乗りして、同じ答え（失敗も）を受け取る
   * - own = true（書き込みの前・書き込みの試し直し・夜の確かめ）: 呼ばれた後のクラウドを読む必要があるので、呼ばれる前に始まった
   *   1歩は終わるのを待ってから、自分の1歩を始める（呼ばれた後に始まった1歩なら、それに相乗りする）。待った1歩が失敗したら、その
   *   失敗を受け取る（つながらない・答えが来ない時に、すぐ後でもう一度読んで、上限まで2回待たせない）
   * 取り込みは書き込みの順番（#mutex）を待たない（書き込みの途中でも alarm・夜の確かめ・読むツールは進む。書き込みは #mutex を
   * 持ったまま取り込みを待つが、取り込みが #mutex を待つことは無いので、待ち合って止まらない）。失敗しても順番は空く（finally）
   */
  async #syncStep(maxPages: number, own = false): Promise<SyncOutcome> {
    const arrived = this.#syncSeq
    for (let cur = this.#sync; cur; cur = this.#sync) {
      if (!own || cur.seq > arrived) return cur.promise
      await cur.promise
    }
    const seq = ++this.#syncSeq
    const promise = this.#runSync(maxPages).finally(() => {
      if (this.#sync?.seq === seq) this.#sync = null
    })
    this.#sync = { seq, promise }
    return promise
  }

  async #runSync(maxPages: number): Promise<SyncOutcome> {
    // 1ページ目を入れた後に失敗しても途中のまま（下ろすのは最後まで読めた時だけ）
    this.#behind = true
    try {
      const out = await this.mirror.sync({
        maxPages,
        workBudget: this.#d.config.workBudgetChars,
        takeReads: (n) => this.#takeReads(n),
      })
      if (out.done) {
        this.#lastSync = this.#now()
        this.#behind = false
      }
      return out
    } catch (e) {
      return this.#firestoreFailure(e)
    }
  }

  #warmingMessage(): string {
    const w = this.mirror.warm()
    const progress = w.total ? `（${w.seen.toLocaleString('ja-JP')}/${w.total.toLocaleString('ja-JP')}件）` : `（${w.seen.toLocaleString('ja-JP')}件）`
    return `初回の取り込み中${progress}。少し待ってから、もう一度試してください。`
  }

  /** 書き込みの前の取り込みが5歩で終わらなかった（端末からの変更が多い。docs はこの呼び出しで取り込んだ文書の数） */
  #catchingUpMessage(docs: number): string {
    return `端末からの変更を取り込んでいる途中です（この呼び出しで ${docs.toLocaleString('ja-JP')}件を取り込みました）。何も書いていません。少し待ってから、もう一度試してください。`
  }

  /**
   * ツールの前に写しを新しくする。初回の取り込みが終わっていなければ1歩進めて「取り込み中」を返す。
   * 書き込みの前は最後まで読む（重複・以前に削除された記録を見分けるため）。5歩で読み終わらなければ書かない（catching_up）
   */
  async #fresh(forWrite: boolean): Promise<{ note?: string }> {
    if (!this.mirror.warm().done) {
      const out = await this.#syncStep(8, forWrite)
      if (out.outOfReads) throw this.#readBudgetError(forWrite)
      if (!out.done) {
        this.#d.schedule?.(this.#now() + 1_000)
        throw new ConnectorError('warming', this.#warmingMessage())
      }
      return {}
    }
    if (forWrite) {
      let docs = 0
      for (let i = 0; i < 5; i++) {
        const out = await this.#syncStep(8, true)
        docs += out.docs
        if (out.done) return {}
        if (out.outOfReads) throw this.#readBudgetError(true)
      }
      // 取り込みの途中の写しでは、以前に削除された作品・カードなどを見分けられないので書かない（続きは alarm で取り込む）
      this.#d.schedule?.(this.#now() + 1_000)
      log('write_catching_up', { docs })
      throw new ConnectorError('catching_up', this.#catchingUpMessage(docs))
    }
    const out = await this.#freshRead()
    // 待っている間に写しを消して取り込み直すことになった（夜の確かめで数が合わない・持ち主が変わった）
    if (!this.mirror.warm().done) {
      this.#d.schedule?.(this.#now() + 1_000)
      throw new ConnectorError('warming', this.#warmingMessage())
    }
    return out
  }

  /**
   * 読むツールの前: 動いている取り込みがあれば、その終わりを待つ（ページの間の、端末の1回の変更の一部だけを取り込んだ写しを
   * 読まない）。終わっていれば（最後まで読んだ・15秒以内に最後まで読んで、その後の1歩が途中で終わっていない）そのまま、
   * まだなら1歩進める（それでも途中なら「取り込みの途中の内容です」と添える）
   */
  async #freshRead(): Promise<{ note?: string }> {
    const reset = () => resetLabel(this.#now())
    try {
      const running = this.#sync
      if (running) {
        const out = await running.promise
        if (out.done) return {}
        if (out.outOfReads) return { note: `（今日の読み取り枠を使い切ったため、最新の変更を取り込めていません。${reset()}に回復します）` }
      } else if (!this.#behind && this.#now() - this.#lastSync < (this.#d.freshMs ?? FRESH_MS)) return {}
      const out = await this.#syncStep(8)
      if (out.done) return {}
      if (out.outOfReads) return { note: `（今日の読み取り枠を使い切ったため、最新の変更を取り込めていません。${reset()}に回復します）` }
    } catch (e) {
      // つながらない時・Firebase の無料枠を使い切った時は前に取り込んだ内容で答える（連携の解除・権限の問題はそのまま返す）
      if (e instanceof ConnectorError && e.code === 'unavailable') return { note: '（いまクラウドに接続できないため、前に取り込んだ内容です）' }
      if (e instanceof ConnectorError && e.code === 'firestore_quota')
        return { note: `（Firebase の今日の無料枠を使い切ったため、前に取り込んだ内容です。${reset()}に回復します）` }
      throw e
    }
    this.#d.schedule?.(this.#now() + 1_000)
    return { note: '（端末からの変更が多いため、取り込みの途中の内容です）' }
  }

  /** 修復した内容（表示用）と、Claude に見せる内容（見せないタイトル・ゴミ箱などを除く） */
  views(): { raw: AppData; view: AppData; hidden: number } {
    const version = this.mirror.version()
    if (this.#views && this.#views.version === version) return this.#views
    // 修復は、稿の本文を読まずに本文を除いた記録で行い（修復は本文の形しか見ない）、残った稿を本文を後から読む記録に戻す
    const data = this.mirror.data()
    const heads = this.mirror.versionHeads()
    const repaired = repairData({ ...data, versions: heads }).data
    const versions: AppData['versions'] = {}
    for (const [id, v] of Object.entries(repaired.versions))
      versions[id] = v === heads[id] && data.versions[id] ? data.versions[id] : this.mirror.lazyVersion(v, data.versions[id])
    // 写しは表をその場で書き換えるので、表の参照で覚える部品（benchTags.ts の analysesByWorkId。自動のタグ）が古い内容を
    // 返さないように、相対比較の分析の表は写しが変わるたびに新しい表にする
    const raw: AppData = { ...repaired, versions, benchAnalyses: { ...repaired.benchAnalyses } }
    const view = claudeView(raw)
    const hidden = Object.values(raw.titles).filter((t) => !canClaudeRead(t)).length
    this.#views = { version, raw, view, hidden }
    return this.#views
  }

  // ---------- ツール ----------

  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
    try {
      // 前の連携の許可（解除した後・持ち主が変わった後）は、状態のツールも含めて使わない（写しの状態だけで見る）
      if (opts.grant && !this.#grantMatchesPairing(opts.grant)) {
        log('grant_stale', { tool: name })
        throw new ConnectorError('unpaired', MESSAGES.unpaired)
      }
      if (name === 'novel_status') return await this.#status(opts.grant)
      this.#requirePaired()
      // 連携の記録を1分ごとに確かめる（どのツールも。解除・作り直し・一覧から外された接続に、写しを新しくする間隔より遅れずに
      // 気付く）。書き込みの許可はここで読んだ内容を使う
      await this.#requireConnection(opts.grant)
      if (name === TRASH_TOOL) return await this.#trash(args, opts.grant)
      if (isIdeaTool(name)) return await this.#ideas(name, args, opts.grant)
      if (isWriteTool(name)) return await this.#write(name, args, opts.grant)
      const { note } = await this.#fresh(false)
      const { view, hidden } = this.views()
      const reader = readerOf(opts.grant)
      const ctx: R.ReadContext = {
        view,
        now: this.#now(),
        client: opts.client,
        workBudget: this.#d.config.workBudgetChars,
        ...(reader ? { onServed: (parts: readonly ServedPart[]) => this.#noteServed(reader, view, parts) } : {}),
      }
      const result = this.#read(name, ctx, args, hidden)
      return note && !result.isError ? { ...result, text: `${note}\n${result.text}` } : result
    } catch (e) {
      if (e instanceof ConnectorError) {
        log('tool_refused', { tool: name, code: e.code })
        return { text: e.message, isError: true, auth: isAuthProblem(e.code) || undefined }
      }
      logError('tool_failed', e, { tool: name })
      return { text: MESSAGES.unavailable, isError: true }
    }
  }

  // ---------- 読んだ話・幕の控え（2.9。推敲案の確かめた範囲） ----------

  /**
   * 接続（reader）の控え（readmemo）。Durable Object は使われない間にメモリから外れる（読んでから推敲案を足すまでに数分かかる）
   * ので、SQLite に置く。READ_MEMO_MAX_AGE_MS より前に控えた話は無いのと同じ
   */
  #readMemo(reader: string): ReadMemoAccess {
    return {
      get: (pieceId) => {
        const row = this.store.getReadMemo(reader, pieceId, this.#now() - READ_MEMO_MAX_AGE_MS)
        return row ? memoEntry(row.hash, row.ver, row.parts) : undefined
      },
      set: (pieceId, entry) =>
        this.store.putReadMemo(reader, pieceId, {
          hash: entry.hash,
          ver: entry.versionId,
          parts: JSON.stringify(entry.parts),
          at: this.#now(),
        }),
    }
  }

  /** novel_read_text が出した話・幕を控える（控えられなくても読む答えはそのまま返す。推敲案は書く時の指紋になるだけ） */
  #noteServed(reader: string, view: AppData, parts: readonly ServedPart[]): void {
    try {
      this.store.transaction(() => noteServed(view, parts, this.#readMemo(reader)))
      const now = this.#now()
      if (now - this.#memoPrunedAt >= READ_MEMO_PRUNE_MS) {
        this.#memoPrunedAt = now
        this.store.pruneReadMemo(now - READ_MEMO_MAX_AGE_MS, READ_MEMO_MAX_ROWS)
      }
    } catch (e) {
      logError('read_memo_failed', e)
    }
  }

  #read(name: string, ctx: R.ReadContext, args: Record<string, unknown>, hidden: number): ToolResult {
    switch (name) {
      case 'novel_list_titles':
        return R.listTitles(ctx, hidden)
      case 'novel_get_outline':
        return R.getOutline(ctx, args)
      case 'novel_read_text':
        return R.readText(ctx, args)
      case 'novel_list_versions':
        return R.listVersions(ctx, args)
      case 'novel_search_text':
        return R.searchText(ctx, args)
      case 'novel_get_notes':
        return R.getNotes(ctx, args)
      case 'novel_get_strategy':
        return R.getStrategy(ctx, args)
      case 'novel_get_critique':
        return R.getCritique(ctx, args)
      case 'novel_list_proofreading':
        return R.listProofreading(ctx, args)
      case 'novel_list_bench_works':
        return R.listBenchWorks(ctx, args)
      case 'novel_get_bench_analysis':
        return R.getBenchAnalysis(ctx, args)
      case 'novel_list_materials':
        return R.listMaterials(ctx, args)
      case 'novel_get_material':
        return R.getMaterial(ctx, args)
      default:
        return fail(`知らないツールです: ${name}`)
    }
  }

  async #status(grant?: GrantProps): Promise<ToolResult> {
    const p = this.pairing()
    const paired = this.pairingState() === 'paired'
    const q = this.#quota()
    const now = this.#now()
    const lines = [`Novel Studio コネクタ ${CONNECTOR_VERSION}（データの形 ${CONNECTOR_MODEL}）`]
    if (!paired) {
      lines.push('連携: していません（claude.ai でコネクタに接続し、アプリで許可してください）')
      return { text: lines.join('\n'), auth: this.identity.uid() ? true : undefined, isError: true }
    }
    // 「連携: 済み（…）」の時刻は、記録を読んだ後に決める（呼び出した接続の許可の時刻。この行の形は変えない）
    lines.push('')
    let writes: boolean | null = this.#connCheck?.writes ?? null
    let model: number | null = this.#modelCheck?.model ?? null
    try {
      const conn = await this.#readConnector()
      if (conn === null) return { text: MESSAGES.unpaired, isError: true, auth: true }
      // 読んでいる間にすべて解除して連携し直された（前の代の許可）: 一覧に同じ cid があっても断る
      if (grant && !this.#grantMatchesPairing(grant)) {
        log('grant_stale', { tool: 'novel_status' })
        return { text: MESSAGES.unpaired, isError: true, auth: true }
      }
      // 一覧から外された接続（いま読んだ一覧に無い）: この許可だけを断る（ほかの接続・Vault の連携はそのまま）
      if (grant && !conn.cids.includes(grant.cid ?? LEGACY_CONNECTION_ID)) {
        log('grant_removed', { tool: 'novel_status' })
        return { text: MESSAGES.unpaired, isError: true, auth: true }
      }
      writes = conn.writes
      model = await this.#readModel()
    } catch (e) {
      if (e instanceof ConnectorError && isAuthProblem(e.code)) return { text: e.message, isError: true, auth: true }
      lines.push('（クラウドの設定を読めませんでした）')
    }
    // 2.9: 許可のある呼び出しは、接続の一覧にあるその接続の許可の時刻（無い・読めなければ、最後に確かめた連携の時刻）
    const listed = this.#connCheck
    const cid = grant?.cid ?? LEGACY_CONNECTION_ID
    const pairedAt = (grant && listed?.cids.includes(cid) ? listed.pairedAt[cid] : null) ?? p.pairedAt
    lines[1] = `連携: 済み（${pairedAt ? new Date(pairedAt + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '―'} 日本時間）`
    lines.push(`書き込み: ${writes ? '許可' : '停止中（アプリの 設定 → Claude 連携 →「書き込みを許可」）'}`)
    lines.push(
      `アプリのデータの形: ${model ?? '記録なし'}${model === CONNECTOR_MODEL ? '（一致）' : `（コネクタは ${CONNECTOR_MODEL}。書き込みは止まります）`}`,
    )
    const warm = this.mirror.warm()
    const counts = this.mirror.counts()
    lines.push(
      warm.done
        ? `取り込み: 完了（記録 ${counts.live.toLocaleString('ja-JP')}件・削除の印 ${counts.deleted.toLocaleString('ja-JP')}件${this.#lastSync ? `・最後に新しくした時刻 ${new Date(this.#lastSync + 9 * 3_600_000).toISOString().slice(11, 19)}` : ''}）`
        : `取り込み: ${this.#warmingMessage()}`,
    )
    lines.push(`読めなかった記録: ${this.mirror.unreadableCount()}件`)
    lines.push(
      `今日（太平洋時間 ${q.day}）の読み取り ${q.reads.toLocaleString('ja-JP')} / ${this.#d.config.dailyReadBudget.toLocaleString('ja-JP')}・書き込み ${q.writes.toLocaleString('ja-JP')} / ${this.#d.config.dailyWriteBudget.toLocaleString('ja-JP')}（${resetLabel(now)}に戻ります）`,
    )
    lines.push(`Claude に見せていないタイトル: ${warm.done ? this.views().hidden : '―'}件`)
    lines.push(
      `ゴミ箱へ移す依頼: アプリの同期待ち ${warm.done ? liveTrashRequests(this.views().raw).length.toLocaleString('ja-JP') : '―'}件・今日（日本時間）${this.#trashDaily().count} / ${TRASH_LIMITS.perDay}件`,
    )
    // 2.8（前の行は 2.7 と1字も変えない）
    lines.push(
      `アイデアへの追記の依頼: アプリの同期待ち ${warm.done ? liveIdeaAppends(this.views().raw).length.toLocaleString('ja-JP') : '―'}件`,
    )
    // 2.9: 接続が2つ以上ある時は、今日の数と上限がすべての接続を合わせた数であること（ほかのアカウントが使った分も入る。
    // 許可の無い呼び出しにも出す。「この接続」の行の前に足すだけで、ほかの行は変えない）
    if ((listed?.cids ?? p.cids ?? []).length >= 2)
      lines.push(`（読み取り・書き込みの枠と、ゴミ箱へ移す1日${TRASH_LIMITS.perDay}件は、すべての接続を合わせた数です）`)
    // 2.9: 許可のある呼び出し（/mcp）だけ、最後にこの接続の名前（名前を読めた時だけ。いつも最後の行）
    const conn = grant ? this.#connCheck : null
    if (conn && conn.cids.includes(cid))
      lines.push(
        `この接続: ${conn.names[cid]}（接続 ${conn.cids.length} / ${MAX_CONNECTIONS}。名前はアプリの 設定 → Claude 連携 で変えられます）`,
      )
    return { text: lines.join('\n') }
  }

  /** users/{owner}/meta/app の model（無い = null） */
  async #readModel(): Promise<number | null> {
    const owner = this.pairing().ownerUid
    if (!owner) throw new ConnectorError('unpaired', MESSAGES.unpaired)
    try {
      this.#countReads(3)
      const d = (await this.fs.batchGet([`users/${owner}/meta/app`])).get(`users/${owner}/meta/app`)
      const m = d ? fromFields(d.fields).model : null
      const model = typeof m === 'number' ? m : null
      this.#modelCheck = { model, at: this.#now() }
      return model
    } catch (e) {
      return this.#firestoreFailure(e)
    }
  }

  /**
   * どのツールの前も・トークンの更新の前も: config/connector を前に読んでから RECHECK_MS 経っていれば読み直す（記録が消された・
   * 作り直された・正しい接続が無いなら連携を外す。つながらない時は前に読んだ内容のまま）。許可（p）の接続が一覧に無ければ、
   * 5秒より前に読んだ一覧なら1回読み直し、それでも無ければこの許可だけを断る（Vault の連携は外さない。ほかの接続はそのまま使える。
   * 古い一覧では断らないので、足したばかりの接続の許可を取り消さない）
   */
  async #requireConnection(p?: GrantProps): Promise<void> {
    if (!this.#connCheck || this.#now() - this.#connCheck.at >= RECHECK_MS) {
      try {
        await this.#readConnectorOrUnpair()
      } catch (e) {
        // つながらない時は、前に読んだ内容（無ければ連携の状態に残した一覧）で続ける（#fresh と同じ）
        if (!(e instanceof ConnectorError && e.code === 'unavailable')) throw e
      }
    }
    if (!p) return
    this.#requireGrantCurrent(p)
    const cid = p.cid ?? LEGACY_CONNECTION_ID
    if (this.#listed(cid)) return
    if (!this.#connCheck || this.#now() - this.#connCheck.at >= CONNECTION_FRESH_MS) {
      // 読めなければ断らずに失敗にする（つながらない時の答え。許可は取り消さない）
      await this.#readConnectorOrUnpair()
      this.#requireGrantCurrent(p)
      if (this.#listed(cid)) return
    }
    log('grant_removed')
    throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /**
   * 読んでいる間に、すべて解除して連携し直した（代が変わった）・連携が外れた時は、前の連携の許可を断る（呼び出しの始めに
   * 確かめた代は、読み取りを待つ間に古くなることがある。一覧に同じ cid があっても、前の代の許可は使わない）
   */
  #requireGrantCurrent(p: GrantProps): void {
    if (this.#grantMatchesPairing(p)) return
    log('grant_stale')
    throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /** 許可の接続が一覧にあるか（最後に読めた一覧。まだ読んでいなければ連携の状態に残した一覧。2.8 の状態は [c0]） */
  #listed(cid: string): boolean {
    return (this.#connCheck?.cids ?? this.pairing().cids ?? [LEGACY_CONNECTION_ID]).includes(cid)
  }

  /** config/connector を読む。消された・作り直された・正しい接続が無い時は unpaired（連携を外すのは #readConnector） */
  async #readConnectorOrUnpair(): Promise<ConnectorState> {
    const conn = await this.#readConnector()
    if (conn === null) throw new ConnectorError('unpaired', MESSAGES.unpaired)
    return conn
  }

  /**
   * 書き込みの前: 「書き込みを許可」とデータの形の版を確かめる。前に読んだ内容は1分（RECHECK_MS）使うが、断る内容（停止中・版が
   * 違う）は5秒（CONNECTION_FRESH_MS）まで: それより前に読んだ内容なら、断る前に1回読み直す（作者が「書き込みを許可」をオンに
   * 戻した・アプリを更新した後に、どの接続も1分ほど断られ続けないように）
   */
  async #requireWrites(): Promise<void> {
    const now = this.#now()
    const c = this.#connCheck
    const writes =
      c && now - c.at < (c.writes ? RECHECK_MS : CONNECTION_FRESH_MS) ? c.writes : (await this.#readConnectorOrUnpair()).writes
    if (!writes) throw new ConnectorError('writes_off', MESSAGES.writesOff)
    const m = this.#modelCheck
    const model =
      m && now - m.at < (m.model === CONNECTOR_MODEL ? RECHECK_MS : CONNECTION_FRESH_MS) ? m.model : await this.#readModel()
    if (model !== CONNECTOR_MODEL) throw new ConnectorError('model_mismatch', modelMismatchMessage(model, CONNECTOR_MODEL))
  }

  /**
   * 書き込みの順番を待った後・書く前に、呼び出しの許可をもう一度確かめる（クラウドは読まない。最後に読めた一覧で見る）。
   * ほかの接続の書き込みを待つ間に、この接続が一覧から外された・すべて解除して連携し直された時は書かない（アクセスルールは
   * 接続を見分けられない）。足したばかりの接続は、後から読んだ一覧にもあるので断らない
   */
  #stillGranted(p: GrantProps | undefined): void {
    if (!p) return
    this.#requireGrantCurrent(p)
    if (this.#listed(p.cid ?? LEGACY_CONNECTION_ID)) return
    log('grant_removed', { waited: true })
    throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  #write(tool: WriteTool, args: Record<string, unknown>, grant?: GrantProps): Promise<ToolResult> {
    return this.#mutex.run(async () => {
      await this.#requireWrites()
      await this.#fresh(true)
      const owner = this.pairing().ownerUid!
      const created = new Set<string>()
      for (let attempt = 0; ; attempt++) {
        this.#stillGranted(grant)
        const { raw, view } = this.views()
        const trashed = trashedIdsOf(raw)
        // ゴミ箱へ移す依頼の出ているカード（見せる内容からは外れている）と同じ内容は、作り直さずに「以前に削除」にする
        const pending = pendingTrashTargets(raw)
        // 推敲案の covered: この接続が読んだ後に変わった話は、読んだ時の指紋を残す（ほかの接続が読んだ話は見ない）
        const reader = tool === 'novel_add_proofreading' ? readerOf(grant) : null
        const memo = reader ? this.#readMemo(reader) : null
        const built = buildToolCall(view, { tool, input: args } as never, {
          source: 'claude',
          now: this.#now(),
          ...(memo ? { readAs: (pieceId: string) => memo.get(pieceId) } : {}),
          wasDeleted: (table, id) => this.mirror.wasDeleted(table, id) || trashed(table, id) || pending.has(`${table}:${id}`),
          // ゴミ箱の中（作品名を変えてから削除した作品も、ゴミ箱にある間は作り直さない）
          inTrash: trashed,
          // 手で足して削除した作品（ゴミ箱の一覧は写しでも中身を省かない）
          trashedBenchWorkNamed: trashedBenchNamesOf(raw),
          // 手で足して削除した資料も同じ
          trashedMaterialNamed: trashedMaterialNamesOf(raw),
        })
        if (!built.ok) return buildError(built)
        let prepared
        try {
          prepared = built.records.map((r) => prepareWrite(this.fs, owner, r))
        } catch (e) {
          if (e instanceof EncodeError) return fail(e.message)
          throw e
        }
        if (!prepared.length) return writeResult(tool, built, created)
        this.#needWrites(prepared, 'items')
        let done: 'done' | 'retry'
        try {
          done = await this.#commitPrepared(prepared, created, attempt)
        } catch (e) {
          // 記録を分けて書いた（100件を超える推敲案）時に、前の組だけ書けた: 書けた分をふつうの答えの形で返し、残りは書けなかったこと・
          // もう一度送れば残りだけ足すことを添える（何も書いていないように見せない）
          if (!created.size || !(e instanceof ConnectorError)) throw e
          log('records_partly_created', { tool, count: created.size, code: e.code })
          return writeResult(tool, built, created, { failed: e.message })
        }
        if (done === 'retry') continue
        log('records_created', { tool, count: created.size })
        return writeResult(tool, built, created)
      }
    })
  }

  /**
   * 作る記録を書き、書けた記録を写しにも入れる（created に {表名}:{id} を足す）。同時に同じ記録が作られた・削除の印がある時は
   * 読み直して 'retry'（3回目まで。呼び出し側で分け直す）。ほかの失敗は日本語の説明つきの失敗にする。
   * 書き込みの数は書く前に prepared の分を数え、書けなかった組の分は戻す（数えるのは書けた記録だけ。試し直しは、その時に書く分を
   * また数える）。書けたか分からない組は戻さない:
   * - 答えが来ない・つながらない（status 0）・5xx（試し直しても続いた）: クラウドが書いたかもしれないので、その組は数えたまま
   *   （送っていない後の組だけ戻す）
   * - 前の試しの答え（5xx・つながらない）が届かずに試し直した答え（afterUnsure）は、前の試しで書けていることがある。
   *   「もうある」（409 など）なら、読み直した写しに、この組の記録がこのコネクタの書いた同じ内容であれば、この呼び出しで書けた
   *   （created に入れ、数えたまま。答えも「重複」でなく「追加」）。読み直せなかった時は、その組を数えたまま。ほかの失敗
   *   （429・403 など）も、その組を数えたまま
   * - 戻すのは、初めの試しで断られた組（403・429・400、「もうある」など）だけ（commit は全部か無しか）
   */
  async #commitPrepared(prepared: PreparedWrite[], created: Set<string>, attempt: number): Promise<'done' | 'retry'> {
    let committed = 0
    /** 送った組（失敗した時は、その組） */
    let sent: PreparedWrite[] = []
    try {
      for (const g of groups(prepared)) {
        sent = g
        const res = await this.fs.commit(g.map((p) => p.write))
        committed += g.length
        this.mirror.putOwn(rowsOfCommit(g, res))
        for (const p of g) created.add(`${p.table}:${p.id}`)
      }
      return 'done'
    } catch (e) {
      // 送っていない後の組は書いていない
      this.#takeWrites(committed + sent.length - prepared.length)
      if (
        e instanceof FirestoreError &&
        (e.code === 'ALREADY_EXISTS' || e.code === 'FAILED_PRECONDITION' || e.code === 'ABORTED' || e.status === 409) &&
        attempt < 3
      ) {
        // 同時に同じ記録が作られた・削除の印がある: 読み直して、重複・以前に削除として分け直す
        log('write_retry', { code: e.code, attempt })
        /**
         * 確かめた後、この組のうち書けていなかった記録の数（確かめられなかった時は、初めの試しの「もうある」なら組のすべて、
         * 前の試しが届いたかもしれない時は 0: 書けたか分からないので数えたまま）
         */
        let unwritten = e.afterUnsure ? 0 : sent.length
        try {
          await this.#sleep(100 + Math.floor(Math.random() * 200) * (attempt + 1))
          // 断られた後のクラウドを読む（先に始まった取り込みに相乗りしない）
          const out = await this.#syncStep(8, true)
          if (out.outOfReads) throw this.#readBudgetError(true)
          // 差分の読み取りで見えない（写しが知らない）文書は、名前を指定して確かめる
          const left = prepared.filter((p) => !created.has(`${p.table}:${p.id}`)).map((p) => `${p.table}:${p.id}`)
          if (left.length && this.#takeReads(left.length + 2)) {
            try {
              await this.mirror.fetchNames(left)
            } catch (err) {
              return this.#firestoreFailure(err)
            }
          }
          // 前の試しで書けていた（答えが届かずに試し直して「もうある」になった）この組の記録
          if (e.afterUnsure) for (const p of sent) if (this.#isOwnRecord(p)) created.add(`${p.table}:${p.id}`)
          unwritten = sent.filter((p) => !created.has(`${p.table}:${p.id}`)).length
        } finally {
          this.#takeWrites(-unwritten)
        }
        return 'retry'
      }
      // 書けたか分からない組は数えたまま。戻すのは、初めの試しで断られた（403・429・400 など。何も書いていない）組だけ
      if (e instanceof FirestoreError && (e.status === 0 || e.status >= 500 || e.afterUnsure))
        log('write_outcome_unknown', { count: sent.length, status: e.status })
      else this.#takeWrites(-sent.length)
      if (e instanceof FirestoreError && e.status === 403) {
        const conn = await this.#readConnectorOrUnpair()
        if (!conn.writes) throw new ConnectorError('writes_off', MESSAGES.writesOff)
      }
      return this.#firestoreFailure(e)
    }
  }

  /** 写しに、このコネクタが書いた同じ内容の記録（削除されていない）がある */
  #isOwnRecord(p: PreparedWrite): boolean {
    const row = this.store.getRec(`${p.table}:${p.id}`)
    return Boolean(row && !row.deleted && row.device === CONNECTOR_DEVICE && row.hash === p.hash)
  }

  // ---------- ゴミ箱へ移す依頼（2.7） ----------

  /** 今日（日本時間）作った依頼の数 */
  #trashDaily(): TrashDaily {
    const day = jstDate(this.#now())
    const cur = this.store.getMeta<TrashDaily>('trashDaily')
    return cur && cur.day === day && typeof cur.count === 'number' ? cur : { day, count: 0 }
  }

  #addTrashDaily(n: number): void {
    if (n <= 0) return
    const cur = this.#trashDaily()
    this.store.setMeta('trashDaily', { day: cur.day, count: cur.count + n } satisfies TrashDaily)
  }

  /**
   * カードをゴミ箱へ移す依頼を作る（書き込みと同じく、書き込みの許可とデータの形の版を確かめ、最後まで読んでから）。
   * 依頼を作るだけで、カードを移すのはアプリ（同期した時に確かめて移す）
   */
  #trash(args: Record<string, unknown>, grant?: GrantProps): Promise<ToolResult> {
    return this.#mutex.run(async () => {
      await this.#requireWrites()
      await this.#fresh(true)
      const owner = this.pairing().ownerUid!
      /** 作った依頼（trashRequests:{依頼の id}） */
      const created = new Set<string>()
      /** 依頼の id からカード（{表名}:{カードの id}） */
      const targetOf = new Map<string, string>()
      const createdTargets = () => new Set([...created].map((k) => targetOf.get(k)).filter((k): k is string => Boolean(k)))
      for (let attempt = 0; ; attempt++) {
        this.#stillGranted(grant)
        const { raw, view } = this.views()
        const built = buildTrashRequests(view, args as TrashInput, {
          now: this.#now(),
          trash: raw.trashRecords,
          wasDeleted: (table, id) => this.mirror.wasDeleted(table, id),
          dailyLeft: TRASH_LIMITS.perDay - this.#trashDaily().count,
        })
        if (!built.ok) return trashBuildError(built)
        for (const r of built.records) targetOf.set(`trashRequests:${r.record.id}`, `${r.record.table}:${r.record.targetId}`)
        let prepared
        try {
          prepared = built.records.map((r) => prepareWrite(this.fs, owner, r))
        } catch (e) {
          if (e instanceof EncodeError) return fail(e.message)
          throw e
        }
        const left = () => TRASH_LIMITS.perDay - this.#trashDaily().count
        if (!prepared.length) return trashResult(built, createdTargets(), left())
        this.#needWrites(prepared, 'cards')
        const before = created.size
        let done: 'done' | 'retry'
        try {
          done = await this.#commitPrepared(prepared, created, attempt)
        } catch (e) {
          throw partlyWritten(e, created.size)
        } finally {
          this.#addTrashDaily(created.size - before)
        }
        if (done === 'retry') continue
        log('trash_requested', { count: created.size })
        return trashResult(built, createdTargets(), left())
      }
    })
  }

  // ---------- Claude のアイデア（2.8） ----------

  /**
   * アイデアを足す（novel_add_ideas）・アイデアに追記する依頼を作る（novel_append_to_idea）。書き込みと同じく、書き込みの許可と
   * データの形の版を確かめ、最後まで読んでから作る（作るだけ。追記はアプリが同期した時に確かめてカードに足す）
   */
  #ideas(tool: IdeaTool, args: Record<string, unknown>, grant?: GrantProps): Promise<ToolResult> {
    return this.#mutex.run(async () => {
      await this.#requireWrites()
      await this.#fresh(true)
      const owner = this.pairing().ownerUid!
      const created = new Set<string>()
      for (let attempt = 0; ; attempt++) {
        this.#stillGranted(grant)
        const { raw, view } = this.views()
        const trashed = trashedIdsOf(raw)
        // ゴミ箱へ移す依頼の出ているアイデア（見せる内容からは外れている）と同じ内容は、作り直さずに「以前に削除」にする。
        // 2.9: フォルダは削除の印・ゴミ箱の中身の id を飛ばして、作り直しの番号に進める（作るフォルダもこの書き込みの数に入る）
        const pending = pendingTrashTargets(raw)
        const ctx = {
          now: this.#now(),
          wasDeleted: (table: 'ideas' | 'ideaAppends' | 'ideaFolders', id: string) =>
            this.mirror.wasDeleted(table, id) ||
            (table === 'ideas' && (trashed(table, id) || pending.has(`${table}:${id}`))) ||
            (table === 'ideaFolders' && trashed(table, id)),
        }
        const add = tool === IDEA_ADD_TOOL ? buildAddIdeas(raw, view, args as AddIdeasInput, ctx) : null
        if (add && !add.ok) return ideaAddError(add)
        const append = add ? null : buildIdeaAppend(raw, view, args as AppendIdeaInput, ctx)
        const records = add ? add.records : append!.records
        const result = () => (add ? ideaAddResult(add, created) : ideaAppendResult(append!, created))
        let prepared
        try {
          prepared = records.map((r) => prepareWrite(this.fs, owner, r))
        } catch (e) {
          if (e instanceof EncodeError) return fail(e.message)
          throw e
        }
        if (!prepared.length) return result()
        this.#needWrites(prepared, 'items')
        let done: 'done' | 'retry'
        try {
          done = await this.#commitPrepared(prepared, created, attempt)
        } catch (e) {
          throw partlyWritten(e, created.size)
        }
        if (done === 'retry') continue
        log(add ? 'ideas_created' : 'idea_append_requested', { count: created.size })
        return result()
      }
    })
  }

  // ---------- 取り込みの続き（alarm）・夜の確かめ（cron） ----------

  /** 初回の取り込みを1歩進める（動いている取り込みがあれば相乗りする）。次に呼ぶ時刻を返す（終わった・止める時は null） */
  async alarm(): Promise<number | null> {
    if (this.pairingState() !== 'paired') return null
    try {
      const out = await this.#syncStep(10)
      if (out.done) return null
      if (out.outOfReads) {
        // 枠が戻る時刻の少し後に続きをする
        return nextPacificMidnight(this.#now()) + 5 * 60_000
      }
      return this.#now() + 1_000
    } catch (e) {
      if (e instanceof ConnectorError && (isAuthProblem(e.code) || e.code === 'permission')) return null
      // Firebase の無料枠を使い切った: 枠が戻る時刻の少し後に続きをする（1分ごとに試し直さない）
      if (e instanceof ConnectorError && e.code === 'firestore_quota') return nextPacificMidnight(this.#now()) + 5 * 60_000
      return this.#now() + 60_000
    }
  }

  /** 夜の確かめ: クラウドの記録の数と写しの数を比べ、合わなければ取り込み直す（予算の中で） */
  async nightly(): Promise<'ok' | 'rescan' | 'skipped'> {
    if (this.pairingState() !== 'paired' || !this.mirror.warm().done) return 'skipped'
    try {
      // 呼ばれた後のクラウドまで読んでから数を比べる（先に始まった取り込みに相乗りしない）
      const out = await this.#syncStep(10, true)
      if (!out.done) return 'skipped'
      if (!this.#takeReads(5)) return 'skipped'
      const owner = this.pairing().ownerUid!
      const cloud = await this.fs.count(`users/${owner}`, { from: [{ collectionId: 'records' }] })
      const c = this.mirror.counts()
      const mine = c.live + c.deleted + c.chunks
      if (cloud === mine) return 'ok'
      log('mirror_count_mismatch', { cloud, mine })
      this.mirror.reset()
      this.#views = null
      this.#d.schedule?.(this.#now() + 1_000)
      return 'rescan'
    } catch (e) {
      logError('nightly_failed', e)
      return 'skipped'
    }
  }

  /** 回数の上限（/authorize はネットワークごと＋全体・DCR は全体）。超えていれば、どの上限か */
  takeRate(kind: RateKind, bucket?: string): RateResult {
    return takeRate(this.store, kind, this.#now(), bucket)
  }

  /** 同意（handle の指紋）の承認を1回だけ通す（POST /authorize。2回目からは false） */
  claimConsent(key: string): boolean {
    return claimConsent(this.store, key, this.#now())
  }
}

/**
 * 記録を分けて書いた時に、前の組だけ書けた失敗（ゴミ箱へ移す依頼・アイデア。いまの上限では1回の呼び出しは1つの組なので起きないが、
 * 書けた分があることを黙らない）。何も書けていなければ、そのままの失敗
 */
function partlyWritten(e: unknown, written: number): unknown {
  if (!written || !(e instanceof ConnectorError)) return e
  return new ConnectorError(e.code, `${e.message}（${written}件は書けました。同じ呼び出しをもう一度送ると、残りだけ作ります）`)
}

/**
 * 読んだ話・幕の控えの持ち主（接続と連携の代。許可の無い呼び出しは控えない）。接続の id は使い回さないが、2.8 までの許可の c0 は
 * ［連携をすべて解除］の後にほかのアカウントが使うことがあるので、代も入れる
 */
function readerOf(grant: GrantProps | undefined): string | null {
  if (!grant) return null
  return `${grant.cid ?? LEGACY_CONNECTION_ID}@${grant.gen ?? ''}`
}

/** 控えの行を読む（区切りの指紋が読めなければ、区切りの控えは無いものとする） */
function memoEntry(hash: string, ver: string | null, parts: string): ReadMemoEntry {
  let map: Record<string, string> = {}
  try {
    const v = JSON.parse(parts) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v))
      map = Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    map = {}
  }
  return { hash, versionId: ver, parts: map }
}

/** Firestore の REST の時刻（{ timestamp }）を ms にする（読めなければ null） */
function plainMillis(v: unknown): number | null {
  const ts = v && typeof v === 'object' ? (v as Partial<Timestamp>).timestamp : undefined
  if (typeof ts !== 'string') return null
  const ms = timestampMillis(ts)
  return Number.isFinite(ms) ? ms : null
}

/** 読んだ config/connector の「書き込みを許可」と接続の一覧 */
function connectorState(doc: Record<string, unknown>, list: ConnectionInfo[]): ConnectorState {
  return {
    writes: doc.writes === true,
    cids: list.map((c) => c.cid),
    names: Object.fromEntries(list.map((c) => [c.cid, c.name])),
    pairedAt: Object.fromEntries(list.map((c) => [c.cid, c.pairedAt])),
  }
}
