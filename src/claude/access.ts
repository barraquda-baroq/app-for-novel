// タイトルを Claude（コネクタ）に見せるか（Title.claudeAccess）の値と、読める・書き込めるの判定。
// 型だけを読み込む小さな部品。見せる内容（visibility.ts）と、アイデアへの追記の部品（ideaAppend.ts）の両方が使う
// （visibility.ts は ideaAppend.ts を読み込むので、ideaAppend.ts が visibility.ts を読み込むと輪になる。trashTargets.ts と同じ考え）。
// visibility.ts からも同じ名前で読み込める（前からの読み込みはそのまま）。
import type { ClaudeAccess, Title } from '../domain/types'

export const CLAUDE_ACCESS_VALUES: readonly ClaudeAccess[] = ['none', 'read', 'write']

/** 無い = 'write'。知らない値（新しい版が書いたもの）は安全側の 'none' */
export function claudeAccessOf(title: Pick<Title, 'claudeAccess'> | null | undefined): ClaudeAccess {
  if (!title) return 'none'
  const v = title.claudeAccess
  if (v === undefined) return 'write'
  return (CLAUDE_ACCESS_VALUES as readonly unknown[]).includes(v) ? v : 'none'
}

/** Claude が読める（read・write） */
export function canClaudeRead(title: Pick<Title, 'claudeAccess'> | null | undefined): boolean {
  return claudeAccessOf(title) !== 'none'
}

/** Claude が推敲案などを書き込める（write） */
export function canClaudeWrite(title: Pick<Title, 'claudeAccess'> | null | undefined): boolean {
  return claudeAccessOf(title) === 'write'
}
