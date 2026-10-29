// 準備・公開・確かめのスクリプトの部品（Cloudflare にはつながない）と、公開する形の中身。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { vaultConfig, workerConfig } from '../../src/config'
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import {
  appBuildEnv,
  deployVarArgs,
  isConnectorOrigin,
  newTokenKey,
  parseWorkersUrl,
  readLocalConfig,
  writeLocalConfig,
} from '../../scripts/lib.mjs'
// @ts-expect-error スクリプトは JavaScript（型の宣言なし）
import { checkConnector } from '../../scripts/check.mjs'
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
