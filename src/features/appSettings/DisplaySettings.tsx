// 表示の設定（この端末だけに保存）: テーマ・原稿の書体と文字サイズ・比較画面の分割・差分ハイライト。
import { useId } from 'react'
import { DEFAULT_PREFS, usePrefs, type EditorFont, type SplitOrientation, type ThemeMode } from '../../store/uiStore'

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'システムに合わせる' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
]

const FONTS: { value: EditorFont; label: string }[] = [
  { value: 'mincho', label: '明朝' },
  { value: 'gothic', label: 'ゴシック' },
]

const SPLITS: { value: SplitOrientation; label: string }[] = [
  { value: 'auto', label: '自動（画面幅で切り替え）' },
  { value: 'horizontal', label: '左右' },
  { value: 'vertical', label: '上下' },
]

export const FONT_SIZE_MIN = 14
export const FONT_SIZE_MAX = 28

const PREVIEW_TEXT =
  '　夜明け前の駅には、まだ誰もいなかった。ホームの端で、少女は小さな鞄を抱えたまま、遠くの線路が白んでいくのを見つめていた。\n「――行こう」と、誰にともなく呟く。'

function Choices<T extends string>({
  labelId,
  options,
  value,
  onChange,
  testid,
}: {
  labelId: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  testid: string
}) {
  return (
    <div className="segmented aset-seg" role="group" aria-labelledby={labelId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          data-testid={`${testid}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function DisplaySettings() {
  const id = useId()
  const theme = usePrefs((s) => s.theme)
  const font = usePrefs((s) => s.editorFont)
  const size = usePrefs((s) => s.editorFontSize)
  const split = usePrefs((s) => s.splitOrientation)
  const showDiff = usePrefs((s) => s.showDiff)
  const setPrefs = usePrefs((s) => s.setPrefs)

  return (
    <section className="card aset-card" aria-labelledby={`${id}-title`} data-testid="display-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>表示</h2>
        <p className="aset-card-lead">この端末だけの設定です。ほかの端末やバックアップには影響しません。</p>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-theme`}>テーマ</span>
        </div>
        <div className="aset-row-control">
          <Choices
            labelId={`${id}-theme`}
            options={THEMES}
            value={theme}
            onChange={(v) => setPrefs({ theme: v })}
            testid="theme"
          />
        </div>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-font`}>原稿の書体</span>
        </div>
        <div className="aset-row-control">
          <Choices
            labelId={`${id}-font`}
            options={FONTS}
            value={font}
            onChange={(v) => setPrefs({ editorFont: v })}
            testid="font"
          />
        </div>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <label htmlFor={`${id}-size`}>文字サイズ</label>
        </div>
        <div className="aset-row-control aset-size">
          <span className="aset-size-mark is-small" aria-hidden="true">
            あ
          </span>
          <input
            id={`${id}-size`}
            type="range"
            className="aset-range"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={size}
            onChange={(e) => setPrefs({ editorFontSize: Number(e.target.value) })}
            aria-valuetext={`${size}ピクセル`}
            data-testid="font-size"
          />
          <span className="aset-size-mark is-large" aria-hidden="true">
            あ
          </span>
          <output htmlFor={`${id}-size`} className="aset-size-value" data-testid="font-size-value">
            {size}px
          </output>
          {size !== DEFAULT_PREFS.editorFontSize ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost aset-size-reset"
              onClick={() => setPrefs({ editorFontSize: DEFAULT_PREFS.editorFontSize })}
            >
              標準（{DEFAULT_PREFS.editorFontSize}px）に戻す
            </button>
          ) : null}
        </div>
      </div>

      <figure className="aset-preview-wrap">
        <figcaption className="aset-preview-caption">原稿の見え方</figcaption>
        <p className="aset-preview" data-testid="font-preview">
          {PREVIEW_TEXT}
        </p>
      </figure>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-split`}>比較画面の分割</span>
          <span className="aset-row-desc">
            採用原稿と推敲バージョンを並べて比べるときの向きです。自動では、広い画面は左右、スマホは上下になります。
          </span>
        </div>
        <div className="aset-row-control">
          <Choices
            labelId={`${id}-split`}
            options={SPLITS}
            value={split}
            onChange={(v) => setPrefs({ splitOrientation: v })}
            testid="split"
          />
        </div>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span id={`${id}-diff`}>比較時に差分をハイライト</span>
          <span className="aset-row-desc">追加された文字と削除された文字に色を付けて表示します。</span>
        </div>
        <div className="aset-row-control">
          <label className="switch aset-switch" data-testid="diff-switch">
            <input
              type="checkbox"
              role="switch"
              checked={showDiff}
              onChange={(e) => setPrefs({ showDiff: e.target.checked })}
              aria-labelledby={`${id}-diff`}
            />
            <span className="track" aria-hidden="true" />
            <span className="aset-switch-state" aria-hidden="true">
              {showDiff ? 'オン' : 'オフ'}
            </span>
          </label>
        </div>
      </div>
    </section>
  )
}
