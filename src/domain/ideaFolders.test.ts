// アイデアのフォルダ（2.9）の見せ方の決まり（どこに出すか・並び・名前）。
import { describe, expect, it } from 'vitest'
import {
  IDEA_FOLDER_NAME_MAX,
  buildIdeaTree,
  containerKey,
  effectiveFolderId,
  effectiveParentId,
  folderChain,
  folderDepth,
  folderNameKey,
  folderPathLabel,
  folderPathNames,
  folderSubtree,
  ideaFolderName,
  isTopFolder,
  normalizeFolderName,
  sectionOf,
  type IdeaFolderData,
} from './ideaFolders'
import type { ID, Idea, IdeaFolder } from './types'

function folder(id: ID, titleId: ID | null, parentId: ID | null, name: string, order = 0): IdeaFolder {
  return { id, titleId, parentId, name, order, createdAt: 1, updatedAt: 1 }
}

function idea(id: ID, titleId: ID | null, folderId: ID | undefined, order = 0, checkedAt?: number): Idea {
  return {
    id,
    titleId,
    heading: '',
    body: id,
    order,
    ...(checkedAt !== undefined ? { checked: true, checkedAt } : { checked: false, checkedAt: null }),
    ...(folderId !== undefined ? { folderId } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

function data(folders: IdeaFolder[], ideas: Idea[] = [], titles: ID[] = ['t1', 't2']): IdeaFolderData {
  return {
    titles: Object.fromEntries(titles.map((t) => [t, { id: t, name: t }])),
    ideaFolders: Object.fromEntries(folders.map((f) => [f.id, f])),
    ideas: Object.fromEntries(ideas.map((i) => [i.id, i])),
  }
}

describe('仕切り（sectionOf）', () => {
  it('タイトルがあればそのタイトル、無い・null・自分の項目でない id は どのタイトルにも属さない（null）', () => {
    const d = data([])
    expect(sectionOf(d.titles, 't1')).toBe('t1')
    expect(sectionOf(d.titles, 'gone')).toBeNull()
    expect(sectionOf(d.titles, null)).toBeNull()
    expect(sectionOf(d.titles, 3)).toBeNull()
    expect(sectionOf(d.titles, 'constructor')).toBeNull()
  })
})

describe('1段目・2段目（再帰しない決まり）', () => {
  it('親の無い・null のフォルダは1段目。1段目を親に持つ同じ仕切りのフォルダは2段目', () => {
    const d = data([folder('A', 't1', null, '場面の相談'), folder('B', 't1', 'A', '雨の駅')])
    expect(isTopFolder(d, d.ideaFolders.A)).toBe(true)
    expect(effectiveParentId(d, d.ideaFolders.A)).toBeNull()
    expect(effectiveParentId(d, d.ideaFolders.B)).toBe('A')
    expect(folderDepth(d, d.ideaFolders.A)).toBe(1)
    expect(folderDepth(d, d.ideaFolders.B)).toBe(2)
  })

  it('親が無い・自分自身・文字列でない時は1段目', () => {
    const d = data([
      folder('A', 't1', 'missing', 'a'),
      folder('B', 't1', 'B', 'b'),
      { ...folder('C', 't1', null, 'c'), parentId: 5 as unknown as ID },
    ])
    for (const id of ['A', 'B', 'C']) {
      expect(isTopFolder(d, d.ideaFolders[id]), id).toBe(true)
      expect(effectiveParentId(d, d.ideaFolders[id]), id).toBeNull()
    }
  })

  it('輪（A→B、B→A）はどちらもつながりがあるので1段目ではなく、親が1段目でないので、見せる時はどちらも1段目', () => {
    const d = data([folder('A', 't1', 'B', 'a'), folder('B', 't1', 'A', 'b')])
    expect(isTopFolder(d, d.ideaFolders.A)).toBe(false)
    expect(isTopFolder(d, d.ideaFolders.B)).toBe(false)
    expect(effectiveParentId(d, d.ideaFolders.A)).toBeNull()
    expect(effectiveParentId(d, d.ideaFolders.B)).toBeNull()
    const tree = buildIdeaTree(d, 't1')
    expect(tree.folders.map((n) => [n.folder.id, n.depth, n.folders.length])).toEqual([
      ['A', 1, 0],
      ['B', 1, 0],
    ])
  })

  it('3段目（C→A→B、B は1段目）: A は2段目、C の親 A は1段目でないので C は1段目として見せる', () => {
    const d = data([folder('B', 't1', null, 'b'), folder('A', 't1', 'B', 'a'), folder('C', 't1', 'A', 'c')])
    expect(effectiveParentId(d, d.ideaFolders.A)).toBe('B')
    expect(effectiveParentId(d, d.ideaFolders.C)).toBeNull()
    expect(folderDepth(d, d.ideaFolders.C)).toBe(1)
    const tree = buildIdeaTree(d, 't1')
    expect(tree.folders.map((n) => n.folder.id)).toEqual(['B', 'C'])
    expect(tree.folders[0].folders.map((n) => n.folder.id)).toEqual(['A'])
  })

  it('親の親へのつながりが切れていても（A→B、B→無い）、B は1段目なので A は B の中の2段目', () => {
    const d = data([folder('B', 't1', 'missing', 'b'), folder('A', 't1', 'B', 'a')])
    expect(isTopFolder(d, d.ideaFolders.B)).toBe(true)
    expect(effectiveParentId(d, d.ideaFolders.A)).toBe('B')
    expect(buildIdeaTree(d, 't1').folders[0].folders.map((n) => n.folder.id)).toEqual(['A'])
  })

  it('別の仕切りの親はつながりにならず、1段目として見せる（タイトルが無い親子はどちらもホームなので、つながる）', () => {
    const d = data([
      folder('P', 't2', null, 'p'),
      folder('X', 't1', 'P', 'x'),
      folder('Q', 'gone', null, 'q'),
      folder('Y', 'gone2', 'Q', 'y'),
      folder('Z', null, 'Q', 'z'),
    ])
    expect(effectiveParentId(d, d.ideaFolders.X)).toBeNull()
    // タイトルが無いフォルダはホーム（null）の仕切り。ホームの親とつながる
    expect(effectiveParentId(d, d.ideaFolders.Y)).toBe('Q')
    expect(effectiveParentId(d, d.ideaFolders.Z)).toBe('Q')
    expect(buildIdeaTree(d, 't1').folders.map((n) => n.folder.id)).toEqual(['X'])
    expect(buildIdeaTree(d, null).folders.map((n) => [n.folder.id, n.folders.map((s) => s.folder.id)])).toEqual([
      ['Q', ['Y', 'Z']],
    ])
  })
})

describe('カードの入っているフォルダ（effectiveFolderId）', () => {
  const d = data(
    [folder('A', 't1', null, 'a'), folder('B', 't1', 'A', 'b'), folder('H', 'gone', null, 'h')],
    [
      idea('in-top', 't1', 'A'),
      idea('in-sub', 't1', 'B'),
      idea('missing', 't1', 'nope'),
      idea('other', 't2', 'A'),
      idea('both-orphan', 'gone2', 'H'),
      idea('home-in-orphan', null, 'H'),
      idea('loose', 't1', undefined),
      { ...idea('bad', 't1', undefined), folderId: 'constructor' },
    ],
  )
  it('同じ仕切りのフォルダ（どちらの段でも）に入る。無い・別の仕切りのフォルダならフォルダの外', () => {
    expect(effectiveFolderId(d, d.ideas['in-top'])).toBe('A')
    expect(effectiveFolderId(d, d.ideas['in-sub'])).toBe('B')
    expect(effectiveFolderId(d, d.ideas.missing)).toBeNull()
    expect(effectiveFolderId(d, d.ideas.other)).toBeNull()
    expect(effectiveFolderId(d, d.ideas.loose)).toBeNull()
    expect(effectiveFolderId(d, d.ideas.bad)).toBeNull()
  })

  it('カードもフォルダもタイトルが無ければ、どちらもホームなので中に入る', () => {
    expect(effectiveFolderId(d, d.ideas['both-orphan'])).toBe('H')
    expect(effectiveFolderId(d, d.ideas['home-in-orphan'])).toBe('H')
  })

  it('入れ物の鍵は仕切り＋フォルダ', () => {
    expect(containerKey(null, null)).toBe('|')
    expect(containerKey('t1', null)).toBe('t1|')
    expect(containerKey('t1', 'A')).toBe('t1|A')
    expect(containerKey(null, 'A')).not.toBe(containerKey('t1', 'A'))
  })
})

describe('仕切りの木（buildIdeaTree）', () => {
  const d = data(
    [
      folder('A', 't1', null, '場面の相談', 1),
      folder('N', 't1', null, '新しい相談', -1),
      folder('S2', 't1', 'A', '港', 5),
      folder('S1', 't1', 'A', '雨の駅', 0),
      folder('Other', 't2', null, 'ほか'),
    ],
    [
      idea('a-open2', 't1', 'A', 2),
      idea('a-done-old', 't1', 'A', 0, 100),
      idea('a-open1', 't1', 'A', 1),
      idea('a-done-new', 't1', 'A', 3, 200),
      idea('s1-open', 't1', 'S1', 0),
      idea('s1-done', 't1', 'S1', 1, 50),
      idea('loose-done', 't1', undefined, 0, 10),
      idea('loose-open', 't1', undefined, 9),
      idea('t2-card', 't2', 'A', 0),
    ],
  )
  const tree = buildIdeaTree(d, 't1')

  it('どの段でもフォルダは order の順（新しく作った負の order が上）、別の仕切りのフォルダは入らない', () => {
    expect(tree.folders.map((n) => n.folder.id)).toEqual(['N', 'A'])
    expect(tree.folders[1].folders.map((n) => n.folder.id)).toEqual(['S1', 'S2'])
    expect(tree.folders.every((n) => n.depth === 1)).toBe(true)
    expect(tree.folders[1].folders.every((n) => n.depth === 2)).toBe(true)
    expect(tree.folders[1].folders[0].folders).toEqual([])
  })

  it('入れ物ごとに、済みでないカード（order の順）→ 済みのカード（新しく済みにしたものから）', () => {
    expect(tree.folders[1].ideas.map((i) => i.id)).toEqual(['a-open1', 'a-open2', 'a-done-new', 'a-done-old'])
    expect(tree.folders[1].folders[0].ideas.map((i) => i.id)).toEqual(['s1-open', 's1-done'])
    expect(tree.loose.map((i) => i.id)).toEqual(['loose-open', 'loose-done'])
  })

  it('数は下のすべてのカード（中のフォルダも）。別の仕切りのカードは数えない', () => {
    expect(tree.folders[1].count).toBe(6)
    expect(tree.folders[1].done).toBe(3)
    expect(tree.folders[1].folders[0].count).toBe(2)
    expect(tree.folders[1].folders[1].count).toBe(0)
    expect(tree.folders[0].count).toBe(0)
    expect(tree.count).toBe(8)
    expect(tree.done).toBe(4)
    // t2 のカードは t1 のフォルダ A を指しているが、別の仕切りなので t2 のフォルダの外
    const t2 = buildIdeaTree(d, 't2')
    expect(t2.loose.map((i) => i.id)).toEqual(['t2-card'])
    expect(t2.folders.map((n) => [n.folder.id, n.count])).toEqual([['Other', 0]])
  })

  it('フォルダもカードも無い仕切りは空', () => {
    expect(buildIdeaTree(d, null)).toEqual({ folders: [], loose: [], count: 0, done: 0 })
  })
})

describe('フォルダの場所と中身', () => {
  const d = data(
    [
      folder('A', null, null, '新作の相談'),
      folder('B', null, 'A', '2026/11/12　港町', 1),
      folder('C', null, 'A', '', 0),
      folder('X', null, 'B', '3段目'),
    ],
    [idea('a1', null, 'A', 0), idea('b1', null, 'B', 0), idea('c1', null, 'C', 0), idea('x1', null, 'X', 0)],
  )

  it('つながり・名前・表記（名前が空なら「無題のフォルダ」）', () => {
    expect(folderChain(d, 'B').map((f) => f.id)).toEqual(['A', 'B'])
    expect(folderChain(d, 'A').map((f) => f.id)).toEqual(['A'])
    expect(folderChain(d, 'X').map((f) => f.id)).toEqual(['X'])
    expect(folderChain(d, 'missing')).toEqual([])
    expect(folderChain(d, undefined)).toEqual([])
    expect(folderPathNames(d, 'B')).toEqual(['新作の相談', '2026/11/12　港町'])
    expect(folderPathNames(d, 'C')).toEqual(['新作の相談', '無題のフォルダ'])
    expect(folderPathLabel(d, 'B')).toBe('新作の相談 › 2026/11/12　港町')
    expect(folderPathLabel(d, 'B', '＞')).toBe('新作の相談＞2026/11/12　港町')
    expect(folderPathLabel(d, null)).toBe('')
    expect(ideaFolderName({ name: '  ' })).toBe('無題のフォルダ')
  })

  it('中身: そのフォルダと中のフォルダ（order の順）、カードは中のフォルダのものを先に、見せる順で', () => {
    const sub = folderSubtree(d, 'A')
    expect(sub.folders.map((f) => f.id)).toEqual(['A', 'C', 'B'])
    expect(sub.ideas.map((i) => i.id)).toEqual(['c1', 'b1', 'a1'])
    // 3段目として指していた X は1段目として見せるので、A の中身ではない
    expect(folderSubtree(d, 'X')).toEqual({ folders: [d.ideaFolders.X], ideas: [d.ideas.x1] })
    expect(folderSubtree(d, 'B')).toEqual({ folders: [d.ideaFolders.B], ideas: [d.ideas.b1] })
    expect(folderSubtree(d, 'missing')).toEqual({ folders: [], ideas: [] })
  })
})

describe('フォルダの名前', () => {
  it('中の全角の空白は残し、前後の空白（全角も）を除く。改行・タブは半角の空白に、続く半角の空白は1つに', () => {
    expect(normalizeFolderName('2026/11/12　港町')).toBe('2026/11/12　港町')
    expect(normalizeFolderName('　 新作の相談 　')).toBe('新作の相談')
    expect(normalizeFolderName('場面の\n相談')).toBe('場面の 相談')
    expect(normalizeFolderName('場面の\r\n\t相談')).toBe('場面の 相談')
    expect(normalizeFolderName('a    b')).toBe('a b')
    expect(normalizeFolderName('a　　b')).toBe('a　　b')
    expect(normalizeFolderName('')).toBe('')
    expect(normalizeFolderName('\n　\n')).toBe('')
  })

  it('NFC にそろえ、40字まで（サロゲートペアは1字。切った後の終わりの空白も除く）', () => {
    expect(normalizeFolderName('か\u3099')).toBe('が')
    const long = '𠮷'.repeat(45)
    expect(Array.from(normalizeFolderName(long))).toHaveLength(IDEA_FOLDER_NAME_MAX)
    expect(normalizeFolderName(`${'あ'.repeat(39)}　い`)).toBe('あ'.repeat(39))
  })

  it('同じ名前と見なす鍵: 字の幅・空白の違いは同じ', () => {
    expect(folderNameKey('新作の相談')).toBe(folderNameKey(' 新作の相談　'))
    expect(folderNameKey('2026/11/12　港町')).toBe(folderNameKey('2026/11/12 港町'))
    expect(folderNameKey('ＡＢＣ　１２３')).toBe(folderNameKey('ABC 123'))
    expect(folderNameKey('場面の相談')).not.toBe(folderNameKey('場面の 相談'))
  })
})
