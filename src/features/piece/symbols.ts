// 記号ボタン（ダッシュ・三点リーダー・全角空白・括弧・ルビ・傍点）で入れる文字と、入れた後のカーソル位置。
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

/** 括弧（記号バーの「括弧」の一覧で選ぶ） */
export type BracketKind = 'kagi' | 'nijukagi' | 'maru' | 'yama' | 'nonome'

export interface BracketDef {
  kind: BracketKind
  open: string
  close: string
  /** 読み上げ・ツールチップ */
  name: string
}

/**
 * 一覧の並び（この順で固定。最後に使ったものを先頭にはしない）。
 * 《》はルビ・傍点の書き方と重なるので入れない。〝〟の閉じは U+301F（U+301E ではない）
 */
export const BRACKETS: readonly BracketDef[] = [
  { kind: 'kagi', open: '「', close: '」', name: 'かぎ括弧' },
  { kind: 'nijukagi', open: '『', close: '』', name: '二重かぎ括弧' },
  { kind: 'maru', open: '（', close: '）', name: '丸括弧' },
  { kind: 'yama', open: '〈', close: '〉', name: '山括弧' },
  { kind: 'nonome', open: '〝', close: '〟', name: 'ちょんちょん括弧' },
]

/** 記号バーで入れられるもの（記号と括弧） */
export type InsertKind = SymbolKind | BracketKind

/** 記号バーのボタンの並び。brackets は「括弧」（押すと一覧。空白とルビの間） */
export const TOOLBAR: readonly (SymbolKind | 'brackets')[] = ['dash', 'ellipsis', 'space', 'brackets', 'ruby', 'bouten']

const BRACKET_OF: ReadonlyMap<InsertKind, BracketDef> = new Map(BRACKETS.map((b) => [b.kind, b]))

export const isBracketKind = (kind: InsertKind): kind is BracketKind => BRACKET_OF.has(kind)

export interface SymbolResult {
  value: string
  selection: Sel
  splice: Splice
}

/**
 * 括弧: 選択なし → 組を入れてカーソルは間／選択あり → 選んだ文字を囲み、カーソルは閉じ括弧の後ろ。
 * 選んだ範囲の終わりの改行（段落をまるごと選んだ時など）は囲まずに、閉じ括弧の後ろに残す。
 * 改行だけを選んでいた時は、選んでいない時と同じ（範囲の初めに組を入れる。改行は消さない）
 */
function applyBracket(value: string, a: number, b: number, def: BracketDef): SymbolResult {
  const core = value.slice(a, b).replace(/\n+$/, '')
  const inserted = `${def.open}${core}${def.close}`
  const caret = core ? a + inserted.length : a + def.open.length
  return {
    value: value.slice(0, a) + inserted + value.slice(a + core.length),
    selection: { start: caret, end: caret },
    splice: { start: a, removed: core, inserted },
  }
}

/**
 * value の選択範囲（start〜end）に記号を入れる。
 * - ダッシュ・三点リーダー・全角空白: 選択範囲を置き換え、カーソルは入れた文字の後ろ
 * - 括弧: 選択なし → 組（「」など）を入れ、カーソルは間／選択あり → 選んだ文字を囲む（カーソルは後ろ）
 * - ルビ: 選択あり → ｜選択《》（カーソルは《》の中）／選択なし → ｜《》（カーソルは ｜ の直後。親文字から打つ）
 * - 傍点: 選択あり → 《《選択》》（カーソルは後ろ）／選択なし → 《《》》（カーソルは真ん中）
 */
export function applySymbol(value: string, start: number, end: number, kind: InsertKind): SymbolResult {
  const a = Math.max(0, Math.min(start, end, value.length))
  const b = Math.max(a, Math.min(Math.max(start, end), value.length))
  if (isBracketKind(kind)) return applyBracket(value, a, b, BRACKET_OF.get(kind)!)
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
