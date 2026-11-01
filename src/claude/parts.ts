// 新しい日付から並べる時の、分けて記録したもの（「（1/3）」「（2/3）」…）のまとめ方。
// 戦略メモ・作品批評の結果（order.ts）とベンチ作品の分析（benchOrder.ts）で同じものを使う。
import type { ID } from '../domain/types'

const byId = (a: { id: ID }, b: { id: ID }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export type Dated = { runDate: string; createdAt: number; id: ID }

export const newestFirst = <T extends Dated>(a: T, b: T) =>
  (a.runDate < b.runDate ? 1 : a.runDate > b.runDate ? -1 : 0) || b.createdAt - a.createdAt || byId(a, b)

// ---------- 分けて記録したもの（「（1/3）」「（2/3）」…） ----------

/** 分けた部分の番号（「（2/3）」「(2/3)」「（前半 1/2）」など。番号の後ろは閉じかっこだけ。「（3/5点）」は番号ではない） */
const MARK = String.raw`[（(][^（）()\n]{0,6}?(\d{1,3})\s*[/／]\s*(\d{1,3})\s*[）)]`

/**
 * 行の先頭の番号。前に置いてよいのは、Markdown の「#」「>」と空白、その後ろに見出し語とコロン1つ
 * （「**結論**：」「**結論：**」「結論：」）だけ。番号を太字にしたもの（「**（1/2）**」）も読む
 */
const HEAD_MARK = new RegExp(
  String.raw`^[#>\s]*(?:(?:\*\*[^*\n：:]{1,20}\*\*\s*[：:]|\*\*[^*\n：:]{1,20}[：:]\*\*|[^\s*#>（）()：:]{1,20}[：:])\s*)?\*{0,2}${MARK}`,
)

/** 行の末尾の番号（見出し・名前の「応募戦略（1/2）」。太字の閉じ「**」と空白は後ろにあってよい） */
const TAIL_MARK = new RegExp(String.raw`${MARK}\*{0,2}\s*$`)

export interface PartMark {
  /** 何番目か（1から） */
  index: number
  /** いくつに分けたか（2以上） */
  count: number
}

/**
 * どこの番号を読むか。
 * - body: 本文（相対比較の分析・批評の結果・戦略メモの本文）。1行目の先頭だけ（「**結論**：12項目中（7/12）が…」や
 *   日付の「（3/5）」を、行の途中にあるだけで番号と読まないように）
 * - heading: 見出し・名前（戦略メモの見出しなど）。先頭か末尾（「応募戦略（1/2）」のように末尾に付けることが多い）
 */
export type PartMarkPlace = 'body' | 'heading'

/** 文の最初の行（空行は飛ばす。最初の200字。末尾は200字までの行だけ）にある、分けた部分の番号。無ければ null */
export function partMarkOf(text: string, place: PartMarkPlace): PartMark | null {
  const start = text.search(/\S/)
  if (start < 0) return null
  const nl = text.indexOf('\n', start)
  const end = nl < 0 ? text.length : nl
  const cut = end - start > 200
  const line = text
    .slice(start, cut ? start + 200 : end)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  const m = HEAD_MARK.exec(line) ?? (place === 'heading' && !cut ? TAIL_MARK.exec(line) : null)
  if (!m) return null
  const index = Number(m[1])
  const count = Number(m[2])
  return count >= 2 && index >= 1 && index <= count ? { index, count } : null
}

/** 分けた部分の番号と、同じまとまりと見なす手がかり（同じ日・同じ分け方の数など） */
export type PartOf<T> = (x: T) => { key: string; mark: PartMark } | null

/**
 * 新しい順（newestFirst）に並べる。分けて記録した部分（同じ key の「（1/k）」〜「（k/k）」）は、まとめていちばん新しい部分の
 * 位置に番号の順に置く（Claude は1つ目から順に送るので、新しい順のままだと最後の部分が上に来て、終わりから読むことになる）。
 * まとまりは作った順に見て、同じ番号がもう一度出たら（同じ日にもう一度分けて記録した）新しいまとまりにする
 */
export function newestFirstWithParts<T extends Dated>(list: readonly T[], partOf: PartOf<T>): T[] {
  const sorted = [...list].sort(newestFirst)
  const marks = new Map<ID, { key: string; mark: PartMark }>()
  for (const x of sorted) {
    const p = partOf(x)
    if (p) marks.set(x.id, p)
  }
  if (marks.size < 2) return sorted
  const groupOf = new Map<ID, T[]>()
  const open = new Map<string, { items: T[]; seen: Set<number> }>()
  for (let i = sorted.length - 1; i >= 0; i--) {
    const x = sorted[i]
    const p = marks.get(x.id)
    if (!p) continue
    let g = open.get(p.key)
    if (!g || g.seen.has(p.mark.index) || g.items.length >= p.mark.count) {
      g = { items: [], seen: new Set() }
      open.set(p.key, g)
    }
    g.items.push(x)
    g.seen.add(p.mark.index)
    groupOf.set(x.id, g.items)
  }
  const out: T[] = []
  const placed = new Set<T[]>()
  for (const x of sorted) {
    const g = groupOf.get(x.id)
    if (!g || g.length < 2) out.push(x)
    else if (!placed.has(g)) {
      placed.add(g)
      const index = (y: T) => marks.get(y.id)!.mark.index
      out.push(...[...g].sort((a, b) => index(a) - index(b) || a.createdAt - b.createdAt || byId(a, b)))
    }
  }
  return out
}
