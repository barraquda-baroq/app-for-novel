// 本編（章・第n話・特殊ブロック・推敲バージョン）の更新操作。
// すべて純粋関数で、新しい AppData を返す。仕様違反は DomainError を投げる。
import {
  canDeletePiece,
  chaptersOf,
  effectiveNumbering,
  episodeLabel,
  episodeNumbers,
  flatten,
  lastEpisodeInScope,
  locatePiece,
  pieceFullLabel,
} from './structure'
import { Tx, transact } from './tx'
import { DomainError, type AppData, type Chapter, type ID, type NodeRef, type Piece, type Slot, type Title, type Version } from './types'
import { insertAt, newId, now, removeValue } from './util'

// ---------- 内部ヘルパー ----------

function requireTitle(tx: Tx, titleId: ID): Title {
  const t = tx.get('titles', titleId)
  if (!t) throw new DomainError('タイトルが見つかりません')
  return t
}

function requirePiece(tx: Tx, pieceId: ID): Piece {
  const p = tx.get('pieces', pieceId)
  if (!p) throw new DomainError('話が見つかりません')
  return p
}

function requireChapter(tx: Tx, chapterId: ID): Chapter {
  const c = tx.get('chapters', chapterId)
  if (!c) throw new DomainError('章が見つかりません')
  return c
}

function touchTitle(tx: Tx, titleId: ID, patch: Partial<Title> = {}): void {
  const t = requireTitle(tx, titleId)
  tx.put('titles', { ...t, ...patch, updatedAt: now() })
}

/** piece を現在のコンテナから外す（レコードは消さない） */
function detachPiece(tx: Tx, pieceId: ID): Slot | null {
  const slot = locatePiece(tx.data, pieceId)
  if (!slot) return null
  const piece = requirePiece(tx, pieceId)
  if (slot.chapterId) {
    const ch = requireChapter(tx, slot.chapterId)
    tx.put('chapters', { ...ch, pieceIds: removeValue(ch.pieceIds, pieceId), updatedAt: now() })
  } else {
    const t = requireTitle(tx, piece.titleId)
    touchTitle(tx, t.id, {
      structure: t.structure.filter((n) => !(n.type === 'piece' && n.id === pieceId)),
    })
  }
  return slot
}

/** piece を指定位置に差し込む */
function attachPiece(tx: Tx, titleId: ID, pieceId: ID, slot: Slot): void {
  if (slot.chapterId) {
    const ch = requireChapter(tx, slot.chapterId)
    if (ch.titleId !== titleId) throw new DomainError('別タイトルの章には移動できません')
    tx.put('chapters', { ...ch, pieceIds: insertAt(ch.pieceIds, slot.index, pieceId), updatedAt: now() })
  } else {
    const t = requireTitle(tx, titleId)
    touchTitle(tx, titleId, { structure: insertAt<NodeRef>(t.structure, slot.index, { type: 'piece', id: pieceId }) })
  }
}

function makeVersion(piece: Piece, seq: number, body = '', sourceVersionId: ID | null = null, name?: string): Version {
  const ts = now()
  return {
    id: newId(),
    pieceId: piece.id,
    titleId: piece.titleId,
    name: name ?? `第${seq}稿`,
    body,
    note: '',
    sourceVersionId,
    createdAt: ts,
    updatedAt: ts,
  }
}

function createPieceRecord(titleId: ID, kind: Piece['kind'], label: string): { piece: Piece; version: Version } {
  const ts = now()
  const base: Piece = {
    id: newId(),
    titleId,
    kind,
    label,
    subtitle: '',
    activeVersionId: null,
    versionIds: [],
    versionSeq: 1,
    createdAt: ts,
    updatedAt: ts,
  }
  const version = makeVersion(base, 1)
  const piece: Piece = { ...base, activeVersionId: version.id, versionIds: [version.id] }
  return { piece, version }
}

/** コンテナ内で最後の episode の直後。episode がなければコンテナの末尾 */
function slotAfterLastEpisodeIn(data: AppData, titleId: ID, chapterId: ID | null): Slot {
  if (chapterId) {
    const ch = data.chapters[chapterId]
    let idx = -1
    ch.pieceIds.forEach((pid, i) => {
      if (data.pieces[pid]?.kind === 'episode') idx = i
    })
    return { chapterId, index: idx >= 0 ? idx + 1 : ch.pieceIds.length }
  }
  const title = data.titles[titleId]
  let idx = -1
  title.structure.forEach((n, i) => {
    if (n.type === 'piece' && data.pieces[n.id]?.kind === 'episode') idx = i
  })
  return { chapterId: null, index: idx >= 0 ? idx + 1 : title.structure.length }
}

// ---------- 話数追加 ----------

/**
 * 話数追加の候補位置を計算する。
 * target 省略時は自動（最新話の直後。話がなければ最初の章、章もなければ末尾）。
 * 新しい話は必ず採番スコープ内の最新話（通し番号なら全体の最後）になる。
 */
export function planEpisodeSlot(data: AppData, titleId: ID, target?: ID | null): Slot {
  const title = data.titles[titleId]
  if (!title) throw new DomainError('タイトルが見つかりません')
  const mode = effectiveNumbering(title)
  const chapters = chaptersOf(data, titleId)

  if (!title.chaptersEnabled) {
    // 章が無効: 平坦な並びで最後の episode の直後（隠れた章構成があってもそのコンテナに入る）
    const flat = flatten(data, titleId)
    for (let i = flat.length - 1; i >= 0; i--) {
      if (data.pieces[flat[i].pieceId].kind === 'episode') {
        return { chapterId: flat[i].chapterId, index: flat[i].index + 1 }
      }
    }
    return { chapterId: null, index: title.structure.length }
  }

  if (target === undefined) {
    if (mode === 'continuous') {
      const last = lastEpisodeInScope(data, titleId, null)
      if (last) {
        const slot = locatePiece(data, last)!
        return { chapterId: slot.chapterId, index: slot.index + 1 }
      }
      if (chapters.length > 0) return slotAfterLastEpisodeIn(data, titleId, chapters[0].id)
      return { chapterId: null, index: title.structure.length }
    }
    // 章ごと: 最後に話がある章（なければ最初の章）
    const flat = flatten(data, titleId)
    for (let i = flat.length - 1; i >= 0; i--) {
      if (data.pieces[flat[i].pieceId].kind === 'episode') return slotAfterLastEpisodeIn(data, titleId, flat[i].chapterId)
    }
    if (chapters.length > 0) return slotAfterLastEpisodeIn(data, titleId, chapters[0].id)
    return { chapterId: null, index: title.structure.length }
  }

  if (target !== null && !data.chapters[target]) throw new DomainError('章が見つかりません')
  if (mode === 'perChapter') return slotAfterLastEpisodeIn(data, titleId, target)

  // 通し番号 + 章あり: 指定コンテナに入れた結果が全体の最新話になる位置でなければならない
  const candidates: Slot[] = [slotAfterLastEpisodeIn(data, titleId, target)]
  if (target === null) candidates.push({ chapterId: null, index: title.structure.length })
  for (const slot of candidates) {
    if (isLastEpisodeAfterInsert(data, titleId, slot)) return slot
  }
  throw new DomainError(
    '通し番号モードでは、最新話より前の章に話数追加はできません（新しい話は必ず最新の話数になります）。最新話のある章以降に追加してから、並べ替えで移動してください。',
  )
}

function isLastEpisodeAfterInsert(data: AppData, titleId: ID, slot: Slot): boolean {
  const probeId = '__probe__'
  const { data: sim } = transact(data, (tx) => {
    tx.put('pieces', {
      id: probeId,
      titleId,
      kind: 'episode',
      label: '',
      subtitle: '',
      activeVersionId: null,
      versionIds: [],
      versionSeq: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    attachPiece(tx, titleId, probeId, slot)
  })
  return lastEpisodeInScope(sim, titleId, slot.chapterId) === probeId
}

/** 話数追加の候補先（UI の選択肢用）。通し番号モードで最新話より前になる章は除外される */
export function episodeTargets(data: AppData, titleId: ID): { chapterId: ID | null; label: string }[] {
  const title = data.titles[titleId]
  if (!title || !title.chaptersEnabled) return []
  const options: { chapterId: ID | null; label: string }[] = []
  const tryTarget = (chapterId: ID | null, label: string) => {
    try {
      planEpisodeSlot(data, titleId, chapterId)
      options.push({ chapterId, label })
    } catch {
      /* 候補外 */
    }
  }
  for (const ch of chaptersOf(data, titleId)) tryTarget(ch.id, ch.name || '（無題の章）')
  tryTarget(null, '章に入れない（タイトル直下）')
  return options
}

export function addEpisode(data: AppData, titleId: ID, target?: ID | null): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const slot = planEpisodeSlot(tx.data, titleId, target)
    const { piece, version } = createPieceRecord(titleId, 'episode', '')
    tx.put('pieces', piece)
    tx.put('versions', version)
    attachPiece(tx, titleId, piece.id, slot)
    return piece.id
  })
}

// ---------- 特殊追加 ----------

export interface InsertOption {
  slot: Slot
  label: string
}

/** 特殊ブロックや移動先として選べる位置の一覧（読む順） */
export function insertOptions(data: AppData, titleId: ID, excludePieceId?: ID): InsertOption[] {
  const title = data.titles[titleId]
  if (!title) return []
  const numbers = episodeNumbers(data, titleId)
  const name = (pid: ID) => `「${pieceFullLabel(data, data.pieces[pid], numbers)}」`
  const opts: InsertOption[] = []

  if (!title.chaptersEnabled) {
    const flat = flatten(data, titleId).filter((f) => f.pieceId !== excludePieceId)
    if (flat.length === 0) return [{ slot: { chapterId: null, index: title.structure.length }, label: '先頭' }]
    opts.push({ slot: { chapterId: flat[0].chapterId, index: flat[0].index }, label: `先頭（${name(flat[0].pieceId)}の前）` })
    flat.forEach((f, i) => {
      opts.push({
        slot: { chapterId: f.chapterId, index: f.index + 1 },
        label: i === flat.length - 1 ? `末尾（${name(f.pieceId)}の後）` : `${name(f.pieceId)}の後`,
      })
    })
    return normalizeExcluded(data, titleId, opts, excludePieceId)
  }

  opts.push({ slot: { chapterId: null, index: 0 }, label: '冒頭（タイトル直下・すべての前）' })
  title.structure.forEach((node, r) => {
    if (node.type === 'piece') {
      if (node.id === excludePieceId) return
      opts.push({ slot: { chapterId: null, index: r + 1 }, label: `${name(node.id)}の後（タイトル直下）` })
      return
    }
    const ch = data.chapters[node.id]
    if (!ch) return
    const chName = `「${ch.name || '無題の章'}」`
    opts.push({ slot: { chapterId: ch.id, index: 0 }, label: `${chName}の先頭` })
    ch.pieceIds.forEach((pid, i) => {
      if (pid === excludePieceId) return
      opts.push({ slot: { chapterId: ch.id, index: i + 1 }, label: `${chName}内 ${name(pid)}の後` })
    })
    opts.push({ slot: { chapterId: null, index: r + 1 }, label: `${chName}の後（タイトル直下）` })
  })
  return normalizeExcluded(data, titleId, opts, excludePieceId)
}

/**
 * 移動元を除外した後のインデックスに直す（移動時は一度外してから差し込むため）。
 * 同じ位置を指す選択肢は1つにまとめる。
 */
function normalizeExcluded(data: AppData, titleId: ID, opts: InsertOption[], excludePieceId?: ID): InsertOption[] {
  let normalized = opts
  if (excludePieceId) {
    const from = locatePiece(data, excludePieceId)
    if (from) {
      normalized = opts.map((o) =>
        o.slot.chapterId === from.chapterId && o.slot.index > from.index
          ? { ...o, slot: { ...o.slot, index: o.slot.index - 1 } }
          : o,
      )
    }
  }
  const seen = new Set<string>()
  const title = data.titles[titleId]
  return normalized.filter((o) => {
    const key = title.chaptersEnabled ? `${o.slot.chapterId}:${o.slot.index}` : o.label
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function addSpecial(data: AppData, titleId: ID, slot: Slot, label = 'プロローグ'): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    requireTitle(tx, titleId)
    const { piece, version } = createPieceRecord(titleId, 'special', label)
    tx.put('pieces', piece)
    tx.put('versions', version)
    attachPiece(tx, titleId, piece.id, slot)
    return piece.id
  })
}

// ---------- 話の編集・削除・並べ替え ----------

export function updatePiece(data: AppData, pieceId: ID, patch: { subtitle?: string; label?: string }): AppData {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    const next: Piece = { ...p, updatedAt: now() }
    if (patch.subtitle !== undefined) next.subtitle = patch.subtitle
    if (patch.label !== undefined) {
      // 第n話の表記は変更できない（特殊ブロックのみ見出しを編集できる）
      if (p.kind !== 'special') throw new DomainError('第n話の表記は変更できません')
      next.label = patch.label
    }
    tx.put('pieces', next)
  }).data
}

export function deletePiece(data: AppData, pieceId: ID): AppData {
  const perm = canDeletePiece(data, pieceId)
  if (!perm.ok) throw new DomainError(perm.reason ?? '削除できません')
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    detachPiece(tx, pieceId)
    for (const vid of p.versionIds) tx.delete('versions', vid)
    tx.delete('pieces', pieceId)
    touchTitle(tx, p.titleId)
  }).data
}

/** 指定位置へ移動（話数は並び順どおりに書き換わる）。slot は移動元を外した後の位置 */
export function movePiece(data: AppData, pieceId: ID, slot: Slot): AppData {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    detachPiece(tx, pieceId)
    attachPiece(tx, p.titleId, pieceId, slot)
  }).data
}

/**
 * 1つ上/下へ移動する。
 * 章が無効なら読む順で隣の話と入れ替える。章が有効ならツリー上の隣の位置へ
 * （章の先頭から上へ動かすと章の外へ、章の外から章の方向へ動かすとその章の端へ入る）。
 */
export function movePieceStep(data: AppData, pieceId: ID, dir: -1 | 1): AppData {
  const piece = data.pieces[pieceId]
  if (!piece) throw new DomainError('話が見つかりません')
  const title = data.titles[piece.titleId]
  const from = locatePiece(data, pieceId)
  if (!title || !from) return data

  let dest: Slot | null = null
  if (!title.chaptersEnabled) {
    const flat = flatten(data, title.id)
    const i = flat.findIndex((f) => f.pieceId === pieceId)
    const neighbor = flat[i + dir]
    if (!neighbor) return data
    if (neighbor.chapterId === from.chapterId) {
      dest = { chapterId: from.chapterId, index: neighbor.index }
    } else {
      dest = { chapterId: neighbor.chapterId, index: dir < 0 ? neighbor.index : neighbor.index + 1 }
    }
  } else if (from.chapterId) {
    const ch = data.chapters[from.chapterId]
    const rootIndex = title.structure.findIndex((n) => n.type === 'chapter' && n.id === ch.id)
    if (dir < 0) {
      dest = from.index > 0 ? { chapterId: ch.id, index: from.index - 1 } : { chapterId: null, index: rootIndex }
    } else {
      // 章の外へ出すときは、移動元を外しても章ノードの位置は変わらないので rootIndex + 1
      dest = from.index < ch.pieceIds.length - 1 ? { chapterId: ch.id, index: from.index + 1 } : { chapterId: null, index: rootIndex + 1 }
    }
  } else {
    const neighbor = title.structure[from.index + dir]
    if (!neighbor) return data
    if (neighbor.type === 'piece') {
      dest = { chapterId: null, index: from.index + dir }
    } else {
      const ch = data.chapters[neighbor.id]
      dest = { chapterId: ch.id, index: dir < 0 ? ch.pieceIds.length : 0 }
    }
  }
  return movePiece(data, pieceId, dest)
}

// ---------- 章 ----------

export function setChaptersEnabled(data: AppData, titleId: ID, enabled: boolean): AppData {
  return transact(data, (tx) => {
    const t = requireTitle(tx, titleId)
    if (t.chaptersEnabled === enabled) return
    if (enabled && !t.structure.some((n) => n.type === 'chapter')) {
      // 初めて章を有効にしたら「第1章」を作り、既存の話をすべてその中に入れる（並び順・話数は変わらない）
      const ts = now()
      const ch: Chapter = {
        id: newId(),
        titleId,
        name: '第1章',
        note: '',
        pieceIds: t.structure.filter((n) => n.type === 'piece').map((n) => n.id),
        createdAt: ts,
        updatedAt: ts,
      }
      tx.put('chapters', ch)
      touchTitle(tx, titleId, { chaptersEnabled: true, structure: [{ type: 'chapter', id: ch.id }] })
      return
    }
    touchTitle(tx, titleId, { chaptersEnabled: enabled })
  }).data
}

export function setNumbering(data: AppData, titleId: ID, numbering: Title['numbering']): AppData {
  return transact(data, (tx) => touchTitle(tx, titleId, { numbering })).data
}

export function addChapter(data: AppData, titleId: ID, name?: string): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const t = requireTitle(tx, titleId)
    const count = t.structure.filter((n) => n.type === 'chapter').length
    const ts = now()
    const ch: Chapter = { id: newId(), titleId, name: name ?? `第${count + 1}章`, note: '', pieceIds: [], createdAt: ts, updatedAt: ts }
    tx.put('chapters', ch)
    touchTitle(tx, titleId, { structure: [...t.structure, { type: 'chapter', id: ch.id }] })
    return ch.id
  })
}

export function updateChapter(data: AppData, chapterId: ID, patch: { name?: string; note?: string }): AppData {
  return transact(data, (tx) => {
    const ch = requireChapter(tx, chapterId)
    tx.put('chapters', { ...ch, ...patch, updatedAt: now() })
  }).data
}

/** 章をタイトル直下の並びの中で1つ上/下へ */
export function moveChapterStep(data: AppData, chapterId: ID, dir: -1 | 1): AppData {
  return transact(data, (tx) => {
    const ch = requireChapter(tx, chapterId)
    const t = requireTitle(tx, ch.titleId)
    const i = t.structure.findIndex((n) => n.type === 'chapter' && n.id === chapterId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= t.structure.length) return
    const structure = [...t.structure]
    ;[structure[i], structure[j]] = [structure[j], structure[i]]
    touchTitle(tx, t.id, { structure })
  }).data
}

/** 章を解除する。中の話は章があった位置にそのまま章の外として並ぶ（話は削除しない） */
export function removeChapter(data: AppData, chapterId: ID): AppData {
  return transact(data, (tx) => {
    const ch = requireChapter(tx, chapterId)
    const t = requireTitle(tx, ch.titleId)
    const i = t.structure.findIndex((n) => n.type === 'chapter' && n.id === chapterId)
    const loose: NodeRef[] = ch.pieceIds.map((id) => ({ type: 'piece', id }))
    const structure = i < 0 ? t.structure : [...t.structure.slice(0, i), ...loose, ...t.structure.slice(i + 1)]
    tx.delete('chapters', chapterId)
    touchTitle(tx, t.id, { structure })
  }).data
}

// ---------- 推敲バージョン ----------

export function addVersion(
  data: AppData,
  pieceId: ID,
  opts: { body?: string; sourceVersionId?: ID | null; name?: string } = {},
): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    const seq = p.versionSeq + 1
    const v = makeVersion(p, seq, opts.body ?? '', opts.sourceVersionId ?? null, opts.name)
    tx.put('versions', v)
    tx.put('pieces', { ...p, versionIds: [...p.versionIds, v.id], versionSeq: seq, updatedAt: now() })
    return v.id
  })
}

/** 推敲用に既存バージョンを複製して新しいバージョンを作る */
export function duplicateVersion(data: AppData, versionId: ID): { data: AppData; result: ID } {
  const src = data.versions[versionId]
  if (!src) throw new DomainError('バージョンが見つかりません')
  const piece = data.pieces[src.pieceId]
  return addVersion(data, src.pieceId, {
    body: src.body,
    sourceVersionId: src.id,
    name: `第${piece.versionSeq + 1}稿（${src.name}を複製）`,
  })
}

export function updateVersion(data: AppData, versionId: ID, patch: { name?: string; body?: string; note?: string }): AppData {
  return transact(data, (tx) => {
    const v = tx.get('versions', versionId)
    if (!v) throw new DomainError('バージョンが見つかりません')
    tx.put('versions', { ...v, ...patch, updatedAt: now() })
  }).data
}

export function deleteVersion(data: AppData, versionId: ID): AppData {
  return transact(data, (tx) => {
    const v = tx.get('versions', versionId)
    if (!v) return
    const p = requirePiece(tx, v.pieceId)
    tx.put('pieces', {
      ...p,
      versionIds: removeValue(p.versionIds, versionId),
      activeVersionId: p.activeVersionId === versionId ? null : p.activeVersionId,
      updatedAt: now(),
    })
    tx.delete('versions', versionId)
  }).data
}

/** 採用（アクティブ）にする。null で採用を解除（この話は「採用原稿がありません」になる） */
export function setActiveVersion(data: AppData, pieceId: ID, versionId: ID | null): AppData {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    if (versionId !== null && !p.versionIds.includes(versionId)) throw new DomainError('この話のバージョンではありません')
    tx.put('pieces', { ...p, activeVersionId: versionId, updatedAt: now() })
  }).data
}

export { episodeLabel }
