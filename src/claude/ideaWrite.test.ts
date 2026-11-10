// Claude がコネクタでアイデア欄に書く（2.8）組み立て: アイデアを足す（場所・1行目・並びの位置・Markdown・上限・重複）と、
// アイデアに追記する依頼（指せるアイデア・断る理由・読んだ印・送り直し・頼み直し）。
import { describe, expect, it } from 'vitest'
import { createTitle } from '../domain/entityOps'
import { hashJson } from '../domain/hash'
import type { AppData, ClaudeAccess, ID, Idea, IdeaAppend, TrashRecord, TrashRequest } from '../domain/types'
import { novel } from '../test/claudeFixture'
import { jstDate } from './dates'
import { claudeIdeaId, ideaAppendId, trashRequestId } from './derivedId'
import { appendedBody, claudeIdeaBody, ideaReadMark, isClaudeIdea } from './ideaAppend'
import { buildAddIdeas, buildIdeaAppend, ideaMarkdownLines, isIdeaTool, markdownHint, type IdeaWriteContext } from './ideaWrite'
import { shortId } from './refs'
import { claudeView } from './visibility'

/** 2026/11/12 14:32（日本時間） */
const AT = Date.UTC(2026, 10, 12, 5, 32, 10)

/** コネクタが作る形の Claude のアイデア */
function claudeIdea(titleId: ID | null, name: string, content: string, at = AT, over: Partial<Idea> = {}): Idea {
  const body = claudeIdeaBody(at, name, content)
  return {
    id: claudeIdeaId(titleId, jstDate(at), name, content),
    titleId,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order: 0,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: at,
    updatedAt: at,
    ...over,
  }
}

function authorIdea(id: ID, titleId: ID | null, body: string, order = 0, over: Partial<Idea> = {}): Idea {
  return { id, titleId, heading: '', body, checked: false, checkedAt: null, order, createdAt: 1, updatedAt: 1, ...over }
}

/** 『星の庭』（読む＋書き込む）・『読む庭』（読むだけ）・『隠す庭』（見せない） */
function setup(ideas: Idea[] = []) {
  const n = novel(['本文。'], { name: '星の庭' })
  const ro = createTitle(n.data, '読む庭')
  const hidden = createTitle(ro.data, '隠す庭')
  const access = (id: ID, a: ClaudeAccess) => ({ ...hidden.data.titles[id], claudeAccess: a })
  const data: AppData = {
    ...hidden.data,
    titles: { ...hidden.data.titles, [ro.result]: access(ro.result, 'read'), [hidden.result]: access(hidden.result, 'none') },
    ideas: Object.fromEntries(ideas.map((i) => [i.id, i])),
  }
  return { data, titleId: n.titleId, readId: ro.result, hiddenId: hidden.result }
}

const ctx = (over: Partial<IdeaWriteContext> = {}): IdeaWriteContext => ({ now: AT, wasDeleted: () => false, ...over })

const add = (data: AppData, input: Record<string, unknown>, c = ctx()) => buildAddIdeas(data, claudeView(data), input, c)

describe('ideaMarkdownLines', () => {
  it('行の頭の見出し・箇条書き・引用・コード・表・区切り線と、太字・リンクを見つける（行の番号つき）', () => {
    const text = [
      '## 動機',
      '- 父との確執',
      '* 星',
      '+ 海',
      '> 引用',
      '```',
      '| a | b |',
      '|---|---|',
      '---',
      '**太字**の行',
      '__強調__',
      '[リンク](https://example.com)',
      '[目次](#a)',
    ].join('\n')
    expect(ideaMarkdownLines(text).map((l) => l.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('「1. 」「#12」「・」【】、ただの記号は使える', () => {
    const ok = [
      '1. 冒頭',
      '#12 で兄が戻る',
      '・兄を探す',
      '【動機】',
      '-5度の朝',
      '*注',
      'a | b',
      '［メモ］(仮)',
      '2026/11/12 14:32',
    ].join('\r\n')
    expect(ideaMarkdownLines(ok)).toEqual([])
  })

  it('直し方は3行まで（1行は20字まで）。残りの数も言う', () => {
    const lines = ideaMarkdownLines(['## 動機', 'ふつう', '- 父との確執', `- ${'あ'.repeat(30)}`, '> 引用'].join('\n'))
    expect(markdownHint(lines)).toBe(
      `Markdown の記号があります（1行目「## 動機」・3行目「- 父との確執」・4行目「- ${'あ'.repeat(17)}…」・ほか1行）。カードは Markdown を変換せずにそのまま出すので、記号を使わず、箇条書きは「・」、小見出しは【】で書き直して送ってください`,
    )
  })

  it('ツールの名前', () => {
    expect([isIdeaTool('novel_add_ideas'), isIdeaTool('novel_append_to_idea'), isIdeaTool('novel_add_revision_ideas')]).toEqual([
      true,
      true,
      false,
    ])
  })
})

describe('buildAddIdeas', () => {
  it('ホームのアイデア: 1行目は日付と時刻（名前はその後ろ）、2行目から中身。Claude の印の形で、見出しは空', () => {
    const s = setup()
    const r = add(s.data, { items: [{ name: '第3章の動機', content: '\r\n\n【動機】\r\n・兄を探す　\n' }], model: ' claude-x ' })
    expect(r.ok).toBe(true)
    expect([r.titleId, r.place, r.titleName]).toEqual([null, 'ホームのアイデア', ''])
    const rec = r.records[0].record
    const body = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'
    expect(rec).toEqual({
      id: claudeIdeaId(null, '2026-11-12', '第3章の動機', '【動機】\n・兄を探す'),
      titleId: null,
      heading: '',
      body,
      checked: false,
      checkedAt: null,
      order: -1,
      source: 'claude',
      v: 1,
      model: 'claude-x',
      claudeHash: hashJson(body),
      createdAt: AT,
      updatedAt: AT,
    })
    expect(isClaudeIdea(rec)).toBe(true)
    expect(r.items).toEqual([{ index: 0, status: 'created', id: rec.id, label: '「2026/11/12 14:32　第3章の動機」' }])
    // 名前が無ければ1行目は日付と時刻だけ。model を渡さなければ持たない
    const plain = add(s.data, { items: [{ content: '星の案' }] }).records[0].record
    expect(plain.body).toBe('2026/11/12 14:32\n星の案')
    expect('model' in plain).toBe(false)
  })

  it('タイトルのアイデア（読む＋書き込む）。「読むだけ」は断り、「見せない」は見つからない。空の title_id も断る', () => {
    const s = setup()
    const r = add(s.data, { title_id: '星の庭', items: [{ content: '案' }] })
    expect([r.ok, r.titleId, r.place, r.titleName]).toEqual([true, s.titleId, 'タイトル『星の庭』のアイデア', '星の庭'])
    expect(r.records[0].record.titleId).toBe(s.titleId)
    const ro = add(s.data, { title_id: shortId('title', s.readId), items: [{ content: '案' }] })
    expect(ro.ok).toBe(false)
    expect(ro.error).toBe(
      'タイトル『読む庭』は「Claude に見せる」が「読むだけ」なので書き込めません（アプリのタイトル画面で「読む＋書き込む」にすると書き込めます。ホームのアイデアに入れる時は、作者に確かめてから title_id を省いて送ってください）',
    )
    const hidden = add(s.data, { title_id: '隠す庭', items: [{ content: '案' }] })
    expect(hidden.ok).toBe(false)
    expect(hidden.error).toContain("タイトル '隠す庭' が見つかりません（Claude に見せていないタイトルは使えません")
    expect(hidden.candidates?.join('')).not.toContain('隠す庭')
    expect(add(s.data, { title_id: '  ', items: [{ content: '案' }] }).error).toBe(
      'title_id が空です（ホームのアイデアに入れる時は省いてください）',
    )
    expect(add(s.data, { items: [] }).ok).toBe(false)
    const many = add(s.data, { items: Array.from({ length: 11 }, (_, i) => ({ content: `案${i}` })) })
    expect(many.error).toBe('1回に足せるアイデアは10件までです（いま 11件。分けて呼んでください）')
  })

  it('並びの位置: その場所の済みでないアイデアの最小の order から前に、渡した順（済み・ほかの場所・見せないアイデアも raw で数える）', () => {
    const s0 = setup()
    const s = setup([
      authorIdea('a1', s0.titleId, '作者1', 3),
      authorIdea('a2', s0.titleId, '作者2', 5),
      authorIdea('a3', s0.titleId, '済み', -50, { checked: true, checkedAt: 2 }),
      authorIdea('h1', null, '作者のホーム', -7),
      authorIdea('x1', s0.hiddenId, '隠す', -100),
    ])
    // createTitle の id は毎回新しいので、同じデータの中のタイトルを使う
    const titleId = Object.values(s.data.titles).find((t) => t.name === '星の庭')!.id
    const data: AppData = {
      ...s.data,
      ideas: Object.fromEntries(Object.values(s.data.ideas).map((i) => [i.id, i.titleId === s0.titleId ? { ...i, titleId } : i])),
    }
    const r = add(data, { title_id: titleId, items: [{ content: '一' }, { content: '二' }, { content: '三' }] })
    expect(r.records.map((x) => x.record.order)).toEqual([0, 1, 2])
    // ホームは作者が書いた（見えない）ホームのアイデアも数える
    const home = add(data, { items: [{ content: '一' }, { content: '二' }] })
    expect(home.records.map((x) => x.record.order)).toEqual([-9, -8])
    // 済みでないアイデアが無い場所は 0 から前
    const empty = add(setup().data, { items: [{ content: '一' }, { content: '二' }] })
    expect(empty.records.map((x) => x.record.order)).toEqual([-2, -1])
    // 足さないもの（重複・形が違う）は数えない
    const mixed = add(setup().data, { items: [{ content: '一' }, { content: '' }, { content: '一' }, { content: '二' }] })
    expect(mixed.items.map((x) => x.status)).toEqual(['created', 'invalid', 'duplicate', 'created'])
    expect(mixed.records.map((x) => x.record.order)).toEqual([-2, -1])
  })

  it('Markdown の記号は足さずに、その行を返す（行の番号はカードと同じ。1行目は日付と名前）。ほかのアイデアは足す', () => {
    const s = setup()
    const r = add(s.data, {
      items: [
        { name: '動機', content: '【動機】\n## 父\n・兄\n- 父との確執' },
        { name: '**強い名前**', content: '中身' },
        { content: '1. 冒頭\n#12 で戻る\n・兄を探す\n【伏線】' },
      ],
    })
    expect(r.items.map((x) => [x.status, x.label])).toEqual([
      ['invalid', 'アイデア（1件目）'],
      ['invalid', 'アイデア（2件目）'],
      ['created', '「2026/11/12 14:32　1. 冒頭」'],
    ])
    expect(r.items[0].hint).toContain('Markdown の記号があります（3行目「## 父」・5行目「- 父との確執」）')
    expect(r.items[1].hint).toContain('1行目「**強い名前**」')
    expect(r.records).toHaveLength(1)
  })

  it('上限: 中身は20,000字（分け方を言う）、記録は JSON にして 50,000字', () => {
    const s = setup()
    const ok = add(s.data, { items: [{ content: 'あ'.repeat(20_000) }] })
    expect(ok.items[0].status).toBe('created')
    const long = add(s.data, { items: [{ content: 'あ'.repeat(45_001) }] })
    expect(long.items[0]).toMatchObject({ status: 'invalid' })
    expect(long.items[0].hint).toBe(
      'content は20,000字までです（いま 45,001字）。3つのアイデアに分け、name に「（1/3）」のような番号を付けて足してください',
    )
    expect(add(s.data, { items: [{ content: '𠮷'.repeat(20_000) }] }).items[0].status).toBe('created')
    // 制御文字は JSON で6字になる
    const big = add(s.data, { items: [{ content: `あ${'\u0001'.repeat(9_000)}い` }, { content: 'ふつう' }] })
    expect(big.items[0].status).toBe('invalid')
    expect(big.items[0].id).toBeUndefined()
    expect(big.items[0].hint).toMatch(
      /^アイデアが大きすぎます（1件は JSON にして 50,000字まで。いま 54,\d{3}字）。2つのアイデアに分け/,
    )
    expect(big.records.map((x) => x.record.order)).toEqual([-1])
    expect(add(s.data, { items: [{ content: '  \n ' }] }).items[0].hint).toBe('content が空です')
  })

  it('同じ日に同じ場所・名前・中身は重複（同じ呼び出しの中も）。日が変われば足せる。名前・場所が違えば別のアイデア', () => {
    const s = setup()
    const first = add(s.data, { items: [{ name: '動機', content: '案' }] })
    const data: AppData = { ...s.data, ideas: { ...s.data.ideas, [first.records[0].record.id]: first.records[0].record } }
    const again = add(
      data,
      {
        items: [
          { name: '動機', content: '案\n' },
          { name: '動機', content: '案' },
        ],
      },
      ctx({ now: AT + 3_600_000 }),
    )
    expect(again.items.map((x) => x.status)).toEqual(['duplicate', 'duplicate'])
    // Claude に見えているカードは、そのカードの1行目（送り直した 15:32 ではなく、作った 14:32）と id
    expect(again.items[0]).toMatchObject({
      id: first.records[0].record.id,
      label: '「2026/11/12 14:32　動機」',
      hint: '同じ内容のアイデアがもうあります（追加しません）',
      existing: true,
    })
    expect(again.records).toHaveLength(0)
    const nextDay = add(data, { items: [{ name: '動機', content: '案' }] }, ctx({ now: AT + 86_400_000 }))
    expect(nextDay.items[0].status).toBe('created')
    expect(add(data, { items: [{ name: '別', content: '案' }] }).items[0].status).toBe('created')
    expect(add(data, { title_id: s.titleId, items: [{ name: '動機', content: '案' }] }).items[0].status).toBe('created')
    const twice = add(s.data, { items: [{ content: '同じ' }, { content: '同じ' }] })
    expect(twice.items.map((x) => x.status)).toEqual(['created', 'duplicate'])
    // 同じ呼び出しの中の重複は、まだ見えるカードが無い（入力から作った表記。id は1件目と同じ）
    expect(twice.items[1]).toMatchObject({ id: twice.items[0].id, label: twice.items[0].label })
    expect(twice.items[1].existing).toBeUndefined()
  })

  it('名前の無いアイデアの表記は、日付と時刻の後ろに中身の最初の行（同じ時刻に作ったカードを見分ける）。重複は、もうあるカードの表記', () => {
    const s = setup()
    const before = claudeIdea(null, '', '港町の案\n・灯台', AT - 3 * 60_000)
    const data: AppData = { ...s.data, ideas: { [before.id]: before } }
    const r = add(data, {
      items: [{ content: '港町の案\n・灯台' }, { content: '\n  山の町の案  \n・峠' }, { content: '【動機】\n・兄を探す' }],
    })
    expect(r.items.map((x) => [x.status, x.label])).toEqual([
      ['duplicate', '「2026/11/12 14:29　港町の案」'],
      ['created', '「2026/11/12 14:32　山の町の案」'],
      ['created', '「2026/11/12 14:32　【動機】」'],
    ])
    expect(r.items[0]).toMatchObject({ id: before.id, existing: true })
    // カードの本文は変えない（1行目は日付と時刻だけ。中身の行の前後の空白も残る）
    expect(r.records.map((x) => x.record.body)).toEqual([
      '2026/11/12 14:32\n  山の町の案  \n・峠',
      '2026/11/12 14:32\n【動機】\n・兄を探す',
    ])
  })

  it('見せないタイトルへ移したアイデアと同じ内容も重複（中身は出さず、入力から作った表記だけ）。以前に削除されたものは作り直さない', () => {
    const s = setup()
    const moved = { ...claudeIdea(null, '動機', '秘密の案'), titleId: s.hiddenId }
    const data: AppData = { ...s.data, ideas: { [moved.id]: moved } }
    expect(claudeView(data).ideas[moved.id]).toBeUndefined()
    const r = add(data, { items: [{ name: '動機', content: '秘密の案' }] })
    expect(r.items[0]).toEqual({
      index: 0,
      status: 'duplicate',
      id: moved.id,
      label: '「2026/11/12 14:32　動機」',
      hint: '同じ内容のアイデアがもうあります（追加しません）',
    })
    const deleted = add(
      s.data,
      { items: [{ content: '消した案' }] },
      ctx({ wasDeleted: (t, id) => t === 'ideas' && id.startsWith('cy-') }),
    )
    expect(deleted.items[0]).toMatchObject({
      status: 'previously_deleted',
      hint: '以前に削除されたアイデアです（追加しません。作者はアプリのゴミ箱から戻せます）',
    })
    expect(deleted.records).toHaveLength(0)
  })
})

// ---------- アイデアに追記 ----------

const NOW = Date.UTC(2026, 10, 14, 1, 0, 0)

function appendSetup() {
  const s0 = setup()
  const home = claudeIdea(null, '第3章の動機', '【動機】\n・兄を探す')
  const inTitle = claudeIdea(s0.titleId, '', '星の案')
  const readOnly = claudeIdea(s0.readId, '', '読む庭の案')
  const hiddenIdea = claudeIdea(s0.hiddenId, '', '隠す庭の案')
  const authorHome = authorIdea('3f2a9c1b-0000-4000-8000-000000000001', null, '作者のホームの案')
  const authorTitle = authorIdea('7a1b2c3d-0000-4000-8000-000000000002', s0.titleId, '作者のタイトルの案')
  const data: AppData = {
    ...s0.data,
    ideas: Object.fromEntries([home, inTitle, readOnly, hiddenIdea, authorHome, authorTitle].map((i) => [i.id, i])),
  }
  return { ...s0, data, home, inTitle, readOnly, hiddenIdea, authorHome, authorTitle }
}

const append = (data: AppData, input: Record<string, unknown>, c = ctx({ now: NOW })) =>
  buildIdeaAppend(data, claudeView(data), input, c)

function req(idea: Idea, text: string, over: Partial<IdeaAppend> = {}): IdeaAppend {
  const mark = ideaReadMark(idea.body)
  return {
    id: ideaAppendId(idea.id, mark, text),
    ideaId: idea.id,
    text,
    readMark: mark,
    source: 'claude',
    v: 1,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
  }
}

describe('buildIdeaAppend', () => {
  it('読んだ印が今の中身と合えば、依頼を1件作る（id はアイデア・印・内容から。内容はそろえる）', () => {
    const s = appendSetup()
    const mark = ideaReadMark(s.home.body)
    const r = append(s.data, {
      idea_id: shortId('idea', s.home.id),
      read_mark: ` ${mark} `,
      content: '\r\n舞台を山の町に変える\n\n',
    })
    expect(r.status).toBe('created')
    expect(r.label).toBe('「2026/11/12 14:32　第3章の動機」（ホームのアイデア）')
    expect(r.records).toEqual([
      {
        table: 'ideaAppends',
        record: {
          id: ideaAppendId(s.home.id, mark, '舞台を山の町に変える'),
          ideaId: s.home.id,
          text: '舞台を山の町に変える',
          readMark: mark,
          source: 'claude',
          v: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ])
    expect(r.records[0].record.id).toMatch(/^cu-/)
    // タイトルのアイデアにも（「読む＋書き込む」）
    const t = append(s.data, { idea_id: s.inTitle.id, read_mark: ideaReadMark(s.inTitle.body), content: '追記' })
    expect([t.status, t.label]).toEqual(['created', '「2026/11/12 14:32　星の案」（タイトル『星の庭』のアイデア）'])
  })

  it('読んだ印は「印: …」のまま・全角のコロン・英大文字・全角の英数字でもよい（同じ依頼の id）。形の違う印は「形が違う」（読み直しではない）', () => {
    const s = appendSetup()
    const mark = ideaReadMark(s.home.body)
    const ref = shortId('idea', s.home.id)
    const bare = append(s.data, { idea_id: ref, read_mark: mark, content: '追記' })
    expect(bare.status).toBe('created')
    const fullWidth = Array.from(mark.toUpperCase())
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
      .join('')
    for (const written of [
      `印: ${mark}`,
      `印：${mark}`,
      ` 印 ： ${mark.toUpperCase()} `,
      mark.toUpperCase(),
      fullWidth,
      `印:${mark}`,
    ]) {
      const r = append(s.data, { idea_id: ref, read_mark: written, content: '追記' })
      expect([written, r.status, r.requestId]).toEqual([written, 'created', bare.requestId])
      expect(r.records[0].record).toEqual(bare.records[0].record)
    }
    expect(bare.records[0].record.readMark).toBe(mark)
    // 送り直し（依頼済み）も、書き方によらず同じ依頼
    const pendingData: AppData = { ...s.data, ideaAppends: { [bare.requestId!]: bare.records[0].record } }
    expect(append(pendingData, { idea_id: ref, read_mark: `印: ${mark.toUpperCase()}`, content: '追記' })).toMatchObject({
      status: 'pending',
      requestId: bare.requestId,
    })
    // 形が違う: 8字でない・記号がある・別の見出しの字（読み直しを求めない）
    for (const bad of [
      'x',
      `${mark}9`,
      mark.slice(0, 7),
      `印: ${mark} ===`,
      `[${mark}]`,
      `i:${mark}`,
      `印: ${mark.slice(0, 4)}-${mark.slice(4)}`,
    ]) {
      const r = append(s.data, { idea_id: ref, read_mark: bad, content: '追記' })
      expect([bad, r.status, r.hint]).toEqual([
        bad,
        'invalid',
        'read_mark の形が違います（novel_get_notes（kind=ideas・ids にこの id）の本文の見出しの「印: 」の後ろの8字を渡してください。例 1i30lfcq）',
      ])
      expect(r.records).toEqual([])
    }
    // 形は合うが今の中身の印と違う: 読んだ後に中身が変わった
    const other = mark === 'aaaaaaaa' ? 'bbbbbbbb' : 'aaaaaaaa'
    expect(append(s.data, { idea_id: ref, read_mark: `印: ${other}`, content: '追記' }).status).toBe('stale')
    // 空・無い
    expect(append(s.data, { idea_id: ref, read_mark: '  ', content: '追記' }).hint).toBe(
      'read_mark がありません（novel_get_notes で今の中身を読み、本文の見出しの「印: 」の後ろの8字を渡してください）',
    )
  })

  it('見つからない: 無い id・作者が書いたホームのアイデア・見せないタイトルのアイデアは同じ答え（ある・無いを言わない）', () => {
    const s = appendSetup()
    const hints = [shortId('idea', 'cy-zzzzzzzz'), shortId('idea', s.authorHome.id), shortId('idea', s.hiddenIdea.id)].map(
      (ref) => {
        const r = append(s.data, { idea_id: ref, read_mark: 'x', content: '追記' })
        expect([r.status, r.ideaId, r.label]).toEqual(['not_found', undefined, undefined])
        return r.hint
      },
    )
    expect(new Set(hints).size).toBe(1)
    expect(hints[0]).toBe(
      '見つかりません（novel_get_notes の kind=ideas で id を確かめてください。作者が書いたホームのアイデアと「見せない」タイトルのアイデアは見えません）',
    )
  })

  it('作者が書いたアイデア・「読むだけ」のタイトル・ゴミ箱へ移す依頼中・ゴミ箱にある・短い id が決まらない', () => {
    const s = appendSetup()
    const content = '追記'
    const authored = append(s.data, { idea_id: shortId('idea', s.authorTitle.id), read_mark: 'x', content })
    expect([authored.status, authored.label]).toEqual(['not_claude', '「作者のタイトルの案」（タイトル『星の庭』のアイデア）'])
    expect(authored.hint).toBe(
      '作者が書いたアイデアには追記できません（追記できるのは、Claude がこのコネクタで作ったアイデアだけ）',
    )
    const ro = append(s.data, { idea_id: shortId('idea', s.readOnly.id), read_mark: ideaReadMark(s.readOnly.body), content })
    expect(ro.status).toBe('not_writable')
    expect(ro.hint).toBe(
      'タイトル『読む庭』は「Claude に見せる」が「読むだけ」なので追記できません（作者がタイトル画面で「読む＋書き込む」にすると追記できます）',
    )
    // ゴミ箱へ移す依頼の出ているアイデア（見せる内容からは外れている）
    const trashReq: TrashRequest = {
      id: trashRequestId('ideas', s.home.id),
      table: 'ideas',
      targetId: s.home.id,
      parentId: 'home',
      targetUpdatedAt: AT,
      label: 'ホームのアイデア「…」',
      source: 'claude',
      v: 2,
      createdAt: AT,
      updatedAt: AT,
    }
    const asked = append(
      { ...s.data, trashRequests: { [trashReq.id]: trashReq } },
      { idea_id: shortId('idea', s.home.id), read_mark: 'x', content },
    )
    expect([asked.status, asked.hint]).toEqual(['pending_trash', 'ゴミ箱へ移す依頼の出ているアイデアです（追記できません）'])
    // ゴミ箱にある（Claude が作ったアイデアだけ。作者が書いたアイデアはゴミ箱にあっても「見つからない」）
    const { [s.home.id]: _home, [s.authorHome.id]: _author, ...rest } = s.data.ideas
    const trashRecord = (id: string, record: Idea): TrashRecord => ({
      id,
      entryId: 'e1',
      table: 'ideas',
      record,
      createdAt: 1,
      updatedAt: 1,
    })
    const trashed: AppData = {
      ...s.data,
      ideas: rest,
      trashRecords: { r1: trashRecord('r1', s.home), r2: trashRecord('r2', s.authorHome) },
    }
    expect(append(trashed, { idea_id: shortId('idea', s.home.id), read_mark: 'x', content }).status).toBe('in_trash')
    expect(append(trashed, { idea_id: shortId('idea', s.authorHome.id), read_mark: 'x', content }).status).toBe('not_found')
    // 短い id が2枚に当たる
    const a = { ...s.home, id: 'cy-abcd1111' }
    const b = { ...s.home, id: 'cy-abcd2222', body: `${s.home.body}2` }
    const two = append({ ...s.data, ideas: { [a.id]: a, [b.id]: b } }, { idea_id: 'i:abcd', read_mark: 'x', content })
    expect(two.status).toBe('ambiguous')
    expect(two.candidates).toEqual([
      'i:abcd1111 「2026/11/12 14:32　第3章の動機」（ホームのアイデア）',
      'i:abcd2222 「2026/11/12 14:32　第3章の動機」（ホームのアイデア）',
    ])
  })

  it('形が違う: 空・20,000字を超える・Markdown・印が無い。1枚が100,000字を超えるなら新しいアイデアにするよう答える', () => {
    const s = appendSetup()
    const mark = ideaReadMark(s.home.body)
    const ref = shortId('idea', s.home.id)
    expect(append(s.data, { idea_id: ref, read_mark: mark, content: ' \n' }).hint).toBe('content が空です')
    expect(append(s.data, { idea_id: ref, read_mark: mark, content: 'あ'.repeat(20_001) }).hint).toBe(
      'content は20,000字までです（いま 20,001字。分けて追記してください）',
    )
    expect(append(s.data, { idea_id: ref, read_mark: mark, content: 'あ'.repeat(20_000) }).status).toBe('created')
    const md = append(s.data, { idea_id: ref, read_mark: mark, content: '【変更】\n- 舞台を山へ' })
    expect(md.status).toBe('invalid')
    expect(md.hint).toContain('Markdown の記号があります（2行目「- 舞台を山へ」）。')
    expect(append(s.data, { idea_id: ref, read_mark: '', content: 'x' }).status).toBe('invalid')
    expect(append(s.data, { idea_id: '', read_mark: mark, content: 'x' }).status).toBe('invalid')
    // 1枚 100,000字まで
    const longBody = `${s.home.body}\n${'あ'.repeat(85_000)}`
    const big = { ...s.home, body: longBody, claudeHash: hashJson(longBody) }
    const data: AppData = { ...s.data, ideas: { ...s.data.ideas, [big.id]: big } }
    const r = append(data, { idea_id: ref, read_mark: ideaReadMark(longBody), content: 'い'.repeat(15_000) })
    expect(r.status).toBe('too_long')
    expect(r.hint).toBe(
      `カードが長くなりすぎます（1枚 100,000字まで。いま ${Array.from(longBody).length.toLocaleString('ja-JP')}字・追記 15,000字）。新しいアイデアとして novel_add_ideas で足してください`,
    )
  })

  it('読んだ後に中身が変わっていれば断る（作者が直した・ほかの追記が入った）。作者が直したアイデアにも、読み直せば追記できる', () => {
    const s = appendSetup()
    const old = ideaReadMark(s.home.body)
    const editedBody = `${s.home.body}\n作者の行`
    const edited: AppData = { ...s.data, ideas: { ...s.data.ideas, [s.home.id]: { ...s.home, body: editedBody } } }
    const stale = append(edited, { idea_id: shortId('idea', s.home.id), read_mark: old, content: '追記' })
    expect(stale.status).toBe('stale')
    expect(stale.hint).toContain('novel_get_notes で読み直し')
    expect(stale.records).toEqual([])
    expect(
      append(edited, { idea_id: shortId('idea', s.home.id), read_mark: ideaReadMark(editedBody), content: '追記' }).status,
    ).toBe('created')
  })

  it('送り直し: 依頼がまだ出ていれば「依頼済み」（当てた後の中身で印が変わっていても）、アプリが足した後は「もう足されています」', () => {
    const s = appendSetup()
    const mark = ideaReadMark(s.home.body)
    const r = req(s.home, '追記')
    const pendingData: AppData = { ...s.data, ideaAppends: { [r.id]: r } }
    // Claude に見せる内容では、もう追記した後の中身（印も変わる）
    expect(claudeView(pendingData).ideas[s.home.id].body).toBe(appendedBody(s.home.body, r))
    const again = append(pendingData, { idea_id: shortId('idea', s.home.id), read_mark: mark, content: '追記' })
    expect([again.status, again.requestId, again.request]).toEqual(['pending', r.id, r])
    expect(again.records).toEqual([])
    // アプリが足して依頼を消した後
    const body = appendedBody(s.home.body, r)
    const appliedData: AppData = {
      ...s.data,
      ideas: { ...s.data.ideas, [s.home.id]: { ...s.home, body, claudeHash: hashJson(body), appendIds: [r.id] } },
    }
    const done = append(
      appliedData,
      { idea_id: shortId('idea', s.home.id), read_mark: mark, content: '追記' },
      ctx({ now: NOW, wasDeleted: () => true }),
    )
    expect([done.status, done.requestId, done.records]).toEqual(['applied', r.id, []])
    // 違う内容を前の印で送ると、読み直すよう答える
    expect(append(appliedData, { idea_id: shortId('idea', s.home.id), read_mark: mark, content: '別の追記' }).status).toBe(
      'stale',
    )
  })

  it('アプリが当てずに消した依頼（削除の印だけ）は、次の番号で頼み直す', () => {
    const s = appendSetup()
    const mark = ideaReadMark(s.home.body)
    const g1 = ideaAppendId(s.home.id, mark, '追記')
    const r = append(
      s.data,
      { idea_id: shortId('idea', s.home.id), read_mark: mark, content: '追記' },
      ctx({ now: NOW, wasDeleted: (t, id) => t === 'ideaAppends' && id === g1 }),
    )
    expect(r.status).toBe('created')
    expect(r.records[0].record.id).toBe(ideaAppendId(s.home.id, mark, '追記', 2))
    const all = append(
      s.data,
      { idea_id: shortId('idea', s.home.id), read_mark: mark, content: '追記' },
      ctx({ now: NOW, wasDeleted: () => true }),
    )
    expect([all.status, all.records]).toEqual(['invalid', []])
  })
})
