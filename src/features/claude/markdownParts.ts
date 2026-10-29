// 長い Markdown（批評の結果・戦略メモ）を、一度に全部を変換・表示しなくて済むように分ける。文字の計算だけで、
// 変換の部品（markdown-it）は使わない。
// - 頭: 閉じている時（「全文を表示」の前）に出す、最初の 3,000 字ほど。全文の表示でも最初の部分になる
// - 続き: 全文の表示で、頭の後ろを 16,000 字ほどずつに分けたもの（MarkdownView が少しずつ変換して出す）
// 切れ目は、コードブロック（``` ~~~）の外の見出しの行と、空行の次の行（行の頭が空白でないもの。リストの続きの段落は切らない）。
// 切れ目が無いまま長くなりすぎたら行の頭で、1行がとても長ければ行の途中で切る（コードブロックの中で切る時は閉じて、
// 次の部分で同じ形で開き直す）。参照形式のリンクの定義（[x]: https://…）は、どの部分からも使えるように、分けた各部分の
// 後ろに付ける（定義は表示されない）。

/** 頭の長さの目安（これを超えた最初の切れ目で切る） */
export const HEAD_CHARS = 3_000
/** 続きの1つの部分の長さの目安 */
export const SECTION_CHARS = 16_000

/** 1つの部分の最大の長さ（切れ目が見つからない時に、無理に切る長さ）。目安の2倍 */
const limitOf = (target: number) => target * 2

const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const BLANK = /^[ \t\r]*$/
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm
/** 付ける参照の定義の数の上限 */
const MAX_REF_DEFS = 200

interface Fence {
  char: string
  len: number
  /** 開いた行（次の部分で開き直す） */
  line: string
}

interface Cut {
  at: number
  /** コードブロックの中で切った（この部分を閉じ、次の部分を開き直す） */
  fence: Fence | null
}

/** 閉じる行か（同じ記号で、開いた時と同じかそれより長く、後ろは空白だけ） */
function closes(line: string, f: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line)
  return m !== null && m[1][0] === f.char && m[1].length >= f.len
}

/** サロゲートペア（絵文字など）の間で切らない位置 */
function safeAt(text: string, at: number, min: number): number {
  const c = text.charCodeAt(at)
  return c >= 0xdc00 && c <= 0xdfff && at - 1 > min ? at - 1 : at
}

/**
 * 切る位置を探す。最初の部分は first、その後ろは rest の長さを目安にする。max 個見つけたらやめる。
 */
function findCuts(text: string, first: number, rest: number, max: number): Cut[] {
  const cuts: Cut[] = []
  let start = 0
  let target = first
  let fence: Fence | null = null
  let prevBlank = false
  let pos = 0
  const cut = (at: number) => {
    cuts.push({ at, fence })
    start = at
    target = rest
  }
  while (pos < text.length && cuts.length < max) {
    let nl = text.indexOf('\n', pos)
    if (nl < 0) nl = text.length
    const line = text.slice(pos, nl)
    const blank = BLANK.test(line)
    if (pos > start) {
      const natural = !fence && pos - start >= target && (HEADING.test(line) || (prevBlank && !blank && !/^[ \t]/.test(line)))
      // この行を入れると長すぎる時は、行の頭で切る（部分がまだ短ければ、下で行の途中で切る）
      if (natural || (nl - start > limitOf(target) && pos - start >= target / 2)) cut(pos)
    }
    // 1行がとても長い時は、行の途中で切る
    while (cuts.length < max && nl - start > limitOf(target)) cut(safeAt(text, start + limitOf(target), start))
    if (fence) {
      if (closes(line, fence)) fence = null
    } else {
      const m = FENCE_OPEN.exec(line)
      // ``` の後ろに ` がある行はコードブロックではない（CommonMark）
      if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) fence = { char: m[1][0], len: m[1].length, line }
    }
    prevBlank = blank
    pos = nl + 1
  }
  return cuts
}

/** 参照形式のリンクの定義の行（重ならないように） */
function refDefsOf(text: string): string {
  if (!text.includes(']:')) return ''
  const defs = new Set<string>()
  for (const m of text.matchAll(REF_DEF)) {
    defs.add(m[0])
    if (defs.size >= MAX_REF_DEFS) break
  }
  return defs.size ? `\n\n${[...defs].join('\n')}\n` : ''
}

/** 切る位置で分ける（コードブロックの中なら閉じて開き直す。参照の定義を付ける） */
function partsAt(text: string, cuts: readonly Cut[], all: boolean): string[] {
  const defs = refDefsOf(text)
  const out: string[] = []
  let from = 0
  let reopen = ''
  for (const c of cuts) {
    let part = reopen + text.slice(from, c.at)
    if (c.fence) part += `${part.endsWith('\n') ? '' : '\n'}${c.fence.char.repeat(c.fence.len)}\n`
    out.push(part + defs)
    reopen = c.fence ? `${c.fence.line}\n` : ''
    from = c.at
  }
  if (all) out.push(reopen + text.slice(from) + defs)
  return out
}

/** 覚えておく文字数の上限まで、新しく使ったものを残す */
export class SizedCache<V> {
  private map = new Map<string, { value: V; size: number }>()
  private total = 0
  constructor(private readonly budget: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    // 使った順の後ろへ
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: string, value: V, size: number): void {
    const old = this.map.get(key)
    if (old) {
      this.total -= old.size
      this.map.delete(key)
    }
    if (size > this.budget) return
    this.map.set(key, { value, size })
    this.total += size
    for (const [k, v] of this.map) {
      if (this.total <= this.budget) break
      this.map.delete(k)
      this.total -= v.size
    }
  }
}

export interface MarkdownHead {
  /** 頭の Markdown（短い文はそのまま全体） */
  text: string
  /** 全体より短い（続きがある） */
  cut: boolean
}

const heads = new SizedCache<MarkdownHead>(4_000_000)
const sectionsCache = new SizedCache<readonly string[]>(4_000_000)

/** 閉じている時に出す頭（最初の 3,000 字ほど。見出し・段落の切れ目で切る） */
export function markdownHead(text: string): MarkdownHead {
  if (text.length <= limitOf(HEAD_CHARS)) return { text, cut: false }
  const hit = heads.get(text)
  if (hit) return hit
  const cuts = findCuts(text, HEAD_CHARS, SECTION_CHARS, 1)
  const head: MarkdownHead = cuts.length ? { text: partsAt(text, cuts, false)[0], cut: true } : { text, cut: false }
  heads.set(text, head, text.length + head.text.length)
  return head
}

/** 全文を分けたもの（最初は markdownHead と同じ頭、その後ろは 16,000 字ほどずつ）。短い文はそのまま1つ */
export function markdownSections(text: string): readonly string[] {
  if (text.length <= limitOf(HEAD_CHARS)) return [text]
  const hit = sectionsCache.get(text)
  if (hit) return hit
  const parts = partsAt(text, findCuts(text, HEAD_CHARS, SECTION_CHARS, Number.POSITIVE_INFINITY), true)
  sectionsCache.set(text, parts, text.length * 2)
  return parts
}
