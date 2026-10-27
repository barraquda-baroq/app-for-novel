// IndexedDB（Dexie）への保存。ストアの AppData を参照比較して、変わったレコードだけを書き込む。
import Dexie, { type Table } from 'dexie'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'

type AnyRecord = { id: string }

class NovelDB extends Dexie {
  constructor(name: string) {
    super(name)
    const schema = Object.fromEntries(TABLE_NAMES.map((t) => [t, 'id']))
    this.version(1).stores(schema)
  }

  tableOf(name: TableName): Table<AnyRecord, string> {
    return this.table(name)
  }
}

export const DEFAULT_DB_NAME = 'novel-studio'

export interface Persistence {
  load(): Promise<AppData>
  /** prev から next への差分を書き込む */
  save(prev: AppData, next: AppData): Promise<void>
  /** 全データを置き換える（バックアップの読み込み用） */
  replaceAll(next: AppData): Promise<void>
  close(): void
}

export function createPersistence(dbName = DEFAULT_DB_NAME): Persistence {
  const db = new NovelDB(dbName)

  return {
    async load() {
      const data = emptyData()
      await db.transaction('r', TABLE_NAMES.map((t) => db.tableOf(t)), async () => {
        for (const t of TABLE_NAMES) {
          const rows = await db.tableOf(t).toArray()
          const map: Record<string, AnyRecord> = {}
          for (const r of rows) map[r.id] = r
          ;(data as unknown as Record<TableName, Record<string, AnyRecord>>)[t] = map
        }
      })
      return data
    },

    async save(prev, next) {
      const work: { table: TableName; puts: AnyRecord[]; dels: string[] }[] = []
      for (const t of TABLE_NAMES) {
        const a = prev[t] as Record<string, AnyRecord>
        const b = next[t] as Record<string, AnyRecord>
        if (a === b) continue
        const puts: AnyRecord[] = []
        const dels: string[] = []
        for (const id in b) if (a[id] !== b[id]) puts.push(b[id])
        for (const id in a) if (!(id in b)) dels.push(id)
        if (puts.length || dels.length) work.push({ table: t, puts, dels })
      }
      if (work.length === 0) return
      await db.transaction('rw', work.map((w) => db.tableOf(w.table)), async () => {
        for (const w of work) {
          if (w.puts.length) await db.tableOf(w.table).bulkPut(w.puts)
          if (w.dels.length) await db.tableOf(w.table).bulkDelete(w.dels)
        }
      })
    },

    async replaceAll(next) {
      await db.transaction('rw', TABLE_NAMES.map((t) => db.tableOf(t)), async () => {
        for (const t of TABLE_NAMES) {
          await db.tableOf(t).clear()
          const rows = Object.values(next[t] as Record<string, AnyRecord>)
          if (rows.length) await db.tableOf(t).bulkPut(rows)
        }
      })
    },

    close() {
      db.close()
    },
  }
}
