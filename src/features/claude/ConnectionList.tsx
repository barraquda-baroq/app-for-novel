// 2.9: Claude との接続（claude.ai で接続するごとに1つ。10まで）の一覧。設定 → Claude 連携 と、連携の画面（#/claude/connect）で使う。
// 行ごとに名前・許可した日時・許可した端末と、［名前を変える］（設定だけ）・［この接続を解除］。
// 解除・名前の変更・すべて解除の確かめと知らせもここにまとめる（どちらの画面でも同じ文）。
import { connectionNameKey, CONNECTION_NAME_MAX, MAX_CONNECTIONS, type ConnectionInfo } from '../../claude/pairing'
import { notify, notifyError } from '../../store/uiStore'
import { formatDateTime } from '../../ui/browser'
import { confirmDialog, promptDialog } from '../../ui/dialogs'
import { cleanNewConnectionName, ConnectionGoneError, CONNECTION_NAME_ERROR } from './connectLogic'

interface ConnectionListProps {
  connections: readonly ConnectionInfo[]
  /** data-testid の頭（設定は claude、連携の画面は connect） */
  testIdPrefix: 'claude' | 'connect'
  busy?: boolean
  /** ［名前を変える］（渡さなければ出さない） */
  onRename?: (c: ConnectionInfo) => void
  onRemove: (c: ConnectionInfo) => void
}

/** 行の data-testid（連携の画面の connect-connection は「この接続」の欄そのもの） */
const ROW_TEST_ID = { claude: 'claude-connection', connect: 'connect-connection-row' } as const

export function ConnectionList({ connections, testIdPrefix: p, busy, onRename, onRemove }: ConnectionListProps) {
  return (
    <ul className="cl-conn-list" data-testid={`${p}-connections`}>
      {connections.map((c) => (
        <li key={c.cid} className="cl-conn" data-testid={ROW_TEST_ID[p]} data-cid={c.cid}>
          <div className="cl-conn-main">
            <strong className="cl-conn-name" data-testid={`${p}-connection-name`}>
              {c.name}
            </strong>
            <span className="cl-conn-meta">
              <span>
                許可した日時 <span className="cl-conn-value">{c.pairedAt ? formatDateTime(c.pairedAt) : '—'}</span>
              </span>
              <span aria-hidden="true"> ・ </span>
              <span>
                許可した端末 <span className="cl-conn-value">{c.approvedOn || '—'}</span>
              </span>
            </span>
          </div>
          <div className="cl-conn-actions">
            {onRename ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onRename(c)}
                disabled={busy}
                aria-label={`「${c.name}」の名前を変える`}
                data-testid={`${p}-connection-rename`}
              >
                名前を変える
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => onRemove(c)}
              disabled={busy}
              aria-label={`「${c.name}」の接続を解除`}
              data-testid={`${p}-connection-remove`}
            >
              この接続を解除
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** 接続の数（「接続 3 / 10」） */
export const connectionCountLabel = (n: number) => `接続 ${n} / ${MAX_CONNECTIONS}`

/** 名前の確かめ（空は呼ばない）。同じ名前（字の幅・空白の違いは同じ）の接続があれば断る */
export function connectionNameProblem(
  name: string,
  connections: readonly ConnectionInfo[],
  exceptCid: string | null = null,
): string | null {
  if (!name.trim()) return '名前を入れてください'
  if (cleanNewConnectionName(name) === null) return CONNECTION_NAME_ERROR
  const key = connectionNameKey(name)
  return connections.some((c) => c.cid !== exceptCid && connectionNameKey(c.name) === key) ? '同じ名前の接続があります' : null
}

const ALL_MESSAGE = (n: number) =>
  `すべての接続（${n}件）が、その場で何も読めず、書き込めなくなります。Claude で使うには、claude.ai でコネクタを接続し直して、もう一度許可してください（claude.ai 側のコネクタも削除しておくと確実です）。`

type ConnectorDocModule = typeof import('./connectorDoc')
const loadDoc = (): Promise<ConnectorDocModule> => import('./connectorDoc')

/** ［連携をすべて解除］: 確かめてから記録を消す（すべての接続が、その場で読めず書き込めなくなる）。消したら true */
export async function removeAllConnections(n: number): Promise<boolean> {
  const ok = await confirmDialog({
    title: 'Claude との連携をすべて解除しますか？',
    message: ALL_MESSAGE(n),
    danger: true,
    confirmLabel: '連携をすべて解除',
  })
  if (!ok) return false
  try {
    const m = await loadDoc()
    await m.deleteConnector()
    notify('Claude との連携をすべて解除しました')
    return true
  } catch {
    notifyError('解除できませんでした。インターネットの接続を確かめてください。')
    return false
  }
}

/**
 * ［この接続を解除］: 確かめてから一覧から外す（その接続の Claude は、次に使った時から使えない。ほかの接続はそのまま）。
 * 見ている一覧が1つなら、すべて解除と同じ確かめをする。外すのはいつもトランザクション（removeConnection）で、記録を消すのは
 * サーバーの一覧でも最後の1つの時だけ（見ている一覧が古く、ほかの端末で足された接続があれば、その接続は残る）。
 * 知らせはトランザクションの結果に合わせる。トランザクションを書いたら（もう無かった時も）true（呼ぶ側は一覧を読み直す）
 */
export async function removeOneConnection(c: ConnectionInfo, connections: readonly ConnectionInfo[]): Promise<boolean> {
  const last = connections.length <= 1
  const ok = await confirmDialog(
    last
      ? {
          title: '最後の接続です。連携をすべて解除しますか？',
          message: ALL_MESSAGE(1),
          danger: true,
          confirmLabel: '連携をすべて解除',
        }
      : {
          title: `「${c.name}」の接続を解除しますか？`,
          message:
            'この接続の Claude は、次に使った時から（遅くとも1分ほどで）読めず、書き込めなくなります。ほかの接続はそのまま使えます。その claude.ai のアカウントでまた使う時は、claude.ai でコネクタを接続し直してください（新しい接続として足されます）。',
          danger: true,
          confirmLabel: 'この接続を解除',
        },
  )
  if (!ok) return false
  try {
    const m = await loadDoc()
    const r = await m.removeConnection(c.cid)
    notify(
      r === 'deleted'
        ? 'Claude との連携をすべて解除しました'
        : r === 'none'
          ? 'その接続はもうありません（ほかの端末で解除されました）。'
          : last
            ? `「${c.name}」の接続を解除しました（ほかの端末で足された接続は、そのまま使えます）`
            : `「${c.name}」の接続を解除しました`,
    )
    return true
  } catch {
    notifyError('解除できませんでした。インターネットの接続を確かめてください。')
    return false
  }
}

/** ［名前を変える］: 名前を聞いて変える（同じ名前の接続は断る）。変えたら true */
export async function renameOneConnection(c: ConnectionInfo, connections: readonly ConnectionInfo[]): Promise<boolean> {
  const name = await promptDialog({
    title: '接続の名前を変える',
    label: `名前（${CONNECTION_NAME_MAX}字まで。どの claude.ai のアカウントか分かる名前に）`,
    initial: c.name,
    maxLength: CONNECTION_NAME_MAX,
    selectOnOpen: true,
    confirmLabel: '変更',
    validate: (v) => connectionNameProblem(v, connections, c.cid),
  })
  const clean = name === null ? null : cleanNewConnectionName(name)
  if (clean === null || clean === c.name) return false
  try {
    const m = await loadDoc()
    await m.renameConnection(c.cid, clean)
    notify(`接続の名前を「${clean}」にしました`)
    return true
  } catch (e) {
    notifyError(
      e instanceof ConnectionGoneError
        ? 'その接続はもうありません（ほかの端末で解除されました）。'
        : '名前を変えられませんでした。インターネットの接続を確かめてください。',
    )
    return false
  }
}
