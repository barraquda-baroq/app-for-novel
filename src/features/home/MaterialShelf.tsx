// ホームの棚「資料」（2.6。内部名は materials）: 創作のために読む資料（主に買った書籍。PDF は claude.ai のプロジェクトに置いたまま、
// Claude が読んでまとめた記録だけをここに残す）。どのタイトルにも属さず、すべてのタイトルで共有する。相対比較の棚と同じ見た目・操作。
// 資料は数百冊になるので、検索の欄（資料名・著者・タグ・メモの部分一致）と、作者が付けたタグのチップ（使っているタグを資料の数つきで。
// 押すと絞り、いくつか選ぶと選んだタグをすべて持つ資料だけ。もう一度押すと外す）で絞れる（絞った時は「n件／全N件」）。
// 「タグを管理」でタグの名前を変える・削除する（すべての資料で）。タグは作者が付けて管理する（Claude は付けない）。
// 絞り込みはこの端末のこの起動の間だけ覚えておく（資料の画面から戻ってきても同じ絞り込みのまま）。
// カードを押すと資料の画面へ。「並べ替え・編集」で並べ替え・削除ができる（絞り込んでいる時は、見えている資料の間で動かす）。
// カードはレコード単位の props の React.memo（資料が多くても、変わったカードだけを描き直す）。
import { memo, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { sortedMaterials } from '../../domain/materialOps'
import type { ID, Material, MaterialNote } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { useData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { formatDateTime, formatUpdated } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import {
  ChevronRightIcon,
  DownIcon,
  EditIcon,
  MoveIcon,
  OpenBookIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  TrashIcon,
  UpIcon,
  XIcon,
} from '../../ui/icons'
import { useKeepInPlace } from '../../ui/keepInPlace'
import { MaterialDialog } from '../materials/MaterialDialog'
import {
  biblioLine,
  deleteMaterialMessage,
  filterCountLabel,
  filterMaterials,
  isFiltering,
  materialLastUpdated,
  materialName,
  materialTags,
  NO_NOTES,
  notesByMaterial,
  sectionChips,
  tagChips,
  toggleTag,
  visibleStepTarget,
  type ShelfFilter,
} from '../materials/materialLogic'
import { ManageTagsDialog } from '../materials/MaterialTagDialogs'
import { MaterialMoveDialog } from './MaterialMoveDialog'

/** カードに出す項目のチップの数（それより多ければ「ほか n」） */
const CHIPS_SHOWN = 6
/** カードに出すタグの数（それより多ければ「ほか n」） */
const CARD_TAGS_SHOWN = 8
/** 棚のタグのチップを初めから出す数（それより多ければ「すべてのタグ（n）」で開く。選んでいるタグはいつも出す） */
const TAG_CHIPS_SHOWN = 12

const NO_FILTER: ShelfFilter = { query: '', tags: [] }
/** 棚の絞り込み（資料の画面から戻ってきても同じにする。この端末のこの起動の間だけ） */
let rememberedFilter: ShelfFilter = NO_FILTER

/** 覚えておいた絞り込みを消す（テスト用） */
export function resetMaterialShelfForTests(): void {
  rememberedFilter = NO_FILTER
}

export function MaterialShelf({ headingId }: { headingId: string }) {
  const data = useData()
  const navigate = useNavigate()
  const searchId = useId()
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState(false)
  const [allTags, setAllTags] = useState(false)
  const [filter, setFilter] = useState<ShelfFilter>(() => rememberedFilter)
  useEffect(() => {
    rememberedFilter = filter
  }, [filter])
  const materials = useMemo(() => sortedMaterials(data), [data.materials]) // eslint-disable-line react-hooks/exhaustive-deps
  // 資料ごとの記録（中身が変わらない資料は前の配列のまま。カードの React.memo が効くように）
  const prevGroups = useRef<ReadonlyMap<ID, readonly MaterialNote[]>>(new Map())
  const groups = useMemo(() => {
    const next = notesByMaterial(data, prevGroups.current)
    prevGroups.current = next
    return next
  }, [data.materialNotes]) // eslint-disable-line react-hooks/exhaustive-deps
  const chips = useMemo(() => tagChips({ materials: data.materials }), [data.materials])
  // 選んだタグが無くなった（そのタグの資料が削除された・タグを外した）時は、絞り込みから外す
  const selected = useMemo(
    () => (filter.tags.length ? filter.tags.filter((k) => chips.some((c) => c.key === k)) : filter.tags),
    [filter.tags, chips],
  )
  // 外したタグは覚えておく絞り込みからも消す（後で同じタグがまた付いても、勝手に絞り込まないように）
  useEffect(() => {
    if (selected.length !== filter.tags.length)
      setFilter((f) => ({ ...f, tags: f.tags.filter((k) => chips.some((c) => c.key === k)) }))
  }, [selected, filter.tags, chips])
  const query = useDeferredValue(filter.query)
  const effective = useMemo(() => ({ query, tags: selected }), [query, selected])
  const filtering = isFiltering(effective)
  const shown = useMemo(() => filterMaterials(materials, effective), [materials, effective])
  const editing = edit && materials.length > 0
  const clear = () => setFilter(NO_FILTER)
  const visibleChips = allTags ? chips : chips.filter((c, i) => i < TAG_CHIPS_SHOWN || selected.includes(c.key))
  const toggle = (key: string) =>
    setFilter((f) => ({
      ...f,
      tags: toggleTag(
        f.tags.filter((k) => chips.some((c) => c.key === k)),
        key,
      ),
    }))

  return (
    <>
      <div className="home-pane-head">
        <OpenBookIcon className="icon home-pane-icon" />
        <h2 id={headingId} tabIndex={-1}>
          資料
        </h2>
        <span className="home-pane-count" data-testid="material-count">
          {materials.length}
        </span>
        <span className="grow" />
        {materials.length > 0 ? (
          <button
            type="button"
            className={`btn btn-sm${editing ? ' home-toggle-on' : ' btn-ghost'}`}
            aria-pressed={editing}
            onClick={() => setEdit((v) => !v)}
            data-testid="material-edit-toggle"
          >
            <EditIcon />
            {editing ? '編集を終える' : '並べ替え・編集'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm home-new-title"
          onClick={() => setAdding(true)}
          data-testid="new-material"
        >
          <PlusIcon />
          資料を追加
        </button>
      </div>

      {materials.length === 0 ? (
        <div className="empty home-empty home-mat-empty" data-testid="material-empty">
          <p>
            創作のために読む資料（主に書籍）を置く棚です。PDF は claude.ai のプロジェクトに置いたまま、Claude
            に読んでもらった要約・創作に役立つ知識・描写に使える部分・サンプルシーンだけをここに残し、どのタイトルでも使えます。
          </p>
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <PlusIcon />
            資料を追加
          </button>
        </div>
      ) : (
        <>
          <div className="home-mat-filter" role="search" data-testid="material-filter">
            <label className="home-mat-search" htmlFor={searchId}>
              <SearchIcon className="icon home-mat-search-icon" />
              <span className="visually-hidden">資料を探す</span>
              <input
                id={searchId}
                className="input"
                type="search"
                enterKeyHint="search"
                value={filter.query}
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                placeholder="資料名・著者・タグ・メモで探す"
                autoComplete="off"
                data-testid="material-search"
              />
            </label>
            {chips.length ? (
              <div className="home-mat-tagbar">
                <div
                  className="home-mat-tags"
                  role="group"
                  aria-label="タグで絞る（選んだタグをすべて持つ資料だけ）"
                  data-testid="material-tags"
                >
                  {visibleChips.map((c) => {
                    const on = selected.includes(c.key)
                    return (
                      <button
                        key={c.key}
                        type="button"
                        className={`home-mat-tag${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        onClick={() => toggle(c.key)}
                        data-testid="material-tag-chip"
                        data-tag={c.tag}
                      >
                        <span className="home-mat-tag-name">{c.tag}</span>
                        <span className="home-mat-tag-count">
                          {c.count}
                          <span className="visually-hidden">件</span>
                        </span>
                      </button>
                    )
                  })}
                  {chips.length > TAG_CHIPS_SHOWN ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm home-mat-tags-more"
                      aria-expanded={allTags}
                      onClick={() => setAllTags((v) => !v)}
                      data-testid="material-tags-more"
                    >
                      {allTags ? 'タグを閉じる' : `すべてのタグ（${chips.length}）`}
                    </button>
                  ) : null}
                </div>
                <div className="home-mat-tag-actions">
                  {selected.length ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setFilter((f) => ({ ...f, tags: [] }))}
                      data-testid="material-tags-clear"
                    >
                      <XIcon />
                      タグの選択を解除
                    </button>
                  ) : null}
                  <span className="grow" />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setManaging(true)}
                    data-testid="material-manage-tags-open"
                  >
                    <TagIcon />
                    タグを管理
                  </button>
                </div>
              </div>
            ) : (
              <p className="small muted home-mat-tags-hint" data-testid="material-tags-hint">
                資料の画面の「タグを付ける」でタグ（ミリタリ・現代など）を付けると、ここでタグで絞れます。
              </p>
            )}
            {/* 件数は読み上げにも伝える（読み上げの領域は、絞り込む前から置いておく） */}
            <p className={`home-mat-filter-status${filtering ? '' : ' is-idle'}`}>
              <span role="status" data-testid="material-filter-count">
                {filtering ? filterCountLabel(shown.length, materials.length) : ''}
              </span>
              {filtering ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clear} data-testid="material-filter-clear">
                  <XIcon />
                  絞り込みを解除
                </button>
              ) : null}
            </p>
          </div>
          {shown.length === 0 ? (
            <div className="empty home-mat-nomatch" data-testid="material-no-match">
              <p>当てはまる資料がありません。</p>
              <button type="button" className="btn btn-sm" onClick={clear}>
                <XIcon />
                絞り込みを解除
              </button>
            </div>
          ) : (
            <ul className="home-mat-list" aria-labelledby={headingId} data-testid="material-list">
              {shown.map((m, i) =>
                editing ? (
                  <MaterialCard
                    key={m.id}
                    material={m}
                    notes={groups.get(m.id) ?? NO_NOTES}
                    edit
                    first={i === 0}
                    last={i === shown.length - 1}
                    upTo={filtering ? (visibleStepTarget(materials, shown, m.id, -1) ?? -1) : -1}
                    downTo={filtering ? (visibleStepTarget(materials, shown, m.id, 1) ?? -1) : -1}
                    canMove={materials.length > 1}
                  />
                ) : (
                  <MaterialCard
                    key={m.id}
                    material={m}
                    notes={groups.get(m.id) ?? NO_NOTES}
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
      {adding ? (
        <MaterialDialog material={null} onClose={() => setAdding(false)} onAdded={(id) => navigate(paths.material(id))} />
      ) : null}
      {managing ? (
        <ManageTagsDialog
          onClose={() => setManaging(false)}
          onRenamed={(from, to) =>
            setFilter((f) => ({
              ...f,
              tags: f.tags.map((k) => (k === from ? to : k)).filter((k, i, all) => all.indexOf(k) === i),
            }))
          }
          onRemoved={(key) => setFilter((f) => ({ ...f, tags: f.tags.filter((k) => k !== key) }))}
        />
      ) : null}
    </>
  )
}

const MaterialCard = memo(function MaterialCard({
  material,
  notes,
  edit,
  first,
  last,
  upTo,
  downTo,
  canMove,
}: {
  material: Material
  notes: readonly MaterialNote[]
  edit: boolean
  /** 見えている資料の中で先頭・末尾か（上へ・下へを押せない） */
  first: boolean
  last: boolean
  /**
   * 絞り込んでいる時の、見えている隣の資料を越える移動先（棚全体での位置。moveMaterialTo）。絞り込んでいない時は -1
   * （1つずつ動かす moveMaterialStep）
   */
  upTo: number
  downTo: number
  /** 「移動…」を押せるか（棚に2冊以上） */
  canMove: boolean
}) {
  const name = materialName(material)
  const biblio = biblioLine(material)
  const tags = materialTags(material)
  const chips = useMemo(() => sectionChips(notes), [notes])
  const updated = materialLastUpdated(material, notes)
  const [moving, setMoving] = useState(false)
  const { ref, move } = useKeepInPlace<HTMLLIElement>()

  // 動かしたカードが押した指の下に残るように（続けて押すとそのまま動かし続けられる）
  const step = (dir: -1 | 1) => {
    const same = dir < 0 ? '[data-testid="material-up"]' : '[data-testid="material-down"]'
    const other = dir < 0 ? '[data-testid="material-down"]' : '[data-testid="material-up"]'
    const to = dir < 0 ? upTo : downTo
    move(
      () => attempt(() => (to >= 0 ? actions.moveMaterialTo(material.id, to) : actions.moveMaterialStep(material.id, dir), true)),
      [same, other],
    )
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `「${name}」を削除しますか？`,
      message: deleteMaterialMessage(notes.length),
      danger: true,
      confirmLabel: '削除',
    })
    if (!ok) return
    if (attempt(() => (actions.deleteMaterial(material.id), true))) notify(`「${name}」をゴミ箱に移しました`)
  }

  return (
    <li
      ref={ref}
      className={`home-mat-card${edit ? ' is-editing' : ''}`}
      data-testid="material-card"
      data-material-id={material.id}
    >
      <Link to={paths.material(material.id)} className="home-mat-link" data-testid="material-card-link">
        <span className="home-mat-top">
          <span className="home-mat-name" data-testid="material-card-name">
            {name}
          </span>
          <ChevronRightIcon className="icon home-title-chevron" />
        </span>
        {biblio ? (
          <span className="home-mat-biblio" data-testid="material-card-biblio">
            {biblio}
          </span>
        ) : null}
        {tags.length ? (
          <span className="home-mat-cardtags" data-testid="material-card-tags">
            <span className="visually-hidden">タグ: </span>
            {tags.slice(0, CARD_TAGS_SHOWN).map((t, i) => (
              <span key={`${t}-${i}`} className="home-mat-cardtag" data-testid="material-card-tag">
                {t}
              </span>
            ))}
            {tags.length > CARD_TAGS_SHOWN ? <span className="small muted">ほか {tags.length - CARD_TAGS_SHOWN}</span> : null}
          </span>
        ) : null}
        <span className="home-mat-stats">
          <span className="badge" data-testid="material-card-count">
            記録 {notes.length}件
          </span>
          {chips.slice(0, CHIPS_SHOWN).map((c) => (
            <span key={c.section} className="home-mat-chip" data-testid="material-card-section">
              {c.section}
              {c.count > 1 ? <span className="home-mat-chip-count">{c.count}</span> : null}
            </span>
          ))}
          {chips.length > CHIPS_SHOWN ? <span className="small muted">ほか {chips.length - CHIPS_SHOWN}</span> : null}
        </span>
        <span className="home-title-foot">
          <span title={formatDateTime(updated)} data-testid="material-card-updated">
            {formatUpdated(updated)}
          </span>
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
            data-testid="material-up"
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
            data-testid="material-down"
          >
            <DownIcon />
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMoving(true)}
            disabled={!canMove}
            title="位置を選んで移動"
            data-testid="material-move"
          >
            <MoveIcon />
            移動…
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} data-testid="material-delete">
            <TrashIcon />
            削除
          </button>
        </div>
      ) : null}
      {moving ? <MaterialMoveDialog materialId={material.id} onClose={() => setMoving(false)} /> : null}
    </li>
  )
})
