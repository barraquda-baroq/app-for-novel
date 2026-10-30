// ホームの棚「ベンチ作品」: 比べるために読む既存の作品（PDF は claude.ai のプロジェクトに置いたまま、分析だけをここに残す）。
// どのタイトルにも属さず、すべてのタイトルで共有する。カードを押すと作品の画面へ。「並べ替え・編集」で並べ替え・削除ができる。
// カードはレコード単位の props の React.memo（作品が多くても、変わったカードだけを描き直す）。
import { memo, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { sortedBenchWorks } from '../../domain/benchOps'
import type { BenchAnalysis, BenchWork, ID } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { ChevronRightIcon, DownIcon, EditIcon, MoveIcon, PlusIcon, ShelfIcon, TrashIcon, UpIcon } from '../../ui/icons'
import { useKeepInPlace } from '../../ui/keepInPlace'
import { BenchWorkDialog } from '../bench/BenchWorkDialog'
import {
  analysesByWork,
  biblioLine,
  comparingTitles,
  deleteWorkMessage,
  viewpointChips,
  workLastUpdated,
  workName,
} from '../bench/benchLogic'
import { BenchMoveDialog } from './BenchMoveDialog'

/** カードに出す観点のチップの数（それより多ければ「ほか n」） */
const CHIPS_SHOWN = 6
const NO_ANALYSES: readonly BenchAnalysis[] = []

export function BenchShelf({ headingId }: { headingId: string }) {
  const data = useData()
  const navigate = useNavigate()
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState(false)
  const works = useMemo(() => sortedBenchWorks(data), [data.benchWorks]) // eslint-disable-line react-hooks/exhaustive-deps
  // 作品ごとの分析（中身が変わらない作品は前の配列のまま。カードの React.memo が効くように）
  const prevGroups = useRef<ReadonlyMap<ID, readonly BenchAnalysis[]>>(new Map())
  const groups = useMemo(() => {
    const next = analysesByWork(data, prevGroups.current)
    prevGroups.current = next
    return next
  }, [data.benchAnalyses]) // eslint-disable-line react-hooks/exhaustive-deps
  const comparing = useMemo(() => comparingTitles(data), [data.titles]) // eslint-disable-line react-hooks/exhaustive-deps
  const editing = edit && works.length > 0

  return (
    <>
      <div className="home-pane-head">
        <ShelfIcon className="icon home-pane-icon" />
        <h2 id={headingId} tabIndex={-1}>
          ベンチ作品
        </h2>
        <span className="home-pane-count" data-testid="bench-count">
          {works.length}
        </span>
        <span className="grow" />
        {works.length > 0 ? (
          <button
            type="button"
            className={`btn btn-sm${editing ? ' home-toggle-on' : ' btn-ghost'}`}
            aria-pressed={editing}
            onClick={() => setEdit((v) => !v)}
            data-testid="bench-edit-toggle"
          >
            <EditIcon />
            {editing ? '編集を終える' : '並べ替え・編集'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm home-new-title"
          onClick={() => setAdding(true)}
          data-testid="new-bench-work"
        >
          <PlusIcon />
          ベンチ作品
        </button>
      </div>

      {works.length === 0 ? (
        <div className="empty home-empty home-bench-empty" data-testid="bench-empty">
          <p>
            比べるために読む既存の作品を置く棚です。PDF は claude.ai のプロジェクトに置いたまま、Claude
            に多角的に分析してもらった内容だけをここに残し、各タイトルの作品批評で比べられます。
          </p>
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <PlusIcon />
            ベンチ作品を足す
          </button>
        </div>
      ) : (
        <ul className="home-bench-list" aria-labelledby={headingId} data-testid="bench-list">
          {works.map((w, i) => (
            <BenchCard
              key={w.id}
              work={w}
              analyses={groups.get(w.id) ?? NO_ANALYSES}
              comparing={comparing.get(w.id)?.label ?? ''}
              comparingCount={comparing.get(w.id)?.count ?? 0}
              edit={editing}
              first={i === 0}
              last={i === works.length - 1}
            />
          ))}
        </ul>
      )}
      {adding ? <BenchWorkDialog work={null} onClose={() => setAdding(false)} onAdded={(id) => navigate(paths.bench(id))} /> : null}
    </>
  )
}

const BenchCard = memo(function BenchCard({
  work,
  analyses,
  comparing,
  comparingCount,
  edit,
  first,
  last,
}: {
  work: BenchWork
  analyses: readonly BenchAnalysis[]
  /** 比べる作品にしているタイトル（「『星の庭』『風の街』」。無ければ空） */
  comparing: string
  comparingCount: number
  edit: boolean
  first: boolean
  last: boolean
}) {
  const name = workName(work)
  const biblio = biblioLine(work)
  const chips = useMemo(() => viewpointChips(analyses), [analyses])
  const updated = workLastUpdated(work, analyses)
  const [moving, setMoving] = useState(false)
  const { ref, move } = useKeepInPlace<HTMLLIElement>()

  // 動かしたカードが押した指の下に残るように（続けて押すとそのまま動かし続けられる）
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? '[data-testid="bench-up"]' : '[data-testid="bench-down"]'
    const other = dir < 0 ? '[data-testid="bench-down"]' : '[data-testid="bench-up"]'
    move(() => attempt(() => (actions.moveBenchWorkStep(work.id, dir), true)), [same, other])
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${name}」を削除しますか？`,
      message: deleteWorkMessage(analyses.length, comparingCount),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteBenchWork(work.id), true))) notify(`「${name}」をゴミ箱に移しました`)
  }

  return (
    <li ref={ref} className={`home-bench-card${edit ? ' is-editing' : ''}`} data-testid="bench-card" data-work-id={work.id}>
      <Link to={paths.bench(work.id)} className="home-bench-link" data-testid="bench-card-link">
        <span className="home-bench-top">
          <span className="home-bench-name" data-testid="bench-card-name">
            {name}
          </span>
          <ChevronRightIcon className="icon home-title-chevron" />
        </span>
        {biblio ? (
          <span className="home-bench-biblio" data-testid="bench-card-author">
            {biblio}
          </span>
        ) : null}
        <span className="home-bench-stats">
          <span className="badge" data-testid="bench-card-count">
            分析 {analyses.length}件
          </span>
          {chips.slice(0, CHIPS_SHOWN).map((c) => (
            <span key={c.viewpoint} className="bw-chip" data-testid="bench-card-viewpoint">
              {c.viewpoint}
              {c.count > 1 ? <span className="bw-chip-count">{c.count}</span> : null}
            </span>
          ))}
          {chips.length > CHIPS_SHOWN ? <span className="small muted">ほか {chips.length - CHIPS_SHOWN}</span> : null}
        </span>
        <span className="home-title-foot">
          <span title={formatDateTime(updated)} data-testid="bench-card-updated">
            {formatUpdated(updated)}
          </span>
          {comparing ? (
            <span className="home-bench-comparing" data-testid="bench-card-comparing">
              比べるタイトル: {comparing}
            </span>
          ) : null}
        </span>
      </Link>

      {edit ? (
        <div className="home-title-edit" role="group" aria-label={`「${name}」の操作`}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => step(-1)}
            disabled={first}
            aria-label="上へ"
            title="1つ上へ"
            data-testid="bench-up"
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
            data-testid="bench-down"
          >
            <DownIcon />
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMoving(true)}
            disabled={first && last}
            title="位置を選んで移動"
            data-testid="bench-move"
          >
            <MoveIcon />
            移動…
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="bench-delete">
            <TrashIcon />
            削除
          </button>
        </div>
      ) : null}
      {moving ? <BenchMoveDialog workId={work.id} onClose={() => setMoving(false)} /> : null}
    </li>
  )
})
