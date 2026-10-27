// メモ: タイトル内で管理する付箋。タイトル画面では本編より下（一番下）に並ぶ。
import { useDeferredValue } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { countChars, formatCount } from '../../domain/text'
import type { Memo, Title } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { getData, useData } from '../../store/appStore'
import { attempt } from '../../store/uiStore'
import { formatDateTime, formatRelative } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { DraftInput, DraftTextarea } from '../../ui/DraftField'
import { useDocumentTitle } from '../../ui/hooks'
import { NoteIcon, TrashIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { useLiveMemoText } from './memoText'
import './memo.css'

export function MemoPage() {
  const { titleId = '', memoId = '' } = useParams()
  const data = useData()
  const title = data.titles[titleId]
  const memo = data.memos[memoId]
  if (!title || !memo || memo.titleId !== title.id) {
    return <NotFound message="メモが見つかりません。削除された可能性があります。" />
  }
  return <MemoEditor key={memo.id} title={title} memo={memo} />
}

/** 削除後に下書きの保存が届いても何もしない。値が同じなら更新日時を動かさない */
function commitMemo(memoId: string, patch: { name?: string; body?: string }): void {
  const m = getData().memos[memoId]
  if (!m) return
  if ((patch.name === undefined || patch.name === m.name) && (patch.body === undefined || patch.body === m.body)) return
  attempt(() => actions.updateMemo(memoId, patch))
}

function MemoEditor({ title, memo }: { title: Title; memo: Memo }) {
  const navigate = useNavigate()
  const [live, onDraftChange] = useLiveMemoText(memo.id, memo.body)
  const chars = countChars(useDeferredValue(live))
  const name = memo.name.trim() || '無題のメモ'
  useDocumentTitle(`メモ: ${name} — ${title.name}`)

  const remove = async () => {
    const ok = await confirmDialog({
      title: `メモ「${name}」を削除しますか？`,
      message: 'このメモの内容を削除します。この操作は取り消せません。',
      confirmLabel: '削除',
      danger: true,
    })
    if (!ok) return
    if (attempt(() => (actions.deleteMemo(memo.id), true))) navigate(paths.title(title.id))
  }

  return (
    <>
      <AppHeader
        crumbs={[
          { label: title.name || '無題のタイトル', to: paths.title(title.id) },
          { label: `メモ: ${name}` },
        ]}
      />
      <main className="page page-narrow memo-page">
        <article className="memo-sheet" data-testid="memo-sheet">
          <div className="memo-head">
            <span className="badge badge-memo memo-kind">
              <NoteIcon />
              メモ
            </span>
            <DraftInput
              key={memo.id}
              className="input-bare memo-name"
              value={memo.name}
              onCommit={(v) => commitMemo(memo.id, { name: v })}
              placeholder="メモのタイトル"
              aria-label="メモのタイトル"
              data-testid="memo-name"
            />
          </div>
          <DraftTextarea
            key={memo.id}
            className="memo-body"
            value={memo.body}
            onCommit={(v) => commitMemo(memo.id, { body: v })}
            onDraftChange={onDraftChange}
            placeholder="思いついたこと、伏線、調べもの、気になる点など。付箋のように自由に書いておけます。"
            aria-label="メモの本文"
            data-testid="memo-body"
          />
          <div className="memo-foot">
            <span className="memo-meta">
              <span title={formatDateTime(memo.updatedAt)}>{formatRelative(memo.updatedAt)}に更新</span>
              <span aria-hidden="true">・</span>
              <span>{formatCount(chars)}字</span>
            </span>
            <button type="button" className="btn btn-danger memo-delete" onClick={() => void remove()} data-testid="memo-delete">
              <TrashIcon />
              削除
            </button>
          </div>
        </article>
        <p className="memo-hint small faint">メモは本編には含まれず、通し読みにも出ません。タイトル画面の一番下に並びます。</p>
      </main>
    </>
  )
}
