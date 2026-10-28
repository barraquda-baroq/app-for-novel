// アプリ設定・バックアップ画面で使う純粋な計算。
import { TABLE_NAMES, type AppData, type TableName } from '../../domain/types'

const pad = (n: number) => String(n).padStart(2, '0')

/** novel-studio-backup-YYYYMMDD-HHmm.json（端末の現地時刻） */
export function backupFileName(date: Date = new Date()): string {
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const hm = `${pad(date.getHours())}${pad(date.getMinutes())}`
  return `novel-studio-backup-${ymd}-${hm}.json`
}

export const TABLE_LABELS: Record<TableName, string> = {
  titles: 'タイトル',
  chapters: '章',
  pieces: '話',
  versions: '推敲バージョン',
  memos: 'メモ',
  ideas: 'アイデア',
  settingCategories: '設定項目',
  settingEntries: '設定のエントリ',
  submissions: '応募計画',
  snapshotTexts: '応募時の原稿の控え',
}

/** 表示の順番（主要なものから） */
const DISPLAY_ORDER: TableName[] = [
  'titles',
  'pieces',
  'versions',
  'chapters',
  'ideas',
  'memos',
  'settingCategories',
  'settingEntries',
  'submissions',
]

export interface TableCount {
  table: TableName
  label: string
  count: number
}

export function dataCounts(data: AppData): TableCount[] {
  return DISPLAY_ORDER.filter((t) => TABLE_NAMES.includes(t)).map((table) => ({
    table,
    label: TABLE_LABELS[table],
    count: Object.keys(data[table] ?? {}).length,
  }))
}

/** 「タイトル 2件、話 5件、…」 */
export function countsSummary(counts: TableCount[]): string {
  return counts.map((c) => `${c.label} ${c.count.toLocaleString('ja-JP')}件`).join('、')
}

export function isEmptyData(data: AppData): boolean {
  return TABLE_NAMES.every((t) => Object.keys(data[t] ?? {}).length === 0)
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '不明'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** バックアップファイルの書き出し日時（読めなければ null） */
export function readExportedAt(json: string): number | null {
  try {
    const parsed = JSON.parse(json) as { exportedAt?: unknown }
    if (typeof parsed?.exportedAt !== 'string') return null
    const t = Date.parse(parsed.exportedAt)
    return Number.isNaN(t) ? null : t
  } catch {
    return null
  }
}

export type Platform = 'ios' | 'android' | 'desktop'

/** ホーム画面への追加方法を案内するための、おおまかな端末の種類 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios'
  // iPadOS の Safari は Mac として名乗るので、タッチ対応かどうかで見分ける
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  return 'desktop'
}

/** すべてのデータを削除する時に入力してもらう言葉 */
export const DELETE_ALL_WORD = '削除'

export function confirmsDeleteAll(input: string | null): boolean {
  return input !== null && input.trim() === DELETE_ALL_WORD
}

// ---------- この端末の状態 ----------

/** 最後にバックアップを書き出した日時（この端末） */
export const LAST_BACKUP_KEY = 'novel-studio:last-backup'

/** 表示の設定（この端末だけ）。すべて削除・復元しても残す */
export const DISPLAY_PREF_KEYS: readonly string[] = ['novel-studio:prefs', 'novel-studio:piece-scroll-sync']

/** このアプリが保存しているキーのうち、keep 以外（書きかけ・折りたたみ・復旧用の控えなど）。ほかのサイトのキーには触れない */
export function localKeysToClear(keys: readonly string[], keep: readonly string[] = DISPLAY_PREF_KEYS): string[] {
  return keys.filter((k) => k.startsWith('novel-studio:') && !keep.includes(k))
}
