// 原稿画面（このアプリの肝）。
// 採用原稿（左／上）と推敲バージョン（右／下）を同じ画面に並べ、比率はスライダーと境界のドラッグで変えられる。
// ?v=<versionId> で比較する推敲バージョンを選ぶ。
// スマホ（狭い画面・高さの低い画面）では、本文などを編集している間は画面上部を畳む（集中モード）。
// 本文・稿の名前・推敲メモ・話の題・見出しの編集は「保存」を押すまで画面の中だけで持つ（usePieceSession.ts）。
// いちばん下に記号バー（巻き戻し／進む・ダッシュ・三点リーダー・全角空白・ルビ・傍点）を置く。
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { episodeNumbers, locatePiece, pieceLabel } from '../../domain/structure'
import type { ID, Piece, Title } from '../../domain/types'
import { paths } from '../../routes'
import { useData } from '../../store/appStore'
import { usePrefs } from '../../store/uiStore'
import { useDocumentTitle, useMediaQuery, useSplitOrientation } from '../../ui/hooks'
import { BookIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { SplitPane } from '../../ui/SplitPane'
import { ActivePane } from './ActivePane'
import { isTypingWithin, useHeldWhile, useLocalFlag, useScrollSync, useTypingFocus } from './editing'
import { useKeyboardInset } from './keyboardInset'
import { activeVersionOf, neighborPieces, pieceHeading, resolveSelected } from './logic'
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
  const label = pieceLabel(data, piece, numbers)
  const slot = useMemo(() => locatePiece(data, piece.id), [data, piece.id])
  const chapter = title.chaptersEnabled && slot?.chapterId ? data.chapters[slot.chapterId] : undefined
  const neighbors = useMemo(() => neighborPieces(data, title.id, piece.id), [data, title.id, piece.id])

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

  useDocumentTitle(`${label}${piece.subtitle.trim() ? ` ${piece.subtitle.trim()}` : ''} — ${title.name}`)

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

  /** コピーの見出し（編集中の見出し・話の題を使う） */
  const pieceKind = piece.kind
  const storedLabel = piece.label
  const storedSubtitle = piece.subtitle
  const heading = useCallback(
    () =>
      pieceHeading(
        pieceKind,
        pieceKind === 'episode' ? label : session.display(pieceField(piece.id, 'label'), storedLabel),
        session.display(pieceField(piece.id, 'subtitle'), storedSubtitle),
      ),
    [pieceKind, label, session, piece.id, storedLabel, storedSubtitle],
  )

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
  crumbs.push({ label })

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
