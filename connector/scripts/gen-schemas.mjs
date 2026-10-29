#!/usr/bin/env node
// ツールの入力の JSON Schema を作り直す: npm --prefix connector run gen-schemas
// src/mcp/schemas.ts（zod）を z.toJSONSchema(…, { io: 'input' }) で変換して src/mcp/schemas.gen.ts に書く。
// 変換は test/unit/schemas.test.ts が行う（同じテストが、ふだんは書き出したものと一致するかを確かめる）。
import { binOf, connectorDir, runNode, say } from './lib.mjs'

const vitest = binOf('vitest', 'vitest', connectorDir)
if (!vitest) {
  say('vitest が入っていません。npm --prefix connector ci を実行してください。')
  process.exit(1)
}
const r = await runNode(vitest, ['run', 'test/unit/schemas.test.ts'], { cwd: connectorDir, env: { GEN_SCHEMAS: '1' } })
if (r.code !== 0) process.exit(r.code)
say('src/mcp/schemas.gen.ts を書き出しました。')
