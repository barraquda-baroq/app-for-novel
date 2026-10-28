// 保存ボタンで確定する画面（原稿画面）に、まだ保存していない編集があるか。
// ヘッダーの保存状態（「保存済み」）・同期の状態を、保存していない編集がある間は言い切らないために使う。
// アプリの更新の前に保存するか聞けるよう、原稿画面を開いている間はその確認（ensureSaved）も置く。
import { create } from 'zustand'

/** 保存していない編集があれば保存するか聞いて保存する（続けてよければ true） */
export type EnsureSaved = (opts?: { message?: string; confirmLabel?: string }) => Promise<boolean>

interface UnsavedEditsState {
  dirty: boolean
  /** 原稿画面を開いている間だけ入る */
  ensureSaved: EnsureSaved | null
}

export const useUnsavedEdits = create<UnsavedEditsState>(() => ({ dirty: false, ensureSaved: null }))

export function setUnsavedEdits(dirty: boolean): void {
  if (useUnsavedEdits.getState().dirty !== dirty) useUnsavedEdits.setState({ dirty })
}

export function registerEnsureSaved(fn: EnsureSaved | null): void {
  if (useUnsavedEdits.getState().ensureSaved !== fn) useUnsavedEdits.setState({ ensureSaved: fn })
}
