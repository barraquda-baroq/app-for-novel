// アイデアのツール（2.8。novel_add_ideas・novel_append_to_idea）と、Claude が作ったアイデアを読む novel_get_notes:
// 足す場所（ホーム・タイトル）・答えの全文・並びの位置・書き込みの許可・重複、読む → 追記 → 見せる内容 → 依頼済み → アプリが足す →
// もう足されています、読んだ後に変わった・頼み直し、作者のアイデア・見えないアイデアは断る、ゴミ箱へ移す、novel_status の最後の行。
import { describe, expect, it } from 'vitest'
import { applyClaudeRequests } from '../../../src/domain/claudeRequests'
import { createTitle, sortIdeas } from '../../../src/domain/entityOps'
import { hashJson } from '../../../src/domain/hash'
import { buildIdeaTree } from '../../../src/domain/ideaFolders'
import type { AppData, Idea, IdeaFolder } from '../../../src/domain/types'
import { claudeFolderId, claudeIdeaId, ideaAppendId } from '../../../src/claude/derivedId'
import { appendedBody, ideaReadMark, isClaudeIdea } from '../../../src/claude/ideaAppend'
import { shortId } from '../../../src/claude/refs'
import { novel } from '../../../src/test/claudeFixture'
import { MESSAGES, modelMismatchMessage } from '../../src/vault/errors'
import { ideaAddResult } from '../../src/vault/tools/ideas'
import { CONNECTOR_MODEL } from '../../src/version'
import { cloudData, connectorDocs, pushChanges } from '../support/cloud'
import { FakeFirebase } from '../support/fakeFirebase'
import { call, OWNER, pairedCore } from '../support/harness'

/** 作者が書いたアイデア */
function authorIdea(id: string, titleId: string | null, body: string, order: number): Idea {
  return { id, titleId, heading: '', body, checked: false, checkedAt: null, order, createdAt: 1, updatedAt: 1 }
}

/** 『星の庭』（読む＋書き込む）・『読む庭』（読むだけ）・『隠す庭』（見せない）と、作者が書いたホーム・タイトルのアイデア */
function setup() {
  const n = novel(['冒頭の本文。'], { name: '星の庭' })
  const ro = createTitle(n.data, '読む庭')
  const hidden = createTitle(ro.data, '隠す庭')
  const authorHome = [
    authorIdea('3f2a9c1b-0000-4000-8000-000000000001', null, 'ホームの作者の案', 0),
    authorIdea('4e3b8d2c-0000-4000-8000-000000000002', null, 'ホームの作者の案2', 1),
  ]
  const authorTitle = authorIdea('5d4c7e3d-0000-4000-8000-000000000003', n.titleId, '星の庭の作者の案', 4)
  const data: AppData = {
    ...hidden.data,
    titles: {
      ...hidden.data.titles,
      [ro.result]: { ...hidden.data.titles[ro.result], claudeAccess: 'read' },
      [hidden.result]: { ...hidden.data.titles[hidden.result], claudeAccess: 'none' },
    },
    ideas: Object.fromEntries([...authorHome, authorTitle].map((i) => [i.id, i])),
  }
  return { data, titleId: n.titleId, readId: ro.result, hiddenId: hidden.result, authorHome, authorTitle }
}

const commits = (fake: FakeFirebase) => fake.calls.filter((c) => c.op === 'commit').length

/** 2026/10/29 12:00（日本時間。harness の時計） */
const DAY = '2026-10-29'
const HOME_CLOSING =
  'アプリのホームのアイデア欄の「どのタイトルにも属さない」に、各端末が同期すると出ます。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。'
const APPEND_CLOSING =
  '追記は依頼として送りました。アプリを開いて同期すると、カードの終わりに足されます（前の中身と作者が直した所は残り、並びの位置と「済み」は変わりません）。Claude からは、もう追記した後の中身が見えます。続けて追記する時は、もう一度 novel_get_notes で読んでから、新しい印（本文の見出しの「印: 」の後ろの8字）を read_mark に渡してください。本文（稿）は書き換えていません。'

describe('novel_add_ideas', () => {
  it('ホームのアイデア: 答えに入れた場所と i:… を出し、済みでないアイデアの先頭に渡した順で入れる（Claude の印の形）', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    const r = await core.callTool('novel_add_ideas', {
      placement: 'outside',
      items: [{ name: '第3章の動機', content: '【動機】\n・兄を探す' }, { content: '新作の案\n・港町' }],
      model: 'claude-x',
    })
    const a = claudeIdeaId(null, DAY, '第3章の動機', '【動機】\n・兄を探す')
    const b = claudeIdeaId(null, DAY, '', '新作の案\n・港町')
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe(
      [
        'アイデアを足す: 追加 2件',
        `- 追加 ${shortId('idea', a)} 「2026/10/29 12:00　第3章の動機」`,
        `- 追加 ${shortId('idea', b)} 「2026/10/29 12:00　新作の案」`,
        '入れた場所: ホームのアイデア（どのタイトルにも属さないアイデア。済みでないアイデアの先頭。カードに「Claude が作成」の印が付きます）',
        HOME_CLOSING,
      ].join('\n'),
    )
    expect(r.structured).toEqual({
      created: [
        { id: shortId('idea', a), label: '「2026/10/29 12:00　第3章の動機」（ホームのアイデア）' },
        { id: shortId('idea', b), label: '「2026/10/29 12:00　新作の案」（ホームのアイデア）' },
      ],
      skipped: [],
    })
    // クラウド: アイデアを作るだけ（作者のアイデアは書き換えない）
    expect(connectorDocs(fake, 'ideas').map((d) => d.fields.id.stringValue).sort()).toEqual([a, b].sort())
    const cloud = cloudData(fake)
    expect(cloud.ideas[a]).toMatchObject({
      titleId: null,
      heading: '',
      body: '2026/10/29 12:00　第3章の動機\n【動機】\n・兄を探す',
      checked: false,
      checkedAt: null,
      order: -2,
      source: 'claude',
      v: 1,
      model: 'claude-x',
    })
    expect(isClaudeIdea(cloud.ideas[a])).toBe(true)
    const home = sortIdeas(Object.values(cloud.ideas).filter((i) => i.titleId === null)).map((i) => i.id)
    expect(home).toEqual([a, b, ...s.authorHome.map((i) => i.id)])
    for (const i of s.authorHome) expect(cloud.ideas[i.id]).toEqual(i)
  })

  it('タイトルのアイデア（読む＋書き込む）。同じ呼び出しをもう一度送ると「重複」で書かない。「読むだけ」「見せない」のタイトルは断る', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    const input = { title_id: shortId('title', s.titleId), placement: 'outside', items: [{ name: '終盤', content: '・灯台で再会する' }] }
    const r = await core.callTool('novel_add_ideas', input)
    const id = claudeIdeaId(s.titleId, DAY, '終盤', '・灯台で再会する')
    expect(r.text).toBe(
      [
        'アイデアを足す: 追加 1件',
        `- 追加 ${shortId('idea', id)} 「2026/10/29 12:00　終盤」`,
        '入れた場所: タイトル『星の庭』のアイデア（済みでないアイデアの先頭。カードに「Claude が作成」の印が付きます）',
        'アプリのタイトル『星の庭』の「アイデア」と、ホームのアイデア欄のその仕切りに、各端末が同期すると出ます。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    expect(cloudData(fake).ideas[id]).toMatchObject({ titleId: s.titleId, order: 3 })
    const before = commits(fake)
    const again = await core.callTool('novel_add_ideas', input)
    expect(again.isError).toBeUndefined()
    // もうあるカード（Claude に見えている）の i:… と1行目を出す
    expect(again.text).toBe(
      `アイデアを足す: 重複 1件\n- 重複 ${shortId('idea', id)} 「2026/10/29 12:00　終盤」: 同じ内容のアイデアがもうあります（追加しません）`,
    )
    expect(again.structured).toEqual({
      created: [],
      skipped: [{ index: 0, reason: 'duplicate', id: shortId('idea', id), hint: '同じ内容のアイデアがもうあります（追加しません）' }],
    })
    expect(commits(fake)).toBe(before)
    const ro = await core.callTool('novel_add_ideas', { placement: 'outside', title_id: '読む庭', items: [{ content: '案' }] })
    expect(ro.isError).toBe(true)
    expect(ro.text).toContain('タイトル『読む庭』は「Claude に見せる」が「読むだけ」なので書き込めません')
    const hidden = await core.callTool('novel_add_ideas', { placement: 'outside', title_id: '隠す庭', items: [{ content: '案' }] })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain("タイトル '隠す庭' が見つかりません")
    // Markdown の記号だけのアイデアは足さずに、その行を返す（失敗として）
    const md = await core.callTool('novel_add_ideas', { placement: 'outside', items: [{ content: '## 動機\n- 兄' }] })
    expect(md.isError).toBe(true)
    expect(md.text).toContain('アイデアを足す: 形が違う 1件\n- 形が違う アイデア（1件目）: Markdown の記号があります（2行目「## 動機」・3行目「- 兄」）')
    expect(commits(fake)).toBe(before)
  })

  it('1回の呼び出しに同じアイデアが2件あれば「追加 1件・重複 1件」（カードは1枚。重複の行にもその i:…）', async () => {
    const fake = new FakeFirebase()
    const { core } = await pairedCore(fake, setup().data)
    const r = await core.callTool('novel_add_ideas', { placement: 'outside', items: [{ content: '同じ案' }, { content: '同じ案' }] })
    const id = claudeIdeaId(null, DAY, '', '同じ案')
    expect(r.isError).toBeUndefined()
    expect(r.text.split('\n').slice(0, 3)).toEqual([
      'アイデアを足す: 追加 1件・重複 1件',
      `- 追加 ${shortId('idea', id)} 「2026/10/29 12:00　同じ案」`,
      `- 重複 ${shortId('idea', id)} 「2026/10/29 12:00　同じ案」: 同じ内容のアイデアがもうあります（追加しません）`,
    ])
    expect(r.structured).toEqual({
      created: [{ id: shortId('idea', id), label: '「2026/10/29 12:00　同じ案」（ホームのアイデア）' }],
      skipped: [{ index: 1, reason: 'duplicate', id: shortId('idea', id), hint: '同じ内容のアイデアがもうあります（追加しません）' }],
    })
    expect(connectorDocs(fake, 'ideas')).toHaveLength(1)
  })

  it('試し直しで2回目に「重複」になったアイデアは、1回目に作っていれば「追加」（同じ id の2件目は「重複」のまま）', () => {
    const id = claudeIdeaId(null, DAY, '', '同じ案')
    const label = '「2026/10/29 12:00　同じ案」'
    const hint = '同じ内容のアイデアがもうあります（追加しません）'
    const r = ideaAddResult(
      {
        ok: true,
        titleId: null,
        place: 'ホームのアイデア',
        titleName: '',
        records: [],
        folders: [],
        folderPath: '',
        notes: [],
        items: [
          { index: 0, status: 'duplicate', id, label, hint, existing: true },
          { index: 1, status: 'duplicate', id, label, hint, existing: true },
        ],
      },
      new Set([`ideas:${id}`]),
    )
    expect(r.text.split('\n').slice(0, 3)).toEqual([
      'アイデアを足す: 追加 1件・重複 1件',
      `- 追加 ${shortId('idea', id)} ${label}`,
      `- 重複 ${shortId('idea', id)} ${label}: ${hint}`,
    ])
    expect((r.structured as { created: unknown[] }).created).toHaveLength(1)
  })

  it('数分後に同じ内容を送り直すと「重複」。もうあるカードの1行目（作った時刻）と i:… を出す', async () => {
    const fake = new FakeFirebase()
    const { core, clock } = await pairedCore(fake, setup().data)
    await call(core, 'novel_add_ideas', { placement: 'outside', items: [{ name: '動機', content: '案' }] })
    const id = claudeIdeaId(null, DAY, '動機', '案')
    clock.now += 3 * 60_000
    const again = await core.callTool('novel_add_ideas', { placement: 'outside', items: [{ name: '動機', content: '案' }] })
    expect(again.isError).toBeUndefined()
    expect(again.text).toBe(
      `アイデアを足す: 重複 1件\n- 重複 ${shortId('idea', id)} 「2026/10/29 12:00　動機」: 同じ内容のアイデアがもうあります（追加しません）`,
    )
    expect(again.text).not.toContain('12:03')
    expect(again.structured).toEqual({
      created: [],
      skipped: [{ index: 0, reason: 'duplicate', id: shortId('idea', id), hint: '同じ内容のアイデアがもうあります（追加しません）' }],
    })
  })

  it('名前の無いアイデアは、答えの表記に中身の最初の行を付けて見分ける（もうある重複1件と新しい2件）', async () => {
    const fake = new FakeFirebase()
    const { core, clock } = await pairedCore(fake, setup().data)
    await call(core, 'novel_add_ideas', { placement: 'outside', items: [{ content: '港町の案\n・灯台' }] })
    clock.now += 60_000
    const r = await core.callTool('novel_add_ideas', {
      placement: 'outside',
      items: [{ content: '港町の案\n・灯台' }, { content: '山の町の案\n・峠' }, { content: '【動機】\n・兄を探す' }],
    })
    const port = claudeIdeaId(null, DAY, '', '港町の案\n・灯台')
    const mountain = claudeIdeaId(null, DAY, '', '山の町の案\n・峠')
    const motive = claudeIdeaId(null, DAY, '', '【動機】\n・兄を探す')
    expect(r.text.split('\n').slice(0, 4)).toEqual([
      'アイデアを足す: 追加 2件・重複 1件',
      `- 追加 ${shortId('idea', mountain)} 「2026/10/29 12:01　山の町の案」`,
      `- 追加 ${shortId('idea', motive)} 「2026/10/29 12:01　【動機】」`,
      `- 重複 ${shortId('idea', port)} 「2026/10/29 12:00　港町の案」: 同じ内容のアイデアがもうあります（追加しません）`,
    ])
    // カードの本文は変えない（1行目は日付と時刻だけ）
    expect(cloudData(fake).ideas[mountain].body).toBe('2026/10/29 12:01\n山の町の案\n・峠')
    // ゴミ箱へ移す答えも、どのカードか分かる（n:・k: の行の形は変えない）
    const trash = await call(core, 'novel_move_cards_to_trash', { cards: [shortId('idea', mountain)] })
    expect(trash).toContain(`- 移す ${shortId('idea', mountain)} ホームのアイデア「2026/10/29 12:01　山の町の案」`)
    // 依頼中のアイデアを読むと、同じ表記で依頼中と答える
    const asked = await core.callTool('novel_get_notes', { kind: 'ideas', ids: [shortId('idea', mountain)] })
    expect(asked.text).toContain(`${shortId('idea', mountain)} ホームのアイデア「2026/10/29 12:01　山の町の案」 はゴミ箱へ移す依頼中です`)
  })

  it('「書き込みを許可」していない時・データの形が違う時は作らない（追記も）', async () => {
    const off = new FakeFirebase()
    const a = await pairedCore(off, setup().data, { writes: false })
    for (const [tool, args] of [
      ['novel_add_ideas', { placement: 'outside', items: [{ content: '案' }] }],
      ['novel_append_to_idea', { idea_id: 'i:12345678', read_mark: 'x', content: '案' }],
    ] as const) {
      const r = await a.core.callTool(tool, args)
      expect([r.isError, r.text]).toEqual([true, MESSAGES.writesOff])
    }
    const old = new FakeFirebase()
    const b = await pairedCore(old, setup().data, { model: CONNECTOR_MODEL - 1 })
    const r = await b.core.callTool('novel_add_ideas', { placement: 'outside', items: [{ content: '案' }] })
    expect([r.isError, r.text]).toEqual([true, modelMismatchMessage(CONNECTOR_MODEL - 1, CONNECTOR_MODEL)])
    expect(connectorDocs(off, 'ideas')).toHaveLength(0)
    expect(connectorDocs(old, 'ideas')).toHaveLength(0)
  })
})

describe('Claude が作ったアイデアを読み、追記する', () => {
  it('読む（title_id なし）→ 印 → 追記 → 追記した後の中身 → 依頼済み → アプリが足す → もう足されています', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core, clock } = await pairedCore(fake, s.data)
    await call(core, 'novel_add_ideas', { placement: 'outside', items: [{ name: '第3章の動機', content: '【動機】\n・兄を探す' }, { content: '港町の案' }] })
    const id = claudeIdeaId(null, DAY, '第3章の動機', '【動機】\n・兄を探す')
    const other = claudeIdeaId(null, DAY, '', '港町の案')
    const ref = shortId('idea', id)
    const body = '2026/10/29 12:00　第3章の動機\n【動機】\n・兄を探す'
    // 一覧（作者が書いたホームのアイデアは見えない。印は出さない）
    const list = await call(core, 'novel_get_notes', { kind: 'ideas' })
    expect(list).toBe(
      [
        '=== ホームのアイデア（どのタイトルにも属さない・Claude が作ったものだけ。2件）===',
        '【Claude】は Claude がこのコネクタで作ったアイデア（追記・ゴミ箱へ移すのは、そのチャットで作ったものだけ）。',
        `${ref} 【Claude】2026/10/29 12:00 第3章の動機 【動機】 ・兄を探す（34字）`,
        `${shortId('idea', other)} 【Claude】2026/10/29 12:00 港町の案（21字）`,
        '本文は ids に短い id を入れるか full=true で読めます。',
        '作者が書いたホームのアイデアは見えません。',
      ].join('\n'),
    )
    expect(list).not.toContain('ホームの作者の案')
    expect(list).not.toContain('印:')
    const mark = ideaReadMark(body)
    const full = await call(core, 'novel_get_notes', { kind: 'ideas', ids: [ref] })
    expect(full).toBe(`=== アイデア【Claude】（ホームのアイデア）[${ref}] 印: ${mark} ===\n${body}`)
    // 追記（依頼を作るだけ。カードはまだ変わらない）
    clock.now = Date.UTC(2026, 9, 31, 2, 0, 0)
    const input = { idea_id: ref, read_mark: mark, content: '【変更】\n・兄ではなく姉を探す' }
    const r = await core.callTool('novel_append_to_idea', input)
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe(
      [
        'アイデアに追記: 追記 1件',
        `- 追記 ${ref} 「2026/10/29 12:00　第3章の動機」（ホームのアイデア）`,
        '足す形: カードの終わりに空行を置き、「2026/10/31のセッションで以下の内容へ変更」の行の下に内容（15字）',
        APPEND_CLOSING,
      ].join('\n'),
    )
    expect(r.structured).toEqual({ created: [{ id: ref, label: '「2026/10/29 12:00　第3章の動機」（ホームのアイデア）' }], skipped: [] })
    const reqId = ideaAppendId(id, mark, '【変更】\n・兄ではなく姉を探す')
    expect(connectorDocs(fake, 'ideaAppends').map((d) => d.fields.id.stringValue)).toEqual([reqId])
    expect(cloudData(fake).ideas[id].body).toBe(body)
    // Claude からは、もう追記した後の中身（印も変わる。同期待ちの数も出る）
    const appended = `${body}\n\n2026/10/31のセッションで以下の内容へ変更\n【変更】\n・兄ではなく姉を探す`
    const after = await call(core, 'novel_get_notes', { kind: 'ideas', ids: [ref] })
    expect(after).toBe(
      `=== アイデア【Claude】（ホームのアイデア・アプリの同期待ちの追記 1件を含む）[${ref}] 印: ${ideaReadMark(appended)} ===\n${appended}`,
    )
    expect(await call(core, 'novel_get_notes', { kind: 'ideas' })).toContain('（追記の依頼 1件はアプリの同期待ち）')
    expect((await call(core, 'novel_status')).split('\n').at(-1)).toBe('アイデアへの追記の依頼: アプリの同期待ち 1件')
    // 同じ呼び出しの送り直しは「依頼済み」（書かない）。前の印で違う内容は「読んだ後に中身が変わった」
    const writes = commits(fake)
    const again = await core.callTool('novel_append_to_idea', input)
    expect(again.text).toBe(
      [
        'アイデアに追記: 追記 1件',
        `- 追記 ${ref} 「2026/10/29 12:00　第3章の動機」（ホームのアイデア）（依頼済み）`,
        '足す形: カードの終わりに空行を置き、「2026/10/31のセッションで以下の内容へ変更」の行の下に内容（15字）',
        APPEND_CLOSING,
      ].join('\n'),
    )
    const stale = await core.callTool('novel_append_to_idea', { ...input, content: '別の追記' })
    expect(stale.isError).toBe(true)
    expect(stale.text).toBe(
      [
        'アイデアに追記: 追記しない',
        `- 追記しない ${ref} 「2026/10/29 12:00　第3章の動機」（ホームのアイデア）（読んだ後に中身が変わった）: 読んだ後にこのアイデアの中身が変わりました（作者がアプリで直した・ほかの追記が入った）。novel_get_notes で読み直し、今の中身を踏まえて書いてから、新しい印（本文の見出しの「印: 」の後ろの8字）を read_mark に渡して送ってください`,
      ].join('\n'),
    )
    expect(stale.structured).toEqual({ created: [], skipped: [{ index: 0, reason: 'stale', hint: expect.any(String) }] })
    expect(commits(fake)).toBe(writes)
    // アプリが同期して足す（依頼は消える）。足した本文は Claude が先に見た本文と1字も違わない
    const before = cloudData(fake)
    const processed = applyClaudeRequests(before, clock.now + 5_000)
    expect(processed.result.appends.map((o) => o.status)).toEqual(['appended'])
    expect(processed.data.ideas[id].body).toBe(appended)
    pushChanges(fake, before, processed.data)
    clock.now += 20_000
    const done = await core.callTool('novel_append_to_idea', input)
    expect(done.isError).toBeUndefined()
    expect(done.text).toBe(
      [
        'アイデアに追記: 追記 1件',
        `- 追記 ${ref} 「2026/10/29 12:00　第3章の動機」（ホームのアイデア）（もう足されています）`,
        'この内容は、もうアプリがカードの終わりに足しています（novel_get_notes で今の中身を読めます）。本文（稿）は書き換えていません。',
      ].join('\n'),
    )
    expect(commits(fake)).toBe(writes)
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', ids: [ref] })).toBe(
      `=== アイデア【Claude】（ホームのアイデア）[${ref}] 印: ${ideaReadMark(appended)} ===\n${appended}`,
    )
    expect((await call(core, 'novel_status')).split('\n').at(-1)).toBe('アイデアへの追記の依頼: アプリの同期待ち 0件')
    // 新しい印でもう一度追記できる（2つ目の追記は1つ目の後ろ）
    const second = await core.callTool('novel_append_to_idea', { idea_id: ref, read_mark: ideaReadMark(appended), content: '・舞台は冬' })
    expect(second.text).toContain('アイデアに追記: 追記 1件')
    expect(core.views().view.ideas[id].body).toBe(appendedBody(appended, { createdAt: clock.now, text: '・舞台は冬' }))
  })

  it('read_mark は「印: …」のまま・全角のコロン・英大文字でもよい（同じ依頼）。形の違う印は「形が違う」（読み直しを求めない）', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    await call(core, 'novel_add_ideas', { placement: 'outside', items: [{ name: '動機', content: '案' }] })
    const id = claudeIdeaId(null, DAY, '動機', '案')
    const ref = shortId('idea', id)
    const mark = ideaReadMark('2026/10/29 12:00　動機\n案')
    const full = await call(core, 'novel_get_notes', { kind: 'ideas', ids: [ref] })
    expect(full).toContain(`[${ref}] 印: ${mark} ===`)
    // 見出しの「印: …」をそのまま渡す
    const r = await core.callTool('novel_append_to_idea', { idea_id: ref, read_mark: `印: ${mark}`, content: '変更' })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('アイデアに追記: 追記 1件')
    const reqId = ideaAppendId(id, mark, '変更')
    expect(connectorDocs(fake, 'ideaAppends').map((d) => d.fields.id.stringValue)).toEqual([reqId])
    expect(cloudData(fake).ideaAppends[reqId].readMark).toBe(mark)
    // 全角のコロン・英大文字・印だけでも、同じ依頼（依頼済み。書かない）
    const writes = commits(fake)
    for (const written of [`印：${mark}`, mark.toUpperCase(), ` ${mark} `]) {
      const again = await core.callTool('novel_append_to_idea', { idea_id: ref, read_mark: written, content: '変更' })
      expect([written, again.isError, again.text.split('\n')[1]]).toEqual([
        written,
        undefined,
        `- 追記 ${ref} 「2026/10/29 12:00　動機」（ホームのアイデア）（依頼済み）`,
      ])
    }
    expect(commits(fake)).toBe(writes)
    // 形の違う印: 「読んだ後に中身が変わった」ではなく「形が違う」
    const bad = await core.callTool('novel_append_to_idea', { idea_id: ref, read_mark: `印: ${mark.slice(0, 6)}`, content: '別の追記' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toBe(
      [
        'アイデアに追記: 追記しない',
        `- 追記しない ${ref} 「2026/10/29 12:00　動機」（ホームのアイデア）（形が違う）: read_mark の形が違います（novel_get_notes（kind=ideas・ids にこの id）の本文の見出しの「印: 」の後ろの8字を渡してください。例 1i30lfcq）`,
      ].join('\n'),
    )
    expect(bad.text).not.toContain('読んだ後に')
    expect(bad.structured).toEqual({ created: [], skipped: [{ index: 0, reason: 'invalid', hint: expect.stringContaining('read_mark の形が違います') }] })
    expect(commits(fake)).toBe(writes)
  })

  it('アプリが当てずに消した依頼（「読むだけ」にした）の後は、同じ内容を別の依頼として頼み直せる', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core, clock } = await pairedCore(fake, s.data)
    await call(core, 'novel_add_ideas', { placement: 'outside', title_id: s.titleId, items: [{ content: '星の案' }] })
    const id = claudeIdeaId(s.titleId, DAY, '', '星の案')
    const mark = ideaReadMark(cloudData(fake).ideas[id].body)
    const input = { idea_id: shortId('idea', id), read_mark: mark, content: '追記' }
    await call(core, 'novel_append_to_idea', input)
    // 作者がタイトルを「読むだけ」にしてから、アプリが同期した（依頼は足さずに消える）
    const before = cloudData(fake)
    const ro = { ...before, titles: { ...before.titles, [s.titleId]: { ...before.titles[s.titleId], claudeAccess: 'read' as const } } }
    const processed = applyClaudeRequests(ro, clock.now)
    expect(processed.result.appends.map((o) => o.status)).toEqual(['not_writable'])
    // 「読む＋書き込む」に戻す
    const back = { ...processed.data, titles: { ...processed.data.titles, [s.titleId]: before.titles[s.titleId] } }
    pushChanges(fake, before, back)
    clock.now += 20_000
    const r = await core.callTool('novel_append_to_idea', input)
    expect(r.text).toContain('アイデアに追記: 追記 1件')
    expect(r.text).not.toContain('（依頼済み）')
    expect(connectorDocs(fake, 'ideaAppends').map((d) => d.fields.id.stringValue)).toContain(ideaAppendId(id, mark, '追記', 2))
  })

  it('作者が書いたアイデア・見えないアイデア・「読むだけ」のタイトルは断る。場所の違う id は場所を言う。ゴミ箱へ移す依頼中も', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    await call(core, 'novel_add_ideas', { placement: 'outside', items: [{ content: 'ホームの案' }] })
    await call(core, 'novel_add_ideas', { placement: 'outside', title_id: s.titleId, items: [{ content: '星の案' }] })
    const home = shortId('idea', claudeIdeaId(null, DAY, '', 'ホームの案'))
    const inTitle = shortId('idea', claudeIdeaId(s.titleId, DAY, '', '星の案'))
    const authored = await core.callTool('novel_append_to_idea', { idea_id: shortId('idea', s.authorTitle.id), read_mark: 'x', content: '追記' })
    expect(authored.text).toBe(
      [
        'アイデアに追記: 追記しない',
        `- 追記しない ${shortId('idea', s.authorTitle.id)} 「星の庭の作者の案」（タイトル『星の庭』のアイデア）（作者が書いたアイデア）: 作者が書いたアイデアには追記できません（追記できるのは、Claude がこのコネクタで作ったアイデアだけ）`,
      ].join('\n'),
    )
    const hiddenHome = await core.callTool('novel_append_to_idea', { idea_id: shortId('idea', s.authorHome[0].id), read_mark: 'x', content: '追記' })
    expect(hiddenHome.text).toBe(
      [
        'アイデアに追記: 追記しない',
        `- 追記しない ${shortId('idea', s.authorHome[0].id)}（見つからない）: 見つかりません（novel_get_notes の kind=ideas で id を確かめてください。作者が書いたホームのアイデアと「見せない」タイトルのアイデアは見えません）`,
      ].join('\n'),
    )
    expect(hiddenHome.text).not.toContain('ホームの作者の案')
    // novel_get_notes: ids で場所の違う id を指すと場所を言う。title_id を省くと、見せているタイトルのアイデアからも探す
    const wrongPlace = await core.callTool('novel_get_notes', { title_id: s.titleId, kind: 'ideas', ids: [home] })
    expect([wrongPlace.isError, wrongPlace.text]).toEqual([true, `${home} はホームのアイデアです（title_id を省いてください）`])
    const ro = Object.values(core.views().view.titles).find((t) => t.name === '読む庭')!
    const otherTitle = await core.callTool('novel_get_notes', { title_id: ro.id, kind: 'ideas', ids: [inTitle] })
    expect(otherTitle.text).toBe(
      `${inTitle} はタイトル『星の庭』のアイデアです（title_id に ${shortId('title', s.titleId)} を渡すか、title_id を省いてください）`,
    )
    const anywhere = await call(core, 'novel_get_notes', { kind: 'ideas', ids: [inTitle, home] })
    expect(anywhere).toContain(`=== アイデア【Claude】（タイトル『星の庭』のアイデア）[${inTitle}] 印: `)
    expect(anywhere).toContain(`=== アイデア【Claude】（ホームのアイデア）[${home}] 印: `)
    // タイトルの一覧: 作者のアイデアは 2.7 の形のまま、Claude のアイデアには【Claude】
    const titleList = await call(core, 'novel_get_notes', { title_id: s.titleId, kind: 'ideas' })
    expect(titleList).toContain(`${inTitle} 【Claude】2026/10/29 12:00 星の案（20字）`)
    expect(titleList).toContain(`${shortId('idea', s.authorTitle.id)} 星の庭の作者の案（8字）`)
    expect(await call(core, 'novel_get_notes', { title_id: s.titleId, kind: 'ideas', ids: [shortId('idea', s.authorTitle.id)] })).toBe(
      `=== アイデア [${shortId('idea', s.authorTitle.id)}] ===\n星の庭の作者の案`,
    )
    // 設定項目・メモは title_id が要る
    const settings = await core.callTool('novel_get_notes', { kind: 'settings' })
    expect([settings.isError, settings.text]).toEqual([
      true,
      'title_id がありません（設定項目・メモはタイトルを指してください。kind=ideas の時だけ省けます）',
    ])
    // ゴミ箱へ移す依頼中のアイデアは、読む・追記するとそう答える
    await call(core, 'novel_move_cards_to_trash', { cards: [home] })
    const asked = await core.callTool('novel_get_notes', { kind: 'ideas', ids: [home] })
    expect(asked.text).toBe(
      `${home} ホームのアイデア「2026/10/29 12:00　ホームの案」 はゴミ箱へ移す依頼中です（アプリが同期すると、アプリのゴミ箱へ移ります。30日は作者がアプリのゴミ箱から戻せます）`,
    )
    const appendAsked = await core.callTool('novel_append_to_idea', { idea_id: home, read_mark: 'x', content: '追記' })
    expect(appendAsked.text).toContain('（ゴミ箱へ移す依頼中）: ゴミ箱へ移す依頼の出ているアイデアです（追記できません）')
    // 一覧からも外れる（作者が書いたホームのアイデアと同じく、どこにも出ない）
    expect(await call(core, 'novel_get_notes', { kind: 'ideas' })).toContain('（ありません）')
  })

  it('「読むだけ」のタイトルの Claude のアイデアは、印を出さず追記できないと書く。追記すると断る', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core, clock } = await pairedCore(fake, s.data)
    await call(core, 'novel_add_ideas', { placement: 'outside', title_id: s.titleId, items: [{ content: '星の案' }] })
    const id = claudeIdeaId(s.titleId, DAY, '', '星の案')
    // 作者がタイトルを「読むだけ」にした
    const before = cloudData(fake)
    pushChanges(fake, before, { ...before, titles: { ...before.titles, [s.titleId]: { ...before.titles[s.titleId], claudeAccess: 'read' } } })
    clock.now += 20_000
    const full = await call(core, 'novel_get_notes', { title_id: s.titleId, kind: 'ideas', ids: [shortId('idea', id)] })
    expect(full).toBe(
      `=== アイデア【Claude】（タイトル『星の庭』のアイデア・「読むだけ」のタイトルなので追記できません）[${shortId('idea', id)}] ===\n2026/10/29 12:00\n星の案`,
    )
    const r = await core.callTool('novel_append_to_idea', { idea_id: shortId('idea', id), read_mark: ideaReadMark('2026/10/29 12:00\n星の案'), content: '追記' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('（書き込めない場所）: タイトル『星の庭』は「Claude に見せる」が「読むだけ」なので追記できません')
  })

  it('足して追記したアイデアをゴミ箱へ移す（Claude の追記は直したに数えない）。アプリは追記してから移す', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core, clock } = await pairedCore(fake, s.data)
    await call(core, 'novel_add_ideas', { placement: 'outside', items: [{ name: '動機', content: '案' }] })
    const id = claudeIdeaId(null, DAY, '動機', '案')
    const ref = shortId('idea', id)
    await call(core, 'novel_append_to_idea', { idea_id: ref, read_mark: ideaReadMark('2026/10/29 12:00　動機\n案'), content: '変更' })
    const r = await call(core, 'novel_move_cards_to_trash', { cards: [ref] })
    expect(r).toContain(`- 移す ${ref} ホームのアイデア「2026/10/29 12:00　動機」`)
    const before = cloudData(fake)
    const processed = applyClaudeRequests(before, clock.now)
    expect(processed.result.appends.map((o) => o.status)).toEqual(['appended'])
    expect(processed.result.trash.map((o) => o.status)).toEqual(['moved'])
    expect((Object.values(processed.data.trashRecords)[0].record as Idea).body).toBe('2026/10/29 12:00　動機\n案\n\n2026/10/29のセッションで以下の内容へ変更\n変更')
  })
})

describe('アイデアのフォルダを読む（2.9）', () => {
  const F_NEW = 'a1a1a1a1-0000-4000-8000-000000000011'
  const F_DATED = 'cf-2b2b2b2b.1'
  const F_SCENE = 'c3c3c3c3-0000-4000-8000-000000000013'
  const F_TITLE = 'd4d4d4d4-0000-4000-8000-000000000014'
  const F_HIDDEN = 'e5e5e5e5-0000-4000-8000-000000000015'
  const C_IN = 'cy-c1c1c1c1.x'
  const C_LOOSE = 'cy-c2c2c2c2.x'
  const C_TITLE = 'cy-c3c3c3c3.x'
  const BODY_IN = '2026/10/29 12:00　港町の主人公\n・灯台守の娘'

  const folder = (id: string, titleId: string | null, name: string, order: number, over: Partial<IdeaFolder> = {}): IdeaFolder => ({
    id,
    titleId,
    parentId: null,
    name,
    order,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })
  const claudeIdea = (id: string, titleId: string | null, body: string, order: number, over: Partial<Idea> = {}): Idea => ({
    id,
    titleId,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  /**
   * ホーム: 作者の「新作の相談」（中に Claude の「2026/10/29　港町」と作者のカード）・作者の「場面の相談」（空）・フォルダの外の
   * Claude のカード。『星の庭』: 作者の「第1章の相談」（作者のカードと済みの Claude のカード）。『隠す庭』: 作者のフォルダ
   */
  function withFolders() {
    const s = setup()
    const data: AppData = {
      ...s.data,
      ideaFolders: Object.fromEntries(
        [
          folder(F_NEW, null, '新作の相談', 0),
          folder(F_DATED, null, '2026/10/29　港町', 0, { parentId: F_NEW, source: 'claude', v: 1 }),
          folder(F_SCENE, null, '場面の相談', 1),
          folder(F_TITLE, s.titleId, '第1章の相談', 0),
          folder(F_HIDDEN, s.hiddenId, '隠す庭の相談', 0),
        ].map((f) => [f.id, f]),
      ),
      ideas: {
        ...s.data.ideas,
        [s.authorHome[0].id]: { ...s.authorHome[0], folderId: F_NEW },
        [s.authorTitle.id]: { ...s.authorTitle, folderId: F_TITLE },
        [C_IN]: claudeIdea(C_IN, null, BODY_IN, -1, { folderId: F_DATED }),
        [C_LOOSE]: claudeIdea(C_LOOSE, null, '2026/10/29 12:00　別の案', -2),
        [C_TITLE]: claudeIdea(C_TITLE, s.titleId, '2026/10/29 12:00　灯台', -1, { folderId: F_TITLE, checked: true, checkedAt: 5 }),
      },
    }
    return { ...s, data }
  }

  it('ホームの一覧: フォルダの木（作者のフォルダの名前も出す・数は出さない・作者のカードは出さない）。フォルダの外の見出し', async () => {
    const s = withFolders()
    const { core } = await pairedCore(new FakeFirebase(), s.data)
    const list = await call(core, 'novel_get_notes', { kind: 'ideas' })
    expect(list).toBe(
      [
        '=== ホームのアイデア（どのタイトルにも属さない・Claude が作ったものだけ。2件・フォルダ 3つ）===',
        '【Claude】は Claude がこのコネクタで作ったアイデア（追記・ゴミ箱へ移すのは、そのチャットで作ったものだけ）。',
        '【フォルダ】はアイデアのフォルダ（2段まで。中のフォルダとアイデアは字下げして続く。名前の前の【Claude】は Claude が作ったフォルダ。f:… は novel_add_ideas の folder・subfolder に渡せる。名前の変更・削除・移動はアプリで作者がする）。ホームのフォルダは名前だけ（作者が作ったものも出す。中は Claude が作ったアイデアだけ）。',
        '【フォルダ】f:a1a1a1a1 新作の相談',
        '  【フォルダ】f:2b2b2b2b 【Claude】2026/10/29　港町',
        `    ${shortId('idea', C_IN)} 【Claude】2026/10/29 12:00 港町の主人公 ・灯台守の娘（30字）`,
        '【フォルダ】f:c3c3c3c3 場面の相談',
        '（フォルダの外）',
        `${shortId('idea', C_LOOSE)} 【Claude】2026/10/29 12:00 別の案（20字）`,
        '本文は ids に短い id を入れるか full=true で読めます（ids に f:… を渡すと、そのフォルダの中のアイデア）。',
        '作者が書いたホームのアイデアは見えません（フォルダの名前は見えます）。',
      ].join('\n'),
    )
    expect(list).not.toContain('ホームの作者の案')
    expect(list).not.toContain('隠す庭')
    // 本文の見出し: Claude のカードは場所にフォルダもつなぐ（フォルダの外のカードは 2.8 のまま）
    const full = await call(core, 'novel_get_notes', { kind: 'ideas', ids: [shortId('idea', C_IN), shortId('idea', C_LOOSE)] })
    expect(full).toBe(
      [
        `=== アイデア【Claude】（ホームのアイデア＞新作の相談＞2026/10/29　港町）[${shortId('idea', C_IN)}] 印: ${ideaReadMark(BODY_IN)} ===`,
        BODY_IN,
        `=== アイデア【Claude】（ホームのアイデア）[${shortId('idea', C_LOOSE)}] 印: ${ideaReadMark('2026/10/29 12:00　別の案')} ===`,
        '2026/10/29 12:00　別の案',
      ].join('\n'),
    )
    // f:… は、そのフォルダ（中のフォルダも）の見えるアイデア。空のフォルダ・見つからない f:…
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', ids: ['f:a1a1a1a1'] })).toBe(
      `=== アイデア【Claude】（ホームのアイデア＞新作の相談＞2026/10/29　港町）[${shortId('idea', C_IN)}] 印: ${ideaReadMark(BODY_IN)} ===\n${BODY_IN}`,
    )
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', ids: ['f:c3c3c3c3'] })).toBe(
      'フォルダ f:c3c3c3c3「場面の相談」の中に、見えるアイデアはありません。',
    )
    const missing = await core.callTool('novel_get_notes', { kind: 'ideas', ids: ['f:e5e5e5e5'] })
    expect(missing.isError).toBe(true)
    expect(missing.text).toBe(
      [
        'フォルダが見つかりません: f:e5e5e5e5',
        '候補:',
        '- f:a1a1a1a1 新作の相談',
        '- f:2b2b2b2b 新作の相談＞2026/10/29　港町',
        '- f:c3c3c3c3 場面の相談',
      ].join('\n'),
    )
  })

  it('タイトルの一覧はフォルダにカードの数（中の済みも）を出す。作者のカードの本文の見出しに「フォルダ: …」。場所の違う f:… は場所を言う', async () => {
    const s = withFolders()
    const { core } = await pairedCore(new FakeFirebase(), s.data)
    const t = shortId('title', s.titleId)
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', title_id: t })).toBe(
      [
        `=== 『星の庭』のアイデア（2件・うち済み 1件・フォルダ 1つ）[${t}] ===`,
        '【済】は作者が済み（実装した・没にした）にしたアイデア。済みでないものの後ろに、新しく済みにしたものから並ぶ。',
        '【Claude】は Claude がこのコネクタで作ったアイデア（追記・ゴミ箱へ移すのは、そのチャットで作ったものだけ）。',
        '【フォルダ】はアイデアのフォルダ（2段まで。中のフォルダとアイデアは字下げして続く。名前の前の【Claude】は Claude が作ったフォルダ。f:… は novel_add_ideas の folder・subfolder に渡せる。名前の変更・削除・移動はアプリで作者がする）。フォルダの（n件）は中のアイデアの数（中のフォルダの分も）。',
        '【フォルダ】f:d4d4d4d4 第1章の相談（2件）',
        `  ${shortId('idea', s.authorTitle.id)} 星の庭の作者の案（8字）`,
        `  ${shortId('idea', C_TITLE)} 【Claude】【済】2026/10/29 12:00 灯台（19字）`,
        '本文は ids に短い id を入れるか full=true で読めます（ids に f:… を渡すと、そのフォルダの中のアイデア）。',
      ].join('\n'),
    )
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', title_id: t, ids: [shortId('idea', s.authorTitle.id)] })).toBe(
      `=== アイデア [${shortId('idea', s.authorTitle.id)}] フォルダ: 第1章の相談 ===\n星の庭の作者の案`,
    )
    const elsewhere = await core.callTool('novel_get_notes', { kind: 'ideas', title_id: t, ids: ['f:a1a1a1a1'] })
    expect(elsewhere.text).toBe('f:a1a1a1a1 はホームのアイデアのフォルダです（title_id を省いてください）')
    // title_id を省くと、見せているタイトルのフォルダからも探す
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', ids: ['f:d4d4d4d4'] })).toContain(
      `[${shortId('idea', s.authorTitle.id)}] フォルダ: 第1章の相談 ===`,
    )
  })

  it('フォルダが無ければ 2.8 と1字も変わらない（タイトル）。フォルダに入っていても見えないフォルダの中なら「フォルダの外」に出る', async () => {
    const s = setup()
    const { core } = await pairedCore(new FakeFirebase(), {
      ...s.data,
      ideaFolders: { [F_HIDDEN]: folder(F_HIDDEN, s.hiddenId, '隠す庭の相談', 0) },
      // 見せないタイトルのフォルダを指す（形の崩れた）カードは、フォルダの外に見える
      ideas: { ...s.data.ideas, [s.authorTitle.id]: { ...s.authorTitle, folderId: F_HIDDEN } },
    })
    const t = shortId('title', s.titleId)
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', title_id: t })).toBe(
      [
        `=== 『星の庭』のアイデア（1件）[${t}] ===`,
        `${shortId('idea', s.authorTitle.id)} 星の庭の作者の案（8字）`,
        '本文は ids に短い id を入れるか full=true で読めます。',
      ].join('\n'),
    )
    expect(await call(core, 'novel_get_notes', { kind: 'ideas', title_id: t, ids: [shortId('idea', s.authorTitle.id)] })).toBe(
      `=== アイデア [${shortId('idea', s.authorTitle.id)}] ===\n星の庭の作者の案`,
    )
  })

  it('追記の答えの場所にもフォルダをつなぐ（「…」（ホームのアイデア＞新作の相談＞2026/10/29　港町））', async () => {
    const s = withFolders()
    const { core } = await pairedCore(new FakeFirebase(), s.data)
    const r = await core.callTool('novel_append_to_idea', { idea_id: shortId('idea', C_IN), read_mark: ideaReadMark(BODY_IN), content: '・舞台は冬' })
    expect(r.isError).toBeUndefined()
    expect(r.text.split('\n')[1]).toBe(
      `- 追記 ${shortId('idea', C_IN)} 「2026/10/29 12:00　港町の主人公」（ホームのアイデア＞新作の相談＞2026/10/29　港町）`,
    )
  })
})

describe('novel_add_ideas: フォルダ（2.9）', () => {
  const DATED = '2026/10/29　港町'
  const writesToday = async (core: Awaited<ReturnType<typeof pairedCore>>['core']) =>
    Number(/・書き込み (\d+) \//.exec(await call(core, 'novel_status'))![1])

  it('フォルダを言わない呼び出しは、何も書かずに「どのフォルダに入れますか」と候補を返す', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    const before = commits(fake)
    const r = await core.callTool('novel_add_ideas', { items: [{ content: '案' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toBe(
      [
        'フォルダが決まっていないので、何も足していません。書き込む前に作者に「どのフォルダに入れますか」と聞き、候補のフォルダの名前も出してください（ホームのアイデアのフォルダは下のとおり）。作者がフォルダを言えば folder にその名前を（2段とも言えば subfolder にも）、「任せる」なら placement="auto"、フォルダに入れないなら placement="outside" を渡して、もう一度呼んでください。',
        '候補:',
        '- （ホームのアイデアにはまだフォルダがありません。作者が名前を言えば、その名前で作ります）',
      ].join('\n'),
    )
    expect(commits(fake)).toBe(before)
    expect(connectorDocs(fake, 'ideas')).toHaveLength(0)
  })

  it('folder だけ: 1段目と2段目「日付　theme」を作り、カードと1回で書く（書き込みの数にフォルダも入る）。続けて f:… で足す', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    const writes = await writesToday(core)
    const before = commits(fake)
    const r = await core.callTool('novel_add_ideas', {
      folder: '新作の相談',
      theme: '港町',
      items: [{ name: '港町の主人公', content: '・灯台守の娘' }, { content: '・港の市場' }],
      model: 'claude-x',
    })
    const top = claudeFolderId(null, null, '新作の相談')
    const sub = claudeFolderId(null, top, DATED)
    const a = claudeIdeaId(null, DAY, '港町の主人公', '・灯台守の娘')
    const b = claudeIdeaId(null, DAY, '', '・港の市場')
    const closing = `アプリのホームのアイデア欄の「どのタイトルにも属さない」のフォルダ「新作の相談」＞「${DATED}」に、各端末が同期すると出ます。同じ相談で続けて足す時は folder に ${shortId('ideaFolder', sub)} を渡してください。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。`
    const placeLine = `入れた場所: ホームのアイデア＞新作の相談＞${DATED}（そのフォルダの済みでないアイデアの先頭。カードと、Claude が作ったフォルダに「Claude が作成」の印が付きます）`
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe(
      [
        'アイデアを足す: 追加 2件',
        `- 追加 ${shortId('idea', a)} 「2026/10/29 12:00　港町の主人公」`,
        `- 追加 ${shortId('idea', b)} 「2026/10/29 12:00　・港の市場」`,
        `フォルダ: 新作の相談 [${shortId('ideaFolder', top)}]（新しく作成）＞${DATED} [${shortId('ideaFolder', sub)}]（新しく作成）`,
        placeLine,
        closing,
      ].join('\n'),
    )
    expect(r.structured).toEqual({
      created: [
        { id: shortId('idea', a), label: `「2026/10/29 12:00　港町の主人公」（ホームのアイデア＞新作の相談＞${DATED}）` },
        { id: shortId('idea', b), label: `「2026/10/29 12:00　・港の市場」（ホームのアイデア＞新作の相談＞${DATED}）` },
      ],
      skipped: [],
    })
    // フォルダ2つとカード2枚を1回の書き込みで（フォルダが先）。書き込みの数は4
    expect(commits(fake) - before).toBe(1)
    expect(await writesToday(core)).toBe(writes + 4)
    const cloud = cloudData(fake)
    expect(cloud.ideaFolders[top]).toEqual({
      id: top,
      titleId: null,
      parentId: null,
      name: '新作の相談',
      order: 0,
      source: 'claude',
      v: 1,
      model: 'claude-x',
      createdAt: Date.UTC(2026, 9, 29, 3, 0, 0),
      updatedAt: Date.UTC(2026, 9, 29, 3, 0, 0),
    })
    expect(cloud.ideaFolders[sub]).toMatchObject({ parentId: top, name: DATED, order: 0, source: 'claude' })
    expect([cloud.ideas[a].folderId, cloud.ideas[a].order, cloud.ideas[b].folderId, cloud.ideas[b].order]).toEqual([sub, -2, sub, -1])
    // アプリの木: 新作の相談 ＞ 港町 ＞ 2枚（作者のホームのカードはフォルダの外のまま）
    const tree = buildIdeaTree(cloud, null)
    expect(tree.folders.map((f) => [f.folder.id, f.folders.map((x) => [x.folder.id, x.ideas.map((i) => i.id)])])).toEqual([
      [top, [[sub, [a, b]]]],
    ])
    expect(tree.loose.map((i) => i.id)).toEqual(s.authorHome.map((i) => i.id))
    // 一覧にも【Claude】の付いたフォルダが出る
    const list = await call(core, 'novel_get_notes', { kind: 'ideas' })
    expect(list).toContain(`【フォルダ】${shortId('ideaFolder', top)} 【Claude】新作の相談`)
    expect(list).toContain(`  【フォルダ】${shortId('ideaFolder', sub)} 【Claude】${DATED}`)
    // 続けて f:…（2段目）に足す: もとからあるフォルダ。そのフォルダの先頭に入る
    const next = await core.callTool('novel_add_ideas', { folder: shortId('ideaFolder', sub), items: [{ content: '・三つ目' }] })
    const c = claudeIdeaId(null, DAY, '', '・三つ目')
    expect(next.text).toBe(
      [
        'アイデアを足す: 追加 1件',
        `- 追加 ${shortId('idea', c)} 「2026/10/29 12:00　・三つ目」`,
        `フォルダ: 新作の相談 [${shortId('ideaFolder', top)}]（もとからあるフォルダ）＞${DATED} [${shortId('ideaFolder', sub)}]（もとからあるフォルダ）`,
        placeLine,
        closing,
      ].join('\n'),
    )
    expect(cloudData(fake).ideas[c]).toMatchObject({ folderId: sub, order: -3 })
    expect(connectorDocs(fake, 'ideaFolders')).toHaveLength(2)
  })

  it('任せる・1件はフォルダの外（その行を足す）。タイトルの2段とも: 結びはタイトルの仕切りのフォルダ', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    const one = await core.callTool('novel_add_ideas', { placement: 'auto', items: [{ content: '・一枚' }] })
    const id = claudeIdeaId(null, DAY, '', '・一枚')
    expect(one.text).toBe(
      [
        'アイデアを足す: 追加 1件',
        `- 追加 ${shortId('idea', id)} 「2026/10/29 12:00　・一枚」`,
        'フォルダ: 入れていません（任せる: 1件なのでフォルダの外）',
        '入れた場所: ホームのアイデア（どのタイトルにも属さないアイデア。済みでないアイデアの先頭。カードに「Claude が作成」の印が付きます）',
        HOME_CLOSING,
      ].join('\n'),
    )
    expect('folderId' in cloudData(fake).ideas[id]).toBe(false)
    const t = shortId('title', s.titleId)
    const scene = await core.callTool('novel_add_ideas', {
      title_id: t,
      folder: '場面の相談',
      subfolder: '雨の駅',
      items: [{ content: '・駅' }],
    })
    const top = claudeFolderId(s.titleId, null, '場面の相談')
    const sub = claudeFolderId(s.titleId, top, '雨の駅')
    expect(scene.text.split('\n').slice(2)).toEqual([
      `フォルダ: 場面の相談 [${shortId('ideaFolder', top)}]（新しく作成）＞雨の駅 [${shortId('ideaFolder', sub)}]（新しく作成）`,
      '入れた場所: タイトル『星の庭』のアイデア＞場面の相談＞雨の駅（そのフォルダの済みでないアイデアの先頭。カードと、Claude が作ったフォルダに「Claude が作成」の印が付きます）',
      `アプリのタイトル『星の庭』の「アイデア」と、ホームのアイデア欄のその仕切りの、フォルダ「場面の相談」＞「雨の駅」に、各端末が同期すると出ます。同じ相談で続けて足す時は folder に ${shortId('ideaFolder', sub)} を渡してください。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。`,
    ])
    expect(cloudData(fake).ideaFolders[sub]).toMatchObject({ titleId: s.titleId, parentId: top })
  })

  it('足すカードが無ければフォルダを作らない（重複は場所を言う）。ゴミ箱に同じ名前のフォルダがあれば補足', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const trashed = {
      id: 'te-old',
      kind: 'ideaFolder' as const,
      label: '場面の相談',
      titleName: '',
      origin: { titleId: null, index: 0 },
      recordIds: ['tr-old'],
      reason: 'deleted' as const,
      deletedAt: Date.UTC(2026, 9, 28),
      createdAt: Date.UTC(2026, 9, 28),
      updatedAt: Date.UTC(2026, 9, 28),
    }
    const record = {
      id: 'tr-old',
      entryId: 'te-old',
      table: 'ideaFolders' as const,
      record: { id: 'old-folder', titleId: null, parentId: null, name: '場面の相談', order: 0, createdAt: 1, updatedAt: 1 },
      createdAt: Date.UTC(2026, 9, 28),
      updatedAt: Date.UTC(2026, 9, 28),
    }
    const { core } = await pairedCore(fake, {
      ...s.data,
      trashEntries: { [trashed.id]: trashed },
      trashRecords: { [record.id]: record },
    })
    await call(core, 'novel_add_ideas', { folder: '新作の相談', theme: '港町', items: [{ content: '・案' }] })
    const before = commits(fake)
    const dup = await core.callTool('novel_add_ideas', { folder: '場面の相談', theme: '港町', items: [{ content: '・案' }] })
    const id = claudeIdeaId(null, DAY, '', '・案')
    expect(dup.text).toBe(
      [
        'アイデアを足す: 重複 1件',
        `- 重複 ${shortId('idea', id)} 「2026/10/29 12:00　・案」: 同じ内容のアイデアがもうあります（追加しません）（場所: ホームのアイデア＞新作の相談＞${DATED}）`,
        'フォルダは作りませんでした（足すカードが無いため）。',
      ].join('\n'),
    )
    expect(commits(fake)).toBe(before)
    expect(connectorDocs(fake, 'ideaFolders')).toHaveLength(2)
    // 新しく作る時は、ゴミ箱の同じ名前のフォルダを補足に書く
    const made = await core.callTool('novel_add_ideas', { folder: '場面の相談', theme: '港町', items: [{ content: '・別の案' }] })
    expect(made.text).toContain(
      '\n補足: ゴミ箱にも同じ名前のフォルダ「場面の相談」があります（新しく作りました。前のフォルダは作者がアプリのゴミ箱から戻せます）\n入れた場所: ',
    )
  })

  it('ほかの接続が同じ1段目を同じ時に作った（409）: 読み直して、そのフォルダを使う（もとからあるフォルダ）', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core, clock } = await pairedCore(fake, s.data)
    const top = claudeFolderId(null, null, '新作の相談')
    const sub = claudeFolderId(null, top, DATED)
    // 書く直前に、ほかの接続が同じ id の1段目を作った
    fake.beforeCommit = () =>
      fake.putRecord(
        OWNER,
        'ideaFolders',
        { id: top, titleId: null, parentId: null, name: '新作の相談', order: 0, source: 'claude', v: 1, createdAt: clock.now, updatedAt: clock.now } as never,
        { device: 'claude-connector' },
      )
    const r = await core.callTool('novel_add_ideas', { folder: '新作の相談', theme: '港町', items: [{ content: '・案' }] })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain(
      `\nフォルダ: 新作の相談 [${shortId('ideaFolder', top)}]（もとからあるフォルダ）＞${DATED} [${shortId('ideaFolder', sub)}]（新しく作成）\n`,
    )
    const cloud = cloudData(fake)
    expect(Object.keys(cloud.ideaFolders).sort()).toEqual([top, sub].sort())
    expect(cloud.ideas[claudeIdeaId(null, DAY, '', '・案')].folderId).toBe(sub)
  })

  /** 答えの結びの「folder に f:… を渡してください（…）」のとおりの入力（f:… と、渡さないと言われたものを除いた入力） */
  const followAdvice = (text: string) => {
    const m = /同じ相談で続けて足す時は folder に (f:[0-9a-z]+) を渡してください(（theme・subfolder は渡さない）)?。/.exec(text)
    expect(m, text).not.toBeNull()
    return { ref: m![1], only: Boolean(m![2]) }
  }

  it('任せる（2件）の答えの結びのとおりに、f:… だけで続けて足すと、同じ1段目にじかに入る（入れ子のフォルダを作らない）', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const { core } = await pairedCore(fake, s.data)
    const first = await core.callTool('novel_add_ideas', {
      placement: 'auto',
      theme: '港町',
      items: [{ content: '・一' }, { content: '・二' }],
    })
    const top = claudeFolderId(null, null, DATED)
    const ref = shortId('ideaFolder', top)
    const closing = `アプリのホームのアイデア欄の「どのタイトルにも属さない」のフォルダ「${DATED}」に、各端末が同期すると出ます。同じ相談で続けて足す時は folder に ${ref} を渡してください（theme・subfolder は渡さない）。追記は novel_append_to_idea で（先に novel_get_notes で今の中身を読む）。本文（稿）は書き換えていません。`
    const placeLine = `入れた場所: ホームのアイデア＞${DATED}（そのフォルダの済みでないアイデアの先頭。カードと、Claude が作ったフォルダに「Claude が作成」の印が付きます）`
    expect(first.text.split('\n').slice(3)).toEqual([`フォルダ: ${DATED} [${ref}]（新しく作成）`, placeLine, closing])
    const advice = followAdvice(first.text)
    expect(advice).toEqual({ ref, only: true })
    // 結びのとおり: folder に f:… だけ（theme・subfolder は渡さない）
    const next = await core.callTool('novel_add_ideas', { folder: advice.ref, items: [{ content: '・三' }] })
    const c = claudeIdeaId(null, DAY, '', '・三')
    expect(next.isError).toBeUndefined()
    expect(next.text).toBe(
      [
        'アイデアを足す: 追加 1件',
        `- 追加 ${shortId('idea', c)} 「2026/10/29 12:00　・三」`,
        `フォルダ: ${DATED} [${ref}]（もとからあるフォルダ）`,
        placeLine,
        closing,
      ].join('\n'),
    )
    expect(followAdvice(next.text)).toEqual({ ref, only: true })
    const cloud = cloudData(fake)
    expect(cloud.ideas[c]).toMatchObject({ folderId: top, order: -3 })
    expect(connectorDocs(fake, 'ideaFolders')).toHaveLength(1)
    const tree = buildIdeaTree(cloud, null)
    expect(tree.folders.map((f) => [f.folder.id, f.folders.length, f.ideas.length])).toEqual([[top, 0, 3]])
  })

  it('1段目に見えても記録に親へのつながりが残るフォルダ（同期で C→A→B）: 中に2段目を作らず、じかに入れて補足で言う。結びのとおりに続けて足せる', async () => {
    const fake = new FakeFirebase()
    const s = setup()
    const folder = (id: string, name: string, parentId: string | null, order: number): IdeaFolder => ({
      id,
      titleId: null,
      parentId,
      name,
      order,
      createdAt: 1,
      updatedAt: 1,
    })
    // 作者のフォルダ: 「別」（A）は「置き場」（B）の中、「新作の相談」（C）は記録では A の中（1段目に見える）
    const bId = 'b1b1b1b1-0000-4000-8000-000000000001'
    const aId = 'a1a1a1a1-0000-4000-8000-000000000002'
    const cId = 'c1c1c1c1-0000-4000-8000-000000000003'
    const folders = [folder(bId, '置き場', null, 0), folder(aId, '別', bId, 0), folder(cId, '新作の相談', aId, 1)]
    const { core } = await pairedCore(fake, { ...s.data, ideaFolders: Object.fromEntries(folders.map((f) => [f.id, f])) })
    const ref = shortId('ideaFolder', cId)
    const r = await core.callTool('novel_add_ideas', { folder: '新作の相談', theme: '港町', items: [{ content: '・一' }] })
    expect(r.isError).toBeUndefined()
    expect(r.text.split('\n').slice(2, 4)).toEqual([
      `フォルダ: 新作の相談 [${ref}]（もとからあるフォルダ）`,
      '補足: フォルダ「新作の相談」は、アプリでの移動がぶつかって中に新しいフォルダを作れない状態なので、そのフォルダにじかに入れました（作者がアプリでそのフォルダの「移動…」から「1段目にする」を選ぶと直ります）',
    ])
    expect(connectorDocs(fake, 'ideaFolders')).toHaveLength(0)
    expect(cloudData(fake).ideas[claudeIdeaId(null, DAY, '', '・一')].folderId).toBe(cId)
    // 結びのとおり f:… だけで続けて足す: 同じフォルダにじかに（補足は出ない）
    const advice = followAdvice(r.text)
    expect(advice).toEqual({ ref, only: true })
    const next = await core.callTool('novel_add_ideas', { folder: advice.ref, items: [{ content: '・二' }] })
    expect(next.isError).toBeUndefined()
    expect(next.text).not.toContain('補足:')
    const cloud = cloudData(fake)
    expect(cloud.ideas[claudeIdeaId(null, DAY, '', '・二')].folderId).toBe(cId)
    // アプリの木でも、2枚とも1段目「新作の相談」にじかに見える
    const tree = buildIdeaTree(cloud, null)
    expect(tree.folders.map((f) => [f.folder.name, f.folders.length, f.ideas.length])).toEqual([
      ['置き場', 1, 0],
      ['新作の相談', 0, 2],
    ])
  })
})
