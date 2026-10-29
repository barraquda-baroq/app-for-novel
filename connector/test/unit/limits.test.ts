// 300話・約30万字の長編で、どのツールの結果も10万字を超えないこと（続きは cursor で全部読めること）。
import { beforeAll, describe, expect, it } from 'vitest'
import { shortId } from '../../../src/claude/refs'
import { decodeCursor } from '../../../src/claude/view'
import type { VaultCore } from '../../src/vault/core'
import { RESULT_LIMIT } from '../../src/vault/tools/common'
import { addCritiqueResult, addRevisionIdea, addStrategyNote } from '../../../src/domain/claudeOps'
import { addMemo, updateMemo, updateTitle } from '../../../src/domain/entityOps'
import { novel } from '../../../src/test/claudeFixture'
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

describe('長い会話の多い原稿の検索', () => {
  it('一致の行が長くても、どのページにも続きの cursor が残り、全部の一致をたどれる', async () => {
    // 1行が約400字の会話を、1話に60行・5話（一致は300件）
    const line = (e: number, k: number) => `「${'ことば'.repeat(130)}${e}-${k}」`
    const t = novel(Array.from({ length: 5 }, (_, e) => Array.from({ length: 60 }, (_, k) => line(e, k)).join('\n')))
    const fake = new FakeFirebase()
    const made = await pairedCore(fake, t.data, { config: { dailyReadBudget: 1_000_000 } })
    const args = { title_id: t.titleId, mode: 'regex', query: '「[^」]*」', max_hits: 200, context_chars: 80 }
    const count = await made.core.callTool('novel_search_text', { ...args, count_only: true })
    expect(count.text).toContain('300件')
    const save = core
    core = made.core
    try {
      const pages = await all('novel_search_text', args)
      expect(pages.length).toBeGreaterThan(1)
      let hits = 0
      for (const [i, page] of pages.entries()) {
        expect(page).not.toContain('結果が長いため')
        if (i < pages.length - 1) expect(page).toMatch(/\n続き: cursor="[^"]+"/)
        hits += page.split('\n').filter((l) => l.startsWith('#')).length
      }
      expect(hits).toBe(300)
      // 見出しの「x〜y件目」が出した一致と合う
      const m = /: 1〜(\d+)件目/.exec(pages[0])
      expect(Number(m?.[1])).toBe(pages[0].split('\n').filter((l) => l.startsWith('#')).length)
    } finally {
      core = save
    }
  })
})

describe('長い1つのメモ・改稿案・全体戦略・批評の結果', () => {
  /** 段落ごとに番号の入った長い本文 */
  const long = (label: string, chars: number) =>
    Array.from({ length: Math.ceil(chars / 500) }, (_, i) => `${label}${i}段落。${'あ'.repeat(490)}`).join('\n')
  /** ページから本文の部分を取り出す（続きの見出し・続きの行を除く） */
  const bodyOf = (page: string) => {
    let t = page
    if (/^=== .*の続き/.test(t)) t = t.slice(t.indexOf('\n') + 1)
    const c = t.lastIndexOf('\n続き: cursor="')
    return c >= 0 ? t.slice(0, c) : t
  }

  it('char_budget ずつ cursor で最後まで読め、どの文字も1回ずつ（10万字を超えない）', async () => {
    const t = novel(['本文'])
    const memoBody = long('メモ', 90_000)
    const ideaBody = long('改稿', 150_000)
    const overall = long('全体', 45_000)
    const result = long('批評', 70_000)
    const m = addMemo(t.data, t.titleId, 'プロット')
    let data = updateMemo(m.data, m.result, { body: memoBody })
    const idea = addRevisionIdea(data, t.titleId, { heading: '大きな改稿', body: ideaBody })
    data = updateTitle(idea.data, t.titleId, { strategyNote: overall })
    const crit = addCritiqueResult(data, t.titleId, { resultMarkdown: result })
    data = crit.data
    const fake = new FakeFirebase()
    const made = await pairedCore(fake, data, { config: { dailyReadBudget: 1_000_000 } })
    const save = core
    core = made.core
    try {
      const cases: [string, Record<string, unknown>, string][] = [
        ['novel_get_notes', { title_id: t.titleId, kind: 'memos', ids: ['プロット'], char_budget: 60_000 }, memoBody],
        ['novel_get_strategy', { title_id: t.titleId, revision_idea_id: shortId('revisionIdea', idea.result), char_budget: 60_000 }, ideaBody],
        ['novel_get_strategy', { title_id: t.titleId, section: 'overall', char_budget: 20_000 }, overall],
        ['novel_get_critique', { title_id: t.titleId, result_id: shortId('critiqueResult', crit.result), char_budget: 30_000 }, result],
      ]
      for (const [name, args, body] of cases) {
        const pages = await all(name, args)
        expect(pages.length, name).toBeGreaterThan(1)
        const joined = pages.map(bodyOf).join('')
        expect(joined.split(body).length, `${name}: 本文がちょうど1回`).toBe(2)
        for (const p of pages) expect(p.length).toBeLessThanOrEqual(RESULT_LIMIT)
      }
      // 一覧の全体戦略は先頭だけ（全文の読み方を出す）
      const overview = await run('novel_get_strategy', { title_id: t.titleId })
      expect(overview).toContain('section="overall"')
      expect(overview).not.toContain('全体89段落')
    } finally {
      core = save
    }
  })
})

describe('一覧に入りきらない改稿案・戦略メモ・批評の結果', () => {
  it('多くても、すべての id が一覧に出る（後ろは見出しだけ）', async () => {
    const t = novel(['本文'])
    let data = t.data
    const ideas: string[] = []
    const notes: string[] = []
    const results: string[] = []
    for (let i = 0; i < 80; i++) {
      const r = addRevisionIdea(data, t.titleId, { heading: `改稿案${i + 1}`, body: `中身${i + 1}` })
      data = r.data
      ideas.push(r.result)
    }
    for (let i = 0; i < 35; i++) {
      const r = addStrategyNote(data, t.titleId, { heading: `戦略${i + 1}`, body: `本文${i + 1}` })
      data = r.data
      notes.push(r.result)
    }
    for (let i = 0; i < 65; i++) {
      const r = addCritiqueResult(data, t.titleId, { resultMarkdown: `批評${i + 1}` })
      data = r.data
      results.push(r.result)
    }
    const made = await pairedCore(new FakeFirebase(), data, { config: { dailyReadBudget: 1_000_000 } })
    const strategy = (await made.core.callTool('novel_get_strategy', { title_id: t.titleId })).text
    for (const id of ideas) expect(strategy).toContain(shortId('revisionIdea', id))
    for (const id of notes) expect(strategy).toContain(shortId('strategyNote', id))
    expect(strategy).toContain('ほか20件')
    expect(strategy).toContain('ほか5件')
    const critique = (await made.core.callTool('novel_get_critique', { title_id: t.titleId })).text
    for (const id of results) expect(critique).toContain(shortId('critiqueResult', id))
    expect(critique).toContain('ほか5件')
  })
})
