// アイデア領域（仕切り・カード）で使う、表示用の純粋な計算。データは変更しない。
import type { IdeaSection } from '../../domain/entityOps'
import type { ID, Idea } from '../../domain/types'

/** 「どのタイトルにも属さない」仕切りの名前（entityOps.ideaSections と同じ文言） */
export const UNASSIGNED_NAME = 'どのタイトルにも属さない'

/** <select> や localStorage で仕切りを表すキー。titleId = null は 'none' */
export const UNASSIGNED_KEY = 'none'

export function sectionKey(titleId: ID | null): string {
  return titleId ?? UNASSIGNED_KEY
}

export function titleIdFromKey(key: string): ID | null {
  return key === UNASSIGNED_KEY || key === '' ? null : key
}

export function sectionDisplayName(section: Pick<IdeaSection, 'titleId' | 'name'>): string {
  if (section.titleId === null) return UNASSIGNED_NAME
  return section.name.trim() || '無題のタイトル'
}

/** 見出しと内容のどちらかがあれば保存できる */
export function canSaveIdea(heading: string, body: string): boolean {
  return heading.trim().length > 0 || body.trim().length > 0
}

/** 文字数で切り詰める（サロゲートペアを壊さない） */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/** 「この案でタイトルを作る」ときのタイトル名の候補。見出し、なければ内容の最初の行 */
export function titleNameFromIdea(idea: Pick<Idea, 'heading' | 'body'>, max = 40): string {
  const heading = idea.heading.trim()
  if (heading) return truncate(heading, max)
  const firstLine =
    idea.body
      .split(/\r\n?|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  return truncate(firstLine, max)
}

/** 確認ダイアログやトーストに出す、アイデアの短い呼び名 */
export function ideaShortLabel(idea: Pick<Idea, 'heading' | 'body'>, max = 24): string {
  return titleNameFromIdea(idea, max) || '（空のアイデア）'
}

/** Ctrl+Enter / ⌘+Enter（変換中の Enter は除く） */
export function isSubmitShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing
}

/** ショートカットの表記（Mac なら ⌘） */
export function submitShortcutLabel(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘+Enter' : 'Ctrl+Enter'
}

/** 移動先の候補。今いる仕切りは current として印を付ける */
export interface MoveTarget {
  titleId: ID | null
  name: string
  count: number
  current: boolean
}

export function moveTargets(sections: IdeaSection[], idea: Pick<Idea, 'titleId'>, titleExists: (id: ID) => boolean): MoveTarget[] {
  // 削除済みタイトルを指すアイデアは「どのタイトルにも属さない」に表示されている
  const currentTitleId = idea.titleId !== null && titleExists(idea.titleId) ? idea.titleId : null
  return sections.map((s) => ({
    titleId: s.titleId,
    name: sectionDisplayName(s),
    count: s.ideas.length,
    current: s.titleId === currentTitleId,
  }))
}

/** 折りたたんだ仕切りのキー一覧を読み込む（壊れた値は無視） */
export function parseCollapsed(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}
