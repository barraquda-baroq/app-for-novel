// 記号バー: 巻き戻し／進む、ダッシュ・三点リーダー・全角空白・ルビ・傍点。
// いま書いている欄（最後にフォーカスした本文・推敲メモ）に働く。押してもフォーカスを奪わない
// （pointerdown / mousedown を止めるので、スマホのキーボードも閉じない）。
// デスクトップは編集画面のいちばん下、スマホはキーボードのすぐ上（閉じている時は画面の下）に常に出す。
import type { SyntheticEvent } from 'react'
import { useHubTarget, useSessionField, type EditorHub } from './editorHub'
import { HistoryRedoIcon, HistoryUndoIcon } from './pieceIcons'
import { SYMBOLS } from './symbols'

/** フォーカスを動かさない（入力欄にカーソルを残し、キーボードを閉じない） */
const keepFocus = (e: SyntheticEvent) => e.preventDefault()

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const UNDO_KEY = MAC ? '⌘Z' : 'Ctrl+Z'
const REDO_KEY = MAC ? '⌘⇧Z' : 'Ctrl+Y'

export function SymbolBar({ hub, dirty, onSave }: { hub: EditorHub; dirty: boolean; onSave: () => void }) {
  const target = useHubTarget(hub)
  const state = useSessionField(hub.session, target?.key ?? null)
  const canUndo = (state?.history.undo.length ?? 0) > 0
  const canRedo = (state?.history.redo.length ?? 0) > 0
  const symbolsOn = target?.symbols ?? false

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
        onClick={() => target?.undo()}
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
        onClick={() => target?.redo()}
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
          onClick={() => target?.insert(s.kind)}
          disabled={!symbolsOn}
          aria-label={s.title}
          title={symbolsOn ? s.title : `${s.title}（本文か推敲メモを書いている時に使えます）`}
          data-testid={`symbol-${s.kind}`}
        >
          {s.label}
        </button>
      ))}
      <span className="pw-sym-space" aria-hidden="true" />
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
    </div>
  )
}
