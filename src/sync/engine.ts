// クラウド（Firestore）との送受信。
// - 受信: users/{uid}/records を「前回受け取った時刻より後に書かれたもの」でリアルタイム購読し、届いた変更を反映する
// - 送信: 端末内の送信待ちを、クラウド側が前回揃えた時から変わっていないことを確かめながら（トランザクション）書く。
//   変わっていたら書かずに、受信で base が新しくなる（3者マージされる）のを待ってから送り直す。
// 送受信は exclusive で1つずつ行い、送った結果を記録する前に自分の書いた変更を受け取ることがないようにする。
// この端末が書いた古い版（続けて送った時、先に送った版の通知が後から届く）は反映しない。
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore'
import { tableSendRank, type Change, type OutboxItem } from '../db/persistence'
import type { TableName } from '../domain/types'
import { appModelRef, asModel, watchAppModel, type AppModel } from './appModel'
import { decideBatch, nothingToSend, sameAsBase, selectBatch } from './batch'
import { CHUNK_CHARS, RECORDS, chunkIdOf, decodeRecord, docIdOf, type ChunkDoc, type RecordDoc } from './codec'

/** エンジンが端末内のデータを読み書きする口（アプリではストア、テストでは保存先を直接使う） */
export interface SyncTarget {
  readOutbox(limit: number): Promise<OutboxItem[]>
  completeUpload(sent: Change[]): Promise<void>
  /**
   * 送るトランザクションを始める前に、その送信待ちに「返事を受け取るまで、クラウドが base のままか分からない」と印を付ける
   * （書き込みが届いたのに返事を受け取れないことがある。OutboxRow.unconfirmed）
   */
  markUnconfirmed(keys: string[]): Promise<void>
  /**
   * クラウドの変更を反映する。cursor は同じトランザクションで記録する。
   * バックアップからの復元・すべて削除をクラウドに当てる前は反映せずに null を返す（後で受け取り直す）。
   * direct = 購読ではなく、書けなかったものだけをクラウドから直接読んだ（1回の書き込みの一部だけのことがある）。
   */
  applyRemote(changes: Change[], cursor?: unknown, opts?: { direct?: boolean }): Promise<Change[] | null>
  outboxCount(): Promise<number>
  markAllDirty(): Promise<void>
  /** 端末内のレコードと送信待ちのキー（`${表名}/${id}`） */
  localKeys(): Promise<Set<string>>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta(key: string, value: unknown): Promise<void>
  /** 端末内にまだ保存していない変更を保存する（送る前に呼ぶ） */
  flush?(): Promise<unknown>
}

export type SyncPhase = 'starting' | 'downloading' | 'uploading' | 'synced' | 'offline' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  /** 送信待ちの件数 */
  pending: number
  /** 最後にクラウドと揃った時刻 */
  lastSyncedAt: number | null
  error: string | null
  /**
   * クラウドのデータが、このアプリより新しい版のアプリで書かれている（データの形の版。src/sync/appModel.ts）。
   * 受け取りは続け、送るのは止めている（この端末の変更は送信待ちに残る）
   */
  outdated?: AppModel | null
}

export interface EngineOptions {
  firestore: Firestore
  uid: string
  deviceId: string
  target: SyncTarget
  onStatus?: (s: SyncStatus) => void
  /** 変更があってから送るまでの待ち時間（ms）。続けて変更しても uploadMaxWait 以内には送る */
  uploadDelay?: number
  uploadMaxWait?: number
  /** テスト用: 分割する大きさ */
  chunkSize?: number
  /**
   * 最初にログインしたアカウントをクラウドの持ち主として記録し、ほかのアカウントでは同期しない（既定 true）。
   * アクセスルールも持ち主だけに読み書きを許す（firestore.rules）。
   */
  ownerLock?: boolean
  /**
   * このアプリのデータの形の版。クラウドに記録し（無い・低ければ上げる）、クラウドの版の方が高ければ送らない。
   * 渡さなければ確かめない（テスト用）
   */
  appModel?: AppModel
  /** テスト用: データの形の版を確かめるまで、送るのを待つ長さの上限（ms） */
  modelWait?: number
}

export interface SyncEngine {
  start(): Promise<void>
  stop(): void
  /** 送信待ちを送る（immediate なら待たずに） */
  requestUpload(immediate?: boolean): void
  /** いますぐ送る（送り終わるか失敗するまで待つ） */
  flush(): Promise<void>
  /** 画面がしばらく裏にあった後などに、記録した位置から購読し直す（読み取りの量を抑える） */
  reanchor(): void
  /** 受信と送信がひと段落するまで待つ（テスト用） */
  idle(): Promise<void>
  readonly status: SyncStatus
}

/** 同期の形の版。文書の形や表を変えたら上げる（次の起動で全件を受け取り直す） */
export const SYNC_SCHEMA = 1

/** クラウドの持ち主を記録する文書 */
export const OWNER_DOC = ['config', 'owner'] as const

interface StoredCursor {
  s: number
  n: number
}

const BATCH_RECORDS = 100
/** 1回のトランザクションで書く量の上限（文字数。UTF-8 で 10MiB の上限に十分収まるように） */
const BATCH_CHARS = 1_500_000
const BATCH_DOCS = 400
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000]
/** データの形の版を確かめるまで、送るのを待つ長さの上限（いますぐ同期・ログアウトの前の送信） */
const MODEL_WAIT_MS = 10_000
const OFFLINE_MESSAGE = 'オフラインです。つながると自動で同期します。'
/** 送る途中で、データの形の版を確かめられなくなった・新しい版で書かれていると分かった（何も書かない） */
const MODEL_PAUSED = new Error('データの形の版を確かめるまで送りません')
/** この端末が送った版の指紋を、文書ごとにいくつまで覚えておくか */
const SENT_MEMORY = 20

const noop = () => undefined

const later = (a: StoredCursor, b: StoredCursor | null) => !b || a.s > b.s || (a.s === b.s && a.n > b.n)

/** 文書の更新時刻（サーバーの時刻。まだ付いていなければ null） */
const timeOf = (data: { updated?: unknown }): StoredCursor | null =>
  data.updated instanceof Timestamp ? { s: data.updated.seconds, n: data.updated.nanoseconds } : null

export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

function errorCode(e: unknown): string {
  return typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
}

function describeError(e: unknown): { offline: boolean; message: string } {
  const code = errorCode(e)
  if (e instanceof SyncError) return { offline: false, message: e.message }
  if (code === 'unavailable' || code === 'deadline-exceeded' || (typeof navigator !== 'undefined' && navigator.onLine === false))
    return { offline: true, message: OFFLINE_MESSAGE }
  if (code === 'permission-denied')
    return {
      offline: false,
      message:
        'クラウドへのアクセスが拒否されました。アクセスルールを公開したか（docs/DEPLOY.md）、持ち主のアカウントでログインしているかを確かめてください。',
    }
  if (code === 'resource-exhausted')
    return { offline: false, message: 'クラウドの今日の無料枠を使い切りました。明日になると同期を再開します。' }
  if (code === 'unauthenticated') return { offline: false, message: 'ログインの期限が切れました。ログインし直してください。' }
  return { offline: false, message: e instanceof Error ? e.message : String(e) }
}

export function createSyncEngine(opts: EngineOptions): SyncEngine {
  const { firestore: fs, uid, deviceId, target } = opts
  const chunkSize = opts.chunkSize ?? CHUNK_CHARS
  const uploadDelay = opts.uploadDelay ?? 2000
  const uploadMaxWait = opts.uploadMaxWait ?? 10_000
  const modelWait = opts.modelWait ?? MODEL_WAIT_MS
  const col = collection(fs, 'users', uid, RECORDS)

  let stopped = false
  let unsub: Unsubscribe | null = null
  let cursor: StoredCursor | null = null
  /** いまの購読を始めた位置（購読し直すと、それまでに届いた分を読み直さずに済む） */
  let subscribedFrom: StoredCursor | null = null
  let downloaded = false
  /** バックアップからの復元・すべて削除をクラウドに当てるまで、受信を止めている */
  let deferred = false
  let status: SyncStatus = { phase: 'starting', pending: 0, lastSyncedAt: null, error: null }
  /** この端末が送った版の指紋（文書ごと、古い順） */
  const sent = new Map<string, string[]>()
  /** 持ち主の確認が済んだ（ownerLock の時） */
  let ownerOk = opts.ownerLock === false
  /**
   * データの形の版: unknown = まだサーバーから確かめていない（オフラインになって、確かめ直すまでも）、
   * newer = 新しい版のアプリで書かれている（どちらも送らない）
   */
  let modelState: 'unknown' | 'ok' | 'newer' = opts.appModel ? 'unknown' : 'ok'
  /**
   * 一度サーバーで確かめた後にオフラインになり、記録の見張りがまだサーバーと揃い直していない（unknown の間）。
   * 見張りの通知は、つながった後もしばらく（Firestore の購読のつなぎ直しを待つ間、1分半ほどまで）届かないことがあるので、
   * その間は待たずに、送るトランザクションの中で記録を読んで確かめる（送る時の読み取り1回分。同期を始めた直後は待つ）
   */
  let modelRecheck = false
  /** 同期をやめた・新しい版のアプリで書かれたデータに気付いた（送るのをやめる） */
  const sendPaused = () => stopped || modelState === 'newer'
  let modelUnsub: Unsubscribe | null = null
  /** データの形の版を確かめた（または同期をやめた）。オフラインになると、確かめ直すまでの新しい約束にする */
  let modelKnown: () => void = () => undefined
  let modelReady = new Promise<void>((resolve) => (modelKnown = resolve))

  // 送受信を1つずつ行うための鎖
  let lock: Promise<unknown> = Promise.resolve()
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn)
    lock = run.catch(() => undefined)
    return run
  }

  function setStatus(patch: Partial<SyncStatus>): void {
    status = { ...status, ...patch }
    opts.onStatus?.(status)
  }

  async function refreshPending(): Promise<number> {
    const pending = await target.outboxCount()
    setStatus({ pending })
    return pending
  }

  function fail(e: unknown): void {
    if (stopped) return
    const d = describeError(e)
    if (!d.offline) console.warn('同期できませんでした', e)
    setStatus({ phase: d.offline ? 'offline' : 'error', error: d.message })
  }

  function rememberSent(id: string, hash: string): void {
    const list = sent.get(id) ?? []
    list.push(hash)
    if (list.length > SENT_MEMORY) list.splice(0, list.length - SENT_MEMORY)
    sent.set(id, list)
  }

  /**
   * この端末が書いて置き換えたクラウドの版（文書ごと、その版の更新時刻）。購読の通知は、書く前のクラウドの内容のまま、書いた後に
   * 届くことがある（通知を受け取ってから反映するまでの間に送った時）。その古い版で、送ったばかりの内容を戻さないように。
   * 指紋（内容）ではなく時刻で見分ける: 同じ文書への後の書き込みは、どの端末のもの（削除・同じ内容で戻したものも）でも
   * サーバーの時刻が必ず後になる。書く前にクラウドに無かった文書は覚えない（無い文書の古い通知は届かない）
   */
  const replaced = new Map<string, StoredCursor>()

  /** 送る前のクラウドの版の通知か（この端末が書いて置き換えた版か、それより前の版。後の版が届いたら、もう古い版は届かない） */
  function isSuperseded(id: string, data: RecordDoc): boolean {
    const old = replaced.get(id)
    if (!old) return false
    const at = timeOf(data)
    if (at && !later(at, old)) return true
    replaced.delete(id)
    return false
  }

  /**
   * 復元・すべて削除の文書を、その内容を正とする変更として当てるか。記録した位置より後に書かれたものだけ。
   * 購読し直すと、記録した位置と同じ時刻の文書（受け取って位置を記録した時に反映したもの）が届き直し、復元の印は次に
   * 書かれるまで残る。それを復元として当て直すと、その後のこの端末の変更（送る前の幕の操作・稿の編集）を戻すので、
   * ふつうの変更として 3者マージする（同じ時刻の、まだ受け取っていない別の書き込みは、同じ通知でいっしょに届く）
   */
  function freshReset(data: RecordDoc, at: StoredCursor | null): boolean {
    return Boolean(data.reset) && (!at || later(at, cursor))
  }

  /** この端末が先に送った古い版の通知か（その後にもっと新しい版を送っている） */
  function isStaleEcho(id: string, data: RecordDoc): boolean {
    if (data.device !== deviceId) return false
    const list = sent.get(id)
    if (!list || !list.includes(data.hash)) return false
    if (list[list.length - 1] === data.hash) {
      sent.set(id, [data.hash])
      return false
    }
    // 届いた版より前に送った指紋は、もう届かない
    sent.set(id, list.slice(list.lastIndexOf(data.hash) + 1))
    return true
  }

  // ---------- 受信 ----------

  let remoteWaiters: (() => void)[] = []
  function waitForRemote(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        remoteWaiters = remoteWaiters.filter((f) => f !== done)
        resolve()
      }
      remoteWaiters.push(done)
    })
  }

  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null
  let resubscribeCount = 0
  /** 購読の世代（購読し直したら、前の購読の通知は使わない） */
  let listenerGen = 0

  /** 購読をやめ、少し待ってから記録した位置から購読し直す */
  function resubscribeLater(): void {
    listenerGen += 1
    unsub?.()
    unsub = null
    if (stopped || resubscribeTimer) return
    const delay = RETRY_DELAYS_MS[Math.min(resubscribeCount, RETRY_DELAYS_MS.length - 1)]
    resubscribeCount += 1
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null
      subscribe()
    }, delay)
  }

  function subscribe(): void {
    if (stopped) return
    unsub?.()
    const gen = ++listenerGen
    subscribedFrom = cursor
    // 「以上」で購読する: 別々の書き込みが同じ時刻になることがあり、「より後」だと、記録した位置と同じ時刻の
    // まだ受け取っていない変更を取りこぼすため（同じ時刻の受け取り済みの変更が届き直すのは、反映しても変わらない）
    const q = cursor
      ? query(col, where('updated', '>=', new Timestamp(cursor.s, cursor.n)), orderBy('updated'))
      : query(col, orderBy('updated'))
    /** この購読で、まだサーバーと揃っていない（最初のサーバーからの通知を受け取っていない） */
    let first = true
    unsub = onSnapshot(
      q,
      // 状態だけの変化も受け取る（控えから作った最初の通知の後、サーバーの内容が変わっていなくても
      // 「サーバーと揃った」通知を受け取れるように）
      { includeMetadataChanges: true },
      (snap) => {
        const fromCache = snap.metadata.fromCache
        // 最初にサーバーと揃うまでの、端末の中の控え（前の購読で受け取った、もう古いかもしれない内容）から
        // 作った通知は使わない。揃った後の通知は、控えの印が付いていてもサーバーから届いた変化なので反映する
        // （受け取った位置は、控えの印が無い通知でだけ進める）
        if (first && fromCache) return
        // 最初にサーバーと揃った通知は、すべての文書を受け取ったものとして扱う
        // （控えからの通知で「追加」済みとされた文書は、変化として届かないため）
        const changed = first
          ? snap.docs
          : snap
              .docChanges()
              .filter((c) => c.type !== 'removed')
              .map((c) => c.doc)
        first = false
        const all = snap.docs
        void exclusive(async () => {
          // 反映に失敗した後の通知は捨てる（後の通知で位置が進むと、失敗した分を取りこぼすため）
          if (gen !== listenerGen) return
          await handleSnapshot(changed, all, fromCache)
          resubscribeCount = 0
        }).catch((e) => {
          fail(e)
          if (gen === listenerGen) resubscribeLater()
        })
      },
      (err) => {
        fail(err)
        if (gen === listenerGen) resubscribeLater()
      },
    )
  }

  /** 記録した位置が購読を始めた位置より進んでいれば、そこから購読し直す */
  function reanchor(): void {
    if (stopped || !unsub || resubscribeTimer || deferred) return
    void exclusive(async () => {
      if (stopped || !unsub || deferred) return
      if (cursor && (!subscribedFrom || later(cursor, subscribedFrom))) subscribe()
    }).catch(fail)
  }

  /** 分割文書が手元に揃っていない時に読み直す */
  async function fetchChunks(parentId: string): Promise<Map<string, ChunkDoc>> {
    const snap = await getDocs(query(col, where('parent', '==', parentId)))
    const map = new Map<string, ChunkDoc>()
    snap.forEach((d) => map.set(d.id, d.data() as ChunkDoc))
    return map
  }

  async function handleSnapshot(
    changed: QueryDocumentSnapshot<DocumentData>[],
    all: QueryDocumentSnapshot<DocumentData>[],
    fromCache: boolean,
  ): Promise<void> {
    if (stopped || deferred) return
    if (!changed.length && fromCache) return
    const chunks = new Map<string, ChunkDoc>()
    for (const d of all) {
      const data = d.data() as Partial<ChunkDoc>
      if (data.table === '_chunk') chunks.set(d.id, data as ChunkDoc)
    }
    const changes: Change[] = []
    let newest: StoredCursor | null = null
    for (const d of changed) {
      const data = d.data({ serverTimestamps: 'none' }) as RecordDoc | ChunkDoc
      const at = timeOf(data)
      if (at && later(at, newest)) newest = at
      if (data.table === '_chunk') continue
      const recDoc = data as RecordDoc
      if (isStaleEcho(d.id, recDoc) || isSuperseded(d.id, recDoc)) continue
      let rec = decodeRecord(recDoc, (i) => chunks.get(chunkIdOf(d.id, i)))
      if (rec === undefined && recDoc.chunks > 0) {
        const fetched = await fetchChunks(d.id)
        rec = decodeRecord(recDoc, (i) => fetched.get(chunkIdOf(d.id, i)))
      }
      if (rec === undefined) {
        console.warn('クラウドのレコードを読み取れませんでした', d.id)
        continue
      }
      changes.push({
        table: recDoc.table as TableName,
        id: recDoc.id,
        record: rec as Change['record'],
        ...(recDoc.device === deviceId ? { own: true } : {}),
        ...(freshReset(recDoc, at) ? { reset: true } : {}),
      })
    }
    const advance = !fromCache && newest && later(newest, cursor) ? newest : undefined
    if (changes.length || advance) {
      const applied = await target.applyRemote(changes, advance)
      if (applied === null) {
        // 復元・すべて削除をクラウドに当てるまで受け取らない（当てた後で、記録した位置から受け取り直す）
        deferred = true
        requestUpload(true)
        return
      }
    }
    if (advance) cursor = advance
    if (!fromCache) downloaded = true
    for (const f of [...remoteWaiters]) f()
    if (!fromCache) {
      const pending = await refreshPending()
      if (!uploading) {
        setStatus(
          pending === 0
            ? { phase: 'synced', lastSyncedAt: Date.now(), error: null }
            : { phase: status.phase === 'error' || status.phase === 'offline' ? status.phase : 'uploading' },
        )
        if (pending > 0) requestUpload()
      }
    }
    // 全件を購読している（初めての受け取り）なら、届いた分を抱えたままにしないよう、記録した位置から購読し直す
    if (!fromCache && !subscribedFrom && cursor) reanchor()
  }

  // ---------- 送信 ----------

  let uploadTimer: ReturnType<typeof setTimeout> | null = null
  let uploadSince: number | null = null
  let uploading: Promise<void> | null = null
  let uploadAgain = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0

  function requestUpload(immediate = false): void {
    if (stopped) return
    if (uploading) {
      uploadAgain = true
      return
    }
    const now = Date.now()
    if (uploadSince === null) uploadSince = now
    if (uploadTimer) clearTimeout(uploadTimer)
    const delay = immediate ? 0 : Math.max(0, Math.min(uploadDelay, uploadSince + uploadMaxWait - now))
    uploadTimer = setTimeout(() => {
      uploadTimer = null
      uploadSince = null
      void uploadAll()
    }, delay)
  }

  function scheduleRetry(): void {
    if (retryTimer || stopped) return
    const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]
    retryCount += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void uploadAll()
    }, delay)
  }

  interface BatchResult {
    done: boolean
    progressed: number
    conflicts: OutboxItem[]
  }

  async function uploadBatch(): Promise<BatchResult> {
    const items = await target.readOutbox(BATCH_RECORDS)
    if (!items.length) return { done: true, progressed: 0, conflicts: [] }
    const idle = items.filter(nothingToSend)
    if (idle.length) await target.completeUpload(idle.map((it) => ({ table: it.table, id: it.id, record: it.local })))
    const batch = selectBatch(items, { chunkSize, maxChars: BATCH_CHARS, maxDocs: BATCH_DOCS })
    if (!batch.length) return { done: false, progressed: idle.length, conflicts: [] }
    // 送っている途中で、新しい版のアプリで書かれたデータに気付いた（順番を待っている間も含む）: 書かずに戻る（送信待ちは残す）
    if (sendPaused()) return { done: false, progressed: idle.length, conflicts: [] }
    // 書き込みがクラウドに届いたのに、返事を受け取れない（オフラインになった・アプリを閉じた）ことがある。その後に端末内で
    // 消した・元に戻しても「送るものが無い」として外さないように、返事を受け取るまでの印を付けておく（クラウドに残った版が
    // この端末の書き込みの通知として戻り、消したものが生き返らないように）。必ず上書きするもの・印の付いたものは書き直さない
    const unmarked = batch.filter((b) => !b.it.force && !b.it.unconfirmed).map((b) => b.it.k)
    if (unmarked.length) await target.markUnconfirmed(unmarked)

    const result = await runTransaction(fs, async (tx) => {
      // オフラインになってから記録の見張りがサーバーと揃い直すまでは、データの形の版もこのトランザクションで読んで確かめる
      // （読んだ記録は書き込みといっしょに確かめられるので、書くまでに上げられたらやり直しになり、読み直す）
      const recheck = modelState !== 'ok' && Boolean(opts.appModel)
      const [snaps, marker] = await Promise.all([
        Promise.all(batch.map((b) => tx.get(doc(col, docIdOf(b.it.table, b.it.id))))),
        recheck ? tx.get(appModelRef(fs, uid)) : Promise.resolve(null),
      ])
      if (recheck) {
        if (marker && newerModel(marker.exists() ? asModel(marker.data()) : null)) throw MODEL_PAUSED
        if (modelState === 'newer') throw MODEL_PAUSED
      }
      // 読んでいる間にオフラインになった・新しい版のアプリで書かれていると分かった: 書かずに終わる（オフラインの前に
      // 始めたトランザクションが、確かめ直す前に書かないように。次の回は記録を読んで確かめる）
      else if (modelState !== 'ok') throw MODEL_PAUSED
      const clouds = snaps.map((snap) => (snap.exists() ? (snap.data() as RecordDoc) : null))
      // 共通の履歴が無いものは、クラウドに何も無い時だけ書く（あれば受信で突き合わせる）。
      // 復元・すべて削除の後は、この端末の内容で必ず上書きする。幕のまとまりは全部を書ける時だけ書く
      const decision = decideBatch(
        batch,
        clouds.map((c) => ({ exists: c !== null, hash: c && !c.deleted ? c.hash : '' })),
      )
      const written: { change: Change; hash: string; replaced: StoredCursor | null }[] = []
      /** 書かずに送り終えるもの（返事の無かった送信待ちで、クラウドも端末内も base のまま） */
      const settled: Change[] = []
      batch.forEach((b, i) => {
        if (!decision.write[i]) return
        if (sameAsBase(b.it)) {
          settled.push({ table: b.it.table, id: b.it.id, record: b.it.local })
          return
        }
        const cloud = clouds[i]
        const id = docIdOf(b.it.table, b.it.id)
        const payload: RecordDoc = {
          table: b.it.table,
          id: b.it.id,
          json: b.enc.json,
          chunks: b.enc.parts.length,
          deleted: !b.it.local,
          hash: b.enc.hash,
          updated: serverTimestamp(),
          device: deviceId,
          ...(b.it.force ? { reset: true } : {}),
        }
        tx.set(doc(col, id), payload)
        b.enc.parts.forEach((part, j) => {
          const chunk: ChunkDoc = {
            table: '_chunk',
            parent: id,
            index: j,
            json: part,
            hash: b.enc.hash,
            updated: serverTimestamp(),
            device: deviceId,
            deleted: false,
          }
          tx.set(doc(col, chunkIdOf(id, j)), chunk)
        })
        for (let j = b.enc.parts.length; j < (cloud?.chunks ?? 0); j++) tx.delete(doc(col, chunkIdOf(id, j)))
        written.push({
          change: { table: b.it.table, id: b.it.id, record: b.it.local },
          hash: b.enc.hash,
          // 置き換えた版の時刻（クラウドに無かった時は覚えない）
          replaced: cloud ? timeOf(cloud) : null,
        })
      })
      return { written, settled, conflicts: decision.conflicts }
    }).catch((e: unknown) => {
      if (e === MODEL_PAUSED) return null
      throw e
    })
    if (!result) return { done: false, progressed: idle.length, conflicts: [] }
    for (const w of result.written) {
      const id = docIdOf(w.change.table, w.change.id)
      rememberSent(id, w.hash)
      if (w.replaced) replaced.set(id, w.replaced)
      else replaced.delete(id)
    }
    await target.completeUpload([...result.written.map((w) => w.change), ...result.settled])
    return {
      done: false,
      progressed: idle.length + result.written.length + result.settled.length,
      conflicts: result.conflicts,
    }
  }

  /** 受信を待っても base が新しくならない時は、クラウドの内容を直接読んで反映する */
  async function pullDirectly(items: OutboxItem[]): Promise<void> {
    const changes: Change[] = []
    for (const it of items) {
      const id = docIdOf(it.table, it.id)
      const snap = await getDoc(doc(col, id))
      if (!snap.exists()) {
        changes.push({ table: it.table, id: it.id, record: null })
        continue
      }
      const data = snap.data() as RecordDoc
      if (isStaleEcho(id, data)) continue
      let rec = decodeRecord(data, () => undefined)
      if (rec === undefined && data.chunks > 0) {
        const fetched = await fetchChunks(id)
        rec = decodeRecord(data, (i) => fetched.get(chunkIdOf(id, i)))
      }
      if (rec !== undefined)
        changes.push({
          table: it.table,
          id: it.id,
          record: rec as Change['record'],
          ...(data.device === deviceId ? { own: true } : {}),
          ...(freshReset(data, timeOf(data)) ? { reset: true } : {}),
        })
    }
    if (changes.length) await target.applyRemote(changes, undefined, { direct: true })
  }

  /** クラウドの記録がこのアプリより新しい版なら、送るのを止める（要更新の表示）。止めたら true */
  function newerModel(cur: AppModel | null): boolean {
    if (!opts.appModel || !cur || cur.model <= opts.appModel.model) return false
    modelState = 'newer'
    setStatus({ outdated: cur })
    return true
  }

  /**
   * トランザクションでない書き込み（復元でまとめて消す）の前に、データの形の版を確かめる。オフラインになってから
   * 記録の見張りがサーバーと揃い直していなければ、サーバーから読む
   */
  async function ensureModel(): Promise<void> {
    if (modelState === 'newer') throw MODEL_PAUSED
    if (modelState === 'ok' || !opts.appModel) return
    const snap = await getDocFromServer(appModelRef(fs, uid))
    if (newerModel(snap.exists() ? asModel(snap.data()) : null)) throw MODEL_PAUSED
  }

  /**
   * バックアップからの復元・すべて削除の後: この端末に無いクラウドのレコードを消す（この端末の内容は、
   * 「必ず上書き」の送信待ちとして続けて送る）。終わったら、記録した位置から受け取り直す。
   */
  async function pushAuthoritative(): Promise<void> {
    if (!(await target.getMeta('authoritative'))) return
    deferred = true
    await ensureModel()
    const local = await target.localKeys()
    // サーバーから読む（読んでいる途中でつながりが切れると、getDocs は端末の中の控えだけで答えるので、受け取っていない
    // レコードを消し漏らしたまま終わってしまう。サーバーから読めなければ失敗し、つながってからやり直す）
    const snap = await getDocsFromServer(query(col, where('deleted', '==', false)))
    const doomed: string[] = []
    const chunkDocs = new Map<string, string[]>()
    snap.forEach((d) => {
      const data = d.data() as RecordDoc | ChunkDoc
      if (data.table === '_chunk') {
        const list = chunkDocs.get(data.parent) ?? []
        list.push(d.id)
        chunkDocs.set(data.parent, list)
        return
      }
      if (!local.has(`${data.table}/${data.id}`)) doomed.push(d.id)
    })
    // 読んでいる間に、新しい版のアプリで書かれていると分かった
    if (modelState === 'newer') throw MODEL_PAUSED
    // 子（稿など）を親（話・タイトル）より先に消す（送信待ちを送る順と同じ）。何回かに分けて書いても、受け取った端末には
    // クラウドにあった子の削除が親の削除より先か同じ通知で届くので、親が消えた時に残っている子はその端末だけのもの（控える）
    // （消すものばかりなので、応募時の原稿の本文は応募計画の後）
    const rank = (id: string) => tableSendRank(id.slice(0, id.indexOf(':')), true)
    doomed.sort((a, b) => rank(a) - rank(b))
    for (let i = 0; i < doomed.length; i += 200) {
      const batch = writeBatch(fs)
      for (const id of doomed.slice(i, i + 200)) {
        const [table, ...rest] = id.split(':')
        const tombstone: RecordDoc = {
          table: table as TableName,
          id: rest.join(':'),
          json: null,
          chunks: 0,
          deleted: true,
          hash: '',
          updated: serverTimestamp(),
          device: deviceId,
          reset: true,
        }
        batch.set(doc(col, id), tombstone)
        for (const c of chunkDocs.get(id) ?? []) batch.delete(doc(col, c))
      }
      await batch.commit()
    }
    await target.setMeta('authoritative', null)
  }

  function uploadAll(): Promise<void> {
    if (uploading) {
      uploadAgain = true
      return uploading
    }
    if (stopped) return Promise.resolve()
    if (uploadTimer) {
      clearTimeout(uploadTimer)
      uploadTimer = null
      uploadSince = null
    }
    // データの形の版をまだ確かめていない・新しい版のアプリで書かれたデータがある間は送らない
    // （送信待ちはそのまま残し、確かめられた・アプリを更新した時に送る）。
    // 同期を始めてからまだ確かめていなければ、確かめ終わるまで待ってから送る（いますぐ同期・ログアウトの前の送信が、
    // 送らずに終わらないように）。長く確かめられない時は、送らずに終わる（送信待ちは残る。確かめられたら送る）。
    // 一度確かめた後にオフラインになった時は待たない（送るトランザクションの中で確かめる。modelRecheck）。
    // 送らずに終わる時は、送信待ちの件数を数え直す（ヘッダーの表示と、「いますぐ同期」が送っていないのに同期できたと
    // 言わないように。端末内の読み取りだけ）
    const recount = () => (stopped ? Promise.resolve() : refreshPending().then(noop, noop))
    if (modelState === 'unknown' && !modelRecheck) {
      void recount()
      return new Promise<void>((resolve) => {
        const giveUp = () => void recount().then(resolve)
        const t = setTimeout(giveUp, modelWait)
        void modelReady.then(async () => {
          clearTimeout(t)
          if (modelState === 'ok' && !stopped) {
            await uploadAll()
            resolve()
          } else giveUp()
        })
      })
    }
    if (modelState === 'newer') return recount()
    uploading = (async () => {
      try {
        await target.flush?.()
        await refreshPending()
        if (!ownerOk) {
          // 起動した時に通信できず、持ち主を確かめられなかった
          await claimOwner()
          ownerOk = true
        }
        await exclusive(pushAuthoritative)
        let stuck = 0
        for (;;) {
          // 新しい版のアプリで書かれたデータに気付いた: ここで送るのをやめる（送信待ちは残す。ok に戻ったら送り直す）
          if (sendPaused()) return
          const r = await exclusive(uploadBatch)
          if (r.done) break
          if (sendPaused()) return
          if (status.phase !== 'uploading') setStatus({ phase: 'uploading', error: null })
          await refreshPending()
          if (r.conflicts.length && r.progressed === 0) {
            // クラウド側が先に変わっていた: 受信で合わせてから送り直す
            stuck += 1
            if (stuck >= 3) await exclusive(() => pullDirectly(r.conflicts))
            else await waitForRemote(3000)
            if (stuck > 6) throw new Error('クラウドとの差を解消できませんでした。しばらくしてからもう一度お試しください。')
          } else stuck = 0
        }
        if (deferred) {
          // 復元・すべて削除をクラウドに当て終わった: 記録した位置から受け取り直す
          deferred = false
          await exclusive(async () => {
            if (!stopped) subscribe()
          })
        }
        retryCount = 0
        const pending = await refreshPending()
        // 最後に揃った時刻は、初めての受け取りが終わってから付ける
        if (pending === 0)
          setStatus(
            downloaded ? { phase: 'synced', lastSyncedAt: Date.now(), error: null } : { phase: 'downloading', error: null },
          )
      } catch (e) {
        // 復元でまとめて消す前に、新しい版のアプリで書かれたデータに気付いた（要更新の表示は出してある）
        if (e === MODEL_PAUSED) {
          await recount()
          return
        }
        fail(e)
        scheduleRetry()
      }
    })().finally(() => {
      uploading = null
      if (uploadAgain && !stopped) {
        uploadAgain = false
        requestUpload()
      }
    })
    return uploading
  }

  /** 最初にログインしたアカウントを持ち主として記録する。別のアカウントのクラウドなら同期しない */
  async function claimOwner(): Promise<void> {
    const ref = doc(fs, ...OWNER_DOC)
    const snap = await getDoc(ref)
    if (!snap.exists()) {
      // 持ち主として同期していたアカウントの記録が消えている = 持ち主を変えようとしている。取り戻さない
      if ((await target.getMeta<string>('ownerSeen')) === uid)
        throw new SyncError(
          'owner-reset',
          'クラウドの持ち主の記録が消されています（持ち主を変えようとしています）。新しい持ち主のアカウントでログインしてください。',
        )
      await setDoc(ref, { uid, createdAt: serverTimestamp() })
    } else if ((snap.data() as { uid?: string }).uid !== uid) {
      throw new SyncError(
        'owner-mismatch',
        'このクラウドは別の Google アカウントのものです。持ち主のアカウントでログインしてください。',
      )
    }
    await target.setMeta('ownerSeen', uid)
  }

  let begun = false
  let beginRetry: ReturnType<typeof setTimeout> | null = null

  /**
   * 同期を始める。持ち主を確かめてから（ownerLock の時）、初めてのアカウントなら端末内を「共通の履歴が無い」状態にし、
   * 購読と送信を始める。通信できずに持ち主を確かめられない時は、つながってからやり直す。
   */
  async function begin(): Promise<void> {
    if (stopped || begun) return
    if (!ownerOk) {
      try {
        await claimOwner()
        ownerOk = true
      } catch (e) {
        fail(e)
        if (e instanceof SyncError) {
          // 別のアカウントのクラウド: 何も送らず、受け取らない
          stopped = true
          return
        }
        if (!beginRetry && !stopped)
          beginRetry = setTimeout(() => {
            beginRetry = null
            void begin()
          }, RETRY_DELAYS_MS[1])
        return
      }
    }
    if (stopped || begun) return
    begun = true
    const storedUid = await target.getMeta<string>('uid')
    if (storedUid !== uid) {
      // このアカウントと同期するのは初めて: 端末内のものはクラウドとの共通の履歴が無い前提で突き合わせ、全件を受け取る
      await target.markAllDirty()
      await target.setMeta('cursor', null)
      await target.setMeta('uid', uid)
    }
    if ((await target.getMeta<number>('syncSchema')) !== SYNC_SCHEMA) {
      await target.setMeta('cursor', null)
      await target.setMeta('syncSchema', SYNC_SCHEMA)
    }
    if (stopped) return
    cursor = (await target.getMeta<StoredCursor | null>('cursor')) ?? null
    deferred = Boolean(await target.getMeta('authoritative'))
    setStatus({ phase: 'downloading', error: null })
    await refreshPending()
    if (opts.appModel && !modelUnsub) {
      modelUnsub = watchAppModel(fs, uid, opts.appModel, (s) => {
        if (stopped) return
        if (s.state === 'unknown') {
          if (modelState === 'ok') {
            // オフラインになった（つながり直している）: 見張りがサーバーと揃い直すまでは、送る時に記録を読んで確かめる
            // （オフラインの間に新しい版のアプリが記録を上げていることがある）
            modelState = 'unknown'
            modelRecheck = true
            modelReady = new Promise<void>((resolve) => (modelKnown = resolve))
            // 送る物が無ければ、送信の失敗からオフラインの表示にはならない。ここで出す
            setStatus({ phase: 'offline', error: OFFLINE_MESSAGE })
          }
          // 新しい版のアプリで書かれている（newer・要更新の表示）は、そのまま
          return
        }
        const was = modelState
        modelState = s.state
        modelRecheck = false
        modelKnown()
        if (s.state === 'newer') setStatus({ outdated: s.cloud })
        else if (status.outdated) setStatus({ outdated: null })
        // 送ってよいと分かった: 待たせていた送信待ちを送る
        if (s.state === 'ok' && was !== 'ok') requestUpload(true)
      })
    }
    if (!deferred) subscribe()
    requestUpload(true)
  }

  const onOnline = () => {
    if (stopped) return
    if (!begun) {
      void begin()
      return
    }
    if (!unsub && !resubscribeTimer) subscribe()
    else reanchor()
    requestUpload(true)
  }

  return {
    get status() {
      return status
    },

    async start() {
      if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
      await begin()
    },

    stop() {
      stopped = true
      listenerGen += 1
      unsub?.()
      unsub = null
      modelUnsub?.()
      modelUnsub = null
      // データの形の版を待っている送信（いますぐ同期・ログアウト）を終わらせる
      modelKnown()
      for (const t of [uploadTimer, retryTimer, resubscribeTimer, beginRetry]) if (t) clearTimeout(t)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
    },

    requestUpload: (immediate?: boolean) => {
      if (begun) requestUpload(immediate)
    },

    flush: () => (begun ? uploadAll() : Promise.resolve()),

    reanchor,

    async idle() {
      for (;;) {
        const u = uploading
        if (u) await u
        await lock
        if (!uploading && !uploadTimer) return
        if (uploadTimer) {
          clearTimeout(uploadTimer)
          uploadTimer = null
          uploadSince = null
          void uploadAll()
        }
      }
    },
  }
}
