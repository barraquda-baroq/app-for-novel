// Claude がアイデア欄に書く（2.8）ための小さな部品: 日付の行・本文の形・追記の形・Claude のアイデアの見分け方・
// 「作者が直した」の決め方・追記の依頼の確かめと当て方（アプリの処理と Claude に見せる内容で同じもの）・読んだ印・場所と1行目。
import { describe, expect, it } from 'vitest'
import { hashJson } from '../domain/hash'
import type { ClaudeAccess, Idea, IdeaAppend, Title } from '../domain/types'
import { jstMinute, jstSlashDate } from './dates'
import {
  appendedBody,
  appendedTail,
  appendHeader,
  appendIdsOf,
  CLAUDE_IDEA_ID,
  claudeIdeaBody,
  IDEA_APPEND_ID,
  IDEA_APPEND_VERSION,
  IDEA_LIMITS,
  IDEA_RECORD_VERSION,
  ideaAppendProblem,
  ideaEditedByAuthor,
  ideaHeadLine,
  ideaPlaceLabel,
  ideaReadMark,
  ideaSectionWritable,
  isClaudeIdea,
  isIdeaAppend,
  isNewerIdeaAppend,
  liveIdeaAppends,
  normalizeIdeaName,
  normalizeIdeaText,
  overlayIdeaAppends,
  withIdeaAppend,
} from './ideaAppend'

/** 2026/11/12 14:32（日本時間） */
const AT = Date.UTC(2026, 10, 12, 5, 32, 10)
const BODY = '2026/11/12 14:32　第3章の動機\n【動機】\n・兄を探す'

/** Claude が作ったアイデア（作者が直していない形） */
function claudeIdea(over: Partial<Idea> = {}): Idea {
  const body = over.body ?? BODY
  return {
    id: 'cy-abc123.def',
    titleId: null,
    heading: '',
    body,
    checked: false,
    checkedAt: null,
    order: 3,
    source: 'claude',
    v: 1,
    claudeHash: hashJson(body),
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }
}

/** 作者がアプリで書いたアイデア */
function authorIdea(over: Partial<Idea> = {}): Idea {
  return {
    id: '3f2a9c1b-0000-4000-8000-000000000000',
    titleId: null,
    heading: '',
    body: '作者の案',
    checked: false,
    checkedAt: null,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function request(over: Partial<IdeaAppend> = {}): IdeaAppend {
  return {
    id: 'cu-req1',
    ideaId: 'cy-abc123.def',
    text: '動機を「兄の約束」に変える',
    readMark: 'abcd1234',
    source: 'claude',
    v: 1,
    createdAt: Date.UTC(2026, 10, 13, 1, 0),
    updatedAt: Date.UTC(2026, 10, 13, 1, 0),
    ...over,
  }
}

const title = (id: string, claudeAccess?: ClaudeAccess, name = '灰の庭'): Title =>
  ({ id, name, claudeAccess }) as unknown as Title

describe('日付の行（日本時間）', () => {
  it('「2026/11/12 14:32」の形（0 で埋める）。UTC の 15:00 で日付が変わる', () => {
    expect(jstMinute(Date.UTC(2026, 0, 2, 0, 5))).toBe('2026/01/02 09:05')
    expect(jstMinute(AT)).toBe('2026/11/12 14:32')
    expect(jstMinute(Date.UTC(2026, 10, 12, 14, 59, 59))).toBe('2026/11/12 23:59')
    expect(jstMinute(Date.UTC(2026, 10, 12, 15, 0))).toBe('2026/11/13 00:00')
    expect(jstSlashDate(Date.UTC(2026, 0, 2, 0, 5))).toBe('2026/01/02')
    expect(jstSlashDate(Date.UTC(2026, 10, 12, 14, 59))).toBe('2026/11/12')
    expect(jstSlashDate(Date.UTC(2026, 10, 12, 15, 0))).toBe('2026/11/13')
  })
})

describe('本文の形', () => {
  it('normalizeIdeaText: 改行は LF、先頭の空の行と終わりの空白（全角の空白も）を除き、途中は変えない', () => {
    expect(normalizeIdeaText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(normalizeIdeaText('\n \n　\nあ\n\n  い  \n')).toBe('あ\n\n  い')
    expect(normalizeIdeaText('  字下げ')).toBe('  字下げ')
    expect(normalizeIdeaText('終わり　\n　')).toBe('終わり')
    expect(normalizeIdeaText(' \n\t\n')).toBe('')
    // 2回そろえても同じ
    const once = normalizeIdeaText('\r\n\r\n・一\r\n・二　\r\n')
    expect(normalizeIdeaText(once)).toBe(once)
  })

  it('normalizeIdeaName: 空白・改行は半角の空白1つにまとめ、前後を除き、40字まで', () => {
    expect(normalizeIdeaName('  第3章の\n　動機  ')).toBe('第3章の 動機')
    expect(normalizeIdeaName(undefined)).toBe('')
    expect(normalizeIdeaName(null)).toBe('')
    expect(normalizeIdeaName('　')).toBe('')
    const long = 'あ'.repeat(45)
    expect(normalizeIdeaName(long)).toBe('あ'.repeat(IDEA_LIMITS.name))
    // サロゲートペアは1字に数え、壊さない
    expect(Array.from(normalizeIdeaName('𠮷'.repeat(41)))).toHaveLength(40)
  })

  it('claudeIdeaBody: 1行目は日付と時刻、名前があれば全角の空白の後ろに。2行目から中身', () => {
    expect(claudeIdeaBody(AT, '第3章の動機', '\n【動機】\r\n・兄を探す\n\n')).toBe(BODY)
    expect(claudeIdeaBody(AT, '', '中身')).toBe('2026/11/12 14:32\n中身')
    expect(claudeIdeaBody(AT, undefined, '中身')).toBe('2026/11/12 14:32\n中身')
    expect(claudeIdeaBody(AT, ' 名前\nの\t続き ', '中身')).toBe('2026/11/12 14:32　名前 の 続き\n中身')
    // 終わりに空白が残らない（何も変えずに編集の画面で保存しても1字も変わらない）
    expect(claudeIdeaBody(AT, '名', '中身　\n')).not.toMatch(/\s$/u)
  })
})

describe('追記の形', () => {
  it('appendedBody: 終わりの空白を除いた本文に空行を1つ置き、「YYYY/MM/DDのセッションで以下の内容へ変更」と内容を足す', () => {
    const req = request({ text: '\n変えた内容\r\n・続き\n\n' })
    expect(appendHeader(req.createdAt)).toBe('2026/11/13のセッションで以下の内容へ変更')
    expect(appendedBody(BODY, req)).toBe(`${BODY}\n\n2026/11/13のセッションで以下の内容へ変更\n変えた内容\n・続き`)
    // 本文の終わりの空行・空白は1つの空行にまとめる
    expect(appendedBody(`${BODY}\n\n　\n`, req)).toBe(appendedBody(BODY, req))
    // 本文が空なら追記だけ
    expect(appendedBody('', req)).toBe('2026/11/13のセッションで以下の内容へ変更\n変えた内容\n・続き')
    expect(appendedBody(' \n', req)).toBe(appendedBody('', req))
    // 日付は依頼を作った時の日本時間（UTC の 15:00 で次の日）
    expect(appendedBody('a', request({ text: 'b', createdAt: Date.UTC(2026, 10, 13, 15, 0) }))).toBe(
      'a\n\n2026/11/14のセッションで以下の内容へ変更\nb',
    )
  })

  it('appendedTail: 元の本文の後ろに空行を置いて足しただけなら、足した部分（\\n\\n から）。ほかは null', () => {
    const after = appendedBody(BODY, request())
    const tail = appendedTail(BODY, after)
    expect(tail).toBe('\n\n2026/11/13のセッションで以下の内容へ変更\n動機を「兄の約束」に変える')
    expect(BODY + tail).toBe(after)
    // 元の本文の終わりに空白があっても同じ
    expect(appendedTail(`${BODY}\n`, after)).toBe(tail)
    // 2回の追記もまとめて1つの足した部分
    const twice = appendedBody(after, request({ id: 'cu-req2', text: '二つ目' }))
    expect(appendedTail(BODY, twice)).toBe(twice.slice(BODY.length))
    // 変わっていない・空行が無い・途中を直した・元が空・足した部分が空
    expect(appendedTail(BODY, BODY)).toBeNull()
    expect(appendedTail(BODY, `${BODY}\n続き`)).toBeNull()
    expect(appendedTail(BODY, `${BODY.replace('兄', '弟')}\n\n足した`)).toBeNull()
    expect(appendedTail('', '\n\n足した')).toBeNull()
    expect(appendedTail(' \n', 'x\n\n足した')).toBeNull()
    expect(appendedTail(BODY, `${BODY}\n\n`)).toBeNull()
  })
})

describe('Claude が作ったアイデアの見分け方と「作者が直した」', () => {
  it('isClaudeIdea: source が claude で、id が cy-… のものだけ', () => {
    expect(isClaudeIdea(claudeIdea())).toBe(true)
    // 作者のアイデア（UUID）に source が付いていても Claude のアイデアにしない（id の形はアクセスルールが守る）
    expect(isClaudeIdea(authorIdea({ source: 'claude' }))).toBe(false)
    // cy- の id でも source が無ければ違う
    expect(isClaudeIdea(claudeIdea({ source: undefined }))).toBe(false)
    expect(isClaudeIdea(claudeIdea({ id: 'cy-ABC' }))).toBe(false)
    expect(isClaudeIdea(claudeIdea({ id: 'ci-abc123' }))).toBe(false)
    expect(isClaudeIdea({ id: undefined as unknown as string, source: 'claude' })).toBe(false)
    expect(CLAUDE_IDEA_ID.test('cy-1a.2b.3c')).toBe(true)
    expect(IDEA_APPEND_ID.test('cu-1a.2b.3c')).toBe(true)
    expect(IDEA_APPEND_ID.test('cy-1a.2b.3c')).toBe(false)
  })

  it('ideaEditedByAuthor: 見出しがある・指紋が無い・本文が違う時は直した。Claude が書いた形に戻すと直していない', () => {
    expect(ideaEditedByAuthor(claudeIdea())).toBe(false)
    expect(ideaEditedByAuthor(claudeIdea({ heading: '古い見出し' }))).toBe(true)
    expect(ideaEditedByAuthor(claudeIdea({ heading: '  ' }))).toBe(false)
    expect(ideaEditedByAuthor(claudeIdea({ claudeHash: undefined }))).toBe(true)
    expect(ideaEditedByAuthor(claudeIdea({ claudeHash: 1 as unknown as string }))).toBe(true)
    const edited = { ...claudeIdea(), body: `${BODY}\n作者の一行` }
    expect(ideaEditedByAuthor(edited)).toBe(true)
    // 空白だけの違いも直したに数える
    expect(ideaEditedByAuthor({ ...claudeIdea(), body: `${BODY} ` })).toBe(true)
    expect(ideaEditedByAuthor({ ...edited, body: BODY })).toBe(false)
    // 済み・並び・場所・updatedAt は数えない
    expect(ideaEditedByAuthor(claudeIdea({ checked: true, checkedAt: 5, order: -4, titleId: 't1', updatedAt: 9 }))).toBe(false)
    // 作者のアイデア（指紋が無い）は直したもの
    expect(ideaEditedByAuthor(authorIdea())).toBe(true)
  })

  it('appendIdsOf: 配列の文字列だけ（壊れた値は空）', () => {
    expect(appendIdsOf(claudeIdea())).toEqual([])
    expect(appendIdsOf(claudeIdea({ appendIds: ['cu-a', 3 as unknown as string, 'cu-b'] }))).toEqual(['cu-a', 'cu-b'])
    expect(appendIdsOf(claudeIdea({ appendIds: 'cu-a' as unknown as string[] }))).toEqual([])
  })
})

describe('追記の依頼の確かめ方', () => {
  it('isIdeaAppend: 形（id が cu-…・ideaId・text・readMark・source・v・時刻）。isNewerIdeaAppend: 知らない新しい版', () => {
    expect(isIdeaAppend(request())).toBe(true)
    expect(isIdeaAppend(request({ text: '' }))).toBe(true)
    expect(isIdeaAppend(request({ id: 'cz-req1' }))).toBe(false)
    expect(isIdeaAppend(request({ ideaId: '' }))).toBe(false)
    expect(isIdeaAppend(request({ text: 1 as unknown as string }))).toBe(false)
    expect(isIdeaAppend(request({ readMark: undefined as unknown as string }))).toBe(false)
    expect(isIdeaAppend(request({ source: 'manual' as unknown as 'claude' }))).toBe(false)
    expect(isIdeaAppend(request({ v: Number.NaN }))).toBe(false)
    expect(isIdeaAppend(request({ createdAt: '1' as unknown as number }))).toBe(false)
    expect(isIdeaAppend(null)).toBe(false)
    expect(isIdeaAppend([request()])).toBe(false)
    expect(IDEA_APPEND_VERSION).toBe(1)
    expect(IDEA_RECORD_VERSION).toBe(1)
    expect(isNewerIdeaAppend(request())).toBe(false)
    expect(isNewerIdeaAppend(request({ v: 2 }))).toBe(true)
    expect(isNewerIdeaAppend(null)).toBe(false)
  })

  it('liveIdeaAppends: 形が正しく知っている版の依頼を、作った順（同じ時刻なら id の順）に', () => {
    const a = request({ id: 'cu-b', createdAt: 10 })
    const b = request({ id: 'cu-a', createdAt: 10 })
    const c = request({ id: 'cu-0', createdAt: 5 })
    const newer = request({ id: 'cu-new', createdAt: 1, v: 2 })
    const broken = { id: 'cu-broken', ideaId: 'x' } as unknown as IdeaAppend
    const live = liveIdeaAppends({ ideaAppends: { [a.id]: a, [b.id]: b, [c.id]: c, [newer.id]: newer, [broken.id]: broken } })
    expect(live.map((r) => r.id)).toEqual(['cu-0', 'cu-a', 'cu-b'])
    expect(liveIdeaAppends({})).toEqual([])
  })

  it('ideaAppendProblem: 無い → もう足した → Claude のアイデアでない → 書き込めない → 中身 → 長すぎる の順', () => {
    const titles = { tw: title('tw', 'write'), tr: title('tr', 'read'), tn: title('tn', 'none'), td: title('td') }
    const req = request()
    expect(ideaAppendProblem(titles, undefined, req)).toBe('not_found')
    expect(ideaAppendProblem(titles, claudeIdea({ appendIds: ['cu-req1'] }), req)).toBe('applied')
    // もう足した依頼は、ほかの理由より先に applied（2台目の端末・分かれて届いた時に、黙って消す）
    expect(ideaAppendProblem(titles, claudeIdea({ appendIds: ['cu-req1'], titleId: 'tn' }), req)).toBe('applied')
    expect(ideaAppendProblem(titles, authorIdea(), request({ ideaId: authorIdea().id }))).toBe('not_claude')
    expect(ideaAppendProblem(titles, authorIdea({ source: 'claude' }), req)).toBe('not_claude')
    expect(ideaAppendProblem(titles, claudeIdea({ titleId: 'tr' }), req)).toBe('not_writable')
    expect(ideaAppendProblem(titles, claudeIdea({ titleId: 'tn' }), req)).toBe('not_writable')
    // 「読む＋書き込む」のタイトル・設定の無い（= 読む＋書き込む）タイトル・ホーム・タイトルが無い（ホームとして表示する）は書き込める
    expect(ideaAppendProblem(titles, claudeIdea({ titleId: 'tw' }), req)).toBeNull()
    expect(ideaAppendProblem(titles, claudeIdea({ titleId: 'td' }), req)).toBeNull()
    expect(ideaAppendProblem(titles, claudeIdea(), req)).toBeNull()
    expect(ideaAppendProblem(titles, claudeIdea({ titleId: 'gone' }), req)).toBeNull()
    expect(ideaAppendProblem(titles, claudeIdea({ titleId: 'constructor' }), req)).toBeNull()
    // 作者が直したアイデアにも追記できる
    expect(ideaAppendProblem(titles, claudeIdea({ body: `${BODY}\n作者` }), req)).toBeNull()
    expect(ideaAppendProblem(titles, claudeIdea(), { ...req, text: ' \n　' })).toBe('invalid')
    expect(ideaAppendProblem(titles, claudeIdea(), { ...req, text: 'あ'.repeat(IDEA_LIMITS.appendText + 1) })).toBe('invalid')
    expect(ideaAppendProblem(titles, claudeIdea(), { ...req, text: 'あ'.repeat(IDEA_LIMITS.appendText) })).toBeNull()
    // 足すと1枚が 100,000 字を超える
    // （空行の2字・「2026/11/13のセッションで以下の内容へ変更」の25字・改行の1字 = 28字を足す。ちょうど 100,000 字までは足せる）
    const big = claudeIdea({ body: 'あ'.repeat(IDEA_LIMITS.body - 60) })
    expect(ideaAppendProblem(titles, big, { ...req, text: '𠮷'.repeat(32) })).toBeNull()
    expect(ideaAppendProblem(titles, big, { ...req, text: '𠮷'.repeat(33) })).toBe('too_long')
  })

  it('ideaSectionWritable: ホーム・タイトルが無いものは書ける。タイトルは「読む＋書き込む」の時だけ', () => {
    const titles = { tw: title('tw', 'write'), tr: title('tr', 'read'), tn: title('tn', 'none'), tx: title('tx') }
    expect(ideaSectionWritable(titles, { titleId: null })).toBe(true)
    expect(ideaSectionWritable(titles, { titleId: 'gone' })).toBe(true)
    expect(ideaSectionWritable(titles, { titleId: 'tw' })).toBe(true)
    expect(ideaSectionWritable(titles, { titleId: 'tx' })).toBe(true)
    expect(ideaSectionWritable(titles, { titleId: 'tr' })).toBe(false)
    expect(ideaSectionWritable(titles, { titleId: 'tn' })).toBe(false)
    expect(ideaSectionWritable({ tq: title('tq', 'all' as ClaudeAccess) }, { titleId: 'tq' })).toBe(false)
  })
})

describe('追記の当て方', () => {
  it('withIdeaAppend: 終わりに足し、依頼の id を足す。直していなければ指紋も新しい本文のもの（追記しても直していないまま）', () => {
    const idea = claudeIdea({ checked: true, checkedAt: 77, order: -2, titleId: 't1', updatedAt: 555 })
    const req = request()
    const next = withIdeaAppend(idea, req)
    expect(next.body).toBe(appendedBody(BODY, req))
    expect(next.appendIds).toEqual(['cu-req1'])
    expect(next.claudeHash).toBe(hashJson(next.body))
    expect(ideaEditedByAuthor(next)).toBe(false)
    // 並び・済み・場所・updatedAt・ほかの項目は変えない
    expect(next).toEqual({ ...idea, body: next.body, appendIds: ['cu-req1'], claudeHash: next.claudeHash })
    expect(idea.body).toBe(BODY)
    // 2回目も直していないまま
    const second = withIdeaAppend(next, request({ id: 'cu-req2', text: '二つ目' }))
    expect(second.appendIds).toEqual(['cu-req1', 'cu-req2'])
    expect(ideaEditedByAuthor(second)).toBe(false)
  })

  it('withIdeaAppend: 作者が直したアイデアは、指紋を変えない（追記しても直したまま）', () => {
    const edited = claudeIdea({ body: `${BODY}\n作者の一行`, claudeHash: hashJson(BODY) })
    const next = withIdeaAppend(edited, request())
    expect(next.body).toBe(appendedBody(edited.body, request()))
    expect(next.claudeHash).toBe(hashJson(BODY))
    expect(ideaEditedByAuthor(next)).toBe(true)
    // 指紋の無いもの（壊れた値）は無いまま
    const noHash = withIdeaAppend(claudeIdea({ claudeHash: undefined }), request())
    expect(noHash.claudeHash).toBeUndefined()
    expect(ideaEditedByAuthor(noHash)).toBe(true)
  })

  it('overlayIdeaAppends: 依頼を順に、足した後の本文に当てる。当てられない依頼は飛ばす。何も当てなければ同じ表', () => {
    const titles = { tr: title('tr', 'read') }
    const mine = claudeIdea()
    const ro = claudeIdea({ id: 'cy-readonly', titleId: 'tr' })
    const done = claudeIdea({ id: 'cy-done', appendIds: ['cu-old'] })
    const author = authorIdea()
    const ideas: Record<string, Idea> = { [mine.id]: mine, [ro.id]: ro, [done.id]: done, [author.id]: author }
    const frozen = JSON.stringify(ideas)
    const r1 = request({ id: 'cu-1', createdAt: 10, text: '一つ目' })
    const r2 = request({ id: 'cu-2', createdAt: 20, text: '二つ目' })
    const skip = [
      request({ id: 'cu-old', ideaId: done.id }),
      request({ id: 'cu-ro', ideaId: ro.id }),
      request({ id: 'cu-author', ideaId: author.id }),
      request({ id: 'cu-missing', ideaId: 'cy-missing' }),
      request({ id: 'cu-empty', text: '' }),
    ]
    const out = overlayIdeaAppends(titles, ideas, [r1, ...skip, r2])
    expect(out.applied.map((r) => r.id)).toEqual(['cu-1', 'cu-2'])
    expect(out.ideas[mine.id].body).toBe(appendedBody(appendedBody(BODY, r1), r2))
    expect(out.ideas[mine.id].appendIds).toEqual(['cu-1', 'cu-2'])
    expect(out.ideas[mine.id].updatedAt).toBe(mine.updatedAt)
    expect(ideaEditedByAuthor(out.ideas[mine.id])).toBe(false)
    // ほかのアイデアは同じオブジェクト。渡した表は書き換えない
    expect(out.ideas[ro.id]).toBe(ro)
    expect(out.ideas[author.id]).toBe(author)
    expect(out.ideas).not.toBe(ideas)
    expect(JSON.stringify(ideas)).toBe(frozen)
    // 何も当てなければ同じ表
    const none = overlayIdeaAppends(titles, ideas, skip)
    expect(none.ideas).toBe(ideas)
    expect(none.applied).toEqual([])
    expect(overlayIdeaAppends(titles, ideas, []).ideas).toBe(ideas)
    // 当てた後の id の依頼をもう一度当てても足さない（applied）
    expect(overlayIdeaAppends(titles, out.ideas, [r1]).ideas).toBe(out.ideas)
  })
})

describe('読んだ印・場所・1行目', () => {
  it('ideaReadMark: 本文の指紋の頭8字（同じ本文なら同じ。1字違えば違う）', () => {
    const mark = ideaReadMark(BODY)
    expect(mark).toMatch(/^[0-9a-z]{8}$/)
    expect(ideaReadMark(BODY)).toBe(mark)
    expect(ideaReadMark(`${BODY}。`)).not.toBe(mark)
    expect(mark.length).toBeLessThanOrEqual(IDEA_LIMITS.mark)
    // 決まった値（アプリとコネクタで同じ値になることの目印。変えると、前に読んだ印がすべて合わなくなる）
    expect(ideaReadMark('2026/11/12 14:32\n中身')).toBe('1on3jcfr')
  })

  it('ideaPlaceLabel: 「ホームのアイデア」か「タイトル『名前』のアイデア」（タイトルが無いものはホーム）', () => {
    const titles = { t1: title('t1', 'write', ' 灰の庭 '), t2: title('t2', 'write', '  ') }
    expect(ideaPlaceLabel(titles, { titleId: null })).toBe('ホームのアイデア')
    expect(ideaPlaceLabel(titles, { titleId: 'gone' })).toBe('ホームのアイデア')
    expect(ideaPlaceLabel(titles, { titleId: 't1' })).toBe('タイトル『灰の庭』のアイデア')
    expect(ideaPlaceLabel(titles, { titleId: 't2' })).toBe('タイトル『無題のタイトル』のアイデア')
  })

  it('ideaHeadLine: 最初の空でない行（古い版の見出しがあれば見出し）。長ければ「…」で max 字に', () => {
    expect(ideaHeadLine(claudeIdea())).toBe('2026/11/12 14:32　第3章の動機')
    expect(ideaHeadLine(claudeIdea({ body: '\n\n  二行目から\n三' }))).toBe('二行目から')
    expect(ideaHeadLine(claudeIdea({ heading: ' 見出し ' }))).toBe('見出し')
    expect(ideaHeadLine(claudeIdea({ body: '' }))).toBe('（空のアイデア）')
    const head = ideaHeadLine(claudeIdea({ body: 'あ'.repeat(50) }))
    expect(head).toBe(`${'あ'.repeat(39)}…`)
    expect(Array.from(ideaHeadLine(claudeIdea({ body: 'あ'.repeat(50) }), 10))).toHaveLength(10)
    expect(ideaHeadLine(claudeIdea({ body: 'あ'.repeat(40) }))).toBe('あ'.repeat(40))
  })
})
