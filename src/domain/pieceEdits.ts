// 原稿画面の「保存」: 画面の中だけで持っていた編集（本文・稿の名前・推敲メモ・話の題・見出し）をまとめて書き込む。
// 編集を始めた後で保存先が変わっていたら（同期で別の端末の編集が届いた等）:
// - 本文は上書きしない。この端末の本文を同じ話の新しい稿として残す（どちらの文章も消さない）
// - 稿の名前・推敲メモ・話の題・見出しは、この端末の編集を正とする
import { addVersion, updatePiece, updateVersion } from './storyOps'
import type { AppData, ID } from './types'

export type PieceEditField = 'body' | 'name' | 'note' | 'subtitle' | 'label'

export interface PieceEdit {
  /** version = 推敲バージョン（body / name / note）、piece = 話（subtitle / label） */
  target: 'version' | 'piece'
  id: ID
  field: PieceEditField
  /** 編集を始めた時の保存先の値 */
  base: string
  /** 画面で編集した値 */
  value: string
  /** 本文の編集なら、編集を始めた時の稿の名前（保存前に稿が削除されていた時の控えの名前に使う） */
  label?: string
}

export interface PieceEditOptions {
  /** この端末の本文を別の稿として残す時の名前（「第1稿」→「第1稿（競合: この端末での編集）」） */
  conflictName: (name: string) => string
}

export interface SavedConflict {
  /** changed = 別の操作で本文が書き換えられていた、deleted = 稿が削除されていた */
  reason: 'changed' | 'deleted'
  /** 書き換えられていた（または削除されていた）稿 */
  versionId: ID
  /** この端末の本文を残した新しい稿 */
  newVersionId: ID
  originalName: string
  name: string
}

export interface PieceEditsResult {
  conflicts: SavedConflict[]
  /** 保存先が無くなっていて書き込めなかった編集（稿の名前・推敲メモ・話の題など） */
  dropped: PieceEdit[]
}

/** 編集をまとめて書き込む。変わっていない項目は書かない（更新日時も動かさない） */
export function applyPieceEdits(
  data: AppData,
  pieceId: ID,
  edits: readonly PieceEdit[],
  opts: PieceEditOptions,
): { data: AppData; result: PieceEditsResult } {
  let d = data
  const conflicts: SavedConflict[] = []
  const dropped: PieceEdit[] = []

  const byVersion = new Map<ID, Partial<Record<PieceEditField, PieceEdit>>>()
  const byPiece = new Map<ID, Partial<Record<PieceEditField, PieceEdit>>>()
  for (const e of edits) {
    const map = e.target === 'version' ? byVersion : byPiece
    const fields = map.get(e.id) ?? {}
    fields[e.field] = e
    map.set(e.id, fields)
  }

  for (const [versionId, fields] of byVersion) {
    const v = d.versions[versionId]
    const { body, name, note } = fields
    if (!v) {
      // 保存する前に稿が削除されていた: 本文だけは新しい稿として残す
      if (body && d.pieces[pieceId] && body.value !== '') {
        const originalName = name?.value ?? body.label ?? ''
        const newName = opts.conflictName(originalName)
        const r = addVersion(d, pieceId, { body: body.value, name: newName })
        d = r.data
        conflicts.push({ reason: 'deleted', versionId, newVersionId: r.result, originalName, name: newName })
      } else if (body) dropped.push(body)
      if (name) dropped.push(name)
      if (note) dropped.push(note)
      continue
    }
    const patch: { name?: string; note?: string; body?: string } = {}
    if (name && name.value !== v.name) patch.name = name.value
    if (note && note.value !== v.note) patch.note = note.value
    let conflictBody: string | null = null
    if (body && body.value !== v.body) {
      if (v.body === body.base) patch.body = body.value
      else conflictBody = body.value
    }
    if (Object.keys(patch).length > 0) d = updateVersion(d, versionId, patch)
    if (conflictBody !== null) {
      const originalName = patch.name ?? v.name
      const newName = opts.conflictName(originalName)
      const r = addVersion(d, v.pieceId, { body: conflictBody, sourceVersionId: v.id, name: newName })
      d = r.data
      conflicts.push({ reason: 'changed', versionId, newVersionId: r.result, originalName, name: newName })
    }
  }

  for (const [id, fields] of byPiece) {
    const p = d.pieces[id]
    const { subtitle, label } = fields
    if (!p) {
      if (subtitle) dropped.push(subtitle)
      if (label) dropped.push(label)
      continue
    }
    const patch: { subtitle?: string; label?: string } = {}
    if (subtitle && subtitle.value !== p.subtitle) patch.subtitle = subtitle.value
    if (label) {
      // 第n話の表記は変更できない（特殊ブロックだけ）
      if (p.kind !== 'special') dropped.push(label)
      else if (label.value !== p.label) patch.label = label.value
    }
    if (Object.keys(patch).length > 0) d = updatePiece(d, id, patch)
  }

  return { data: d, result: { conflicts, dropped } }
}
