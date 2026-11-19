// 欄ごとの検索の、今の一致1か所だけの印（本文欄 textarea の上に重ねる。全部の一致への色付けはしない）。
// 検索窓にフォーカスを残したまま見せるため、本文欄にフォーカスが無い間だけ描く（フォーカスがある時は本当に選ぶ）。
// 見つけた所が見えていなければ、上から3分の1ほどの所までスクロールする（caret.ts の revealRange）。
// 位置は本文欄と同じ書式の見えない要素で測る（caret.ts の rangeRects）。本文欄のスクロールには描き直さずに付いていく。
// 「段落」で移った段落の印（kind="paragraph"）も同じ仕組みで描く。こちらは本文欄にフォーカスがあっても描き（カーソルは段落の頭に
// 置くだけで選ばない）、見えていても上の方までスクロールする（caret.ts の revealAtTop）。大きさが変わった時に動かし直すのは、
// 移った後に本文欄をスクロールしていない間だけ（読み進めた所から段落へ引き戻さない）。
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { rangeRects, revealAtTop, revealRange } from './caret'
import type { EditorHub } from './editorHub'
import type { Hit } from './fieldSearch'
import type { SearchSlot } from './searchStore'
import type { FieldKey } from './session'

interface Props {
  slot: SearchSlot
  /** 本文欄を入れた .pw-body */
  bodyRef: RefObject<HTMLElement | null>
  hit: Hit | null
  revealSeq: number
  /** 本文欄の値（変わったら測り直す） */
  value: string
  fieldKey?: FieldKey
  hub: EditorHub
  /** search = 欄ごとの検索の今の一致（既定）、paragraph = 「段落」で移った段落 */
  kind?: 'search' | 'paragraph'
  /** 段落の番号（kind="paragraph" の時。data-paragraph に出す） */
  paragraph?: number
}

export function SearchHitLayer({ slot, bodyRef, hit, revealSeq, value, fieldKey, hub, kind = 'search', paragraph }: Props) {
  const isParagraph = kind === 'paragraph'
  const layerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const seenSeq = useRef(revealSeq)
  /** 最後に見えるようにした一致（本文欄の大きさが変わったら、もう一度見える所まで動かす） */
  const revealed = useRef<Hit | null>(null)
  /** 段落: 見える所まで動かした直後の本文欄のスクロールの位置（その後に読み進めてスクロールしたら、もう戻さない） */
  const revealedTop = useRef<number | null>(null)
  const textarea = () => bodyRef.current?.querySelector<HTMLTextAreaElement>('textarea.manuscript') ?? null
  const [fieldFocused, setFieldFocused] = useState(() => {
    const el = textarea()
    return el !== null && document.activeElement === el
  })
  /** 見える所まで動かす（検索は見えていなければ上から3分の1ほどへ、段落はいつも上の方へ） */
  const reveal = (el: HTMLTextAreaElement, h: Hit) => (isParagraph ? revealAtTop(el, h.start) : revealRange(el, h.start, h.end))

  // 本文欄にフォーカスがある間は検索の印を描かない（本当の選択が見える）
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const sync = () => {
      const el = textarea()
      setFieldFocused(el !== null && document.activeElement === el)
    }
    body.addEventListener('focusin', sync)
    body.addEventListener('focusout', sync)
    sync()
    return () => {
      body.removeEventListener('focusin', sync)
      body.removeEventListener('focusout', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyRef])

  /** 本文欄に重ねる位置と、一致の矩形を置き直す */
  const draw = useRef(() => {})
  draw.current = () => {
    const el = textarea()
    const layer = layerRef.current
    const inner = innerRef.current
    if (!el || !layer || !inner || !hit) return
    layer.style.top = `${el.offsetTop + el.clientTop}px`
    layer.style.left = `${el.offsetLeft + el.clientLeft}px`
    layer.style.width = `${el.clientWidth}px`
    layer.style.height = `${el.clientHeight}px`
    inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
    let rects: ReturnType<typeof rangeRects> = []
    try {
      rects = rangeRects(el, hit.start, hit.end)
    } catch {
      /* 測れない環境（テスト）では矩形を描かない */
    }
    const spans = rects.map((r) => {
      const s = document.createElement('span')
      s.className = isParagraph ? 'pw-hit-rect pw-para-rect' : 'pw-hit-rect'
      s.style.left = `${r.x}px`
      s.style.top = `${r.y}px`
      s.style.width = `${r.width}px`
      s.style.height = `${r.height}px`
      return s
    })
    // 段落は、左の余白に段落の高さの線も引く（折り返した行が続いても、どこまでがその段落か分かるように）
    if (isParagraph && rects.length > 0) {
      const top = Math.min(...rects.map((r) => r.y))
      const bottom = Math.max(...rects.map((r) => r.y + r.height))
      const bar = document.createElement('span')
      bar.className = 'pw-para-bar'
      bar.style.left = `${Math.max(1, (parseFloat(getComputedStyle(el).paddingLeft) || 0) - 10)}px`
      bar.style.top = `${top}px`
      bar.style.height = `${bottom - top}px`
      spans.push(bar)
    }
    inner.replaceChildren(...spans)
  }

  const visible = hit !== null && (isParagraph || !fieldFocused)

  // 一致が変わった・移るよう頼まれた時は、見える所まで動かす（検索は、本文欄にフォーカスがあれば本当に選ぶ）
  useLayoutEffect(() => {
    const el = textarea()
    const isNew = revealSeq !== seenSeq.current
    seenSeq.current = revealSeq
    if (!el || !hit) {
      revealed.current = null
      return
    }
    if (isNew) {
      try {
        if (!isParagraph && document.activeElement === el) {
          el.setSelectionRange(hit.start, hit.end)
          // 見つけた所を選んだ後に打った文字は、前の入力と別の1手にする
          if (fieldKey) hub.session.seal(fieldKey)
        }
        reveal(el, hit)
      } catch {
        /* 測れない環境（テスト）では動かさない */
      }
      revealed.current = hit
      revealedTop.current = el.scrollTop
    }
    if (visible) draw.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit?.start, hit?.end, revealSeq, value, visible])

  // 本文欄のスクロールに付いていく。大きさが変わった時（キーボードが出て縮んだ・集中モードで上が畳まれた・字体を読み込んだ）は測り直し、
  // 見えるようにした一致がまだ今の一致なら、もう一度見える所まで動かす
  useEffect(() => {
    const el = textarea()
    if (!el || !visible) return
    const onScroll = () => {
      const inner = innerRef.current
      if (inner) inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
    }
    const remeasure = () => {
      const r = revealed.current
      // 段落は、移った後に本文欄をスクロールしていたら（読み進めた）動かさない（印は描き直す）
      const scrolled = isParagraph && revealedTop.current !== null && Math.abs(el.scrollTop - revealedTop.current) > 1
      if (scrolled) revealed.current = null
      if (r && hit && !scrolled && r.start === hit.start && r.end === hit.end) {
        try {
          reveal(el, r)
          revealedTop.current = el.scrollTop
        } catch {
          /* 測れない環境 */
        }
      }
      draw.current()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure)
    ro?.observe(el)
    let alive = true
    void document.fonts?.ready.then(() => {
      if (alive) draw.current()
    })
    return () => {
      alive = false
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hit?.start, hit?.end])

  if (!visible) return null
  return (
    <div
      ref={layerRef}
      className={isParagraph ? 'pw-hit-layer is-paragraph' : 'pw-hit-layer'}
      aria-hidden="true"
      data-testid={isParagraph ? `${slot}-para-hit` : `${slot}-search-hit`}
      data-start={hit.start}
      data-end={hit.end}
      data-paragraph={isParagraph ? paragraph : undefined}
    >
      <div ref={innerRef} className="pw-hit-inner" />
    </div>
  )
}
