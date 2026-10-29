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

/**
 * ../connector.local.json（{ "origin": "https://…", "enableDcr": true }。enableDcr はつながらない時の最後の手段で足す。
 * Git に入らないので、git pull の邪魔をしない）。無い・形が違えば null
 */
export function readLocalConfig(file = localConfigPath) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isConnectorOrigin(j?.origin) ? { origin: j.origin, enableDcr: j?.enableDcr === true } : null
  } catch {
    return null
  }
}

/** connector.local.json を書く（enableDcr は true の時だけ書く） */
export function writeLocalConfig(origin, { enableDcr = false } = {}, file = localConfigPath) {
  if (!isConnectorOrigin(origin)) throw new Error(`コネクタの URL の形が違います: ${origin}`)
  fs.writeFileSync(file, `${JSON.stringify({ origin, ...(enableDcr ? { enableDcr: true } : {}) }, null, 2)}\n`)
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

/**
 * DCR を有効にしたか（つながらない時の最後の手段。公開した状態もこれに合うはず）: connector.local.json の "enableDcr": true。
 * 前の版の手順で connector/wrangler.jsonc の ENABLE_DCR を "true" に書き換えた時も
 */
export function dcrEnabledInConfig(file = path.join(connectorDir, 'wrangler.jsonc'), localFile = localConfigPath) {
  if (readLocalConfig(localFile)?.enableDcr) return true
  try {
    return /"ENABLE_DCR"\s*:\s*"true"/.test(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/** 公開する時に渡す変数（wrangler.jsonc には書かない。enableDcr = connector.local.json の "enableDcr": true） */
export function deployVarArgs(origin, { enableDcr = false } = {}) {
  return ['--var', `MCP_RESOURCE:${origin}/mcp`, '--var', `PUBLIC_ORIGIN:${origin}`, ...(enableDcr ? ['--var', 'ENABLE_DCR:true'] : [])]
}

/** 秘密の鍵（32バイトの乱数の base64url）。画面には出さない */
export function newTokenKey() {
  return randomBytes(32).toString('base64url')
}

/** wrangler の出力の最後の数行（失敗の理由を見せる。秘密は標準入力で渡すので出力には出ない） */
export function lastLines(text, n = 6) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .map((l) => `    ${l}`)
    .join('\n')
}

/**
 * 鍵（TOKEN_ENC_KEY）を用意する（run は wrangler。テストでは差し替える）。もうあれば、そのまま使う（rotate の時だけ作り直す）。
 * 鍵があるか確かめられなかった時（一時的な失敗）は、作り直さずに止まる: 作り直すと Claude との連携が切れるため。
 * 戻り値: { ok: true, created, rotated } か { ok: false, reason: 'list_failed' | 'put_failed', why }（why は wrangler の表示の最後の数行）
 */
export async function ensureTokenKey(run, { rotate = false, makeKey = newTokenKey, onRotate = () => {} } = {}) {
  const list = await run(['secret', 'list', '--format', 'json'], { capture: true, quiet: true })
  if (list.code !== 0) return { ok: false, reason: 'list_failed', why: lastLines(`${list.stderr}\n${list.stdout}`) }
  const hasKey = /"name"\s*:\s*"TOKEN_ENC_KEY"/.test(list.stdout)
  if (hasKey && !rotate) return { ok: true, created: false, rotated: false }
  if (hasKey) onRotate()
  const put = await run(['secret', 'put', 'TOKEN_ENC_KEY'], { input: makeKey(), capture: true, quiet: true })
  if (put.code !== 0) return { ok: false, reason: 'put_failed', why: lastLines(`${put.stderr}\n${put.stdout}`) }
  return { ok: true, created: true, rotated: hasKey }
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

/** 最初の公開で自動で作られる OAuth の KV の名前（wrangler: Worker の名前 + "-" + バインディング名） */
export const OAUTH_KV_TITLE = 'novel-studio-connector-oauth-kv'

/**
 * wrangler の失敗の出力から、よくある原因を見分ける。
 * login = Cloudflare のログインが切れた（出力を控えて動かすので、wrangler はブラウザを開けない）、
 * kv_exists = 消したコネクタの OAuth の KV が残っていて、同じ名前で作り直せない。分からなければ null
 */
export function wranglerProblem(output) {
  const t = String(output ?? '')
  // ネットワークの問題（ログインは残っている）
  if (/could not be refreshed because the Cloudflare auth server could not be reached/i.test(t)) return null
  if (/\[code: 10014\]|namespace with this account ID and title already exists/i.test(t)) return 'kv_exists'
  // 「non-interactive」だけでは見ない（ほかの問い合わせの既定の値を使った時にも出る）
  if (
    /CLOUDFLARE_API_TOKEN environment variable|auth token has expired and could not be refreshed|no credentials were found|You are not (?:logged in|authenticated)|Not logged in/i.test(
      t,
    )
  )
    return 'login'
  return null
}

/** wranglerProblem の直し方（again = もう一度実行するコマンド） */
export function wranglerProblemHint(problem, again = 'npm run deploy') {
  if (problem === 'login')
    return `Cloudflare へのログインが切れています。npx --prefix connector wrangler login を実行して（ブラウザで Cloudflare にログインして「Allow」）、もう一度 ${again} を実行してください（API トークンを作る必要はありません）。`
  if (problem === 'kv_exists')
    return (
      `前に消したコネクタの KV（${OAUTH_KV_TITLE}）が Cloudflare に残っているため、コネクタを作り直せません。` +
      `もう一度使う時は、Cloudflare のダッシュボードの「ストレージとデータベース → KV」で ${OAUTH_KV_TITLE} を削除してから、もう一度 ${again} を実行してください。` +
      'コネクタをやめた時は、リポジトリの直下の connector.local.json を削除してから npm run deploy を実行してください（docs/CONNECTOR.md の 4）。'
    )
  return null
}

/**
 * このパソコンに connector.local.json が無いまま、アプリを公開しようとしている時の注意（コネクタの部品が入っている =
 * コネクタを使っている時だけ）。connector.local.json は npm run connector:setup をしたパソコンにだけある
 */
export function missingLocalNotice({ local, skipApp, connectorDeps }) {
  if (local || skipApp || !connectorDeps) return null
  return [
    '注意: このパソコンには connector.local.json がありません。このまま公開すると、アプリは「コネクタ未設定」になり、' +
      'claude.ai から接続し直せなくなります（いまの接続は続きます）。コネクタも更新しません。',
    '  別のパソコンで npm run connector:setup をした時は、このパソコンでも一度 npm run connector:setup を実行する' +
      '（同じコネクタ・鍵・連携をそのまま使います）か、そのパソコンの connector.local.json をここ（リポジトリの直下）にコピーしてください。',
  ]
}

export const MISSING_CONNECTOR_DEPS =
  'コネクタの部品が入っていません。リポジトリの直下で npm --prefix connector ci を実行してから、もう一度試してください。'

export const say = (msg = '') => console.log(msg)
export const ok = (msg) => console.log(`  ✓ ${msg}`)
export const ng = (msg) => console.log(`  ✗ ${msg}`)

/** 答えが「はい」か（空なら def）。日本語入力のままの全角の ｙ・ＹＥＳ も「はい」 */
export function answerIsYes(answer, def = true) {
  const a = String(answer ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
  return a ? a === 'y' || a === 'yes' || a === 'はい' : def
}

/** はい・いいえを聞く（Enter だけなら def） */
export async function ask(question, def = true) {
  if (!process.stdin.isTTY) return def
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return answerIsYes(await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `), def)
  } finally {
    rl.close()
  }
}

export function nodeVersionOk(version = process.versions.node) {
  return Number(version.split('.')[0]) >= 22
}
