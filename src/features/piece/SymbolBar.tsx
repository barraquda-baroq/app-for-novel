// 記号バー: 巻き戻し／進む、ダッシュ・三点リーダー・全角空白・括弧・ルビ・傍点。
// いま書いている欄（最後にフォーカスした本文・推敲メモ）に働く。押してもフォーカスを奪わない
// （pointerdown / mousedown を止めるので、スマホのキーボードも閉じない）。
// 「括弧」は押すと上向きに一覧（「」『』（）〈〉〝〟）を開く。一覧も押してもフォーカスを奪わない
// （キーボードで開いた時だけ一覧にフォーカスを移す）。
// デスクトップは編集画面のいちばん下、スマホはキーボードのすぐ上（閉じている時は画面の下）に常に出す。
// iPhone のアプリは原稿画面でキーボードの「完了」の帯を消すので（src/platform/keyboard.ts）、代わりに「キーボードを閉じる」を出す。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { isNativeIos } from '../../platform/platform'
import { IS_MAC, keepFocus } from '../../ui/keys'
import { PopupMenu, type MenuPlacement } from '../../ui/PopupMenu'
import { isFieldVisible, useHubTarget, type EditorHub, type FieldHandle } from './editorHub'
import { HistoryRedoIcon, HistoryUndoIcon, KeyboardHideIcon } from './pieceIcons'
import type { FieldKey } from './session'
import { BRACKETS, SYMBOLS, TOOLBAR } from './symbols'

const UNDO_KEY = IS_MAC ? '⌘Z' : 'Ctrl+Z'
const REDO_KEY = IS_MAC ? '⌘⇧Z' : 'Ctrl+Y'

const SYMBOL_OF = new Map(SYMBOLS.map((s) => [s.kind, s]))
const BRACKETS_TITLE = '括弧を入れる（選んだ文字は括弧で囲む）'
const BRACKETS_LABEL = `括弧を入れる（${BRACKETS.map((b) => b.open + b.close).join('')}）`
const OFF_HINT = '（本文か推敲メモを書いている時に使えます）'

/** 開いている括弧の一覧（開いた時の働き先の欄。欄が変わったら閉じる） */
interface BracketsOpen {
  anchor: HTMLElement
  byKeyboard: boolean
  key: FieldKey
}

export function SymbolBar({ hub, dirty, onSave }: { hub: EditorHub; dirty: boolean; onSave: () => void }) {
  const target = useHubTarget(hub)
  const key = target?.key ?? null
  // 入力のたびには描き直さない（戻せるか・進めるかが変わった時だけ）
  const canUndo = useSyncExternalStore(hub.session.subscribe, () => (key ? hub.session.canUndo(key) : false))
  const canRedo = useSyncExternalStore(hub.session.subscribe, () => (key ? hub.session.canRedo(key) : false))
  const symbolsOn = target?.symbols ?? false
  const [closeKeyboard] = useState(isNativeIos)
  const [brackets, setBrackets] = useState<BracketsOpen | null>(null)
  // 記号を使えなくなった（話の題などへ移った）・働き先の欄が変わった時は、括弧の一覧を閉じる
  if (brackets && (!symbolsOn || brackets.key !== key)) setBrackets(null)
  const placement = useMemo<MenuPlacement | null>(
    () => (brackets ? { anchor: brackets.anchor, side: 'above' } : null),
    [brackets],
  )
  // 一覧を開いている間に、本文を打ち始めた・ほかの所へフォーカスが移った（Tab・ダイアログなど）時も閉じる
  useEffect(() => {
    if (!brackets) return
    const close = () => setBrackets(null)
    const onFocus = (e: FocusEvent) => {
      const t = e.target
      if (!(t instanceof Element) || t.closest('[role="menu"]') || brackets.anchor.contains(t)) return
      if (t === hub.getTarget()?.element()) return
      close()
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('input', close, true)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('input', close, true)
    }
  }, [brackets, hub])
  // 見えていない欄（ほかの方法で隠れた欄）は書き換えない
  const act = (f: (t: FieldHandle) => void) => {
    const t = hub.getTarget()
    const el = t?.element()
    if (t && el && isFieldVisible(el)) f(t)
    else hub.releaseHidden()
  }

  return (
    <>
      <div
        className="pw-symbols"
        role="toolbar"
        aria-label="巻き戻しと記号"
        data-testid="symbol-bar"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
      >
        <button
          type="button"
          className="btn pw-sym pw-sym-icon"
          onClick={() => act((t) => t.undo())}
          disabled={!canUndo}
          aria-label="巻き戻し"
          title={`巻き戻し（${UNDO_KEY}）`}
          data-testid="undo-button"
        >
          <HistoryUndoIcon />
        </button>
        <button
          type="button"
          className="btn pw-sym pw-sym-icon"
          onClick={() => act((t) => t.redo())}
          disabled={!canRedo}
          aria-label="進む"
          title={`進む（${REDO_KEY}）`}
          data-testid="redo-button"
        >
          <HistoryRedoIcon />
        </button>
        <span className="pw-sym-sep" aria-hidden="true" />
        {TOOLBAR.map((kind) => {
          if (kind === 'brackets') {
            return (
              <button
                key={kind}
                type="button"
                className="btn pw-sym pw-sym-brackets"
                onClick={(e) => {
                  const anchor = e.currentTarget
                  // キーボード（Enter・Space）で押した時は detail が 0
                  const byKeyboard = e.detail === 0
                  if (brackets || !key) setBrackets(null)
                  else setBrackets({ anchor, byKeyboard, key })
                }}
                disabled={!symbolsOn}
                aria-haspopup="menu"
                aria-expanded={brackets !== null}
                aria-label={BRACKETS_LABEL}
                title={symbolsOn ? BRACKETS_TITLE : `${BRACKETS_TITLE}${OFF_HINT}`}
                data-testid="symbol-brackets"
              >
                括弧
              </button>
            )
          }
          const s = SYMBOL_OF.get(kind)!
          return (
            <button
              key={kind}
              type="button"
              className={`btn pw-sym pw-sym-${kind}`}
              onClick={() => act((t) => t.insert(kind))}
              disabled={!symbolsOn}
              aria-label={s.title}
              title={symbolsOn ? s.title : `${s.title}${OFF_HINT}`}
              data-testid={`symbol-${kind}`}
            >
              {s.label}
            </button>
          )
        })}
        <span className="pw-sym-fill" aria-hidden="true" />
        {/* スマホで書いている間（画面上部を畳んでいる間）の保存ボタン */}
        <button
          type="button"
          className="btn btn-primary pw-sym pw-sym-save"
          onClick={onSave}
          disabled={!dirty}
          data-testid="symbol-save"
        >
          保存
        </button>
        {closeKeyboard ? (
          <button
            type="button"
            className="btn pw-sym pw-sym-icon"
            // フォーカスを外すとキーボードが閉じる（押した時にフォーカスを奪わないのはほかのボタンと同じ）
            onClick={() => {
              const active = document.activeElement
              if (active instanceof HTMLElement && active !== document.body) active.blur()
              else hub.getTarget()?.element()?.blur()
            }}
            aria-label="キーボードを閉じる"
            title="キーボードを閉じる"
            data-testid="symbol-close-keyboard"
          >
            <KeyboardHideIcon />
          </button>
        ) : null}
      </div>
      {/* 一覧は body に出す（記号バーの横のスクロールで切れないように） */}
      {brackets && placement ? (
        <PopupMenu
          label="括弧"
          layout="row"
          placement={placement}
          // 指・マウスで開いた時は本文にカーソルを残す（スマホのキーボードも閉じない）。キーボードで開いた時は一覧へ
          autoFocus={brackets.byKeyboard}
          keepFocus
          // 一覧を開いたまま別の記号・保存を押した時も、1回で働く（閉じるだけにしない）
          swallowOutsideClick={false}
          returnFocus={brackets.byKeyboard ? brackets.anchor : undefined}
          items={BRACKETS.map((b) => ({
            label: `${b.open}${b.close}`,
            ariaLabel: `${b.name}（${b.open}${b.close}）`,
            onSelect: () => act((t) => t.insert(b.kind)),
            testId: `bracket-${b.kind}`,
          }))}
          onClose={() => setBrackets(null)}
          testId="bracket-menu"
        />
      ) : null}
    </>
  )
}
