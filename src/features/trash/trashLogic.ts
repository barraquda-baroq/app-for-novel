// ゴミ箱の画面で使う、表示用の純粋な計算。データは変更しない。
import { TRASH_KIND_LABELS, TRASH_RETENTION_DAYS, trashDaysLeft, type RestoreResult } from '../../domain/trash'
import type { AppData, ID, Piece, TrashEntry } from '../../domain/types'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const pad = (n: number) => String(n).padStart(2, '0')

/** 端末の現地時刻での日付のキー（yyyy-mm-dd） */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 日付の見出し。「今日」「昨日」「10月25日（土）」（去年以前は年も付ける） */
export function dayLabel(ts: number, nowTs: number): string {
  const d = new Date(ts)
  const today = new Date(nowTs)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(ts) === dayKey(nowTs)) return '今日'
  if (dayKey(ts) === dayKey(yesterday.getTime())) return '昨日'
  const md = `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/** 削除した時刻（hh:mm） */
export function timeLabel(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 種類の表記。話のうち特殊ブロック（プロローグ等）は「特殊ブロック」 */
export function trashKindLabel(entry: Pick<TrashEntry, 'kind' | 'recordIds' | 'id'>, records: AppData['trashRecords']): string {
  if (entry.kind === 'piece') {
    const main = records[entry.recordIds[0]]
    if (main?.entryId === entry.id && main.table === 'pieces' && (main.record as Piece).kind === 'special') return '特殊ブロック'
  }
  return TRASH_KIND_LABELS[entry.kind] ?? 'その他'
}

/** どこにあったか（「作品A › 第2章」など）。タイトル自体は空文字 */
export function trashPlace(entry: Pick<TrashEntry, 'kind' | 'titleName' | 'parentLabel' | 'origin'>): string {
  if (entry.kind === 'title') return ''
  if (entry.kind === 'idea' && !entry.origin?.titleId) return 'どのタイトルにも属さない'
  const title = entry.titleName.trim() || '無題のタイトル'
  return entry.parentLabel ? `${title} › ${entry.parentLabel}` : title
}

/** 「あと30日で完全に削除」 */
export function daysLeftLabel(days: number): string {
  return days <= 0 ? 'まもなく完全に削除' : `あと${days}日で完全に削除`
}

export interface TrashRow {
  id: ID
  entry: TrashEntry
  kind: string
  label: string
  place: string
  time: string
  daysLeft: number
  conflict: boolean
}

export interface TrashDay {
  key: string
  label: string
  rows: TrashRow[]
}

/** 新しい順に並んだ entries を、削除した日ごとにまとめる */
export function trashDays(entries: TrashEntry[], records: AppData['trashRecords'], nowTs: number): TrashDay[] {
  const days: TrashDay[] = []
  for (const entry of entries) {
    const key = dayKey(entry.deletedAt)
    let day = days.at(-1)
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(entry.deletedAt, nowTs), rows: [] }
      days.push(day)
    }
    day.rows.push({
      id: entry.id,
      entry,
      kind: trashKindLabel(entry, records),
      label: entry.label.trim() || '（名前なし）',
      place: trashPlace(entry),
      time: timeLabel(entry.deletedAt),
      daysLeft: trashDaysLeft(entry, nowTs),
      conflict: entry.reason === 'conflict',
    })
  }
  return days
}

/** 戻した後のお知らせ */
export function restoredMessage(r: Pick<RestoreResult, 'label' | 'copied' | 'movedToUnassigned'>): string {
  const name = `「${r.label.trim() || '（名前なし）'}」`
  if (r.movedToUnassigned) return `${name}を「どのタイトルにも属さない」に戻しました（元のタイトルがないため）`
  if (r.copied) return `${name}を複製として元の場所に戻しました（同じものが残っていたため）`
  return `${name}を元の場所に戻しました`
}

/** 同期の競合で残した内容の説明 */
export const CONFLICT_HELP =
  '片方の端末で削除され、もう片方の端末で編集されていたので、編集された内容をここに残しました。元に戻す時、同じものが残っていれば複製として戻ります。'

/** ページの説明 */
export const TRASH_LEAD = `削除したタイトル・話・推敲バージョン・メモ・アイデアなどは、ここに${TRASH_RETENTION_DAYS}日間残ります。「元に戻す」で元の場所に戻せます。${TRASH_RETENTION_DAYS}日たつと自動で完全に削除されます。`
