/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // 相対パスで出力しておくと、静的ホスティング・Capacitor/Tauri 等のラッパーにそのまま載せられる
  base: './',
  // 同期（Firebase）は使う時に読み込む。開発サーバーで途中に依存を最適化し直して再読み込みしないよう、先にまとめておく
  optimizeDeps: { include: ['firebase/app', 'firebase/auth', 'firebase/firestore'] },
  plugins: [
    react(),
    VitePWA({
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
})
