import { HashRouter, Route, Routes } from 'react-router-dom'
import { AppSettingsPage } from './features/appSettings/AppSettingsPage'
import { ChapterPage } from './features/chapter/ChapterPage'
import { HomePage } from './features/home/HomePage'
import { MemoPage } from './features/memo/MemoPage'
import { PieceWorkspace } from './features/piece/PieceWorkspace'
import { ReadThroughPage } from './features/read/ReadThroughPage'
import { TitlePage } from './features/title/TitlePage'
import { useApp } from './store/appStore'
import { AppFrame, AppHeader } from './ui/Layout'
import { NotFound } from './ui/NotFound'

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

export function App() {
  return (
    <HashRouter>
      <AppFrame>
        <Gate>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/settings" element={<AppSettingsPage />} />
            <Route path="/t/:titleId" element={<TitlePage />} />
            <Route path="/t/:titleId/c/:chapterId" element={<ChapterPage />} />
            <Route path="/t/:titleId/p/:pieceId" element={<PieceWorkspace />} />
            <Route path="/t/:titleId/m/:memoId" element={<MemoPage />} />
            <Route path="/t/:titleId/read" element={<ReadThroughPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Gate>
      </AppFrame>
    </HashRouter>
  )
}
