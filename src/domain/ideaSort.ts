// アイデアの済みと並び（仕切り・フォルダの中・コネクタの一覧で同じ）。entityOps.ts からも同じ名前で出す。
// フォルダの見せ方（ideaFolders.ts）とゴミ箱（trash.ts）が entityOps.ts を読み込まずに使えるように分けた
// （entityOps.ts → trash.ts → ideaFolders.ts → entityOps.ts の輪を作らないため）。型と util のほかは読み込まない。
import type { Idea } from './types'
import { byOrder } from './util'

/** 済み（実装した・没にした）か。checked を持たない古いアイデアは済みでない */
export function isIdeaChecked(idea: Pick<Idea, 'checked'>): boolean {
  return idea.checked === true
}

/**
 * アイデアの並び（仕切りの中・コネクタの一覧で同じ）。済みでないものは order の順、
 * 済みのものはその後ろに、新しく済みにしたものから（斜線＋グレーで下へ沈む）
 */
export function sortIdeas(list: readonly Idea[]): Idea[] {
  return [...list].sort((a, b) => {
    const ac = isIdeaChecked(a)
    const bc = isIdeaChecked(b)
    if (ac !== bc) return ac ? 1 : -1
    if (ac) return (b.checkedAt ?? 0) - (a.checkedAt ?? 0) || byOrder(a, b)
    return byOrder(a, b)
  })
}
