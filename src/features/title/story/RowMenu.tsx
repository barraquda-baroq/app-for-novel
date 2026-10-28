// 本編の一覧の行の操作メニュー（右クリック・長押し・行の「…」ボタン）。
// 一覧ごとに1つだけ置き（RowMenuProvider）、行は開く対象（話・幕の id）を渡すだけにする
// （行を React.memo のまま軽く保つため。メニューの中身は開いた時のデータから作る）。
// 話: 開く・セパレート（採用原稿のある分けていない話）／セパレート解除（幕に分けた話）・移動…・削除
// 幕: 開く・さらに分ける・次の幕とつなぐ（最後の幕にはない）
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { joinError } from '../../../domain/acts'
import { activeVersion, actsOf, isSplit, parentOf, pieceFullLabel } from '../../../domain/structure'
import type { AppData, ID } from '../../../domain/types'
import { paths } from '../../../routes'
import { getData } from '../../../store/appStore'
import { ChevronRightIcon, MoveIcon, TrashIcon } from '../../../ui/icons'
import { useMenuTrigger, type MenuTriggerHandlers } from '../../../ui/longPress'
import { PopupMenu, type MenuPlacement, type PopupMenuItem } from '../../../ui/PopupMenu'
import { confirmJoin, confirmUnseparate } from '../../acts/actFlows'
import { JoinActsIcon, ScissorsIcon, SplitActsIcon, UnsplitIcon } from '../../acts/actIcons'
import { MoveDialog } from './MoveDialog'
import { confirmDeletePiece } from './pieceFlows'

export type RowTarget = { type: 'piece'; id: ID } | { type: 'act'; id: ID }

interface OpenRequest {
  target: RowTarget
  placement: MenuPlacement
  returnFocus: HTMLElement | null
}

interface RowMenuApi {
  open: (req: OpenRequest) => void
}

const RowMenuContext = createContext<RowMenuApi | null>(null)

interface MenuDeps {
  navigate: (to: string) => void
  move: (pieceId: ID) => void
}

/** メニューの名前と項目（開いた時のデータで作る） */
export function rowMenuItems(data: AppData, target: RowTarget, deps: MenuDeps): { label: string; items: PopupMenuItem[] } | null {
  const piece = data.pieces[target.id]
  if (!piece) return null
  const label = `${pieceFullLabel(data, piece)}の操作`
  const open: PopupMenuItem = {
    label: '開く',
    icon: <ChevronRightIcon />,
    onSelect: () => deps.navigate(paths.piece(piece.titleId, piece.id)),
    testId: 'menu-open',
  }
  if (target.type === 'act') {
    const parent = parentOf(data, piece)
    const acts = parent ? actsOf(data, parent) : []
    const last = acts[acts.length - 1]?.id === piece.id
    const adopted = activeVersion(data, piece) !== null
    const items: PopupMenuItem[] = [
      open,
      {
        label: 'さらに分ける',
        icon: <ScissorsIcon />,
        disabled: !adopted,
        hint: adopted ? undefined : '採用稿のない幕は分けられません',
        onSelect: () => deps.navigate(paths.separate(piece.titleId, piece.id)),
        testId: 'menu-split-act',
      },
    ]
    if (!last) {
      const blocked = joinError(data, piece.id)
      items.push({
        label: '次の幕とつなぐ',
        icon: <JoinActsIcon />,
        disabled: blocked !== null,
        hint: blocked ?? undefined,
        onSelect: () => void confirmJoin(piece.id),
        testId: 'menu-join',
      })
    }
    return { label, items }
  }
  const items: PopupMenuItem[] = [open]
  if (piece.kind === 'episode') {
    if (isSplit(piece)) {
      items.push({
        label: 'セパレート解除',
        icon: <UnsplitIcon />,
        onSelect: () => void confirmUnseparate(piece.id),
        testId: 'menu-unseparate',
      })
    } else {
      const adopted = activeVersion(data, piece) !== null
      items.push({
        label: 'セパレート',
        icon: <SplitActsIcon />,
        disabled: !adopted,
        hint: adopted ? '採用原稿を幕に分ける（話数は増えません）' : '採用原稿のある話だけ幕に分けられます',
        onSelect: () => deps.navigate(paths.separate(piece.titleId, piece.id)),
        testId: 'menu-separate',
      })
    }
  }
  items.push(
    { label: '移動…', icon: <MoveIcon />, onSelect: () => deps.move(piece.id), testId: 'menu-move' },
    {
      label: '削除',
      icon: <TrashIcon />,
      danger: true,
      onSelect: () => void confirmDeletePiece(piece.id),
      testId: 'menu-delete',
    },
  )
  return { label, items }
}

export function RowMenuProvider({
  children,
  onPieceMoved,
}: {
  children: ReactNode
  /** メニューの「移動…」で動かした後に呼ばれる（折りたたんだ章を開くなど） */
  onPieceMoved?: (pieceId: ID, via: 'step' | 'dialog') => void
}) {
  const navigate = useNavigate()
  const [request, setRequest] = useState<OpenRequest | null>(null)
  const [moving, setMoving] = useState<ID | null>(null)
  const api = useMemo<RowMenuApi>(
    () => ({
      // 開いている「…」をもう一度押したら閉じる
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
  const menu = request ? rowMenuItems(getData(), request.target, { navigate, move: setMoving }) : null
  return (
    <RowMenuContext.Provider value={api}>
      {children}
      {request && menu ? (
        <PopupMenu
          key={`${request.target.id}`}
          label={menu.label}
          items={menu.items}
          placement={request.placement}
          onClose={close}
          returnFocus={request.returnFocus}
          testId="row-menu"
        />
      ) : null}
      {moving ? (
        <MoveDialog pieceId={moving} onClose={() => setMoving(null)} onMoved={() => onPieceMoved?.(moving, 'dialog')} />
      ) : null}
    </RowMenuContext.Provider>
  )
}

export interface RowMenuTrigger {
  /** 行（リンクと「…」を包む要素）に付ける。右クリック・長押しで開く */
  handlers: MenuTriggerHandlers
  /** 「…」ボタンから開く */
  openFrom: (button: HTMLElement) => void
}

/** 行のメニューを開く手段。一覧に RowMenuProvider がなければ null（メニューを出さない） */
export function useRowMenu(target: RowTarget): RowMenuTrigger | null {
  const api = useContext(RowMenuContext)
  const { type, id } = target
  const handlers = useMenuTrigger((point, el) => {
    api?.open({
      target: { type, id },
      placement: { point },
      // 閉じた後は行のリンクへ（右クリック・長押しした行）
      returnFocus: el.querySelector<HTMLElement>('a') ?? el,
    })
  })
  const openFrom = useCallback(
    (button: HTMLElement) => api?.open({ target: { type, id } as RowTarget, placement: { anchor: button }, returnFocus: button }),
    [api, type, id],
  )
  return api ? { handlers, openFrom } : null
}
