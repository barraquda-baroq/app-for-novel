// アイデア1件のカード。済みのチェックボックス、内容（長い場合は6行で折りたたみ。2行以上なら1行目を少し目立たせる）と、
// 編集・移動・並べ替え（済みでないものだけ）・削除。済み（実装した・没にした）にすると斜線＋グレーで仕切りの下へ沈む
// （通知で知らせ、移った先で少しの間目立たせる）。
// 古い版で付けた見出しがあれば、編集して保存するまでは見出しとして出す。
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { isIdeaChecked } from '../../domain/entityOps'
import { trashNotice } from '../../domain/trash'
import type { Idea } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime, formatRelative } from '../../ui/browser'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { DownIcon, EditIcon, MoveIcon, TrashIcon, UpIcon } from '../../ui/icons'
import { IdeaEditorModal } from './IdeaEditorModal'
import { IdeaMoveDialog } from './IdeaMoveDialog'
import { SparkIcon } from './ideaIcons'
import { ideaEditText, ideaModalDraftKey, ideaShortLabel, splitLead, titleNameFromIdea } from './ideaLogic'
import { useKeepInPlace } from '../../ui/keepInPlace'
import { REVEAL_MS, revealIdea, useReveal } from './reveal'
import { writeLocal } from './storage'

export interface IdeaCardProps {
  idea: Idea
  /** 表示している仕切りの名前（編集ダイアログに出す） */
  sectionName: string
  /** 「どのタイトルにも属さない」仕切りにあるか（「この案でタイトルを作る」を出す） */
  unassigned: boolean
  /** 済みでないアイデアの中で先頭・末尾か（並べ替えのボタン。済みのカードでは使わない） */
  first: boolean
  last: boolean
}

/** 内容が折りたたみ表示（6行。済みは2行）からはみ出しているか */
function useOverflow(text: string, expanded: boolean, checked: boolean) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (expanded) return
      setOverflow(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded, checked])
  return [ref, overflow] as const
}

/** quick capture などで「表示」を押した時に、このカードまでスクロールして少しの間目立たせる（済みにした・外した時は目立たせるだけ） */
function useRevealed(ideaId: string, ref: RefObject<HTMLLIElement | null>): boolean {
  // 同じアイデアをもう一度見せる時も反応させる（seq が変わる）
  const seq = useReveal((s) => (s.id === ideaId ? s.seq : 0))
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!seq) return
    setOn(true)
    let raf = 0
    if (useReveal.getState().scroll) {
      raf = requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        el.scrollIntoView({
          block: 'center',
          behavior: reduce ? 'auto' : 'smooth',
        })
        el.focus({ preventScroll: true })
      })
    }
    const timer = setTimeout(() => setOn(false), REVEAL_MS)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      setOn(false)
    }
  }, [seq, ref])
  return on
}

/**
 * 済みにした・外した後のフォーカス。カードは仕切りの下・済みでないものの末尾へ動くので、
 * 空いた所に来たカード（同じ側の次、なければ前）のチェックボックスへ移し、キーボードで続けて消し込めるようにする。
 * 同じ側にほかのカードがなければ、動いた先の自分のチェックボックスに残して見える所まで出す（フォーカスを画面の外に置かない）
 */
function useKeepCheckFocus(checked: boolean) {
  const ref = useRef<HTMLInputElement>(null)
  // false = チェックボックスにフォーカスがなかった。null = 同じ側にほかのカードがない。要素 = 空いた所に来るカード
  const pending = useRef<HTMLElement | null | false>(false)
  useLayoutEffect(() => {
    const next = pending.current
    if (next === false) return
    pending.current = false
    const el = ref.current
    // カードが動くとフォーカスは外れる（body）。ほかの所へ移っていたら奪わない
    const active = document.activeElement
    if (!el || (active !== el && active !== null && active !== document.body)) return
    // 空いた所に来たカードなので、もう画面に出ている（カードの要素は並びが変わっても作り直されない）
    const target = next?.isConnected ? next.querySelector<HTMLInputElement>('[data-testid="idea-check"]') : null
    if (target) {
      target.focus()
      return
    }
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
  }, [checked])
  /** 済みを切り替える直前に呼ぶ（今のカードの隣を覚える） */
  const mark = () => {
    const el = ref.current
    const li = el?.closest('li')
    if (!el || !li || document.activeElement !== el) {
      pending.current = false
      return
    }
    // 同じ側（済み・済みでない）のカードだけ。区切り「済み n件」は data-checked を持たないので選ばない
    const same = (n: Element | null): n is HTMLElement => n instanceof HTMLElement && n.dataset.checked === li.dataset.checked
    pending.current = [li.nextElementSibling, li.previousElementSibling].find(same) ?? null
  }
  /** 切り替えられなかった時（カードは動かない） */
  const cancel = () => {
    pending.current = false
  }
  return { ref, mark, cancel }
}

function IdeaCardView({ idea, sectionName, unassigned, first, last }: IdeaCardProps) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const checked = isIdeaChecked(idea)
  const heading = idea.heading.trim()
  const body = idea.body
  // 見出しのない（今の版の）アイデアは、2行以上なら1行目を少し目立たせる
  const { lead, rest } = heading ? { lead: '', rest: body } : splitLead(body)
  const [bodyRef, overflow] = useOverflow(body, expanded, checked)
  const label = ideaShortLabel(idea)
  const editDraftKey = ideaModalDraftKey({ mode: 'edit', ideaId: idea.id })
  const { ref: cardRef, move } = useKeepInPlace<HTMLLIElement>()
  const revealed = useRevealed(idea.id, cardRef)
  const check = useKeepCheckFocus(checked)

  const toggleChecked = (next: boolean) => {
    check.mark()
    if (!attempt(() => (actions.setIdeaChecked(idea.id, next), true))) {
      check.cancel()
      return
    }
    // カードは仕切りの下・済みでないものの末尾へ動くので、消えたように見えないよう知らせる（削除とは別）
    notify(
      next
        ? `「${label}」を済みにしました（下の「済み」へ移しました）`
        : `「${label}」の済みを外しました（済みでないものの末尾へ戻しました）`,
    )
    // 移った先で少しの間目立たせる（スクロールはしない。フォーカスは空いた所に来たカードへ。useKeepCheckFocus）
    revealIdea(idea.id, false)
  }

  // 動かしたカードが押した指の下に残るように（続けて押すとそのまま動かし続けられる）
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? '[data-testid="idea-up"]' : '[data-testid="idea-down"]'
    const other = dir < 0 ? '[data-testid="idea-down"]' : '[data-testid="idea-up"]'
    move(() => attempt(() => (actions.moveIdeaStep(idea.id, dir), true)), [same, other])
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'アイデアを削除しますか？',
      message: trashNotice(`「${label}」を`),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteIdea(idea.id), true))) writeLocal(editDraftKey, null)
  }

  const makeTitle = async () => {
    const suggestion = titleNameFromIdea(idea)
    const asked = promptDialog({
      title: 'この案でタイトルを作る',
      label: 'タイトル名（このアイデアは新しいタイトルの仕切りへ移ります）',
      initial: suggestion,
      placeholder: '例: 星の海の図書館',
      confirmLabel: '作成',
      selectOnOpen: true,
    })
    const name = await asked
    if (name === null) return
    const titleId = attempt(() => {
      const id = actions.createTitle(name.trim())
      actions.moveIdeaToSection(idea.id, id)
      return id
    })
    if (!titleId) return
    notify(`タイトル「${getData().titles[titleId]?.name ?? name.trim()}」を作成し、アイデアを移しました`)
    navigate(paths.title(titleId))
  }

  return (
    <li
      ref={cardRef}
      className={`idea-card${checked ? ' is-checked' : ''}${revealed ? ' is-revealed' : ''}`}
      tabIndex={-1}
      data-testid="idea-card"
      data-idea-id={idea.id}
      data-checked={checked}
    >
      <div className="idea-card-top">
        <label
          className="idea-check"
          title={checked ? '済みを外す（済みでないアイデアの末尾に戻す）' : '済みにする（実装した・没にした）'}
        >
          <input
            ref={check.ref}
            type="checkbox"
            checked={checked}
            onChange={(e) => toggleChecked(e.target.checked)}
            aria-label={checked ? `「${label}」の済みを外す` : `「${label}」を済みにする`}
            data-testid="idea-check"
          />
        </label>
        <div className="idea-card-main">
          {heading ? (
            <h4 className="idea-card-heading" data-testid="idea-heading">
              {heading}
            </h4>
          ) : null}
          {body.trim() ? (
            <p ref={bodyRef} className={`idea-card-body${expanded ? ' is-expanded' : ''}`} data-testid="idea-body">
              {lead ? (
                <span className="idea-card-lead" data-testid="idea-lead">
                  {lead}
                </span>
              ) : null}
              {rest}
            </p>
          ) : null}
          {overflow || expanded ? (
            <button
              type="button"
              className="idea-card-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              data-testid="idea-more"
            >
              {expanded ? '折りたたむ' : '続きを表示'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="idea-card-actions" role="group" aria-label={`「${label}」の操作`}>
        {/* 並べ替えは済みでないアイデアの中だけ（済みのものは済みにした順で下にまとまる） */}
        {checked ? null : (
          <>
            <button
              type="button"
              className="icon-btn"
              onClick={() => step(-1)}
              disabled={first}
              aria-label="上へ"
              title="1つ上へ"
              data-testid="idea-up"
            >
              <UpIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => step(1)}
              disabled={last}
              aria-label="下へ"
              title="1つ下へ"
              data-testid="idea-down"
            >
              <DownIcon />
            </button>
          </>
        )}
        <time
          className="idea-card-time"
          dateTime={new Date(idea.updatedAt).toISOString()}
          title={`更新: ${formatDateTime(idea.updatedAt)}`}
        >
          {formatRelative(idea.updatedAt)}
        </time>
        <span className="grow" />
        {unassigned ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost idea-card-make"
            onClick={() => void makeTitle()}
            data-testid="idea-make-title"
          >
            <SparkIcon />
            この案でタイトルを作る
          </button>
        ) : null}
        <span className="idea-card-buttons">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMoving(true)} data-testid="idea-move">
            <MoveIcon />
            移動
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)} data-testid="idea-edit">
            <EditIcon />
            編集
          </button>
          <button
            type="button"
            className="icon-btn idea-card-delete"
            onClick={() => void remove()}
            aria-label="削除"
            title="削除"
            data-testid="idea-delete"
          >
            <TrashIcon />
          </button>
        </span>
      </div>

      {editing ? (
        <IdeaEditorModal
          mode="edit"
          sectionName={sectionName}
          initialBody={ideaEditText(idea)}
          mergedHeading={heading !== ''}
          draftKey={editDraftKey}
          onClose={() => setEditing(false)}
          onSave={(b) => {
            // 見出しは内容の1行目にまとめたので空にする（見出しのないアイデアは変わらない）
            attempt(() => actions.updateIdea(idea.id, idea.heading ? { heading: '', body: b } : { body: b }))
            setEditing(false)
          }}
        />
      ) : null}
      {moving ? <IdeaMoveDialog ideaId={idea.id} onClose={() => setMoving(false)} /> : null}
    </li>
  )
}

/** 一覧の行（レコード単位の props。ほかのアイデアが変わっても描き直さない） */
export const IdeaCard = memo(IdeaCardView)
