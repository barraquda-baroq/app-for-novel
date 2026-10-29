// 共通スタイルを先に読み込み、各画面の CSS で上書きできるようにする
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { actions } from './store/actions'
import { flushNow, getData, initStore, replaceAllData } from './store/appStore'
import { installLeaveHandlers, saveBeforeLeave } from './store/lifecycle'
import { useAppUpdate } from './store/uiStore'
import { initSync, signInForTest } from './sync/controller'

// 端末内のデータが勝手に消されないよう、永続ストレージを要求する（対応ブラウザのみ）
void navigator.storage?.persist?.().catch(() => undefined)

// 画面を閉じる・裏に回る時は、入力中の下書きも含めて保留中の変更をすぐ保存する
installLeaveHandlers()

if (import.meta.env.PROD) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      useAppUpdate.setState({
        ready: true,
        apply: async () => {
          await saveBeforeLeave()
          await updateSW(true)
        },
      })
    },
  })
}

// E2E テストからデータを用意するための開発用フック（本番ビルドには含まれない）
if (import.meta.env.DEV) {
  ;(window as unknown as { __ns: unknown }).__ns = {
    actions,
    getData,
    flushNow,
    replaceAllData,
    signInForTest,
    /** ビルドの時に決めた Claude 用のコネクタの origin */
    connectorOrigin: __CONNECTOR_ORIGIN__,
    /** 手動連携の貼り付けと同じ作り方で Claude の記録を足す（戻り値は足した数） */
    pasteClaude: async (titleId: string, text: string, now = Date.now()) => {
      const { previewPaste } = await import('./claude/paste')
      const p = previewPaste(getData(), text, { titleId, now })
      if (!p.ok) throw new Error(p.error)
      return actions.addClaudeRecords(p.records).length
    },
  }
}

// 端末内のデータを読み込んでから、ログインしたことのある端末なら同期を始める
void initStore().then(() => initSync())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
