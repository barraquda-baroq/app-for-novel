// 設定 → Claude 連携: Claude 用のコネクタ（リモート MCP）の URL、連携の状態（config/connector）、
// 2.9: 接続の一覧（claude.ai のアカウントごと。10まで。名前・許可した日時・許可した端末・［名前を変える］・［この接続を解除］）、
// すべての接続に効く「書き込みを許可」・［連携をすべて解除］、Claude ができること・できないこと。
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { isNative } from '../../platform/platform'
import { notify, notifyError } from '../../store/uiStore'
import { useSync } from '../../sync/controller'
import { copyText } from '../../ui/browser'
import { CopyIcon, LinkIcon } from '../../ui/icons'
import type { ConnectionInfo } from '../../claude/pairing'
import { CLAUDE_CAN, CLAUDE_CANNOT } from './claudeUi'
import { CONNECTOR_ORIGIN, connectorMcpUrl } from './connectLogic'
import type { ConnectorState } from './connectorDoc'
import {
  connectionCountLabel,
  ConnectionList,
  removeAllConnections,
  removeOneConnection,
  renameOneConnection,
} from './ConnectionList'
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
  const [native] = useState(isNative)

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

  /** 確かめのダイアログと書き込みの間はボタンを止める（知らせは ConnectionList.tsx の各操作が出す） */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const connections: readonly ConnectionInfo[] = conn.state === 'paired' ? conn.status.connections : []
  const unpairAll = () => run(() => removeAllConnections(connections.length))
  const removeOne = (c: ConnectionInfo) => run(() => removeOneConnection(c, connections))
  const rename = (c: ConnectionInfo) => run(() => renameOneConnection(c, connections))

  return (
    <section id="claude" className="card aset-card" aria-labelledby={`${id}-title`} data-testid="claude-settings">
      <div className="aset-card-head">
        <h2 id={`${id}-title`}>Claude 連携</h2>
        <p className="aset-card-lead">
          claude.ai に Novel Studio のコネクタ（リモート MCP）を足すと、Claude が「Claude
          に見せる」タイトルの採用原稿を読み、推敲案・改稿案・戦略メモ・作品批評を書き込めます。コネクタを使わない時は、戦略・作品批評の「Claude
          に頼む（手動）」でコピーと貼り付けでも使えます。
        </p>
        {native ? (
          <p className="aset-card-lead" data-testid="claude-native-note">
            連携の許可は、claude.ai
            でコネクタを接続した時にブラウザで開く画面で行います。このアプリでは、連携の状態の確認・書き込みの切り替え・解除ができます。
          </p>
        ) : null}
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
            <div className="cl-pairing" data-testid="claude-pairing-info">
              <p className="cl-conn-count" data-testid="claude-connection-count">
                {connectionCountLabel(connections.length)}
                <span className="cl-conn-count-note">（claude.ai のアカウントごと。同時に10まで）</span>
              </p>
              <ConnectionList
                connections={connections}
                testIdPrefix="claude"
                busy={busy}
                onRename={(c) => void rename(c)}
                onRemove={(c) => void removeOne(c)}
              />
              <div className="cl-writes-row">
                <span className="cl-writes-label">
                  書き込み: <span data-testid="claude-writes-state">{conn.status.writes ? '許可' : '停止中（読むだけ）'}</span>
                </span>
                <span className="cl-writes-control">
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
                  <span className="cl-writes-note">（すべての接続に効きます）</span>
                </span>
              </div>
              <div className="cl-unpair-row">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void unpairAll()}
                  disabled={busy}
                  data-testid="claude-unpair"
                >
                  連携をすべて解除
                </button>
              </div>
              <p className="aset-row-desc cl-conn-hint" data-testid="claude-connection-hint">
                どの名前が claude.ai のどのアカウントかは、アプリからは分かりません。そのアカウントの Claude に「Novel Studio
                の状態（novel_status）を見て」と頼むと、最後の行に「この接続: 接続2」と出ます。
              </p>
            </div>
          )}
        </div>
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
