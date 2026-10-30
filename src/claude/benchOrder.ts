// ベンチ作品の分析の並び（2.5。アプリの画面とコネクタで同じ並びにする）。
// - 作品の分析: 新しい日付から（同じ日なら新しく作った順）。分けて記録したもの（本文の1行目の「（1/3）」…）は番号の順
// - 観点ごとのまとまり: 観点を最初に分析した順（同じ時に作った分析は送った順）、まとまりの中は新しい日付から
// ホームの棚からも読むので、推敲案の場所を探す部品（anchor.ts）などを読み込まない
import type { AppData, BenchAnalysis, ID } from '../domain/types'
import { newestFirstWithParts, partMarkOf, type PartOf } from './parts'

/** ベンチ作品の分析の分けた部分: 本文の最初の行の番号。同じ日・同じ観点・同じ数に分けたものをまとめる */
const analysisPart: PartOf<BenchAnalysis> = (a) => {
  const mark = partMarkOf(a.body)
  return mark ? { key: [a.runDate, a.viewpoint.normalize('NFC').trim(), mark.count].join('\u0000'), mark } : null
}

/** 作品の分析（新しい日付から。分けて記録したものは番号の順） */
export function benchAnalysesOf(data: Pick<AppData, 'benchAnalyses'>, workId: ID): BenchAnalysis[] {
  return newestFirstWithParts(
    Object.values(data.benchAnalyses).filter((a) => a.workId === workId),
    analysisPart,
  )
}

export interface ViewpointGroup {
  /** 観点の名前（前後の空白を除いたもの。空なら「観点なし」） */
  viewpoint: string
  /** 新しい日付から */
  items: BenchAnalysis[]
}

/**
 * 分析を観点ごとにまとめる（同じ名前の観点を1つに。前後の空白・Unicode の正規化の違いは同じとみなす）。
 * まとまりの順は、その観点を最初に分析した順（作った時刻。同じ時刻なら送った順に1ずつずらしてある）。
 * あいうえお順にしないのは、漢字の観点（構成・文体・人物…）は読みが分からず並びが意味を持たないのと、
 * 新しい分析を足しても既にあるまとまりが動かないように。新しい観点は後ろに増える
 */
export function benchViewpointGroups(list: readonly BenchAnalysis[]): ViewpointGroup[] {
  const sorted = newestFirstWithParts(list, analysisPart)
  const groups = new Map<string, { group: ViewpointGroup; first: number; firstId: ID }>()
  for (const a of sorted) {
    const key = a.viewpoint.normalize('NFC').trim()
    const g = groups.get(key)
    if (g) {
      g.group.items.push(a)
      if (a.createdAt < g.first || (a.createdAt === g.first && a.id < g.firstId)) {
        g.first = a.createdAt
        g.firstId = a.id
      }
    } else groups.set(key, { group: { viewpoint: key || '観点なし', items: [a] }, first: a.createdAt, firstId: a.id })
  }
  return [...groups.values()]
    .sort((a, b) => a.first - b.first || (a.firstId < b.firstId ? -1 : a.firstId > b.firstId ? 1 : 0))
    .map((g) => g.group)
}
