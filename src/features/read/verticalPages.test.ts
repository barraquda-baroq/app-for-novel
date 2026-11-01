import { describe, expect, it } from 'vitest'
import { separatePiece } from '../../domain/acts'
import { createTitle } from '../../domain/entityOps'
import { buildReadThrough, NO_ACTIVE_MESSAGE, type ReadBlock } from '../../domain/readthrough'
import { stripRuby } from '../../domain/ruby'
import { addEpisode, addSpecial, updatePiece, updateVersion } from '../../domain/storyOps'
import { emptyData, type AppData, type ID } from '../../domain/types'
import type { PieceBlock } from './readLogic'
import {
  createPageCache,
  episodeSourceOf,
  layoutBody,
  layoutVerticalPages,
  locatePage,
  paginateEpisode,
  type PageLine,
} from './verticalPages'

const texts = (lines: readonly PageLine[]) => lines.map((l) => l.text)
const cells = (lines: readonly PageLine[]) => lines.map((l) => l.cells)
const a = (n: number, ch = 'あ') => ch.repeat(n)

function piece(id: ID, body: string | null, extra: Partial<PieceBlock> = {}): PieceBlock {
  return {
    type: 'piece',
    pieceId: id,
    kind: 'episode',
    chapterId: null,
    label: '第1話',
    subtitle: '',
    body,
    versionName: body === null ? null : '第1稿',
    acts: null,
    ...extra,
  }
}

describe('本文を行に分ける', () => {
  it('1行の字数で折り返し、段落ごとに新しい行にする', () => {
    const lines = layoutBody(`${a(25)}\n${a(3, 'い')}`, 10)
    expect(texts(lines)).toEqual([a(10), a(10), a(5), 'いいい'])
    expect(cells(lines)).toEqual([10, 10, 5, 3])
    expect(lines.every((l) => l.kind === 'text' && l.hang === 0)).toBe(true)
  })

  it('空行は1行。末尾の改行の後ろは行にしない。CRLF・CR も改行', () => {
    const lines = layoutBody('あ\n\n\nい\n', 10)
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['text', 'あ'],
      ['blank', ''],
      ['blank', ''],
      ['text', 'い'],
    ])
    expect(texts(layoutBody('あ\r\nい\rう', 10))).toEqual(['あ', 'い', 'う'])
    expect(layoutBody('', 10)).toEqual([])
    expect(layoutBody('\n', 10).map((l) => l.kind)).toEqual(['blank'])
  })

  it('字下げは書いたとおり（自動で下げない。折り返した行も下げない）', () => {
    const lines = layoutBody(`　${a(12)}\n「${a(3)}」`, 10)
    expect(texts(lines)).toEqual([`　${a(9)}`, a(3), `「${a(3)}」`])
    expect(cells(lines)).toEqual([10, 3, 5])
  })

  it('半角の英数字・記号・空白は 0.5 マス（縦中横にしない）。全角の英数字は1マス', () => {
    expect(cells(layoutBody('abcdefghij0123456789', 10))).toEqual([10])
    expect(texts(layoutBody('abcdefghij0123456789X', 10))).toEqual(['abcdefghij0123456789', 'X'])
    expect(cells(layoutBody('第12話 ok', 10))).toEqual([2 + 1 + 0.5 + 1])
    expect(cells(layoutBody('ＡＢ１２', 10))).toEqual([4])
    // 半角カナも 0.5 マス
    expect(cells(layoutBody('ｱｲｳｴ', 10))).toEqual([2])
    // 半マス残っていても全角は入らない
    expect(texts(layoutBody(`${a(9)}xあ`, 10))).toEqual([`${a(9)}x`, 'あ'])
    expect(cells(layoutBody(`${a(9)}xあ`, 10))).toEqual([9.5, 1])
  })

  it('「――」「……」は書いたとおり1字1マス', () => {
    expect(cells(layoutBody('――……', 10))).toEqual([4])
    expect(texts(layoutBody(`${a(9)}……`, 10))).toEqual([`${a(9)}…`, '…'])
  })

  it('サロゲートペアは1字、異体字セレクタ・結合文字は幅 0 で前の字に付く', () => {
    expect(cells(layoutBody('𠮷野家', 10))).toEqual([3])
    const ivs = '葛\u{E0100}'
    const lines = layoutBody(`${a(9)}${ivs}い`, 10)
    expect(texts(lines)).toEqual([`${a(9)}${ivs}`, 'い'])
    expect(cells(lines)).toEqual([10, 1])
    expect(cells(layoutBody('が', 10))).toEqual([1])
  })

  describe('禁則', () => {
    it('ぶら下げ: 行頭に来る「、」「。」「，」「．」は前の行の最後のマスの外に出す', () => {
      for (const p of ['、', '。', '，', '．']) {
        const lines = layoutBody(`${a(10)}${p}い`, 10)
        expect(texts(lines)).toEqual([`${a(10)}${p}`, 'い'])
        expect(lines[0].cells).toBe(11)
        expect(lines[0].hang).toBe(1)
        expect(lines[1].hang).toBe(0)
      }
      // 行の中の句読点はそのまま
      expect(layoutBody(`${a(8)}。い`, 10)[0]).toMatchObject({ text: `${a(8)}。い`, cells: 10, hang: 0 })
      // 半角の句読点は 0.5 マスぶら下げる
      expect(layoutBody(`${a(10)}｡`, 10)[0]).toMatchObject({ cells: 10.5, hang: 0.5 })
    })

    it('追い込み: 行頭に来る閉じ括弧・？！（全角・半角・‼⁉）・ー は前の行の末尾に入れる', () => {
      for (const p of [
        '」',
        '』',
        '）',
        '】',
        '〉',
        '》',
        '］',
        '｝',
        '〕',
        '’',
        '”',
        ')',
        '？',
        '！',
        '?',
        '!',
        '‼',
        '⁉',
        'ー',
      ]) {
        const lines = layoutBody(`${a(10)}${p}い`, 10)
        expect(texts(lines)).toEqual([`${a(10)}${p}`, 'い'])
        expect(lines[0].hang).toBe(0)
        expect(lines[0].cells).toBe(p.charCodeAt(0) < 0x7f ? 10.5 : 11)
      }
      // 行頭に来ないものは前の行に入れない
      expect(texts(layoutBody(`${a(10)}「い`, 10))).toEqual([a(10), '「い'])
      expect(texts(layoutBody(`${a(10)}…`, 10))).toEqual([a(10), '…'])
    })

    it('「。」」「？」」のように続く時は、句読点をぶら下げて閉じ括弧も前の行へ', () => {
      const lines = layoutBody(`「${a(9)}。」次`, 10)
      expect(texts(lines)).toEqual([`「${a(9)}。」`, '次'])
      expect(lines[0]).toMatchObject({ cells: 12, hang: 1 })
      const q = layoutBody(`「${a(9)}！？」`, 10)
      expect(texts(q)).toEqual([`「${a(9)}！？」`])
      expect(q[0]).toMatchObject({ cells: 13, hang: 0 })
    })

    it('追い込みは字数を3マス超えるまで（それより多い長音などは次の行の頭に置く）', () => {
      const lines = layoutBody(`${a(10)}ーーーーー`, 10)
      expect(texts(lines)).toEqual([`${a(10)}ーーー`, 'ーー'])
      expect(cells(lines)).toEqual([13, 2])
    })

    it('ぶら下げは1行に1字。2つ目の句読点は追い込む', () => {
      const lines = layoutBody(`${a(10)}。。い`, 10)
      expect(texts(lines)).toEqual([`${a(10)}。。`, 'い'])
      expect(lines[0]).toMatchObject({ cells: 12, hang: 1 })
    })

    it('段落の頭の閉じ括弧・句読点は前の段落に入れない', () => {
      expect(texts(layoutBody(`${a(10)}\n」。`, 10))).toEqual([a(10), '」。'])
    })
  })

  describe('ルビ・傍点', () => {
    it('ルビは親文字だけをマスに数え、記法は行の文字に残す', () => {
      const lines = layoutBody('彼は｜魔法使い《ウィザード》だ。東京《とうきょう》へ', 20)
      expect(texts(lines)).toEqual(['彼は｜魔法使い《ウィザード》だ。東京《とうきょう》へ'])
      expect(cells(lines)).toEqual([2 + 4 + 2 + 2 + 1])
    })

    it('ルビは行の途中で分けない（入らなければ次の行へ）', () => {
      const lines = layoutBody(`${a(8)}｜魔法使い《ウィザード》だ`, 10)
      expect(texts(lines)).toEqual([a(8), '｜魔法使い《ウィザード》だ'])
      expect(cells(lines)).toEqual([8, 5])
      // ルビの後の句読点もぶら下げる
      const hang = layoutBody(`${a(6)}｜魔法使い《ウィザード》。`, 10)
      expect(texts(hang)).toEqual([`${a(6)}｜魔法使い《ウィザード》。`])
      expect(hang[0]).toMatchObject({ cells: 11, hang: 1 })
    })

    it('1行より長い親文字のルビは、1行ずつに分けて読みも割り振る', () => {
      const base = '一二三四五六七八九十壱弐'
      const lines = layoutBody(`｜${base}《いちにさんしごろくしちはちくじゅういちに》`, 10)
      expect(lines).toHaveLength(2)
      expect(cells(lines)).toEqual([10, 2])
      expect(lines.map((l) => stripRuby(l.text)).join('')).toBe(base)
      for (const l of lines) expect(l.text).toMatch(/^｜.+《.+》$/)
    })

    it('傍点は1字ずつ分けられ、行ごとに《《…》》で閉じ直す', () => {
      const lines = layoutBody(`${a(8)}《《強調文字》》だ`, 10)
      expect(texts(lines)).toEqual([`${a(8)}《《強調》》`, '《《文字》》だ'])
      expect(cells(lines)).toEqual([10, 3])
    })

    it('｜《 は《そのもの（1マス、記法のまま残す）', () => {
      const lines = layoutBody('作品名は｜《銀河》です', 20)
      expect(texts(lines)).toEqual(['作品名は｜《銀河》です'])
      expect(cells(lines)).toEqual([10])
      // 漢字の後の｜《 を行で分けても、行ごとに読んで同じ文字になる
      const split = layoutBody(`${a(9)}漢字｜《かな》`, 10)
      expect(split.map((l) => stripRuby(l.text)).join('')).toBe(`${a(9)}漢字《かな》`)
    })

    it('漢字でない文字の後の《》や閉じていない記号は、ふつうの字として数える', () => {
      expect(cells(layoutBody('あいう《えお》', 20))).toEqual([7])
      expect(cells(layoutBody('《《閉じない', 20))).toEqual([6])
    })

    it('どの分け方でも、行ごとに記法を読んでつなぐと元の本文の記法を読んだものと同じになり、マスの合計も同じ', () => {
      const pieces = [
        'あ',
        '漢',
        '字',
        '｜魔法《まほう》',
        '東京《とうきょう》',
        '《《傍点》》',
        '｜《',
        '。',
        '」',
        'ー',
        'a',
        '　',
        '？',
      ]
      let seed = 7
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
      }
      for (let n = 0; n < 200; n++) {
        let p = ''
        const len = 5 + Math.floor(rand() * 40)
        for (let i = 0; i < len; i++) p += pieces[Math.floor(rand() * pieces.length)]
        const chars = 10 + Math.floor(rand() * 5)
        const lines = layoutBody(p, chars)
        expect(lines.map((l) => stripRuby(l.text)).join('')).toBe(stripRuby(p))
        const total = layoutBody(p, 1000)[0].cells
        expect(lines.reduce((s, l) => s + l.cells, 0)).toBe(total)
        for (const l of lines) expect(l.cells).toBeLessThanOrEqual(chars + 3)
      }
    })
  })
})

describe('話をページに組む', () => {
  const setup = { chars: 10, lines: 5 }

  it('話の頭に「第n話　題」と空行1行。行数ごとにページを分ける', () => {
    const lay = paginateEpisode(episodeSourceOf(piece('p1', `${a(25)}\n${a(10)}\n\n${a(3)}`, { subtitle: ' 旅立ち ' })), setup)
    const all = lay.pages.flat()
    expect(all.map((l) => [l.kind, l.text])).toEqual([
      ['heading', '第1話　旅立ち'],
      ['blank', ''],
      ['text', a(10)],
      ['text', a(10)],
      ['text', a(5)],
      ['text', a(10)],
      ['blank', ''],
      ['text', a(3)],
    ])
    expect(lay.pages.map((p) => p.length)).toEqual([5, 3])
    expect(lay.lineCount).toBe(8)
    expect(lay.acts).toEqual([])
  })

  it('見出しは記法として読まず、長ければ折り返す', () => {
    const lay = paginateEpisode({ heading: '第1話　｜魔法《まほう》の国のおはなし', parts: [{ body: 'あ' }] }, setup)
    const heads = lay.pages[0].filter((l) => l.kind === 'heading')
    expect(texts(heads)).toEqual(['第1話　｜魔法《まほ', 'う》の国のおはなし'])
  })

  it('見出しの2桁までの半角数字は縦中横（1マス）に数え、分けない。3桁以上は半角のまま数え、分けない', () => {
    // 「第1話　」+ 全角6字 = 10マス（1 を半マスに数えると 9.5マス）。1行 10字に収まる
    const one = paginateEpisode({ heading: '第1話　六字の題名だ', parts: [{ body: 'あ' }] }, setup)
    const oneHeads = one.pages[0].filter((l) => l.kind === 'heading')
    expect(oneHeads.map((l) => [l.text, l.cells])).toEqual([['第1話　六字の題名だ', 10]])
    // 1字多ければ折り返す（半マスに数えると 10.5マスで、やはり折り返す）
    const over = paginateEpisode({ heading: '第1話　七字の長い題名', parts: [{ body: 'あ' }] }, setup)
    expect(texts(over.pages[0].filter((l) => l.kind === 'heading'))).toEqual(['第1話　七字の長い題', '名'])
    // 2桁は 0.5 + 0.5 と同じ1マス
    const two = paginateEpisode({ heading: '第12話', parts: [{ body: 'あ' }] }, setup)
    expect(two.pages[0][0]).toMatchObject({ text: '第12話', cells: 3 })
    // 3桁は半角のまま（1.5マス）で、行の境目でも分けない
    const three = paginateEpisode({ heading: '第123話', parts: [{ body: 'あ' }] }, setup)
    expect(three.pages[0][0]).toMatchObject({ text: '第123話', cells: 3.5 })
    const edge = paginateEpisode({ heading: 'あいうえおかきく第123話', parts: [{ body: 'あ' }] }, setup)
    expect(texts(edge.pages[0].filter((l) => l.kind === 'heading'))).toEqual(['あいうえおかきく第', '123話'])
    // 幕の見出しも同じ
    const b = piece('p1', 'unused', {
      acts: [{ pieceId: 'a1', label: `第1幕　${'あ'.repeat(6)}`, body: 'い', versionName: '第1稿' }],
    })
    const act = paginateEpisode(episodeSourceOf(b), setup).pages[0].filter((l) => l.kind === 'act')
    expect(act.map((l) => l.cells)).toEqual([10])
    // 本文の半角数字は今までどおり半マス
    expect(layoutBody('第1話', 10)[0].cells).toBe(2.5)
  })

  it('採用原稿がなければ「採用原稿がありません。」の1行。本文が空なら見出しだけ', () => {
    const missing = paginateEpisode(episodeSourceOf(piece('p1', null)), setup)
    expect(missing.pages.flat().map((l) => [l.kind, l.text])).toEqual([
      ['heading', '第1話'],
      ['blank', ''],
      ['missing', NO_ACTIVE_MESSAGE],
    ])
    expect(missing.pages.flat()[2]).toMatchObject({ cells: 11, hang: 1 })
    const empty = paginateEpisode(episodeSourceOf(piece('p1', '')), setup)
    expect(empty.pages.flat().map((l) => l.kind)).toEqual(['heading', 'blank'])
    expect(empty.pages).toHaveLength(1)
  })

  it('話の末尾の空行は数えない（白紙のページを作らない）。頭の空行は書いたとおり', () => {
    const lay = paginateEpisode(episodeSourceOf(piece('p1', `\n${a(3)}\n\n\n\n\n\n\n`)), setup)
    expect(lay.pages.flat().map((l) => l.kind)).toEqual(['heading', 'blank', 'blank', 'text'])
    expect(lay.pages).toHaveLength(1)
  })

  it('幕の境目ではページを変えず、幕の見出しを1行に置く', () => {
    const b = piece('p1', 'unused', {
      acts: [
        { pieceId: 'a1', label: '第1幕', body: `${a(3)}\n`, versionName: '第1稿' },
        { pieceId: 'a2', label: '第2幕', body: null, versionName: null },
        { pieceId: 'a3', label: '第3幕', body: a(12), versionName: '第1稿' },
      ],
    })
    const lay = paginateEpisode(episodeSourceOf(b), setup)
    const all = lay.pages.flat()
    expect(all.map((l) => [l.kind, l.text])).toEqual([
      ['heading', '第1話'],
      ['blank', ''],
      ['act', '第1幕'],
      ['text', a(3)],
      ['act', '第2幕'],
      ['missing', NO_ACTIVE_MESSAGE],
      ['act', '第3幕'],
      ['text', a(10)],
      ['text', a(2)],
    ])
    expect(all.filter((l) => l.kind === 'act').map((l) => l.actId)).toEqual(['a1', 'a2', 'a3'])
    expect(lay.pages.map((p) => p.length)).toEqual([5, 4])
    expect(lay.acts).toEqual([
      { pieceId: 'a1', label: '第1幕', pageIndex: 0, line: 2 },
      { pieceId: 'a2', label: '第2幕', pageIndex: 0, line: 4 },
      { pieceId: 'a3', label: '第3幕', pageIndex: 1, line: 1 },
    ])
  })
})

describe('通し読み全体をページに組む', () => {
  const setup = { chars: 10, lines: 5 }

  it('話ごとに新しいページから始め、通しのページ番号を振る。章の見出しはページに入れない', () => {
    const blocks: ReadBlock[] = [
      { type: 'chapter', chapterId: 'c1', name: '一章', note: '' },
      piece('p1', a(50), { chapterId: 'c1' }),
      piece('p2', 'あ', { label: '第2話', chapterId: 'c1' }),
      { type: 'chapterEnd', chapterId: 'c1' },
      piece('p3', null, { kind: 'special', label: 'エピローグ' }),
    ]
    const lay = layoutVerticalPages(blocks, setup)
    expect(lay.episodes.map((e) => [e.pieceId, e.heading, e.startPage, e.pageCount, e.chapterId, e.kind])).toEqual([
      ['p1', '第1話', 1, 2, 'c1', 'episode'],
      ['p2', '第2話', 3, 1, 'c1', 'episode'],
      ['p3', 'エピローグ', 4, 1, null, 'special'],
    ])
    expect(lay.totalPages).toBe(4)
    expect(lay.byPiece.get('p2')?.startPage).toBe(3)
    expect(lay.setup).toEqual(setup)
    expect(lay.episodes[0].pages[1].map((l) => l.text)).toEqual([a(10), a(10)])
    expect(lay.episodes[0].acts).toBeNull()
    expect(layoutVerticalPages([], setup)).toMatchObject({ episodes: [], totalPages: 0 })
  })

  it('幕の見出しの通しのページ番号', () => {
    const blocks: ReadBlock[] = [
      piece('p1', a(30)),
      piece('p2', 'x', {
        label: '第2話',
        acts: [
          { pieceId: 'a1', label: '第1幕', body: a(30), versionName: '第1稿' },
          { pieceId: 'a2', label: '第2幕', body: 'い', versionName: '第1稿' },
        ],
      }),
    ]
    const lay = layoutVerticalPages(blocks, setup)
    expect(lay.episodes[1].startPage).toBe(2)
    expect(lay.episodes[1].acts).toEqual([
      { pieceId: 'a1', label: '第1幕', page: 2, line: 2 },
      { pieceId: 'a2', label: '第2幕', page: 3, line: 1 },
    ])
  })

  it('通しのページ番号から話を探す', () => {
    const lay = layoutVerticalPages([piece('p1', a(50)), piece('p2', 'あ'), piece('p3', a(80))], setup)
    expect(lay.episodes.map((e) => e.startPage)).toEqual([1, 3, 4])
    expect(locatePage(lay, 1)).toMatchObject({ episode: { pieceId: 'p1' }, pageIndex: 0 })
    expect(locatePage(lay, 2)).toMatchObject({ episode: { pieceId: 'p1' }, pageIndex: 1 })
    expect(locatePage(lay, 3)).toMatchObject({ episode: { pieceId: 'p2' }, pageIndex: 0 })
    expect(locatePage(lay, lay.totalPages)).toMatchObject({ episode: { pieceId: 'p3' }, pageIndex: lay.totalPages - 4 })
    expect(locatePage(lay, 0)).toBeNull()
    expect(locatePage(lay, lay.totalPages + 1)).toBeNull()
    expect(locatePage(lay, 1.5)).toBeNull()
  })

  it('アプリのデータから: 通し読みと同じ見出し・幕の見出し', () => {
    let data: AppData = emptyData()
    const t = createTitle(data, '作品')
    data = t.data
    const ids: ID[] = []
    for (const body of ['一話の本文', 'はじめ\nおわり']) {
      const r = addEpisode(data, t.result)
      data = updateVersion(r.data, r.data.pieces[r.result].versionIds[0], { body })
      ids.push(r.result)
    }
    data = updatePiece(data, ids[0], { subtitle: '雨' })
    data = separatePiece(data, ids[1], ['はじめ\n'.length]).data
    data = addSpecial(data, t.result, { chapterId: null, index: 0 }, 'プロローグ').data
    const lay = layoutVerticalPages(buildReadThrough(data, t.result), { chars: 20, lines: 20 })
    expect(lay.episodes.map((e) => e.heading)).toEqual(['プロローグ', '第1話　雨', '第2話'])
    expect(lay.episodes[2].pages[0].map((l) => [l.kind, l.text])).toEqual([
      ['heading', '第2話'],
      ['blank', ''],
      ['act', '第1幕'],
      ['text', 'はじめ'],
      ['act', '第2幕'],
      ['text', 'おわり'],
    ])
    expect(lay.totalPages).toBe(3)
  })
})

describe('覚え（PageCache）', () => {
  it('本文・見出し・字数×行数が変わらない話は組み直さず、同じ pages を返す', () => {
    const cache = createPageCache()
    const blocks = [piece('p1', a(50)), piece('p2', a(20), { label: '第2話' })]
    const first = layoutVerticalPages(blocks, { chars: 10, lines: 5 }, cache)
    expect(cache.size).toBe(2)
    // ブロックを作り直しても（通し読みはデータが変わるたびに作る）、本文が同じなら同じ pages
    const again = layoutVerticalPages(
      blocks.map((b) => ({ ...b })),
      { chars: 10, lines: 5 },
      cache,
    )
    expect(again.episodes[0].pages).toBe(first.episodes[0].pages)
    expect(again.episodes[1].pages).toBe(first.episodes[1].pages)
    // 1話だけ変えれば、その話だけ組み直す（後ろの話のページ番号は変わる）
    const edited = layoutVerticalPages([piece('p1', a(90)), blocks[1]], { chars: 10, lines: 5 }, cache)
    expect(edited.episodes[0].pages).not.toBe(first.episodes[0].pages)
    expect(edited.episodes[1].pages).toBe(first.episodes[1].pages)
    expect(edited.episodes[1].startPage).toBe(edited.episodes[0].pageCount + 1)
    // 見出し（題）が変わっても組み直す
    const renamed = layoutVerticalPages(
      [blocks[0], piece('p2', a(20), { label: '第2話', subtitle: '題' })],
      { chars: 10, lines: 5 },
      cache,
    )
    expect(renamed.episodes[1].pages).not.toBe(first.episodes[1].pages)
  })

  it('行数だけを変えた時は行の分け方を使い回し、字数を変えたら組み直す', () => {
    const cache = createPageCache()
    const blocks = [piece('p1', a(200))]
    const first = layoutVerticalPages(blocks, { chars: 10, lines: 5 }, cache)
    const taller = layoutVerticalPages(blocks, { chars: 10, lines: 10 }, cache)
    expect(taller.episodes[0].pageCount).toBe(Math.ceil(22 / 10))
    expect(taller.episodes[0].pages[0][2]).toBe(first.episodes[0].pages[0][2])
    const wider = layoutVerticalPages(blocks, { chars: 20, lines: 10 }, cache)
    expect(wider.episodes[0].lineCount).toBe(12)
    // 覚えが無くても同じ結果
    expect(layoutVerticalPages(blocks, { chars: 20, lines: 10 }).episodes[0].pages).toEqual(wider.episodes[0].pages)
  })
})

describe('長編でも速い', () => {
  it('数十万字（300話・ルビや傍点も入れて記法を除いて約60万字）を組み、覚えがあれば組み直さない', () => {
    const para = '　彼は｜魔法使い《ウィザード》だった。「そうだろう？」と《《彼女》》は言った――ABC123の街で……。'
    const body = Array.from({ length: 30 }, (_, i) => (i % 7 === 6 ? '' : para.repeat(2))).join('\n')
    const blocks: ReadBlock[] = Array.from({ length: 300 }, (_, i) => piece(`p${i}`, body, { label: `第${i + 1}話` }))
    const total = blocks.reduce((s, b) => s + (b.type === 'piece' && b.body ? b.body.length : 0), 0)
    expect(total).toBeGreaterThan(800_000)
    const cache = createPageCache()
    const t0 = performance.now()
    const lay = layoutVerticalPages(blocks, { chars: 40, lines: 32 }, cache)
    const t1 = performance.now()
    layoutVerticalPages(
      blocks.map((b) => ({ ...b })),
      { chars: 40, lines: 32 },
      cache,
    )
    const t2 = performance.now()
    expect(lay.totalPages).toBe(600)
    expect(lay.episodes[299].startPage + lay.episodes[299].pageCount - 1).toBe(lay.totalPages)
    // 目安（CI の遅い端末でも通るように広めに取る）
    expect(t1 - t0).toBeLessThan(3000)
    expect(t2 - t1).toBeLessThan(200)
  })
})
