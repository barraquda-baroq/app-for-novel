#!/usr/bin/env node
// コネクタのテスト（エミュレーターの要らないもの）: npm --prefix connector test（リポジトリの直下では npm run test:connector）
//   1. 単体テスト（Node の vitest。Firebase は fetch の差し替え）
//   2. Workers の実行環境（workerd）でのテスト（OAuth・連携・/mcp・Durable Object）
//   （1 の中で、公開する形にまとめた中身に dexie・firebase・react・zustand が入っていないことも確かめる: test/unit/scripts.test.ts）
// エミュレーターの結合テストは、リポジトリの直下で npm run test:connector:emu。
import { binOf, connectorDir, runNode, say } from './lib.mjs'

const vitest = binOf('vitest', 'vitest', connectorDir)
if (!vitest) {
  say('vitest が入っていません。npm --prefix connector ci を実行してください。')
  process.exit(1)
}
for (const [label, args] of [
  ['単体テスト', ['run']],
  ['Workers の実行環境のテスト', ['run', '--config', 'vitest.workers.config.ts']],
]) {
  say(`\n▶ ${label}`)
  const r = await runNode(vitest, args, { cwd: connectorDir })
  if (r.code !== 0) {
    say(`✗ ${label} に失敗しました`)
    process.exit(r.code)
  }
}
say('\nコネクタのテストはすべて通りました。')
