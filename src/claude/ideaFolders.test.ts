// Claude 側のアイデアのフォルダ（2.9）の部品: cf-… の見分け方・日付の付いた名前・カードの場所・候補の行。
import { describe, expect, it } from 'vitest'
import type { ID, Idea, IdeaFolder } from '../domain/types'
import { claudeFolderId } from './derivedId'
import { ideaPlaceLabel } from './ideaAppend'
import {
  CLAUDE_FOLDER_ID,
  FOLDER_CANDIDATES_MAX,
  IDEA_FOLDER_RECORD_VERSION,
  datedFolderName,
  folderCandidateLines,
  ideaPathLabel,
  isClaudeFolder,
} from './ideaFolders'

function folder(id: ID, titleId: ID | null, parentId: ID | null, name: string, order = 0): IdeaFolder {
  return { id, titleId, parentId, name, order, createdAt: 1, updatedAt: 1 }
}

const titles = { t1: { id: 't1', name: '星の庭' } }

describe('Claude が作ったフォルダの見分け方', () => {
  it('source と id の形（cf-…）の両方がそろった時だけ', () => {
    const id = claudeFolderId(null, null, '新作の相談')
    expect(id).toMatch(CLAUDE_FOLDER_ID)
    expect(IDEA_FOLDER_RECORD_VERSION).toBe(1)
    expect(isClaudeFolder({ id, source: 'claude' })).toBe(true)
    // UUID に source だけ付けたもの・cf- だけで source の無いものは Claude のフォルダではない
    expect(isClaudeFolder({ id: '3f2a9c1b-0000-4000-8000-000000000000', source: 'claude' })).toBe(false)
    expect(isClaudeFolder({ id })).toBe(false)
    // Claude のアイデア（cy-…）の id でもない
    expect(isClaudeFolder({ id: 'cy-abc', source: 'claude' })).toBe(false)
    expect(isClaudeFolder({ id: 5 as unknown as string, source: 'claude' })).toBe(false)
  })
})

describe('日付の付いたフォルダの名前', () => {
  it('日本時間の日付・全角の空白・テーマ（日付の変わり目は日本時間の 0 時）', () => {
    // 日本時間 2026/11/12 23:59 と 2026/11/13 00:00
    expect(datedFolderName(Date.UTC(2026, 10, 12, 14, 59), '港町の新作')).toBe('2026/11/12\u3000港町の新作')
    expect(datedFolderName(Date.UTC(2026, 10, 12, 15, 0), '港町の新作')).toBe('2026/11/13\u3000港町の新作')
  })

  it('テーマはフォルダの名前と同じくそろえ（中の全角の空白は残す）、全体も40字まで', () => {
    const now = Date.UTC(2026, 10, 12, 0, 0)
    expect(datedFolderName(now, '　港町の\n新作　')).toBe('2026/11/12\u3000港町の 新作')
    expect(datedFolderName(now, '港町　新作')).toBe('2026/11/12\u3000港町　新作')
    expect(Array.from(datedFolderName(now, 'あ'.repeat(29)))).toHaveLength(40)
    expect(Array.from(datedFolderName(now, 'あ'.repeat(35)))).toHaveLength(40)
  })
})

describe('カードの場所（ideaPathLabel）', () => {
  const view = {
    titles,
    ideaFolders: {
      A: folder('A', null, null, '新作の相談'),
      B: folder('B', null, 'A', '2026/11/12　港町'),
      T: folder('T', 't1', null, '場面の相談'),
    },
  }
  const card = (titleId: ID | null, folderId?: ID): Pick<Idea, 'titleId' | 'folderId'> => ({
    titleId,
    ...(folderId ? { folderId } : {}),
  })

  it('フォルダの外のカードは ideaPlaceLabel と同じ', () => {
    expect(ideaPathLabel(view, card(null))).toBe(ideaPlaceLabel(titles, card(null)))
    expect(ideaPathLabel(view, card('t1'))).toBe('タイトル『星の庭』のアイデア')
    // フォルダが無い・別の仕切りのフォルダもフォルダの外
    expect(ideaPathLabel(view, card(null, 'missing'))).toBe('ホームのアイデア')
    expect(ideaPathLabel(view, card('t1', 'A'))).toBe('タイトル『星の庭』のアイデア')
  })

  it('フォルダの中のカードは「＞」でフォルダをつなぐ', () => {
    expect(ideaPathLabel(view, card(null, 'B'))).toBe('ホームのアイデア＞新作の相談＞2026/11/12　港町')
    expect(ideaPathLabel(view, card(null, 'A'))).toBe('ホームのアイデア＞新作の相談')
    expect(ideaPathLabel(view, card('t1', 'T'))).toBe('タイトル『星の庭』のアイデア＞場面の相談')
  })
})

describe('候補のフォルダの行', () => {
  it('木の順（1段目、その中の2段目、次の1段目）に「f:… 名前」「f:… 1段目＞2段目」', () => {
    const a = claudeFolderId(null, null, '新作の相談')
    const view = {
      titles,
      ideaFolders: {
        [a]: { ...folder(a, null, null, '新作の相談', 0), source: 'claude' as const },
        '5e6f7a8b-0000-4000-8000-000000000000': folder('5e6f7a8b-0000-4000-8000-000000000000', null, a, '2026/11/12　港町'),
        '9a9a9a9a-0000-4000-8000-000000000000': folder('9a9a9a9a-0000-4000-8000-000000000000', null, null, '', -1),
        't1folder-0000-4000-8000-000000000000': folder('t1folder-0000-4000-8000-000000000000', 't1', null, '場面の相談'),
      },
      ideas: {},
    }
    expect(folderCandidateLines(view, null)).toEqual([
      'f:9a9a9a9a 無題のフォルダ',
      `f:${a.slice(3).replace(/\./g, '').slice(0, 8)} 新作の相談`,
      'f:5e6f7a8b 新作の相談＞2026/11/12　港町',
    ])
    expect(folderCandidateLines(view, 't1')).toEqual(['f:t1folder 場面の相談'])
    expect(folderCandidateLines({ ...view, ideaFolders: {} }, null)).toEqual([])
  })

  it(`${FOLDER_CANDIDATES_MAX}行まで`, () => {
    const ideaFolders: Record<ID, IdeaFolder> = {}
    for (let i = 0; i < 15; i++) {
      const top = `top${String(i).padStart(2, '0')}`
      ideaFolders[top] = folder(top, null, null, `相談${i}`, i)
      ideaFolders[`${top}s`] = folder(`${top}s`, null, top, '中')
    }
    const lines = folderCandidateLines({ titles, ideaFolders, ideas: {} }, null)
    expect(lines).toHaveLength(FOLDER_CANDIDATES_MAX)
    expect(lines.slice(0, 2)).toEqual(['f:top00 相談0', 'f:top00s 相談0＞中'])
  })
})
