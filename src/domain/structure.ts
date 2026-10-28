// 本編（章・第n話・特殊ブロック・幕）の構成に関する読み取り専用の計算。
// 話数・幕数は保存せず、ここで並び順から導出する。
// 採用原稿（上位の層に反映される本文）は adoptedText で取る。幕に分けた話は各幕の採用稿をつないだもの。
import { bodyMetrics, type BodyMetrics } from './text'
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

export function actLabel(n: number): string {
  return `第${n}幕`
}

/** 一覧や見出しに出す表記。episode は「第n話」（変更不可）、special は任意の見出し、act は「第x幕」 */
export function pieceLabel(data: AppData, piece: Piece, numbers?: Record<ID, number>): string {
  if (piece.kind === 'special') return piece.label.trim() || '（無題のブロック）'
  if (piece.kind === 'act') {
    const n = actNumber(data, piece)
    return n ? actLabel(n) : '第?幕'
  }
  const map = numbers ?? episodeNumbers(data, piece.titleId)
  const n = map[piece.id]
  return n ? episodeLabel(n) : '第?話'
}

/** 「第3話 旅立ち」のような表示用のフルタイトル。幕は「第3話　旅立ち　第2幕」（題は話のもの） */
export function pieceFullLabel(data: AppData, piece: Piece, numbers?: Record<ID, number>): string {
  if (piece.kind === 'act') {
    const parent = parentOf(data, piece)
    const label = pieceLabel(data, piece)
    return parent ? `${pieceFullLabel(data, parent, numbers)}　${label}` : label
  }
  const label = pieceLabel(data, piece, numbers)
  return piece.subtitle.trim() ? `${label}　${piece.subtitle.trim()}` : label
}

// ---------- 幕（セパレート） ----------

/** 幕に分けた第n話か（幕の並びが空でない） */
export function isSplit(piece: Piece | undefined): boolean {
  return piece?.kind === 'episode' && Array.isArray(piece.actIds) && piece.actIds.length > 0
}

/** 幕の属する話（幕でなければ・見つからなければ undefined） */
export function parentOf(data: AppData, piece: Piece): Piece | undefined {
  if (piece.kind !== 'act' || !piece.parentId) return undefined
  const parent = data.pieces[piece.parentId]
  return parent && parent.kind === 'episode' ? parent : undefined
}

/** 話の幕（読む順。見つからない幕・この話の幕でないものは飛ばす） */
export function actsOf(data: AppData, piece: Piece): Piece[] {
  if (!isSplit(piece)) return []
  const out: Piece[] = []
  for (const id of piece.actIds!) {
    const act = data.pieces[id]
    if (act && act.kind === 'act' && act.parentId === piece.id) out.push(act)
  }
  return out
}

/** 第x幕の x（1から。話の幕の並びに無ければ null） */
export function actNumber(data: AppData, act: Piece): number | null {
  const parent = parentOf(data, act)
  if (!parent) return null
  const i = actsOf(data, parent).findIndex((a) => a.id === act.id)
  return i >= 0 ? i + 1 : null
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

export const ACT_DELETE_REASON = '幕だけを削除することはできません。隣の幕とつなぐか、セパレートを解除してください。'

/**
 * 削除できるか。途中の話数を削除して話数を空洞化させることはできない。
 * episode は採番スコープ内の最後の話だけ削除可能。特殊ブロックはいつでも削除可能。
 */
export function canDeletePiece(data: AppData, pieceId: ID): Permission {
  const piece = data.pieces[pieceId]
  if (!piece) return { ok: false, reason: '見つかりません' }
  if (piece.kind === 'special') return { ok: true }
  if (piece.kind === 'act') return { ok: false, reason: ACT_DELETE_REASON }
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

/** 幕に分けた話の1幕分 */
export interface ActPart {
  act: Piece
  /** 第x幕の x */
  number: number
  /** 幕の採用稿（なければ null。つないだ本文には何も足さない） */
  version: Version | null
}

/** 幕に分けた話の本文（各幕の採用稿を読む順につないだもの） */
export interface JoinedText {
  body: string
  parts: ActPart[]
  /** 採用稿のない幕の数 */
  missing: number
}

const joinedCache = new WeakMap<Piece, JoinedText>()

/** 各幕と、その採用稿（読む順） */
export function actParts(data: AppData, piece: Piece): ActPart[] {
  return actsOf(data, piece).map((act, i) => ({ act, number: i + 1, version: activeVersion(data, act) }))
}

/**
 * 幕に分けた話の、各幕の採用稿をつないだ本文。幕と採用稿が変わらない限り同じオブジェクトを返すので、
 * 文字数・枚数・指紋（bodyMetrics）も数え直さない。
 */
export function joinedText(data: AppData, piece: Piece): JoinedText {
  const parts = actParts(data, piece)
  const cached = joinedCache.get(piece)
  if (
    cached &&
    cached.parts.length === parts.length &&
    cached.parts.every((p, i) => p.act === parts[i].act && p.version === parts[i].version)
  ) {
    return cached
  }
  let body = ''
  let missing = 0
  for (const p of parts) {
    if (p.version) body += p.version.body
    else missing += 1
  }
  const joined: JoinedText = { body, parts, missing }
  joinedCache.set(piece, joined)
  return joined
}

/**
 * 上位の層（章・タイトル・通し読み・書き出し・応募時の記録）に反映される本文を持つもの。
 * ふつうは採用中の稿。幕に分けた話は各幕の採用稿をつないだもの（どの幕にも採用稿がなければ null）。
 * 返すオブジェクトは本文が変わらない限り同じなので、bodyMetrics のキャッシュが効く。
 */
export function adoptedText(data: AppData, piece: Piece): { body: string } | null {
  if (isSplit(piece)) {
    const j = joinedText(data, piece)
    return j.parts.some((p) => p.version) ? j : null
  }
  return activeVersion(data, piece)
}

/** 採用原稿の本文（なければ null） */
export function activeBody(data: AppData, piece: Piece): string | null {
  return adoptedText(data, piece)?.body ?? null
}

/** 採用原稿の文字数・枚数・指紋（なければ null） */
export function adoptedMetrics(data: AppData, piece: Piece): BodyMetrics | null {
  const t = adoptedText(data, piece)
  return t ? bodyMetrics(t) : null
}

/** 幕に分けた話のうち、採用稿のない幕の数（分けていなければ 0） */
export function missingActs(data: AppData, piece: Piece): number {
  return isSplit(piece) ? joinedText(data, piece).missing : 0
}
