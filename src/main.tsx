import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { actions } from './store/actions'
import { flushNow, getData, initStore, replaceAllData } from './store/appStore'
import './styles.css'

// 端末内のデータが勝手に消されないよう、永続ストレージを要求する（対応ブラウザのみ）
void navigator.storage?.persist?.().catch(() => undefined)

// 画面を閉じる・裏に回る時は保留中の変更をすぐ保存する
window.addEventListener('pagehide', () => void flushNow())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushNow()
})

if (import.meta.env.PROD) registerSW({ immediate: true })

// E2E テストからデータを用意するための開発用フック（本番ビルドには含まれない）
if (import.meta.env.DEV) {
  ;(window as unknown as { __ns: unknown }).__ns = { actions, getData, flushNow, replaceAllData }
}

void initStore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
