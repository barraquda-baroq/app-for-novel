import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'
import { HomePage } from './features/home/HomePage'
import { actions } from './store/actions'
import { useApp } from './store/appStore'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { AppFrame, AppHeader } from './ui/Layout'
import { NotFound } from './ui/NotFound'

// 起動を軽くするため、ホーム以外の画面は開いた時に読み込む（PWA ではオフライン用に事前キャッシュされる）
const AppSettingsPage = lazy(() =>
  import('./features/appSettings/AppSettingsPage').then((m) => ({
    default: m.AppSettingsPage,
  })),
)
const ChapterPage = lazy(() =>
  import('./features/chapter/ChapterPage').then((m) => ({
    default: m.ChapterPage,
  })),
)
const MemoPage = lazy(() => import('./features/memo/MemoPage').then((m) => ({ default: m.MemoPage })))
const PieceWorkspace = lazy(() =>
  import('./features/piece/PieceWorkspace').then((m) => ({
    default: m.PieceWorkspace,
  })),
)
const ReadThroughPage = lazy(() =>
  import('./features/read/ReadThroughPage').then((m) => ({
    default: m.ReadThroughPage,
  })),
)
const TitlePage = lazy(() => import('./features/title/TitlePage').then((m) => ({ default: m.TitlePage })))
const TrashPage = lazy(() => import('./features/trash/TrashPage').then((m) => ({ default: m.TrashPage })))

const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000

/** 読み込みが終わったら、削除してから30日たったゴミ箱の中身を完全に削除する（開いている間は1時間ごとにも） */
function TrashPurge() {
  const ready = useApp((s) => s.status === 'ready')
  useEffect(() => {
    if (!ready) return
    const purge = () => {
      try {
        actions.purgeExpiredTrash()
      } catch (e) {
        console.warn('ゴミ箱の古いものを削除できませんでした', e)
      }
    }
    purge()
    const timer = window.setInterval(purge, TRASH_PURGE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [ready])
  return null
}

function PageLoading() {
  return (
    <div className="page" role="status">
      <p className="muted">読み込み中…</p>
    </div>
  )
}

function Gate({ children }: { children: React.ReactNode }) {
  const status = useApp((s) => s.status)
  const error = useApp((s) => s.loadError)
  if (status === 'loading') {
    return (
      <div className="page" role="status">
        <p className="muted">読み込み中…</p>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <>
        <AppHeader />
        <div className="page page-narrow">
          <div className="card card-pad stack" role="alert">
            <h1 style={{ fontSize: 18 }}>データを読み込めませんでした</h1>
            <p className="muted" style={{ margin: 0 }}>
              ブラウザの設定でサイトデータ（IndexedDB）の保存が許可されているか確認してください。プライベートブラウズでは保存できない場合があります。
            </p>
            <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {error}
            </pre>
          </div>
        </div>
      </>
    )
  }
  return <>{children}</>
}

/** 1つの画面で描画エラーが起きても、他の画面へ移ればまた表示できるようにする */
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
}

export function App() {
  return (
    <HashRouter>
      <AppFrame>
        <TrashPurge />
        <Gate>
          <RouteErrorBoundary>
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/settings" element={<AppSettingsPage />} />
                <Route path="/trash" element={<TrashPage />} />
                <Route path="/t/:titleId" element={<TitlePage />} />
                <Route path="/t/:titleId/c/:chapterId" element={<ChapterPage />} />
                <Route path="/t/:titleId/p/:pieceId" element={<PieceWorkspace />} />
                <Route path="/t/:titleId/m/:memoId" element={<MemoPage />} />
                <Route path="/t/:titleId/read" element={<ReadThroughPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </RouteErrorBoundary>
        </Gate>
      </AppFrame>
    </HashRouter>
  )
}
