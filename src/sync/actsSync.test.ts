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
  restoreProblems,
  scenarioProblems,
  scenarioStart,
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
  const [first, second] = order === 'x-first' ? [x, y] : [y, x]
  second.offline()
  if (mode === '両方がオフライン') first.offline()
  await x.edit((d) => s.x(d, ep))
  await y.edit((d) => s.y(d, ep))
  const seen = [...texts(await x.load()), ...texts(await y.load())]
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
  problems.push(...scenarioProblems(s, order, await x.load(), ep, seen, { x: x.notes as never, y: y.notes as never }))
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
      const start = scenarioStart({ body: 'ABCDEFGHI', splitAt: r() < 0.7 ? [3, 6] : null })
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
        if (restoreFirst) expect([...new Set(seen)].filter((t) => !all.some((q) => q.includes(t)))).toEqual([])
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
})
