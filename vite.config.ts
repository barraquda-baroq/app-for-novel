/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite'
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

/** 埋め込むビルドの日時。Web 版の本番のビルド（npm run build）は null（毎回同じ中身にする）。アプリ・テスト・開発中は今の日時 */
export function buildTimeDefine(command: 'build' | 'serve', native: boolean, now = Date.now()): number | null {
  return command === 'build' && !native ? null : now
}

/** index.html の <script data-inline="ファイル">…</script> */
const INLINE_SCRIPT = /<script data-inline="([^"]+)">([\s\S]*?)<\/script>/g

/**
 * index.html の <script data-inline="ファイル">…</script> の先頭に、そのファイルの中身を埋め込む（src/launch/launch.js: 外観と起動アニメーション）。
 * 最初の描画の前に、アプリの本体の読み込みを待たずに動かすため（読み込みを1つも増やさない）。minify ではコメントを除いて縮める（ビルド）
 */
export async function inlineScripts(html: string, root: string, minify: boolean): Promise<string> {
  let out = ''
  let last = 0
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const file = path.resolve(root, m[1])
    let code = readFileSync(file, 'utf8')
    // 古い端末でも動く書き方のまま縮める（埋め込むので Vite の変換を通らない）
    if (minify) code = (await transformWithEsbuild(code, file, { minify: true, target: 'es2020', legalComments: 'none' })).code
    if (/<\/script/i.test(code)) throw new Error(`${m[1]} に </script> があると埋め込めません`)
    out += `${html.slice(last, m.index)}<script>\n${code.trim()}\n${m[2].trim()}\n</script>`
    last = m.index + m[0].length
  }
  return out + html.slice(last)
}

function inlineLaunchScript(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url))
  let minify = false
  return {
    name: 'novel-studio:inline-launch-script',
    configResolved(config) {
      minify = config.command === 'build'
    },
    configureServer(server) {
      // 開発中に書き換えたら読み込み直す（モジュールのつながりの外にあるので、Vite は見ていない）
      const file = path.resolve(root, 'src/launch/launch.js')
      server.watcher.add(file)
      server.watcher.on('change', (changed) => {
        if (path.resolve(changed) === file) server.ws.send({ type: 'full-reload' })
      })
    },
    transformIndexHtml: { order: 'pre', handler: (html) => inlineScripts(html, root, minify) },
  }
}

export default defineConfig(({ command, mode }) => {
  // iPhone / Android アプリ（Capacitor）に載せる画面（npm run build:native）。サービスワーカーを入れず、dist-native に出す
  // （capacitor.config.ts の webDir。Web 版の dist を取り違えてアプリに入れることがないように）
  const native = mode === 'native'
  return {
    define: {
      __CONNECTOR_ORIGIN__: JSON.stringify(connectorOrigin(command === 'build')),
      // ビルドした日時（アプリの「このアプリについて」と、iPhone のテスト版の期限の目安。使うのはアプリだけ）。
      // Web 版のビルドには入れない: 入れると、アプリが何も変わっていなくてもビルドのたびに中身が変わり、
      // npm run deploy のたびに「新しいバージョンのアプリがあります」が出て、全部を読み込み直すことになる
      __BUILD_TIME__: JSON.stringify(buildTimeDefine(command, native)),
    },
    // 相対パスで出力しておくと、静的ホスティング・Capacitor/Tauri 等のラッパーにそのまま載せられる
    base: './',
    build: native ? { outDir: 'dist-native', emptyOutDir: true } : undefined,
    // 同期（Firebase）は使う時に読み込む。開発サーバーで途中に依存を最適化し直して再読み込みしないよう、先にまとめておく
    optimizeDeps: { include: ['firebase/app', 'firebase/auth', 'firebase/firestore'] },
    plugins: [
      react(),
      inlineLaunchScript(),
      VitePWA({
        // アプリでは使わない（更新はアプリそのものを入れ直す。virtual:pwa-register は何もしない形になる）
        disable: native,
        // 執筆中に勝手に再読み込みしないよう、更新はユーザーが「更新する」を押した時に適用する
        registerType: 'prompt',
        workbox: {
          // Firebase のログイン画面（/__/auth/…）はオフライン用のアプリの画面に差し替えない
          navigateFallbackDenylist: [/^\/__\//],
        },
        includeAssets: ['favicon.svg', 'icon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Novel Studio — 小説執筆アプリ',
          short_name: 'Novel Studio',
          description: 'アイデア・設定・話数単位の原稿と推敲バージョン、応募戦略をまとめて管理する小説執筆アプリ',
          lang: 'ja',
          // アイコン（黒地に緑の点の「NS」）と起動アニメーションのダークの地の色。ウインドウの枠の色は、開いた後は外観に合わせる（index.html の theme-color）
          theme_color: '#050607',
          background_color: '#050607',
          display: 'standalone',
          start_url: './',
          scope: './',
          // 絵は真ん中の 80% の円（maskable の安全な範囲）に収めてあるので、同じ画像を丸などに切り抜かれる用（maskable）にも使う
          // （scripts/render-icons.mjs）
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
    ],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      // scripts/ はスクリプトの部品のテスト（Node の環境。各ファイルの先頭の @vitest-environment node）
      include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
      // 同期のテストは Firebase エミュレーターの中で動かす（npm run test:sync）
      exclude: ['src/**/*.emu.test.ts', 'node_modules/**'],
    },
  }
})
