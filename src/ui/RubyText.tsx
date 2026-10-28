// ルビ・傍点の記法（カクヨム式 ｜漢字《かんじ》・漢字《かんじ》・《《傍点》》）を、読むための表示にする。
// 通し読み・応募時の原稿・一覧の抜粋など、読むだけの所で使う（編集欄では記法のまま見せる）。
// 書き出し・コピーは記法のまま（data の本文）なので、ここでは表示だけを変える。
// 画面の文字を選んでコピーした時は親文字だけになる（ルビの読みは選べないようにしてある。ruby.css）。
import { Fragment, memo, type RefObject } from 'react'
import { hasRubyMarkup, parseRuby, stripRuby, type RubySegment } from '../domain/ruby'
import { useNearViewport } from './nearViewport'
import './ruby.css'

/** 分けた本文（parseRuby の結果）をそのまま表示する */
export const RubySegments = memo(function RubySegments({ segments }: { segments: readonly RubySegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.type === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.type === 'ruby' ? (
          // 括弧（rp）はルビを表示できない環境のためのもの（通常は表示しない。読みと同じく選べない）
          <ruby key={i} className="rb-ruby">
            {s.base}
            <rp>（</rp>
            <rt>{s.reading}</rt>
            <rp>）</rp>
          </ruby>
        ) : (
          <em key={i} className="rb-bouten">
            {s.text}
          </em>
        ),
      )}
    </>
  )
})

/**
 * 本文を記法どおりに表示する。同じ本文（同じ文字列）なら描き直さない
 * （通し読みでほかの話が変わっても、変わっていない話の本文は分け直さない）。
 */
export const RubyText = memo(function RubyText({ text }: { text: string }) {
  const segments = parseRuby(text)
  // ルビ・傍点のない本文は文字だけ（数百万字でも要素を作らない。｜《 の書き分けは parseRuby が《にしてある）
  if (segments.length === 0) return null
  if (segments.length === 1 && segments[0].type === 'text') return <>{segments[0].text}</>
  return <RubySegments segments={segments} />
})

/** 記号とルビの読みを除いた文字だけ（画面から遠い話に置く。検索では親文字が見つかる）。text は除いた後の本文 */
const RubyBaseText = memo(function RubyBaseText({ text }: { text: string }) {
  return <>{text}</>
})

/**
 * 長い本文を読む画面の1話分の本文。記法があれば、watch の要素（content-visibility: auto の話の枠）が
 * 画面の近くに来た時にルビ・傍点の表示にする（それまでは記号と読みを除いた文字だけ。nearViewport.ts）。
 * plain は記号と読みを除いた本文（稿・本文の控えごとに覚えておいたもの。strippedBody）。
 * 渡せば開くたびに全文を分け直さない（省くとここで除く）。
 */
export function LazyRubyText({ text, plain, watch }: { text: string; plain?: string; watch: RefObject<Element | null> }) {
  const markup = hasRubyMarkup(text)
  const near = useNearViewport(watch, markup)
  return markup && !near ? <RubyBaseText text={plain ?? stripRuby(text)} /> : <RubyText text={text} />
}

/** 分けた本文の親文字だけ（ルビの読みと傍点の印を除く） */
function segmentsBaseText(segments: readonly RubySegment[]): string {
  let out = ''
  for (const s of segments) out += s.type === 'ruby' ? s.base : s.text
  return out
}

/**
 * 一覧の抜粋など、分けた本文を画面の近くに来た時だけルビ・傍点の表示にする（それまでは親文字だけ）。
 * 数百行の一覧でも、開いた時に全行の <ruby> を作らないため。watch は行の中の要素。
 */
export function LazyRubySegments({ segments, watch }: { segments: readonly RubySegment[]; watch: RefObject<Element | null> }) {
  const markup = segments.some((s) => s.type !== 'text')
  const near = useNearViewport(watch, markup)
  if (markup && !near) return <>{segmentsBaseText(segments)}</>
  return <RubySegments segments={segments} />
}
