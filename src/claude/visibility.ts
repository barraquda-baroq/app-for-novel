// タイトルを Claude（コネクタ）に見せるか（Title.claudeAccess）。
// - 無い = write（読む＋書き込む）。個人のアプリで、原稿を Claude に見てもらうのが前提のため
// - none = 見せない（コネクタのどのツールにも出ない）、read = 読むだけ、write = 読む＋推敲案などを足す
// アクセスルールではタイトルごとに分けられない（タイトルの id は文書の JSON の中にある）ので、コネクタのコードで守る。
// ゴミ箱・応募時の原稿の控え・どのタイトルにも属さないアイデアは、どのタイトルの設定でも見せない。
// ベンチ作品とその分析（2.5）はどのタイトルにも属さない利用者の覚え書きなので、タイトルの設定とは関係なく見せる。
import { emptyData, type AppData, type ClaudeAccess, type TableName, type Title } from '../domain/types'

export const CLAUDE_ACCESS_VALUES: readonly ClaudeAccess[] = ['none', 'read', 'write']

/** タイトルの設定の選択肢（「Claude に見せる: 見せない／読むだけ／読む＋書き込む」） */
export const CLAUDE_ACCESS_OPTIONS: readonly { value: ClaudeAccess; label: string }[] = [
  { value: 'none', label: '見せない' },
  { value: 'read', label: '読むだけ' },
  { value: 'write', label: '読む＋書き込む' },
]

/** 無い = 'write'。知らない値（新しい版が書いたもの）は安全側の 'none' */
export function claudeAccessOf(title: Pick<Title, 'claudeAccess'> | null | undefined): ClaudeAccess {
  if (!title) return 'none'
  const v = title.claudeAccess
  if (v === undefined) return 'write'
  return (CLAUDE_ACCESS_VALUES as readonly unknown[]).includes(v) ? v : 'none'
}

export function claudeAccessLabel(access: ClaudeAccess): string {
  return CLAUDE_ACCESS_OPTIONS.find((o) => o.value === access)?.label ?? '見せない'
}

/** Claude が読める（read・write） */
export function canClaudeRead(title: Pick<Title, 'claudeAccess'> | null | undefined): boolean {
  return claudeAccessOf(title) !== 'none'
}

/** Claude が推敲案などを書き込める（write） */
export function canClaudeWrite(title: Pick<Title, 'claudeAccess'> | null | undefined): boolean {
  return claudeAccessOf(title) === 'write'
}

/** どのタイトルの設定でも見せない表 */
const NEVER_SERVED: ReadonlySet<TableName> = new Set<TableName>(['snapshotTexts', 'trashEntries', 'trashRecords'])

/** タイトルの設定と関係なく、いつも見せる表（ベンチ作品とその分析） */
const ALWAYS_SERVED: ReadonlySet<TableName> = new Set<TableName>(['benchWorks', 'benchAnalyses'])

/**
 * コネクタに見せる内容。見せないタイトル（none）と、その配下のレコード（titleId で見る）を除き、
 * ゴミ箱・応募時の原稿の控え・どのタイトルにも属さないアイデアも除く。共通の批評プロンプト（titleId = null）と
 * ベンチ作品・その分析は見せる。
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
