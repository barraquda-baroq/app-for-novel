// 欄ごとの検索の、今の一致1か所だけの印（本文欄 textarea の上に重ねる。全部の一致への色付けはしない）。
// 検索窓にフォーカスを残したまま見せるため、本文欄にフォーカスが無い間だけ描く（フォーカスがある時は本当に選ぶ）。
// 見つけた所が見えていなければ、上から3分の1ほどの所までスクロールする（caret.ts の revealRange）。
// 位置は本文欄と同じ書式の見えない要素で測る（caret.ts の rangeRects）。本文欄のスクロールには描き直さずに付いていく。
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { rangeRects, revealRange } from './caret'
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
}

export function SearchHitLayer({ slot, bodyRef, hit, revealSeq, value, fieldKey, hub }: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const seenSeq = useRef(revealSeq)
  /** 最後に見えるようにした一致（本文欄の大きさが変わったら、もう一度見える所まで動かす） */
  const revealed = useRef<Hit | null>(null)
  const textarea = () => bodyRef.current?.querySelector<HTMLTextAreaElement>('textarea.manuscript') ?? null
  const [fieldFocused, setFieldFocused] = useState(() => {
    const el = textarea()
    return el !== null && document.activeElement === el
  })

  // 本文欄にフォーカスがある間は印を描かない（本当の選択が見える）
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
    inner.replaceChildren(
      ...rects.map((r) => {
        const s = document.createElement('span')
        s.className = 'pw-hit-rect'
        s.style.left = `${r.x}px`
        s.style.top = `${r.y}px`
        s.style.width = `${r.width}px`
        s.style.height = `${r.height}px`
        return s
      }),
    )
  }

  // 一致が変わった・移るよう頼まれた時は、見える所まで動かす（本文欄にフォーカスがあれば本当に選ぶ）
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
        if (document.activeElement === el) {
          el.setSelectionRange(hit.start, hit.end)
          // 見つけた所を選んだ後に打った文字は、前の入力と別の1手にする
          if (fieldKey) hub.session.seal(fieldKey)
        }
        revealRange(el, hit.start, hit.end)
      } catch {
        /* 測れない環境（テスト）では動かさない */
      }
      revealed.current = hit
    }
    if (!fieldFocused) draw.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit?.start, hit?.end, revealSeq, value, fieldFocused])

  // 本文欄のスクロールに付いていく。大きさが変わった時（キーボードが出て縮んだ・集中モードで上が畳まれた・字体を読み込んだ）は測り直し、
  // 見えるようにした一致がまだ今の一致なら、もう一度見える所まで動かす
  const shown = hit !== null && !fieldFocused
  useEffect(() => {
    const el = textarea()
    if (!el || !shown) return
    const onScroll = () => {
      const inner = innerRef.current
      if (inner) inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
    }
    const remeasure = () => {
      const r = revealed.current
      if (r && hit && r.start === hit.start && r.end === hit.end) {
        try {
          revealRange(el, r.start, r.end)
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
  }, [shown, hit?.start, hit?.end])

  if (!shown) return null
  return (
    <div
      ref={layerRef}
      className="pw-hit-layer"
      aria-hidden="true"
      data-testid={`${slot}-search-hit`}
      data-start={hit.start}
      data-end={hit.end}
    >
      <div ref={innerRef} className="pw-hit-inner" />
    </div>
  )
}
