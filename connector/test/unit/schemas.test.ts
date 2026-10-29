// ツールの入力の JSON Schema（src/mcp/schemas.gen.ts）が、zod の定義（src/mcp/schemas.ts）を { io: 'input' } で
// 変換したものと同じか。npm run gen-schemas（GEN_SCHEMAS=1）の時は書き出す。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { SCHEMAS, WRITE_OUTPUT } from '../../src/mcp/schemas'
import { TOOL_DEFS } from '../../src/mcp/tools'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '../../src/mcp/schemas.gen.ts')

function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>
  delete out.$schema
  return out
}

export function renderSchemas(): string {
  const tools: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(SCHEMAS)) tools[name] = jsonSchema(s)
  const names = Object.keys(SCHEMAS)
    .map((n) => `  | '${n}'`)
    .join('\n')
  return `// このファイルは npm --prefix connector run gen-schemas（scripts/gen-schemas.mjs）が src/mcp/schemas.ts から作る。手で直さない。
// zod の定義を JSON Schema（{ io: 'input' }）にしたもの。Workers の中で zod から作り直さないように、作った結果を置いておく。

export type ToolName =
${names}

export const TOOL_SCHEMAS: Record<ToolName, Record<string, unknown>> = ${JSON.stringify(tools, null, 2)}

export const WRITE_OUTPUT_SCHEMA: Record<string, unknown> = ${JSON.stringify(jsonSchema(WRITE_OUTPUT), null, 2)}
`
}

describe('ツールの JSON Schema', () => {
  it('schemas.gen.ts は schemas.ts から作ったものと同じ（違えば npm --prefix connector run gen-schemas）', () => {
    const text = renderSchemas()
    if (process.env.GEN_SCHEMAS === '1') fs.writeFileSync(target, text)
    expect(fs.readFileSync(target, 'utf8')).toBe(text)
  })

  it('入力の形（io: input）: 既定値のある項目は必須にならない', () => {
    const read = jsonSchema(SCHEMAS.novel_read_text) as { required?: string[]; properties: Record<string, { default?: unknown }> }
    expect(read.required).toEqual(['title_id'])
    expect(read.properties.char_budget.default).toBe(20_000)
    const proof = jsonSchema(SCHEMAS.novel_add_proofreading) as {
      properties: { items: { items: { required: string[] } } }
    }
    expect(proof.properties.items.items.required.sort()).toEqual(['category', 'excerpt', 'piece', 'reason'])
  })

  it('すべてのツールに入力の形がある', () => {
    for (const def of TOOL_DEFS) expect(SCHEMAS[def.name], def.name).toBeTruthy()
    expect(Object.keys(SCHEMAS).sort()).toEqual(TOOL_DEFS.map((d) => d.name).sort())
  })
})
