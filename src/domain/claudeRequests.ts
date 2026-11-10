// Claude の依頼（2.8）をアプリで1回の処理で当てる: アイデアへの追記の依頼（domain/claudeIdeas.ts）を先に、ゴミ箱へ移す依頼
// （domain/claudeTrash.ts）を後に。同期を受け持つ画面がクラウドと揃った時に呼ぶ（src/features/claude/ClaudeTrashRequests.tsx）。
// 追記を先にするので「作る → 追記 → ゴミ箱へ移す」と頼まれたアイデアは、追記した後の形でゴミ箱へ入る（Claude が見ていた形と同じ。
// Claude の追記は「作者が直した」に数えないので、直していないカードは追記の後も移せる）。逆の順（移す依頼の後の追記）は、コネクタが
// 依頼中のアイデアを見せないので作られない（届いても、アイデアがもうゴミ箱にあるので黙って消す）。
import { applyIdeaAppends, ideaAppendNotice, type IdeaAppendOutcome } from './claudeIdeas'
import { applyTrashRequests, trashRequestNotice, type TrashRequestOutcome } from './claudeTrash'
import type { AppData } from './types'

export interface ClaudeRequestsResult {
  /** アイデアへの追記の依頼の結果 */
  appends: IdeaAppendOutcome[]
  /** ゴミ箱へ移す依頼の結果 */
  trash: TrashRequestOutcome[]
}

/** 依頼を当てる（追記が先、ゴミ箱へ移すのが後）。どちらも何も変えなければ、元の data をそのまま返す */
export function applyClaudeRequests(data: AppData, nowTs: number): { data: AppData; result: ClaudeRequestsResult } {
  const appends = applyIdeaAppends(data, nowTs)
  const trash = applyTrashRequests(appends.data, nowTs)
  return { data: trash.data, result: { appends: appends.result, trash: trash.result } }
}

/** 処理の後のお知らせ（追記とゴミ箱へ移した分を「。」でつなぐ。無ければ空） */
export function claudeRequestNotice(r: ClaudeRequestsResult): string {
  return [ideaAppendNotice(r.appends), trashRequestNotice(r.trash)].filter(Boolean).join('。')
}
