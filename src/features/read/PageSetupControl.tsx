// 通し読みの縦書きのツールバー「40字×32行 ▾」: ページの字数×行数（タイトルごと。Title.pageSetup。同期する）を選ぶ。
// 20×20・40×30・40×32・40×40・42×34 と「自由に入力」（字数 10〜60・行数 5〜60）。
import { useId, useState } from 'react'
import { checkPageSetup, isPresetPageSetup, PAGE_SETUP_PRESETS, pageSetupLongLabel, samePageSetup } from '../../domain/pageSetup'
import type { PageSetup } from '../../domain/types'
import { CheckIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { PopupMenu, type PopupMenuItem } from '../../ui/PopupMenu'

export function PageSetupControl({ setup, onChange }: { setup: PageSetup; onChange: (next: PageSetup) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [custom, setCustom] = useState(false)
  const preset = isPresetPageSetup(setup)
  const blank = <span className="rt-grid-blank" />
  const items: PopupMenuItem[] = [
    ...PAGE_SETUP_PRESETS.map((p) => ({
      label: pageSetupLongLabel(p),
      icon: samePageSetup(p, setup) ? <CheckIcon /> : blank,
      onSelect: () => onChange({ chars: p.chars, lines: p.lines }),
      testId: `page-setup-${p.chars}x${p.lines}`,
    })),
    {
      label: '自由に入力',
      hint: preset ? undefined : `今は ${pageSetupLongLabel(setup)}`,
      icon: preset ? blank : <CheckIcon />,
      onSelect: () => setCustom(true),
      testId: 'page-setup-custom',
    },
  ]
  return (
    <>
      <button
        type="button"
        className="btn btn-sm rt-grid-btn"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`ページの字数×行数（${pageSetupLongLabel(setup)}）`}
        title="縦書きのページの字数×行数（このタイトルの設定）"
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        data-testid="page-setup-button"
      >
        <span data-testid="page-setup-value">{pageSetupLongLabel(setup)}</span>
        <span className="rt-grid-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {anchor ? (
        <PopupMenu
          label="ページの字数×行数"
          placement={{ anchor }}
          returnFocus={anchor}
          onClose={() => setAnchor(null)}
          items={items}
          testId="page-setup-menu"
        />
      ) : null}
      {custom ? (
        <PageSetupDialog
          setup={setup}
          onClose={() => setCustom(false)}
          onSubmit={(next) => {
            setCustom(false)
            onChange(next)
          }}
        />
      ) : null}
    </>
  )
}

/** 「自由に入力」: 1行の字数と1ページの行数（全角の数字も読む） */
function PageSetupDialog({
  setup,
  onClose,
  onSubmit,
}: {
  setup: PageSetup
  onClose: () => void
  onSubmit: (next: PageSetup) => void
}) {
  const [chars, setChars] = useState(String(setup.chars))
  const [lines, setLines] = useState(String(setup.lines))
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const submit = () => {
    const r = checkPageSetup(chars, lines)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onSubmit(r.setup)
  }
  return (
    <Modal
      title="ページの字数×行数"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="page-setup-apply">
            決める
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        data-testid="page-setup-dialog"
      >
        <p className="small muted rt-grid-note">このタイトルの縦書きのページを、1行の字数×1ページの行数で組みます。</p>
        <div className="rt-grid-fields">
          <label className="field">
            <span>1行の字数（10〜60）</span>
            <span className="rt-grid-input">
              <input
                className="input"
                inputMode="numeric"
                value={chars}
                onChange={(e) => {
                  setChars(e.target.value)
                  setError(null)
                }}
                aria-invalid={error !== null && error.startsWith('1行') ? true : undefined}
                data-testid="page-setup-chars"
              />
              字
            </span>
          </label>
          <span className="rt-grid-times" aria-hidden="true">
            ×
          </span>
          <label className="field">
            <span>1ページの行数（5〜60）</span>
            <span className="rt-grid-input">
              <input
                className="input"
                inputMode="numeric"
                value={lines}
                onChange={(e) => {
                  setLines(e.target.value)
                  setError(null)
                }}
                aria-invalid={error !== null && error.startsWith('1ページ') ? true : undefined}
                data-testid="page-setup-lines"
              />
              行
            </span>
          </label>
        </div>
        {error ? (
          <p className="rt-grid-error" role="alert" data-testid="page-setup-error">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  )
}
