// 幕（2.2）の同期: 2台の端末が同じ話の幕の構成を同時に変えた時に、揃った後の内容が約束（src/test/actsScenarios.ts）を守る。
// 仮のクラウド（src/test/fakeCloud.ts）で、送る順番（先に送った端末）と、オフラインだった端末の組み合わせをすべて試す。
// 決まった場面のほかに、決まった種から作る操作の組み合わせ（幕の操作・稿の編集・採用・話の削除）も試す。
import { describe, expect, it } from 'vitest'
import * as A from '../domain/acts'
import { repairData } from '../domain/repair'
import * as S from '../domain/storyOps'
import { activeBody, isSplit } from '../domain/structure'
import type { AppData, ID } from '../domain/types'
import {
  ACTS_SCENARIOS,
  actsIds,
  lostVersions,
  restoreProblems,
  scenarioProblems,
  scenarioStart,
  seenVersions,
  structureProblems,
  texts,
  type ActsScenario,
  type Order,
} from '../test/actsScenarios'
import { FakeCloud, FakeDevice, sameData, settle } from '../test/fakeCloud'

type Mode = '片方がオフライン' | '両方がオフライン'

async function run(s: ActsScenario, order: Order, mode: Mode): Promise<string[]> {
  const cloud = new FakeCloud()
  const x = new FakeDevice('X', cloud)
  const y = new FakeDevice('Y', cloud)
  const start = scenarioStart(s)
  const ep = start.ep
  await x.edit(() => start.data)
  await settle(x, y)
  x.notes = []
  y.notes = []
  x.messages = []
  y.messages = []
  const [first, second] = order === 'x-first' ? [x, y] : [y, x]
  second.offline()
  if (mode === '両方がオフライン') first.offline()
  await x.edit((d) => s.x(d, ep))
  await y.edit((d) => s.y(d, ep))
  const seen = [...texts(await x.load()), ...texts(await y.load())]
  const seenV = [...seenVersions(await x.load(), start.data), ...seenVersions(await y.load(), start.data)]
  if (mode === '片方がオフライン') {
    await first.sync()
    await second.sync()
  } else {
    // 両方がオフラインの間に書き、ほぼ同時につながった（先に送った方が先にクラウドに入る）
    await first.uploadBatch()
    await second.uploadBatch()
  }
  await settle(x, y)
  const problems: string[] = []
  if (!(await sameData(x, y))) problems.push('I2 両方の端末の内容が違う')
  // I4: 幕の知らせは、話の番号で話を示す（この端末で削除した話も）
  for (const dev of [x, y])
    for (const m of dev.messages) if (!m.includes('第1話')) problems.push(`I4 ${dev.name} の知らせに話の番号が無い: ${m}`)
  problems.push(...scenarioProblems(s, order, await x.load(), ep, seen, seenV, { x: x.notes as never, y: y.notes as never }))
  if (problems.length) problems.push(`---\n${cloud.log.join('\n')}`)
  return problems
}

describe('幕の構成を2台で同時に変えた時の同期', () => {
  for (const s of ACTS_SCENARIOS) {
    for (const order of ['x-first', 'y-first'] as const) {
      for (const mode of ['片方がオフライン', '両方がオフライン'] as const) {
        it(`${s.name}（${order === 'x-first' ? 'X' : 'Y'} が先に送る・${mode}）`, async () => {
          expect(await run(s, order, mode)).toEqual([])
        })
      }
    }
  }
})

// ---------- 決まった種から作る操作の組み合わせ ----------

/** 決まった種の乱数（同じ種なら同じ並び） */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

type RandomOp = { name: string; run: (d: AppData, ep: ID) => AppData }

/** いまの話でできる操作（幕の操作・稿の編集・採用・題・削除） */
function possibleOps(r: () => number, d: AppData, ep: ID): RandomOp[] {
  const e = d.pieces[ep]
  if (!e) return []
  const out: RandomOp[] = []
  if (!isSplit(e)) {
    out.push({ name: '分ける[3]', run: (x) => A.separatePiece(x, ep, [3]).data })
    out.push({ name: '分ける[2,5]', run: (x) => A.separatePiece(x, ep, [2, 5]).data })
    out.push({
      name: '話の採用稿を書き換える',
      run: (x) => S.updateVersion(x, x.pieces[ep].activeVersionId!, { body: 'ABCDEFGHI+x' }),
    })
  } else {
    const acts = actsIds(d, ep)
    const i = Math.floor(r() * acts.length)
    const at = (x: AppData) => actsIds(x, ep)[i]
    const body = d.versions[d.pieces[acts[i]].activeVersionId ?? '']?.body ?? ''
    if (i < acts.length - 1) out.push({ name: `第${i + 1}幕をつなぐ`, run: (x) => A.joinActWithNext(x, at(x)).data })
    if (body.length >= 2) out.push({ name: `第${i + 1}幕をさらに分ける`, run: (x) => A.separatePiece(x, at(x), [1]).data })
    out.push({ name: 'セパレート解除', run: (x) => A.unseparatePiece(x, ep).data })
    out.push({
      name: `第${i + 1}幕を書き換える`,
      run: (x) => S.updateVersion(x, x.pieces[at(x)].activeVersionId!, { body: `${body}+${i}`, note: `メモ${i}` }),
    })
    out.push({ name: `第${i + 1}幕に稿を足す`, run: (x) => S.addVersion(x, at(x), { body: `別稿${i}` }).data })
    // 採用していない稿があれば、削除する・書き換える（削除と書き換えが重なった稿は、幕の属する話も控えてゴミ箱へ）
    const other = (x: AppData) => x.pieces[at(x)].versionIds.find((id) => id !== x.pieces[at(x)].activeVersionId)
    if (other(d)) {
      out.push({ name: `第${i + 1}幕の採用していない稿を削除する`, run: (x) => S.deleteVersion(x, other(x)!) })
      out.push({
        name: `第${i + 1}幕の採用していない稿を書き換える`,
        // 前の本文は残す（片方だけの書き換えで前の本文が消えるのは正しいので、文章の確かめで消えたことにしない）
        run: (x) => S.updateVersion(x, other(x)!, { body: `${x.versions[other(x)!].body}+別稿${i}`, note: `別稿のメモ${i}` }),
      })
    }
    out.push({
      name: `第${i + 1}幕で別の稿を採用する`,
      run: (x) => {
        const added = S.addVersion(x, at(x), { body: `採用${i}` })
        return S.setActiveVersion(added.data, at(x), added.result)
      },
    })
  }
  out.push({ name: '題を変える', run: (x) => S.updatePiece(x, ep, { subtitle: `題${Math.floor(r() * 9)}` }) })
  out.push({ name: '話を削除する', run: (x) => S.deletePiece(x, ep) })
  return out
}

describe('幕の操作の組み合わせ（決まった種）', () => {
  it('どの組み合わせでも、文章が消えず・両方の端末が揃い・幕の形が正しく・ゴミ箱の稿を戻せる', async () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 60; seed++) {
      const r = seeded(seed)
      // 分けていれば、第2幕には採用していない稿もある
      const start = scenarioStart({
        body: 'ABCDEFGHI',
        splitAt: r() < 0.7 ? [3, 6] : null,
        prepare: (d, ep) => (d.pieces[ep].actIds?.length ? S.addVersion(d, actsIds(d, ep)[1], { body: 'DEF別稿' }).data : d),
      })
      const ep = start.ep
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      const y = new FakeDevice('Y', cloud)
      await x.edit(() => start.data)
      await settle(x, y)
      const [first, second] = r() < 0.5 ? [x, y] : [y, x]
      const together = r() < 0.5
      second.offline()
      if (together) first.offline()
      const names: string[] = []
      for (const dev of [x, y]) {
        for (let k = 1 + Math.floor(r() * 2); k > 0; k--) {
          const list = possibleOps(r, await dev.load(), ep)
          if (!list.length) break
          const op = list[Math.floor(r() * list.length)]
          try {
            await dev.edit((d) => op.run(d, ep))
            names.push(`${dev.name}:${op.name}`)
          } catch {
            names.push(`${dev.name}:${op.name}（できない）`)
          }
        }
      }
      const seen = [...texts(await x.load()), ...texts(await y.load())]
      const seenV = [...seenVersions(await x.load(), start.data), ...seenVersions(await y.load(), start.data)]
      if (together) {
        await first.uploadBatch()
        await second.uploadBatch()
      } else {
        await first.sync()
        await second.sync()
      }
      await settle(x, y)
      const d = await x.load()
      const problems: string[] = []
      if (!(await sameData(x, y))) problems.push('I2 両方の端末の内容が違う')
      const pool = [...Object.values(d.versions).flatMap((v) => [v.body, v.note])]
      for (const tr of Object.values(d.trashRecords)) {
        const rec = tr.record as { body?: unknown; note?: unknown }
        for (const t of [rec.body, rec.note]) if (typeof t === 'string') pool.push(t)
      }
      for (const t of new Set(seen)) if (!pool.some((q) => q.includes(t))) problems.push(`I1 文章が消えた: ${t}`)
      problems.push(...lostVersions(seenV, d))
      problems.push(...structureProblems(d).map((m) => `I3 ${m}`))
      const v = repairData(d).data
      const text = v.pieces[ep] ? (activeBody(v, v.pieces[ep]) ?? '') : ''
      for (const ch of 'ABCDEFGHI') if (text.split(ch).length > 2) problems.push(`I3 採用原稿に「${ch}」が2回: ${text}`)
      problems.push(...restoreProblems(d, ep).map((m) => `S9 ${m}`))
      if (problems.length) failures.push(`種 ${seed}（${names.join('、')}）: ${problems.join(' / ')}`)
    }
    expect(failures).toEqual([])
  }, 120_000)
})

describe('初めてのログイン（共通の履歴が無い）と幕', () => {
  // 同じバックアップを2台に入れ、それぞれで幕の構成を変えてから、X が先に、Y が後から初めてログインした
  const variants: [
    string,
    number[] | null,
    ((d: AppData, ep: ID) => AppData) | null,
    ((d: AppData, ep: ID) => AppData) | null,
  ][] = [
    ['両方が分けた', null, (d, ep) => A.separatePiece(d, ep, [3]).data, (d, ep) => A.separatePiece(d, ep, [2, 5]).data],
    ['後からログインした端末だけが分けた', null, null, (d, ep) => A.separatePiece(d, ep, [2, 5]).data],
    ['先にログインした端末だけが分けた', null, (d, ep) => A.separatePiece(d, ep, [3]).data, null],
    ['後からログインした端末がセパレートを解除した', [3, 6], null, (d, ep) => A.unseparatePiece(d, ep).data],
  ]
  for (const [name, splitAt, opX, opY] of variants) {
    it(`${name}: 文章が消えず、両方の端末が揃い、幕の形が正しい`, async () => {
      const start = scenarioStart({ body: 'ABCDEFGHI', splitAt })
      const ep = start.ep
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      const y = new FakeDevice('Y', cloud)
      for (const d of [x, y]) {
        await d.p.replaceAll(start.data)
        await d.p.setMeta('authoritative', null)
        await d.p.markAllDirty()
      }
      if (opX) await x.edit((d) => opX(d, ep))
      if (opY) await y.edit((d) => opY(d, ep))
      const seen = [...texts(await x.load()), ...texts(await y.load())]
      const seenV = [...seenVersions(await x.load(), start.data), ...seenVersions(await y.load(), start.data)]
      await x.sync()
      await y.sync()
      await settle(x, y)
      expect(await sameData(x, y)).toBe(true)
      const d = await x.load()
      const pool = [...Object.values(d.versions).flatMap((v) => [v.body, v.note])]
      for (const tr of Object.values(d.trashRecords)) {
        const rec = tr.record as { body?: unknown; note?: unknown }
        for (const t of [rec.body, rec.note]) if (typeof t === 'string') pool.push(t)
      }
      expect([...new Set(seen)].filter((t) => !pool.some((q) => q.includes(t)))).toEqual([])
      expect(lostVersions(seenV, d)).toEqual([])
      expect([...structureProblems(d), ...restoreProblems(d, ep)]).toEqual([])
      const v = repairData(d).data
      expect(activeBody(v, v.pieces[ep])).toBe('ABCDEFGHI')
    })
  }
})

describe('バックアップからの復元と幕', () => {
  // X がバックアップから戻す間に、Y がオフラインで幕の構成を変えた（Y の幕・稿はクラウドに無いので、X の復元では消えない）
  const variants: [string, number[] | null, (d: AppData, ep: ID) => AppData, number][] = [
    ['第2幕をさらに分けた', [3, 6], (d, ep) => A.separatePiece(d, actsIds(d, ep)[1], [1]).data, 3],
    ['第1幕と第2幕をつないだ', [3, 6], (d, ep) => A.joinActWithNext(d, actsIds(d, ep)[0]).data, 3],
    ['分けた', null, (d, ep) => A.separatePiece(d, ep, [3]).data, 0],
  ]
  for (const [name, splitAt, op, acts] of variants) {
    for (const restoreFirst of [true, false]) {
      it(`${name}端末と、バックアップから戻した端末（${restoreFirst ? '戻した方' : '幕の操作'}が先に送る）`, async () => {
        const start = scenarioStart({ body: 'ABCDEFGHI', splitAt })
        const ep = start.ep
        const cloud = new FakeCloud()
        const x = new FakeDevice('X', cloud)
        const y = new FakeDevice('Y', cloud)
        await x.edit(() => start.data)
        await settle(x, y)
        const backup = await x.load()
        x.notes = []
        y.notes = []
        x.offline()
        y.offline()
        await y.edit((d) => op(d, ep))
        const seen = [...texts(await x.load()), ...texts(await y.load())]
        const seenV = seenVersions(await y.load(), backup)
        if (restoreFirst) {
          await x.restore(backup)
          await x.sync()
          // Y はつながって、先に復元を受け取った（Y の幕・稿はクラウドに無いので、復元の削除には入っていない）
          await y.receive()
          await y.sync()
        } else {
          await y.sync()
          await x.restore(backup)
          await x.sync()
        }
        await settle(x, y)
        expect(await sameData(x, y)).toBe(true)
        const d = await x.load()
        const all = [...Object.values(d.versions).flatMap((v) => [v.body, v.note])]
        for (const tr of Object.values(d.trashRecords)) {
          const rec = tr.record as { body?: unknown; note?: unknown }
          for (const t of [rec.body, rec.note]) if (typeof t === 'string') all.push(t)
        }
        // 戻した端末が先なら、Y の送っていない幕の稿も残る（後なら、復元は Y が送った後の内容も戻す）
        if (restoreFirst) {
          expect([...new Set(seen)].filter((t) => !all.some((q) => q.includes(t)))).toEqual([])
          expect(lostVersions(seenV, d)).toEqual([])
        }
        expect([...structureProblems(d), ...restoreProblems(d, ep)]).toEqual([])
        const v = repairData(d).data
        expect(activeBody(v, v.pieces[ep])).toBe('ABCDEFGHI')
        expect(isSplit(v.pieces[ep]) ? actsIds(d, ep).length : 0).toBe(acts)
        if (restoreFirst)
          expect(y.notes.filter((n) => n.kind === 'acts').map((n) => [n.id, 'detail' in n ? n.detail : ''])).toEqual([
            [ep, 'lost'],
          ])
      })
    }
  }

  // 幕の操作でない、ふつうの稿の追加・複製: 戻した話の稿の一覧に、名前を変えずに載せ直す（幕の知らせは出さない）
  const plain: [string, (d: AppData, ep: ID) => AppData, string][] = [
    ['稿を足した', (d, ep) => S.addVersion(d, ep, { body: 'Yの新しい稿' }).data, 'Yの新しい稿'],
    ['採用稿を複製した', (d, ep) => S.duplicateVersion(d, d.pieces[ep].activeVersionId!).data, 'ABCDEFGHI'],
  ]
  for (const [name, op, body] of plain) {
    it(`分けていない話に${name}端末と、バックアップから戻した端末（戻した方が先に送る）`, async () => {
      const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
      const ep = start.ep
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      const y = new FakeDevice('Y', cloud)
      await x.edit(() => start.data)
      await settle(x, y)
      const backup = await x.load()
      y.offline()
      await y.edit((d) => op(d, ep))
      const before = await y.load()
      const added = before.pieces[ep].versionIds.find((id) => !backup.versions[id])!
      await x.restore(backup)
      await x.sync()
      await y.receive()
      await settle(x, y)
      expect(await sameData(x, y)).toBe(true)
      const d = await y.load()
      expect(y.notes).toEqual([])
      expect(structureProblems(d)).toEqual([])
      expect(d.versions[added]).toMatchObject({ body, name: before.versions[added].name, pieceId: ep })
      expect(d.pieces[ep].versionIds).toContain(added)
      expect(Object.keys(d.trashEntries)).toEqual([])
    })
  }

  // 戻したバックアップにその話が無い（話を作る前・削除した後に取ったバックアップ、すべて削除）: 話は消えるが、
  // Y が送っていない幕・稿（クラウドに無いので、削除は届かない）の文章は、ゴミ箱に残して知らせる
  const unsent: [string, number[] | null, (d: AppData, ep: ID) => AppData, 'acts' | 'trash'][] = [
    ...variants.map(([name, splitAt, op]): [string, number[] | null, (d: AppData, ep: ID) => AppData, 'acts'] => [
      name,
      splitAt,
      (d, ep) => {
        const next = op(d, ep)
        const last = actsIds(next, ep).at(-1)!
        return S.updateVersion(next, next.pieces[last].activeVersionId!, { body: 'Yの追記', note: 'Yのメモ' })
      },
      'acts',
    ]),
    ['話に稿を足した', null, (d, ep) => S.addVersion(d, ep, { body: 'Yだけの新しい稿' }).data, 'trash'],
  ]
  for (const [name, splitAt, op, kind] of unsent) {
    it(`${name}端末と、その話の無いバックアップから戻した端末（戻した方が先に送る）`, async () => {
      const start = scenarioStart({ body: 'ABCDEFGHI', splitAt })
      const ep = start.ep
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      const y = new FakeDevice('Y', cloud)
      await x.edit(() => start.data)
      await settle(x, y)
      const backup = S.deletePiece(await x.load(), ep)
      x.notes = []
      y.notes = []
      y.offline()
      await y.edit((d) => op(d, ep))
      const seen = texts(await y.load())
      const seenV = seenVersions(await y.load(), start.data)
      await x.restore(backup)
      await x.sync()
      await y.receive()
      await y.sync()
      await settle(x, y)
      expect(await sameData(x, y)).toBe(true)
      const d = await x.load()
      expect(d.pieces[ep]).toBeUndefined()
      const all = texts(d)
      expect([...new Set(seen)].filter((t) => !all.some((q) => q.includes(t)))).toEqual([])
      expect(lostVersions(seenV, d)).toEqual([])
      expect([...structureProblems(d), ...restoreProblems(d, ep)]).toEqual([])
      if (kind === 'acts')
        expect(y.notes.filter((n) => n.kind === 'acts').map((n) => [n.id, 'detail' in n ? n.detail : ''])).toEqual([
          [ep, 'deletedThere'],
        ])
      else expect(y.notes.map((n) => n.kind)).toEqual(['trash'])
    })
  }
})

describe('バックアップから戻して消えた話の下の、送っていない稿・幕', () => {
  // X がバックアップを取った後に作った話 E2 は同期済み。Y がオフラインで E2 に稿を足した・E2 を分けて書き換えた後、
  // X がバックアップ（E2 が無い）から戻した。Y の稿・幕はクラウドに無いので、削除は届かない
  for (const variant of ['稿を足した', '分けて第2幕を書き換えた', '稿を足して、復元の後・受け取る前に送った'] as const) {
    it(`${variant}: Y の文章はゴミ箱に残る`, async () => {
      const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      const y = new FakeDevice('Y', cloud)
      await x.edit(() => start.data)
      await settle(x, y)
      const backup = await x.load()
      let e2 = ''
      await x.edit((d) => {
        const r = S.addEpisode(d, d.pieces[start.ep].titleId)
        e2 = r.result
        const vid = r.data.pieces[e2].versionIds[0]
        return S.setActiveVersion(S.updateVersion(r.data, vid, { body: 'E2本文ABCDEF' }), e2, vid)
      })
      await settle(x, y)
      y.offline()
      const want = variant === '分けて第2幕を書き換えた' ? 'DEF+Yだけの追記' : 'Yだけの新しい稿'
      if (variant === '分けて第2幕を書き換えた') {
        await y.edit((d) => A.separatePiece(d, e2, [3]).data)
        await y.edit((d) => S.updateVersion(d, d.pieces[actsIds(d, e2)[1]].activeVersionId!, { body: want }))
      } else await y.edit((d) => S.addVersion(d, e2, { body: want }).data)
      await x.restore(backup)
      await x.sync()
      if (variant === '稿を足して、復元の後・受け取る前に送った') {
        // 稿はクラウドに無かったので書ける（E2 の更新は書けない）
        await y.uploadBatch()
        expect([...cloud.docs.values()].some((doc) => (doc.record as { body?: string } | null)?.body === want)).toBe(true)
      }
      await y.receive()
      await settle(x, y)
      expect(await sameData(x, y)).toBe(true)
      const d = await y.load()
      expect(d.pieces[e2]).toBeUndefined()
      expect(texts(d).some((t) => t.includes(want))).toBe(true)
      expect(y.notes.length).toBeGreaterThan(0)
      expect(structureProblems(d)).toEqual([])
    })
  }
})

describe('バックアップから戻した端末と、その後の幕の操作', () => {
  it('戻した後に分けた話は、送る前に自分の復元の書き込みが届き直しても（購読し直した）、分けたまま送る', async () => {
    const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
    const ep = start.ep
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    await x.edit(() => start.data)
    await settle(x, y)
    const backup = await x.load()
    await x.restore(backup)
    await x.sync()
    await settle(x, y)
    const restoreTs = cloud.ts
    x.notes = []
    await x.edit((d) => A.separatePiece(d, ep, [3]).data)
    await x.edit((d) => S.updateVersion(d, d.pieces[actsIds(d, ep)[1]].activeVersionId!, { body: 'DEFGHI+X' }))
    // 送る前に購読し直した（再読み込み・オフラインから戻った）: 記録した位置と同じ時刻の、自分の復元の書き込みが届き直す
    x.cursor = restoreTs - 1
    await x.receive()
    const raw = await x.load()
    expect(structureProblems(raw)).toEqual([])
    expect(raw.pieces[ep].actIds).toHaveLength(2)
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    const d = await y.load()
    expect(structureProblems(d)).toEqual([])
    const v = repairData(d).data
    expect(isSplit(v.pieces[ep])).toBe(true)
    expect(activeBody(v, v.pieces[ep])).toBe('ABCDEFGHI+X')
    expect(x.notes.filter((n) => n.kind === 'acts')).toEqual([])
  })
})

describe('受け取り済みの復元の書き込みが届き直した時', () => {
  // X の復元を受け取った Y が、送る前に購読し直した（再読み込み・オフラインから戻った）: 記録した位置と同じ時刻の
  // 復元の書き込みが届き直す（印は次に書かれるまで残る）。もう反映したので、その後の Y の変更を戻さない
  async function restoredOnY() {
    const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
    const ep = start.ep
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    await x.edit(() => start.data)
    await settle(x, y)
    await x.restore(await x.load())
    await x.sync()
    await y.receive()
    y.notes = []
    return { ep, cloud, x, y, restoreTs: cloud.ts }
  }

  it('その後に分けて書き換えた話は、分けたまま', async () => {
    const { ep, x, y, restoreTs } = await restoredOnY()
    await y.edit((d) => A.separatePiece(d, ep, [3]).data)
    await y.edit((d) => S.updateVersion(d, d.pieces[actsIds(d, ep)[1]].activeVersionId!, { body: 'DEFGHI+Y' }))
    await y.receive(restoreTs - 1)
    expect(structureProblems(await y.load())).toEqual([])
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    const d = await y.load()
    expect(structureProblems(d)).toEqual([])
    const v = repairData(d).data
    expect(isSplit(v.pieces[ep])).toBe(true)
    expect(activeBody(v, v.pieces[ep])).toBe('ABCDEFGHI+Y')
    expect(Object.keys(d.trashEntries)).toEqual([])
    expect(y.notes).toEqual([])
  })

  it('その後に書き換えた稿は、書き換えたまま（ゴミ箱に移さない）', async () => {
    const { ep, x, y, restoreTs } = await restoredOnY()
    const vid = (await y.load()).pieces[ep].activeVersionId!
    await y.edit((d) => S.updateVersion(d, vid, { body: 'ABCDEFGHI+後で' }))
    await y.receive(restoreTs - 1)
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    const d = await y.load()
    expect(d.versions[vid].body).toBe('ABCDEFGHI+後で')
    expect(Object.keys(d.trashEntries)).toEqual([])
    expect(y.notes).toEqual([])
  })
})

describe('バックアップから戻した直後の操作（1台）', () => {
  // 復元を送り終えてから、受け取り直す（自分の復元の書き込みが届く）までの間に、戻した話を操作した
  const ops: [string, (d: AppData, ep: ID) => AppData][] = [
    ['分けた', (d, ep) => A.separatePiece(d, ep, [3]).data],
    [
      '稿を複製して採用した',
      (d, ep) => {
        const r = S.duplicateVersion(d, d.pieces[ep].activeVersionId!)
        return S.setActiveVersion(r.data, ep, r.result)
      },
    ],
  ]
  for (const [name, op] of ops) {
    it(`${name}: 自分の復元の書き込みが届いても、操作は取り消されず、知らせも出ない`, async () => {
      const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: null })
      const ep = start.ep
      const cloud = new FakeCloud()
      const x = new FakeDevice('X', cloud)
      await x.edit(() => start.data)
      await x.sync()
      const backup = await x.load()
      await x.restore(backup)
      // エンジンと同じ: クラウドを揃えて送り終えるまで受け取らない
      await x.pushAuthoritative()
      for (;;) if ((await x.uploadBatch()).done) break
      await x.edit((d) => op(d, ep))
      const before = await x.load()
      const trash = Object.keys(before.trashEntries).length
      x.notes = []
      await x.receive()
      await x.sync()
      const d = await x.load()
      expect(x.notes).toEqual([])
      expect(structureProblems(d)).toEqual([])
      expect(d.pieces[ep]).toEqual(before.pieces[ep])
      expect(Object.keys(d.versions).sort()).toEqual(Object.keys(before.versions).sort())
      expect(Object.keys(d.trashEntries)).toHaveLength(trash)
      for (const id of actsIds(d, ep)) expect(cloud.docs.get(`pieces:${id}`)?.record).toEqual(d.pieces[id])
      expect(cloud.docs.get(`pieces:${ep}`)?.record).toEqual(d.pieces[ep])
    })
  }
})

describe('分けてから解除した話と、元の稿の書き換え', () => {
  it('解除の後で書き換えられた元の稿と解除した稿をまとめて受け取った端末には、知らせを出さない', async () => {
    const start = scenarioStart({ body: 'ABCDEF', splitAt: null })
    const ep = start.ep
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    const y = new FakeDevice('Y', cloud)
    const z = new FakeDevice('Z', cloud)
    await x.edit(() => start.data)
    await settle(x, y, z)
    const ev = start.data.pieces[ep].activeVersionId!
    z.notes = []
    z.offline()
    // X が分けてから解除し、それを受け取った Y が、採用していない元の稿を書き換えた（解除より後の書き換え）
    await x.edit((d) => A.unseparatePiece(A.separatePiece(d, ep, [3]).data, ep).data)
    await settle(x, y)
    await y.edit((d) => S.updateVersion(d, ev, { body: 'ABCDEF+後で' }))
    await settle(x, y)
    // Z は長くオフラインで、両方をまとめて受け取る
    await settle(x, y, z)
    expect(await sameData(x, z)).toBe(true)
    expect(z.notes.filter((n) => n.kind === 'acts')).toEqual([])
    expect(y.notes.filter((n) => n.kind === 'acts')).toEqual([])
  })
})

describe('1台だけが操作した時（同時の編集が無い）', () => {
  // 幕の操作の後で、元の稿（採用しなくなった稿）を書き換えた。受け取った端末が両方を1回の反映で受け取っても、
  // 幕の知らせ（書き換える前の稿から分けた・つないだ、分ける前の採用稿が書き換えられた）を出さない
  type How = '受け取る端末がオフラインだった' | '新しい端末' | '送る端末がオフラインだった'
  async function receiveBoth(
    splitAt: number[],
    op: (d: AppData, ep: ID) => AppData,
    source: (d: AppData, ep: ID) => ID,
    how: How,
  ): Promise<{ x: FakeDevice; y: FakeDevice; ep: ID }> {
    const start = scenarioStart({ body: 'ABCDEFGHI', splitAt })
    const ep = start.ep
    const cloud = new FakeCloud()
    const x = new FakeDevice('X', cloud)
    let y = new FakeDevice('Y', cloud)
    await x.edit(() => start.data)
    if (how === '新しい端末') await x.sync()
    else await settle(x, y)
    const src = source(await x.load(), ep)
    if (how === '受け取る端末がオフラインだった') y.offline()
    await x.edit((d) => op(d, ep))
    if (how !== '送る端末がオフラインだった') await x.sync()
    await x.edit((d) => S.updateVersion(d, src, { body: `${d.versions[src].body}+後で` }))
    await x.sync()
    if (how === '新しい端末') {
      y = new FakeDevice('Y', cloud)
      y.offline()
    }
    y.notes = []
    await settle(x, y)
    expect(await sameData(x, y)).toBe(true)
    return { x, y, ep }
  }
  const actsNotes = (d: FakeDevice) => d.notes.filter((n) => n.kind === 'acts')
  const firstAct = (d: AppData, ep: ID) => d.pieces[actsIds(d, ep)[0]].activeVersionId!

  for (const how of ['受け取る端末がオフラインだった', '新しい端末', '送る端末がオフラインだった'] as const) {
    it(`第1幕と第2幕をつないでから、第1幕の元の採用稿を書き換えた（${how}）`, async () => {
      const { y } = await receiveBoth([3, 6], (d, ep) => A.joinActWithNext(d, actsIds(d, ep)[0]).data, firstAct, how)
      expect(actsNotes(y)).toEqual([])
    })
  }
  it('第1幕をさらに分けてから、元の採用稿を書き換えた（新しい端末）', async () => {
    const { y } = await receiveBoth([3, 6], (d, ep) => A.separatePiece(d, actsIds(d, ep)[0], [1]).data, firstAct, '新しい端末')
    expect(actsNotes(y)).toEqual([])
  })
  it('セパレートを解除してから、話の分ける前の採用稿を書き換えた（分けた話を受け取っていた端末がオフラインだった）', async () => {
    const { y } = await receiveBoth(
      [3, 6],
      (d, ep) => A.unseparatePiece(d, ep).data,
      (d, ep) => d.pieces[ep].activeVersionId!,
      '受け取る端末がオフラインだった',
    )
    expect(actsNotes(y)).toEqual([])
  })

  for (const how of ['受け取る端末がオフラインだった', '新しい端末', '送る端末がオフラインだった'] as const) {
    it(`決まった種の操作を続けても、受け取った端末に幕の知らせが出ない（${how}）`, async () => {
      const failures: string[] = []
      for (let seed = 1; seed <= 40; seed++) {
        const r = seeded(seed * 7 + 3)
        const start = scenarioStart({
          body: 'ABCDEFGHI',
          splitAt: r() < 0.7 ? [3, 6] : null,
          prepare: (d, ep) => (d.pieces[ep].actIds?.length ? S.addVersion(d, actsIds(d, ep)[1], { body: 'DEF別稿' }).data : d),
        })
        const ep = start.ep
        const cloud = new FakeCloud()
        const x = new FakeDevice('X', cloud)
        let y = new FakeDevice('Y', cloud)
        await x.edit(() => start.data)
        await settle(x, y)
        x.notes = []
        y.notes = []
        if (how === '受け取る端末がオフラインだった') y.offline()
        const names: string[] = []
        for (let k = 0; k < 6; k++) {
          const list = possibleOps(r, await x.load(), ep).filter((o) => o.name !== '話を削除する')
          const op = list[Math.floor(r() * list.length)]
          try {
            await x.edit((d) => op.run(d, ep))
            names.push(op.name)
          } catch {
            continue
          }
          if (how !== '送る端末がオフラインだった') await x.sync()
        }
        if (how === '新しい端末') {
          await x.sync()
          y = new FakeDevice('Z', cloud)
          y.offline()
        }
        await settle(x, y)
        const problems: string[] = []
        if (!(await sameData(x, y))) problems.push('I2 両方の端末の内容が違う')
        for (const d of [x, y]) if (d.notes.length) problems.push(`${d.name} の知らせ ${JSON.stringify(d.notes)}`)
        if (problems.length) failures.push(`種 ${seed}（${names.join('、')}）: ${problems.join(' / ')}`)
      }
      expect(failures).toEqual([])
    }, 120_000)
  }
})
