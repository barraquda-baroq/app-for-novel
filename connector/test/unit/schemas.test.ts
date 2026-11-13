// ツールの入力の JSON Schema（src/mcp/schemas.gen.ts）が、zod の定義（src/mcp/schemas.ts）を { io: 'input' } で
// 変換したものと同じか。npm run gen-schemas（GEN_SCHEMAS=1）の時は書き出す。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { isIdeaTool } from '../../../src/claude/ideaWrite'
import { SCHEMAS, TRASH_OUTPUT, WRITE_OUTPUT } from '../../src/mcp/schemas'
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

export const TRASH_OUTPUT_SCHEMA: Record<string, unknown> = ${JSON.stringify(jsonSchema(TRASH_OUTPUT), null, 2)}
`
}

describe('ツールの JSON Schema', () => {
  it('schemas.gen.ts は schemas.ts から作ったものと同じ（違えば npm --prefix connector run gen-schemas）', () => {
    const text = renderSchemas()
    if (process.env.GEN_SCHEMAS === '1') fs.writeFileSync(target, text)
    // Windows で改行が CRLF で取り出されていても同じとみなす（書き出すのはいつも LF）
    expect(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')).toBe(text)
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

  it('長い文章の項目には maxLength が無い（短い項目・件数の上限はそのまま）。説明も前の上限を言わない', () => {
    type Prop = { maxLength?: number; maxItems?: number; properties?: Record<string, Prop>; items?: Prop }
    const props = (name: keyof typeof SCHEMAS) => (jsonSchema(SCHEMAS[name]) as Prop).properties!
    const idea = props('novel_add_revision_ideas').items!.items!.properties!
    expect(idea.body.maxLength).toBeUndefined()
    expect(idea.heading.maxLength).toBe(80)
    const note = props('novel_add_strategy_note')
    expect(note.body.maxLength).toBeUndefined()
    expect(note.heading.maxLength).toBe(80)
    const contest = note.contests.items!.properties!
    expect([contest.fit.maxLength, contest.plan.maxLength]).toEqual([undefined, undefined])
    expect([contest.name.maxLength, contest.organizer.maxLength, contest.url.maxLength]).toEqual([80, 80, 2_000])
    expect(note.contests.maxItems).toBe(10)
    const prompt = props('novel_save_critique_prompt')
    expect(prompt.body.maxLength).toBeUndefined()
    expect(prompt.name.maxLength).toBe(60)
    const result = props('novel_add_critique_result')
    expect([result.prompt_text.maxLength, result.result_markdown.maxLength]).toEqual([undefined, undefined])
    expect(result.artifact_url.maxLength).toBe(2_000)
    const proof = props('novel_add_proofreading')
    const item = proof.items.items!.properties!
    expect([item.excerpt, item.context_before, item.category_label, item.suggestion, item.reason].map((p) => p.maxLength)).toEqual([
      100, 30, 20, 500, 300,
    ])
    expect([proof.run_label.maxLength, proof.items.maxItems, proof.covered.maxItems]).toEqual([60, 100, 200])
    // 書き出した JSON Schema にも、ツールの説明にも、前の上限（20,000・30,000・50,000・60,000字、相性 300字・方針 2,000字）は無い
    // （2.8 のアイデアのツールは別。1件の中身・追記が20,000字までと決めてあり、超えた時はツールが分け方を返す。下で確かめる）
    const gen = fs.readFileSync(target, 'utf8')
    for (const n of [20000, 30000, 50000, 60000]) expect(gen.match(new RegExp(`"maxLength": ${n}\\b`, 'g'))).toBeNull()
    for (const def of TOOL_DEFS.filter((d) => d.kind === 'write' && !isIdeaTool(d.name)))
      expect(def.description, def.name).not.toMatch(/(20,000|30,000|50,000|60,000)字まで|（300字以内）|（2,000字以内）/)
    const others = Object.entries(SCHEMAS)
      .filter(([name]) => !isIdeaTool(name))
      .map(([, s]) => JSON.stringify(jsonSchema(s)))
      .join('\n')
    expect(others).not.toMatch(/(20,000|30,000|50,000|60,000)字まで|相性（300字以内）|方針（2,000字以内）/)
    // アイデアの中身・追記には maxLength を付けない（長すぎる時は入力の形の確かめで断らず、ツールが分け方を答える）。名前・id・印は短い
    const add = props('novel_add_ideas')
    const addItem = add.items.items!.properties!
    expect([addItem.content.maxLength, addItem.name.maxLength, add.items.maxItems]).toEqual([undefined, 40, 10])
    const append = props('novel_append_to_idea')
    expect([append.content.maxLength, append.idea_id.maxLength, append.read_mark.maxLength]).toEqual([undefined, 80, 20])
  })

  it('アイデアを足す（2.9）: folder・subfolder（80字まで）・theme（29字まで）・placement（auto か outside）。並びは title_id の次', () => {
    type Prop = { maxLength?: number; description?: string; properties?: Record<string, Prop> }
    const add = (jsonSchema(SCHEMAS.novel_add_ideas) as Prop).properties!
    expect(Object.keys(add)).toEqual(['title_id', 'folder', 'subfolder', 'theme', 'placement', 'items', 'model'])
    expect([add.folder.maxLength, add.subfolder.maxLength, add.theme.maxLength]).toEqual([80, 80, 29])
    expect((add.placement as { enum?: unknown }).enum).toEqual(['auto', 'outside'])
    expect(String(add.folder.description)).toContain('「どのフォルダに入れますか」と聞く')
    expect(String(add.placement.description)).toContain('folder と一緒には渡さない')
    expect(String(add.items.description)).toContain('入れた場所（フォルダ）の済みでないアイデアの先頭に並ぶ')
    const required = (jsonSchema(SCHEMAS.novel_add_ideas) as { required?: string[] }).required
    expect(required).toEqual(['items'])
  })

  it('すべてのツールに入力の形がある', () => {
    for (const def of TOOL_DEFS) expect(SCHEMAS[def.name], def.name).toBeTruthy()
    expect(Object.keys(SCHEMAS).sort()).toEqual(TOOL_DEFS.map((d) => d.name).sort())
  })
})
