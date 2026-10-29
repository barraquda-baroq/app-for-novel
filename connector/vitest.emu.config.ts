// コネクタの結合テスト（Firebase エミュレーターが要る）: リポジトリの直下で npm run test:connector:emu
// アプリの端末（../src の同期・端末内の保存。Dexie は fake-indexeddb）と、コネクタの Vault の中身を一緒に動かす。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/emu/**/*.emu.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
