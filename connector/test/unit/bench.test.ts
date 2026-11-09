// 相対比較（2.5。内部名は bench）のツール: 一覧・分析を読む・分析を追加、作品批評の相対比較する作品・比べた作品（bench_works）。
// 相対比較の作品はタイトルの「Claude に見せる」と関係なく見せ、書き込みは「書き込みを許可」の時だけ。
import { describe, expect, it } from 'vitest'
import {
  addBenchAnalysis,
  addBenchWork,
  addTitleBenchWork,
  deleteBenchWork,
  setBenchWorkTags,
} from '../../../src/domain/benchOps'
import { applyAutoGenreTags } from '../../../src/domain/benchTags'
import { addClaudeRecords, setTitleClaudeAccess } from '../../../src/domain/claudeOps'
import { buildCritiqueResult } from '../../../src/claude/records'
import { createTitle } from '../../../src/domain/entityOps'
import { shortId } from '../../../src/claude/refs'
import { benchWorkId } from '../../../src/claude/derivedId'
import type { AppData, ID } from '../../../src/domain/types'
import { encodeCursor } from '../../../src/claude/view'
import { benchWorkLine } from '../../../src/claude/bench'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { novel } from '../../../src/test/claudeFixture'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, call, pairedCore } from '../support/harness'

/** 棚に2作品（1つは分析つき）と、比べる作品にしたタイトル・見せないタイトル */
function shelf() {
  const n = novel(['冒頭の本文。'], { name: '星の庭' })
  let data: AppData = n.data
  const a = addBenchWork(data, { name: '銀河の果て', author: '山田', year: '2019', pdfPlace: 'プロジェクト「相対比較」' })
  data = a.data
  const b = addBenchWork(data, { name: '海の記憶', author: '佐藤' })
  data = b.data
  const at = (viewpoint: string, body: string, runDate: string, createdAt: number) => {
    const r = addBenchAnalysis(data, a.result, { viewpoint, body, runDate })
    data = { ...r.data, benchAnalyses: { ...r.data.benchAnalyses, [r.result]: { ...r.data.benchAnalyses[r.result], createdAt } } }
    return r.result
  }
  const first = at('構成', '## 構成\n三幕で、第一幕の終わりに転機。', '2026-10-01', 1)
  at('文体', '## 文体\n短い文を重ねる。', '2026-10-02', 2)
  at('構成', '## 構成（読み直し）\n伏線の回収が早い。', '2026-10-20', 3)
  data = addTitleBenchWork(data, n.titleId, a.result)
  const hidden = createTitle(data, '内緒の話')
  data = setTitleClaudeAccess(addTitleBenchWork(hidden.data, hidden.result, b.result), hidden.result, 'none')
  return { data, titleId: n.titleId, hiddenId: hidden.result, workA: a.result, workB: b.result, firstAnalysis: first }
}

describe('読む（novel_list_bench_works・novel_get_bench_analysis）', () => {
  it('一覧: 作品・著者・観点ごとの数と最新の日付・比べるタイトル（見せないタイトルは出さない）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const text = await call(core, 'novel_list_bench_works')
    expect(text).toContain('=== 相対比較（2作品。作者が比べるために読む既存の作品）===')
    expect(text).toContain(`${shortId('benchWork', s.workA)}『銀河の果て』（山田） 山田・2019`)
    expect(text).toContain('分析 3件')
    expect(text).toContain('構成 2件（最新 2026-10-20）・文体 1件（最新 2026-10-02）')
    expect(text).toContain('PDF の置き場所: プロジェクト「相対比較」')
    expect(text).toContain(`比べるタイトル: 『星の庭』[${shortId('title', s.titleId)}]`)
    expect(text).toContain(`${shortId('benchWork', s.workB)}『海の記憶』（佐藤）`)
    expect(text).not.toContain('内緒の話')
  })

  it('タイトルをすべて見せなくても、相対比較の作品は読める', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const data = setTitleClaudeAccess(s.data, s.titleId, 'none')
    const { core } = await pairedCore(fake, data)
    expect(await call(core, 'novel_list_titles')).toContain('（ありません')
    expect(await call(core, 'novel_list_bench_works')).toContain('『銀河の果て』')
  })

  it('分析: 作品名・短い id で指し、観点ごとに新しい日付から。観点で絞る・1つだけ読む・知らない作品は候補', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const all = await call(core, 'novel_get_bench_analysis', { work: '銀河の果て' })
    expect(all).toContain('--- 観点「構成」（2件）---')
    expect(all.indexOf('伏線の回収が早い')).toBeLessThan(all.indexOf('第一幕の終わりに転機'))
    expect(all.indexOf('--- 観点「構成」')).toBeLessThan(all.indexOf('--- 観点「文体」'))
    const only = await call(core, 'novel_get_bench_analysis', { work: shortId('benchWork', s.workA), viewpoints: ['文体'] })
    expect(only).toContain('短い文を重ねる')
    expect(only).not.toContain('三幕')
    const one = await call(core, 'novel_get_bench_analysis', {
      work: s.workA,
      analysis_id: shortId('benchAnalysis', s.firstAnalysis),
    })
    expect(one).toContain('第一幕の終わりに転機')
    expect(one).not.toContain('伏線')
    const none = await core.callTool('novel_get_bench_analysis', { work: '無い作品' })
    expect(none.isError).toBe(true)
    expect(none.text).toContain('『銀河の果て』')
    const noViewpoint = await core.callTool('novel_get_bench_analysis', { work: s.workA, viewpoints: ['人物'] })
    expect(noViewpoint.isError).toBe(true)
    expect(noViewpoint.text).toContain('観点「構成」')
    expect(await call(core, 'novel_get_bench_analysis', { work: '海の記憶' })).toContain('分析はまだありません')
  })

  it('長い分析は char_budget 字ずつ、cursor で続きを読む（観点の絞り込みも続く）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const long = Array.from({ length: 80 }, (_, i) => `段落${i + 1}。${'あ'.repeat(95)}`).join('\n')
    const data = addBenchAnalysis(s.data, s.workA, { viewpoint: '人物', body: long, runDate: '2026-10-25' }).data
    const { core } = await pairedCore(fake, data)
    const first = await call(core, 'novel_get_bench_analysis', { work: s.workA, viewpoints: ['人物'], char_budget: 2_000 })
    const cursor = /続き: cursor="([^"]+)"/.exec(first)![1]
    expect(first).toContain('段落1。')
    expect(first).not.toContain('段落80。')
    let text = first
    let next: string | undefined = cursor
    for (let i = 0; next && i < 20; i++) {
      const page = await call(core, 'novel_get_bench_analysis', { cursor: next, char_budget: 2_000 })
      expect(page).toContain('『銀河の果て』の分析の続き')
      expect(page).not.toContain('短い文を重ねる')
      text += page
      next = /続き: cursor="([^"]+)"/.exec(page)?.[1]
    }
    expect(next).toBeUndefined()
    expect(text).toContain('段落80。')
    expect((await core.callTool('novel_get_bench_analysis', { cursor: 'xyz' })).isError).toBe(true)
  })
})

/** 棚に n 作品（作品ごとに観点 k 個の分析）。作品名は names(i) */
function bigShelf(n: number, k: number, name: (i: number) => string = (i) => `作品${String(i + 1).padStart(3, '0')}`) {
  let data: AppData = novel(['冒頭の本文。'], { name: '星の庭' }).data
  const ids: ID[] = []
  for (let i = 0; i < n; i++) {
    const w = addBenchWork(data, { name: name(i), author: '著者' })
    data = w.data
    ids.push(w.result)
    for (let j = 0; j < k; j++)
      data = addBenchAnalysis(data, w.result, { viewpoint: `観点${j + 1}・とても長い観点の名前`, body: '本文', runDate: '2026-10-30' }).data
  }
  return { data, ids }
}

/** 一覧の w:… を出てきた順に */
const listedIds = (text: string) => [...text.matchAll(/^(w:[0-9a-f]+)『/gm)].map((m) => m[1])
const nextCursor = (text: string) => /続き: cursor="([^"]+)"/.exec(text)?.[1]

describe('一覧の絞り込みと続き（novel_list_bench_works の names・exclude_names・char_budget・cursor）', () => {
  it('names で作品名に含む作品だけ、exclude_names で除く（全角と半角・空白の違いは問わない）', async () => {
    const fake = new FakeFirebase()
    const names = ['【原稿】星の庭（第1稿）', '【原稿】星の庭（第1稿・2回目）', '【原稿】海の庭（第1稿）', '【横断】SF', '【対照】星の庭（名前あり）', '銀河の果て']
    const s = bigShelf(names.length, 1, (i) => names[i])
    const { core } = await pairedCore(fake, s.data)
    const runs = await call(core, 'novel_list_bench_works', { names: ['【原稿】星の庭'] })
    expect(runs).toContain('=== 相対比較（作品名に「【原稿】星の庭」を含む作品 2作品／全6作品。作者が比べるために読む既存の作品）===')
    expect(listedIds(runs)).toEqual([s.ids[0], s.ids[1]].map((id) => shortId('benchWork', id)))
    expect(runs).toContain('分析の本文は novel_get_bench_analysis（work に w:…）で読んでください。')
    expect(runs).not.toContain('続き: cursor=')
    // 全角の英字・続く空白でも同じ（NFKC・空白をまとめて照らす）
    const genre = await call(core, 'novel_list_bench_works', { names: ['【横断】ＳＦ', '【原稿】海の庭 '] })
    expect(listedIds(genre)).toEqual([s.ids[2], s.ids[3]].map((id) => shortId('benchWork', id)))
    expect(genre).toContain('作品名に「【横断】ＳＦ」「【原稿】海の庭」のどれかを含む作品 2作品／全6作品')
    const books = await call(core, 'novel_list_bench_works', { exclude_names: ['【原稿】', '【横断】', '【対照】', '【監査】'] })
    expect(listedIds(books)).toEqual([shortId('benchWork', s.ids[5])])
    expect(books).toContain('作品名に「【原稿】」「【横断】」「【対照】」「【監査】」のどれも含まない作品 1作品／全6作品')
    const both = await call(core, 'novel_list_bench_works', { names: ['星の庭'], exclude_names: ['【対照】'] })
    expect(listedIds(both)).toEqual([s.ids[0], s.ids[1]].map((id) => shortId('benchWork', id)))
    expect(both).toContain('作品名に「星の庭」を含む・「【対照】」を含まない作品 2作品／全6作品')
    const none = await call(core, 'novel_list_bench_works', { names: ['【監査】基準測定'] })
    expect(none).toContain('（作品名に「【監査】基準測定」を含む作品はありません）')
    expect(listedIds(none)).toEqual([])
    // 絞り込まなければ今までどおり
    const all = await call(core, 'novel_list_bench_works')
    expect(all).toContain('=== 相対比較（6作品。作者が比べるために読む既存の作品）===')
    expect(listedIds(all)).toHaveLength(6)
  })

  it('長い棚は作品の途中で切らずに返し、cursor だけで続きを読む（重なり・抜けなし。絞り込みは cursor に入る）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(24, 10)
    const { core } = await pairedCore(fake, s.data)
    const seen: string[] = []
    let text = await call(core, 'novel_list_bench_works', { char_budget: 2_000 })
    expect(text).toContain('=== 相対比較（24作品。作者が比べるために読む既存の作品）===')
    let pages = 1
    for (;;) {
      expect(text.length).toBeLessThanOrEqual(2_000)
      seen.push(...listedIds(text))
      const next = nextCursor(text)
      if (!next) break
      // 最後の行が続きの行（前の版のプロンプトも「結果が長いため、ここで切りました」で切れたと分かる）
      expect(text.trimEnd().split('\n').at(-1)).toMatch(/^続き: cursor="[^"]+"（結果が長いため、ここで切りました。残り\d+作品は、この cursor で読めます）$/)
      // 作品の行の途中では切らない（最後の作品の「分析」の行まである）
      expect(text.split('\n').at(-2)).toMatch(/^ {2}分析 10件/)
      text = await call(core, 'novel_list_bench_works', { cursor: next })
      pages++
      expect(text).toMatch(/^=== 相対比較の続き（24作品のうち\d+作品目から／全24作品）===/)
    }
    expect(pages).toBeGreaterThan(2)
    expect(seen).toEqual(s.ids.map((id) => shortId('benchWork', id)))
    expect(text).toContain('分析の本文は novel_get_bench_analysis（work に w:…）で読んでください。')
  })

  it('絞り込みの続き: cursor だけで同じ条件。違う条件を一緒に渡すと断る。読めない cursor も断る', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(12, 10, (i) => (i % 2 ? `【原稿】星の庭（第1稿・${i + 1}回目）` : `既存の作品${i + 1}`))
    const { core } = await pairedCore(fake, s.data)
    const first = await call(core, 'novel_list_bench_works', { names: ['【原稿】星の庭'], char_budget: 2_000 })
    const next = nextCursor(first)!
    expect(next).toBeTruthy()
    const second = await call(core, 'novel_list_bench_works', { cursor: next })
    expect(second).toContain('=== 相対比較の続き（作品名に「【原稿】星の庭」を含む作品 6作品のうち')
    const ids = [...listedIds(first), ...listedIds(second)]
    expect(ids.every((id) => s.ids.filter((_, i) => i % 2).map((x) => shortId('benchWork', x)).includes(id))).toBe(true)
    // 同じ条件を一緒に渡すのはよい・違う条件は断る
    expect(await call(core, 'novel_list_bench_works', { cursor: next, names: ['【原稿】星の庭'] })).toBe(second)
    const other = await core.callTool('novel_list_bench_works', { cursor: next, names: ['既存'] })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('cursor が別の条件のものです')
    const bad = await core.callTool('novel_list_bench_works', { cursor: 'abc' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('cursor が読めません')
    const wrongKind = await core.callTool('novel_list_bench_works', { cursor: encodeCursor({ k: 'bench', t: 'x', which: 'work', id: 'x', o: 0 }) })
    expect(wrongKind.isError).toBe(true)
    const badNames = await core.callTool('novel_list_bench_works', { names: 'abc' })
    expect(badNames.isError).toBe(true)
  })

  it('前のページの最後の作品が消えていても、その次の作品から続ける', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(5, 1)
    const { core } = await pairedCore(fake, s.data)
    const third = s.data.benchWorks[s.ids[2]]
    // 3作品目まで読んだ後に3作品目が消えた（cursor の id はもう無い）
    const cursor = encodeCursor({ k: 'benchList', n: [], x: [], a: 'gone-id', o: third.order })
    const rest = await call(core, 'novel_list_bench_works', { cursor })
    expect(listedIds(rest)).toEqual([s.ids[3], s.ids[4]].map((id) => shortId('benchWork', id)))
    expect(rest).toContain('=== 相対比較の続き（5作品のうち4作品目から／全5作品）===')
    const end = await call(core, 'novel_list_bench_works', {
      cursor: encodeCursor({ k: 'benchList', n: [], x: [], a: s.ids[4], o: s.data.benchWorks[s.ids[4]].order }),
    })
    expect(end).toContain('（この後の作品はありません）')
    expect(listedIds(end)).toEqual([])
  })

  it('部分一致なので、1つの原稿の回だけは「【原稿】{原稿名}（」と【対照】を除く組み合わせで見る（見出しの条件は入力のまま）', async () => {
    const fake = new FakeFirebase()
    const names = [
      '【原稿】星の庭（第1稿）',
      '【原稿】星の庭（第1稿・2回目）',
      '【対照】【原稿】星の庭（第1稿）（置換）',
      '【対照】【原稿】星の庭（第1稿）（名前あり）',
      '【原稿】星の庭園（第1稿）',
    ]
    const s = bigShelf(names.length, 1, (i) => names[i])
    const { core } = await pairedCore(fake, s.data)
    expect(listedIds(await call(core, 'novel_list_bench_works', { names: ['【原稿】星の庭'] }))).toHaveLength(5)
    const runs = await call(core, 'novel_list_bench_works', { names: ['【原稿】星の庭（'], exclude_names: ['【対照】'] })
    expect(listedIds(runs)).toEqual([s.ids[0], s.ids[1]].map((id) => shortId('benchWork', id)))
    expect(runs).toContain('作品名に「【原稿】星の庭（」を含む・「【対照】」を含まない作品 2作品／全5作品')
  })

  it('残りが char_budget に収まれば1回で全部（続きの行の分を空けて切らない）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(5, 10)
    const { core } = await pairedCore(fake, s.data)
    const whole = await call(core, 'novel_list_bench_works')
    const budget = whole.length
    expect(budget).toBeGreaterThan(1_500)
    expect(budget).toBeLessThan(2_500)
    const one = await call(core, 'novel_list_bench_works', { char_budget: Math.max(2_000, budget) })
    expect(one).toBe(whole)
    expect(nextCursor(one)).toBeUndefined()
  })

  it('続きは最後に出した作品の今の位置の次から（アプリで並べ替えて並び順の数が振り直されても抜けない）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(5, 1)
    const { core } = await pairedCore(fake, s.data)
    // 2作品目まで読んだ後に並び順の数が振り直された（cursor の並び順は今のどの作品より大きい）
    const cursor = encodeCursor({ k: 'benchList', n: [], x: [], a: s.ids[1], o: 1_000 })
    const rest = await call(core, 'novel_list_bench_works', { cursor })
    expect(listedIds(rest)).toEqual([s.ids[2], s.ids[3], s.ids[4]].map((id) => shortId('benchWork', id)))
  })

  it('1つの作品の行だけで char_budget に収まらない時は、その行を切って印を付け、分析の数は残す', async () => {
    const fake = new FakeFirebase()
    let data = bigShelf(1, 1).data
    const big = addBenchWork(data, { name: '観点の多い作品', author: '著者' })
    data = big.data
    for (let j = 0; j < 80; j++)
      data = addBenchAnalysis(data, big.result, { viewpoint: `観点${j + 1}・とても長い観点の名前`, body: '本文', runDate: '2026-10-30' }).data
    const after = addBenchWork(data, { name: '後の作品', author: '著者' })
    data = after.data
    const { core } = await pairedCore(fake, data)
    const seen: string[] = []
    let text = await call(core, 'novel_list_bench_works', { char_budget: 2_000 })
    let clipped = ''
    for (let n = 0; n < 10; n++) {
      expect(text.length).toBeLessThanOrEqual(2_000)
      seen.push(...listedIds(text))
      if (text.includes('『観点の多い作品』')) clipped = text
      const next = nextCursor(text)
      if (!next) break
      text = await call(core, 'novel_list_bench_works', { cursor: next })
    }
    expect(clipped).toContain('  分析 80件')
    expect(clipped).toContain('（この作品の行は長いため、ここまで）')
    expect(seen).toHaveLength(3)
    expect(seen).toContain(shortId('benchWork', after.result))
  })

  it('除くだけの絞り込みも cursor で続き、違う exclude_names は断り、char_budget は渡せばそちらを使う', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(16, 10, (i) => (i % 2 ? `【原稿】星の庭（第1稿・${i + 1}回目）` : `既存の作品${i + 1}`))
    const { core } = await pairedCore(fake, s.data)
    const first = await call(core, 'novel_list_bench_works', { exclude_names: ['【原稿】'], char_budget: 2_000 })
    const next = nextCursor(first)!
    expect(next).toBeTruthy()
    const refused = await core.callTool('novel_list_bench_works', { cursor: next, exclude_names: ['【横断】'] })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('cursor が別の条件のものです')
    const rest = await call(core, 'novel_list_bench_works', { cursor: next, char_budget: 100_000 })
    expect(rest).toContain('作品名に「【原稿】」を含まない作品 8作品のうち')
    expect(nextCursor(rest)).toBeUndefined()
    const ids = [...listedIds(first), ...listedIds(rest)]
    expect(ids).toEqual(s.ids.filter((_, i) => i % 2 === 0).map((id) => shortId('benchWork', id)))
  })

  it('引数なしで、今まで1回で返っていた長さ（99,000〜100,000字）の棚は、今までと同じ答え', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(95, 30)
    const { core } = await pairedCore(fake, s.data)
    // 今までの答え（見出し・作品ごとの行・終わりの行）。結果の上限（100,000字）を超えなければ切られなかった
    const works = Object.values(s.data.benchWorks).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const old = [
      `=== 相対比較（${works.length}作品。作者が比べるために読む既存の作品）===`,
      ...works.map((w) => benchWorkLine(s.data, w)),
      '分析の本文は novel_get_bench_analysis（work に w:…）で読んでください。',
    ].join('\n')
    expect(old.length).toBeGreaterThan(99_000)
    expect(old.length).toBeLessThanOrEqual(100_000)
    expect(await call(core, 'novel_list_bench_works')).toBe(old)
  })

  it('省略時は結果の上限まで1回で返し、超える棚は作品の切れ目で続きにする（途中で切れた印は出ない）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(110, 30)
    const { core } = await pairedCore(fake, s.data)
    const first = await call(core, 'novel_list_bench_works')
    expect(first.length).toBeGreaterThan(90_000)
    expect(first.length).toBeLessThanOrEqual(100_000)
    expect(first).not.toContain('[...]')
    expect(first).toContain('結果が長いため、ここで切りました')
    const next = nextCursor(first)!
    const second = await call(core, 'novel_list_bench_works', { cursor: next })
    expect([...listedIds(first), ...listedIds(second)]).toEqual(s.ids.map((id) => shortId('benchWork', id)))
    expect(nextCursor(second)).toBeUndefined()
  })
})

describe('作品批評（novel_get_critique・novel_add_critique_result）', () => {
  it('タイトルの相対比較する作品を観点つきで出し、比べた作品を bench_works で記録する', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const text = await call(core, 'novel_get_critique', { title_id: s.titleId })
    expect(text).toContain('--- 相対比較する作品（1作品。作者が比べたい既存の作品）---')
    expect(text).toContain(`${shortId('benchWork', s.workA)}『銀河の果て』（山田） 分析 3件: 構成・文体`)
    expect(text).toContain('novel_get_bench_analysis')
    const r = await core.callTool('novel_add_critique_result', {
      title_id: s.titleId,
      result_markdown: '## 『銀河の果て』と比べて\n…',
      bench_works: [shortId('benchWork', s.workA), '無い作品'],
    })
    expect(r.text).toContain('追加 1件')
    expect(r.text).toContain("bench_works の '無い作品' は見つからないため外しました")
    const docs = fake.recordDocs(OWNER).filter((d) => d.name.includes('/critiqueResults:'))
    const f = docs[0].fields
    const rec = decodeRecord(
      {
        table: 'critiqueResults',
        id: f.id.stringValue,
        json: f.json.stringValue,
        chunks: 0,
        deleted: false,
        hash: f.hash.stringValue,
        updated: null,
        device: 'claude-connector',
      } as unknown as RecordDoc,
      () => undefined,
    )
    expect(rec).toMatchObject({ benchWorkIds: [s.workA] })

    // 読み返すと、結果ごとに比べた作品が出る（一覧と result_id の全文）
    const compared = `比べた作品: ${shortId('benchWork', s.workA)}『銀河の果て』（山田）`
    const list = await call(core, 'novel_get_critique', { title_id: s.titleId })
    expect(list).toContain(`・${compared}`)
    const full = await call(core, 'novel_get_critique', { title_id: s.titleId, result_id: shortId('critiqueResult', String(f.id.stringValue)) })
    expect(full).toContain(`\n${compared}\n`)
    expect(full).not.toContain('相対比較から削除されています')
  })

  it('比べた作品が相対比較から削除されていれば、その数を添える。比べた作品の無い結果には出さない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const built = buildCritiqueResult(
      s.data,
      { title_id: s.titleId, result_markdown: '## 二作と比べて', bench_works: [s.workA, s.workB] },
      { source: 'claude', now: Date.UTC(2026, 9, 30, 3) },
    )
    const plain = buildCritiqueResult(
      s.data,
      { title_id: s.titleId, result_markdown: '## 比べずに', run_date: '2026-10-01' },
      { source: 'claude', now: Date.UTC(2026, 9, 1, 3) },
    )
    let data = addClaudeRecords(s.data, [...built.records, ...plain.records]).data
    data = deleteBenchWork(data, s.workB)
    const { core } = await pairedCore(fake, data)
    const list = await call(core, 'novel_get_critique', { title_id: s.titleId })
    expect(list).toContain(`比べた作品: ${shortId('benchWork', s.workA)}『銀河の果て』（山田）（ほか1作品は相対比較から削除されています）`)
    expect(list.match(/比べた作品:/g)).toHaveLength(1)
    const id = built.records[0].record.id
    const full = await call(core, 'novel_get_critique', { title_id: s.titleId, result_id: shortId('critiqueResult', id) })
    expect(full).toContain('（ほか1作品は相対比較から削除されています）')
    const other = await call(core, 'novel_get_critique', {
      title_id: s.titleId,
      result_id: shortId('critiqueResult', plain.records[0].record.id),
    })
    expect(other).not.toContain('比べた作品')
  })
})

describe('書き込み（novel_add_bench_analysis）', () => {
  /** コネクタが作った文書（棚に置いておいた作品は端末が書いたもの） */
  const docsOf = (fake: FakeFirebase, table: string) =>
    fake
      .recordDocs(OWNER)
      .filter((d) => d.name.includes(`/${table}:`) && d.fields.device?.stringValue === 'claude-connector')

  it('相対比較に無い作品は new_work を付けた時だけ作り、分析を観点ごとに作る（同じ内容は重複）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const items = [
      { viewpoint: '構成', body_markdown: '## 構成\n四部構成。', run_date: '2026-10-30' },
      { viewpoint: '冒頭の掴み', body_markdown: '## 冒頭\n一文目で謎を置く。', run_date: '2026-10-30' },
    ]
    const missing = await core.callTool('novel_add_bench_analysis', { work: '星を継ぐ', items })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('new_work')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)

    const input = { work: '星を継ぐ', new_work: { name: '星を継ぐ', author: '高橋', pdf_place: 'プロジェクト「SF」' }, items }
    const r = await core.callTool('novel_add_bench_analysis', input)
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('相対比較に分析を追加: 追加 2件')
    expect(r.text).toContain('『星を継ぐ』（高橋） を相対比較に追加しました')
    expect(r.text).toContain('アプリのホームの「相対比較」に、各端末が同期すると出ます')
    expect(r.text).not.toContain('ベンチ')
    expect(r.structured).toMatchObject({ created: [{ id: expect.stringMatching(/^n:/) }, { id: expect.stringMatching(/^n:/) }] })
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(2)
    expect(docsOf(fake, 'benchWorks')[0].fields.device).toEqual({ stringValue: 'claude-connector' })
    // 一覧にもすぐ出る（自分の書き込みを写しに入れる）
    expect(await call(core, 'novel_list_bench_works')).toContain('『星を継ぐ』（高橋）')
    // 答えの作品の w:… で、そのまま次の分析を足せる（一覧で探し直さなくてよい）
    const workRef = /作品 (w:[0-9A-Za-z]+)『星を継ぐ』（高橋） を相対比較に追加しました/.exec(r.text)![1]
    expect(r.text).not.toContain('相対比較の作品 w:')
    clock.now += 20_000
    const again = await core.callTool('novel_add_bench_analysis', input)
    expect(again.text).toContain('重複 2件')
    // 何も足さなかった時も、どの作品かを出す
    expect(again.text).toContain(`補足: 相対比較の作品 ${workRef}『星を継ぐ』（高橋） には何も追加していません`)
    expect(again.text).not.toContain('を相対比較に追加しました')
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(2)
    // 作品名で指せば、作品はもう作らない。既にある作品に足した時も、答えに作品の w:… を出す
    const more = await core.callTool('novel_add_bench_analysis', {
      work: '星を継ぐ',
      items: [{ viewpoint: '人物', body_markdown: '主人公の弧' }],
    })
    expect(more.text).toContain('追加 1件')
    expect(more.text).toContain(`補足: 相対比較の作品 ${workRef}『星を継ぐ』（高橋） に追加しました`)
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    const byRef = await core.callTool('novel_add_bench_analysis', {
      work: workRef,
      items: [{ viewpoint: '文体', body_markdown: '短い文' }],
    })
    expect(byRef.text).toContain('追加 1件')
    expect(byRef.text).toContain(`相対比較の作品 ${workRef}『星を継ぐ』（高橋） に追加しました`)
  })

  it('相対比較に無い作品で分析を1つも作れなければ、作品も作らず、作っていないことを答える', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const r = await core.callTool('novel_add_bench_analysis', {
      work: '星を継ぐ',
      new_work: { name: '星を継ぐ', author: '高橋' },
      items: [{ viewpoint: '', body_markdown: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('形が違う 1件')
    expect(r.text).toContain('補足: 分析を1つも追加しなかったため、作品『星を継ぐ』（高橋）は相対比較に追加していません')
    expect(r.text).not.toContain('w:')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)
  })

  it('作品名の全角と半角・全角の空白の違いでは、別の作品を作らない（相対比較の作品に足す）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const up = addBenchWork(s.data, { name: '銀河の果て　上', author: '山田' })
    const sf = addBenchWork(up.data, { name: 'ＳＦ傑作選', author: '' })
    const { core } = await pairedCore(fake, sf.data)
    for (const name of ['銀河の果て 上', 'SF傑作選']) {
      const r = await core.callTool('novel_add_bench_analysis', {
        work: name,
        new_work: { name, author: name === 'SF傑作選' ? '' : '山田' },
        items: [{ viewpoint: '構成', body_markdown: `## 構成\n${name}`, run_date: '2026-10-30' }],
      })
      expect(r.text).toContain('追加 1件')
      expect(r.text).not.toContain('を相対比較に追加しました')
      const work = name === 'SF傑作選' ? `${shortId('benchWork', sf.result)}『ＳＦ傑作選』` : `${shortId('benchWork', up.result)}『銀河の果て　上』（山田）`
      expect(r.text).toContain(`相対比較の作品 ${work} に追加しました`)
    }
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)
    const list = await call(core, 'novel_list_bench_works')
    expect(list.match(/『銀河の果て/g)).toHaveLength(2)
    expect(list).toContain(`${shortId('benchWork', up.result)}『銀河の果て　上』（山田）`)
    expect(list).not.toContain('『SF傑作選』')
  })

  it('作品名が同じでも new_work の著者が違えば別の作品として作り、同じ作品名・著者ならその作品に足す', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    // 棚の『海の記憶』は佐藤。田中の同名の作品は別の作品
    const input = {
      work: '海の記憶',
      new_work: { name: '海の記憶', author: '田中' },
      items: [{ viewpoint: '構成', body_markdown: '## 構成\n田中の『海の記憶』', run_date: '2026-10-30' }],
    }
    const r = await core.callTool('novel_add_bench_analysis', input)
    expect(r.text).toContain('追加 1件')
    expect(r.text).toContain('『海の記憶』（田中） を相対比較に追加しました')
    expect(r.text).toContain(`著者の違う同名の作品 ${shortId('benchWork', s.workB)}『海の記憶』（佐藤） があるため、別の作品として足しました`)
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    clock.now += 20_000
    const again = await core.callTool('novel_add_bench_analysis', {
      ...input,
      items: [{ viewpoint: '文体', body_markdown: '## 文体\n短文', run_date: '2026-10-30' }],
    })
    expect(again.text).toContain('追加 1件')
    expect(again.text).not.toContain('を相対比較に追加しました')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    // 佐藤の作品には何も足していない
    const sato = await call(core, 'novel_get_bench_analysis', { work: shortId('benchWork', s.workB) })
    expect(sato).not.toContain('田中')
    const list = await call(core, 'novel_list_bench_works')
    expect(list).toContain('『海の記憶』（田中）')
    expect(list).toContain('『海の記憶』（佐藤）')
  })

  it('手で足して削除した作品（ゴミ箱に同じ作品名）は new_work で作り直さない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    // 「海の記憶」（佐藤）は棚で手で足した作品（id は内容から作った id ではない）。削除してゴミ箱へ
    const { core } = await pairedCore(fake, deleteBenchWork(s.data, s.workB))
    const r = await core.callTool('novel_add_bench_analysis', {
      work: '海の記憶',
      new_work: { name: '海の記憶', author: '佐藤' },
      items: [{ viewpoint: '構成', body_markdown: '## 構成\n二部構成。', run_date: '2026-10-30' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('以前に削除されています')
    expect(r.text).toContain('ゴミ箱から戻してください')
    expect(docsOf(fake, 'benchWorks')).toHaveLength(0)
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)
    // 棚にある作品はそのまま書ける
    const ok = await core.callTool('novel_add_bench_analysis', {
      work: '銀河の果て',
      items: [{ viewpoint: '人物', body_markdown: '主人公の弧' }],
    })
    expect(ok.text).toContain('追加 1件')
    expect(ok.text).toContain(`相対比較の作品 ${shortId('benchWork', s.workA)}『銀河の果て』（山田） に追加しました`)
  })

  it('Claude が作って削除し、ゴミ箱からも消した作品（削除の印だけが残る）は、別の id の新しい作品として作り直す', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const input = {
      work: '52ヘルツのクジラたち',
      new_work: { name: '52ヘルツのクジラたち', author: '町田' },
      items: [{ viewpoint: '00 読書ノート', body_markdown: '## 0. 抽出確認\n本文。', run_date: '2026-11-03' }],
    }
    const first = await core.callTool('novel_add_bench_analysis', input)
    expect(first.text).toContain('を相対比較に追加しました')
    const oldId = benchWorkId('52ヘルツのクジラたち', '町田')
    expect(first.text).toContain(shortId('benchWork', oldId))
    const oldAnalysis = docsOf(fake, 'benchAnalyses')[0].fields.id.stringValue as string
    // 端末で削除してゴミ箱も空にした: クラウドには削除の印だけが残る（コネクタは削除の印の文書を書き換えられない）
    fake.tombstone(OWNER, 'benchWorks', oldId)
    fake.tombstone(OWNER, 'benchAnalyses', oldAnalysis)
    clock.now += 20_000
    expect(await call(core, 'novel_list_bench_works')).not.toContain('52ヘルツ')
    const again = await core.callTool('novel_add_bench_analysis', input)
    expect(again.isError).toBeUndefined()
    expect(again.text).toContain('追加 1件')
    const newId = benchWorkId('52ヘルツのクジラたち', '町田', 2)
    expect(again.text).toContain(`作品 ${shortId('benchWork', newId)}『52ヘルツのクジラたち』（町田） を相対比較に追加しました`)
    expect(docsOf(fake, 'benchWorks').map((d) => d.fields.id.stringValue)).toEqual([newId])
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(1)
    // 削除の印はそのまま
    const mark = fake.recordDocs(OWNER).find((d) => d.name.endsWith(`/benchWorks:${oldId}`))
    expect(mark?.fields.deleted?.booleanValue).toBe(true)
    // 同じ作品名でもう一度: 作り直した作品に足す（作品は増えない）
    clock.now += 20_000
    const more = await core.callTool('novel_add_bench_analysis', {
      ...input,
      items: [{ viewpoint: '02 ログライン・企画の核', body_markdown: '**結論**：一行', run_date: '2026-11-03' }],
    })
    expect(more.text).toContain('追加 1件')
    expect(more.text).toContain(`相対比較の作品 ${shortId('benchWork', newId)}『52ヘルツのクジラたち』（町田） に追加しました`)
    expect(docsOf(fake, 'benchWorks')).toHaveLength(1)
    expect(await call(core, 'novel_list_bench_works')).toContain('『52ヘルツのクジラたち』（町田）')
  })

  it('大きすぎる分析は作らず、番号を付けて分けるよう返す。「書き込みを許可」が外れていれば書かない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const big = await core.callTool('novel_add_bench_analysis', {
      work: s.workA,
      items: [{ viewpoint: '文体', body_markdown: 'あ'.repeat(250_000) }],
    })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('body_markdown を2つ以上に分け')
    expect(big.text).toContain('各部の body_markdown の1行目の先頭に「（1/2）」')
    expect(big.text).toContain(`相対比較の作品 ${shortId('benchWork', s.workA)}『銀河の果て』（山田） には何も追加していません`)
    expect(docsOf(fake, 'benchAnalyses')).toHaveLength(0)

    const fake2 = new FakeFirebase()
    const off = await pairedCore(fake2, s.data, { writes: false })
    const r = await off.core.callTool('novel_add_bench_analysis', {
      work: s.workA,
      items: [{ viewpoint: '人物', body_markdown: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込みは停止中')
    expect(await call(off.core, 'novel_list_bench_works')).toContain('『銀河の果て』')
  })
})

describe('作品のタグ（2.7。novel_list_bench_works の tags・タグの行・novel_get_bench_analysis のタグの行）', () => {
  /** V29 の 02 が登録する「14 検索用タグ」の本文 */
  const genre14 = (genre: string, sub: string) =>
    [
      '**結論**：検索の最短の言い方',
      '担当：編集長（マーケター案を確定）',
      '',
      `- 判定したジャンル：${genre}`,
      '- 適性のある賞（選んだ理由）：架空の新人賞（理由）',
      '※この2行には、役割の前の判定をそのまま写す。「ジャンル／サブジャンル」のジャンルは、判定したジャンルと同じ名前にする。',
      `- ジャンル／サブジャンル：${sub}`,
      '- トーン（例：静謐、疾走、乾いた、湿った、ユーモア）：静謐',
    ].join('\n')

  /** 作品A（作者のタグ）・作品B（14 だけ。アプリはまだ付けていない）・作品C（タグなし）・【横断】恋愛（14 があっても付かない） */
  function tagged() {
    const s = bigShelf(3, 1, (i) => ['作品A', '作品B', '作品C'][i])
    let data = setBenchWorkTags(s.data, s.ids[0], ['恋愛', '青春'])
    data = addBenchAnalysis(data, s.ids[1], { viewpoint: '14 検索用タグ', body: genre14('恋愛', '恋愛／喪失・家族'), runDate: '2026-11-01' }).data
    const cross = addBenchWork(data, { name: '【横断】恋愛', author: '編集部' })
    data = addBenchAnalysis(cross.data, cross.result, { viewpoint: '14 検索用タグ', body: genre14('恋愛', '恋愛'), runDate: '2026-11-01' }).data
    return { data, ids: [...s.ids, cross.result] }
  }

  it('一覧: 作品ごとに1行目の次に「  タグ: …」（アプリがまだ付けていない 14 のタグも）。1回目だけ「タグ（作品の数）」の行', async () => {
    const fake = new FakeFirebase()
    const s = tagged()
    const { core } = await pairedCore(fake, s.data)
    const text = await call(core, 'novel_list_bench_works')
    const lines = text.split('\n')
    expect(lines[0]).toBe('=== 相対比較（4作品。作者が比べるために読む既存の作品）===')
    expect(lines[1]).toBe('タグ（作品の数）: 恋愛 2・家族 1・青春 1・喪失 1')
    const after = (ref: string) => lines[lines.findIndex((l) => l.startsWith(ref)) + 1]
    expect(after(`${shortId('benchWork', s.ids[0])}『作品A』`)).toBe('  タグ: 恋愛・青春')
    expect(after(`${shortId('benchWork', s.ids[1])}『作品B』`)).toBe('  タグ: 恋愛・喪失・家族')
    expect(after(`${shortId('benchWork', s.ids[2])}『作品C』`)).toMatch(/^ {2}分析 1件/)
    expect(after(`${shortId('benchWork', s.ids[3])}『【横断】恋愛』`)).toMatch(/^ {2}分析 1件/)
    // 続きの答えには出さない
    const big = bigShelf(24, 10)
    const fake2 = new FakeFirebase()
    const { core: core2 } = await pairedCore(fake2, setBenchWorkTags(big.data, big.ids[0], ['SF']))
    const first = await call(core2, 'novel_list_bench_works', { char_budget: 2_000 })
    expect(first.split('\n')[1]).toBe('タグ（作品の数）: SF 1')
    const second = await call(core2, 'novel_list_bench_works', { cursor: nextCursor(first)! })
    expect(second).not.toContain('タグ（作品の数）')
    // タグが1つも無ければ出さない
    const fake3 = new FakeFirebase()
    const { core: core3 } = await pairedCore(fake3, bigShelf(2, 1).data)
    expect(await call(core3, 'novel_list_bench_works')).not.toContain('タグ')
  })

  it('tags で絞る: すべて持つ作品だけ（名前そのもので照らす。部分一致ではない。全角と半角は問わない）。ほかの絞り込みと一緒にも', async () => {
    const fake = new FakeFirebase()
    const s = tagged()
    const { core } = await pairedCore(fake, s.data)
    const love = await call(core, 'novel_list_bench_works', { tags: ['恋愛'] })
    expect(love).toContain('=== 相対比較（タグ「恋愛」を持つ作品 2作品／全4作品。作者が比べるために読む既存の作品）===')
    expect(listedIds(love)).toEqual([s.ids[0], s.ids[1]].map((id) => shortId('benchWork', id)))
    // 絞っても「タグ（作品の数）」は全作品で数える
    expect(love.split('\n')[1]).toBe('タグ（作品の数）: 恋愛 2・家族 1・青春 1・喪失 1')
    const both = await call(core, 'novel_list_bench_works', { tags: ['恋愛', ' 家族 '] })
    expect(both).toContain('タグ「恋愛」「家族」をすべて持つ作品 1作品／全4作品')
    expect(listedIds(both)).toEqual([shortId('benchWork', s.ids[1])])
    expect(listedIds(await call(core, 'novel_list_bench_works', { tags: ['恋'] }))).toEqual([])
    expect(await call(core, 'novel_list_bench_works', { tags: ['恋'] })).toContain('（タグ「恋」を持つ作品はありません）')
    const mixed = await call(core, 'novel_list_bench_works', { names: ['作品'], exclude_names: ['B'], tags: ['恋愛'] })
    expect(mixed).toContain('作品名に「作品」を含む・「B」を含まない・タグ「恋愛」を持つ作品 1作品／全4作品')
    expect(listedIds(mixed)).toEqual([shortId('benchWork', s.ids[0])])
    // 形の違う tags は断る
    for (const tags of ['恋愛', [1], ['あ'.repeat(21)], Array.from({ length: 11 }, (_, i) => `t${i}`)]) {
      const bad = await core.callTool('novel_list_bench_works', { tags })
      expect(bad.isError).toBe(true)
      expect(bad.text).toContain('names・exclude_names・tags は文字列の配列にしてください（それぞれ10個まで・1つ80字まで。tags は1つ20字まで）')
    }
  })

  it('cursor は tags も続ける。違う tags は断る。tags の無い前の版の cursor も読める', async () => {
    const fake = new FakeFirebase()
    const big = bigShelf(12, 10)
    let data = big.data
    for (const id of big.ids.filter((_, i) => i % 2)) data = setBenchWorkTags(data, id, ['SF'])
    const { core } = await pairedCore(fake, data)
    const first = await call(core, 'novel_list_bench_works', { tags: ['SF'], char_budget: 2_000 })
    const next = nextCursor(first)!
    expect(next).toBeTruthy()
    const second = await call(core, 'novel_list_bench_works', { cursor: next })
    expect(second).toContain('=== 相対比較の続き（タグ「SF」を持つ作品 6作品のうち')
    const odd = big.ids.filter((_, i) => i % 2).map((id) => shortId('benchWork', id))
    expect([...listedIds(first), ...listedIds(second)].every((id) => odd.includes(id))).toBe(true)
    expect(await call(core, 'novel_list_bench_works', { cursor: next, tags: ['ＳＦ'] })).toBe(second)
    const other = await core.callTool('novel_list_bench_works', { cursor: next, tags: ['宇宙'] })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('cursor が別の条件のものです（cursor だけを渡すか、同じ names・exclude_names・tags で渡してください）')
    // tags を持たない前の版の cursor（2.6）は、タグで絞らずに続ける
    const old = encodeCursor({ k: 'benchList', n: [], x: [], a: big.ids[0], o: data.benchWorks[big.ids[0]].order, b: 2_000 })
    const cont = await call(core, 'novel_list_bench_works', { cursor: old })
    expect(cont).toMatch(/^=== 相対比較の続き（12作品のうち2作品目から／全12作品）===/)
  })

  it('アプリが付けた後に作者が外したタグは出ない（autoTagsFrom が進んでいるので 14 から付き直さない）', async () => {
    const fake = new FakeFirebase()
    const s = tagged()
    const data = setBenchWorkTags(applyAutoGenreTags(s.data), s.ids[1], ['恋愛'])
    const { core } = await pairedCore(fake, data)
    const text = await call(core, 'novel_list_bench_works', { tags: ['家族'] })
    expect(listedIds(text)).toEqual([])
    expect(text).toContain('タグ（作品の数）: 恋愛 2・青春 1')
  })

  it('novel_get_bench_analysis: 書誌の行の次に「タグ: …」（書誌の行は変えない）。analysis_id の1件だけの答えは今のまま', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    let data = setBenchWorkTags(s.data, s.workA, ['SF', '宇宙'])
    const b = addBenchAnalysis(data, s.workB, { viewpoint: '14 検索用タグ', body: genre14('恋愛', '恋愛／喪失'), runDate: '2026-11-01' })
    data = b.data
    const { core } = await pairedCore(fake, data)
    const a = await call(core, 'novel_get_bench_analysis', { work: '銀河の果て' })
    expect(a.split('\n').slice(0, 3)).toEqual([
      `=== 相対比較の作品 ${shortId('benchWork', s.workA)}『銀河の果て』（山田） ===`,
      '山田・2019',
      'タグ: SF・宇宙',
    ])
    const auto = await call(core, 'novel_get_bench_analysis', { work: '海の記憶' })
    expect(auto.split('\n').slice(1, 3)).toEqual(['佐藤', 'タグ: 恋愛・喪失'])
    const one = await call(core, 'novel_get_bench_analysis', { work: s.workA, analysis_id: shortId('benchAnalysis', s.firstAnalysis) })
    expect(one).not.toContain('タグ:')
  })

  it('new_work に tags・autoTagsFrom が付いていても作品に入れない（タグはアプリが 14 から付ける）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const r = await core.callTool('novel_add_bench_analysis', {
      work: '星を継ぐ',
      new_work: { name: '星を継ぐ', author: '高橋', tags: ['SF'], autoTagsFrom: { analysisId: 'x', runDate: '2026-11-01', createdAt: 1 } },
      items: [{ viewpoint: '14 検索用タグ', body_markdown: genre14('SF', 'SF／宇宙'), run_date: '2026-11-01' }],
    })
    expect(r.isError).toBeUndefined()
    const doc = fake.recordDocs(OWNER).find((d) => d.name.includes('/benchWorks:') && d.fields.device?.stringValue === 'claude-connector')!
    const rec = decodeRecord(
      {
        table: 'benchWorks',
        id: doc.fields.id.stringValue,
        json: doc.fields.json.stringValue,
        chunks: 0,
        deleted: false,
        hash: doc.fields.hash.stringValue,
        updated: null,
        device: 'claude-connector',
      } as unknown as RecordDoc,
      () => undefined,
    ) as Record<string, unknown>
    expect(rec.name).toBe('星を継ぐ')
    expect('tags' in rec).toBe(false)
    expect('autoTagsFrom' in rec).toBe(false)
    // 読む時は 14 から付くタグを見せる
    expect(await call(core, 'novel_list_bench_works', { tags: ['宇宙'] })).toContain('『星を継ぐ』（高橋）')
  })
})
