// 同期のテスト（Firebase エミュレーターが必要）: npm run test:sync
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.emu.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
