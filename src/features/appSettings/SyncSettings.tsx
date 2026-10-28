// 同期: Google アカウントでログインして、Windows・iPhone・Android の内容を同じにする。
import { useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { notify, notifyError } from '../../store/uiStore'
import { confirmAccountSwitch, signIn, signOut, syncNow, useSync } from '../../sync/controller'
import { formatRelative } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { syncBadge } from '../../ui/SyncIndicator'

export function SyncSettings() {
  const id = useId()
  const s = useSync()
  const ref = useRef<HTMLElement>(null)
  const { hash } = useLocation()
  const [syncing, setSyncing] = useState(false)
  const badge = syncBadge(s)

  useEffect(() => {
    if (hash === '#sync') ref.current?.scrollIntoView({ block: 'start' })
  }, [hash])

  const logout = async () => {
    const ok = await confirmDialog({
      title: 'ログアウトしますか？',
      message:
        'ログアウトすると、この端末はほかの端末と同期しなくなります。この端末のデータはそのまま残り、もう一度ログインすると続きから同期します。',
      confirmLabel: 'ログアウト',
    })
    if (ok) await signOut()
  }

  const now = async () => {
    setSyncing(true)
    try {
      await syncNow()
      const st = useSync.getState().status
      if (st?.phase === 'error' || st?.phase === 'offline') notifyError(st.error ?? '同期できませんでした')
      else notify('クラウドと同期しました')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section ref={ref} id="sync" className="card aset-card" aria-labelledby={`${id}-title`} data-testid="sync-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>同期</h2>
        <p className="aset-card-lead">
          Google アカウントでログインすると、Windows・iPhone・Android
          のどの端末で書いた内容も自動で同じになります（表示の設定はこの端末だけのものです）。原稿はあなたのアカウントでしか読み書きできません。通信できない間もこれまでどおり書けて、つながった時に送ります。
        </p>
      </div>

      {s.auth === 'signedIn' && s.user && s.accountMismatch ? (
        <div className="aset-row" data-testid="sync-account-mismatch">
          <div className="aset-row-label">
            <span>別のアカウントでログインしています</span>
            <span className="aset-row-desc">
              この端末は以前{s.accountMismatch.previousEmail ? `、${s.accountMismatch.previousEmail} ` : '、別のアカウント'}
              と同期していました。いまのアカウント（{s.user.email || s.user.name}
              ）で同期すると、この端末の内容をこのアカウントのクラウドの内容と突き合わせて保存します（どちらの文章も消えません）。間違えて選んだ時は、ログアウトしてから持ち主のアカウントでログインし直してください。
            </span>
          </div>
          <div className="aset-row-control">
            <button type="button" className="btn" onClick={() => void signOut()} disabled={s.busy}>
              ログアウト
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void confirmAccountSwitch()}
              disabled={s.busy}
              data-testid="sync-confirm-account"
            >
              このアカウントで同期する
            </button>
          </div>
        </div>
      ) : s.auth === 'signedIn' && s.user ? (
        <>
          <div className="aset-row">
            <div className="aset-row-label">
              <span>ログイン中のアカウント</span>
              <span className="aset-row-desc" data-testid="sync-account">
                {s.user.email || s.user.name}
              </span>
            </div>
            <button type="button" className="btn" onClick={() => void logout()} disabled={s.busy}>
              ログアウト
            </button>
          </div>
          <div className="aset-row">
            <div className="aset-row-label">
              <span>同期の状態</span>
              <span
                className={`aset-row-desc sync-state ${badge?.tone ?? ''}`}
                role="status"
                aria-live="polite"
                data-testid="sync-state"
              >
                {badge ? `${badge.label} — ${badge.detail}` : ''}
                {s.status?.lastSyncedAt ? `（最後に揃った時刻: ${formatRelative(s.status.lastSyncedAt)}）` : ''}
              </span>
            </div>
            <button type="button" className="btn" onClick={() => void now()} disabled={syncing || !s.leader}>
              {syncing ? '同期中…' : '今すぐ同期'}
            </button>
          </div>
          <p className="aset-note">ログアウトしても、この端末のデータは消えません。</p>
        </>
      ) : (
        <div className="aset-row">
          <div className="aset-row-label">
            <span>{s.auth === 'checking' ? 'ログインの状態を確認しています…' : 'ログインしていません'}</span>
            <span className="aset-row-desc">
              ログインすると、この端末の内容とクラウドの内容が合わさります（どちらも消えません）。
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void signIn()}
            disabled={s.busy || s.auth === 'checking'}
            data-testid="sync-signin"
          >
            {s.busy ? 'ログイン中…' : 'Google でログイン'}
          </button>
        </div>
      )}
      {s.error ? (
        <p className="aset-note aset-error" role="alert">
          {s.error}
        </p>
      ) : null}
    </section>
  )
}
