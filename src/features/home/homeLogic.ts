// ホーム画面（タイトル群・アイデア領域）で使う、表示用の純粋な計算。データは変更しない。
import { missingActiveLabel, titleLastEdited, titleSummary, type TitleSummary } from '../../domain/entityOps'
import { formatCount } from '../../domain/text'
import type { AppData, ID } from '../../domain/types'

export type HomeView = 'titles' | 'ideas'

/** リンクの ?view= の値（titles / ideas 以外は null） */
export function parseHomeView(raw: string | null | undefined): HomeView | null {
  return raw === 'titles' || raw === 'ideas' ? raw : null
}

/** あらすじの抜粋（改行・連続した空白は1つの空白に） */
export function synopsisExcerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

export interface TitleCardInfo {
  id: ID
  name: string
  synopsis: string
  summary: TitleSummary
  chaptersEnabled: boolean
  lastEdited: number
  ideaCount: number
  versionCount: number
}

export function titleCardInfo(data: AppData, titleId: ID): TitleCardInfo | null {
  const title = data.titles[titleId]
  if (!title) return null
  let ideaCount = 0
  for (const idea of Object.values(data.ideas)) if (idea.titleId === titleId) ideaCount += 1
  let versionCount = 0
  for (const v of Object.values(data.versions)) if (v.titleId === titleId) versionCount += 1
  return {
    id: title.id,
    name: title.name.trim() || '無題のタイトル',
    synopsis: synopsisExcerpt(title.synopsis),
    summary: titleSummary(data, titleId),
    chaptersEnabled: title.chaptersEnabled,
    lastEdited: titleLastEdited(data, titleId),
    ideaCount,
    versionCount,
  }
}

/** 「全3話」「＋特殊1」のような話数の表記 */
export function episodesLabel(summary: Pick<TitleSummary, 'episodes' | 'specials'>): { main: string; sub: string | null } {
  return {
    main: `全${summary.episodes}話`,
    sub: summary.specials > 0 ? `特殊${summary.specials}` : null,
  }
}

/** 「採用原稿なし 2話＋特殊1」（特殊ブロックは話数に数えない）。なければ空文字 */
export function missingLabel(summary: Pick<TitleSummary, 'missingEpisodes' | 'missingSpecials'>): string {
  return missingActiveLabel(summary.missingEpisodes, summary.missingSpecials)
}

export function charsLabel(chars: number): string {
  return `${formatCount(chars)}字`
}

/** タイトル削除の確認文。何が消え、アイデアがどこへ行くかをはっきり書く */
export function deleteTitleMessage(info: Pick<TitleCardInfo, 'summary' | 'versionCount' | 'ideaCount'>): string {
  const { episodes, specials } = info.summary
  const parts = [`全${episodes}話`]
  if (specials > 0) parts.push(`特殊ブロック${specials}件`)
  parts.push(`推敲バージョン${info.versionCount}稿`)
  const lines = [
    `このタイトルのすべての話・推敲バージョン・設定・戦略・メモが削除されます（${parts.join('、')}）。元に戻すことはできません。`,
  ]
  lines.push(
    info.ideaCount > 0
      ? `このタイトルのアイデア（${info.ideaCount}件）は削除されず、「どのタイトルにも属さない」へ移ります。`
      : 'このタイトルのアイデアがあった場合は、削除されずに「どのタイトルにも属さない」へ移ります。',
  )
  return lines.join('\n\n')
}
