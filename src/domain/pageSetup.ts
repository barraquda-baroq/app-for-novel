// 縦書きのページ表示（通し読み）の、タイトルごとの字数×行数（Title.pageSetup）。
// 一太郎の「文字数×行数」にならい、1行の字数と1ページの行数を決める。無い = 40字×32行。
// 型（PageSetup）は types.ts、組み方（ページに分ける）は src/features/read/verticalPages.ts。
import type { PageSetup, Title } from './types'

export type { PageSetup }

/** 既定（タイトルに設定が無い時） */
export const DEFAULT_PAGE_SETUP: Readonly<PageSetup> = Object.freeze({ chars: 40, lines: 32 })

/** 選べる字数×行数（並びのまま出す） */
export const PAGE_SETUP_PRESETS: readonly Readonly<PageSetup>[] = Object.freeze([
  { chars: 20, lines: 20 },
  { chars: 40, lines: 30 },
  { chars: 40, lines: 32 },
  { chars: 40, lines: 40 },
  { chars: 42, lines: 34 },
])

/** 自由に入れる時の範囲（字数・行数とも整数） */
export const PAGE_CHARS_MIN = 10
export const PAGE_CHARS_MAX = 60
export const PAGE_LINES_MIN = 5
export const PAGE_LINES_MAX = 60

const inRange = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max

/** 範囲の中の字数×行数か（同期・バックアップで届いた値もこれで確かめる） */
export function isValidPageSetup(v: unknown): v is PageSetup {
  if (!v || typeof v !== 'object') return false
  const s = v as { chars?: unknown; lines?: unknown }
  return inRange(s.chars, PAGE_CHARS_MIN, PAGE_CHARS_MAX) && inRange(s.lines, PAGE_LINES_MIN, PAGE_LINES_MAX)
}

/** タイトルの字数×行数。無い・範囲の外・壊れた値なら既定（40×32） */
export function pageSetupOf(title: Pick<Title, 'pageSetup'> | null | undefined): PageSetup {
  const v = title?.pageSetup
  return isValidPageSetup(v) ? { chars: v.chars, lines: v.lines } : { ...DEFAULT_PAGE_SETUP }
}

/** タイトルが字数×行数を決めているか（無い・壊れた値なら false = 既定を使っている） */
export function hasPageSetup(title: Pick<Title, 'pageSetup'> | null | undefined): boolean {
  return isValidPageSetup(title?.pageSetup)
}

export function samePageSetup(a: PageSetup, b: PageSetup): boolean {
  return a.chars === b.chars && a.lines === b.lines
}

/** 選べる字数×行数の1つか */
export function isPresetPageSetup(s: PageSetup): boolean {
  return PAGE_SETUP_PRESETS.some((p) => samePageSetup(p, s))
}

/** 「40×32」（選ぶ欄の表示） */
export function pageSetupLabel(s: PageSetup): string {
  return `${s.chars}×${s.lines}`
}

/** 「40字×32行」（読み上げ・知らせ） */
export function pageSetupLongLabel(s: PageSetup): string {
  return `${s.chars}字×${s.lines}行`
}

/** 入力欄の数（全角の数字・前後の空白も読む）。整数でなければ null */
function readInt(input: string | number): number | null {
  if (typeof input === 'number') return Number.isInteger(input) ? input : null
  const s = input.normalize('NFKC').trim()
  return /^\d{1,4}$/.test(s) ? Number(s) : null
}

export type PageSetupCheck = { ok: true; setup: PageSetup } | { ok: false; message: string }

/**
 * 自由に入れた字数・行数を確かめる（全角の数字も読む）。範囲の外・数でなければ、画面に出す言い方で返す
 */
export function checkPageSetup(chars: string | number, lines: string | number): PageSetupCheck {
  const c = readInt(chars)
  if (c === null || c < PAGE_CHARS_MIN || c > PAGE_CHARS_MAX)
    return { ok: false, message: `1行の字数は ${PAGE_CHARS_MIN}〜${PAGE_CHARS_MAX} の数で入れてください` }
  const l = readInt(lines)
  if (l === null || l < PAGE_LINES_MIN || l > PAGE_LINES_MAX)
    return { ok: false, message: `1ページの行数は ${PAGE_LINES_MIN}〜${PAGE_LINES_MAX} の数で入れてください` }
  return { ok: true, setup: { chars: c, lines: l } }
}

/**
 * 「40×32」「40x32」「４０×３２」「40字×32行」のような1つの入力欄の字数×行数を読む。
 * 読めなければ、画面に出す言い方で返す
 */
export function parsePageSetup(input: string): PageSetupCheck {
  const s = input.normalize('NFKC').trim()
  const m = /^(\d{1,4})\s*字?\s*[x×*]\s*(\d{1,4})\s*行?$/i.exec(s)
  if (!m) return { ok: false, message: '「40×32」のように、字数×行数で入れてください' }
  return checkPageSetup(m[1], m[2])
}
