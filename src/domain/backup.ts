// JSON バックアップの書き出し・読み込み。データは端末内にしかないので、機種変更や保全のために用意する。
import { repairData } from './repair'
import { DomainError, TABLE_NAMES, emptyData, type AppData } from './types'

export const BACKUP_APP_ID = 'novel-studio'
export const BACKUP_SCHEMA_VERSION = 1

export interface BackupFile {
  app: typeof BACKUP_APP_ID
  schemaVersion: number
  exportedAt: string
  data: AppData
}

export function toBackup(data: AppData, exportedAt = new Date()): BackupFile {
  return { app: BACKUP_APP_ID, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: exportedAt.toISOString(), data }
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
