// 採用原稿 → 選んだ推敲バージョン の差分表示（読み取り専用）
// 計算中も同じ要素を使う（スクロール同期の対象が入れ替わらないように）。
// 長文では要素が多いので、差分が変わらない限り描き直さない（採用原稿の自動保存のたびに描き直さない）。
// 欄ごとの検索の今の一致（hitStart〜hitEnd。表示の文字をつないだ上の位置）は <mark> で包み、移るたびに見える所までスクロールする。
// 「段落」で移った段落（paraStart〜paraEnd。同じく表示の位置）は <span class="pw-para"> で包み、移るたびに上の方までスクロールする。
import { memo, useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode } from 'react'
import type { DiffSegment } from '../../domain/diff'

interface Props {
  segments: DiffSegment[] | null
  /** 検索の今の一致（表示の文字をつないだ上の位置） */
  hitStart?: number
  hitEnd?: number
  /** 見つけた所までスクロールさせる合図（増えたら動かす） */
  revealSeq?: number
  /** 「段落」で移った段落（表示の文字をつないだ上の位置）と、その番号 */
  paraStart?: number
  paraEnd?: number
  paragraph?: number
  /** 移った段落までスクロールさせる合図（増えたら動かす） */
  paraSeq?: number
  /** 差分の表示にフォーカスがある時のキー（欄ごとの検索の Ctrl+F・Esc）。描き直しても変わらない関数を渡す */
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
}

export const DiffView = memo(function DiffView({
  segments,
  hitStart,
  hitEnd,
  revealSeq = 0,
  paraStart,
  paraEnd,
  paragraph,
  paraSeq = 0,
  onKeyDown,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const seenSeq = useRef(revealSeq)
  const seenParaSeq = useRef(paraSeq)

  // 一致が外側の見えている範囲に無ければ、上から3分の1ほどの所まで動かす（外側の overflow: clip の要素は動かさない）
  useLayoutEffect(() => {
    if (revealSeq === seenSeq.current) return
    seenSeq.current = revealSeq
    const box = ref.current
    const mark = box?.querySelector('mark.pw-hit')
    if (!box || !mark) return
    const b = box.getBoundingClientRect()
    const m = mark.getBoundingClientRect()
    if (m.top >= b.top && m.bottom <= b.bottom) return
    box.scrollTop += m.top - b.top - box.clientHeight / 3
  }, [revealSeq])

  // 移った段落は、見えていても上の方（上に1行ほど残した所）まで動かす
  useLayoutEffect(() => {
    if (paraSeq === seenParaSeq.current) return
    seenParaSeq.current = paraSeq
    const box = ref.current
    const mark = box?.querySelector<HTMLElement>('.pw-para')
    if (!box || !mark) return
    const b = box.getBoundingClientRect()
    const m = mark.getBoundingClientRect()
    const line = parseFloat(getComputedStyle(box).lineHeight) || m.height || 20
    box.scrollTop += m.top - b.top - Math.min(line, box.clientHeight / 4)
  }, [paraSeq])

  const hs = hitStart ?? 0
  const he = hitEnd ?? 0
  const hasHit = he > hs
  const ps = paraStart ?? 0
  const pe = paraEnd ?? 0
  const hasPara = pe > ps
  let pos = 0
  let marked = false
  let paraMarked = false
  /** 区切りの文字のうち、一致・移った段落に重なる所を <mark>・<span class="pw-para"> で包む（一致は段落の中に収まる） */
  const content = (text: string): ReactNode => {
    const from = pos
    const to = pos + text.length
    pos = to
    const hitIn = hasHit && hs < to && he > from
    const paraIn = hasPara && ps < to && pe > from
    if (!hitIn && !paraIn) return text
    // 区切りの中の切れ目（一致・段落の端）で分け、それぞれを包む
    const cuts = new Set([from, to])
    for (const p of [hs, he, ps, pe]) if (p > from && p < to) cuts.add(p)
    const points = [...cuts].sort((a, b) => a - b)
    const parts: ReactNode[] = []
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k]
      const z = points[k + 1]
      let node: ReactNode = text.slice(a - from, z - from)
      if (hitIn && a >= hs && z <= he) {
        const first = !marked
        marked = true
        node = (
          <mark key={`h${a}`} className="pw-hit" data-testid={first ? 'diff-search-hit' : undefined}>
            {node}
          </mark>
        )
      }
      if (paraIn && a >= ps && z <= pe) {
        const first = !paraMarked
        paraMarked = true
        node = (
          <span
            key={`p${a}`}
            className="pw-para"
            data-testid={first ? 'diff-para-hit' : undefined}
            data-paragraph={first ? paragraph : undefined}
          >
            {node}
          </span>
        )
      }
      parts.push(node)
    }
    return <>{parts}</>
  }

  return (
    <div
      ref={ref}
      className={`manuscript diff-view pw-diff${segments ? '' : ' is-pending'}`}
      data-testid="diff-view"
      data-scroll-sync="compare"
      tabIndex={0}
      role="document"
      aria-label="採用原稿との差分（読み取り専用）"
      aria-busy={segments ? undefined : true}
      onKeyDown={onKeyDown}
    >
      {segments === null ? (
        <span className="faint" data-testid="diff-pending">
          差分を計算中…
        </span>
      ) : segments.length === 0 ? (
        <span className="faint">（本文がありません）</span>
      ) : (
        segments.map((s, i) =>
          s.kind === 'same' ? (
            <span key={i}>{content(s.text)}</span>
          ) : s.kind === 'add' ? (
            <ins key={i} className="diff-add">
              {content(s.text)}
            </ins>
          ) : (
            <del key={i} className="diff-del">
              {content(s.text)}
            </del>
          ),
        )
      )}
    </div>
  )
})
