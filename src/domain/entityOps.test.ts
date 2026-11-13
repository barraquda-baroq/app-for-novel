import { describe, expect, it } from 'vitest'
import { parseBackup, toBackup } from './backup'
import { diffSummary, diffTexts } from './diff'
import {
  addCategory,
  addEntry,
  addIdea,
  addMemo,
  addSubmission,
  categoriesOf,
  compareSnapshotWithCurrent,
  createTitle,
  deleteSubmission,
  deleteIdea,
  deleteTitle,
  entriesOf,
  ideaSections,
  memosOf,
  missingActiveLabel,
  moveIdeaStep,
  moveIdeaTo,
  moveIdeaToSection,
  moveSubmissionStep,
  moveTitleTo,
  recordSubmissionSnapshot,
  setIdeaChecked,
  snapshotPieceBody,
  snapshotText,
  sortedTitles,
  submissionsReferencingVersion,
  submissionsOf,
  titleLastEdited,
  titleSummary,
  trashIdea,
  updateCategory,
  updateIdea,
  updateSubmission,
} from './entityOps'
import { hashJson } from './hash'
import { ideaEditedByAuthor } from '../claude/ideaAppend'
import { transact } from './tx'
import { addEpisode, deleteVersion, setActiveVersion, updateVersion } from './storyOps'
import { countChars, textStats } from './text'
import { repairData } from './repair'
import { listTrash, restoreTrashEntry } from './trash'
import { DomainError, emptyData, type AppData, type Idea, type IdeaFolder, type Submission } from './types'

describe('アイデア領域', () => {
  it('タイトルを増やすと仕切りが増え、どのタイトルにも属さない仕切りが常に最後にある', () => {
    let data = emptyData()
    expect(ideaSections(data).map((s) => s.name)).toEqual(['どのタイトルにも属さない'])
    data = createTitle(data, '作品A').data
    data = createTitle(data, '作品B').data
    expect(ideaSections(data).map((s) => s.name)).toEqual(['作品A', '作品B', 'どのタイトルにも属さない'])
  })

  it('アイデアを仕切り間で移動・並べ替えでき、タイトル削除時はどのタイトルにも属さないへ移る', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const a = addIdea(data, null, '案1')
    data = a.data
    const b = addIdea(data, null, '案2')
    data = b.data
    data = moveIdeaStep(data, b.result, -1)
    expect(ideaSections(data)[1].ideas.map((i) => i.heading)).toEqual(['案2', '案1'])
    data = moveIdeaToSection(data, a.result, t.result)
    expect(ideaSections(data)[0].ideas.map((i) => i.heading)).toEqual(['案1'])
    data = deleteTitle(data, t.result)
    expect(ideaSections(data)).toHaveLength(1)
    expect(ideaSections(data)[0].ideas.map((i) => i.heading)).toEqual(['案2', '案1'])
  })
})

describe('アイデアの書き換え・ゴミ箱（2.8）', () => {
  /** タイトル1つと、その仕切りの作者のアイデア2つ・Claude のアイデア1つ（済みのもの1つ） */
  function ideaFixture() {
    const t = createTitle(emptyData(), '灰の庭')
    let data = t.data
    const a = addIdea(data, t.result, '', '案1')
    data = a.data
    const b = addIdea(data, t.result, '', '案2')
    data = setIdeaChecked(b.data, b.result, true)
    const body = '2026/11/12 14:32\u3000第3章の動機\n・兄を探す'
    const claude: Idea = {
      id: 'cy-abc123.def',
      titleId: t.result,
      heading: '',
      body,
      checked: false,
      checkedAt: null,
      order: -1,
      source: 'claude',
      v: 1,
      claudeHash: hashJson(body),
      appendIds: ['cu-a'],
      createdAt: 100,
      updatedAt: 100,
    }
    data = { ...data, ideas: { ...data.ideas, [claude.id]: claude } }
    return { data, titleId: t.result, a: a.result, b: b.result, claude }
  }

  it('updateIdea: 何も変わらない時は書き込まず、同じデータを返す（updatedAt も進めない）', () => {
    const f = ideaFixture()
    expect(updateIdea(f.data, f.claude.id, { body: f.claude.body })).toBe(f.data)
    expect(updateIdea(f.data, f.claude.id, { heading: '', body: f.claude.body })).toBe(f.data)
    expect(updateIdea(f.data, f.claude.id, {})).toBe(f.data)
    expect(ideaEditedByAuthor(updateIdea(f.data, f.claude.id, { body: f.claude.body }).ideas[f.claude.id])).toBe(false)
    // 変われば書き込み、updatedAt を進める（Claude のアイデアは作者が直したものになる）
    const next = updateIdea(f.data, f.claude.id, { body: `${f.claude.body}\n作者の一行` })
    expect(next).not.toBe(f.data)
    expect(next.ideas[f.claude.id].updatedAt).toBeGreaterThan(f.claude.updatedAt)
    expect(next.ideas[f.claude.id].source).toBe('claude')
    expect(next.ideas[f.claude.id].claudeHash).toBe(f.claude.claudeHash)
    expect(ideaEditedByAuthor(next.ideas[f.claude.id])).toBe(true)
    expect(() => updateIdea(f.data, 'nope', { body: 'x' })).toThrow(DomainError)
  })

  it('済み・並べ替え・位置を選んだ移動・仕切りの移動は、Claude のアイデアを「作者が直した」にしない', () => {
    const f = ideaFixture()
    const id = f.claude.id
    let data = setIdeaChecked(f.data, id, true)
    expect(data.ideas[id].checked).toBe(true)
    expect(ideaEditedByAuthor(data.ideas[id])).toBe(false)
    data = setIdeaChecked(data, id, false)
    expect(ideaEditedByAuthor(data.ideas[id])).toBe(false)
    data = moveIdeaStep(data, id, 1)
    data = moveIdeaStep(data, id, -1)
    expect(ideaEditedByAuthor(data.ideas[id])).toBe(false)
    data = moveIdeaTo(data, id, f.titleId, 1)
    expect(ideaEditedByAuthor(data.ideas[id])).toBe(false)
    data = moveIdeaToSection(data, id, null)
    expect(data.ideas[id].titleId).toBeNull()
    expect(ideaEditedByAuthor(data.ideas[id])).toBe(false)
    data = moveIdeaTo(data, id, f.titleId, 0)
    expect(data.ideas[id]).toMatchObject({
      titleId: f.titleId,
      source: 'claude',
      claudeHash: f.claude.claudeHash,
      appendIds: ['cu-a'],
    })
    expect(ideaEditedByAuthor(data.ideas[id])).toBe(false)
  })

  it('deleteIdea: ゴミ箱の1件の形は今までどおり（trashIdea を使っても同じ）。戻すと Claude のアイデアの項目もそのまま', () => {
    const f = ideaFixture()
    const deleted = deleteIdea(f.data, f.a)
    expect(deleted.ideas[f.a]).toBeUndefined()
    const [entry] = Object.values(deleted.trashEntries)
    const [record] = Object.values(deleted.trashRecords)
    const peers = Object.values(f.data.ideas).filter((i) => !i.checked)
    const sorted = [...peers].sort((x, y) => x.order - y.order)
    const at = sorted.findIndex((i) => i.id === f.a)
    expect(entry).toEqual({
      id: entry.id,
      kind: 'idea',
      label: '案1',
      titleName: '灰の庭',
      origin: { titleId: f.titleId, index: f.data.ideas[f.a].order, prevId: at > 0 ? sorted[at - 1].id : null },
      recordIds: [record.id],
      reason: 'deleted',
      deletedAt: entry.deletedAt,
      createdAt: entry.deletedAt,
      updatedAt: entry.deletedAt,
    })
    expect(record).toEqual({
      id: record.id,
      entryId: entry.id,
      table: 'ideas',
      record: f.data.ideas[f.a],
      createdAt: entry.deletedAt,
      updatedAt: entry.deletedAt,
    })
    // 同じ形を trashIdea で作れる（時刻・ゴミ箱の id・印は渡したもの）
    const viaTx = transact(f.data, (tx) =>
      trashIdea(tx, f.data.ideas[f.claude.id], { at: 5, entryId: 'te-x', recordId: (i) => `tr-x-${i}`, by: 'claude' }),
    )
    expect(viaTx.result).toBe('te-x')
    expect(viaTx.data.trashEntries['te-x']).toMatchObject({
      kind: 'idea',
      label: '2026/11/12 14:32\u3000第3章の動機',
      titleName: '灰の庭',
      origin: { titleId: f.titleId, index: -1, prevId: null },
      recordIds: ['tr-x-0'],
      by: 'claude',
      deletedAt: 5,
    })
    expect(viaTx.data.trashRecords['tr-x-0'].record).toEqual(f.claude)
    expect(viaTx.data.ideas[f.claude.id]).toBeUndefined()
    const back = restoreTrashEntry(viaTx.data, 'te-x').data
    // 並びの位置は戻す時に決め直す（updatedAt も進む）。中身と Claude のアイデアの項目はそのまま
    const { order: _o, updatedAt: _u, ...rest } = f.claude
    void _o
    void _u
    expect(back.ideas[f.claude.id]).toMatchObject(rest)
    expect(ideaEditedByAuthor(back.ideas[f.claude.id])).toBe(false)
    // 何も無ければ何もしない
    expect(deleteIdea(f.data, 'nope').ideas).toBe(f.data.ideas)
  })
})

describe('アイデアのフォルダの中のカード（2.9）', () => {
  const folder = (id: string, titleId: string | null, parentId: string | null, name: string, order: number): IdeaFolder => ({
    id,
    titleId,
    parentId,
    name,
    order,
    createdAt: 1,
    updatedAt: 1,
  })
  const withFolders = (data: AppData, ...fs: IdeaFolder[]): AppData => ({
    ...data,
    ideaFolders: { ...data.ideaFolders, ...Object.fromEntries(fs.map((f) => [f.id, f])) },
  })
  const add = (data: AppData, titleId: string | null, body: string, folderId: string | null = null) => {
    const r = addIdea(data, titleId, '', body, folderId)
    return { data: r.data, id: r.result }
  }
  const bodies = (list: Idea[]) => list.map((i) => i.body)

  /** タイトル「星の庭」に 1段目「場面」とその中の「雨の駅」、ホームに「新作の相談」。カードはフォルダの外・中に */
  function fixture() {
    const t = createTitle(emptyData(), '星の庭')
    let data = withFolders(
      t.data,
      folder('f-scene', t.result, null, '場面', 0),
      folder('f-rain', t.result, 'f-scene', '雨の駅', 0),
      folder('f-home', null, null, '新作の相談', 0),
    )
    let r = add(data, t.result, '外1')
    const loose1 = r.id
    r = add(r.data, t.result, '場面1', 'f-scene')
    const scene1 = r.id
    r = add(r.data, t.result, '雨1', 'f-rain')
    const rain1 = r.id
    r = add(r.data, t.result, '雨2', 'f-rain')
    const rain2 = r.id
    r = add(r.data, t.result, '外2')
    const loose2 = r.id
    data = r.data
    return { data, titleId: t.result, loose1, loose2, scene1, rain1, rain2 }
  }

  it('ideaSections: ideas は今までどおり仕切りのすべてのカード、tree にフォルダの木。表が同じなら同じ答え', () => {
    const f = fixture()
    const sections = ideaSections(f.data)
    const [title, home] = sections
    // ideas は仕切りのすべてのカード（order は入れ物ごとなので、ここでは顔ぶれだけを見る）
    expect(bodies(title.ideas).sort()).toEqual(['場面1', '外1', '外2', '雨1', '雨2'])
    expect(title.tree.folders.map((n) => n.folder.name)).toEqual(['場面'])
    expect(title.tree.folders[0].folders.map((n) => n.folder.name)).toEqual(['雨の駅'])
    expect(bodies(title.tree.folders[0].ideas)).toEqual(['場面1'])
    expect(bodies(title.tree.folders[0].folders[0].ideas)).toEqual(['雨1', '雨2'])
    expect(bodies(title.tree.loose)).toEqual(['外1', '外2'])
    expect(title.tree.count).toBe(5)
    expect(home.ideas).toEqual([])
    expect(home.tree.folders.map((n) => n.folder.name)).toEqual(['新作の相談'])
    // アイデア・フォルダ・タイトルの表が同じなら作り直さない（ほかの表が変わっても）
    expect(ideaSections({ ...f.data, memos: {} })).toBe(sections)
    expect(ideaSections(withFolders(f.data, folder('f-new', null, null, '別', -1)))).not.toBe(sections)
    expect(ideaSections(setIdeaChecked(f.data, f.loose1, true))).not.toBe(sections)
  })

  it('addIdea: フォルダを渡すとその中の末尾に入る。無いフォルダ・別の仕切りのフォルダは断る。フォルダの外には項目を書かない', () => {
    const f = fixture()
    const r = add(f.data, f.titleId, '雨3', 'f-rain')
    expect(r.data.ideas[r.id]).toMatchObject({ folderId: 'f-rain', titleId: f.titleId })
    expect(bodies(ideaSections(r.data)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨1', '雨2', '雨3'])
    // 並びは入れ物ごと（フォルダの外の末尾は、フォルダの中のカードの order に関係しない）
    const loose = add(f.data, f.titleId, '外3')
    expect('folderId' in loose.data.ideas[loose.id]).toBe(false)
    expect(loose.data.ideas[loose.id].order).toBe(f.data.ideas[f.loose2].order + 1)
    expect(() => addIdea(f.data, f.titleId, '', 'x', 'nope')).toThrow('フォルダが見つかりません')
    expect(() => addIdea(f.data, f.titleId, '', 'x', 'f-home')).toThrow('フォルダが見つかりません')
    expect(() => addIdea(f.data, null, '', 'x', 'f-scene')).toThrow('フォルダが見つかりません')
    // ホームのフォルダにはホームのカードとして入る
    const home = add(f.data, null, '相談1', 'f-home')
    expect(bodies(ideaSections(home.data).at(-1)!.tree.folders[0].ideas)).toEqual(['相談1'])
  })

  it('setIdeaChecked: 外すと、入っているフォルダの済みでないカードの末尾に戻る', () => {
    const f = fixture()
    let data = setIdeaChecked(f.data, f.rain1, true)
    expect(bodies(ideaSections(data)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨2', '雨1'])
    data = add(data, f.titleId, '雨3', 'f-rain').data
    data = setIdeaChecked(data, f.rain1, false)
    expect(bodies(ideaSections(data)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨2', '雨3', '雨1'])
    expect(data.ideas[f.rain1].folderId).toBe('f-rain')
    // フォルダの外のカードの並びは変わらない
    expect(bodies(ideaSections(data)[0].tree.loose)).toEqual(['外1', '外2'])
  })

  it('moveIdeaStep: 同じ入れ物（仕切り＋フォルダ）の中で動かす', () => {
    const f = fixture()
    let data = moveIdeaStep(f.data, f.rain2, -1)
    expect(bodies(ideaSections(data)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨2', '雨1'])
    // 入れ物の先頭・末尾では動かない（フォルダの外のカードと入れ替わらない）
    expect(moveIdeaStep(data, f.rain2, -1).ideas).toBe(data.ideas)
    expect(moveIdeaStep(data, f.scene1, 1).ideas).toBe(data.ideas)
    data = moveIdeaStep(data, f.loose2, -1)
    expect(bodies(ideaSections(data)[0].tree.loose)).toEqual(['外2', '外1'])
  })

  it('moveIdeaTo: フォルダの中の選んだ位置へ・フォルダの外へ。外へ出すと項目ごと消す（null は書かない）', () => {
    const f = fixture()
    let data = moveIdeaTo(f.data, f.loose1, f.titleId, 1, 'f-rain')
    expect(data.ideas[f.loose1].folderId).toBe('f-rain')
    expect(bodies(ideaSections(data)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨1', '外1', '雨2'])
    expect(bodies(ideaSections(data)[0].tree.loose)).toEqual(['外2'])
    data = moveIdeaTo(data, f.loose1, f.titleId, 0)
    expect('folderId' in data.ideas[f.loose1]).toBe(false)
    expect(bodies(ideaSections(data)[0].tree.loose)).toEqual(['外1', '外2'])
    // 2段目から1段目へ（同じ仕切り）、別の仕切りのフォルダへ（タイトルも変わる）
    data = moveIdeaTo(data, f.rain1, f.titleId, 0, 'f-scene')
    expect(bodies(ideaSections(data)[0].tree.folders[0].ideas)).toEqual(['雨1', '場面1'])
    data = moveIdeaTo(data, f.rain1, null, 0, 'f-home')
    expect(data.ideas[f.rain1]).toMatchObject({ titleId: null, folderId: 'f-home' })
    expect(() => moveIdeaTo(data, f.rain1, f.titleId, 0, 'f-home')).toThrow('フォルダが見つかりません')
    expect(() => moveIdeaTo(data, f.rain1, f.titleId, 0, 'nope')).toThrow('フォルダが見つかりません')
    // 済みのカードは入れ物だけ移す（入れ物の末尾の order。済みのまま）
    data = setIdeaChecked(data, f.rain2, true)
    data = moveIdeaTo(data, f.rain2, f.titleId, 0)
    expect(data.ideas[f.rain2]).toMatchObject({ checked: true, titleId: f.titleId })
    expect('folderId' in data.ideas[f.rain2]).toBe(false)
    expect(Object.values(data.ideas).some((i) => (i as { folderId?: unknown }).folderId === null)).toBe(false)
  })

  it('moveIdeaTo: 同じ入れ物の中の位置だけ変える時は、入っているフォルダの参照をそのままにする', () => {
    const f = fixture()
    const data = moveIdeaTo(f.data, f.rain2, f.titleId, 0, 'f-rain')
    expect(bodies(ideaSections(data)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨2', '雨1'])
    // 見せ方でフォルダの外にあるカード（フォルダが無い）を同じ仕切りの外の中で動かしても、参照は消さない
    const dangling = { ...f.data, ideas: { ...f.data.ideas, [f.loose1]: { ...f.data.ideas[f.loose1], folderId: 'gone' } } }
    const moved = moveIdeaTo(dangling, f.loose1, f.titleId, 1)
    expect(moved.ideas[f.loose1].folderId).toBe('gone')
    expect(bodies(ideaSections(moved)[0].tree.loose)).toEqual(['外2', '外1'])
  })

  it('moveIdeaToSection: 別の仕切りのフォルダの外へ（入っていたフォルダから出す）。同じ仕切りのフォルダの中からも外へ出す', () => {
    const f = fixture()
    let data = moveIdeaToSection(f.data, f.rain1, null)
    expect(data.ideas[f.rain1].titleId).toBeNull()
    expect('folderId' in data.ideas[f.rain1]).toBe(false)
    data = moveIdeaToSection(data, f.scene1, f.titleId)
    expect('folderId' in data.ideas[f.scene1]).toBe(false)
    expect(bodies(ideaSections(data)[0].tree.loose)).toEqual(['外1', '外2', '場面1'])
    // もうフォルダの外にあれば何もしない
    expect(moveIdeaToSection(data, f.loose1, f.titleId).ideas).toBe(data.ideas)
  })

  it('trashIdea: 戻す位置は入れ物の中で控え、フォルダの中なら場所の表記を控える。戻すと同じフォルダに戻る', () => {
    const f = fixture()
    const deleted = deleteIdea(f.data, f.rain2)
    const [entry] = Object.values(deleted.trashEntries)
    expect(entry).toMatchObject({
      kind: 'idea',
      titleName: '星の庭',
      parentLabel: '場面 › 雨の駅',
      origin: { titleId: f.titleId, index: f.data.ideas[f.rain2].order, prevId: f.rain1 },
    })
    // フォルダの外のカードは場所の表記を持たない（今までと同じ形）
    const outside = Object.values(deleteIdea(f.data, f.loose2).trashEntries)[0]
    expect(outside.parentLabel).toBeUndefined()
    expect(outside.origin).toEqual({ titleId: f.titleId, index: f.data.ideas[f.loose2].order, prevId: f.loose1 })
    const back = restoreTrashEntry(deleted, entry.id).data
    expect(back.ideas[f.rain2].folderId).toBe('f-rain')
    expect(bodies(ideaSections(back)[0].tree.folders[0].folders[0].ideas)).toEqual(['雨1', '雨2'])
  })

  it('deleteTitle: フォルダもホームへ移る（中のつながり・カードの folderId はそのまま。1段目はホームの1段目の後ろへ）', () => {
    const f = fixture()
    let data = withFolders(f.data, folder('f-plot', f.titleId, null, '筋', 1), folder('f-home2', null, null, '道具', 5))
    data = deleteTitle(data, f.titleId)
    const [home] = ideaSections(data)
    expect(home.titleId).toBeNull()
    expect(home.tree.folders.map((n) => n.folder.name)).toEqual(['新作の相談', '道具', '場面', '筋'])
    const scene = home.tree.folders[2]
    expect(scene.folders.map((n) => n.folder.name)).toEqual(['雨の駅'])
    expect(bodies(scene.ideas)).toEqual(['場面1'])
    expect(bodies(scene.folders[0].ideas)).toEqual(['雨1', '雨2'])
    expect(bodies(home.tree.loose)).toEqual(['外1', '外2'])
    expect(data.ideaFolders['f-scene']).toMatchObject({ titleId: null, parentId: null, order: 6 })
    expect(data.ideaFolders['f-plot']).toMatchObject({ titleId: null, order: 7 })
    // 2段目の並び・親はそのまま
    expect(data.ideaFolders['f-rain']).toMatchObject({ titleId: null, parentId: 'f-scene', order: 0 })
    // フォルダはタイトルのゴミ箱の件には入らない（タイトルを戻しても戻らない）
    const [entry] = Object.values(data.trashEntries)
    expect(entry.recordIds.map((id) => data.trashRecords[id].table)).not.toContain('ideaFolders')
    const back = restoreTrashEntry(data, entry.id).data
    expect(back.ideaFolders['f-scene'].titleId).toBeNull()
  })

  it('deleteTitle: ホームの1段目と同じ名前（字の幅・空白の違いも同じ）の1段目は「名前（タイトル名）」にする。それも重なれば「 2」…', () => {
    const t = createTitle(emptyData(), '星の庭')
    let data = withFolders(
      t.data,
      folder('h1', null, null, '新作 の相談 ＡＢ', 0),
      folder('h2', null, null, '場面（星の庭）', 1),
      folder('a', t.result, null, '新作\u3000の相談  AB', 0),
      folder('b', t.result, null, '場面', 1),
      folder('c', t.result, null, '筋', 2),
      folder('a-sub', t.result, 'a', '新作の相談', 0),
      folder('h-b', null, null, '場面', 2),
    )
    data = deleteTitle(data, t.result)
    expect(data.ideaFolders.a.name).toBe('新作\u3000の相談  AB（星の庭）')
    expect(data.ideaFolders.b.name).toBe('場面（星の庭） 2')
    expect(data.ideaFolders.c.name).toBe('筋')
    // 2段目は親と一緒に移るので、名前は変えない
    expect(data.ideaFolders['a-sub'].name).toBe('新作の相談')
    // 長い名前・長いタイトル名でも40字まで
    const long = createTitle(emptyData(), 'とても長いタイトルの名前をここに書いておくとどうなるでしょうか')
    let d2 = withFolders(
      long.data,
      folder('h', null, null, 'あ'.repeat(40), 0),
      folder('x', long.result, null, 'あ'.repeat(40), 0),
    )
    d2 = deleteTitle(d2, long.result)
    const name = d2.ideaFolders.x.name
    expect(Array.from(name).length).toBeLessThanOrEqual(40)
    expect(name).toMatch(/（とても長いタイトルの名前をここに書いて…）$/)
    expect(name.startsWith('あ')).toBe(true)
  })
})

describe('タイトル配下', () => {
  it('新しいタイトルにはキャラクター・世界観の設定項目が用意され、項目は後から任意に追加できる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    expect(categoriesOf(data, t.result).map((c) => c.name)).toEqual(['キャラクター', '世界観'])
    const c = addCategory(data, t.result, '用語集', ['読み', '意味'])
    data = c.data
    const e = addEntry(data, c.result, '魔導炉')
    data = e.data
    expect(entriesOf(data, c.result)[0].fields.map((f) => f.key)).toEqual(['読み', '意味'])
    // テンプレートを変えても既存エントリのフィールドは変わらない
    data = updateCategory(data, c.result, { fieldTemplate: ['読み'] })
    expect(entriesOf(data, c.result)[0].fields).toHaveLength(2)
  })

  it('メモはタイトル内で管理される', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = addMemo(t.data, t.result, '伏線メモ').data
    expect(memosOf(data, t.result).map((m) => m.name)).toEqual(['伏線メモ'])
  })

  it('タイトルを削除すると配下のデータがすべてゴミ箱の1件にまとめて移る', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    data = addEpisode(data, t.result).data
    data = addMemo(data, t.result).data
    data = addSubmission(data, t.result, '新人賞').data
    data = deleteTitle(data, t.result)
    expect({ ...data, trashEntries: {}, trashRecords: {} }).toEqual(emptyData())
    const entries = Object.values(data.trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'title', label: '作品A', titleName: '作品A', reason: 'deleted' })
    // タイトル・設定項目2・話・稿・メモ・応募計画
    expect(entries[0].recordIds).toHaveLength(7)
    expect(data.trashRecords[entries[0].recordIds[0]]).toMatchObject({ table: 'titles', record: { id: t.result } })
  })

  it('最終編集日時には原稿の編集も含まれる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = addEpisode(t.data, t.result).data
    const vid = Object.keys(data.versions)[0]
    data = { ...data, versions: { ...data.versions, [vid]: { ...data.versions[vid], updatedAt: 9_999_999_999_999 } } }
    expect(titleLastEdited(data, t.result)).toBe(9_999_999_999_999)
  })

  it('採用原稿の総文字数と、採用原稿がない話の数を集計できる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const e1 = addEpisode(data, t.result)
    data = e1.data
    data = updateVersion(data, data.pieces[e1.result].versionIds[0], { body: 'あいう えお\nかき' })
    const e2 = addEpisode(data, t.result)
    data = setActiveVersion(e2.data, e2.result, null)
    expect(titleSummary(data, t.result)).toEqual({
      episodes: 2,
      specials: 0,
      missingActive: 1,
      missingEpisodes: 1,
      missingSpecials: 0,
      missingActs: 0,
      activeChars: 7,
    })
  })
})

describe('戦略', () => {
  it('応募順を並べ替えられ、応募時点の採用原稿を記録できる', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const e1 = addEpisode(data, t.result)
    data = e1.data
    const v1 = data.pieces[e1.result].versionIds[0]
    data = updateVersion(data, v1, { body: '本文本文' })
    const s1 = addSubmission(data, t.result, 'A賞')
    data = s1.data
    const s2 = addSubmission(data, t.result, 'B賞')
    data = s2.data
    data = moveSubmissionStep(data, s2.result, -1)
    expect(submissionsOf(data, t.result).map((s) => s.contestName)).toEqual(['B賞', 'A賞'])
    data = recordSubmissionSnapshot(data, s1.result)
    expect(data.submissions[s1.result].snapshot).toMatchObject({ charCount: 4, activeVersions: { [e1.result]: v1 } })
  })
})

describe('応募計画の規定の備考・提出する梗概／キャッチコピー・特記事項', () => {
  const EXTRAS: Partial<Submission> = {
    limitNote: 'ルビ不可。章タイトル必須。',
    synopsis: '海辺の町に住む少女が、嘘をついて世界を救う話。',
    synopsisMin: 100,
    synopsisMax: 800,
    catchphrase: 'その嘘は、世界を救うためについた。',
    catchphraseMin: null,
    catchphraseMax: 40,
    specialNotes: '応募フォームの「作品のセールスポイント」欄にも同じ文を使う',
  }

  function setup() {
    const t = createTitle(emptyData(), '作品A')
    const e1 = addEpisode(t.data, t.result)
    let data = updateVersion(e1.data, e1.data.pieces[e1.result].versionIds[0], { body: '本文本文' })
    const s = addSubmission(data, t.result, 'A賞')
    data = updateSubmission(s.data, s.result, EXTRAS)
    return { data, titleId: t.result, id: s.result }
  }

  it('新しい応募計画は空・規定なしで作る', () => {
    const t = createTitle(emptyData(), '作品A')
    const s = addSubmission(t.data, t.result, 'A賞')
    expect(s.data.submissions[s.result]).toMatchObject({
      limitNote: '',
      synopsis: '',
      synopsisMin: null,
      synopsisMax: null,
      catchphrase: '',
      catchphraseMin: null,
      catchphraseMax: null,
      specialNotes: '',
    })
  })

  it('応募時の原稿を記録すると、その時の梗概・あらすじとキャッチコピーも控える（後から書き直しても変わらない）', () => {
    const f = setup()
    let data = recordSubmissionSnapshot(f.data, f.id)
    const snap = data.submissions[f.id].snapshot!
    expect(snap).toMatchObject({ charCount: 4, synopsis: EXTRAS.synopsis, catchphrase: EXTRAS.catchphrase })
    data = updateSubmission(data, f.id, { synopsis: '書き直した梗概', catchphrase: '新しいコピー' })
    expect(data.submissions[f.id].snapshot).toMatchObject({ synopsis: EXTRAS.synopsis, catchphrase: EXTRAS.catchphrase })
    // 記録し直すと今の内容になる
    data = recordSubmissionSnapshot(data, f.id)
    expect(data.submissions[f.id].snapshot).toMatchObject({ synopsis: '書き直した梗概', catchphrase: '新しいコピー' })
    // 書いていなければ空で控える（古いデータで項目が無くても）
    const { synopsis: _s, catchphrase: _c, ...old } = data.submissions[f.id]
    data = { ...data, submissions: { ...data.submissions, [f.id]: old as Submission } }
    data = recordSubmissionSnapshot(data, f.id)
    expect(data.submissions[f.id].snapshot).toMatchObject({ synopsis: '', catchphrase: '' })
  })

  it('バックアップ・ゴミ箱（応募計画の削除・タイトルの削除）から戻しても、項目と応募時の控えはそのまま', () => {
    const f = setup()
    const data = recordSubmissionSnapshot(f.data, f.id)
    const before = data.submissions[f.id]
    expect(parseBackup(JSON.stringify(toBackup(data))).submissions[f.id]).toEqual(before)
    for (const del of [(d: AppData) => deleteSubmission(d, f.id), (d: AppData) => deleteTitle(d, f.titleId)]) {
      const deleted = del(data)
      expect(deleted.submissions[f.id]).toBeUndefined()
      const restored = restoreTrashEntry(deleted, listTrash(deleted.trashEntries)[0].id).data
      expect(restored.submissions[f.id]).toEqual(before)
    }
  })
})

describe('文字数', () => {
  it('空白・改行を除いて数え、サロゲートペアも1文字とする', () => {
    expect(countChars('あい う\nえ　お𠮷')).toBe(6)
    const s = textStats('あいう\n\nえお')
    expect(s).toMatchObject({ chars: 5, charsWithSpaces: 5, lines: 3, manuscriptPages: 1 })
    expect(textStats('').manuscriptPages).toBe(0)
    expect(textStats('あ'.repeat(401)).manuscriptPages).toBe(2)
  })
})

describe('差分', () => {
  it('変更箇所を文字単位で示す', () => {
    const segs = diffTexts('今日は晴れ。\n明日は雨。\n', '今日は快晴。\n明日は雨。\n')
    const changed = segs.filter((s) => s.kind !== 'same')
    expect(changed.some((s) => s.kind === 'add' && s.text.includes('快'))).toBe(true)
    expect(changed.some((s) => s.kind === 'del' && s.text.includes('れ'))).toBe(true)
    // 2行目は変更されていない
    expect(changed.every((s) => !s.text.includes('明日'))).toBe(true)
    const joinedTarget = segs
      .filter((s) => s.kind !== 'del')
      .map((s) => s.text)
      .join('')
    const joinedBase = segs
      .filter((s) => s.kind !== 'add')
      .map((s) => s.text)
      .join('')
    expect(joinedTarget).toBe('今日は快晴。\n明日は雨。\n')
    expect(joinedBase).toBe('今日は晴れ。\n明日は雨。\n')
    expect(diffSummary(segs).added).toBeGreaterThan(0)
  })
})

describe('バックアップ', () => {
  it('書き出したものを読み込むと同じデータに戻る', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = addEpisode(t.data, t.result).data
    const json = JSON.stringify(toBackup(data))
    expect(parseBackup(json)).toEqual(data)
  })

  it('形式が違うファイルは拒否する', () => {
    expect(() => parseBackup('{}')).toThrow(DomainError)
    expect(() => parseBackup('not json')).toThrow(DomainError)
    expect(() => parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 1, data: { titles: [] } }))).toThrow(
      DomainError,
    )
  })
})

describe('応募時の原稿の記録', () => {
  it('話ごとの稿と本文の控えを残し、稿の名前変更では「本文が変わった」としない', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    data = t.data
    const e1 = addEpisode(data, t.result)
    data = e1.data
    const v1 = data.pieces[e1.result].versionIds[0]
    data = updateVersion(data, v1, { body: '応募した本文' })
    const s = addSubmission(data, t.result, 'A賞')
    data = recordSubmissionSnapshot(s.data, s.result)
    const snap = data.submissions[s.result].snapshot!
    expect(snap.pieces![e1.result]).toMatchObject({ label: '第1話', versionName: '第1稿', chars: 6 })
    expect(snapshotPieceBody(data, snap.pieces![e1.result])).toBe('応募した本文')
    expect(snapshotText(data, snap, '作品A')).toContain('応募した本文')
    expect(submissionsReferencingVersion(data, v1).map((x) => x.contestName)).toEqual(['A賞'])

    data = updateVersion(data, v1, { name: '決定稿', note: 'メモだけ変更' })
    expect(compareSnapshotWithCurrent(data, t.result, snap)).toMatchObject({ switched: [], edited: [], charDelta: 0 })
    data = updateVersion(data, v1, { body: '応募後に直した本文' })
    expect(compareSnapshotWithCurrent(data, t.result, snap).edited).toEqual([e1.result])
    // 稿を消しても、応募した本文は記録に残る
    data = deleteVersion(data, v1)
    expect(snapshotPieceBody(data, data.submissions[s.result].snapshot!.pieces![e1.result])).toBe('応募した本文')
  })

  it('同じ本文は複数の応募記録で1つだけ保存され、使われなくなった控えは消える', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    const e1 = addEpisode(t.data, t.result)
    data = updateVersion(e1.data, e1.data.pieces[e1.result].versionIds[0], { body: '同じ本文' })
    const a = addSubmission(data, t.result, 'A賞')
    const b = addSubmission(a.data, t.result, 'B賞')
    data = recordSubmissionSnapshot(b.data, a.result)
    data = recordSubmissionSnapshot(data, b.result)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(1)
    data = deleteSubmission(data, a.result)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(1)
    data = deleteSubmission(data, b.result)
    expect(Object.keys(data.snapshotTexts)).toHaveLength(0)
  })

  it('古い記録（本文が記録の中にある）は読み込み時に控えの表へ移される', () => {
    let data = emptyData()
    const t = createTitle(data, '作品A')
    const s = addSubmission(t.data, t.result, 'A賞')
    data = s.data
    const legacy = {
      at: 1,
      charCount: 2,
      activeVersions: { p: 'v' },
      order: ['p'],
      pieces: {
        p: {
          kind: 'episode',
          label: '第1話',
          subtitle: '',
          versionId: 'v',
          versionName: '第1稿',
          chars: 2,
          body: '古い',
          hash: 'h',
        },
      },
    } as unknown as NonNullable<AppData['submissions'][string]['snapshot']>
    data = { ...data, submissions: { [s.result]: { ...data.submissions[s.result], snapshot: legacy } } }
    const repaired = repairData(data).data
    const piece = repaired.submissions[s.result].snapshot!.pieces!.p
    expect(piece.body).toBeUndefined()
    expect(snapshotPieceBody(repaired, piece)).toBe('古い')
  })

  it('採用原稿なしの話と特殊ブロックを分けて表記する', () => {
    expect(missingActiveLabel(0, 0)).toBe('')
    expect(missingActiveLabel(2, 0)).toBe('採用原稿なし 2話')
    expect(missingActiveLabel(1, 1)).toBe('採用原稿なし 1話＋特殊1')
    expect(missingActiveLabel(0, 1)).toBe('採用原稿なし 特殊1')
  })
})

describe('位置を指定した並べ替え', () => {
  it('アイデアを別の仕切りの任意の位置へ、タイトルを任意の位置へ移せる', () => {
    let data = emptyData()
    const t = createTitle(data, 'A')
    data = createTitle(t.data, 'B').data
    const ids: string[] = []
    for (const h of ['1', '2', '3']) {
      const r = addIdea(data, null, h)
      data = r.data
      ids.push(r.result)
    }
    data = moveIdeaTo(data, ids[2], null, 0)
    expect(
      ideaSections(data)
        .at(-1)!
        .ideas.map((i) => i.heading),
    ).toEqual(['3', '1', '2'])
    data = moveIdeaTo(data, ids[0], t.result, 0)
    expect(ideaSections(data)[0].ideas.map((i) => i.heading)).toEqual(['1'])
    expect(
      ideaSections(data)
        .at(-1)!
        .ideas.map((i) => i.heading),
    ).toEqual(['3', '2'])
    data = moveTitleTo(data, t.result, 5)
    expect(sortedTitles(data).map((x) => x.name)).toEqual(['B', 'A'])
  })
})
