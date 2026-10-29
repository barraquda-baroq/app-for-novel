// 準備・公開・確かめのスクリプトの部品（Cloudflare にはつながない）と、公開する形の中身。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { vaultConfig, workerConfig } from '../../src/config'
// prettier-ignore
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { answerIsYes, appBuildEnv, dcrEnabledInConfig, deployVarArgs, ensureTokenKey, isConnectorOrigin, newTokenKey, parseWorkersUrl, readLocalConfig, writeLocalConfig } from '../../scripts/lib.mjs'
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
    expect(dcrEnabledInConfig(on)).toBe(true)
    expect(dcrEnabledInConfig(off)).toBe(false)
    expect(dcrEnabledInConfig(path.join(dir, 'none.jsonc'))).toBe(false)
    expect(dcrEnabledInConfig()).toBe(false)
    expect(parseCheckArgs(['--dcr'])).toEqual({ origin: '', dcr: true })
    expect(parseCheckArgs(['https://c.example.workers.dev', '--dcr'])).toEqual({ origin: 'https://c.example.workers.dev', dcr: true })
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
    writeLocalConfig('https://novel-studio-connector.baroq.workers.dev', file)
    expect(readLocalConfig(file)).toEqual({ origin: 'https://novel-studio-connector.baroq.workers.dev' })
    fs.writeFileSync(file, '{"origin":"javascript:alert(1)"}')
    expect(readLocalConfig(file)).toBeNull()
    expect(() => writeLocalConfig('http://insecure.example', file)).toThrow()
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
