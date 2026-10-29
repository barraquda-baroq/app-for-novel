// 記号バー: 巻き戻し／進む、ダッシュ・三点リーダー・全角空白・ルビ・傍点。
// いま書いている欄（最後にフォーカスした本文・推敲メモ）に働く。押してもフォーカスを奪わない
// （pointerdown / mousedown を止めるので、スマホのキーボードも閉じない）。
// デスクトップは編集画面のいちばん下、スマホはキーボードのすぐ上（閉じている時は画面の下）に常に出す。
// iPhone のアプリは原稿画面でキーボードの「完了」の帯を消すので（src/platform/keyboard.ts）、代わりに「キーボードを閉じる」を出す。
import { useState, useSyncExternalStore, type SyntheticEvent } from 'react'
import { isNativeIos } from '../../platform/platform'
import { isFieldVisible, useHubTarget, type EditorHub, type FieldHandle } from './editorHub'
import { HistoryRedoIcon, HistoryUndoIcon, KeyboardHideIcon } from './pieceIcons'
import { SYMBOLS } from './symbols'

/** フォーカスを動かさない（入力欄にカーソルを残し、キーボードを閉じない） */
const keepFocus = (e: SyntheticEvent) => e.preventDefault()

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const UNDO_KEY = MAC ? '⌘Z' : 'Ctrl+Z'
const REDO_KEY = MAC ? '⌘⇧Z' : 'Ctrl+Y'

export function SymbolBar({ hub, dirty, onSave }: { hub: EditorHub; dirty: boolean; onSave: () => void }) {
  const target = useHubTarget(hub)
  const key = target?.key ?? null
  // 入力のたびには描き直さない（戻せるか・進めるかが変わった時だけ）
  const canUndo = useSyncExternalStore(hub.session.subscribe, () => (key ? hub.session.canUndo(key) : false))
  const canRedo = useSyncExternalStore(hub.session.subscribe, () => (key ? hub.session.canRedo(key) : false))
  const symbolsOn = target?.symbols ?? false
  const [closeKeyboard] = useState(isNativeIos)
  // 見えていない欄（ほかの方法で隠れた欄）は書き換えない
  const act = (f: (t: FieldHandle) => void) => {
    const t = hub.getTarget()
    const el = t?.element()
    if (t && el && isFieldVisible(el)) f(t)
    else hub.releaseHidden()
  }

  return (
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
      {SYMBOLS.map((s) => (
        <button
          key={s.kind}
          type="button"
          className={`btn pw-sym pw-sym-${s.kind}`}
          onClick={() => act((t) => t.insert(s.kind))}
          disabled={!symbolsOn}
          aria-label={s.title}
          title={symbolsOn ? s.title : `${s.title}（本文か推敲メモを書いている時に使えます）`}
          data-testid={`symbol-${s.kind}`}
        >
          {s.label}
        </button>
      ))}
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
  )
}
