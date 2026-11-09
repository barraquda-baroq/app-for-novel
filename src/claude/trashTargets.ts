// ゴミ箱へ移す依頼（2.7。TrashRequest）の形と、依頼の出ているカード。コネクタの見せる内容（visibility.ts の claudeView）・
// 自動のタグ（domain/benchTags.ts）・依頼の作成（trashRequest.ts）・アプリの処理（domain/claudeTrash.ts）で同じものを使う。
// visibility.ts から読み込むので、ほかの部品（benchOps・trash.ts など）は読み込まない（読み込みが輪にならないように）。
import type { AppData, ID, TrashRequest, TrashRequestTable } from '../domain/types'

/** このアプリ・コネクタが知っている依頼の形の版 */
export const TRASH_REQUEST_VERSION = 1

/** 依頼で移せるカードの表（相対比較の分析と資料の記録だけ。作品・資料そのものは移さない） */
export const TRASH_TARGET_TABLES: readonly TrashRequestTable[] = ['benchAnalyses', 'materialNotes']

export function isTrashTargetTable(v: unknown): v is TrashRequestTable {
  return typeof v === 'string' && (TRASH_TARGET_TABLES as readonly string[]).includes(v)
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 依頼の形が正しいか（版は問わない。新しい版の依頼は isNewerTrashRequest で見分ける） */
export function isTrashRequest(r: unknown): r is TrashRequest {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const x = r as Record<string, unknown>
  return (
    isStr(x.id) &&
    isTrashTargetTable(x.table) &&
    isStr(x.targetId) &&
    isStr(x.parentId) &&
    isNum(x.targetUpdatedAt) &&
    typeof x.label === 'string' &&
    x.source === 'claude' &&
    isNum(x.v) &&
    isNum(x.createdAt) &&
    isNum(x.updatedAt)
  )
}

/** 新しい版のコネクタが書いた依頼（形が違うかもしれないので、アプリは触らずに残す） */
export function isNewerTrashRequest(r: unknown): boolean {
  const v = (r as { v?: unknown } | null | undefined)?.v
  return typeof v === 'number' && v > TRASH_REQUEST_VERSION
}

/** 依頼の対象の印（「benchAnalyses:id」） */
export const trashTargetKey = (table: TrashRequestTable, id: ID): string => `${table}:${id}`

/** 形が正しく、知っている版の依頼（作った順） */
export function liveTrashRequests(data: Pick<AppData, 'trashRequests'>): TrashRequest[] {
  return Object.values(data.trashRequests ?? {})
    .filter((r) => isTrashRequest(r) && !isNewerTrashRequest(r))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 依頼の出ているカード（trashTargetKey の集まり）。表の参照で覚えておかない（コネクタの写しは表をその場で書き換えるため）。
 * 依頼はアプリが処理すると消えるので、数は少ない
 */
export function pendingTrashTargets(data: Pick<AppData, 'trashRequests'>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const r of liveTrashRequests(data)) out.add(trashTargetKey(r.table, r.targetId))
  return out
}

/** 作品（資料）ごとの、依頼の出ているカードの数（作品・資料の一覧の「ゴミ箱へ移す依頼中 n件」） */
export function pendingTrashCount(data: Pick<AppData, 'trashRequests'>, table: TrashRequestTable, parentId: ID): number {
  const seen = new Set<string>()
  for (const r of liveTrashRequests(data)) if (r.table === table && r.parentId === parentId) seen.add(r.targetId)
  return seen.size
}

/** 「  ゴミ箱へ移す依頼中 2件（アプリが同期すると移ります）」の行（作品・資料の一覧の行。依頼が無ければ空） */
export function pendingTrashLine(count: number): string {
  return count ? `  ゴミ箱へ移す依頼中 ${count}件（アプリが同期すると移ります）` : ''
}
