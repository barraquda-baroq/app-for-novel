// 保存ボタンで確定する画面（原稿画面）に、まだ保存していない編集があるか。
// ヘッダーの保存状態（「保存済み」）を、保存していない編集がある間は出さないために使う。
import { create } from 'zustand'

export const useUnsavedEdits = create<{ dirty: boolean }>(() => ({ dirty: false }))

export function setUnsavedEdits(dirty: boolean): void {
  if (useUnsavedEdits.getState().dirty !== dirty) useUnsavedEdits.setState({ dirty })
}
