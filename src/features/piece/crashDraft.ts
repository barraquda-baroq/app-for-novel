// 原稿画面で保存していない編集の控え（端末内の localStorage だけ。同期しない）。
// アプリが落ちた・閉じた時のために、編集のたびに少し待ってから（と、裏に回る・閉じる時に）話ごとに控え、
// 次にその話を開いた時に「復元しますか？」と聞く。保存・破棄したら消す。
// 控えには書いた画面（編集セッション）の印 owner を入れ、その画面が開いている間は Web Locks のロックを持つ。
// 同じ話を別のタブで開いた時、まだ開いているタブの控えは「前回保存されなかった編集」として聞かない。
import { textHash } from '../../domain/text'
import { parseFieldKey, type FieldEdit, type FieldKey } from './session'

const PREFIX = 'novel-studio:edit:'

export const draftKey = (pieceId: string) => `${PREFIX}${pieceId}`

/** 控えの1項目。容量が足りない時は、編集を始めた時の値（base）を指紋（baseHash）だけにする */
export interface StoredEdit {
  value: string
  base?: string
  baseHash?: string
  label?: string
}

export interface CrashDraft {
  v: 1
  pieceId: string
  /** 控えた時刻 */
  at: number
  /** 書いた画面（編集セッション）の印。古い控えには無い */
  owner?: string
  /**
   * 幕の控え: 幕の属する話と、控えた時に幕の前にあった幕（先頭なら null）。幕がつないだ・セパレートを解除したことで
   * 無くなった後も、残った幕・話を開いた時に「新しい稿として残す」か聞けるように（古い控え・幕でない話の控えには無い）
   */
  parentId?: string
  prevId?: string | null
  edits: Record<FieldKey, StoredEdit>
}

/** 控えに入れる、編集している幕の場所（幕でなければ空） */
export interface DraftContext {
  parentId?: string
  prevId?: string | null
}

const OWNER_LOCK_PREFIX = 'novel-studio:edit-owner:'

export const ownerLockName = (owner: string) => `${OWNER_LOCK_PREFIX}${owner}`

/**
 * 画面が開いている間、持ち主のロックを持つ（返す関数で手放す）。
 * タブを閉じた・落ちた時はブラウザが手放すので、生きているかの合図に使える（Web Locks が無ければ何もしない）。
 */
export function holdEditOwner(owner: string): () => void {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return () => {}
  let release: (() => void) | null = null
  let done = false
  locks
    .request(
      ownerLockName(owner),
      () =>
        new Promise<void>((resolve) => {
          if (done) resolve()
          else release = resolve
        }),
    )
    .catch(() => undefined)
  return () => {
    done = true
    release?.()
  }
}

/** owner の画面（別のタブ・ウィンドウ）がまだ開いているか。分からない時は false */
export async function editOwnerAlive(owner: string): Promise<boolean> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks?.query) return false
  try {
    const q = await locks.query()
    const name = ownerLockName(owner)
    return Boolean(q.held?.some((l) => l.name === name))
  } catch {
    return false
  }
}

function build(
  pieceId: string,
  edits: Record<FieldKey, FieldEdit>,
  owner: string | undefined,
  at: number,
  hashBase: boolean,
  context: DraftContext,
): CrashDraft {
  const out: Record<FieldKey, StoredEdit> = {}
  for (const [key, e] of Object.entries(edits)) {
    const item: StoredEdit = { value: e.value }
    if (hashBase && e.base.length > 200) item.baseHash = textHash(e.base)
    else item.base = e.base
    if (e.label !== undefined) item.label = e.label
    out[key] = item
  }
  const draft: CrashDraft = { v: 1, pieceId, at, edits: out }
  if (owner) draft.owner = owner
  if (context.parentId) {
    draft.parentId = context.parentId
    draft.prevId = context.prevId ?? null
  }
  return draft
}

/** 控えを書く（書けたら true）。編集がなければ消す。owner は書いた画面の印、context は幕の場所 */
export function writeCrashDraft(
  pieceId: string,
  edits: Record<FieldKey, FieldEdit>,
  owner?: string,
  at = Date.now(),
  context: DraftContext = {},
): boolean {
  if (Object.keys(edits).length === 0) {
    removeCrashDraft(pieceId, owner)
    return true
  }
  try {
    localStorage.setItem(draftKey(pieceId), JSON.stringify(build(pieceId, edits, owner, at, false, context)))
    return true
  } catch {
    // 容量不足: 長い base は指紋だけにして、もう一度
    try {
      localStorage.setItem(draftKey(pieceId), JSON.stringify(build(pieceId, edits, owner, at, true, context)))
      return true
    } catch (e) {
      console.warn('保存していない編集を端末内に控えられませんでした', e)
      return false
    }
  }
}

/**
 * 控えを消す。owner を渡した時は、その画面が書いた控え（か、持ち主の印の無い古い控え）だけを消す
 * （同じ話を開いている別のタブが書き直した控えは消さない）。
 */
export function removeCrashDraft(pieceId: string, owner?: string): void {
  try {
    if (owner !== undefined) {
      const raw = localStorage.getItem(draftKey(pieceId))
      if (!raw) return
      let stored: unknown
      try {
        stored = (JSON.parse(raw) as { owner?: unknown } | null)?.owner
      } catch {
        stored = undefined
      }
      if (typeof stored === 'string' && stored !== owner) return
    }
    localStorage.removeItem(draftKey(pieceId))
  } catch {
    /* noop */
  }
}

/** 控えを読む（無い・壊れている時は null。壊れた控えは消す） */
export function readCrashDraft(pieceId: string): CrashDraft | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(draftKey(pieceId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<CrashDraft>
    if (d && d.v === 1 && d.pieceId === pieceId && typeof d.at === 'number' && d.edits && typeof d.edits === 'object') {
      const edits: Record<FieldKey, StoredEdit> = {}
      for (const [key, e] of Object.entries(d.edits)) {
        if (!parseFieldKey(key) || !e || typeof e.value !== 'string') continue
        if (typeof e.base !== 'string' && typeof e.baseHash !== 'string') continue
        edits[key] = e
      }
      const draft: CrashDraft = { v: 1, pieceId, at: d.at, edits }
      if (typeof d.owner === 'string') draft.owner = d.owner
      if (typeof d.parentId === 'string') {
        draft.parentId = d.parentId
        draft.prevId = typeof d.prevId === 'string' ? d.prevId : null
      }
      return draft
    }
  } catch {
    /* 壊れている */
  }
  removeCrashDraft(pieceId)
  return null
}

/**
 * 控えを、いまの保存先の値と照らして復元する編集にする。
 * - 保存先の値と同じになっている項目（別のタブで保存した等）は復元しない
 * - 稿が無くなった項目（本文・稿の名前・推敲メモ）も復元する（保存すると、この端末の編集を新しい稿として残す）。
 *   話の題・見出しは話が無くなっていれば復元しない
 * - base が指紋だけの時は、保存先の値の指紋と同じなら保存先の値を base にし、違えば「変わった」ことにする
 * readStored は項目の保存先の値（無くなっていれば undefined）を返す。
 */
export function resolveCrashDraft(
  draft: CrashDraft,
  readStored: (key: FieldKey) => string | undefined,
): Record<FieldKey, FieldEdit> {
  const out: Record<FieldKey, FieldEdit> = {}
  for (const [key, e] of Object.entries(draft.edits)) {
    const f = parseFieldKey(key)
    if (!f) continue
    const stored = readStored(key)
    if (stored === undefined && f.target === 'piece') continue
    if (stored !== undefined && e.value === stored) continue
    let base: string
    if (typeof e.base === 'string') base = e.base
    else if (stored !== undefined && e.baseHash === textHash(stored)) base = stored
    // 編集を始めた後で保存先が変わった（保存の時に別の稿として残す）
    else base = `\u0000${e.baseHash ?? ''}`
    if (e.value === base) continue
    out[key] = e.label !== undefined ? { base, value: e.value, label: e.label } : { base, value: e.value }
  }
  return out
}

/** 端末内にあるすべての控え（壊れたものは消す） */
export function listCrashDrafts(): CrashDraft[] {
  const ids: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length))
    }
  } catch {
    return []
  }
  return ids.map((id) => readCrashDraft(id)).filter((d): d is CrashDraft => d !== null)
}

/**
 * 話 parentId の幕だった控えのうち、幕がもう無いもの（つないだ・セパレートを解除したことで無くなった幕の、保存されなかった編集）。
 * 古い順に返す
 */
export function findOrphanDrafts(pieces: Readonly<Record<string, unknown>>, parentId: string): CrashDraft[] {
  return listCrashDrafts()
    .filter((d) => d.parentId === parentId && !pieces[d.pieceId])
    .sort((a, b) => a.at - b.at)
}
