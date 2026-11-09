// MCP のサーバー（リクエストごとに作る。状態を持たない）。ツールの定義は JSON Schema（schemas.gen.ts）と
// Workers で使える検証（cf-worker。ajv は eval を使うので Workers では動かない）。
// initialize・tools/list は Vault を呼ばない。tools/call だけが Vault（Durable Object）を RPC で呼ぶ。
import { CLIENT_INFO_META_KEY, McpServer, fromJsonSchema, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import type { ToolResult } from '../vault/tools/common'
import { CONNECTOR_VERSION } from '../version'
import { SERVER_INSTRUCTIONS } from './instructions'
import { TOOL_SCHEMAS, TRASH_OUTPUT_SCHEMA, WRITE_OUTPUT_SCHEMA, type ToolName } from './schemas.gen'
import { TOOL_DEFS } from './tools'

export type CallTool = (name: ToolName, args: Record<string, unknown>, opts: { client?: string }) => Promise<ToolResult>

const validator = new CfWorkerJsonSchemaValidator()
let compiled: Map<ToolName, StandardSchemaWithJSON> | null = null
const outputs = new Map<'write' | 'trash', StandardSchemaWithJSON>()

/** JSON Schema をツールの入力の形にする（Worker の中で1回だけ） */
function schemaOf(name: ToolName): StandardSchemaWithJSON {
  if (!compiled) compiled = new Map()
  let s = compiled.get(name)
  if (!s) {
    s = fromJsonSchema(TOOL_SCHEMAS[name] as never, validator) as StandardSchemaWithJSON
    compiled.set(name, s)
  }
  return s
}

/** 結果（structuredContent）の形（書き込みツールと、ゴミ箱へ移すツール） */
function outputSchema(kind: 'write' | 'trash'): StandardSchemaWithJSON {
  let s = outputs.get(kind)
  if (!s) {
    s = fromJsonSchema((kind === 'write' ? WRITE_OUTPUT_SCHEMA : TRASH_OUTPUT_SCHEMA) as never, validator) as StandardSchemaWithJSON
    outputs.set(kind, s)
  }
  return s
}

/** 呼び出したクライアントの名前（2026-07-28 の呼び出しは _meta の clientInfo、古い呼び出しは HTTP の User-Agent） */
function clientName(ctx: unknown, fallback?: string): string | undefined {
  const env = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } })?.mcpReq?.envelope
  const info = env?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined
  return typeof info?.name === 'string' ? info.name : fallback
}

export function createServer(call: CallTool, info: { userAgent?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'novel-studio', title: 'Novel Studio', version: CONNECTOR_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  )
  for (const def of TOOL_DEFS) {
    const structured = def.kind === 'write' || def.kind === 'trash' ? def.kind : null
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: schemaOf(def.name),
        ...(structured ? { outputSchema: outputSchema(structured) } : {}),
        annotations: def.annotations,
      },
      async (args: unknown, ctx: unknown) => {
        const r = await call(def.name, (args ?? {}) as Record<string, unknown>, { client: clientName(ctx, info.userAgent) })
        return {
          content: [{ type: 'text' as const, text: r.text }],
          ...(r.isError ? { isError: true } : {}),
          ...(structured && r.structured && !r.isError ? { structuredContent: r.structured } : {}),
        }
      },
    )
  }
  return server
}
