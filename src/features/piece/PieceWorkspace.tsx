// 原稿画面（このアプリの肝）。
// 採用原稿（左／上）と推敲バージョン（右／下）を同じ画面に並べ、比率はスライダーと境界のドラッグで変えられる。
// ?v=<versionId> で比較する推敲バージョンを選ぶ。
// スマホ（狭い画面・高さの低い画面）では、本文などを編集している間は画面上部を畳む（集中モード）。
// 本文・稿の名前・推敲メモ・話の題・見出しの編集は「保存」を押すまで画面の中だけで持つ（usePieceSession.ts）。
// いちばん下に記号バー（巻き戻し／進む・ダッシュ・三点リーダー・全角空白・ルビ・傍点）を置く。
// 幕（セパレート）も同じ画面で編集する（見出しは「第3話　題　第2幕」、前後の移動は同じ話の中の幕）。
// 幕に分けた話は、話自身の本文は編集せず、幕の一覧（EpisodeFolder）を出す。
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { joinError, unseparateError } from '../../domain/acts'
import {
  activeVersion,
  actLabel,
  actNumber,
  episodeNumbers,
  isSplit,
  locatePiece,
  parentOf,
  pieceLabel,
} from '../../domain/structure'
import type { ID, Piece, Title } from '../../domain/types'
import { paths } from '../../routes'
import { getData, useData } from '../../store/appStore'
import { usePrefs } from '../../store/uiStore'
import { useDocumentTitle, useMediaQuery, useSplitOrientation } from '../../ui/hooks'
import { BookIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import type { PopupMenuItem } from '../../ui/PopupMenu'
import { SplitPane } from '../../ui/SplitPane'
import { confirmJoin, confirmUnseparate } from '../acts/actFlows'
import { ActsIcon, JoinActsIcon, ScissorsIcon, SplitActsIcon, UnsplitIcon } from '../acts/actIcons'
import { EpisodeFolder } from '../acts/EpisodeFolder'
import { ActivePane } from './ActivePane'
import { isTypingWithin, useHeldWhile, useLocalFlag, useScrollSync, useTypingFocus } from './editing'
import { useKeyboardInset } from './keyboardInset'
import { activeVersionOf, actNeighbors, neighborPieces, pieceHeading, resolveSelected } from './logic'
import { PieceBar } from './PieceBar'
import './piece.css'
import { SaveControls } from './SaveControls'
import { pieceField } from './session'
import { SymbolBar } from './SymbolBar'
import { usePieceSession } from './usePieceSession'
import { VersionsPane, type WorkspaceApi } from './VersionsPane'

/** 一覧から比較を開いた履歴の印（history.state に入れる） */
const COMPARE_FROM_LIST = 'pwCompareFromList'
type CompareHistoryState = { [COMPARE_FROM_LIST]?: boolean }

export function PieceWorkspace() {
  const { titleId = '', pieceId = '' } = useParams()
  const data = useData()
  const title = data.titles[titleId]
  const piece = data.pieces[pieceId]
  if (!title || !piece || piece.titleId !== title.id) {
    return <NotFound message="話が見つかりません。削除された可能性があります。" />
  }
  if (piece.kind === 'act' && !parentOf(data, piece)) {
    return <NotFound message="幕が見つかりません。つないだり、セパレートを解除したりした可能性があります。" />
  }
  // 幕に分けた話: 幕の一覧（話自身の本文は編集しない）
  if (isSplit(piece)) return <EpisodeFolder key={piece.id} title={title} piece={piece} />
  // 話を切り替えたら画面内の状態（ポップオーバー・編集セッション等）をリセットする
  return <Workspace key={piece.id} title={title} piece={piece} />
}

function Workspace({ title, piece }: { title: Title; piece: Piece }) {
  const data = useData()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const autoOrientation = useSplitOrientation()
  const orientationPref = usePrefs((s) => s.splitOrientation)
  const splitRatio = usePrefs((s) => s.splitRatio)
  const showDiff = usePrefs((s) => s.showDiff)
  const setPrefs = usePrefs((s) => s.setPrefs)
  const [scrollSync, setScrollSync] = useLocalFlag('novel-studio:piece-scroll-sync', false)

  const rootRef = useRef<HTMLDivElement>(null)
  const { session, hub, dirty, save, discard, ensureSaved } = usePieceSession(piece.id)
  useKeyboardInset()

  const numbers = useMemo(() => episodeNumbers(data, title.id), [data, title.id])
  // 幕は、属する話の話数・題・章を見出しと位置に使う
  const isAct = piece.kind === 'act'
  const parent = isAct ? parentOf(data, piece) : undefined
  const episode = parent ?? piece
  const actNo = isAct ? actNumber(data, piece) : null
  const actName = actNo ? actLabel(actNo) : null
  const label = pieceLabel(data, episode, numbers)
  const slot = useMemo(() => locatePiece(data, episode.id), [data, episode.id])
  const chapter = title.chaptersEnabled && slot?.chapterId ? data.chapters[slot.chapterId] : undefined
  const neighbors = useMemo(
    () => (parent ? actNeighbors(data, parent, piece.id) : neighborPieces(data, title.id, piece.id)),
    [data, parent, title.id, piece.id],
  )

  const active = activeVersionOf(data, piece)
  const requested = params.get('v')
  const selected = resolveSelected(data, piece, requested)

  // 入力中の欄（ペインの中なら、スマホでは集中モード）。編集中の欄が作り直される時は判定し直す
  const typing = useTypingFocus(rootRef, '.pw-split', `${active?.id ?? ''}|${selected?.id ?? ''}|${showDiff ? 1 : 0}`)
  const writing = typing === 'area'
  // 指で操作する端末では、仮想キーボードの開閉で画面の縦横比が変わっても、入力中は分割の向きを変えない
  // （キーボードはフォーカスの直後に出るので、typing の反映を待たずに今のフォーカスも見る）
  const touch = useMediaQuery('(pointer: coarse)')
  const holdOrientation = touch && orientationPref === 'auto' && (typing !== null || isTypingWithin('.pw-root'))
  const orientation = useHeldWhile(autoOrientation, holdOrientation)

  useDocumentTitle(
    `${label}${episode.subtitle.trim() ? ` ${episode.subtitle.trim()}` : ''}${actName ? ` ${actName}` : ''} — ${title.name}`,
  )

  // 削除済み・別の話のバージョンを指す ?v は落として一覧表示にする
  useEffect(() => {
    if (requested && !selected) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('v')
          return next
        },
        { replace: true },
      )
    }
  }, [requested, selected, setParams])

  // 一覧から比較を開いた時は履歴に積む（ブラウザ・Android の「戻る」で一覧に戻れるように）。
  // 比較中にバージョンを切り替える時は積まない。一覧に戻る時は、積んだ履歴があればそれを戻る。
  const historyState = location.state as CompareHistoryState | null
  const openedFromList = historyState?.[COMPARE_FROM_LIST] === true
  const select = useCallback(
    (versionId: ID | null) => {
      if (!versionId && requested && openedFromList) {
        navigate(-1)
        return
      }
      const entering = Boolean(versionId) && !requested
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (versionId) next.set('v', versionId)
          else next.delete('v')
          return next
        },
        entering ? { state: { [COMPARE_FROM_LIST]: true } } : { replace: true, state: versionId ? historyState : null },
      )
    },
    [setParams, navigate, requested, openedFromList, historyState],
  )

  const comparing = Boolean(selected)
  useScrollSync(scrollSync && comparing, rootRef, `${active?.id ?? ''}|${selected?.id ?? ''}|${showDiff ? 1 : 0}|${orientation}`)

  // 保存していない編集があれば、移動する前に確かめる（usePieceSession.ts の useBlocker）
  const goTo = (id: ID | null) => {
    if (!id) return
    navigate(paths.piece(title.id, id))
  }

  /** コピーの見出し（編集中の見出し・話の題を使う）。幕は「第3話　題　第2幕」 */
  const pieceKind = piece.kind
  const storedLabel = piece.label
  const episodeId = episode.id
  const storedSubtitle = episode.subtitle
  const heading = useCallback(() => {
    const subtitle = session.display(pieceField(episodeId, 'subtitle'), storedSubtitle)
    if (pieceKind === 'act') return [pieceHeading('episode', label, subtitle), actName].filter(Boolean).join('　')
    return pieceHeading(
      pieceKind,
      pieceKind === 'episode' ? label : session.display(pieceField(episodeId, 'label'), storedLabel),
      subtitle,
    )
  }, [pieceKind, label, session, episodeId, storedLabel, storedSubtitle, actName])

  // 上部バーの「幕」メニュー: 幕に分ける（採用原稿のある話）／さらに分ける・次の幕とつなぐ・セパレート解除（幕）。
  // 項目は開いた時のデータで作る。保存していない編集があれば、操作の前に保存するか聞く
  const parentId = parent?.id ?? null
  const pieceId = piece.id
  const titleId = title.id
  const hasActive = active !== null
  const actMenu = useMemo(() => {
    if (pieceKind === 'special' || (pieceKind === 'episode' && !hasActive)) return null
    const guarded = (fn: () => unknown) => () => {
      void ensureSaved().then((ok) => (ok ? fn() : undefined))
    }
    return (): PopupMenuItem[] => {
      const d = getData()
      if (!parentId) {
        return [
          {
            label: '幕に分ける（セパレート）',
            icon: <SplitActsIcon />,
            hint: '採用原稿を区切って WEB 掲載用の幕にする（話数は増えません）',
            onSelect: guarded(() => navigate(paths.separate(titleId, pieceId))),
            testId: 'separate-button',
          },
        ]
      }
      const self = d.pieces[pieceId]
      const adopted = self ? activeVersion(d, self) !== null : false
      const items: PopupMenuItem[] = [
        {
          label: 'さらに分ける',
          icon: <ScissorsIcon />,
          disabled: !adopted,
          hint: adopted ? undefined : '採用稿のない幕は分けられません',
          onSelect: guarded(() => navigate(paths.separate(titleId, pieceId))),
          testId: 'separate-button',
        },
      ]
      const parentPiece = d.pieces[parentId]
      if (parentPiece && actNeighbors(d, parentPiece, pieceId).next) {
        const blocked = joinError(d, pieceId)
        items.push({
          label: '次の幕とつなぐ',
          icon: <JoinActsIcon />,
          disabled: blocked !== null,
          hint: blocked ?? undefined,
          onSelect: guarded(() => confirmJoin(pieceId)),
          testId: 'join-next-button',
        })
      }
      const unsplitBlocked = unseparateError(d, parentId)
      items.push(
        {
          label: 'セパレート解除',
          icon: <UnsplitIcon />,
          disabled: unsplitBlocked !== null,
          hint: unsplitBlocked ?? '各幕の採用稿をつないで、1つの話に戻す',
          // 解除するとこの幕はなくなるので、話の画面へ移る
          onSelect: guarded(async () => {
            if (await confirmUnseparate(parentId)) navigate(paths.piece(titleId, parentId), { replace: true })
          }),
          testId: 'unseparate-act-button',
        },
        {
          label: `幕の一覧（${label}）`,
          icon: <ActsIcon />,
          onSelect: () => navigate(paths.piece(titleId, parentId)),
          testId: 'open-folder',
        },
      )
      return items
    }
  }, [pieceKind, hasActive, parentId, pieceId, titleId, label, ensureSaved, navigate])

  // キーボードで押した「保存」「破棄」は、押した後に押せなく（無く）なってフォーカスが外れるので、最後に書いていた欄へ戻す
  // （指・マウスで押した時は戻さない。スマホでキーボードが開いてしまうので）
  const refocusAfter = (run: () => Promise<unknown>) => (e: { detail: number }) => {
    const byKeyboard = e.detail === 0
    void run().then(() => {
      if (!byKeyboard) return
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (!a || a === document.body || !a.isConnected || a.matches(':disabled')) {
          hub.getTarget()?.element()?.focus({ preventScroll: true })
        }
      })
    })
  }

  const crumbs: Crumb[] = [{ label: title.name || '無題のタイトル', to: paths.title(title.id) }]
  if (chapter) crumbs.push({ label: chapter.name || '（無題の章）', to: paths.chapter(title.id, chapter.id) })
  if (parent) {
    crumbs.push({ label, to: paths.piece(title.id, parent.id) })
    crumbs.push({ label: actName ?? '第?幕' })
  } else crumbs.push({ label })

  const api: WorkspaceApi = {
    piece,
    titleId: title.id,
    orientation,
    hub,
    select,
    ensureSaved,
    heading,
  }

  return (
    <div
      className={`pw-root${writing ? ' is-focus-mode' : ''}${dirty ? ' is-dirty' : ''}`}
      ref={rootRef}
      data-testid="piece-workspace"
    >
      <AppHeader
        crumbs={crumbs}
        actions={
          <>
            <SaveControls dirty={dirty} onSave={refocusAfter(save)} onDiscard={refocusAfter(discard)} />
            <Link
              to={paths.read(title.id)}
              className="icon-btn"
              aria-label="通し読み（採用原稿のみ）"
              title="通し読み（採用原稿のみ）"
            >
              <BookIcon />
            </Link>
          </>
        }
      />
      <PieceBar
        piece={piece}
        episode={episode}
        actLabel={actName}
        actMenu={actMenu}
        hub={hub}
        label={label}
        prev={neighbors.prev ? { id: neighbors.prev, label: pieceLabel(data, data.pieces[neighbors.prev], numbers) } : null}
        next={neighbors.next ? { id: neighbors.next, label: pieceLabel(data, data.pieces[neighbors.next], numbers) } : null}
        onNavigate={goTo}
        comparing={comparing}
        scrollSync={scrollSync}
        onScrollSyncChange={setScrollSync}
        showDiff={showDiff}
        onShowDiffChange={(v) => setPrefs({ showDiff: v })}
      />
      <SplitPane
        className="pw-split"
        orientation={orientation}
        ratio={splitRatio}
        onRatioChange={(r) => setPrefs({ splitRatio: r })}
        first={<ActivePane api={api} active={active} />}
        second={<VersionsPane api={api} active={active} selected={selected} showDiff={showDiff} />}
        firstLabel="採用原稿"
        secondLabel="推敲バージョン"
      />
      <SymbolBar hub={hub} dirty={dirty} onSave={() => void save()} />
    </div>
  )
}
