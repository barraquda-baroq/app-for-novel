// 相対比較（内部名は bench。ホームの棚・作品の画面）で使う、表示用の純粋な計算。データは変更しない。
// 棚の作品が多くても重くならないように、作品ごとの分析の並びは、中身が変わらない限り同じ配列を使い続ける
// （カードは React.memo でレコード単位の props にしている）。
import { benchAnalysesOf, benchViewpointGroups } from '../../claude/benchOrder'
import { refKey } from '../../claude/refs'
import { benchWorkName } from '../../domain/benchOps'
import { trashNotice } from '../../domain/trash'
import type { AppData, BenchAnalysis, BenchWork, ID } from '../../domain/types'
import { sourceLabel } from '../claude/claudeUi'

/** 作品の書誌の1行（「山田・星の出版・2019・SF」。無い項目は飛ばす） */
export function biblioLine(w: Pick<BenchWork, 'author' | 'publisher' | 'year' | 'genre'>): string {
  return [w.author, w.publisher, w.year, w.genre]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .join('・')
}

/**
 * 作品を作ったものの札（「Claude が作成」）。アプリのほかの表記（「Claude に頼む」など）と同じく英字のあとには空白を入れ、
 * 全角の括弧のあとは詰める（「Claude（貼り付け）が作成」）。手で足した作品は null
 */
export function createdByLabel(source: BenchWork['source']): string | null {
  const by = sourceLabel(source)
  if (!by) return null
  return `${by}${/[\x21-\x7e]$/.test(by) ? ' ' : ''}が作成`
}

/** 作品の最終更新（作品とその分析のいちばん新しい更新日時） */
export function workLastUpdated(
  work: Pick<BenchWork, 'updatedAt'>,
  analyses: readonly Pick<BenchAnalysis, 'updatedAt'>[],
): number {
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

/** 作品の削除の確認文（分析の数と、相対比較する作品にしているタイトルでは、ゴミ箱にある間は出ないことを書く） */
export function deleteWorkMessage(analyses: number, comparing: number): string {
  const lines = [trashNotice(`この作品を相対比較から削除し、${analyses > 0 ? `分析（${analyses}件）もいっしょに` : ''}`)]
  if (comparing > 0)
    lines.push(
      `相対比較する作品にしているタイトル（${comparing}件）では、ゴミ箱にある間は相対比較する作品に出ません（ゴミ箱から戻すと、また出ます）。`,
    )
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

// ---------- 自分の原稿の分析（【原稿】…（第n稿…）） ----------
// 自分の原稿は何回も分析するので、1回の分析を1つの作品にして（データの形は変えない）、作品名
// 「【原稿】原稿名（第2稿・2回目）」の原稿名ごとにまとめて、新しい回から並べる。

/** 原稿の分析の作品名の頭 */
const MANUSCRIPT_PREFIX = '【原稿】'
/** 回の札の頭（「第2稿」「第２稿」「第二稿」。後ろに「・2回目」などが続いてよい） */
const RUN_LABEL = /^第\s*(?:[0-9０-９]+|[〇零一二三四五六七八九十百千]+)\s*稿/
const OPEN = new Set(['（', '('])
const CLOSE = new Set(['）', ')'])

export interface ManuscriptRunName {
  /** 原稿名（「【原稿】」と回の札を除いたもの。書いたとおり） */
  base: string
  /** 回の札（最後の括弧の中。「第2稿・2回目」） */
  run: string
}

/**
 * 作品名を原稿名と回の札に分ける。「【原稿】」で始まり、最後が「（第…稿…）」の括弧で終わる名前だけ（ほかは null）。
 * 原稿名に括弧があってもよい（回の札は最後の括弧だけ。括弧の中の括弧もそのまま札に入れる）
 */
export function manuscriptRunOf(name: string): ManuscriptRunName | null {
  const s = benchWorkName({ name }).normalize('NFC')
  if (!s.startsWith(MANUSCRIPT_PREFIX)) return null
  const chars = Array.from(s)
  if (!CLOSE.has(chars[chars.length - 1])) return null
  // 最後の閉じ括弧と対になる開き括弧
  let depth = 0
  let open = -1
  for (let i = chars.length - 1; i >= 0; i--) {
    if (CLOSE.has(chars[i])) depth++
    else if (OPEN.has(chars[i]) && --depth === 0) {
      open = i
      break
    }
  }
  if (open < 0) return null
  const run = chars
    .slice(open + 1, -1)
    .join('')
    .trim()
  const base = chars.slice(Array.from(MANUSCRIPT_PREFIX).length, open).join('').trim()
  return base && RUN_LABEL.test(run) ? { base, run } : null
}

/** 同じ原稿とみなす形（全角と半角・全角の空白・続く空白・前後の空白の違いを問わない。コネクタが作品名で探す時と同じ） */
export const manuscriptKey = (base: string): string => refKey(base)

export interface ManuscriptRun {
  work: BenchWork
  /** 回の札（「第2稿・2回目」） */
  run: string
}

export interface Manuscript {
  key: string
  /** 原稿名（いちばん新しい回の書き方） */
  base: string
  /** 新しい回から（作った時刻の新しい順。同じなら id の順） */
  runs: ManuscriptRun[]
}

const newestRunFirst = (a: ManuscriptRun, b: ManuscriptRun) =>
  b.work.createdAt - a.work.createdAt || (a.work.id < b.work.id ? -1 : a.work.id > b.work.id ? 1 : 0)

/** 原稿ごとの分析（key → 原稿）。【原稿】の作品名でない作品は入らない。1回だけの原稿も入る */
export function manuscriptsOf(works: Iterable<BenchWork>): Map<string, Manuscript> {
  const out = new Map<string, Manuscript>()
  const bases = new Map<ID, string>()
  for (const work of works) {
    const parsed = manuscriptRunOf(work.name)
    if (!parsed) continue
    bases.set(work.id, parsed.base)
    const key = manuscriptKey(parsed.base)
    const run = { work, run: parsed.run }
    const m = out.get(key)
    if (m) m.runs.push(run)
    else out.set(key, { key, base: parsed.base, runs: [run] })
  }
  for (const m of out.values()) {
    m.runs.sort(newestRunFirst)
    m.base = bases.get(m.runs[0].work.id)!
  }
  return out
}

/** 作品と同じ原稿の分析（作品も含めて新しい回から）。【原稿】の作品でない・ほかに回が無ければ null */
export function sameManuscriptOf(data: Pick<AppData, 'benchWorks'>, workId: ID): Manuscript | null {
  const work = data.benchWorks[workId]
  const parsed = work ? manuscriptRunOf(work.name) : null
  if (!parsed) return null
  const m = manuscriptsOf(Object.values(data.benchWorks)).get(manuscriptKey(parsed.base))
  return m && m.runs.length > 1 ? m : null
}

/** 棚に並べる1枚（作品のカードか、2回以上分析した原稿をまとめたカード） */
export type ShelfEntry =
  | { kind: 'work'; work: BenchWork }
  | { kind: 'manuscript'; key: string; base: string; runs: readonly ShelfRun[] }

export interface ShelfRun extends ManuscriptRun {
  analyses: readonly BenchAnalysis[]
}

/** 分析の無い作品の分析（いつも同じ配列） */
export const NO_ANALYSES: readonly BenchAnalysis[] = []

/**
 * 棚の並び（works は棚の順）。2回以上分析した原稿は1枚にまとめ、その原稿の作品のうち棚でいちばん前の作品の位置に置く。
 * 前に作った並び prev と中身（作品・分析の配列）が同じ原稿は、前の回の配列をそのまま使う（カードの React.memo が効くように）
 */
export function benchShelfEntries(
  works: readonly BenchWork[],
  analyses: ReadonlyMap<ID, readonly BenchAnalysis[]>,
  prev: readonly ShelfEntry[] = [],
): ShelfEntry[] {
  const manuscripts = manuscriptsOf(works)
  const keyOf = new Map<ID, string>()
  for (const m of manuscripts.values()) if (m.runs.length > 1) for (const r of m.runs) keyOf.set(r.work.id, m.key)
  const old = new Map<string, readonly ShelfRun[]>()
  for (const e of prev) if (e.kind === 'manuscript') old.set(e.key, e.runs)
  const placed = new Set<string>()
  const out: ShelfEntry[] = []
  for (const work of works) {
    const key = keyOf.get(work.id)
    if (key === undefined) {
      out.push({ kind: 'work', work })
      continue
    }
    if (placed.has(key)) continue
    placed.add(key)
    const m = manuscripts.get(key)!
    const runs = m.runs.map((r) => ({ ...r, analyses: analyses.get(r.work.id) ?? NO_ANALYSES }))
    const before = old.get(key)
    const same =
      before &&
      before.length === runs.length &&
      before.every((r, i) => r.work === runs[i].work && r.run === runs[i].run && r.analyses === runs[i].analyses)
    out.push({ kind: 'manuscript', key, base: m.base, runs: same ? before : runs })
  }
  return out
}
