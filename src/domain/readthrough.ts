// 通し読み。採用（アクティブ）原稿だけが上位の層（章・タイトル）に反映される。
import { activeBody, chaptersOf, episodeNumbers, flatten, pieceLabel } from './structure'
import type { AppData, ID } from './types'

export const NO_ACTIVE_MESSAGE = '採用原稿がありません。'

export type ReadBlock =
  | { type: 'chapter'; chapterId: ID; name: string; note: string }
  | {
      type: 'piece'
      pieceId: ID
      kind: 'episode' | 'special'
      chapterId: ID | null
      label: string
      subtitle: string
      /** 採用原稿の本文。採用原稿がなければ null */
      body: string | null
      versionName: string | null
    }

/**
 * 通し読み用のブロック列を作る。chapterId を指定するとその章だけ。
 * 章が有効なときだけ章見出しを挟む。
 */
export function buildReadThrough(data: AppData, titleId: ID, chapterId?: ID): ReadBlock[] {
  const title = data.titles[titleId]
  if (!title) return []
  const numbers = episodeNumbers(data, titleId)
  const blocks: ReadBlock[] = []
  let currentChapter: ID | null | undefined
  const chapterIds = new Set(chaptersOf(data, titleId).map((c) => c.id))
  for (const item of flatten(data, titleId)) {
    if (chapterId !== undefined && item.chapterId !== chapterId) continue
    if (title.chaptersEnabled && item.chapterId !== currentChapter) {
      currentChapter = item.chapterId
      if (item.chapterId && chapterIds.has(item.chapterId)) {
        const ch = data.chapters[item.chapterId]
        blocks.push({ type: 'chapter', chapterId: ch.id, name: ch.name, note: ch.note })
      }
    }
    const piece = data.pieces[item.pieceId]
    const body = activeBody(data, piece)
    blocks.push({
      type: 'piece',
      pieceId: piece.id,
      kind: piece.kind,
      chapterId: item.chapterId,
      label: pieceLabel(data, piece, numbers),
      subtitle: piece.subtitle,
      body,
      versionName: body === null ? null : (data.versions[piece.activeVersionId!]?.name ?? null),
    })
  }
  // 中身が空の章も見出しだけは出す（章単位の通し読みで空の章を開いた場合など）
  if (chapterId !== undefined && title.chaptersEnabled && blocks.length === 0 && data.chapters[chapterId]) {
    const ch = data.chapters[chapterId]
    blocks.push({ type: 'chapter', chapterId: ch.id, name: ch.name, note: ch.note })
  }
  return blocks
}

/** テキストファイル書き出し用。採用原稿がない話は「採用原稿がありません。」と出力する */
export function readThroughText(data: AppData, titleId: ID, chapterId?: ID): string {
  const title = data.titles[titleId]
  if (!title) return ''
  const parts: string[] = []
  if (chapterId === undefined) parts.push(title.name, '')
  for (const b of buildReadThrough(data, titleId, chapterId)) {
    if (b.type === 'chapter') {
      parts.push(`■ ${b.name}`, '')
      continue
    }
    parts.push(b.subtitle.trim() ? `${b.label}　${b.subtitle.trim()}` : b.label, '')
    parts.push(b.body ?? NO_ACTIVE_MESSAGE, '', '')
  }
  return parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n'
}
