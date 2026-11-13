// ホームの棚「相対比較」（内部名は bench）: 比べるために読む既存の作品（PDF は claude.ai のプロジェクトに置いたまま、分析だけをここに残す）。
// どのタイトルにも属さず、すべてのタイトルで共有する。カードを押すと作品の画面へ。「並べ替え・編集」で並べ替え・削除ができる。
// 自分の原稿を何回も分析した作品（「【原稿】原稿名（第2稿・2回目）」）は、2回以上あれば原稿ごとに1枚にまとめ、開くと回の一覧
// （新しい回から）。「並べ替え・編集」の間は、回を1つずつ並べ替え・削除できるように、まとめずに並べる。
// カードはレコード単位の props の React.memo（作品が多くても、変わったカードだけを描き直す）。
// 作品のタグ（ジャンル。2.7）のチップで絞れる（資料の棚と同じ。いくつか選ぶと、選んだタグをすべて持つ作品だけ。絞った時は
// 「n作品／全N作品」）。原稿のまとめは絞った後の回で作る（1回しか残らなければ作品のカード）。「タグを管理」でタグの名前を変える・
// 削除する（すべての作品で）。絞り込みはこの端末のこの起動の間だけ覚えておく（作品の画面から戻ってきても同じ）。
// 「並べ替え・編集」の間も絞り込みは効き、見えている作品の間で動かす。
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { sortedBenchWorks } from '../../domain/benchOps'
import type { BenchAnalysis, BenchWork, ID } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { ChevronRightIcon, DownIcon, EditIcon, MoveIcon, PlusIcon, ShelfIcon, TrashIcon, UpIcon, XIcon } from '../../ui/icons'
import { useKeepInPlace } from '../../ui/keepInPlace'
import { BenchManageTagsDialog } from '../bench/BenchTagDialogs'
import { BenchWorkDialog } from '../bench/BenchWorkDialog'
import {
  analysesByWork,
  benchShelfEntries,
  benchTagChips,
  benchTags,
  biblioLine,
  comparingTitles,
  deleteWorkMessage,
  filterBenchWorksByTags,
  NO_ANALYSES,
  viewpointChips,
  workLastUpdated,
  workName,
  type ShelfEntry,
  type ShelfRun,
} from '../bench/benchLogic'
import { filterCountLabel, toggleTag, visibleStepTarget } from '../materials/materialLogic'
import { TagFilterBar } from '../materials/TagFilterBar'
import { BenchMoveDialog } from './BenchMoveDialog'
import { bandBodyId, HomeBandHead } from './HomeBandHead'
import { openBand, toggleBand } from './homeBands'

/** カードに出す観点のチップの数（それより多ければ「ほか n」） */
const CHIPS_SHOWN = 6
/** カードに出すタグの数（それより多ければ「ほか n」） */
const CARD_TAGS_SHOWN = 8
/** 開いている原稿のカード（作品の画面から戻ってきても開いたままにする。この端末のこの起動の間だけ） */
const openManuscripts = new Set<string>()
/** 棚のタグの絞り込み（tagKey の形。作品の画面から戻ってきても同じにする。この端末のこの起動の間だけ） */
let rememberedTags: readonly string[] = []

/** 覚えておいた絞り込みを消す（テスト用） */
export function resetBenchShelfForTests(): void {
  rememberedTags = []
  openManuscripts.clear()
}

export function BenchShelf({
  headingId,
  open = true,
  onToggle = () => toggleBand('bench'),
}: {
  headingId: string
  /** 帯が開いているか（ホームが渡す。単独で描く時は開いている） */
  open?: boolean
  onToggle?: () => void
}) {
  const data = useData()
  const navigate = useNavigate()
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState(false)
  const [tagFilter, setTagFilter] = useState<readonly string[]>(() => rememberedTags)
  useEffect(() => {
    rememberedTags = tagFilter
  }, [tagFilter])
  const works = useMemo(() => sortedBenchWorks(data), [data.benchWorks]) // eslint-disable-line react-hooks/exhaustive-deps
  const chips = useMemo(() => benchTagChips({ benchWorks: data.benchWorks }), [data.benchWorks])
  // 選んだタグが無くなった（そのタグの作品が削除された・タグを外した）時は、絞り込みから外す
  const selected = useMemo(
    () => (tagFilter.length ? tagFilter.filter((k) => chips.some((c) => c.key === k)) : tagFilter),
    [tagFilter, chips],
  )
  // 外したタグは覚えておく絞り込みからも消す（後で同じタグがまた付いても、勝手に絞り込まないように）
  useEffect(() => {
    if (selected.length !== tagFilter.length) setTagFilter((f) => f.filter((k) => chips.some((c) => c.key === k)))
  }, [selected, tagFilter, chips])
  const filtering = selected.length > 0
  const shown = useMemo(() => filterBenchWorksByTags(works, selected), [works, selected])
  const toggle = (key: string) =>
    setTagFilter((f) =>
      toggleTag(
        f.filter((k) => chips.some((c) => c.key === k)),
        key,
      ),
    )
  const clear = () => setTagFilter([])
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
    const next = benchShelfEntries(shown, groups, prevEntries.current)
    prevEntries.current = next
    return next
  }, [shown, groups])
  // 帯を閉じたら「並べ替え・編集」も終える（次に開いた時は見るだけの棚）
  if (!open && edit) setEdit(false)
  const editing = open && edit && works.length > 0
  const bodyId = bandBodyId(headingId)

  return (
    <>
      <HomeBandHead
        area="bench"
        headingId={headingId}
        bodyId={bodyId}
        open={open}
        onToggle={onToggle}
        icon={ShelfIcon}
        label="相対比較"
        count={works.length}
        countTestId="bench-count"
        actions={
          <>
            {open && works.length > 0 ? (
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
              onClick={() => {
                // 閉じた帯からでも追加できる（追加した後に戻ってきた時は、帯が開いている）
                openBand('bench')
                setAdding(true)
              }}
              data-testid="new-bench-work"
            >
              <PlusIcon />
              作品を追加
            </button>
          </>
        }
      />

      {open ? (
        <div id={bodyId} className="home-band-body">
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
            <>
              <div className="home-mat-filter" data-testid="bench-filter">
                <TagFilterBar
                  chips={chips}
                  selected={selected}
                  onToggle={toggle}
                  onClear={clear}
                  onManage={() => setManaging(true)}
                  testIdPrefix="bench"
                  groupLabel="タグで絞る（選んだタグをすべて持つ作品だけ）"
                  hint="作品の画面の「ジャンル」でタグを付けると、ここでタグで絞れます（「14 検索用タグ」のジャンルは自動で付きます）。"
                  countUnit="作品"
                />
                {/* 件数は読み上げにも伝える（読み上げの領域は、絞り込む前から置いておく） */}
                <p className={`home-mat-filter-status${filtering ? '' : ' is-idle'}`}>
                  <span role="status" data-testid="bench-filter-count">
                    {filtering ? filterCountLabel(shown.length, works.length, '作品') : ''}
                  </span>
                  {filtering ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={clear} data-testid="bench-filter-clear">
                      <XIcon />
                      絞り込みを解除
                    </button>
                  ) : null}
                </p>
              </div>
              {shown.length === 0 ? (
                <div className="empty home-mat-nomatch" data-testid="bench-no-match">
                  <p>当てはまる作品がありません。</p>
                  <button type="button" className="btn btn-sm" onClick={clear}>
                    <XIcon />
                    絞り込みを解除
                  </button>
                </div>
              ) : (
                <ul className="home-bench-list" aria-labelledby={`${headingId}-name`} data-testid="bench-list">
                  {editing
                    ? shown.map((w, i) => (
                        <BenchCard
                          key={w.id}
                          work={w}
                          analyses={groups.get(w.id) ?? NO_ANALYSES}
                          comparing={comparing.get(w.id)?.label ?? ''}
                          comparingCount={comparing.get(w.id)?.count ?? 0}
                          edit
                          first={i === 0}
                          last={i === shown.length - 1}
                          upTo={filtering ? (visibleStepTarget(works, shown, w.id, -1) ?? -1) : -1}
                          downTo={filtering ? (visibleStepTarget(works, shown, w.id, 1) ?? -1) : -1}
                          canMove={works.length > 1}
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
                            upTo={-1}
                            downTo={-1}
                            canMove={false}
                          />
                        ),
                      )}
                </ul>
              )}
            </>
          )}
        </div>
      ) : null}
      {adding ? (
        <BenchWorkDialog work={null} onClose={() => setAdding(false)} onAdded={(id) => navigate(paths.bench(id))} />
      ) : null}
      {managing ? (
        <BenchManageTagsDialog
          onClose={() => setManaging(false)}
          onRenamed={(from, to) =>
            setTagFilter((f) => f.map((k) => (k === from ? to : k)).filter((k, i, all) => all.indexOf(k) === i))
          }
          onRemoved={(key) => setTagFilter((f) => f.filter((k) => k !== key))}
        />
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
  upTo,
  downTo,
  canMove,
}: {
  work: BenchWork
  analyses: readonly BenchAnalysis[]
  /** 比べる作品にしているタイトル（「『星の庭』『風の街』」。無ければ空） */
  comparing: string
  comparingCount: number
  edit: boolean
  /** 見えている作品の中で先頭・末尾か（上へ・下へを押せない） */
  first: boolean
  last: boolean
  /**
   * タグで絞っている時の、見えている隣の作品を越える移動先（棚全体での位置。moveBenchWorkTo）。絞っていない時は -1
   * （1つずつ動かす moveBenchWorkStep）
   */
  upTo: number
  downTo: number
  /** 「移動…」を押せるか（棚に2作品以上） */
  canMove: boolean
}) {
  const name = workName(work)
  const biblio = biblioLine(work)
  const tags = benchTags(work)
  const chips = useMemo(() => viewpointChips(analyses), [analyses])
  const updated = workLastUpdated(work, analyses)
  const [moving, setMoving] = useState(false)
  const { ref, move } = useKeepInPlace<HTMLLIElement>()

  // 動かしたカードが押した指の下に残るように（続けて押すとそのまま動かし続けられる）
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? '[data-testid="bench-up"]' : '[data-testid="bench-down"]'
    const other = dir < 0 ? '[data-testid="bench-down"]' : '[data-testid="bench-up"]'
    const to = dir < 0 ? upTo : downTo
    move(
      () => attempt(() => (to >= 0 ? actions.moveBenchWorkTo(work.id, to) : actions.moveBenchWorkStep(work.id, dir), true)),
      [same, other],
    )
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
        {tags.length ? (
          <span className="home-mat-cardtags" data-testid="bench-card-tags">
            <span className="visually-hidden">タグ: </span>
            {tags.slice(0, CARD_TAGS_SHOWN).map((t, i) => (
              <span key={`${t}-${i}`} className="home-mat-cardtag" data-testid="bench-card-tag">
                {t}
              </span>
            ))}
            {tags.length > CARD_TAGS_SHOWN ? <span className="small muted">ほか {tags.length - CARD_TAGS_SHOWN}</span> : null}
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
            disabled={!canMove}
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
