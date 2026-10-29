// 連携の決まり（src/claude/pairing.ts）を確かめる値。アプリのテスト（src/claude/pairing.test.ts・connectLogic.test.ts）と
// コネクタのテスト（connector/test/unit・worker・emu）が同じ値を使い、同じ答えになることを確かめる。
// 指紋は実装とは別に Node の crypto で計算した値（sha256hex(state + '.' + k)）。

export const PAIRING_FIXTURE = {
  appOrigin: 'https://novel-studio-3352e.web.app',
  connectorOrigin: 'https://novel-studio-connector.example.workers.dev',
  /** コネクタ（OAuth のライブラリの beginUpstream）が渡す連携の印の例 */
  state: 'c3RhdGUtZnJvbS1iZWdpblVwc3RyZWFtLTAxMjM',
  /** アプリが作る k の例（32バイトの base64url = 43 字） */
  k: 'a2V5LWZyb20tdGhlLWFwcC1jb25uZWN0LXBhZ2UtMDE',
  hash: '2e9aca21c06e393ca5836da5f3ce34e48e5e063618e52f16bd6ab6fce94124e0',
  connectUrl: 'https://novel-studio-3352e.web.app/#/claude/connect?s=c3RhdGUtZnJvbS1iZWdpblVwc3RyZWFtLTAxMjM',
  callbackUrl:
    'https://novel-studio-connector.example.workers.dev/pair/callback?state=c3RhdGUtZnJvbS1iZWdpblVwc3RyZWFtLTAxMjM&k=a2V5LWZyb20tdGhlLWFwcC1jb25uZWN0LXBhZ2UtMDE',
  /** URL に書くと形が変わる文字を含む印（行き来しても同じ値・同じ指紋になること） */
  oddState: 'a+b/c=d&e?f#g%h~状態',
  oddHash: 'f678cb49dd9303c8cf7d805260f7f421cdf3e04737be3a3acc44dc7d51c0d60a',
  /** /connect/identity の答えの例 */
  identity: { uid: 'anonConnectorUid0123456789ab', version: '2.3.0', model: 3 },
} as const
