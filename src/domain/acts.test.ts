import { describe, expect, it } from 'vitest'
import {
  joinActWithNext,
  joinError,
  separatePiece,
  splitPointError,
  splitSegments,
  unseparateError,
  unseparatePiece,
} from './acts'
import {
  createTitle,
  missingActiveLabel,
  recordSubmissionSnapshot,
  addSubmission,
  compareSnapshotWithCurrent,
  takeSnapshot,
  titleSummary,
} from './entityOps'
import { episodeEntries, episodeFileText } from './episodeExport'
import { titleProgress } from './progress'
import { buildReadThrough, NO_ACTIVE_MESSAGE, readThroughText } from './readthrough'
import { repairData } from './repair'
import {
  addEpisode,
  addVersion,
  deletePiece,
  deleteVersion,
  duplicateVersion,
  movePiece,
  movePieceStep,
  setActiveVersion,
  SPLIT_ADOPT_LOCKED,
  updatePiece,
  updateVersion,
} from './storyOps'
import {
  actNumber,
  actParts,
  actsOf,
  adoptedMetrics,
  adoptedText,
  canDeletePiece,
  flatten,
  isSplit,
  joinedText,
  pieceFullLabel,
  pieceLabel,
} from './structure'
import { countChars, textHash } from './text'
import { restoreTrashEntry, trashContents } from './trash'
import { DomainError, emptyData, type AppData, type ID, type Piece } from './types'

// ---------- 用意 ----------

/** 本文 bodies の話を作ったタイトル */
function setup(bodies: string[]) {
  const t = createTitle(emptyData(), '作品')
  let data = t.data
  const ids: ID[] = []
  for (const body of bodies) {
    const r = addEpisode(data, t.result)
    data = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body })
    ids.push(r.result)
  }
  return { data, titleId: t.result, ids }
}

function split(data: AppData, pieceId: ID, offsets: number[]) {
  const r = separatePiece(data, pieceId, offsets)
  return { data: r.data, acts: r.result }
}

/** 幕の採用稿の本文（読む順） */
function actBodies(data: AppData, pieceId: ID): (string | null)[] {
  return actParts(data, data.pieces[pieceId]).map((x) => x.version?.body ?? null)
}

const errorOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.message
    throw e
  }
  throw new Error('DomainError が投げられませんでした')
}

// ---------- 分ける ----------

describe('セパレート（幕に分ける）', () => {
  it('採用稿を区切った本文が各幕の第1稿（採用中）になり、つなぐと元の本文に戻る（話数は増えない）', () => {
    const body = '一幕目の文。\n二幕目の文。\n三幕目。'
    const { data: d0, titleId, ids } = setup([body, '第2話'])
    const { data, acts } = split(d0, ids[0], [7, 14])
    const ep = data.pieces[ids[0]]
    expect(isSplit(ep)).toBe(true)
    expect(ep.actIds).toEqual(acts)
    expect(actBodies(data, ids[0])).toEqual(['一幕目の文。\n', '二幕目の文。\n', '三幕目。'])
    expect(actBodies(data, ids[0]).join('')).toBe(body)
    for (const id of acts) {
      const act = data.pieces[id]
      expect(act.kind).toBe('act')
      expect(act.parentId).toBe(ids[0])
      expect(act.titleId).toBe(titleId)
      expect(act.versionIds).toHaveLength(1)
      expect(act.activeVersionId).toBe(act.versionIds[0])
      expect(data.versions[act.versionIds[0]].name).toBe('第1稿')
    }
    // 話自身の稿はそのまま。本編の並びに幕は載らず、話数も変わらない
    expect(ep.versionIds).toEqual(d0.pieces[ids[0]].versionIds)
    expect(ep.activeVersionId).toBe(d0.pieces[ids[0]].activeVersionId)
    expect(flatten(data, titleId).map((f) => f.pieceId)).toEqual(ids)
    expect(acts.map((id) => pieceLabel(data, data.pieces[id]))).toEqual(['第1幕', '第2幕', '第3幕'])
    expect(acts.map((id) => actNumber(data, data.pieces[id]))).toEqual([1, 2, 3])
    // 話の本文は各幕の採用稿をつないだもの
    expect(adoptedText(data, ep)?.body).toBe(body)
  })

  it('分割点の並びは問わない（小さい順に区切る）', () => {
    const { data: d0, ids } = setup(['あいうえお'])
    const { data } = split(d0, ids[0], [4, 1])
    expect(actBodies(data, ids[0])).toEqual(['あ', 'いうえ', 'お'])
  })

  it('サロゲートペア（𠮷）・CRLF・空白も1字も変えずに分ける', () => {
    const body = '𠮷野家　\r\n\r\n次の幕𩸽\r\n  終わり　'
    const { data: d0, ids } = setup([body])
    const offsets = [body.indexOf('\r\n\r\n') + 4, body.indexOf('𩸽') + 2]
    const { data } = split(d0, ids[0], offsets)
    const parts = actBodies(data, ids[0])
    expect(parts).toEqual(['𠮷野家　\r\n\r\n', '次の幕𩸽', '\r\n  終わり　'])
    expect(parts.join('')).toBe(body)
    expect(countChars(parts.join(''))).toBe(countChars(body))
  })

  it('先頭・末尾・同じ位置・文字の途中・改行の途中・分割点なしは区切れない', () => {
    const body = 'あ𠮷い\r\nう'
    expect(splitPointError(body, 0)).toBe('先頭では区切れません')
    expect(splitPointError(body, body.length)).toBe('末尾では区切れません')
    expect(splitPointError(body, 1, [1])).toBe('そこはもう区切ってあります')
    expect(splitPointError(body, 2)).toBe('文字の途中では区切れません')
    expect(splitPointError(body, body.indexOf('\n'))).toBe('改行の途中では区切れません')
    expect(splitPointError(body, 1.5)).toBe('区切る位置が正しくありません')
    expect(splitPointError(body, 1)).toBeNull()
    expect(splitPointError(body, 3)).toBeNull()
    expect(() => splitSegments(body, [])).toThrow('区切る位置を1つ以上')
    expect(() => splitSegments(body, [1, 1])).toThrow('そこはもう区切ってあります')
    const { data, ids } = setup([body])
    expect(errorOf(() => separatePiece(data, ids[0], [0]))).toBe('先頭では区切れません')
    expect(errorOf(() => separatePiece(data, ids[0], [body.length]))).toBe('末尾では区切れません')
    expect(errorOf(() => separatePiece(data, ids[0], [2]))).toBe('文字の途中では区切れません')
    // 分けられなかった時は何も変わらない
    expect(isSplit(data.pieces[ids[0]])).toBe(false)
  })

  it('採用原稿のない話・特殊ブロック・もう分けた話は分けられない', () => {
    const { data: d0, ids } = setup(['あいう', 'かきく'])
    const unadopted = setActiveVersion(d0, ids[0], null)
    expect(errorOf(() => separatePiece(unadopted, ids[0], [1]))).toContain('採用原稿のない話は幕に分けられません')
    const { data } = split(d0, ids[1], [1])
    expect(errorOf(() => separatePiece(data, ids[1], [2]))).toContain('もう幕に分けてあります')
  })

  it('幕をさらに分ける: その幕に「第n稿（分割）」を採用し、残りの区切りの幕をすぐ後ろに入れる（ほかの稿は残る）', () => {
    const { data: d0, ids } = setup(['ABCDEFGH'])
    let { data, acts } = split(d0, ids[0], [4])
    // 1幕目に推敲用の稿を足しておく（さらに分けても残る）
    data = addVersion(data, acts[0], { body: '別の稿' }).data
    const before = data.pieces[acts[0]]
    const r = separatePiece(data, acts[0], [1, 3])
    data = r.data
    expect(r.result[0]).toBe(acts[0])
    const ep = data.pieces[ids[0]]
    expect(ep.actIds).toEqual([acts[0], r.result[1], r.result[2], acts[1]])
    expect(actBodies(data, ids[0])).toEqual(['A', 'BC', 'D', 'EFGH'])
    expect(actBodies(data, ids[0]).join('')).toBe('ABCDEFGH')
    const first = data.pieces[acts[0]]
    expect(first.versionIds).toEqual([...before.versionIds, first.activeVersionId])
    expect(data.versions[first.activeVersionId!].name).toBe('第3稿（分割）')
    // 元の採用稿・推敲用の稿は残る
    for (const vid of before.versionIds) expect(data.versions[vid]).toBeDefined()
    expect(data.versions[before.activeVersionId!].body).toBe('ABCD')
    expect(r.result.slice(1).map((id) => data.versions[data.pieces[id].activeVersionId!].name)).toEqual(['第1稿', '第1稿'])
  })
})

// ---------- 分けている間 ----------

describe('幕に分けた話', () => {
  it('話自身の稿・採用は変えられない（採用を外す・採用を変えるにはセパレート解除が先）', () => {
    const { data: d0, ids } = setup(['あいうえお'])
    const { data } = split(d0, ids[0], [2])
    const ep = data.pieces[ids[0]]
    const vid = ep.activeVersionId!
    expect(errorOf(() => setActiveVersion(data, ids[0], null))).toBe(SPLIT_ADOPT_LOCKED)
    expect(SPLIT_ADOPT_LOCKED).toBe('幕に分けた話の採用を変えるには、先にセパレートを解除してください')
    const withOther = addVersion(d0, ids[0]).data
    const splitOther = separatePiece(withOther, ids[0], [2]).data
    expect(errorOf(() => setActiveVersion(splitOther, ids[0], withOther.pieces[ids[0]].versionIds[1]))).toBe(SPLIT_ADOPT_LOCKED)
    expect(() => updateVersion(data, vid, { body: '書き換え' })).toThrow(DomainError)
    expect(() => addVersion(data, ids[0])).toThrow(DomainError)
    expect(() => duplicateVersion(data, vid)).toThrow(DomainError)
    expect(() => deleteVersion(data, vid)).toThrow(DomainError)
    // 話の題は変えられる（各幕の見出し「第1話　題　第x幕」に使う）
    const titled = updatePiece(data, ids[0], { subtitle: '旅立ち' })
    expect(pieceFullLabel(titled, titled.pieces[titled.pieces[ids[0]].actIds![1]])).toBe('第1話　旅立ち　第2幕')
  })

  it('幕は並べ替え・削除・見出しの変更ができない（幕の稿は話と同じように扱える）', () => {
    const { data: d0, ids } = setup(['あいうえお'])
    const { data, acts } = split(d0, ids[0], [2])
    expect(() => movePieceStep(data, acts[0], 1)).toThrow(DomainError)
    expect(() => movePiece(data, acts[0], { chapterId: null, index: 0 })).toThrow(DomainError)
    expect(canDeletePiece(data, acts[0]).ok).toBe(false)
    expect(() => deletePiece(data, acts[0])).toThrow(DomainError)
    expect(() => updatePiece(data, acts[0], { label: '序' })).toThrow('第x幕の表記は変更できません')
    // 幕の稿は追加・採用・採用解除できる
    const r = addVersion(data, acts[0], { body: '新しい幕' })
    const adopted = setActiveVersion(r.data, acts[0], r.result)
    expect(actBodies(adopted, ids[0])).toEqual(['新しい幕', 'うえお'])
    const unadopted = setActiveVersion(adopted, acts[0], null)
    expect(actBodies(unadopted, ids[0])).toEqual([null, 'うえお'])
  })

  it('話の本文・文字数・進捗・集計は各幕の採用稿をつないだもの（採用稿のない幕は数えず、採用原稿なしとして数える）', () => {
    const { data: d0, titleId, ids } = setup(['あいうえお', 'かきく'])
    let { data, acts } = split(d0, ids[0], [2])
    expect(adoptedMetrics(data, data.pieces[ids[0]])?.chars).toBe(5)
    data = updateVersion(data, data.pieces[acts[1]].activeVersionId!, { body: 'うえおかきくけこ' })
    expect(adoptedMetrics(data, data.pieces[ids[0]])?.chars).toBe(10)
    expect(titleSummary(data, titleId)).toMatchObject({ activeChars: 13, missingActive: 0, missingActs: 0 })
    const progress = titleProgress(data, titleId)
    expect(progress.get(ids[0])).toMatchObject({ chars: 10, total: 13, end: 10 / 13 })
    data = setActiveVersion(data, acts[0], null)
    expect(adoptedText(data, data.pieces[ids[0]])?.body).toBe('うえおかきくけこ')
    const s = titleSummary(data, titleId)
    expect(s).toMatchObject({ activeChars: 11, missingActive: 1, missingActs: 1, missingEpisodes: 0 })
    expect(missingActiveLabel(s.missingEpisodes, s.missingSpecials, s.missingActs)).toBe('採用原稿なし 1幕')
    // どの幕にも採用稿がなければ、話にも採用原稿がない
    data = setActiveVersion(data, acts[1], null)
    expect(adoptedText(data, data.pieces[ids[0]])).toBeNull()
    expect(titleSummary(data, titleId)).toMatchObject({ activeChars: 3, missingActs: 2, missingActive: 2 })
  })

  it('つないだ本文は幕と採用稿が変わらない限り同じオブジェクト（文字数を数え直さない）', () => {
    const { data: d0, ids } = setup(['あいうえお', 'か'])
    const { data } = split(d0, ids[0], [2])
    const a = joinedText(data, data.pieces[ids[0]])
    // ほかの話を変えても同じ
    const other = updateVersion(data, data.pieces[ids[1]].versionIds[0], { body: 'かき' })
    expect(joinedText(other, other.pieces[ids[0]])).toBe(a)
    const edited = updateVersion(data, data.pieces[data.pieces[ids[0]].actIds![0]].activeVersionId!, { body: 'あ' })
    expect(joinedText(edited, edited.pieces[ids[0]])).not.toBe(a)
    expect(joinedText(edited, edited.pieces[ids[0]]).body).toBe('あうえお')
  })

  it('通し読みは幕ごとに見出しを入れ、採用稿のない幕には「採用原稿がありません。」', () => {
    const { data: d0, titleId, ids } = setup(['一幕。二幕。', '次の話'])
    let { data, acts } = split(d0, ids[0], [3])
    data = updatePiece(data, ids[0], { subtitle: '題' })
    data = setActiveVersion(data, acts[1], null)
    const blocks = buildReadThrough(data, titleId)
    const b = blocks[0]
    expect(b.type === 'piece' && b.acts?.map((a) => [a.label, a.body])).toEqual([
      ['第1幕', '一幕。'],
      ['第2幕', null],
    ])
    expect(b.type === 'piece' && b.body).toBe('一幕。')
    const text = readThroughText(data, titleId)
    expect(text).toBe(`作品\n\n第1話　題\n\n第1幕\n\n一幕。\n\n\n第2幕\n\n${NO_ACTIVE_MESSAGE}\n\n\n第2話\n\n次の話\n`)
  })

  it('各話テキスト書き出しは1話1ファイルで、各幕の前に幕の見出しを入れる（採用稿のない幕は飛ばす）', () => {
    const { data: d0, titleId, ids } = setup(['一幕の文。\n二幕の文。\n三幕。'])
    let { data, acts } = split(d0, ids[0], [6, 12])
    data = updatePiece(data, ids[0], { subtitle: '題' })
    const [entry] = episodeEntries(data, titleId, new Date(2026, 9, 1))
    expect(entry.name).toBe('20261001作品_第1話.txt')
    expect(episodeFileText(entry, true)).toBe(
      '第1話　題\r\n\r\n第1幕\r\n\r\n一幕の文。\r\n\r\n第2幕\r\n\r\n二幕の文。\r\n\r\n第3幕\r\n\r\n三幕。',
    )
    expect(episodeFileText(entry, false).startsWith('第1幕\r\n\r\n一幕の文。')).toBe(true)
    data = setActiveVersion(data, acts[1], null)
    const [e2] = episodeEntries(data, titleId, new Date(2026, 9, 1))
    expect(episodeFileText(e2, false)).toBe('第1幕\r\n\r\n一幕の文。\r\n\r\n第3幕\r\n\r\n三幕。')
  })

  it('応募時の記録はつないだ本文。分けただけでは変化にならず、幕の編集は「本文を編集」になる', () => {
    const { data: d0, titleId, ids } = setup(['あいうえお'])
    const sub = addSubmission(d0, titleId, 'コンテスト')
    const recorded = recordSubmissionSnapshot(sub.data, sub.result)
    const snapshot = recorded.submissions[sub.result].snapshot!
    let { data, acts } = split(recorded, ids[0], [2])
    expect(compareSnapshotWithCurrent(data, titleId, snapshot)).toMatchObject({ switched: [], edited: [], charDelta: 0 })
    const now = takeSnapshot(data, titleId)
    expect(now.pieces![ids[0]].versionName).toBe('2幕に分けた原稿')
    expect([...now.texts.values()]).toEqual(['あいうえお'])
    data = updateVersion(data, data.pieces[acts[1]].activeVersionId!, { body: 'うえおか' })
    expect(compareSnapshotWithCurrent(data, titleId, snapshot)).toMatchObject({ edited: [ids[0]], charDelta: 1 })
  })
})

// ---------- つなぐ ----------

describe('次の幕とつなぐ', () => {
  it('この幕に「第n稿（つないだ稿）」を採用し、次の幕は消える。次の幕の採用していなかった稿はゴミ箱へ（戻すとこの幕の稿）', () => {
    const { data: d0, titleId, ids } = setup(['ABCDEF'])
    let { data, acts } = split(d0, ids[0], [2, 4])
    // 2幕目に推敲用の稿を2つ
    data = addVersion(data, acts[1], { body: 'CD改' }).data
    data = addVersion(data, acts[1], { body: 'CD改2' }).data
    const second = data.pieces[acts[1]]
    const r = joinActWithNext(data, acts[0])
    data = r.data
    expect(data.pieces[ids[0]].actIds).toEqual([acts[0], acts[2]])
    expect(data.pieces[acts[1]]).toBeUndefined()
    expect(data.versions[second.activeVersionId!]).toBeUndefined()
    const first = data.pieces[acts[0]]
    expect(first.activeVersionId).toBe(r.result)
    expect(data.versions[r.result]).toMatchObject({ name: '第2稿（つないだ稿）', body: 'ABCD' })
    expect(actBodies(data, ids[0]).join('')).toBe('ABCDEF')
    expect(adoptedText(data, data.pieces[ids[0]])?.body).toBe('ABCDEF')

    const entries = Object.values(data.trashEntries)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({ kind: 'version', label: '第2幕の採用していなかった稿（2稿）', parentLabel: '第1話　第1幕' })
    const contents = trashContents(data, entry)
    expect(contents.map((c) => (c.record as { name: string }).name)).toEqual(['第2幕の第2稿', '第2幕の第3稿'])

    const restored = restoreTrashEntry(data, entry.id)
    const back = restored.data
    expect(restored.result.titleId).toBe(titleId)
    const firstBack = back.pieces[acts[0]]
    expect(firstBack.versionIds.slice(-2).map((id) => back.versions[id].body)).toEqual(['CD改', 'CD改2'])
    expect(firstBack.versionIds.slice(-2).every((id) => back.versions[id].pieceId === acts[0])).toBe(true)
    // 採用は変わらない
    expect(firstBack.activeVersionId).toBe(r.result)
    expect(Object.keys(back.trashEntries)).toHaveLength(0)
    expect(repairData(back).fixes).toEqual([])
  })

  it('採用していなかった稿がなければゴミ箱には入れない', () => {
    const { data: d0, ids } = setup(['ABCD'])
    const { data, acts } = split(d0, ids[0], [2])
    const joined = joinActWithNext(data, acts[0]).data
    expect(Object.keys(joined.trashEntries)).toHaveLength(0)
    expect(actsOf(joined, joined.pieces[ids[0]])).toHaveLength(1)
  })

  it('最後の幕・採用稿のない幕はつなげない', () => {
    const { data: d0, ids } = setup(['ABCDEF'])
    let { data, acts } = split(d0, ids[0], [2, 4])
    expect(joinError(data, acts[2])).toBe('最後の幕なので、次の幕とつなげません')
    expect(() => joinActWithNext(data, acts[2])).toThrow(DomainError)
    data = setActiveVersion(data, acts[1], null)
    expect(joinError(data, acts[0])).toBe('第2幕に採用稿がないため、つなげません')
    expect(errorOf(() => joinActWithNext(data, acts[1]))).toBe('第2幕に採用稿がないため、つなげません')
    expect(joinError(data, ids[0])).toBe('幕ではありません')
  })
})

// ---------- 解除 ----------

describe('セパレート解除', () => {
  it('すべての幕に採用稿がある時だけ解除でき、各幕の採用稿をつないだ「第n稿（幕をつないだ稿）」を採用する', () => {
    const { data: d0, titleId, ids } = setup(['ABCDEF'])
    let { data, acts } = split(d0, ids[0], [2, 4])
    data = updateVersion(data, data.pieces[acts[1]].activeVersionId!, { body: 'cd' })
    data = addVersion(data, acts[0], { body: '1幕の別案' }).data
    data = addVersion(data, acts[2], { body: '3幕の別案' }).data
    const own = data.pieces[ids[0]]
    const r = unseparatePiece(data, ids[0])
    data = r.data
    const ep = data.pieces[ids[0]]
    expect(isSplit(ep)).toBe(false)
    expect(ep.actIds).toEqual([])
    expect(ep.activeVersionId).toBe(r.result)
    expect(ep.versionIds).toEqual([...own.versionIds, r.result])
    expect(data.versions[r.result]).toMatchObject({ name: '第2稿（幕をつないだ稿）', body: 'ABcdEF', pieceId: ids[0] })
    for (const id of acts) expect(data.pieces[id]).toBeUndefined()
    expect(Object.values(data.versions).filter((v) => v.pieceId !== ids[0])).toEqual([])
    expect(flatten(data, titleId).map((f) => f.pieceId)).toEqual(ids)

    // 各幕の採用していなかった稿は1件にまとめてゴミ箱へ。戻すとこの話の稿として戻る
    const entries = Object.values(data.trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'version', label: '各幕の採用していなかった稿（2稿）', parentLabel: '第1話' })
    const back = restoreTrashEntry(data, entries[0].id).data
    const restored = back.pieces[ids[0]]
    expect(restored.versionIds.slice(-2).map((id) => back.versions[id].name)).toEqual(['第1幕の第2稿', '第3幕の第2稿'])
    expect(restored.activeVersionId).toBe(r.result)
    expect(repairData(back).fixes).toEqual([])
  })

  it('採用稿のない幕が1つでもあれば解除できない（幕の名前を伝える）', () => {
    const { data: d0, ids } = setup(['ABCDEF'])
    let { data, acts } = split(d0, ids[0], [2, 4])
    data = setActiveVersion(data, acts[1], null)
    expect(unseparateError(data, ids[0])).toBe('第2幕に採用原稿がないため、セパレートを解除できません')
    expect(errorOf(() => unseparatePiece(data, ids[0]))).toBe('第2幕に採用原稿がないため、セパレートを解除できません')
    data = setActiveVersion(data, acts[2], null)
    expect(unseparateError(data, ids[0])).toBe('第2幕・第3幕に採用原稿がないため、セパレートを解除できません')
    expect(unseparateError(d0, ids[0])).toBe('幕に分けていない話です')
  })

  it('解除した後のゴミ箱は、話をまた幕に分けていると戻せない', () => {
    const { data: d0, ids } = setup(['ABCD'])
    let { data, acts } = split(d0, ids[0], [2])
    data = addVersion(data, acts[0], { body: '別案' }).data
    data = unseparatePiece(data, ids[0]).data
    const entry = Object.values(data.trashEntries)[0]
    data = separatePiece(data, ids[0], [1]).data
    expect(errorOf(() => restoreTrashEntry(data, entry.id))).toContain('先にセパレートを解除してください')
  })
})

// ---------- 削除・ゴミ箱 ----------

describe('幕に分けた話の削除', () => {
  it('話・幕・すべての稿を1件にまとめてゴミ箱へ移し、戻すとすべて元どおり', () => {
    const { data: d0, titleId, ids } = setup(['第1話', 'ABCDEF'])
    let { data, acts } = split(d0, ids[1], [2, 4])
    data = addVersion(data, acts[1], { body: '別案' }).data
    const before = data
    expect(canDeletePiece(data, ids[1]).ok).toBe(true)
    data = deletePiece(data, ids[1])
    expect(data.pieces[ids[1]]).toBeUndefined()
    for (const id of acts) expect(data.pieces[id]).toBeUndefined()
    expect(Object.values(data.versions).every((v) => v.pieceId === ids[0])).toBe(true)
    const entries = Object.values(data.trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'piece', label: '第2話' })
    const contents = trashContents(data, entries[0])
    // 話 + 話の稿1 + 幕3 + 幕の稿4
    expect(contents.map((c) => c.table)).toEqual([
      'pieces',
      'versions',
      'pieces',
      'versions',
      'pieces',
      'versions',
      'versions',
      'pieces',
      'versions',
    ])

    const back = restoreTrashEntry(data, entries[0].id).data
    expect(flatten(back, titleId).map((f) => f.pieceId)).toEqual(ids)
    expect(back.pieces[ids[1]].actIds).toEqual(acts)
    expect(actBodies(back, ids[1])).toEqual(actBodies(before, ids[1]))
    expect(back.pieces[acts[1]].versionIds).toEqual(before.pieces[acts[1]].versionIds)
    expect(repairData(back).fixes).toEqual([])
  })

  it('同じ id の話が残っていて複製として戻す時も、幕の参照を付け替える', () => {
    const { data: d0, ids } = setup(['ABCD'])
    const { data, acts } = split(d0, ids[0], [2])
    const deleted = deletePiece(data, ids[0])
    const entry = Object.values(deleted.trashEntries)[0]
    // 削除した話が（同期などで）残っていた
    const withCopy: AppData = {
      ...deleted,
      pieces: { ...deleted.pieces, [ids[0]]: data.pieces[ids[0]], [acts[0]]: data.pieces[acts[0]] },
    }
    const r = restoreTrashEntry(withCopy, entry.id)
    const copy = r.data.pieces[r.result.id]
    expect(r.result.copied).toBe(true)
    expect(copy.actIds).toHaveLength(2)
    expect(copy.actIds).not.toContain(acts[0])
    for (const id of copy.actIds!) expect(r.data.pieces[id].parentId).toBe(copy.id)
  })

  it('途中の話は分けていても削除できない。並べ替えると幕もいっしょに動く', () => {
    const { data: d0, titleId, ids } = setup(['ABCD', '第2話'])
    const { data, acts } = split(d0, ids[0], [2])
    expect(canDeletePiece(data, ids[0]).ok).toBe(false)
    const moved = movePieceStep(data, ids[0], 1)
    expect(flatten(moved, titleId).map((f) => f.pieceId)).toEqual([ids[1], ids[0]])
    expect(moved.pieces[ids[0]].actIds).toEqual(acts)
    expect(pieceFullLabel(moved, moved.pieces[acts[1]])).toBe('第2話　第2幕')
  })
})

// ---------- 修復 ----------

describe('幕の修復（表示用）', () => {
  function sample() {
    const { data: d0, titleId, ids } = setup(['ABCDEF'])
    const { data, acts } = split(d0, ids[0], [2, 4])
    return { data, titleId, ids, acts }
  }

  it('正常に分けたデータはそのまま', () => {
    const { data } = sample()
    expect(repairData(data).fixes).toEqual([])
  })

  it('話のない幕は見えなくする（幕の稿も）。幕は本編の並びに入れない', () => {
    const { data, titleId, ids, acts } = sample()
    const pieces = { ...data.pieces }
    delete pieces[ids[0]]
    const broken: AppData = { ...data, pieces, titles: { ...data.titles, [titleId]: { ...data.titles[titleId], structure: [] } } }
    const r = repairData(broken)
    for (const id of acts) expect(r.data.pieces[id]).toBeUndefined()
    expect(Object.keys(r.data.versions)).toHaveLength(0)
    expect(r.data.titles[titleId].structure).toEqual([])
  })

  it('幕の並びは、存在してこの話を指す幕だけにし、載っていない幕は作られた順に後ろへ足す', () => {
    const { data, ids, acts } = sample()
    const later: Piece = {
      ...data.pieces[acts[0]],
      id: 'late',
      createdAt: data.pieces[acts[0]].createdAt + 10,
      versionIds: [],
      activeVersionId: null,
    }
    const broken: AppData = {
      ...data,
      pieces: {
        ...data.pieces,
        late: later,
        [ids[0]]: { ...data.pieces[ids[0]], actIds: [acts[2], 'ghost', acts[0], acts[2]] },
      },
    }
    const r = repairData(broken)
    expect(r.fixes.length).toBeGreaterThan(0)
    expect(r.data.pieces[ids[0]].actIds).toEqual([acts[2], acts[0], acts[1], 'late'])
    // 修復は表示用の内容にだけ当てる（元のデータは変えない）
    expect(broken.pieces[ids[0]].actIds).toEqual([acts[2], 'ghost', acts[0], acts[2]])
  })

  it('幕の種類は幕のまま（第n話にしない）。幕が本編の並びに入っていたら外す。第n話以外の幕の並びは使わない', () => {
    const { data, titleId, ids, acts } = sample()
    const t = data.titles[titleId]
    const broken: AppData = {
      ...data,
      titles: { ...data.titles, [titleId]: { ...t, structure: [...t.structure, { type: 'piece', id: acts[0] }] } },
    }
    const r = repairData(broken)
    expect(r.data.pieces[acts[0]].kind).toBe('act')
    expect(r.data.titles[titleId].structure).toEqual(t.structure)
    expect(flatten(r.data, titleId).map((f) => f.pieceId)).toEqual(ids)
    // 特殊ブロックを指す幕は見えなくし、特殊ブロックの幕の並びは読まない
    const special: AppData = {
      ...data,
      pieces: { ...data.pieces, [ids[0]]: { ...data.pieces[ids[0]], kind: 'special', label: 'プロローグ' } },
    }
    const rs = repairData(special)
    for (const id of acts) expect(rs.data.pieces[id]).toBeUndefined()
    expect(isSplit(rs.data.pieces[ids[0]])).toBe(false)
  })

  it('幕の並びが空（セパレートを解除した話）なら、話を指したまま残っている幕を足さない（話自身の採用稿のまま）', () => {
    const { data, ids, acts } = sample()
    const undone = unseparatePiece(data, ids[0]).data
    // 解除した端末の幕の削除が届く前（幕の1つがまだ残っている）
    const withLeftover: AppData = {
      ...undone,
      pieces: { ...undone.pieces, [acts[1]]: data.pieces[acts[1]] },
      versions: {
        ...undone.versions,
        [data.pieces[acts[1]].activeVersionId!]: data.versions[data.pieces[acts[1]].activeVersionId!],
      },
    }
    const r = repairData(withLeftover).data
    const ep = r.pieces[ids[0]]
    expect(isSplit(ep)).toBe(false)
    expect(ep.actIds).toEqual([])
    expect(adoptedText(r, ep)?.body).toBe('ABCDEF')
    expect(unseparateError(r, ids[0])).toBe('幕に分けていない話です')
  })

  it('セパレート解除と、別の端末で幕をさらに分けたのが重なっても（解除が勝った並び）、話は分けていないまま本文は全部', () => {
    const { data: d0, ids } = setup(['ABCDEFGHI'])
    const { data, acts } = split(d0, ids[0], [3, 6])
    // 端末 X: セパレート解除
    const x = unseparatePiece(data, ids[0]).data
    // 端末 Y: 第2幕をさらに分ける（新しい幕 C1 が第2幕の後ろに入る）
    const y = separatePiece(data, acts[1], [1])
    const c1 = y.result[1]
    // 同期で合わさった内容: 話は X（幕の並びは空）、Y が作った幕 C1 とその稿はまだ残っている
    const merged: AppData = {
      ...x,
      pieces: { ...x.pieces, [c1]: y.data.pieces[c1] },
      versions: { ...x.versions, [y.data.pieces[c1].activeVersionId!]: y.data.versions[y.data.pieces[c1].activeVersionId!] },
    }
    const r = repairData(merged).data
    expect(isSplit(r.pieces[ids[0]])).toBe(false)
    expect(adoptedText(r, r.pieces[ids[0]])?.body).toBe('ABCDEFGHI')
  })

  it('話の更新より先に幕が届いた時（幕の並びが無い）は、作られた順＝読む順に並べる（id の順に関わらない）', () => {
    const body = 'AAAABBBBCCCCDDDDEEEEFFFF'
    const { data: d0, ids } = setup([body])
    const { data, acts } = split(d0, ids[0], [4, 8, 12, 16, 20])
    // 作った時刻は読む順に増える
    const created = acts.map((id) => data.pieces[id].createdAt)
    expect(created).toEqual([...created].sort((a, b) => a - b))
    expect(new Set(created).size).toBe(acts.length)
    // id を読む順と逆にし、入れる順も混ぜる。話は分ける前のまま（幕の並びが無い）
    const pieces: AppData['pieces'] = {}
    const versions: AppData['versions'] = { ...d0.versions }
    for (const p of Object.values(d0.pieces)) pieces[p.id] = p
    const order = [3, 0, 5, 2, 4, 1]
    for (const i of order) {
      const act = data.pieces[acts[i]]
      const newActId = `z${9 - i}`
      const vid = act.activeVersionId!
      pieces[newActId] = { ...act, id: newActId }
      versions[vid] = { ...data.versions[vid], pieceId: newActId }
    }
    const arrived: AppData = { ...d0, pieces, versions }
    expect(arrived.pieces[ids[0]].actIds).toBeUndefined()
    const r = repairData(arrived).data
    expect(isSplit(r.pieces[ids[0]])).toBe(true)
    expect(adoptedText(r, r.pieces[ids[0]])?.body).toBe(body)
    // その状態で解除しても、元の本文を採用する
    const u = unseparatePiece(r, ids[0])
    expect(u.data.versions[u.result].body).toBe(body)
  })

  it('同じ時刻に作られた幕は id の順に並べる（どの端末でも同じ並び）', () => {
    const { data, ids, acts } = sample()
    const ts = data.pieces[acts[0]].createdAt
    const pieces = { ...data.pieces, [ids[0]]: { ...data.pieces[ids[0]] } }
    delete pieces[ids[0]].actIds
    for (const id of acts) pieces[id] = { ...pieces[id], createdAt: ts }
    const r = repairData({ ...data, pieces }).data
    expect(r.pieces[ids[0]].actIds).toEqual([...acts].sort())
  })

  it('古い版の端末が第n話として書いた幕（kind episode・parentId あり）も幕として扱い、本編の並びに入れない', () => {
    const { data, titleId, ids, acts } = sample()
    const t = data.titles[titleId]
    // 2.1 の修復は幕を第n話にして本編の末尾に足し、その並びを書き戻すことがある
    const old: AppData = {
      ...data,
      pieces: { ...data.pieces, [acts[1]]: { ...data.pieces[acts[1]], kind: 'episode' } },
      titles: {
        ...data.titles,
        [titleId]: { ...t, structure: [...t.structure, ...acts.map((id) => ({ type: 'piece' as const, id }))] },
      },
    }
    const r = repairData(old).data
    expect(r.pieces[acts[1]].kind).toBe('act')
    expect(flatten(r, titleId).map((f) => f.pieceId)).toEqual(ids)
    expect(r.pieces[ids[0]].actIds).toEqual(acts)
    expect(adoptedText(r, r.pieces[ids[0]])?.body).toBe('ABCDEF')
  })
})

// ---------- ゴミ箱から戻す（幕が無くなった後） ----------

describe('消えた幕の稿をゴミ箱から戻す', () => {
  /** 'AAABBBCCC' を3幕に分ける */
  function three() {
    const { data: d0, titleId, ids } = setup(['AAABBBCCC'])
    const { data, acts } = split(d0, ids[0], [3, 6])
    return { data, titleId, ep: ids[0], acts }
  }
  const versionsWithBody = (data: AppData, pieceId: ID, body: string) =>
    data.pieces[pieceId].versionIds.map((id) => data.versions[id]).filter((v) => v.body === body)

  it('つないだ後にまた前の幕とつないでも、前につないだ時の稿は残った幕の稿として（採用せずに）戻せる', () => {
    let { data, ep, acts } = three()
    data = addVersion(data, acts[2], { body: '第3幕の下書き' }).data
    data = joinActWithNext(data, acts[1]).data
    const entryA = Object.values(data.trashEntries)[0]
    expect(entryA.origin).toMatchObject({ pieceId: acts[1], parentId: ep })
    data = joinActWithNext(data, acts[0]).data
    expect(data.pieces[acts[1]]).toBeUndefined()
    const before = data.pieces[acts[0]]
    const back = restoreTrashEntry(data, entryA.id).data
    const restored = versionsWithBody(back, acts[0], '第3幕の下書き')
    expect(restored).toHaveLength(1)
    expect(restored[0].pieceId).toBe(acts[0])
    expect(back.pieces[acts[0]].activeVersionId).toBe(before.activeVersionId)
    expect(adoptedText(back, back.pieces[ep])?.body).toBe('AAABBBCCC')
    expect(repairData(back).fixes).toEqual([])
  })

  it('ゴミ箱の件の幕の属する話（origin.parentId）は、文字列の時だけ残す（修復）', () => {
    let { data, acts } = three()
    data = addVersion(data, acts[2], { body: '下書き' }).data
    data = joinActWithNext(data, acts[1]).data
    const entry = Object.values(data.trashEntries)[0]
    const broken: AppData = {
      ...data,
      trashEntries: { [entry.id]: { ...entry, origin: { ...entry.origin, parentId: 42 as unknown as string } } },
    }
    expect(repairData(broken).data.trashEntries[entry.id].origin).not.toHaveProperty('parentId')
    expect(repairData(data).data.trashEntries[entry.id].origin.parentId).toBe(entry.origin.parentId)
  })

  it('つないだ後にセパレートを解除しても、つないだ時の稿は話の稿として（採用せずに）戻せる', () => {
    let { data, ep, acts } = three()
    data = addVersion(data, acts[2], { body: '第3幕の下書き' }).data
    data = joinActWithNext(data, acts[1]).data
    const entryA = Object.values(data.trashEntries)[0]
    const u = unseparatePiece(data, ep)
    data = u.data
    const back = restoreTrashEntry(data, entryA.id).data
    const restored = versionsWithBody(back, ep, '第3幕の下書き')
    expect(restored).toHaveLength(1)
    expect(back.pieces[ep].versionIds.at(-1)).toBe(restored[0].id)
    expect(back.pieces[ep].activeVersionId).toBe(u.result)
    expect(repairData(back).fixes).toEqual([])
  })

  it('幕から削除した稿は、その幕がつないで無くなっても、解除して無くなっても戻せる', () => {
    let { data, ep, acts } = three()
    const extra = addVersion(data, acts[1], { body: '第2幕の別案' })
    data = deleteVersion(extra.data, extra.result)
    const entry = Object.values(data.trashEntries)[0]
    expect(entry.origin).toMatchObject({ pieceId: acts[1], parentId: ep })

    // つないで第2幕が無くなった → 第1幕へ
    const joined = joinActWithNext(data, acts[0]).data
    const backJoined = restoreTrashEntry(joined, entry.id).data
    expect(versionsWithBody(backJoined, acts[0], '第2幕の別案')).toHaveLength(1)

    // さらに解除した → 話へ
    const undone = unseparatePiece(joined, ep).data
    const backUndone = restoreTrashEntry(undone, entry.id).data
    expect(versionsWithBody(backUndone, ep, '第2幕の別案')).toHaveLength(1)

    // 解除だけ → 話へ
    const onlyUndone = unseparatePiece(data, ep).data
    const back = restoreTrashEntry(onlyUndone, entry.id).data
    expect(versionsWithBody(back, ep, '第2幕の別案')).toHaveLength(1)
  })

  it('別の端末でつながれて（ゴミ箱の付け替えが無くても）、幕の属する話から戻せる。採用中だった稿でも採用は変えない', () => {
    let { data, ep, acts } = three()
    // 第2幕の採用稿を消してから、別の稿を採用する
    const a2 = data.pieces[acts[1]].activeVersionId!
    const other = addVersion(data, acts[1], { body: 'BBB改' })
    data = deleteVersion(other.data, a2)
    data = setActiveVersion(data, acts[1], other.result)
    const entry = Object.values(data.trashEntries)[0]
    expect(entry.origin).toMatchObject({ pieceId: acts[1], parentId: ep, wasActive: true })
    // 別の端末でのつなぎ: この件はまだ届いていなかった（付け替えられていない）
    const withoutEntry: AppData = { ...data, trashEntries: {} }
    const remote = joinActWithNext(withoutEntry, acts[0]).data
    let synced: AppData = { ...remote, trashEntries: { ...remote.trashEntries, [entry.id]: entry } }
    // 第1幕の採用を外しておいても、戻した稿は採用しない（つないだ本文が黙って変わらないように）
    synced = setActiveVersion(synced, acts[0], null)
    const back = restoreTrashEntry(synced, entry.id).data
    const restored = versionsWithBody(back, acts[0], 'BBB')
    expect(restored).toHaveLength(1)
    expect(back.pieces[acts[0]].activeVersionId).toBeNull()

    // 話をまた分けていた時は最初の幕へ
    const resplit: AppData = (() => {
      const u = unseparatePiece({ ...remote, trashEntries: {} }, ep).data
      return { ...separatePiece(u, ep, [2]).data, trashEntries: { [entry.id]: entry }, trashRecords: remote.trashRecords }
    })()
    const first = actsOf(resplit, resplit.pieces[ep])[0]
    const back2 = restoreTrashEntry(resplit, entry.id).data
    expect(versionsWithBody(back2, first.id, 'BBB')).toHaveLength(1)
  })
})

// ---------- 推敲メモを引き継ぐ ----------

describe('消える幕の推敲メモ', () => {
  it('つなぐ・解除すると、消える幕の採用稿の推敲メモと名前を新しい稿の推敲メモに引き継ぐ', () => {
    const { data: d0, ids } = setup(['AAABBBCCC'])
    let { data, acts } = split(d0, ids[0], [3, 6])
    const notes = ['第1幕のメモ：書き出しを短く', '第2幕のメモ：伏線を回収する', '第3幕のメモ：余韻']
    acts.forEach((id, i) => {
      data = updateVersion(data, data.pieces[id].activeVersionId!, { name: `幕${i + 1}の稿`, note: notes[i] })
    })
    const j = joinActWithNext(data, acts[1])
    const joinedNote = j.data.versions[j.result].note
    expect(joinedNote).toBe(`【第2幕　幕2の稿】\n${notes[1]}\n\n【第3幕　幕3の稿】\n${notes[2]}`)

    const u = unseparatePiece(j.data, ids[0])
    const live = Object.values(u.data.versions).map((v) => v.note)
    const trashed = Object.values(u.data.trashRecords).map((r) => (r.record as { note?: string }).note ?? '')
    const all = [...live, ...trashed].join('\n')
    for (const n of notes) expect(all).toContain(n)
    for (const name of ['幕1の稿', '幕2の稿', '幕3の稿']) expect(all).toContain(name)
    expect(u.data.versions[u.result].note).toContain('【第1幕　幕1の稿】')
    // 空のメモは引き継がない
    const { data: e0, ids: eids } = setup(['ABCD'])
    const e = unseparatePiece(split(e0, eids[0], [2]).data, eids[0])
    expect(e.data.versions[e.result].note).toBe('')
  })
})

// ---------- 古い版の端末がゴミ箱に入れた幕 ----------

describe('古い版（2.1）の端末が第n話として削除した幕を戻す', () => {
  /** 2.1 の削除: 幕を第n話（kind episode）のまま話のレコードとしてゴミ箱へ入れ、幕だけを消す（話の幕の並びは書かない） */
  function deletedBy21(data: AppData, actId: ID): { data: AppData; entryId: ID } {
    const act = data.pieces[actId]
    const entryId = 'old-entry'
    const records = [
      {
        id: 'old-r1',
        entryId,
        table: 'pieces' as const,
        record: { ...act, kind: 'episode' as const },
        createdAt: 1,
        updatedAt: 1,
      },
      ...act.versionIds.map((vid, i) => ({
        id: `old-r${i + 2}`,
        entryId,
        table: 'versions' as const,
        record: data.versions[vid],
        createdAt: 1,
        updatedAt: 1,
      })),
    ]
    const pieces = { ...data.pieces }
    delete pieces[actId]
    const versions = { ...data.versions }
    for (const vid of act.versionIds) delete versions[vid]
    return {
      entryId,
      data: {
        ...data,
        pieces,
        versions,
        trashEntries: {
          [entryId]: {
            id: entryId,
            kind: 'piece',
            label: '第3話',
            titleName: '作品',
            origin: { titleId: act.titleId, chapterId: null, index: 2, prevId: null },
            recordIds: records.map((r) => r.id),
            reason: 'deleted',
            deletedAt: Date.now(),
            createdAt: 1,
            updatedAt: 1,
          },
        },
        trashRecords: Object.fromEntries(records.map((r) => [r.id, r])),
      },
    }
  }

  it('幕として戻し、話の幕の並びの元の位置に入る（本編の並びには入れない）', () => {
    const { data: d0, titleId, ids } = setup(['ABCDEF'])
    const { data, acts } = split(d0, ids[0], [2, 4])
    const gone = deletedBy21(data, acts[2])
    expect(adoptedText(gone.data, gone.data.pieces[ids[0]])?.body).toBe('ABCD')
    const back = restoreTrashEntry(gone.data, gone.entryId).data
    expect(back.pieces[acts[2]].kind).toBe('act')
    expect(back.pieces[ids[0]].actIds).toEqual(acts)
    expect(flatten(back, titleId).map((f) => f.pieceId)).toEqual(ids)
    expect(adoptedText(back, back.pieces[ids[0]])?.body).toBe('ABCDEF')
    expect(repairData(back).fixes).toEqual([])
  })

  it('話の幕の並びから外れていたら作られた順の位置に入れ、話を分けていなければ戻せない', () => {
    const { data: d0, ids } = setup(['ABCDEF'])
    const { data, acts } = split(d0, ids[0], [2, 4])
    const gone = deletedBy21(data, acts[1])
    const unlisted: AppData = {
      ...gone.data,
      pieces: { ...gone.data.pieces, [ids[0]]: { ...gone.data.pieces[ids[0]], actIds: [acts[0], acts[2]] } },
    }
    const back = restoreTrashEntry(unlisted, gone.entryId).data
    expect(back.pieces[ids[0]].actIds).toEqual(acts)

    const undone = unseparatePiece(unlisted, ids[0]).data
    expect(errorOf(() => restoreTrashEntry(undone, gone.entryId))).toContain('幕として戻せません')
    const noParent = { ...unlisted, pieces: { ...unlisted.pieces } }
    delete noParent.pieces[ids[0]]
    expect(errorOf(() => restoreTrashEntry(noParent, gone.entryId))).toContain('元の話がないため戻せません')
  })
})

// ---------- 同期のための元の稿の指紋（2.2） ----------

describe('分けた・つないだ稿の元の稿の指紋', () => {
  it('分けた幕の第1稿・さらに分けた稿・つないだ稿は、元の稿と、その本文の指紋を控える（解除した稿は控えない）', () => {
    const { data: d0, ids } = setup(['ABCDEFGHI'])
    const ev = d0.pieces[ids[0]].versionIds[0]
    const { data, acts } = split(d0, ids[0], [3, 6])
    for (const id of acts) {
      const v = data.versions[data.pieces[id].activeVersionId!]
      expect(v.sourceVersionId).toBe(ev)
      expect(v.sourceHash).toBe(textHash('ABCDEFGHI'))
    }
    const a2v = data.pieces[acts[1]].activeVersionId!
    const further = separatePiece(data, acts[1], [1])
    const ds = further.data.versions[further.data.pieces[acts[1]].activeVersionId!]
    expect(ds).toMatchObject({ sourceVersionId: a2v, sourceHash: textHash('DEF'), body: 'D' })
    const c1 = further.data.versions[further.data.pieces[further.result[1]].activeVersionId!]
    expect(c1).toMatchObject({ sourceVersionId: a2v, sourceHash: textHash('DEF'), body: 'EF' })
    const a1v = data.pieces[acts[0]].activeVersionId!
    const joined = joinActWithNext(data, acts[0])
    expect(joined.data.versions[joined.result]).toMatchObject({ sourceVersionId: a1v, sourceHash: textHash('ABC') })
    const un = unseparatePiece(data, ids[0])
    expect(un.data.versions[un.result].sourceHash).toBeUndefined()
  })
})
