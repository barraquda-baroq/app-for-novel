// 資料（2.6）のツール: 一覧・記録を読む・記録を追加。相対比較のツール（bench.test.ts）と同じ確かめ。
// 資料はタイトルの「Claude に見せる」と関係なく見せ、書き込みは「書き込みを許可」の時だけ。
import { describe, expect, it } from 'vitest'
import { addMaterial, addMaterialNote, deleteMaterial } from '../../../src/domain/materialOps'
import { addBenchWork } from '../../../src/domain/benchOps'
import { setTitleClaudeAccess } from '../../../src/domain/claudeOps'
import { createTitle } from '../../../src/domain/entityOps'
import { shortId } from '../../../src/claude/refs'
import type { AppData, ID } from '../../../src/domain/types'
import { encodeCursor } from '../../../src/claude/view'
import { decodeRecord, type RecordDoc } from '../../../src/sync/codec'
import { novel } from '../../../src/test/claudeFixture'
import { FakeFirebase } from '../support/fakeFirebase'
import { OWNER, call, pairedCore } from '../support/harness'

/** 棚に2つの資料（1つは記録つき）と、見せないタイトル */
function shelf() {
  const n = novel(['冒頭の本文。'], { name: '星の庭' })
  let data: AppData = n.data
  const a = addMaterial(data, {
    name: '江戸の暮らし',
    author: '山田',
    year: '2019',
    tags: ['歴史', '江戸'],
    pdfPlace: 'プロジェクト「資料」',
  })
  data = a.data
  const b = addMaterial(data, { name: '刀剣の手入れ', author: '佐藤', tags: ['武器'] })
  data = b.data
  const at = (section: string, body: string, runDate: string, createdAt: number) => {
    const r = addMaterialNote(data, a.result, { section, body, runDate })
    data = { ...r.data, materialNotes: { ...r.data.materialNotes, [r.result]: { ...r.data.materialNotes[r.result], createdAt } } }
    return r.result
  }
  // ほかの項目「年表」は最初に記録しても、決まった4つの項目の後に並ぶ
  at('年表', '## 年表\n1603 江戸幕府。', '2026-10-01', 0)
  const first = at('要約', '## 要約\n第1章 町の成り立ち。', '2026-10-01', 1)
  at('創作に役立つ知識', '- 長屋の家賃は月に300文ほど（第3章）', '2026-10-02', 2)
  at('要約', '## 要約（読み直し）\n第2章 物売りの声。', '2026-10-20', 3)
  at('サンプルシーン', '場面: 夏の長屋。\n風鈴が鳴った。', '2026-10-21', 4)
  const hidden = createTitle(data, '内緒の話')
  data = setTitleClaudeAccess(hidden.data, hidden.result, 'none')
  return { data, titleId: n.titleId, materialA: a.result, materialB: b.result, firstNote: first }
}

describe('読む（novel_list_materials・novel_get_material）', () => {
  it('一覧: 資料・書誌・作者が付けたタグ・項目ごとの数と最新の日付（決まった項目の順）・PDF の置き場所', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const text = await call(core, 'novel_list_materials')
    expect(text).toContain('=== 資料（2件。作者が創作のために読む資料）===')
    expect(text).toContain(`${shortId('material', s.materialA)}『江戸の暮らし』（山田） 山田・2019\n  タグ: 歴史・江戸\n  記録 5件`)
    expect(text).toContain(
      '要約 2件（最新 2026-10-20）・創作に役立つ知識 1件（最新 2026-10-02）・サンプルシーン 1件（最新 2026-10-21）・年表 1件（最新 2026-10-01）',
    )
    expect(text).toContain('PDF の置き場所: プロジェクト「資料」')
    expect(text).toContain(`${shortId('material', s.materialB)}『刀剣の手入れ』（佐藤） 佐藤\n  タグ: 武器\n  記録 0件`)
    expect(text.indexOf('『江戸の暮らし』')).toBeLessThan(text.indexOf('『刀剣の手入れ』'))
    expect(text.trimEnd().split('\n').at(-1)).toBe('記録の本文は novel_get_material（material に d:…）で読んでください。')
    expect(text).not.toContain('内緒の話')
    expect(text).not.toContain('相対比較')
  })

  it('タイトルをすべて見せなくても、資料は読める。棚が空なら作り方を答える', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const data = setTitleClaudeAccess(s.data, s.titleId, 'none')
    const { core } = await pairedCore(fake, data)
    expect(await call(core, 'novel_list_titles')).toContain('（ありません')
    expect(await call(core, 'novel_list_materials')).toContain('『江戸の暮らし』')
    expect(await call(core, 'novel_get_material', { material: '江戸の暮らし' })).toContain('第1章 町の成り立ち')

    const empty = await pairedCore(new FakeFirebase(), novel(['本文']).data)
    const none = await call(empty.core, 'novel_list_materials')
    expect(none).toContain('=== 資料（0件。作者が創作のために読む資料）===')
    expect(none).toContain('novel_add_material_notes の new_material を付けて記録を追加すると、資料も資料の棚に追加されます')
    expect(none).not.toContain('記録の本文は')
  })

  it('記録: 資料名・短い id で指し、決まった項目の順・新しい日付から。項目で絞る・1つだけ読む・知らない資料は候補', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const all = await call(core, 'novel_get_material', { material: '江戸の暮らし' })
    expect(all).toContain(`=== 資料 ${shortId('material', s.materialA)}『江戸の暮らし』（山田） ===\n山田・2019\nタグ: 歴史・江戸\n--- 項目「要約」`)
    expect(all).toContain('--- 項目「要約」（2件）---')
    expect(all).toContain(`#### 要約（2026-10-01・手で記録）[${shortId('materialNote', s.firstNote)}]`)
    expect(all.indexOf('物売りの声')).toBeLessThan(all.indexOf('町の成り立ち'))
    const order = ['要約', '創作に役立つ知識', 'サンプルシーン', '年表'].map((n) => all.indexOf(`--- 項目「${n}」`))
    expect(order.every((x) => x >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    // 項目は前後の空白の違いでも同じ
    const only = await call(core, 'novel_get_material', { material: shortId('material', s.materialA), sections: [' 創作に役立つ知識 '] })
    expect(only).toContain('長屋の家賃')
    expect(only).not.toContain('町の成り立ち')
    const one = await call(core, 'novel_get_material', { material: s.materialA, note_id: shortId('materialNote', s.firstNote) })
    expect(one).toContain(`=== 資料 ${shortId('material', s.materialA)}『江戸の暮らし』（山田） の記録 ===`)
    // 1つだけ読む時も、資料全体を読む時と同じく書誌とタグを先頭に出す
    expect(one).toContain('タグ: 歴史・江戸\n#### 要約')
    expect(one).toContain('町の成り立ち')
    expect(one).not.toContain('物売りの声')
    const noNote = await core.callTool('novel_get_material', { material: s.materialA, note_id: 'k:ffffffff' })
    expect(noNote.isError).toBe(true)
    expect(noNote.text).toContain("記録 'k:ffffffff' が『江戸の暮らし』に見つかりません")
    expect(noNote.text).toContain(`${shortId('materialNote', s.firstNote)}「要約」2026-10-01`)
    const none = await core.callTool('novel_get_material', { material: '無い資料' })
    expect(none.isError).toBe(true)
    expect(none.text).toContain("資料 '無い資料' が見つかりません")
    expect(none.text).toContain('『江戸の暮らし』')
    const noSection = await core.callTool('novel_get_material', { material: s.materialA, sections: ['人物'] })
    expect(noSection.isError).toBe(true)
    expect(noSection.text).toContain('『江戸の暮らし』には項目「人物」の記録がありません')
    expect(noSection.text).toContain('項目「年表」')
    expect(await call(core, 'novel_get_material', { material: '刀剣の手入れ' })).toContain('記録はまだありません')
    const missing = await core.callTool('novel_get_material', {})
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('material がありません')
  })

  it('資料名が同じ資料が2つあれば、d:… の短い id で指すよう候補を返す', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const twin = addMaterial(s.data, { name: '江戸の暮らし', author: '田中' })
    const { core } = await pairedCore(fake, twin.data)
    const r = await core.callTool('novel_get_material', { material: '江戸の暮らし' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('資料名「江戸の暮らし」の資料が2件あります。d:… の短い id で指してください')
    expect(r.text).toContain(`${shortId('material', twin.result)}『江戸の暮らし』（田中）`)
    expect(await call(core, 'novel_get_material', { material: shortId('material', twin.result) })).toContain('記録はまだありません')
  })

  it('長い記録は char_budget 字ずつ、cursor で続きを読む（項目の絞り込みも続く）。ほかのツールの cursor は断る', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const long = Array.from({ length: 80 }, (_, i) => `段落${i + 1}。${'あ'.repeat(95)}`).join('\n')
    const data = addMaterialNote(s.data, s.materialA, { section: '描写に使える部分', body: long, runDate: '2026-10-25' }).data
    const { core } = await pairedCore(fake, data)
    const first = await call(core, 'novel_get_material', { material: s.materialA, sections: ['描写に使える部分'], char_budget: 2_000 })
    const cursor = /続き: cursor="([^"]+)"/.exec(first)![1]
    expect(first).toContain('段落1。')
    expect(first).not.toContain('段落80。')
    let text = first
    let next: string | undefined = cursor
    for (let i = 0; next && i < 20; i++) {
      const page = await call(core, 'novel_get_material', { cursor: next, char_budget: 2_000 })
      expect(page).toContain('『江戸の暮らし』の記録の続き')
      expect(page).not.toContain('町の成り立ち')
      text += page
      next = /続き: cursor="([^"]+)"/.exec(page)?.[1]
    }
    expect(next).toBeUndefined()
    expect(text).toContain('段落80。')
    expect((await core.callTool('novel_get_material', { cursor: 'xyz' })).isError).toBe(true)
    // 相対比較の分析の cursor・一覧の cursor は資料の記録の続きにならない
    const benchCursor = encodeCursor({ k: 'bench', t: s.materialA, which: 'work', id: s.materialA, o: 0 })
    const wrong = await core.callTool('novel_get_material', { cursor: benchCursor })
    expect(wrong.isError).toBe(true)
    expect(wrong.text).toContain('novel_get_material の続きの cursor をそのまま渡してください')
    const back = await core.callTool('novel_get_bench_analysis', { cursor })
    expect(back.isError).toBe(true)
  })
})

/** 棚に n 個の資料（資料ごとに項目 k 個の記録）。資料名は name(i)、タグは tags(i) */
function bigShelf(
  n: number,
  k: number,
  name: (i: number) => string = (i) => `資料${String(i + 1).padStart(3, '0')}`,
  tags: (i: number) => string[] | undefined = () => undefined,
) {
  let data: AppData = novel(['冒頭の本文。'], { name: '星の庭' }).data
  const ids: ID[] = []
  for (let i = 0; i < n; i++) {
    const t = tags(i)
    const m = addMaterial(data, { name: name(i), author: '著者', ...(t ? { tags: t } : {}) })
    data = m.data
    ids.push(m.result)
    for (let j = 0; j < k; j++)
      data = addMaterialNote(data, m.result, { section: `項目${j + 1}・とても長い項目の名前`, body: '本文', runDate: '2026-10-30' }).data
  }
  return { data, ids }
}

/** 一覧の d:… を出てきた順に */
const listedIds = (text: string) => [...text.matchAll(/^(d:[0-9a-z]+)『/gm)].map((m) => m[1])
const nextCursor = (text: string) => /続き: cursor="([^"]+)"/.exec(text)?.[1]
const refs = (ids: readonly ID[]) => ids.map((id) => shortId('material', id))

describe('一覧の絞り込みと続き（novel_list_materials の names・exclude_names・tags・char_budget・cursor）', () => {
  it('names で資料名に含む資料だけ、exclude_names で除き、tags でそのタグをすべて持つ資料だけ（全角と半角・空白の違いは問わない）', async () => {
    const fake = new FakeFirebase()
    const names = ['江戸の暮らし', '江戸の町並み 図録', '戦国の城', '外科の歴史', '刀剣の手入れ', 'ＳＦの小道具', '料理の本']
    const tags = [['歴史', '江戸', '風俗'], ['歴史', '江戸'], ['歴史', '戦闘'], ['医療', '歴史'], ['武器', '戦闘'], ['ＳＦ'], undefined]
    const s = bigShelf(names.length, 1, (i) => names[i], (i) => tags[i])
    const { core } = await pairedCore(fake, s.data)
    const edo = await call(core, 'novel_list_materials', { names: ['江戸'] })
    expect(edo).toContain('=== 資料（資料名に「江戸」を含む資料 2件／全7件。作者が創作のために読む資料）===')
    expect(listedIds(edo)).toEqual(refs([s.ids[0], s.ids[1]]))
    expect(edo).toContain('記録の本文は novel_get_material（material に d:…）で読んでください。')
    expect(edo).not.toContain('続き: cursor=')
    // 全角の英字・続く空白でも同じ（NFKC・空白をまとめて照らす）
    const sf = await call(core, 'novel_list_materials', { names: ['SFの', '町並み　図録'] })
    expect(listedIds(sf)).toEqual(refs([s.ids[1], s.ids[5]]))
    expect(sf).toContain('資料名に「SFの」「町並み　図録」のどれかを含む資料 2件／全7件')
    const noBook = await call(core, 'novel_list_materials', { exclude_names: ['図録', '江戸'] })
    expect(listedIds(noBook)).toEqual(refs(s.ids.slice(2)))
    expect(noBook).toContain('資料名に「図録」「江戸」のどれも含まない資料 5件／全7件')
    // タグ: そのタグを持つ資料だけ（タグの無い資料は出ない）
    const history = await call(core, 'novel_list_materials', { tags: ['歴史'] })
    expect(listedIds(history)).toEqual(refs(s.ids.slice(0, 4)))
    expect(history).toContain('=== 資料（タグ「歴史」を持つ資料 4件／全7件。作者が創作のために読む資料）===')
    expect(history).toContain('  タグ: 医療・歴史')
    // いくつか渡せば、すべてのタグを持つ資料だけ（同じタグは1つに数える）
    const edoHistory = await call(core, 'novel_list_materials', { tags: ['歴史', ' 江戸 ', '江戸'] })
    expect(listedIds(edoHistory)).toEqual(refs([s.ids[0], s.ids[1]]))
    expect(edoHistory).toContain('=== 資料（タグ「歴史」「江戸」をすべて持つ資料 2件／全7件。作者が創作のために読む資料）===')
    const battle = await call(core, 'novel_list_materials', { tags: ['戦闘', '武器'] })
    expect(listedIds(battle)).toEqual(refs([s.ids[4]]))
    // 全角と半角の違いは問わない。タグは部分一致ではなく、名前そのもので照らす
    expect(listedIds(await call(core, 'novel_list_materials', { tags: ['SF'] }))).toEqual(refs([s.ids[5]]))
    const part = await call(core, 'novel_list_materials', { tags: ['歴'] })
    expect(part).toContain('（タグ「歴」を持つ資料はありません）')
    expect(listedIds(part)).toEqual([])
    const both = await call(core, 'novel_list_materials', { names: ['の'], exclude_names: ['江戸'], tags: ['歴史'] })
    expect(listedIds(both)).toEqual(refs([s.ids[2], s.ids[3]]))
    expect(both).toContain('資料名に「の」を含む・「江戸」を含まない・タグ「歴史」を持つ資料 2件／全7件')
    const none = await call(core, 'novel_list_materials', { tags: ['料理'] })
    expect(none).toContain('（タグ「料理」を持つ資料はありません）')
    expect(listedIds(none)).toEqual([])
    expect(none).not.toContain('記録の本文は')
    // 絞り込まなければ全部（タグの無い資料にはタグの行を出さない）
    const all = await call(core, 'novel_list_materials')
    expect(all).toContain('=== 資料（7件。作者が創作のために読む資料）===')
    expect(listedIds(all)).toHaveLength(7)
    expect(all).toContain(`${shortId('material', s.ids[6])}『料理の本』（著者） 著者\n  記録 1件`)
  })

  it('長い棚は資料の途中で切らずに返し、cursor だけで続きを読む（重なり・抜けなし）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(24, 10)
    const { core } = await pairedCore(fake, s.data)
    const seen: string[] = []
    let text = await call(core, 'novel_list_materials', { char_budget: 2_000 })
    expect(text).toContain('=== 資料（24件。作者が創作のために読む資料）===')
    let pages = 1
    for (;;) {
      expect(text.length).toBeLessThanOrEqual(2_000)
      seen.push(...listedIds(text))
      const next = nextCursor(text)
      if (!next) break
      expect(text.trimEnd().split('\n').at(-1)).toMatch(/^続き: cursor="[^"]+"（結果が長いため、ここで切りました。残り\d+件は、この cursor で読めます）$/)
      // 資料の行の途中では切らない（最後の資料の「記録」の行まである）
      expect(text.split('\n').at(-2)).toMatch(/^ {2}記録 10件/)
      text = await call(core, 'novel_list_materials', { cursor: next })
      pages++
      expect(text).toMatch(/^=== 資料の続き（24件のうち\d+件目から／全24件）===/)
    }
    expect(pages).toBeGreaterThan(2)
    expect(seen).toEqual(refs(s.ids))
    expect(text).toContain('記録の本文は novel_get_material（material に d:…）で読んでください。')
  })

  it('絞り込みの続き: cursor だけで同じ条件（タグも）。違う条件を一緒に渡すと断る。読めない cursor・相対比較の cursor も断る', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(
      12,
      10,
      (i) => `資料${i + 1}`,
      (i) => (i % 2 ? ['歴史', '江戸'] : ['料理']),
    )
    const { core } = await pairedCore(fake, s.data)
    const first = await call(core, 'novel_list_materials', { tags: ['歴史', '江戸'], char_budget: 2_000 })
    const next = nextCursor(first)!
    expect(next).toBeTruthy()
    const second = await call(core, 'novel_list_materials', { cursor: next })
    expect(second).toContain('=== 資料の続き（タグ「歴史」「江戸」をすべて持つ資料 6件のうち')
    const ids = [...listedIds(first), ...listedIds(second)]
    const history = refs(s.ids.filter((_, i) => i % 2))
    expect(ids.every((id) => history.includes(id))).toBe(true)
    // 同じ条件を一緒に渡すのはよい・違う条件は断る
    expect(await call(core, 'novel_list_materials', { cursor: next, tags: ['江戸', '歴史'] })).toBe(second)
    for (const other of [{ tags: ['歴史'] }, { tags: ['料理'] }, { names: ['資料1'] }, { exclude_names: ['資料1'] }]) {
      const r = await core.callTool('novel_list_materials', { cursor: next, ...other })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('cursor が別の条件のものです（cursor だけを渡すか、同じ names・exclude_names・tags で渡してください）')
    }
    const bad = await core.callTool('novel_list_materials', { cursor: 'abc' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('cursor が読めません（novel_list_materials の続きの cursor をそのまま渡してください）')
    const benchList = await core.callTool('novel_list_materials', { cursor: encodeCursor({ k: 'benchList', n: [], x: [], a: 'x', o: 0 }) })
    expect(benchList.isError).toBe(true)
    // 資料の一覧の cursor は、相対比較の一覧の続きにもならない
    expect((await core.callTool('novel_list_bench_works', { cursor: next })).isError).toBe(true)
    const badTags = await core.callTool('novel_list_materials', { tags: 'abc' })
    expect(badTags.isError).toBe(true)
    expect(badTags.text).toContain('names・exclude_names・tags は文字列の配列にしてください')
    expect(badTags.text).toContain('tags は1つ20字まで')
    expect((await core.callTool('novel_list_materials', { tags: ['あ'.repeat(21)] })).isError).toBe(true)
    expect((await core.callTool('novel_list_materials', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).isError).toBe(true)
  })

  it('前のページの最後の資料が消えていても、その次の資料から続ける。最後まで読んだ後は「この後の資料はありません」', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(5, 1)
    const { core } = await pairedCore(fake, s.data)
    const third = s.data.materials[s.ids[2]]
    const cursor = encodeCursor({ k: 'materialList', n: [], x: [], t: [], a: 'gone-id', o: third.order })
    const rest = await call(core, 'novel_list_materials', { cursor })
    expect(listedIds(rest)).toEqual(refs([s.ids[3], s.ids[4]]))
    expect(rest).toContain('=== 資料の続き（5件のうち4件目から／全5件）===')
    const end = await call(core, 'novel_list_materials', {
      cursor: encodeCursor({ k: 'materialList', n: [], x: [], t: [], a: s.ids[4], o: s.data.materials[s.ids[4]].order }),
    })
    expect(end).toContain('（この後の資料はありません）')
    expect(listedIds(end)).toEqual([])
  })

  it('残りが char_budget に収まれば1回で全部（続きの行の分を空けて切らない）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(5, 10)
    const { core } = await pairedCore(fake, s.data)
    const whole = await call(core, 'novel_list_materials')
    const budget = whole.length
    expect(budget).toBeGreaterThan(1_500)
    expect(budget).toBeLessThan(2_500)
    const one = await call(core, 'novel_list_materials', { char_budget: Math.max(2_000, budget) })
    expect(one).toBe(whole)
    expect(nextCursor(one)).toBeUndefined()
  })

  it('続きは最後に出した資料の今の位置の次から（アプリで並べ替えて並び順の数が振り直されても抜けない）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(5, 1)
    const { core } = await pairedCore(fake, s.data)
    const cursor = encodeCursor({ k: 'materialList', n: [], x: [], t: [], a: s.ids[1], o: 1_000 })
    const rest = await call(core, 'novel_list_materials', { cursor })
    expect(listedIds(rest)).toEqual(refs([s.ids[2], s.ids[3], s.ids[4]]))
  })

  it('1つの資料の行だけで char_budget に収まらない時は、その行を切って印を付け、記録の数は残す', async () => {
    const fake = new FakeFirebase()
    let data = bigShelf(1, 1).data
    const big = addMaterial(data, { name: '項目の多い資料', author: '著者' })
    data = big.data
    for (let j = 0; j < 80; j++)
      data = addMaterialNote(data, big.result, { section: `項目${j + 1}・とても長い項目の名前`, body: '本文', runDate: '2026-10-30' }).data
    const after = addMaterial(data, { name: '後の資料', author: '著者' })
    data = after.data
    const { core } = await pairedCore(fake, data)
    const seen: string[] = []
    let text = await call(core, 'novel_list_materials', { char_budget: 2_000 })
    let clipped = ''
    for (let n = 0; n < 10; n++) {
      expect(text.length).toBeLessThanOrEqual(2_000)
      seen.push(...listedIds(text))
      if (text.includes('『項目の多い資料』')) clipped = text
      const next = nextCursor(text)
      if (!next) break
      text = await call(core, 'novel_list_materials', { cursor: next })
    }
    expect(clipped).toContain('  記録 80件')
    expect(clipped).toContain('（この資料の行は長いため、ここまで）')
    expect(seen).toHaveLength(3)
    expect(seen).toContain(shortId('material', after.result))
  })

  it('省略時は結果の上限まで1回で返し、超える棚は資料の切れ目で続きにする（途中で切れた印は出ない）', async () => {
    const fake = new FakeFirebase()
    const s = bigShelf(110, 30)
    const { core } = await pairedCore(fake, s.data)
    const first = await call(core, 'novel_list_materials')
    expect(first.length).toBeGreaterThan(90_000)
    expect(first.length).toBeLessThanOrEqual(100_000)
    expect(first).not.toContain('[...]')
    expect(first).toContain('結果が長いため、ここで切りました')
    const next = nextCursor(first)!
    const second = await call(core, 'novel_list_materials', { cursor: next })
    expect([...listedIds(first), ...listedIds(second)]).toEqual(refs(s.ids))
    expect(nextCursor(second)).toBeUndefined()
  })
})

describe('書き込み（novel_add_material_notes）', () => {
  /** コネクタが作った文書（棚に置いておいた資料は端末が書いたもの） */
  const docsOf = (fake: FakeFirebase, table: string) =>
    fake
      .recordDocs(OWNER)
      .filter((d) => d.name.includes(`/${table}:`) && d.fields.device?.stringValue === 'claude-connector')
  /** コネクタが作った文書を、端末と同じ decodeRecord で読んだもの */
  const decoded = (fake: FakeFirebase, table: string) =>
    docsOf(fake, table).map(
      (d) =>
        decodeRecord(
        {
          table,
          id: d.fields.id.stringValue,
          json: d.fields.json.stringValue,
          chunks: 0,
          deleted: false,
          hash: d.fields.hash.stringValue,
          updated: null,
          device: 'claude-connector',
        } as unknown as RecordDoc,
        () => undefined,
        ) as unknown as Record<string, unknown>,
    )

  it('資料の棚に無い資料は new_material を付けた時だけ作り、記録を項目ごとに作る（同じ内容は重複）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    const items = [
      { section: '要約', body_markdown: '## 要約\n第1章 外科の始まり。', run_date: '2026-10-30' },
      { section: '描写に使える部分', body_markdown: '- 消毒の匂い（第2章）', run_date: '2026-10-30' },
    ]
    const missing = await core.callTool('novel_add_material_notes', { material: '外科の歴史', items })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain("資料 '外科の歴史' が見つかりません")
    expect(missing.text).toContain('new_material')
    expect(docsOf(fake, 'materials')).toHaveLength(0)

    const input = {
      material: '外科の歴史',
      // タグ・分野を付けて送っても、資料には入れない（タグは作者が付けて管理する）
      new_material: { name: '外科の歴史', author: '高橋', pdf_place: 'プロジェクト「資料」', tags: ['医療'], field: '医療' },
      items,
      model: 'claude-test',
    }
    const r = await core.callTool('novel_add_material_notes', input)
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('資料に記録を追加: 追加 2件')
    expect(r.text).toContain('『外科の歴史』（高橋） を資料に追加しました')
    expect(r.text).toContain('アプリのホームの「資料」に、各端末が同期すると出ます')
    expect(r.text).not.toContain('相対比較')
    expect(r.structured).toMatchObject({ created: [{ id: expect.stringMatching(/^k:/) }, { id: expect.stringMatching(/^k:/) }] })
    expect(docsOf(fake, 'materials')).toHaveLength(1)
    expect(docsOf(fake, 'materialNotes')).toHaveLength(2)
    const [made] = decoded(fake, 'materials')
    expect(made).toMatchObject({ name: '外科の歴史', author: '高橋', pdfPlace: 'プロジェクト「資料」', note: '', source: 'claude' })
    expect(made).not.toHaveProperty('tags')
    expect(made).not.toHaveProperty('field')
    expect(decoded(fake, 'materialNotes').every((n) => n.materialId === made.id)).toBe(true)
    expect(decoded(fake, 'materialNotes')[0]).toMatchObject({ source: 'claude', model: 'claude-test', runDate: '2026-10-30' })
    // 一覧にもすぐ出る（自分の書き込みを写しに入れる）
    expect(await call(core, 'novel_list_materials', { names: ['外科'] })).toContain('『外科の歴史』（高橋） 高橋\n  記録 2件')
    expect(await call(core, 'novel_list_materials', { tags: ['医療'] })).toContain('（タグ「医療」を持つ資料はありません）')
    // 答えの資料の d:… で、そのまま次の記録を足せる
    const ref = /資料 (d:[0-9A-Za-z]+)『外科の歴史』（高橋） を資料に追加しました/.exec(r.text)![1]
    clock.now += 20_000
    const again = await core.callTool('novel_add_material_notes', input)
    expect(again.text).toContain('重複 2件')
    expect(again.text).toContain(`補足: 資料 ${ref}『外科の歴史』（高橋） には何も追加していません`)
    expect(again.text).not.toContain('を資料に追加しました')
    expect(docsOf(fake, 'materialNotes')).toHaveLength(2)
    // 資料名で指せば、資料はもう作らない。既にある資料に足した時も、答えに資料の d:… を出す
    const more = await core.callTool('novel_add_material_notes', {
      material: '外科の歴史',
      items: [{ section: '創作に役立つ知識', body_markdown: '- 麻酔の普及は19世紀（第4章）' }],
    })
    expect(more.text).toContain('追加 1件')
    expect(more.text).toContain(`補足: 資料 ${ref}『外科の歴史』（高橋） に追加しました`)
    expect(docsOf(fake, 'materials')).toHaveLength(1)
    const byRef = await core.callTool('novel_add_material_notes', {
      material: ref,
      items: [{ section: 'サンプルシーン', body_markdown: '場面: 野戦病院。\n灯りが揺れた。' }],
    })
    expect(byRef.text).toContain('追加 1件')
    expect(byRef.text).toContain(`資料 ${ref}『外科の歴史』（高橋） に追加しました`)
    // 読み返すと、決まった項目の順に並ぶ（run_date を省いた記録は今日の日付）
    const read = await call(core, 'novel_get_material', { material: ref })
    const order = ['要約', '創作に役立つ知識', '描写に使える部分', 'サンプルシーン'].map((n) => read.indexOf(`--- 項目「${n}」`))
    expect(order.every((x) => x >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(read).toContain('#### 創作に役立つ知識（2026-10-29・Claude）')
  })

  it('資料の棚に無い資料で記録を1つも作れなければ、資料も作らず、作っていないことを答える', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const r = await core.callTool('novel_add_material_notes', {
      material: '外科の歴史',
      new_material: { name: '外科の歴史', author: '高橋' },
      items: [{ section: '', body_markdown: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('形が違う 1件')
    expect(r.text).toContain('補足: 記録を1つも追加しなかったため、資料『外科の歴史』（高橋）は資料の棚に追加していません')
    expect(r.text).not.toContain('d:')
    expect(docsOf(fake, 'materials')).toHaveLength(0)
  })

  it('資料名の全角と半角・全角の空白の違いでは、別の資料を作らない（資料の棚の資料に足す）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const up = addMaterial(s.data, { name: '江戸の暮らし　上', author: '山田' })
    const sf = addMaterial(up.data, { name: 'ＳＦ考証読本', author: '' })
    const { core } = await pairedCore(fake, sf.data)
    for (const name of ['江戸の暮らし 上', 'SF考証読本']) {
      const r = await core.callTool('novel_add_material_notes', {
        material: name,
        new_material: { name, author: name === 'SF考証読本' ? '' : '山田' },
        items: [{ section: '要約', body_markdown: `## 要約\n${name}`, run_date: '2026-10-30' }],
      })
      expect(r.text).toContain('追加 1件')
      expect(r.text).not.toContain('を資料に追加しました')
      const material =
        name === 'SF考証読本' ? `${shortId('material', sf.result)}『ＳＦ考証読本』` : `${shortId('material', up.result)}『江戸の暮らし　上』（山田）`
      expect(r.text).toContain(`資料 ${material} に追加しました`)
    }
    expect(docsOf(fake, 'materials')).toHaveLength(0)
    const list = await call(core, 'novel_list_materials')
    expect(list.match(/『江戸の暮らし/g)).toHaveLength(2)
    expect(list).not.toContain('『SF考証読本』')
  })

  it('資料名が同じでも new_material の著者が違えば別の資料として作り、同じ資料名・著者ならその資料に足す', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core, clock } = await pairedCore(fake, s.data)
    // 棚の『刀剣の手入れ』は佐藤。田中の同名の資料は別の資料
    const input = {
      material: '刀剣の手入れ',
      new_material: { name: '刀剣の手入れ', author: '田中', year: '2001' },
      items: [{ section: '要約', body_markdown: '## 要約\n田中の『刀剣の手入れ』', run_date: '2026-10-30' }],
    }
    const r = await core.callTool('novel_add_material_notes', input)
    expect(r.text).toContain('追加 1件')
    expect(r.text).toContain('『刀剣の手入れ』（田中） を資料に追加しました')
    expect(r.text).toContain(`著者の違う同名の資料 ${shortId('material', s.materialB)}『刀剣の手入れ』（佐藤） があるため、別の資料として足しました`)
    expect(docsOf(fake, 'materials')).toHaveLength(1)
    clock.now += 20_000
    const again = await core.callTool('novel_add_material_notes', {
      ...input,
      items: [{ section: '描写に使える部分', body_markdown: '- 打ち粉の音', run_date: '2026-10-30' }],
    })
    expect(again.text).toContain('追加 1件')
    expect(again.text).not.toContain('を資料に追加しました')
    expect(docsOf(fake, 'materials')).toHaveLength(1)
    // 佐藤の資料には何も足していない
    const sato = await call(core, 'novel_get_material', { material: shortId('material', s.materialB) })
    expect(sato).not.toContain('田中')
    const list = await call(core, 'novel_list_materials')
    expect(list).toContain('『刀剣の手入れ』（田中）')
    expect(list).toContain('『刀剣の手入れ』（佐藤）')
  })

  it('手で足して削除した資料（ゴミ箱に同じ資料名）は new_material で作り直さない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, deleteMaterial(s.data, s.materialB))
    const r = await core.callTool('novel_add_material_notes', {
      material: '刀剣の手入れ',
      new_material: { name: '刀剣の手入れ', author: '佐藤' },
      items: [{ section: '要約', body_markdown: '## 要約\n手入れの道具。', run_date: '2026-10-30' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('資料『刀剣の手入れ』は以前に削除されています')
    expect(r.text).toContain('ゴミ箱から戻してください')
    expect(docsOf(fake, 'materials')).toHaveLength(0)
    expect(docsOf(fake, 'materialNotes')).toHaveLength(0)
    expect(await call(core, 'novel_list_materials')).not.toContain('『刀剣の手入れ』')
    // 棚にある資料はそのまま書ける
    const ok = await core.callTool('novel_add_material_notes', {
      material: '江戸の暮らし',
      items: [{ section: '描写に使える部分', body_markdown: '- 物売りの声' }],
    })
    expect(ok.text).toContain('追加 1件')
    expect(ok.text).toContain(`資料 ${shortId('material', s.materialA)}『江戸の暮らし』（山田） に追加しました`)
  })

  it('相対比較の作品と資料は別の棚（同じ名前でも、資料のツールは相対比較の作品に足さない）', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const bench = addBenchWork(s.data, { name: '外科の歴史', author: '高橋' })
    const { core } = await pairedCore(fake, bench.data)
    const r = await core.callTool('novel_add_material_notes', {
      material: '外科の歴史',
      items: [{ section: '要約', body_markdown: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("資料 '外科の歴史' が見つかりません")
    expect((await core.callTool('novel_get_material', { material: shortId('benchWork', bench.result) })).isError).toBe(true)
    expect((await core.callTool('novel_get_bench_analysis', { work: shortId('material', s.materialA) })).isError).toBe(true)
    expect(await call(core, 'novel_list_materials')).not.toContain('外科の歴史')
  })

  it('大きすぎる記録は作らず、番号を付けて分けるよう返す。items は20件まで。「書き込みを許可」が外れていれば書かない', async () => {
    const fake = new FakeFirebase()
    const s = shelf()
    const { core } = await pairedCore(fake, s.data)
    const big = await core.callTool('novel_add_material_notes', {
      material: s.materialA,
      items: [{ section: '創作に役立つ知識', body_markdown: 'あ'.repeat(250_000) }],
    })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('body_markdown を2つ以上に分け')
    expect(big.text).toContain('各部の body_markdown の1行目の先頭に「（1/2）」')
    expect(big.text).toContain(`資料 ${shortId('material', s.materialA)}『江戸の暮らし』（山田） には何も追加していません`)
    expect(docsOf(fake, 'materialNotes')).toHaveLength(0)
    const many = await core.callTool('novel_add_material_notes', {
      material: s.materialA,
      items: Array.from({ length: 21 }, (_, i) => ({ section: '要約', body_markdown: `${i}` })),
    })
    expect(many.isError).toBe(true)
    expect(many.text).toContain('items が多すぎます（1回 20 件まで')

    const fake2 = new FakeFirebase()
    const off = await pairedCore(fake2, s.data, { writes: false })
    const r = await off.core.callTool('novel_add_material_notes', {
      material: s.materialA,
      items: [{ section: '要約', body_markdown: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('書き込みは停止中')
    expect(await call(off.core, 'novel_list_materials')).toContain('『江戸の暮らし』')
  })
})
