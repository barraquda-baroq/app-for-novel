// テスト用: クラウドの記録をアプリが受け取った形にする・アプリの処理の結果をクラウドに書く（アプリの同期の代わり）。
import { emptyData, TABLE_NAMES, type AppData, type TableName } from '../../../src/domain/types'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import type { Rec } from '../../../src/sync/merge'
import type { FakeFirebase } from './fakeFirebase'
import { OWNER } from './harness'

/** クラウドの記録を、端末と同じ decodeRecord で AppData にしたもの（アプリが受け取った内容） */
export function cloudData(fake: FakeFirebase): AppData {
  const data = emptyData() as unknown as Record<TableName, Record<string, Rec>>
  for (const d of fake.recordDocs(OWNER)) {
    const table = d.fields.table?.stringValue as TableName
    if (!TABLE_NAMES.includes(table) || d.fields.deleted?.booleanValue) continue
    const rec = decodeRecord(
      {
        table,
        id: d.fields.id.stringValue,
        json: d.fields.json.stringValue,
        chunks: 0,
        deleted: false,
        hash: d.fields.hash.stringValue,
        updated: null,
        device: d.fields.device?.stringValue,
      } as unknown as RecordDoc,
      () => undefined,
    )
    if (rec) data[table][rec.id] = rec as Rec
  }
  return data as unknown as AppData
}

/** アプリの処理の結果（前と後の差）を、端末と同じ形でクラウドに書く（消えた記録は削除の印） */
export function pushChanges(fake: FakeFirebase, before: AppData, after: AppData): void {
  for (const table of TABLE_NAMES) {
    const a = before[table] as Record<string, Rec>
    const b = after[table] as Record<string, Rec>
    for (const [id, rec] of Object.entries(b)) if (a[id] !== rec) fake.putRecord(OWNER, table, rec)
    for (const id of Object.keys(a)) if (!(id in b)) fake.tombstone(OWNER, table, id)
  }
}

/** コネクタ（claude-connector）が書いたその表の文書 */
export const connectorDocs = (fake: FakeFirebase, table: string) =>
  fake.recordDocs(OWNER).filter((d) => d.name.includes(`/${table}:`) && d.fields.device?.stringValue === 'claude-connector')
