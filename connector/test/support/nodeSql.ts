// テスト用: Vault の SQLite を node:sqlite で動かす（Workers の ctx.storage.sql と同じ SQL）
import { DatabaseSync } from 'node:sqlite'
import type { SqlRunner, SqlValue } from '../../src/vault/store'

export function nodeSql(): SqlRunner & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  let depth = 0
  return {
    db,
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return db.prepare(sql).all(...params) as T[]
    },
    run(sql: string, ...params: SqlValue[]): void {
      if (params.length) db.prepare(sql).run(...params)
      else db.exec(sql)
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn()
      depth += 1
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      } finally {
        depth -= 1
      }
    },
  }
}
