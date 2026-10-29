/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { normalizeOrigin } from './src/claude/pairing'

/**
 * Claude 用のコネクタ（Cloudflare Worker）の場所。ビルドの時に決めて埋め込む（URL からは受け取らない。docs/CONNECTOR.md）。
 * connector.local.json（npm run connector:setup が書く。リポジトリには入れない）の origin、無ければ VITE_CONNECTOR_ORIGIN、
 * どちらも無ければ空（設定の Claude 連携は「コネクタ未設定」、連携の画面は先へ進まない）
 */
function connectorOrigin(build: boolean): string {
  let raw = ''
  const file = new URL('./connector.local.json', import.meta.url)
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as { origin?: unknown }
      raw = typeof v.origin === 'string' ? v.origin : ''
    } catch {
      console.warn('connector.local.json を読めませんでした（コネクタ未設定として続けます）')
    }
  }
  if (!raw) raw = process.env.VITE_CONNECTOR_ORIGIN ?? ''
  raw = raw.trim()
  if (!raw) return ''
  // アプリの画面・コネクタと同じ決まり（src/claude/pairing.ts）: https の origin（開発中は localhost も）だけ
  const origin = normalizeOrigin(raw)
  if (!origin) console.warn(`コネクタの origin が正しくありません（https://… の origin だけ）: ${raw}`)
  // 公開するビルドには、手元のコネクタ（http://localhost…）を入れない
  if (build && origin.startsWith('http:')) {
    console.warn(`手元のコネクタの URL は公開するアプリに入れません: ${origin}`)
    return ''
  }
  return origin
}

export default defineConfig(({ command, mode }) => {
  // iPhone / Android アプリ（Capacitor）に載せる画面（npm run build:native）。サービスワーカーを入れず、dist-native に出す
  // （capacitor.config.ts の webDir。Web 版の dist を取り違えてアプリに入れることがないように）
  const native = mode === 'native'
  return {
    define: {
      __CONNECTOR_ORIGIN__: JSON.stringify(connectorOrigin(command === 'build')),
      // ビルドした日時（アプリの「このアプリについて」と、iPhone のテスト版の期限の目安）
      __BUILD_TIME__: JSON.stringify(Date.now()),
    },
    // 相対パスで出力しておくと、静的ホスティング・Capacitor/Tauri 等のラッパーにそのまま載せられる
    base: './',
    build: native ? { outDir: 'dist-native', emptyOutDir: true } : undefined,
    // 同期（Firebase）は使う時に読み込む。開発サーバーで途中に依存を最適化し直して再読み込みしないよう、先にまとめておく
    optimizeDeps: { include: ['firebase/app', 'firebase/auth', 'firebase/firestore'] },
    plugins: [
      react(),
      VitePWA({
        // アプリでは使わない（更新はアプリそのものを入れ直す。virtual:pwa-register は何もしない形になる）
        disable: native,
        // 執筆中に勝手に再読み込みしないよう、更新はユーザーが「更新する」を押した時に適用する
        registerType: 'prompt',
        workbox: {
          // Firebase のログイン画面（/__/auth/…）はオフライン用のアプリの画面に差し替えない
          navigateFallbackDenylist: [/^\/__\//],
        },
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Novel Studio — 小説執筆アプリ',
          short_name: 'Novel Studio',
          description: 'アイデア・設定・話数単位の原稿と推敲バージョン、応募戦略をまとめて管理する小説執筆アプリ',
          lang: 'ja',
          theme_color: '#2f3a4f',
          background_color: '#f6f4ef',
          display: 'standalone',
          start_url: './',
          scope: './',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
    ],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // 同期のテストは Firebase エミュレーターの中で動かす（npm run test:sync）
      exclude: ['src/**/*.emu.test.ts', 'node_modules/**'],
    },
  }
})
