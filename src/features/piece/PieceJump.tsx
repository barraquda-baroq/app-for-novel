// 原稿画面・幕の画面の左上の「第n話」から開く話の一覧（中身は通し読みの目次と同じ: read/TocBody.tsx）。
// そのタイトルのすべての話を読む順に並べ（章の区切り・特殊ブロック・幕・「採用原稿なし」も）、今の話・幕に印を付けて、その位置を出す。
// パソコンは押した所の下に開くポップオーバー、スマホ・高さの低い画面は下からのシート（Modal）。
// 選ぶと一覧を閉じてから onPick で移る（保存していない編集の確認は、前後の話への移動と同じく移る側で出す）。今の話を選ぶと閉じるだけ。
// ↑↓・Home・End で項目を動き、Enter で開く。Esc（Android の「戻る」）で閉じて、押した所へフォーカスを戻す。
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useHref } from 'react-router-dom'
import { buildReadThrough } from '../../domain/readthrough'
import type { ID } from '../../domain/types'
import { paths } from '../../routes'
import { useMediaQuery } from '../../ui/hooks'
import { Modal } from '../../ui/Modal'
import { tocGroups } from '../read/readLogic'
import { TocBody, type TocPick } from '../read/TocBody'
import { useStoryData } from '../title/story/useStoryData'
import { centeredScrollTop, JUMP_SHEET_QUERY, jumpFocusIndex } from './logic'
import './pieceJump.css'

/** 今の話・幕の項目 */
const CURRENT = 'a.rt-toc-link[aria-current="page"]'

export interface PieceJumpProps {
  titleId: ID
  /** 今開いている話・幕（一覧で印を付ける。選んでも移らない） */
  currentId: ID
  /** 一覧で別の話・幕を選んだ時 */
  onPick: (id: ID) => void
  /** 押す所（ボタン）のクラス */
  className: string
  ariaLabel: string
  title: string
  children: ReactNode
  testId?: string
}

export function PieceJump({
  titleId,
  currentId,
  onPick,
  className,
  ariaLabel,
  title,
  children,
  testId = 'piece-jump',
}: PieceJumpProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const sheet = useMediaQuery(JUMP_SHEET_QUERY)
  // 一覧に渡す関数は変えない（開いている間に画面が描き直されても、数百話の一覧を作り直さない）
  const latest = useRef({ onPick, currentId })
  latest.current = { onPick, currentId }

  /** 閉じる。back なら押した所へフォーカスを戻す（外側を押して閉じた時は、押した所のまま） */
  const close = useCallback((back: boolean) => {
    setOpen(false)
    if (back) buttonRef.current?.focus({ preventScroll: true })
  }, [])

  const pick = useCallback((id: ID) => {
    // 先に一覧を閉じてから移る（保存の確認のダイアログと一覧が重ならないように。確認でやめた時は押した所に戻る）
    flushSync(() => setOpen(false))
    buttonRef.current?.focus({ preventScroll: true })
    const { onPick: go, currentId: cur } = latest.current
    if (id !== cur) go(id)
  }, [])

  // 開いた時: 今の話を真ん中に出して、そこへフォーカスする（シートでは Modal が同じ項目へフォーカスし、閉じた後に押した所へ戻す）
  useLayoutEffect(() => {
    if (!open) return
    const list = document.getElementById(listId)
    if (list) revealCurrent(list, !sheet)
  }, [open, sheet, listId])

  const list = <PieceJumpList id={listId} titleId={titleId} currentId={currentId} onPick={pick} head={!sheet} />
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
      >
        {children}
      </button>
      {open ? (
        sheet ? (
          <Modal title="話の一覧" onClose={() => close(false)} initialFocus={CURRENT}>
            {list}
          </Modal>
        ) : (
          <JumpPopover anchor={buttonRef} onClose={close}>
            {list}
          </JumpPopover>
        )
      ) : null}
    </>
  )
}

/** 今の話・幕の項目（無ければ最初の項目）を入れ物の真ん中に出す。focus ならフォーカスもする */
function revealCurrent(list: HTMLElement, focus: boolean): void {
  const item = list.querySelector<HTMLAnchorElement>(CURRENT) ?? list.querySelector<HTMLAnchorElement>('a.rt-toc-link')
  if (!item) return
  const box = list.closest<HTMLElement>('.modal-body, .pj-pop')
  if (box) {
    // 開く時の動き（少し縮めて出す）の途中でも、縮める前の大きさで測る
    const b = box.getBoundingClientRect()
    const scale = box.offsetHeight > 0 ? b.height / box.offsetHeight || 1 : 1
    const top = (item.getBoundingClientRect().top - b.top) / scale - box.clientTop + box.scrollTop
    box.scrollTop = centeredScrollTop(top, item.offsetHeight, box.clientHeight, box.scrollHeight)
  }
  if (focus) item.focus({ preventScroll: true })
}

/** 一覧の中身。開いている間だけ作り、本編のデータが変わった時だけ作り直す */
const PieceJumpList = memo(function PieceJumpList({
  id,
  titleId,
  currentId,
  onPick,
  head,
}: {
  id: string
  titleId: ID
  currentId: ID
  onPick: (id: ID) => void
  /** 見出し（話の一覧と話の数）を出す（シートは Modal の見出しがあるので出さない） */
  head: boolean
}) {
  const story = useStoryData(titleId)
  const groups = useMemo(() => tocGroups(buildReadThrough(story, titleId)), [story, titleId])
  const count = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups])
  // 項目は本当の行き先にする（Ctrl・⌘ を押しながらで新しいタブに開ける）
  const base = useHref('/').replace(/\/$/, '')
  const hrefOf = useCallback((pieceId: ID) => `${base}${paths.piece(titleId, pieceId)}`, [base, titleId])
  const pickToc = useCallback<TocPick>(
    (e, t) => {
      // 修飾キーを押しながらのクリックはブラウザに任せる（新しいタブ・ウィンドウで開く）
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      e.preventDefault()
      onPick(t.pieceId)
    },
    [onPick],
  )
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a.rt-toc-link'))
    const j = jumpFocusIndex(e.key, links.indexOf(document.activeElement as HTMLAnchorElement), links.length)
    if (j === null) return
    e.preventDefault()
    links[j].focus()
  }
  return (
    <div id={id} className="pj-list" onKeyDown={onKeyDown} data-testid="piece-jump-list">
      {head ? (
        <p className="pj-head">
          話の一覧<span className="rt-toc-count">{count}</span>
        </p>
      ) : null}
      <TocBody groups={groups} hrefOf={hrefOf} onPick={pickToc} className="pj-body" currentId={currentId} />
    </div>
  )
})

/** 画面の端からの余白 */
const EDGE = 8
/** 押した所との間 */
const GAP = 6
/** ポップオーバーの高さ（画面が低くても、これだけは取る） */
const MAX_HEIGHT = 560
const MIN_HEIGHT = 200

/** 置く位置を測るまでは見せない（位置は描いた後に直接置く） */
const HIDDEN = { left: 0, top: 0, visibility: 'hidden' } as const

/**
 * パソコンの一覧: 押した所の下に開く。外側を押す・Esc・フォーカスが外へ出る・外側のスクロール・画面の幅の変更で閉じる。
 * 上部バー（重なり順 15）の中に置くと推敲案の一覧（40）の下になるので、body に出す
 */
function JumpPopover({
  anchor,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLButtonElement | null>
  onClose: (back: boolean) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    const a = anchor.current
    if (!el || !a) return
    const r = a.getBoundingClientRect()
    const top = r.bottom + GAP
    el.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, window.innerHeight - top - EDGE))}px`
    const w = el.offsetWidth
    el.style.left = `${Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE))}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
  }, [anchor])

  useEffect(() => {
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (ref.current?.contains(t) === true || anchor.current?.contains(t) === true)
    // 押した所を押した時は、そのボタン（開く・閉じる）に任せる
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) closeRef.current(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      closeRef.current(true)
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      closeRef.current(false)
    }
    // 回転・ウィンドウの幅の変更の時だけ閉じる（置いた位置がずれるので）
    const openWidth = window.innerWidth
    const onResize = () => {
      if (window.innerWidth !== openWidth) closeRef.current(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className="pj-pop"
      role="dialog"
      aria-label="話の一覧"
      style={HIDDEN}
      // Android の「戻る」は Esc を送って閉じる（platform/nativeInit.ts）
      data-back-close="esc"
      onBlur={(e) => {
        // Tab などでフォーカスが一覧の外へ出たら閉じる
        const next = e.relatedTarget
        if (next instanceof Node && !e.currentTarget.contains(next) && !anchor.current?.contains(next)) closeRef.current(false)
      }}
      data-testid="piece-jump-pop"
    >
      {children}
    </div>,
    document.body,
  )
}
