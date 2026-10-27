// 原稿画面（このアプリの肝）。
// 採用原稿（左／上）と推敲バージョン（右／下）を同じ画面に並べ、比率はスライダーと境界のドラッグで変えられる。
// ?v=<versionId> で比較する推敲バージョンを選ぶ。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { episodeNumbers, locatePiece, pieceLabel } from '../../domain/structure'
import type { ID, Piece, Title } from '../../domain/types'
import { paths } from '../../routes'
import { flushNow, useData } from '../../store/appStore'
import { notify, usePrefs } from '../../store/uiStore'
import type { DraftHandle } from '../../ui/DraftField'
import { useDocumentTitle, useSplitOrientation } from '../../ui/hooks'
import { BookIcon } from '../../ui/icons'
import { AppHeader, type Crumb } from '../../ui/Layout'
import { NotFound } from '../../ui/NotFound'
import { SplitPane } from '../../ui/SplitPane'
import { ActivePane } from './ActivePane'
import { DraftRegistryContext, flushEditors, useLocalFlag, useScrollSync, type DraftRegistry } from './editing'
import { activeVersionOf, neighborPieces, resolveSelected } from './logic'
import { PieceBar } from './PieceBar'
import './piece.css'
import { VersionsPane, type WorkspaceApi } from './VersionsPane'

export function PieceWorkspace() {
  const { titleId = '', pieceId = '' } = useParams()
  const data = useData()
  const title = data.titles[titleId]
  const piece = data.pieces[pieceId]
  if (!title || !piece || piece.titleId !== title.id) {
    return <NotFound message="話が見つかりません。削除された可能性があります。" />
  }
  // 話を切り替えたら画面内の状態（ポップオーバー・下書き等）をリセットする
  return <Workspace key={piece.id} title={title} piece={piece} />
}

function Workspace({ title, piece }: { title: Title; piece: Piece }) {
  const data = useData()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const orientation = useSplitOrientation()
  const splitRatio = usePrefs((s) => s.splitRatio)
  const showDiff = usePrefs((s) => s.showDiff)
  const setPrefs = usePrefs((s) => s.setPrefs)
  const [scrollSync, setScrollSync] = useLocalFlag('novel-studio:piece-scroll-sync', false)

  const rootRef = useRef<HTMLDivElement>(null)
  const activeEditor = useRef<DraftHandle>(null)
  const compareEditor = useRef<DraftHandle>(null)
  const noteEditor = useRef<DraftHandle>(null)
  const [drafts] = useState<DraftRegistry>(() => new Set())

  const numbers = useMemo(() => episodeNumbers(data, title.id), [data, title.id])
  const label = pieceLabel(data, piece, numbers)
  const slot = useMemo(() => locatePiece(data, piece.id), [data, piece.id])
  const chapter = title.chaptersEnabled && slot?.chapterId ? data.chapters[slot.chapterId] : undefined
  const neighbors = useMemo(() => neighborPieces(data, title.id, piece.id), [data, title.id, piece.id])

  const active = activeVersionOf(data, piece)
  const requested = params.get('v')
  const selected = resolveSelected(data, piece, requested)

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

  const select = useCallback(
    (versionId: ID | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (versionId) next.set('v', versionId)
          else next.delete('v')
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  // Ctrl/Cmd+S: 入力中の下書きも含めてすぐに保存する
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        flushEditors(activeEditor, compareEditor, noteEditor, ...drafts)
        void flushNow().then(() => notify('保存しました'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drafts])

  const comparing = Boolean(selected)
  useScrollSync(
    scrollSync && comparing,
    rootRef,
    `${active?.id ?? ''}|${selected?.id ?? ''}|${showDiff ? 1 : 0}|${orientation}`,
  )

  const goTo = (id: ID | null) => {
    if (!id) return
    flushEditors(activeEditor, compareEditor, noteEditor)
    navigate(paths.piece(title.id, id))
  }

  const crumbs: Crumb[] = [{ label: title.name || '無題のタイトル', to: paths.title(title.id) }]
  if (chapter) crumbs.push({ label: chapter.name || '（無題の章）', to: paths.chapter(title.id, chapter.id) })
  crumbs.push({ label })

  const api: WorkspaceApi = {
    piece,
    titleId: title.id,
    orientation,
    activeEditor,
    compareEditor,
    noteEditor,
    select,
  }

  return (
    <DraftRegistryContext.Provider value={drafts}>
      <div className="pw-root" ref={rootRef} data-testid="piece-workspace">
        <AppHeader
          crumbs={crumbs}
          actions={
            <Link to={paths.read(title.id)} className="icon-btn" aria-label="通し読み（採用原稿のみ）" title="通し読み（採用原稿のみ）">
              <BookIcon />
            </Link>
          }
        />
        <PieceBar
          piece={piece}
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
      </div>
    </DraftRegistryContext.Provider>
  )
}
