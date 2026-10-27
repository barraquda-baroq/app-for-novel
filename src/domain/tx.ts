import type { AppData, ID, TableName } from './types'

type RecordOf<T extends TableName> = AppData[T][string]

/**
 * AppData をイミュータブルに更新するための小さなトランザクション。
 * 触ったテーブルだけを浅くコピーするので、永続化層は参照比較で差分を検出できる。
 */
export class Tx {
  private readonly draft: AppData
  private readonly copied = new Set<TableName>()

  constructor(base: AppData) {
    this.draft = { ...base }
  }

  get<T extends TableName>(table: T, id: ID | null | undefined): RecordOf<T> | undefined {
    if (id == null) return undefined
    return this.draft[table][id] as RecordOf<T> | undefined
  }

  all<T extends TableName>(table: T): RecordOf<T>[] {
    return Object.values(this.draft[table]) as RecordOf<T>[]
  }

  put<T extends TableName>(table: T, record: RecordOf<T>): void {
    this.ensure(table)
    ;(this.draft[table] as Record<ID, RecordOf<T>>)[record.id] = record
  }

  delete(table: TableName, id: ID): void {
    if (!(id in this.draft[table])) return
    this.ensure(table)
    delete (this.draft[table] as Record<ID, unknown>)[id]
  }

  get data(): AppData {
    return this.draft
  }

  private ensure(table: TableName): void {
    if (this.copied.has(table)) return
    ;(this.draft as unknown as Record<TableName, unknown>)[table] = { ...this.draft[table] }
    this.copied.add(table)
  }
}

export function transact<R>(base: AppData, fn: (tx: Tx) => R): { data: AppData; result: R } {
  const tx = new Tx(base)
  const result = fn(tx)
  return { data: tx.data, result }
}
