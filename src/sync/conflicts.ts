// 同期の競合で、どちらの文章も消さないための控えを作る。
// - 稿の本文が両方の端末で変わっていた → この端末の本文を「（競合: ○○での編集）」の別の稿として残す
// - 片方で削除・片方で編集されていた → 削除を優先し、編集された内容をゴミ箱に残す（reason: 'conflict'）
import { pieceFullLabel } from '../domain/structure'
import type {
  AppData,
  ContentTableName,
  ID,
  Idea,
  Memo,
  SettingEntry,
  Submission,
  TrashEntry,
  TrashKind,
  TrashOrigin,
  TrashRecord,
  Version,
} from '../domain/types'
import type { Rec } from './merge'

/** 端末の呼び名（競合の控えの名前に使う） */
export function deviceLabel(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh/.test(ua)) return 'Mac'
  return 'この端末'
}

export function conflictVersionName(name: string, device: string): string {
  return `${name || '無題の稿'}（競合: ${device}での編集）`
}

/** 本文が競合した稿の控え（新しい id の稿。話の稿一覧の末尾に足す） */
export function conflictVersionCopy(mine: Version, device: string, id: ID, now: number): Version {
  return {
    ...mine,
    id,
    name: conflictVersionName(mine.name, device),
    sourceVersionId: mine.id,
    createdAt: now,
    updatedAt: now,
  }
}

const KIND_OF: Partial<Record<ContentTableName, TrashKind>> = {
  versions: 'version',
  memos: 'memo',
  ideas: 'idea',
  settingEntries: 'settingEntry',
  submissions: 'submission',
}

/**
 * 片方の端末で削除され、もう片方で編集されていたレコードの控えをゴミ箱の1件にする。
 * 文章を持たない表（タイトル・章・話など）は控えない（null）。
 */
export function conflictTrash(
  data: AppData,
  table: ContentTableName,
  record: Rec,
  opts: { now: number; newId: () => ID },
): { entry: TrashEntry; records: TrashRecord[] } | null {
  const kind = KIND_OF[table]
  if (!kind) return null
  let label = ''
  let titleId: ID | null = null
  const origin: TrashOrigin = { titleId: null, index: 0 }
  if (table === 'versions') {
    const v = record as unknown as Version
    const piece = data.pieces[v.pieceId]
    titleId = v.titleId ?? piece?.titleId ?? null
    label = piece ? `${pieceFullLabel(data, piece)}　${v.name}` : v.name
    origin.pieceId = v.pieceId
    origin.index = piece ? piece.versionIds.length : 0
    origin.prevId = piece?.versionIds[piece.versionIds.length - 1] ?? null
    origin.wasActive = false
  } else if (table === 'memos') {
    const m = record as unknown as Memo
    titleId = m.titleId
    label = m.name
    origin.index = m.order
  } else if (table === 'ideas') {
    const i = record as unknown as Idea
    titleId = i.titleId
    label = i.heading || i.body.split('\n')[0]?.slice(0, 40) || 'アイデア'
    origin.index = i.order
  } else if (table === 'settingEntries') {
    const e = record as unknown as SettingEntry
    titleId = e.titleId
    label = e.name || '設定のエントリ'
    origin.categoryId = e.categoryId
    origin.index = e.order
  } else if (table === 'submissions') {
    const s = record as unknown as Submission
    titleId = s.titleId
    label = s.contestName || '応募計画'
    origin.index = s.order
  }
  origin.titleId = titleId
  const entryId = opts.newId()
  const recordId = opts.newId()
  const entry: TrashEntry = {
    id: entryId,
    kind,
    label: label || '（名前なし）',
    titleName: titleId ? (data.titles[titleId]?.name ?? '') : '',
    origin,
    recordIds: [recordId],
    reason: 'conflict',
    deletedAt: opts.now,
    createdAt: opts.now,
    updatedAt: opts.now,
  }
  const trashRecord: TrashRecord = {
    id: recordId,
    entryId,
    table,
    record: record as unknown as TrashRecord['record'],
    createdAt: opts.now,
    updatedAt: opts.now,
  }
  return { entry, records: [trashRecord] }
}
