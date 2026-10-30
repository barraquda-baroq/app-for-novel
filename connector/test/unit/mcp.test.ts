// MCP の層: ツールの一覧（名前・題・ヒント・並び）、JSON Schema での入力の確かめ（cf-worker）、
// initialize・tools/list は Vault を呼ばないこと、書き込みツールの structuredContent。
import { createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import { beforeAll, describe, expect, it } from 'vitest'
import { novel } from '../../../src/test/claudeFixture'
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions'
import { TOOL_SCHEMAS } from '../../src/mcp/schemas.gen'
import { createServer } from '../../src/mcp/server'
import { TOOL_DEFS } from '../../src/mcp/tools'
import type { VaultCore } from '../../src/vault/core'
import { FakeFirebase } from '../support/fakeFirebase'
import { pairedCore } from '../support/harness'

const EXPECTED_ORDER = [
  'novel_status',
  'novel_list_titles',
  'novel_get_outline',
  'novel_read_text',
  'novel_list_versions',
  'novel_search_text',
  'novel_get_notes',
  'novel_get_strategy',
  'novel_get_critique',
  'novel_list_proofreading',
  'novel_list_bench_works',
  'novel_get_bench_analysis',
  'novel_add_proofreading',
  'novel_add_revision_ideas',
  'novel_add_strategy_note',
  'novel_save_critique_prompt',
  'novel_add_critique_result',
  'novel_add_bench_analysis',
]

describe('ツールの決まり', () => {
  it('名前は ASCII の novel_*（64字以内・重ならない・決まった並び）、題は日本語、ヒントは4つとも', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(EXPECTED_ORDER)
    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(/^novel_[a-z_]+$/)
      expect(t.name.length).toBeLessThanOrEqual(64)
      expect(t.title).toMatch(/[ぁ-んァ-ヶ一-龠]/)
      expect(t.annotations.title).toBe(t.title)
      expect(Object.keys(t.annotations).sort()).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint', 'title'])
      expect(t.annotations.openWorldHint).toBe(false)
      expect(t.annotations.destructiveHint).toBe(false)
      expect(t.annotations.readOnlyHint).toBe(t.kind === 'read')
      expect(t.description.length).toBeGreaterThan(60)
    }
    expect(new Set(TOOL_DEFS.map((t) => t.name)).size).toBe(TOOL_DEFS.length)
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200)
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(900)
  })

  it('既定値を省いた呼び出しも、cf-worker の検証で通る（JSON Schema は io: input から作っている）', async () => {
    const v = new CfWorkerJsonSchemaValidator()
    const read = fromJsonSchema(TOOL_SCHEMAS.novel_read_text as never, v)
    const ok = await read['~standard'].validate({ title_id: 't:12345678' })
    expect('issues' in ok && ok.issues).toBeFalsy()
    const bad = await read['~standard'].validate({ char_budget: 10 })
    expect('issues' in bad && bad.issues?.length).toBeTruthy()
    const proof = fromJsonSchema(TOOL_SCHEMAS.novel_add_proofreading as never, v)
    const p = await proof['~standard'].validate({
      title_id: 't:1',
      items: [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }],
    })
    expect('issues' in p && p.issues).toBeFalsy()
    const wrong = await proof['~standard'].validate({ title_id: 't:1', items: [{ piece: '#1', excerpt: 'x', category: 'typos', reason: 'r' }] })
    expect('issues' in wrong && wrong.issues?.length).toBeTruthy()
    // 長い文章は入力の形の確かめで断らない（大きさは書き込みの時に確かめ、分け方を返す）。短い項目の上限はそのまま
    const critique = fromJsonSchema(TOOL_SCHEMAS.novel_add_critique_result as never, v)
    const long = await critique['~standard'].validate({ title_id: 't:1', prompt_text: 'あ'.repeat(30_000), result_markdown: 'あ'.repeat(250_000) })
    expect('issues' in long && long.issues).toBeFalsy()
    const longExcerpt = await proof['~standard'].validate({
      title_id: 't:1',
      items: [{ piece: '#1', excerpt: 'あ'.repeat(101), category: 'typo', reason: 'r' }],
    })
    expect('issues' in longExcerpt && longExcerpt.issues?.length).toBeTruthy()
  })
})

describe('MCP の呼び出し（2025-11-25 の stateless・2026-07-28）', () => {
  let core: VaultCore
  let titleId: string
  let calls = 0
  let handler: ReturnType<typeof createMcpHandler>

  beforeAll(async () => {
    const n = novel(['窓から見れる景色。'])
    titleId = n.titleId
    core = (await pairedCore(new FakeFirebase(), n.data)).core
    handler = createMcpHandler(
      () =>
        createServer(async (name, args, opts) => {
          calls += 1
          return core.callTool(name, args, opts)
        }),
      { legacy: 'stateless', responseMode: 'json' },
    )
  })

  async function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
    const res = await handler.fetch(
      new Request('https://connector.example/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
    )
    const text = await res.text()
    const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(/data: (.*)/.exec(text)![1])
    return { status: res.status, json }
  }

  it('initialize・tools/list は Vault を呼ばない。一覧は決まった並びで、題・ヒント・入力の形がある', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } })
    expect(init.status).toBe(200)
    expect(init.json.result.serverInfo.name).toBe('novel-studio')
    expect(init.json.result.instructions).toContain('採用原稿')
    const list = await rpc('tools/list', {}, 2)
    const tools = list.json.result.tools as { name: string; title: string; annotations: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> }; outputSchema?: unknown }[]
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_ORDER)
    expect(tools[3].title).toBe('採用原稿を読む')
    expect(tools[3].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    const write = tools.find((t) => t.name === 'novel_add_proofreading')!
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
    expect(tools[3].inputSchema.properties.char_budget).toMatchObject({ default: 20_000, maximum: 60_000 })
    expect(write.outputSchema).toBeTruthy()
    // ベンチ作品（2.5）: 読む2つと書き込み1つ
    const bench = tools.filter((t) => t.name.includes('_bench_'))
    expect(bench.map((t) => [t.name, t.title, t.annotations.readOnlyHint])).toEqual([
      ['novel_list_bench_works', 'ベンチ作品の一覧を見る', true],
      ['novel_get_bench_analysis', 'ベンチ作品の分析を読む', true],
      ['novel_add_bench_analysis', 'ベンチ作品の分析を追加', false],
    ])
    expect(bench[2].outputSchema).toBeTruthy()
    expect(init.json.result.instructions).toContain('ベンチ作品')
    expect(tools[2].outputSchema).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('tools/call: 読むツールはテキストだけ、書き込みツールは structuredContent も返す', async () => {
    const read = await rpc('tools/call', { name: 'novel_read_text', arguments: { title_id: titleId } }, 3)
    expect(read.json.result.content[0].text).toContain('窓から見れる景色。')
    expect(read.json.result.structuredContent).toBeUndefined()
    const write = await rpc(
      'tools/call',
      { name: 'novel_add_revision_ideas', arguments: { title_id: titleId, items: [{ heading: '冒頭', body: '景色の描写を増やす' }] } },
      4,
    )
    expect(write.json.result.isError).toBeFalsy()
    expect(write.json.result.structuredContent.created[0].id).toMatch(/^r:/)
    expect(calls).toBe(2)
  })

  it('書き込みツールが何も作れなかった時は isError（structuredContent なしでも出力の形の確かめで落ちない）', async () => {
    const r = await rpc(
      'tools/call',
      { name: 'novel_add_proofreading', arguments: { title_id: titleId, items: [{ piece: '#1', excerpt: '無い文', category: 'typo', reason: 'x' }] } },
      6,
    )
    expect(r.status).toBe(200)
    expect(r.json.error).toBeUndefined()
    expect(r.json.result.isError).toBe(true)
    expect(r.json.result.content[0].text).toContain('見つからない 1件')
    // 重複だけの時は isError にせず、structuredContent を返す
    const input = { title_id: titleId, items: [{ heading: '冒頭', body: '景色の描写を増やす' }] }
    const dup = await rpc('tools/call', { name: 'novel_add_revision_ideas', arguments: input }, 7)
    expect(dup.json.result.isError).toBeFalsy()
    expect(dup.json.result.structuredContent).toMatchObject({ created: [], skipped: [{ index: 0, reason: 'duplicate' }] })
  })

  it('入力の形が違えば、Vault を呼ばずに失敗を返す', async () => {
    const before = calls
    const r = await rpc('tools/call', { name: 'novel_read_text', arguments: { char_budget: 5 } }, 5)
    const failed = r.json.error || r.json.result?.isError
    expect(failed).toBeTruthy()
    expect(calls).toBe(before)
  })
})
