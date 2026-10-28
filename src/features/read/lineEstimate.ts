// 長い本文を読む画面で、画面の外の話を組版しないための大きさの見積もり。
// 各話に content-visibility: auto を付け、まだ描いていない話は「段落の文字数 ÷ 1行の字数」で見積もった大きさで場所だけ取る
// （300話・数百万字でも開く・縦書きや文字の大きさを切り替える時に全文を組み直さない）。
// 1行の字数（--cpl）は本文の枠の幅（縦書きでは高さ）と文字の大きさから求め、見積もりの計算そのものは CSS で行う。
// ルビ・傍点の記法は、表示される文字（記号とルビの読みを除いた本文）で数える（ルビは行間に収まるので行は増えない）。
import { useLayoutEffect, type CSSProperties, type RefObject } from 'react'
import { strippedBody, stripRuby } from '../../domain/ruby'

export interface LineShape {
  /** 空でない段落の文字数の合計（空白を含む。サロゲートペアは1字） */
  chars: number
  /** 空でない段落の数 */
  paras: number
  /** 空行の数 */
  blank: number
}

const EMPTY: LineShape = { chars: 0, paras: 0, blank: 0 }

/** 本文の段落の形。ルビ・傍点の記法は、表示される文字だけで数える */
export function lineShapeOf(source: string): LineShape {
  return plainLineShape(stripRuby(source))
}

/** 記号とルビの読みを除いた後の本文（stripRuby の結果）の段落の形。除くのは1回だけにする（2回除くと結果が変わることがある） */
function plainLineShape(text: string): LineShape {
  if (text.length === 0) return EMPTY
  let chars = 0
  let paras = 0
  let blank = 0
  let len = 0
  const end = () => {
    if (len > 0) {
      paras += 1
      chars += len
    } else blank += 1
    len = 0
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) !== 0x0a) end()
      continue
    }
    if (c === 0x0a) {
      end()
      continue
    }
    // サロゲートペアの後半は数えない
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const h = text.charCodeAt(i - 1)
      if (h >= 0xd800 && h <= 0xdbff) continue
    }
    len += 1
  }
  // 末尾の改行の後ろは段落として数えない
  if (len > 0) end()
  return { chars, paras, blank }
}

const cache = new WeakMap<object, LineShape>()

/**
 * 本文を持つ不変のレコード（推敲バージョン・本文の控え）の段落の形。レコードごとに1回だけ数える。
 * 記号と読みを除いた本文は、通し読みの遠くの話の表示と分け合う（strippedBody）
 */
export function lineShape(record: { body: string }): LineShape {
  let s = cache.get(record)
  if (!s) {
    s = plainLineShape(strippedBody(record))
    cache.set(record, s)
  }
  return s
}

/** 見積もりに使う CSS 変数（--ls-chars / --ls-paras / --ls-blank） */
export function lineShapeStyle(shape: LineShape): CSSProperties {
  return { '--ls-chars': shape.chars, '--ls-paras': shape.paras, '--ls-blank': shape.blank } as CSSProperties
}

/** 1行（縦書きでは1列）に入る字数 */
export function charsPerLine(inlineSize: number, fontSize: number, letterSpacingEm = 0): number {
  if (!(inlineSize > 0) || !(fontSize > 0)) return 40
  return Math.max(1, Math.floor(inlineSize / (fontSize * (1 + letterSpacingEm))))
}

/**
 * 本文の枠（ref）の内側の行の長さ（横書きは幅、縦書きは高さ）から1行の字数を求め、枠に --cpl として入れる。
 * React の再描画は起こさない。deps（文字の大きさ・書字方向など）が変わった時も入れ直す。
 * 本文の文字の大きさが枠と違う時は fontSizePx で渡す（省くと枠の文字の大きさ）。
 */
export function useCharsPerLine(
  ref: RefObject<HTMLElement | null>,
  letterSpacingEm: number,
  deps: unknown[],
  fontSizePx?: number,
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let inline = 0
    const apply = () => {
      const fontSize = fontSizePx ?? parseFloat(getComputedStyle(el).fontSize)
      el.style.setProperty('--cpl', String(charsPerLine(inline, fontSize, letterSpacingEm)))
    }
    const measure = () => {
      const cs = getComputedStyle(el)
      const vertical = cs.writingMode.startsWith('vertical') || cs.writingMode.startsWith('sideways')
      const pad = vertical
        ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
        : parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      inline = (vertical ? el.clientHeight : el.clientWidth) - pad
    }
    if (typeof ResizeObserver === 'undefined') {
      measure()
      apply()
      return
    }
    // 大きさは ResizeObserver で受け取る（開いた直後に全体を組み直さないよう、自分では測らない）
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentBoxSize?.[0]
      if (box) inline = box.inlineSize
      else measure()
      apply()
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
