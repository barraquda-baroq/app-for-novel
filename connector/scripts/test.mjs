#!/usr/bin/env node
// コネクタのテスト（エミュレーターの要らないもの）: npm --prefix connector test（リポジトリの直下では npm run test:connector）
//   1. 単体テスト（Node の vitest。Firebase は fetch の差し替え）
//   2. Workers の実行環境（workerd）でのテスト（OAuth・連携・/mcp・Durable Object）
//   3. 公開する形にまとめた中身の確かめ（dexie・firebase・react・zustand が入っていない）
// エミュレーターの結合テストは、リポジトリの直下で npm run test:connector:emu。
import { binOf, connectorDir, runNode, say } from './lib.mjs'
import { bundleCheck } from './bundle-check.mjs'

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
say('\n▶ 公開する形の確かめ')
const b = await bundleCheck()
if (!b.ok) process.exit(1)
