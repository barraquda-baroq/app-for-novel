// アイデアのフォルダ（2.9）の表示。仕切りの中に2段まで（1段目の中に2段目）。どの段でも、フォルダを上、フォルダに入っていない
// カードをその下に並べ、カードは入れ物（仕切り＋フォルダ）ごとに「済み n件」の区切りと並べ替え（↑↓）の端を持つ。
// 見出し: 開け閉め（この端末に覚えておく。folderCollapse.ts）・名前・下のすべてのカードの数・「Claude が作成」の印・
// ［＋］（このフォルダにアイデアを追加）・［…］（操作のメニュー。見出しの長押し・右クリックでも開く）。
// 開け閉めのボタンの読み上げは、中の名前・数・印のまま（開いているかは aria-expanded で伝える）。
// メニューは仕切りごとに1つだけ置き（IdeaFolderMenuProvider）、見出しは開く対象（フォルダの id）を渡すだけにする
// （本編の一覧の RowMenu と同じ。メニューの中身は開いた時のデータから作る）。
// 「選んで移す」で選んでいる間は、見出しに中のカード（中のフォルダのものも）をまとめて選ぶ□を出し、［＋］［…］は出さない
// （閉じたままでも選べる）。
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isClaudeFolder } from '../../claude/ideaFolders'
import { folderChain, folderDepth, ideaFolderName, type IdeaFolderNode } from '../../domain/ideaFolders'
import { folderPlaceOf, siblingFolders } from '../../domain/ideaFolderOps'
import { isIdeaChecked } from '../../domain/ideaSort'
import type { AppData, ID, Idea } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { ChevronRightIcon, DownIcon, EditIcon, FolderIcon, MoreIcon, MoveIcon, PlusIcon, TrashIcon, UpIcon } from '../../ui/icons'
import { scrollByInstant } from '../../ui/keepInPlace'
import { useMenuTrigger, type MenuTriggerHandlers } from '../../ui/longPress'
import { PopupMenu, type MenuPlacement, type PopupMenuItem } from '../../ui/PopupMenu'
import { ClaudeMadeBadge } from './ClaudeMadeBadge'
import { expandFolders, toggleFolder, useFolderCollapsed } from './folderCollapse'
import { createFolderFlow, deleteFolderFlow, folderElement, renameFolderFlow } from './folderFlows'
import { IdeaCard } from './IdeaCard'
import { IdeaEditorModal } from './IdeaEditorModal'
import { IdeaFolderMoveDialog } from './IdeaFolderMoveDialog'
import { folderCountTitle, ideaModalDraftKey, ideaPlaceName, sectionKey } from './ideaLogic'
import { setSelected, useSelectedCount, useSelectMode } from './selection'

// ---------- カードの並び（入れ物ごと） ----------

export interface IdeaCardListProps {
  /** 入れ物のカード（sortIdeas: 済みでないもの → 済み） */
  ideas: Idea[]
  /** 仕切りのキー（sectionKey） */
  section: string
  /** 場所の表記（編集ダイアログの「場所」。「星の庭 › 場面の相談」） */
  place: string
  /** 「どのタイトルにも属さない」仕切りのカードか（「この案でタイトルを作る」を出す） */
  unassigned: boolean
}

/** 1つの入れ物（仕切りのフォルダの外・フォルダの中）のカード。並べ替えの端と「済み」の区切りはこの入れ物の中で決める */
export function IdeaCardList({ ideas, section, place, unassigned }: IdeaCardListProps) {
  const doneCount = ideas.reduce((n, i) => (isIdeaChecked(i) ? n + 1 : n), 0)
  const openCount = ideas.length - doneCount
  return (
    <ul className="idea-list">
      {/* 1つの平らな並びにする（済みにしたカードが動いても作り直さず、開いている編集ダイアログなどが残る） */}
      {ideas.flatMap((idea, i) => {
        const card = (
          <IdeaCard
            key={idea.id}
            idea={idea}
            section={section}
            sectionName={place}
            unassigned={unassigned}
            first={i === 0}
            last={i === openCount - 1}
          />
        )
        // 済みのアイデアの前に区切り（並びは sortIdeas: 済みでないもの → 済み）
        if (i !== openCount) return [card]
        return [
          <li key="done-divider" className="idea-list-done" aria-hidden="true" data-testid="idea-done-divider">
            済み {doneCount}件
          </li>,
          card,
        ]
      })}
    </ul>
  )
}

// ---------- フォルダの操作のメニュー ----------

interface MenuRequest {
  id: ID
  placement: MenuPlacement
  returnFocus: HTMLElement | null
}

interface FolderMenuApi {
  open: (req: MenuRequest) => void
}

const FolderMenuContext = createContext<FolderMenuApi | null>(null)

export interface FolderMenuDeps {
  createSub: (id: ID) => void
  rename: (id: ID) => void
  step: (id: ID, dir: -1 | 1) => void
  move: (id: ID) => void
  remove: (id: ID) => void
}

/** フォルダのメニューの名前と項目（開いた時のデータで作る）。2段目には「この中にフォルダを作る」が無い（3段目は作れない） */
export function folderMenuItems(data: AppData, id: ID, deps: FolderMenuDeps): { label: string; items: PopupMenuItem[] } | null {
  const f = data.ideaFolders[id]
  if (!f) return null
  const name = ideaFolderName(f)
  const siblings = siblingFolders(data, folderPlaceOf(data, f))
  const index = siblings.findIndex((s) => s.id === id)
  const items: PopupMenuItem[] = []
  if (folderDepth(data, f) === 1) {
    items.push({
      label: 'この中にフォルダを作る',
      icon: <FolderIcon />,
      onSelect: () => deps.createSub(id),
      testId: 'idea-folder-new-sub',
    })
  }
  items.push(
    { label: '名前を変える', icon: <EditIcon />, onSelect: () => deps.rename(id), testId: 'idea-folder-rename' },
    { label: '上へ', icon: <UpIcon />, disabled: index <= 0, onSelect: () => deps.step(id, -1), testId: 'idea-folder-up' },
    {
      label: '下へ',
      icon: <DownIcon />,
      disabled: index < 0 || index >= siblings.length - 1,
      onSelect: () => deps.step(id, 1),
      testId: 'idea-folder-down',
    },
    { label: '移動…', icon: <MoveIcon />, onSelect: () => deps.move(id), testId: 'idea-folder-move' },
    { label: '削除', icon: <TrashIcon />, danger: true, onSelect: () => deps.remove(id), testId: 'idea-folder-delete' },
  )
  return { label: `『${name}』の操作`, items }
}

/** 仕切り1つ分のフォルダのメニュー（右クリック・長押し・［…］で開く） */
export function IdeaFolderMenuProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<MenuRequest | null>(null)
  const [moving, setMoving] = useState<ID | null>(null)
  /** 並べ替えたフォルダを、動かす前と同じ画面の位置に残す（描き終わった直後に合わせる） */
  const keep = useRef<{ id: ID; top: number } | null>(null)
  const api = useMemo<FolderMenuApi>(
    () => ({
      // 開いている［…］をもう一度押したら閉じる
      open: (req) =>
        setRequest((prev) =>
          prev && 'anchor' in prev.placement && 'anchor' in req.placement && prev.placement.anchor === req.placement.anchor
            ? null
            : req,
        ),
    }),
    [],
  )
  const close = useCallback(() => setRequest(null), [])

  useLayoutEffect(() => {
    const k = keep.current
    if (!k) return
    keep.current = null
    const el = folderElement(k.id)
    if (!el) return
    const delta = el.getBoundingClientRect().top - k.top
    if (Math.abs(delta) >= 1) scrollByInstant(delta)
  })

  const deps: FolderMenuDeps = {
    createSub: (id) => {
      const f = getData().ideaFolders[id]
      if (f) void createFolderFlow({ titleId: folderPlaceOf(getData(), f).titleId, parentId: id })
    },
    rename: (id) => void renameFolderFlow(id),
    step: (id, dir) => {
      const top = folderElement(id)?.getBoundingClientRect().top
      keep.current = top === undefined ? null : { id, top }
      if (!attempt(() => (actions.moveIdeaFolderStep(id, dir), true))) keep.current = null
      // 動かなかった時（描き直されない時）に、後の描画まで持ち越さない
      requestAnimationFrame(() => {
        keep.current = null
      })
    },
    move: setMoving,
    remove: (id) => void deleteFolderFlow(id),
  }
  const menu = request ? folderMenuItems(getData(), request.id, deps) : null
  return (
    <FolderMenuContext.Provider value={api}>
      {children}
      {request && menu ? (
        <PopupMenu
          key={request.id}
          label={menu.label}
          items={menu.items}
          placement={request.placement}
          onClose={close}
          returnFocus={request.returnFocus}
          testId="idea-folder-menu-popup"
        />
      ) : null}
      {moving ? <IdeaFolderMoveDialog folderId={moving} onClose={() => setMoving(null)} /> : null}
    </FolderMenuContext.Provider>
  )
}

interface FolderMenuTrigger {
  /** 見出しに付ける。右クリック・長押しで開く */
  handlers: MenuTriggerHandlers
  /** ［…］から開く */
  openFrom: (button: HTMLElement) => void
}

/** フォルダのメニューを開く手段。仕切りに IdeaFolderMenuProvider がなければ null（メニューを出さない） */
function useFolderMenu(id: ID): FolderMenuTrigger | null {
  const api = useContext(FolderMenuContext)
  const handlers = useMenuTrigger((point, el) => {
    api?.open({
      id,
      placement: { point },
      // 閉じた後は見出しの開け閉めのボタンへ
      returnFocus: el.querySelector<HTMLElement>('[data-testid="idea-folder-toggle"]') ?? el,
    })
  })
  const openFrom = useCallback(
    (button: HTMLElement) => api?.open({ id, placement: { anchor: button }, returnFocus: button }),
    [api, id],
  )
  return api ? { handlers, openFrom } : null
}

// ---------- フォルダ ----------

export interface IdeaFolderViewProps {
  node: IdeaFolderNode
  /** 仕切り（null = どのタイトルにも属さない） */
  titleId: ID | null
  /** 仕切りの名前（場所の表記に使う） */
  sectionName: string
  unassigned: boolean
  /** 親のフォルダの名前（2段目の時だけ。場所の表記に使う） */
  parentNames?: readonly string[]
}

export function IdeaFolderView({ node, titleId, sectionName, unassigned, parentNames = [] }: IdeaFolderViewProps) {
  const { folder, depth } = node
  const id = folder.id
  const bodyId = useId()
  const nameId = useId()
  const collapsed = useFolderCollapsed(id)
  const [adding, setAdding] = useState(false)
  const menu = useFolderMenu(id)
  const key = sectionKey(titleId)
  const selecting = useSelectMode(key)
  // 中のすべてのカード（中のフォルダのものも）。見出しの□でまとめて選ぶ
  const inside = useMemo(() => [...node.folders.flatMap((sub) => sub.ideas), ...node.ideas].map((i) => i.id), [node])
  const selectedCount = useSelectedCount(key, inside)
  const allSelected = inside.length > 0 && selectedCount === inside.length
  const selectRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (selectRef.current) selectRef.current.indeterminate = selectedCount > 0 && !allSelected
  })
  const name = ideaFolderName(folder)
  const names = useMemo(() => [...parentNames, name], [parentNames, name])
  const place = ideaPlaceName(sectionName, names)
  const byClaude = isClaudeFolder(folder)
  const empty = node.folders.length === 0 && node.ideas.length === 0

  const add = (body: string) => {
    const ideaId = attempt(() => actions.addIdea(titleId, '', body, id))
    setAdding(false)
    if (!ideaId) return
    // 閉じていれば開いて、足したカードを見せる
    expandFolders(folderChain(getData(), id).map((f) => f.id))
    notify(`「${name}」にアイデアを追加しました`)
  }

  return (
    <section
      className={`idea-folder${collapsed ? ' is-collapsed' : ''}`}
      data-testid="idea-folder"
      data-folder-id={id}
      data-depth={depth}
      aria-labelledby={nameId}
    >
      <div className="idea-folder-head" {...(selecting ? undefined : menu?.handlers)}>
        {selecting ? (
          <label className="idea-folder-select" title="中のカードをすべて選ぶ・外す">
            <input
              ref={selectRef}
              type="checkbox"
              checked={allSelected}
              disabled={inside.length === 0}
              onChange={() => setSelected(inside, !allSelected)}
              aria-label={`『${name}』の中のカードをすべて選ぶ`}
              data-testid="idea-folder-select"
            />
          </label>
        ) : null}
        <button
          type="button"
          className="idea-folder-toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={() => toggleFolder(id)}
          data-testid="idea-folder-toggle"
        >
          <ChevronRightIcon className="icon idea-folder-chevron" />
          <FolderIcon className="icon idea-folder-icon" />
          <span id={nameId} className="idea-folder-name" data-testid="idea-folder-name">
            {name}
          </span>
          <span
            className="idea-folder-count"
            data-testid="idea-folder-count"
            data-count={node.count}
            title={folderCountTitle(node.count, node.done)}
          >
            {node.count}
            <span className="visually-hidden">件</span>
          </span>
          {byClaude ? (
            <ClaudeMadeBadge
              compact
              className="idea-folder-by"
              testId="idea-folder-by"
              title="Claude がコネクタで作ったフォルダ"
            />
          ) : null}
        </button>
        {selecting ? null : (
          <button
            type="button"
            className="icon-btn idea-folder-add"
            onClick={() => setAdding(true)}
            aria-label={`『${name}』にアイデアを追加`}
            title="このフォルダにアイデアを追加"
            data-testid="idea-folder-add"
          >
            <PlusIcon />
          </button>
        )}
        {menu && !selecting ? (
          <button
            type="button"
            className="icon-btn idea-folder-menu"
            aria-haspopup="menu"
            aria-label={`『${name}』の操作`}
            title="フォルダの操作（名前・並べ替え・削除など）"
            onClick={(e) => menu.openFrom(e.currentTarget)}
            data-testid="idea-folder-menu"
          >
            <MoreIcon />
          </button>
        ) : null}
      </div>

      <div id={bodyId} className="idea-folder-body" hidden={collapsed}>
        {node.folders.length ? (
          <div className="idea-folders">
            {node.folders.map((sub) => (
              <IdeaFolderView
                key={sub.folder.id}
                node={sub}
                titleId={titleId}
                sectionName={sectionName}
                unassigned={unassigned}
                parentNames={names}
              />
            ))}
          </div>
        ) : null}
        {node.ideas.length ? <IdeaCardList ideas={node.ideas} section={key} place={place} unassigned={unassigned} /> : null}
        {empty && !selecting ? (
          <button type="button" className="idea-folder-empty" onClick={() => setAdding(true)} data-testid="idea-folder-empty">
            <span>まだカードはありません。</span>
            <span className="idea-folder-empty-add">
              <PlusIcon />
              ここに追加
            </span>
          </button>
        ) : null}
      </div>

      {adding ? (
        <IdeaEditorModal
          mode="add"
          sectionName={place}
          draftKey={ideaModalDraftKey({ mode: 'add', folderId: id })}
          onSave={add}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </section>
  )
}

/** 1つの入れ物（仕切り・1段目のフォルダ）の中のフォルダの並び */
export function IdeaFolderList({
  nodes,
  titleId,
  sectionName,
  unassigned,
}: {
  nodes: IdeaFolderNode[]
  titleId: ID | null
  sectionName: string
  unassigned: boolean
}) {
  return (
    <div className="idea-folders" data-testid="idea-folders">
      {nodes.map((n) => (
        <IdeaFolderView key={n.folder.id} node={n} titleId={titleId} sectionName={sectionName} unassigned={unassigned} />
      ))}
    </div>
  )
}
