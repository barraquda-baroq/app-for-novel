import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { flushNow, initStore } from './store/appStore'
import './styles.css'

// 端末内のデータが勝手に消されないよう、永続ストレージを要求する（対応ブラウザのみ）
void navigator.storage?.persist?.().catch(() => undefined)

// 画面を閉じる・裏に回る時は保留中の変更をすぐ保存する
window.addEventListener('pagehide', () => void flushNow())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushNow()
})

if (import.meta.env.PROD) registerSW({ immediate: true })

void initStore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
