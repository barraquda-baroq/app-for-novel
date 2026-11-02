// 資料のタグの編集（2.6）: 付けたタグのチップ（×で外す）と入力欄。Enter・「、」・「,」で足し、使っているタグを候補に出す。
// タグは作者が自分で付けて管理する（Claude は付けない）。並びは付けた順。1つ20字まで・1つの資料に20個まで。
// 日本語の入力（IME）の変換中は Enter・「、」で足さない（変換を確定してから）。
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { MATERIAL_LIMITS } from '../../domain/materialOps'
import { PlusIcon, TagIcon, XIcon } from '../../ui/icons'
import { addTags, hasTagSeparator, splitTagInput, tagSuggestions } from './materialLogic'

export interface TagEditorProps {
  /** 付けたタグ（付けた順） */
  tags: readonly string[]
  onChange: (tags: string[]) => void
  /** 使っているタグ（多く使われている順。候補に出す） */
  inUse: readonly string[]
  /**
   * 保存の前に呼ぶと、入力欄に打ちかけのタグも足した並びを返す（入力欄は空にする）。
   * 入力欄から別の欄へ移らずに保存した時にも、打ったタグを落とさないように。打ちかけのタグを足せない時
   * （20字を超える・20個を超える）は null を返し、入力欄に残して理由を出す（保存しない）
   */
  flushRef?: MutableRefObject<(() => string[] | null) | null>
  /** 見出し（既定「タグ（任意）」） */
  label?: string
}

export function TagEditor({ tags, onChange, inUse, flushRef, label = 'タグ（任意）' }: TagEditorProps) {
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const full = tags.length >= MATERIAL_LIMITS.tags
  const suggestions = useMemo(() => tagSuggestions(inUse, tags, text), [inUse, tags, text])

  /**
   * 区切りの前のタグを足し、残りを入力欄に残す。足せなかったタグ（20字を超える・20個を超える）は入力欄に戻し
   * （打ち直さずに直せるように）、null を返す
   */
  const take = (value: string, all = false): string[] | null => {
    const { done, rest } = all ? { done: [value], rest: '' } : splitTagInput(value)
    if (!done.some((t) => t.trim())) {
      setText(rest)
      setError(null)
      return [...tags]
    }
    const r = addTags(tags, done)
    setError(r.error)
    if (r.tags.length !== tags.length) onChange(r.tags)
    setText(r.rejected.length ? [...r.rejected, rest].filter(Boolean).join('、') : rest)
    return r.rejected.length ? null : r.tags
  }

  useEffect(() => {
    if (!flushRef) return
    flushRef.current = () => (text.trim() ? take(text, true) : [...tags])
    return () => {
      flushRef.current = null
    }
  })

  const add = (tag: string) => {
    take(tag, true)
    inputRef.current?.focus()
  }

  const remove = (index: number) => {
    onChange(tags.filter((_, i) => i !== index))
    setError(null)
    inputRef.current?.focus()
  }

  return (
    <div className="field mt-tags-field" data-testid="material-tag-editor">
      <label htmlFor={inputId} className="mt-tags-label">
        <TagIcon />
        {label}
      </label>
      {tags.length ? (
        <ul className="mt-tag-list" aria-label="付けたタグ" data-testid="material-tag-chips">
          {tags.map((t, i) => (
            <li key={`${t}-${i}`} className="mt-tag-chip" data-testid="material-tag-chip-edit">
              <span className="mt-tag-name">{t}</span>
              <button
                type="button"
                className="mt-tag-remove"
                onClick={() => remove(i)}
                aria-label={`タグ「${t}」を外す`}
                title="外す"
                data-testid="material-tag-remove"
              >
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={inputId}
        ref={inputRef}
        className="input"
        value={text}
        // 20個の時も、押せないようにはせず読むだけにする（フォーカスを失わず、×で外した後すぐ打てるように）
        readOnly={full}
        aria-disabled={full || undefined}
        enterKeyHint="enter"
        autoComplete="off"
        placeholder={full ? `タグは${MATERIAL_LIMITS.tags}個までです` : '例：ミリタリ、現代、戦闘'}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(e) => {
          composing.current = false
          const value = e.currentTarget.value
          if (hasTagSeparator(value)) take(value)
        }}
        onChange={(e) => {
          const value = e.target.value
          if (!composing.current && hasTagSeparator(value)) take(value)
          else {
            setText(value)
            if (error) setError(null)
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter' && text.trim()) {
            // フォームを送らずにタグを足す（空の時は、ほかの欄と同じくフォームを送る）
            e.preventDefault()
            take(text, true)
          } else if (e.key === 'Backspace' && text === '' && tags.length) {
            remove(tags.length - 1)
          }
        }}
        // 入力欄から離れただけでは足さない（打ちかけのタグは保存の時に flushRef で足す）。離れた時に足すと、候補の列が
        // 出てダイアログの高さが変わり、押そうとした［保存］が指の下から動いて押せないことがあるため
        data-testid="material-tag-input"
      />
      <span id={hintId} className="small muted mt-tags-hint">
        Enter・「、」・「,」で区切って足します（1つ{MATERIAL_LIMITS.tag}字・{MATERIAL_LIMITS.tags}
        個まで）。タグは作者が付けるもので、Claude は付けません。
      </span>
      {error ? (
        <span id={errorId} className="cl-error small" role="alert" data-testid="material-tag-error">
          {error}
        </span>
      ) : null}
      {suggestions.length && !full ? (
        <div
          className="mt-tag-suggestions"
          role="group"
          aria-label="使っているタグから付ける"
          data-testid="material-tag-suggestions"
        >
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              className="mt-tag-suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(t)}
              aria-label={`タグ「${t}」を付ける`}
              data-testid="material-tag-suggestion"
            >
              <PlusIcon />
              {t}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
