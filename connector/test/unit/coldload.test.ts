// Durable Object を作り直した後の最初の呼び出し（写しを SQLite から作り直す）で、稿・応募時の原稿の控え・ゴミ箱の中身の本文を
// 読まず、取り込んだ時に確かめた行の指紋を数え直さないこと。結果は作り直す前と同じ。
import { describe, expect, it } from 'vitest'
import { deleteMemo, memosOf, recordSubmissionSnapshot, submissionsOf } from '../../../src/domain/entityOps'
import { addVersion } from '../../../src/domain/storyOps'
import { isSplit } from '../../../src/domain/structure'
import type { AppData } from '../../../src/domain/types'
import { novel300 } from '../fixtures/novel300'
import { FakeFirebase } from '../support/fakeFirebase'
import { call, makeCore, pairedCore } from '../support/harness'

/** 300話に、採用していない稿（50話に2稿ずつ）・応募時の原稿の控え・ゴミ箱の中身を足す */
function bigAccount(): { data: AppData; titleId: string; acts: number } {
  const n = novel300()
  let data = n.data
  for (const id of n.ids.slice(20, 70)) {
    if (isSplit(data.pieces[id])) continue
    for (let k = 0; k < 2; k++) data = addVersion(data, id, { body: `前の稿${k}。${'い'.repeat(3_000)}` }).data
  }
  data = recordSubmissionSnapshot(data, submissionsOf(data, n.titleId)[0].id)
  for (const m of memosOf(data, n.titleId).slice(0, 3)) data = deleteMemo(data, m.id)
  const acts = Object.values(data.pieces).filter((p) => p.kind === 'act').length
  return { data, titleId: n.titleId, acts }
}

describe('Durable Object を作り直した後の写し', () => {
  it('本文を読まずに写しを作り、同じ結果を返す（本文は使う時に読む）', async () => {
    const { data, titleId, acts } = bigAccount()
    expect(Object.keys(data.snapshotTexts).length).toBeGreaterThan(0)
    expect(Object.keys(data.trashRecords).length).toBeGreaterThan(0)
    const fake = new FakeFirebase()
    const warm = await pairedCore(fake, data, { config: { dailyReadBudget: 1_000_000 } })
    const titles = await call(warm.core, 'novel_list_titles')
    const outline = await call(warm.core, 'novel_get_outline', { title_id: titleId })

    // 同じ SQLite で作り直す（Durable Object が追い出された後の最初の呼び出し）
    const cold = makeCore(fake, { sql: warm.sql, clock: warm.clock, config: { dailyReadBudget: 1_000_000 } })
    const started = performance.now()
    const titles2 = await call(cold.core, 'novel_list_titles')
    const outline2 = await call(cold.core, 'novel_get_outline', { title_id: titleId })
    const ms = performance.now() - started
    expect(titles2).toBe(titles)
    expect(outline2).toBe(outline)
    const stats = { ...cold.core.mirror.stats }
    // 取り込んだ時に確かめた行は、指紋を数え直さない
    expect(stats.verified).toBe(0)
    // 稿・控え・ゴミ箱の中身は本文を読まずに作る
    const liteRows = Object.keys(data.versions).length + Object.keys(data.snapshotTexts).length + Object.keys(data.trashRecords).length
    expect(stats.lite).toBeGreaterThanOrEqual(liteRows)
    // 読んだ本文は、幕に分けた話の幕の採用稿だけ（つないだ本文の文字数を数えるため）
    expect(stats.bodies).toBeLessThanOrEqual(acts)
    // ゆるい上限（遅い環境でも落ちない程度）
    expect(ms).toBeLessThan(5_000)

    // 本文は使う時に読む（読んだ内容は取り込んだものと同じ）
    const text = await call(cold.core, 'novel_read_text', { title_id: titleId, pieces: ['#2', '#30'] })
    expect(text).toContain('番号0号')
    expect(cold.core.mirror.stats.bodies).toBeGreaterThan(stats.bodies)
    const args = { title_id: titleId, query: '前の稿1', scope: 'all_versions', from: '#20', to: '#40' }
    const search = await call(cold.core, 'novel_search_text', args)
    expect(search).toBe(await call(warm.core, 'novel_search_text', args))
    expect(search).toContain('【前の稿1】')
  })

  it('前の版で作った写し（確かめた印の無い行）は、1回だけ確かめ直して印を付ける', async () => {
    const { data, titleId } = bigAccount()
    const fake = new FakeFirebase()
    const warm = await pairedCore(fake, data, { config: { dailyReadBudget: 1_000_000 } })
    const outline = await call(warm.core, 'novel_get_outline', { title_id: titleId })
    warm.sql.run('UPDATE rec SET ok = 0')
    warm.sql.run('DELETE FROM lite')
    const first = makeCore(fake, { sql: warm.sql, clock: warm.clock, config: { dailyReadBudget: 1_000_000 } })
    expect(await call(first.core, 'novel_get_outline', { title_id: titleId })).toBe(outline)
    expect(first.core.mirror.stats.verified).toBeGreaterThan(0)
    const second = makeCore(fake, { sql: warm.sql, clock: warm.clock, config: { dailyReadBudget: 1_000_000 } })
    expect(await call(second.core, 'novel_get_outline', { title_id: titleId })).toBe(outline)
    expect(second.core.mirror.stats.verified).toBe(0)
  })
})
