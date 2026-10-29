import { defineConfig, devices } from '@playwright/test'

// 同期の E2E テスト。Firebase エミュレーターにつなぐ開発サーバーで、2つのブラウザ（端末）を動かす。
// `npm run test:e2e:sync` で、エミュレーターを立ち上げてから実行する。
const port = Number(process.env.E2E_SYNC_PORT ?? 5180)

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.sync.spec.ts',
  outputDir: './e2e/artifacts/sync-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'ja-JP',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    env: {
      VITE_FIREBASE_EMULATOR: '127.0.0.1',
      // Claude 用のコネクタの場所（ページの通信を横取りして答える。e2e/claude.sync.spec.ts は仮のコネクタ、e2e/pairing.sync.spec.ts は本物の Worker）
      VITE_CONNECTOR_ORIGIN: process.env.VITE_CONNECTOR_ORIGIN ?? 'https://connector.e2e.test',
    },
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } }],
})
