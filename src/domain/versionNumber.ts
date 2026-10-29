// 推敲バージョン（稿）の番号「第n稿」。
// - 番号は保存せず、稿の名前の先頭の「第n稿」から読む（n は半角・全角の数字か漢数字。前の空白は除く。
//   後ろに「（第2稿を複製）」「（分割）」などが付いていてもよい）。名前を「改稿版」のように書き換えた稿は番号なしとして数えない
// - 新しく作る稿の番号は、その話・幕に今ある稿（採用・不採用を問わない。ゴミ箱の稿・完全に削除した稿は数えない）の
//   いちばん大きい番号＋1（無ければ1）。間の欠けた番号は埋めない（第1・3・5・6稿なら次は第7稿）
// - 2台の端末で同時に稿を作ると、同じ番号の稿が2つできることがある（どちらも第4稿など）。名前は書き換えられるので、そのままにする
// - Piece.versionSeq は古い版のアプリ・同期のために残すが、名前には使わない（稿を作る時に、作った番号・稿の数まで進めるだけ）
import type { AppData, ID, Piece, Version } from './types'

/** 名前の先頭の「第n稿」（前の空白は除く）。1 = 「第n稿」、2 = n */
const NUMBERED_PREFIX = /^\s*(第([0-9０-９]+|[〇零一二三四五六七八九十百千]+)稿)/

const KANJI_DIGITS = new Map<string, number>([
  ['〇', 0],
  ['零', 0],
  ['一', 1],
  ['二', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
])

const KANJI_UNITS = new Map<string, number>([
  ['十', 10],
  ['百', 100],
  ['千', 1000],
])

/** 半角・全角の数字（「12」「１２」） */
function digitsNumber(s: string): number {
  let n = 0
  for (const c of s) {
    const code = c.charCodeAt(0)
    n = n * 10 + (code >= 0xff10 ? code - 0xff10 : code - 0x30)
  }
  return n
}

/**
 * 漢数字。十・百・千を使う書き方（「二十一」= 21、「百〇一」= 101。〇・零は読み飛ばす）と、
 * 位取りの書き方（「一〇」= 10、「二〇二」= 202）を読む。「十百」「二三十」のような読めない並びは null
 */
function kanjiNumber(s: string): number | null {
  const chars = Array.from(s)
  if (!chars.some((c) => KANJI_UNITS.has(c))) {
    let n = 0
    for (const c of chars) n = n * 10 + (KANJI_DIGITS.get(c) ?? 0)
    return n
  }
  let total = 0
  let digit: number | null = null
  let lastUnit = Infinity
  for (const c of chars) {
    const unit = KANJI_UNITS.get(c)
    if (unit !== undefined) {
      // 位は大きい順に1回ずつ（「千百十」はよいが「十百」「十十」は読まない）
      if (unit >= lastUnit) return null
      total += (digit ?? 1) * unit
      digit = null
      lastUnit = unit
      continue
    }
    const d = KANJI_DIGITS.get(c) ?? 0
    if (d === 0) continue
    if (digit !== null) return null
    digit = d
  }
  return total + (digit ?? 0)
}

/** 名前の先頭の「第n稿」の部分（「第3稿（第2稿を複製）」なら「第3稿」）。無ければ null */
export function numberedPrefix(name: string): string | null {
  return NUMBERED_PREFIX.exec(name)?.[1] ?? null
}

/**
 * 稿の名前から読んだ番号（「第3稿（第2稿を複製）」「第３稿」「第三稿」「 第3稿」→ 3）。
 * 先頭が「第n稿」でない名前（「改稿版」「第2幕の第1稿」）は null
 */
export function versionNumber(name: string): number | null {
  const m = NUMBERED_PREFIX.exec(name)
  if (!m) return null
  const raw = m[2]
  const n = /^[0-9０-９]+$/.test(raw) ? digitsNumber(raw) : kanjiNumber(raw)
  return n !== null && Number.isSafeInteger(n) ? n : null
}

/** 話・幕に今ある稿（versionIds の順。載っていない稿（同期の途中・壊れたデータ）も後ろに付ける。ゴミ箱の稿は入らない） */
export function pieceVersions(data: AppData, piece: Piece): Version[] {
  const listed = piece.versionIds.map((id) => data.versions[id]).filter((v): v is Version => Boolean(v))
  const extra = Object.values(data.versions).filter((v) => v.pieceId === piece.id && !piece.versionIds.includes(v.id))
  return [...listed, ...extra]
}

/** 次に作る稿の番号: 話・幕に今ある稿（採用・不採用を問わない）のいちばん大きい番号＋1。番号のある稿が無ければ1 */
export function nextVersionNumber(data: AppData, piece: Piece): number {
  let max = 0
  for (const v of pieceVersions(data, piece)) {
    const n = versionNumber(v.name)
    if (n !== null && n > max) max = n
  }
  return max + 1
}

/** 次に作る稿の名前（「第4稿」、suffix を付けて「第4稿（つないだ稿）」）。確認文に出す名前と作る稿の名前を揃えるのに使う */
export function nextVersionName(data: AppData, piece: Piece, suffix = ''): string {
  return `第${nextVersionNumber(data, piece)}稿${suffix}`
}

/**
 * 番号 n の稿を作って稿の並びが versionIds になった後の versionSeq。古い版のアプリは versionSeq + 1 で名前を付けるので、
 * 作った番号より小さくしない。今までどおり稿の数より小さくもしない（修復 repair.ts・同期が揃えている形）。戻すことはしない
 */
export function advancedVersionSeq(piece: Piece, n: number, versionIds: readonly ID[]): number {
  return Math.max(Number.isFinite(piece.versionSeq) ? piece.versionSeq : 1, n, versionIds.length)
}

/** ゴミ箱から戻した稿と同じ名前の稿が戻す先にあった時に付ける（2つ目からは「（復元2）」「（復元3）」…） */
export const RESTORED_NAME_SUFFIX = '（復元）'

const RESTORED_TAIL = /（復元\d*）$/

/**
 * ゴミ箱から戻す稿の名前。戻す先の話・幕の稿に同じ名前（taken）があれば「（復元）」、それもあれば「（復元2）」…を付ける
 * （「第2稿（復元）」を戻す時に重なれば「第2稿（復元2）」）。重ならなければ名前を変えない。
 * 先頭の「第n稿」は残るので、番号はそのまま数えられる
 */
export function restoredVersionName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const trimmed = name.trim() || '無題の稿'
  const stem = trimmed.replace(RESTORED_TAIL, '')
  for (let i = 1; ; i++) {
    const candidate = `${stem}（復元${i === 1 ? '' : i}）`
    if (!taken.has(candidate)) return candidate
  }
}
