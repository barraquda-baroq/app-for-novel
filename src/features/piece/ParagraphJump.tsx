// 原稿画面のペインのヘッダーの「段落」（「検索」の右）と、押すと開く段落の一覧。動きは useParagraphJump.ts、数え方は paragraphList.ts。
// Claude の推敲の指摘（「¶41「話かけて」→…」）の段落の番号へ移るためのもの。
// - 上に番号の欄（「段落の番号」。スマホは数字のキーボード、Enter で移る。「28」「¶28」「２８」）。無い番号はそう言って移らない
// - 段落の数（「全n段落」）と、全部の段落の一覧（「¶n　書き出しの20字ほど…」。ルビ・傍点は親文字だけ）。カーソルのある段落に印を付け、
//   番号を打つとその段落の行に印を付けて見える所へ出す。↑↓・Home・End で行を動き（最初の行の ↑ で番号の欄へ）、Enter・押すと移る
// パソコンは押した所の下に開くポップオーバー、スマホ・高さの低い画面は下からのシート（話の一覧と同じ。JUMP_SHEET_QUERY）。
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { formatCount } from '../../domain/text'
import { useMediaQuery } from '../../ui/hooks'
import { Modal } from '../../ui/Modal'
import { centeredScrollTop, JUMP_SHEET_QUERY, jumpFocusIndex } from './logic'
import { clampParagraph, paragraphItems, paragraphTarget, paragraphTargetMessage, type ParagraphItem } from './paragraphList'
import { PilcrowIcon } from './pieceIcons'
import { JumpPopover } from './PieceJump'
import type { ParagraphJump } from './useParagraphJump'
import './pieceJump.css'

/** 一覧の行 */
const ITEM = 'button.pg-item'

/** 一覧の n 段落目の行を、一覧の真ん中に出す（開く時の動き（少し縮めて出す）の途中でも、縮める前の大きさで測る） */
function revealItem(list: HTMLElement, n: number): void {
  const item = list.querySelector<HTMLElement>(`${ITEM}[data-n="${n}"]`)
  if (!item) return
  const b = list.getBoundingClientRect()
  const scale = list.offsetHeight > 0 ? b.height / list.offsetHeight || 1 : 1
  const top = (item.getBoundingClientRect().top - b.top) / scale - list.clientTop + list.scrollTop
  list.scrollTop = centeredScrollTop(top, item.offsetHeight, list.clientHeight, list.scrollHeight)
}

/** ヘッダーの「段落」と、開いた一覧 */
export function ParagraphJumpButton({ jump }: { jump: ParagraphJump }) {
  const sheet = useMediaQuery(JUMP_SHEET_QUERY)
  const { open, panelId } = jump

  // 開いた時（ポップオーバーを置いた後）: カーソルのある段落を一覧の真ん中に出し、パソコンでは番号の欄へフォーカスする
  // （シートは Modal が最初の入力欄へフォーカスする）
  useLayoutEffect(() => {
    if (!open) return
    const panel = document.getElementById(panelId)
    const list = panel?.querySelector<HTMLElement>('.pg-list')
    const current = list?.querySelector<HTMLElement>(`${ITEM}[aria-current]`)
    if (list && current) revealItem(list, Number(current.dataset.n))
    if (!sheet) panel?.querySelector<HTMLInputElement>('input.pg-input')?.focus({ preventScroll: true })
  }, [open, sheet, panelId])

  const panel = <ParagraphPanel id={panelId} text={jump.text} current={jump.current} onPick={jump.jump} head={!sheet} />
  return (
    <>
      <button
        ref={jump.buttonRef}
        type="button"
        className={`btn pw-tbtn pw-para-toggle${open ? ' is-open' : ''}`}
        onPointerDown={jump.onTogglePointerDown}
        onClick={jump.toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label="段落へ移る"
        title="段落の番号（¶）へ移る"
        data-testid={`${jump.slot}-para-toggle`}
      >
        <PilcrowIcon />
        <span className="pw-tlabel">段落</span>
      </button>
      {open ? (
        sheet ? (
          <Modal title="段落へ移る" onClose={() => jump.close({ back: true })}>
            {panel}
          </Modal>
        ) : (
          <JumpPopover
            anchor={jump.buttonRef}
            onClose={(back) => jump.close({ back })}
            label="段落へ移る"
            className="pj-pop pg-pop"
            testId="para-jump-pop"
          >
            {panel}
          </JumpPopover>
        )
      ) : null}
    </>
  )
}

interface PanelProps {
  id: string
  text: string
  /** 印を付ける段落（カーソルのある段落・最後に移った段落） */
  current: number | null
  onPick: (n: number) => void
  /** 見出し（「段落へ移る」）を出す（シートは Modal の見出しがあるので出さない） */
  head: boolean
}

/** 段落の一覧の中身。開いている間だけ作り、本文が変わった時だけ一覧を作り直す */
function ParagraphPanel({ id, text, current, onPick, head }: PanelProps) {
  const items = useMemo(() => paragraphItems(text), [text])
  const total = items.length
  const cur = clampParagraph(current, total)
  const [value, setValue] = useState('')
  /** Enter・「移動」を押した後は、指せない番号の言葉を出したままにする */
  const [tried, setTried] = useState(false)
  const target = paragraphTarget(value, total)
  const message = paragraphTargetMessage(target)
  const typed = target.kind === 'ok' ? target.n : null
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const inputId = useId()
  const statusId = useId()

  // 番号を打ったら、その段落の行を見える所へ出す（どの段落か確かめられるように）
  useEffect(() => {
    if (typed !== null && listRef.current) revealItem(listRef.current, typed)
  }, [typed])

  const submit = () => {
    if (target.kind === 'ok') onPick(target.n)
    else setTried(true)
  }

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 変換を確定する Enter（Safari は isComposing を付けず keyCode 229 で届く）では移らない
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowDown') {
      // 打った番号の行（無ければカーソルのある段落、最初の段落）へ
      const el = listRef.current?.querySelector<HTMLButtonElement>(`${ITEM}[data-n="${typed ?? cur ?? 1}"]`)
      if (!el) return
      e.preventDefault()
      el.focus()
    }
  }

  const showMessage = message !== '' && (tried || target.kind === 'out')
  const totalLabel = `全${formatCount(total)}段落`

  return (
    <div id={id} className="pg-panel" data-testid="para-jump-panel">
      {head ? <p className="pj-head pg-head">段落へ移る</p> : null}
      <div className="pg-form">
        <div className="pg-labels">
          <label className="pg-label" htmlFor={inputId}>
            段落の番号
          </label>
          <span className="pg-total" data-testid="para-jump-total">
            {totalLabel}
          </span>
        </div>
        <div className="pg-row">
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="numeric"
            enterKeyHint="go"
            className="input pg-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setTried(false)
            }}
            onKeyDown={onInputKeyDown}
            placeholder={total > 0 ? `1〜${total}` : ''}
            disabled={total === 0}
            maxLength={12}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={showMessage || undefined}
            aria-describedby={showMessage ? statusId : undefined}
            data-testid="para-jump-input"
          />
          <button
            type="button"
            className="btn btn-primary pg-go"
            onClick={submit}
            disabled={total === 0}
            data-testid="para-jump-go"
          >
            移動
          </button>
        </div>
        <p id={statusId} className="pg-status" role="status" aria-live="polite" data-testid="para-jump-status">
          {showMessage ? message : ''}
        </p>
      </div>
      {total === 0 ? (
        <p className="pg-empty">この稿には段落がありません。</p>
      ) : (
        <ParagraphList listRef={listRef} items={items} current={cur} typed={typed} onPick={onPick} inputRef={inputRef} />
      )}
    </div>
  )
}

interface ListProps {
  listRef: RefObject<HTMLUListElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  items: ParagraphItem[]
  current: number | null
  /** 番号の欄で指している段落 */
  typed: number | null
  onPick: (n: number) => void
}

/** 段落の行（数百行になるので、行・印が変わった時だけ描き直す） */
const ParagraphList = memo(function ParagraphList({ listRef, inputRef, items, current, typed, onPick }: ListProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(ITEM))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    // 最初の行の ↑ で番号の欄へ戻る
    if (e.key === 'ArrowUp' && index === 0) {
      e.preventDefault()
      inputRef.current?.focus()
      return
    }
    const j = jumpFocusIndex(e.key, index, buttons.length)
    if (j === null) return
    e.preventDefault()
    buttons[j].focus()
  }
  return (
    <ul ref={listRef} className="pg-list" onKeyDown={onKeyDown} aria-label="段落の一覧" data-testid="para-jump-list">
      {items.map((it) => (
        <li key={it.n}>
          <button
            type="button"
            className={`pg-item${it.n === typed ? ' is-target' : ''}`}
            aria-current={it.n === current ? 'location' : undefined}
            onClick={() => onPick(it.n)}
            data-n={it.n}
            data-testid="para-jump-item"
          >
            <span className="pg-num">¶{it.n}</span>
            {'　'}
            <span className="pg-text">{it.label}</span>
          </button>
        </li>
      ))}
    </ul>
  )
})
