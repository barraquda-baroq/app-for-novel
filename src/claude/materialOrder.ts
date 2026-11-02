// 資料の記録の並び（2.6。アプリの画面とコネクタで同じ並びにする）。相対比較の分析の並び（benchOrder.ts）と同じ作り。
// - 資料の記録: 新しい日付から（同じ日なら新しく作った順）。分けて記録したもの（本文の1行目の先頭の「（1/3）」…）は番号の順
// - 項目ごとのまとまり: 決まった項目（要約・創作に役立つ知識・描写に使える部分・サンプルシーン）をこの順に、その後にほかの項目を
//   最初に記録した順（同じ時に作った記録は送った順）。まとまりの中は新しい日付から
// ホームの棚からも読むので、推敲案の場所を探す部品（anchor.ts）などを読み込まない
import { MATERIAL_SECTIONS, sectionKey } from '../domain/materialOps'
import type { AppData, ID, MaterialNote } from '../domain/types'
import { newestFirstWithParts, partMarkOf, type PartOf } from './parts'

/** 資料の記録の分けた部分: 本文の最初の行の先頭の番号。同じ日・同じ項目・同じ数に分けたものをまとめる */
const notePart: PartOf<MaterialNote> = (n) => {
  const mark = partMarkOf(n.body, 'body')
  return mark ? { key: [n.runDate, sectionKey(n.section), mark.count].join('\u0000'), mark } : null
}

/** 資料の記録（新しい日付から。分けて記録したものは番号の順） */
export function materialNotesOf(data: Pick<AppData, 'materialNotes'>, materialId: ID): MaterialNote[] {
  return newestFirstWithParts(
    Object.values(data.materialNotes).filter((n) => n.materialId === materialId),
    notePart,
  )
}

export interface SectionGroup {
  /** 項目の名前（前後の空白を除いたもの。空なら「項目なし」） */
  section: string
  /** 新しい日付から */
  items: MaterialNote[]
}

/** 決まった項目の何番目か（決まった項目でなければ -1） */
const FIXED_INDEX = new Map<string, number>(MATERIAL_SECTIONS.map((s, i) => [sectionKey(s), i]))

/**
 * 記録を項目ごとにまとめる（同じ名前の項目を1つに。前後の空白・Unicode の正規化の違いは同じとみなす）。
 * まとまりの順は、決まった4つの項目をこの順に、その後にほかの項目をその項目を最初に記録した順（作った時刻。同じ時刻なら
 * 送った順に1ずつずらしてある）。記録の無い項目のまとまりは作らない。新しい記録を足しても既にあるまとまりが動かないように、
 * あいうえお順にはしない。新しい項目は後ろに増える
 */
export function materialSectionGroups(list: readonly MaterialNote[]): SectionGroup[] {
  const sorted = newestFirstWithParts(list, notePart)
  const groups = new Map<string, { group: SectionGroup; first: number; firstId: ID }>()
  for (const n of sorted) {
    const key = sectionKey(n.section)
    const g = groups.get(key)
    if (g) {
      g.group.items.push(n)
      if (n.createdAt < g.first || (n.createdAt === g.first && n.id < g.firstId)) {
        g.first = n.createdAt
        g.firstId = n.id
      }
    } else groups.set(key, { group: { section: key || '項目なし', items: [n] }, first: n.createdAt, firstId: n.id })
  }
  const fixed = (key: string) => FIXED_INDEX.get(key) ?? -1
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => {
      const fa = fixed(ka)
      const fb = fixed(kb)
      if (fa >= 0 || fb >= 0) return fa < 0 ? 1 : fb < 0 ? -1 : fa - fb
      return a.first - b.first || (a.firstId < b.firstId ? -1 : a.firstId > b.firstId ? 1 : 0)
    })
    .map(([, g]) => g.group)
}
