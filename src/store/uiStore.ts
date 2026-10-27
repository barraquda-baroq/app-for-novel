// 端末ごとの表示設定（比率・分割方向・文字サイズなど）とトースト通知。
// 表示設定は localStorage に保存する（使えない環境でも既定値で動く）。
import { create } from 'zustand'
import { DomainError } from '../domain/types'

export type SplitOrientation = 'auto' | 'horizontal' | 'vertical'
export type ThemeMode = 'system' | 'light' | 'dark'
export type EditorFont = 'mincho' | 'gothic'

export interface Prefs {
  /** 原稿比較の分割比率（採用原稿側の割合 0.15〜0.85） */
  splitRatio: number
  /** 分割方向。auto は画面幅で決める（広い画面は左右、スマホは上下） */
  splitOrientation: SplitOrientation
  theme: ThemeMode
  editorFont: EditorFont
  editorFontSize: number
  /** 比較時に差分をハイライトする */
  showDiff: boolean
  /** 通し読みを縦書きで表示する */
  verticalReading: boolean
}

export const DEFAULT_PREFS: Prefs = {
  splitRatio: 0.5,
  splitOrientation: 'auto',
  theme: 'system',
  editorFont: 'mincho',
  editorFontSize: 17,
  showDiff: false,
  verticalReading: false,
}

const PREFS_KEY = 'novel-studio:prefs'

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

export const clampRatio = (r: number) => Math.min(0.85, Math.max(0.15, r))

interface PrefsState extends Prefs {
  setPrefs: (patch: Partial<Prefs>) => void
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...loadPrefs(),
  setPrefs: (patch) => {
    const next = { ...patch }
    if (next.splitRatio !== undefined) next.splitRatio = clampRatio(next.splitRatio)
    set(next)
    try {
      const { setPrefs: _omit, ...prefs } = { ...get() }
      void _omit
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* 保存できなくても動作は続ける */
    }
  },
}))

// ---------- トースト ----------

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], message: string) => void
  dismiss: (id: number) => void
}

let toastSeq = 0

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts.slice(-3), { id, kind, message }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 6000 : 3000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export function notify(message: string): void {
  useToasts.getState().push('info', message)
}

export function notifyError(message: string): void {
  useToasts.getState().push('error', message)
}

/**
 * 操作を実行し、仕様上できない操作（DomainError）はエラートーストで知らせる。
 * 成功時は戻り値を、失敗時は undefined を返す。
 */
export function attempt<R>(fn: () => R): R | undefined {
  try {
    return fn()
  } catch (e) {
    if (e instanceof DomainError) {
      notifyError(e.message)
      return undefined
    }
    notifyError(e instanceof Error ? e.message : String(e))
    console.error(e)
    return undefined
  }
}
