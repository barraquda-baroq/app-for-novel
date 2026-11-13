// Claude がコネクタでアイデア欄に書く（2.8）組み立て: アイデアを足す（場所・1行目・並びの位置・Markdown・上限・重複）と、
// アイデアに追記する依頼（指せるアイデア・断る理由・読んだ印・送り直し・頼み直し）。
import { describe, expect, it } from 'vitest'
import { createTitle } from '../domain/entityOps'
import { hashJson } from '../domain/hash'
import { buildIdeaTree, ideaFolderName } from '../domain/ideaFolders'
import type { AppData, ClaudeAccess, ID, Idea, IdeaAppend, IdeaFolder, TrashRecord, TrashRequest } from '../domain/types'
import { novel } from '../test/claudeFixture'
import { jstDate } from './dates'
import { claudeFolderId, claudeIdeaId, ideaAppendId, trashRequestId } from './derivedId'
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

/** 2.8 の呼び出し（フォルダに入れない: placement="outside"。カードだけを作る） */
const add = (data: AppData, input: Record<string, unknown>, c = ctx()) => {
  const built = buildAddIdeas(data, claudeView(data), { placement: 'outside', ...input }, c)
  expect(built.records.every((r) => r.table === 'ideas')).toBe(true)
  return { ...built, records: built.records as { table: 'ideas'; record: Idea }[] }
}

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
    // createTitle の id は毎回新しいので、同じデータの中のタイトルを使う（見せないタイトルも。無いタイトルの id のままだと、
    // 2.9 の仕切りの決まり（sectionOf）ではホームのアイデアとして数える）
    const titleId = Object.values(s.data.titles).find((t) => t.name === '星の庭')!.id
    const remap = (id: string | null) => (id === s0.titleId ? titleId : id === s0.hiddenId ? s.hiddenId : id)
    const data: AppData = {
      ...s.data,
      ideas: Object.fromEntries(Object.values(s.data.ideas).map((i) => [i.id, { ...i, titleId: remap(i.titleId) }])),
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

// ---------- アイデアを足す: フォルダ（2.9） ----------

function folder(id: ID, titleId: ID | null, name: string, order = 0, over: Partial<IdeaFolder> = {}): IdeaFolder {
  return { id, titleId, parentId: null, name, order, createdAt: 1, updatedAt: 1, ...over }
}

/** フォルダを指定せずに呼ぶ（2.9 の呼び出し） */
const addTo = (data: AppData, input: Record<string, unknown>, c = ctx()) => buildAddIdeas(data, claudeView(data), input, c)

const withFolders = (data: AppData, folders: IdeaFolder[], ideas: Idea[] = []): AppData => ({
  ...data,
  ideaFolders: Object.fromEntries(folders.map((f) => [f.id, f])),
  ideas: { ...data.ideas, ...Object.fromEntries(ideas.map((i) => [i.id, i])) },
})

const folderRecords = (b: ReturnType<typeof addTo>) =>
  b.records.filter((r) => r.table === 'ideaFolders').map((r) => r.record as IdeaFolder)
const cardRecords = (b: ReturnType<typeof addTo>) => b.records.filter((r) => r.table === 'ideas').map((r) => r.record as Idea)

const DATED = '2026/11/12\u3000港町'

/** 書いた後の形（組み立てた記録を足す） */
function applied(data: AppData, b: ReturnType<typeof addTo>): AppData {
  const out = { ...data, ideaFolders: { ...data.ideaFolders }, ideas: { ...data.ideas } }
  for (const r of b.records) (out[r.table] as Record<ID, unknown>)[r.record.id] = r.record
  return out
}

/** 足したカードが、書いた後のアプリの木（buildIdeaTree）で見えるフォルダの道（「新作の相談＞2026/11/12　港町」。外なら空） */
function shownPaths(data: AppData, b: ReturnType<typeof addTo>): string[] {
  const tree = buildIdeaTree(applied(data, b), b.titleId)
  const paths = new Map<ID, string>()
  for (const top of tree.folders) {
    const name = ideaFolderName(top.folder)
    for (const i of top.ideas) paths.set(i.id, name)
    for (const sub of top.folders) for (const i of sub.ideas) paths.set(i.id, `${name}＞${ideaFolderName(sub.folder)}`)
  }
  return cardRecords(b).map((c) => paths.get(c.id) ?? '')
}

describe('buildAddIdeas: フォルダ（2.9）', () => {
  it('folder も placement も無ければ、何も書かずに断り、候補のフォルダ（無ければ「まだありません」）を返す', () => {
    const s = setup()
    const none = addTo(s.data, { items: [{ content: '案' }] })
    expect(none.ok).toBe(false)
    expect(none.records).toEqual([])
    expect(none.error).toBe(
      'フォルダが決まっていないので、何も足していません。書き込む前に作者に「どのフォルダに入れますか」と聞き、候補のフォルダの名前も出してください（ホームのアイデアのフォルダは下のとおり）。作者がフォルダを言えば folder にその名前を（2段とも言えば subfolder にも）、「任せる」なら placement="auto"、フォルダに入れないなら placement="outside" を渡して、もう一度呼んでください。',
    )
    expect(none.candidates).toEqual(['（ホームのアイデアにはまだフォルダがありません。作者が名前を言えば、その名前で作ります）'])
    const data = withFolders(s.data, [
      folder('f-top', null, '新作の相談', 0),
      folder('f-sub', null, DATED, 0, { parentId: 'f-top' }),
      folder('f-scene', null, '場面の相談', 1),
      folder('f-title', s.titleId, '第1章', 0),
    ])
    expect(addTo(data, { items: [{ content: '案' }] }).candidates).toEqual([
      'f:ftop 新作の相談',
      `f:fsub 新作の相談＞${DATED}`,
      'f:fscene 場面の相談',
    ])
    const inTitle = addTo(data, { title_id: '星の庭', items: [{ content: '案' }] })
    expect(inTitle.error).toContain('（タイトル『星の庭』のアイデアのフォルダは下のとおり）')
    expect(inTitle.candidates).toEqual(['f:ftitle 第1章'])
    // 「読むだけ」のタイトルは、フォルダより先に断る
    expect(addTo(data, { title_id: shortId('title', s.readId), items: [{ content: '案' }] }).error).toContain(
      '「読むだけ」なので書き込めません',
    )
  })

  it('folder と placement は一緒に渡せない。subfolder だけ・形の違う placement・空の folder も断る', () => {
    const s = setup()
    const items = [{ content: '案' }]
    expect(addTo(s.data, { folder: '新作の相談', placement: 'auto', items }).error).toBe(
      'folder と placement は一緒に渡せません（作者がフォルダを言った時は folder だけ、言わなかった時は placement だけ）',
    )
    expect(addTo(s.data, { subfolder: '雨の駅', placement: 'outside', items }).error).toBe(
      'subfolder は folder（1段目のフォルダ）と一緒に渡してください',
    )
    expect(addTo(s.data, { placement: 'inside', items }).error).toBe(
      'placement は "auto"（任せる）か "outside"（フォルダに入れない）にしてください',
    )
    expect(addTo(s.data, { folder: '  ', items }).ok).toBe(false)
    expect(addTo(s.data, { folder: 'あ'.repeat(41), theme: '港町', items }).error).toBe(
      'フォルダの名前は1行・40字までにしてください',
    )
    expect(addTo(s.data, { folder: '新作の相談', theme: 'あ'.repeat(30), items }).error).toBe(
      'theme（相談のテーマ）は1行・29字までにしてください（フォルダの名前「日付　テーマ」が40字までのため）',
    )
  })

  it('placement="outside" はフォルダの外（2.8 と同じ記録・答えの場所）。フォルダがあっても外のカードの並びで先頭に', () => {
    const s = setup()
    const plain = addTo(s.data, { placement: 'outside', items: [{ name: '動機', content: '案' }] })
    expect(plain.ok).toBe(true)
    expect(plain.records).toEqual(add(s.data, { items: [{ name: '動機', content: '案' }] }).records)
    expect([plain.place, plain.folders, plain.folderPath, plain.notes, plain.auto1]).toEqual([
      'ホームのアイデア',
      [],
      '',
      [],
      undefined,
    ])
    expect('folderId' in cardRecords(plain)[0]).toBe(false)
    // フォルダの中のカードは、外の並びに数えない
    const data = withFolders(
      s.data,
      [folder('f-top', null, '新作の相談')],
      [authorIdea('in', null, '中', -50, { folderId: 'f-top' }), authorIdea('out', null, '外', 4)],
    )
    expect(cardRecords(addTo(data, { placement: 'outside', items: [{ content: '一' }] }))[0].order).toBe(3)
  })

  it('placement="auto": 1件はフォルダの外（auto1）、2件以上は新しい1段目「日付　theme」（theme が無ければ断る）', () => {
    const s = setup()
    const one = addTo(s.data, { placement: 'auto', items: [{ content: '一' }] })
    expect([one.ok, one.auto1, one.folders, 'folderId' in cardRecords(one)[0]]).toEqual([true, true, [], false])
    expect(addTo(s.data, { placement: 'auto', items: [{ content: '一' }, { content: '二' }] }).error).toBe(
      'placement="auto" で2件以上の時は、新しいフォルダ「2026/11/12　テーマ」にまとめるので、theme（相談のテーマ。短く）も渡してください',
    )
    const two = addTo(s.data, {
      placement: 'auto',
      theme: ' 港町 ',
      items: [{ content: '一' }, { content: '二' }],
      model: 'claude-x',
    })
    const id = claudeFolderId(null, null, DATED)
    expect(folderRecords(two)).toEqual([
      {
        id,
        titleId: null,
        parentId: null,
        name: DATED,
        order: 0,
        source: 'claude',
        v: 1,
        model: 'claude-x',
        createdAt: AT,
        updatedAt: AT,
      },
    ])
    expect(cardRecords(two).map((c) => [c.folderId, c.order])).toEqual([
      [id, -2],
      [id, -1],
    ])
    expect(two.records.map((r) => r.table)).toEqual(['ideaFolders', 'ideas', 'ideas'])
    expect([two.place, two.folderPath, two.targetFolderId, two.auto1]).toEqual([
      `ホームのアイデア＞${DATED}`,
      DATED,
      id,
      undefined,
    ])
    expect(two.folders).toEqual([{ id, name: DATED, depth: 1, created: true, isNew: true }])
    // 1件が形の違うものでも、数は渡した items の数で決める（2件なのでフォルダに入れる）
    const mixed = addTo(s.data, { placement: 'auto', theme: '港町', items: [{ content: '一' }, { content: '' }] })
    expect(mixed.items.map((i) => i.status)).toEqual(['created', 'invalid'])
    expect(folderRecords(mixed)).toHaveLength(1)
  })

  it('folder だけ: 1段目（無ければ作る）の中に2段目「日付　theme」を作り、カードはそこへ（1件でも）。theme が無ければ断る', () => {
    const s = setup()
    expect(addTo(s.data, { folder: '新作の相談', items: [{ content: '一' }] }).error).toBe(
      'folder だけの時は、その中に「2026/11/12　テーマ」の2段目のフォルダを作るので、theme（相談のテーマ。短く）も渡してください（作者が2段目の名前を言った時は subfolder に渡す）',
    )
    const r = addTo(s.data, { folder: '  新作の相談 ', theme: '港町', items: [{ content: '一' }] })
    const top = claudeFolderId(null, null, '新作の相談')
    const sub = claudeFolderId(null, top, DATED)
    expect(folderRecords(r).map((f) => [f.id, f.parentId, f.name, f.order])).toEqual([
      [top, null, '新作の相談', 0],
      [sub, top, DATED, 0],
    ])
    expect(cardRecords(r)[0].folderId).toBe(sub)
    expect([r.place, r.folderPath]).toEqual([`ホームのアイデア＞新作の相談＞${DATED}`, `新作の相談＞${DATED}`])
    expect(r.folders.map((f) => [f.name, f.depth, f.created])).toEqual([
      ['新作の相談', 1, true],
      [DATED, 2, true],
    ])
    // 1段目はあり（字の幅・空白の違いは同じ）、2段目は兄弟の上に入る（最小 − 1）
    const data = withFolders(s.data, [
      folder('f-top', null, '新作の　相談', 3),
      folder('f-old', null, '2026/11/01　灯台', 5, { parentId: 'f-top' }),
    ])
    const again = addTo(data, { folder: '新作の　相談', theme: '港町', items: [{ content: '一' }] })
    const newSub = claudeFolderId(null, 'f-top', DATED)
    expect(folderRecords(again).map((f) => [f.id, f.parentId, f.order])).toEqual([[newSub, 'f-top', 4]])
    expect(again.folders.map((f) => [f.id, f.created, f.isNew])).toEqual([
      ['f-top', false, false],
      [newSub, true, true],
    ])
    // 同じ日・同じテーマの2段目はもうある（全角の英数字・空白の違いも同じ）: 作らずにそこへ
    const dated = withFolders(data, [
      ...Object.values(data.ideaFolders),
      folder('f-dated', null, '２０２６/１１/１２　港町', 0, { parentId: 'f-top' }),
    ])
    const reuse = addTo(dated, { folder: 'f:ftop', theme: '港町', items: [{ content: '一' }] })
    expect(folderRecords(reuse)).toEqual([])
    expect(cardRecords(reuse)[0].folderId).toBe('f-dated')
  })

  it('folder と subfolder: どちらも名前で探し、無ければ作る。2段目の f:… は1段目の中のものだけ', () => {
    const s = setup()
    const data = withFolders(s.data, [
      folder('f-scene', s.titleId, '場面の相談', 0),
      folder('f-rain', s.titleId, '雨の駅', 0, { parentId: 'f-scene' }),
      folder('f-other', s.titleId, '別の相談', 1),
      folder('f-otherSub', s.titleId, '夜', 0, { parentId: 'f-other' }),
    ])
    const t = shortId('title', s.titleId)
    const existing = addTo(data, { title_id: t, folder: '場面の相談', subfolder: '雨の駅', items: [{ content: '一' }] })
    expect(folderRecords(existing)).toEqual([])
    expect(cardRecords(existing)[0]).toMatchObject({ titleId: s.titleId, folderId: 'f-rain' })
    expect(existing.place).toBe('タイトル『星の庭』のアイデア＞場面の相談＞雨の駅')
    const made = addTo(data, { title_id: t, folder: '場面の相談', subfolder: '雪の駅', items: [{ content: '一' }] })
    expect(folderRecords(made).map((f) => [f.titleId, f.parentId, f.name, f.order])).toEqual([
      [s.titleId, 'f-scene', '雪の駅', -1],
    ])
    expect(addTo(data, { title_id: t, folder: '場面の相談', subfolder: 'f:fothersub', items: [{ content: '一' }] }).error).toBe(
      'f:fothersu は「場面の相談」の中のフォルダではありません',
    )
    // 2段目の f:… を folder に渡すと、そのフォルダにじかに入れる（subfolder は断る）
    const direct = addTo(data, { title_id: t, folder: 'f:frain', items: [{ content: '一' }] })
    expect([cardRecords(direct)[0].folderId, direct.folderPath]).toEqual(['f-rain', '場面の相談＞雨の駅'])
    expect(addTo(data, { title_id: t, folder: 'f:frain', subfolder: '朝', items: [{ content: '一' }] }).error).toBe(
      'f:frain は2段目のフォルダなので、中にフォルダは作れません（3段目は作れません。subfolder を省くと、そのフォルダにじかに入れます）',
    )
    // 1段目に無く、2段目に1つだけある名前も、そこにじかに入れる
    const byName = addTo(data, { title_id: t, folder: '雨の駅', items: [{ content: '一' }] })
    expect(cardRecords(byName)[0].folderId).toBe('f-rain')
  })

  it('同じ名前が2つ以上・ほかの場所の f:…・見つからない f:… は断る', () => {
    const s = setup()
    const data = withFolders(s.data, [
      folder('f-a1', null, '新作の相談', 0),
      folder('f-a2', null, '新作の相談', 1),
      folder('f-bbbb', null, '場面', 2),
      folder('f-s1', null, '雨の駅', 0, { parentId: 'f-bbbb' }),
      folder('f-c', null, '別', 3),
      folder('f-s2', null, '雨の駅', 0, { parentId: 'f-c' }),
      folder('f-tttt', s.titleId, '第1章', 0),
    ])
    const dup = addTo(data, { folder: '新作の相談', theme: '港町', items: [{ content: '一' }] })
    expect(dup.error).toBe(
      '「新作の相談」という名前の1段目のフォルダが2つ以上あり、決まりません。f:… で指し、theme もそのまま渡してください（その中に2段目「日付　theme」を作ります）',
    )
    expect(dup.candidates).toEqual(['f:fa1 新作の相談', 'f:fa2 新作の相談'])
    expect(addTo(data, { folder: '雨の駅', items: [{ content: '一' }] }).error).toBe(
      '「雨の駅」という名前のフォルダが2つ以上あり、決まりません。f:… で指してください',
    )
    expect(addTo(data, { folder: 'f:ftttt', theme: '港町', items: [{ content: '一' }] }).error).toBe(
      `f:ftttt はタイトル『星の庭』のフォルダです（そこに入れる時は title_id に ${shortId('title', s.titleId)} を渡してください）`,
    )
    expect(addTo(data, { title_id: '星の庭', folder: 'f:fbbbb', theme: '港町', items: [{ content: '一' }] }).error).toBe(
      'f:fbbbb はホームのアイデアのフォルダです（title_id を省いてください）',
    )
    const missing = addTo(data, { folder: 'f:zzzz', theme: '港町', items: [{ content: '一' }] })
    expect([missing.error, missing.candidates?.[0]]).toEqual(['フォルダが見つかりません: f:zzzz', 'f:fa1 新作の相談'])
  })

  it('重複だけならフォルダを作らない（空のフォルダは作らない）。重複はフォルダが違っても重複で、見えていれば場所を言う', () => {
    const s = setup()
    const inFolder = claudeIdea(null, '', '案', AT, { folderId: 'f-top', order: -1 })
    const data = withFolders(s.data, [folder('f-top', null, '新作の相談')], [inFolder])
    const r = addTo(data, { folder: '場面の相談', theme: '港町', items: [{ content: '案' }] })
    expect(r.ok).toBe(true)
    expect(r.records).toEqual([])
    expect(r.folders.map((f) => [f.name, f.created, f.isNew])).toEqual([
      ['場面の相談', false, true],
      [DATED, false, true],
    ])
    expect(r.items[0]).toEqual({
      index: 0,
      status: 'duplicate',
      id: inFolder.id,
      label: '「2026/11/12 14:32　案」',
      hint: '同じ内容のアイデアがもうあります（追加しません）（場所: ホームのアイデア＞新作の相談）',
      existing: true,
    })
    expect(r.notes).toEqual([])
  })

  it('カードは入れ物の済みでないカードの先頭（作者のカードも raw で数える）。フォルダは外から順にカードより先で、2つまで', () => {
    const s = setup()
    const data = withFolders(
      s.data,
      [folder('f-top', null, '新作の相談', 2), folder('f-x', null, '別', -4)],
      [
        authorIdea('a1', null, '中の作者の案', 7, { folderId: 'f-top' }),
        authorIdea('a2', null, '済み', -90, { folderId: 'f-top', checked: true, checkedAt: 3 }),
        authorIdea('a3', null, '外', -30),
      ],
    )
    const r = addTo(data, { folder: '新作の相談', subfolder: '雨の駅', items: [{ content: '一' }, { content: '二' }] })
    expect(r.records.map((x) => x.table)).toEqual(['ideaFolders', 'ideas', 'ideas'])
    expect(cardRecords(r).map((c) => c.order)).toEqual([-2, -1])
    const direct = addTo(data, { folder: '新作の相談', subfolder: 'f:zzzz', items: [{ content: '一' }] })
    expect(direct.ok).toBe(false)
    // 1段目にじかに（任せる・2件以上で、もうある「日付　theme」のフォルダ）
    const dated = withFolders(
      data,
      [...Object.values(data.ideaFolders), folder('f-d', null, DATED, 9)],
      [...Object.values(data.ideas), authorIdea('a4', null, 'd の中', 5, { folderId: 'f-d' })],
    )
    const auto = addTo(dated, { placement: 'auto', theme: '港町', items: [{ content: '一' }, { content: '二' }] })
    expect([folderRecords(auto), cardRecords(auto).map((c) => [c.folderId, c.order])]).toEqual([
      [],
      [
        ['f-d', 3],
        ['f-d', 4],
      ],
    ])
    // 新しい1段目は兄弟の最小 − 1
    const fresh = addTo(data, { placement: 'auto', theme: '灯台', items: [{ content: '一' }, { content: '二' }] })
    expect(folderRecords(fresh)[0].order).toBe(-5)
  })

  it('作り直しの番号: 同じ id の名前を変えた・移したフォルダ、削除の印・ゴミ箱の id、同じ呼び出しで使った id を飛ばす。100 を超えたら断る', () => {
    const s = setup()
    const g1 = claudeFolderId(null, null, '新作の相談')
    const g2 = claudeFolderId(null, null, '新作の相談', 2)
    const g3 = claudeFolderId(null, null, '新作の相談', 3)
    // g1 は名前を変えたフォルダ（raw にある）、g2 は削除の印
    const data = withFolders(s.data, [folder(g1, null, '名前を変えた', 0, { source: 'claude', v: 1 })])
    const r = addTo(
      data,
      { folder: '新作の相談', theme: '港町', items: [{ content: '一' }] },
      ctx({ wasDeleted: (t, id) => t === 'ideaFolders' && id === g2 }),
    )
    expect(folderRecords(r)[0].id).toBe(g3)
    expect(folderRecords(r)[1].id).toBe(claudeFolderId(null, g3, DATED))
    const exhausted = addTo(
      s.data,
      { folder: '新作の相談', theme: '港町', items: [{ content: '一' }] },
      ctx({ wasDeleted: (t) => t === 'ideaFolders' }),
    )
    expect(exhausted.error).toBe(
      'このフォルダはもう作れません（同じ名前のフォルダの削除と作り直しが多すぎます）。別の名前にしてください',
    )
  })

  it('補足: ゴミ箱に同じ場所・同じ名前のフォルダ（N1）・見えているほかの場所に同じ名前のフォルダ（N2）。作る時だけ', () => {
    const s = setup()
    const entry = (id: string, label: string, titleId: ID | null, parentLabel?: string) => ({
      id,
      kind: 'ideaFolder' as const,
      label,
      titleName: '',
      ...(parentLabel ? { parentLabel } : {}),
      origin: { titleId, index: 0 },
      recordIds: [],
      reason: 'deleted' as const,
      deletedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const data: AppData = {
      ...withFolders(s.data, [folder('f-tttt', s.titleId, '新作の相談'), folder('f-hidden', s.hiddenId, '新作の相談')]),
      trashEntries: {
        e1: entry('e1', ' 新作の相談 ', null),
        e2: entry('e2', DATED, null, '別の親'),
        e3: entry('e3', '新作の相談', s.titleId),
      },
    }
    const r = addTo(data, { folder: '新作の相談', theme: '港町', items: [{ content: '一' }] })
    expect(r.notes).toEqual([
      'ゴミ箱にも同じ名前のフォルダ「新作の相談」があります（新しく作りました。前のフォルダは作者がアプリのゴミ箱から戻せます）',
      'タイトル『星の庭』にも同じ名前のフォルダ「新作の相談」[f:ftttt] があります（違う場所だった時は、作者がアプリで移せます）',
    ])
    // 2段目は親の名前も同じ時だけ
    const sub = {
      ...data,
      trashEntries: { ...data.trashEntries, e4: entry('e4', DATED, null, '新作の相談') },
    }
    expect(addTo(sub, { folder: '新作の相談', theme: '港町', items: [{ content: '一' }] }).notes).toContain(
      `ゴミ箱にも同じ名前のフォルダ「${DATED}」があります（新しく作りました。前のフォルダは作者がアプリのゴミ箱から戻せます）`,
    )
    // カードを足さなければ補足も出さない
    expect(addTo(data, { folder: '新作の相談', theme: '港町', items: [{ content: '' }] }).notes).toEqual([])
  })

  it('1段目の f:… だけ（theme・subfolder 無し）はその1段目にじかに入れる。theme を付ければ、今までどおり中に「日付　theme」', () => {
    const s = setup()
    const data = withFolders(s.data, [
      folder('f-top', null, '新作の相談', 0),
      folder('f-old', null, '2026/11/01　灯台', 0, { parentId: 'f-top' }),
    ])
    const direct = addTo(data, { folder: 'f:ftop', items: [{ content: '一' }] })
    expect(direct.ok).toBe(true)
    expect(folderRecords(direct)).toEqual([])
    expect(cardRecords(direct)[0].folderId).toBe('f-top')
    expect([direct.place, direct.folderPath, direct.targetFolderId, direct.directNote]).toEqual([
      'ホームのアイデア＞新作の相談',
      '新作の相談',
      'f-top',
      undefined,
    ])
    expect(direct.folders).toEqual([{ id: 'f-top', name: '新作の相談', depth: 1, created: false, isNew: false }])
    expect(shownPaths(data, direct)).toEqual(['新作の相談'])
    // theme を付けると、その中に2段目「日付　theme」を作る（名前で言った時と同じ）
    const dated = addTo(data, { folder: 'f:ftop', theme: '港町', items: [{ content: '一' }] })
    const sub = claudeFolderId(null, 'f-top', DATED)
    expect(folderRecords(dated).map((f) => [f.id, f.parentId, f.name])).toEqual([[sub, 'f-top', DATED]])
    expect([cardRecords(dated)[0].folderId, dated.folderPath]).toEqual([sub, `新作の相談＞${DATED}`])
    expect(shownPaths(data, dated)).toEqual([`新作の相談＞${DATED}`])
    // 名前で言った1段目は、今までどおり theme が要る
    expect(addTo(data, { folder: '新作の相談', items: [{ content: '一' }] }).error).toBe(
      'folder だけの時は、その中に「2026/11/12　テーマ」の2段目のフォルダを作るので、theme（相談のテーマ。短く）も渡してください（作者が2段目の名前を言った時は subfolder に渡す）',
    )
    // 2段目の f:… に theme を付けても、断らずにそのフォルダにじかに入れる（theme は使わない）
    const second = addTo(data, { folder: 'f:fold', theme: '港町', items: [{ content: '一' }] })
    expect([second.ok, folderRecords(second), cardRecords(second)[0].folderId]).toEqual([true, [], 'f-old'])
  })

  it('任せる（2件）で作った1段目に、答えの f:… だけで続けて1件足すと、同じフォルダにじかに入る', () => {
    const s = setup()
    const first = addTo(s.data, { placement: 'auto', theme: '港町', items: [{ content: '一' }, { content: '二' }] })
    const top = claudeFolderId(null, null, DATED)
    expect(first.folders.map((f) => [f.id, f.depth])).toEqual([[top, 1]])
    const after = applied(s.data, first)
    const next = addTo(after, { folder: shortId('ideaFolder', top), items: [{ content: '三' }] })
    expect(next.ok).toBe(true)
    expect(folderRecords(next)).toEqual([])
    expect(cardRecords(next)[0]).toMatchObject({ folderId: top, order: -3 })
    expect(next.folders).toEqual([{ id: top, name: DATED, depth: 1, created: false, isNew: false }])
    const tree = buildIdeaTree(applied(after, next), null)
    expect(tree.folders.map((f) => [ideaFolderName(f.folder), f.folders.length, f.ideas.length])).toEqual([[DATED, 0, 3]])
  })

  it('1段目に見えても記録に親へのつながりが残るフォルダ（同期で C→A→B・A↔B）は、中にフォルダを作らずにじかに入れ、補足で言う', () => {
    const s = setup()
    // C→A→B: A は B の中の2段目、「新作の相談」（C）は記録では A の中だが1段目に見える
    const chain = withFolders(s.data, [
      folder('f-bbbb', null, '置き場', 0),
      folder('f-aaaa', null, '別', 0, { parentId: 'f-bbbb' }),
      folder('f-cccc', null, '新作の相談', 1, { parentId: 'f-aaaa' }),
    ])
    const note =
      'フォルダ「新作の相談」は、アプリでの移動がぶつかって中に新しいフォルダを作れない状態なので、そのフォルダにじかに入れました（作者がアプリでそのフォルダの「移動…」から「1段目にする」を選ぶと直ります）'
    for (const input of [
      { folder: '新作の相談', theme: '港町' },
      { folder: '新作の相談' },
      { folder: 'f:fcccc', theme: '港町' },
      { folder: '新作の相談', subfolder: '雨の駅' },
      { folder: 'f:fcccc' },
    ]) {
      const r = addTo(chain, { ...input, items: [{ content: '一' }] })
      expect(r.ok, JSON.stringify(input)).toBe(true)
      expect(folderRecords(r)).toEqual([])
      expect(cardRecords(r)[0].folderId).toBe('f-cccc')
      expect([r.place, r.folderPath, r.folders.map((f) => f.depth)]).toEqual(['ホームのアイデア＞新作の相談', '新作の相談', [1]])
      // f:… だけなら、もともと1段目にじかに入れるので補足は無い
      expect(r.directNote).toBe(input.folder === 'f:fcccc' && Object.keys(input).length === 1 ? undefined : note)
      // アプリの木でも、答えの場所と同じ段に見える
      expect(shownPaths(chain, r)).toEqual([r.folderPath])
    }
    // 2段目に見えるフォルダ（A）は今までどおり、そこにじかに入れる
    const inA = addTo(chain, { folder: 'f:faaaa', items: [{ content: '一' }] })
    expect([inA.folderPath, inA.directNote, shownPaths(chain, inA)]).toEqual(['置き場＞別', undefined, ['置き場＞別']])
    // A↔B の輪: どちらも1段目に見え、中にフォルダを作らない
    const cycle = withFolders(s.data, [
      folder('f-xxxx', null, '場面の相談', 0, { parentId: 'f-yyyy' }),
      folder('f-yyyy', null, '人物の相談', 1, { parentId: 'f-xxxx' }),
    ])
    const r = addTo(cycle, { folder: '場面の相談', theme: '港町', items: [{ content: '一' }] })
    expect([folderRecords(r), cardRecords(r)[0].folderId, r.folderPath]).toEqual([[], 'f-xxxx', '場面の相談'])
    expect(r.directNote).toContain('フォルダ「場面の相談」は、アプリでの移動がぶつかって')
    expect(shownPaths(cycle, r)).toEqual(['場面の相談'])
    // ふつうの1段目（記録でも1段目）は、今までどおり中に「日付　theme」を作る
    const plain = addTo(chain, { folder: '置き場', theme: '港町', items: [{ content: '一' }] })
    expect([folderRecords(plain).length, plain.folderPath, plain.directNote]).toEqual([1, `置き場＞${DATED}`, undefined])
    expect(shownPaths(chain, plain)).toEqual([`置き場＞${DATED}`])
  })

  it('親が無い・別の仕切りにある1段目（中の2段目が見えている）は、もうある2段目を使い、新しく作る時だけじかに入れて補足で言う', () => {
    const s = setup()
    const note =
      'フォルダ「新作の相談」は、アプリでの移動がぶつかって中に新しいフォルダを作れない状態なので、そのフォルダにじかに入れました（作者がアプリでそのフォルダの「移動…」から「1段目にする」を選ぶと直ります）'
    for (const parentId of ['f-gone', 'f-tttt']) {
      // 親（f-gone）は消えた（ゴミ箱）・親（f-tttt）は別の仕切り（タイトル『星の庭』）。どちらも「新作の相談」は1段目に見え、中も見える
      const data = withFolders(s.data, [
        folder('f-tttt', s.titleId, '第1章', 0),
        folder('f-cccc', null, '新作の相談', 0, { parentId }),
        folder('f-xxxx', null, '雨の駅', 0, { parentId: 'f-cccc' }),
        folder('f-dddd', null, DATED, 1, { parentId: 'f-cccc' }),
      ])
      expect(buildIdeaTree(data, null).folders.map((f) => [ideaFolderName(f.folder), f.folders.length])).toEqual([
        ['新作の相談', 2],
      ])
      for (const [input, target] of [
        [{ folder: '新作の相談', subfolder: '雨の駅' }, 'f-xxxx'],
        [{ folder: 'f:fcccc', subfolder: 'f:fxxxx' }, 'f-xxxx'],
        [{ folder: '新作の相談', theme: '港町' }, 'f-dddd'],
      ] as const) {
        const r = addTo(data, { ...input, items: [{ content: '一' }] })
        expect([r.ok, folderRecords(r), cardRecords(r)[0].folderId, r.directNote], JSON.stringify(input)).toEqual([
          true,
          [],
          target,
          undefined,
        ])
        expect(shownPaths(data, r)).toEqual([r.folderPath])
      }
      // 新しい2段目を作る時だけ、作らずにじかに入れて補足で言う
      for (const input of [
        { folder: '新作の相談', theme: '灯台' },
        { folder: '新作の相談', subfolder: '駅の外' },
      ]) {
        const r = addTo(data, { ...input, items: [{ content: '一' }] })
        expect([r.ok, folderRecords(r), cardRecords(r)[0].folderId, r.directNote]).toEqual([true, [], 'f-cccc', note])
        expect(shownPaths(data, r)).toEqual(['新作の相談'])
      }
      // 名前で言った1段目は、今までどおり theme が要る
      expect(addTo(data, { folder: '新作の相談', items: [{ content: '一' }] }).error).toContain(
        'theme（相談のテーマ。短く）も渡して',
      )
    }
  })

  it('同じ名前の1段目が2つの時、名前だけ（theme 無し）なら先に theme を求め、指し直す f:… にも theme を渡させる（2段目「日付　theme」を作る）', () => {
    const s = setup()
    const data = withFolders(s.data, [folder('f-aaaa', null, '新作の相談', 0), folder('f-bbbb', null, '新作の相談', 1)])
    const first = addTo(data, { folder: '新作の相談', items: [{ content: '一' }] })
    expect([first.ok, first.error, first.candidates]).toEqual([
      false,
      'folder だけの時は、その中に「2026/11/12　テーマ」の2段目のフォルダを作るので、theme（相談のテーマ。短く）も渡してください（作者が2段目の名前を言った時は subfolder に渡す）',
      undefined,
    ])
    const second = addTo(data, { folder: '新作の相談', theme: '港町', items: [{ content: '一' }] })
    expect(second.error).toContain('f:… で指し、theme もそのまま渡してください')
    expect(second.candidates).toEqual(['f:faaaa 新作の相談', 'f:fbbbb 新作の相談'])
    // そのとおり f:… と theme で指し直すと、その中に「日付　theme」を作る
    const third = addTo(data, { folder: 'f:faaaa', theme: '港町', items: [{ content: '一' }] })
    expect([third.ok, third.folderPath, shownPaths(data, third)]).toEqual([
      true,
      `新作の相談＞${DATED}`,
      [`新作の相談＞${DATED}`],
    ])
    // 2段とも言った時は、今までどおり f:… で指してもらう（theme は要らない）
    expect(addTo(data, { folder: '新作の相談', subfolder: '雨の駅', items: [{ content: '一' }] }).error).toBe(
      '「新作の相談」という名前のフォルダが2つ以上あり、決まりません。f:… で指してください',
    )
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
