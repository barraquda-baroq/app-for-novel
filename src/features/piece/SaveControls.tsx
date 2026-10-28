// 原稿画面のヘッダーの「未保存」「破棄」「保存」。
// スマホでは、保存していない編集がある時だけ「破棄」「保存」を出す（ヘッダーが狭いので「未保存」の文字は保存ボタンの印にする）。
/** 押した時の呼び出し（detail はクリックの回数。キーボードで押した時は 0） */
type Press = (e: { detail: number }) => void

export function SaveControls({ dirty, onSave, onDiscard }: { dirty: boolean; onSave: Press; onDiscard: Press }) {
  return (
    <div className={`pw-save${dirty ? ' is-dirty' : ''}`} role="group" aria-label="保存" data-testid="save-controls">
      {dirty ? (
        <span className="badge badge-unsaved pw-unsaved" data-testid="unsaved-badge">
          未保存
        </span>
      ) : null}
      {dirty ? (
        <button
          type="button"
          className="btn btn-sm pw-discard"
          onClick={onDiscard}
          title="保存していない編集を取り消して、保存した時の内容に戻す"
          data-testid="discard-button"
        >
          破棄
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-sm btn-primary pw-save-btn"
        onClick={onSave}
        disabled={!dirty}
        aria-label={dirty ? '保存（保存していない編集があります）' : '保存（保存していない編集はありません）'}
        title={dirty ? '編集を保存する（Ctrl/⌘+S）' : '保存していない編集はありません'}
        data-testid="save-button"
      >
        保存
      </button>
    </div>
  )
}
