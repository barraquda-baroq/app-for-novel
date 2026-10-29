// Vault（Durable Object）の SQLite。Workers では ctx.storage.sql、テストでは node:sqlite を同じ SQL で使う。
// - rec: Firestore の記録の文書（すべての表。知らない表も残す）。分割した記録は json が null で chunk に分割文書
// - chunk: 端末が書いた分割文書（25万文字を超える記録）
// - meta: 受け取った位置（cursor）・身元・連携の状態・数の記録など（JSON）
// 取り込んだ記録（原稿）は暗号化しない（Durable Object の保存領域はもともと暗号化されている。DECISIONS 1）。

export type SqlValue = string | number | null

export interface SqlRunner {
  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[]
  run(sql: string, ...params: SqlValue[]): void
  /** 同期のトランザクション（途中で例外なら何も書かない） */
  transaction<T>(fn: () => T): T
}

export interface RecRow {
  /** 文書の名前の最後（{表名}:{id}） */
  name: string
  tbl: string
  id: string
  deleted: boolean
  chunks: number
  hash: string
  /** updated（サーバー時刻）のマイクロ秒 */
  updUs: number
  /** updated の文字列（RFC 3339） */
  updated: string
  /** 文書の更新時刻（Firestore の updateTime） */
  updateTime: string
  device: string
  json: string | null
  reset: boolean
}

export interface ChunkRow {
  name: string
  parent: string
  idx: number
  hash: string
  json: string
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rec (name TEXT PRIMARY KEY, tbl TEXT NOT NULL, id TEXT NOT NULL, deleted INTEGER NOT NULL,
    chunks INTEGER NOT NULL, hash TEXT NOT NULL, upd_us INTEGER NOT NULL, updated TEXT NOT NULL, update_time TEXT NOT NULL,
    device TEXT NOT NULL, json TEXT, reset INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS chunk (name TEXT PRIMARY KEY, parent TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL,
    json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chunk_parent ON chunk(parent)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
]

type RecDbRow = {
  name: string
  tbl: string
  id: string
  deleted: number
  chunks: number
  hash: string
  upd_us: number
  updated: string
  update_time: string
  device: string
  json: string | null
  reset: number
}

const toRec = (r: RecDbRow): RecRow => ({
  name: r.name,
  tbl: r.tbl,
  id: r.id,
  deleted: Boolean(r.deleted),
  chunks: Number(r.chunks),
  hash: r.hash,
  updUs: Number(r.upd_us),
  updated: r.updated,
  updateTime: r.update_time,
  device: r.device,
  json: r.json,
  reset: Boolean(r.reset),
})

export class MirrorStore {
  readonly sql: SqlRunner

  constructor(sql: SqlRunner) {
    this.sql = sql
    for (const s of SCHEMA) sql.run(s)
  }

  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }

  getMeta<T>(k: string): T | null {
    const rows = this.sql.all<{ v: string }>('SELECT v FROM meta WHERE k = ?', k)
    if (!rows.length) return null
    try {
      return JSON.parse(rows[0].v) as T
    } catch {
      return null
    }
  }

  setMeta(k: string, v: unknown): void {
    this.sql.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v))
  }

  deleteMeta(k: string): void {
    this.sql.run('DELETE FROM meta WHERE k = ?', k)
  }

  getRec(name: string): RecRow | null {
    const rows = this.sql.all<RecDbRow>('SELECT * FROM rec WHERE name = ?', name)
    return rows.length ? toRec(rows[0]) : null
  }

  /** 記録を入れる（もっと新しい updated の行があれば入れない）。入れたら true */
  putRec(row: RecRow): boolean {
    // 同じ文書へのあとの書き込みは、どの端末のものでも updated（サーバー時刻）が必ず後になる
    const cur = this.sql.all<{ upd_us: number }>('SELECT upd_us FROM rec WHERE name = ?', row.name)
    if (cur.length && Number(cur[0].upd_us) > row.updUs) return false
    this.sql.run(
      `INSERT INTO rec (name, tbl, id, deleted, chunks, hash, upd_us, updated, update_time, device, json, reset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET tbl = excluded.tbl, id = excluded.id, deleted = excluded.deleted, chunks = excluded.chunks,
         hash = excluded.hash, upd_us = excluded.upd_us, updated = excluded.updated, update_time = excluded.update_time,
         device = excluded.device, json = excluded.json, reset = excluded.reset`,
      row.name,
      row.tbl,
      row.id,
      row.deleted ? 1 : 0,
      row.chunks,
      row.hash,
      row.updUs,
      row.updated,
      row.updateTime,
      row.device,
      row.json,
      row.reset ? 1 : 0,
    )
    return true
  }

  allRecs(): RecRow[] {
    return this.sql.all<RecDbRow>('SELECT * FROM rec').map(toRec)
  }

  recCount(): { live: number; deleted: number } {
    const rows = this.sql.all<{ deleted: number; n: number }>('SELECT deleted, COUNT(*) AS n FROM rec GROUP BY deleted')
    let live = 0
    let deleted = 0
    for (const r of rows) {
      if (Number(r.deleted)) deleted += Number(r.n)
      else live += Number(r.n)
    }
    return { live, deleted }
  }

  chunkCount(): number {
    return Number(this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM chunk')[0]?.n ?? 0)
  }

  putChunk(row: ChunkRow): void {
    this.sql.run(
      `INSERT INTO chunk (name, parent, idx, hash, json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET parent = excluded.parent, idx = excluded.idx, hash = excluded.hash, json = excluded.json`,
      row.name,
      row.parent,
      row.idx,
      row.hash,
      row.json,
    )
  }

  chunksOf(parent: string): ChunkRow[] {
    return this.sql
      .all<ChunkRow>('SELECT name, parent, idx, hash, json FROM chunk WHERE parent = ? ORDER BY idx', parent)
      .map((r) => ({ ...r, idx: Number(r.idx) }))
  }

  /** 分割文書を片付ける（from 番目から後ろ） */
  deleteChunks(parent: string, from = 0): void {
    this.sql.run('DELETE FROM chunk WHERE parent = ? AND idx >= ?', parent, from)
  }

  /** 取り込んだ記録をすべて消す（持ち主が変わった・数が合わない時に取り込み直す） */
  clearMirror(): void {
    this.sql.run('DELETE FROM rec')
    this.sql.run('DELETE FROM chunk')
  }
}
