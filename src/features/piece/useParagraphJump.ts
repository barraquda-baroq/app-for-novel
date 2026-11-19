// 原稿画面の欄1つ分（採用原稿・推敲バージョン）の「段落」の動き。ヘッダーの「検索」の右の「段落」で一覧を開き、選んだ段落へ移る。
// - 段落の番号は Claude（コネクタ）と同じ数え方（src/claude/anchor.ts の paragraphAt・paragraphSpans。稿の本文ごとに1から、
//   空行・空白だけの行は数えない）で、保存していない編集も含めた欄の本文で数える。幕は幕の稿の本文で数える
// - 一覧はパソコンでは押した所の下に開くポップオーバー、スマホ・高さの低い画面は下からのシート（話の一覧 PieceJump.tsx と同じ）。
//   一覧の中身は開いている間だけ作る（ParagraphJump.tsx）
// - 選ぶと一覧を閉じ、その段落を本文欄の上の方までスクロールして印を付ける（検索の印と同じ SearchHitLayer、差分の表示は <span>）。
//   パソコンでは本文欄にフォーカスしてカーソルを段落の頭に置く。指で操作する端末では、開く前に本文欄にフォーカスがあった時だけ
//   本文欄に戻してカーソルを置く（移っただけではキーボードを出さない。欄ごとの検索の × で本文欄に戻すのと同じ考え）
// - 印は、本文が変わった・本文欄でキーを押した・本文欄を押した・稿や表示の種類が変わった時に消える（スクロールでは消えない）
// - 同じ欄の検索窓が開いていれば、検索の起点を移った段落の頭へ移す（onJumped。検索窓に戻っても前の一致へ引き戻さない）
// - Esc・Android の「戻る」で閉じる。開く前に本文欄にいたらそこへ（カーソルはそのまま）、ほかは「段落」へフォーカスを戻す
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { paragraphAt, paragraphSpans } from '../../claude/anchor'
import type { DiffSegment } from '../../domain/diff'
import { isTextEntry } from './editing'
import type { EditorHub } from './editorHub'
import { bodyOffsetOfDisplay, displayRangeOf } from './paragraphList'
import type { SearchSlot } from './searchStore'
import type { FieldKey } from './session'
import { selectDisplayRange } from './useFieldSearch'

export interface ParagraphJumpOptions {
  slot: SearchSlot
  /** 段落を数える本文（保存していない編集も含めた稿の本文） */
  text: string
  /** 本文欄を入れた .pw-body */
  bodyRef: RefObject<HTMLElement | null>
  /** 稿・表示の種類が変わったら印とカーソルの控えを外す */
  sourceKey: string
  /** 差分の表示の時の区切り（稿の本文の位置を表示の位置に写す。計算中は null）。本文欄（textarea）の時は渡さない */
  diff?: DiffSegment[] | null
  /** 編集できる本文欄なら、その欄（移った後に打った文字を別の1手にする） */
  fieldKey?: FieldKey
  hub: EditorHub
  /** 移った時に、段落の頭（本文欄・差分の表示の位置）を渡す（同じ欄の検索の起点を移す） */
  onJumped?: (start: number) => void
}

/** 移った段落の印（本文欄の位置。差分の表示なら表示の文字をつないだ上の位置） */
export interface ParagraphMark {
  start: number
  end: number
  /** 段落の番号 */
  n: number
}

export interface ParagraphJump {
  slot: SearchSlot
  open: boolean
  /** 段落を数える本文 */
  text: string
  /** 一覧で印を付ける段落（カーソルのある段落か、最後に移った段落。分からなければ null） */
  current: number | null
  /** 本文欄の印（無ければ null） */
  mark: ParagraphMark | null
  /** 移った段落までスクロールさせる合図（増えたら動かす） */
  revealSeq: number
  buttonRef: RefObject<HTMLButtonElement | null>
  panelId: string
  /** 「段落」を押し始めた時（本文欄にフォーカスがあったかを控える） */
  onTogglePointerDown: () => void
  /** 「段落」（開いていれば閉じる） */
  toggle: () => void
  /** 閉じる。back なら（Esc・「戻る」）開く前の所へフォーカスを戻す */
  close: (o: { back: boolean }) => void
  /** n 段落目へ移る（一覧を閉じる） */
  jump: (n: number) => void
}

interface MarkState extends ParagraphMark {
  /** 印を付けた時の本文・区切り・稿（変わったら印を消す） */
  text: string
  diff: DiffSegment[] | null | undefined
  source: string
}

/** 印を消さないキー（修飾キーだけ） */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS'])

const isTouch = () => (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) || false

export function useParagraphJump({
  slot,
  text,
  bodyRef,
  sourceKey,
  diff,
  fieldKey,
  hub,
  onJumped,
}: ParagraphJumpOptions): ParagraphJump {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<number | null>(null)
  const [markState, setMarkState] = useState<MarkState | null>(null)
  const [revealSeq, setRevealSeq] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  /** この欄に一度でもフォーカスしたか（していなければカーソルの位置は意味が無い） */
  const touched = useRef(false)
  /** 最後に移った段落（その後に本文欄にフォーカスしたら外す） */
  const lastJump = useRef<number | null>(null)
  /** 開く前に本文欄にフォーカスがあったか */
  const fieldBefore = useRef(false)
  /** 「段落」を押し始めた時に本文欄にフォーカスがあったか（押すとフォーカスがボタンへ移る端末があるので、押し始めに控える） */
  const pressFocus = useRef<boolean | null>(null)

  const fieldEl = () => bodyRef.current?.querySelector<HTMLElement>('.manuscript') ?? null

  useEffect(() => {
    touched.current = false
    lastJump.current = null
  }, [sourceKey])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.manuscript'))) return
      touched.current = true
      lastJump.current = null
    }
    body.addEventListener('focusin', onFocus)
    return () => body.removeEventListener('focusin', onFocus)
  }, [bodyRef])

  // 印を付けた時から本文・差分・稿が変わっていたら印は無し
  const mark =
    markState && markState.text === text && markState.diff === diff && markState.source === sourceKey ? markState : null
  const hasMark = mark !== null

  // 本文欄でキーを押した・本文欄を押した（スクロールバーは除く）ら印を消す
  useEffect(() => {
    if (!hasMark) return
    const el = fieldEl()
    if (!el) return
    const clear = () => setMarkState(null)
    const onKey = (e: KeyboardEvent) => {
      if (!MODIFIERS.has(e.key)) clear()
    }
    const onClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      if (e.clientX - r.left - el.clientLeft > el.clientWidth || e.clientY - r.top - el.clientTop > el.clientHeight) return
      clear()
    }
    el.addEventListener('keydown', onKey)
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('click', onClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMark, sourceKey])

  /** 稿の本文の上の位置（差分の表示では、表示の位置から写す） */
  const caretParagraph = (el: HTMLElement): number | null => {
    if (el instanceof HTMLTextAreaElement) return paragraphAt(el.value, el.selectionStart)
    if (!diff) return null
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return null
    const r = sel.getRangeAt(0)
    const before = document.createRange()
    before.setStart(el, 0)
    before.setEnd(r.startContainer, r.startOffset)
    return paragraphAt(text, bodyOffsetOfDisplay(diff, before.toString().length))
  }

  const openNow = () => {
    const el = fieldEl()
    const focused = pressFocus.current ?? (el !== null && document.activeElement === el)
    pressFocus.current = null
    fieldBefore.current = focused
    let cur: number | null = null
    if (el && focused) cur = caretParagraph(el)
    else if (lastJump.current !== null) cur = lastJump.current
    else if (el && touched.current) cur = caretParagraph(el)
    // 描いてから同じタップの中で番号の欄にフォーカスする（iPhone でもキーボードが出るように）
    flushSync(() => {
      setCurrent(cur)
      setOpen(true)
    })
  }

  const close = ({ back }: { back: boolean }) => {
    flushSync(() => setOpen(false))
    if (!back) return
    const el = fieldEl()
    if (fieldBefore.current && el) el.focus({ preventScroll: true })
    else buttonRef.current?.focus({ preventScroll: true })
  }

  const jumpNow = (n: number) => {
    const restore = fieldBefore.current
    // 先に一覧を閉じる（シートが開く前のフォーカスを戻した後で、本文欄へ移す）
    flushSync(() => setOpen(false))
    const el = fieldEl()
    if (!el) return
    // パソコンは本文欄へ。指で操作する端末は、開く前に本文欄にいた時だけ（キーボードを出さない）
    const toField = !isTouch() || restore
    let range: { start: number; end: number }
    if (el instanceof HTMLTextAreaElement) {
      // 本文欄の値で数える（数え方は同じ。位置は本文欄の上の位置）
      const sp = paragraphSpans(el.value)[n - 1]
      if (!sp) return
      range = sp
      if (toField) {
        el.focus({ preventScroll: true })
        el.setSelectionRange(sp.start, sp.start)
        // 移った後に打った文字は、前の入力と別の1手にする
        if (fieldKey) hub.session.seal(fieldKey)
      }
    } else {
      // 差分の表示: 稿の本文（削除された文字を除いた区切り）で数え、表示の位置に写す
      if (!diff) return
      const body = diff
        .filter((s) => s.kind !== 'del')
        .map((s) => s.text)
        .join('')
      const sp = paragraphSpans(body)[n - 1]
      if (!sp) return
      range = displayRangeOf(diff, sp.start, sp.end)
      if (toField) {
        el.focus({ preventScroll: true })
        selectDisplayRange(el, range.start, range.start)
      }
    }
    if (!toField) {
      // シートを閉じた時に戻ったフォーカスが文字の欄なら外す（キーボードを閉じる）
      const a = document.activeElement
      if (a instanceof HTMLElement && isTextEntry(a)) a.blur()
    }
    lastJump.current = n
    setMarkState({ start: range.start, end: range.end, n, text, diff, source: sourceKey })
    setRevealSeq((k) => k + 1)
    onJumped?.(range.start)
  }

  // 一覧に渡す関数は変えない（開いている間にペインが描き直されても、数百行の一覧を描き直さない）
  const jumpRef = useRef(jumpNow)
  jumpRef.current = jumpNow
  const jump = useCallback((n: number) => jumpRef.current(n), [])

  return {
    slot,
    open,
    text,
    current,
    mark,
    revealSeq,
    buttonRef,
    panelId,
    onTogglePointerDown: () => {
      const el = fieldEl()
      pressFocus.current = el !== null && document.activeElement === el
    },
    toggle: () => (open ? close({ back: false }) : openNow()),
    close,
    jump,
  }
}
