// JSON バックアップの書き出し・読み込み。データは端末内にしかないので、機種変更や保全のために用意する。
import { repairData } from './repair'
import { DomainError, TABLE_NAMES, emptyData, type AppData } from './types'

export const BACKUP_APP_ID = 'novel-studio'
/**
 * バックアップの形の版。2 = 2.3（推敲案・改稿案・戦略メモ・作品批評の表を追加）、3 = 2.5（ベンチ作品とその分析の表を追加）、
 * 4 = 2.6（資料とその記録の表を追加）。
 * これ以下の版は読み込める（無い表は空として読む）。これより新しい版は読み込まない
 */
export const BACKUP_SCHEMA_VERSION = 4

export interface BackupFile {
  app: typeof BACKUP_APP_ID
  schemaVersion: number
  exportedAt: string
  data: AppData
}

/**
 * バックアップに入れない表。ゴミ箱へ移す依頼（2.7）とアイデアへの追記の依頼（2.8）は、アプリが処理するまでの一時的な記録なので
 * 書き出さず、読み込まない（バックアップから戻すと、まだ処理していない依頼は取り消しになる）。依頼の表を足しても
 * BACKUP_SCHEMA_VERSION は上げない（上げると前の版のアプリが新しいバックアップを読めなくなる。ゴミ箱の件の by・Claude が作った
 * アイデアの source などは、前の版では知らない項目として残るだけ）
 */
const NOT_BACKED_UP = new Set<keyof AppData>(['trashRequests', 'ideaAppends'])

export function toBackup(data: AppData, exportedAt = new Date()): BackupFile {
  const { trashRequests: _omit, ideaAppends: _omitAppends, ...rest } = data
  void _omit
  void _omitAppends
  return {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    data: rest as AppData,
  }
}

export function parseBackup(json: string): AppData {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new DomainError('JSON として読み込めませんでした')
  }
  if (!parsed || typeof parsed !== 'object') throw new DomainError('バックアップファイルの形式が正しくありません')
  const file = parsed as Partial<BackupFile>
  if (file.app !== BACKUP_APP_ID) throw new DomainError('Novel Studio のバックアップファイルではありません')
  if (typeof file.schemaVersion !== 'number' || file.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new DomainError('このバージョンのアプリでは読み込めないバックアップです')
  }
  const src = (file.data ?? {}) as Partial<Record<keyof AppData, unknown>>
  const data = emptyData()
  for (const table of TABLE_NAMES) {
    if (NOT_BACKED_UP.has(table)) continue
    const records = src[table]
    if (records === undefined) continue
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
      throw new DomainError(`バックアップの ${table} が壊れています`)
    }
    for (const [id, rec] of Object.entries(records as Record<string, unknown>)) {
      if (!rec || typeof rec !== 'object' || (rec as { id?: unknown }).id !== id) {
        throw new DomainError(`バックアップの ${table} に不正なレコードがあります`)
      }
    }
    ;(data as unknown as Record<string, unknown>)[table] = records
  }
  // 参照切れ（存在しない章・話・タイトルへの参照など）は読み込み時に直す
  return repairData(data).data
}
