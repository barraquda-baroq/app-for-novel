// バックアップからの復元・すべて削除・大きな削除の同期（仮のクラウド。src/test/fakeCloud.ts はエンジンと同じ規則で送受信する）
import { describe, expect, it } from 'vitest'
import * as E from '../domain/entityOps'
import * as S from '../domain/storyOps'
import { emptyData, type AppData, type ID } from '../domain/types'
import { FakeCloud, FakeDevice, sameData, settle } from '../test/fakeCloud'

/** 話が n 話ある作品と、その原稿を記録した応募計画（応募時の原稿の本文が n 件） */
function novelWithSubmission(n: number): { data: AppData; titleId: ID } {
  const t = E.createTitle(emptyData(), '長編')
  let data = t.data
  for (let i = 0; i < n; i++) {
    const e = S.addEpisode(data, t.result)
    const vid = e.data.pieces[e.result].versionIds[0]
    data = S.setActiveVersion(S.updateVersion(e.data, vid, { body: `第${i + 1}話の本文` }), e.result, vid)
  }
  const s = E.addSubmission(data, t.result, '新人賞')
  data = E.recordSubmissionSnapshot(s.data, s.result)
  return { data, titleId: t.result }
}

const liveCloudTexts = (cloud: FakeCloud) =>
  [...cloud.docs.values()].filter((d) => d.table === 'snapshotTexts' && d.record !== null).length

describe('応募時の原稿の本文（snapshotTexts）の削除', () => {
  // 削除は何回かに分けて届く。本文の削除が応募計画の削除より先に届くと、受け取った端末はまだ応募計画が使っているので
  // 消さずに送り直し、消したはずの本文がクラウドとすべての端末に戻っていた
  const cases: [string, (d: AppData, titleId: ID) => AppData | 'all'][] = [
    ['すべて削除', () => 'all'],
    ['タイトルの削除', (d, titleId) => E.deleteTitle(d, titleId)],
  ]
  for (const [name, op] of cases) {
    it(`${name}: 本文は応募計画の後に消すので、ほかの端末が送り直さず、どこにも残らない`, async () => {
      const { data, titleId } = novelWithSubmission(120)
      expect(Object.keys(data.snapshotTexts)).toHaveLength(120)
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      const y = new FakeDevice('Y', cloud)
      await x.edit(() => data)
      await settle(x, y)
      expect(liveCloudTexts(cloud)).toBe(120)
      const next = op(await x.load(), titleId)
      if (next === 'all') await x.restore(emptyData())
      else await x.edit(() => next)
      await settle(x, y)
      expect(await sameData(x, y)).toBe(true)
      expect(liveCloudTexts(cloud)).toBe(0)
      for (const dev of [x, y]) expect(Object.keys((await dev.load()).snapshotTexts)).toEqual([])
    })
  }
})
