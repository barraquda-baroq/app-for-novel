// コネクタの単体テスト（Node。fetch はテストの中で差し替える）: npm --prefix connector run test:unit
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
