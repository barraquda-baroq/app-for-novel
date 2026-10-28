// タイトル内のメモ（付箋）。表示優先度が最も低く、常に本編の一番下に置く。
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { memosOf } from '../../../domain/entityOps'
import type { ID, Memo } from '../../../domain/types'
import { paths } from '../../../routes'
import { actions } from '../../../store/actions'
import { useData } from '../../../store/appStore'
import { attempt, notify } from '../../../store/uiStore'
import { formatRelative } from '../../../ui/browser'
import { confirmDialog, promptDialog } from '../../../ui/dialogs'
import { DownIcon, NoteIcon, PlusIcon, TrashIcon, UpIcon } from '../../../ui/icons'
import { memoExcerpt } from './storyLogic'

export async function addMemoFlow(titleId: ID): Promise<ID | undefined> {
  const name = await promptDialog({ title: 'メモを追加', label: 'メモのタイトル', placeholder: '例: 伏線の回収リスト', confirmLabel: '追加' })
  if (name === null) return undefined
  const id = attempt(() => actions.addMemo(titleId, name.trim()))
  if (id) notify(`メモ「${name.trim()}」を追加しました`)
  return id
}

export function MemoSection({ titleId }: { titleId: ID }) {
  const data = useData()
  const memos = useMemo(() => memosOf(data, titleId), [data, titleId])
  // 本編の編集モードとは別に切り替える（本編の行が広がってメモの位置がずれないように）
  const [edit, setEdit] = useState(false)
  const editing = edit && memos.length > 0

  return (
    <section className="section story-memos" aria-labelledby="story-memos-heading" data-testid="memo-section">
      <div className="section-head">
        <NoteIcon className="icon story-memo-icon" />
        <h2 id="story-memos-heading">メモ</h2>
        <span className="badge badge-memo">{memos.length}</span>
        <span className="grow" />
        {memos.length > 0 ? (
          <button
            type="button"
            className={`btn btn-sm${editing ? ' story-toggle-on' : ' btn-ghost'}`}
            aria-pressed={editing}
            onClick={() => setEdit(!editing)}
            data-testid="memo-edit-toggle"
          >
            {editing ? '編集を終える' : '並べ替え・削除'}
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={() => void addMemoFlow(titleId)} data-testid="add-memo">
          <PlusIcon />
          メモ
        </button>
      </div>
      {memos.length === 0 ? (
        <p className="story-memo-empty small muted">
          メモはまだありません。思いついたことや伏線の覚え書きなど、付箋のように残しておけます。
        </p>
      ) : (
        <ul className="story-memo-grid">
          {memos.map((m, i) => (
            <MemoCard key={m.id} memo={m} edit={editing} first={i === 0} last={i === memos.length - 1} />
          ))}
        </ul>
      )}
    </section>
  )
}

function MemoCard({ memo, edit, first, last }: { memo: Memo; edit: boolean; first: boolean; last: boolean }) {
  const name = memo.name.trim() || '無題のメモ'
  const excerpt = memoExcerpt(memo.body)

  const remove = async () => {
    const ok = await confirmDialog({
      title: `メモ「${name}」を削除しますか？`,
      message: '元に戻すことはできません。',
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    attempt(() => actions.deleteMemo(memo.id))
  }

  return (
    <li className="story-memo" data-testid="memo-card">
      <Link to={paths.memo(memo.titleId, memo.id)} className="story-memo-link">
        <span className="story-memo-name">{name}</span>
        {excerpt ? <span className="story-memo-body">{excerpt}</span> : <span className="story-memo-body is-empty">（まだ何も書かれていません）</span>}
        <span className="story-memo-time">更新: {formatRelative(memo.updatedAt)}</span>
      </Link>
      {edit ? (
        <div className="story-memo-edit" role="group" aria-label={`${name}の操作`}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => attempt(() => actions.moveMemoStep(memo.id, -1))}
            disabled={first}
            aria-label="上へ"
            title="1つ前へ"
          >
            <UpIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => attempt(() => actions.moveMemoStep(memo.id, 1))}
            disabled={last}
            aria-label="下へ"
            title="1つ後ろへ"
          >
            <DownIcon />
          </button>
          <span className="grow" />
          <button type="button" className="icon-btn story-memo-delete" onClick={() => void remove()} aria-label="削除" title="削除" data-testid="memo-delete">
            <TrashIcon />
          </button>
        </div>
      ) : null}
    </li>
  )
}
