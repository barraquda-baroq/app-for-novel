// アプリの外枠: ヘッダー（パンくず・保存状態・設定）、トースト、ダイアログ
import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { reloadFromDisk, useApp } from '../store/appStore'
import { usePrefs, useToasts } from '../store/uiStore'
import { DialogHost } from './dialogs'
import { GearIcon, XIcon } from './icons'

export interface Crumb {
  label: string
  to?: string
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="現在地">
      {items.map((c, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 ? <span className="sep">›</span> : null}
          {c.to && i < items.length - 1 ? (
            <Link to={c.to}>{c.label}</Link>
          ) : (
            <span className={i === items.length - 1 ? 'current' : undefined} aria-current={i === items.length - 1 ? 'page' : undefined}>
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}

function SaveStatus() {
  const status = useApp((s) => s.saveStatus)
  const error = useApp((s) => s.saveError)
  const label = { saved: '保存済み', pending: '編集中…', saving: '保存中…', error: '保存できませんでした' }[status]
  return (
    <span className={`save-status ${status}`} title={error ?? undefined} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span className="hide-mobile">{label}</span>
    </span>
  )
}

/** 各画面のヘッダー。crumbs にパンくず、actions に右側のボタンを渡す */
export function AppHeader({ crumbs, actions }: { crumbs?: Crumb[]; actions?: ReactNode }) {
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="ホーム（アイデアとタイトル一覧）">
        <img src="./icon.svg" alt="" />
        <span className={crumbs && crumbs.length > 0 ? 'hide-mobile' : undefined}>Novel Studio</span>
      </Link>
      {crumbs && crumbs.length > 0 ? (
        <>
          <span className="faint hide-mobile">/</span>
          <Breadcrumbs items={crumbs} />
        </>
      ) : null}
      <span className="spacer" />
      {actions}
      <SaveStatus />
      <Link to="/settings" className="icon-btn" aria-label="アプリの設定とバックアップ" title="設定・バックアップ">
        <GearIcon />
      </Link>
    </header>
  )
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <p>{t.message}</p>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="閉じる">
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  )
}

function ExternalChangeBanner() {
  const external = useApp((s) => s.externalChange)
  if (!external) return null
  return (
    <div className="banner" role="alert">
      <span className="grow">別のタブ・ウィンドウでデータが変更されました。最新の内容を読み込んでください（同時に編集すると上書きされることがあります）。</span>
      <button type="button" className="btn btn-sm" onClick={() => void reloadFromDisk()}>
        最新を読み込む
      </button>
    </div>
  )
}

/** テーマ・エディタフォントを <html> に反映する */
function PrefsEffect() {
  const theme = usePrefs((s) => s.theme)
  const font = usePrefs((s) => s.editorFont)
  const size = usePrefs((s) => s.editorFontSize)
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    root.style.setProperty('--editor-font', font === 'mincho' ? 'var(--font-mincho)' : 'var(--font-ui)')
    root.style.setProperty('--editor-size', `${size}px`)
  }, [theme, font, size])
  return null
}

/** 画面（パス）が変わったら先頭から表示する。?tab= などのクエリだけの変更ではスクロールしない */
function ScrollToTopOnNavigate() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <ScrollToTopOnNavigate />
      <PrefsEffect />
      <ExternalChangeBanner />
      {children}
      <Toasts />
      <DialogHost />
    </div>
  )
}
