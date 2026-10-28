// 本編（章・第n話・特殊ブロック）の構成に関する読み取り専用の計算。
// 話数は保存せず、ここで並び順から導出する。
import type { AppData, Chapter, ID, NodeRef, NumberingMode, Piece, Slot, Title, Version } from './types'

export interface FlatItem {
  pieceId: ID
  chapterId: ID | null
  /** 所属コンテナ（タイトル直下なら structure、章なら chapter.pieceIds）内のインデックス */
  index: number
}

/** 章の有無に関わらず、本編を読む順に平坦化する */
export function flatten(data: AppData, titleId: ID): FlatItem[] {
  const title = data.titles[titleId]
  if (!title) return []
  const out: FlatItem[] = []
  title.structure.forEach((node, rootIndex) => {
    if (node.type === 'piece') {
      if (data.pieces[node.id]) out.push({ pieceId: node.id, chapterId: null, index: rootIndex })
    } else {
      const ch = data.chapters[node.id]
      if (!ch) return
      ch.pieceIds.forEach((pid, i) => {
        if (data.pieces[pid]) out.push({ pieceId: pid, chapterId: ch.id, index: i })
      })
    }
  })
  return out
}

/** 章が無効なら常に通し番号 */
export function effectiveNumbering(title: Title): NumberingMode {
  return title.chaptersEnabled ? title.numbering : 'continuous'
}

/** 話数の採番スコープのキー。通し番号ならタイトル全体、章ごとなら所属コンテナ */
export function scopeKey(title: Title, chapterId: ID | null): string {
  if (effectiveNumbering(title) === 'continuous') return 'title'
  return chapterId ?? 'root'
}

/** pieceId -> 話数（episode のみ） */
export function episodeNumbers(data: AppData, titleId: ID): Record<ID, number> {
  const title = data.titles[titleId]
  if (!title) return {}
  const counters = new Map<string, number>()
  const result: Record<ID, number> = {}
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    if (piece.kind !== 'episode') continue
    const key = scopeKey(title, item.chapterId)
    const n = (counters.get(key) ?? 0) + 1
    counters.set(key, n)
    result[piece.id] = n
  }
  return result
}

export function episodeLabel(n: number): string {
  return `第${n}話`
}

/** 一覧や見出しに出す表記。episode は「第n話」（変更不可）、special は任意の見出し */
export function pieceLabel(data: AppData, piece: Piece, numbers?: Record<ID, number>): string {
  if (piece.kind === 'special') return piece.label.trim() || '（無題のブロック）'
  const map = numbers ?? episodeNumbers(data, piece.titleId)
  const n = map[piece.id]
  return n ? episodeLabel(n) : '第?話'
}

/** 「第3話 旅立ち」のような表示用のフルタイトル */
export function pieceFullLabel(data: AppData, piece: Piece, numbers?: Record<ID, number>): string {
  const label = pieceLabel(data, piece, numbers)
  return piece.subtitle.trim() ? `${label}　${piece.subtitle.trim()}` : label
}

export function locatePiece(data: AppData, pieceId: ID): Slot | null {
  const piece = data.pieces[pieceId]
  if (!piece) return null
  const title = data.titles[piece.titleId]
  if (!title) return null
  const rootIndex = title.structure.findIndex((n) => n.type === 'piece' && n.id === pieceId)
  if (rootIndex >= 0) return { chapterId: null, index: rootIndex }
  for (const node of title.structure) {
    if (node.type !== 'chapter') continue
    const ch = data.chapters[node.id]
    const i = ch ? ch.pieceIds.indexOf(pieceId) : -1
    if (i >= 0) return { chapterId: ch.id, index: i }
  }
  return null
}

export function chaptersOf(data: AppData, titleId: ID): Chapter[] {
  const title = data.titles[titleId]
  if (!title) return []
  return title.structure
    .filter((n): n is Extract<NodeRef, { type: 'chapter' }> => n.type === 'chapter')
    .map((n) => data.chapters[n.id])
    .filter((c): c is Chapter => Boolean(c))
}

/** コンテナ内の piece id 一覧（タイトル直下なら章を除いた piece のみ） */
export function containerPieceIds(data: AppData, titleId: ID, chapterId: ID | null): ID[] {
  if (chapterId) return data.chapters[chapterId]?.pieceIds ?? []
  const title = data.titles[titleId]
  if (!title) return []
  return title.structure.filter((n) => n.type === 'piece').map((n) => n.id)
}

/** 採番スコープ内で最後の episode（なければ null） */
export function lastEpisodeInScope(data: AppData, titleId: ID, chapterId: ID | null): ID | null {
  const title = data.titles[titleId]
  if (!title) return null
  const key = scopeKey(title, chapterId)
  let last: ID | null = null
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    if (piece.kind === 'episode' && scopeKey(title, item.chapterId) === key) last = piece.id
  }
  return last
}

export interface Permission {
  ok: boolean
  reason?: string
}

/**
 * 削除できるか。途中の話数を削除して話数を空洞化させることはできない。
 * episode は採番スコープ内の最後の話だけ削除可能。特殊ブロックはいつでも削除可能。
 */
export function canDeletePiece(data: AppData, pieceId: ID): Permission {
  const piece = data.pieces[pieceId]
  if (!piece) return { ok: false, reason: '見つかりません' }
  if (piece.kind === 'special') return { ok: true }
  const slot = locatePiece(data, pieceId)
  const last = lastEpisodeInScope(data, piece.titleId, slot?.chapterId ?? null)
  if (last === pieceId) return { ok: true }
  const title = data.titles[piece.titleId]
  const scope =
    effectiveNumbering(title) !== 'perChapter' ? '' : slot?.chapterId ? 'この章の' : 'タイトル直下（章に入っていない話）の'
  return {
    ok: false,
    reason: `途中の話数は削除できません。${scope}最後の話だけが削除できます。削除したい話を並べ替えで最後に移動してから削除してください。`,
  }
}

export interface TitleStats {
  episodes: number
  specials: number
  /** 採用原稿がない話の数 */
  missingActive: number
  /** 採用原稿の総文字数（空白・改行除く） */
  activeChars: number
}

/** 採用中の推敲バージョン（なければ null） */
export function activeVersion(data: AppData, piece: Piece): Version | null {
  if (!piece.activeVersionId) return null
  return data.versions[piece.activeVersionId] ?? null
}

export function activeBody(data: AppData, piece: Piece): string | null {
  if (!piece.activeVersionId) return null
  const v = data.versions[piece.activeVersionId]
  return v ? v.body : null
}
