// キー操作の小さな共通部品（原稿画面の記号バー・欄ごとの検索・メニュー・セパレート画面）
import type { SyntheticEvent } from 'react'

/** Mac・iPhone・iPad（ショートカットは ⌘。iPad の物理キーボードも UA が Mac なので ⌘） */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** 押してもフォーカスを動かさない（入力欄にカーソルを残し、スマホのキーボードを閉じない）。onPointerDown・onMouseDown に付ける */
export const keepFocus = (e: SyntheticEvent) => e.preventDefault()
