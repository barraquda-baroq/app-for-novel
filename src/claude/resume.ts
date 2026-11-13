// 続きの cursor で、前回の続きの区切り（話・幕・稿、相対比較の分析、資料の記録）を id で探し直す（2.9）。前回の答えの後に、
// アプリやほかの接続（claude.ai のアカウント）が区切りを足した・消した・並べ替えても、黙って同じ所をもう一度出したり、
// 読んでいない所を飛ばしたりしないため。
// - cursor には、続きの区切りの id と、それより前の区切り（もう読んだもの）の id の集まりの指紋（数と、id ごとの値の和。並びは問わない）を入れる
//   （読んだ区切りの id をすべて入れると cursor が長くなりすぎるため）
// - 続きの時は、その区切りを id で探し、その前の区切りの集まりが前回と同じなら黙って続ける（読んだ区切り同士・まだの区切り同士の並べ替えは問わない）
// - 違えば、どう変わったかを分かる範囲で返す（1つ入った・読んだ1つが後ろへ動いた・それ以外）。知らせる文は使う側で作る
// ホームの棚からも読むので、重い部品を読み込まない

export interface Keyed {
  key: string
}

/** id ごとの値（FNV-1a 32bit） */
function keyHash(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** 先頭から n 個ずつの区切りの、id の数と値の和（n = 0〜items.length） */
function prefixSums(items: readonly Keyed[]): number[] {
  const sums = [0]
  for (const x of items) sums.push((sums[sums.length - 1] + keyHash(x.key)) >>> 0)
  return sums
}

const print = (count: number, sum: number) => `${count}.${sum.toString(36)}`

/** 先頭の n 個の区切り（もう読んだもの）の指紋（「数.和」。cursor に入れる） */
export function prefixPrint(items: readonly Keyed[], n: number): string {
  let sum = 0
  for (let i = 0; i < n && i < items.length; i++) sum = (sum + keyHash(items[i].key)) >>> 0
  return print(Math.min(n, items.length), sum)
}

/** cursor の指紋を読む（読めなければ null） */
function parsePrint(v: unknown): { count: number; sum: number } | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,6})\.([0-9a-z]{1,7})$/.exec(v)
  if (!m) return null
  const sum = parseInt(m[2], 36)
  return sum <= 0xffffffff ? { count: Number(m[1]), sum } : null
}

/** key の区切りの位置（同じ key がいくつかあれば near に近いもの。無ければ -1） */
export function findNear(items: readonly Keyed[], key: string, near: number): number {
  if (items[near]?.key === key) return near
  let best = -1
  items.forEach((x, i) => {
    if (x.key === key && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i
  })
  return best
}

export type Relocation =
  /** 前の区切りの集まりが前回と同じ（黙って続ける）。index は続ける区切り */
  | { kind: 'same'; index: number }
  /** 前回の続きより前に、区切り item が1つ入った（まだ読んでいない） */
  | { kind: 'added'; index: number; item: number }
  /** 前に読んだ区切り item が1つ、前回の続きより後ろへ動いた（この後にもう一度出る） */
  | { kind: 'again'; index: number; item: number }
  /** それ以外（前の区切りが増えた・減った・動いた） */
  | { kind: 'changed'; index: number }
  /** 前回の続きの区切りが無い。index は続ける区切り（same: その前の区切りの集まりは前回と同じ） */
  | { kind: 'gone'; index: number; same: boolean }

/**
 * 前回の続きの区切りを探し直す。found はその区切りのいまの位置（無ければ -1）、print は cursor の指紋、atStart は前回の続きが
 * 区切りの始めか（途中まで読んだ区切りなら false）。指紋が読めなければ null
 */
export function relocate(items: readonly Keyed[], found: number, printed: unknown, atStart: boolean): Relocation | null {
  const old = parsePrint(printed)
  if (!old) return null
  const sums = prefixSums(items)
  // 先頭の n 個が、前回読んだ区切りとちょうど同じ集まりか（数が n の時だけ）
  const sameAt = (n: number) => n === old.count && n <= items.length && sums[n] === old.sum
  if (found < 0) {
    const same = sameAt(old.count)
    return { kind: 'gone', index: Math.min(old.count, items.length), same }
  }
  if (sameAt(found)) return { kind: 'same', index: found }
  // 区切りの始めからなら、読んだ区切りのすぐ後から（その間に、まだ読んでいない区切りが前へ動いて入った時）
  if (atStart && sameAt(old.count)) return { kind: 'same', index: old.count }
  if (found === old.count + 1) {
    const d = (sums[found] - old.sum) >>> 0
    const item = items.findIndex((x, i) => i < found && keyHash(x.key) === d)
    if (item >= 0) return { kind: 'added', index: found, item }
  }
  if (found === old.count - 1) {
    const d = (old.sum - sums[found]) >>> 0
    const item = items.findIndex((x, i) => i > found && keyHash(x.key) === d)
    if (item >= 0) return { kind: 'again', index: found, item }
  }
  return { kind: 'changed', index: found }
}

// ---------- つないだ文の中の区切り（相対比較の分析・資料の記録を全部読む時） ----------

/** つないだ文の中の1つの区切り（key は分析・記録の id。頭の見出し・書誌・タグの行は key '' の区切り） */
export interface TextBlock extends Keyed {
  /** この区切りの始めから読み直す時の位置（まとまりの最初の区切りなら、まとまりの見出しの行の始め） */
  from: number
  /** 区切りの文（「#### 」の行から）の始め */
  start: number
  /** 区切りの文 */
  text: string
}

/**
 * 頭（見出し・書誌・タグの行）と、まとまり（観点・項目）ごとの見出しの行・区切りの文を改行でつなぐ。区切りごとの位置も返す
 */
export function joinBlocks(
  head: string,
  groups: readonly { title: string; items: readonly { key: string; text: string }[] }[],
): { text: string; blocks: TextBlock[] } {
  const parts = [head]
  const blocks: TextBlock[] = [{ key: '', from: 0, start: 0, text: head }]
  let at = head.length + 1
  for (const g of groups) {
    const groupAt = at
    parts.push(g.title)
    at += g.title.length + 1
    g.items.forEach((it, i) => {
      blocks.push({ key: it.key, from: i === 0 ? groupAt : at, start: at, text: it.text })
      parts.push(it.text)
      at += it.text.length + 1
    })
  }
  return { text: parts.join('\n'), blocks }
}

/** 位置 o を含む区切りの番号（o より前で始まる最後の区切り） */
export function blockAt(blocks: readonly TextBlock[], o: number): number {
  let i = 0
  while (i + 1 < blocks.length && blocks[i + 1].from <= o) i += 1
  return i
}
