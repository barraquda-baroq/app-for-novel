// 原稿画面の編集セッション。
// 本文・稿の名前・推敲メモ・話の題・見出しの編集は、「保存」を押すまでストアに入れない（＝ほかの端末にも送らない）。
// 画面の中だけで、項目ごとに「編集を始めた時の保存先の値（base）」と「いまの値」を持ち、保存の時に
// base と保存先を比べて、別の端末の編集が届いていないかを確かめる（src/domain/pieceEdits.ts）。
// 巻き戻し／進むの履歴（src/features/piece/history.ts）も項目ごとにここで持つ。
import type { PieceEdit, PieceEditField } from '../../domain/pieceEdits'
import type { ID } from '../../domain/types'
import { EMPTY_HISTORY, record, redo, seal, undo, type EditKind, type History, type Sel, type Splice } from './history'

/** 編集する項目の名前。version:<稿のID>:body のような形 */
export type FieldKey = string

export type VersionFieldName = 'body' | 'name' | 'note'
export type PieceFieldName = 'subtitle' | 'label'

export function versionField(versionId: ID, field: VersionFieldName): FieldKey {
  return `version:${versionId}:${field}`
}

export function pieceField(pieceId: ID, field: PieceFieldName): FieldKey {
  return `piece:${pieceId}:${field}`
}

const VERSION_FIELDS: readonly string[] = ['body', 'name', 'note']
const PIECE_FIELDS: readonly string[] = ['subtitle', 'label']

export function parseFieldKey(key: FieldKey): { target: 'version' | 'piece'; id: ID; field: PieceEditField } | null {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first <= 0 || last <= first + 1) return null
  const target = key.slice(0, first)
  const id = key.slice(first + 1, last)
  const field = key.slice(last + 1)
  if (target === 'version' && VERSION_FIELDS.includes(field)) return { target, id, field: field as PieceEditField }
  if (target === 'piece' && PIECE_FIELDS.includes(field)) return { target, id, field: field as PieceEditField }
  return null
}

/** 保存していない編集 */
export interface FieldEdit {
  /** 編集を始めた時の保存先の値 */
  base: string
  value: string
  /** 本文・推敲メモなら、編集を始めた時の稿の名前（保存前に稿が削除されていた時の控えの名前） */
  label?: string
}

export interface FieldState {
  /** 保存していない編集（なければ保存先の値をそのまま表示する） */
  edit: FieldEdit | null
  history: History
  /** history が前提にしている今の値（これと表示が違えば、履歴は古いので捨てる） */
  current: string | null
}

export interface InputChange {
  /** 変更前の値（省略すると今の表示） */
  before?: string
  value: string
  selBefore: Sel
  selAfter: Sel
  inputType?: string
  kind?: EditKind
  splice?: Splice
  at: number
}

export interface Restored {
  value: string
  selection: Sel
}

export class EditSession {
  private readonly fields = new Map<FieldKey, FieldState>()
  private readonly listeners = new Set<() => void>()
  private readonly dirtyKeys = new Set<FieldKey>()
  private nameRev = 0
  /** 端末内の控え（src/features/piece/crashDraft.ts）をこのセッションが書いた・復元したか */
  draftOwned = false
  /** 控えの持ち主の印（同じ話を別のタブで開いている時に、そのタブの控えを「前回の編集」と取り違えない） */
  readonly owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  constructor(readonly pieceId: ID) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn()
  }

  field(key: FieldKey): FieldState | undefined {
    return this.fields.get(key)
  }

  isDirty = (): boolean => this.dirtyKeys.size > 0

  /** 稿の名前のどれかが変わるたびに増える（比較の選択肢に編集中の名前を出すため） */
  namesRevision = (): number => this.nameRev

  /** 画面に出す値（保存していない編集があればそれ、なければ保存先の値） */
  display(key: FieldKey, stored: string): string {
    return this.fields.get(key)?.edit?.value ?? stored
  }

  edits(): Record<FieldKey, FieldEdit> {
    const out: Record<FieldKey, FieldEdit> = {}
    for (const k of this.dirtyKeys) {
      const e = this.fields.get(k)?.edit
      if (e) out[k] = e
    }
    return out
  }

  /** 保存する編集の一覧 */
  pendingEdits(): PieceEdit[] {
    const out: PieceEdit[] = []
    for (const [key, edit] of Object.entries(this.edits())) {
      const f = parseFieldKey(key)
      if (!f) continue
      out.push({ ...f, base: edit.base, value: edit.value, ...(edit.label !== undefined ? { label: edit.label } : {}) })
    }
    return out
  }

  private put(key: FieldKey, next: FieldState): void {
    const prev = this.fields.get(key)
    this.fields.set(key, next)
    if (next.edit) this.dirtyKeys.add(key)
    else this.dirtyKeys.delete(key)
    if (key.endsWith(':name') && (prev?.edit?.value ?? null) !== (next.edit?.value ?? null)) this.nameRev += 1
    this.emit()
  }

  private editFor(prev: FieldEdit | null, stored: string, value: string, label?: string): FieldEdit | null {
    const base = prev ? prev.base : stored
    // 保存先の値と同じになったら、編集していないのと同じ。
    // 編集中に保存先が変わっていたら（同期で別の端末の編集が届いた等）、base に戻しても編集のまま
    // （保存先の値に切り替えると、表示と履歴がずれて、打った文字を「進む」で取り戻せなくなる）
    if (value === stored) return null
    const l = prev ? prev.label : label
    return l !== undefined ? { base, value, label: l } : { base, value }
  }

  /** 入力・削除・貼り付け・記号の挿入など（履歴に積む） */
  change(key: FieldKey, stored: string, c: InputChange, label?: string): void {
    const state = this.fields.get(key)
    const before = c.before ?? this.display(key, stored)
    if (before === c.value) return
    // 保存先の値が別の操作で変わって表示が変わっていたら、それまでの履歴は当てはまらない
    const base = state && state.current === before ? state.history : EMPTY_HISTORY
    const history = record(base, {
      before,
      after: c.value,
      selBefore: c.selBefore,
      selAfter: c.selAfter,
      inputType: c.inputType,
      kind: c.kind,
      splice: c.splice,
      at: c.at,
    })
    this.put(key, { edit: this.editFor(state?.edit ?? null, stored, c.value, label), history, current: c.value })
  }

  /** 値だけを変える（日本語入力の変換中。履歴には確定した時に change で積む） */
  setValue(key: FieldKey, stored: string, value: string, label?: string): void {
    const state = this.fields.get(key)
    if (this.display(key, stored) === value) return
    this.put(key, {
      edit: this.editFor(state?.edit ?? null, stored, value, label),
      history: state?.history ?? EMPTY_HISTORY,
      current: state?.current ?? null,
    })
  }

  /** 次の入力を新しい手にする */
  seal(key: FieldKey): void {
    const state = this.fields.get(key)
    if (!state || !state.history.open) return
    this.fields.set(key, { ...state, history: seal(state.history) })
  }

  canUndo(key: FieldKey): boolean {
    return (this.fields.get(key)?.history.undo.length ?? 0) > 0
  }

  canRedo(key: FieldKey): boolean {
    return (this.fields.get(key)?.history.redo.length ?? 0) > 0
  }

  undo(key: FieldKey, stored: string): Restored | null {
    return this.travel(key, stored, undo)
  }

  redo(key: FieldKey, stored: string): Restored | null {
    return this.travel(key, stored, redo)
  }

  private travel(
    key: FieldKey,
    stored: string,
    fn: (h: History, value: string) => { history: History; value: string; selection: Sel } | null,
  ): Restored | null {
    const state = this.fields.get(key)
    if (!state) return null
    const cur = this.display(key, stored)
    if (state.current !== cur) {
      // 表示が履歴の前提と違う（保存先の値が変わった）: 古い履歴は捨てる
      if (state.history.undo.length || state.history.redo.length)
        this.put(key, { edit: state.edit, history: EMPTY_HISTORY, current: null })
      return null
    }
    const r = fn(state.history, cur)
    if (!r) return null
    this.put(key, { edit: this.editFor(state.edit, stored, r.value), history: r.history, current: r.value })
    return { value: r.value, selection: r.selection }
  }

  /** 保存していない編集をすべて捨てる（履歴も） */
  discard(): void {
    if (this.fields.size === 0) return
    const hadNames = [...this.dirtyKeys].some((k) => k.endsWith(':name'))
    this.fields.clear()
    this.dirtyKeys.clear()
    if (hadNames) this.nameRev += 1
    this.emit()
  }

  /**
   * 保存した後: 保存した値のままの項目は編集なしにする（履歴は残す。保存先の値と表示が同じなので続けて戻せる）。
   * resetHistory の項目（本文が競合して保存先の値を表示し直す項目）は履歴も捨てる。
   */
  markSaved(saved: readonly PieceEdit[], resetHistory: ReadonlySet<FieldKey> = new Set()): void {
    let changed = false
    for (const e of saved) {
      const key =
        e.target === 'version' ? versionField(e.id, e.field as VersionFieldName) : pieceField(e.id, e.field as PieceFieldName)
      const state = this.fields.get(key)
      if (!state?.edit || state.edit.value !== e.value) continue
      this.fields.set(
        key,
        resetHistory.has(key) ? { edit: null, history: EMPTY_HISTORY, current: null } : { ...state, edit: null },
      )
      this.dirtyKeys.delete(key)
      if (key.endsWith(':name')) this.nameRev += 1
      changed = true
    }
    if (changed) this.emit()
  }

  /** 端末内の控えから編集を戻す（履歴は持たない） */
  restore(edits: Record<FieldKey, FieldEdit>): void {
    const keys = Object.keys(edits)
    if (keys.length === 0) return
    for (const key of keys) {
      if (!parseFieldKey(key)) continue
      const e = edits[key]
      this.fields.set(key, { edit: { ...e }, history: EMPTY_HISTORY, current: null })
      this.dirtyKeys.add(key)
      if (key.endsWith(':name')) this.nameRev += 1
    }
    this.emit()
  }
}
