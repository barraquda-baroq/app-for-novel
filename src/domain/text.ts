// 文字数カウント。コンテストの規定に合わせやすいよう、空白・改行を除いた文字数を基本にする。

export interface TextStats {
  /** 空白・改行を除いた文字数 */
  chars: number
  /** 改行のみ除いた文字数（空白を含む） */
  charsWithSpaces: number
  /** 行数（改行区切り） */
  lines: number
  /** 400字詰め原稿用紙換算の枚数（1行20字・20行、段落ごとに改行して数える簡易計算） */
  manuscriptPages: number
}

const WHITESPACE = /\s/u

export function countChars(text: string): number {
  let n = 0
  for (const ch of text) if (!WHITESPACE.test(ch)) n += 1
  return n
}

export function textStats(text: string): TextStats {
  let chars = 0
  let withSpaces = 0
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue
    withSpaces += 1
    if (!WHITESPACE.test(ch)) chars += 1
  }
  const paragraphs = text.length === 0 ? [] : text.replace(/\r\n?/g, '\n').split('\n')
  let rows = 0
  for (const p of paragraphs) rows += Math.max(1, Math.ceil(Array.from(p).length / 20))
  return {
    chars,
    charsWithSpaces: withSpaces,
    lines: paragraphs.length,
    manuscriptPages: rows === 0 ? 0 : Math.ceil(rows / 20),
  }
}

export function formatCount(n: number): string {
  return n.toLocaleString('ja-JP')
}
