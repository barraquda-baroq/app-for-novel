// ルビ・傍点の記法（カクヨム式 ｜漢字《かんじ》・漢字《かんじ》・《《傍点》》）を、読むための表示にする。
// 通し読み・応募時の原稿・一覧の抜粋など、読むだけの所で使う（編集欄では記法のまま見せる）。
// 書き出し・コピーは記法のまま（data の本文）なので、ここでは表示だけを変える。
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
          // 括弧（rp）はルビを表示できない環境と、コピーした時のためのもの（通常は表示しない）
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

/** 記号とルビの読みを除いた文字だけ（画面から遠い話に置く。検索では親文字が見つかる） */
const RubyBaseText = memo(function RubyBaseText({ text }: { text: string }) {
  return <>{stripRuby(text)}</>
})

/**
 * 長い本文を読む画面の1話分の本文。記法があれば、watch の要素（content-visibility: auto の話の枠）が
 * 画面の近くに来た時にルビ・傍点の表示にする（それまでは記号と読みを除いた文字だけ。nearViewport.ts）。
 */
export function LazyRubyText({ text, watch }: { text: string; watch: RefObject<Element | null> }) {
  const markup = hasRubyMarkup(text)
  const near = useNearViewport(watch, markup)
  return markup && !near ? <RubyBaseText text={text} /> : <RubyText text={text} />
}
