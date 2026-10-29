#!/usr/bin/env node
// 公開する形にまとめた中身の確かめ: npm --prefix connector run bundle-check
// wrangler deploy --dry-run --outdir dist でまとめ（Cloudflare には送らない）、ソースマップで入っているファイルを見る。
// アプリの純粋な部品（src/domain・src/claude・src/sync/codec.ts・merge.ts）だけが入り、
// dexie・firebase・react・zustand、アプリの画面・端末内の保存・同期のエンジンは入っていないこと。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectorDir, say, wrangler } from './lib.mjs'

const FORBIDDEN_PACKAGES = ['dexie', 'firebase', '@firebase', 'react', 'react-dom', 'react-router', 'react-router-dom', 'zustand', 'idb']
const FORBIDDEN_APP = [/^src\/(store|db|features|ui)\//, /^src\/sync\/(engine|firebase|controller|appModel|acts|batch|conflicts)\.ts$/, /^src\/(App|main|routes)\.tsx?$/]

/** ソースマップの sources からリポジトリの直下からの相対パスにする */
export function bundleProblems(sources, repoRoot) {
  const problems = []
  const app = []
  for (const s of sources) {
    const abs = path.resolve(connectorDir, 'dist', s)
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
    const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(rel)
    if (nm && FORBIDDEN_PACKAGES.includes(nm[1])) problems.push(rel)
    if (!rel.startsWith('connector/') && !rel.includes('node_modules/')) {
      app.push(rel)
      if (FORBIDDEN_APP.some((re) => re.test(rel))) problems.push(rel)
    }
  }
  return { problems, app }
}

export async function bundleCheck({ quiet = false } = {}) {
  const outdir = path.join(connectorDir, 'dist')
  fs.rmSync(outdir, { recursive: true, force: true })
  const r = await wrangler(['deploy', '--dry-run', '--outdir', 'dist'], { capture: true, quiet: true })
  if (r.code !== 0) {
    say(r.stdout)
    say(r.stderr)
    say('✗ まとめられませんでした（wrangler deploy --dry-run）')
    return { ok: false }
  }
  const map = JSON.parse(fs.readFileSync(path.join(outdir, 'index.js.map'), 'utf8'))
  const size = fs.statSync(path.join(outdir, 'index.js')).size
  const { problems, app } = bundleProblems(map.sources ?? [], path.resolve(connectorDir, '..'))
  if (!quiet) {
    say(`  まとめた大きさ: ${(size / 1024).toFixed(0)} KiB（${(map.sources ?? []).length} ファイル。アプリの部品 ${app.length}）`)
    for (const a of app) say(`    - ${a}`)
  }
  if (problems.length) {
    say('✗ 入ってはいけないものが入っています:')
    for (const p of problems) say(`    ${p}`)
    return { ok: false, problems, app, size }
  }
  say('  ✓ dexie・firebase・react・zustand とアプリの画面・同期のエンジンは入っていません')
  return { ok: true, problems, app, size }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await bundleCheck()
  if (!r.ok) process.exitCode = 1
}
