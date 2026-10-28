// 巻き戻し／進むの履歴（入力欄ごと、30手）。
// 値を書き換えるとブラウザ標準の「元に戻す」は使えなくなるので、自前で持つ。
// 1手は「start の位置で removed を inserted に置き換えた」という差分で持つ（長い原稿でも全文を何十個も持たない）。
// 続けて打った文字は1手にまとめる。1秒以上の間・改行・記号の挿入・カーソルの移動で区切る。
// 日本語入力（IME）は変換を確定した時に1手になる。

export interface Sel {
  start: number
  end: number
}

/** 変更の種類。type と delete だけが、続けて行うと1手にまとまる */
export type EditKind = 'type' | 'delete' | 'newline' | 'paste' | 'cut' | 'drop' | 'symbol' | 'ime' | 'other'

export interface Splice {
  start: number
  removed: string
  inserted: string
}

export interface Step extends Splice {
  /** 変更前の選択範囲（巻き戻した時に戻す） */
  selBefore: Sel
  /** 変更後の選択範囲（進めた時に戻す） */
  selAfter: Sel
  kind: EditKind
  /** 最後にまとめた時刻 */
  at: number
}

export interface History {
  undo: readonly Step[]
  redo: readonly Step[]
  /** 次の変更を最後の手にまとめてよいか（区切った後は false） */
  open: boolean
}

export const HISTORY_LIMIT = 30
/** これより間が空いたら、続けて打っていても別の手にする */
export const COALESCE_MS = 1000

export const EMPTY_HISTORY: History = { undo: [], redo: [], open: false }

/**
 * before → after の変更を1か所の置き換えとして求める（同じなら null）。
 * caretAfter（変更後のカーソル位置）を渡すと、同じ文字が並ぶ所でもカーソルの手前に挿入したものとして求める。
 * selBefore（変更前の選択範囲）も渡すと、入力・削除・貼り付けはそれだけで正確に求められる。
 */
export function spliceOf(before: string, after: string, caretAfter?: number, selBefore?: Sel): Splice | null {
  if (before === after) return null
  if (caretAfter !== undefined && selBefore) {
    // 入力・削除・貼り付け・確定: 変更は「変更前の選択範囲（か、削除ならカーソルまで）」から変更後のカーソルまで
    const start = Math.min(selBefore.start, caretAfter)
    const tail = after.length - caretAfter
    const removedEnd = before.length - tail
    if (
      start >= 0 &&
      removedEnd >= start &&
      caretAfter >= start &&
      before.slice(0, start) === after.slice(0, start) &&
      before.slice(removedEnd) === after.slice(caretAfter)
    ) {
      // 置き換えた範囲の先頭が同じ文字なら詰める（カーソルの手前で終わることは変えない）
      let s = start
      while (s < removedEnd && s < caretAfter && before.charCodeAt(s) === after.charCodeAt(s)) s++
      return { start: s, removed: before.slice(s, removedEnd), inserted: after.slice(s, caretAfter) }
    }
  }
  const min = Math.min(before.length, after.length)
  let p = 0
  while (p < min && before.charCodeAt(p) === after.charCodeAt(p)) p++
  let s = 0
  while (s < min && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++
  if (caretAfter !== undefined && caretAfter >= 0 && caretAfter <= after.length && after.length - caretAfter <= s) {
    // カーソルの手前で終わる置き換えとして求める（「あああ」の途中に「あ」を足した時など）
    const delta = after.length - before.length
    const start = Math.min(p, caretAfter, caretAfter - delta)
    const insertedLen = caretAfter - start
    const removedLen = insertedLen - delta
    if (start >= 0 && removedLen >= 0) {
      return {
        start,
        removed: before.slice(start, start + removedLen),
        inserted: after.slice(start, caretAfter),
      }
    }
  }
  const suffix = Math.min(s, min - p)
  return { start: p, removed: before.slice(p, before.length - suffix), inserted: after.slice(p, after.length - suffix) }
}

/** input イベントの inputType から変更の種類を決める */
export function kindOfInput(inputType: string | undefined, splice: Splice): EditKind {
  switch (inputType) {
    case 'insertLineBreak':
    case 'insertParagraph':
      return 'newline'
    case 'insertFromPaste':
    case 'insertFromPasteAsQuotation':
    case 'insertFromYank':
      return 'paste'
    case 'deleteByCut':
      return 'cut'
    case 'insertFromDrop':
    case 'deleteByDrag':
      return 'drop'
    case 'insertReplacementText':
      return 'other'
    case 'insertCompositionText':
    case 'insertFromComposition':
      return 'ime'
    default:
      break
  }
  if (splice.inserted.includes('\n')) return 'newline'
  if (inputType?.startsWith('delete')) return 'delete'
  if (inputType === 'insertText') return 'type'
  // inputType が分からない時は差分から推定する
  if (splice.inserted === '') return 'delete'
  if (splice.removed === '' && [...splice.inserted].length === 1) return 'type'
  return 'other'
}

/** 最後の手に続けてまとめられるか */
function canMerge(last: Step, next: Step): boolean {
  if (next.at - last.at > COALESCE_MS) return false
  if (last.kind !== next.kind) return false
  if (next.kind === 'type') {
    // 打った文字の直後に続けて打った（改行は含まない）
    return next.removed === '' && next.start === last.start + last.inserted.length && !next.inserted.includes('\n')
  }
  if (next.kind === 'delete') {
    if (last.inserted !== '' || next.inserted !== '') return false
    // Backspace を続けた（手前へ）／Delete を続けた（同じ位置）
    return next.start + next.removed.length === last.start || next.start === last.start
  }
  return false
}

function merge(last: Step, next: Step): Step {
  if (next.kind === 'type') {
    return { ...last, inserted: last.inserted + next.inserted, selAfter: next.selAfter, at: next.at }
  }
  // delete
  if (next.start + next.removed.length === last.start && next.start !== last.start) {
    return { ...last, start: next.start, removed: next.removed + last.removed, selAfter: next.selAfter, at: next.at }
  }
  return { ...last, removed: last.removed + next.removed, selAfter: next.selAfter, at: next.at }
}

/** まとめてよい種類（これ以外は1回で1手になり、次の変更とはまとめない） */
const MERGEABLE: ReadonlySet<EditKind> = new Set(['type', 'delete'])

export interface Change {
  before: string
  after: string
  selBefore: Sel
  selAfter: Sel
  /** 分かれば input イベントの inputType。kind を直接指定することもできる */
  inputType?: string
  kind?: EditKind
  /** 置き換えた位置が分かっている時（記号の挿入など）。省略すると before と after から求める */
  splice?: Splice
  at: number
}

/** 変更を履歴に積む（進む の履歴は消える）。値が変わっていなければそのまま返す */
export function record(h: History, c: Change): History {
  if (c.before === c.after) return h
  const splice = c.splice ?? spliceOf(c.before, c.after, c.selAfter.end, c.selBefore)
  if (!splice) return h
  const kind = c.kind ?? kindOfInput(c.inputType, splice)
  const step: Step = { ...splice, selBefore: c.selBefore, selAfter: c.selAfter, kind, at: c.at }
  const last = h.undo[h.undo.length - 1]
  if (h.open && last && canMerge(last, step)) {
    return { undo: [...h.undo.slice(0, -1), merge(last, step)], redo: [], open: true }
  }
  const undo = [...h.undo, step]
  if (undo.length > HISTORY_LIMIT) undo.splice(0, undo.length - HISTORY_LIMIT)
  return { undo, redo: [], open: MERGEABLE.has(kind) }
}

/** 次の変更を新しい手にする（カーソルを動かした・フォーカスし直した時など） */
export function seal(h: History): History {
  return h.open ? { ...h, open: false } : h
}

export interface Restored {
  history: History
  value: string
  selection: Sel
}

function clampSel(sel: Sel, length: number): Sel {
  const start = Math.max(0, Math.min(sel.start, length))
  return { start, end: Math.max(start, Math.min(sel.end, length)) }
}

/** 1手戻す。value は今の値。戻せる手がなければ null */
export function undo(h: History, value: string): Restored | null {
  const step = h.undo[h.undo.length - 1]
  if (!step) return null
  const next = value.slice(0, step.start) + step.removed + value.slice(step.start + step.inserted.length)
  return {
    history: { undo: h.undo.slice(0, -1), redo: [...h.redo, step], open: false },
    value: next,
    selection: clampSel(step.selBefore, next.length),
  }
}

/** 戻した手をやり直す。進める手がなければ null */
export function redo(h: History, value: string): Restored | null {
  const step = h.redo[h.redo.length - 1]
  if (!step) return null
  const next = value.slice(0, step.start) + step.inserted + value.slice(step.start + step.removed.length)
  return {
    history: { undo: [...h.undo, step], redo: h.redo.slice(0, -1), open: false },
    value: next,
    selection: clampSel(step.selAfter, next.length),
  }
}
