// ベンチ作品（ホームの棚の、比べるために読む既存の作品）とその分析の操作。
// 作品はどのタイトルにも属さず、すべてのタイトルで共有する。各タイトルは比べる作品を選べる（Title.benchWorkIds）。
// 分析は1つの作品にいくつでも（観点・Markdown の本文・日付）。Claude（コネクタ・貼り付け）が作った分析も、作った後は
// ふつうのレコードとして編集・削除できる。削除はゴミ箱へ（作品はその分析と一緒に1件、分析は1件ずつ）。
import { jstDate, isIsoDate } from '../claude/dates'
import { CLAUDE_RECORD_VERSION } from '../claude/visibility'
import { deepEqual } from './equal'
import { orderOrigin, putInTrash, trashLabel } from './trash'
import { transact, type Tx } from './tx'
import { DomainError, type AppData, type BenchAnalysis, type BenchWork, type ID, type Title } from './types'
import { byOrder, newId, nextOrder, now, stepOrder } from './util'

/** 長さの上限（短い項目だけ。分析の本文・メモには上限を設けない）。src/claude/records.ts の RECORD_LIMITS と同じ値 */
export const BENCH_LIMITS = {
  workName: 80,
  author: 80,
  publisher: 80,
  year: 20,
  genre: 40,
  pdfPlace: 200,
  viewpoint: 40,
} as const

/** 文字（コードポイント）の数 */
const chars = (s: string) => Array.from(s).length

// ---------- 読む ----------

/** 棚の並び（order の順） */
export function sortedBenchWorks(data: Pick<AppData, 'benchWorks'>): BenchWork[] {
  return Object.values(data.benchWorks).sort(byOrder)
}

/** 作品の名前（空なら「無題のベンチ作品」） */
export function benchWorkName(work: Pick<BenchWork, 'name'>): string {
  return work.name.trim() || '無題のベンチ作品'
}

/** 作品を比べる作品にしているタイトル（タイトルの並び順） */
export function titlesComparing(data: Pick<AppData, 'titles'>, workId: ID): Title[] {
  return Object.values(data.titles)
    .filter((t) => Array.isArray(t.benchWorkIds) && t.benchWorkIds.includes(workId))
    .sort(byOrder)
}

/** タイトルの比べるベンチ作品（選んだ順。消えた作品は除く） */
export function benchWorksOfTitle(data: Pick<AppData, 'titles' | 'benchWorks'>, titleId: ID): BenchWork[] {
  const ids = data.titles[titleId]?.benchWorkIds ?? []
  return ids.map((id) => data.benchWorks[id]).filter((w): w is BenchWork => Boolean(w))
}

/** 観点の名前を比べる形（前後の空白を除き、Unicode の正規化をそろえる） */
export function viewpointKey(viewpoint: string): string {
  return viewpoint.normalize('NFC').trim()
}

/**
 * 観点の入力の候補（すべての作品の分析の観点。多く使われているものから、同じ数なら最初に使った順）。
 * 分析を書く時に、作品をまたいで同じ観点の名前にそろえやすいように
 */
export function benchViewpointSuggestions(data: Pick<AppData, 'benchAnalyses'>): string[] {
  const seen = new Map<string, { name: string; count: number; first: number }>()
  for (const a of Object.values(data.benchAnalyses)) {
    const key = viewpointKey(a.viewpoint)
    if (!key) continue
    const cur = seen.get(key)
    if (cur) {
      cur.count += 1
      cur.first = Math.min(cur.first, a.createdAt)
    } else seen.set(key, { name: key, count: 1, first: a.createdAt })
  }
  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first || (a.name < b.name ? -1 : 1))
    .map((x) => x.name)
}

// ---------- ベンチ作品 ----------

export interface BenchWorkInput {
  name?: string
  author?: string
  publisher?: string
  year?: string
  genre?: string
  pdfPlace?: string
  note?: string
}

function checkLength(value: string | undefined, max: number, label: string): void {
  if (value !== undefined && chars(value) > max) throw new DomainError(`${label}は${max}字までにしてください`)
}

/** 入力の形を確かめて、作品の項目にする（任意の項目は、空なら持たない） */
function workFields(input: BenchWorkInput): Partial<BenchWork> {
  const out: Partial<BenchWork> = {}
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new DomainError('作品名を入れてください')
    checkLength(name, BENCH_LIMITS.workName, '作品名')
    out.name = name
  }
  if (input.author !== undefined) {
    checkLength(input.author.trim(), BENCH_LIMITS.author, '著者')
    out.author = input.author.trim()
  }
  if (input.pdfPlace !== undefined) {
    checkLength(input.pdfPlace.trim(), BENCH_LIMITS.pdfPlace, 'PDF の置き場所')
    out.pdfPlace = input.pdfPlace.trim()
  }
  if (input.note !== undefined) out.note = input.note
  for (const [key, label] of [
    ['publisher', '出版社'],
    ['year', '刊行年'],
    ['genre', 'ジャンル'],
  ] as const) {
    const v = input[key]
    if (v === undefined) continue
    checkLength(v.trim(), BENCH_LIMITS[key], label)
    out[key] = v.trim()
  }
  return out
}

/** 空の任意項目（出版社・刊行年・ジャンル）を取り除く */
function dropEmptyOptional(w: BenchWork): BenchWork {
  const out = { ...w }
  for (const key of ['publisher', 'year', 'genre'] as const) if (out[key] !== undefined && !out[key]!.trim()) delete out[key]
  return out
}

/** ベンチ作品を棚の末尾に足す（作品名は必須） */
export function addBenchWork(data: AppData, input: BenchWorkInput): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const fields = workFields({ ...input, name: input.name ?? '' })
    const ts = now()
    const work: BenchWork = dropEmptyOptional({
      id: newId(),
      name: fields.name!,
      author: fields.author ?? '',
      pdfPlace: fields.pdfPlace ?? '',
      note: fields.note ?? '',
      ...(fields.publisher ? { publisher: fields.publisher } : {}),
      ...(fields.year ? { year: fields.year } : {}),
      ...(fields.genre ? { genre: fields.genre } : {}),
      order: nextOrder(tx.all('benchWorks')),
      createdAt: ts,
      updatedAt: ts,
    })
    tx.put('benchWorks', work)
    return work.id
  })
}

function requireWork(tx: Tx, id: ID): BenchWork {
  const w = tx.get('benchWorks', id)
  if (!w) throw new DomainError('ベンチ作品が見つかりません')
  return w
}

/** 作品の情報を直す（作品名は空にできない。値が変わらなければ何もしない） */
export function updateBenchWork(data: AppData, id: ID, patch: BenchWorkInput): AppData {
  return transact(data, (tx) => {
    const w = requireWork(tx, id)
    const next = dropEmptyOptional({ ...w, ...workFields(patch) })
    if (deepEqual(next, w)) return
    tx.put('benchWorks', { ...next, updatedAt: now() })
  }).data
}

/** 棚の index 番目（0から）へ移す */
export function moveBenchWorkTo(data: AppData, id: ID, index: number): AppData {
  return transact(data, (tx) => {
    const list = tx.all('benchWorks').sort(byOrder)
    const from = list.findIndex((w) => w.id === id)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved)
    const ts = now()
    list.forEach((w, i) => {
      if (w.order !== i) tx.put('benchWorks', { ...w, order: i, updatedAt: ts })
    })
  }).data
}

/** 棚の中で1つ上（-1）・下（+1）へ */
export function moveBenchWorkStep(data: AppData, id: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const ts = now()
    for (const w of stepOrder(tx.all('benchWorks'), id, dir)) tx.put('benchWorks', { ...w, updatedAt: ts })
  }).data
}

/** 作品の分析（作った順。並べ方は src/claude/order.ts の benchAnalysesOf） */
function analysesOf(tx: Tx, workId: ID): BenchAnalysis[] {
  return tx
    .all('benchAnalyses')
    .filter((a) => a.workId === workId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * ベンチ作品を、その分析といっしょにゴミ箱の1件へ移す。比べる作品にしていたタイトルは書き換えない（タイトルには作品の id が
 * 残り、作品が無い間は表示から外れて（修復・benchWorksOfTitle）、戻すとまた比べる作品に出る。ほかの端末で同じタイトルが削除されても、
 * 触っていないタイトルの「削除と編集が重なった」控えができないように）。比べる作品にしていたタイトルは控えておき（origin.titleIds）、
 * 戻す時に、その後で作品の id が抜けたタイトル（ゴミ箱の中のものも）に足し直す（trash.ts の relinkBenchWork）。
 * 作品批評の結果の「比べた作品」の記録はそのまま（戻せば、また名前が出る）
 */
export function deleteBenchWork(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const work = tx.get('benchWorks', id)
    if (!work) return
    const comparing = titlesComparing(tx.data, id)
    putInTrash(tx, {
      kind: 'benchWork',
      label: trashLabel.benchWork(work),
      titleName: '',
      origin: {
        titleId: null,
        ...orderOrigin(tx.all('benchWorks'), id),
        ...(comparing.length ? { titleIds: comparing.map((t) => t.id) } : {}),
      },
      records: [
        { table: 'benchWorks', record: work },
        ...analysesOf(tx, id).map((record) => ({ table: 'benchAnalyses' as const, record })),
      ],
    })
  }).data
}

// ---------- 分析 ----------

export interface BenchAnalysisInput {
  viewpoint?: string
  body?: string
  /** 分析した日（YYYY-MM-DD。省略時は今日） */
  runDate?: string
}

function analysisFields(input: BenchAnalysisInput): Partial<BenchAnalysis> {
  const out: Partial<BenchAnalysis> = {}
  if (input.viewpoint !== undefined) {
    const v = input.viewpoint.trim()
    if (!v) throw new DomainError('観点を入れてください（構成・文体・人物など）')
    checkLength(v, BENCH_LIMITS.viewpoint, '観点')
    out.viewpoint = v
  }
  if (input.body !== undefined) out.body = input.body
  if (input.runDate !== undefined) {
    const d = input.runDate.trim()
    if (!isIsoDate(d)) throw new DomainError('日付は YYYY-MM-DD で入れてください')
    out.runDate = d
  }
  return out
}

/** 分析を手で足す（観点は必須。日付を省けば今日） */
export function addBenchAnalysis(data: AppData, workId: ID, input: BenchAnalysisInput): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireWork(tx, workId)
    const fields = analysisFields({ ...input, viewpoint: input.viewpoint ?? '' })
    const ts = now()
    const a: BenchAnalysis = {
      id: newId(),
      workId,
      viewpoint: fields.viewpoint!,
      body: fields.body ?? '',
      runDate: fields.runDate ?? jstDate(ts),
      source: 'manual',
      v: CLAUDE_RECORD_VERSION,
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('benchAnalyses', a)
    return a.id
  })
}

/** 分析を直す（観点・本文・日付。値が変わらなければ何もしない） */
export function updateBenchAnalysis(data: AppData, id: ID, patch: BenchAnalysisInput): AppData {
  return transact(data, (tx) => {
    const a = tx.get('benchAnalyses', id)
    if (!a) throw new DomainError('ベンチ作品の分析が見つかりません')
    const fields = analysisFields(patch)
    if ((Object.keys(fields) as (keyof BenchAnalysis)[]).every((k) => fields[k] === a[k])) return
    tx.put('benchAnalyses', { ...a, ...fields, updatedAt: now() })
  }).data
}

export function deleteBenchAnalysis(data: AppData, id: ID): AppData {
  return transact(data, (tx) => {
    const a = tx.get('benchAnalyses', id)
    if (!a) return
    const work = tx.get('benchWorks', a.workId)
    putInTrash(tx, {
      kind: 'benchAnalysis',
      label: trashLabel.benchAnalysis(a),
      titleName: '',
      ...(work ? { parentLabel: trashLabel.benchWork(work) } : {}),
      origin: { titleId: null, index: -1, workId: a.workId },
      records: [{ table: 'benchAnalyses', record: a }],
    })
  }).data
}

// ---------- タイトルの比べるベンチ作品 ----------

/** タイトルの比べる作品に足す（末尾。もう入っていれば何もしない） */
export function addTitleBenchWork(data: AppData, titleId: ID, workId: ID): AppData {
  return transact(data, (tx) => {
    const t = tx.get('titles', titleId)
    if (!t) throw new DomainError('タイトルが見つかりません')
    requireWork(tx, workId)
    const ids = Array.isArray(t.benchWorkIds) ? t.benchWorkIds : []
    if (ids.includes(workId)) return
    tx.put('titles', { ...t, benchWorkIds: [...ids, workId], updatedAt: now() })
  }).data
}

/** タイトルの比べる作品から外す（作品そのものは棚に残る） */
export function removeTitleBenchWork(data: AppData, titleId: ID, workId: ID): AppData {
  return transact(data, (tx) => {
    const t = tx.get('titles', titleId)
    if (!t) throw new DomainError('タイトルが見つかりません')
    const ids = Array.isArray(t.benchWorkIds) ? t.benchWorkIds : []
    if (!ids.includes(workId)) return
    tx.put('titles', { ...t, benchWorkIds: ids.filter((x) => x !== workId), updatedAt: now() })
  }).data
}
