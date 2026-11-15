// タイトルのコピー（第二稿。src/domain/titleCopy.ts）の同期: 幕に分けた話のあるタイトルを写しても、ほかの端末に同じ内容で届き、
// 幕の知らせ（取り込めなかった・書き換えられる前の稿から分けた）を出さない。写しの幕をほかの端末でつなぐ・解除しても同じ。
// 仮のクラウド（src/test/fakeCloud.ts）で確かめる
import { describe, expect, it } from 'vitest'
import * as A from '../domain/acts'
import * as E from '../domain/entityOps'
import { buildReadThrough, readBlocksText } from '../domain/readthrough'
import { repairData } from '../domain/repair'
import * as S from '../domain/storyOps'
import { activeBody, actsOf, flatten } from '../domain/structure'
import { copyTitle } from '../domain/titleCopy'
import { emptyData, type AppData, type ID } from '../domain/types'
import { structureProblems } from '../test/actsScenarios'
import { FakeCloud, FakeDevice, sameData, settle } from '../test/fakeCloud'

const view = (d: AppData) => repairData(d).data
const readText = (d: AppData, titleId: ID) => readBlocksText(buildReadThrough(view(d), titleId))

/** 第1話（3つの幕。第3幕は第2稿を採用）と第2話のタイトル */
function start(): { data: AppData; titleId: ID } {
  const t = E.createTitle(emptyData(), '灯台')
  let d = t.data
  let r = S.addEpisode(d, t.result)
  d = r.data
  const ep = r.result
  d = S.updateVersion(d, d.pieces[ep].activeVersionId!, { body: 'あいうえおかきくけこさしすせそ' })
  const acts = A.separatePiece(d, ep, [5, 10])
  d = acts.data
  r = S.addVersion(d, acts.result[2], { body: 'さしすせそ。' })
  d = S.setActiveVersion(r.data, acts.result[2], r.result)
  r = S.addEpisode(d, t.result)
  d = S.updateVersion(r.data, r.data.pieces[r.result].activeVersionId!, { body: '二話' })
  return { data: d, titleId: t.result }
}

describe('タイトルのコピーの同期', () => {
  it('写しはほかの端末に同じ内容で届き、幕の知らせを出さない。写しの幕をつなぐ・解除しても知らせは出ない', async () => {
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    const s = start()
    await x.edit(() => s.data)
    await settle(x, y)

    let copyId = ''
    await x.edit((d) => {
      const r = copyTitle(view(d), s.titleId, '灯台（第二稿）')
      copyId = r.result
      return r.data
    })
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    const onY = await y.load()
    expect(onY.titles[copyId].name).toBe('灯台（第二稿）')
    expect(readText(onY, copyId)).toBe(readText(onY, s.titleId))
    expect(structureProblems(view(onY))).toEqual([])
    expect([...x.notes, ...y.notes]).toEqual([])
    expect([...x.messages, ...y.messages]).toEqual([])

    // Y で写しの第1幕と第2幕をつなぐ（X は幕の構成を変えていない）
    const ep = flatten(view(onY), copyId)[0].pieceId
    const acts = actsOf(view(onY), view(onY).pieces[ep]).map((a) => a.id)
    await y.edit((d) => A.joinActWithNext(view(d), acts[0]).data)
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    expect([...x.notes, ...y.notes]).toEqual([])

    // X で写しのセパレートを解除する
    await x.edit((d) => A.unseparatePiece(view(d), ep).data)
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    expect([...x.notes, ...y.notes]).toEqual([])
    expect([...x.messages, ...y.messages]).toEqual([])
    const done = view(await y.load())
    expect(done.pieces[ep].actIds).toEqual([])
    // 元のタイトルの幕はそのまま。写しの話の本文は、元の各幕の採用稿をつないだものと同じ
    const orig = flatten(done, s.titleId)[0].pieceId
    expect(actsOf(done, done.pieces[orig])).toHaveLength(3)
    expect(activeBody(done, done.pieces[ep])).toBe(activeBody(done, done.pieces[orig]))
    expect(activeBody(done, done.pieces[ep])).toBe('あいうえおかきくけこさしすせそ。')
  })
})
