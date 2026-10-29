// コネクタのスクリプトの共通の道具（Windows の PowerShell でも Mac のターミナルでも同じに動くよう、Node だけで書く）。
// - npm・npx・シェルを通さず、パッケージの CLI（wrangler・firebase・vite・tsc）の JS を node で直接動かす
// - 秘密（TOKEN_ENC_KEY）は画面に出さず、標準入力で wrangler secret put に渡す
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

export const connectorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const repoDir = path.resolve(connectorDir, '..')
export const localConfigPath = path.join(repoDir, 'connector.local.json')

/** workers.dev の URL の形（https://名前.サブドメイン.workers.dev） */
const WORKERS_URL = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.workers\.dev/gi

/** wrangler deploy の出力から、コネクタの URL を取り出す（無ければ null） */
export function parseWorkersUrl(text, name = 'novel-studio-connector') {
  const found = [...new Set((String(text).match(WORKERS_URL) ?? []).map((u) => u.toLowerCase()))]
  return found.find((u) => u.startsWith(`https://${name}.`)) ?? found[0] ?? null
}

/** コネクタの origin として使えるか（https で、パス・問い合わせが無い） */
export function isConnectorOrigin(v) {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && v === u.origin
  } catch {
    return false
  }
}

/** ../connector.local.json（{ "origin": "https://…" }）。無い・形が違えば null */
export function readLocalConfig(file = localConfigPath) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isConnectorOrigin(j?.origin) ? { origin: j.origin } : null
  } catch {
    return null
  }
}

export function writeLocalConfig(origin, file = localConfigPath) {
  if (!isConnectorOrigin(origin)) throw new Error(`コネクタの URL の形が違います: ${origin}`)
  fs.writeFileSync(file, `${JSON.stringify({ origin }, null, 2)}\n`)
}

/**
 * 公開するアプリをビルドする時の環境変数（runNode の env に渡す。undefined は子の環境から外れる）。
 * 開発用の値（エミュレーター・手元のコネクタ）は入れない: PowerShell の $env: は画面を閉じるまで残るので、
 * 開発サーバーを動かした画面で npm run deploy をすると、公開するアプリがエミュレーターにつながってしまう。
 * コネクタの URL は connector.local.json を優先し、無ければ https の VITE_CONNECTOR_ORIGIN だけを使う
 */
export function appBuildEnv(env = process.env, local = null) {
  const inherited = env.VITE_CONNECTOR_ORIGIN
  return {
    VITE_FIREBASE_EMULATOR: undefined,
    VITE_CONNECTOR_ORIGIN: local ? local.origin : isConnectorOrigin(inherited) ? inherited : undefined,
  }
}

/** 公開する時に渡す変数（wrangler.jsonc には書かない） */
export function deployVarArgs(origin) {
  return ['--var', `MCP_RESOURCE:${origin}/mcp`, '--var', `PUBLIC_ORIGIN:${origin}`]
}

/** 秘密の鍵（32バイトの乱数の base64url）。画面には出さない */
export function newTokenKey() {
  return randomBytes(32).toString('base64url')
}

/** パッケージの CLI の JS ファイル（fromDir から見つける） */
export function binOf(pkg, binName, fromDir) {
  const require = createRequire(path.join(fromDir, 'package.json'))
  let pkgJson
  try {
    pkgJson = require.resolve(`${pkg}/package.json`)
  } catch {
    return null
  }
  const pj = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
  const bin = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[binName ?? pkg]
  return bin ? path.join(path.dirname(pkgJson), bin) : null
}

/**
 * node でスクリプトを動かす。capture = 出力を画面に出しながら控える。input = 標準入力に渡す文字（秘密に使う。画面には出ない）
 */
export function runNode(script, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: opts.cwd ?? repoDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...(opts.env ?? {}) },
      stdio: [opts.input !== undefined ? 'pipe' : 'inherit', opts.capture ? 'pipe' : 'inherit', opts.capture ? 'pipe' : 'inherit'],
    })
    let stdout = ''
    let stderr = ''
    if (opts.capture) {
      child.stdout.on('data', (d) => {
        stdout += d
        if (!opts.quiet) process.stdout.write(d)
      })
      child.stderr.on('data', (d) => {
        stderr += d
        if (!opts.quiet) process.stderr.write(d)
      })
    }
    if (opts.input !== undefined) child.stdin.end(opts.input)
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

export function wranglerBin() {
  return binOf('wrangler', 'wrangler', connectorDir)
}

/** wrangler を connector/ で動かす */
export function wrangler(args, opts = {}) {
  const bin = wranglerBin()
  if (!bin) throw new Error(MISSING_CONNECTOR_DEPS)
  return runNode(bin, args, { cwd: connectorDir, ...opts })
}

export const MISSING_CONNECTOR_DEPS =
  'コネクタの部品が入っていません。リポジトリの直下で npm --prefix connector ci を実行してから、もう一度試してください。'

export const say = (msg = '') => console.log(msg)
export const ok = (msg) => console.log(`  ✓ ${msg}`)
export const ng = (msg) => console.log(`  ✗ ${msg}`)

/** はい・いいえを聞く（Enter だけなら def） */
export async function ask(question, def = true) {
  if (!process.stdin.isTTY) return def
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const a = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
    return a ? a === 'y' || a === 'yes' || a === 'はい' : def
  } finally {
    rl.close()
  }
}

export function nodeVersionOk(version = process.versions.node) {
  return Number(version.split('.')[0]) >= 22
}
