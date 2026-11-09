// 原稿画面の欄1つ分（採用原稿・推敲バージョン）の検索の動き。
// - 開くのはペインのヘッダーの「検索」か、その本文欄にフォーカスがある時の Ctrl+F（Mac は ⌘F）。ほかの所ではブラウザの検索のまま
// - 語を変えると、起点（欄のカーソルの位置か、今の一致）から後ろの最初の一致へ移る。Enter・次へで次、Shift+Enter・前へで前（端で反対の端へ）
// - 見つけた所は、検索窓にフォーカスを残したまま印（SearchHitLayer・差分の <mark>）で見せ、閉じた時（Esc・×）に本文欄で本当に選ぶ
// - 日本語入力の変換中は探さない（確定してから）。語と窓が開いているかは searchStore.ts（話を移っても残る）
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import type { EditorHub } from './editorHub'
import {
  buildSearchIndex,
  findHits,
  firstFrom,
  foldQuery,
  hitStatus,
  isFindShortcut,
  lastBefore,
  queryFromSelection,
  type Hit,
} from './fieldSearch'
import { useFieldSearchStore, type SearchSlot } from './searchStore'
import type { FieldKey } from './session'

export interface FieldSearchOptions {
  slot: SearchSlot
  /** 探す文字（textarea は保存していない編集も含めた本文、diff は差分の表示の文字をつないだもの。差分の計算中は null） */
  text: string | null
  kind: 'textarea' | 'diff'
  /** 本文欄を入れた .pw-body */
  bodyRef: RefObject<HTMLElement | null>
  /** 探す元が変わったら（稿・表示の種類）今の一致を外す */
  sourceKey: string
  /** 編集できる本文欄なら、その欄（見つけた所を選ぶ時に巻き戻しを区切る） */
  fieldKey?: FieldKey
  hub: EditorHub
}

export interface FieldSearch {
  slot: SearchSlot
  open: boolean
  /** 検索窓の語（変換中の文字も含む） */
  query: string
  /** 件数の欄（「3／12」など） */
  status: string
  /** 一致の数 */
  total: number
  /** 今の一致（元の本文・差分の表示の位置） */
  hit: Hit | null
  /** 見つけた所までスクロールさせる合図（増えたら動かす） */
  revealSeq: number
  inputRef: RefObject<HTMLInputElement | null>
  barId: string
  fieldKey?: FieldKey
  setQuery: (q: string, composing?: boolean) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onInputFocus: () => void
  next: () => void
  prev: () => void
  toggle: () => void
  /** 閉じる。toField なら本文欄にフォーカスを戻し、見つけた所を選ぶ */
  close: (o: { toField: boolean }) => void
  /** 本文欄の onKeyDown（Ctrl+F・⌘F で開く。開いている時の Esc で閉じる）。描き直しても変わらない関数 */
  onFieldKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

const NO_HITS = { hits: [] as Hit[], capped: false }

/** 原稿画面のポップオーバー（表示の設定・「…」）が開いているか（Esc はそちらを先に閉じる） */
const popoverOpen = () => document.querySelector('[data-back-close="esc"]') !== null

/** 差分の表示（読み取り専用の div）の中で、表示の文字の [start, end) を選ぶ */
export function selectDisplayRange(container: HTMLElement, start: number, end: number): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let pos = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0
    if (!started && start <= pos + len) {
      range.setStart(node, start - pos)
      started = true
    }
    if (started && end <= pos + len) {
      range.setEnd(node, end - pos)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    pos += len
  }
}

export function useFieldSearch({ slot, text, kind, bodyRef, sourceKey, fieldKey, hub }: FieldSearchOptions): FieldSearch {
  const open = useFieldSearchStore((s) => s[slot].open)
  const query = useFieldSearchStore((s) => s[slot].query)
  const setSlot = useFieldSearchStore((s) => s.set)
  const inputRef = useRef<HTMLInputElement>(null)
  const barId = useId()

  /** 実際に探す語（変換中は変えない） */
  const [committed, setCommitted] = useState(query)
  /** 起点（元の位置）と、今の一致を選んでいるか（今の一致は起点から後ろの最初の一致） */
  const [pos, setPos] = useState({ anchor: 0, active: false })
  const [revealSeq, setRevealSeq] = useState(0)
  /** 欄で打ちながら前へ・次へを押した時に、遅らせずに作り直した対応表の元の文字 */
  const [pinned, setPinned] = useState<string | null>(null)
  const composing = useRef(false)
  /** この欄に一度でもフォーカスしたか（していなければ先頭から探す） */
  const touched = useRef(false)

  // 稿・表示の種類が変わったら、今の一致を外して先頭から
  const [seenSource, setSeenSource] = useState(sourceKey)
  if (seenSource !== sourceKey) {
    setSeenSource(sourceKey)
    setPos({ anchor: 0, active: false })
  }
  useEffect(() => {
    touched.current = false
  }, [sourceKey])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.closest('.manuscript')) touched.current = true
    }
    body.addEventListener('focusin', onFocus)
    return () => body.removeEventListener('focusin', onFocus)
  }, [bodyRef])

  // 打っている間は対応表を作り直すのを遅らせる。窓を閉じている間は作らない
  const deferred = useDeferredValue(text)
  const source = !open || text === null ? null : pinned === text ? text : (deferred ?? text)
  const index = useMemo(() => (source === null ? null : buildSearchIndex(source)), [source])
  const needle = useMemo(() => foldQuery(committed), [committed])
  const result = useMemo(() => (index && needle ? findHits(index, needle) : NO_HITS), [index, needle])
  const current = pos.active ? firstFrom(result.hits, pos.anchor) : null
  const hit = current === null ? null : result.hits[current]
  const pending = open && kind === 'diff' && text === null
  const status = hitStatus({ query: committed, total: result.hits.length, current, capped: result.capped, pending })

  const fieldEl = () => bodyRef.current?.querySelector<HTMLElement>('.manuscript') ?? null

  const commit = (q: string) => {
    setCommitted(q)
    setPos((p) => ({ anchor: p.anchor, active: q !== '' }))
    setRevealSeq((n) => n + 1)
  }

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const focusInput = () => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }

  /** 前へ・次へ */
  const step = (dir: 1 | -1) => {
    let hits = result.hits
    // 欄で打ちながら押した時（前へ・次へはフォーカスを奪わない）は、今の本文で作り直してから選ぶ
    const el = fieldEl()
    if (text !== null && source !== null && source !== text && el && document.activeElement === el) {
      hits = findHits(buildSearchIndex(text), needle).hits
      setPinned(text)
    }
    if (hits.length === 0) return
    const cur = pos.active ? firstFrom(hits, pos.anchor) : null
    const idx =
      cur === null
        ? dir > 0
          ? firstFrom(hits, pos.anchor)!
          : lastBefore(hits, pos.anchor)!
        : (cur + dir + hits.length) % hits.length
    setPos({ anchor: hits[idx].start, active: true })
    setRevealSeq((n) => n + 1)
  }

  /** ヘッダーの「検索」で開く（iPhone でキーボードが出るよう、描いてから同じタップの中でフォーカスする） */
  const openFromButton = () => {
    const el = fieldEl()
    const anchor = touched.current && el instanceof HTMLTextAreaElement ? el.selectionStart : 0
    flushSync(() => {
      setSlot(slot, { open: true })
      setPos({ anchor, active: false })
    })
    focusInput()
  }

  /** 本文欄の Ctrl+F・⌘F で開く。選んでいる文字があれば、それを語にする */
  const openFromField = (el: HTMLElement) => {
    let q: string | null = null
    let anchor = 0
    if (el instanceof HTMLTextAreaElement) {
      q = queryFromSelection(el.value, el.selectionStart, el.selectionEnd)
      anchor = Math.min(el.selectionStart, el.selectionEnd)
    } else {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const t = sel.toString()
        q = queryFromSelection(t, 0, t.length)
      }
    }
    touched.current = true
    flushSync(() => {
      if (q !== null) {
        setSlot(slot, { open: true, query: q })
        setCommitted(q)
        setPos({ anchor, active: true })
        setRevealSeq((n) => n + 1)
      } else {
        setSlot(slot, { open: true })
        setPos({ anchor, active: false })
      }
    })
    focusInput()
  }

  const close = ({ toField }: { toField: boolean }) => {
    const h = hit
    const el = fieldEl()
    flushSync(() => {
      setSlot(slot, { open: false })
      setPos((p) => ({ anchor: p.anchor, active: false }))
    })
    if (!toField || !el) return
    el.focus({ preventScroll: true })
    if (!h) return
    if (el instanceof HTMLTextAreaElement) {
      el.setSelectionRange(h.start, h.end)
      if (fieldKey) hub.session.seal(fieldKey)
    } else selectDisplayRange(el, h.start, h.end)
  }

  const onFieldKeyDownNow = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (isFindShortcut(e)) {
      e.preventDefault()
      openFromField(e.currentTarget)
      return
    }
    if (e.key === 'Escape' && open && !e.defaultPrevented && !popoverOpen()) close({ toField: false })
  }
  const keyRef = useRef(onFieldKeyDownNow)
  keyRef.current = onFieldKeyDownNow
  const onFieldKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => keyRef.current(e), [])

  return {
    slot,
    open,
    query,
    status,
    total: result.hits.length,
    hit: open ? hit : null,
    revealSeq,
    inputRef,
    barId,
    fieldKey,
    setQuery: (q, composingNow = false) => {
      setSlot(slot, { query: q })
      if (!composing.current && !composingNow) commit(q)
    },
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: () => {
      composing.current = false
      // Safari では確定の input イベントが compositionend の後に届くので、それを待ってから探す
      setTimeout(() => {
        if (mounted.current && !composing.current) commit(useFieldSearchStore.getState()[slot].query)
      }, 0)
    },
    onInputFocus: () => hub.blurTarget(),
    next: () => step(1),
    prev: () => step(-1),
    toggle: () => (open ? close({ toField: false }) : openFromButton()),
    close,
    onFieldKeyDown,
  }
}
