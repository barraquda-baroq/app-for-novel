// ベンチ作品の画面（/bench/:workId）: 作品の情報（直せる）と、分析の一覧（観点ごと。まとまりは観点を最初に分析した順、
// 中は新しい日付から）。分析は開閉でき、長い分析は閉じている間は頭だけを変換して出す（「全文を表示」で全部）。
// 分析は手で足す・直す・削除でき、「Claude に頼む（手動）」で PDF を置いた claude.ai のプロジェクトに渡す依頼文をコピーし、
// 「結果を貼り付け」で取り込む（2回貼り付けても増えない）。
import { memo, useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { benchAnalysesOf, benchViewpointGroups } from '../../claude/benchOrder'
import { isNewerRecord, NEWER_RECORD_LABEL } from '../../claude/visibility'
import { titlesComparing } from '../../domain/benchOps'
import { formatCount } from '../../domain/text'
import { trashNotice } from '../../domain/trash'
import type { BenchAnalysis, BenchWork, ID } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData, useRecord } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { copyText, formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { useDocumentTitle } from '../../ui/hooks'
import { ChevronRightIcon, CopyIcon, EditIcon, PlusIcon, ShelfIcon, TrashIcon } from '../../ui/icons'
import { AppHeader } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { AskIcon, PasteIcon, SparkIcon } from '../claude/claudeIcons'
import { sourceLabel } from '../claude/claudeUi'
import { Markdown } from '../claude/Markdown'
import { PasteResultDialog } from '../claude/PasteResultDialog'
import { AnalysisDialog } from './AnalysisDialog'
import { BenchManualDialog } from './BenchManualDialog'
import { BenchWorkDialog } from './BenchWorkDialog'
import {
  analysisPreview,
  biblioLine,
  createdByLabel,
  deleteWorkMessage,
  runDateLabel,
  workLastUpdated,
  workName,
} from './benchLogic'
import '../title/strategy/claudeSections.css'
import './bench.css'

/** 開いた分析で、これより長ければ頭だけを出して「全文を表示」（閉じている間は頭だけを変換する。Markdown.tsx） */
const LONG_ANALYSIS = 900

export function BenchWorkPage() {
  const { workId = '' } = useParams()
  const work = useRecord('benchWorks', workId)
  if (!work)
    return (
      <NotFound
        message="ベンチ作品が見つかりません。削除された可能性があります。"
        action={{ to: paths.homeArea('bench'), label: 'ベンチ作品の一覧へ' }}
      />
    )
  return <BenchWorkView key={work.id} work={work} />
}

function BenchWorkView({ work }: { work: BenchWork }) {
  const navigate = useNavigate()
  const data = useData()
  const name = workName(work)
  useDocumentTitle(`ベンチ作品: ${name}`)
  const analyses = useMemo(() => benchAnalysesOf(data, work.id), [data.benchAnalyses, work.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => benchViewpointGroups(analyses), [analyses])
  const comparing = useMemo(() => titlesComparing(data, work.id), [data.titles, work.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [editWork, setEditWork] = useState(false)
  const [editing, setEditing] = useState<{ analysis: BenchAnalysis | null } | null>(null)
  const [manual, setManual] = useState(false)
  const [paste, setPaste] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<ID>>(() => new Set())
  const [full, setFull] = useState<ReadonlySet<ID>>(() => new Set())
  const biblio = biblioLine(work)
  const createdBy = createdByLabel(work.source)
  const updated = workLastUpdated(work, analyses)
  const totalChars = useMemo(() => analyses.reduce((n, a) => n + a.body.length, 0), [analyses])

  const flip = (set: ReadonlySet<ID>, id: ID) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const toggle = useCallback((id: ID) => setOpen((prev) => flip(prev, id)), [])
  const toggleFull = useCallback((id: ID) => setFull((prev) => flip(prev, id)), [])
  const edit = useCallback((analysis: BenchAnalysis) => setEditing({ analysis }), [])
  const allOpen = analyses.length > 0 && analyses.every((a) => open.has(a.id))

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${name}」を削除しますか？`,
      message: deleteWorkMessage(analyses.length, comparing.length),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteBenchWork(work.id), true))) {
      notify(`「${name}」をゴミ箱に移しました`)
      navigate(paths.homeArea('bench'))
    }
  }

  return (
    <>
      <AppHeader
        crumbs={[{ label: 'ホーム', to: paths.home() }, { label: 'ベンチ作品', to: paths.homeArea('bench') }, { label: name }]}
      />
      <main className="page bw-page" data-area="bench" data-testid="bench-page">
        <section className="bw-head card" aria-labelledby="bw-name" data-testid="bench-work-head">
          <div className="bw-head-top">
            <span className="badge bw-kind">
              <ShelfIcon />
              ベンチ作品
            </span>
            {createdBy ? (
              <span className="badge cl-badge" data-testid="bench-work-source">
                <SparkIcon />
                {createdBy}
              </span>
            ) : null}
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={() => setEditWork(true)} data-testid="bench-work-edit">
              <EditIcon />
              情報を直す
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="bench-work-delete">
              <TrashIcon />
              削除
            </button>
          </div>
          <h1 id="bw-name" className="bw-name" data-testid="bench-work-title">
            {name}
          </h1>
          {biblio ? (
            <p className="bw-biblio" data-testid="bench-work-biblio">
              {biblio}
            </p>
          ) : null}
          <dl className="bw-facts">
            <div>
              <dt>PDF の置き場所</dt>
              <dd data-testid="bench-work-pdf-place">{work.pdfPlace.trim() || '（未記入）'}</dd>
            </div>
            <div>
              <dt>比べるタイトル</dt>
              <dd>
                {comparing.length ? (
                  <span className="bw-chips" data-testid="bench-work-comparing">
                    {comparing.map((t) => (
                      <Link key={t.id} to={paths.title(t.id, 'critique')} className="bw-chip is-title">
                        『{t.name.trim() || '無題のタイトル'}』
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="muted">（まだありません。タイトルの「作品批評」で選べます）</span>
                )}
              </dd>
            </div>
            <div>
              <dt>最終更新</dt>
              <dd title={formatDateTime(updated)}>{formatUpdated(updated)}</dd>
            </div>
          </dl>
          {work.note.trim() ? (
            <p className="bw-note" data-testid="bench-work-note-text">
              {work.note}
            </p>
          ) : null}
        </section>

        <section className="bw-analyses" aria-labelledby="bw-analyses-heading" data-testid="bench-analyses">
          <div className="bw-analyses-head">
            <h2 id="bw-analyses-heading">
              分析<span className="sx-count">{analyses.length}</span>
            </h2>
            {analyses.length ? <span className="small muted">合計 {formatCount(totalChars)}字</span> : null}
            <span className="grow" />
            {analyses.length ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setOpen(allOpen ? new Set() : new Set(analyses.map((a) => a.id)))}
                data-testid="bench-toggle-all"
              >
                {allOpen ? 'すべて閉じる' : 'すべて開く'}
              </button>
            ) : null}
          </div>
          <div className="bw-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setEditing({ analysis: null })}
              data-testid="bench-add-analysis"
            >
              <PlusIcon />
              分析を足す
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setManual(true)} data-testid="bench-manual">
              <AskIcon />
              Claude に頼む（手動）
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPaste(true)} data-testid="bench-paste">
              <PasteIcon />
              結果を貼り付け
            </button>
          </div>
          {analyses.length === 0 ? (
            <div className="empty bw-empty" data-testid="bench-analyses-empty">
              <p>まだ分析がありません。</p>
              <p className="small">
                コネクタを付けた claude.ai のプロジェクト（PDF
                を置いたもの）で「この作品を構成・文体の観点で分析して、ベンチ作品に追加して」と頼むか、「Claude
                に頼む（手動）」の依頼文を使ってください。手で書くこともできます。
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.viewpoint} className="bw-group" data-testid="bench-group" data-viewpoint={g.viewpoint}>
                <h3 className="bw-group-head">
                  {g.viewpoint}
                  <span className="sx-count">{g.items.length}</span>
                </h3>
                <ol className="sx-list">
                  {g.items.map((a) => (
                    <AnalysisCard
                      key={a.id}
                      analysis={a}
                      open={open.has(a.id)}
                      full={full.has(a.id)}
                      onToggle={toggle}
                      onToggleFull={toggleFull}
                      onEdit={edit}
                    />
                  ))}
                </ol>
              </section>
            ))
          )}
        </section>
      </main>
      {editWork ? <BenchWorkDialog work={work} onClose={() => setEditWork(false)} /> : null}
      {editing ? (
        <AnalysisDialog
          workId={work.id}
          analysis={editing.analysis}
          onClose={() => setEditing(null)}
          onAdded={(id) => setOpen((prev) => new Set(prev).add(id))}
        />
      ) : null}
      {manual ? <BenchManualDialog work={work} onClose={() => setManual(false)} onPaste={() => setPaste(true)} /> : null}
      {paste ? <PasteResultDialog benchWorkId={work.id} onClose={() => setPaste(false)} /> : null}
    </>
  )
}

const AnalysisCard = memo(function AnalysisCard({
  analysis: a,
  open,
  full,
  onToggle,
  onToggleFull,
  onEdit,
}: {
  analysis: BenchAnalysis
  open: boolean
  full: boolean
  onToggle: (id: ID) => void
  onToggleFull: (id: ID) => void
  onEdit: (a: BenchAnalysis) => void
}) {
  const badge = sourceLabel(a.source)
  const long = a.body.length > LONG_ANALYSIS
  const bodyId = `bw-analysis-${a.id}`
  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${a.viewpoint.trim() || '観点なし'}」の分析を削除しますか？`,
      message: trashNotice('この分析を'),
      danger: true,
      confirmLabel: '削除',
    })
    if (ok && attempt(() => (actions.deleteBenchAnalysis(a.id), true))) notify('分析をゴミ箱に移しました')
  }
  return (
    <li className={`sx-card bw-analysis${open ? ' is-open' : ''}`} data-testid="bench-analysis" data-analysis-id={a.id}>
      <div className="sx-card-head">
        <button
          type="button"
          className="sx-card-toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => onToggle(a.id)}
          data-testid="bench-analysis-toggle"
        >
          <ChevronRightIcon className="icon sx-chevron" />
          <span className="sx-card-text">
            <span className="bw-analysis-meta">
              <span className="bw-analysis-date" data-testid="bench-analysis-date-label">
                {runDateLabel(a.runDate)}
              </span>
              <span className="badge cl-badge">
                <SparkIcon />
                {badge ?? '手で記録'}
              </span>
              {a.model ? <span className="small muted">{a.model}</span> : null}
              {isNewerRecord(a) ? <span className="badge badge-missing">{NEWER_RECORD_LABEL}</span> : null}
            </span>
            {!open && a.body.trim() ? <span className="sx-card-preview">{analysisPreview(a.body)}</span> : null}
          </span>
        </button>
      </div>
      {open ? (
        <div className="sx-card-body" id={bodyId}>
          {a.body.trim() ? (
            <>
              <div className={`cq-result-body${long && !full ? ' is-clamped' : ''}`}>
                <Markdown text={a.body} preview={long && !full} testId="bench-analysis-body" />
              </div>
              {long ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm sn-more"
                  aria-expanded={full}
                  onClick={() => onToggleFull(a.id)}
                  data-testid="bench-analysis-more"
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
              onClick={() => void copyText(a.body, '分析の本文をコピーしました')}
              disabled={!a.body}
              data-testid="bench-analysis-copy"
            >
              <CopyIcon />
              コピー
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onEdit(a)} data-testid="bench-analysis-edit">
              <EditIcon />
              直す
            </button>
            <span className="grow" />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void remove()}
              data-testid="bench-analysis-delete"
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
