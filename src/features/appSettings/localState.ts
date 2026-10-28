// この端末のブラウザに保存している、データ以外のちょっとした状態（書きかけ・折りたたみ・復旧用の控えなど）を消す。
// すべてのデータを削除した時やバックアップから復元した時に、古いデータ向けの状態が残らないようにする。
import { DISPLAY_PREF_KEYS, LAST_BACKUP_KEY, localKeysToClear } from './settingsLogic'

/** 消し終わったら window に送るイベント（表示中の画面が読み直せるように） */
export const LOCAL_STATE_CLEARED = 'novel-studio:local-state-cleared'

function clearStorage(storage: Storage, keep: readonly string[]): void {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key !== null) keys.push(key)
  }
  for (const key of localKeysToClear(keys, keep)) storage.removeItem(key)
}

/**
 * 表示の設定（テーマ・文字サイズなど）以外の、この端末の状態を消す。
 * keepLastBackup: 「最後に書き出した日時」を残す（復元の時。書き出した事実は変わらないので）
 */
export function clearLocalState({ keepLastBackup }: { keepLastBackup: boolean }): void {
  const keep = keepLastBackup ? [...DISPLAY_PREF_KEYS, LAST_BACKUP_KEY] : DISPLAY_PREF_KEYS
  for (const get of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      clearStorage(get(), keep)
    } catch {
      /* 使えない環境では何もしない */
    }
  }
  window.dispatchEvent(new Event(LOCAL_STATE_CLEARED))
}
