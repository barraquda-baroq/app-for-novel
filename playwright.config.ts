import { defineConfig, devices } from '@playwright/test'

// E2E テスト。`npm run test:e2e` で dev サーバーを立ち上げて実行する。
// 複数の作業を並行して走らせる時は E2E_PORT でポートを分ける。
const port = Number(process.env.E2E_PORT ?? 5174)

export default defineConfig({
  testDir: './e2e',
  // 同期のテストはエミュレーターが要るので別に動かす（playwright.sync.config.ts）
  testIgnore: '**/*.sync.spec.ts',
  outputDir: './e2e/artifacts/results',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'ja-JP',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    // Claude 用のコネクタの場所（テストではページの通信を横取りして、仮のコネクタが答える。e2e/claude.spec.ts）
    env: { VITE_CONNECTOR_ORIGIN: process.env.VITE_CONNECTOR_ORIGIN ?? 'https://connector.e2e.test' },
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
