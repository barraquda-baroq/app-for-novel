// アプリの外枠: ヘッダー（パンくず・保存状態・設定）、トースト、ダイアログ
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigationType } from 'react-router-dom'
import { flushNow, reloadFromDisk, useApp } from '../store/appStore'
import { flushAllDrafts } from '../store/draftRegistry'
import { notify, notifyError, resolveAppearance, THEME_COLORS, useAppUpdate, usePrefs, useToasts } from '../store/uiStore'
import { DialogHost, cancelAllDialogs } from './dialogs'
import { GearIcon, XIcon } from './icons'
import { SyncIndicator } from './SyncIndicator'

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
            <span
              className={i === items.length - 1 ? 'current' : undefined}
              aria-current={i === items.length - 1 ? 'page' : undefined}
            >
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}

function SaveStatus() {
  const saveStatus = useApp((s) => s.saveStatus)
  const draftsDirty = useApp((s) => s.draftsDirty)
  const error = useApp((s) => s.saveError)
  // 入力欄にまだ反映していない文字があるうちは「保存済み」と表示しない
  const status = saveStatus === 'saved' && draftsDirty ? 'pending' : saveStatus
  const label = {
    saved: '保存済み',
    pending: '編集中…',
    saving: '保存中…',
    error: '保存できませんでした',
  }[status]
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
      <SyncIndicator />
      <Link to="/settings" className="icon-btn" aria-label="アプリの設定・バックアップ" title="アプリの設定・バックアップ">
        <GearIcon />
      </Link>
    </header>
  )
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  // ダイアログ表示中は画面本体が操作不可（inert）になるので、通知は body 直下に出す
  return createPortal(
    <div className="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <p>{t.message}</p>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="閉じる">
            <XIcon />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

function ExternalChangeBanner() {
  const external = useApp((s) => s.externalChange)
  if (!external) return null
  const reload = async () => {
    flushAllDrafts()
    if (await reloadFromDisk()) notify('最新の内容を読み込みました')
    else
      notifyError(
        'このタブの変更を保存できなかったため、読み込み直しませんでした。保存できるようになってからもう一度お試しください。',
      )
  }
  return (
    <div className="banner" role="alert">
      <span className="grow">
        別のタブ・ウィンドウでデータが変更されました。最新の内容を読み込んでください（このタブで変えた項目はそのまま残ります）。
      </span>
      <button type="button" className="btn btn-sm" onClick={() => void reload()}>
        最新を読み込む
      </button>
    </div>
  )
}

/** 保存できない状態が続いている時は、スマホでも見える場所ではっきり知らせる */
function SaveErrorBanner() {
  const status = useApp((s) => s.saveStatus)
  const error = useApp((s) => s.saveError)
  if (status !== 'error') return null
  return (
    <div className="banner banner-error" role="alert" data-testid="save-error-banner">
      <span className="grow">
        保存できませんでした{error ? `（${error}）` : ''}
        。端末の空き容量を確認してください。しばらくすると自動でもう一度保存します。念のため「アプリの設定」からバックアップを書き出しておくと安心です。
      </span>
      <button type="button" className="btn btn-sm" onClick={() => void flushNow()}>
        再試行
      </button>
      <Link to="/settings" className="btn btn-sm">
        バックアップへ
      </Link>
    </div>
  )
}

function UpdateBanner() {
  const ready = useAppUpdate((s) => s.ready)
  const apply = useAppUpdate((s) => s.apply)
  if (!ready || !apply) return null
  return (
    <div className="banner banner-info" role="status">
      <span className="grow">新しいバージョンのアプリがあります。書いた内容を保存してから更新します。</span>
      <button type="button" className="btn btn-sm" onClick={() => void apply()}>
        更新する
      </button>
    </div>
  )
}

/** 前回の終了時に保存しきれなかった変更を復元したら知らせる */
function RecoveryNotice() {
  const count = useApp((s) => s.recoveredCount)
  useEffect(() => {
    if (count > 0) notify(`前回の終了時に保存しきれなかった変更（${count}件）を復元しました`)
  }, [count])
  return null
}

/**
 * 外観・原稿の書体と文字サイズを <html> に反映する。
 * data-theme には実際の外観（white / dark / deep-dark）を入れる。「端末の設定に合わせる」の間は端末の切り替えにも追従する。
 * ブラウザの枠の色（<meta name="theme-color">）も外観に合わせる。最初の描画前は index.html のスクリプトが同じことをする。
 */
function PrefsEffect() {
  const theme = usePrefs((s) => s.theme)
  const font = usePrefs((s) => s.editorFont)
  const size = usePrefs((s) => s.editorFontSize)
  useEffect(() => {
    const root = document.documentElement
    const query = theme === 'system' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined
    const apply = () => {
      const appearance = resolveAppearance(theme, query?.matches ?? false)
      root.setAttribute('data-theme', appearance)
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
      }
      meta.content = THEME_COLORS[appearance]
    }
    apply()
    query?.addEventListener?.('change', apply)
    return () => query?.removeEventListener?.('change', apply)
  }, [theme])
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--editor-font', font === 'mincho' ? 'var(--font-mincho)' : 'var(--font-gothic)')
    root.style.setProperty('--editor-size', `${size}px`)
  }, [font, size])
  return null
}

const SCROLL_KEY = 'novel-studio:scroll'
/** 控えておく履歴の項目の数（古いものから捨てる） */
const SCROLL_MEMORY_MAX = 50

function readScrollMemory(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeScrollMemory(entryKey: string, y: number): void {
  try {
    const memory = readScrollMemory()
    delete memory[entryKey]
    memory[entryKey] = Math.max(0, Math.round(y))
    const keys = Object.keys(memory)
    for (const k of keys.slice(0, Math.max(0, keys.length - SCROLL_MEMORY_MAX))) delete memory[k]
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(memory))
  } catch {
    /* noop */
  }
}

/**
 * 画面（パス）が変わったら先頭から表示する。?tab= などのクエリだけの変更ではスクロールしない。
 * ブラウザの「戻る／進む」では、その画面を離れた時のスクロール位置に戻す。
 */
function ScrollOnNavigate() {
  const location = useLocation()
  const navType = useNavigationType()
  const pathKey = location.pathname
  const entryKey = location.key
  const restoring = useRef(false)

  // 離れる時の位置を履歴の項目ごとに覚えておく。
  // 画面が切り替わる瞬間にページが縮んで位置が 0 に詰められると、その 0 を前の画面の位置として
  // 記録してしまうので、リスナーは DOM の入れ替えと同じタイミング（layout effect）で付け外しする。
  useLayoutEffect(() => {
    let frame = 0
    const onScroll = () => {
      if (restoring.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => writeScrollMemory(entryKey, window.scrollY))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
    }
  }, [entryKey])

  useLayoutEffect(() => {
    if (navType === 'POP') {
      // 位置はスクロールイベントで上書きされる前に読む
      const y = readScrollMemory()[entryKey]
      if (typeof y === 'number' && y > 0) {
        restoring.current = true
        let tries = 0
        let frame = 0
        // 遅れて読み込まれる画面もあるので、目的の位置までスクロールできる高さになるまで少し待つ
        const step = () => {
          const max = document.documentElement.scrollHeight - window.innerHeight
          if (max >= y || tries >= 60) {
            window.scrollTo(0, Math.min(y, Math.max(0, max)))
            restoring.current = false
            return
          }
          tries += 1
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        return () => {
          cancelAnimationFrame(frame)
          restoring.current = false
        }
      }
    }
    window.scrollTo(0, 0)
    // パスが変わった時だけ（クエリだけの変更では動かさない）
  }, [pathKey])
  return null
}

/** 画面が変わったら、開いたままの確認・入力ダイアログはキャンセル扱いで閉じる */
function CloseDialogsOnNavigate() {
  const { pathname } = useLocation()
  useEffect(() => cancelAllDialogs, [pathname])
  return null
}

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <ScrollOnNavigate />
      <CloseDialogsOnNavigate />
      <PrefsEffect />
      <RecoveryNotice />
      <UpdateBanner />
      <SaveErrorBanner />
      <ExternalChangeBanner />
      {children}
      <Toasts />
      <DialogHost />
    </div>
  )
}
