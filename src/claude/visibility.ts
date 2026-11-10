// タイトルを Claude（コネクタ）に見せるか（Title.claudeAccess）。
// - 無い = write（読む＋書き込む）。個人のアプリで、原稿を Claude に見てもらうのが前提のため
// - none = 見せない（コネクタのどのツールにも出ない）、read = 読むだけ、write = 読む＋推敲案などを足す
// アクセスルールではタイトルごとに分けられない（タイトルの id は文書の JSON の中にある）ので、コネクタのコードで守る。
// ゴミ箱・応募時の原稿の控え・どのタイトルにも属さないアイデアは、どのタイトルの設定でも見せない。
// ベンチ作品とその分析（2.5）はどのタイトルにも属さない利用者の覚え書きなので、タイトルの設定とは関係なく見せる。
// 資料とその記録（2.6）も同じく、タイトルの設定とは関係なく見せる。
// ゴミ箱へ移す依頼（2.7）は見せ、依頼の出ているカード（相対比較の分析・資料の記録）は見せない（アプリが同期してゴミ箱へ移すまで、
// Claude からはもう無いものとして扱う。trashTargets.ts）。
import { emptyData, type AppData, type ClaudeAccess, type TableName } from '../domain/types'
import { canClaudeRead } from './access'
import { pendingTrashTargets, trashTargetKey, TRASH_TARGET_TABLES } from './trashTargets'

// 値と判定は access.ts（型だけを読み込む部品）にある。前からの読み込みのために、ここからも同じ名前で出す
export { CLAUDE_ACCESS_VALUES, canClaudeRead, canClaudeWrite, claudeAccessOf } from './access'

/** タイトルの設定の選択肢（「Claude に見せる: 見せない／読むだけ／読む＋書き込む」） */
export const CLAUDE_ACCESS_OPTIONS: readonly { value: ClaudeAccess; label: string }[] = [
  { value: 'none', label: '見せない' },
  { value: 'read', label: '読むだけ' },
  { value: 'write', label: '読む＋書き込む' },
]

export function claudeAccessLabel(access: ClaudeAccess): string {
  return CLAUDE_ACCESS_OPTIONS.find((o) => o.value === access)?.label ?? '見せない'
}

/** どのタイトルの設定でも見せない表 */
const NEVER_SERVED: ReadonlySet<TableName> = new Set<TableName>(['snapshotTexts', 'trashEntries', 'trashRecords'])

/** タイトルの設定と関係なく、いつも見せる表（ベンチ作品とその分析、資料とその記録、ゴミ箱へ移す依頼） */
const ALWAYS_SERVED: ReadonlySet<TableName> = new Set<TableName>([
  'benchWorks',
  'benchAnalyses',
  'materials',
  'materialNotes',
  'trashRequests',
])

/**
 * コネクタに見せる内容。見せないタイトル（none）と、その配下のレコード（titleId で見る）を除き、
 * ゴミ箱・応募時の原稿の控え・どのタイトルにも属さないアイデアも除く。共通の批評プロンプト（titleId = null）と
 * ベンチ作品・その分析、資料・その記録は見せる（ゴミ箱へ移す依頼の出ているカードは除く）。
 * 変わらない表は同じオブジェクトのまま返す
 */
export function claudeView(data: AppData): AppData {
  const out = emptyData() as unknown as Record<TableName, Record<string, unknown>>
  const visible = new Set(
    Object.values(data.titles)
      .filter((t) => canClaudeRead(t))
      .map((t) => t.id),
  )
  for (const table of Object.keys(data) as TableName[]) {
    if (NEVER_SERVED.has(table)) continue
    if (ALWAYS_SERVED.has(table)) {
      out[table] = data[table] as Record<string, unknown>
      continue
    }
    const rows = data[table] as Record<string, { titleId?: unknown; id: string }>
    if (table === 'titles') {
      out.titles = visible.size === Object.keys(rows).length ? rows : pick(rows, (r) => visible.has(r.id))
      continue
    }
    let all = true
    const keep = (r: { titleId?: unknown }) => {
      const t = r.titleId
      // 共通の批評プロンプトだけは、どのタイトルにも属さなくても見せる
      if (t === null) return table === 'critiquePrompts'
      return typeof t === 'string' && visible.has(t)
    }
    for (const r of Object.values(rows))
      if (!keep(r)) {
        all = false
        break
      }
    out[table] = all ? rows : pick(rows, keep)
  }
  const pending = pendingTrashTargets(data)
  if (pending.size)
    for (const table of TRASH_TARGET_TABLES) {
      const rows = out[table] as Record<string, { id: string }>
      if (Object.keys(rows).some((id) => pending.has(trashTargetKey(table, id))))
        out[table] = pick(rows, (r) => !pending.has(trashTargetKey(table, r.id)))
    }
  return out as unknown as AppData
}

function pick<T>(rows: Record<string, T>, keep: (r: T) => boolean): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [id, r] of Object.entries(rows)) if (keep(r)) out[id] = r
  return out
}

/** このアプリが知っている記録の形の版 */
export const CLAUDE_RECORD_VERSION = 1

/** 新しい版のコネクタ・アプリが書いた記録（形が違うかもしれないので「新しいコネクタの記録」として出す） */
export function isNewerRecord(r: { v?: unknown }): boolean {
  return typeof r.v === 'number' && r.v > CLAUDE_RECORD_VERSION
}

export const NEWER_RECORD_LABEL = '新しいコネクタの記録'
