// 原稿画面の入力欄のまとめ役。記号バー・巻き戻しボタンが「いま書いている欄」に働けるよう、
// 最後にフォーカスした欄を覚えておく。編集の中身は EditSession が持つ。
import { useSyncExternalStore } from 'react'
import type { EditSession, FieldKey, FieldState } from './session'
import type { SymbolKind } from './symbols'

export interface FieldHandle {
  key: FieldKey
  /** 記号を入れられる欄（本文・推敲メモ） */
  symbols: boolean
  element: () => HTMLTextAreaElement | HTMLInputElement | null
  insert: (kind: SymbolKind) => void
  undo: () => void
  redo: () => void
}

/**
 * 欄が画面に見えているか（閉じた <details> の中・display: none の中なら false）。
 * getClientRects() は閉じた <details> の中でも矩形を返すので使わない。checkVisibility の無いブラウザでは見えているとみなす
 */
export function isFieldVisible(el: Element): boolean {
  return el.isConnected && (typeof el.checkVisibility !== 'function' || el.checkVisibility())
}

export class EditorHub {
  private readonly handles = new Set<FieldHandle>()
  private target: FieldHandle | null = null
  private readonly listeners = new Set<() => void>()

  constructor(readonly session: EditSession) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn()
  }

  /** 記号バーなどが働く欄（最後にフォーカスした欄。無くなったら null） */
  getTarget = (): FieldHandle | null => this.target

  register(h: FieldHandle): () => void {
    this.handles.add(h)
    return () => {
      this.handles.delete(h)
      if (this.target === h) {
        this.target = null
        this.emit()
      }
    }
  }

  focused(h: FieldHandle): void {
    if (this.target === h) return
    this.target = h
    this.emit()
  }

  /** key の欄が見えなくなった時（推敲メモを畳んだ等）、記号バー・巻き戻しの働き先から外す（ボタンは押せなくなる） */
  release(key: FieldKey): void {
    if (this.target?.key !== key) return
    this.target = null
    this.emit()
  }

  /** 働き先の欄が見えなくなっていたら（しまった「…」の中など）外す */
  releaseHidden(): void {
    const el = this.target?.element()
    if (this.target && (!el || !isFieldVisible(el))) {
      this.target = null
      this.emit()
    }
  }

  /** key の欄にフォーカスする（画面に無ければ false） */
  focusField(key: FieldKey): boolean {
    for (const h of this.handles) {
      const el = h.element()
      if (h.key === key && el) {
        el.focus()
        return true
      }
    }
    return false
  }
}

export function useSessionField(session: EditSession, key: FieldKey | null): FieldState | undefined {
  return useSyncExternalStore(session.subscribe, () => (key ? session.field(key) : undefined))
}

/** 画面に出す値（保存していない編集があればそれ）。key が null なら保存先の値のまま（購読しない） */
export function useSessionValue(session: EditSession, key: FieldKey | null, stored: string): string {
  const state = useSessionField(session, key)
  return state?.edit ? state.edit.value : stored
}

export function useSessionDirty(session: EditSession): boolean {
  return useSyncExternalStore(session.subscribe, session.isDirty)
}

export function useNamesRevision(session: EditSession): number {
  return useSyncExternalStore(session.subscribe, session.namesRevision)
}

export function useHubTarget(hub: EditorHub): FieldHandle | null {
  return useSyncExternalStore(hub.subscribe, hub.getTarget)
}
