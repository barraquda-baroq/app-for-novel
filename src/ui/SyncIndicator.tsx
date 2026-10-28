// ヘッダーの同期の状態（ログインしたことのある端末だけに出す）。押すとアプリの設定の「同期」へ。
import { Link } from 'react-router-dom'
import { useUnsavedEdits } from '../store/unsavedEdits'
import { useSync, type SyncState } from '../sync/controller'
import './sync.css'

export type SyncBadge = { tone: 'ok' | 'busy' | 'warn' | 'error' | 'off'; label: string; detail: string }

/** 同期の状態を、ヘッダー・設定で使う短い言葉にする */
export function syncBadge(
  s: Pick<SyncState, 'auth' | 'status' | 'leader' | 'everSignedIn'> & Partial<Pick<SyncState, 'accountMismatch'>>,
): SyncBadge | null {
  if (s.auth === 'idle' && !s.everSignedIn) return null
  if (s.auth === 'signedIn' && s.accountMismatch)
    return {
      tone: 'warn',
      label: '確認が必要',
      detail: '以前とは別のアカウントでログインしています。アプリの設定の「同期」で確かめてください',
    }
  if (s.auth === 'idle' || s.auth === 'checking')
    return { tone: 'busy', label: '確認中', detail: 'ログインの状態を確認しています' }
  if (s.auth === 'signedOut')
    return { tone: 'off', label: '未ログイン', detail: 'ログインしていないため、ほかの端末と同期していません' }
  const st = s.status
  if (!s.leader && !st) return { tone: 'ok', label: '同期中', detail: '別のウィンドウ（タブ）で同期しています' }
  if (!st || st.phase === 'starting' || st.phase === 'downloading')
    return { tone: 'busy', label: '同期中', detail: 'クラウドの内容を受け取っています' }
  if (st.phase === 'uploading')
    return { tone: 'busy', label: '送信中', detail: `クラウドへ送っています（残り ${st.pending} 件）` }
  if (st.phase === 'offline')
    return {
      tone: 'warn',
      label: st.pending ? `未送信 ${st.pending}` : 'オフライン',
      detail: st.pending
        ? `オフラインです。未送信の変更が ${st.pending} 件あります（この端末には保存済み。つながると送ります）`
        : 'オフラインです。つながると自動で同期します',
    }
  if (st.phase === 'error') return { tone: 'error', label: '同期できません', detail: st.error ?? '同期できませんでした' }
  if (st.pending > 0) return { tone: 'busy', label: '送信待ち', detail: `送信待ちの変更が ${st.pending} 件あります` }
  return { tone: 'ok', label: '同期済み', detail: 'ほかの端末と同じ内容です' }
}

/** 保存していない編集がある間の「同期済み」の説明 */
export function unsavedSyncBadge(badge: SyncBadge | null, unsaved: boolean): SyncBadge | null {
  if (!badge || !unsaved || badge.tone !== 'ok' || badge.label !== '同期済み') return badge
  return { ...badge, detail: '保存した内容はほかの端末と同じです（保存していない編集は、保存すると送ります）' }
}

export function SyncIndicator() {
  const auth = useSync((s) => s.auth)
  const status = useSync((s) => s.status)
  const leader = useSync((s) => s.leader)
  const everSignedIn = useSync((s) => s.everSignedIn)
  const accountMismatch = useSync((s) => s.accountMismatch)
  // 保存ボタンで確定する画面に保存していない編集がある間は、「ほかの端末と同じ内容」と言い切らない
  // （保存していない編集は、まだどこにも送っていない）
  const unsaved = useUnsavedEdits((s) => s.dirty)
  const badge = unsavedSyncBadge(syncBadge({ auth, status, leader, everSignedIn, accountMismatch }), unsaved)
  if (!badge) return null
  return (
    <Link
      to="/settings#sync"
      className={`sync-indicator ${badge.tone}`}
      title={badge.detail}
      aria-label={`同期: ${badge.label}。${badge.detail}`}
      data-testid="sync-indicator"
      data-tone={badge.tone}
    >
      <CloudIcon tone={badge.tone} />
      <span className="hide-mobile">{badge.label}</span>
    </Link>
  )
}

function CloudIcon({ tone }: { tone: SyncBadge['tone'] }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.1 4.5 4.5 0 0 0 7 18Z" />
      {tone === 'ok' ? <path d="m9.5 13.5 2 2 3.5-4" /> : null}
      {tone === 'busy' ? <path d="M12 10.5v5m0-5-2 2m2-2 2 2" /> : null}
      {tone === 'warn' || tone === 'off' ? <path d="m9.5 11.5 5 5m0-5-5 5" /> : null}
      {tone === 'error' ? <path d="M12 10.5v3m0 2.2v.1" /> : null}
    </svg>
  )
}
