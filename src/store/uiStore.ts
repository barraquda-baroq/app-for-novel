// 端末ごとの表示設定（比率・分割方向・文字サイズなど）とトースト通知。
// 表示設定は localStorage に保存する（使えない環境でも既定値で動く）。
import { create } from 'zustand'
import { DomainError } from '../domain/types'

export type SplitOrientation = 'auto' | 'horizontal' | 'vertical'
/** 外観。ホワイト／ダーク／ディープダーク（タブもほぼ黒。人目のある場所で目立たないように） */
export type Appearance = 'white' | 'dark' | 'deep-dark'
/** 外観の設定。system は端末の設定（ライト／ダーク）に合わせてホワイトかダークになる */
export type ThemeMode = 'system' | Appearance
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
  /**
   * 起動アニメーションを出す（既定オン）。index.html に埋め込んだ src/launch/launch.js が、アプリより先にこの値を読む
   * （false の時だけ出さない）
   */
  launchAnimation: boolean
}

export const DEFAULT_PREFS: Prefs = {
  splitRatio: 0.5,
  splitOrientation: 'auto',
  theme: 'system',
  editorFont: 'gothic',
  editorFontSize: 17,
  showDiff: false,
  verticalReading: false,
  launchAnimation: true,
}

const PREFS_KEY = 'novel-studio:prefs'

/**
 * 保存形式の版。2（Novel Studio 2.0）で外観を3種にし（light → white）、原稿の書体の既定を明朝からゴシックにした。
 * 1.x は表示の設定をまとめて保存していたため、既定のままの「明朝」と選んだ「明朝」を区別できない。
 * そこで 1.x の書体はゴシック（新しい既定）に移す。明朝は設定からいつでも選び直せる。
 */
export const PREFS_VERSION = 2

const THEME_MODES: readonly ThemeMode[] = ['system', 'white', 'dark', 'deep-dark']
const EDITOR_FONTS: readonly EditorFont[] = ['mincho', 'gothic']

/** localStorage に保存していた表示の設定を今の形に直す（古い版の値は移し替え、壊れた値は既定値にする） */
export function migratePrefs(stored: unknown): Prefs {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return DEFAULT_PREFS
  const raw = stored as Record<string, unknown>
  const legacy = raw.version !== PREFS_VERSION
  const prefs: Record<string, unknown> = { ...DEFAULT_PREFS }
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (typeof raw[key] === typeof prefs[key]) prefs[key] = raw[key]
  }
  const theme = legacy && raw.theme === 'light' ? 'white' : prefs.theme
  prefs.theme = THEME_MODES.includes(theme as ThemeMode) ? theme : DEFAULT_PREFS.theme
  const font = legacy ? DEFAULT_PREFS.editorFont : prefs.editorFont
  prefs.editorFont = EDITOR_FONTS.includes(font as EditorFont) ? font : DEFAULT_PREFS.editorFont
  return prefs as unknown as Prefs
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    return migratePrefs(JSON.parse(raw))
  } catch {
    return DEFAULT_PREFS
  }
}

/** 外観の設定から実際の外観を決める（「端末の設定に合わせる」は端末がダークならダーク、そうでなければホワイト） */
export function resolveAppearance(mode: ThemeMode, systemDark: boolean): Appearance {
  if (mode === 'system') return systemDark ? 'dark' : 'white'
  return mode
}

/**
 * ブラウザの枠（アドレスバー・ステータスバー）の色。ヘッダーの背景（--surface）に合わせる。
 * 最初の描画の前に外観を決める src/launch/launch.js（index.html に埋め込む）にも同じ値がある（変える時は両方そろえる）。
 */
export const THEME_COLORS: Record<Appearance, string> = {
  white: '#ffffff',
  dark: '#17181b',
  'deep-dark': '#0e0f11',
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
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, version: PREFS_VERSION }))
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

// ---------- アプリ（PWA）の更新 ----------

interface UpdateState {
  /** 新しいバージョンが用意できた */
  ready: boolean
  /** 保存してから新しいバージョンに切り替える */
  apply: (() => Promise<void>) | null
}

export const useAppUpdate = create<UpdateState>(() => ({ ready: false, apply: null }))
