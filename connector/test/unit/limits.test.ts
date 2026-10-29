// 300話・約30万字の長編で、どのツールの結果も10万字を超えないこと（続きは cursor で全部読めること）。
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeCursor } from '../../../src/claude/view'
import type { VaultCore } from '../../src/vault/core'
import { RESULT_LIMIT } from '../../src/vault/tools/common'
import { novel300, type Novel300 } from '../fixtures/novel300'
import { FakeFirebase } from '../support/fakeFirebase'
import { pairedCore } from '../support/harness'

let core: VaultCore
let n: Novel300
const sizes: Record<string, number> = {}

async function run(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await core.callTool(name, args)
  if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 300)}`)
  expect(r.text.length, name).toBeLessThanOrEqual(RESULT_LIMIT)
  sizes[name] = Math.max(sizes[name] ?? 0, r.text.length)
  return r.text
}

/** 続き: cursor="…" をたどって全部読む */
async function all(name: string, args: Record<string, unknown>, max = 200): Promise<string[]> {
  const pages: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < max; i++) {
    const text = await run(name, { ...args, ...(cursor ? { cursor } : {}) })
    pages.push(text)
    const m = /続き: cursor="([^"]+)"/.exec(text)
    if (!m) return pages
    expect(decodeCursor(m[1]), 'cursor が読める').not.toBeNull()
    cursor = m[1]
  }
  throw new Error(`${name}: 終わりません`)
}

beforeAll(async () => {
  n = novel300()
  const fake = new FakeFirebase()
  const made = await pairedCore(fake, n.data, { config: { dailyReadBudget: 1_000_000 } })
  core = made.core
}, 120_000)

describe('300話の長編で、結果は10万字まで', () => {
  it('目次（すべての話が並ぶ）', async () => {
    const pages = await all('novel_get_outline', { title_id: n.titleId })
    const text = pages.join('\n')
    expect(text).toContain('#301 第300話')
    expect(text).toContain('#12.3 第3幕')
    await all('novel_get_outline', { title_id: n.titleId, response_format: 'detailed' })
  })

  it('採用原稿を最後まで読める（6万字ずつ・すべての話の固有の文が入る）', async () => {
    const pages = await all('novel_read_text', { title_id: n.titleId, char_budget: 60_000 })
    expect(pages.length).toBeGreaterThan(4)
    const text = pages.join('\n')
    for (let i = 0; i < 300; i++) expect(text, `第${i + 1}話`).toContain(`番号${i}号`)
    const strip = await all('novel_read_text', { title_id: n.titleId, ruby: 'strip', char_budget: 20_000 })
    expect(strip.join('\n')).not.toContain('《')
  })

  it('検索（件数・一致・続き）', async () => {
    await run('novel_search_text', { title_id: n.titleId, query: '雨の音', count_only: true })
    const pages = await all('novel_search_text', { title_id: n.titleId, query: '駅まで', max_hits: 200, context_chars: 80 }, 400)
    expect(pages.length).toBeGreaterThan(1)
    await run('novel_search_text', { title_id: n.titleId, query: '見れる', scope: 'all_versions' })
    await run('novel_search_text', { title_id: n.titleId, query: '(雨|駅)の', mode: 'regex' })
  })

  it('稿・設定・メモ・アイデア', async () => {
    await run('novel_list_versions', { title_id: n.titleId, piece: '#12' })
    for (const kind of ['settings', 'memos', 'ideas']) {
      await run('novel_get_notes', { title_id: n.titleId, kind })
      const pages = await all('novel_get_notes', { title_id: n.titleId, kind, full: true, char_budget: 60_000 })
      expect(pages.length).toBeGreaterThan(0)
    }
  })

  it('戦略・作品批評・推敲案', async () => {
    const strategy = await run('novel_get_strategy', { title_id: n.titleId })
    expect(strategy).toContain('応募計画（5件）')
    const note = /g:[0-9a-z]{8}/.exec(strategy)![0]
    await run('novel_get_strategy', { title_id: n.titleId, note_id: note })
    const critique = await run('novel_get_critique', { title_id: n.titleId })
    const result = /a:[0-9a-z]{8}/.exec(critique)![0]
    await run('novel_get_critique', { title_id: n.titleId, result_id: result })
    const open = await all('novel_list_proofreading', { title_id: n.titleId, status: 'all' })
    expect(open[0]).toContain('確認の範囲')
    expect(open.join('\n').match(/^x:/gm)?.length).toBeGreaterThan(400)
    await all('novel_list_proofreading', { title_id: n.titleId, response_format: 'detailed' })
  })

  it('状態・タイトル一覧', async () => {
    await run('novel_status', {})
    await run('novel_list_titles', {})
    // 記録: 一番大きな結果の文字数（目安）
    expect(Math.max(...Object.values(sizes))).toBeLessThanOrEqual(RESULT_LIMIT)
  })
})
