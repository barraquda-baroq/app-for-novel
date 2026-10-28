// 原稿画面（採用原稿と推敲バージョンの比較）で使う純粋な計算。
import { NO_ACTIVE_MESSAGE } from '../../domain/readthrough'
import { flatten } from '../../domain/structure'
import { countChars, formatCount, textStats } from '../../domain/text'
import type { AppData, ID, Piece, Submission, Version } from '../../domain/types'

/** 採用中のバージョン（採用なし・参照切れなら null） */
export function activeVersionOf(data: AppData, piece: Piece): Version | null {
  if (!piece.activeVersionId) return null
  const v = data.versions[piece.activeVersionId]
  return v && v.pieceId === piece.id ? v : null
}

/** この話のすべての推敲バージョンを新しい順（作成の新しいもの → 古いもの）に並べる */
export function versionsNewestFirst(data: AppData, piece: Piece): Version[] {
  const out: Version[] = []
  for (let i = piece.versionIds.length - 1; i >= 0; i--) {
    const v = data.versions[piece.versionIds[i]]
    if (v && v.pieceId === piece.id) out.push(v)
  }
  return out
}

/** ?v= で指定されたバージョンが、この話の比較対象として有効なら返す */
export function resolveSelected(data: AppData, piece: Piece, versionId: string | null): Version | null {
  if (!versionId) return null
  if (!piece.versionIds.includes(versionId)) return null
  const v = data.versions[versionId]
  return v && v.pieceId === piece.id ? v : null
}

/** 読む順（章の有無に関わらず平坦化した並び）での前後の話 */
export function neighborPieces(data: AppData, titleId: ID, pieceId: ID): { prev: ID | null; next: ID | null } {
  const flat = flatten(data, titleId)
  const i = flat.findIndex((f) => f.pieceId === pieceId)
  if (i < 0) return { prev: null, next: null }
  return { prev: flat[i - 1]?.pieceId ?? null, next: flat[i + 1]?.pieceId ?? null }
}

/** 採用原稿との文字数の差（例: +120字 / −35字 / ±0字） */
export function formatCharDelta(delta: number): string {
  if (delta > 0) return `+${formatCount(delta)}字`
  if (delta < 0) return `−${formatCount(-delta)}字`
  return '±0字'
}

/** 「3,214字・原稿用紙9枚」 */
export function statsLabel(text: string): string {
  const s = statsParts(text)
  return `${s.chars}・${s.pages}`
}

/** 文字数と原稿用紙換算を別々に（狭いヘッダーでは文字数だけを出す） */
export function statsParts(text: string): { chars: string; pages: string } {
  const s = textStats(text)
  return { chars: `${formatCount(s.chars)}字`, pages: `原稿用紙${formatCount(s.manuscriptPages)}枚` }
}

/** 推敲メモなどの最初の空でない行 */
export function firstLine(text: string): string {
  for (const line of text.split(/\r\n?|\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** 一覧の各行に出す情報 */
export interface VersionRowInfo {
  version: Version
  isActive: boolean
  chars: number
  /** 採用原稿との文字数の差。採用原稿がない・自分が採用中なら null */
  delta: number | null
  note: string
}

export function versionRows(data: AppData, piece: Piece): VersionRowInfo[] {
  const active = activeVersionOf(data, piece)
  const activeChars = active ? countChars(active.body) : 0
  return versionsNewestFirst(data, piece).map((v) => {
    const chars = countChars(v.body)
    const isActive = active?.id === v.id
    return {
      version: v,
      isActive,
      chars,
      delta: active && !isActive ? chars - activeChars : null,
      note: firstLine(v.note),
    }
  })
}

/**
 * 採用した後に比較対象として選ぶバージョン。
 * それまで採用していたバージョンがあれば、それと新しい採用原稿を比べられるようにする。
 */
export function selectionAfterAdopt(previousActiveId: ID | null, adoptedId: ID, versionIds: ID[]): ID | null {
  if (!previousActiveId || previousActiveId === adoptedId) return null
  return versionIds.includes(previousActiveId) ? previousActiveId : null
}

/** スクロール位置を割合で写す（スクロール同期用） */
export function mapScrollTop(srcTop: number, srcMax: number, dstMax: number): number {
  if (srcMax <= 0 || dstMax <= 0) return 0
  const ratio = Math.min(1, Math.max(0, srcTop / srcMax))
  return Math.round(ratio * dstMax)
}

/** 上部バーを1行にする画面（スマホの横持ちなど、高さが低く幅のある画面）。piece.css と揃える */
export const COMPACT_QUERY = '(max-height: 500px) and (min-width: 481px)'

/** スライダー（15〜85）と比率（0.15〜0.85）の変換 */
export const RATIO_MIN = 15
export const RATIO_MAX = 85

export function ratioToSlider(ratio: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, Math.round(ratio * 100)))
}

export function sliderToRatio(value: number): number {
  const v = Number.isFinite(value) ? value : 50
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, v)) / 100
}

export function versionDisplayName(v: Pick<Version, 'name'>): string {
  return v.name.trim() || '（無題の稿）'
}

/**
 * 推敲バージョンを削除する時の確認文。
 * 応募の記録（応募時の原稿）として参照されている稿なら、そのことと、削除しても控えが残るかを添える。
 */
export function versionDeleteMessage(
  version: Pick<Version, 'id' | 'pieceId'>,
  isActive: boolean,
  referencedBy: Pick<Submission, 'contestName' | 'snapshot'>[],
): string {
  const parts = [
    isActive
      ? `このバージョンは採用中です。削除すると、この話には採用原稿がなくなり、通し読みでは「${NO_ACTIVE_MESSAGE}」と表示されます。`
      : 'この推敲バージョンの本文と推敲メモを削除します。',
  ]
  if (referencedBy.length > 0) {
    const names = referencedBy.map((s) => `「${s.contestName.trim() || '（コンテスト名未設定）'}」`).join('')
    // 古い記録には本文の控えがない
    const hasCopy = referencedBy.every((s) => {
      const p = s.snapshot?.pieces?.[version.pieceId]
      return Boolean(p && p.versionId === version.id && (p.textKey ?? p.body ?? null) !== null)
    })
    parts.push(
      hasCopy
        ? `この稿は${names}の応募時の原稿として記録されています。記録には本文の控えがあるので、削除しても応募時の原稿は残ります。`
        : `この稿は${names}の応募時の原稿として記録されています。記録に本文の控えがないため、削除すると応募時の原稿は読めなくなります。`,
    )
  }
  parts.push('この操作は取り消せません。')
  return parts.join('\n\n')
}
