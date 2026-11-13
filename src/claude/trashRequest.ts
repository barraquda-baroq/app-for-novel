// ゴミ箱へ移す依頼（2.7）を作る部品。コネクタの novel_move_cards_to_trash が使う（アプリの処理は domain/claudeTrash.ts）。
// - 移せるのは、Claude がコネクタで作ったカード（相対比較の分析 n:… と資料の記録 k:…。source が claude で、作者が直していない
//   = updatedAt が createdAt と同じ）だけ。作者が手で書いた・貼り付けた・アプリで直したカード、作品・資料そのもの、ほかの種類の
//   記録は断る（id を指されても）
// - 2.8 から Claude が作ったアイデア（i:…。isClaudeIdea）も移せる。直したかは本文の指紋で見る（ideaEditedByAuthor。済み・並べ替え・
//   仕切りの移動・Claude の追記は直したに数えない）。「読む＋書き込む」でないタイトルのアイデアは移さない。アイデアの依頼は形の版 2
// - コネクタは依頼を作るだけ。アプリが同期した時に、もう一度確かめてからゴミ箱へ移す（30日は作者がアプリのゴミ箱から戻せる）
// - 1回20件・1日（日本時間）100件まで。同じカードをもう一度頼んでも、依頼は増えない（依頼中）
import { benchWorkName } from '../domain/benchOps'
import { materialName } from '../domain/materialOps'
import type { AppData, BenchAnalysis, ID, Idea, MaterialNote, TrashRequest, TrashRequestTable } from '../domain/types'
import { trashRequestId } from './derivedId'
import { CLAUDE_IDEA_ID, ideaEditedByAuthor, ideaHeadLine, ideaPlaceLabel, ideaSectionWritable, isClaudeIdea } from './ideaAppend'
import { matchesId, shortId, SHORT_ID_LETTERS, type ShortIdKind } from './refs'
import { IDEA_HOME_PARENT, liveTrashRequests, trashRequestVersionFor } from './trashTargets'

/** ツールの名前 */
export const TRASH_TOOL = 'novel_move_cards_to_trash'

/** 数の上限。json はコネクタが書ける依頼の大きさ（JSON の字数。アクセスルールと同じ値） */
export const TRASH_LIMITS = { perCall: 20, perDay: 100, json: 2_000, label: 200, ref: 80 } as const

/** 頼み直しの通し番号の上限（削除と頼み直しをこれより多く繰り返したカードは、Claude からは頼めない） */
const MAX_GENERATION = 100

type Card = BenchAnalysis | MaterialNote | Idea

/** 依頼で移せる表（接頭の無い id を探す順） */
const CARD_TABLES: readonly TrashRequestTable[] = ['benchAnalyses', 'materialNotes', 'ideas']

/** 表ごとの短い id の種類 */
export const KIND_OF: Record<TrashRequestTable, ShortIdKind> = {
  benchAnalyses: 'benchAnalysis',
  materialNotes: 'materialNote',
  ideas: 'idea',
}

/** 表ごとの棚の名前（答えの「相対比較『作品名』の「構成」」。アイデアは表記が場所を言うので空） */
export const TRASH_SHELF_LABELS: Record<TrashRequestTable, string> = {
  benchAnalyses: '相対比較',
  materialNotes: '資料',
  ideas: '',
}

/** カードの作品（資料）の id。アイデアは仕切りのタイトルの id（ホームのアイデアは 'home'） */
export function cardParentId(table: TrashRequestTable, card: Card): ID {
  if (table === 'ideas') {
    const t = (card as Idea).titleId
    return typeof t === 'string' && t ? t : IDEA_HOME_PARENT
  }
  return table === 'benchAnalyses' ? (card as BenchAnalysis).workId : (card as MaterialNote).materialId
}

/** カードの短い id（n:… か k:…） */
export function cardShortId(table: TrashRequestTable, id: ID): string {
  return shortId(KIND_OF[table], id)
}

/**
 * 移せないカードの理由。not_claude = Claude がコネクタで作ったカードでない、edited = 作者がアプリで直した、
 * not_writable = 「読む＋書き込む」でないタイトルのアイデア、changed = 依頼の後に直した・作品（資料）が変わった
 * （アイデアは依頼の後に別の仕切りへ移した）。問題が無ければ null
 */
export type TrashTargetProblem = 'not_claude' | 'edited' | 'not_writable' | 'changed'

/**
 * カードを移せるか。data（タイトルの表）を渡すと、アイデアの場所に書き込めるかも見る（コネクタの依頼の作成・アプリの処理）。
 * 分析・記録は 2.7 と同じ（updatedAt が createdAt と同じ・依頼の時の updatedAt と作品（資料））
 */
export function trashTargetProblem(
  table: TrashRequestTable,
  card: Card,
  req?: Pick<TrashRequest, 'targetUpdatedAt' | 'parentId'>,
  data?: Pick<AppData, 'titles'>,
): TrashTargetProblem | null {
  if (table === 'ideas') {
    const idea = card as Idea
    if (!isClaudeIdea(idea)) return 'not_claude'
    if (ideaEditedByAuthor(idea)) return 'edited'
    if (data && !ideaSectionWritable(data.titles, idea)) return 'not_writable'
    // 依頼の時の updatedAt は比べない（済み・並べ替えでも変わる）。依頼の後に別の仕切りへ移したものだけ移さない
    if (req && req.parentId !== cardParentId(table, idea)) return 'changed'
    return null
  }
  const c = card as BenchAnalysis | MaterialNote
  if (c.source !== 'claude') return 'not_claude'
  if (c.updatedAt !== c.createdAt) return 'edited'
  if (req && (req.targetUpdatedAt !== c.updatedAt || req.parentId !== cardParentId(table, c))) return 'changed'
  return null
}

const cut = (s: string, max: number) => {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

/**
 * カードの表記（『作品名』の「構成」（2026-10-30）。作品・資料が見つからなければ「構成」（2026-10-30）だけ）。
 * アイデアは場所と1行目（ホームのアイデア「2026/11/12 14:32　第3章の動機」・タイトル『灰の庭』のアイデア「…」。名前の無い Claude の
 * アイデアは日付と時刻の後ろに中身の最初の行「2026/11/12 14:32　港町の案」。ideaHeadLine）
 */
export function trashCardLabel(
  data: Pick<AppData, 'benchWorks' | 'materials' | 'titles'>,
  table: TrashRequestTable,
  card: Card,
): string {
  if (table === 'ideas')
    return cut(`${ideaPlaceLabel(data.titles, card as Idea)}「${ideaHeadLine(card as Idea, 40)}」`, TRASH_LIMITS.label)
  const parent =
    table === 'benchAnalyses'
      ? data.benchWorks[(card as BenchAnalysis).workId]
      : data.materials[(card as MaterialNote).materialId]
  const name = parent ? (table === 'benchAnalyses' ? benchWorkName(parent) : materialName(parent)) : ''
  const item = table === 'benchAnalyses' ? (card as BenchAnalysis).viewpoint : (card as MaterialNote).section
  const what = `「${(typeof item === 'string' ? item.trim() : '') || (table === 'benchAnalyses' ? '観点なし' : '項目なし')}」`
  const runDate = (card as BenchAnalysis | MaterialNote).runDate
  const date = typeof runDate === 'string' && runDate ? `（${runDate}）` : ''
  return cut(`${name ? `『${name}』の` : ''}${what}${date}`, TRASH_LIMITS.label)
}

/** Claude の依頼で移したゴミ箱の1件と中身の id（依頼から決める。2台の端末が同じ依頼を処理しても1件になるように） */
export function trashEntryIdsOf(requestId: ID): { entry: ID; record: (i: number) => ID } {
  return { entry: `te-${requestId}`, record: (i) => (i === 0 ? `tr-${requestId}` : `tr-${requestId}-${i}`) }
}

// ---------- 依頼を作る（コネクタ） ----------

export interface TrashInput {
  /** 移すカードの id（n:…・k:…・i:…。短い id か id そのもの） */
  cards?: unknown
}

/**
 * 1つの指定の結果。requested = 依頼する、pending = もう依頼中（書かない）、repeated = 同じ呼び出しの前の指定と同じカード、
 * not_claude・edited = 移せないカード、not_writable = 「読む＋書き込む」でないタイトルのアイデア、shelf_item = 作品・資料そのもの、
 * not_card = ほかの種類の記録、not_found = 見つからない、ambiguous = 短い id が何枚にも当たる、in_trash = もうゴミ箱にある、
 * invalid = 形が違う
 */
export type TrashItemStatus =
  | 'requested'
  | 'pending'
  | 'repeated'
  | 'not_claude'
  | 'edited'
  | 'not_writable'
  | 'shelf_item'
  | 'not_card'
  | 'not_found'
  | 'ambiguous'
  | 'in_trash'
  | 'invalid'

export interface TrashItem {
  /** 入力のまま（短く切る） */
  ref: string
  status: TrashItemStatus
  table?: TrashRequestTable
  /** カードの id */
  id?: ID
  /** カードの表記（『作品名』の「構成」（2026-10-30）） */
  label?: string
  hint?: string
  candidates?: string[]
}

export interface TrashBuild {
  /** false = 呼び出し全体を断った（error に理由） */
  ok: boolean
  error?: string
  records: { table: 'trashRequests'; record: TrashRequest }[]
  items: TrashItem[]
}

export interface TrashContext {
  now: number
  /** ゴミ箱の中身（中身の元の表と id だけを見る。コネクタの写しでは中身を省いた形） */
  trash: AppData['trashRecords']
  /** クラウドに削除の印がある記録か（コネクタの写し。依頼の id を頼み直しの番号に進める） */
  wasDeleted: (table: string, id: ID) => boolean
  /** 今日（日本時間）あと何件頼めるか */
  dailyLeft: number
}

export const TRASH_STATUS_HINTS: Record<Exclude<TrashItemStatus, 'requested'>, string> = {
  pending: 'もうゴミ箱へ移す依頼が出ています（アプリが同期すると移ります）',
  repeated: 'この呼び出しの中で、前に指定したカードと同じです（1つにまとめました）',
  not_claude:
    'Claude がこのコネクタで作ったカードではありません（作者が書いた・貼り付けたカードは移せません。作者がアプリで削除してください）',
  edited: '作者がアプリで直したカードです（移せません。作者がアプリで削除してください）',
  not_writable:
    '「Claude に見せる」が「読む＋書き込む」でないタイトルのアイデアです（移せません。作者がアプリで削除するか、タイトルを「読む＋書き込む」にしてください）',
  shelf_item:
    '作品・資料そのものは移せません（移せるのはカードだけ。作品・資料ごとやり直す時は、作者がアプリで削除してください）',
  not_card: '移せるのは相対比較の分析（n:…）・資料の記録（k:…）・Claude が作ったアイデア（i:…）だけです',
  not_found: '見つかりません（novel_get_bench_analysis・novel_get_material で id を確かめてください）',
  ambiguous: '短い id が何枚ものカードに当たります（id を長く指定してください）',
  in_trash: 'もうゴミ箱にあります',
  invalid: 'id の形が違います',
}

/** i:… で見つからない時（分析・記録の見つからない時の文は 2.7 のまま） */
const IDEA_NOT_FOUND_HINT = '見つかりません（novel_get_notes の kind=ideas で id を確かめてください）'

/** 2.9: アイデアのフォルダ（f:…）を渡された時（「移せない種類」の行の形のまま、フォルダ用の説明を出す） */
export const FOLDER_NOT_CARD_HINT =
  'フォルダはゴミ箱へ移せません（フォルダの削除・整理はアプリで作者がします。中のカードは i:… で指せます）'

/** 3つの表から、指定に当たるカード（接頭の無い id は、どの表でも id そのものと同じものだけ） */
function findCards(data: AppData, table: TrashRequestTable | null, ref: string): { table: TrashRequestTable; card: Card }[] {
  const out: { table: TrashRequestTable; card: Card }[] = []
  for (const t of table ? [table] : CARD_TABLES) {
    const rows = data[t] as Record<ID, Card>
    if (!table) {
      // 表の自分の項目だけ（'constructor' などの id で Object の中身を拾わない）
      if (Object.prototype.hasOwnProperty.call(rows, ref)) out.push({ table: t, card: rows[ref] })
      continue
    }
    for (const card of Object.values(rows)) if (matchesId(KIND_OF[t], ref, card.id)) out.push({ table: t, card })
  }
  return out
}

/**
 * ゴミ箱の中身が、Claude が作ったアイデアか（作者が書いたアイデアは、ゴミ箱にあることも答えない）。コネクタの写しのゴミ箱の中身は
 * 元の記録の id だけなので、id の形（cy-…。アクセスルールで Claude だけが作る形）で見る。source があれば claude であること
 */
export function isTrashedClaudeIdea(record: unknown): boolean {
  const r = record as { id?: unknown; source?: unknown } | undefined
  return typeof r?.id === 'string' && CLAUDE_IDEA_ID.test(r.id) && (r.source === undefined || r.source === 'claude')
}

/** ゴミ箱にあるカードの id（指定に当たるもの） */
function findTrashed(trash: AppData['trashRecords'], table: TrashRequestTable | null, ref: string): ID[] {
  const out = new Set<ID>()
  for (const r of Object.values(trash)) {
    const id = (r.record as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') continue
    if (r.table === 'ideas' && !isTrashedClaudeIdea(r.record)) continue
    if (
      table
        ? r.table === table && matchesId(KIND_OF[table], ref, id)
        : (CARD_TABLES as readonly string[]).includes(r.table) && id === ref
    )
      out.add(id)
  }
  return [...out]
}

/** 短い id の文字から、表（n:・k:・i:）・作品か資料（w: と d:）・アイデアのフォルダ（f:。2.9）・ほかの種類 */
function refKind(ref: string): { table: TrashRequestTable | null; other?: 'shelf' | 'folder' | 'card' } {
  const m = /^([a-zA-Z]):/.exec(ref)
  if (!m) return { table: null }
  const letter = m[1].toLowerCase()
  if (letter === SHORT_ID_LETTERS.benchAnalysis) return { table: 'benchAnalyses' }
  if (letter === SHORT_ID_LETTERS.materialNote) return { table: 'materialNotes' }
  if (letter === SHORT_ID_LETTERS.idea) return { table: 'ideas' }
  if (letter === SHORT_ID_LETTERS.benchWork || letter === SHORT_ID_LETTERS.material) return { table: null, other: 'shelf' }
  if (letter === SHORT_ID_LETTERS.ideaFolder) return { table: null, other: 'folder' }
  return { table: null, other: 'card' }
}

/**
 * ゴミ箱へ移す依頼を作る。data は Claude に見せる内容（claudeView。依頼中のカードはもう外れている）。
 * 新しく作る依頼が1回の上限・今日の残りを超える時は、呼び出し全体を断る（一部だけ頼まない）
 */
export function buildTrashRequests(data: AppData, input: TrashInput, ctx: TrashContext): TrashBuild {
  const fail = (error: string): TrashBuild => ({ ok: false, error, records: [], items: [] })
  const cards = input && typeof input === 'object' ? input.cards : undefined
  if (!Array.isArray(cards) || cards.length === 0)
    return fail('cards がありません（ゴミ箱へ移すカードの id を n:… か k:… で渡してください）')
  if (cards.length > TRASH_LIMITS.perCall)
    return fail(`1回に移せるのは${TRASH_LIMITS.perCall}件までです（いま ${cards.length}件。分けて呼んでください）`)
  const pending = liveTrashRequests(data)
  const items: TrashItem[] = []
  const records: TrashBuild['records'] = []
  const seen = new Set<string>()
  for (const raw of cards) {
    const ref = typeof raw === 'string' ? raw.trim() : ''
    const shown = cut(typeof raw === 'string' ? raw.trim() : String(raw), TRASH_LIMITS.ref)
    if (!ref || Array.from(ref).length > TRASH_LIMITS.ref) {
      items.push({ ref: shown, status: 'invalid', hint: TRASH_STATUS_HINTS.invalid })
      continue
    }
    const kind = refKind(ref)
    if (kind.other) {
      const status = kind.other === 'shelf' ? 'shelf_item' : 'not_card'
      items.push({ ref, status, hint: kind.other === 'folder' ? FOLDER_NOT_CARD_HINT : TRASH_STATUS_HINTS[status] })
      continue
    }
    // 依頼中のカード（見せる内容からは外れている）
    const asked = pending.filter((r) =>
      kind.table ? r.table === kind.table && matchesId(KIND_OF[r.table], ref, r.targetId) : r.targetId === ref,
    )
    const hits = findCards(data, kind.table, ref)
    // 短い id が何枚にも当たる（依頼中のカードと見えているカードは重ならないが、Claude に見せる内容でない時は同じカードのこともある）
    if (new Set([...asked.map((r) => r.targetId), ...hits.map((h) => h.card.id)]).size > 1) {
      items.push({
        ref,
        status: 'ambiguous',
        hint: TRASH_STATUS_HINTS.ambiguous,
        candidates: [
          ...asked.map((r) => `${cardShortId(r.table, r.targetId)} ${r.label}（依頼中）`),
          ...hits.map((h) => `${cardShortId(h.table, h.card.id)} ${trashCardLabel(data, h.table, h.card)}`),
        ].slice(0, 10),
      })
      continue
    }
    if (asked.length) {
      const r = asked[0]
      const key = `${r.table}:${r.targetId}`
      const status = seen.has(key) ? 'repeated' : 'pending'
      seen.add(key)
      items.push({ ref, status, table: r.table, id: r.targetId, label: r.label, hint: TRASH_STATUS_HINTS[status] })
      continue
    }
    if (!hits.length) {
      const trashed = findTrashed(ctx.trash, kind.table, ref)
      const status = trashed.length ? 'in_trash' : 'not_found'
      const hint = status === 'not_found' && kind.table === 'ideas' ? IDEA_NOT_FOUND_HINT : TRASH_STATUS_HINTS[status]
      items.push({ ref, status, hint })
      continue
    }
    const { table, card } = hits[0]
    const key = `${table}:${card.id}`
    const label = trashCardLabel(data, table, card)
    if (seen.has(key)) {
      items.push({ ref, status: 'repeated', table, id: card.id, label, hint: TRASH_STATUS_HINTS.repeated })
      continue
    }
    seen.add(key)
    const problem = trashTargetProblem(table, card, undefined, data)
    if (problem === 'not_claude' || problem === 'edited' || problem === 'not_writable') {
      items.push({ ref, status: problem, table, id: card.id, label, hint: TRASH_STATUS_HINTS[problem] })
      continue
    }
    const id = freshRequestId(table, card.id, data, ctx)
    if (!id) {
      items.push({
        ref,
        status: 'invalid',
        table,
        id: card.id,
        label,
        hint: 'このカードはもう頼み直せません（作者がアプリで削除してください）',
      })
      continue
    }
    const record: TrashRequest = {
      id,
      table,
      targetId: card.id,
      parentId: cardParentId(table, card),
      targetUpdatedAt: card.updatedAt,
      label,
      source: 'claude',
      v: trashRequestVersionFor(table),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }
    records.push({ table: 'trashRequests', record })
    items.push({ ref, status: 'requested', table, id: card.id, label })
  }
  if (records.length > Math.max(0, ctx.dailyLeft))
    return fail(
      `今日（日本時間）ゴミ箱へ移せるのは、あと${Math.max(0, ctx.dailyLeft)}件です（すべての接続を合わせて1日${TRASH_LIMITS.perDay}件まで。いま新しく${records.length}件）。数を減らすか、明日にしてください`,
    )
  return { ok: true, records, items }
}

/**
 * 依頼の id を決める（1 = 初めて。生きている依頼が無く、削除の印がある番号は飛ばす）。上限まですべて削除の印なら null
 */
function freshRequestId(table: TrashRequestTable, targetId: ID, data: AppData, ctx: TrashContext): ID | null {
  for (let g = 1; g <= MAX_GENERATION; g++) {
    const id = trashRequestId(table, targetId, g)
    if (data.trashRequests[id]) continue
    if (ctx.wasDeleted('trashRequests', id)) continue
    return id
  }
  return null
}
