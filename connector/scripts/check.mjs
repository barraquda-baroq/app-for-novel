#!/usr/bin/env node
// 公開したコネクタを確かめる: npm run connector:check（リポジトリの直下で。URL は ../connector.local.json から）
//   または node connector/scripts/check.mjs https://novel-studio-connector.<サブドメイン>.workers.dev
// claude.ai が接続する時に読む2つのメタデータ（resource・issuer・S256・CIMD・"none"・offline_access・DCR が無いこと）、
// トークンの無い /mcp が 401 になること、コネクタの身元を作れる（Firebase の匿名ログインが有効）ことを確かめる。原稿は読まない。
import { pathToFileURL } from 'node:url'
import { dcrEnabledInConfig, readLocalConfig } from './lib.mjs'

/** 確かめた結果の一覧（{ ok, label, hint? }） */
export async function checkConnector(origin, { fetch: f = fetch, expectDcr = false } = {}) {
  const results = []
  const add = (ok, label, hint) => results.push({ ok: Boolean(ok), label, ...(hint && !ok ? { hint } : {}) })
  const get = async (path, init) => {
    try {
      return await f(`${origin}${path}`, init)
    } catch (e) {
      return { ok: false, status: 0, headers: new Headers(), json: async () => ({}), text: async () => String(e) }
    }
  }

  const home = await get('/')
  const html = await home.text()
  const state = /data-state="([a-z_]+)"/.exec(html)?.[1] ?? ''
  add(home.status === 200 && html.includes('Novel Studio コネクタ'), `コネクタが動いている（${origin}）`, 'URL を確かめ、npm run deploy をもう一度実行してください')

  const pr = await get('/.well-known/oauth-protected-resource/mcp')
  const prj = pr.status === 200 ? await pr.json().catch(() => ({})) : {}
  add(prj.resource === `${origin}/mcp`, `保護されたリソースの URL が ${origin}/mcp`, 'npm run deploy（URL を渡して公開し直す）')
  add(Array.isArray(prj.authorization_servers) && prj.authorization_servers[0] === origin, '認可サーバーがこのコネクタ')

  const as = await get('/.well-known/oauth-authorization-server')
  const asj = as.status === 200 ? await as.json().catch(() => ({})) : {}
  add(asj.issuer === origin, '認可サーバーの issuer')
  add(Array.isArray(asj.code_challenge_methods_supported) && asj.code_challenge_methods_supported.includes('S256'), 'PKCE（S256）')
  add(asj.client_id_metadata_document_supported === true, 'Claude の公開の識別子（CIMD）を受け付ける')
  add(Array.isArray(asj.token_endpoint_auth_methods_supported) && asj.token_endpoint_auth_methods_supported.includes('none'), '秘密の無いクライアント（none）')
  add(Array.isArray(asj.scopes_supported) && asj.scopes_supported.includes('offline_access'), '更新用トークン（offline_access）')
  // wrangler.jsonc の ENABLE_DCR と、公開した状態が合っているか（合わなければ公開し直す）
  const redeploy = '公開した状態が connector/wrangler.jsonc の ENABLE_DCR と合いません。npm run deploy をもう一度実行してください'
  if (expectDcr) add(typeof asj.registration_endpoint === 'string', '自動的に登録（DCR）が有効', redeploy)
  else add(asj.registration_endpoint === undefined, '自動的に登録（DCR）は無効', redeploy)

  const mcp = await get('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const www = mcp.headers.get('WWW-Authenticate') ?? ''
  add(mcp.status === 401 && www.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`), 'トークンの無い /mcp は 401（接続の手順を案内する）')

  const id = await get('/connect/identity')
  const idj = await id.json().catch(() => ({}))
  if (id.status === 200 && typeof idj.uid === 'string')
    add(true, `コネクタの身元（匿名のアカウント）を用意できた（版 ${idj.version}・データの形 ${idj.model}）`)
  else if (idj.error === 'anonymous_disabled')
    add(false, '匿名ログインが無効です', 'Firebase コンソール → Authentication →「ログイン方法」→「匿名」を有効にして保存し、もう一度実行してください')
  else if (idj.error === 'key_missing') add(false, '鍵（TOKEN_ENC_KEY）が設定されていません', 'npm run connector:setup をもう一度実行してください')
  else add(false, 'コネクタの身元を用意できません', idj.message ?? `HTTP ${id.status}`)

  return { results, state, ok: results.every((r) => r.ok) }
}

export function printResults({ results }) {
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`)
    if (r.hint) console.log(`      → ${r.hint}`)
  }
}

/** コマンドの引数（-- で始まらない最初のものが URL。--dcr は DCR を有効にした時） */
export function parseCheckArgs(argv) {
  const args = argv.filter((a) => typeof a === 'string')
  return { origin: args.find((a) => !a.startsWith('--')) ?? '', dcr: args.includes('--dcr') }
}

async function main() {
  const args = parseCheckArgs(process.argv.slice(2))
  const origin = (args.origin || readLocalConfig()?.origin || '').replace(/\/+$/, '')
  if (!origin) {
    console.log('コネクタの URL が分かりません。先に npm run connector:setup を実行するか、URL を付けて実行してください。')
    process.exitCode = 1
    return
  }
  console.log(`Novel Studio コネクタを確かめます: ${origin}`)
  const r = await checkConnector(origin, { expectDcr: args.dcr || dcrEnabledInConfig() })
  printResults(r)
  console.log(r.ok ? '問題ありません。' : '問題があります（✗ の行）。')
  if (!r.ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
