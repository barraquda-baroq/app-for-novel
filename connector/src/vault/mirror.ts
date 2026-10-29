// 持ち主の記録の写し（Vault の SQLite と、メモリの AppData）。端末と同じ「updated の順」の差分の読み取りで新しくする。
// - 問い合わせ: records を updated・__name__ の順に、前回の最後の文書（cursor）の次から N 件ずつ（N は前のページの大きさで 50〜5）
//   同じ時刻の文書も名前の順で必ず次に来るので、読み直しも取りこぼしも無い（Firestore の問い合わせは強い一貫性）
// - 1ページを1つのトランザクションで保存し、cursor も同じトランザクションで進める（保存できなかったページの先へは進まない）
// - 記録は端末と同じ decodeRecord（src/sync/codec.ts）で取り出す。分割した記録（25万文字超）は、分割文書が揃うまで待ち
//   （同じ書き込みの分割文書は名前の順で親の後に来るので、次のページに続くことがある）、最後まで揃わなければ読み直し、
//   それでも読めなければ端末と同じく飛ばす（unreadable に数える）
// - 知らない表（新しい版のアプリが足したもの）の文書も保存だけしておく（取り込み直さずに済むように）
// - 稿の本文はメモリに全部は持たない: 写しの稿は本文を除いた記録で、本文は使う時に1つずつ読む（body。文字数で上限のある LRU）。
//   文字数・枚数・指紋は取り込んだ時に数えて保存し（lite）、Durable Object を作り直した時は本文を読まずに写しを作る。
//   応募時の原稿の控え・ゴミ箱の中身はツールで出さないので、本文を除いた形だけを持つ
import { bodyHashOf, primeBodyHash } from '../../../src/claude/anchor'
import { decodeRecord, type ChunkDoc, type RecordDoc } from '../../../src/sync/codec'
import type { Rec } from '../../../src/sync/merge'
import { bodyMetrics, primeBodyMetrics, type BodyMetrics } from '../../../src/domain/text'
import { TABLE_NAMES, emptyData, type AppData, type ID, type TableName, type Version } from '../../../src/domain/types'
import { log } from '../log'
import type { FirestoreRest, FsDoc } from './firestore'
import type { MirrorStore, RecRow } from './store'
import { fromFields, timestampMicros, type Timestamp } from './values'

const KNOWN = new Set<string>(TABLE_NAMES)

export interface Cursor {
  ts: string
  name: string
}

export interface WarmState {
  done: boolean
  /** 取り込み始めた時の文書の数（進み具合の表示用） */
  total: number
  /** 取り込んだ文書の数 */
  seen: number
}

export interface SyncOptions {
  /** 読むページの数の上限 */
  maxPages: number
  /** 1回に取り込む JSON の文字数の目安（超えたら次のページを読まない） */
  workBudget: number
  /** 読み取りの数を数える（足りなければ false を返して止める） */
  takeReads: (n: number) => boolean
}

export interface SyncOutcome {
  pages: number
  docs: number
  /** 最後まで読んだ（今の時点の変更をすべて受け取った） */
  done: boolean
  /** 読み取りの枠が足りずに止まった */
  outOfReads: boolean
}

const PAGE_MAX = 50
const PAGE_MIN = 5
/** メモリに持つ稿の本文の文字数の上限（LRU） */
const BODY_CACHE_CHARS = 3_000_000

type Parsed = { kind: 'rec'; row: RecRow } | { kind: 'chunk'; parent: string; name: string } | null

/** 稿の lite（本文を除いた記録・文字数と枚数・本文の指紋） */
interface VersionLite {
  head: Omit<Version, 'body'>
  metrics: BodyMetrics
  bodyHash: string
}

/** 記録の取り出し方の数（テストで、写しを作る時に本文を読まないことを確かめる） */
export interface MirrorStats {
  /** 指紋を確かめて取り出した（decodeRecord） */
  verified: number
  /** 確かめ済みの行を JSON だけで取り出した */
  trusted: number
  /** lite から本文を読まずに作った（稿・応募時の原稿の控え・ゴミ箱の中身） */
  lite: number
  /** 稿の本文を読んだ（表ごと） */
  bodies: number
}

export class Mirror {
  readonly #store: MirrorStore
  readonly #fs: FirestoreRest
  readonly #ownerUid: () => string
  #data: AppData | null = null
  #version = 0
  #pending = new Set<string>()
  #unreadable = new Set<string>()
  #pageSize = PAGE_MAX
  /** 写しの稿の、本文を除いた記録（修復は本文を読まずにこちらで行う。body は空） */
  #heads: Record<ID, Version> = {}
  /** 稿の本文（記録の名前 → 本文。古いものから外す） */
  #bodies = new Map<string, string>()
  #bodyChars = 0
  readonly stats: MirrorStats = { verified: 0, trusted: 0, lite: 0, bodies: 0 }

  constructor(store: MirrorStore, fs: FirestoreRest, ownerUid: () => string) {
    this.#store = store
    this.#fs = fs
    this.#ownerUid = ownerUid
  }

  /** 写しの内容（知っている表だけ。修復・見せる内容の絞り込みの前）。稿の本文は読む時に読み込む */
  data(): AppData {
    if (!this.#data) this.#load()
    return this.#data!
  }

  /** 写しの稿の、本文を除いた記録（body は空。data().versions と同じ id） */
  versionHeads(): Record<ID, Version> {
    if (!this.#data) this.#load()
    return this.#heads
  }

  /**
   * 本文を後から読む稿の記録（fields は head、body は読む時に読み込む）。文字数・指紋は from から引き継ぐ
   * （修復で項目を補った稿を、写しの稿と同じように使うため）
   */
  lazyVersion(head: Version, from: Version | undefined): Version {
    const v = this.#lazy(head)
    if (from) {
      primeBodyMetrics(v, bodyMetrics(from))
      primeBodyHash(v, bodyHashOf(from))
    }
    return v
  }

  #lazy(head: Omit<Version, 'body'> & { body?: string }): Version {
    const { body: _omit, ...rest } = head
    void _omit
    const name = `versions:${head.id}`
    const v = { ...rest } as Version
    Object.defineProperty(v, 'body', { get: () => this.body(name), enumerable: true, configurable: true })
    return v
  }

  /** 稿の本文（記録の名前 versions:{id}）。メモリに無ければ写しの行から読む */
  body(name: string): string {
    const hit = this.#bodies.get(name)
    if (hit !== undefined) {
      // 使った順に並べ直す
      this.#bodies.delete(name)
      this.#bodies.set(name, hit)
      return hit
    }
    const row = this.#store.getRec(name)
    const rec = row ? this.#decode(row) : null
    const body = rec && typeof (rec as { body?: unknown }).body === 'string' ? (rec as unknown as { body: string }).body : null
    if (body === null) {
      log('mirror_body_missing', { table: 'versions' })
      return ''
    }
    this.stats.bodies += 1
    this.#keepBody(name, body)
    return body
  }

  #keepBody(name: string, body: string): void {
    const prev = this.#bodies.get(name)
    if (prev !== undefined) {
      this.#bodyChars -= prev.length
      this.#bodies.delete(name)
    }
    if (body.length > BODY_CACHE_CHARS) return
    this.#bodies.set(name, body)
    this.#bodyChars += body.length
    for (const [k, v] of this.#bodies) {
      if (this.#bodyChars <= BODY_CACHE_CHARS) break
      this.#bodies.delete(k)
      this.#bodyChars -= v.length
    }
  }

  #dropBody(name: string): void {
    const prev = this.#bodies.get(name)
    if (prev === undefined) return
    this.#bodies.delete(name)
    this.#bodyChars -= prev.length
  }

  /** 内容が変わるたびに増える（見せる内容のキャッシュに使う） */
  version(): number {
    return this.#version
  }

  unreadableCount(): number {
    if (!this.#data) this.#load()
    return this.#unreadable.size
  }

  cursor(): Cursor | null {
    return this.#store.getMeta<Cursor>('cursor')
  }

  warm(): WarmState {
    return this.#store.getMeta<WarmState>('warm') ?? { done: false, total: 0, seen: 0 }
  }

  /** 以前に削除された記録か（クラウドの削除の印がある） */
  wasDeleted(table: string, id: string): boolean {
    const row = this.#store.getRec(`${table}:${id}`)
    return Boolean(row?.deleted)
  }

  /** 写しを消す（持ち主が変わった・数が合わない時。次の読み取りで最初から取り込み直す） */
  reset(): void {
    this.#store.transaction(() => {
      this.#store.clearMirror()
      this.#store.deleteMeta('cursor')
      this.#store.deleteMeta('warm')
    })
    this.#data = null
    this.#heads = {}
    this.#bodies.clear()
    this.#bodyChars = 0
    this.#pending.clear()
    this.#unreadable.clear()
    this.#version += 1
  }

  #load(): void {
    const data = emptyData()
    this.#data = data
    this.#heads = {}
    this.#pending.clear()
    this.#unreadable.clear()
    // 確かめ済みの稿などは本文を読まない（lite から作る）。まだ確かめていない行を確かめたら、次からはそうする
    this.#store.transaction(() => {
      for (const row of this.#store.loadRecs()) this.#apply(row, false)
    })
    this.#version += 1
  }

  /** 行から記録を取り出す。確かめ済みの行は JSON を読むだけ、まだなら端末と同じ decodeRecord（指紋も確かめる） */
  #decode(row: RecRow): Rec | null | undefined {
    if (row.ok) {
      if (row.deleted) return null
      let json = row.json
      if (json === null) {
        if (!row.chunks) return undefined
        const parts = this.#store.chunksOf(row.name)
        if (parts.length < row.chunks || parts.some((c, i) => c.idx !== i || c.hash !== row.hash)) return undefined
        json = parts
          .slice(0, row.chunks)
          .map((c) => c.json)
          .join('')
      }
      try {
        const rec = JSON.parse(json) as Rec
        if (rec && typeof rec === 'object' && rec.id === row.id) {
          this.stats.trusted += 1
          return rec
        }
      } catch {
        // 下で確かめ直す
      }
    }
    this.stats.verified += 1
    const doc: RecordDoc = {
      table: row.tbl as TableName,
      id: row.id,
      json: row.json,
      chunks: row.chunks,
      deleted: row.deleted,
      hash: row.hash,
      updated: null,
      device: row.device,
    }
    let chunks: Map<number, ChunkDoc> | null = null
    return decodeRecord(doc, (i) => {
      if (!chunks) {
        chunks = new Map()
        for (const c of this.#store.chunksOf(row.name))
          chunks.set(c.idx, {
            table: '_chunk',
            parent: c.parent,
            index: c.idx,
            json: c.json,
            hash: c.hash,
            updated: null,
            device: '',
            deleted: false,
          })
      }
      return chunks.get(i)
    })
  }

  /** 保存した行をメモリの内容に反映する。変わったら true */
  #apply(row: RecRow, cleanup: boolean): boolean {
    if (!KNOWN.has(row.tbl)) return false
    const table = (this.#data as unknown as Record<string, Record<string, unknown>>)[row.tbl]
    // 確かめ済みで lite のある稿・控え・ゴミ箱の中身は、本文を読まずに作る
    if (row.ok && row.lite && !row.deleted && this.#applyLite(row, table)) return true
    const rec = this.#decode(row)
    if (rec === null) {
      this.#pending.delete(row.name)
      this.#unreadable.delete(row.name)
      if (cleanup) this.#store.deleteChunks(row.name)
      if (row.tbl === 'versions') {
        delete this.#heads[row.id]
        this.#dropBody(row.name)
      }
      if (!(row.id in table)) return false
      delete table[row.id]
      return true
    }
    if (rec === undefined) {
      // 分割文書がまだ揃わない（次のページに続く）か、読めない
      if (row.chunks > 0) this.#pending.add(row.name)
      else this.#unreadable.add(row.name)
      return false
    }
    this.#pending.delete(row.name)
    this.#unreadable.delete(row.name)
    // 使わなくなった分割文書を片付ける（分割しなくなった（chunks 0）時は全部。端末は Firestore から消しているが、消したことは
    // 差分の読み取りには届かないので、残すと夜の確かめで数が合わなくなる）
    if (cleanup) this.#store.deleteChunks(row.name, row.chunks)
    let lite: string | null = null
    if (row.tbl === 'versions' && typeof (rec as { body?: unknown }).body === 'string') {
      // 稿: 文字数・枚数・指紋を数えて保存し、写しには本文を後から読む記録を入れる
      const full = rec as unknown as Version
      const info: VersionLite = { head: headOf(full), metrics: bodyMetrics(full), bodyHash: bodyHashOf(full) }
      lite = JSON.stringify(info)
      table[row.id] = this.#versionFrom(info)
      this.#keepBody(row.name, full.body)
    } else if (row.tbl === 'snapshotTexts' || row.tbl === 'trashRecords') {
      const stub = stubOf(row.tbl, rec)
      lite = JSON.stringify(stub)
      table[row.id] = stub
    } else table[row.id] = rec
    if (!row.ok) this.#store.markOk(row.name, lite)
    return true
  }

  /** lite から写しの記録を作る（読めなければ false で、ふつうに取り出す） */
  #applyLite(row: RecRow, table: Record<string, unknown>): boolean {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.lite!)
    } catch {
      return false
    }
    if (row.tbl === 'versions') {
      const info = parsed as VersionLite
      if (!info?.head || info.head.id !== row.id || !info.metrics || typeof info.bodyHash !== 'string') return false
      table[row.id] = this.#versionFrom(info)
    } else {
      const stub = parsed as { id?: unknown }
      if (!stub || stub.id !== row.id) return false
      table[row.id] = stub
    }
    this.#pending.delete(row.name)
    this.#unreadable.delete(row.name)
    this.stats.lite += 1
    return true
  }

  #versionFrom(info: VersionLite): Version {
    this.#heads[info.head.id] = { ...info.head, body: '' } as Version
    const v = this.#lazy(info.head)
    primeBodyMetrics(v, info.metrics)
    primeBodyHash(v, info.bodyHash)
    return v
  }

  #parse(doc: FsDoc): Parsed {
    const f = fromFields(doc.fields)
    const name = doc.name.slice(doc.name.lastIndexOf('/') + 1)
    const updated = (f.updated as Timestamp | null)?.timestamp ?? ''
    const updUs = timestampMicros(updated)
    if (!updated || !Number.isFinite(updUs)) return null
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    if (f.table === '_chunk') {
      const parent = str(f.parent)
      const idx = typeof f.index === 'number' ? f.index : -1
      if (!parent || idx < 0 || typeof f.json !== 'string') return null
      this.#store.putChunk({ name, parent, idx, hash: str(f.hash), json: f.json })
      return { kind: 'chunk', parent, name }
    }
    const row: RecRow = {
      name,
      tbl: str(f.table),
      id: str(f.id),
      deleted: f.deleted === true,
      chunks: typeof f.chunks === 'number' ? f.chunks : 0,
      hash: str(f.hash),
      updUs,
      updated,
      updateTime: doc.updateTime,
      device: str(f.device),
      json: typeof f.json === 'string' ? f.json : null,
      reset: f.reset === true,
    }
    if (!row.tbl || !row.id) return null
    this.#store.putRec(row)
    return { kind: 'rec', row }
  }

  /** 差分を読む（1回の呼び出しで maxPages ページまで） */
  async sync(opts: SyncOptions): Promise<SyncOutcome> {
    if (!this.#data) this.#load()
    const owner = this.#ownerUid()
    let pages = 0
    let docs = 0
    let work = 0
    let warm = this.warm()
    if (!warm.done && !this.cursor() && warm.total === 0) {
      // 最初の取り込み: 全体の数を数える（進み具合の表示用。1,000件ごとに1回の読み取り）
      try {
        if (opts.takeReads(1)) {
          const total = await this.#fs.count(`users/${owner}`, { from: [{ collectionId: 'records' }] })
          warm = { done: false, total, seen: 0 }
          this.#store.setMeta('warm', warm)
        }
      } catch (e) {
        log('mirror_count_failed', { error: e instanceof Error ? e.name : 'error' })
      }
    }
    for (;;) {
      if (pages >= opts.maxPages || (pages > 0 && work >= opts.workBudget))
        return { pages, docs, done: false, outOfReads: false }
      const n = this.#pageSize
      // 読み取り: 返った文書の数（0件でも1回）と、アクセスルールが読む2つの文書（config/owner・config/connector）
      if (!opts.takeReads(n + 2)) return { pages, docs, done: false, outOfReads: true }
      const cursor = this.cursor()
      const query: Record<string, unknown> = {
        from: [{ collectionId: 'records' }],
        orderBy: [
          { field: { fieldPath: 'updated' }, direction: 'ASCENDING' },
          { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
        ],
        limit: n,
      }
      if (cursor)
        query.startAt = { values: [{ timestampValue: cursor.ts }, { referenceValue: cursor.name }], before: false }
      const page = await this.#fs.runQuery(`users/${owner}`, query)
      // 実際に読んだ数との差を返す（多めに取った分）
      opts.takeReads(Math.max(1, page.length) + 2 - (n + 2))
      pages += 1
      docs += page.length
      const parsed: Parsed[] = []
      let size = 0
      this.#store.transaction(() => {
        for (const d of page) {
          parsed.push(this.#parse(d))
          size += (d.fields.json as { stringValue?: string } | undefined)?.stringValue?.length ?? 0
        }
        const last = page[page.length - 1]
        if (last) {
          const ts = (last.fields.updated as { timestampValue?: string } | undefined)?.timestampValue
          if (ts) this.#store.setMeta('cursor', { ts, name: last.name } satisfies Cursor)
        }
        if (!warm.done) {
          warm = { ...warm, seen: warm.seen + page.length, done: page.length < n }
          this.#store.setMeta('warm', warm)
        }
      })
      work += size
      // ページの大きさを、文書の大きさに合わせる（大きな稿が続く時は少なく）
      const avg = page.length ? size / page.length : 0
      this.#pageSize = avg > 10_000 ? Math.max(PAGE_MIN, Math.min(PAGE_MAX, Math.floor(300_000 / avg))) : PAGE_MAX
      let changed = false
      const parents = new Set<string>()
      for (const p of parsed) {
        if (!p) continue
        if (p.kind === 'rec') {
          if (this.#apply(p.row, true)) changed = true
        } else if (this.#pending.has(p.parent)) parents.add(p.parent)
      }
      for (const name of parents) {
        const row = this.#store.getRec(name)
        if (row && this.#apply(row, true)) changed = true
      }
      if (changed) this.#version += 1
      if (page.length < n) {
        await this.#finishPending(opts)
        return { pages, docs, done: true, outOfReads: false }
      }
    }
  }

  /** 最後まで読んでも分割文書が揃わない記録は、分割文書を読み直す。それでも読めなければ飛ばす */
  async #finishPending(opts: SyncOptions): Promise<void> {
    if (!this.#pending.size) return
    const owner = this.#ownerUid()
    let changed = false
    for (const name of [...this.#pending]) {
      const row = this.#store.getRec(name)
      if (!row) {
        this.#pending.delete(name)
        continue
      }
      if (!opts.takeReads(row.chunks + 2)) return
      const chunks = await this.#fs.runQuery(`users/${owner}`, {
        from: [{ collectionId: 'records' }],
        where: { fieldFilter: { field: { fieldPath: 'parent' }, op: 'EQUAL', value: { stringValue: name } } },
      })
      this.#store.transaction(() => {
        for (const d of chunks) this.#parse(d)
      })
      if (this.#apply(row, true)) changed = true
      else if (this.#pending.has(name)) {
        this.#pending.delete(name)
        this.#unreadable.add(name)
        log('mirror_unreadable', { table: row.tbl, chunks: row.chunks })
      }
    }
    if (changed) this.#version += 1
  }

  /**
   * 名前を指定して文書を読み、写しに入れる（書き込みが「もうある」で断られたのに、差分の読み取りでは見えない時の確かめ。
   * 写しの位置より前にある文書を、写しが知らなかった場合）
   */
  async fetchNames(docIds: string[]): Promise<void> {
    if (!this.#data) this.#load()
    const owner = this.#ownerUid()
    const found = await this.#fs.batchGet(docIds.map((id) => `users/${owner}/records/${id}`))
    const parsed: Parsed[] = []
    this.#store.transaction(() => {
      for (const d of found.values()) if (d) parsed.push(this.#parse(d))
    })
    let changed = false
    for (const p of parsed) if (p?.kind === 'rec' && this.#apply(p.row, false)) changed = true
    if (changed) this.#version += 1
  }

  /** 書き込んだ記録を、読み直さずに写しへ入れる（次の差分の読み取りでも同じ内容が届く） */
  putOwn(rows: RecRow[]): void {
    if (!this.#data) this.#load()
    this.#store.transaction(() => {
      for (const r of rows) this.#store.putRec(r)
    })
    let changed = false
    for (const r of rows) {
      const cur = this.#store.getRec(r.name)
      if (cur && this.#apply(cur, false)) changed = true
    }
    if (changed) this.#version += 1
  }

  /** 生きている記録・削除の印・分割文書の数（夜の確かめで、クラウドの数と比べる） */
  counts(): { live: number; deleted: number; chunks: number } {
    return { ...this.#store.recCount(), chunks: this.#store.chunkCount() }
  }
}

/** 稿の、本文を除いた記録 */
function headOf(v: Version): Omit<Version, 'body'> {
  const { body: _omit, ...rest } = v
  void _omit
  return rest
}

/** ツールで本文を出さない表の記録（応募時の原稿の控えは本文なし、ゴミ箱の中身は元の記録の id だけ） */
function stubOf(table: 'snapshotTexts' | 'trashRecords', rec: Rec): Rec {
  if (table === 'snapshotTexts') return { ...rec, body: '' } as Rec
  const r = rec as unknown as { record?: { id?: unknown } }
  return { ...rec, record: { id: r.record && typeof r.record === 'object' ? r.record.id : undefined } } as unknown as Rec
}
