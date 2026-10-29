// ツールの結果の共通の道具。結果はいつも日本語のテキスト（原稿は structuredContent に入れない）、10万字まで。
import { resolveTitle } from '../../../../src/claude/refs'
import type { AppData, Title } from '../../../../src/domain/types'

export interface ToolResult {
  text: string
  isError?: boolean
  /** 書き込みツールだけ（作った記録の id と表記・飛ばした理由。原稿は入れない） */
  structured?: Record<string, unknown>
  /** 認証の問題（連携の解除・身元を失った）: MCP の呼び出しを HTTP 401 にする */
  auth?: boolean
}

/** 結果の上限（claude.ai は約15万字。余裕を見て10万字） */
export const RESULT_LIMIT = 100_000

/** 長すぎる結果を、行の切れ目で切る */
export function capText(text: string, limit = RESULT_LIMIT): string {
  if (text.length <= limit) return text
  const room = limit - 120
  let cut = text.lastIndexOf('\n', room)
  if (cut < room / 2) cut = room
  // サロゲートペアの途中で切らない
  const c = text.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1
  return `${text.slice(0, cut)}\n[...]（結果が長いため、ここで切りました。範囲を狭めるか、cursor で続きを読んでください）`
}

export function ok(text: string): ToolResult {
  return { text: capText(text) }
}

export function fail(message: string, candidates?: readonly string[]): ToolResult {
  const list = candidates && candidates.length ? `\n候補:\n${candidates.map((c) => `- ${c}`).join('\n')}` : ''
  return { text: capText(`${message}${list}`), isError: true }
}

/** 入力の文字列（無い・空なら undefined） */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

export function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/** title_id を読む（見せているタイトルの中から） */
export function titleArg(view: AppData, ref: unknown): { title: Title } | { error: ToolResult } {
  const r = str(ref)
  if (!r) return { error: fail('title_id がありません（novel_list_titles で t:… を確かめてください）') }
  const t = resolveTitle(view, r)
  if (!t.ok)
    return {
      error: fail(
        `${t.message}（Claude に見せていないタイトルは使えません。アプリのタイトルの設定「Claude に見せる」を確かめてください）`,
        t.candidates,
      ),
    }
  return { title: t.value }
}

/** 先頭 n 字（改行は空白に。切ったら [...]） */
export function head(text: string, n = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > n ? `${chars.slice(0, n).join('')}[...]` : one
}

/** 文字数（コードポイント） */
export function length(text: string): number {
  return Array.from(text).length
}
