// Workers の実行環境（workerd）でのテスト: npm --prefix connector run test:worker
// OAuth（ライブラリ）・同意の画面・連携の確かめ・/mcp・Durable Object を、wrangler.jsonc と同じ設定で動かす。
// Firebase は test/support/fakeFirebase.ts（fetch の差し替え）。
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // テストの workerd（@cloudflare/vitest-pool-workers 0.23.0 に入っているもの）が対応する最新の日付。
        // 公開する時は wrangler.jsonc の 2026-10-01（wrangler 4.151.0 の workerd）
        compatibilityDate: '2026-08-22',
        bindings: {
          TOKEN_ENC_KEY: 'workerd-test-secret-0123456789abcdef',
          PUBLIC_ORIGIN: 'https://connector.example',
          MCP_RESOURCE: 'https://connector.example/mcp',
          FIREBASE_EMULATOR_HOST: 'fake-firebase',
        },
      },
    }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
