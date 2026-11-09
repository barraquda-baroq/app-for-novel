// 資料の画面（/materials/:materialId）: 資料の情報（直せる）と、記録の一覧（項目ごと。決まった4つの項目「要約」「創作に役立つ知識」
// 「描写に使える部分」「サンプルシーン」をこの順に、その後にほかの項目を最初に記録した順。中は新しい日付から。分けて記録したものは
// 番号の順）。記録は開閉でき、長い記録は閉じている間は頭だけを変換して出す（「全文を表示」で全部）。
// 記録は手で足す・直す・削除でき、「Claude に頼む（手動）」で PDF を置いた claude.ai のプロジェクトに渡す依頼文をコピーし、
// 「結果を貼り付け」で取り込む（2回貼り付けても増えない）。相対比較の作品の画面（BenchWorkPage）と同じ作り。
// タグ（ミリタリ・現代・戦闘…）は作者が自分で付けて管理する（Claude は付けない）。「タグを編集」で付け直せる。
import { memo, useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { materialNotesOf } from '../../claude/materialOrder'
import { isNewerRecord, NEWER_RECORD_LABEL } from '../../claude/visibility'
import { formatCount } from '../../domain/text'
import { trashNotice } from '../../domain/trash'
import type { ID, Material, MaterialNote } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData, useRecord } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { copyText, formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { useDocumentTitle } from '../../ui/hooks'
import { ChevronRightIcon, CopyIcon, EditIcon, OpenBookIcon, PlusIcon, TagIcon, TrashIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { AskIcon, PasteIcon, SparkIcon } from '../claude/claudeIcons'
import { sourceLabel } from '../claude/claudeUi'
import { Markdown } from '../claude/Markdown'
import { PasteResultDialog } from '../claude/PasteResultDialog'
import { MaterialDialog } from './MaterialDialog'
import { MaterialManualDialog } from './MaterialManualDialog'
import { MaterialNoteDialog } from './MaterialNoteDialog'
import { MaterialTagsEditDialog } from './MaterialTagDialogs'
import {
  biblioLine,
  deleteMaterialMessage,
  materialCreatedBy,
  materialLastUpdated,
  materialName,
  materialTags,
  noteDateLabel,
  noteGroups,
  notePreview,
} from './materialLogic'
import '../title/strategy/claudeSections.css'
import './materials.css'
import './tags.css'

/** 開いた記録で、これより長ければ頭だけを出して「全文を表示」（閉じている間は頭だけを変換する。Markdown.tsx） */
const LONG_NOTE = 900

export function MaterialPage() {
  const { materialId = '' } = useParams()
  const material = useRecord('materials', materialId)
  if (!material)
    return (
      <NotFound
        message="資料が見つかりません。削除された可能性があります。"
        action={{ to: paths.homeArea('materials'), label: '資料の一覧へ' }}
      />
    )
  return <MaterialView key={material.id} material={material} />
}

function MaterialView({ material }: { material: Material }) {
  const navigate = useNavigate()
  const data = useData()
  const name = materialName(material)
  useDocumentTitle(`資料: ${name}`)
  const notes = useMemo(() => materialNotesOf(data, material.id), [data.materialNotes, material.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => noteGroups(notes), [notes])
  const [editMaterial, setEditMaterial] = useState(false)
  const [editTags, setEditTags] = useState(false)
  const [editing, setEditing] = useState<{ note: MaterialNote | null; section?: string } | null>(null)
  const [manual, setManual] = useState(false)
  const [paste, setPaste] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<ID>>(() => new Set())
  const [full, setFull] = useState<ReadonlySet<ID>>(() => new Set())
  const biblio = biblioLine(material)
  const tags = materialTags(material)
  const createdBy = materialCreatedBy(material.source)
  const updated = materialLastUpdated(material, notes)
  const totalChars = useMemo(() => notes.reduce((n, a) => n + a.body.length, 0), [notes])

  const flip = (set: ReadonlySet<ID>, id: ID) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const toggle = useCallback((id: ID) => setOpen((prev) => flip(prev, id)), [])
  const toggleFull = useCallback((id: ID) => setFull((prev) => flip(prev, id)), [])
  const edit = useCallback((note: MaterialNote) => setEditing({ note }), [])
  const allOpen = notes.length > 0 && notes.every((n) => open.has(n.id))

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${name}」を削除しますか？`,
      message: deleteMaterialMessage(notes.length),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteMaterial(material.id), true))) {
      notify(`「${name}」をゴミ箱に移しました`)
      navigate(paths.homeArea('materials'))
    }
  }

  return (
    <>
      <AppHeader
        crumbs={[{ label: 'ホーム', to: paths.home() }, { label: '資料', to: paths.homeArea('materials') }, { label: name }]}
      />
      <main className="page mt-page" data-area="materials" data-testid="material-page">
        <section className="mt-head card" aria-labelledby="mt-name" data-testid="material-head">
          <div className="mt-head-top">
            <span className="badge mt-kind">
              <OpenBookIcon />
              資料
            </span>
            {createdBy ? (
              <span className="badge cl-badge" data-testid="material-source">
                <SparkIcon />
                {createdBy}
              </span>
            ) : null}
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={() => setEditMaterial(true)} data-testid="material-edit">
              <EditIcon />
              資料の情報を直す
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="material-delete">
              <TrashIcon />
              削除
            </button>
          </div>
          <h1 id="mt-name" className="mt-name" data-testid="material-title">
            {name}
          </h1>
          {biblio ? (
            <p className="mt-biblio" data-testid="material-biblio">
              {biblio}
            </p>
          ) : null}
          <div className="mt-tags-row" data-testid="material-tags">
            <TagIcon className="icon mt-tags-icon" />
            {tags.length ? (
              <ul className="mt-tag-list" aria-label="タグ">
                {tags.map((t, i) => (
                  <li key={`${t}-${i}`} className="mt-tag-chip is-static" data-testid="material-tag">
                    {t}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small muted" data-testid="material-no-tags">
                タグなし
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditTags(true)}
              data-testid="material-edit-tags"
            >
              <EditIcon />
              {tags.length ? 'タグを編集' : 'タグを付ける'}
            </button>
          </div>
          <dl className="mt-facts">
            <div>
              <dt>PDF の置き場所</dt>
              <dd data-testid="material-pdf-place">{material.pdfPlace.trim() || '（未記入）'}</dd>
            </div>
            <div>
              <dt>最終更新</dt>
              <dd title={formatDateTime(updated)}>{formatUpdated(updated)}</dd>
            </div>
          </dl>
          {material.note.trim() ? (
            <p className="mt-note" data-testid="material-note-text">
              {material.note}
            </p>
          ) : null}
        </section>

        <section className="mt-notes" aria-labelledby="mt-notes-heading" data-testid="material-notes">
          <div className="mt-notes-head">
            <h2 id="mt-notes-heading">
              記録<span className="sx-count">{notes.length}</span>
            </h2>
            {notes.length ? <span className="small muted">合計 {formatCount(totalChars)}字</span> : null}
            <span className="grow" />
            {notes.length ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setOpen(allOpen ? new Set() : new Set(notes.map((n) => n.id)))}
                data-testid="material-toggle-all"
              >
                {allOpen ? 'すべて閉じる' : 'すべて開く'}
              </button>
            ) : null}
          </div>
          <div className="mt-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setEditing({ note: null })}
              data-testid="material-add-note"
            >
              <PlusIcon />
              記録を追加
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setManual(true)} data-testid="material-manual">
              <AskIcon />
              Claude に頼む（手動）
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPaste(true)} data-testid="material-paste">
              <PasteIcon />
              結果を貼り付け
            </button>
          </div>
          {notes.length === 0 ? (
            <div className="empty mt-empty" data-testid="material-notes-empty">
              <p>まだ記録がありません。</p>
              <p className="small">
                コネクタを付けた claude.ai のプロジェクト（PDF
                を置いたもの）で「この資料を読んで、要約・創作に役立つ知識・描写に使える部分・サンプルシーンを資料に追加して」と頼むか、「Claude
                に頼む（手動）」の依頼文を使ってください。手で書くこともできます。
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.section} className="mt-group" data-testid="material-group" data-section={g.section}>
                <h3 className="mt-group-head">
                  {g.section}
                  <span className="sx-count">{g.items.length}</span>
                </h3>
                {g.items.length ? (
                  <ol className="sx-list">
                    {g.items.map((n) => (
                      <NoteCard
                        key={n.id}
                        note={n}
                        open={open.has(n.id)}
                        full={full.has(n.id)}
                        onToggle={toggle}
                        onToggleFull={toggleFull}
                        onEdit={edit}
                      />
                    ))}
                  </ol>
                ) : (
                  <p className="mt-group-empty small muted" data-testid="material-group-empty">
                    <span>まだ記録がありません。</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setEditing({ note: null, section: g.section })}
                      data-testid="material-group-add"
                    >
                      <PlusIcon />
                      この項目の記録を追加
                    </button>
                  </p>
                )}
              </section>
            ))
          )}
        </section>
      </main>
      {editMaterial ? <MaterialDialog material={material} onClose={() => setEditMaterial(false)} /> : null}
      {editTags ? <MaterialTagsEditDialog material={material} onClose={() => setEditTags(false)} /> : null}
      {editing ? (
        <MaterialNoteDialog
          materialId={material.id}
          note={editing.note}
          section={editing.section}
          onClose={() => setEditing(null)}
          onAdded={(id) => setOpen((prev) => new Set(prev).add(id))}
        />
      ) : null}
      {manual ? (
        <MaterialManualDialog material={material} onClose={() => setManual(false)} onPaste={() => setPaste(true)} />
      ) : null}
      {paste ? <PasteResultDialog materialId={material.id} onClose={() => setPaste(false)} /> : null}
    </>
  )
}

const NoteCard = memo(function NoteCard({
  note: n,
  open,
  full,
  onToggle,
  onToggleFull,
  onEdit,
}: {
  note: MaterialNote
  open: boolean
  full: boolean
  onToggle: (id: ID) => void
  onToggleFull: (id: ID) => void
  onEdit: (n: MaterialNote) => void
}) {
  const badge = sourceLabel(n.source)
  const long = n.body.length > LONG_NOTE
  const bodyId = `mt-note-${n.id}`
  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${n.section.trim() || '項目なし'}」の記録を削除しますか？`,
      message: trashNotice('この記録を'),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteMaterialNote(n.id), true))) notify('記録をゴミ箱に移しました')
  }
  return (
    <li className={`sx-card mt-note-card${open ? ' is-open' : ''}`} data-testid="material-note" data-note-id={n.id}>
      <div className="sx-card-head">
        <button
          type="button"
          className="sx-card-toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => onToggle(n.id)}
          data-testid="material-note-toggle"
        >
          <ChevronRightIcon className="icon sx-chevron" />
          <span className="sx-card-text">
            <span className="mt-note-meta">
              <span className="mt-note-date" data-testid="material-note-date-label">
                {noteDateLabel(n.runDate)}
              </span>
              <span className="badge cl-badge">
                <SparkIcon />
                {badge ?? '手で記録'}
              </span>
              {n.model ? <span className="small muted">{n.model}</span> : null}
              {isNewerRecord(n) ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
            </span>
            {!open && n.body.trim() ? <span className="sx-card-preview">{notePreview(n.body)}</span> : null}
          </span>
        </button>
      </div>
      {open ? (
        <div className="sx-card-body" id={bodyId}>
          {n.body.trim() ? (
            <>
              <div className={`cq-result-body${long && !full ? ' is-clamped' : ''}`}>
                <Markdown text={n.body} preview={long && !full} testId="material-note-body" />
              </div>
              {long ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm sn-more"
                  aria-expanded={full}
                  onClick={() => onToggleFull(n.id)}
                  data-testid="material-note-more"
                >
                  <ChevronRightIcon className="icon sx-chevron" />
                  {full ? '折りたたむ' : '全文を表示'}
                </button>
              ) : null}
            </>
          ) : (
            <p className="small muted">（本文がありません）</p>
          )}
          <div className="sx-card-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copyText(n.body, '記録の本文をコピーしました')}
              disabled={!n.body}
              data-testid="material-note-copy"
            >
              <CopyIcon />
              コピー
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onEdit(n)} data-testid="material-note-edit">
              <EditIcon />
              直す
            </button>
            <span className="grow" />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void remove()}
              data-testid="material-note-delete"
            >
              <TrashIcon />
              削除
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
})
