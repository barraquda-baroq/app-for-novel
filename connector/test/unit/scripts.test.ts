// 準備・公開・確かめのスクリプトの部品（Cloudflare にはつながない）と、公開する形の中身。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { vaultConfig, workerConfig } from '../../src/config'
// prettier-ignore
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { OAUTH_KV_TITLE, answerIsYes, appBuildEnv, dcrEnabledInConfig, deployVarArgs, ensureTokenKey, isConnectorOrigin, missingLocalNotice, newTokenKey, parseWorkersUrl, readLocalConfig, wranglerProblem, wranglerProblemHint, writeLocalConfig } from '../../scripts/lib.mjs'
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { checkConnector, parseCheckArgs } from '../../scripts/check.mjs'
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { bundleCheck, bundleProblems } from '../../scripts/bundle-check.mjs'

describe('wrangler.jsonc の変数', () => {
  it('どの変数もコネクタのコードが読む（効かない設定を書かない）', () => {
    const dir = path.resolve(import.meta.dirname, '../..')
    const text = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8')
    const vars = /"vars"\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? ''
    const names = [...vars.matchAll(/^\s*"([A-Z0-9_]+)"\s*:/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(5)
    const src = fs.readFileSync(path.join(dir, 'src/config.ts'), 'utf8')
    for (const name of names) expect(src, name).toMatch(new RegExp(`env\\.${name}\\b`))
    // 設定から作った値も、どれかのコードが使う（読むだけで何にも効かない設定を作らない）
    const env = Object.fromEntries(names.map((n) => [n, '']))
    const keys = [...Object.keys(vaultConfig(env as never)), ...Object.keys(workerConfig(env as never, 'https://c.example/'))]
    const files = (fs.readdirSync(path.join(dir, 'src'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('config.ts'))
      .map((f) => fs.readFileSync(path.join(dir, 'src', f), 'utf8'))
      .join('\n')
    for (const key of keys) expect(files, key).toMatch(new RegExp(`\\.${key}\\b`))
  })
})

describe('CI（.github/workflows/ci.yml）', () => {
  it('コネクタの部品を入れ、型・単体・Workers・エミュレーターのテストを動かす（同期の E2E の前に入れる）', () => {
    const ci = fs.readFileSync(path.resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'), 'utf8')
    const at = (s: string) => ci.indexOf(s)
    for (const s of ['npm --prefix connector ci', 'npm --prefix connector run typecheck', 'npm run test:connector\n', 'npm run test:connector:emu'])
      expect(at(s), s).toBeGreaterThan(0)
    expect(at('npm --prefix connector ci')).toBeLessThan(at('npm run test:e2e:sync'))
    expect(ci).toContain('connector/package-lock.json')
  })
})

describe('docs/CONNECTOR.md のコマンド', () => {
  it('リポジトリの直下で動かす wrangler のコマンドには、Worker の名前を付ける（直下には wrangler.jsonc が無い）', () => {
    const dir = path.resolve(import.meta.dirname, '../..')
    const name = /"name"\s*:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'))?.[1]
    expect(name).toBeTruthy()
    const doc = fs.readFileSync(path.join(dir, '../docs/CONNECTOR.md'), 'utf8')
    const commands = [...doc.matchAll(/`(npx --prefix connector wrangler (?:delete|secret delete)[^`]*)`/g)].map((m) => m[1])
    expect(commands.length).toBeGreaterThanOrEqual(2)
    for (const c of commands) expect(c, c).toContain(`--name ${name}`)
  })
})

describe('スクリプトの部品', () => {
  it('ENABLE_DCR を "true" にした時（最後の手段）は、確かめも DCR が有効なことを期待する。--dcr は URL として読まない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-dcr-'))
    const on = path.join(dir, 'on.jsonc')
    const off = path.join(dir, 'off.jsonc')
    fs.writeFileSync(on, '{\n  // "true" にすると…\n  "vars": { "ENABLE_DCR": "true" }\n}\n')
    fs.writeFileSync(off, '{\n  // つながらない時の最後の手段: "true" にすると DCR を受け付ける\n  "vars": { "ENABLE_DCR": "false" }\n}\n')
    const noLocal = path.join(dir, 'none.json')
    expect(dcrEnabledInConfig(on, noLocal)).toBe(true)
    expect(dcrEnabledInConfig(off, noLocal)).toBe(false)
    expect(dcrEnabledInConfig(path.join(dir, 'none.jsonc'), noLocal)).toBe(false)
    expect(dcrEnabledInConfig(undefined, noLocal)).toBe(false)
    expect(parseCheckArgs(['--dcr'])).toEqual({ origin: '', dcr: true })
    expect(parseCheckArgs(['https://c.example.workers.dev', '--dcr'])).toEqual({ origin: 'https://c.example.workers.dev', dcr: true })
  })

  it('DCR は connector.local.json の "enableDcr": true で有効にする（Git に入る wrangler.jsonc を書き換えない）。準備し直しても残る', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-dcr-local-'))
    const local = path.join(dir, 'connector.local.json')
    const jsonc = path.join(dir, 'wrangler.jsonc')
    fs.writeFileSync(jsonc, '{ "vars": { "ENABLE_DCR": "false" } }')
    const origin = 'https://novel-studio-connector.baroq.workers.dev'
    fs.writeFileSync(local, JSON.stringify({ origin, enableDcr: true }))
    const read = readLocalConfig(local)
    expect(read).toEqual({ origin, enableDcr: true })
    expect(dcrEnabledInConfig(jsonc, local)).toBe(true)
    expect(deployVarArgs(origin, { enableDcr: read.enableDcr })).toEqual([
      '--var',
      `MCP_RESOURCE:${origin}/mcp`,
      '--var',
      `PUBLIC_ORIGIN:${origin}`,
      '--var',
      'ENABLE_DCR:true',
    ])
    // npm run connector:setup が書き直しても、enableDcr は残る
    writeLocalConfig(origin, { enableDcr: read.enableDcr }, local)
    expect(readLocalConfig(local)).toEqual({ origin, enableDcr: true })
    writeLocalConfig(origin, {}, local)
    expect(JSON.parse(fs.readFileSync(local, 'utf8'))).toEqual({ origin })
    expect(dcrEnabledInConfig(jsonc, local)).toBe(false)
    // docs は wrangler.jsonc の書き換えを勧めない
    const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../docs/CONNECTOR.md'), 'utf8')
    expect(doc).toContain('"enableDcr": true')
    expect(doc).not.toMatch(/wrangler\.jsonc` の `ENABLE_DCR` を `"true"` にして/)
  })

  it('準備のスクリプト・コネクタの案内が指す docs/CONNECTOR.md の手順の番号が合っている', () => {
    const dir = path.resolve(import.meta.dirname, '../..')
    const doc = fs.readFileSync(path.join(dir, '../docs/CONNECTOR.md'), 'utf8')
    const handSteps = doc.slice(doc.indexOf('### 1-A.'), doc.indexOf('### 1-B.'))
    const stepOf = (re: RegExp) => Number(new RegExp(`^(\\d+)\\. \\*\\*${re.source}`, 'm').exec(handSteps)?.[1])
    const anon = stepOf(/Firebase で匿名ログインを有効にする/)
    const script = stepOf(/準備のスクリプトを動かす/)
    expect(anon).toBeGreaterThan(0)
    expect(script).toBeGreaterThan(anon)
    const setup = fs.readFileSync(path.join(dir, 'scripts/setup.mjs'), 'utf8')
    const errors = fs.readFileSync(path.join(dir, 'src/vault/errors.ts'), 'utf8')
    expect(setup).toContain(`1-A の手順 1〜${script - 1}`)
    expect(setup).toContain(`匿名ログインが無効です。docs/CONNECTOR.md の 1-A の手順 ${anon} をやり直して`)
    expect(setup).toContain(`1-A の手順 ${script + 1}〜`)
    // 確かめで止まった時は、アプリとアクセスルールを公開していないので、check ではなく setup をやり直す
    expect(setup).toContain('アプリとアクセスルールはまだ公開していません')
    expect(setup).not.toContain('npm run connector:check で確かめてください')
    expect(errors).toContain(`docs/CONNECTOR.md の 1-A の手順 ${anon}）`)
  })

  it('公開するアプリのビルドには、開発用の値（エミュレーター・手元のコネクタ）を入れない', () => {
    const dev = { VITE_FIREBASE_EMULATOR: '127.0.0.1', VITE_CONNECTOR_ORIGIN: 'http://localhost:8787' }
    expect(appBuildEnv(dev, null)).toEqual({ VITE_FIREBASE_EMULATOR: undefined, VITE_CONNECTOR_ORIGIN: undefined })
    expect(appBuildEnv(dev, { origin: 'https://c.example.workers.dev' })).toEqual({
      VITE_FIREBASE_EMULATOR: undefined,
      VITE_CONNECTOR_ORIGIN: 'https://c.example.workers.dev',
    })
    expect(appBuildEnv({ VITE_CONNECTOR_ORIGIN: 'https://d.example.workers.dev' }, null).VITE_CONNECTOR_ORIGIN).toBe(
      'https://d.example.workers.dev',
    )
    // undefined の値は子の環境から外れる（Node の spawn）
    expect('VITE_FIREBASE_EMULATOR' in appBuildEnv({}, null)).toBe(true)
  })

  it('wrangler deploy の出力から URL を取り出す', () => {
    const out = `Uploaded novel-studio-connector (3.21 sec)\nDeployed novel-studio-connector triggers (1.02 sec)\n  https://novel-studio-connector.baroq.workers.dev\n  schedule: 17 19 * * *`
    expect(parseWorkersUrl(out)).toBe('https://novel-studio-connector.baroq.workers.dev')
    expect(parseWorkersUrl('no url here')).toBeNull()
  })

  it('コネクタの URL の形・公開する時に渡す変数（: を含む値も1つの変数）', () => {
    expect(isConnectorOrigin('https://novel-studio-connector.baroq.workers.dev')).toBe(true)
    expect(isConnectorOrigin('https://x.workers.dev/mcp')).toBe(false)
    expect(isConnectorOrigin('http://x.workers.dev')).toBe(false)
    expect(deployVarArgs('https://a.b.workers.dev')).toEqual([
      '--var',
      'MCP_RESOURCE:https://a.b.workers.dev/mcp',
      '--var',
      'PUBLIC_ORIGIN:https://a.b.workers.dev',
    ])
  })

  it('connector.local.json を書いて読む（形が違えば null）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-'))
    const file = path.join(dir, 'connector.local.json')
    expect(readLocalConfig(file)).toBeNull()
    writeLocalConfig('https://novel-studio-connector.baroq.workers.dev', {}, file)
    expect(readLocalConfig(file)).toEqual({ origin: 'https://novel-studio-connector.baroq.workers.dev', enableDcr: false })
    fs.writeFileSync(file, '{"origin":"javascript:alert(1)"}')
    expect(readLocalConfig(file)).toBeNull()
    expect(() => writeLocalConfig('http://insecure.example', {}, file)).toThrow()
  })

  it('はい・いいえの答え: 日本語入力のままの全角の ｙ も「はい」', () => {
    for (const a of ['y', 'Y', 'yes', 'はい', 'ｙ', 'Ｙ', 'ｙｅｓ', ' ｙ '])
      expect(answerIsYes(a), a).toBe(true)
    for (const a of ['n', 'ｎ', 'no', 'いいえ']) expect(answerIsYes(a), a).toBe(false)
    expect(answerIsYes('')).toBe(true)
    expect(answerIsYes('', false)).toBe(false)
  })

  it('鍵: あればそのまま。確かめられない時（一時的な失敗）は作り直さずに止まり、wrangler の理由を見せる', async () => {
    type Call = { args: string[]; input?: string }
    const fake = (answers: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
      const calls: Call[] = []
      const run = async (args: string[], opts: { input?: string } = {}) => {
        calls.push({ args, input: opts.input })
        const a = answers[args.slice(0, 2).join(' ')] ?? { code: 0 }
        return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
      }
      return { run, calls }
    }
    const has = '[{"name":"TOKEN_ENC_KEY","type":"secret_text"}]'
    // もうある: 作らない
    const kept = fake({ 'secret list': { code: 0, stdout: has } })
    expect(await ensureTokenKey(kept.run)).toEqual({ ok: true, created: false, rotated: false })
    expect(kept.calls.map((c) => c.args[1])).toEqual(['list'])
    // 一覧が一時的に失敗: 鍵を作り直さない（作り直すと連携が切れる）
    const blip = fake({ 'secret list': { code: 1, stderr: '✘ [ERROR] A request to the Cloudflare API failed. (status 503)' } })
    const r = await ensureTokenKey(blip.run)
    expect(r).toMatchObject({ ok: false, reason: 'list_failed' })
    expect(r.why).toContain('status 503')
    expect(blip.calls.map((c) => c.args[1])).toEqual(['list'])
    // 初めて（一覧は空）: 作って標準入力で渡す
    const first = fake({ 'secret list': { code: 0, stdout: '[]' } })
    expect(await ensureTokenKey(first.run, { makeKey: () => 'k'.repeat(43) })).toEqual({ ok: true, created: true, rotated: false })
    expect(first.calls[1]).toEqual({ args: ['secret', 'put', 'TOKEN_ENC_KEY'], input: 'k'.repeat(43) })
    // 保存に失敗: 理由を見せる（鍵そのものは出力に無い）
    const denied = fake({ 'secret list': { code: 0, stdout: '[]' }, 'secret put': { code: 1, stderr: 'Authentication error [code: 10000]' } })
    const d = await ensureTokenKey(denied.run, { makeKey: () => 'secret-value' })
    expect(d).toMatchObject({ ok: false, reason: 'put_failed' })
    expect(d.why).toContain('code: 10000')
    expect(d.why).not.toContain('secret-value')
    // 作り直す（--rotate-key）: 知らせてから作る
    let warned = false
    const rot = fake({ 'secret list': { code: 0, stdout: has } })
    expect(await ensureTokenKey(rot.run, { rotate: true, onRotate: () => (warned = true) })).toEqual({ ok: true, created: true, rotated: true })
    expect(warned).toBe(true)
  })

  it('wrangler の失敗の原因: ログインが切れた・前のコネクタの KV が残っている（直し方を日本語で）', () => {
    const expired =
      "✘ [ERROR] Your auth token has expired and could not be refreshed, and the environment is non-interactive. Run `wrangler login` in an interactive terminal or set a CLOUDFLARE_API_TOKEN."
    const none =
      "✘ [ERROR] In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work."
    const kv =
      'Provisioning OAUTH_KV (KV Namespace)...\n🌀 Creating new KV Namespace "novel-studio-connector-oauth-kv"...\n🤖 Using fallback value in non-interactive context: Create new\n✘ [ERROR] A request to the Cloudflare API (/accounts/x/storage/kv/namespaces) failed.\n  a namespace with this account ID and title already exists [code: 10014]'
    const offline =
      'Your auth token has expired and could not be refreshed because the Cloudflare auth server could not be reached. This is usually a network problem'
    expect(wranglerProblem(expired)).toBe('login')
    expect(wranglerProblem(none)).toBe('login')
    expect(wranglerProblem(kv)).toBe('kv_exists')
    expect(wranglerProblem(offline)).toBeNull()
    expect(wranglerProblem('✘ [ERROR] Build failed with 1 error')).toBeNull()
    expect(wranglerProblemHint('login')).toContain('npx --prefix connector wrangler login')
    expect(wranglerProblemHint('login')).toContain('npm run deploy')
    expect(wranglerProblemHint('kv_exists', 'npm run connector:setup')).toContain(OAUTH_KV_TITLE)
    expect(wranglerProblemHint('kv_exists', 'npm run connector:setup')).toContain('もう一度 npm run connector:setup')
    expect(wranglerProblemHint(null)).toBeNull()
    // KV の名前は wrangler が作る名前（Worker の名前 + バインディング名）と同じ
    const dir = path.resolve(import.meta.dirname, '../..')
    const cfg = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8')
    const name = /"name"\s*:\s*"([^"]+)"/.exec(cfg)?.[1]
    expect(cfg).toContain('"binding": "OAUTH_KV"')
    expect(OAUTH_KV_TITLE).toBe(`${name}-oauth-kv`)
  })

  it('connector.local.json の無いパソコンからアプリを公開する時は注意を出す（コネクタの部品が入っている時だけ）', () => {
    const notice = missingLocalNotice({ local: null, skipApp: false, connectorDeps: true })
    expect(notice?.join('\n')).toContain('コネクタ未設定')
    expect(notice?.join('\n')).toContain('npm run connector:setup')
    expect(missingLocalNotice({ local: { origin: 'https://c.example.workers.dev' }, skipApp: false, connectorDeps: true })).toBeNull()
    expect(missingLocalNotice({ local: null, skipApp: true, connectorDeps: true })).toBeNull()
    expect(missingLocalNotice({ local: null, skipApp: false, connectorDeps: false })).toBeNull()
  })

  it('鍵は32バイトの乱数（毎回違う）', () => {
    const a = newTokenKey()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newTokenKey()).not.toBe(a)
  })
})

describe('npm run connector:check（メタデータの確かめ）', () => {
  const origin = 'https://novel-studio-connector.baroq.workers.dev'
  function server(over: { dcr?: boolean; resource?: string; anonymous?: boolean } = {}) {
    return async (url: string, init?: RequestInit) => {
      const p = new URL(url).pathname
      if (p === '/') return new Response('<p data-state="unpaired">Novel Studio コネクタ</p>')
      if (p === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({ resource: over.resource ?? `${origin}/mcp`, authorization_servers: [origin] })
      if (p === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: origin,
          code_challenge_methods_supported: ['S256'],
          client_id_metadata_document_supported: true,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
          scopes_supported: ['novel', 'offline_access'],
          ...(over.dcr ? { registration_endpoint: `${origin}/oauth/register` } : {}),
        })
      if (p === '/mcp' && init?.method === 'POST')
        return new Response('{}', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
        })
      if (p === '/connect/identity')
        return over.anonymous === false
          ? Response.json({ error: 'anonymous_disabled', message: '匿名ログインが無効' }, { status: 503 })
          : Response.json({ uid: 'anon1', version: '2.3.0', model: 3 })
      return new Response('', { status: 404 })
    }
  }

  it('すべて合えば ok', async () => {
    const r = await checkConnector(origin, { fetch: server() })
    expect(r.results.filter((x: { ok: boolean }) => !x.ok)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.state).toBe('unpaired')
  })

  it('URL の違い・DCR が有効・匿名ログインが無効を見つける', async () => {
    const r = await checkConnector(origin, { fetch: server({ resource: 'https://other.example/mcp', dcr: true, anonymous: false }) })
    const bad = r.results.filter((x: { ok: boolean }) => !x.ok).map((x: { label: string }) => x.label)
    expect(bad).toEqual(expect.arrayContaining([`保護されたリソースの URL が ${origin}/mcp`, '自動的に登録（DCR）は無効', '匿名ログインが無効です']))
    expect(r.ok).toBe(false)
  })
})

describe('公開する形（wrangler deploy --dry-run）', () => {
  it('入ってはいけないものを見つける', () => {
    const root = path.resolve(__dirname, '../../..')
    const { problems } = bundleProblems(
      ['../node_modules/@modelcontextprotocol/server/dist/index.mjs', '../../node_modules/dexie/dist/dexie.mjs', '../../src/store/appStore.ts', '../../src/claude/view.ts'],
      root,
    )
    expect(problems).toEqual(['node_modules/dexie/dist/dexie.mjs', 'src/store/appStore.ts'])
  })

  it('まとめた中身に dexie・firebase・react・zustand・アプリの画面が入っていない', async () => {
    const r = await bundleCheck({ quiet: true })
    expect(r.ok).toBe(true)
    expect(r.app).toEqual(expect.arrayContaining(['src/claude/view.ts', 'src/sync/codec.ts', 'src/sync/merge.ts']))
  }, 180_000)
})
