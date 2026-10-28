// 記号ボタン（ダッシュ・三点リーダー・全角空白・ルビ・傍点）で入れる文字と、入れた後のカーソル位置。
// ルビ・傍点はカクヨム式（src/domain/ruby.ts）。
import type { Sel, Splice } from './history'

export type SymbolKind = 'dash' | 'ellipsis' | 'space' | 'ruby' | 'bouten'

export interface SymbolDef {
  kind: SymbolKind
  /** ボタンに出す文字 */
  label: string
  /** 読み上げ・ツールチップ */
  title: string
}

/** ダッシュは U+2015 を2つ、三点リーダーは U+2026 を2つ（小説の慣例） */
export const DASH = '――'
export const ELLIPSIS = '……'
export const FULL_SPACE = '　'

export const SYMBOLS: readonly SymbolDef[] = [
  { kind: 'dash', label: DASH, title: 'ダッシュ（――）を入れる' },
  { kind: 'ellipsis', label: ELLIPSIS, title: '三点リーダー（……）を入れる' },
  { kind: 'space', label: '空白', title: '全角空白を入れる' },
  { kind: 'ruby', label: 'ルビ', title: 'ルビを振る（選んだ文字に ｜漢字《かんじ》 の形で）' },
  { kind: 'bouten', label: '傍点', title: '傍点を振る（選んだ文字に 《《強調》》 の形で）' },
]

export interface SymbolResult {
  value: string
  selection: Sel
  splice: Splice
}

/**
 * value の選択範囲（start〜end）に記号を入れる。
 * - ダッシュ・三点リーダー・全角空白: 選択範囲を置き換え、カーソルは入れた文字の後ろ
 * - ルビ: 選択あり → ｜選択《》（カーソルは《》の中）／選択なし → ｜《》（カーソルは ｜ の直後。親文字から打つ）
 * - 傍点: 選択あり → 《《選択》》（カーソルは後ろ）／選択なし → 《《》》（カーソルは真ん中）
 */
export function applySymbol(value: string, start: number, end: number, kind: SymbolKind): SymbolResult {
  const a = Math.max(0, Math.min(start, end, value.length))
  const b = Math.max(a, Math.min(Math.max(start, end), value.length))
  const selected = value.slice(a, b)
  let inserted: string
  let caret: number
  switch (kind) {
    case 'dash':
      inserted = DASH
      caret = a + inserted.length
      break
    case 'ellipsis':
      inserted = ELLIPSIS
      caret = a + inserted.length
      break
    case 'space':
      inserted = FULL_SPACE
      caret = a + inserted.length
      break
    case 'ruby':
      if (selected) {
        inserted = `｜${selected}《》`
        caret = a + 1 + selected.length + 1
      } else {
        inserted = '｜《》'
        caret = a + 1
      }
      break
    case 'bouten':
      if (selected) {
        inserted = `《《${selected}》》`
        caret = a + inserted.length
      } else {
        inserted = '《《》》'
        caret = a + 2
      }
      break
  }
  return {
    value: value.slice(0, a) + inserted + value.slice(b),
    selection: { start: caret, end: caret },
    splice: { start: a, removed: selected, inserted },
  }
}
