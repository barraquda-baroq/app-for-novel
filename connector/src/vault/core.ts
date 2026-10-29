// Vault の中身（Durable Object の外でも動く。テストでは node:sqlite と Firebase エミュレーターで動かす）。
// 持ち主ごとに1つ（idFromName('owner')）。コネクタの身元・連携の状態・持ち主の記録の写し・数の記録・書き込みの順番を持つ。
import { trashedIdsOf, buildToolCall, isWriteTool, type WriteTool } from '../../../src/claude/records'
import { claudeView, canClaudeRead } from '../../../src/claude/visibility'
import { repairData } from '../../../src/domain/repair'
import type { AppData } from '../../../src/domain/types'
import type { VaultConfig } from '../env'
import { log, logError } from '../log'
import { CONNECTOR_MODEL, CONNECTOR_VERSION } from '../version'
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
  type QuotaCounts,
} from './quota'
import { takeRate, type RateKind } from './ratelimit'
import { MirrorStore, type SqlRunner } from './store'
import { fail, type ToolResult } from './tools/common'
import * as R from './tools/read'
import { buildError, writeResult } from './tools/write'
import { fromFields, timestampMillis, type Timestamp } from './values'
import { EncodeError, groups, prepareWrite, rowsOfCommit } from './writer'

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
}

export interface PairingMeta {
  state: 'paired' | 'unpaired'
  ownerUid: string | null
  /** 連携した時刻（ms） */
  pairedAt: number | null
  /** 解除した理由（ログ・状態の表示用） */
  reason?: string
}

export type PairingCheck =
  | { ok: true; ownerUid: string }
  | { ok: false; reason: 'not_found' | 'uid' | 'hash' | 'expired' | 'used' | 'owner' | 'error'; message: string }

export type HealthState = 'ready' | 'unpaired' | 'no_identity' | 'anonymous_disabled' | 'key_missing' | 'unavailable'

export interface CallOptions {
  /** クライアントの名前（Claude Code なら本文の既定の文字数を減らす） */
  client?: string
}

/** 連携の確かめの指紋の有効時間（アプリが config/connector を書いてから） */
export const PAIRING_TTL_MS = 15 * 60_000
/** 読むツールの前に写しを新しくする間隔 */
export const FRESH_MS = 15_000
/** config/connector・meta/app を読み直す間隔（書き込みの前） */
const RECHECK_MS = 60_000

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
  readonly #mutex = new Mutex()
  #lastSync = 0
  #views: { version: number; raw: AppData; view: AppData; hidden: number } | null = null
  #writesCheck: { writes: boolean; at: number } | null = null
  #modelCheck: { model: number | null; at: number } | null = null

  constructor(deps: VaultDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => Date.now())
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.store = new MirrorStore(deps.sql)
    this.identity = new Identity({
      fetch: deps.fetch,
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
      fetch: deps.fetch,
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

  #setUnpaired(reason: string): void {
    const cur = this.pairing()
    if (cur.state !== 'unpaired') log('pairing_lost', { reason })
    // 持ち主は覚えておく（同じ持ち主と連携し直せば、写しをそのまま使える）
    this.store.setMeta('pairing', { ...cur, state: 'unpaired', reason } satisfies PairingMeta)
    this.#writesCheck = null
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
   * 合えば連携した状態にして、写しの取り込みを始める
   */
  async verifyPairing(hash: string): Promise<PairingCheck> {
    const bad = (reason: Exclude<PairingCheck, { ok: true }>['reason']): PairingCheck => {
      log('pairing_refused', { reason })
      return { ok: false, reason, message: PAIRING_MESSAGES[reason] }
    }
    if (!/^[0-9a-f]{64}$/.test(hash)) return bad('hash')
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
    try {
      const d = (await this.fs.batchGet(['config/connector'])).get('config/connector')
      conn = d ? fromFields(d.fields) : null
    } catch (e) {
      // 無い記録・自分の uid でない記録は、アクセスルールで読めない（403。どちらかは分からない）
      if (e instanceof FirestoreError && e.status === 403) return bad('not_found')
      logError('pairing_connector_failed', e)
      return bad('error')
    }
    if (!conn) return bad('not_found')
    if (conn.uid !== uid) return bad('uid')
    if (conn.pairing !== hash) return bad('hash')
    const pairedAt = timestampMillis((conn.pairedAt as Timestamp | null)?.timestamp ?? '')
    const now = this.#now()
    if (!Number.isFinite(pairedAt) || now - pairedAt > PAIRING_TTL_MS || pairedAt - now > 2 * 60_000) return bad('expired')
    this.store.setMeta('usedPairings', [...used, hash].slice(-50))
    const prev = this.pairing()
    if (prev.ownerUid && prev.ownerUid !== ownerUid) {
      log('mirror_owner_changed')
      this.mirror.reset()
      this.#views = null
    }
    this.store.setMeta('pairing', { state: 'paired', ownerUid, pairedAt } satisfies PairingMeta)
    this.#writesCheck = { writes: conn.writes === true, at: now }
    this.#modelCheck = null
    log('paired', { writes: conn.writes === true })
    this.#d.schedule?.(now + 500)
    return { ok: true, ownerUid }
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

  #takeWrites(n: number): boolean {
    const q = this.#quota()
    if (q.writes + n > this.#d.config.dailyWriteBudget) return false
    this.store.setMeta('quota', { ...q, writes: q.writes + n } satisfies QuotaCounts)
    return true
  }

  // ---------- 写し ----------

  /** Firestore の失敗を、日本語の説明つきの失敗にする（403 は連携が解除されたかを確かめる） */
  async #firestoreFailure(e: unknown): Promise<never> {
    if (e instanceof ConnectorError) throw e
    if (e instanceof FirestoreError) {
      if (e.code === 'RESOURCE_EXHAUSTED' || e.status === 429)
        throw new ConnectorError('firestore_quota', firestoreQuotaMessage(this.#now()))
      if (e.status === 403) {
        const writes = await this.#readConnector()
        if (writes === null) {
          this.#setUnpaired('connector_gone')
          throw new ConnectorError('unpaired', MESSAGES.unpaired)
        }
        throw new ConnectorError('permission', MESSAGES.permission)
      }
      logError('firestore_failed', e, { status: e.status, code: e.code })
      throw new ConnectorError('unavailable', MESSAGES.unavailable)
    }
    logError('vault_failed', e)
    throw new ConnectorError('unavailable', MESSAGES.unavailable)
  }

  /** config/connector を読む。writes を返す（読めない・このコネクタのものでない = null） */
  async #readConnector(): Promise<boolean | null> {
    try {
      const d = (await this.fs.batchGet(['config/connector'])).get('config/connector')
      if (!d) return null
      const f = fromFields(d.fields)
      if (f.uid !== this.identity.uid()) return null
      const writes = f.writes === true
      this.#writesCheck = { writes, at: this.#now() }
      return writes
    } catch (e) {
      if (e instanceof FirestoreError && e.status === 403) return null
      if (e instanceof ConnectorError) throw e
      logError('connector_read_failed', e)
      throw new ConnectorError('unavailable', MESSAGES.unavailable)
    }
  }

  #requirePaired(): void {
    if (this.pairingState() !== 'paired') throw new ConnectorError('unpaired', MESSAGES.unpaired)
  }

  /** 写しを1歩新しくする */
  async #syncStep(maxPages: number): Promise<SyncOutcome> {
    try {
      const out = await this.mirror.sync({
        maxPages,
        workBudget: this.#d.config.workBudgetChars,
        takeReads: (n) => this.#takeReads(n),
      })
      if (out.done) this.#lastSync = this.#now()
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

  /**
   * ツールの前に写しを新しくする。初回の取り込みが終わっていなければ1歩進めて「取り込み中」を返す。
   * 書き込みの前は最後まで読む（重複・以前に削除された記録を見分けるため）
   */
  async #fresh(forWrite: boolean): Promise<{ note?: string }> {
    const warm = this.mirror.warm()
    if (!warm.done) {
      const out = await this.#syncStep(8)
      if (out.outOfReads) throw new ConnectorError('read_budget', readBudgetMessage(this.#now()))
      if (!out.done) {
        this.#d.schedule?.(this.#now() + 1_000)
        throw new ConnectorError('warming', this.#warmingMessage())
      }
      return {}
    }
    if (!forWrite && this.#now() - this.#lastSync < FRESH_MS) return {}
    for (let i = 0; i < (forWrite ? 5 : 1); i++) {
      const out = await this.#syncStep(8)
      if (out.done) return {}
      if (out.outOfReads) {
        if (forWrite) throw new ConnectorError('read_budget', readBudgetMessage(this.#now()))
        return { note: `（今日の読み取り枠を使い切ったため、最新の変更を取り込めていません。${resetLabel(this.#now())}に回復します）` }
      }
    }
    this.#d.schedule?.(this.#now() + 1_000)
    return { note: '（端末からの変更が多いため、取り込みの途中の内容です）' }
  }

  /** 修復した内容（表示用）と、Claude に見せる内容（見せないタイトル・ゴミ箱などを除く） */
  views(): { raw: AppData; view: AppData; hidden: number } {
    const version = this.mirror.version()
    if (this.#views && this.#views.version === version) return this.#views
    const raw = repairData(this.mirror.data()).data
    const view = claudeView(raw)
    const hidden = Object.values(raw.titles).filter((t) => !canClaudeRead(t)).length
    this.#views = { version, raw, view, hidden }
    return this.#views
  }

  // ---------- ツール ----------

  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
    try {
      if (name === 'novel_status') return await this.#status()
      this.#requirePaired()
      if (isWriteTool(name)) return await this.#write(name, args)
      const { note } = await this.#fresh(false)
      const { view, hidden } = this.views()
      const ctx: R.ReadContext = { view, now: this.#now(), client: opts.client, workBudget: this.#d.config.workBudgetChars }
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
      default:
        return fail(`知らないツールです: ${name}`)
    }
  }

  async #status(): Promise<ToolResult> {
    const p = this.pairing()
    const paired = this.pairingState() === 'paired'
    const q = this.#quota()
    const now = this.#now()
    const lines = [`Novel Studio コネクタ ${CONNECTOR_VERSION}（データの形 ${CONNECTOR_MODEL}）`]
    if (!paired) {
      lines.push('連携: していません（claude.ai でコネクタに接続し、アプリで許可してください）')
      return { text: lines.join('\n'), auth: this.identity.uid() ? true : undefined, isError: true }
    }
    lines.push(`連携: 済み（${p.pairedAt ? new Date(p.pairedAt + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '―'} 日本時間）`)
    let writes: boolean | null = this.#writesCheck?.writes ?? null
    let model: number | null = this.#modelCheck?.model ?? null
    try {
      writes = await this.#readConnector()
      if (writes === null) {
        this.#setUnpaired('connector_gone')
        return { text: MESSAGES.unpaired, isError: true, auth: true }
      }
      model = await this.#readModel()
    } catch (e) {
      if (e instanceof ConnectorError && isAuthProblem(e.code)) return { text: e.message, isError: true, auth: true }
      lines.push('（クラウドの設定を読めませんでした）')
    }
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
    return { text: lines.join('\n') }
  }

  /** users/{owner}/meta/app の model（無い = null） */
  async #readModel(): Promise<number | null> {
    const owner = this.pairing().ownerUid
    if (!owner) throw new ConnectorError('unpaired', MESSAGES.unpaired)
    try {
      const d = (await this.fs.batchGet([`users/${owner}/meta/app`])).get(`users/${owner}/meta/app`)
      const m = d ? fromFields(d.fields).model : null
      const model = typeof m === 'number' ? m : null
      this.#modelCheck = { model, at: this.#now() }
      return model
    } catch (e) {
      return this.#firestoreFailure(e)
    }
  }

  async #requireWrites(): Promise<void> {
    const now = this.#now()
    let writes = this.#writesCheck && now - this.#writesCheck.at < RECHECK_MS ? this.#writesCheck.writes : null
    if (writes === null) {
      writes = await this.#readConnector()
      if (writes === null) {
        this.#setUnpaired('connector_gone')
        throw new ConnectorError('unpaired', MESSAGES.unpaired)
      }
    }
    if (!writes) throw new ConnectorError('writes_off', MESSAGES.writesOff)
    const model =
      this.#modelCheck && now - this.#modelCheck.at < RECHECK_MS ? this.#modelCheck.model : await this.#readModel()
    if (model !== CONNECTOR_MODEL) throw new ConnectorError('model_mismatch', modelMismatchMessage(model, CONNECTOR_MODEL))
  }

  #write(tool: WriteTool, args: Record<string, unknown>): Promise<ToolResult> {
    return this.#mutex.run(async () => {
      await this.#requireWrites()
      await this.#fresh(true)
      const owner = this.pairing().ownerUid!
      const created = new Set<string>()
      for (let attempt = 0; ; attempt++) {
        const { raw, view } = this.views()
        const trashed = trashedIdsOf(raw)
        const built = buildToolCall(view, { tool, input: args } as never, {
          source: 'claude',
          now: this.#now(),
          wasDeleted: (table, id) => this.mirror.wasDeleted(table, id) || trashed(table, id),
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
        if (!this.#takeWrites(prepared.length)) throw new ConnectorError('write_budget', writeBudgetMessage(this.#now()))
        try {
          for (const g of groups(prepared)) {
            const res = await this.fs.commit(g.map((p) => p.write))
            this.mirror.putOwn(rowsOfCommit(g, res))
            for (const p of g) created.add(`${p.table}:${p.id}`)
          }
          log('records_created', { tool, count: created.size })
          return writeResult(tool, built, created)
        } catch (e) {
          if (
            e instanceof FirestoreError &&
            (e.code === 'ALREADY_EXISTS' || e.code === 'FAILED_PRECONDITION' || e.code === 'ABORTED' || e.status === 409) &&
            attempt < 3
          ) {
            // 同時に同じ記録が作られた・削除の印がある: 読み直して、重複・以前に削除として分け直す
            log('write_retry', { code: e.code, attempt })
            await this.#sleep(100 + Math.floor(Math.random() * 200) * (attempt + 1))
            const out = await this.#syncStep(8)
            if (out.outOfReads) throw new ConnectorError('read_budget', readBudgetMessage(this.#now()))
            continue
          }
          if (e instanceof FirestoreError && e.status === 403) {
            const writes = await this.#readConnector()
            if (writes === null) {
              this.#setUnpaired('connector_gone')
              throw new ConnectorError('unpaired', MESSAGES.unpaired)
            }
            if (!writes) throw new ConnectorError('writes_off', MESSAGES.writesOff)
          }
          return this.#firestoreFailure(e)
        }
      }
    })
  }

  // ---------- 取り込みの続き（alarm）・夜の確かめ（cron） ----------

  /** 初回の取り込みを1歩進める。次に呼ぶ時刻を返す（終わった・止める時は null） */
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
      return this.#now() + 60_000
    }
  }

  /** 夜の確かめ: クラウドの記録の数と写しの数を比べ、合わなければ取り込み直す（予算の中で） */
  async nightly(): Promise<'ok' | 'rescan' | 'skipped'> {
    if (this.pairingState() !== 'paired' || !this.mirror.warm().done) return 'skipped'
    try {
      const out = await this.#syncStep(10)
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

  /** 回数の上限（/authorize・DCR）。超えていれば false */
  takeRate(kind: RateKind): boolean {
    return takeRate(this.store, kind, this.#now())
  }
}
