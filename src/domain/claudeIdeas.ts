// アイデアへの追記の依頼（2.8。IdeaAppend）をアプリで処理する。Claude（コネクタ）は依頼を作るだけで、カードに足すのはアプリ
// （同期を受け持つ画面でクラウドと揃った時に、ゴミ箱へ移す依頼と一緒に当てる）。
// 1件ずつ確かめてから（src/claude/ideaAppend.ts の ideaAppendProblem。Claude に見せる内容と同じ確かめ方・同じ順）、カードの終わりに
// 空行を置いて「2026/11/12のセッションで以下の内容へ変更」の行と内容を足し、依頼を消す:
// - Claude がコネクタで作ったアイデア（isClaudeIdea）で、書き込める場所（ホームか「読む＋書き込む」のタイトル）にあること
// - 同じ依頼を2回足さない（足した依頼の id を appendIds に残す。2台の端末が別々に当てても、同期で1回にまとまる）
// - 作者が直したカードにも足す（前の中身は消さない）。並び・済み・場所・見出しは変えない
// - 新しい版のコネクタが書いた依頼は触らずに残す
// 足す行の日付は依頼を作った時（コネクタの時計）の日本時間なので、どの端末がいつ処理しても、足した後の本文は1字も違わない。
import { ideaAppendProblem, isIdeaAppend, isNewerIdeaAppend, withIdeaAppend } from '../claude/ideaAppend'
import { trashLabel } from './trash'
import { transact, type Tx } from './tx'
import type { AppData, ID, Idea, IdeaAppend } from './types'

/**
 * 依頼1件の結果。appended = カードの終わりに足した、applied = もう足してあった（別の端末が先に足した）、
 * not_found = アイデアが無い、in_trash = アイデアはゴミ箱にある、not_claude = Claude が作ったアイデアでない、
 * not_writable = 書き込めない場所のアイデア、too_long = 足すと1枚が長くなりすぎる、invalid = 依頼の形が違う
 */
export type IdeaAppendStatus =
  | 'appended'
  | 'applied'
  | 'not_found'
  | 'in_trash'
  | 'not_claude'
  | 'not_writable'
  | 'too_long'
  | 'invalid'

export interface IdeaAppendOutcome {
  requestId: ID
  status: IdeaAppendStatus
  ideaId?: ID
  label?: string
}

/** ゴミ箱の中身に、この id のアイデアがあるか */
function ideaInTrash(data: AppData, id: ID): boolean {
  for (const r of Object.values(data.trashRecords))
    if (r.table === 'ideas' && (r.record as { id?: unknown } | undefined)?.id === id) return true
  return false
}

/** 依頼の指すアイデア（自分の項目だけ。'constructor' などの id で Object の中身を拾わない） */
function ideaOf(tx: Tx, id: ID): Idea | undefined {
  return Object.prototype.hasOwnProperty.call(tx.data.ideas, id) ? tx.get('ideas', id) : undefined
}

/** 依頼1件の結果と、足した後のアイデア（足す時だけ。まだ書かない） */
function appendStep(
  data: AppData,
  idea: Idea | undefined,
  req: IdeaAppend,
  nowTs: number,
): { outcome: IdeaAppendOutcome; next?: Idea } {
  const problem = ideaAppendProblem(data.titles, idea, req)
  if (!idea || problem === 'not_found')
    return {
      outcome: { requestId: req.id, ideaId: req.ideaId, status: ideaInTrash(data, req.ideaId) ? 'in_trash' : 'not_found' },
    }
  const base = { requestId: req.id, ideaId: idea.id, label: trashLabel.idea(idea) }
  if (problem) return { outcome: { ...base, status: problem } }
  return { outcome: { ...base, status: 'appended' }, next: { ...withIdeaAppend(idea, req), updatedAt: nowTs } }
}

const createdAtOf = (r: unknown) => {
  const v = (r as { createdAt?: unknown } | null | undefined)?.createdAt
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 依頼を処理する（作った順。同じ時刻なら id の順）。同じアイデアへの2件目は、1件目を足した本文に足す（Claude に見せる内容の
 * overlayIdeaAppends と同じ）。何も変わらなければ、元の data をそのまま返す
 */
export function applyIdeaAppends(data: AppData, nowTs: number): { data: AppData; result: IdeaAppendOutcome[] } {
  // 形の違う行も消せるように、表の鍵（id）で並べて扱う
  const rows = Object.entries(data.ideaAppends ?? {})
  if (!rows.length) return { data, result: [] }
  rows.sort(([ka, a], [kb, b]) => createdAtOf(a) - createdAtOf(b) || (ka < kb ? -1 : ka > kb ? 1 : 0))
  const outcomes: IdeaAppendOutcome[] = []
  let changed = false
  const out = transact(data, (tx) => {
    for (const [key, req] of rows) {
      // 新しい版の依頼は触らない（その版のアプリが処理する）
      if (isNewerIdeaAppend(req)) continue
      changed = true
      tx.delete('ideaAppends', key)
      if (!isIdeaAppend(req) || req.id !== key) {
        outcomes.push({ requestId: key, status: 'invalid' })
        continue
      }
      // 確かめと足した形は書く前に作る。1件の依頼で投げても、その依頼だけ形の違う依頼として消し、ほかの依頼・ゴミ箱へ移す依頼は続ける
      let step: { outcome: IdeaAppendOutcome; next?: Idea }
      try {
        step = appendStep(tx.data, ideaOf(tx, req.ideaId), req, nowTs)
      } catch {
        step = { outcome: { requestId: req.id, ideaId: req.ideaId, status: 'invalid' } }
      }
      if (step.next) tx.put('ideas', step.next)
      outcomes.push(step.outcome)
    }
  })
  return changed ? { data: out.data, result: outcomes } : { data, result: [] }
}

const REFUSED_LABELS: Partial<Record<IdeaAppendStatus, string>> = {
  not_claude: 'Claude が作ったアイデアでない',
  not_writable: '書き込めない場所のアイデア',
  too_long: '長くなりすぎる',
  invalid: '形の違う依頼',
}

/**
 * 処理の後のお知らせ（無ければ空）。例:「Claude の依頼で、アイデア「2026/11/12 14:32　第3章の動機」の終わりに追記しました」
 * （2つ以上のアイデアなら「アイデア2件の終わりに」）。足さなかった依頼は理由ごとの数を添える（アイデアが無い・ゴミ箱にある・
 * もう足してあった依頼は知らせない）
 */
export function ideaAppendNotice(outcomes: readonly IdeaAppendOutcome[]): string {
  const ideas = new Map<ID, string>()
  const refused = new Map<string, number>()
  for (const o of outcomes) {
    if (o.status === 'appended' && o.ideaId && !ideas.has(o.ideaId)) ideas.set(o.ideaId, o.label ?? '')
    const label = REFUSED_LABELS[o.status]
    if (label) refused.set(label, (refused.get(label) ?? 0) + 1)
  }
  const parts: string[] = []
  if (ideas.size === 1) parts.push(`Claude の依頼で、アイデア「${[...ideas.values()][0]}」の終わりに追記しました`)
  else if (ideas.size > 1) parts.push(`Claude の依頼で、アイデア${ideas.size}件の終わりに追記しました`)
  if (refused.size) {
    const n = [...refused.values()].reduce((a, b) => a + b, 0)
    const why = [...refused].map(([label, count]) => `${label}${count}件`).join('・')
    parts.push(`Claude の追記の依頼のうち${n}件は足しませんでした（${why}）`)
  }
  return parts.join('。')
}
