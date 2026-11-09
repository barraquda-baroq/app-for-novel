// ゴミ箱へ移す依頼（2.7）を作る部品。コネクタの novel_move_cards_to_trash が使う（アプリの処理は domain/claudeTrash.ts）。
// - 移せるのは、Claude がコネクタで作ったカード（相対比較の分析 n:… と資料の記録 k:…。source が claude で、作者が直していない
//   = updatedAt が createdAt と同じ）だけ。作者が手で書いた・貼り付けた・アプリで直したカード、作品・資料そのもの、ほかの種類の
//   記録は断る（id を指されても）
// - コネクタは依頼を作るだけ。アプリが同期した時に、もう一度確かめてからゴミ箱へ移す（30日は作者がアプリのゴミ箱から戻せる）
// - 1回20件・1日（日本時間）100件まで。同じカードをもう一度頼んでも、依頼は増えない（依頼中）
import { benchWorkName } from '../domain/benchOps'
import { materialName } from '../domain/materialOps'
import type { AppData, BenchAnalysis, ID, MaterialNote, TrashRequest, TrashRequestTable } from '../domain/types'
import { trashRequestId } from './derivedId'
import { matchesId, shortId, SHORT_ID_LETTERS, type ShortIdKind } from './refs'
import { liveTrashRequests, TRASH_REQUEST_VERSION } from './trashTargets'

/** ツールの名前 */
export const TRASH_TOOL = 'novel_move_cards_to_trash'

/** 数の上限。json はコネクタが書ける依頼の大きさ（JSON の字数。アクセスルールと同じ値） */
export const TRASH_LIMITS = { perCall: 20, perDay: 100, json: 2_000, label: 200, ref: 80 } as const

/** 頼み直しの通し番号の上限（削除と頼み直しをこれより多く繰り返したカードは、Claude からは頼めない） */
const MAX_GENERATION = 100

type Card = BenchAnalysis | MaterialNote

/** 表ごとの短い id の種類 */
const KIND_OF: Record<TrashRequestTable, ShortIdKind> = { benchAnalyses: 'benchAnalysis', materialNotes: 'materialNote' }

/** 表ごとの棚の名前（答えの「相対比較『作品名』の「構成」」） */
export const TRASH_SHELF_LABELS: Record<TrashRequestTable, string> = { benchAnalyses: '相対比較', materialNotes: '資料' }

/** カードの作品（資料）の id */
export function cardParentId(table: TrashRequestTable, card: Card): ID {
  return table === 'benchAnalyses' ? (card as BenchAnalysis).workId : (card as MaterialNote).materialId
}

/** カードの短い id（n:… か k:…） */
export function cardShortId(table: TrashRequestTable, id: ID): string {
  return shortId(KIND_OF[table], id)
}

/**
 * 移せないカードの理由。not_claude = Claude がコネクタで作ったカードでない、edited = 作者がアプリで直した、
 * changed = 依頼の後に直した・作品（資料）が変わった。問題が無ければ null
 */
export type TrashTargetProblem = 'not_claude' | 'edited' | 'changed'

export function trashTargetProblem(
  table: TrashRequestTable,
  card: Card,
  req?: Pick<TrashRequest, 'targetUpdatedAt' | 'parentId'>,
): TrashTargetProblem | null {
  if (card.source !== 'claude') return 'not_claude'
  if (card.updatedAt !== card.createdAt) return 'edited'
  if (req && (req.targetUpdatedAt !== card.updatedAt || req.parentId !== cardParentId(table, card))) return 'changed'
  return null
}

const cut = (s: string, max: number) => {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

/** カードの表記（『作品名』の「構成」（2026-10-30）。作品・資料が見つからなければ「構成」（2026-10-30）だけ） */
export function trashCardLabel(data: Pick<AppData, 'benchWorks' | 'materials'>, table: TrashRequestTable, card: Card): string {
  const parent =
    table === 'benchAnalyses'
      ? data.benchWorks[(card as BenchAnalysis).workId]
      : data.materials[(card as MaterialNote).materialId]
  const name = parent ? (table === 'benchAnalyses' ? benchWorkName(parent) : materialName(parent)) : ''
  const item = table === 'benchAnalyses' ? (card as BenchAnalysis).viewpoint : (card as MaterialNote).section
  const what = `「${(typeof item === 'string' ? item.trim() : '') || (table === 'benchAnalyses' ? '観点なし' : '項目なし')}」`
  const date = typeof card.runDate === 'string' && card.runDate ? `（${card.runDate}）` : ''
  return cut(`${name ? `『${name}』の` : ''}${what}${date}`, TRASH_LIMITS.label)
}

/** Claude の依頼で移したゴミ箱の1件と中身の id（依頼から決める。2台の端末が同じ依頼を処理しても1件になるように） */
export function trashEntryIdsOf(requestId: ID): { entry: ID; record: (i: number) => ID } {
  return { entry: `te-${requestId}`, record: (i) => (i === 0 ? `tr-${requestId}` : `tr-${requestId}-${i}`) }
}

// ---------- 依頼を作る（コネクタ） ----------

export interface TrashInput {
  /** 移すカードの id（n:… か k:…。短い id か id そのもの） */
  cards?: unknown
}

/**
 * 1つの指定の結果。requested = 依頼する、pending = もう依頼中（書かない）、repeated = 同じ呼び出しの前の指定と同じカード、
 * not_claude・edited = 移せないカード、shelf_item = 作品・資料そのもの、not_card = ほかの種類の記録、not_found = 見つからない、
 * ambiguous = 短い id が何枚にも当たる、in_trash = もうゴミ箱にある、invalid = 形が違う
 */
export type TrashItemStatus =
  | 'requested'
  | 'pending'
  | 'repeated'
  | 'not_claude'
  | 'edited'
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
  shelf_item:
    '作品・資料そのものは移せません（移せるのはカードだけ。作品・資料ごとやり直す時は、作者がアプリで削除してください）',
  not_card: '移せるのは相対比較の分析（n:…）と資料の記録（k:…）だけです',
  not_found: '見つかりません（novel_get_bench_analysis・novel_get_material で id を確かめてください）',
  ambiguous: '短い id が何枚ものカードに当たります（id を長く指定してください）',
  in_trash: 'もうゴミ箱にあります',
  invalid: 'id の形が違います',
}

/** 2つの表から、指定に当たるカード */
function findCards(data: AppData, table: TrashRequestTable | null, ref: string): { table: TrashRequestTable; card: Card }[] {
  const out: { table: TrashRequestTable; card: Card }[] = []
  for (const t of table ? [table] : (['benchAnalyses', 'materialNotes'] as const)) {
    const rows = data[t] as Record<ID, Card>
    if (!table) {
      const exact = rows[ref]
      if (exact) out.push({ table: t, card: exact })
      continue
    }
    for (const card of Object.values(rows)) if (matchesId(KIND_OF[t], ref, card.id)) out.push({ table: t, card })
  }
  return out
}

/** ゴミ箱にあるカードの id（指定に当たるもの） */
function findTrashed(trash: AppData['trashRecords'], table: TrashRequestTable | null, ref: string): ID[] {
  const out = new Set<ID>()
  for (const r of Object.values(trash)) {
    const id = (r.record as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') continue
    if (
      table
        ? r.table === table && matchesId(KIND_OF[table], ref, id)
        : (r.table === 'benchAnalyses' || r.table === 'materialNotes') && id === ref
    )
      out.add(id)
  }
  return [...out]
}

/** 短い id の文字から、表（n: と k:）・作品か資料（w: と d:）・ほかの種類 */
function refKind(ref: string): { table: TrashRequestTable | null; other?: 'shelf' | 'card' } {
  const m = /^([a-zA-Z]):/.exec(ref)
  if (!m) return { table: null }
  const letter = m[1].toLowerCase()
  if (letter === SHORT_ID_LETTERS.benchAnalysis) return { table: 'benchAnalyses' }
  if (letter === SHORT_ID_LETTERS.materialNote) return { table: 'materialNotes' }
  if (letter === SHORT_ID_LETTERS.benchWork || letter === SHORT_ID_LETTERS.material) return { table: null, other: 'shelf' }
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
      items.push({ ref, status, hint: TRASH_STATUS_HINTS[status] })
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
      items.push({ ref, status, hint: TRASH_STATUS_HINTS[status] })
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
    const problem = trashTargetProblem(table, card)
    if (problem === 'not_claude' || problem === 'edited') {
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
      v: TRASH_REQUEST_VERSION,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }
    records.push({ table: 'trashRequests', record })
    items.push({ ref, status: 'requested', table, id: card.id, label })
  }
  if (records.length > Math.max(0, ctx.dailyLeft))
    return fail(
      `今日（日本時間）ゴミ箱へ移せるのは、あと${Math.max(0, ctx.dailyLeft)}件です（1日${TRASH_LIMITS.perDay}件まで。いま新しく${records.length}件）。数を減らすか、明日にしてください`,
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
