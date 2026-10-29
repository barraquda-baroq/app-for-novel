// 送った書き込みがクラウドに届いたのに、返事を受け取れなかった（つながりが切れた・アプリを閉じた）後の同期
// （仮のクラウド。src/test/fakeCloud.ts はエンジンと同じ規則で送受信する）。
// その後オフラインのまま、その書き込みで作ったもの（幕・稿）を消したら、消したことがクラウドに届き、
// クラウドに残った版がこの端末の書き込みの通知として戻ってきて生き返らない
import { describe, expect, it } from 'vitest'
import * as A from '../domain/acts'
import { repairData } from '../domain/repair'
import * as S from '../domain/storyOps'
import { activeBody } from '../domain/structure'
import type { AppData, ID } from '../domain/types'
import { scenarioStart, structureProblems } from '../test/actsScenarios'
import { FakeCloud, FakeDevice, sameData, settle } from '../test/fakeCloud'

type Order = '消したことを先に送る' | '自分の書き込みの通知が先に届く'
const orders: Order[] = ['消したことを先に送る', '自分の書き込みの通知が先に届く']

/** 話を指している、クラウドの生きている幕 */
const liveCloudActs = (cloud: FakeCloud, ep: ID) =>
  [...cloud.docs.values()].filter(
    (d) => d.table === 'pieces' && d.record !== null && (d.record as { parentId?: string }).parentId === ep,
  )

async function start(splitAt: number[] | null) {
  const cloud = new FakeCloud()
  const x = new FakeDevice('X', cloud)
  const y = new FakeDevice('Y', cloud)
  const s = scenarioStart({ body: 'ABCDEFGHI', splitAt })
  await x.edit(() => s.data)
  await settle(x, y)
  x.notes = []
  y.notes = []
  return { cloud, x, y, ep: s.ep }
}

/** X の書き込みの返事が届かず、X はオフラインのまま op で元に戻した・消した。その後つながった */
async function lostThenUndo(
  x: FakeDevice,
  y: FakeDevice,
  op: (d: AppData) => AppData,
  undo: (d: AppData) => AppData,
  order: Order,
) {
  await x.edit(op)
  await x.uploadBatch({ replyLost: true })
  // Y は受け取った
  await y.sync()
  x.offline()
  await x.edit(undo)
  if (order === '消したことを先に送る') await x.uploadBatch()
  else await x.receive()
  await settle(x, y)
}

describe('返事を受け取れなかった書き込みの後で、オフラインのまま消した', () => {
  for (const order of orders) {
    it(`分けた後にセパレートを解除した: 幕はクラウドに残らず、後で分け直しても本文が重ならない（${order}）`, async () => {
      const { cloud, x, y, ep } = await start(null)
      await lostThenUndo(
        x,
        y,
        (d) => A.separatePiece(d, ep, [3, 6]).data,
        (d) => A.unseparatePiece(d, ep).data,
        order,
      )
      expect(await sameData(x, y)).toBe(true)
      expect(liveCloudActs(cloud, ep)).toEqual([])
      // 後で分け直した
      await x.edit((d) => A.separatePiece(d, ep, [4]).data)
      await settle(x, y)
      expect(await sameData(x, y)).toBe(true)
      expect(liveCloudActs(cloud, ep)).toHaveLength(2)
      for (const dev of [x, y]) {
        const d = await dev.load()
        expect(structureProblems(d)).toEqual([])
        const v = repairData(d).data
        expect(v.pieces[ep].actIds).toHaveLength(2)
        expect(activeBody(v, v.pieces[ep])).toBe('ABCDEFGHI')
      }
      expect(y.notes).toEqual([])
    })

    it(`つないだ後にセパレートを解除した: 何も変えていない端末に競合の知らせ・稿の写しを作らない（${order}）`, async () => {
      const { cloud, x, y, ep } = await start([3, 6])
      await lostThenUndo(
        x,
        y,
        (d) => A.joinActWithNext(d, d.pieces[ep].actIds![1]).data,
        (d) => A.unseparatePiece(d, ep).data,
        order,
      )
      expect(await sameData(x, y)).toBe(true)
      expect(y.notes).toEqual([])
      expect(liveCloudActs(cloud, ep)).toEqual([])
      const d = await y.load()
      expect(structureProblems(d)).toEqual([])
      const v = repairData(d).data
      expect(activeBody(v, v.pieces[ep])).toBe('ABCDEFGHI')
      expect(Object.values(d.versions).filter((ver) => ver.name.includes('競合'))).toEqual([])
    })

    it(`稿を足した後に消した: 消した稿はどの端末でも生き返らない（ゴミ箱に残る）（${order}）`, async () => {
      const { cloud, x, y, ep } = await start(null)
      let vid = ''
      await lostThenUndo(
        x,
        y,
        (d) => {
          const r = S.addVersion(d, ep, { body: '新しい稿の本文' })
          vid = r.result
          return r.data
        },
        (d) => S.deleteVersion(d, vid),
        order,
      )
      expect(await sameData(x, y)).toBe(true)
      expect(cloud.docs.get(`versions:${vid}`)?.record ?? null).toBeNull()
      for (const dev of [x, y]) {
        const d = await dev.load()
        expect(d.versions[vid]).toBeUndefined()
        expect(d.pieces[ep].versionIds).not.toContain(vid)
        expect(Object.values(d.trashRecords).some((r) => (r.record as { id?: string }).id === vid)).toBe(true)
      }
    })
  }

  it('返事の無かった送信待ちは、クラウドを確かめて、クラウドにも無ければ書かずに終える', async () => {
    const { cloud, x, y, ep } = await start(null)
    let vid = ''
    await x.edit((d) => {
      const r = S.addVersion(d, ep, { body: '届かなかった稿' })
      vid = r.result
      return r.data
    })
    // 書き込みが届く前に切れた（クラウドには何も無い）: 印を付けたまま、送ったことにならない
    const items = await x.p.readOutbox(100)
    await x.p.markUnconfirmed(items.map((it) => it.k))
    await x.edit((d) => S.deleteVersion(d, vid))
    await settle(x, y)
    // 削除の印も書かない（クラウドに無かったので）
    expect(cloud.docs.has(`versions:${vid}`)).toBe(false)
    expect(await x.p.outboxCount()).toBe(0)
  })
})
