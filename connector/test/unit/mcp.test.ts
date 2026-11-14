// MCP の層: ツールの一覧（名前・題・ヒント・並び）、JSON Schema での入力の確かめ（cf-worker）、
// initialize・tools/list は Vault を呼ばないこと、書き込みツールの structuredContent。
import { createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import { beforeAll, describe, expect, it } from 'vitest'
import { novel } from '../../../src/test/claudeFixture'
import { MATERIAL_SECTION_GUIDE } from '../../../src/claude/material'
import { MATERIAL_SECTIONS } from '../../../src/domain/materialOps'
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions'
import { TOOL_SCHEMAS } from '../../src/mcp/schemas.gen'
import { createServer } from '../../src/mcp/server'
import { TOOL_DEFS } from '../../src/mcp/tools'
import type { VaultCore } from '../../src/vault/core'
import { FakeFirebase } from '../support/fakeFirebase'
import { pairedCore } from '../support/harness'

const EXPECTED_ORDER = [
  'novel_status',
  'novel_list_titles',
  'novel_get_outline',
  'novel_read_text',
  'novel_list_versions',
  'novel_search_text',
  'novel_get_notes',
  'novel_get_strategy',
  'novel_get_critique',
  'novel_list_proofreading',
  'novel_list_bench_works',
  'novel_get_bench_analysis',
  'novel_list_materials',
  'novel_get_material',
  'novel_add_proofreading',
  'novel_add_revision_ideas',
  'novel_add_strategy_note',
  'novel_save_critique_prompt',
  'novel_add_critique_result',
  'novel_add_bench_analysis',
  'novel_add_material_notes',
  'novel_add_ideas',
  'novel_append_to_idea',
  'novel_move_cards_to_trash',
]

describe('ツールの決まり', () => {
  it('名前は ASCII の novel_*（64字以内・重ならない・決まった並び）、題は日本語、ヒントは4つとも', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(EXPECTED_ORDER)
    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(/^novel_[a-z_]+$/)
      expect(t.name.length).toBeLessThanOrEqual(64)
      expect(t.title).toMatch(/[ぁ-んァ-ヶ一-龠]/)
      expect(t.annotations.title).toBe(t.title)
      expect(Object.keys(t.annotations).sort()).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint', 'title'])
      expect(t.annotations.openWorldHint).toBe(false)
      // 2.7: カードを消すのはゴミ箱へ移すツールだけ（claude.ai でこれだけ「承認が必要」にしておける）
      expect(t.annotations.destructiveHint).toBe(t.kind === 'trash')
      expect(t.annotations.idempotentHint).toBe(true)
      expect(t.annotations.readOnlyHint).toBe(t.kind === 'read')
      expect(t.description.length).toBeGreaterThan(60)
    }
    expect(new Set(TOOL_DEFS.map((t) => t.name)).size).toBe(TOOL_DEFS.length)
    // 2.8: 読むツール 14・書き込みツール 9（アイデアを足す・アイデアに追記を含む）・ゴミ箱へ移すツール 1
    expect(TOOL_DEFS).toHaveLength(24)
    expect(TOOL_DEFS.filter((t) => t.kind === 'read')).toHaveLength(14)
    expect(TOOL_DEFS.filter((t) => t.kind === 'write')).toHaveLength(9)
    expect(TOOL_DEFS.filter((t) => t.kind === 'trash').map((t) => [t.name, t.title])).toEqual([
      ['novel_move_cards_to_trash', 'カードをゴミ箱へ移す'],
    ])
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200)
    // 2.8: 1,000字未満（相対比較・資料・用語・文字数の行は 2.7 と1字も違わない）
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1000)
    const lines = SERVER_INSTRUCTIONS.split('\n')
    for (const line of [
      '相対比較は、作者が比べるために読む既存の作品のホームの棚（「ベンチ作品」「比較作品」とも呼ぶ。PDF は claude.ai のプロジェクトにあり、ここには作品の情報と分析だけ）。批評では novel_get_bench_analysis で分析を読めます。',
      '資料は、作者が創作のために読む資料（主に買った書籍。「参考資料」「資料本」とも呼ぶ）のホームの棚です（PDF は claude.ai のプロジェクトにあり、ここには情報と記録だけ）。設定や描写には novel_get_material で記録を読めます。',
      '用語: タイトル＞章＞話（第n話・特殊ブロック・幕）＞稿。採用原稿は、話ごとに採用している稿の本文（幕に分けた話は各幕の採用稿をつないだもの）。',
      '文字数は空白・改行・ルビの記法と読みを除いて数え、日付は日本時間です。',
    ])
      expect(lines).toContain(line)
  })

  it('アイデアのツール（2.8）: 書き込みと同じヒント（何も消さないので「常に許可」にできる）・説明に場所・1行目・Markdown・読んでから追記', () => {
    const add = TOOL_DEFS.find((t) => t.name === 'novel_add_ideas')!
    const append = TOOL_DEFS.find((t) => t.name === 'novel_append_to_idea')!
    expect([add.title, append.title]).toEqual(['アイデアを足す', 'アイデアに追記'])
    for (const t of [add, append]) {
      expect(t.kind).toBe('write')
      expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    }
    for (const phrase of [
      'title_id を省くとどのタイトルにも属さないホームのアイデアに入れる',
      '「読む＋書き込む」の時だけ',
      '済みでないアイデアの先頭に、渡した順で並ぶ',
      '日本時間「2026/11/12 14:32」',
      '「2026/11/12 14:32　第3章の動機」',
      'Markdown の記号',
      '箇条書きは「・」、小見出しは【】で書く',
      '「Claude が作成」の印',
      '入れた場所（タイトル『…』のアイデアか、ホームのアイデア）と、足したアイデアの id（i:…）を出す',
      '本文（稿）は書き換えない',
    ])
      expect(add.description).toContain(phrase)
    for (const phrase of [
      '「2026/11/12のセッションで以下の内容へ変更」',
      '前の中身（作者がアプリで直した所も）は消さず、カードの並びの位置と「済み」も変えない',
      'そのチャットで自分が novel_add_ideas で足した時の答えに出た id だけ',
      '追記の前に必ず novel_get_notes（kind=ideas、ids にその id）で今の中身を読み',
      '「印: 」の後ろの8字を read_mark に渡す',
      '作者が直したアイデアにも追記できる',
      'アプリを開いて同期した時にカードに足される',
      '同じ内容を送り直しても増えない',
    ])
      expect(append.description).toContain(phrase)
    const notes = TOOL_DEFS.find((t) => t.name === 'novel_get_notes')!
    expect(notes.description).toContain('kind=ideas は title_id を省ける')
    expect(notes.description).toContain('作者が書いたホームのアイデアは返さない')
    expect(notes.description).not.toContain('どのタイトルにも属さないアイデアは返さない')
    expect(TOOL_DEFS.find((t) => t.name === 'novel_status')!.description).toContain('アイデアへの追記の依頼（アプリの同期待ち）の数')
    // 2.9: 複数の接続（どのアカウントの接続かを、アプリの一覧の名前と合わせられる）
    expect(TOOL_DEFS.find((t) => t.name === 'novel_status')!.description).toContain(
      'この接続の名前（アプリの 設定 → Claude 連携 の接続の一覧と同じ）',
    )
    const trash = TOOL_DEFS.find((t) => t.name === 'novel_move_cards_to_trash')!
    expect(trash.description).toContain('相対比較の分析（n:…）・資料の記録（k:…）・アイデア（i:…）を、アプリのゴミ箱へ移す')
    expect(trash.description).toContain('アイデアは、Claude の追記だけなら直していないものとして移せる')
    expect(trash.description).toContain('（アイデアは1行目と場所）')
    expect(SERVER_INSTRUCTIONS).toContain('i: アイデア')
    expect(SERVER_INSTRUCTIONS).toContain('Claude が作ったホームのアイデア')
    expect(SERVER_INSTRUCTIONS).toContain('（n:・k:・i:）')
    expect(SERVER_INSTRUCTIONS).toContain('Claude が作ったアイデアへの追記だけ')
    // ゴミ箱へ移すツールの入力の形は 2.7 のまま（cards。1〜20件・1つ80字まで）
    const cards = (TOOL_SCHEMAS.novel_move_cards_to_trash as { properties: { cards: Record<string, unknown> } }).properties.cards
    expect(cards).toMatchObject({ minItems: 1, maxItems: 20, items: { minLength: 1, maxLength: 80 } })
    expect(Object.keys((TOOL_SCHEMAS.novel_move_cards_to_trash as { properties: object }).properties)).toEqual(['cards'])
    expect(String(cards.description)).toContain('アイデア i:…')
  })

  it('数え方（2.9）: 文字数の行（そのまま）の次に、char_budget と「字目」は空白・改行も数える行。追加のツールの説明に字数', () => {
    const lines = SERVER_INSTRUCTIONS.split('\n')
    const at = lines.indexOf('文字数は空白・改行・ルビの記法と読みを除いて数え、日付は日本時間です。')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe('char_budget・「字目」は空白・改行も数えます。')
    for (const name of [
      'novel_add_bench_analysis',
      'novel_add_material_notes',
      'novel_add_critique_result',
      'novel_add_strategy_note',
      'novel_add_revision_ideas',
    ])
      expect(TOOL_DEFS.find((t) => t.name === name)!.description).toContain('字数（アプリと同じ数え方。空白・改行・ルビの記法と読みを除く')
    for (const name of ['novel_add_proofreading', 'novel_save_critique_prompt', 'novel_add_ideas'])
      expect(TOOL_DEFS.find((t) => t.name === name)!.description).not.toContain('アプリと同じ数え方')
  })

  it('数え方（2.9）: サーバーの説明に入らない、空白・改行も数える字数（一覧の「  分析 n件（n字）」・続きの「残り n字」「約n字」）は、ツールと入力の説明に書く', () => {
    // novel_list_bench_works の「  分析 n件（n字）」は V30 のまま（空白・改行・ルビの記法も数える）なので、説明で追加の答えの「字数:」と分ける
    const list = TOOL_DEFS.find((t) => t.name === 'novel_list_bench_works')!.description
    expect(list).toContain('後ろの（n字）は、ほかの一覧と違って空白・改行・ルビの記法と読みも数えた本文の長さの合計')
    expect(list).toContain('「n字以内」は追加の答えの「字数:」で確かめる')
    const budget = (tool: string) =>
      String((TOOL_SCHEMAS as Record<string, { properties: { char_budget: { description?: string } } }>)[tool].properties.char_budget.description)
    for (const tool of ['novel_get_strategy', 'novel_get_critique', 'novel_get_bench_analysis', 'novel_get_material', 'novel_get_notes'])
      expect(budget(tool)).toContain('この字数と続きの「残り n字」は空白・改行・ルビの記法も数える')
    expect(budget('novel_read_text')).toContain('この字数と続きの「約n字」は空白・改行も数える')
  })

  it('アイデアのフォルダ（2.9）: サーバーの説明は id の行に f: を足すだけ（1,000字未満）。一覧・ゴミ箱へ移すツールの説明にフォルダ', () => {
    expect(SERVER_INSTRUCTIONS).toContain('i: アイデア、f: そのフォルダ、x: 推敲案')
    expect(SERVER_INSTRUCTIONS.length).toBe(999)
    const notes = TOOL_DEFS.find((t) => t.name === 'novel_get_notes')!
    for (const phrase of [
      'アイデアのフォルダ（2段まで。【フォルダ】と f:…）ごとにまとめて出す',
      'ホームのフォルダは名前だけが見え、中は Claude が作ったアイデアだけ',
      'タイトルのフォルダはカードの数も出す',
      'ids に f:… を渡すと、そのフォルダ（中のフォルダも）のアイデアを本文まで返す',
      '「ホームのアイデア＞新作の相談＞2026/11/12　港町」',
    ])
      expect(notes.description, phrase).toContain(phrase)
    const trash = TOOL_DEFS.find((t) => t.name === 'novel_move_cards_to_trash')!
    expect(trash.description).toContain('アイデアのフォルダ（f:…）は移さない')
    // アイデアを足す: フォルダを先に聞く・任せる・空のフォルダは作らない・整理はできない（2.8 の言葉は上のテストのまま）
    const add = TOOL_DEFS.find((t) => t.name === 'novel_add_ideas')!
    for (const phrase of [
      'どのフォルダに入れますか',
      'placement="auto"',
      'placement="outside"',
      'folder も placement も無い時は足さずに断る',
      '空のフォルダは作らない',
      'フォルダの名前の変更・削除・移動と、カードの移動はできない',
      '「2026/11/12　{theme}」',
      '前の答えに出たフォルダの f:… を folder に渡す',
      // 続けて足す時は f:… だけ（1段目の f:… に theme を付けると、その中に2段目を作るため）
      '（theme・subfolder は渡さない。f:… だけなら、どちらの段でもそのフォルダにじかに入る）',
      '1段目を名前で folder だけに渡した時は、その中に2段目のフォルダ「2026/11/12　{theme}」',
      'カードと、Claude が作ったフォルダには「Claude が作成」の印が付く',
      '（フォルダが違っても）足さない',
    ])
      expect(add.description, phrase).toContain(phrase)
  })

  it('アイデアのツールの入力の形（cf-worker）: 1〜10件・名前は40字まで・中身の長さは入力の形では断らない', async () => {
    const v = new CfWorkerJsonSchemaValidator()
    const add = fromJsonSchema(TOOL_SCHEMAS.novel_add_ideas as never, v)
    const addOk = async (x: Record<string, unknown>) => {
      const r = await add['~standard'].validate(x)
      return !('issues' in r && r.issues?.length)
    }
    expect(await addOk({ items: [{ content: 'あ' }] })).toBe(true)
    expect(await addOk({ title_id: 't:1', items: [{ name: 'あ'.repeat(40), content: 'あ'.repeat(30_000) }], model: 'claude' })).toBe(true)
    expect(await addOk({ items: [] })).toBe(false)
    expect(await addOk({ items: Array.from({ length: 11 }, () => ({ content: 'x' })) })).toBe(false)
    expect(await addOk({ items: [{ name: 'あ'.repeat(41), content: 'x' }] })).toBe(false)
    // 2.9: フォルダ（80字まで）・テーマ（29字まで）・placement（auto か outside）
    expect(await addOk({ folder: '新作の相談', subfolder: '雨の駅', theme: 'あ'.repeat(29), items: [{ content: 'x' }] })).toBe(true)
    expect(await addOk({ placement: 'auto', theme: '港町', items: [{ content: 'x' }] })).toBe(true)
    expect(await addOk({ placement: 'outside', items: [{ content: 'x' }] })).toBe(true)
    expect(await addOk({ placement: 'inside', items: [{ content: 'x' }] })).toBe(false)
    expect(await addOk({ theme: 'あ'.repeat(30), items: [{ content: 'x' }] })).toBe(false)
    expect(await addOk({ folder: 'あ'.repeat(81), items: [{ content: 'x' }] })).toBe(false)
    expect(await addOk({ folder: '', items: [{ content: 'x' }] })).toBe(false)
    expect(await addOk({ items: [{ name: 'x' }] })).toBe(false)
    expect(await addOk({ title_id: '', items: [{ content: 'x' }] })).toBe(false)
    const append = fromJsonSchema(TOOL_SCHEMAS.novel_append_to_idea as never, v)
    const appendOk = async (x: Record<string, unknown>) => {
      const r = await append['~standard'].validate(x)
      return !('issues' in r && r.issues?.length)
    }
    expect(await appendOk({ idea_id: 'i:12345678', read_mark: 'k3f9a2b1', content: 'あ'.repeat(30_000) })).toBe(true)
    expect(await appendOk({ idea_id: 'i:1', read_mark: 'x' })).toBe(false)
    expect(await appendOk({ idea_id: 'i:1', content: 'x' })).toBe(false)
    expect(await appendOk({ idea_id: 'i:1', read_mark: 'x'.repeat(21), content: 'x' })).toBe(false)
    expect(await appendOk({ idea_id: 'x'.repeat(81), read_mark: 'x', content: 'x' })).toBe(false)
    // novel_get_notes: kind=ideas の時は title_id を省ける（入力の形では kind に関係なく省ける。ツールが設定項目・メモを断る）
    const notes = fromJsonSchema(TOOL_SCHEMAS.novel_get_notes as never, v)
    const r = await notes['~standard'].validate({ kind: 'ideas' })
    expect('issues' in r && r.issues).toBeFalsy()
  })

  it('既定値を省いた呼び出しも、cf-worker の検証で通る（JSON Schema は io: input から作っている）', async () => {
    const v = new CfWorkerJsonSchemaValidator()
    const read = fromJsonSchema(TOOL_SCHEMAS.novel_read_text as never, v)
    const ok = await read['~standard'].validate({ title_id: 't:12345678' })
    expect('issues' in ok && ok.issues).toBeFalsy()
    const bad = await read['~standard'].validate({ char_budget: 10 })
    expect('issues' in bad && bad.issues?.length).toBeTruthy()
    const proof = fromJsonSchema(TOOL_SCHEMAS.novel_add_proofreading as never, v)
    const p = await proof['~standard'].validate({
      title_id: 't:1',
      items: [{ piece: '#1', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }],
    })
    expect('issues' in p && p.issues).toBeFalsy()
    const wrong = await proof['~standard'].validate({ title_id: 't:1', items: [{ piece: '#1', excerpt: 'x', category: 'typos', reason: 'r' }] })
    expect('issues' in wrong && wrong.issues?.length).toBeTruthy()
    // 長い文章は入力の形の確かめで断らない（大きさは書き込みの時に確かめ、分け方を返す）。短い項目の上限はそのまま
    const critique = fromJsonSchema(TOOL_SCHEMAS.novel_add_critique_result as never, v)
    const long = await critique['~standard'].validate({ title_id: 't:1', prompt_text: 'あ'.repeat(30_000), result_markdown: 'あ'.repeat(250_000) })
    expect('issues' in long && long.issues).toBeFalsy()
    const longExcerpt = await proof['~standard'].validate({
      title_id: 't:1',
      items: [{ piece: '#1', excerpt: 'あ'.repeat(101), category: 'typo', reason: 'r' }],
    })
    expect('issues' in longExcerpt && longExcerpt.issues?.length).toBeTruthy()
    // 相対比較の一覧: 作品名の絞り込み（10個・80字まで）・char_budget（2,000〜100,000）・長い cursor（絞り込みが入る）
    const list = fromJsonSchema(TOOL_SCHEMAS.novel_list_bench_works as never, v)
    const valid = async (x: Record<string, unknown>) => {
      const r = await list['~standard'].validate(x)
      return !('issues' in r && r.issues?.length)
    }
    expect(await valid({})).toBe(true)
    expect(
      await valid({ names: ['【原稿】星の庭'], exclude_names: ['【横断】', '【対照】'], char_budget: 2_000, cursor: 'x'.repeat(12_000) }),
    ).toBe(true)
    expect(await valid({ names: [] })).toBe(false)
    expect(await valid({ names: ['あ'.repeat(81)] })).toBe(false)
    expect(await valid({ exclude_names: Array.from({ length: 11 }, (_, i) => `x${i}`) })).toBe(false)
    expect(await valid({ char_budget: 100_000 })).toBe(true)
    expect(await valid({ char_budget: 100_001 })).toBe(false)
    expect(await valid({ char_budget: 1_999 })).toBe(false)
    // 作品のタグの絞り込み（2.7。10個・20字まで）
    expect(await valid({ tags: ['恋愛', '喪失'], names: ['作品'] })).toBe(true)
    expect(await valid({ tags: [] })).toBe(false)
    expect(await valid({ tags: [''] })).toBe(false)
    expect(await valid({ tags: ['あ'.repeat(21)] })).toBe(false)
    expect(await valid({ tags: ['あ'.repeat(20)] })).toBe(true)
    expect(await valid({ tags: Array.from({ length: 11 }, (_, i) => `x${i}`) })).toBe(false)
    expect(Object.keys((TOOL_SCHEMAS.novel_list_bench_works as { properties: object }).properties)).toEqual([
      'names',
      'exclude_names',
      'tags',
      'char_budget',
      'cursor',
    ])
    // 資料の一覧（2.6）: 資料名の絞り込み（10個・80字まで）・タグの絞り込み（10個・20字まで）・char_budget・長い cursor
    const materials = fromJsonSchema(TOOL_SCHEMAS.novel_list_materials as never, v)
    const validMaterials = async (x: Record<string, unknown>) => {
      const r = await materials['~standard'].validate(x)
      return !('issues' in r && r.issues?.length)
    }
    expect(await validMaterials({})).toBe(true)
    expect(
      await validMaterials({
        names: ['江戸'],
        exclude_names: ['図録'],
        tags: ['ミリタリ', '現代'],
        char_budget: 2_000,
        cursor: 'x'.repeat(12_000),
      }),
    ).toBe(true)
    expect(await validMaterials({ tags: [] })).toBe(false)
    expect(await validMaterials({ tags: [''] })).toBe(false)
    expect(await validMaterials({ tags: ['あ'.repeat(21)] })).toBe(false)
    expect(await validMaterials({ tags: ['あ'.repeat(20)] })).toBe(true)
    expect(await validMaterials({ names: ['あ'.repeat(81)] })).toBe(false)
    expect(await validMaterials({ tags: Array.from({ length: 11 }, (_, i) => `x${i}`) })).toBe(false)
    expect(await validMaterials({ tags: Array.from({ length: 10 }, (_, i) => `x${i}`) })).toBe(true)
    // 分野の絞り込みは無い（タグにした）
    expect(Object.keys((TOOL_SCHEMAS.novel_list_materials as { properties: object }).properties)).toEqual([
      'names',
      'exclude_names',
      'tags',
      'char_budget',
      'cursor',
    ])
    expect(await validMaterials({ char_budget: 100_001 })).toBe(false)
    // 資料を読む: material が要る。項目で絞る・1つだけ読む
    const get = fromJsonSchema(TOOL_SCHEMAS.novel_get_material as never, v)
    const getOk = async (x: Record<string, unknown>) => {
      const r = await get['~standard'].validate(x)
      return !('issues' in r && r.issues?.length)
    }
    expect(await getOk({ material: 'd:12345678', sections: ['要約'], note_id: 'k:1', char_budget: 2_000 })).toBe(true)
    expect(await getOk({ sections: ['要約'] })).toBe(false)
    expect(await getOk({ material: 'd:1', sections: ['あ'.repeat(41)] })).toBe(false)
    // 資料に記録を追加: 長い記録は入力の形の確かめで断らない。items は1〜20件、項目の名前は40字まで、new_material の刊行年は20字まで。
    // new_material にタグ・分野は無い（タグは作者が付けて管理する）
    const add = fromJsonSchema(TOOL_SCHEMAS.novel_add_material_notes as never, v)
    const addOk = async (x: Record<string, unknown>) => {
      const r = await add['~standard'].validate(x)
      return !('issues' in r && r.issues?.length)
    }
    const item = { section: '要約', body_markdown: 'あ'.repeat(250_000), run_date: '2026-11-02' }
    expect(
      await addOk({
        material: '江戸の暮らし',
        new_material: { name: '江戸の暮らし', author: '山田', publisher: '海出版', year: '2019', pdf_place: 'プロジェクト「資料」' },
        items: [item],
        model: 'claude',
      }),
    ).toBe(true)
    expect(await addOk({ material: 'd:1', items: [] })).toBe(false)
    expect(await addOk({ material: 'd:1', items: Array.from({ length: 21 }, () => item) })).toBe(false)
    expect(await addOk({ material: 'd:1', items: [{ ...item, section: 'あ'.repeat(41) }] })).toBe(false)
    expect(await addOk({ material: 'd:1', new_material: { name: '江戸', author: '', year: '1'.repeat(21) }, items: [item] })).toBe(false)
    const newMaterial = (TOOL_SCHEMAS.novel_add_material_notes as { properties: { new_material: { properties: object } } }).properties
      .new_material
    expect(Object.keys(newMaterial.properties)).toEqual(['name', 'author', 'publisher', 'year', 'pdf_place'])
    expect(await addOk({ material: 'd:1', new_material: { name: '江戸' }, items: [item] })).toBe(false)
  })
})

describe('MCP の呼び出し（2025-11-25 の stateless・2026-07-28）', () => {
  let core: VaultCore
  let titleId: string
  let calls = 0
  let handler: ReturnType<typeof createMcpHandler>

  beforeAll(async () => {
    const n = novel(['窓から見れる景色。'])
    titleId = n.titleId
    core = (await pairedCore(new FakeFirebase(), n.data)).core
    handler = createMcpHandler(
      () =>
        createServer(async (name, args, opts) => {
          calls += 1
          return core.callTool(name, args, opts)
        }),
      { legacy: 'stateless', responseMode: 'json' },
    )
  })

  async function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
    const res = await handler.fetch(
      new Request('https://connector.example/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
    )
    const text = await res.text()
    const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(/data: (.*)/.exec(text)![1])
    return { status: res.status, json }
  }

  it('initialize・tools/list は Vault を呼ばない。一覧は決まった並びで、題・ヒント・入力の形がある', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } })
    expect(init.status).toBe(200)
    expect(init.json.result.serverInfo.name).toBe('novel-studio')
    expect(init.json.result.instructions).toContain('採用原稿')
    const list = await rpc('tools/list', {}, 2)
    const tools = list.json.result.tools as { name: string; title: string; annotations: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> }; outputSchema?: unknown }[]
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_ORDER)
    expect(tools[3].title).toBe('採用原稿を読む')
    expect(tools[3].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    const write = tools.find((t) => t.name === 'novel_add_proofreading')!
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
    expect(tools[3].inputSchema.properties.char_budget).toMatchObject({ default: 20_000, maximum: 60_000 })
    expect(write.outputSchema).toBeTruthy()
    // 相対比較（2.5。ツールの名前は bench のまま）: 読む2つと書き込み1つ
    const bench = tools.filter((t) => t.name.includes('_bench_'))
    expect(bench.map((t) => [t.name, t.title, t.annotations.readOnlyHint])).toEqual([
      ['novel_list_bench_works', '相対比較の作品一覧を見る', true],
      ['novel_get_bench_analysis', '相対比較の分析を読む', true],
      ['novel_add_bench_analysis', '相対比較に分析を追加', false],
    ])
    expect(bench[2].outputSchema).toBeTruthy()
    // 作者が「ベンチ作品」「比較作品」と呼んでも、相対比較のツールにつながるように（説明と、追加のツールの説明に書く）
    const instructions = init.json.result.instructions as string
    expect(instructions).toContain('相対比較')
    expect(instructions).toContain('「ベンチ作品」「比較作品」とも呼ぶ')
    const addBench = TOOL_DEFS.find((t) => t.name === 'novel_add_bench_analysis')!
    expect(addBench.description).toContain('ホームの「相対比較」')
    expect(addBench.description).toContain('「ベンチ作品」「比較作品」とも呼ぶ')
    // それ以外の説明・題には「ベンチ」を出さない
    for (const t of TOOL_DEFS) {
      expect(t.title, t.name).not.toContain('ベンチ')
      if (t !== addBench) expect(t.description, t.name).not.toContain('ベンチ')
    }
    expect(instructions.replace('「ベンチ作品」「比較作品」とも呼ぶ', '')).not.toContain('ベンチ')
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toContain('ベンチ')
    // 資料（2.6）: 読む2つと書き込み1つ。説明に資料の棚と短い id（d:・k:）
    const material = tools.filter((t) => /_materials?(_|$)/.test(t.name))
    expect(material.map((t) => [t.name, t.title, t.annotations.readOnlyHint])).toEqual([
      ['novel_list_materials', '資料の一覧を見る', true],
      ['novel_get_material', '資料を読む', true],
      ['novel_add_material_notes', '資料に記録を追加', false],
    ])
    expect(material[2].outputSchema).toBeTruthy()
    expect(material[2].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
    expect(instructions).toContain('資料は、作者が創作のために読む資料')
    expect(instructions).toContain('「参考資料」「資料本」とも呼ぶ')
    expect(instructions).toContain('d: 資料、k: その記録')
    // 追加のツールの説明に、決まった4つの項目の書き方（手動連携の依頼文と同じ）と分け方
    const addMaterial = TOOL_DEFS.find((t) => t.name === 'novel_add_material_notes')!
    expect(addMaterial.description).toContain('ホームの「資料」')
    for (const s of MATERIAL_SECTIONS) expect(addMaterial.description).toContain(`「${s}」は${MATERIAL_SECTION_GUIDE[s]}`)
    expect(addMaterial.description).toContain('すべて拾う')
    expect(addMaterial.description).toContain('「（1/2）」「（2/2）」')
    expect(addMaterial.description).toContain('著者が違えば別の資料')
    // タグは作者が付けて管理する（Claude は付けない）。一覧はタグで絞れる
    expect(addMaterial.description).toContain('タグは作者が自分で付けて管理する（Claude はタグを付けない')
    const listMaterials = TOOL_DEFS.find((t) => t.name === 'novel_list_materials')!
    expect(listMaterials.description).toContain('tags でそのタグをすべて持つ資料だけにする')
    expect(listMaterials.description).toContain('作者が自分で付けて管理するもの')
    for (const t of TOOL_DEFS) expect(t.description, t.name).not.toContain('分野')
    // 相対比較の作品のタグ（2.7）: 一覧に出し tags で絞れる。追加では書けず、「14 検索用タグ」の2行からアプリが付ける
    const listBench = TOOL_DEFS.find((t) => t.name === 'novel_list_bench_works')!
    expect(listBench.description).toContain('作品のタグ（タグ: 恋愛・青春…。作者が管理し、「14 検索用タグ」の判定したジャンル・サブジャンルはアプリが自動で付ける')
    expect(listBench.description).toContain('tags でそのタグをすべて持つ作品だけにする（タグの名前そのもので照らす）')
    expect(listBench.description).toContain('タグ（作品の数）')
    expect(TOOL_DEFS.find((t) => t.name === 'novel_get_bench_analysis')!.description).toContain('先頭に作品の書誌とタグも出す')
    expect(addBench.description).toContain('作品のタグは書けない（観点「14 検索用タグ」の「- 判定したジャンル：」「- ジャンル／サブジャンル：」の行から')
    expect(tools[2].outputSchema).toBeUndefined()
    // ゴミ箱へ移すツール（2.7）: これだけ destructiveHint。結果の形もある。説明とサーバーの説明に、使ってよい時を書く
    const trash = tools.find((t) => t.name === 'novel_move_cards_to_trash')!
    expect(trash.title).toBe('カードをゴミ箱へ移す')
    expect(trash.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false })
    expect(trash.outputSchema).toBeTruthy()
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['novel_move_cards_to_trash'])
    const trashDef = TOOL_DEFS.find((t) => t.name === 'novel_move_cards_to_trash')!
    for (const phrase of [
      '作者が削除を頼んだ時だけ使い、自分の判断では使わない',
      'イレギュラーがあれば作者に報告し',
      '選択肢の1つとして提案する',
      'そのチャットで自分が追加した時の答えに出た id だけ',
      '作者が書いた・貼り付けた・アプリで直したカード、作品・資料そのもの',
      '1回20件・1日（日本時間）100件まで',
      'アプリが同期した時にアプリのゴミ箱へ移る（30日は作者がアプリのゴミ箱から戻せる',
    ])
      expect(trashDef.description).toContain(phrase)
    for (const phrase of [
      'novel_move_cards_to_trash',
      '作者が頼んだ時だけ使い、自分の判断で使わない',
      'イレギュラーは報告し、選択肢の1つとして提案する',
      'そのチャットで自分が登録した id だけ',
    ])
      expect(instructions).toContain(phrase)
    expect(instructions).not.toContain('何かを削除したりはしません')
    expect(calls).toBe(0)
  })

  it('tools/call: 読むツールはテキストだけ、書き込みツールは structuredContent も返す', async () => {
    const read = await rpc('tools/call', { name: 'novel_read_text', arguments: { title_id: titleId } }, 3)
    expect(read.json.result.content[0].text).toContain('窓から見れる景色。')
    expect(read.json.result.structuredContent).toBeUndefined()
    const write = await rpc(
      'tools/call',
      { name: 'novel_add_revision_ideas', arguments: { title_id: titleId, items: [{ heading: '冒頭', body: '景色の描写を増やす' }] } },
      4,
    )
    expect(write.json.result.isError).toBeFalsy()
    expect(write.json.result.structuredContent.created[0].id).toMatch(/^r:/)
    expect(calls).toBe(2)
  })

  it('書き込みツールの structuredContent の chars（本文の字数。アプリと同じ数え方）は出力の形の確かめを通り、本文の字数の行と同じ数', async () => {
    const write = await rpc(
      'tools/call',
      {
        name: 'novel_add_revision_ideas',
        arguments: { title_id: titleId, items: [{ heading: '見出しは数えない', body: '景色の　描写を\n増やす' }] },
      },
      8,
    )
    expect(write.json.error).toBeUndefined()
    expect(write.json.result.isError).toBeFalsy()
    expect(write.json.result.structuredContent.created).toEqual([{ id: expect.stringMatching(/^r:/), label: '「見出しは数えない」', chars: 9 }])
    expect(write.json.result.content[0].text).toContain('\n    字数: 9字（空白・改行を除く。アプリと同じ数え方）\n')
  })

  it('書き込みツールが何も作れなかった時は isError（structuredContent なしでも出力の形の確かめで落ちない）', async () => {
    const r = await rpc(
      'tools/call',
      { name: 'novel_add_proofreading', arguments: { title_id: titleId, items: [{ piece: '#1', excerpt: '無い文', category: 'typo', reason: 'x' }] } },
      6,
    )
    expect(r.status).toBe(200)
    expect(r.json.error).toBeUndefined()
    expect(r.json.result.isError).toBe(true)
    expect(r.json.result.content[0].text).toContain('見つからない 1件')
    // 重複だけの時は isError にせず、structuredContent を返す
    const input = { title_id: titleId, items: [{ heading: '冒頭', body: '景色の描写を増やす' }] }
    const dup = await rpc('tools/call', { name: 'novel_add_revision_ideas', arguments: input }, 7)
    expect(dup.json.result.isError).toBeFalsy()
    expect(dup.json.result.structuredContent).toMatchObject({ created: [], skipped: [{ index: 0, reason: 'duplicate' }] })
  })

  it('入力の形が違えば、Vault を呼ばずに失敗を返す', async () => {
    const before = calls
    const r = await rpc('tools/call', { name: 'novel_read_text', arguments: { char_budget: 5 } }, 5)
    const failed = r.json.error || r.json.result?.isError
    expect(failed).toBeTruthy()
    expect(calls).toBe(before)
  })

  it('tools/call: ゴミ箱へ移すツールは structuredContent（requested・skipped）を返し、移せない時は isError', async () => {
    const add = await rpc(
      'tools/call',
      {
        name: 'novel_add_bench_analysis',
        arguments: { work: '銀河の果て', new_work: { name: '銀河の果て', author: '山田' }, items: [{ viewpoint: '構成', body_markdown: '三幕。' }] },
      },
      8,
    )
    const id = add.json.result.structuredContent.created[0].id as string
    const r = await rpc('tools/call', { name: 'novel_move_cards_to_trash', arguments: { cards: [id, 'w:12345678'] } }, 9)
    expect(r.json.result.isError).toBeFalsy()
    expect(r.json.result.structuredContent).toEqual({
      requested: [{ id, label: expect.stringContaining('相対比較『銀河の果て』の「構成」') }],
      skipped: [{ ref: 'w:12345678', reason: 'shelf_item', hint: expect.any(String) }],
    })
    expect(r.json.result.content[0].text).toContain('30日は、作者がアプリのゴミ箱から元に戻せます')
    const bad = await rpc('tools/call', { name: 'novel_move_cards_to_trash', arguments: { cards: ['x:12345678'] } }, 10)
    expect(bad.json.error).toBeUndefined()
    expect(bad.json.result.isError).toBe(true)
    // 入力の形: 1〜20件・1つ80字まで
    const many = await rpc('tools/call', { name: 'novel_move_cards_to_trash', arguments: { cards: Array.from({ length: 21 }, () => id) } }, 11)
    expect(many.json.error || many.json.result?.isError).toBeTruthy()
    const empty = await rpc('tools/call', { name: 'novel_move_cards_to_trash', arguments: { cards: [] } }, 12)
    expect(empty.json.error || empty.json.result?.isError).toBeTruthy()
  })
})
