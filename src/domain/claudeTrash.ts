// ゴミ箱へ移す依頼（2.7。TrashRequest）をアプリで処理する。Claude（コネクタ）は依頼を作るだけで、カードを移すのはアプリ
// （src/features/claude/ClaudeRequests.tsx が、同期を受け持つ画面でクラウドと揃った時に、アイデアへの追記の依頼と一緒に
// 当てる。domain/claudeRequests.ts）。
// 1件ずつ確かめてから、作者の削除と同じ形でゴミ箱へ入れ（trashBenchAnalysis・trashMaterialNote・trashIdea）、依頼を消す:
// - Claude がコネクタで作ったカード（source が claude）で、作者が直していない（updatedAt が createdAt と同じ）こと。
//   依頼の後に直した・作品（資料）が変わったカードも移さない（changed）
// - アイデア（2.8）は Claude が作ったもの（isClaudeIdea）で、本文が Claude が書いた形のまま（claudeHash。済み・並べ替え・仕切りの
//   移動・Claude の追記は直したに数えない）、書き込める場所（ホームか「読む＋書き込む」のタイトル）にあること。依頼の後に
//   別の仕切りへ移したものも移さない（changed）
// - 1日（日本時間）100件まで（その日に Claude の依頼で移したゴミ箱の件と合わせて数える）
// - 新しい版のコネクタが書いた依頼は触らずに残す
// ゴミ箱の1件と中身の id は依頼から決める（2台の端末が同じ依頼を処理しても1件になる。claude/trashRequest.ts の trashEntryIdsOf）。
// 削除した時刻は処理した時刻にする（依頼の時刻にすると、長く開かなかった後に処理したものがすぐ完全に削除されるため）。
import { jstDate } from '../claude/dates'
import { trashEntryIdsOf, trashTargetProblem, TRASH_LIMITS, type TrashTargetProblem } from '../claude/trashRequest'
import { isNewerTrashRequest, isTrashRequest } from '../claude/trashTargets'
import { trashBenchAnalysis } from './benchOps'
import { trashIdea } from './entityOps'
import { trashMaterialNote } from './materialOps'
import { TRASH_RETENTION_DAYS } from './trash'
import { transact } from './tx'
import type { AppData, BenchAnalysis, ID, Idea, MaterialNote, TrashRequestTable } from './types'

/**
 * 依頼1件の結果。moved = ゴミ箱へ移した、in_trash = カードはもうゴミ箱にある、not_found = カードが無い、
 * not_claude・edited・not_writable・changed = 移せないカード、over_limit = 1日の上限を超えた、invalid = 依頼の形が違う
 */
export type TrashRequestStatus = 'moved' | 'in_trash' | 'not_found' | TrashTargetProblem | 'over_limit' | 'invalid'

export interface TrashRequestOutcome {
  requestId: ID
  status: TrashRequestStatus
  table?: TrashRequestTable
  targetId?: ID
  label?: string
}

/** その日（日本時間）に Claude の依頼でゴミ箱へ入れた件の数 */
function movedToday(data: AppData, nowTs: number): number {
  const today = jstDate(nowTs)
  let n = 0
  for (const e of Object.values(data.trashEntries)) if (e.by === 'claude' && jstDate(e.deletedAt) === today) n += 1
  return n
}

/** ゴミ箱の中身に、この表の id のカードがあるか */
function inTrash(data: AppData, table: TrashRequestTable, id: ID): boolean {
  for (const r of Object.values(data.trashRecords))
    if (r.table === table && (r.record as { id?: unknown } | undefined)?.id === id) return true
  return false
}

/** 依頼を処理する（作った順）。何も変わらなければ、元の data をそのまま返す */
export function applyTrashRequests(data: AppData, nowTs: number): { data: AppData; result: TrashRequestOutcome[] } {
  const requests = Object.values(data.trashRequests ?? {})
  if (!requests.length) return { data, result: [] }
  const sorted = [...requests].sort((a, b) => {
    const ca = typeof a?.createdAt === 'number' ? a.createdAt : 0
    const cb = typeof b?.createdAt === 'number' ? b.createdAt : 0
    return ca - cb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
  const outcomes: TrashRequestOutcome[] = []
  let changed = false
  const out = transact(data, (tx) => {
    let left = TRASH_LIMITS.perDay - movedToday(data, nowTs)
    for (const req of sorted) {
      // 新しい版の依頼は触らない（その版のアプリが処理する）
      if (isNewerTrashRequest(req)) continue
      changed = true
      if (!isTrashRequest(req)) {
        const id = (req as { id: ID }).id
        tx.delete('trashRequests', id)
        outcomes.push({ requestId: id, status: 'invalid' })
        continue
      }
      const base = { requestId: req.id, table: req.table, targetId: req.targetId, label: req.label }
      const rows = tx.data[req.table] as Record<ID, BenchAnalysis | MaterialNote | Idea>
      const card = Object.prototype.hasOwnProperty.call(rows, req.targetId)
        ? (tx.get(req.table, req.targetId) as BenchAnalysis | MaterialNote | Idea | undefined)
        : undefined
      if (!card) {
        tx.delete('trashRequests', req.id)
        outcomes.push({ ...base, status: inTrash(tx.data, req.table, req.targetId) ? 'in_trash' : 'not_found' })
        continue
      }
      const problem = trashTargetProblem(req.table, card, req, tx.data)
      if (problem) {
        tx.delete('trashRequests', req.id)
        outcomes.push({ ...base, status: problem })
        continue
      }
      if (left <= 0) {
        tx.delete('trashRequests', req.id)
        outcomes.push({ ...base, status: 'over_limit' })
        continue
      }
      const ids = trashEntryIdsOf(req.id)
      const opts = { at: nowTs, entryId: ids.entry, recordId: ids.record, by: 'claude' as const }
      if (req.table === 'benchAnalyses') trashBenchAnalysis(tx, card as BenchAnalysis, opts)
      else if (req.table === 'materialNotes') trashMaterialNote(tx, card as MaterialNote, opts)
      else trashIdea(tx, card as Idea, opts)
      tx.delete('trashRequests', req.id)
      left -= 1
      outcomes.push({ ...base, status: 'moved' })
    }
  })
  return changed ? { data: out.data, result: outcomes } : { data, result: [] }
}

const TABLE_NAMES_JA: Record<TrashRequestTable, string> = {
  benchAnalyses: '相対比較の分析',
  materialNotes: '資料の記録',
  ideas: 'アイデア',
}

/** お知らせで表を並べる順 */
const NOTICE_ORDER: readonly TrashRequestTable[] = ['benchAnalyses', 'materialNotes', 'ideas']

const REFUSED_LABELS: Partial<Record<TrashRequestStatus, string>> = {
  not_claude: 'Claude が作ったカードでない',
  edited: '作者が直したカード',
  not_writable: '書き込めない場所のアイデア',
  changed: '依頼の後に直したカード',
  over_limit: '1日の上限（100件）を超えた',
  invalid: '形の違う依頼',
}

/** アイデアの changed（依頼の後に別の仕切りへ移した。分析・記録の changed は REFUSED_LABELS の「依頼の後に直したカード」） */
const CHANGED_IDEA_LABEL = '依頼の後に別の仕切りへ移したアイデア'

/**
 * 処理の後のお知らせ（無ければ空）。例:「Claude の依頼で、相対比較の分析2件・資料の記録1件をゴミ箱へ移しました（30日は
 * ゴミ箱から戻せます）」。移さなかった依頼は理由ごとの数を添える（カードが無い・もうゴミ箱にある依頼は知らせない）
 */
export function trashRequestNotice(outcomes: readonly TrashRequestOutcome[]): string {
  const moved = new Map<TrashRequestTable, number>()
  const refused = new Map<string, number>()
  for (const o of outcomes) {
    if (o.status === 'moved' && o.table) moved.set(o.table, (moved.get(o.table) ?? 0) + 1)
    // アイデアの changed は、依頼の後に作者が別の仕切りへ移した時だけ（済み・並べ替え・本文では changed にならない）。
    // 「直した」と言うと、作者が中身を直したように読めるため
    const label = o.status === 'changed' && o.table === 'ideas' ? CHANGED_IDEA_LABEL : REFUSED_LABELS[o.status]
    if (label) refused.set(label, (refused.get(label) ?? 0) + 1)
  }
  const parts: string[] = []
  if (moved.size) {
    const what = NOTICE_ORDER.filter((t) => moved.has(t))
      .map((t) => `${TABLE_NAMES_JA[t]}${moved.get(t)}件`)
      .join('・')
    parts.push(`Claude の依頼で、${what}をゴミ箱へ移しました（${TRASH_RETENTION_DAYS}日はゴミ箱から戻せます）`)
  }
  if (refused.size) {
    const n = [...refused.values()].reduce((a, b) => a + b, 0)
    const why = [...refused].map(([label, count]) => `${label}${count}件`).join('・')
    parts.push(`Claude の依頼のうち${n}件は移しませんでした（${why}）`)
  }
  return parts.join('。')
}
