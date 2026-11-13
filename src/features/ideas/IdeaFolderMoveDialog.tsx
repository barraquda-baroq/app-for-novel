// フォルダ（2.9）を移すダイアログ（フォルダのメニューの「移動…」）。移動先は、仕切りごとに「1段目にする」と、ほかの1段目のフォルダの中。
// 2段目は、どの仕切りの1段目の中へも・1段目にもできる。中にフォルダの無い1段目は、ほかの1段目の中へ移せる（「任せる」で作られた
// フォルダの整理のため）。中にフォルダのあるフォルダは、フォルダの中へは移せない（3段目は作れない）。
// 位置は移す先の兄弟のフォルダの中で選ぶ（既定は先頭）。仕切りが変わる時は、中のフォルダとカードも一緒にその仕切りへ移る。
// 1段目として見せているのに記録に親へのつながりが残るフォルダ（同期で移動がぶつかった）は、今の場所の「1段目にする」でも移せる
// （つながりを消して、中にフォルダを作れるようにする。moveIdeaFolder）。
import { useContext, useId, useMemo, useState } from 'react'
import { ideaSections } from '../../domain/entityOps'
import { folderNameKey, folderSubtree, ideaFolderName } from '../../domain/ideaFolders'
import { folderPlaceOf, siblingFolders } from '../../domain/ideaFolderOps'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { BookIcon, CheckIcon, FolderIcon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { expandFolders } from './folderCollapse'
import { focusFolderHead } from './folderFlows'
import { InboxIcon } from './ideaIcons'
import { folderMoveTargets, positionOptions, sectionDisplayName, sectionKey, UNASSIGNED_NAME } from './ideaLogic'
import { IdeaSectionOpenContext } from './reveal'

/** 中にフォルダがあるフォルダを、フォルダの中へ移せない理由 */
export const FOLDER_HAS_SUBFOLDERS = '中にフォルダがあるので、ほかのフォルダの中へは移せません（3段目は作れません）'

export function IdeaFolderMoveDialog({ folderId, onClose }: { folderId: ID; onClose: () => void }) {
  const data = useData()
  const formId = useId()
  const noteId = useId()
  const openSection = useContext(IdeaSectionOpenContext)
  const sections = useMemo(() => ideaSections(data), [data])
  const folder = data.ideaFolders[folderId]
  const place = useMemo(() => (folder ? folderPlaceOf(data, folder) : null), [data, folder])
  const subtree = useMemo(() => folderSubtree(data, folderId), [data, folderId])
  const subCount = Math.max(0, subtree.folders.length - 1)
  const targets = useMemo(
    () => (place ? folderMoveTargets(sections, { id: folderId, place, hasSubfolders: subCount > 0 }) : []),
    [sections, folderId, place, subCount],
  )
  // 既定は今の場所（位置だけを変える時もここから）
  const [target, setTarget] = useState<string | null>(() => targets.find((t) => t.current)?.key ?? null)
  /** 移した後の位置（移す先の兄弟の中。既定は先頭） */
  const [position, setPosition] = useState<number | null>(null)

  const chosen = target === null ? null : (targets.find((t) => t.key === target && !t.disabled) ?? null)
  const siblings = useMemo(
    () => (chosen ? siblingFolders(data, { titleId: chosen.titleId, parentId: chosen.parentId }, folderId) : []),
    [data, chosen, folderId],
  )
  const options = useMemo(() => positionOptions(siblings.map((f) => ideaFolderName(f))), [siblings])
  const currentIndex = useMemo(() => {
    if (!chosen?.current || !place) return -1
    const all = siblingFolders(data, place)
    return all.findIndex((f) => f.id === folderId)
  }, [chosen, place, data, folderId])
  const index = position === null ? (chosen?.current ? Math.max(0, currentIndex) : 0) : Math.min(position, siblings.length)
  const option = options.find((o) => o.index === index)

  if (!folder || !place) return null
  const name = ideaFolderName(folder)
  const cards = subtree.ideas.length
  /** 今の場所でも、記録の仕切り・親が見せ方と違う（書いてそろえる） */
  const relink = chosen !== null && chosen.current && (folder.titleId !== chosen.titleId || folder.parentId !== chosen.parentId)
  const unchanged = chosen !== null && chosen.current && index === currentIndex && !relink
  const duplicate =
    chosen !== null && !chosen.current && siblings.some((f) => folderNameKey(f.name) === folderNameKey(folder.name))
  const section = chosen ? sections.find((s) => s.titleId === chosen.titleId) : undefined
  const partitionName = section ? sectionDisplayName(section) : ''
  /** 移す先の表記（「「場面の相談」」・「「星の庭」の1段目」） */
  const dest = chosen ? (chosen.parentId === null ? `「${partitionName}」の1段目` : `「${chosen.name}」`) : ''

  const choose = (key: string) => {
    setTarget(key)
    setPosition(null)
  }

  const submit = () => {
    if (!chosen || unchanged || duplicate) return
    const to = { titleId: chosen.titleId, parentId: chosen.parentId }
    const ok = attempt(() => (actions.moveIdeaFolder(folderId, to, index), true))
    if (!ok) return
    notify(chosen.current && !relink ? '並び順を変えました' : `「${name}」を${dest}へ移しました`)
    // 移した先の仕切りと親のフォルダを開いて、見出しを見せる
    const moved = getData().ideaFolders[folderId]
    if (moved) {
      openSection?.(sectionKey(chosen.titleId))
      if (chosen.parentId) expandFolders([chosen.parentId])
      focusFolderHead(folderId)
    }
    onClose()
  }

  const inner = [subCount ? `中のフォルダ${subCount}つ` : '', cards ? `中のカード ${cards}件` : ''].filter(Boolean).join('と')
  const along = inner ? `（${inner}も一緒に移ります）` : ''
  const partitionNote =
    chosen && chosen.titleId !== place.titleId
      ? chosen.titleId === null
        ? `（「${UNASSIGNED_NAME}」へ移ります）`
        : `（タイトル『${partitionName}』へ移ります）`
      : ''
  const pos = option ? option.label.replace(/（\d+番目）$/u, '') : '先頭'
  const summary = !chosen
    ? '移動先を選んでください。'
    : unchanged
      ? '現在の位置です。移動先か位置を選んでください。'
      : duplicate
        ? '移す先に同じ名前のフォルダがあります。'
        : `「${name}」を${chosen.parentId === null ? dest : `${dest}の中`}の${pos}に移します${along}${partitionNote}`

  return (
    <Modal
      title="フォルダを移動"
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
            disabled={!chosen || unchanged || duplicate}
            data-testid="idea-folder-move-submit"
          >
            移動する
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="idea-move"
        data-testid="idea-folder-move-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="idea-move-lead small muted">「{name}」の移動先と、その中の位置を選んでください。</p>
        {subCount ? (
          <p id={noteId} className="idea-move-note small" data-testid="idea-folder-move-note">
            {FOLDER_HAS_SUBFOLDERS}
          </p>
        ) : null}
        <fieldset className="idea-move-fieldset">
          <legend className="idea-move-legend">移動先</legend>
          <ul className="idea-move-list">
            {targets.map((t) => {
              const selected = t.key === target
              return (
                <li key={t.key}>
                  <label
                    className={`idea-move-option is-depth-${t.depth}${selected ? ' is-selected' : ''}${t.current ? ' is-current' : ''}${t.disabled ? ' is-disabled' : ''}${t.titleId === null && t.depth === 0 ? ' is-unassigned' : ''}`}
                    data-testid="idea-folder-move-option"
                    data-section={sectionKey(t.titleId)}
                    data-parent={t.parentId ?? ''}
                  >
                    <input
                      type="radio"
                      className="visually-hidden"
                      name={`${formId}-target`}
                      value={t.key}
                      checked={selected}
                      disabled={t.disabled}
                      aria-describedby={t.disabled ? noteId : undefined}
                      onChange={() => choose(t.key)}
                    />
                    <span className="idea-move-icon" aria-hidden="true">
                      {t.depth > 0 ? <FolderIcon /> : t.titleId === null ? <InboxIcon /> : <BookIcon />}
                    </span>
                    <span className="idea-move-name">{t.depth === 0 ? `${t.name}（1段目にする）` : t.name}</span>
                    {t.current ? (
                      <span className="idea-move-current">
                        <CheckIcon />
                        現在の場所
                      </span>
                    ) : null}
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
        <label className="field idea-move-position">
          <span>位置</span>
          <select
            className="select"
            value={index}
            onChange={(e) => setPosition(Number(e.target.value))}
            disabled={!chosen}
            data-testid="idea-folder-move-position"
          >
            {options.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
                {o.index === currentIndex && chosen?.current ? '（現在の位置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <p
          className={`idea-move-summary small${duplicate ? ' is-problem' : ' muted'}`}
          role="status"
          data-testid="idea-folder-move-summary"
        >
          {summary}
        </p>
      </form>
    </Modal>
  )
}
