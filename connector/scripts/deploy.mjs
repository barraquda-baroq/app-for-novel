#!/usr/bin/env node
// コネクタを公開する（wrangler deploy）。URL（MCP_RESOURCE・PUBLIC_ORIGIN）は ../connector.local.json から渡す。
// ふだんはリポジトリの直下の npm run deploy（アプリ・アクセスルール・コネクタをまとめて公開）から呼ばれる。
import { pathToFileURL } from 'node:url'
import { deployVarArgs, parseWorkersUrl, readLocalConfig, say, wrangler, wranglerProblem, wranglerProblemHint } from './lib.mjs'

/** 公開する。戻り値は wrangler の出力にあった URL（無ければ null） */
export async function deployConnector({ origin = readLocalConfig()?.origin ?? null } = {}) {
  const args = ['deploy', ...(origin ? deployVarArgs(origin) : [])]
  const r = await wrangler(args, { capture: true })
  if (r.code !== 0) return { ok: false, url: null, output: `${r.stdout}\n${r.stderr}` }
  return { ok: true, url: parseWorkersUrl(`${r.stdout}\n${r.stderr}`), output: r.stdout }
}

async function main() {
  const local = readLocalConfig()
  if (!local) say('（../connector.local.json がありません。初めての時は、リポジトリの直下で npm run connector:setup を実行してください）')
  const r = await deployConnector({ origin: local?.origin ?? null })
  if (!r.ok) {
    say(wranglerProblemHint(wranglerProblem(r.output), 'node connector/scripts/deploy.mjs') ?? 'コネクタを公開できませんでした（上の wrangler の表示を見てください）。')
    process.exitCode = 1
    return
  }
  if (local && r.url && r.url !== local.origin)
    say(`注意: 公開した URL（${r.url}）が connector.local.json（${local.origin}）と違います。npm run connector:setup をやり直してください。`)
  say(`コネクタを公開しました${r.url ? `: ${r.url}/mcp` : ''}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
