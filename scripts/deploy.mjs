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
import { MISSING_CONNECTOR_DEPS, binOf, readLocalConfig, runNode, say, wranglerBin } from '../connector/scripts/lib.mjs'

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
  if (!flags.has('--skip-app')) {
    const env = local ? { VITE_CONNECTOR_ORIGIN: local.origin } : {}
    if (local) say(`コネクタの URL をアプリに入れます: ${local.origin}`)
    await step('型の確かめ（tsc -b）', need('typescript', 'tsc'), ['-b'], env)
    await step('アプリのビルド（vite build）', need('vite', 'vite'), ['build'], env)
    await step('Firebase Hosting とアクセスルールの公開', need('firebase-tools', 'firebase'), ['deploy', '--only', 'hosting,firestore'])
  }
  if (!flags.has('--skip-connector')) {
    if (!local) say('\n（connector.local.json が無いので、Claude 用のコネクタは公開しません。使う時は npm run connector:setup）')
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
      const r = await deployConnector({ origin: local.origin })
      if (!r.ok) {
        say('✗ コネクタを公開できませんでした（上の表示を見てください。npm --prefix connector ci を忘れていないか）')
        process.exit(1)
      }
    }
  }
  say('\n公開しました。')
}

await main()
