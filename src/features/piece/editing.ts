// 原稿画面の保存まわりの小さなヘルパー。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt } from '../../store/uiStore'
import type { DraftHandle } from '../../ui/DraftField'
import { mapScrollTop } from './logic'

type VersionPatch = { name?: string; body?: string; note?: string }

/**
 * バージョンへの書き込み。下書きの保存が削除の後に届いた場合（削除直後のアンマウント等）は
 * 何もしない。値が変わっていなければ更新日時も動かさない。
 */
export function commitVersion(versionId: string, patch: VersionPatch): void {
  const v = getData().versions[versionId]
  if (!v) return
  const changed = (Object.keys(patch) as (keyof VersionPatch)[]).some((k) => patch[k] !== undefined && patch[k] !== v[k])
  if (!changed) return
  attempt(() => actions.updateVersion(versionId, patch))
}

export function commitPiece(pieceId: string, patch: { subtitle?: string; label?: string }): void {
  const p = getData().pieces[pieceId]
  if (!p) return
  if ((patch.subtitle === undefined || patch.subtitle === p.subtitle) && (patch.label === undefined || patch.label === p.label)) return
  attempt(() => actions.updatePiece(pieceId, patch))
}

/** 成功したかどうかを返す attempt（戻り値のない操作用） */
export function tryRun(fn: () => void): boolean {
  return attempt(() => {
    fn()
    return true
  }) === true
}

export function flushEditors(...refs: RefObject<DraftHandle | null>[]): void {
  for (const r of refs) r.current?.flush()
}

/** 原稿画面の中の下書き欄（話の題・見出し・稿の名前など）。Ctrl/Cmd+S でまとめて保存するために登録する */
export type DraftRegistry = Set<RefObject<DraftHandle | null>>

export const DraftRegistryContext = createContext<DraftRegistry | null>(null)

/** DraftInput / DraftTextarea に渡す ref。原稿画面の Ctrl/Cmd+S で一緒に保存される */
export function useRegisteredDraft(): RefObject<DraftHandle | null> {
  const registry = useContext(DraftRegistryContext)
  const ref = useRef<DraftHandle>(null)
  useEffect(() => {
    if (!registry) return
    registry.add(ref)
    return () => {
      registry.delete(ref)
    }
  }, [registry])
  return ref
}

/**
 * 下書き中のテキスト（文字数表示・コピー用）。id が変わったら保存済みの値に戻る。
 * onDraftChange は id ごとに同じ関数を返す（DraftTextarea の effect が回り続けないように）。
 */
export function useLiveText(id: string, stored: string): [string, (text: string) => void] {
  const [live, setLive] = useState<{ id: string; text: string } | null>(null)
  const onDraftChange = useCallback((text: string) => setLive({ id, text }), [id])
  return [live && live.id === id ? live.text : stored, onDraftChange]
}

/** 端末ごとの小さな真偽値設定（localStorage が使えなくても動く） */
export function useLocalFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: boolean) => {
      setValue(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        /* 保存できなくても動作は続ける */
      }
    },
    [key],
  )
  return [value, set]
}

/**
 * 2つのスクロール領域（data-scroll-sync="active" / "compare"）のスクロール位置を割合で揃える。
 * resetKey が変わる（エディタが作り直される）たびに付け直す。
 */
export function useScrollSync(enabled: boolean, root: RefObject<HTMLElement | null>, resetKey: string): void {
  useEffect(() => {
    if (!enabled) return
    const el = root.current
    if (!el) return
    const a = el.querySelector<HTMLElement>('[data-scroll-sync="active"]')
    const b = el.querySelector<HTMLElement>('[data-scroll-sync="compare"]')
    if (!a || !b) return
    let ignoreNext: HTMLElement | null = null
    const follow = (src: HTMLElement, dst: HTMLElement) => () => {
      if (ignoreNext === src) {
        ignoreNext = null
        return
      }
      const top = mapScrollTop(src.scrollTop, src.scrollHeight - src.clientHeight, dst.scrollHeight - dst.clientHeight)
      if (Math.abs(dst.scrollTop - top) < 1) return
      const before = dst.scrollTop
      dst.scrollTop = top
      if (dst.scrollTop !== before) ignoreNext = dst
    }
    const onA = follow(a, b)
    const onB = follow(b, a)
    a.addEventListener('scroll', onA, { passive: true })
    b.addEventListener('scroll', onB, { passive: true })
    onA()
    return () => {
      a.removeEventListener('scroll', onA)
      b.removeEventListener('scroll', onB)
    }
  }, [enabled, root, resetKey])
}

/** ポップオーバーの外側をクリック・Esc で閉じる */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref])
}
