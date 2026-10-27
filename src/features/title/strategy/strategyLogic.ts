// 戦略タブの表示用の純粋な計算（締切までの日数・規定文字数の判定・応募時スナップショットとの比較など）。
import { activeBody, flatten } from '../../../domain/structure'
import { countChars, formatCount, textStats } from '../../../domain/text'
import type { AppData, ID, Submission, SubmissionSnapshot, SubmissionStatus } from '../../../domain/types'

// ---------- 現在の原稿 ----------

export interface ManuscriptSummary {
  /** 採用原稿の総文字数（空白・改行除く） */
  chars: number
  /** 400字詰め原稿用紙換算（各話を新しいページから書いた場合の合計） */
  pages: number
  episodes: number
  specials: number
  /** 採用原稿がない話の数 */
  missingActive: number
}

export function manuscriptSummary(data: AppData, titleId: ID): ManuscriptSummary {
  const s: ManuscriptSummary = { chars: 0, pages: 0, episodes: 0, specials: 0, missingActive: 0 }
  for (const item of flatten(data, titleId)) {
    const p = data.pieces[item.pieceId]
    if (p.kind === 'episode') s.episodes += 1
    else s.specials += 1
    const body = activeBody(data, p)
    if (body === null) {
      s.missingActive += 1
      continue
    }
    s.chars += countChars(body)
    s.pages += textStats(body).manuscriptPages
  }
  return s
}

// ---------- 状態 ----------

export type StatusTone = 'neutral' | 'accent' | 'active' | 'danger' | 'faint'

export function statusTone(status: SubmissionStatus): StatusTone {
  switch (status) {
    case 'submitted':
    case 'reviewing':
      return 'accent'
    case 'passed':
    case 'won':
      return 'active'
    case 'rejected':
      return 'danger'
    case 'withdrawn':
      return 'faint'
    default:
      return 'neutral'
  }
}

/** まだ応募していない（締切が過ぎていたら注意が必要な）状態 */
export function isBeforeSubmission(status: SubmissionStatus): boolean {
  return status === 'considering' || status === 'planned'
}

// ---------- 日付 ----------

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/** 'yyyy-mm-dd' を UTC の日数に。不正な日付は null */
function ymdToDay(ymd: string): number | null {
  const m = YMD.exec(ymd.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(t / 86_400_000)
}

/** 端末のローカル日付での「今日」から締切までの日数（今日なら 0、過ぎていれば負） */
export function daysUntil(ymd: string, today: Date): number | null {
  const target = ymdToDay(ymd)
  if (target === null) return null
  const base = Math.round(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000)
  return target - base
}

/** 'yyyy-mm-dd' → 'yyyy/mm/dd'（不正なら空文字） */
export function formatYmd(ymd: string): string {
  return ymdToDay(ymd) === null ? '' : ymd.trim().replace(/-/g, '/')
}

export interface DeadlineInfo {
  text: string
  tone: 'muted' | 'warn' | 'danger'
  days: number
}

/** 「締切 2026/12/31（あと65日）」「締切を過ぎています（2026/10/01）」など。締切未設定なら null */
export function deadlineInfo(s: Pick<Submission, 'deadline' | 'status'>, today: Date): DeadlineInfo | null {
  const days = daysUntil(s.deadline, today)
  if (days === null) return null
  const date = formatYmd(s.deadline)
  const pending = isBeforeSubmission(s.status)
  if (days < 0) return { text: `締切を過ぎています（${date}）`, tone: pending ? 'danger' : 'muted', days }
  if (days === 0) return { text: `締切 ${date}（今日まで）`, tone: pending ? 'warn' : 'muted', days }
  return { text: `締切 ${date}（あと${days}日）`, tone: pending && days <= 14 ? 'warn' : 'muted', days }
}

// ---------- 規定文字数 ----------

export interface CharLimitCheck {
  state: 'ok' | 'short' | 'over'
  text: string
  /** 下限まで足りない／上限を超えた文字数 */
  diff: number
}

/** 現在の採用原稿の文字数が規定（下限・上限）に収まっているか。どちらも未設定なら null */
export function charLimitCheck(total: number, minChars: number | null, maxChars: number | null): CharLimitCheck | null {
  if (minChars === null && maxChars === null) return null
  if (minChars !== null && total < minChars) {
    const diff = minChars - total
    return { state: 'short', diff, text: `あと${formatCount(diff)}字必要` }
  }
  if (maxChars !== null && total > maxChars) {
    const diff = total - maxChars
    return { state: 'over', diff, text: `${formatCount(diff)}字超過` }
  }
  return { state: 'ok', diff: 0, text: '規定内' }
}

/** 「80,000〜120,000字」「80,000字以上」「120,000字以内」 */
export function charLimitRange(minChars: number | null, maxChars: number | null): string {
  if (minChars !== null && maxChars !== null) return `${formatCount(minChars)}〜${formatCount(maxChars)}字`
  if (minChars !== null) return `${formatCount(minChars)}字以上`
  if (maxChars !== null) return `${formatCount(maxChars)}字以内`
  return ''
}

/**
 * 規定文字数の入力欄の値を数値にする。全角数字・桁区切り・「字」「万」に対応。
 * 空欄は null、数として読めなければ undefined。
 */
export function parseCharLimit(input: string): number | null | undefined {
  let s = input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,、\s]/g, '')
    .replace(/[．]/g, '.')
    .replace(/(文字|字)$/u, '')
  if (s === '') return null
  let scale = 1
  if (s.endsWith('万')) {
    scale = 10_000
    s = s.slice(0, -1)
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined
  const n = Math.round(Number(s) * scale)
  return Number.isFinite(n) ? n : undefined
}

// ---------- 応募時スナップショット ----------

export interface SnapshotDiff {
  /** 採用する稿が切り替わった・話が追加/削除された数 */
  switched: number
  /** 同じ稿のまま、記録後に本文が編集された数 */
  edited: number
  /** 記録時点の話の数 */
  recordedPieces: number
  /** 現在の採用原稿の文字数 − 記録時の文字数 */
  charDelta: number
}

export function compareSnapshot(data: AppData, titleId: ID, snapshot: SubmissionSnapshot): SnapshotDiff {
  const current = new Map<ID, ID | null>()
  for (const item of flatten(data, titleId)) current.set(item.pieceId, data.pieces[item.pieceId].activeVersionId)
  const recorded = snapshot.activeVersions
  let switched = 0
  let edited = 0
  let chars = 0
  for (const [pieceId, versionId] of current) {
    if (!(pieceId in recorded) || recorded[pieceId] !== versionId) {
      switched += 1
    } else if (versionId) {
      const v = data.versions[versionId]
      if (v && v.updatedAt > snapshot.at) edited += 1
    }
    const body = activeBody(data, data.pieces[pieceId])
    if (body) chars += countChars(body)
  }
  for (const pieceId of Object.keys(recorded)) if (!current.has(pieceId)) switched += 1
  return { switched, edited, recordedPieces: Object.keys(recorded).length, charDelta: chars - snapshot.charCount }
}

// ---------- 並び ----------

/** 締切順（締切未設定は最後、同じ日は応募順）。応募順そのものは変えない表示用 */
export function sortByDeadline(list: Submission[]): Submission[] {
  return [...list].sort((a, b) => {
    const da = ymdToDay(a.deadline)
    const db = ymdToDay(b.deadline)
    if (da !== null && db !== null && da !== db) return da - db
    if (da === null && db !== null) return 1
    if (da !== null && db === null) return -1
    return a.order - b.order || a.id.localeCompare(b.id)
  })
}

export function isHttpUrl(url: string): boolean {
  const s = url.trim()
  if (!/^https?:\/\//i.test(s)) return false
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname)
  } catch {
    return false
  }
}
