// テスト用の仮のクラウドと端末。同期エンジン（src/sync/engine.ts）と同じ規則で送受信する:
// - 送信: 送信待ちを readOutbox で読み、selectBatch・decideBatch（src/sync/batch.ts）で、クラウドの指紋が base と同じものだけを
//   1回の書き込み（同じ時刻）で書く。幕のまとまりは全部書けるか1つも書かない
// - 受信: クラウドの書き込みを、オフラインから戻った最初はまとめて1回、その後は書き込みごとに1回ずつ applyRemote で反映する
//   （Firestore は1回の書き込みを1つの通知で届ける）
// - バックアップからの復元・すべて削除: 送る前に、この端末に無いクラウドのレコードを消し（pushAuthoritative。子から先に、
//   何回かに分けて）、「必ず上書き」の送信待ちは reset の印付きで書く。それまでの受信は反映せずに、後で受け取り直す。
//   復元を始めた時の時刻（authoritativeFrom）より後にほかの端末が書いたものは、消さず・上書きせずに 3者マージする
// - 端末内の保存・3者マージは本物（src/db/persistence.ts。fake-indexeddb）
import {
  createPersistence,
  tableSendRank,
  type Change,
  type ConflictNote,
  type OutboxItem,
  type Persistence,
} from '../db/persistence'
import { repairData } from '../domain/repair'
import { conflictMessage } from '../store/appStore'
import type { AppData } from '../domain/types'
import { newId } from '../domain/util'
import { decideBatch, nothingToSend, sameAsBase, selectBatch } from '../sync/batch'
import { hashRecord } from '../sync/codec'
import { createConflictHooks } from '../sync/conflicts'
import { stableStringify, type Rec } from '../sync/merge'

interface CloudDoc {
  table: string
  id: string
  record: Rec | null
  hash: string
  ts: number
  device: string
  /** 復元・すべて削除で書いた（その内容を正とする） */
  reset?: boolean
}

export class FakeCloud {
  docs = new Map<string, CloudDoc>()
  ts = 0
  /** 書き込みの記録（失敗した時の説明用） */
  log: string[] = []
}

let seq = 0

export class FakeDevice {
  readonly p: Persistence
  /** 受け取った位置（クラウドの書き込みの時刻） */
  cursor = 0
  /** オフラインから戻った後、まだまとめて受け取っていない */
  catchingUp = false
  notes: ConflictNote[] = []
  /** 幕の知らせがあった反映ごとの知らせの文（ストアと同じく、反映する前・後の表示用の内容で話を示す） */
  messages: string[] = []
  private sent = new Map<string, string[]>()

  constructor(
    readonly name: string,
    readonly cloud: FakeCloud,
  ) {
    this.p = createPersistence(`fake-${name}-${++seq}-${Math.random().toString(36).slice(2)}`)
  }

  load(): Promise<AppData> {
    return this.p.load()
  }

  async edit(fn: (d: AppData) => AppData): Promise<void> {
    const prev = await this.p.load()
    await this.p.save(prev, fn(prev))
  }

  /** バックアップからの復元・すべて削除（次に送る時に、クラウドもこの内容に揃える） */
  async restore(data: AppData): Promise<void> {
    // 同期したことのある端末として（クラウドもこの内容に揃える）
    if (!(await this.p.getMeta('uid'))) await this.p.setMeta('uid', 'fake-user')
    await this.p.replaceAll(data)
  }

  /**
   * エンジンの pushAuthoritative と同じ: 復元の後、この端末に無いクラウドのレコードを、子から先に batch 件ずつ消す。
   * 消すのは、復元を始めた時（authoritativeFrom。初めての時にクラウドの最後の書き込みの時刻を記録する）までに書かれたものだけ。
   * stopAfter = その回数だけ書いたところで止まった（アプリを閉じた。復元の印は残り、次に開いた時に続きから）
   */
  async pushAuthoritative(opts: { batch?: number; stopAfter?: number } = {}): Promise<void> {
    if (!(await this.p.getMeta('authoritative'))) return
    const local = await this.p.localKeys()
    let from = await this.p.getMeta<number>('authoritativeFrom')
    if (from == null) {
      from = this.cloud.ts
      await this.p.setMeta('authoritativeFrom', from)
    }
    const bound = from
    const rank = (key: string) => tableSendRank(key.slice(0, key.indexOf(':')), true)
    const doomed = [...this.cloud.docs.entries()]
      .filter(([, d]) => d.record && !local.has(`${d.table}/${d.id}`) && d.ts <= bound)
      .map(([key]) => key)
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    const size = opts.batch ?? 200
    let commits = 0
    for (let i = 0; i < doomed.length; i += size) {
      if (opts.stopAfter !== undefined && commits >= opts.stopAfter) return
      const ts = ++this.cloud.ts
      const part = doomed.slice(i, i + size)
      for (const key of part) {
        const d = this.cloud.docs.get(key)!
        this.cloud.docs.set(key, { ...d, record: null, hash: hashRecord(null), ts, device: this.name, reset: true })
      }
      this.cloud.log.push(`${this.name}@${ts}: 復元で消した ${part.map((k) => k.slice(0, k.indexOf(':') + 5)).join(' ')}`)
      commits += 1
    }
    // 消し終えたが、復元の印を外す前に止まった
    if (opts.stopAfter !== undefined) return
    await this.p.setMeta('authoritative', null)
  }

  /** 復元を始めた時の時刻（エンジンの restoreBound） */
  private restoreFrom: number | null = null

  /** オフラインにする（戻った最初の受信は、それまでの書き込みをまとめて受け取る） */
  offline(): void {
    this.catchingUp = true
  }

  /**
   * エンジンの uploadBatch と同じ: 1回分を送る。
   * replyLost = 書き込みはクラウドに届いたが、返事を受け取れなかった（オフラインになった・アプリを閉じた）:
   * 送った記録（completeUpload・送った版の指紋）を残さない
   */
  async uploadBatch(opts: { replyLost?: boolean } = {}): Promise<{ done: boolean; progressed: number; conflicts: OutboxItem[] }> {
    const items = await this.p.readOutbox(100)
    if (!items.length) return { done: true, progressed: 0, conflicts: [] }
    const idle = items.filter(nothingToSend)
    if (idle.length) await this.p.completeUpload(idle.map((it) => ({ table: it.table, id: it.id, record: it.local })))
    const batch = selectBatch(items, { chunkSize: 250_000, maxChars: 1_500_000, maxDocs: 400 })
    if (!batch.length) return { done: false, progressed: idle.length, conflicts: [] }
    // 返事を受け取るまでの印（エンジンと同じ）
    const unmarked = batch.filter((b) => !b.it.force && !b.it.unconfirmed).map((b) => b.it.k)
    if (unmarked.length) await this.p.markUnconfirmed(unmarked)
    const clouds = batch.map((b) => this.cloud.docs.get(`${b.it.table}:${b.it.id}`))
    // エンジンと同じ: 必ず上書きするものがある時だけ、復元を始めた時刻を読む
    const from = batch.some((b) => b.it.force) ? ((await this.p.getMeta<number>('authoritativeFrom')) ?? null) : null
    const decision = decideBatch(
      batch,
      clouds.map((c) => ({
        exists: Boolean(c),
        hash: c?.record ? c.hash : '',
        fresh: Boolean(c && c.device !== this.name && from !== null && c.ts > from),
      })),
    )
    const ts = ++this.cloud.ts
    const written: Change[] = []
    /** 書かずに送り終えるもの（返事の無かった送信待ちで、クラウドも端末内も base のまま） */
    const settled: Change[] = []
    batch.forEach((b, i) => {
      if (!decision.write[i]) return
      if (sameAsBase(b.it)) {
        settled.push({ table: b.it.table, id: b.it.id, record: b.it.local })
        return
      }
      const key = `${b.it.table}:${b.it.id}`
      const hash = hashRecord(b.it.local)
      this.cloud.docs.set(key, {
        table: b.it.table,
        id: b.it.id,
        record: b.it.local,
        hash,
        ts,
        device: this.name,
        ...(b.it.force ? { reset: true } : {}),
      })
      if (!opts.replyLost) {
        const list = this.sent.get(key) ?? []
        list.push(hash)
        this.sent.set(key, list.slice(-20))
      }
      written.push({ table: b.it.table, id: b.it.id, record: b.it.local })
    })
    const short = (k: string) => k.slice(0, k.indexOf('/') + 5)
    this.cloud.log.push(
      `${this.name}@${ts}: 書いた ${written.map((w) => `${w.table}:${w.id.slice(0, 4)}${w.record ? '' : '(削除)'}`).join(' ')}` +
        (decision.conflicts.length ? ` | 書けなかった ${decision.conflicts.map((c) => short(c.k)).join(' ')}` : '') +
        (opts.replyLost ? '（返事を受け取れなかった）' : ''),
    )
    if (opts.replyLost) return { done: false, progressed: 0, conflicts: [] }
    await this.p.completeUpload([...written, ...settled])
    return { done: false, progressed: idle.length + written.length + settled.length, conflicts: decision.conflicts }
  }

  private staleEcho(key: string, d: CloudDoc): boolean {
    if (d.device !== this.name) return false
    const list = this.sent.get(key)
    if (!list || !list.includes(d.hash)) return false
    if (list[list.length - 1] === d.hash) {
      this.sent.set(key, [d.hash])
      return false
    }
    this.sent.set(key, list.slice(list.lastIndexOf(d.hash) + 1))
    return true
  }

  private changeOf(key: string, d: CloudDoc): Change | null {
    if (this.staleEcho(key, d)) return null
    return {
      table: d.table as Change['table'],
      id: d.id,
      record: d.record as Change['record'],
      ...(d.device === this.name ? { own: true } : {}),
      // エンジンと同じ: 記録した位置より後に書かれた復元の文書だけを、復元として当てる（届き直したものはふつうの変更）
      ...(d.reset && d.ts > this.cursor ? { reset: true } : {}),
      // この端末の復元を始めた後に、ほかの端末が書いた
      ...(d.device !== this.name && this.restoreFrom !== null && d.ts > this.restoreFrom ? { afterRestore: true } : {}),
    }
  }

  /** 反映する（復元をまだクラウドに当てていなければ反映せずに null） */
  private async apply(changes: Change[], cursor: number | undefined, direct = false): Promise<Change[] | null> {
    // 控えの表記は、反映する前の表示用の内容で作る（ストアと同じ）
    const before = repairData(await this.p.load()).data
    const notes: ConflictNote[] = []
    const hooks = createConflictHooks({
      device: this.name,
      data: () => before,
      newId,
      report: (n) => {
        this.notes.push(n)
        notes.push(n)
      },
    })
    const r = await this.p.applyRemote(changes, { cursor, ...hooks, ...(direct ? { direct: true } : {}) })
    if (notes.some((n) => n.kind === 'acts')) {
      const message = conflictMessage(notes, [before, repairData(await this.p.load()).data])
      if (message) this.messages.push(message)
    }
    return r
  }

  /**
   * 受け取っていない書き込みを反映する。戻った最初はまとめて、その後は書き込みごとに。
   * from を渡すと、その時刻より後の書き込みを受け取り直す（購読し直して、記録した位置と同じ時刻の書き込みが届き直した時）
   */
  async receive(from?: number): Promise<boolean> {
    this.restoreFrom = (await this.p.getMeta<number>('authoritativeFrom')) ?? null
    const docs = [...this.cloud.docs.entries()]
      .filter(([, d]) => d.ts > (from ?? this.cursor))
      .sort((a, b) => a[1].ts - b[1].ts || (a[0] < b[0] ? -1 : 1))
    if (!docs.length) return false
    const groups: [string, CloudDoc][][] = []
    if (this.catchingUp) groups.push(docs)
    else {
      for (const e of docs) {
        const last = groups[groups.length - 1]
        if (last && last[0][1].ts === e[1].ts) last.push(e)
        else groups.push([e])
      }
    }
    this.catchingUp = false
    for (const g of groups) {
      const changes = g.map(([k, d]) => this.changeOf(k, d)).filter((c): c is Change => c !== null)
      const cursor = g[g.length - 1][1].ts
      // 復元をクラウドに当てるまでは受け取らない（当てた後で、記録した位置から受け取り直す）
      if ((await this.apply(changes, cursor > this.cursor ? cursor : undefined)) === null) return false
      // 位置は戻さない（届き直した書き込みの時刻は、記録した位置より前のことがある）
      this.cursor = Math.max(this.cursor, cursor)
    }
    return true
  }

  /** エンジンの pullDirectly と同じ: 書けなかったものだけをクラウドから直接読んで反映する */
  async pullDirectly(items: OutboxItem[]): Promise<void> {
    this.restoreFrom = (await this.p.getMeta<number>('authoritativeFrom')) ?? null
    const changes: Change[] = []
    for (const it of items) {
      const key = `${it.table}:${it.id}`
      const d = this.cloud.docs.get(key)
      if (!d) {
        changes.push({ table: it.table, id: it.id, record: null })
        continue
      }
      const c = this.changeOf(key, d)
      if (c) changes.push(c)
    }
    if (changes.length) await this.apply(changes, undefined, true)
  }

  /** エンジンの uploadAll と同じ: 送り終わるまで送る。書けなければ受信してから送り直す */
  async sync(): Promise<void> {
    await this.pushAuthoritative()
    let stuck = 0
    for (let round = 0; round < 50; round++) {
      const r = await this.uploadBatch()
      if (r.done) break
      if (r.conflicts.length && r.progressed === 0) {
        stuck += 1
        const got = await this.receive()
        if (!got && stuck >= 3) await this.pullDirectly(r.conflicts)
        if (stuck > 6) throw new Error(`${this.name}: クラウドとの差を解消できませんでした\n${this.cloud.log.join('\n')}`)
      } else stuck = 0
    }
    await this.receive()
  }
}

/** 両方の端末の送信待ちが空になり、クラウドの書き込みをすべて受け取るまで送受信する */
export async function settle(...ds: FakeDevice[]): Promise<void> {
  for (let round = 0; round < 20; round++) {
    for (const d of ds) await d.sync()
    const counts = await Promise.all(ds.map((d) => d.p.outboxCount()))
    if (counts.every((c) => c === 0) && ds.every((d) => d.cursor === d.cloud.ts || !hasNewer(d))) return
  }
  const rows = await Promise.all(ds.map(async (d) => `${d.name}: ${JSON.stringify(await d.p.readOutbox(5)).slice(0, 800)}`))
  throw new Error(`揃いませんでした\n${rows.join('\n')}\n${ds[0].cloud.log.join('\n')}`)
}

function hasNewer(d: FakeDevice): boolean {
  for (const doc of d.cloud.docs.values()) if (doc.ts > d.cursor) return true
  return false
}

/** 2台の端末の内容が同じか */
export async function sameData(a: FakeDevice, b: FakeDevice): Promise<boolean> {
  return stableStringify(await a.load()) === stableStringify(await b.load())
}
