// Claude 側のアイデアのフォルダ（2.9）の小さな部品。Claude がコネクタで作るフォルダ（id は cf-…）の形と見分け方、日付の付いた
// フォルダの名前、Claude に見せるカードの場所（「ホームのアイデア＞新作の相談＞2026/11/12　港町」）と、候補のフォルダの行。
// コネクタ（アイデアを足す・Claude に見せる一覧）とアプリ（「Claude が作成」の印）が同じものを使う。
// どこに出すかは src/domain/ideaFolders.ts の決まりだけで決める（ここはその上の表記だけ）。visibility.ts からは読み込まない。
import {
  buildIdeaTree,
  effectiveFolderId,
  folderPathLabel,
  ideaFolderName,
  normalizeFolderName,
  type IdeaFolderData,
} from '../domain/ideaFolders'
import type { ID, Idea, IdeaFolder, Title } from '../domain/types'
import { jstSlashDate } from './dates'
import { ideaPlaceLabel } from './ideaAppend'
import { shortId } from './refs'

/** Claude が作るフォルダの id（derivedId.ts の claudeFolderId。アクセスルールでも同じ形を求める） */
export const CLAUDE_FOLDER_ID = /^cf-[0-9a-z.]+$/

/** Claude が作るフォルダの記録の形の版 */
export const IDEA_FOLDER_RECORD_VERSION = 1

/** 候補のフォルダの行の数の上限 */
export const FOLDER_CANDIDATES_MAX = 20

/** Claude の側でフォルダの場所をつなぐ記号（アプリの画面は ' › '） */
export const CLAUDE_PATH_SEP = '＞'

/** Claude がコネクタで作ったフォルダか（source と id の形の両方。source だけでは決めない。id の形はアクセスルールが守る） */
export function isClaudeFolder(f: Pick<IdeaFolder, 'id' | 'source'>): boolean {
  return f.source === 'claude' && typeof f.id === 'string' && CLAUDE_FOLDER_ID.test(f.id)
}

/**
 * 日付の付いたフォルダの名前（「2026/11/12　港町の新作」。日付は日本時間、後ろは全角の空白とテーマ）。
 * normalizeIdeaName は全角の空白を半角にするので使わない（テーマは normalizeFolderName でそろえ、全体も40字まで）
 */
export function datedFolderName(now: number, theme: string): string {
  return normalizeFolderName(`${jstSlashDate(now)}\u3000${normalizeFolderName(theme)}`)
}

type PathView = Pick<IdeaFolderData, 'ideaFolders'> & { titles: Readonly<Record<ID, Pick<Title, 'name'>>> }

/**
 * Claude に見せるカードの場所（ideaPlaceLabel に、入っているフォルダを「＞」でつないだもの。「ホームのアイデア＞新作の相談＞
 * 2026/11/12　港町」）。フォルダの外のカードは ideaPlaceLabel と1字も違わない
 */
export function ideaPathLabel(view: PathView, idea: Pick<Idea, 'titleId' | 'folderId'>): string {
  const place = ideaPlaceLabel(view.titles, idea)
  const fid = effectiveFolderId(view, idea)
  return fid ? `${place}${CLAUDE_PATH_SEP}${folderPathLabel(view, fid, CLAUDE_PATH_SEP)}` : place
}

/**
 * 仕切りのフォルダの候補の行（木の順: 1段目、その中の2段目、次の1段目…。「f:1a2b3c4d 新作の相談」
 * 「f:5e6f7a8b 新作の相談＞2026/11/12　港町」。FOLDER_CANDIDATES_MAX 行まで）
 */
export function folderCandidateLines(view: IdeaFolderData, section: ID | null): string[] {
  const lines: string[] = []
  for (const top of buildIdeaTree(view, section).folders) {
    const name = ideaFolderName(top.folder)
    lines.push(`${shortId('ideaFolder', top.folder.id)} ${name}`)
    for (const sub of top.folders)
      lines.push(`${shortId('ideaFolder', sub.folder.id)} ${name}${CLAUDE_PATH_SEP}${ideaFolderName(sub.folder)}`)
  }
  return lines.slice(0, FOLDER_CANDIDATES_MAX)
}
