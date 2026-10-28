// 原稿画面の保存まわりの小さなヘルパー。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { actions } from '../../store/actions'
import { getData } from '../../store/appStore'
import { attempt, notify } from '../../store/uiStore'
import { conflictVersionName } from '../../sync/conflicts'
import type { DraftConflictGuard, DraftHandle } from '../../ui/DraftField'
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

/**
 * 本文の編集中に、同期で別の端末の編集が届いて稿の本文が書き換わっていたら、入力中の本文を上書きせずに
 * 「（競合: この端末の編集）」の新しい稿として残す（どちらの文章も消さない）。
 */
export function versionBodyGuard(versionId: string): DraftConflictGuard {
  return {
    read: () => getData().versions[versionId]?.body ?? '',
    onConflict: (draft) => {
      const v = getData().versions[versionId]
      if (!v) return
      const ok = tryRun(() =>
        actions.addVersion(v.pieceId, {
          body: draft,
          sourceVersionId: v.id,
          name: conflictVersionName(v.name, 'この端末'),
        }),
      )
      if (ok)
        notify(
          `別の端末で「${v.name}」が書き換えられたため、入力中の本文を「${conflictVersionName(v.name, 'この端末')}」として残しました`,
        )
    },
  }
}

export function commitPiece(pieceId: string, patch: { subtitle?: string; label?: string }): void {
  const p = getData().pieces[pieceId]
  if (!p) return
  if ((patch.subtitle === undefined || patch.subtitle === p.subtitle) && (patch.label === undefined || patch.label === p.label))
    return
  attempt(() => actions.updatePiece(pieceId, patch))
}

/** 成功したかどうかを返す attempt（戻り値のない操作用） */
export function tryRun(fn: () => void): boolean {
  return (
    attempt(() => {
      fn()
      return true
    }) === true
  )
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

/** 文字を入力する欄か（読み取り専用の本文・ボタン・チェックボックス・スライダーなどは除く） */
export function isTextEntry(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && (el.type === 'text' || el.type === 'search')
  return false
}

/** いま selector の中の入力欄で入力中か（描画中に読む。フォーカスの変化をすぐに反映したい時に使う） */
export function isTypingWithin(selector: string): boolean {
  const a = typeof document === 'undefined' ? null : document.activeElement
  return a !== null && isTextEntry(a) && a.closest(selector) !== null
}

/** フォーカスが外れてから集中モードを解くまでの時間（タップの途中でレイアウトが動いて押し間違えないように） */
const FOCUS_EXIT_DELAY = 150
/** 画面の下からこれ以上の高さが隠れていれば、仮想キーボードが出ているとみなす */
const KEYBOARD_MIN_HEIGHT = 120

/** 入力中の欄がどこにあるか（area = 指定した範囲の中、elsewhere = それ以外、null = 入力していない） */
export type TypingPlace = 'area' | 'elsewhere' | null

/**
 * root の中の入力欄で文字を入力している間、その欄が area（セレクタ）の中か外かを返す。
 * 原稿画面では、スマホで本文・推敲メモ・稿の名前（ペインの中）を編集中に画面上部（ヘッダー・上部バー）を
 * 畳んで本文を広く見せる（集中モード）。
 * - ポインターを押している間は切り替えない（押した所と離した所で別の物を押したことにならないように）。
 * - フォーカスを残したまま仮想キーボードだけを閉じた（Android の戻るボタン等）時は、入力欄から
 *   フォーカスを外して元の表示に戻す。
 * - recheckKey が変わったら（編集中の欄が作り直される時など）判定し直す。
 */
export function useTypingFocus(root: RefObject<HTMLElement | null>, area: string, recheckKey: string): TypingPlace {
  const [place, setPlace] = useState<TypingPlace>(null)
  const recheck = useRef<() => void>(() => {})

  useEffect(() => {
    const el = root.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let pointerDown = false
    let waitingPointer = false
    const editing = (): TypingPlace => {
      const a = document.activeElement
      if (!a || !el.contains(a) || !isTextEntry(a)) return null
      return a.closest(area) ? 'area' : 'elsewhere'
    }
    const apply = () => {
      if (pointerDown) {
        waitingPointer = true
        return
      }
      setPlace(editing())
    }
    const schedule = (delay: number) => {
      clearTimeout(timer)
      timer = setTimeout(apply, delay)
    }
    const onFocusIn = () => schedule(0)
    const onFocusOut = () => schedule(FOCUS_EXIT_DELAY)
    const onPointerDown = () => {
      pointerDown = true
    }
    const onPointerUp = () => {
      pointerDown = false
      // click が届いた後で切り替える
      if (waitingPointer) {
        waitingPointer = false
        schedule(0)
      }
    }
    recheck.current = () => schedule(0)

    const vv = window.visualViewport
    let keyboard = false
    const onViewport = () => {
      if (!vv) return
      const open = window.innerHeight - vv.height * vv.scale > KEYBOARD_MIN_HEIGHT
      if (keyboard && !open && editing() !== null) (document.activeElement as HTMLElement).blur()
      keyboard = open
    }

    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    vv?.addEventListener('resize', onViewport)
    onViewport()
    apply()
    return () => {
      clearTimeout(timer)
      recheck.current = () => {}
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      vv?.removeEventListener('resize', onViewport)
    }
  }, [root, area])

  useEffect(() => {
    recheck.current()
  }, [recheckKey])

  return place
}

/** hold の間は、hold になる直前の値を返し続ける（キーボードの開閉で分割の向きが変わらないように） */
export function useHeldWhile<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value)
  if (!hold && held !== value) setHeld(value)
  return hold ? held : value
}
