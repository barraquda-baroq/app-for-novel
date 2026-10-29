import { lazy, Suspense, useEffect } from 'react'
import { createHashRouter, Outlet, RouterProvider, useLocation, useRouteError, type RouteObject } from 'react-router-dom'
import { HomePage } from './features/home/HomePage'
import { actions } from './store/actions'
import { isNative } from './platform/platform'
import { useApp } from './store/appStore'
import { ErrorBoundary, ErrorScreen } from './ui/ErrorBoundary'
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
const SeparatePage = lazy(() =>
  import('./features/acts/SeparatePage').then((m) => ({
    default: m.SeparatePage,
  })),
)
const ReadThroughPage = lazy(() =>
  import('./features/read/ReadThroughPage').then((m) => ({
    default: m.ReadThroughPage,
  })),
)
const TitlePage = lazy(() => import('./features/title/TitlePage').then((m) => ({ default: m.TitlePage })))
const TrashPage = lazy(() => import('./features/trash/TrashPage').then((m) => ({ default: m.TrashPage })))
const ConnectPage = lazy(() => import('./features/claude/ConnectPage').then((m) => ({ default: m.ConnectPage })))

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
              {isNative()
                ? '端末の空き容量を確認して、アプリを開き直してください。続く時は端末を再起動してください（アプリは削除しないでください。端末の中のデータが消えます）。'
                : 'ブラウザの設定でサイトデータ（IndexedDB）の保存が許可されているか確認してください。プライベートブラウズでは保存できない場合があります。'}
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

/** すべての画面の外枠。画面ごとの中身は <Outlet /> に入る */
function RootLayout() {
  return (
    <AppFrame>
      <TrashPurge />
      <Gate>
        <RouteErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </Gate>
    </AppFrame>
  )
}

/** 外枠そのものの描画に失敗した時（ふつうは各画面のエラー表示 RouteErrorBoundary が受け止める） */
function RootError() {
  const error = useRouteError()
  console.error('画面の表示中にエラーが起きました', error)
  return <ErrorScreen message={error instanceof Error ? error.message : String(error)} />
}

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RootError />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/settings', element: <AppSettingsPage /> },
      { path: '/trash', element: <TrashPage /> },
      { path: '/t/:titleId', element: <TitlePage /> },
      { path: '/t/:titleId/c/:chapterId', element: <ChapterPage /> },
      { path: '/t/:titleId/p/:pieceId', element: <PieceWorkspace /> },
      { path: '/t/:titleId/p/:pieceId/separate', element: <SeparatePage /> },
      { path: '/t/:titleId/m/:memoId', element: <MemoPage /> },
      { path: '/t/:titleId/read', element: <ReadThroughPage /> },
      { path: '/claude/connect', element: <ConnectPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

// 画面を離れる前の確認（原稿画面の保存していない編集）に useBlocker を使うので、データルーターにする
let router: ReturnType<typeof createHashRouter> | null = null

export function App() {
  router ??= createHashRouter(routes)
  return <RouterProvider router={router} />
}
