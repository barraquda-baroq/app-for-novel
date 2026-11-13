import { describe, expect, it } from 'vitest'
import {
  addIdea,
  createTitle,
  deleteIdea,
  ideaSections,
  moveIdeaStep,
  moveIdeaTo,
  moveIdeaToSection,
  setIdeaChecked,
} from './entityOps'
import {
  createIdeaFolder,
  createIdeaFolderAndMove,
  deleteIdeaFolder,
  ideaFolderNameProblem,
  moveIdeaFolder,
  moveIdeaFolderStep,
  moveIdeas,
  renameIdeaFolder,
  siblingFolders,
} from './ideaFolderOps'
import { buildIdeaTree, folderDepth, type IdeaFolderNode } from './ideaFolders'
import { listTrash, restoreTrashEntry } from './trash'
import { DomainError, emptyData, type AppData, type ID, type Idea, type IdeaFolder } from './types'

const names = (nodes: IdeaFolderNode[]) => nodes.map((n) => n.folder.name)
const bodies = (list: Idea[]) => list.map((i) => i.body)

/** タイトル「星の庭」「灰の街」と、どのタイトルにも属さない仕切り */
function base() {
  const a = createTitle(emptyData(), '星の庭')
  const b = createTitle(a.data, '灰の街')
  return { data: b.data, star: a.result, ash: b.result }
}

function folderIn(data: AppData, titleId: ID | null, parentId: ID | null, name: string) {
  const r = createIdeaFolder(data, titleId, parentId, name)
  return { data: r.data, id: r.result }
}

function card(data: AppData, titleId: ID | null, body: string, folderId: ID | null = null) {
  const r = addIdea(data, titleId, '', body, folderId)
  return { data: r.data, id: r.result }
}

/** 星の庭: 1段目「場面」（中に「雨の駅」「港」）と「筋」。カードは各所に */
function fixture() {
  const b = base()
  let r = folderIn(b.data, b.star, null, '場面')
  const scene = r.id
  r = folderIn(r.data, b.star, null, '筋')
  const plot = r.id
  r = folderIn(r.data, b.star, scene, '雨の駅')
  const rain = r.id
  r = folderIn(r.data, b.star, scene, '港')
  const port = r.id
  let data = r.data
  const ids: Record<string, ID> = {}
  for (const [body, fid] of [
    ['場面1', scene],
    ['場面2', scene],
    ['雨1', rain],
    ['雨2', rain],
    ['港1', port],
    ['筋1', plot],
    ['外1', null],
  ] as const) {
    const c = card(data, b.star, body, fid)
    data = c.data
    ids[body] = c.id
  }
  return { ...b, data, scene, plot, rain, port, ids }
}

describe('フォルダを作る', () => {
  it('兄弟の上（order は兄弟の最小 − 1）に入る。どちらの段も。名前はそろえて（前後の空白・改行）、中の全角の空白は残す', () => {
    const f = fixture()
    expect(names(buildIdeaTree(f.data, f.star).folders)).toEqual(['筋', '場面'])
    expect(names(buildIdeaTree(f.data, f.star).folders[1].folders)).toEqual(['港', '雨の駅'])
    expect(f.data.ideaFolders[f.scene].order).toBe(0)
    expect(f.data.ideaFolders[f.plot].order).toBe(-1)
    const r = folderIn(f.data, f.star, f.scene, '　2026/11/13　港町\n')
    expect(r.data.ideaFolders[r.id]).toMatchObject({
      titleId: f.star,
      parentId: f.scene,
      name: '2026/11/13　港町',
      order: Math.min(r.data.ideaFolders[f.rain].order, r.data.ideaFolders[f.port].order) - 1,
    })
    expect(r.data.ideaFolders[r.id].source).toBeUndefined()
    // どのタイトルにも属さない仕切りにも作れる
    const home = folderIn(f.data, null, null, '新作の相談')
    expect(names(buildIdeaTree(home.data, null).folders)).toEqual(['新作の相談'])
    expect(home.data.ideaFolders[home.id].order).toBe(0)
  })

  it('断る: 3段目・同じ段の同じ名前（字の幅・空白の違いも同じ）・空・41字・無いタイトル・無い親・別の仕切りの親', () => {
    const f = fixture()
    expect(() => createIdeaFolder(f.data, f.star, f.rain, '3段目')).toThrow('3段目のフォルダは作れません')
    expect(() => createIdeaFolder(f.data, f.ash, f.scene, '別の仕切り')).toThrow('3段目のフォルダは作れません')
    expect(() => createIdeaFolder(f.data, f.star, null, ' 場面 ')).toThrow('同じ名前のフォルダがもうあります')
    expect(() => createIdeaFolder(f.data, f.star, f.scene, '雨の駅')).toThrow('同じ名前のフォルダがもうあります')
    const wide = folderIn(f.data, f.star, null, 'ＡＢ　メモ').data
    expect(() => createIdeaFolder(wide, f.star, null, 'AB メモ')).toThrow('同じ名前のフォルダがもうあります')
    expect(() => createIdeaFolder(f.data, f.star, null, ' \n　')).toThrow('フォルダの名前を入れてください')
    expect(() => createIdeaFolder(f.data, f.star, null, 'あ'.repeat(41))).toThrow('フォルダの名前は40字までです')
    expect(createIdeaFolder(f.data, f.star, null, 'あ'.repeat(40)).data).not.toBe(f.data)
    expect(() => createIdeaFolder(f.data, 'nope', null, 'x')).toThrow('タイトルが見つかりません')
    expect(() => createIdeaFolder(f.data, f.star, 'nope', 'x')).toThrow('フォルダが見つかりません')
    // 同じ名前でも、別の段・別の仕切りなら作れる
    expect(() => createIdeaFolder(f.data, f.star, f.scene, '筋')).not.toThrow()
    expect(() => createIdeaFolder(f.data, f.ash, null, '場面')).not.toThrow()
    expect(() => createIdeaFolder(f.data, null, null, '場面')).not.toThrow()
  })

  it('ideaFolderNameProblem は画面の入力の確かめにも使える（名前を変えるフォルダ自身とは比べない）', () => {
    const f = fixture()
    const top = { titleId: f.star, parentId: null }
    expect(ideaFolderNameProblem(f.data, top, '新しい')).toBeNull()
    expect(ideaFolderNameProblem(f.data, top, '場面')).toBe('同じ名前のフォルダがもうあります')
    expect(ideaFolderNameProblem(f.data, top, '場面', f.scene)).toBeNull()
    expect(ideaFolderNameProblem(f.data, top, '')).toBe('フォルダの名前を入れてください')
    expect(ideaFolderNameProblem(f.data, top, 'あ'.repeat(41))).toBe('フォルダの名前は40字までです')
  })
})

describe('フォルダの名前を変える・並べ替える', () => {
  it('名前を変える（同じ段の同じ名前は断る）。変わらなければ書き込まない。Claude のフォルダは印をそのまま', () => {
    const f = fixture()
    let data = renameIdeaFolder(f.data, f.rain, ' 雨の駅舎 ')
    expect(data.ideaFolders[f.rain].name).toBe('雨の駅舎')
    expect(renameIdeaFolder(data, f.rain, '雨の駅舎')).toBe(data)
    expect(renameIdeaFolder(data, f.rain, '雨の駅舎\n')).toBe(data)
    expect(() => renameIdeaFolder(data, f.rain, '港')).toThrow('同じ名前のフォルダがもうあります')
    expect(() => renameIdeaFolder(data, f.rain, '')).toThrow('フォルダの名前を入れてください')
    expect(() => renameIdeaFolder(data, 'nope', 'x')).toThrow('フォルダが見つかりません')
    // 別の段の同じ名前はよい
    data = renameIdeaFolder(data, f.rain, '筋')
    expect(data.ideaFolders[f.rain].name).toBe('筋')
    const claude = {
      ...data,
      ideaFolders: {
        ...data.ideaFolders,
        'cf-x.y': { ...data.ideaFolders[f.plot], id: 'cf-x.y', name: '2026/11/12　港町', source: 'claude' as const, v: 1 },
      },
    }
    const renamed = renameIdeaFolder(claude, 'cf-x.y', '港町の相談')
    expect(renamed.ideaFolders['cf-x.y']).toMatchObject({ name: '港町の相談', source: 'claude', v: 1 })
  })

  it('同じ段（仕切り＋親）の中で上下に動かす。端では動かない', () => {
    const f = fixture()
    let data = moveIdeaFolderStep(f.data, f.scene, -1)
    expect(names(buildIdeaTree(data, f.star).folders)).toEqual(['場面', '筋'])
    expect(moveIdeaFolderStep(data, f.scene, -1)).toBe(data)
    data = moveIdeaFolderStep(data, f.port, 1)
    expect(names(buildIdeaTree(data, f.star).folders[0].folders)).toEqual(['雨の駅', '港'])
    expect(moveIdeaFolderStep(data, f.port, 1)).toBe(data)
    expect(moveIdeaFolderStep(data, 'nope', 1)).toBe(data)
  })
})

describe('フォルダを移す', () => {
  it('2段目をほかの1段目へ（同じ仕切り）。位置を選べる（既定は先頭）', () => {
    const f = fixture()
    let data = folderIn(f.data, f.star, f.plot, '伏線').data
    data = moveIdeaFolder(data, f.rain, { titleId: f.star, parentId: f.plot })
    expect(names(buildIdeaTree(data, f.star).folders[0].folders)).toEqual(['雨の駅', '伏線'])
    expect(names(buildIdeaTree(data, f.star).folders[1].folders)).toEqual(['港'])
    data = moveIdeaFolder(data, f.port, { titleId: f.star, parentId: f.plot }, 5)
    expect(names(buildIdeaTree(data, f.star).folders[0].folders)).toEqual(['雨の駅', '伏線', '港'])
    // 中のカードは一緒（folderId はそのまま）
    expect(bodies(buildIdeaTree(data, f.star).folders[0].folders[0].ideas)).toEqual(['雨1', '雨2'])
  })

  it('2段目を別の仕切りの1段目へ: フォルダと中のカードの titleId を書き換え、folderId はそのまま', () => {
    const f = fixture()
    let r = folderIn(f.data, f.ash, null, '街の場面')
    const data = moveIdeaFolder(r.data, f.rain, { titleId: f.ash, parentId: r.id })
    expect(data.ideaFolders[f.rain]).toMatchObject({ titleId: f.ash, parentId: r.id })
    expect(data.ideas[f.ids['雨1']]).toMatchObject({ titleId: f.ash, folderId: f.rain })
    expect(bodies(buildIdeaTree(data, f.ash).folders[0].folders[0].ideas)).toEqual(['雨1', '雨2'])
    expect(names(buildIdeaTree(data, f.star).folders[1].folders)).toEqual(['港'])
    // ホームの1段目へも
    r = folderIn(data, null, null, '新作の相談')
    const home = moveIdeaFolder(r.data, f.port, { titleId: null, parentId: r.id })
    expect(home.ideas[f.ids['港1']]).toMatchObject({ titleId: null, folderId: f.port })
  })

  it('2段目を1段目にする・中にフォルダの無い1段目をほかの1段目の中へ（任せるで作られたフォルダの整理）', () => {
    const f = fixture()
    let data = moveIdeaFolder(f.data, f.rain, { titleId: f.star, parentId: null }, 1)
    expect(names(buildIdeaTree(data, f.star).folders)).toEqual(['筋', '雨の駅', '場面'])
    expect(data.ideaFolders[f.rain].parentId).toBeNull()
    data = moveIdeaFolder(data, f.plot, { titleId: f.star, parentId: f.scene }, 0)
    expect(names(buildIdeaTree(data, f.star).folders)).toEqual(['雨の駅', '場面'])
    expect(names(buildIdeaTree(data, f.star).folders[1].folders)).toEqual(['筋', '港'])
    expect(bodies(buildIdeaTree(data, f.star).folders[1].folders[0].ideas)).toEqual(['筋1'])
  })

  it('中にフォルダのある1段目は、別の仕切りの1段目へだけ移せる（中のフォルダ・カードも一緒に。つながりはそのまま）', () => {
    const f = fixture()
    expect(() => moveIdeaFolder(f.data, f.scene, { titleId: f.star, parentId: f.plot })).toThrow(
      '中にフォルダがあるフォルダは、ほかのフォルダの中へは移せません（3段目は作れません）',
    )
    const data = moveIdeaFolder(f.data, f.scene, { titleId: f.ash, parentId: null })
    const tree = buildIdeaTree(data, f.ash)
    expect(names(tree.folders)).toEqual(['場面'])
    expect(names(tree.folders[0].folders)).toEqual(['港', '雨の駅'])
    expect(tree.count).toBe(5)
    expect(data.ideaFolders[f.rain]).toMatchObject({ titleId: f.ash, parentId: f.scene })
    expect(data.ideas[f.ids['場面1']]).toMatchObject({ titleId: f.ash, folderId: f.scene })
    expect(buildIdeaTree(data, f.star).count).toBe(2)
  })

  it('断る: 自分の中・2段目の中（3段目）・移す先の同じ名前・無いタイトル・無いフォルダ', () => {
    const f = fixture()
    expect(() => moveIdeaFolder(f.data, f.plot, { titleId: f.star, parentId: f.plot })).toThrow(
      'フォルダをそのフォルダの中へは移せません',
    )
    expect(() => moveIdeaFolder(f.data, f.plot, { titleId: f.star, parentId: f.rain })).toThrow('3段目のフォルダは作れません')
    const dup = folderIn(f.data, f.star, f.plot, '港').data
    expect(() => moveIdeaFolder(dup, f.port, { titleId: f.star, parentId: f.plot })).toThrow(
      '移す先に同じ名前のフォルダがあります',
    )
    expect(() => moveIdeaFolder(f.data, f.port, { titleId: 'nope', parentId: null })).toThrow('タイトルが見つかりません')
    expect(() => moveIdeaFolder(f.data, f.port, { titleId: f.star, parentId: 'nope' })).toThrow('フォルダが見つかりません')
    expect(() => moveIdeaFolder(f.data, 'nope', { titleId: f.star, parentId: null })).toThrow('フォルダが見つかりません')
  })

  it('同じ入れ物の中なら位置だけを変える（自分の名前とは比べない）', () => {
    const f = fixture()
    const data = moveIdeaFolder(f.data, f.plot, { titleId: f.star, parentId: null }, 1)
    expect(names(buildIdeaTree(data, f.star).folders)).toEqual(['場面', '筋'])
  })
})

describe('フォルダの削除（ゴミ箱の1件）', () => {
  it('フォルダ・中のフォルダ・カードを1件にまとめる（中身の順・戻す位置・場所の表記）', () => {
    const f = fixture()
    let data = setIdeaChecked(f.data, f.ids['場面1'], true)
    data = deleteIdeaFolder(data, f.scene)
    expect(data.ideaFolders[f.scene]).toBeUndefined()
    expect(data.ideaFolders[f.rain]).toBeUndefined()
    expect(data.ideas[f.ids['雨1']]).toBeUndefined()
    expect(data.ideas[f.ids['筋1']]).toBeDefined()
    const [entry] = listTrash(data.trashEntries)
    expect(entry).toMatchObject({
      kind: 'ideaFolder',
      label: '場面',
      titleName: '星の庭',
      origin: { titleId: f.star, index: 0, prevId: f.plot },
    })
    expect(entry.parentLabel).toBeUndefined()
    const contents = entry.recordIds.map((id) => data.trashRecords[id].record as { id: ID })
    expect(contents.map((r) => r.id)).toEqual([
      f.scene,
      f.port,
      f.rain,
      f.ids['場面2'],
      f.ids['場面1'],
      f.ids['港1'],
      f.ids['雨1'],
      f.ids['雨2'],
    ])
    // 2段目は親の名前を場所の表記に控える。空のフォルダは中身が1つ
    const sub = deleteIdeaFolder(f.data, f.port)
    const [subEntry] = listTrash(sub.trashEntries)
    expect(subEntry).toMatchObject({ kind: 'ideaFolder', label: '港', parentLabel: '場面', origin: { titleId: f.star } })
    expect(subEntry.recordIds).toHaveLength(2)
    expect(deleteIdeaFolder(f.data, 'nope')).toBe(f.data)
  })

  it('ホームのフォルダは タイトル名が空、仕切りは null', () => {
    const r = folderIn(emptyData(), null, null, '新作の相談')
    const data = deleteIdeaFolder(r.data, r.id)
    const [entry] = listTrash(data.trashEntries)
    expect(entry).toMatchObject({ titleName: '', origin: { titleId: null, prevId: null } })
  })
})

describe('カードをまとめて移す', () => {
  it('今の見せる順で、移す先の末尾へ。済みは済みのまま（order も付ける）。もう無いカードは飛ばし、移した数を返す', () => {
    const f = fixture()
    let data = setIdeaChecked(f.data, f.ids['場面1'], true)
    const r = folderIn(data, null, null, '新作の相談')
    data = card(r.data, null, '相談1', r.id).data
    const moved = moveIdeas(data, [f.ids['外1'], f.ids['場面1'], f.ids['雨2'], f.ids['場面2'], 'gone'], {
      titleId: null,
      folderId: r.id,
    })
    expect(moved.result).toBe(4)
    const target = buildIdeaTree(moved.data, null).folders[0]
    // 見せる順: 場面の中の雨の駅（雨2）→ 場面（場面2・済みの場面1）→ フォルダの外（外1）。済みは下にまとまる
    expect(bodies(target.ideas)).toEqual(['相談1', '雨2', '場面2', '外1', '場面1'])
    const ordered = Object.values(moved.data.ideas)
      .filter((i) => i.folderId === r.id)
      .sort((a, b) => a.order - b.order)
    expect(bodies(ordered)).toEqual(['相談1', '雨2', '場面2', '場面1', '外1'])
    expect(moved.data.ideas[f.ids['場面1']]).toMatchObject({ checked: true, titleId: null, folderId: r.id })
    expect(moveIdeas(data, ['gone'], { titleId: null, folderId: r.id }).result).toBe(0)
  })

  it('フォルダの外へ移すと folderId の項目を消す。移す先を確かめる', () => {
    const f = fixture()
    const moved = moveIdeas(f.data, [f.ids['雨1'], f.ids['筋1']], { titleId: f.star, folderId: null })
    expect('folderId' in moved.data.ideas[f.ids['雨1']]).toBe(false)
    // 見せる順（筋が場面の上）のまま末尾へ
    expect(bodies(buildIdeaTree(moved.data, f.star).loose)).toEqual(['外1', '筋1', '雨1'])
    expect(() => moveIdeas(f.data, [f.ids['雨1']], { titleId: f.ash, folderId: f.scene })).toThrow('フォルダが見つかりません')
    expect(() => moveIdeas(f.data, [f.ids['雨1']], { titleId: 'nope', folderId: null })).toThrow('タイトルが見つかりません')
  })

  it('新しいフォルダを作って移す（1回の操作。名前を断られれば何も変えない）', () => {
    const f = fixture()
    const r = createIdeaFolderAndMove(f.data, f.star, f.plot, '2026/11/13　港町', [f.ids['外1'], f.ids['港1']])
    expect(r.result.moved).toBe(2)
    const folder = r.data.ideaFolders[r.result.folderId]
    expect(folder).toMatchObject({ titleId: f.star, parentId: f.plot, name: '2026/11/13　港町' })
    expect(bodies(buildIdeaTree(r.data, f.star).folders[0].folders[0].ideas)).toEqual(['港1', '外1'])
    expect(() => createIdeaFolderAndMove(f.data, f.star, null, '場面', [f.ids['外1']])).toThrow(DomainError)
    expect(() => createIdeaFolderAndMove(f.data, f.star, f.rain, '3段目', [f.ids['外1']])).toThrow('3段目のフォルダは作れません')
  })
})

describe('null の folderId は書かない', () => {
  it('どの操作の後も、カードに folderId: null は無い（フォルダの外は項目なし）', () => {
    const f = fixture()
    let data = f.data
    const steps: ((d: AppData) => AppData)[] = [
      (d) => moveIdeaTo(d, f.ids['雨1'], f.star, 0),
      (d) => moveIdeaTo(d, f.ids['雨1'], f.star, 0, f.port),
      (d) => moveIdeaToSection(d, f.ids['雨2'], f.ash),
      (d) => moveIdeas(d, [f.ids['場面1'], f.ids['港1']], { titleId: null, folderId: null }).data,
      (d) => setIdeaChecked(d, f.ids['筋1'], true),
      (d) => setIdeaChecked(d, f.ids['筋1'], false),
      (d) => moveIdeaStep(d, f.ids['場面2'], 1),
      (d) => moveIdeaFolder(d, f.rain, { titleId: f.ash, parentId: null }),
      (d) => deleteIdeaFolder(d, f.scene),
      (d) => restoreTrashEntry(d, listTrash(d.trashEntries)[0].id).data,
      (d) => deleteIdea(d, f.ids['港1']),
      (d) => deleteIdeaFolder(d, f.port),
      (d) => restoreTrashEntry(d, listTrash(d.trashEntries).find((e) => e.kind === 'idea')!.id).data,
      (d) => createIdeaFolderAndMove(d, f.star, null, '新しい', [f.ids['外1'], f.ids['雨1']]).data,
      (d) => moveIdeas(d, [f.ids['外1']], { titleId: f.star, folderId: null }).data,
    ]
    for (const step of steps) {
      data = step(data)
      for (const i of Object.values(data.ideas)) {
        expect(Object.prototype.hasOwnProperty.call(i, 'folderId') ? i.folderId : 'absent').not.toBeNull()
      }
    }
    // 仕切りの数はそのまま
    expect(ideaSections(data)).toHaveLength(3)
  })

  it('siblingFolders は見せ方の段で並べる（1段目として見せる、親の切れたフォルダも1段目の兄弟）', () => {
    const f = fixture()
    const data = {
      ...f.data,
      ideaFolders: {
        ...f.data.ideaFolders,
        odd: { ...f.data.ideaFolders[f.plot], id: 'odd', name: '親が無い', parentId: 'gone' },
      },
    }
    expect(siblingFolders(data, { titleId: f.star, parentId: null }).map((x) => x.id)).toContain('odd')
  })
})

describe('1段目として見せているのに親へのつながりが残るフォルダ（同期で移動がぶつかった）', () => {
  const rec = (id: ID, name: string, parentId: ID | null, order: number): IdeaFolder => ({
    id,
    titleId: null,
    parentId,
    name,
    order,
    createdAt: 1,
    updatedAt: 1,
  })
  const withFolders = (...folders: IdeaFolder[]): AppData => ({
    ...emptyData(),
    ideaFolders: Object.fromEntries(folders.map((f) => [f.id, f])),
  })
  /** ホームの木（1段目の名前と、中のフォルダの名前） */
  const shape = (data: AppData) => buildIdeaTree(data, null).folders.map((n) => [n.folder.name, names(n.folders)])
  /**
   * C→A→B: 端末1が A（中にフォルダなし）を B の中へ移し、同じ時に端末2（かコネクタ）が A の中に C を作った（まとめた後の形）。
   * A は B の中の2段目、C は1段目に見える
   */
  const chain = () => withFolders(rec('b', 'B', null, 0), rec('a', 'A', 'b', 0), rec('c', 'C', 'a', 1))
  /** A↔B: 2台が同じ時に A を B の中へ・B を A の中へ移した。どちらも1段目に見える */
  const cycle = () => withFolders(rec('a', 'A', 'b', 0), rec('b', 'B', 'a', 1))

  it('C→A→B: C の中にフォルダを作れる（C のつながりを同じ操作で消す）。新しいフォルダは C の中の2段目', () => {
    const data = chain()
    expect(shape(data)).toEqual([
      ['B', ['A']],
      ['C', []],
    ])
    expect(folderDepth(data, data.ideaFolders.c)).toBe(1)
    const r = createIdeaFolder(data, null, 'c', 'X')
    expect(r.data.ideaFolders.c).toMatchObject({ parentId: null, name: 'C', order: 1 })
    expect(r.data.ideaFolders[r.result]).toMatchObject({ titleId: null, parentId: 'c', name: 'X' })
    expect(folderDepth(r.data, r.data.ideaFolders[r.result])).toBe(2)
    expect(shape(r.data)).toEqual([
      ['B', ['A']],
      ['C', ['X']],
    ])
    // 後で A を1段目にしても、C は A の中へ動かない
    expect(shape(moveIdeaFolder(r.data, 'a', { titleId: null, parentId: null }, 2))).toEqual([
      ['B', []],
      ['C', ['X']],
      ['A', []],
    ])
    // 新しいフォルダを作って移す・C の中へ移すも同じ
    const c = card(data, null, '案')
    const made = createIdeaFolderAndMove(c.data, null, 'c', 'Y', [c.id])
    expect(made.data.ideaFolders.c.parentId).toBeNull()
    expect(buildIdeaTree(made.data, null).folders[1].folders[0].ideas.map((i) => i.id)).toEqual([c.id])
    const other = withFolders(...Object.values(data.ideaFolders), rec('d', 'D', null, 2))
    const moved = moveIdeaFolder(other, 'd', { titleId: null, parentId: 'c' })
    expect([moved.ideaFolders.c.parentId, moved.ideaFolders.d.parentId]).toEqual([null, 'c'])
    expect(shape(moved)).toEqual([
      ['B', ['A']],
      ['C', ['D']],
    ])
    // 2段目に見えるフォルダ（A）の中へは今までどおり作れない
    expect(() => createIdeaFolder(data, null, 'a', 'X')).toThrow('3段目のフォルダは作れません')
  })

  it('C→A→B: 「1段目にする」（今の場所・今の位置）でも、つながりを消して書く。後で A が1段目に戻っても C は動かない', () => {
    const data = chain()
    const top = moveIdeaFolder(data, 'c', { titleId: null, parentId: null }, 1)
    expect(top.ideaFolders.c).toMatchObject({ parentId: null, order: 1 })
    expect(top.ideaFolders.c.updatedAt).toBeGreaterThan(1)
    expect(shape(top)).toEqual(shape(data))
    expect(shape(moveIdeaFolder(top, 'a', { titleId: null, parentId: null }, 2))).toEqual([
      ['B', []],
      ['C', []],
      ['A', []],
    ])
    // 記録も見せ方も同じ場所・同じ位置なら書かない
    expect(moveIdeaFolder(top, 'c', { titleId: null, parentId: null }, 1).ideaFolders).toBe(top.ideaFolders)
  })

  it('A↔B の輪: どちらの中にもフォルダを作れ、ほかの1段目の中へ移せる（親にする方のつながりを消す）。1段目にもできる', () => {
    const data = cycle()
    expect(shape(data)).toEqual([
      ['A', []],
      ['B', []],
    ])
    // A の中に作る: A のつながりを消す。記録で A の中にある B は、A の中に見える
    const r = createIdeaFolder(data, null, 'a', 'X')
    expect(r.data.ideaFolders.a.parentId).toBeNull()
    expect(shape(r.data)).toEqual([['A', ['X', 'B']]])
    for (const f of Object.values(r.data.ideaFolders)) expect(folderDepth(r.data, f)).toBe(f.id === 'a' ? 1 : 2)
    // A を B の中へ: B のつながりを消し、A は B の中の2段目
    const into = moveIdeaFolder(data, 'a', { titleId: null, parentId: 'b' })
    expect([into.ideaFolders.a.parentId, into.ideaFolders.b.parentId]).toEqual(['b', null])
    expect(shape(into)).toEqual([['B', ['A']]])
    // A を1段目にする（今の場所）: A のつながりを消す
    const top = moveIdeaFolder(data, 'a', { titleId: null, parentId: null }, 0)
    expect(top.ideaFolders.a.parentId).toBeNull()
    expect(shape(top)).toEqual([['A', ['B']]])
  })
})
