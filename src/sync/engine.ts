// クラウド（Firestore）との送受信。
// - 受信: users/{uid}/records を「前回受け取った時刻より後に書かれたもの」でリアルタイム購読し、届いた変更を反映する
// - 送信: 端末内の送信待ちを、クラウド側が前回揃えた時から変わっていないことを確かめながら（トランザクション）書く。
//   変わっていたら書かずに、受信で base が新しくなる（3者マージされる）のを待ってから送り直す。
// 送受信は exclusive で1つずつ行い、送った結果を記録する前に自分の書いた変更を受け取ることがないようにする。
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore'
import type { Change, OutboxItem } from '../db/persistence'
import type { TableName } from '../domain/types'
import {
  CHUNK_CHARS,
  RECORDS,
  chunkIdOf,
  decodeRecord,
  docIdOf,
  encodeRecord,
  hashRecord,
  type ChunkDoc,
  type Encoded,
  type RecordDoc,
} from './codec'
import { contentEqual } from './merge'

/** エンジンが端末内のデータを読み書きする口（アプリではストア、テストでは保存先を直接使う） */
export interface SyncTarget {
  readOutbox(limit: number): Promise<OutboxItem[]>
  completeUpload(sent: Change[]): Promise<void>
  /** クラウドの変更を反映する。cursor は同じトランザクションで記録する */
  applyRemote(changes: Change[], cursor?: unknown): Promise<unknown>
  outboxCount(): Promise<number>
  markAllDirty(): Promise<void>
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
}

export interface SyncEngine {
  start(): Promise<void>
  stop(): void
  /** 送信待ちを送る（immediate なら待たずに） */
  requestUpload(immediate?: boolean): void
  /** いますぐ送る（送り終わるか失敗するまで待つ） */
  flush(): Promise<void>
  /** 受信と送信がひと段落するまで待つ（テスト用） */
  idle(): Promise<void>
  readonly status: SyncStatus
}

/** 同期の形の版。文書の形や表を変えたら上げる（次の起動で全件を受け取り直す） */
export const SYNC_SCHEMA = 1

interface StoredCursor {
  s: number
  n: number
}

const BATCH_RECORDS = 100
/** 1回のトランザクションで書く量の上限（文字数。UTF-8 で 10MiB の上限に十分収まるように） */
const BATCH_CHARS = 1_500_000
const BATCH_DOCS = 400
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000]

const later = (a: StoredCursor, b: StoredCursor | null) => !b || a.s > b.s || (a.s === b.s && a.n > b.n)

function errorCode(e: unknown): string {
  return typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
}

function describeError(e: unknown): { offline: boolean; message: string } {
  const code = errorCode(e)
  if (code === 'unavailable' || code === 'deadline-exceeded' || (typeof navigator !== 'undefined' && navigator.onLine === false))
    return { offline: true, message: 'オフラインです。つながると自動で同期します。' }
  if (code === 'permission-denied')
    return { offline: false, message: 'クラウドへのアクセスが拒否されました。ログインし直してください。' }
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
  const col = collection(fs, 'users', uid, RECORDS)

  let stopped = false
  let unsub: Unsubscribe | null = null
  let cursor: StoredCursor | null = null
  let downloaded = false
  let status: SyncStatus = { phase: 'starting', pending: 0, lastSyncedAt: null, error: null }

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
    const q = cursor
      ? query(col, where('updated', '>', new Timestamp(cursor.s, cursor.n)), orderBy('updated'))
      : query(col, orderBy('updated'))
    unsub = onSnapshot(
      q,
      (snap) => {
        const changed = snap
          .docChanges()
          .filter((c) => c.type !== 'removed')
          .map((c) => c.doc)
        const fromCache = snap.metadata.fromCache
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
    if (stopped) return
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
      if (data.updated instanceof Timestamp) {
        const at = { s: data.updated.seconds, n: data.updated.nanoseconds }
        if (later(at, newest)) newest = at
      }
      if (data.table === '_chunk') continue
      const recDoc = data as RecordDoc
      let rec = decodeRecord(recDoc, (i) => chunks.get(chunkIdOf(d.id, i)))
      if (rec === undefined && recDoc.chunks > 0) {
        const fetched = await fetchChunks(d.id)
        rec = decodeRecord(recDoc, (i) => fetched.get(chunkIdOf(d.id, i)))
      }
      if (rec === undefined) {
        console.warn('クラウドのレコードを読み取れませんでした', d.id)
        continue
      }
      changes.push({ table: recDoc.table as TableName, id: recDoc.id, record: rec as Change['record'] })
    }
    const advance = !fromCache && newest && later(newest, cursor) ? newest : undefined
    if (changes.length || advance) await target.applyRemote(changes, advance)
    if (advance) cursor = advance
    if (!fromCache && !downloaded) downloaded = true
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
    // クラウドと同じ内容になっているもの（編集して元に戻した等）は送らずに済ませる
    const same = items.filter((it) => contentEqual(it.local, it.base))
    if (same.length) await target.completeUpload(same.map((it) => ({ table: it.table, id: it.id, record: it.local })))
    const batch: { it: OutboxItem; enc: Encoded; baseHash: string }[] = []
    let chars = 0
    let docs = 0
    for (const it of items) {
      if (contentEqual(it.local, it.base)) continue
      const enc = encodeRecord(it.local, chunkSize)
      if (batch.length && (chars + enc.size > BATCH_CHARS || docs + 1 + enc.parts.length > BATCH_DOCS)) break
      batch.push({ it, enc, baseHash: hashRecord(it.base) })
      chars += enc.size
      docs += 1 + enc.parts.length
    }
    if (!batch.length) return { done: false, progressed: same.length, conflicts: [] }

    const result = await runTransaction(fs, async (tx) => {
      const snaps = await Promise.all(batch.map((b) => tx.get(doc(col, docIdOf(b.it.table, b.it.id)))))
      const written: Change[] = []
      const conflicts: OutboxItem[] = []
      batch.forEach((b, i) => {
        const snap = snaps[i]
        const cloud = snap.exists() ? (snap.data() as RecordDoc) : null
        const cloudHash = cloud && !cloud.deleted ? cloud.hash : ''
        if (cloudHash !== b.baseHash) {
          conflicts.push(b.it)
          return
        }
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
          }
          tx.set(doc(col, chunkIdOf(id, j)), chunk)
        })
        for (let j = b.enc.parts.length; j < (cloud?.chunks ?? 0); j++) tx.delete(doc(col, chunkIdOf(id, j)))
        written.push({ table: b.it.table, id: b.it.id, record: b.it.local })
      })
      return { written, conflicts }
    })
    await target.completeUpload(result.written)
    return { done: false, progressed: same.length + result.written.length, conflicts: result.conflicts }
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
      let rec = decodeRecord(data, () => undefined)
      if (rec === undefined && data.chunks > 0) {
        const fetched = await fetchChunks(id)
        rec = decodeRecord(data, (i) => fetched.get(chunkIdOf(id, i)))
      }
      if (rec !== undefined) changes.push({ table: it.table, id: it.id, record: rec as Change['record'] })
    }
    if (changes.length) await target.applyRemote(changes, undefined)
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
    uploading = (async () => {
      try {
        await target.flush?.()
        let stuck = 0
        for (;;) {
          if (stopped) return
          const r = await exclusive(uploadBatch)
          if (r.done) break
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
        retryCount = 0
        const pending = await refreshPending()
        if (pending === 0) setStatus({ phase: downloaded ? 'synced' : 'downloading', lastSyncedAt: Date.now(), error: null })
      } catch (e) {
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

  const onOnline = () => {
    if (stopped) return
    if (!unsub && !resubscribeTimer) subscribe()
    requestUpload(true)
  }

  return {
    get status() {
      return status
    },

    async start() {
      const storedUid = await target.getMeta<string>('uid')
      if (storedUid !== uid) {
        // 初めてこのアカウントで同期する: 端末内のものはすべてクラウドに無い前提で送り、全件を受け取る
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
      setStatus({ phase: 'downloading', error: null })
      await refreshPending()
      subscribe()
      requestUpload(true)
      if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
    },

    stop() {
      stopped = true
      listenerGen += 1
      unsub?.()
      unsub = null
      for (const t of [uploadTimer, retryTimer, resubscribeTimer]) if (t) clearTimeout(t)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
    },

    requestUpload,

    flush: () => uploadAll(),

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
