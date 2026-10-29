#!/usr/bin/env node
// 公開: npm run deploy（Windows の PowerShell でも Mac のターミナルでも同じ。docs/DEPLOY.md）
//   1. アプリをビルドする（tsc -b → vite build）。connector.local.json があれば、コネクタの URL をアプリに入れる
//   2. Firebase Hosting とアクセスルールを公開する（firebase deploy --only hosting,firestore）
//   3. connector.local.json があれば、Claude 用のコネクタも型を確かめてから公開する（connector/scripts/deploy.mjs。
//      コネクタはアプリの src/domain・src/claude などをそのまま使うので、アプリと同じ版から公開する）
// オプション: --skip-app（1・2 をしない）、--skip-connector（3 をしない）
// npm・npx・シェルを通さず、各ツールの JS を node で直接動かす（&& のつなぎも使わない）。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MISSING_CONNECTOR_DEPS,
  appBuildEnv,
  ask,
  binOf,
  missingLocalNotice,
  readLocalConfig,
  runNode,
  say,
  wrangler,
  wranglerBin,
  wranglerProblem,
  wranglerProblemHint,
} from '../connector/scripts/lib.mjs'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))

function need(pkg, bin) {
  const p = binOf(pkg, bin, repoDir)
  if (!p) {
    say(`${pkg} が入っていません。リポジトリの直下で npm ci を実行してから、もう一度試してください。`)
    process.exit(1)
  }
  return p
}

async function step(label, script, args, env) {
  say(`\n▶ ${label}`)
  const r = await runNode(script, args, { cwd: repoDir, env })
  if (r.code !== 0) {
    say(`✗ ${label} に失敗しました（上の表示を見てください）`)
    process.exit(r.code || 1)
  }
}

async function main() {
  const local = readLocalConfig()
  // コネクタを別のパソコンで準備した時: このまま公開すると、アプリからコネクタの URL が消える
  const notice = missingLocalNotice({ local, skipApp: flags.has('--skip-app'), connectorDeps: Boolean(wranglerBin()) })
  if (notice) {
    for (const line of notice) say(line)
    if (process.stdin.isTTY && !(await ask('コネクタの URL なしでアプリを公開しますか？（コネクタをまだ準備していない・使わない時は y）', false))) {
      say('中止しました（何も公開していません）。')
      process.exit(1)
    }
  }
  if (!flags.has('--skip-app')) {
    // 開発用の値（エミュレーター・手元のコネクタ）は公開するアプリに入れない
    const env = appBuildEnv(process.env, local)
    if (process.env.VITE_FIREBASE_EMULATOR) say('エミュレーターの設定（VITE_FIREBASE_EMULATOR）は公開するアプリには入れません')
    if (process.env.VITE_CONNECTOR_ORIGIN && !local && !env.VITE_CONNECTOR_ORIGIN)
      say('https でないコネクタの URL（VITE_CONNECTOR_ORIGIN）は公開するアプリには入れません')
    if (env.VITE_CONNECTOR_ORIGIN) say(`コネクタの URL をアプリに入れます: ${env.VITE_CONNECTOR_ORIGIN}`)
    await step('型の確かめ（tsc -b）', need('typescript', 'tsc'), ['-b'], env)
    await step('アプリのビルド（vite build）', need('vite', 'vite'), ['build'], env)
    await step('Firebase Hosting とアクセスルールの公開', need('firebase-tools', 'firebase'), ['deploy', '--only', 'hosting,firestore'])
  }
  if (!flags.has('--skip-connector')) {
    if (!local)
      say(
        '\n（このパソコンに connector.local.json が無いので、Claude 用のコネクタは公開しませんでした。' +
          '別のパソコンで準備した時は、このパソコンでも一度 npm run connector:setup を実行してください）',
      )
    else if (!wranglerBin()) {
      say(`\n✗ ${MISSING_CONNECTOR_DEPS}`)
      process.exit(1)
    } else {
      await step('コネクタの型の確かめ（tsc -p connector/tsconfig.worker.json）', need('typescript', 'tsc'), [
        '-p',
        path.join('connector', 'tsconfig.worker.json'),
        '--noEmit',
      ])
      const { deployConnector } = await import(pathToFileURL(path.join(repoDir, 'connector', 'scripts', 'deploy.mjs')).href)
      say('\n▶ Claude 用のコネクタの公開')
      let r = await deployConnector({ origin: local.origin })
      // Cloudflare のログインが切れた（出力を控えて動かすので、wrangler はブラウザを開けない）: ここでログインして、もう一度
      if (!r.ok && wranglerProblem(r.output) === 'login' && process.stdin.isTTY) {
        say('\nCloudflare へのログインが切れています。ブラウザが開いたら Cloudflare にログインして「Allow」を押してください。')
        const login = await wrangler(['login'])
        if (login.code === 0) r = await deployConnector({ origin: local.origin })
      }
      if (!r.ok) {
        const hint = wranglerProblemHint(wranglerProblem(r.output))
        say(`✗ ${hint ?? 'コネクタを公開できませんでした（上の表示を見てください。npm --prefix connector ci を忘れていないか）'}`)
        process.exit(1)
      }
    }
  }
  say('\n公開しました。')
}

await main()
