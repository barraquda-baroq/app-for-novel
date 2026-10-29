// 稿の番号「第n稿」: 名前から番号を読む・次の番号を決める・ゴミ箱から戻す稿の名前
import { describe, expect, it } from 'vitest'
import { createTitle } from './entityOps'
import { addEpisode, addVersion, deleteVersion, updateVersion } from './storyOps'
import { emptyData, type AppData, type ID, type Piece, type Version } from './types'
import {
  advancedVersionSeq,
  nextVersionName,
  nextVersionNumber,
  numberedPrefix,
  pieceVersions,
  restoredVersionName,
  versionNumber,
} from './versionNumber'

describe('稿の名前から番号を読む（versionNumber）', () => {
  it('半角の数字', () => {
    expect(versionNumber('第1稿')).toBe(1)
    expect(versionNumber('第12稿')).toBe(12)
    expect(versionNumber('第007稿')).toBe(7)
    expect(versionNumber('第0稿')).toBe(0)
  })

  it('全角の数字（半角と混ざっていてもよい）', () => {
    expect(versionNumber('第３稿')).toBe(3)
    expect(versionNumber('第１２稿')).toBe(12)
    expect(versionNumber('第1２稿')).toBe(12)
  })

  it('漢数字（十・百・千を使う書き方と、〇を使う位取りの書き方）', () => {
    expect(versionNumber('第一稿')).toBe(1)
    expect(versionNumber('第九稿')).toBe(9)
    expect(versionNumber('第十稿')).toBe(10)
    expect(versionNumber('第十一稿')).toBe(11)
    expect(versionNumber('第二十稿')).toBe(20)
    expect(versionNumber('第二十一稿')).toBe(21)
    expect(versionNumber('第百稿')).toBe(100)
    expect(versionNumber('第百二稿')).toBe(102)
    expect(versionNumber('第百〇一稿')).toBe(101)
    expect(versionNumber('第千零一稿')).toBe(1001)
    expect(versionNumber('第三千五百二十稿')).toBe(3520)
    expect(versionNumber('第一〇稿')).toBe(10)
    expect(versionNumber('第二〇二稿')).toBe(202)
    expect(versionNumber('第〇稿')).toBe(0)
    expect(versionNumber('第零稿')).toBe(0)
  })

  it('読めない漢数字の並びは番号なし', () => {
    expect(versionNumber('第十百稿')).toBeNull()
    expect(versionNumber('第十十稿')).toBeNull()
    expect(versionNumber('第二三十稿')).toBeNull()
  })

  it('後ろに付いた説明は読み飛ばす（複製・分割・競合・復元）', () => {
    expect(versionNumber('第3稿（第2稿を複製）')).toBe(3)
    expect(versionNumber('第5稿（分割）')).toBe(5)
    expect(versionNumber('第2稿（つないだ稿）')).toBe(2)
    expect(versionNumber('第6稿（幕をつないだ稿）')).toBe(6)
    expect(versionNumber('第4稿（競合: iPhoneでの編集）')).toBe(4)
    expect(versionNumber('第2稿（復元）')).toBe(2)
    expect(versionNumber('第2稿（ゴミ箱から復元）')).toBe(2)
    expect(versionNumber('第三稿・改')).toBe(3)
    expect(versionNumber('第2稿 推敲中')).toBe(2)
  })

  it('前の空白（半角・全角・タブ）は除いて読む', () => {
    expect(versionNumber(' 第3稿')).toBe(3)
    expect(versionNumber('　第３稿')).toBe(3)
    expect(versionNumber('\t 第十稿（分割）')).toBe(10)
  })

  it('先頭が「第n稿」でない名前は番号なし（書き換えた名前・幕の稿の名前）', () => {
    expect(versionNumber('改稿版')).toBeNull()
    expect(versionNumber('決定稿')).toBeNull()
    expect(versionNumber('')).toBeNull()
    expect(versionNumber('稿')).toBeNull()
    expect(versionNumber('第稿')).toBeNull()
    expect(versionNumber('第2幕の第1稿')).toBeNull()
    expect(versionNumber('改・第3稿')).toBeNull()
    expect(versionNumber('第 3 稿')).toBeNull()
    expect(versionNumber('第3a稿')).toBeNull()
    expect(versionNumber('第-1稿')).toBeNull()
  })

  it('大きすぎて正しく数えられない番号は番号なし', () => {
    expect(versionNumber(`第${'9'.repeat(20)}稿`)).toBeNull()
    expect(versionNumber('第9007199254740991稿')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('numberedPrefix は先頭の「第n稿」の部分を書いたままの形で返す', () => {
    expect(numberedPrefix('第3稿（第2稿を複製）')).toBe('第3稿')
    expect(numberedPrefix('　第三稿（分割）')).toBe('第三稿')
    expect(numberedPrefix('第１２稿')).toBe('第１２稿')
    expect(numberedPrefix('改稿版')).toBeNull()
  })
})

// ---------- 次の番号 ----------

/** 稿の名前 names の第1話（names の順に作り、作った後に名前を付け直す） */
function pieceWith(names: string[]): { data: AppData; pieceId: ID; ids: ID[] } {
  const t = createTitle(emptyData(), '作品')
  const r = addEpisode(t.data, t.result)
  let data = r.data
  const ids: ID[] = [data.pieces[r.result].versionIds[0]]
  for (let i = 1; i < names.length; i++) {
    const v = addVersion(data, r.result)
    data = v.data
    ids.push(v.result)
  }
  names.forEach((name, i) => {
    data = updateVersion(data, ids[i], { name })
  })
  return { data, pieceId: r.result, ids }
}

const next = (data: AppData, pieceId: ID) => nextVersionNumber(data, data.pieces[pieceId])

describe('次の稿の番号（nextVersionNumber）', () => {
  it('第1稿だけなら次は2', () => {
    const { data, pieceId } = pieceWith(['第1稿'])
    expect(next(data, pieceId)).toBe(2)
    expect(nextVersionName(data, data.pieces[pieceId])).toBe('第2稿')
    expect(nextVersionName(data, data.pieces[pieceId], '（つないだ稿）')).toBe('第2稿（つないだ稿）')
  })

  it('間が欠けていても埋めない（第1・3・5・6稿なら次は7）', () => {
    const { data, pieceId } = pieceWith(['第1稿', '第3稿', '第5稿', '第6稿'])
    expect(next(data, pieceId)).toBe(7)
  })

  it('並び順ではなく、いちばん大きい番号の次（採用・不採用を問わない）', () => {
    const { data, pieceId, ids } = pieceWith(['第8稿', '第2稿（第8稿を複製）', '第3稿'])
    expect(data.pieces[pieceId].activeVersionId).toBe(ids[0])
    expect(next(data, pieceId)).toBe(9)
  })

  it('全角・漢数字の名前も数える', () => {
    let { data, pieceId } = pieceWith(['第1稿', '第１２稿'])
    expect(next(data, pieceId)).toBe(13)
    ;({ data, pieceId } = pieceWith(['第1稿', '第二十稿（推敲）']))
    expect(next(data, pieceId)).toBe(21)
  })

  it('番号のない名前に書き換えた稿は数えない。番号のある稿が無ければ1', () => {
    let { data, pieceId } = pieceWith(['第1稿', '改稿版', '決定稿'])
    expect(next(data, pieceId)).toBe(2)
    ;({ data, pieceId } = pieceWith(['改稿版', '決定稿']))
    expect(next(data, pieceId)).toBe(1)
  })

  it('稿の無い話は1', () => {
    const { data, pieceId, ids } = pieceWith(['第1稿'])
    const empty = deleteVersion(data, ids[0])
    expect(empty.pieces[pieceId].versionIds).toEqual([])
    expect(next(empty, pieceId)).toBe(1)
  })

  it('ゴミ箱の稿は数えない', () => {
    const { data, pieceId, ids } = pieceWith(['第1稿', '第2稿', '第3稿'])
    const trashed = deleteVersion(deleteVersion(data, ids[2]), ids[1])
    expect(Object.keys(trashed.trashEntries)).toHaveLength(2)
    expect(next(trashed, pieceId)).toBe(2)
  })

  it('別の話・幕の稿は数えない。並びに載っていない稿（同期の途中など）は数える', () => {
    const t = createTitle(emptyData(), '作品')
    const a = addEpisode(t.data, t.result)
    const b = addEpisode(a.data, t.result)
    let data = updateVersion(b.data, b.data.pieces[b.result].versionIds[0], { name: '第9稿' })
    expect(next(data, a.result)).toBe(2)
    const unlisted: Version = { ...data.versions[data.pieces[a.result].versionIds[0]], id: 'unlisted', name: '第5稿' }
    data = { ...data, versions: { ...data.versions, unlisted } }
    expect(pieceVersions(data, data.pieces[a.result]).map((v) => v.id)).toEqual([...data.pieces[a.result].versionIds, 'unlisted'])
    expect(next(data, a.result)).toBe(6)
  })
})

describe('versionSeq（古い版のアプリ・同期のために残す）', () => {
  const piece = (versionSeq: number) => ({ versionSeq }) as Piece
  it('作った番号・稿の数まで進め、戻さない', () => {
    expect(advancedVersionSeq(piece(1), 2, ['a', 'b'])).toBe(2)
    expect(advancedVersionSeq(piece(5), 2, ['a', 'b'])).toBe(5)
    expect(advancedVersionSeq(piece(3), 1, ['a', 'b', 'c', 'd'])).toBe(4)
    expect(advancedVersionSeq(piece(Number.NaN), 3, ['a'])).toBe(3)
  })
})

describe('ゴミ箱から戻す稿の名前（restoredVersionName）', () => {
  it('同じ名前の稿が無ければそのまま', () => {
    expect(restoredVersionName('第3稿', new Set(['第1稿', '第2稿']))).toBe('第3稿')
    expect(restoredVersionName('第3稿', new Set())).toBe('第3稿')
  })

  it('同じ名前の稿があれば「（復元）」、それもあれば「（復元2）」…', () => {
    expect(restoredVersionName('第2稿', new Set(['第1稿', '第2稿']))).toBe('第2稿（復元）')
    expect(restoredVersionName('第2稿', new Set(['第2稿', '第2稿（復元）']))).toBe('第2稿（復元2）')
    expect(restoredVersionName('第2稿', new Set(['第2稿', '第2稿（復元）', '第2稿（復元2）']))).toBe('第2稿（復元3）')
    expect(restoredVersionName('第3稿（第2稿を複製）', new Set(['第3稿（第2稿を複製）']))).toBe('第3稿（第2稿を複製）（復元）')
  })

  it('「（復元）」の付いた稿を戻す時は、番号だけ進める', () => {
    expect(restoredVersionName('第2稿（復元）', new Set(['第2稿', '第2稿（復元）']))).toBe('第2稿（復元2）')
    expect(restoredVersionName('第2稿（復元2）', new Set(['第2稿（復元）', '第2稿（復元2）']))).toBe('第2稿（復元3）')
  })

  it('名前が空なら「無題の稿（復元）」。戻した名前の番号はそのまま数えられる', () => {
    expect(restoredVersionName('', new Set(['']))).toBe('無題の稿（復元）')
    expect(versionNumber(restoredVersionName('第4稿', new Set(['第4稿'])))).toBe(4)
  })
})
