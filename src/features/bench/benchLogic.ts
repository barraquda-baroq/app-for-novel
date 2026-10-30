// ベンチ作品の画面（ホームの棚・作品の画面）で使う、表示用の純粋な計算。データは変更しない。
// 棚の作品が多くても重くならないように、作品ごとの分析の並びは、中身が変わらない限り同じ配列を使い続ける
// （カードは React.memo でレコード単位の props にしている）。
import { benchAnalysesOf, benchViewpointGroups } from '../../claude/benchOrder'
import { benchWorkName } from '../../domain/benchOps'
import { trashNotice } from '../../domain/trash'
import type { AppData, BenchAnalysis, BenchWork, ID } from '../../domain/types'

/** 作品の書誌の1行（「山田・星の出版・2019・SF」。無い項目は飛ばす） */
export function biblioLine(w: Pick<BenchWork, 'author' | 'publisher' | 'year' | 'genre'>): string {
  return [w.author, w.publisher, w.year, w.genre]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .join('・')
}

/** 作品の最終更新（作品とその分析のいちばん新しい更新日時） */
export function workLastUpdated(work: Pick<BenchWork, 'updatedAt'>, analyses: readonly Pick<BenchAnalysis, 'updatedAt'>[]): number {
  return analyses.reduce((m, a) => Math.max(m, a.updatedAt), work.updatedAt)
}

/** 観点の名前（観点ごとの数つき。カードのチップに出す） */
export interface ViewpointChip {
  viewpoint: string
  count: number
}

export function viewpointChips(analyses: readonly BenchAnalysis[]): ViewpointChip[] {
  return benchViewpointGroups(analyses).map((g) => ({ viewpoint: g.viewpoint, count: g.items.length }))
}

/**
 * 作品ごとの分析（新しい日付から）。前に作った並び prev と中身（レコード）が同じ作品は、前の配列をそのまま使う
 * （カードの React.memo が効くように）
 */
export function analysesByWork(
  data: Pick<AppData, 'benchAnalyses'>,
  prev?: ReadonlyMap<ID, readonly BenchAnalysis[]>,
): Map<ID, readonly BenchAnalysis[]> {
  const raw = new Map<ID, BenchAnalysis[]>()
  for (const a of Object.values(data.benchAnalyses)) {
    const list = raw.get(a.workId)
    if (list) list.push(a)
    else raw.set(a.workId, [a])
  }
  const out = new Map<ID, readonly BenchAnalysis[]>()
  for (const [workId, list] of raw) {
    const old = prev?.get(workId)
    const same = old && old.length === list.length && old.every((a) => data.benchAnalyses[a.id] === a)
    out.set(workId, same ? old : benchAnalysesOf({ benchAnalyses: Object.fromEntries(list.map((a) => [a.id, a])) }, workId))
  }
  return out
}

export interface Comparing {
  /** 「『星の庭』『風の街』」（タイトルの並び順） */
  label: string
  count: number
}

/** 作品ごとの、比べる作品にしているタイトル */
export function comparingTitles(data: Pick<AppData, 'titles'>): Map<ID, Comparing> {
  const out = new Map<ID, string[]>()
  for (const t of Object.values(data.titles).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    for (const id of new Set(t.benchWorkIds ?? [])) {
      const list = out.get(id) ?? []
      list.push(t.name.trim() || '無題のタイトル')
      out.set(id, list)
    }
  }
  return new Map([...out].map(([id, names]) => [id, { label: names.map((n) => `『${n}』`).join(''), count: names.length }]))
}

/** 作品の削除の確認文（分析の数と、比べる作品にしているタイトルから外れることを書く） */
export function deleteWorkMessage(analyses: number, comparing: number): string {
  const lines = [trashNotice(analyses > 0 ? `この作品の分析（${analyses}件）もいっしょに` : 'この作品を')]
  if (comparing > 0)
    lines.push(`比べる作品にしているタイトル（${comparing}件）からも外れます（ゴミ箱から戻すと、また比べる作品に戻ります）。`)
  lines.push('PDF そのものは claude.ai のプロジェクトにあるので、消えません。')
  return lines.join('\n\n')
}

/** 作品の表示名 */
export const workName = benchWorkName

/** 日付の表示（YYYY-MM-DD → 2026/10/30） */
export function runDateLabel(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replace(/-/g, '/') : d || '日付なし'
}

/** 本文の1行の見本（閉じた分析に出す。Markdown の記号は除く） */
export function analysisPreview(body: string, max = 120): string {
  const flat = body
    .slice(0, 2_000)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}
