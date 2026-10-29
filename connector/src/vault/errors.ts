// コネクタの失敗（Claude に返す日本語の説明つき）。
// unpaired・identity_lost は認証の問題: MCP の呼び出しは HTTP 401 にして、claude.ai に接続し直してもらう。
// それ以外はツールの結果（isError）として、何をすればよいかを返す。

export type ConnectorErrorCode =
  | 'unpaired'
  | 'identity_lost'
  | 'anonymous_disabled'
  | 'key_missing'
  | 'read_budget'
  | 'write_budget'
  | 'firestore_quota'
  | 'writes_off'
  | 'model_mismatch'
  | 'unavailable'
  | 'warming'
  | 'permission'
  | 'invalid'

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode
  constructor(code: ConnectorErrorCode, message: string) {
    super(message)
    this.name = 'ConnectorError'
    this.code = code
  }
}

/** 接続し直してもらう失敗（HTTP 401） */
export function isAuthProblem(code: ConnectorErrorCode): boolean {
  return code === 'unpaired' || code === 'identity_lost'
}

export const MESSAGES = {
  unpaired:
    'Novel Studio 側で連携が解除されています（アプリの 設定 → Claude 連携）。claude.ai の「カスタマイズ → コネクタ」で Novel Studio に接続し直してください。',
  identityLost:
    'コネクタの身元（匿名のアカウント）が使えなくなりました。claude.ai の「カスタマイズ → コネクタ」で Novel Studio に接続し直し、アプリでもう一度許可してください。',
  anonymousDisabled:
    'Firebase の匿名ログインが無効です。Firebase コンソール → Authentication →「ログイン方法」で「匿名」を有効にしてください（docs/CONNECTOR.md の 1-A の手順 3）。',
  keyMissing:
    'コネクタの鍵（TOKEN_ENC_KEY）が設定されていません。Mac か Windows で npm run connector:setup をもう一度実行してください。',
  writesOff:
    '書き込みは停止中です。アプリの 設定 → Claude 連携 で「書き込みを許可」をオンにすると、推敲案などを追加できます（読むのは続けられます）。',
  unavailable: '一時的に Novel Studio のクラウドに接続できません。少し待ってから、もう一度試してください。',
  firestoreQuota:
    'Firebase の今日の無料枠を使い切りました（アプリの同期も止まっている可能性があります）。日本時間16時（11/1以降は17時）に回復します。',
  permission:
    'Novel Studio のクラウドに拒まれました（アクセスルールが古い可能性）。Mac か Windows で npm run deploy を実行して、アクセスルールを公開し直してください。',
} as const

export function modelMismatchMessage(cloud: number | null, mine: number): string {
  if (cloud === null)
    return 'アプリのデータの形の版がクラウドにありません。すべての端末のアプリを 2.3 以降に更新して同期してから、もう一度試してください（読むのは続けられます）。'
  if (cloud > mine)
    return `アプリが新しい版のデータを書いています（データの形 ${cloud}、コネクタは ${mine}）。npm run deploy でコネクタを更新してください（読むのは続けられます）。`
  return `アプリの版が古いままです（データの形 ${cloud}、コネクタは ${mine}）。すべての端末のアプリを更新して同期してから、もう一度試してください（読むのは続けられます）。`
}
