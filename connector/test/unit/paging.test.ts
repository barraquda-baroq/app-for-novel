// 続きの cursor（2.9）: 前の答えの後に、ほかの接続（claude.ai のアカウント）やアプリが中身を変えても、続きは黙って同じ所をもう一度
// 出したり、読んでいない所を飛ばしたりしない（変わったことは答えの先頭で知らせる）。
// - novel_read_text: アプリが話を並べ替えた・特殊ブロックを足した（L2-4。区切りを id で探し直す）
// - novel_list_proofreading: ほかの接続が推敲案を足した・作者がチェックした・フラグを立てた（L2-5。最後に出した案の並びの鍵の次から）
// - novel_get_bench_analysis（作品の分析を全部）・novel_get_material: ほかの接続が分析を足した・ゴミ箱へ移した・「14 検索用タグ」で
//   タグの行が増えた、作者が記録を書き換えた（GAP-1。読んでいた分析・記録を id で探し直す）
import { describe, expect, it } from 'vitest'
import { addMaterial } from '../../../src/domain/materialOps'
import { movePieceStep } from '../../../src/domain/storyOps'
import type { AppData, ProofSuggestion, TableName } from '../../../src/domain/types'
import { decodeCursor, encodeCursor } from '../../../src/claude/view'
import type { Rec } from '../../../src/sync/merge'
import { novel } from '../../../src/test/claudeFixture'
import type { GrantProps, VaultCore } from '../../src/vault/core'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, addConnection, pairedCore } from '../support/harness'

/** 2つの接続で連携した Vault（A = caaa、B = cbbb） */
async function accounts(data: AppData) {
  const fake = new FakeFirebase()
  const made = await pairedCore(fake, data, { cid: 'caaa', config: { dailyReadBudget: 1_000_000 } })
  const b = await addConnection(fake, made.core, made.uid, { cid: 'cbbb', name: '接続2', pairedAt: made.clock.now })
  return { fake, ...made, a: made.grant, b }
}

/** ツールを呼ぶ（失敗なら例外） */
async function tool(core: VaultCore, grant: GrantProps, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await core.callTool(name, args, { grant })
  if (r.isError) throw new Error(`${name}: ${r.text}`)
  return r.text
}

const cursorOf = (text: string) => /続き: cursor="([^"]+)"/.exec(text)?.[1]
const withoutCursor = (text: string) => text.replace(/\n続き: cursor=.*$/, '').trimEnd()

/** アプリで変えたデータを、端末と同じ形でクラウドに送る（変わった記録と、消えた記録の削除の印） */
function pushChanges(fake: FakeFirebase, before: AppData, after: AppData): void {
  for (const table of Object.keys(after) as TableName[]) {
    const was = before[table] as Record<string, Rec>
    const now = after[table] as Record<string, Rec>
    for (const [id, rec] of Object.entries(now)) if (JSON.stringify(was[id]) !== JSON.stringify(rec)) fake.putRecord(OWNER, table, rec)
    for (const id of Object.keys(was)) if (!(id in now)) fake.tombstone(OWNER, table, id)
  }
}

/** 記録の JSON（小さな記録だけ） */
function recordsOf<T>(fake: FakeFirebase, table: string): T[] {
  return fake
    .recordDocs(OWNER)
    .filter((d) => d.name.includes(`/${table}:`) && !d.name.includes('#') && d.fields.json && 'stringValue' in d.fields.json)
    .map((d) => JSON.parse((d.fields.json as { stringValue: string }).stringValue) as T)
}

/** 段落ごとに印（prefix-001…）を付けた本文 */
const marked = (prefix: string, paras: number, len: number) =>
  Array.from({ length: paras }, (_, k) => `${prefix}-${String(k + 1).padStart(3, '0')}。${'あ'.repeat(len)}`).join('\n')

const marksIn = (text: string, re: RegExp) => [...withoutCursor(text).matchAll(re)].map((m) => m[1])

/**
 * V30 の 09 の取り出し方（続きのページは最初の「=== 」の行までを捨て、その次の行からを本文にする。「=== 」の行より前の「（」で始まる
 * 行は知らせ、後ろの「（」で始まる行は本文）で、知らせが本文に入らないこと。本文（知らせより後）を返す
 */
function v30Body(page: string): string[] {
  const lines = withoutCursor(page).split('\n')
  const at = lines.findIndex((l) => l.startsWith('=== '))
  expect(at, page).toBeGreaterThanOrEqual(0)
  for (const l of lines.slice(0, at)) expect(l.startsWith('（'), l).toBe(true)
  const body = lines.slice(at + 1)
  for (const l of body) expect(/^（(分析|記録|前回の続き)/.test(l), l).toBe(false)
  return body
}

/** 同じ印が2回以上出たもの */
const repeated = (marks: readonly string[]) => marks.filter((m, i) => marks.indexOf(m) !== i)

describe('novel_read_text の続き（L2-4）', () => {
  it('U2: B が読む間にアプリが話を並べ替え、A の相対比較の書き込みの取り込みでそれが届いた: 続きの話を飛ばさず、もう一度出る話は知らせる', async () => {
    const n = novel([1, 2, 3].map((e) => marked(`E${e}`, 5, 280)))
    const { core, fake, a, b } = await accounts(n.data)
    const first = await tool(core, b, 'novel_read_text', { title_id: n.titleId, char_budget: 2_000 })
    expect(first).toContain('E1-001')
    expect(first).not.toContain('E2-001')
    // アプリで第1話を第2話の後ろへ動かした。A の書き込みの前の取り込みで、B の次の読み取りより先に写しに入る
    pushChanges(fake, n.data, movePieceStep(n.data, n.ids[0], 1))
    await tool(core, a, 'novel_add_bench_analysis', {
      work: '星を継ぐ',
      new_work: { name: '星を継ぐ', author: '高橋' },
      items: [{ viewpoint: '文体', body_markdown: '## 文体\n短い文。', run_date: '2026-10-30' }],
    })
    const pages = [first]
    for (let cursor = cursorOf(first); cursor; ) {
      const page = await tool(core, b, 'novel_read_text', { title_id: n.titleId, cursor, char_budget: 2_000 })
      pages.push(page)
      cursor = cursorOf(page)
    }
    const marks = pages.flatMap((p) => marksIn(p, /(E\d-\d{3})。/g))
    // 第2話（いまは第1話）を飛ばさない（前は番号で続けたので、第1話をもう一度読み、第2話を飛ばしていた）
    for (const e of ['E1', 'E2', 'E3']) for (let k = 1; k <= 5; k++) expect(marks).toContain(`${e}-00${k}`)
    expect(pages[1].split('\n')[0]).toBe(
      '（話の並びが変わりました。前に読んだ #2 第2話 が前回の続きより後ろへ動いたため、この後にもう一度出ます。前回の続きの #1 第1話から続けます）',
    )
  })
})

describe('novel_list_proofreading の続き（L2-5）', () => {
  /** 第3話・第4話に30段落ずつ（「X3-01は見れる。」…）。推敲案は B が60件（detailed で 40件ずつ） */
  async function proofreading() {
    const para = (e: number, k: number) => `X${e}-${String(k).padStart(2, '0')}は見れる。`
    const body = (e: number, count: number) => Array.from({ length: count }, (_, k) => para(e, k + 1)).join('\n')
    const n = novel([body(1, 10), body(2, 10), body(3, 30), body(4, 30)])
    const acc = await accounts(n.data)
    const items = (e: number, from: number, count: number) =>
      Array.from({ length: count }, (_, k) => ({
        piece: `#${e}`,
        excerpt: `X${e}-${String(from + k).padStart(2, '0')}は見れる`,
        category: 'ra_nuki',
        suggestion: '見られる',
        reason: 'ら抜き',
      }))
    const added = await tool(acc.core, acc.b, 'novel_add_proofreading', {
      title_id: n.titleId,
      run_label: 'ら抜き',
      items: [...items(3, 1, 30), ...items(4, 1, 30)],
    })
    expect(added).toContain('追加 60件')
    acc.clock.now += 20_000
    return { n, ...acc, items }
  }

  const listed = (text: string) => marksIn(text, /「(X\d-\d{2})は見れる」/g)
  const list = (core: VaultCore, grant: GrantProps, titleId: string, cursor?: string) =>
    tool(core, grant, 'novel_list_proofreading', { title_id: titleId, response_format: 'detailed', ...(cursor ? { cursor } : {}) })

  it('ほかの接続が前の方に推敲案を足した: 続きは前の答えの最後の案の次から（重ならない）。増えた数を知らせる', async () => {
    const { n, core, a, b, clock, items } = await proofreading()
    const first = await list(core, b, n.titleId)
    expect(listed(first)).toHaveLength(40)
    // A が第1話に5件（新しい案は一覧の先頭に入る）
    expect(await tool(core, a, 'novel_add_proofreading', { title_id: n.titleId, run_label: 'A', items: items(1, 1, 5) })).toContain('追加 5件')
    clock.now += 20_000
    const second = await list(core, b, n.titleId, cursorOf(first))
    expect(second.split('\n')[0]).toBe(
      '（前の答えの後に推敲案が 5件増えました。新しい案は一覧の前の方に入るため、この続きには出ません（cursor なしで読み直すと出ます））',
    )
    const all = [...listed(first), ...listed(second)]
    expect(listed(second)).toHaveLength(20)
    expect(repeated(all)).toEqual([])
    expect(all).toHaveLength(60)
    expect(cursorOf(second)).toBeUndefined()
    // cursor なしで読み直すと、新しい5件が先頭に出る
    expect(listed(await list(core, b, n.titleId)).slice(0, 5)).toEqual(['X1-01', 'X1-02', 'X1-03', 'X1-04', 'X1-05'])
  })

  it('作者が前の答えに出た案をチェックした（status=open）: 続きを飛ばさない（知らせも出さない）。フラグを立てて前へ動いた案は知らせる', async () => {
    const { n, core, fake, b, clock } = await proofreading()
    const first = await list(core, b, n.titleId)
    const shown = listed(first)
    // アプリで、前の答えに出た5件をチェックした
    const recs = recordsOf<ProofSuggestion>(fake, 'proofSuggestions')
    const byExcerpt = (x: string) => recs.find((s) => s.excerpt === `${x}は見れる`)!
    for (const x of shown.slice(0, 5))
      fake.putRecord(OWNER, 'proofSuggestions', { ...byExcerpt(x), done: true, doneAt: clock.now, updatedAt: clock.now + 1 } as never)
    clock.now += 20_000
    const second = await list(core, b, n.titleId, cursorOf(first))
    expect(listed(second)).toHaveLength(20)
    expect(repeated([...shown, ...listed(second)])).toEqual([])
    expect(second).not.toContain('一覧が変わりました')
    expect(second).not.toContain('増えました')
    // まだ出ていない案に作者がフラグを立てた（一覧の先頭へ動く）: 続きには出ないので知らせる
    const third = await list(core, b, n.titleId)
    const unshown = recs.find((s) => !listed(third).includes(s.excerpt.replace('は見れる', '')) && !shown.slice(0, 5).includes(s.excerpt.replace('は見れる', '')))!
    fake.putRecord(OWNER, 'proofSuggestions', { ...unshown, flagged: true, updatedAt: clock.now + 1 } as never)
    clock.now += 20_000
    const fourth = await list(core, b, n.titleId, cursorOf(third))
    expect(fourth.split('\n')[0]).toMatch(/^（前の答えの後に、推敲案の追加・チェック・フラグなどで一覧が変わりました。/)
    expect(listed(fourth)).not.toContain(unshown.excerpt.replace('は見れる', ''))
  })

  it('2.8 までの cursor（一覧の何件目か）も読める', async () => {
    const { n, core, b } = await proofreading()
    const first = await list(core, b, n.titleId)
    const key = JSON.stringify(['open', '', '', '', '', true])
    const old = encodeCursor({ k: 'proof', t: n.titleId, s: 40, f: key })
    const second = await list(core, b, n.titleId, old)
    expect(repeated([...listed(first), ...listed(second)])).toEqual([])
    expect(listed(second)).toHaveLength(20)
    expect((await core.callTool('novel_list_proofreading', { title_id: n.titleId, cursor: encodeCursor({ k: 'proof', t: n.titleId, f: key }) }, { grant: b })).text).toContain(
      'cursor が読めません',
    )
  })
})

describe('novel_get_bench_analysis（作品の分析を全部）・novel_get_material の続き（GAP-1）', () => {
  /** A が作品を足し、10の観点に80段落ずつの分析（約7,400字ずつ）。B は既定の 60,000字ずつ読む */
  async function bench() {
    const n = novel(['本文。'])
    const acc = await accounts(n.data)
    const vp = (i: number) => `${String(i).padStart(2, '0')} 観点${i}`
    const added = await tool(acc.core, acc.a, 'novel_add_bench_analysis', {
      work: '銀河の果て',
      new_work: { name: '銀河の果て', author: '山田' },
      items: Array.from({ length: 10 }, (_, i) => ({
        viewpoint: vp(i + 1),
        body_markdown: marked(String(i + 1).padStart(2, '0'), 80, 85),
        run_date: '2026-10-30',
      })),
    })
    const cards = [...added.matchAll(/- 追加 (n:\S+)/g)].map((m) => m[1])
    expect(cards).toHaveLength(10)
    const work = /作品 (w:[0-9a-z]+)『銀河の果て』/.exec(added)![1]
    acc.clock.now += 20_000
    return { ...acc, work, cards, vp }
  }

  /** 1から最後まで読む（between: 1ページ目の後に呼ぶ）。ページと、出てきた段落の印 */
  async function readWork(core: VaultCore, b: GrantProps, work: string, between: () => Promise<void>) {
    const first = await tool(core, b, 'novel_get_bench_analysis', { work })
    await between()
    const pages = [first]
    for (let cursor = cursorOf(first); cursor; ) {
      const page = await tool(core, b, 'novel_get_bench_analysis', { cursor })
      pages.push(page)
      cursor = cursorOf(page)
    }
    return { pages, marks: pages.flatMap((p) => marksIn(p, /^(\d{2}-\d{3})。/gm)) }
  }

  const originals = Array.from({ length: 10 }, (_, i) =>
    Array.from({ length: 80 }, (_, k) => `${String(i + 1).padStart(2, '0')}-${String(k + 1).padStart(3, '0')}`),
  ).flat()

  it('ほかの接続が、読んだ所より前の観点に分析を足した: 重ねずに続け、足した分析はまだ読んでいないと知らせる', async () => {
    const { core, a, b, clock, work, vp } = await bench()
    const { pages, marks } = await readWork(core, b, work, async () => {
      await tool(core, a, 'novel_add_bench_analysis', {
        work,
        items: [{ viewpoint: vp(1), body_markdown: marked('N1', 30, 85), run_date: '2026-11-01' }],
      })
      clock.now += 20_000
    })
    expect(pages).toHaveLength(2)
    // 前は、足した分析の分だけ前へずれた位置から読み、約30段落をもう一度出していた
    expect(repeated(marks)).toEqual([])
    expect(marks).toEqual(originals)
    // 知らせは続きの見出しより前（V30 の 09 は、続きの見出しより後を本文にする）
    expect(pages[1].split('\n')[0]).toMatch(
      /^（分析が増えました。前回の続きより前に n:[0-9a-z]{8}「01 観点1」が入りました（まだ読んでいません。analysis_id で読めます）。前回の続きの n:[0-9a-z]{8}「0\d 観点\d」の途中から続けます）$/,
    )
    expect(pages[1].split('\n')[1]).toMatch(/^=== 『銀河の果て』の分析の続き（[\d,]+字目から）===$/)
    expect(v30Body(pages[1])[0]).toMatch(/^\d{2}-\d{3}。/)
    expect(pages[1]).not.toContain('N1-001')
  })

  it('ほかの接続が、読んだ所より前の分析をゴミ箱へ移した: 続きを飛ばさない（並びが変わったことは知らせる）', async () => {
    const { core, a, b, work, cards } = await bench()
    const { pages, marks } = await readWork(core, b, work, async () => {
      expect(await tool(core, a, 'novel_move_cards_to_trash', { cards: [cards[1]] })).toContain('移す 1件')
    })
    // 前は、ゴミ箱へ移した分析の分だけ後ろへずれた位置から読み、約31段落を飛ばしていた
    expect(marks).toEqual(originals)
    expect(pages[1].split('\n')[0]).toMatch(/^（分析が増えた・減った・動いたため、並びが変わりました。前回の続きの n:[0-9a-z]{8}「0\d 観点\d」の途中から続けます。/)
    expect(pages[1].split('\n')[1]).toMatch(/^=== 『銀河の果て』の分析の続き（[\d,]+字目から）===$/)
    v30Body(pages[1])
  })

  it('「14 検索用タグ」の分析が足されて頭にタグの行が増えた（新しい観点は後ろ）: 黙って同じ所から続け、足した分析も読める', async () => {
    const { core, a, b, clock, work } = await bench()
    const genre14 = ['- 判定したジャンル：SF', '- ジャンル／サブジャンル：SF／宇宙'].join('\n')
    const { pages, marks } = await readWork(core, b, work, async () => {
      await tool(core, a, 'novel_add_bench_analysis', {
        work,
        items: [{ viewpoint: '14 検索用タグ', body_markdown: genre14, run_date: '2026-11-01' }],
      })
      clock.now += 20_000
    })
    expect(marks).toEqual(originals)
    // 前の答えの最後の段落の次の段落から（前はタグの行の分だけずれていた）
    const last = withoutCursor(pages[0]).split('\n').at(-1)!
    const next = pages[1].split('\n')[1]
    const [g, p] = /^(\d{2})-(\d{3})/.exec(last)!.slice(1).map(Number)
    expect(next.startsWith(p === 80 ? '--- 観点「' : `${String(g).padStart(2, '0')}-${String(p + 1).padStart(3, '0')}。`)).toBe(true)
    expect(pages[1]).not.toContain('並びが変わりました')
    expect(pages[1]).toContain('--- 観点「14 検索用タグ」（1件）---')
    expect((await tool(core, b, 'novel_get_bench_analysis', { work })).split('\n')[2]).toBe('タグ: SF・宇宙')
  })

  it('読んでいた分析がゴミ箱へ移された: そう言って次の分析から', async () => {
    const { core, a, b, work, cards } = await bench()
    const first = await tool(core, b, 'novel_get_bench_analysis', { work })
    // 1ページ目は 08 の途中まで
    const reading = cards[Number(/^(\d{2})-\d{3}/.exec(withoutCursor(first).split('\n').at(-1)!)![1]) - 1]
    await tool(core, a, 'novel_move_cards_to_trash', { cards: [reading] })
    const second = await tool(core, b, 'novel_get_bench_analysis', { cursor: cursorOf(first) })
    expect(second.split('\n')[0]).toMatch(
      /^（前回の続きの分析が見つからないため（ゴミ箱へ移した・観点を変えたなど）、次の n:[0-9a-z]{8}「\d{2} 観点\d+」から続けます）$/,
    )
    expect(second.split('\n')[1]).toMatch(/^=== 『銀河の果て』の分析の続き（[\d,]+字目から）===$/)
    expect(v30Body(second)[0]).toMatch(/^--- 観点「/)
  })

  it('最後の分析を読んでいる間にゴミ箱へ移された: 知らせと続きの見出しだけで終わる（V30 の 09 で知らせを本文にしない）', async () => {
    const { core, a, b, work, cards } = await bench()
    let page = await tool(core, b, 'novel_get_bench_analysis', { work, char_budget: 2_000 })
    for (let c = cursorOf(page); c && !/^10-\d{3}。/m.test(withoutCursor(page)); c = cursorOf(page))
      page = await tool(core, b, 'novel_get_bench_analysis', { cursor: c, char_budget: 2_000 })
    // いまのページは最後の観点（10）の途中まで
    expect(cursorOf(page)).toBeDefined()
    await tool(core, a, 'novel_move_cards_to_trash', { cards: [cards[9]] })
    const last = await tool(core, b, 'novel_get_bench_analysis', { cursor: cursorOf(page), char_budget: 2_000 })
    expect(last.split('\n')).toEqual([
      '（前回の続きの分析が見つからないため（ゴミ箱へ移した・観点を変えたなど）、ここで終わりです）',
      expect.stringMatching(/^=== 『銀河の果て』の分析の続き（[\d,]+字目から）===$/),
    ])
    expect(v30Body(last)).toEqual([])
  })

  it('1ページ目が観点のまとまりの見出しの行で終わった（何も変わっていない）: 続きは見出しを繰り返さず、位置だけの cursor と同じ所から', async () => {
    const n = novel(['本文。'])
    const { core, a, b, clock } = await accounts(n.data)
    const added = await tool(core, a, 'novel_add_bench_analysis', {
      work: '銀河',
      new_work: { name: '銀河', author: '山田' },
      items: [1, 2, 3].map((i) => ({ viewpoint: `0${i} 観点${i}`, body_markdown: marked(`0${i}`, 20, 60), run_date: '2026-10-30' })),
    })
    const work = /作品 (w:[0-9a-z]+)『銀河』/.exec(added)![1]
    clock.now += 20_000
    let hits = 0
    for (let budget = 2_000; budget <= 3_800; budget += 10) {
      const first = await tool(core, b, 'novel_get_bench_analysis', { work, char_budget: budget })
      if (!/^--- 観点「/.test(withoutCursor(first).split('\n').at(-1)!)) continue
      hits += 1
      const c = decodeCursor(cursorOf(first)!)!
      expect(c.g).toBe(1)
      const second = await tool(core, b, 'novel_get_bench_analysis', { cursor: cursorOf(first), char_budget: budget })
      const lines = second.split('\n')
      expect(lines[0]).toBe(`=== 『銀河』の分析の続き（${(c.o as number).toLocaleString('ja-JP')}字目から）===`)
      expect(lines[1]).toMatch(/^#### 0\d 観点\d（2026-10-30・Claude）/)
      // 位置だけの cursor（2.8 までの形）と同じ続き
      const old = encodeCursor({ k: c.k, t: c.t, which: c.which, id: c.id, o: c.o })
      expect(await tool(core, b, 'novel_get_bench_analysis', { cursor: old, char_budget: budget })).toBe(second)
    }
    expect(hits).toBeGreaterThan(0)
  })

  it('資料の記録: 前の項目に記録が足された・読んでいた記録が書き換えられた。前の版の cursor（位置だけ）も読める', async () => {
    const n = novel(['本文。'])
    const m = addMaterial(n.data, { name: '江戸の暮らし', author: '高橋' })
    const { core, fake, a, b, clock } = await accounts(m.data)
    const add = (section: string, body: string) =>
      tool(core, a, 'novel_add_material_notes', { material: '江戸の暮らし', items: [{ section, body_markdown: body, run_date: '2026-10-30' }] })
    await add('要約', marked('S1', 20, 85))
    await add('創作に役立つ知識', marked('K1', 80, 85))
    clock.now += 20_000
    const read = (args: Record<string, unknown>) => tool(core, b, 'novel_get_material', { char_budget: 2_000, ...args })
    const first = await read({ material: '江戸の暮らし' })
    const second = await read({ cursor: cursorOf(first) })
    // 2ページ目の後に、A が「要約」に記録を足した（前の方）
    await add('要約', marked('S2', 5, 85))
    clock.now += 20_000
    const third = await read({ cursor: cursorOf(second) })
    expect(third.split('\n')[0]).toMatch(/^（記録が増えました。前回の続きより前に k:[0-9a-z]{8}「要約」が入りました（まだ読んでいません。note_id で読めます）。/)
    expect(third.split('\n')[1]).toMatch(/^=== 『江戸の暮らし』の記録の続き（[\d,]+字目から）===$/)
    v30Body(third)
    const marks = [first, second, third].flatMap((p) => marksIn(p, /^([SK]\d-\d{3})。/gm))
    expect(repeated(marks)).toEqual([])
    expect(marks).not.toContain('S2-001')
    // 読んでいた記録を作者がアプリで書き換えた: その記録の始めから読み直す
    const note = recordsOf<{ id: string; section: string; body: string; updatedAt: number }>(fake, 'materialNotes').find(
      (x) => x.section === '創作に役立つ知識',
    )!
    fake.putRecord(OWNER, 'materialNotes', { ...note, body: `${note.body}\n追記。`, updatedAt: note.updatedAt + 1 } as never)
    clock.now += 20_000
    const fourth = await read({ cursor: cursorOf(third) })
    expect(fourth.split('\n')[0]).toBe('（前回の続きの記録の本文が変わっていたため、その記録の始めから読み直しています）')
    expect(fourth.split('\n')[1]).toMatch(/^=== 『江戸の暮らし』の記録の続き（[\d,]+字目から）===$/)
    v30Body(fourth)
    // その項目の最初の記録なので、項目の見出しの行から
    expect(fourth.split('\n').slice(2, 4)).toEqual([
      '--- 項目「創作に役立つ知識」（1件）---',
      expect.stringMatching(/^#### 創作に役立つ知識（2026-10-30・Claude）\[k:[0-9a-z]{8}\]$/),
    ])
    // 前の版の cursor（位置 o だけ）は、今までどおり位置から
    const old = encodeCursor({ k: 'material', t: m.result, which: 'material', id: m.result, o: 0 })
    expect((await read({ cursor: old })).split('\n')[0]).toMatch(/^=== 資料 d:[0-9a-z]{8}『江戸の暮らし』（高橋） ===$/)
  })
})
