// 戦略タブの表示用の純粋な計算（締切・結果発表までの日数・規定の判定・応募時スナップショットとの比較など）。
import { compareSnapshotWithCurrent, type SnapshotDiff } from '../../../domain/entityOps'
import { activeBody, episodeNumbers, flatten, pieceLabel } from '../../../domain/structure'
import { countChars, formatCount, textStats } from '../../../domain/text'
import type {
  AppData,
  ID,
  LimitUnit,
  PieceKind,
  Submission,
  SubmissionSnapshot,
  SubmissionStatus,
} from '../../../domain/types'

// ---------- 現在の原稿 ----------

export interface ManuscriptSummary {
  /** 採用原稿の総文字数（空白・改行除く） */
  chars: number
  /** 400字詰め原稿用紙換算（各話を新しいページから書いた場合の合計） */
  pages: number
  episodes: number
  specials: number
  /** 採用原稿がない話・特殊ブロックの合計 */
  missingActive: number
  /** 採用原稿がない第n話の数 */
  missingEpisodes: number
  /** 採用原稿がない特殊ブロックの数 */
  missingSpecials: number
}

export function manuscriptSummary(data: AppData, titleId: ID): ManuscriptSummary {
  const s: ManuscriptSummary = {
    chars: 0,
    pages: 0,
    episodes: 0,
    specials: 0,
    missingActive: 0,
    missingEpisodes: 0,
    missingSpecials: 0,
  }
  for (const item of flatten(data, titleId)) {
    const p = data.pieces[item.pieceId]
    if (p.kind === 'episode') s.episodes += 1
    else s.specials += 1
    const body = activeBody(data, p)
    if (body === null) {
      s.missingActive += 1
      if (p.kind === 'episode') s.missingEpisodes += 1
      else s.missingSpecials += 1
      continue
    }
    s.chars += countChars(body)
    s.pages += textStats(body).manuscriptPages
  }
  return s
}

/** 「3話＋特殊1」「3話」「特殊1」（特殊ブロックは話数に数えない） */
export function pieceCountLabel(episodes: number, specials: number): string {
  if (specials === 0) return `${episodes}話`
  if (episodes === 0) return `特殊${specials}`
  return `${episodes}話＋特殊${specials}`
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

/** 応募前（検討中・応募予定）／応募後で結果待ち（応募済み・選考中）／結果が出た・終了（通過・受賞・落選・取り下げ） */
export type StatusPhase = 'before' | 'waiting' | 'finished'

export function statusPhase(status: SubmissionStatus): StatusPhase {
  if (isBeforeSubmission(status)) return 'before'
  if (status === 'submitted' || status === 'reviewing') return 'waiting'
  return 'finished'
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

/** ローカル日付の 'yyyy-mm-dd' */
export function toYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
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

/** 「結果発表まであと12日（2026/11/09）」「結果発表日を過ぎています（2026/10/01）」など。未設定なら null */
export function resultInfo(resultOn: string, today: Date): DeadlineInfo | null {
  const days = daysUntil(resultOn, today)
  if (days === null) return null
  const date = formatYmd(resultOn)
  if (days < 0) return { text: `結果発表日を過ぎています（${date}）`, tone: 'warn', days }
  if (days === 0) return { text: `結果発表は今日（${date}）`, tone: 'warn', days }
  return { text: `結果発表まであと${days}日（${date}）`, tone: 'muted', days }
}

// ---------- 規定（文字数・原稿用紙換算枚数） ----------

/** 古いデータ（単位なし）は文字数 */
export function limitUnitOf(s: Pick<Submission, 'limitUnit'>): LimitUnit {
  return s.limitUnit === 'pages' ? 'pages' : 'chars'
}

const UNIT_SUFFIX: Record<LimitUnit, string> = { chars: '字', pages: '枚' }

export function unitSuffix(unit: LimitUnit): string {
  return UNIT_SUFFIX[unit]
}

/** 「2,000字」「約5枚」 */
export function formatAmount(amount: number, unit: LimitUnit): string {
  return unit === 'pages' ? `約${formatCount(amount)}枚` : `${formatCount(amount)}字`
}

export interface LimitCheck {
  state: 'ok' | 'short' | 'over'
  text: string
  /** 下限まで足りない／上限を超えた量 */
  diff: number
}

/** 原稿の量が規定（下限・上限）に収まっているか。どちらも未設定なら null */
export function limitCheck(
  total: number,
  min: number | null,
  max: number | null,
  unit: LimitUnit = 'chars',
): LimitCheck | null {
  if (min === null && max === null) return null
  const u = UNIT_SUFFIX[unit]
  if (min !== null && total < min) {
    const diff = min - total
    return { state: 'short', diff, text: `あと${formatCount(diff)}${u}必要` }
  }
  if (max !== null && total > max) {
    const diff = total - max
    return { state: 'over', diff, text: `${formatCount(diff)}${u}超過` }
  }
  return { state: 'ok', diff: 0, text: '規定内' }
}

/** 「80,000〜120,000字」「80枚以上」「130枚以内」 */
export function limitRange(min: number | null, max: number | null, unit: LimitUnit = 'chars'): string {
  const u = UNIT_SUFFIX[unit]
  if (min !== null && max !== null) return `${formatCount(min)}〜${formatCount(max)}${u}`
  if (min !== null) return `${formatCount(min)}${u}以上`
  if (max !== null) return `${formatCount(max)}${u}以内`
  return ''
}

/**
 * 規定の入力欄の値を数値にする。全角数字・桁区切り・「字」「枚」「万」に対応。
 * 空欄は null、数として読めなければ undefined。
 */
export function parseLimit(input: string): number | null | undefined {
  let s = input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,、\s]/g, '')
    .replace(/[．]/g, '.')
    .replace(/(文字|字|枚)$/u, '')
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

/** 応募時の原稿の枚数（古い記録で枚数がなければ本文の控えから数える。控えもなければ null） */
export function snapshotPages(snapshot: SubmissionSnapshot): number | null {
  if (typeof snapshot.pages === 'number') return snapshot.pages
  if (!snapshot.pieces) return null
  let pages = 0
  for (const p of Object.values(snapshot.pieces)) if (p.body) pages += textStats(p.body).manuscriptPages
  return pages
}

export interface LimitBasis {
  /** current = 現在の採用原稿、snapshot = 応募時に記録した原稿 */
  source: 'current' | 'snapshot'
  amount: number
}

/**
 * 規定と比べる原稿。応募前は現在の採用原稿、応募後は応募時に記録した原稿。
 * 応募後で記録がない（または古い記録に枚数がない）ときは null。
 */
export function limitBasis(
  s: Pick<Submission, 'status' | 'snapshot' | 'limitUnit'>,
  current: { chars: number; pages: number },
): LimitBasis | null {
  const unit = limitUnitOf(s)
  if (statusPhase(s.status) === 'before') return { source: 'current', amount: unit === 'pages' ? current.pages : current.chars }
  if (!s.snapshot) return null
  const amount = unit === 'pages' ? snapshotPages(s.snapshot) : s.snapshot.charCount
  return amount === null ? null : { source: 'snapshot', amount }
}

// ---------- 結果 → 改稿方針 → 再応募方針 ----------

export interface FollowUpLine {
  field: 'result' | 'revisionPlan' | 'resubmissionPlan'
  label: string
  /** 1行に詰めた本文。未記入なら空文字 */
  text: string
}

const FOLLOW_UP: { field: FollowUpLine['field']; label: string }[] = [
  { field: 'result', label: '結果・講評' },
  { field: 'revisionPlan', label: '改稿方針' },
  { field: 'resubmissionPlan', label: '再応募方針' },
]

/** 畳んだカードに出す、結果・講評／改稿方針／再応募方針の1行の抜粋 */
export function followUpLines(
  s: Pick<Submission, 'result' | 'revisionPlan' | 'resubmissionPlan'>,
  maxLength = 80,
): FollowUpLine[] {
  return FOLLOW_UP.map(({ field, label }) => {
    const one = s[field].replace(/\s+/gu, ' ').trim()
    const chars = Array.from(one)
    return { field, label, text: chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : one }
  })
}

// ---------- 応募時スナップショット ----------

export type SnapshotChange = 'switched' | 'edited' | 'added' | 'removed'

export const SNAPSHOT_CHANGE_LABEL: Record<SnapshotChange, string> = {
  switched: '稿が変わった',
  edited: '本文を編集',
  added: '追加',
  removed: '削除',
}

export interface SnapshotRow {
  pieceId: ID
  kind: PieceKind
  label: string
  subtitle: string
  /** 記録した稿の名前（採用原稿がなかった・記録後に追加された話は null） */
  versionName: string | null
  chars: number
  /** 記録時に採用原稿がなかった */
  noActive: boolean
  change: SnapshotChange | null
}

export interface SnapshotView {
  /** 話ごとの内容（本文の控え）がある記録か。古い記録は false */
  detailed: boolean
  /** 記録した順の話（記録後に追加された話は最後） */
  rows: SnapshotRow[]
  diff: SnapshotDiff
  episodes: number
  specials: number
}

/** 応募時の記録を、今の採用原稿と比べながら表示用に並べる */
export function snapshotView(data: AppData, titleId: ID, snapshot: SubmissionSnapshot): SnapshotView {
  const diff = compareSnapshotWithCurrent(data, titleId, snapshot)
  const change = new Map<ID, SnapshotChange>()
  for (const k of ['switched', 'edited', 'added', 'removed'] as const) for (const id of diff[k]) change.set(id, k)

  const detailed = Boolean(snapshot.pieces && snapshot.order)
  let episodes = 0
  let specials = 0
  const rows: SnapshotRow[] = []
  if (detailed) {
    for (const id of snapshot.order!) {
      const p = snapshot.pieces![id]
      if (!p) continue
      if (p.kind === 'episode') episodes += 1
      else specials += 1
      rows.push({
        pieceId: id,
        kind: p.kind,
        label: p.label,
        subtitle: p.subtitle.trim(),
        versionName: p.versionName,
        chars: p.chars,
        noActive: p.body === null,
        change: change.get(id) ?? null,
      })
    }
    const numbers = episodeNumbers(data, titleId)
    for (const id of diff.added) {
      const piece = data.pieces[id]
      if (!piece) continue
      const body = activeBody(data, piece)
      rows.push({
        pieceId: id,
        kind: piece.kind,
        label: pieceLabel(data, piece, numbers),
        subtitle: piece.subtitle.trim(),
        versionName: null,
        chars: body ? countChars(body) : 0,
        noActive: body === null,
        change: 'added',
      })
    }
  } else {
    // 古い記録は話ごとの内容がないので、今もある話の種類から数える（消えた話は第n話として数える）
    for (const id of Object.keys(snapshot.activeVersions)) {
      if (data.pieces[id]?.kind === 'special') specials += 1
      else episodes += 1
    }
  }
  return { detailed, rows, diff, episodes, specials }
}

/** 「稿の切り替え 1件、本文の編集 2件」。変化がなければ空文字 */
export function snapshotChangeSummary(diff: SnapshotDiff): string {
  const parts: string[] = []
  if (diff.switched.length) parts.push(`稿の切り替え ${diff.switched.length}件`)
  if (diff.edited.length) parts.push(`本文の編集 ${diff.edited.length}件`)
  if (diff.added.length) parts.push(`追加 ${diff.added.length}件`)
  if (diff.removed.length) parts.push(`削除 ${diff.removed.length}件`)
  return parts.join('、')
}

// ---------- 並び ----------

/**
 * 締切順の表示用の並び（応募順そのものは変えない）。
 * 1. 応募前で締切が今日以降のもの（締切が近い順）
 * 2. 応募前で締切が未定のもの
 * 3. 応募済み・選考中（結果発表が近い順）
 * 4. 結果が出た・取り下げたもの、応募前のまま締切を過ぎたもの（締切順）
 * 同じ条件の中では応募順。
 */
export function sortByDeadline(list: Submission[], today: Date): Submission[] {
  const keyOf = (s: Submission): [number, number | null] => {
    const phase = statusPhase(s.status)
    if (phase === 'before') {
      const d = daysUntil(s.deadline, today)
      if (d === null) return [1, null]
      return d >= 0 ? [0, d] : [3, d]
    }
    if (phase === 'waiting') return [2, daysUntil(s.resultOn, today)]
    return [3, daysUntil(s.deadline, today)]
  }
  return list
    .map((s) => ({ s, k: keyOf(s) }))
    .sort((a, b) => {
      if (a.k[0] !== b.k[0]) return a.k[0] - b.k[0]
      const da = a.k[1]
      const db = b.k[1]
      if (da !== null && db !== null && da !== db) return da - db
      if (da === null && db !== null) return 1
      if (da !== null && db === null) return -1
      return a.s.order - b.s.order || a.s.id.localeCompare(b.s.id)
    })
    .map((x) => x.s)
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
