// 作品批評タブの表示用の純粋な計算（データは変えない）。
import type { CritiqueResult } from '../../../domain/types'

export interface ResultDay {
  /** YYYY-MM-DD（日本時間） */
  date: string
  items: CritiqueResult[]
}

/** 新しい日付から並んだ批評結果を、日付ごとにまとめる（並びはそのまま） */
export function groupByDate(results: readonly CritiqueResult[]): ResultDay[] {
  const days: ResultDay[] = []
  for (const r of results) {
    const last = days.at(-1)
    if (last && last.date === r.runDate) last.items.push(r)
    else days.push({ date: r.runDate, items: [r] })
  }
  return days
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** 「2026年10月28日（水）」（日付として読めなければそのまま） */
export function dayHeading(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date || '日付なし'
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) return date
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日（${WEEKDAYS[d.getUTCDay()]}）`
}

/** 結果の見出し（使ったプロンプトの名前、無ければ依頼文の最初の行） */
export function resultHeading(r: Pick<CritiqueResult, 'promptName' | 'promptText'>): string {
  const name = r.promptName.trim()
  if (name) return name
  const line =
    r.promptText
      .split(/\r\n?|\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const chars = Array.from(line)
  return chars.length ? (chars.length > 30 ? `${chars.slice(0, 30).join('')}…` : line) : '（プロンプトなし）'
}

/** 批評の範囲の表記 */
export function scopeLabel(r: Pick<CritiqueResult, 'scope'>): string {
  const s = r.scope
  if (!s || s.kind !== 'range') return 'タイトル全体'
  return s.label.trim() || '話の範囲'
}
