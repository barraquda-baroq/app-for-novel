#!/usr/bin/env node
// Claude 用コネクタの準備（初めての時に1回）: リポジトリの直下で npm run connector:setup
// Windows（PowerShell）でも Mac（ターミナル）でも同じ。手で行う手順（Cloudflare の登録・Firebase の匿名ログイン・claude.ai への登録）は
// docs/CONNECTOR.md。このスクリプトがすること:
//   1. Cloudflare にログインしているか確かめる（していなければブラウザでログイン）
//   2. コネクタを公開する（KV と Durable Object は自動で作られる）→ URL を控える
//   3. URL を ../connector.local.json に書き、URL を渡して公開し直す
//   4. 鍵（TOKEN_ENC_KEY）を作り、画面に出さずに wrangler secret put に渡す（もうあれば、そのまま使う）
//   5. コネクタを確かめる（匿名ログインが無効なら、直し方を出して止まる）
//   6. アプリとアクセスルールを公開する（npm run deploy と同じ。コネクタの URL がアプリに入る）
//   7. claude.ai に登録する URL を出す
// オプション: --yes（聞かずに進める）、--skip-app（6 をしない）、--rotate-key（鍵を作り直す。Claude との連携はやり直しになる）
import { checkConnector, printResults } from './check.mjs'
import { deployConnector } from './deploy.mjs'
import {
  MISSING_CONNECTOR_DEPS,
  ask,
  dcrEnabledInConfig,
  newTokenKey,
  ng,
  nodeVersionOk,
  ok,
  readLocalConfig,
  repoDir,
  runNode,
  say,
  wrangler,
  wranglerBin,
  writeLocalConfig,
} from './lib.mjs'
import path from 'node:path'

const flags = new Set(process.argv.slice(2))
const yes = flags.has('--yes')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  say('Novel Studio の Claude 用コネクタを準備します。')
  say('')
  say('先に手で済ませておくこと（docs/CONNECTOR.md の 1-A の手順 1〜4）:')
  say('  ・Cloudflare に登録し、2段階認証と workers.dev のサブドメインを設定する')
  say('  ・Firebase コンソールで「匿名」のログインを有効にする')
  say('  ・npm ci と npm --prefix connector ci を実行しておく')
  say('')
  say('このあと自動で行うこと: Cloudflare へのログインの確認 → コネクタの公開 → 鍵の作成（画面には出ません）→ 確認 → アプリとアクセスルールの公開')
  if (!yes && !(await ask('続けますか？'))) {
    say('中止しました（何も変えていません）。')
    return
  }

  if (!nodeVersionOk()) {
    ng(`Node.js が古すぎます（いま ${process.versions.node}）。22 以上を入れてください（https://nodejs.org/ja）。`)
    process.exitCode = 1
    return
  }
  if (!wranglerBin()) {
    ng(MISSING_CONNECTOR_DEPS)
    process.exitCode = 1
    return
  }

  // 1. Cloudflare へのログイン
  say('\n[1/7] Cloudflare にログインしているか確かめます')
  const who = await wrangler(['whoami'], { capture: true, quiet: true })
  if (who.code !== 0 || /not authenticated|You are not logged in/i.test(`${who.stdout}${who.stderr}`)) {
    say('  ログインしていません。ブラウザが開いたら Cloudflare にログインして「Allow」を押してください。')
    const login = await wrangler(['login'])
    if (login.code !== 0) {
      ng('ログインできませんでした。もう一度実行してください。')
      process.exitCode = 1
      return
    }
  }
  ok('Cloudflare にログインしています')

  // 2. 公開して URL を控える
  say('\n[2/7] コネクタを公開します（初めての時は KV と Durable Object も作られます）')
  const before = readLocalConfig()
  const first = await deployConnector({ origin: before?.origin ?? null })
  if (!first.ok || !first.url) {
    ng('公開できなかったか、URL が分かりませんでした。')
    if (/subdomain|workers\.dev/i.test(first.output ?? ''))
      say('  → Cloudflare のダッシュボードの「Workers & Pages」で、workers.dev のサブドメインを決めてから、もう一度実行してください。')
    process.exitCode = 1
    return
  }
  const origin = first.url
  ok(`公開しました: ${origin}`)

  // 3. URL を控えて、URL を渡して公開し直す
  say('\n[3/7] URL を connector.local.json に書き、URL を渡して公開し直します')
  writeLocalConfig(origin)
  ok(`${path.relative(repoDir, path.join(repoDir, 'connector.local.json'))} に書きました（Git には入りません）`)
  if (before?.origin !== origin) {
    const second = await deployConnector({ origin })
    if (!second.ok) {
      ng('公開し直せませんでした。もう一度実行してください。')
      process.exitCode = 1
      return
    }
  }
  ok('URL を渡して公開しました')

  // 4. 鍵
  say('\n[4/7] 鍵（TOKEN_ENC_KEY）を用意します（画面には出しません）')
  const list = await wrangler(['secret', 'list', '--format', 'json'], { capture: true, quiet: true })
  const hasKey = list.code === 0 && /"name"\s*:\s*"TOKEN_ENC_KEY"/.test(list.stdout)
  if (hasKey && !flags.has('--rotate-key')) ok('鍵はもう設定されています（そのまま使います）')
  else {
    if (hasKey) say('  鍵を作り直します（Claude との連携は、claude.ai でコネクタに接続し直すまで止まります）。')
    const put = await wrangler(['secret', 'put', 'TOKEN_ENC_KEY'], { input: newTokenKey(), capture: true, quiet: true })
    if (put.code !== 0) {
      ng('鍵を保存できませんでした。もう一度実行してください。')
      process.exitCode = 1
      return
    }
    ok('鍵を作って Cloudflare に保存しました')
  }

  // 5. 確かめる（公開が行き渡るまで少し待つ）
  say('\n[5/7] コネクタを確かめます')
  let check = null
  for (let i = 0; i < 6; i++) {
    check = await checkConnector(origin, { expectDcr: dcrEnabledInConfig() })
    if (check.ok) break
    await sleep(5_000)
  }
  printResults(check)
  if (!check.ok) {
    const anon = check.results.some((r) => r.label.includes('匿名ログインが無効'))
    if (anon) say('\n匿名ログインが無効です。docs/CONNECTOR.md の 1-A の手順 3 をやり直して、もう一度 npm run connector:setup を実行してください。')
    else say('\n確かめで問題がありました（✗ の行）。しばらく待ってから npm run connector:check で確かめてください。')
    process.exitCode = 1
    return
  }

  // 6. アプリとアクセスルール
  if (flags.has('--skip-app')) say('\n[6/7] アプリとアクセスルールの公開は飛ばします（--skip-app）')
  else {
    say('\n[6/7] アプリとアクセスルールを公開します（npm run deploy と同じ。コネクタの URL がアプリに入ります）')
    const app = await runNode(path.join(repoDir, 'scripts', 'deploy.mjs'), ['--skip-connector'], { cwd: repoDir })
    if (app.code !== 0) {
      ng('アプリとアクセスルールを公開できませんでした。上の表示を見て、npm run deploy をもう一度実行してください。')
      process.exitCode = 1
      return
    }
    ok('アプリとアクセスルールを公開しました')
  }

  // 7. URL
  say('\n[7/7] 準備ができました。')
  say(`claude.ai に登録する URL: ${origin}/mcp`)
  say('（この URL は秘密ではありません。アプリの 設定 → Claude 連携 からもコピーできます。続きは docs/CONNECTOR.md の 1-A の手順 6〜）')
}

await main()
