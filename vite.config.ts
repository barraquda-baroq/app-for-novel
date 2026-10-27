/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // 相対パスで出力しておくと、静的ホスティング・Capacitor/Tauri 等のラッパーにそのまま載せられる
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
  },
})
