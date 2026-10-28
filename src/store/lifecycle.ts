// 画面を閉じる・裏に回る・再読み込みする時の保存処理。
import { flushNow, writeRecoveryJournal } from './appStore'
import { flushAllDrafts } from './draftRegistry'

/**
 * 入力欄の下書きをすべてストアへ反映し、まだ保存できていない変更を同期的に控えてから保存を始める。
 * pagehide / visibilitychange(hidden) / アプリ更新の前に呼ぶ。
 */
export function saveBeforeLeave(): Promise<boolean> {
  flushAllDrafts()
  writeRecoveryJournal()
  return flushNow()
}

let installed = false

export function installLeaveHandlers(): void {
  if (installed) return
  installed = true
  window.addEventListener('pagehide', () => void saveBeforeLeave())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveBeforeLeave()
  })
}
