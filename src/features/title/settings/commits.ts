// 設定エントリへの書き込み。下書き欄の保存は少し遅れて届くので、
// 必ず「保存する時点の最新のデータ」から組み立てる（別のフィールドの編集を上書きしない）。
import type { ID, SettingField } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData } from '../../../store/appStore'
import { attempt } from '../../../store/uiStore'

/** 名前・自由記述の保存。削除・移動の後に届いた保存や、値が変わらない保存は何もしない */
export function commitEntry(entryId: ID, patch: { name?: string; body?: string }): void {
  const e = getData().settingEntries[entryId]
  if (!e) return
  if ((patch.name === undefined || patch.name === e.name) && (patch.body === undefined || patch.body === e.body)) return
  attempt(() => actions.updateEntry(entryId, patch))
}

/** フィールド配列の更新。fn には保存時点の最新のフィールドが渡される。null を返すと何もしない */
export function commitFields(entryId: ID, fn: (fields: SettingField[]) => SettingField[] | null): boolean {
  const e = getData().settingEntries[entryId]
  if (!e) return false
  const next = fn(e.fields)
  if (!next) return false
  return attempt(() => (actions.updateEntry(entryId, { fields: next }), true)) === true
}
