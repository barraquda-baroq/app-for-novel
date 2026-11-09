// 相対比較の作品の自動のタグ（2.7）: 02 が登録した「14 検索用タグ」の「判定したジャンル」と「ジャンル／サブジャンル」の行を、
// 作品のタグにする。アプリ（BenchAutoTags が同期の後に applyAutoGenreTags を当てる）とコネクタ（読む時に benchWorkTagsWithAuto で
// まだ付けていないタグも見せる）で同じ関数を使う。
// - 使うのは作品の最新の 14（分析の並びで最初のもの。novel_get_bench_analysis で最初に返るもの）
// - どの 14 まで取り込んだかを作品の autoTagsFrom に残し、それより新しい 14 が来た時（無ければ一度だけ）、今のタグの後ろに足す。
//   前のタグは消さないので、作者が外したタグは、新しい 14 が来るまで付き直さない
// - 14 が読めない（2行が無い・空）時は何もしない（autoTagsFrom も進めない。作者が本文を直せば付く）
// - 【対照】【監査】【横断】の作品には付けない。【原稿】は回ごとに別の作品なので、回ごとの 14 から付く
// - ゴミ箱へ移す依頼（2.7）の出ている 14 は読まない（コネクタの見せる内容からも外れているので、Claude に見えるタグと同じにする）
// 読み込むのは benchOps・tags・claude/benchOrder・claude/parts・claude/refs・claude/trashTargets だけ（同期の merge.ts からは読まない）。
import { sortBenchAnalyses } from '../claude/benchOrder'
import { newestFirst } from '../claude/parts'
import { refKey } from '../claude/refs'
import { pendingTrashTargets, trashTargetKey } from '../claude/trashTargets'
import { isTaglessWork } from './benchOps'
import { displayTags, TAG_LIMITS, tagKey } from './tags'
import { transact } from './tx'
import type { AppData, AutoTagMark, BenchAnalysis, BenchWork, ID } from './types'
import { now } from './util'

/** 自動のタグを読む観点（02 が登録する） */
export const GENRE_TAG_VIEWPOINT = '14 検索用タグ'

const GENRE_KEY = refKey(GENRE_TAG_VIEWPOINT)

/** 「14 検索用タグ」の分析か（観点名の全角と半角・空白の違いは問わない） */
export const isGenreAnalysis = (a: Pick<BenchAnalysis, 'viewpoint'>): boolean =>
  refKey(typeof a.viewpoint === 'string' ? a.viewpoint : '') === GENRE_KEY

/** 作品の最新の「14 検索用タグ」（analyses はその作品の分析。並びは novel_get_bench_analysis と同じ。無ければ undefined） */
export function latestGenreAnalysis(analyses: readonly BenchAnalysis[]): BenchAnalysis | undefined {
  return sortBenchAnalyses(analyses.filter(isGenreAnalysis))[0]
}

// ---------- 本文の読み方 ----------

/**
 * 行の頭（空白・箇条書きの印「-」「*」「+」「・」・太字の「**」）、ラベル（「判定したジャンル」「ジャンル／サブジャンル」。
 * 後ろの（…）の注記も可）、太字の閉じと「：」「:」、値
 */
const LINE = new RegExp(
  String.raw`^[\s　]*(?:[-*+・][\s　]*)?(?:\*\*)?[\s　]*(判定したジャンル|ジャンル[\s　]*[／/][\s　]*サブジャンル)[\s　]*(?:[（(][^（）()\n]*[）)])?[\s　]*(?:\*\*)?[\s　]*[：:][\s　]*(.*)$`,
)

/** サブジャンルの区切り（「／」「/」「・」「、」「,」「，」） */
const SEPARATORS = new Set(['／', '/', '・', '、', ',', '，'])
const OPEN = new Set(['（', '(', '「', '『', '【', '［', '['])
const CLOSE = new Set(['）', ')', '」', '』', '】', '］', ']'])

/** タグにしない語 */
const NONE_WORDS = new Set(
  ['なし', '無し', '特になし', '特に無し', '不明', '該当なし', '該当無し', '—', '-', '―', '－', '－－', '?', '？'].map(refKey),
)

/** 値の前後の太字・コード・空白と、末尾の「。」を除く */
function cleanValue(v: string): string {
  let s = v.trim()
  for (;;) {
    const next = s
      .replace(/^(?:\*\*|`)+/, '')
      .replace(/(?:\*\*|`)+$/, '')
      .replace(/[。．.]+$/, '')
      .trim()
    if (next === s) return s
    s = next
  }
}

/** かっこの外の区切りで分ける（「本格（館・孤島）」をかっこの中で分けないように） */
function splitOutside(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of value) {
    if (OPEN.has(c)) depth++
    else if (CLOSE.has(c) && depth > 0) depth--
    if (depth === 0 && SEPARATORS.has(c)) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/**
 * 1つの語をタグの名前にする（末尾の（…）の注記を外し、「サブジャンル：本格」のようなラベルは「：」の後ろだけ）。
 * 空・「なし」「不明」など・20字を超える語は null（切り詰めない）
 */
function wordTag(raw: string): string | null {
  let w = cleanValue(raw)
  for (;;) {
    const next = w.replace(/[（(][^（）()]*[）)]$/, '').trim()
    if (next === w) break
    w = next
  }
  const colon = Math.max(w.lastIndexOf('：'), w.lastIndexOf(':'))
  if (colon >= 0) w = w.slice(colon + 1)
  w = cleanValue(w)
  const key = tagKey(w)
  if (!key || NONE_WORDS.has(key) || Array.from(w).length > TAG_LIMITS.tag) return null
  return w
}

/** value が genre で始まり、その後が区切りか終わりなら、その後ろ（区切りの後）。そうでなければ null */
function afterGenre(value: string, genre: string): string | null {
  const want = tagKey(genre)
  if (!want) return null
  const chars = Array.from(value)
  for (let i = 1; i <= chars.length; i++) {
    const head = chars.slice(0, i).join('')
    if (tagKey(head) !== want) continue
    const rest = chars.slice(i)
    if (!rest.length) return ''
    const first = rest.findIndex((c) => c.trim() !== '')
    if (first < 0) return ''
    if (SEPARATORS.has(rest[first])) return rest.slice(first + 1).join('')
  }
  return null
}

/**
 * 「14 検索用タグ」の本文から、自動のタグにする語（判定したジャンル → サブジャンルの順。重なりは1つ）。
 * - 「- 判定したジャンル：恋愛」は値をまるごと1つのタグにする（「時代・歴史」を分けない）
 * - 「- ジャンル／サブジャンル：恋愛／青春・喪失、家族」は、先頭が判定したジャンルならそれを外し、残りを「／」「・」「、」
 *   （と「/」「,」「，」）で区切る。判定したジャンルの行が無い（V21 以前の 14）・先頭が違う時は、値全体を区切る
 * - どちらも最初の1行だけを使う。行の頭の「-」「*」・太字、半角の「/」「:」も読む
 */
export function genreTagsOf(body: string): string[] {
  let genreLine: string | undefined
  let subLine: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (!m) continue
    if (m[1] === '判定したジャンル') genreLine ??= m[2]
    else subLine ??= m[2]
    if (genreLine !== undefined && subLine !== undefined) break
  }
  const words: string[] = []
  const genre = genreLine === undefined ? null : wordTag(genreLine)
  if (genre) words.push(genre)
  if (subLine !== undefined) {
    const value = cleanValue(subLine)
    const rest = genre ? afterGenre(value, genre) : null
    for (const part of splitOutside(rest ?? value)) {
      const tag = wordTag(part)
      if (tag) words.push(tag)
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    const key = tagKey(w)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

// ---------- 取り込み ----------

/** 取り込んだ 14 の印として読める形か */
export function isAutoTagMark(v: unknown): v is AutoTagMark {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    typeof m.analysisId === 'string' &&
    typeof m.runDate === 'string' &&
    typeof m.createdAt === 'number' &&
    Number.isFinite(m.createdAt)
  )
}

/** 分析の印（id・日付・作った時刻） */
export const markOf = (a: Pick<BenchAnalysis, 'id' | 'runDate' | 'createdAt'>): AutoTagMark => ({
  analysisId: a.id,
  runDate: a.runDate,
  createdAt: a.createdAt,
})

/** 分析 a が、取り込んだ 14 の印 mark より新しいか（分析の並び: 日付 → 作った時刻 → id。同じ分析なら新しくない） */
export function isNewerMark(a: Pick<BenchAnalysis, 'id' | 'runDate' | 'createdAt'>, mark: AutoTagMark): boolean {
  if (a.id === mark.analysisId) return false
  return newestFirst(a, { id: mark.analysisId, runDate: mark.runDate, createdAt: mark.createdAt }) < 0
}

export interface PendingAutoTags {
  /** 付けた後のタグ（今のタグの後ろに、まだ無い語を20個になるまで足したもの。今と同じこともある） */
  tags: string[]
  /** 取り込む 14 の印 */
  mark: AutoTagMark
}

/**
 * まだ取り込んでいない自動のタグ（analyses はその作品の分析）。取り込むものが無ければ null:
 * タグを付けない作品・14 が無い・取り込んだ 14 より新しい 14 が無い・14 が読めない
 */
export function pendingAutoTags(
  work: Pick<BenchWork, 'name' | 'tags' | 'autoTagsFrom'>,
  analyses: readonly BenchAnalysis[],
): PendingAutoTags | null {
  if (isTaglessWork(work)) return null
  const latest = latestGenreAnalysis(analyses)
  if (!latest) return null
  if (isAutoTagMark(work.autoTagsFrom) && !isNewerMark(latest, work.autoTagsFrom)) return null
  const words = genreTagsOf(typeof latest.body === 'string' ? latest.body : '')
  if (!words.length) return null
  const tags = displayTags(work.tags) ?? []
  const have = new Set(tags.map(tagKey))
  for (const w of words) {
    if (tags.length >= TAG_LIMITS.tags) break
    const key = tagKey(w)
    if (have.has(key)) continue
    have.add(key)
    tags.push(w)
  }
  return { tags, mark: markOf(latest) }
}

/** 分析を作品ごとにまとめたもの（同じ表の参照なら作り直さない） */
const byWorkCache = new WeakMap<object, Map<ID, BenchAnalysis[]>>()

/** 作品ごとの分析（並びは決めない） */
export function analysesByWorkId(benchAnalyses: AppData['benchAnalyses']): ReadonlyMap<ID, readonly BenchAnalysis[]> {
  const cached = byWorkCache.get(benchAnalyses)
  if (cached) return cached
  const out = new Map<ID, BenchAnalysis[]>()
  for (const a of Object.values(benchAnalyses)) {
    const list = out.get(a.workId)
    if (list) list.push(a)
    else out.set(a.workId, [a])
  }
  byWorkCache.set(benchAnalyses, out)
  return out
}

const NONE: readonly BenchAnalysis[] = []

/**
 * まだ取り込んでいない自動のタグを、すべての作品に付ける（付けた作品は autoTagsFrom を進め、updatedAt も進める）。
 * 付ける作品が無ければ data をそのまま返す（保存も同期も起こさない）
 */
/** ゴミ箱へ移す依頼の出ている分析を除く（依頼が無ければ同じ並び） */
function withoutPendingTrash(
  data: Partial<Pick<AppData, 'trashRequests'>>,
  list: readonly BenchAnalysis[],
): readonly BenchAnalysis[] {
  if (!data.trashRequests) return list
  const pending = pendingTrashTargets({ trashRequests: data.trashRequests })
  if (!pending.size) return list
  return list.filter((a) => !pending.has(trashTargetKey('benchAnalyses', a.id)))
}

export function applyAutoGenreTags(data: AppData): AppData {
  const byWork = analysesByWorkId(data.benchAnalyses)
  const updates: { work: BenchWork; pending: PendingAutoTags }[] = []
  for (const work of Object.values(data.benchWorks)) {
    const list = byWork.get(work.id)
    if (!list) continue
    const pending = pendingAutoTags(work, withoutPendingTrash(data, list))
    if (pending) updates.push({ work, pending })
  }
  if (!updates.length) return data
  return transact(data, (tx) => {
    const ts = now()
    for (const { work, pending } of updates) {
      const next: BenchWork = { ...work, tags: pending.tags, autoTagsFrom: pending.mark, updatedAt: ts }
      if (!pending.tags.length) delete next.tags
      tx.put('benchWorks', next)
    }
  }).data
}

/** 作品のタグ（アプリがまだ付けていない自動のタグも含める。コネクタの一覧・絞り込み・手動連携の依頼文で見せる形） */
export function benchWorkTagsWithAuto(
  data: Pick<AppData, 'benchAnalyses'> & Partial<Pick<AppData, 'trashRequests'>>,
  work: BenchWork,
): string[] {
  const list = withoutPendingTrash(data, analysesByWorkId(data.benchAnalyses).get(work.id) ?? NONE)
  return pendingAutoTags(work, list)?.tags ?? displayTags(work.tags) ?? []
}
