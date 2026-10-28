// 本編（章・第n話・特殊ブロック・推敲バージョン）の更新操作。
// すべて純粋関数で、新しい AppData を返す。仕様違反は DomainError を投げる。
// 幕に分けた話（セパレート。src/domain/acts.ts）の稿・採用は、セパレートを解除するまで変えられない。
import {
  actsOf,
  canDeletePiece,
  chaptersOf,
  effectiveNumbering,
  episodeLabel,
  episodeNumbers,
  flatten,
  isSplit,
  lastEpisodeInScope,
  locatePiece,
  pieceFullLabel,
} from './structure'
import { pieceOrigin, putInTrash, trashLabel } from './trash'
import { Tx, transact } from './tx'
import {
  DomainError,
  type AppData,
  type Chapter,
  type ID,
  type NodeRef,
  type Piece,
  type Slot,
  type Title,
  type Version,
} from './types'
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

/** 幕に分けた話の採用を変えようとした時 */
export const SPLIT_ADOPT_LOCKED = '幕に分けた話の採用を変えるには、先にセパレートを解除してください'
/** 幕に分けた話の稿を変えようとした時 */
export const SPLIT_VERSIONS_LOCKED = '幕に分けた話の稿は変えられません。各幕の画面で編集するか、先にセパレートを解除してください'

/** 幕に分けた話（稿・採用を変えられない）なら DomainError */
function requireUnsplit(piece: Piece, message = SPLIT_VERSIONS_LOCKED): void {
  if (isSplit(piece)) throw new DomainError(message)
}

/** 幕は本編の並び（structure・chapter.pieceIds）に載らないので、並べ替え・移動はできない */
function requireNotAct(piece: Piece): void {
  if (piece.kind === 'act') throw new DomainError('幕は並べ替えられません（話の中の幕の順は、つなぐ・さらに分けるで変わります）')
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

export function makeVersion(piece: Piece, seq: number, body = '', sourceVersionId: ID | null = null, name?: string): Version {
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
  return { chapterId: null, index: idx >= 0 ? idx + 1 : rootEndBeforeTrailingSpecials(data, title) }
}

/**
 * タイトル直下の末尾に並ぶ特殊ブロック（エピローグ・あとがき等）の手前の位置。
 * 話や章より後ろにある特殊ブロックだけを「末尾」とみなす（話がまだない時の特殊ブロックはプロローグの可能性が高いので、その後ろ）。
 */
function rootEndBeforeTrailingSpecials(data: AppData, title: Title): number {
  let i = title.structure.length
  while (i > 0) {
    const node = title.structure[i - 1]
    if (node.type !== 'piece' || data.pieces[node.id]?.kind !== 'special') break
    i -= 1
  }
  return i === 0 ? title.structure.length : i
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
    // まだ話がない: 末尾のエピローグ等より前
    return { chapterId: null, index: rootEndBeforeTrailingSpecials(data, title) }
  }

  if (target === undefined) {
    if (mode === 'continuous') {
      const last = lastEpisodeInScope(data, titleId, null)
      if (last) {
        const slot = locatePiece(data, last)!
        return { chapterId: slot.chapterId, index: slot.index + 1 }
      }
      if (chapters.length > 0) return slotAfterLastEpisodeIn(data, titleId, chapters[0].id)
      return { chapterId: null, index: rootEndBeforeTrailingSpecials(data, title) }
    }
    // 章ごと: 最後に話がある章（なければ最初の章）
    const flat = flatten(data, titleId)
    for (let i = flat.length - 1; i >= 0; i--) {
      if (data.pieces[flat[i].pieceId].kind === 'episode') return slotAfterLastEpisodeIn(data, titleId, flat[i].chapterId)
    }
    if (chapters.length > 0) return slotAfterLastEpisodeIn(data, titleId, chapters[0].id)
    return { chapterId: null, index: rootEndBeforeTrailingSpecials(data, title) }
  }

  if (target !== null && !data.chapters[target]) throw new DomainError('章が見つかりません')
  if (mode === 'perChapter') return slotAfterLastEpisodeIn(data, titleId, target)

  // 通し番号 + 章あり: 指定コンテナに入れた結果が全体の最新話になる位置でなければならない
  const candidates: Slot[] = [slotAfterLastEpisodeIn(data, titleId, target)]
  if (target === null) {
    // 末尾のエピローグ等より前、それでもだめなら最後
    candidates.push({ chapterId: null, index: rootEndBeforeTrailingSpecials(data, title) })
    candidates.push({ chapterId: null, index: title.structure.length })
  }
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

/**
 * 特殊ブロックや移動先として選べる位置の一覧（読む順）。
 * excludePieceId を渡すと移動用になり、その話を外した後の位置で返す（現在位置も必ず含まれる）。
 */
export function insertOptions(data: AppData, titleId: ID, excludePieceId?: ID): InsertOption[] {
  const title = data.titles[titleId]
  if (!title) return []
  const numbers = episodeNumbers(data, titleId)
  const name = (pid: ID) => `「${pieceFullLabel(data, data.pieces[pid], numbers)}」`
  // next: その位置の直後にある話（同じ見出しが並んだ時の区別に使う）
  const opts: (InsertOption & { next?: string })[] = []

  if (!title.chaptersEnabled) {
    const all = flatten(data, titleId)
    const exIdx = excludePieceId ? all.findIndex((f) => f.pieceId === excludePieceId) : -1
    const from = exIdx >= 0 ? all[exIdx] : null
    const flat = all.filter((f) => f.pieceId !== excludePieceId)
    if (flat.length === 0) {
      const slot = from ? { chapterId: from.chapterId, index: from.index } : { chapterId: null, index: title.structure.length }
      return normalizeExcluded(data, [{ slot, label: '先頭' }], excludePieceId)
    }
    for (let k = 0; k <= flat.length; k++) {
      // 隠れた章の境目では同じ読み位置を複数の slot で表せるので、移動元の現在位置はその話の slot を使う
      let slot: Slot
      if (from && k === exIdx) slot = { chapterId: from.chapterId, index: from.index }
      else if (k === 0) slot = { chapterId: flat[0].chapterId, index: flat[0].index }
      else slot = { chapterId: flat[k - 1].chapterId, index: flat[k - 1].index + 1 }
      const label =
        k === 0
          ? `先頭（${name(flat[0].pieceId)}の前）`
          : k === flat.length
            ? `末尾（${name(flat[k - 1].pieceId)}の後）`
            : `${name(flat[k - 1].pieceId)}の後`
      opts.push({ slot, label, next: flat[k] ? name(flat[k].pieceId) : undefined })
    }
    return normalizeExcluded(data, opts, excludePieceId)
  }

  const firstNode = title.structure.find((n) => n.type === 'chapter' || n.id !== excludePieceId)
  const nodeName = (n: NodeRef | undefined) =>
    !n ? undefined : n.type === 'piece' ? name(n.id) : `「${data.chapters[n.id]?.name || '無題の章'}」`
  opts.push({ slot: { chapterId: null, index: 0 }, label: '冒頭（タイトル直下・すべての前）', next: nodeName(firstNode) })
  title.structure.forEach((node, r) => {
    const nextNode = title.structure.slice(r + 1).find((n) => n.type === 'chapter' || n.id !== excludePieceId)
    if (node.type === 'piece') {
      if (node.id === excludePieceId) return
      opts.push({
        slot: { chapterId: null, index: r + 1 },
        label: `${name(node.id)}の後（タイトル直下）`,
        next: nodeName(nextNode),
      })
      return
    }
    const ch = data.chapters[node.id]
    if (!ch) return
    const chName = `「${ch.name || '無題の章'}」`
    const inside = ch.pieceIds.filter((pid) => pid !== excludePieceId)
    opts.push({ slot: { chapterId: ch.id, index: 0 }, label: `${chName}の先頭`, next: inside[0] ? name(inside[0]) : undefined })
    ch.pieceIds.forEach((pid, i) => {
      if (pid === excludePieceId) return
      const after = ch.pieceIds.slice(i + 1).find((x) => x !== excludePieceId)
      opts.push({
        slot: { chapterId: ch.id, index: i + 1 },
        label: `${chName}内 ${name(pid)}の後`,
        next: after ? name(after) : undefined,
      })
    })
    opts.push({ slot: { chapterId: null, index: r + 1 }, label: `${chName}の後（タイトル直下）`, next: nodeName(nextNode) })
  })
  return normalizeExcluded(data, opts, excludePieceId)
}

/**
 * 移動元を除外した後のインデックスに直す（移動時は一度外してから差し込むため）。
 * 同じ位置を指す選択肢は1つにまとめ、同じ見出しの選択肢は直後の話を添えて区別する。
 */
function normalizeExcluded(data: AppData, opts: (InsertOption & { next?: string })[], excludePieceId?: ID): InsertOption[] {
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
  const unique = normalized.filter((o) => {
    const key = `${o.slot.chapterId}:${o.slot.index}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const labelCount = new Map<string, number>()
  for (const o of unique) labelCount.set(o.label, (labelCount.get(o.label) ?? 0) + 1)
  const ordinal = new Map<string, number>()
  return unique.map(({ slot, label, next }) => {
    if ((labelCount.get(label) ?? 0) < 2) return { slot, label }
    const n = (ordinal.get(label) ?? 0) + 1
    ordinal.set(label, n)
    return { slot, label: next ? `${label}（${next}の前）` : `${label}（${n}つ目）` }
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
      // 第n話・第x幕の表記は変更できない（特殊ブロックのみ見出しを編集できる）
      if (p.kind !== 'special')
        throw new DomainError(p.kind === 'act' ? '第x幕の表記は変更できません' : '第n話の表記は変更できません')
      next.label = patch.label
    }
    tx.put('pieces', next)
  }).data
}

/** 話の稿（versionIds の順。載っていない稿（壊れたデータ）も後ろに付ける） */
function versionsOfPiece(tx: Tx, p: Piece): Version[] {
  return [
    ...p.versionIds.map((vid) => tx.get('versions', vid)).filter((v): v is Version => Boolean(v)),
    ...tx.all('versions').filter((v) => v.pieceId === p.id && !p.versionIds.includes(v.id)),
  ]
}

/** 話をその稿ごとゴミ箱へ移す（途中の話数は削除できない）。幕に分けた話は、幕とその稿もいっしょに1件にまとめる */
export function deletePiece(data: AppData, pieceId: ID): AppData {
  const perm = canDeletePiece(data, pieceId)
  if (!perm.ok) throw new DomainError(perm.reason ?? '削除できません')
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    const title = requireTitle(tx, p.titleId)
    const origin = pieceOrigin(tx.data, pieceId)
    const chapter = origin.chapterId ? tx.get('chapters', origin.chapterId) : undefined
    const records: { table: 'pieces' | 'versions'; record: Piece | Version }[] = [
      { table: 'pieces', record: p },
      ...versionsOfPiece(tx, p).map((record) => ({ table: 'versions' as const, record })),
    ]
    // 幕（並びに載っていないが、この話を指している幕も）とその稿
    const acts = [...actsOf(tx.data, p), ...tx.all('pieces').filter((a) => a.kind === 'act' && a.parentId === p.id)]
    for (const act of new Set(acts)) {
      records.push({ table: 'pieces', record: act })
      for (const v of versionsOfPiece(tx, act)) records.push({ table: 'versions', record: v })
    }
    const label = pieceFullLabel(tx.data, p)
    detachPiece(tx, pieceId)
    putInTrash(tx, {
      kind: 'piece',
      label,
      titleName: title.name,
      parentLabel: chapter ? trashLabel.chapter(chapter) : undefined,
      origin,
      records,
    })
    touchTitle(tx, p.titleId)
  }).data
}

/** 指定位置へ移動（話数は並び順どおりに書き換わる）。slot は移動元を外した後の位置 */
export function movePiece(data: AppData, pieceId: ID, slot: Slot): AppData {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    requireNotAct(p)
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
  requireNotAct(piece)
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
      // 隠れた章の境目をまたぐ時は、読む順で入れ替えた上で各章の話数（器の大きさ）を保つ。
      // こうすると ↑ と ↓ で元に戻り、章をオンに戻した時に章の構成が崩れない。
      const order = flat.map((f) => f.pieceId)
      ;[order[i], order[i + dir]] = [order[i + dir], order[i]]
      if (containerCapacity(data, title) === order.length) {
        return transact(data, (tx) => refillContainers(tx, title.id, order)).data
      }
      dest = { chapterId: neighbor.chapterId, index: dir < 0 ? neighbor.index : neighbor.index + 1 }
    }
  } else if (from.chapterId) {
    const ch = data.chapters[from.chapterId]
    const rootIndex = title.structure.findIndex((n) => n.type === 'chapter' && n.id === ch.id)
    if (dir < 0) {
      dest = from.index > 0 ? { chapterId: ch.id, index: from.index - 1 } : { chapterId: null, index: rootIndex }
    } else {
      // 章の外へ出すときは、移動元を外しても章ノードの位置は変わらないので rootIndex + 1
      dest =
        from.index < ch.pieceIds.length - 1
          ? { chapterId: ch.id, index: from.index + 1 }
          : { chapterId: null, index: rootIndex + 1 }
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

function containerCapacity(data: AppData, title: Title): number {
  return title.structure.reduce((n, node) => n + (node.type === 'piece' ? 1 : (data.chapters[node.id]?.pieceIds.length ?? 0)), 0)
}

/** 読む順の並び order を、今のコンテナ構成（章の外の位置・各章の話数）のまま詰め直す */
function refillContainers(tx: Tx, titleId: ID, order: ID[]): void {
  const t = requireTitle(tx, titleId)
  let k = 0
  const structure: NodeRef[] = t.structure.map((node) => {
    if (node.type === 'piece') return { type: 'piece', id: order[k++] }
    const ch = tx.get('chapters', node.id)
    if (ch) {
      const ids = order.slice(k, k + ch.pieceIds.length)
      k += ch.pieceIds.length
      tx.put('chapters', { ...ch, pieceIds: ids, updatedAt: now() })
    }
    return node
  })
  touchTitle(tx, titleId, { structure })
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

/** 既定の章名。既にある「第n章」と重ならない番号にする */
function nextChapterName(data: AppData, title: Title): string {
  const chapters = chaptersOf(data, title.id)
  let max = chapters.length
  for (const c of chapters) {
    const m = /^第(\d+)章/.exec(c.name.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `第${max + 1}章`
}

export function addChapter(data: AppData, titleId: ID, name?: string): { data: AppData; result: ID } {
  return transact(data, (tx) => {
    const t = requireTitle(tx, titleId)
    const ts = now()
    const ch: Chapter = {
      id: newId(),
      titleId,
      name: name ?? nextChapterName(tx.data, t),
      note: '',
      pieceIds: [],
      createdAt: ts,
      updatedAt: ts,
    }
    tx.put('chapters', ch)
    // 末尾のエピローグ等（タイトル直下の特殊ブロック）より前に入れる
    const at = rootEndBeforeTrailingSpecials(tx.data, t)
    touchTitle(tx, titleId, { structure: insertAt<NodeRef>(t.structure, at, { type: 'chapter', id: ch.id }) })
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

/**
 * 章を解除する。中の話は章があった位置にそのまま章の外として並ぶ（話は削除しない）。
 * 章（名前・メモ）はゴミ箱へ移り、戻すと元の位置に章が作り直され、今もタイトル直下にある話が章へ戻る。
 */
export function removeChapter(data: AppData, chapterId: ID): AppData {
  return transact(data, (tx) => {
    const ch = requireChapter(tx, chapterId)
    const t = requireTitle(tx, ch.titleId)
    const i = t.structure.findIndex((n) => n.type === 'chapter' && n.id === chapterId)
    const loose: NodeRef[] = ch.pieceIds.map((id) => ({ type: 'piece', id }))
    const structure = i < 0 ? t.structure : [...t.structure.slice(0, i), ...loose, ...t.structure.slice(i + 1)]
    putInTrash(tx, {
      kind: 'chapter',
      label: trashLabel.chapter(ch),
      titleName: t.name,
      origin: {
        titleId: t.id,
        chapterId: null,
        index: i < 0 ? t.structure.length : i,
        prevId: i > 0 ? t.structure[i - 1].id : null,
      },
      records: [{ table: 'chapters', record: ch }],
    })
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
    requireUnsplit(p)
    const seq = p.versionSeq + 1
    const v = makeVersion(p, seq, opts.body ?? '', opts.sourceVersionId ?? null, opts.name)
    tx.put('versions', v)
    tx.put('pieces', { ...p, versionIds: [...p.versionIds, v.id], versionSeq: seq, updatedAt: now() })
    return v.id
  })
}

/** 複製名に使う元の稿の呼び名。「第2稿（第1稿を複製）」なら「第2稿」。名前が空なら「無題の稿」 */
export function baseVersionName(name: string): string {
  const trimmed = name.trim()
  const m = /^(第\d+稿)/.exec(trimmed)
  if (m) return m[1]
  return trimmed.replace(/（[^（）]*を複製）$/, '').trim() || '無題の稿'
}

/** 推敲用に既存バージョンを複製して新しいバージョンを作る */
export function duplicateVersion(data: AppData, versionId: ID): { data: AppData; result: ID } {
  const src = data.versions[versionId]
  if (!src) throw new DomainError('バージョンが見つかりません')
  const piece = data.pieces[src.pieceId]
  return addVersion(data, src.pieceId, {
    body: src.body,
    sourceVersionId: src.id,
    name: `第${piece.versionSeq + 1}稿（${baseVersionName(src.name)}を複製）`,
  })
}

export function updateVersion(data: AppData, versionId: ID, patch: { name?: string; body?: string; note?: string }): AppData {
  return transact(data, (tx) => {
    const v = tx.get('versions', versionId)
    if (!v) throw new DomainError('バージョンが見つかりません')
    const p = tx.get('pieces', v.pieceId)
    if (p) requireUnsplit(p)
    tx.put('versions', { ...v, ...patch, updatedAt: now() })
  }).data
}

/** 推敲バージョンをゴミ箱へ移す。採用中だった稿なら、この話は採用なしになる */
export function deleteVersion(data: AppData, versionId: ID): AppData {
  return transact(data, (tx) => {
    const v = tx.get('versions', versionId)
    if (!v) return
    const p = requirePiece(tx, v.pieceId)
    requireUnsplit(p)
    const index = p.versionIds.indexOf(versionId)
    putInTrash(tx, {
      kind: 'version',
      label: trashLabel.version(v),
      titleName: tx.get('titles', p.titleId)?.name ?? '',
      parentLabel: pieceFullLabel(tx.data, p),
      origin: {
        titleId: p.titleId,
        pieceId: p.id,
        index: index < 0 ? p.versionIds.length : index,
        prevId: index > 0 ? p.versionIds[index - 1] : null,
        wasActive: p.activeVersionId === versionId,
      },
      records: [{ table: 'versions', record: v }],
    })
    tx.put('pieces', {
      ...p,
      versionIds: removeValue(p.versionIds, versionId),
      activeVersionId: p.activeVersionId === versionId ? null : p.activeVersionId,
      updatedAt: now(),
    })
  }).data
}

/** 採用（アクティブ）にする。null で採用を解除（この話は「採用原稿がありません」になる） */
export function setActiveVersion(data: AppData, pieceId: ID, versionId: ID | null): AppData {
  return transact(data, (tx) => {
    const p = requirePiece(tx, pieceId)
    requireUnsplit(p, SPLIT_ADOPT_LOCKED)
    if (versionId !== null && !p.versionIds.includes(versionId)) throw new DomainError('この話のバージョンではありません')
    tx.put('pieces', { ...p, activeVersionId: versionId, updatedAt: now() })
  }).data
}

export { episodeLabel }
