// 設定 → Claude 連携: Claude 用のコネクタ（リモート MCP）の URL、連携の状態（config/connector）、
// 「書き込みを許可」の切り替え・［連携を解除］、Claude ができること・できないこと。
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { notify, notifyError } from '../../store/uiStore'
import { useSync } from '../../sync/controller'
import { copyText, formatDateTime } from '../../ui/browser'
import { confirmDialog } from '../../ui/dialogs'
import { CopyIcon, LinkIcon } from '../../ui/icons'
import { CLAUDE_CAN, CLAUDE_CANNOT } from './claudeUi'
import { CONNECTOR_ORIGIN, connectorMcpUrl } from './connectLogic'
import type { ConnectorState } from './connectorDoc'
import './claude.css'

/** セットアップの手順（リポジトリの docs/CONNECTOR.md） */
export const CONNECTOR_GUIDE_URL = 'https://github.com/barraquda-baroq/app-for-novel/blob/HEAD/docs/CONNECTOR.md'

export function ClaudeSettings() {
  const id = useId()
  const s = useSync()
  const signedIn = s.auth === 'signedIn' && s.user !== null && !s.accountMismatch
  const [conn, setConn] = useState<ConnectorState>({ state: 'loading' })
  const [busy, setBusy] = useState(false)
  const url = CONNECTOR_ORIGIN ? connectorMcpUrl(CONNECTOR_ORIGIN) : ''

  // ログインしている時だけ連携の記録を見張る（Firebase はログインした時に読み込まれている）
  useEffect(() => {
    if (!signedIn) return
    let unsub: (() => void) | null = null
    let stopped = false
    setConn({ state: 'loading' })
    void import('./connectorDoc')
      .then((m) => {
        if (!stopped) unsub = m.watchConnector(setConn)
      })
      .catch(() => setConn({ state: 'error', message: '連携の状態を読めませんでした。' }))
    return () => {
      stopped = true
      unsub?.()
    }
  }, [signedIn])

  const setWrites = async (writes: boolean) => {
    setBusy(true)
    try {
      const m = await import('./connectorDoc')
      await m.setConnectorWrites(writes)
      notify(writes ? 'Claude の書き込みを許可しました' : 'Claude の書き込みを止めました（読むことはできます）')
    } catch {
      notifyError('変えられませんでした。インターネットの接続を確かめてください。')
    } finally {
      setBusy(false)
    }
  }

  const unpair = async () => {
    const ok = await confirmDialog({
      title: 'Claude との連携を解除しますか？',
      message:
        'コネクタはその場で何も読めず、書き込めなくなります。Claude で使うには、claude.ai でコネクタを接続し直して、もう一度許可してください（claude.ai 側のコネクタも削除しておくと確実です）。',
      danger: true,
      confirmLabel: '連携を解除',
    })
    if (!ok) return
    setBusy(true)
    try {
      const m = await import('./connectorDoc')
      await m.deleteConnector()
      notify('Claude との連携を解除しました')
    } catch {
      notifyError('解除できませんでした。インターネットの接続を確かめてください。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="claude" className="card aset-card" aria-labelledby={`${id}-title`} data-testid="claude-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>Claude 連携</h2>
        <p className="aset-card-lead">
          claude.ai に Novel Studio のコネクタ（リモート MCP）を足すと、Claude が「Claude
          に見せる」タイトルの採用原稿を読み、推敲案・改稿案・戦略メモ・作品批評を書き込めます。コネクタを使わない時は、戦略・作品批評の「Claude
          に頼む（手動）」でコピーと貼り付けでも使えます。
        </p>
      </div>

      <div className="aset-row">
        <div className="aset-row-label">
          <span>コネクタの URL（claude.ai に登録する）</span>
          {url ? (
            <code className="cl-url" data-testid="claude-connector-url">
              {url}
            </code>
          ) : (
            <span className="aset-row-desc" data-testid="claude-connector-unset">
              コネクタ未設定。手順（docs/CONNECTOR.md）の <code>npm run connector:setup</code> で用意すると、ここに出ます。
            </span>
          )}
        </div>
        <div className="aset-row-control">
          {url ? (
            <button
              type="button"
              className="btn"
              onClick={() => void copyText(url, 'コネクタの URL をコピーしました')}
              data-testid="claude-copy-url"
            >
              <CopyIcon />
              コピー
            </button>
          ) : null}
          <a className="btn btn-ghost" href={CONNECTOR_GUIDE_URL} target="_blank" rel="noopener noreferrer">
            <LinkIcon />
            手順を見る
          </a>
        </div>
      </div>

      <div className="aset-row" data-testid="claude-pairing">
        <div className="aset-row-label">
          <span>連携の状態</span>
          {!signedIn ? (
            <span className="aset-row-desc" data-testid="claude-pairing-signin">
              ログインすると、連携の状態を確かめて解除できます（<Link to="/settings#sync">同期</Link>）。
            </span>
          ) : conn.state === 'loading' ? (
            <span className="aset-row-desc">確かめています…</span>
          ) : conn.state === 'error' ? (
            <span className="aset-row-desc cl-error-text">{conn.message}</span>
          ) : conn.state === 'none' ? (
            <span className="aset-row-desc" data-testid="claude-pairing-none">
              連携していません。claude.ai でコネクタを接続すると、許可の画面が開きます。
            </span>
          ) : (
            <dl className="cl-pairing" data-testid="claude-pairing-info">
              <div>
                <dt>連携日時</dt>
                <dd>{conn.status.pairedAt ? formatDateTime(conn.status.pairedAt) : '—'}</dd>
              </div>
              <div>
                <dt>連携した端末</dt>
                <dd>{conn.status.approvedOn || '—'}</dd>
              </div>
              <div>
                <dt>書き込み</dt>
                <dd data-testid="claude-writes-state">{conn.status.writes ? '許可' : '停止中（読むだけ）'}</dd>
              </div>
            </dl>
          )}
        </div>
        {signedIn && conn.state === 'paired' ? (
          <div className="aset-row-control">
            <label className="switch">
              <input
                type="checkbox"
                checked={conn.status.writes}
                disabled={busy}
                onChange={(e) => void setWrites(e.target.checked)}
                data-testid="claude-writes-toggle"
              />
              <span className="track" aria-hidden="true" />
              <span>書き込みを許可</span>
            </label>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void unpair()}
              disabled={busy}
              data-testid="claude-unpair"
            >
              連携を解除
            </button>
          </div>
        ) : null}
      </div>

      <div className="cl-cando">
        <div>
          <h3 className="aset-subhead">Claude ができること</h3>
          <ul className="cl-cando-list">
            {CLAUDE_CAN.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="aset-subhead">できないこと</h3>
          <ul className="cl-cando-list is-cannot">
            {CLAUDE_CANNOT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="aset-note">
        タイトルごとに見せるかは、各タイトルの画面の「Claude に見せる」（見せない／読むだけ／読む＋書き込む）で変えられます。
      </p>
    </section>
  )
}
