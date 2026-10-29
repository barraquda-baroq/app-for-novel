import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { buildReadThrough, NO_ACTIVE_MESSAGE, readThroughText } from './readthrough'
import { repairData } from './repair'
import {
  addChapter,
  addEpisode,
  addSpecial,
  addVersion,
  deletePiece,
  deleteVersion,
  duplicateVersion,
  episodeTargets,
  insertOptions,
  movePiece,
  movePieceStep,
  moveChapterStep,
  removeChapter,
  setActiveVersion,
  setChaptersEnabled,
  setNumbering,
  updatePiece,
  updateVersion,
} from './storyOps'
import { canDeletePiece, episodeNumbers, flatten, pieceLabel } from './structure'
import { emptyTrash, restoreTrashEntry } from './trash'
import { DomainError, emptyData, type AppData, type ID } from './types'

function setup() {
  const r = createTitle(emptyData(), 'テスト作品')
  return { data: r.data, titleId: r.result }
}

function add(data: AppData, titleId: ID, target?: ID | null) {
  const r = addEpisode(data, titleId, target)
  return { data: r.data, id: r.result }
}

/** 読む順のラベル一覧 */
function labels(data: AppData, titleId: ID): string[] {
  const numbers = episodeNumbers(data, titleId)
  return flatten(data, titleId).map((f) => {
    const p = data.pieces[f.pieceId]
    return pieceLabel(data, p, numbers) + (p.subtitle ? `:${p.subtitle}` : '')
  })
}

function withSubtitles(data: AppData, ids: ID[], names: string[]) {
  return ids.reduce((d, id, i) => updatePiece(d, id, { subtitle: names[i] }), data)
}

describe('話数追加', () => {
  it('タイトル作成直後は第1話、その後は第2話…と最新話が強制的に作られる', () => {
    let { data, titleId } = setup()
    let a
    ;({ data, id: a } = add(data, titleId))
    expect(labels(data, titleId)).toEqual(['第1話'])
    ;({ data } = add(data, titleId))
    ;({ data } = add(data, titleId))
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', '第3話'])
    // 新しい話には「第1稿」が作られ、採用中になっている
    const p = data.pieces[a]
    expect(p.versionIds).toHaveLength(1)
    expect(p.activeVersionId).toBe(p.versionIds[0])
    expect(data.versions[p.versionIds[0]].name).toBe('第1稿')
  })

  it('末尾にエピローグがあっても新しい話は最新話の直後に入る', () => {
    let { data, titleId } = setup()
    ;({ data } = add(data, titleId))
    const ep = addSpecial(data, titleId, { chapterId: null, index: 1 }, 'エピローグ')
    data = ep.data
    ;({ data } = add(data, titleId))
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', 'エピローグ'])
  })

  it('第n話の表記は変更できない（特殊ブロックの見出しは変更できる）', () => {
    let { data, titleId } = setup()
    let id
    ;({ data, id } = add(data, titleId))
    expect(() => updatePiece(data, id, { label: 'プロローグ' })).toThrow(DomainError)
    const sp = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    data = updatePiece(sp.data, sp.result, { label: '序' })
    expect(labels(data, titleId)).toEqual(['序', '第1話'])
  })

  it('話の題（サブタイトル）を付けられる', () => {
    let { data, titleId } = setup()
    let id
    ;({ data, id } = add(data, titleId))
    data = updatePiece(data, id, { subtitle: '旅立ち' })
    expect(labels(data, titleId)).toEqual(['第1話:旅立ち'])
  })
})

describe('並べ替えと削除', () => {
  it('ソートすると話数が並び順どおりに書き換わる', () => {
    let { data, titleId } = setup()
    const ids: ID[] = []
    for (let i = 0; i < 4; i++) {
      const r = add(data, titleId)
      data = r.data
      ids.push(r.id)
    }
    data = withSubtitles(data, ids, ['A', 'B', 'C', 'D'])
    data = movePieceStep(data, ids[3], -1)
    data = movePieceStep(data, ids[3], -1)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:D', '第3話:B', '第4話:C'])
  })

  it('途中の話数は削除できない。最後の話だけ削除できる', () => {
    let { data, titleId } = setup()
    const ids: ID[] = []
    for (let i = 0; i < 4; i++) {
      const r = add(data, titleId)
      data = r.data
      ids.push(r.id)
    }
    data = withSubtitles(data, ids, ['A', 'B', 'C', 'D'])
    expect(canDeletePiece(data, ids[1]).ok).toBe(false)
    expect(canDeletePiece(data, ids[2]).ok).toBe(false)
    expect(() => deletePiece(data, ids[1])).toThrow(DomainError)
    expect(canDeletePiece(data, ids[3]).ok).toBe(true)

    // 仕様の例: 第4話を第2話にソートして詰めてから、旧2話・旧3話を削除する
    data = movePiece(data, ids[3], { chapterId: null, index: 1 })
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:D', '第3話:B', '第4話:C'])
    data = deletePiece(data, ids[2])
    data = deletePiece(data, ids[1])
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:D'])
    // 削除した話のバージョンも消える
    expect(Object.values(data.versions).some((v) => v.pieceId === ids[1])).toBe(false)
  })

  it('特殊ブロックは位置に関係なく削除できる', () => {
    let { data, titleId } = setup()
    ;({ data } = add(data, titleId))
    const sp = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    data = sp.data
    ;({ data } = add(data, titleId))
    expect(canDeletePiece(data, sp.result).ok).toBe(true)
    data = deletePiece(data, sp.result)
    expect(labels(data, titleId)).toEqual(['第1話', '第2話'])
  })

  it('特殊ブロックは話数を消費しない', () => {
    let { data, titleId } = setup()
    ;({ data } = add(data, titleId))
    ;({ data } = add(data, titleId))
    data = addSpecial(data, titleId, { chapterId: null, index: 1 }, '幕間').data
    expect(labels(data, titleId)).toEqual(['第1話', '幕間', '第2話'])
    ;({ data } = add(data, titleId))
    expect(labels(data, titleId)).toEqual(['第1話', '幕間', '第2話', '第3話'])
  })
})

describe('推敲バージョンと採用', () => {
  it('複製・採用・採用解除ができ、採用原稿だけが通し読みに反映される', () => {
    let { data, titleId } = setup()
    let id
    ;({ data, id } = add(data, titleId))
    const v1 = data.pieces[id].versionIds[0]
    data = updateVersion(data, v1, { body: '初稿の本文' })
    const dup = duplicateVersion(data, v1)
    data = updateVersion(dup.data, dup.result, { body: '推敲した本文' })
    expect(data.versions[dup.result].name).toBe('第2稿（第1稿を複製）')
    expect(data.versions[dup.result].sourceVersionId).toBe(v1)

    let read = buildReadThrough(data, titleId)
    expect(read).toMatchObject([{ type: 'piece', body: '初稿の本文', versionName: '第1稿' }])

    data = setActiveVersion(data, id, dup.result)
    read = buildReadThrough(data, titleId)
    expect(read).toMatchObject([{ type: 'piece', body: '推敲した本文' }])

    data = setActiveVersion(data, id, null)
    read = buildReadThrough(data, titleId)
    expect(read).toMatchObject([{ type: 'piece', label: '第1話', body: null }])
    expect(readThroughText(data, titleId)).toContain(NO_ACTIVE_MESSAGE)
    // 採用を外しても話数は変わらない
    expect(labels(data, titleId)).toEqual(['第1話'])
  })

  it('採用中のバージョンを削除すると採用なしになる。次の稿の番号は今ある稿のいちばん大きい番号の次', () => {
    let { data, titleId } = setup()
    let id
    ;({ data, id } = add(data, titleId))
    const v2 = addVersion(data, id)
    data = v2.data
    data = setActiveVersion(data, id, v2.result)
    data = deleteVersion(data, v2.result)
    expect(data.pieces[id].activeVersionId).toBeNull()
    const again = addVersion(data, id)
    expect(again.data.versions[again.result].name).toBe('第2稿')
  })

  it('他の話のバージョンは採用できない', () => {
    let { data, titleId } = setup()
    let a, b
    ;({ data, id: a } = add(data, titleId))
    ;({ data, id: b } = add(data, titleId))
    expect(() => setActiveVersion(data, a, data.pieces[b].versionIds[0])).toThrow(DomainError)
  })
})

describe('稿の番号（第n稿）', () => {
  /** 第1話と、その第1稿 */
  function oneEpisode() {
    const { data, titleId } = setup()
    const r = add(data, titleId)
    return { data: r.data, id: r.id, v1: r.data.pieces[r.id].versionIds[0] }
  }
  const names = (data: AppData, id: ID) => data.pieces[id].versionIds.map((v) => data.versions[v].name)

  it('作成→複製→複製→第3稿・第2稿を削除→ゴミ箱を空にする→複製: 第2稿になる（ゴミ箱に残っている間も同じ）', () => {
    let { data, id, v1 } = oneEpisode()
    expect(names(data, id)).toEqual(['第1稿'])
    const d2 = duplicateVersion(data, v1)
    data = d2.data
    expect(data.versions[d2.result].name).toBe('第2稿（第1稿を複製）')
    const d3 = duplicateVersion(data, d2.result)
    data = d3.data
    expect(data.versions[d3.result].name).toBe('第3稿（第2稿を複製）')

    data = deleteVersion(data, d3.result)
    data = deleteVersion(data, d2.result)
    expect(names(data, id)).toEqual(['第1稿'])
    // ゴミ箱の稿は数えない
    const inTrash = duplicateVersion(data, v1)
    expect(inTrash.data.versions[inTrash.result].name).toBe('第2稿（第1稿を複製）')

    data = emptyTrash(data)
    const after = duplicateVersion(data, v1)
    expect(after.data.versions[after.result].name).toBe('第2稿（第1稿を複製）')
    expect(names(after.data, id)).toEqual(['第1稿', '第2稿（第1稿を複製）'])
    // versionSeq（古い版のアプリ・同期のため）は戻さない
    expect(after.data.pieces[id].versionSeq).toBe(3)
  })

  it('間の欠けた番号は埋めない（第1・3・5・6稿なら次は第7稿）。採用中の稿も採用していない稿も数える', () => {
    let { data, id, v1 } = oneEpisode()
    const ids = [v1]
    for (let i = 0; i < 5; i++) {
      const r = addVersion(data, id)
      data = r.data
      ids.push(r.result)
    }
    data = deleteVersion(data, ids[1])
    data = deleteVersion(data, ids[3])
    data = setActiveVersion(data, id, ids[5])
    expect(names(data, id)).toEqual(['第1稿', '第3稿', '第5稿', '第6稿'])
    const dup = duplicateVersion(data, v1)
    expect(dup.data.versions[dup.result].name).toBe('第7稿（第1稿を複製）')
    const blank = addVersion(dup.data, id)
    expect(blank.data.versions[blank.result].name).toBe('第8稿')
  })

  it('稿の名前を書き換えると、書き換えた名前の番号で数える（番号のない名前は数えない）', () => {
    let { data, id, v1 } = oneEpisode()
    const v2 = addVersion(data, id)
    data = updateVersion(v2.data, v2.result, { name: '改稿版' })
    let r = addVersion(data, id)
    expect(r.data.versions[r.result].name).toBe('第2稿')

    data = updateVersion(data, v2.result, { name: '第十稿（推敲中）' })
    r = duplicateVersion(data, v2.result)
    expect(r.data.versions[r.result].name).toBe('第11稿（第十稿を複製）')
    expect(r.data.pieces[id].versionSeq).toBe(11)

    data = updateVersion(data, v1, { name: '　第１２稿' })
    r = addVersion(data, id)
    expect(r.data.versions[r.result].name).toBe('第13稿')
  })

  it('稿をすべて削除した話に足す稿は第1稿', () => {
    let { data, id, v1 } = oneEpisode()
    const v2 = addVersion(data, id)
    data = deleteVersion(deleteVersion(v2.data, v2.result), v1)
    expect(data.pieces[id].versionIds).toEqual([])
    const r = addVersion(data, id)
    expect(r.data.versions[r.result].name).toBe('第1稿')
    expect(r.data.pieces[id].versionSeq).toBe(2)
  })

  it('ゴミ箱から戻した稿の番号も数える', () => {
    let { data, id } = oneEpisode()
    const v2 = addVersion(data, id)
    data = deleteVersion(v2.data, v2.result)
    data = restoreTrashEntry(data, Object.keys(data.trashEntries)[0]).data
    const r = addVersion(data, id)
    expect(r.data.versions[r.result].name).toBe('第3稿')
  })

  it('番号が増えなくても versionSeq は稿の数より小さくしない（修復で直す所が出ない）', () => {
    let { data, id, v1 } = oneEpisode()
    data = updateVersion(data, v1, { name: '改稿版' })
    for (let i = 0; i < 3; i++) {
      const r = addVersion(data, id)
      data = updateVersion(r.data, r.result, { name: `案${i + 1}` })
    }
    expect(names(data, id)).toEqual(['改稿版', '案1', '案2', '案3'])
    expect(data.pieces[id].versionSeq).toBe(4)
    expect(repairData(data).fixes).toEqual([])
  })
})

describe('章（大長編モード）', () => {
  function withChapters() {
    let { data, titleId } = setup()
    const ids: ID[] = []
    for (let i = 0; i < 3; i++) {
      const r = add(data, titleId)
      data = r.data
      ids.push(r.id)
    }
    data = setChaptersEnabled(data, titleId, true)
    return { data, titleId, ids }
  }

  it('章を有効にすると第1章が作られ、既存の話はその中に入る（話数は変わらない）', () => {
    const { data, titleId } = withChapters()
    const t = data.titles[titleId]
    expect(t.structure).toHaveLength(1)
    const ch = data.chapters[t.structure[0].id]
    expect(ch.name).toBe('第1章')
    expect(ch.pieceIds).toHaveLength(3)
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', '第3話'])
  })

  it('通し番号では章をまたいで連番になり、話を別の章へ移すと話数が書き換わる', () => {
    let { data, titleId, ids } = withChapters()
    data = withSubtitles(data, ids, ['A', 'B', 'C'])
    const c2 = addChapter(data, titleId)
    data = c2.data
    expect(data.chapters[c2.result].name).toBe('第2章')
    let id4
    ;({ data, id: id4 } = add(data, titleId, c2.result))
    data = updatePiece(data, id4, { subtitle: 'D' })
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話:C', '第4話:D'])
    // 第1話 A を第2章の先頭へ
    data = movePiece(data, ids[0], { chapterId: c2.result, index: 0 })
    expect(labels(data, titleId)).toEqual(['第1話:B', '第2話:C', '第3話:A', '第4話:D'])
  })

  it('通し番号では最新話より前の章に話数追加できない', () => {
    let { data, titleId } = withChapters()
    const first = data.titles[titleId].structure[0].id
    const c2 = addChapter(data, titleId)
    data = c2.data
    ;({ data } = add(data, titleId, c2.result))
    expect(() => addEpisode(data, titleId, first)).toThrow(DomainError)
    const targets = episodeTargets(data, titleId).map((t) => t.chapterId)
    expect(targets).toContain(c2.result)
    expect(targets).not.toContain(first)
  })

  it('章ごとの話数モードでは章ごとに第1話から振り直され、各章の最後の話だけ削除できる', () => {
    let { data, titleId, ids } = withChapters()
    data = setNumbering(data, titleId, 'perChapter')
    const first = data.titles[titleId].structure[0].id
    const c2 = addChapter(data, titleId)
    data = c2.data
    let x
    ;({ data, id: x } = add(data, titleId, c2.result))
    ;({ data } = add(data, titleId, c2.result))
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', '第3話', '第1話', '第2話'])
    // 前の章にも追加でき、その章の最新話になる
    let y
    ;({ data, id: y } = add(data, titleId, first))
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', '第3話', '第4話', '第1話', '第2話'])
    expect(canDeletePiece(data, y).ok).toBe(true)
    expect(canDeletePiece(data, ids[2]).ok).toBe(false)
    expect(canDeletePiece(data, x).ok).toBe(false)
  })

  it('章を無効にしても構成は保たれ、通し番号で表示される', () => {
    let { data, titleId } = withChapters()
    data = setNumbering(data, titleId, 'perChapter')
    const c2 = addChapter(data, titleId)
    data = c2.data
    ;({ data } = add(data, titleId, c2.result))
    data = setChaptersEnabled(data, titleId, false)
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', '第3話', '第4話'])
    data = setChaptersEnabled(data, titleId, true)
    expect(Object.keys(data.chapters)).toHaveLength(2)
    expect(labels(data, titleId)).toEqual(['第1話', '第2話', '第3話', '第1話'])
  })

  it('1つずつの移動で章の外・隣の章へ移れる', () => {
    let { data, titleId, ids } = withChapters()
    data = withSubtitles(data, ids, ['A', 'B', 'C'])
    const c1 = data.titles[titleId].structure[0].id
    const c2 = addChapter(data, titleId)
    data = c2.data
    // C（第1章の最後）を下へ: 章の外へ → 第2章の先頭へ
    data = movePieceStep(data, ids[2], 1)
    expect(data.titles[titleId].structure.map((n) => n.type)).toEqual(['chapter', 'piece', 'chapter'])
    data = movePieceStep(data, ids[2], 1)
    expect(data.chapters[c2.result].pieceIds).toEqual([ids[2]])
    expect(data.chapters[c1].pieceIds).toEqual([ids[0], ids[1]])
    // A（第1章の先頭）を上へ: 章の外（冒頭）へ
    data = movePieceStep(data, ids[0], -1)
    expect(data.titles[titleId].structure[0]).toEqual({ type: 'piece', id: ids[0] })
    // さらに上へは動かない
    const same = movePieceStep(data, ids[0], -1)
    expect(same).toBe(data)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話:C'])
  })

  it('章の並べ替えで話数が書き換わる。章を解除しても話は消えない', () => {
    let { data, titleId, ids } = withChapters()
    data = withSubtitles(data, ids, ['A', 'B', 'C'])
    const c2 = addChapter(data, titleId)
    data = c2.data
    data = movePiece(data, ids[0], { chapterId: c2.result, index: 0 })
    expect(labels(data, titleId)).toEqual(['第1話:B', '第2話:C', '第3話:A'])
    data = moveChapterStep(data, c2.result, -1)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話:C'])
    data = removeChapter(data, c2.result)
    expect(Object.keys(data.chapters)).toHaveLength(1)
    expect(labels(data, titleId)).toEqual(['第1話:A', '第2話:B', '第3話:C'])
    expect(data.titles[titleId].structure[0]).toEqual({ type: 'piece', id: ids[0] })
  })

  it('通し読みでは章見出しが入り、章単位の通し読みもできる', () => {
    let { data, titleId } = withChapters()
    const c1 = data.titles[titleId].structure[0].id
    const c2 = addChapter(data, titleId, '第2章 帰還')
    data = c2.data
    ;({ data } = add(data, titleId, c2.result))
    const all = buildReadThrough(data, titleId)
    expect(all.filter((b) => b.type === 'chapter').map((b) => (b.type === 'chapter' ? b.name : ''))).toEqual([
      '第1章',
      '第2章 帰還',
    ])
    const only2 = buildReadThrough(data, titleId, c2.result)
    expect(only2).toHaveLength(2)
    expect(only2[1]).toMatchObject({ type: 'piece', label: '第4話' })
    expect(buildReadThrough(data, titleId, c1)).toHaveLength(4)
  })
})

describe('挿入位置の候補', () => {
  it('章なし: 先頭・各話の後・末尾が選べ、移動時は移動元を除いた位置になる', () => {
    let { data, titleId } = setup()
    const ids: ID[] = []
    for (let i = 0; i < 3; i++) {
      const r = add(data, titleId)
      data = r.data
      ids.push(r.id)
    }
    const opts = insertOptions(data, titleId)
    expect(opts.map((o) => o.label)).toEqual(['先頭（「第1話」の前）', '「第1話」の後', '「第2話」の後', '末尾（「第3話」の後）'])
    const moveOpts = insertOptions(data, titleId, ids[0])
    const toEnd = moveOpts[moveOpts.length - 1]
    data = movePiece(data, ids[0], toEnd.slot)
    expect(flatten(data, titleId).map((f) => f.pieceId)).toEqual([ids[1], ids[2], ids[0]])
  })

  it('章あり: 章の先頭・章内・章の外の位置が選べる', () => {
    let { data, titleId } = setup()
    ;({ data } = add(data, titleId))
    data = setChaptersEnabled(data, titleId, true)
    const labelsList = insertOptions(data, titleId).map((o) => o.label)
    expect(labelsList).toEqual([
      '冒頭（タイトル直下・すべての前）',
      '「第1章」の先頭',
      '「第1章」内 「第1話」の後',
      '「第1章」の後（タイトル直下）',
    ])
    const prologue = addSpecial(data, titleId, insertOptions(data, titleId)[0].slot, 'プロローグ')
    expect(labels(prologue.data, titleId)).toEqual(['プロローグ', '第1話'])
    expect(prologue.data.titles[titleId].structure[0]).toEqual({ type: 'piece', id: prologue.result })
  })
})

describe('通し読みの章の区切り', () => {
  it('章の後ろにあるタイトル直下の話の前に、章の終わりの区切りが入る', () => {
    const t = createTitle(emptyData(), '作品')
    let data = addEpisode(t.data, t.result).data
    data = setChaptersEnabled(data, t.result, true)
    data = addSpecial(data, t.result, { chapterId: null, index: 1 }, 'エピローグ').data
    const blocks = buildReadThrough(data, t.result)
    expect(blocks.map((b) => b.type)).toEqual(['chapter', 'piece', 'chapterEnd', 'piece'])
    expect(readThroughText(data, t.result)).toContain('――――――――')
  })
})
