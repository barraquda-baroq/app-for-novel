// 「＋追加」ダイアログ。タイトルから追加するときは必ず「話数追加」「特殊追加」「メモ」から選ぶ。
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { episodeTargets, insertOptions } from '../../../domain/storyOps'
import { chaptersOf, effectiveNumbering } from '../../../domain/structure'
import type { ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { DocIcon, NoteIcon, StarIcon } from '../../../ui/icons'
import { Modal } from '../../../ui/Modal'
import {
  SPECIAL_SUGGESTIONS,
  chapterName,
  defaultEpisodeTarget,
  optionsWithinChapter,
  previewEpisode,
  specialPositionPreference,
} from './storyLogic'

export type AddKind = 'episode' | 'special' | 'memo'

export interface AddDialogProps {
  titleId: ID
  onClose: () => void
  /** 種類をあらかじめ選んでおく（章の「＋話数追加」など） */
  presetKind?: AddKind
  /** 話数追加の追加先・特殊追加の差し込み範囲をこの章にする */
  chapterId?: ID
}

const KINDS: { kind: AddKind; title: string; desc: string; icon: typeof DocIcon }[] = [
  { kind: 'episode', title: '話数追加', desc: '次の「第n話」を作ります。話数は自動で決まります。', icon: DocIcon },
  { kind: 'special', title: '特殊追加', desc: 'プロローグ・幕間など、話数に数えないブロックを差し込みます。', icon: StarIcon },
  { kind: 'memo', title: 'メモ', desc: 'タイトル付きの付箋。本編の下にまとめて置かれます。', icon: NoteIcon },
]

export function AddDialog({ titleId, onClose, presetKind, chapterId }: AddDialogProps) {
  const data = useData()
  const navigate = useNavigate()
  const formId = useId()
  const title = data.titles[titleId]
  const [kind, setKind] = useState<AddKind | null>(presetKind ?? null)
  // 種類を選んだら入力欄が見えるようにスクロールする（横持ちのスマホなど、高さが低いと入力欄が下に隠れるため）
  const formRef = useRef<HTMLFormElement>(null)
  const revealForm = useRef(false)
  useEffect(() => {
    if (!revealForm.current) return
    revealForm.current = false
    formRef.current?.scrollIntoView({ block: 'nearest' })
  }, [kind])
  const chooseKind = (next: AddKind) => {
    revealForm.current = next !== kind
    setKind(next)
  }

  // 話数追加
  const targets = useMemo(() => episodeTargets(data, titleId), [data, titleId])
  const [target, setTarget] = useState<ID | null | undefined>(() => {
    if (chapterId && targets.some((t) => t.chapterId === chapterId)) return chapterId
    return defaultEpisodeTarget(data, titleId, targets)
  })
  const chaptersOn = Boolean(title?.chaptersEnabled)
  const effectiveTarget = chaptersOn ? target : undefined
  const preview = useMemo(() => previewEpisode(data, titleId, effectiveTarget), [data, titleId, effectiveTarget])
  const [subtitle, setSubtitle] = useState('')

  // 特殊追加
  const allOptions = useMemo(() => insertOptions(data, titleId), [data, titleId])
  const options = useMemo(
    () => (chapterId && chaptersOn ? optionsWithinChapter(allOptions, chapterId) : allOptions),
    [allOptions, chapterId, chaptersOn],
  )
  const [label, setLabel] = useState('プロローグ')
  const [position, setPosition] = useState(0)
  // 差し込む位置を自分で選んだら、見出しを打ち直しても位置は自動で変えない
  const [positionTouched, setPositionTouched] = useState(false)
  const positionIndex = Math.min(position, Math.max(0, options.length - 1))

  // メモ
  const [memoName, setMemoName] = useState('')
  const memoInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // メモはタイトルが必須なので、選んだらすぐ入力できるようにする
    if (kind === 'memo') memoInput.current?.focus()
  }, [kind])
  const excludedChapters = useMemo(
    () => (chaptersOn ? chaptersOf(data, titleId).length + 1 - targets.length : 0),
    [chaptersOn, data, titleId, targets],
  )

  if (!title) return null

  /** 見出しに合わせて既定の位置を選ぶ（プロローグは先頭、エピローグ・あとがきは末尾） */
  const applyLabel = (next: string, { force }: { force: boolean }) => {
    setLabel(next)
    if (!force && positionTouched) return
    const pref = specialPositionPreference(next)
    if (pref === 'first') setPosition(0)
    else if (pref === 'last') setPosition(options.length - 1)
  }

  const canSubmit =
    kind === 'episode'
      ? preview !== null
      : kind === 'special'
        ? label.trim().length > 0 && options.length > 0
        : kind === 'memo'
          ? memoName.trim().length > 0
          : false

  const submit = () => {
    if (!canSubmit || !kind) return
    if (kind === 'episode') {
      const id = attempt(() => actions.addEpisode(titleId, effectiveTarget))
      if (!id) return
      if (subtitle.trim()) attempt(() => actions.updatePiece(id, { subtitle: subtitle.trim() }))
      onClose()
      navigate(paths.piece(titleId, id))
      return
    }
    if (kind === 'special') {
      const opt = options[positionIndex]
      if (!opt) return
      const id = attempt(() => actions.addSpecial(titleId, opt.slot, label.trim()))
      if (!id) return
      if (subtitle.trim()) attempt(() => actions.updatePiece(id, { subtitle: subtitle.trim() }))
      onClose()
      navigate(paths.piece(titleId, id))
      return
    }
    const id = attempt(() => actions.addMemo(titleId, memoName.trim()))
    if (!id) return
    notify(`メモ「${memoName.trim()}」を追加しました`)
    onClose()
  }

  const submitLabel =
    kind === 'episode'
      ? preview
        ? `第${preview.number}話を作成`
        : '作成'
      : kind === 'special'
        ? 'ブロックを差し込む'
        : kind === 'memo'
          ? 'メモを作成'
          : '追加'

  const numberingNote = !chaptersOn
    ? null
    : effectiveNumbering(title) === 'perChapter'
      ? '章ごとに第1話から数えるので、選んだ章の最新話として追加されます。'
      : excludedChapters > 0
        ? '通し番号では、新しい話は必ず最新の話数になります。そのため最新話より前の章は選べません（追加したあとで並べ替えれば移動できます）。'
        : '通し番号では、新しい話は必ず最新の話数になります。'

  return (
    <Modal
      title="追加する"
      onClose={onClose}
      initialFocus={presetKind ? '[data-kind-autofocus]' : '[data-choice-autofocus]'}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!canSubmit} data-testid="add-submit">
            {submitLabel}
          </button>
        </>
      }
    >
      <div className="story-add" data-testid="add-dialog">
        <p className="story-add-lead small muted" id={`${formId}-lead`}>
          追加する種類を選んでください。
        </p>
        <div className="story-add-choices" role="group" aria-labelledby={`${formId}-lead`}>
          {KINDS.map((k, i) => {
            const Icon = k.icon
            return (
              <button
                key={k.kind}
                type="button"
                className={`choice story-add-choice is-${k.kind}`}
                aria-pressed={kind === k.kind}
                onClick={() => chooseKind(k.kind)}
                data-testid={`add-kind-${k.kind}`}
                {...(i === 0 ? { 'data-choice-autofocus': true } : {})}
              >
                <span className="story-add-choice-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="story-add-choice-text">
                  <strong>{k.title}</strong>
                  <span>{k.desc}</span>
                </span>
              </button>
            )
          })}
        </div>

        <form
          ref={formRef}
          id={formId}
          className="story-add-form stack"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {kind === null ? <p className="story-add-placeholder small faint">種類を選ぶと、ここに入力欄が表示されます。</p> : null}

          {kind === 'episode' ? (
            <>
              <div className="story-add-preview" role="status" data-testid="episode-preview">
                {preview ? (
                  <>
                    <span>
                      <strong>{preview.description}</strong>が作成されます。
                    </span>
                    {preview.placement ? (
                      <span className="story-add-placement" data-testid="episode-placement">
                        {preview.placement}
                      </span>
                    ) : null}
                    <span className="small muted">話数は自動で決まり、後から変更できません。</span>
                  </>
                ) : (
                  <span>この章には話数追加できません。</span>
                )}
              </div>
              {chaptersOn ? (
                <label className="field">
                  <span>追加先の章</span>
                  <select
                    className="select"
                    value={target === null ? '__root__' : (target ?? '')}
                    onChange={(e) => setTarget(e.target.value === '__root__' ? null : e.target.value)}
                    data-testid="episode-target"
                    {...(presetKind ? { 'data-kind-autofocus': true } : {})}
                  >
                    {targets.map((t) => (
                      <option key={t.chapterId ?? '__root__'} value={t.chapterId ?? '__root__'}>
                        {t.chapterId ? chapterName(data.chapters[t.chapterId]) : t.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {numberingNote ? <p className="small muted story-add-note">{numberingNote}</p> : null}
              <label className="field">
                <span>話の題（任意）</span>
                <input
                  className="input"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="例: 旅立ちの朝"
                  data-testid="add-subtitle"
                  {...(presetKind && !chaptersOn ? { 'data-kind-autofocus': true } : {})}
                />
              </label>
            </>
          ) : null}

          {kind === 'special' ? (
            <>
              <p className="small muted story-add-note">
                話数に数えないブロックです。第n話の代わりに、見出しを自由に付けられます。話数が決まった後からでも好きな位置に差し込めます。
              </p>
              <label className="field">
                <span>見出し</span>
                <input
                  className="input"
                  value={label}
                  onChange={(e) => applyLabel(e.target.value, { force: false })}
                  data-testid="special-label"
                  {...(presetKind ? { 'data-kind-autofocus': true } : {})}
                />
              </label>
              <div className="story-add-suggest" role="group" aria-label="見出しの候補">
                {SPECIAL_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="story-add-suggest-chip"
                    aria-pressed={label.trim() === s}
                    onClick={() => applyLabel(s, { force: true })}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>差し込む位置{chapterId && chaptersOn ? '（この章の中）' : ''}</span>
                <select
                  className="select"
                  value={positionIndex}
                  onChange={(e) => {
                    setPosition(Number(e.target.value))
                    setPositionTouched(true)
                  }}
                  data-testid="special-position"
                >
                  {options.map((o, i) => (
                    <option key={i} value={i}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>話の題（任意）</span>
                <input
                  className="input"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="例: 雨の夜に"
                  data-testid="add-subtitle"
                />
              </label>
            </>
          ) : null}

          {kind === 'memo' ? (
            <>
              <p className="small muted story-add-note">
                付箋のように使える覚え書きです。本編には含まれず、タイトル画面の一番下にまとめて表示されます。
              </p>
              <label className="field">
                <span>メモのタイトル</span>
                <input
                  className="input"
                  value={memoName}
                  onChange={(e) => setMemoName(e.target.value)}
                  placeholder="例: 伏線の回収リスト"
                  data-testid="memo-name"
                  ref={memoInput}
                />
              </label>
            </>
          ) : null}
        </form>
      </div>
    </Modal>
  )
}
