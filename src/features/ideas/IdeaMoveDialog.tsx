// アイデアを移すダイアログ。移動先は木の形（仕切り（フォルダの外）・1段目・2段目。2.9）で選ぶ。
// - 1枚（カードの［移動］）: 移動先の入れ物の、済みでないアイデアの中の位置を選べる（既定は末尾）。済みのアイデアは位置を選ばない
//   （移動先でも下にまとまる）。既定の移動先は、フォルダの外のカードならほかの仕切りの先頭、フォルダの中のカードならその仕切りの
//   フォルダの外
// - まとめて（「選んで移す」）: 移動先を選ぶまで移せない。位置は選ばず、移動先の末尾に今の並びのまま入る（済みは済みのまま）
// どちらも「選んだ場所に新しいフォルダを作って移す」で、フォルダを作って1回の操作で移せる（2段目の中には作れない）。
// 移した後は、移した先の仕切りとフォルダを開いて、移したカード（まとめての時は最初の1枚）を見せる。
import { useContext, useId, useMemo, useState } from 'react'
import { ideaSections, isIdeaChecked, type IdeaSection } from '../../domain/entityOps'
import { folderPathNames } from '../../domain/ideaFolders'
import type { AppData, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { BookIcon, CheckIcon, FolderIcon, PlusIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { expandFolders } from './folderCollapse'
import { askNewFolderName } from './folderFlows'
import { InboxIcon } from './ideaIcons'
import {
  bulkMovedMessage,
  containerIdeas,
  ideaPlace,
  ideaPlaceName,
  ideaShortLabel,
  moveTargets,
  positionOptions,
  sectionDisplayName,
  sectionKey,
  type MoveTarget,
} from './ideaLogic'
import { IdeaSectionOpenContext, revealIdeaInTree } from './reveal'

export interface IdeaMoveDialogProps {
  /** 移すカード（1枚の時はカードの［移動］） */
  ideaIds: readonly ID[]
  onClose: () => void
  /** まとめて移す（「選んで移す」）。既定は2枚以上の時 */
  bulk?: boolean
  /** 移した後（選ぶのをやめるなど） */
  onMoved?: () => void
}

/** 移動先の場所の表記（仕切りの行は仕切りの名前、フォルダの行は「星の庭 › 場面の相談」） */
function targetLabel(data: AppData, sections: IdeaSection[], t: MoveTarget): string {
  const section = sections.find((s) => s.titleId === t.titleId)
  const name = section ? sectionDisplayName(section) : ''
  return t.folderId === null ? name : ideaPlaceName(name, folderPathNames(data, t.folderId))
}

export function IdeaMoveDialog({ ideaIds, onClose, bulk = ideaIds.length > 1, onMoved }: IdeaMoveDialogProps) {
  const data = useData()
  const formId = useId()
  const noteId = useId()
  const openSection = useContext(IdeaSectionOpenContext)
  const sections = useMemo(() => ideaSections(data), [data])
  const ideas = useMemo(() => ideaIds.map((id) => data.ideas[id]).filter((i) => i !== undefined), [ideaIds, data.ideas])
  // 今いる入れ物（まとめての時は、すべて同じ入れ物にある時だけ印を付ける）
  const currentKey = useMemo(() => {
    const places = ideas.map((i) => ideaPlace(data, i))
    const first = places[0]
    if (!first || places.some((p) => p.titleId !== first.titleId || p.folderId !== first.folderId)) return null
    return JSON.stringify([first.titleId, first.folderId])
  }, [ideas, data])
  const targets = useMemo(() => {
    const current = currentKey === null ? null : (JSON.parse(currentKey) as [ID | null, ID | null])
    return moveTargets(sections, current ? { titleId: current[0], folderId: current[1] } : null)
  }, [sections, currentKey])
  const [target, setTarget] = useState<string | null>(() => {
    if (bulk) return null
    const here = targets.find((t) => t.current)
    if (!here) return null
    // フォルダの外のカードは、ほかの仕切りの先頭（今の仕切りの中で動かす時は「現在の場所」を選ぶ）。フォルダの中のカードは、その仕切りの外
    const def =
      here.folderId === null
        ? (targets.find((t) => t.depth === 0 && !t.current) ?? here)
        : targets.find((t) => t.depth === 0 && t.titleId === here.titleId)
    return (def ?? here).key
  })
  /** 移動後の位置。null = 末尾 */
  const [position, setPosition] = useState<number | null>(null)

  const chosen = target === null ? null : (targets.find((t) => t.key === target) ?? null)
  const single = bulk ? undefined : ideas[0]
  const checked = single ? isIdeaChecked(single) : false
  const section = chosen ? sections.find((s) => s.titleId === chosen.titleId) : undefined
  // 位置は移動先の入れ物の済みでないアイデアの中で数える（済みのものは済みにした順で下にまとまる）
  const open = useMemo(
    () => (section && chosen ? containerIdeas(section, chosen.folderId).filter((i) => !isIdeaChecked(i)) : []),
    [section, chosen],
  )
  const others = useMemo(() => open.filter((i) => i.id !== single?.id), [open, single])
  const options = useMemo(() => positionOptions(others.map((i) => ideaShortLabel(i))), [others])
  const currentIndex = chosen?.current && single ? open.findIndex((i) => i.id === single.id) : -1
  const index = position === null ? others.length : Math.min(position, others.length)
  const option = options.find((o) => o.index === index)

  if (ideas.length === 0 || (!bulk && !single)) return null
  const count = ideas.length
  const label = single ? ideaShortLabel(single) : ''
  const place = chosen ? targetLabel(data, sections, chosen) : ''
  const unchanged = !bulk && chosen !== null && chosen.current && (checked || index === currentIndex)
  const ids = ideas.map((i) => i.id)

  const choose = (key: string) => {
    setTarget(key)
    setPosition(null)
  }

  /** 移した後: 仕切りとフォルダを開いて、移したカード（移す先の並びで最初の1枚）を見せる */
  const reveal = (titleId: ID | null, folderId: ID | null) => {
    const after = ideaSections(getData()).find((s) => s.titleId === titleId)
    const want = new Set(ids)
    const first = after ? containerIdeas(after, folderId).find((i) => want.has(i.id)) : undefined
    if (first) revealIdeaInTree(first.id, openSection)
  }

  const finish = () => {
    onMoved?.()
    onClose()
  }

  const submit = () => {
    if (!chosen || unchanged) return
    if (single) {
      const ok = attempt(() => (actions.moveIdeaTo(single.id, chosen.titleId, index, chosen.folderId), true))
      if (!ok) return
      notify(chosen.current ? '並び順を変えました' : `「${place}」へ移動しました`)
    } else {
      const moved = attempt(() => actions.moveIdeas(ids, { titleId: chosen.titleId, folderId: chosen.folderId }))
      if (moved === undefined) return
      notify(bulkMovedMessage(moved, ideaIds.length, place))
    }
    reveal(chosen.titleId, chosen.folderId)
    finish()
  }

  // 選んだ場所に新しいフォルダを作って移す（仕切りの外 → 1段目、1段目 → その中の2段目。2段目の中には作れない）
  const createAndMove = async () => {
    if (!chosen || chosen.depth === 2) return
    const parentId = chosen.depth === 0 ? null : chosen.folderId
    const name = await askNewFolderName({ titleId: chosen.titleId, parentId })
    if (name === null) return
    const r = attempt(() => actions.createIdeaFolderAndMove(chosen.titleId, parentId, name, ids))
    if (!r) return
    if (parentId) expandFolders([parentId])
    const after = getData()
    const sectionName = section ? sectionDisplayName(section) : ''
    const newPlace = ideaPlaceName(sectionName, folderPathNames(after, r.folderId))
    notify(single ? `「${newPlace}」へ移動しました` : bulkMovedMessage(r.moved, ideaIds.length, newPlace))
    reveal(chosen.titleId, r.folderId)
    finish()
  }

  const summary = (() => {
    if (!chosen) return '移動先を選んでください。'
    if (!single) return `${count}件を「${place}」の末尾に移します。済みのカードは済みのまま、下にまとまります。`
    if (checked) {
      return unchanged
        ? '現在の場所です。移動先を選んでください。'
        : `「${place}」に移ります。済みのまま、済みのアイデアと一緒に下にまとまります。`
    }
    return unchanged
      ? '現在の位置です。移動先か位置を選んでください。'
      : `「${place}」の${option ? option.label.replace(/（\d+番目）$/u, '') : '末尾'}に入ります。`
  })()

  return (
    <Modal
      title={single ? 'アイデアを移動' : `${count}件のアイデアを移動`}
      onClose={onClose}
      initialFocus="input[type=radio]:checked"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={!chosen || unchanged}
            data-testid="idea-move-submit"
          >
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="idea-move"
        data-testid="idea-move-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="idea-move-lead small muted">
          {!single
            ? `選んだ${count}件の移動先を選んでください。移動先の末尾に、今の並びのまま入ります。`
            : checked
              ? `「${label}」の移動先を選んでください。`
              : `「${label}」の移動先と、その中の位置を選んでください。`}
        </p>
        <fieldset className="idea-move-fieldset">
          <legend className="idea-move-legend">移動先</legend>
          <ul className="idea-move-list">
            {targets.map((t) => {
              const selected = t.key === target
              return (
                <li key={t.key}>
                  <label
                    className={`idea-move-option is-depth-${t.depth}${selected ? ' is-selected' : ''}${t.current ? ' is-current' : ''}${t.titleId === null && t.depth === 0 ? ' is-unassigned' : ''}`}
                    data-testid="idea-move-option"
                    data-section={sectionKey(t.titleId)}
                    data-folder={t.folderId ?? ''}
                    data-depth={t.depth}
                  >
                    <input
                      type="radio"
                      className="visually-hidden"
                      name={`${formId}-target`}
                      value={t.key}
                      checked={selected}
                      onChange={() => choose(t.key)}
                    />
                    <span className="idea-move-icon" aria-hidden="true">
                      {t.depth > 0 ? <FolderIcon /> : t.titleId === null ? <InboxIcon /> : <BookIcon />}
                    </span>
                    <span className="idea-move-name">{t.name}</span>
                    {t.current ? (
                      <span className="idea-move-current">
                        <CheckIcon />
                        現在の場所
                      </span>
                    ) : (
                      <span className="idea-move-count">{t.count}件</span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
        <div className="idea-move-new">
          <button
            type="button"
            className="btn btn-sm btn-ghost idea-move-new-folder"
            onClick={() => void createAndMove()}
            disabled={!chosen || chosen.depth === 2}
            aria-describedby={chosen?.depth === 2 ? noteId : undefined}
            data-testid="idea-move-new-folder"
          >
            <PlusIcon />
            選んだ場所に新しいフォルダを作って移す…
          </button>
          {chosen?.depth === 2 ? (
            <span id={noteId} className="idea-move-new-note small muted" data-testid="idea-move-new-note">
              3段目は作れません
            </span>
          ) : null}
        </div>
        {single && !checked ? (
          <label className="field idea-move-position">
            <span>位置</span>
            <select
              className="select"
              value={index}
              onChange={(e) => setPosition(Number(e.target.value))}
              disabled={!chosen}
              data-testid="idea-move-position"
            >
              {options.map((o) => (
                <option key={o.index} value={o.index}>
                  {o.label}
                  {o.index === currentIndex ? '（現在の位置）' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="idea-move-summary small muted" role="status" data-testid="idea-move-summary">
          {summary}
        </p>
      </form>
    </Modal>
  )
}
