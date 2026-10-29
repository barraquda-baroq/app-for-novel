// バックアップからの復元・すべて削除・大きな削除の同期（仮のクラウド。src/test/fakeCloud.ts はエンジンと同じ規則で送受信する）
import { describe, expect, it } from 'vitest'
import * as E from '../domain/entityOps'
import * as S from '../domain/storyOps'
import { emptyData, type AppData, type ID } from '../domain/types'
import { scenarioStart, texts } from '../test/actsScenarios'
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

describe('バックアップからの復元を途中で止めて、後で続けた時', () => {
  // 復元はクラウドを何回かに分けて書く（この端末に無いレコードを消す・この端末の内容で上書きする）。その途中でアプリを閉じ
  // （iPhone で裏に回って止まった・ウィンドウを閉じた・再読み込み）、後で開いて続けても、復元を始めた後にほかの端末が
  // 書いた・控えた文章は消さず、上書きしない（復元は始めた時のクラウドの内容にだけ当てる。時刻はサーバーの時刻）

  it('消す途中で止まった: 続きで消すのは復元を始めた時にあったものだけ（ほかの端末がその後に控えた・書いた稿は残る）', async () => {
    const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    await x.edit(() => start.data)
    await settle(x, y)
    const backup = await x.load()
    // X が受け取っていない間に、Y が話 E2 を足して送り、その稿を書き換えた（まだ送っていない）
    let e2 = ''
    let v2 = ''
    await y.edit((d) => {
      const r = S.addEpisode(d, d.pieces[start.ep].titleId)
      e2 = r.result
      v2 = r.data.pieces[e2].versionIds[0]
      return S.setActiveVersion(S.updateVersion(r.data, v2, { body: 'E2本文' }), e2, v2)
    })
    await y.sync()
    await y.edit((d) => S.updateVersion(d, v2, { body: 'E2本文+Yの未送信の追記' }))
    // X が E2 の無いバックアップから戻した。消す1回目（E2 の稿）を書いたところで、アプリが止まった
    await x.restore(backup)
    await x.pushAuthoritative({ batch: 1, stopAfter: 1 })
    expect(cloud.docs.get(`versions:${v2}`)?.record ?? null).toBeNull()
    // Y は復元の削除を受け取り、送っていない追記をゴミ箱に控えて送った。戻した話にも稿を足して送った
    await y.receive()
    expect(y.notes.map((n) => n.kind)).toContain('trash')
    await y.edit((d) => S.addVersion(d, start.ep, { body: 'Yが復元の後に書いた稿' }).data)
    await y.sync()
    // 後で X を開いた（復元の続きから）
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    for (const dev of [x, y]) {
      const d = await dev.load()
      const all = texts(d)
      expect(all.some((t) => t.includes('E2本文+Yの未送信の追記'))).toBe(true)
      expect(all).toContain('Yが復元の後に書いた稿')
      // 復元は当たっている（E2 は消え、戻した話は残る）
      expect(d.pieces[e2]).toBeUndefined()
      expect(d.versions[backup.pieces[start.ep].activeVersionId!].body).toBe('ABCDEFGHI')
    }
  })

  it('上書きの途中で止まった: 続きで、ほかの端末がその後に書き換えた稿を戻した内容で上書きしない', async () => {
    const { data } = novelWithSubmission(150)
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    await x.edit(() => data)
    await settle(x, y)
    const backup = await x.load()
    await x.restore(backup)
    await x.pushAuthoritative()
    // 上書きの1回目（100件）を書いたところで、アプリを閉じた
    await x.uploadBatch()
    const queued = new Set((await x.p.readOutbox(1000)).map((it) => it.k))
    const vid = Object.keys(backup.versions).find((id) => queued.has(`versions/${id}`))
    expect(vid).toBeDefined()
    // Y はその1回目を受け取ってから、まだ上書きされていない稿を書き換えて送った
    await y.receive()
    await y.edit((d) => S.updateVersion(d, vid!, { body: 'Yの編集' }))
    await y.sync()
    // 後で X を開いた
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    for (const dev of [x, y]) expect((await dev.load()).versions[vid!].body).toBe('Yの編集')
    expect(await x.p.outboxCount()).toBe(0)
  })

  it('止めずに最後まで送った復元は、今までどおり、始める前のクラウドの変更より戻した内容を採る', async () => {
    const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    await x.edit(() => start.data)
    await settle(x, y)
    const backup = await x.load()
    const vid = backup.pieces[start.ep].activeVersionId!
    // X が受け取っていない間に、Y が書き換えて送った（X が戻す前）
    await y.edit((d) => S.updateVersion(d, vid, { body: '戻す前のYの編集' }))
    await y.sync()
    await x.restore(backup)
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    expect((await y.load()).versions[vid].body).toBe('ABCDEFGHI')
  })
})
