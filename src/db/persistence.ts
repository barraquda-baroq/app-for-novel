// IndexedDB（Dexie）への保存。ストアの AppData を参照比較して、変わったレコードだけを書き込む。
import Dexie, { type Table } from 'dexie'
import { TABLE_NAMES, emptyData, type AppData, type TableName } from '../domain/types'

export type AnyRecord = { id: string; updatedAt?: number }

class NovelDB extends Dexie {
  constructor(name: string) {
    super(name)
    const v1Tables = [
      'titles',
      'chapters',
      'pieces',
      'versions',
      'memos',
      'ideas',
      'settingCategories',
      'settingEntries',
      'submissions',
    ]
    this.version(1).stores(Object.fromEntries(v1Tables.map((t) => [t, 'id'])))
    // v2: 応募時の原稿の本文を内容ごとにまとめて保存する表を追加
    this.version(2).stores(Object.fromEntries([...v1Tables, 'snapshotTexts'].map((t) => [t, 'id'])))
    // v3（2.x）: ゴミ箱の表と、同期用の送信待ち（_outbox）・状態（_meta）を追加
    this.version(3).stores({
      ...Object.fromEntries(TABLE_NAMES.map((t) => [t, 'id'])),
      _outbox: 'k',
      _meta: 'key',
    })
  }

  tableOf(name: TableName): Table<AnyRecord, string> {
    return this.table(name)
  }
}

export const DEFAULT_DB_NAME = 'novel-studio'

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** base から mine で変えた項目だけを theirs に重ねる（3者マージ。同じ項目を両方が変えたらこのタブを優先） */
export function mergeRecord(base: AnyRecord, mine: AnyRecord, theirs: AnyRecord): AnyRecord {
  const out: Record<string, unknown> = { ...theirs }
  const b = base as Record<string, unknown>
  const m = mine as Record<string, unknown>
  for (const key of Object.keys(m)) {
    if (key === 'updatedAt') continue
    if (!sameValue(m[key], b[key])) out[key] = m[key]
  }
  out.updatedAt = Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0)
  return out as AnyRecord
}

/** 保存時に、別のタブが先に書き換えていたレコードをどう扱ったか */
export interface SaveOutcome {
  /** 別タブの変更とこのタブの変更を項目ごとに合わせて書いたレコード */
  merged: Partial<Record<TableName, AnyRecord[]>>
  /** 別タブで削除されていたので書かなかったレコード */
  dropped: Partial<Record<TableName, string[]>>
}

export interface Persistence {
  load(): Promise<AppData>
  /**
   * prev（このタブが最後に保存した内容）から next への差分を書き込む。
   * 保存先のレコードが prev の後に別タブで変わっていたら、このタブが変えた項目だけを重ねて書く。
   */
  save(prev: AppData, next: AppData): Promise<SaveOutcome | void>
  /** 全データを置き換える（バックアップの読み込み用） */
  replaceAll(next: AppData): Promise<void>
  close(): void
}

export function createPersistence(dbName = DEFAULT_DB_NAME): Persistence {
  const db = new NovelDB(dbName)

  return {
    async load() {
      const data = emptyData()
      await db.transaction(
        'r',
        TABLE_NAMES.map((t) => db.tableOf(t)),
        async () => {
          for (const t of TABLE_NAMES) {
            const rows = await db.tableOf(t).toArray()
            const map: Record<string, AnyRecord> = {}
            for (const r of rows) map[r.id] = r
            ;(data as unknown as Record<TableName, Record<string, AnyRecord>>)[t] = map
          }
        },
      )
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
      const outcome: SaveOutcome = { merged: {}, dropped: {} }
      if (work.length === 0) return outcome
      await db.transaction(
        'rw',
        work.map((w) => db.tableOf(w.table)),
        async () => {
          for (const w of work) {
            const table = db.tableOf(w.table)
            const base = prev[w.table] as Record<string, AnyRecord>
            if (w.puts.length) {
              const onDisk = await table.bulkGet(w.puts.map((r) => r.id))
              const toWrite: AnyRecord[] = []
              w.puts.forEach((mine, i) => {
                const before = base[mine.id]
                const disk = onDisk[i]
                if (before && !disk) {
                  // 別タブで削除されていた: 復活させない
                  ;(outcome.dropped[w.table] ??= []).push(mine.id)
                  return
                }
                if (before && disk && (disk.updatedAt ?? 0) > (before.updatedAt ?? 0)) {
                  // 別タブが先に書き換えていた: このタブが変えた項目だけを重ねる
                  const merged = mergeRecord(before, mine, disk)
                  ;(outcome.merged[w.table] ??= []).push(merged)
                  toWrite.push(merged)
                  return
                }
                toWrite.push(mine)
              })
              if (toWrite.length) await table.bulkPut(toWrite)
            }
            if (w.dels.length) await table.bulkDelete(w.dels)
          }
        },
      )
      return outcome
    },

    async replaceAll(next) {
      await db.transaction(
        'rw',
        TABLE_NAMES.map((t) => db.tableOf(t)),
        async () => {
          for (const t of TABLE_NAMES) {
            await db.tableOf(t).clear()
            const rows = Object.values(next[t] as Record<string, AnyRecord>)
            if (rows.length) await db.tableOf(t).bulkPut(rows)
          }
        },
      )
    },

    close() {
      db.close()
    },
  }
}
