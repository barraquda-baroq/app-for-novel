// ホームの棚「相対比較」（内部名は bench）: 比べるために読む既存の作品（PDF は claude.ai のプロジェクトに置いたまま、分析だけをここに残す）。
// どのタイトルにも属さず、すべてのタイトルで共有する。カードを押すと作品の画面へ。「並べ替え・編集」で並べ替え・削除ができる。
// 自分の原稿を何回も分析した作品（「【原稿】原稿名（第2稿・2回目）」）は、2回以上あれば原稿ごとに1枚にまとめ、開くと回の一覧
// （新しい回から）。「並べ替え・編集」の間は、回を1つずつ並べ替え・削除できるように、まとめずに並べる。
// カードはレコード単位の props の React.memo（作品が多くても、変わったカードだけを描き直す）。
import { memo, useId, useMemo, useRef, useState } from 'react'
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
  benchShelfEntries,
  biblioLine,
  comparingTitles,
  deleteWorkMessage,
  NO_ANALYSES,
  viewpointChips,
  workLastUpdated,
  workName,
  type ShelfEntry,
  type ShelfRun,
} from '../bench/benchLogic'
import { BenchMoveDialog } from './BenchMoveDialog'

/** カードに出す観点のチップの数（それより多ければ「ほか n」） */
const CHIPS_SHOWN = 6
/** 開いている原稿のカード（作品の画面から戻ってきても開いたままにする。この端末のこの起動の間だけ） */
const openManuscripts = new Set<string>()

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
  // 棚の並び（2回以上分析した原稿は1枚に。中身が変わらない原稿は前の配列のまま）
  const prevEntries = useRef<readonly ShelfEntry[]>([])
  const entries = useMemo(() => {
    const next = benchShelfEntries(works, groups, prevEntries.current)
    prevEntries.current = next
    return next
  }, [works, groups])
  const editing = edit && works.length > 0

  return (
    <>
      <div className="home-pane-head">
        <ShelfIcon className="icon home-pane-icon" />
        <h2 id={headingId} tabIndex={-1}>
          相対比較
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
          作品を追加
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
            作品を追加
          </button>
        </div>
      ) : (
        <ul className="home-bench-list" aria-labelledby={headingId} data-testid="bench-list">
          {editing
            ? works.map((w, i) => (
                <BenchCard
                  key={w.id}
                  work={w}
                  analyses={groups.get(w.id) ?? NO_ANALYSES}
                  comparing={comparing.get(w.id)?.label ?? ''}
                  comparingCount={comparing.get(w.id)?.count ?? 0}
                  edit
                  first={i === 0}
                  last={i === works.length - 1}
                />
              ))
            : entries.map((e) =>
                e.kind === 'manuscript' ? (
                  <ManuscriptCard key={`m:${e.key}`} manuscriptKey={e.key} base={e.base} runs={e.runs} />
                ) : (
                  <BenchCard
                    key={e.work.id}
                    work={e.work}
                    analyses={groups.get(e.work.id) ?? NO_ANALYSES}
                    comparing={comparing.get(e.work.id)?.label ?? ''}
                    comparingCount={comparing.get(e.work.id)?.count ?? 0}
                    edit={false}
                    first={false}
                    last={false}
                  />
                ),
              )}
        </ul>
      )}
      {adding ? (
        <BenchWorkDialog work={null} onClose={() => setAdding(false)} onAdded={(id) => navigate(paths.bench(id))} />
      ) : null}
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

/** 2回以上分析した自分の原稿をまとめたカード。開くと回の一覧（新しい回から。押すとその回の作品の画面へ） */
const ManuscriptCard = memo(function ManuscriptCard({
  manuscriptKey,
  base,
  runs,
}: {
  manuscriptKey: string
  /** 原稿名（いちばん新しい回の書き方） */
  base: string
  /** 新しい回から */
  runs: readonly ShelfRun[]
}) {
  const [open, setOpen] = useState(() => openManuscripts.has(manuscriptKey))
  const listId = useId()
  const name = `【原稿】${base}`
  const latest = runs[0].work.createdAt
  const toggle = () => {
    setOpen(!open)
    if (open) openManuscripts.delete(manuscriptKey)
    else openManuscripts.add(manuscriptKey)
  }
  return (
    <li
      className={`home-bench-card home-bench-manuscript${open ? ' is-open' : ''}`}
      data-testid="bench-manuscript"
      data-manuscript={base}
    >
      <button
        type="button"
        className="home-bench-link home-bench-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={toggle}
        data-testid="bench-manuscript-toggle"
      >
        <span className="home-bench-top">
          <span className="home-bench-name" data-testid="bench-manuscript-name">
            {name}
          </span>
          <ChevronRightIcon className="icon home-title-chevron home-bench-chevron" />
        </span>
        <span className="home-bench-stats">
          <span className="badge" data-testid="bench-manuscript-runs">
            {runs.length}回の分析
          </span>
        </span>
        <span className="home-title-foot">
          <span data-testid="bench-manuscript-latest">最新 {formatDateTime(latest)}</span>
        </span>
      </button>
      {open ? (
        <ol id={listId} className="home-bench-runs" aria-label={`「${name}」の分析`} data-testid="bench-runs">
          {runs.map((r) => (
            <li key={r.work.id} data-testid="bench-run" data-work-id={r.work.id}>
              <Link to={paths.bench(r.work.id)} className="home-bench-run" data-testid="bench-run-link">
                <span className="home-bench-run-main">
                  <span className="home-bench-run-label" data-testid="bench-run-label">
                    {r.run}
                  </span>
                  <span className="home-bench-run-meta">
                    <span data-testid="bench-run-date">{formatDateTime(r.work.createdAt)}</span>
                    <span className="badge" data-testid="bench-run-count">
                      分析 {r.analyses.length}件
                    </span>
                  </span>
                </span>
                <ChevronRightIcon className="icon home-title-chevron" />
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  )
})
