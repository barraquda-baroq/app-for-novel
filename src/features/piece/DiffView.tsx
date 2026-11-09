// 採用原稿 → 選んだ推敲バージョン の差分表示（読み取り専用）
// 計算中も同じ要素を使う（スクロール同期の対象が入れ替わらないように）。
// 長文では要素が多いので、差分が変わらない限り描き直さない（採用原稿の自動保存のたびに描き直さない）。
// 欄ごとの検索の今の一致（hitStart〜hitEnd。表示の文字をつないだ上の位置）は <mark> で包み、移るたびに見える所までスクロールする。
import { memo, useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode } from 'react'
import type { DiffSegment } from '../../domain/diff'

interface Props {
  segments: DiffSegment[] | null
  /** 検索の今の一致（表示の文字をつないだ上の位置） */
  hitStart?: number
  hitEnd?: number
  /** 見つけた所までスクロールさせる合図（増えたら動かす） */
  revealSeq?: number
  /** 差分の表示にフォーカスがある時のキー（欄ごとの検索の Ctrl+F・Esc）。描き直しても変わらない関数を渡す */
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
}

export const DiffView = memo(function DiffView({ segments, hitStart, hitEnd, revealSeq = 0, onKeyDown }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const seenSeq = useRef(revealSeq)

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

  const hs = hitStart ?? 0
  const he = hitEnd ?? 0
  const hasHit = he > hs
  let pos = 0
  let marked = false
  /** 区切りの文字のうち、一致に重なる所を <mark> で包む */
  const content = (text: string): ReactNode => {
    const from = pos
    const to = pos + text.length
    pos = to
    if (!hasHit || hs >= to || he <= from) return text
    const a = Math.max(hs, from) - from
    const z = Math.min(he, to) - from
    const first = !marked
    marked = true
    return (
      <>
        {text.slice(0, a)}
        <mark className="pw-hit" data-testid={first ? 'diff-search-hit' : undefined}>
          {text.slice(a, z)}
        </mark>
        {text.slice(z)}
      </>
    )
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
