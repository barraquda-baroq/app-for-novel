// ホームのタイトル群。カードを押すとタイトルに入る。「並べ替え・編集」で名前の変更・並べ替え・削除ができる。
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { sortedTitles } from '../../domain/entityOps'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { BookIcon, BulbIcon, ChevronRightIcon, DownIcon, EditIcon, MoveIcon, PlusIcon, TrashIcon, UpIcon } from '../../ui/icons'
import { useKeepInPlace } from '../../ui/keepInPlace'
import { charsLabel, deleteTitleMessage, episodesLabel, missingLabel, titleCardInfo, type TitleCardInfo } from './homeLogic'
import { TitleMoveDialog } from './TitleMoveDialog'

export async function createTitleFlow(navigate: (to: string) => void): Promise<void> {
  const name = await promptDialog({
    title: '新しいタイトル',
    label: 'タイトル名',
    placeholder: '例: 星の海の図書館',
    confirmLabel: '作成',
  })
  if (name === null) return
  const id = attempt(() => actions.createTitle(name.trim()))
  if (!id) return
  navigate(paths.title(id))
}

export function TitleGroup({ headingId }: { headingId: string }) {
  const data = useData()
  const navigate = useNavigate()
  const [edit, setEdit] = useState(false)
  const titles = useMemo(() => sortedTitles(data), [data])
  const infos = useMemo(
    () => titles.map((t) => titleCardInfo(data, t.id)).filter((i): i is TitleCardInfo => i !== null),
    [data, titles],
  )
  const editing = edit && infos.length > 0

  return (
    <>
      <div className="home-pane-head">
        <BookIcon className="icon home-pane-icon" />
        <h2 id={headingId} tabIndex={-1}>
          タイトル
        </h2>
        <span className="home-pane-count" data-testid="title-count">
          {infos.length}
        </span>
        <span className="grow" />
        {infos.length > 0 ? (
          <button
            type="button"
            className={`btn btn-sm${editing ? ' home-toggle-on' : ' btn-ghost'}`}
            aria-pressed={editing}
            onClick={() => setEdit((v) => !v)}
            data-testid="titles-edit-toggle"
          >
            <EditIcon />
            {editing ? '編集を終える' : '並べ替え・編集'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm home-new-title"
          onClick={() => void createTitleFlow(navigate)}
          data-testid="new-title"
        >
          <PlusIcon />
          新しいタイトル
        </button>
      </div>

      {infos.length === 0 ? (
        <div className="empty home-empty" data-testid="titles-empty">
          <p>まだタイトルがありません。「＋新しいタイトル」から始めましょう。</p>
          <button type="button" className="btn btn-primary" onClick={() => void createTitleFlow(navigate)}>
            <PlusIcon />
            新しいタイトル
          </button>
        </div>
      ) : (
        <ul className="home-title-list" aria-labelledby={headingId}>
          {infos.map((info, i) => (
            <TitleCard key={info.id} info={info} edit={editing} first={i === 0} last={i === infos.length - 1} />
          ))}
        </ul>
      )}
    </>
  )
}

function TitleCard({ info, edit, first, last }: { info: TitleCardInfo; edit: boolean; first: boolean; last: boolean }) {
  const { summary } = info
  const eps = episodesLabel(summary)
  const missing = missingLabel(summary)
  const [moving, setMoving] = useState(false)
  const { ref, move } = useKeepInPlace<HTMLLIElement>()

  // 動かしたカードが押した指の下に残るように（続けて押すとそのまま動かし続けられる）
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? '[data-testid="title-up"]' : '[data-testid="title-down"]'
    const other = dir < 0 ? '[data-testid="title-down"]' : '[data-testid="title-up"]'
    move(() => attempt(() => (actions.moveTitleStep(info.id, dir), true)), [same, other])
  }

  const rename = async () => {
    const name = await promptDialog({ title: 'タイトル名を変更', label: 'タイトル名', initial: info.name, confirmLabel: '変更' })
    if (name === null) return
    attempt(() => actions.updateTitle(info.id, { name: name.trim() }))
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${info.name}」を削除しますか？`,
      message: deleteTitleMessage(info),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteTitle(info.id), true))) notify(`「${info.name}」を削除しました`)
  }

  return (
    <li ref={ref} className={`home-title-card${edit ? ' is-editing' : ''}`} data-testid="title-card" data-title-id={info.id}>
      <Link to={paths.title(info.id)} className="home-title-link" data-testid="title-card-link">
        <span className="home-title-top">
          <span className="home-title-name" data-testid="title-card-name">
            {info.name}
          </span>
          <ChevronRightIcon className="icon home-title-chevron" />
        </span>
        {info.synopsis ? (
          <span className="home-title-synopsis">{info.synopsis}</span>
        ) : (
          <span className="home-title-synopsis is-empty">あらすじは未記入です</span>
        )}
        <span className="home-title-stats" data-testid="title-card-stats">
          <span className="badge" data-testid="title-card-episodes">
            {eps.main}
            {eps.sub ? <span className="home-title-stat-sub">＋{eps.sub}</span> : null}
          </span>
          <span className="badge" data-testid="title-card-chars">
            {charsLabel(summary.activeChars)}
          </span>
          {missing ? (
            <span className="badge badge-missing" data-testid="title-card-missing">
              {missing}
            </span>
          ) : null}
          {info.chaptersEnabled ? (
            <span className="badge badge-accent" data-testid="title-card-chapters">
              章あり
            </span>
          ) : null}
        </span>
        <span className="home-title-foot">
          <span title={formatDateTime(info.lastEdited)} data-testid="title-card-updated">
            {formatUpdated(info.lastEdited)}
          </span>
          {info.ideaCount > 0 ? (
            <span className="home-title-ideas">
              <BulbIcon />
              アイデア {info.ideaCount}
            </span>
          ) : null}
        </span>
      </Link>

      {edit ? (
        <div className="home-title-edit" role="group" aria-label={`「${info.name}」の操作`}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(-1)}
            disabled={first}
            aria-label="上へ"
            title="1つ上へ"
            data-testid="title-up"
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
            data-testid="title-down"
          >
            <DownIcon />
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMoving(true)}
            disabled={first && last}
            title="位置を選んで移動"
            data-testid="title-move"
          >
            <MoveIcon />
            移動…
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void rename()}
            aria-label="名前を変更"
            data-testid="title-rename"
          >
            <EditIcon />
            名前<span className="hide-mobile">を変更</span>
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="title-delete">
            <TrashIcon />
            削除
          </button>
        </div>
      ) : null}
      {moving ? <TitleMoveDialog titleId={info.id} onClose={() => setMoving(false)} /> : null}
    </li>
  )
}
