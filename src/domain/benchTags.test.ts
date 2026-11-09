import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addBenchAnalysis,
  addBenchWork,
  deleteBenchAnalysis,
  removeBenchTag,
  setBenchWorkTags,
  updateBenchAnalysis,
} from './benchOps'
import {
  applyAutoGenreTags,
  benchWorkTagsWithAuto,
  genreTagsOf,
  isNewerMark,
  latestGenreAnalysis,
  pendingAutoTags,
} from './benchTags'
import { emptyData, type AppData, type BenchAnalysis, type ID } from './types'

/** V29 の 02 が登録する「14 検索用タグ」の本文（テンプレートの書き方そのまま） */
const V29_14 = `**結論**：港町の喫茶店を舞台に、喪失から立ち直る二人を描く恋愛小説
担当：編集長（マーケター案を確定）

- 判定したジャンル：恋愛
- 適性のある賞（選んだ理由）：架空の恋愛小説新人賞（喪失と再生の恋愛を新人に求める賞のため）
※この2行には、役割の前の判定をそのまま写す。「ジャンル／サブジャンル」のジャンルは、判定したジャンルと同じ名前にする。
- ジャンル／サブジャンル：恋愛／青春・喪失、家族
- トーン（例：静謐、疾走、乾いた、湿った、ユーモア）：静謐、湿った
- 構造型（05の命名）：一人称回想型
- 表現の核の種類（03の分類）：沈黙で語る型
- 読者層：20〜40代
- 分量区分：長編
- 賞・受賞歴：不明（ブラインド分析のため書かない）
- 比較用キーワード（原稿との照合に使う語、5つまで）：喪失、喫茶店、港町、再生、手紙`

/** 14 の本文（ジャンルの2行だけを差し替える） */
const body14 = (genre: string | null, sub: string) =>
  [
    '**結論**：検索の最短の言い方',
    '担当：編集長（マーケター案を確定）',
    '',
    ...(genre === null ? [] : [`- 判定したジャンル：${genre}`, '- 適性のある賞（選んだ理由）：架空の賞（理由）']),
    `- ジャンル／サブジャンル：${sub}`,
    '- トーン（例：静謐、疾走、乾いた、湿った、ユーモア）：乾いた',
  ].join('\n')

/** 時刻を1秒ずつ進めながら操作する（分析の並びが作った時刻で決まるため） */
function clock(start = Date.UTC(2026, 10, 9, 3, 0)) {
  let t = start
  vi.useFakeTimers()
  vi.setSystemTime(t)
  return () => {
    t += 1000
    vi.setSystemTime(t)
    return t
  }
}

afterEach(() => {
  vi.useRealTimers()
})

/** 作品を足す */
function withWork(data: AppData, name: string): { data: AppData; id: ID } {
  const r = addBenchWork(data, { name, author: '著者' })
  return { data: r.data, id: r.result }
}

/** 分析を足す（観点・本文・日付） */
function withAnalysis(data: AppData, workId: ID, viewpoint: string, body: string, runDate = '2026-11-01') {
  const r = addBenchAnalysis(data, workId, { viewpoint, body, runDate })
  return { data: r.data, id: r.result }
}

const analysesOf = (data: AppData, workId: ID): BenchAnalysis[] =>
  Object.values(data.benchAnalyses).filter((a) => a.workId === workId)

describe('「14 検索用タグ」の本文の読み方（genreTagsOf）', () => {
  it('V29 の 14: 判定したジャンル → サブジャンル（「／」「・」「、」で区切る。先頭の判定したジャンルは1つに）', () => {
    expect(genreTagsOf(V29_14)).toEqual(['恋愛', '青春', '喪失', '家族'])
  })

  it('判定したジャンルは区切らない（「時代・歴史」）。ジャンル／サブジャンルの先頭が同じなら外して、残りを区切る', () => {
    expect(genreTagsOf(body14('時代・歴史', '時代・歴史／幕末・剣客'))).toEqual(['時代・歴史', '幕末', '剣客'])
    // 先頭が違えば全体を区切る（重なりは1つ）
    expect(genreTagsOf(body14('恋愛', '青春／恋愛・家族'))).toEqual(['恋愛', '青春', '家族'])
    // 先頭が判定したジャンルで始まるだけの別の語（「恋愛小説」）は外さない
    expect(genreTagsOf(body14('恋愛', '恋愛小説／純愛'))).toEqual(['恋愛', '恋愛小説', '純愛'])
    // サブジャンルが無い
    expect(genreTagsOf(body14('ミステリー', 'ミステリー'))).toEqual(['ミステリー'])
  })

  it('判定したジャンルの行が無い V21 の 14 は、ジャンル／サブジャンルの全体を区切る', () => {
    expect(genreTagsOf(body14(null, 'ミステリー／本格・館もの'))).toEqual(['ミステリー', '本格', '館もの'])
  })

  it('書き方の揺れ: 太字のラベル・「*」の印・半角の「/」「:」・「 / 」の空白・「,」「，」', () => {
    expect(genreTagsOf('- **判定したジャンル**：ＳＦ\n- **ジャンル／サブジャンル**：ＳＦ / スペースオペラ, 軍事')).toEqual([
      'ＳＦ',
      'スペースオペラ',
      '軍事',
    ])
    expect(genreTagsOf('* 判定したジャンル: ホラー\n* ジャンル/サブジャンル: ホラー/怪談，民俗')).toEqual([
      'ホラー',
      '怪談',
      '民俗',
    ])
    expect(genreTagsOf('**判定したジャンル：** 青春\n**ジャンル／サブジャンル：** 青春／部活。')).toEqual(['青春', '部活'])
    expect(genreTagsOf('判定したジャンル：恋愛\nジャンル　／　サブジャンル：恋愛／大人')).toEqual(['恋愛', '大人'])
  })

  it('末尾の（…）の注記を外し、「サブジャンル：本格」のラベルは「：」の後ろだけ。かっこの中では区切らない', () => {
    expect(genreTagsOf(body14('ミステリー（棚のジャンル名から）', 'ミステリー／サブジャンル：本格（館・孤島）'))).toEqual([
      'ミステリー',
      '本格',
    ])
  })

  it('「なし」「不明」「（なし）」・空の値・20字を超える語は飛ばす（切り詰めない）', () => {
    expect(genreTagsOf(body14('恋愛', '恋愛／なし'))).toEqual(['恋愛'])
    expect(genreTagsOf(body14('不明', 'ファンタジー／（なし）・異世界'))).toEqual(['ファンタジー', '異世界'])
    expect(genreTagsOf(body14('', ''))).toEqual([])
    expect(genreTagsOf(body14('恋愛', `恋愛／${'あ'.repeat(21)}・${'い'.repeat(20)}`))).toEqual(['恋愛', 'い'.repeat(20)])
  })

  it('全角と半角だけ違う重なりは1つ（先に出た書き方）。2行が無ければ空', () => {
    expect(genreTagsOf(body14('SF', 'ＳＦ／ＳＦ・SF・宇宙'))).toEqual(['SF', '宇宙'])
    expect(genreTagsOf('**結論**：一文\n- トーン：静謐')).toEqual([])
    // ※の行（テンプレートの注意書き）は読まない
    expect(genreTagsOf('※この2行には…「ジャンル／サブジャンル」のジャンルは…\n- 判定したジャンル：恋愛')).toEqual(['恋愛'])
    // それぞれ最初の1行だけ
    expect(genreTagsOf(`${body14('恋愛', '恋愛／青春')}\n- 判定したジャンル：SF\n- ジャンル／サブジャンル：SF／宇宙`)).toEqual([
      '恋愛',
      '青春',
    ])
  })
})

describe('最新の 14（latestGenreAnalysis）と、取り込んだ印（isNewerMark）', () => {
  it('日付 → 作った時刻 → id の順で最新。観点名の全角の空白・全角の数字も同じ観点', () => {
    const tick = clock()
    let { data, id: w } = withWork(emptyData(), '作品')
    tick()
    const a = withAnalysis(data, w, '14 検索用タグ', body14('恋愛', '恋愛'), '2026-11-02')
    data = a.data
    tick()
    const b = withAnalysis(data, w, '１４　検索用タグ', body14('SF', 'SF'), '2026-11-01')
    data = b.data
    tick()
    data = withAnalysis(data, w, '13 数値評価', '本文', '2026-11-05').data
    expect(latestGenreAnalysis(analysesOf(data, w))?.id).toBe(a.id)
    tick()
    const c = withAnalysis(data, w, ' 14　検索用タグ ', body14('ホラー', 'ホラー'), '2026-11-02')
    data = c.data
    // 同じ日なら新しく作った方
    expect(latestGenreAnalysis(analysesOf(data, w))?.id).toBe(c.id)
    expect(latestGenreAnalysis([])).toBeUndefined()
    const mark = { analysisId: a.id, runDate: '2026-11-02', createdAt: data.benchAnalyses[a.id].createdAt }
    expect(isNewerMark(data.benchAnalyses[c.id], mark)).toBe(true)
    expect(isNewerMark(data.benchAnalyses[b.id], mark)).toBe(false)
    // 同じ分析は新しくない（日付を直しても）
    expect(isNewerMark({ ...data.benchAnalyses[a.id], runDate: '2026-12-01' }, mark)).toBe(false)
  })
})

describe('自動のタグを付ける（pendingAutoTags・applyAutoGenreTags）', () => {
  /** 14 のある作品 */
  function shelf() {
    const tick = clock()
    let { data, id } = withWork(emptyData(), '港の喫茶店')
    tick()
    const a = withAnalysis(data, id, '14 検索用タグ', V29_14)
    data = a.data
    tick()
    return { data, id, analysisId: a.id, tick }
  }

  it('前からある作品（autoTagsFrom なし）は最新の 14 から一度だけ。もう一度当てても何もしない（data もそのまま）', () => {
    const { data, id, analysisId } = shelf()
    expect(pendingAutoTags(data.benchWorks[id], analysesOf(data, id))?.tags).toEqual(['恋愛', '青春', '喪失', '家族'])
    const next = applyAutoGenreTags(data)
    expect(next.benchWorks[id].tags).toEqual(['恋愛', '青春', '喪失', '家族'])
    expect(next.benchWorks[id].autoTagsFrom).toEqual({
      analysisId,
      runDate: '2026-11-01',
      createdAt: data.benchAnalyses[analysisId].createdAt,
    })
    expect(next.benchWorks[id].updatedAt).toBeGreaterThan(data.benchWorks[id].updatedAt)
    expect(applyAutoGenreTags(next)).toBe(next)
    expect(pendingAutoTags(next.benchWorks[id], analysesOf(next, id))).toBeNull()
  })

  it('作者が外したタグは同じ 14 では戻らない。新しい 14 が来るとその判定を足し、前のタグは消さない', () => {
    const { data: d0, id, tick } = shelf()
    let data = applyAutoGenreTags(d0)
    data = setBenchWorkTags(data, id, ['恋愛', '家族', '港町'])
    expect(applyAutoGenreTags(data)).toBe(data)
    // すべての作品から外しても戻らない
    data = removeBenchTag(data, '家族').data
    expect(applyAutoGenreTags(data)).toBe(data)
    tick()
    const b = withAnalysis(data, id, '14 検索用タグ', body14('恋愛', '恋愛／大人・喪失'), '2026-11-08')
    data = applyAutoGenreTags(b.data)
    expect(data.benchWorks[id].tags).toEqual(['恋愛', '港町', '大人', '喪失'])
    expect(data.benchWorks[id].autoTagsFrom?.analysisId).toBe(b.id)
  })

  it('古い 14 しか残っていない（取り込んだ 14 を削除した）時は何もしない', () => {
    const { data: d0, id, tick } = shelf()
    tick()
    const b = withAnalysis(d0, id, '14 検索用タグ', body14('SF', 'SF／宇宙'), '2026-11-08')
    let data = applyAutoGenreTags(b.data)
    expect(data.benchWorks[id].tags).toEqual(['SF', '宇宙'])
    data = setBenchWorkTags(data, id, [])
    data = deleteBenchAnalysis(data, b.id)
    expect(applyAutoGenreTags(data)).toBe(data)
  })

  it('14 が読めない時は autoTagsFrom を進めない（本文を直すと付く）。もう付いているタグだけでも autoTagsFrom は進める', () => {
    const tick = clock()
    let { data, id } = withWork(emptyData(), '作品')
    tick()
    const a = withAnalysis(data, id, '14 検索用タグ', '**結論**：まだ書いていない\n- 判定したジャンル：')
    data = a.data
    expect(applyAutoGenreTags(data)).toBe(data)
    tick()
    data = updateBenchAnalysis(data, a.id, { body: body14('恋愛', '恋愛') })
    data = applyAutoGenreTags(data)
    expect(data.benchWorks[id].tags).toEqual(['恋愛'])
    // 付いているタグだけの新しい 14
    tick()
    data = setBenchWorkTags(data, id, ['恋愛', 'ＳＦ'])
    const b = withAnalysis(data, id, '14 検索用タグ', body14('SF', 'SF'), '2026-11-09')
    data = applyAutoGenreTags(b.data)
    expect(data.benchWorks[id].tags).toEqual(['恋愛', 'ＳＦ'])
    expect(data.benchWorks[id].autoTagsFrom?.analysisId).toBe(b.id)
  })

  it('20個で止める', () => {
    const tick = clock()
    let { data, id } = withWork(emptyData(), '作品')
    data = setBenchWorkTags(
      data,
      id,
      Array.from({ length: 19 }, (_, i) => `タグ${i + 1}`),
    )
    tick()
    data = withAnalysis(data, id, '14 検索用タグ', body14('恋愛', '恋愛／青春・喪失')).data
    data = applyAutoGenreTags(data)
    expect(data.benchWorks[id].tags).toHaveLength(20)
    expect(data.benchWorks[id].tags?.at(-1)).toBe('恋愛')
  })

  it('【対照】【監査】【横断】（【対照】【原稿】… も）の作品には付けない。【原稿】は回ごとの 14 から（前の回のタグを引き継がない）', () => {
    const tick = clock()
    let data = emptyData()
    const ids: ID[] = []
    for (const name of [
      '【対照】港の喫茶店',
      '【監査】港の喫茶店',
      '【横断】恋愛',
      '【対照】【原稿】星の庭（第1稿）（置換）',
      ' 【横断】 恋愛＋喪失',
    ]) {
      const w = withWork(data, name)
      data = withAnalysis(w.data, w.id, '14 検索用タグ', V29_14).data
      ids.push(w.id)
      tick()
    }
    expect(applyAutoGenreTags(data)).toBe(data)
    const r1 = withWork(data, '【原稿】星の庭（第1稿）')
    data = withAnalysis(r1.data, r1.id, '14 検索用タグ', body14('恋愛', '恋愛／青春')).data
    tick()
    const r2 = withWork(data, '【原稿】星の庭（第2稿）')
    data = withAnalysis(r2.data, r2.id, '14 検索用タグ', body14('ファンタジー', 'ファンタジー／異世界')).data
    data = applyAutoGenreTags(data)
    expect(data.benchWorks[r1.id].tags).toEqual(['恋愛', '青春'])
    expect(data.benchWorks[r2.id].tags).toEqual(['ファンタジー', '異世界'])
    for (const id of ids) expect(data.benchWorks[id].tags).toBeUndefined()
  })

  it('作品の無い分析は飛ばす。Claude・貼り付け・手で記録のどれで作った 14 も同じに扱う', () => {
    const tick = clock()
    let data = emptyData()
    const ids: ID[] = []
    for (const source of ['claude', 'paste', 'manual'] as const) {
      const w = withWork(data, `作品${source}`)
      const a = withAnalysis(w.data, w.id, '14 検索用タグ', body14('恋愛', '恋愛／青春'))
      data = {
        ...a.data,
        benchAnalyses: { ...a.data.benchAnalyses, [a.id]: { ...a.data.benchAnalyses[a.id], source } },
      }
      ids.push(w.id)
      tick()
    }
    const orphan: BenchAnalysis = { ...Object.values(data.benchAnalyses)[0], id: 'orphan', workId: 'nope' }
    data = { ...data, benchAnalyses: { ...data.benchAnalyses, orphan } }
    data = applyAutoGenreTags(data)
    for (const id of ids) expect(data.benchWorks[id].tags).toEqual(['恋愛', '青春'])
    expect(data.benchWorks.nope).toBeUndefined()
  })

  it('アプリがまだ付けていないタグも見せる（benchWorkTagsWithAuto）。付けた後・外した後は今のタグ', () => {
    const { data: d0, id } = shelf()
    expect(benchWorkTagsWithAuto(d0, d0.benchWorks[id])).toEqual(['恋愛', '青春', '喪失', '家族'])
    const data = setBenchWorkTags(applyAutoGenreTags(d0), id, ['恋愛'])
    expect(benchWorkTagsWithAuto(data, data.benchWorks[id])).toEqual(['恋愛'])
    const tagless = withWork(data, '【横断】恋愛')
    expect(benchWorkTagsWithAuto(tagless.data, tagless.data.benchWorks[tagless.id])).toEqual([])
  })
})
