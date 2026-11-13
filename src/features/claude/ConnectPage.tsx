// #/claude/connect?s=<state>: Claude 用のコネクタとの連携の画面（コネクタの「Novel Studio で確認する」から開かれる）。
// 1. ログイン（ログインしたことのないブラウザなら、いつものログイン。そのブラウザも同期する端末になる）
// 2. クラウドの持ち主のアカウントか確かめる（config/owner）
// 3. 同期が揃うのを待つ（見せるタイトルを正しく出し、連携の記録を書く前に）
// 4. ビルドの時に決めたコネクタの origin から、コネクタの匿名のアカウントを受け取る（URL の uid・origin は使わない）
// 5. 見せるタイトル・書き込みを許可するかを選んで［許可する］→ 連携の記録の接続の一覧（2.9。10まで）に接続（指紋だけ）を足し、
//    送ってからコネクタへ移る。接続の id は画面を開くごとに1つ作り、記録に失敗した後のやり直しでも同じものを使う（重ならない）。
//    コネクタがこのアプリより古い版なら許可させない（2.8 までのコネクタは、許可するとほかの接続を切ってしまう）
// 手順は connectLogic.ts（prepareConnect・approvePairing）、URL・k・指紋の決まりはコネクタと同じ src/claude/pairing.ts。
// iPhone / Android のアプリでは連携できない（コネクタは Web 版の画面からだけ受け付ける）ので、同じ印のままブラウザで開いてもらう。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { defaultConnectionName, newConnectionId } from '../../claude/pairing'
import { claudeAccessOf, CLAUDE_ACCESS_OPTIONS } from '../../claude/visibility'
import { sortedTitles } from '../../domain/entityOps'
import { TRASH_RETENTION_DAYS } from '../../domain/trash'
import type { ClaudeAccess, ID } from '../../domain/types'
import { paths } from '../../routes'
import { actions } from '../../store/actions'
import { flushNow, getPersistence, useData } from '../../store/appStore'
import { attempt } from '../../store/uiStore'
import { isNative } from '../../platform/platform'
import { DATA_MODEL } from '../../sync/appModel'
import { deviceLabel } from '../../sync/conflicts'
import { signIn, signOut, syncNow, useSync } from '../../sync/controller'
import { useDocumentTitle } from '../../ui/hooks'
import { AppHeader } from '../../ui/Layout'
import { PlugIcon } from './claudeIcons'
import { CLAUDE_ACCESS_HINTS } from './ClaudeAccessControl'
import { CLAUDE_CAN, CLAUDE_CANNOT } from './claudeUi'
import {
  approvePairing,
  CONNECTOR_ORIGIN,
  fetchIdentity,
  prepareConnect,
  randomPairingKey,
  validState,
  type ConnectorIdentity,
  type ConnectorStatus,
} from './connectLogic'
import { leaveTo } from './leave'
import './claude.css'

/** 公開している Web 版（Firebase Hosting）。アプリで連携の画面が開いた時に、ブラウザで開き直す先 */
export const WEB_APP_ORIGIN = 'https://novel-studio-3352e.web.app'

/** ブラウザで開き直す連携の画面の URL（同じ ?s=） */
export function webConnectUrl(state: string): string {
  return `${WEB_APP_ORIGIN}/#${paths.claudeConnect()}?s=${encodeURIComponent(state)}`
}

type Step =
  | { step: 'checking' }
  | { step: 'notOwner' }
  | { step: 'noOwner' }
  | { step: 'ownerError' }
  | { step: 'sync' }
  | { step: 'syncTimeout' }
  | { step: 'identity' }
  | { step: 'identityError'; error: string }
  | { step: 'connectorOld'; identity: ConnectorIdentity }
  | { step: 'ready'; identity: ConnectorIdentity; ownerUid: string; existing: ConnectorStatus | null; existingError: boolean }
  | { step: 'saving' }
  | {
      step: 'saveError'
      error: string
      identity: ConnectorIdentity
      ownerUid: string
      existing: ConnectorStatus | null
      existingError: boolean
    }
  | { step: 'done' }
  | { step: 'cancelled' }

/** 同期が「同期済み」になるまで待つ（なれば true） */
function waitForSynced(ms: number): Promise<boolean> {
  if (useSync.getState().status?.phase === 'synced') return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(false)
    }, ms)
    const unsub = useSync.subscribe((s) => {
      if (s.status?.phase === 'synced') {
        clearTimeout(timer)
        unsub()
        resolve(true)
      }
    })
  })
}

/** 送信待ちが無くなったか見直す間隔 */
const OUTBOX_POLL_MS = 250

/**
 * 送信待ちを送り、すべてサーバーに受け取られたら true（limitMs まで。届かない・送るのを止めている・時間切れは false）。
 * 確かめるのは端末内の送信待ち（IndexedDB。どの画面（タブ）でも同じ）で、送ったものはサーバーが受け取ってから外れる。
 * 同期を受け持つのがほかの画面でも、その画面が送り終えるのを待てる（知らせの古い状態で済ませない）
 */
async function flushAll(limitMs: number): Promise<boolean> {
  const until = Date.now() + limitMs
  const left = () => Math.max(0, until - Date.now())
  // 先にこの画面の編集を端末内に保存する（保存できなければ送れない）
  if (!(await flushNow())) return false
  const persistence = getPersistence()
  if (!persistence) return false
  // 新しい版のアプリで書かれたデータがある間は送らない（送信待ちは残る）
  const held = () => !!useSync.getState().status?.outdated
  const empty = async () => (await persistence.outboxCount().catch(() => -1)) === 0
  if (held()) return false
  // 同期を受け持つ画面なら、いますぐ送る（ほかの画面なら、端末内に保存したことがその画面に伝わって送られる）
  await Promise.race([syncNow().catch(() => undefined), new Promise((r) => setTimeout(r, left()))])
  for (;;) {
    if (held()) return false
    if (await empty()) return true
    if (left() === 0) return false
    await new Promise((r) => setTimeout(r, Math.min(OUTBOX_POLL_MS, left())))
  }
}

export function ConnectPage() {
  useDocumentTitle('Claude との連携')
  const [params] = useSearchParams()
  const state = validState(params.get('s'))
  const sync = useSync()
  const uid = sync.auth === 'signedIn' ? (sync.user?.uid ?? null) : null
  const mismatch = sync.accountMismatch !== null
  const [step, setStep] = useState<Step>({ step: 'checking' })
  const [attemptNo, setAttemptNo] = useState(0)
  // 選んだ内容は記録に失敗した後も残す（連携の記録の間はフォームを外すので、フォームの中には持たない）。
  // 接続の id は画面を開くごとに1つ（claude.ai で接続し直すと、新しい画面になり新しい id）
  const [draft, setDraft] = useState<ApproveDraft>(() => ({
    writes: null,
    access: {},
    cid: newConnectionId(),
    name: null,
    mode: 'add',
    replaceCid: null,
  }))
  const host = CONNECTOR_ORIGIN ? new URL(CONNECTOR_ORIGIN).host : ''
  const [native] = useState(isNative)

  useEffect(() => {
    if (native || !CONNECTOR_ORIGIN || !state || !uid || mismatch) return
    let cancelled = false
    const set = (s: Step) => {
      if (!cancelled) setStep(s)
    }
    void (async () => {
      set({ step: 'checking' })
      const doc = await import('./connectorDoc')
      if (cancelled) return
      const r = await prepareConnect(
        {
          origin: CONNECTOR_ORIGIN,
          readOwnerUid: () => doc.readOwnerUid(),
          waitSynced: (ms) => waitForSynced(ms),
          fetchIdentity: (origin) => fetchIdentity(origin),
          readConnector: () => doc.readConnectorDoc(),
          dataModel: DATA_MODEL,
          cancelled: () => cancelled,
          onStep: (s) => set({ step: s }),
        },
        uid,
      )
      if (r.step !== 'cancelled') set(r)
    })()
    return () => {
      cancelled = true
    }
  }, [native, state, uid, mismatch, attemptNo])

  const retry = () => setAttemptNo((n) => n + 1)

  const body = (() => {
    if (native)
      return (
        <Notice tone="info" testId="connect-native">
          <p>連携の許可は、ブラウザで開く画面（Web 版の Novel Studio）で行います。このアプリの中では許可できません。</p>
          {state ? (
            <a
              className="btn btn-primary"
              href={webConnectUrl(state)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="connect-open-browser"
            >
              ブラウザで開く
            </a>
          ) : (
            <p>claude.ai のコネクタの画面（「Novel Studio で確認する」）からやり直してください。</p>
          )}
        </Notice>
      )
    if (!CONNECTOR_ORIGIN)
      return (
        <Notice tone="warn" testId="connect-unconfigured">
          <p>
            <strong>コネクタ未設定</strong>
          </p>
          <p>
            このアプリにはコネクタの場所が設定されていないため、連携できません。docs/CONNECTOR.md の手順で
            <code>npm run connector:setup</code> を実行して、アプリを公開し直してください。
          </p>
        </Notice>
      )
    if (!state)
      return (
        <Notice tone="warn" testId="connect-no-state">
          <p>連携の印がありません。claude.ai のコネクタの画面（「Novel Studio で確認する」）からやり直してください。</p>
        </Notice>
      )
    if (sync.auth !== 'signedIn' || !sync.user)
      return (
        <div className="cn-block" data-testid="connect-signin">
          <p>
            Novel Studio の持ち主の Google
            アカウントでログインしてください。このブラウザでログインすると、ほかの端末と同じように同期する端末になります（あとで
            設定 → 同期 からログアウトできます）。
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void signIn()}
            disabled={sync.busy || sync.auth === 'checking'}
            data-testid="connect-signin-button"
          >
            {sync.busy || sync.auth === 'checking' ? 'ログインの状態を確認しています…' : 'Google でログイン'}
          </button>
          {sync.error ? (
            <p className="cl-error" role="alert">
              {sync.error}
            </p>
          ) : null}
        </div>
      )
    if (mismatch)
      return (
        <Notice tone="warn" testId="connect-mismatch">
          <p>
            このブラウザは以前、別のアカウントと同期していました。先に <Link to={paths.appSettings()}>設定 → 同期</Link>{' '}
            で確かめてください。
          </p>
        </Notice>
      )
    switch (step.step) {
      case 'checking':
        return <Progress text="持ち主のアカウントか確かめています…" />
      case 'notOwner':
        return (
          <Notice tone="danger" testId="connect-not-owner">
            <p>
              <strong>このアカウントは Novel Studio の持ち主ではありません</strong>（{sync.user.email || sync.user.name}）。
            </p>
            <p>持ち主のアカウントでログインし直してください。</p>
            <button type="button" className="btn" onClick={() => void signOut()}>
              ログアウト
            </button>
          </Notice>
        )
      case 'noOwner':
        return (
          <Notice tone="warn" testId="connect-no-owner">
            <p>クラウドの持ち主がまだ記録されていません。設定 → 同期 で同期が終わってから、もう一度お試しください。</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'ownerError':
        return (
          <Notice tone="warn" testId="connect-owner-error">
            <p>持ち主を確かめられませんでした。インターネットの接続を確かめてください。</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'sync':
        return <Progress text="同期が揃うのを待っています…（初めての端末では少しかかります）" testId="connect-sync-wait" />
      case 'syncTimeout':
        return (
          <Notice tone="warn" testId="connect-sync-timeout">
            <p>同期が終わりませんでした。インターネットの接続を確かめて、もう一度お試しください。</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'identity':
        return <Progress text="コネクタに問い合わせています…" />
      case 'identityError':
        return (
          <Notice tone="warn" testId="connect-identity-error">
            <p>{step.error}</p>
            <RetryButton onClick={retry} />
          </Notice>
        )
      case 'connectorOld':
        return (
          <Notice tone="warn" testId="connect-connector-old">
            <p>
              コネクタがまだこのアプリの版になっていません（いまのコネクタは {step.identity.version || '不明'}・データの形{' '}
              {step.identity.model ?? '不明'}
              ）。このまま許可すると、ほかの接続が切れてしまうため許可できません。コネクタを更新してから（npm run
              deploy。docs/DEPLOY.md）、claude.ai でもう一度「接続」を押してください。
            </p>
          </Notice>
        )
      case 'ready':
      case 'saveError':
        return (
          <ApproveForm
            identity={step.identity}
            ownerUid={step.ownerUid}
            existing={step.existing}
            existingError={step.existingError}
            state={state}
            error={step.step === 'saveError' ? step.error : null}
            draft={draft}
            onDraftChange={setDraft}
            onSaving={() => setStep({ step: 'saving' })}
            onDone={() => setStep({ step: 'done' })}
            onError={(error) =>
              setStep({
                step: 'saveError',
                error,
                identity: step.identity,
                ownerUid: step.ownerUid,
                existing: step.existing,
                existingError: step.existingError,
              })
            }
            onCancel={() => setStep({ step: 'cancelled' })}
          />
        )
      case 'saving':
        return <Progress text="連携を記録しています…" testId="connect-saving" />
      case 'done':
        return <Progress text="連携しました。claude.ai に戻ります…" testId="connect-done" />
      case 'cancelled':
        return (
          <Notice tone="info" testId="connect-cancelled">
            <p>連携をやめました。この画面は閉じてかまいません（claude.ai のコネクタは接続されません）。</p>
            <Link to={paths.home()} className="btn">
              ホームへ
            </Link>
          </Notice>
        )
    }
  })()

  return (
    <>
      <AppHeader crumbs={[{ label: 'Claude との連携' }]} />
      <main className="page page-narrow cn-page" data-testid="connect-page">
        <h1 className="cn-title">
          <PlugIcon />
          Claude（claude.ai）との連携
        </h1>
        {host ? (
          <p className="cn-host" data-testid="connect-host">
            コネクタ: <code>{host}</code>
          </p>
        ) : null}
        {body}
      </main>
    </>
  )
}

function Progress({ text, testId }: { text: string; testId?: string }) {
  return (
    <p className="cn-progress" role="status" data-testid={testId ?? 'connect-progress'}>
      <span className="cn-spinner" aria-hidden="true" />
      {text}
    </p>
  )
}

function Notice({ tone, testId, children }: { tone: 'warn' | 'danger' | 'info'; testId: string; children: React.ReactNode }) {
  return (
    <div className={`cn-notice is-${tone}`} role={tone === 'info' ? 'status' : 'alert'} data-testid={testId}>
      {children}
    </div>
  )
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn" onClick={onClick} data-testid="connect-retry">
      もう一度
    </button>
  )
}

/** 連携の画面で選んでいる内容（タイトルは変えたものだけ。変えていなければいまの設定を出す） */
interface ApproveDraft {
  /** 「書き込みを許可」（null = いまの設定。記録が無ければ許可） */
  writes: boolean | null
  access: Record<ID, ClaudeAccess>
  /** 足す接続の id（画面を開くごとに1つ。やり直しでも同じ） */
  cid: string
  /** 接続の名前（null = 既定の名前） */
  name: string | null
  /** 新しい接続として足す・前の接続と入れ替える */
  mode: 'add' | 'replace'
  replaceCid: string | null
}

interface ApproveFormProps {
  identity: ConnectorIdentity
  ownerUid: string
  /** いまの連携の記録（無ければ null） */
  existing: ConnectorStatus | null
  existingError: boolean
  state: string
  error: string | null
  draft: ApproveDraft
  onDraftChange: (draft: ApproveDraft) => void
  onSaving: () => void
  onDone: () => void
  onError: (error: string) => void
  onCancel: () => void
}

function ApproveForm({
  identity,
  ownerUid,
  existing,
  state,
  error,
  draft,
  onDraftChange,
  onSaving,
  onDone,
  onError,
  onCancel,
}: ApproveFormProps) {
  const data = useData()
  const titles = useMemo(() => sortedTitles(data), [data])
  // コネクタが用意し直された時（記録の uid が違う）は、前の接続は使えないので、新しく始める
  const current = existing && existing.uid === identity.uid ? existing : null
  const connections = current?.connections ?? []
  const writes = draft.writes ?? current?.writes ?? true
  const name = draft.name ?? defaultConnectionName(connections.map((c) => c.name))
  // 新しい版のアプリで書かれたデータがある間は、タイトルの設定を送れない
  const outdated = useSync((s) => !!s.status?.outdated)
  const busy = useRef(false)
  const valueOf = (id: ID): ClaudeAccess => draft.access[id] ?? claudeAccessOf(data.titles[id])
  const shown = titles.filter((t) => valueOf(t.id) !== 'none').length

  const approve = async () => {
    if (busy.current) return
    busy.current = true
    onSaving()
    try {
      const doc = await import('./connectorDoc')
      const changes = titles
        .filter((t) => data.titles[t.id] && valueOf(t.id) !== claudeAccessOf(data.titles[t.id]))
        .map((t) => ({ titleId: t.id, access: valueOf(t.id) }))
      const r = await approvePairing(
        {
          origin: CONNECTOR_ORIGIN,
          addConnection: (a) => doc.addConnection(a),
          deleteConnector: () => doc.deleteConnector(),
          setAccess: (titleId, a) => {
            attempt(() => actions.setTitleClaudeAccess(titleId, a))
          },
          flush: (limitMs) => flushAll(limitMs),
          navigate: (url) => leaveTo(url),
          randomKey: () => randomPairingKey(),
          deviceLabel: () => deviceLabel(),
        },
        {
          state,
          identity,
          ownerUid,
          writes,
          access: changes,
          cid: draft.cid,
          name,
          replaceCid: draft.mode === 'replace' ? draft.replaceCid : null,
        },
      )
      if (r.ok) onDone()
      else onError(r.error)
    } finally {
      busy.current = false
    }
  }

  return (
    <div className="cn-form" data-testid="connect-form">
      <p>
        Claude（claude.ai）が Novel Studio への接続を求めています。Claude に見せるタイトルを選んで［許可する］を押すと、claude.ai
        に戻って接続が終わります。
      </p>
      {identity.model !== null && identity.model !== DATA_MODEL ? (
        <p className="cn-notice is-warn" role="note" data-testid="connect-model-warning">
          コネクタのデータの形の版（{identity.model}）がこのアプリ（{DATA_MODEL}
          ）と違うため、コネクタは推敲案などを書き込めません（読むことはできます）。アプリかコネクタを更新してください。
        </p>
      ) : null}

      <div className="cn-columns">
        <section className="cn-box" aria-labelledby="cn-can">
          <h2 id="cn-can">Claude ができること</h2>
          <ul>
            {CLAUDE_CAN.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
        <section className="cn-box" aria-labelledby="cn-cannot">
          <h2 id="cn-cannot">できないこと</h2>
          <ul>
            {CLAUDE_CANNOT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="cn-titles" aria-labelledby="cn-titles-heading">
        <h2 id="cn-titles-heading">
          Claude に見せるタイトル<span className="sx-count">{shown}</span>
        </h2>
        {titles.length === 0 ? (
          <p className="small muted">タイトルがまだありません（後で作ったタイトルも、各タイトルの画面で設定できます）。</p>
        ) : (
          <ul className="cn-title-list" data-testid="connect-titles">
            {titles.map((t) => (
              <li key={t.id} className="cn-title-row" data-testid="connect-title" data-title-id={t.id}>
                <span className="cn-title-name">{t.name.trim() || '無題のタイトル'}</span>
                <div
                  className="segmented cn-seg"
                  role="group"
                  aria-label={`「${t.name.trim() || '無題のタイトル'}」を Claude に見せる`}
                >
                  {CLAUDE_ACCESS_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={valueOf(t.id) === o.value}
                      title={CLAUDE_ACCESS_HINTS[o.value]}
                      onClick={() => onDraftChange({ ...draft, access: { ...draft.access, [t.id]: o.value } })}
                      data-testid={`connect-access-${o.value}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="tiny faint">後から各タイトルの画面の「Claude に見せる」で変えられます。</p>
      </section>

      <label className="check cn-writes">
        <input
          type="checkbox"
          checked={writes}
          onChange={(e) => onDraftChange({ ...draft, writes: e.target.checked })}
          data-testid="connect-writes"
        />
        <span>
          推敲案などの書き込みも許可
          <span className="tiny faint cn-writes-hint">
            （Claude が推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果・相対比較の分析・資料の記録・アイデアを足せ、Claude
            が足したアイデアに追記できます。頼んだ時だけ、Claude が足した相対比較の分析・資料の記録・アイデアをゴミ箱へ移せます（
            {TRASH_RETENTION_DAYS}日は戻せます）。本文は書き換えません。後から 設定 → Claude 連携 で止められます）
          </span>
        </span>
      </label>

      <p className="cn-warn" data-testid="connect-phishing-note">
        claude.ai で「接続」を押した直後でなければ、心当たりのない依頼です。［やめる］を押してください。
      </p>
      {outdated ? (
        <p className="cn-notice is-warn" role="alert" data-testid="connect-outdated">
          クラウドのデータがこのアプリより新しい版のアプリで書かれているため、タイトルの設定を送れません。アプリを更新してから、もう一度お試しください。
        </p>
      ) : null}
      {error ? (
        <p className="cl-error" role="alert" data-testid="connect-error">
          {error}
        </p>
      ) : null}
      <div className="cn-actions">
        <button type="button" className="btn" onClick={onCancel} data-testid="connect-cancel">
          やめる
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void approve()}
          disabled={outdated}
          data-testid="connect-approve"
        >
          許可する
        </button>
      </div>
    </div>
  )
}
