import { describe, expect, it } from 'vitest'
import { createTitle, addCategory, addEntry, categoriesOf } from '../../../domain/entityOps'
import {
  addChapter,
  addEpisode,
  addSpecial,
  addVersion,
  episodeTargets,
  insertOptions,
  movePiece,
  movePieceStep,
  removeChapter,
  setActiveVersion,
  setChaptersEnabled,
  setNumbering,
  updateVersion,
} from '../../../domain/storyOps'
import { canDeletePiece, locatePiece } from '../../../domain/structure'
import { emptyData, type AppData, type ID } from '../../../domain/types'
import {
  chapterStats,
  chapterStepAvailability,
  defaultEpisodeTarget,
  deletePermissions,
  entryCounts,
  excerptOf,
  findSlotIndex,
  formatRenumbering,
  memoExcerpt,
  optionsWithinChapter,
  pieceRows,
  pieceSummary,
  previewEpisode,
  previewMoveLabel,
  renumberingOnRelease,
  rowsFor,
  sameRows,
  specialPositionPreference,
  statsOfPieces,
  stepAvailability,
  titleStats,
} from './storyLogic'

function setup(episodes = 0): { data: AppData; titleId: ID; ids: ID[] } {
  const r = createTitle(emptyData(), '作品')
  let data = r.data
  const ids: ID[] = []
  for (let i = 0; i < episodes; i++) {
    const e = addEpisode(data, r.result)
    data = e.data
    ids.push(e.result)
  }
  return { data, titleId: r.result, ids }
}

describe('previewEpisode', () => {
  it('次に作られる話数を返す（タイトル作成直後は第1話）', () => {
    const { data, titleId } = setup()
    expect(previewEpisode(data, titleId)?.number).toBe(1)
    const { data: d3, titleId: t3 } = setup(3)
    expect(previewEpisode(d3, t3)).toMatchObject({ number: 4, chapterId: null, description: '第4話' })
  })

  it('特殊ブロックは話数を消費しない', () => {
    const { data, titleId } = setup(2)
    const d = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    expect(previewEpisode(d, titleId)?.number).toBe(3)
  })

  it('データは変更しない', () => {
    const { data, titleId } = setup(1)
    const before = data.pieces
    previewEpisode(data, titleId)
    expect(data.pieces).toBe(before)
    expect(Object.keys(data.pieces)).toHaveLength(1)
  })

  it('章ごとモードでは章名つきの説明になり、通し番号で最新話より前の章は null', () => {
    const { data, titleId } = setup(2)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    const r = addChapter(d, titleId)
    d = addEpisode(r.data, titleId, r.result).data
    // 通し番号: 第1章は最新話（第3話・第2章）より前なので追加できない
    expect(previewEpisode(d, titleId, ch1)).toBeNull()
    expect(previewEpisode(d, titleId, r.result)?.number).toBe(4)
    d = setNumbering(d, titleId, 'perChapter')
    expect(previewEpisode(d, titleId, ch1)).toMatchObject({ number: 3, chapterId: ch1, description: '「第1章」の第3話' })
    expect(previewEpisode(d, titleId, r.result)?.description).toBe('「第2章」の第2話')
    expect(previewEpisode(d, titleId, null)?.description).toBe('タイトル直下の第1話')
  })

  it('どこに入るか（前後の話）も説明する。末尾のエピローグより前に入ることがわかる', () => {
    const { data, titleId } = setup(2)
    expect(previewEpisode(data, titleId)?.placement).toBe('「第2話」の後に入ります。')
    const d = addSpecial(data, titleId, { chapterId: null, index: 2 }, 'エピローグ').data
    expect(previewEpisode(d, titleId)?.placement).toBe('「第2話」の後（「エピローグ」の前）に入ります。')
    // 話がまだなければ、前後の説明はない
    const empty = setup()
    expect(previewEpisode(empty.data, empty.titleId)?.placement).toBeNull()
    const onlyPrologue = addSpecial(empty.data, empty.titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    expect(previewEpisode(onlyPrologue, empty.titleId)?.placement).toBe('「プロローグ」の後に入ります。')
  })

  it('前にしか何もなければ「…の後」と説明する（話がまだない時の特殊ブロックはプロローグとして扱われる）', () => {
    const empty = setup()
    let d = addSpecial(empty.data, empty.titleId, { chapterId: null, index: 0 }, 'エピローグ').data
    d = setChaptersEnabled(d, empty.titleId, true)
    // 章を解除して [エピローグ]（章管理はオン・章なし）にする
    d = removeChapter(d, d.titles[empty.titleId].structure[0].id)
    expect(previewEpisode(d, empty.titleId)?.placement).toBe('タイトル直下の「エピローグ」の後に入ります。')
  })

  it('章ありでは、章の中（またはタイトル直下）の前後で説明する', () => {
    const { data, titleId } = setup(2)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    d = addSpecial(d, titleId, { chapterId: ch1, index: 2 }, '幕間').data
    expect(previewEpisode(d, titleId, ch1)?.placement).toBe('「第1章」の中の「第2話」の後（「幕間」の前）に入ります。')
    const r = addChapter(d, titleId)
    d = r.data
    expect(previewEpisode(d, titleId, r.result)?.placement).toBe('「第2章」に入ります。')
    d = addSpecial(d, titleId, { chapterId: null, index: d.titles[titleId].structure.length }, 'エピローグ').data
    expect(previewEpisode(d, titleId, null)?.placement).toBe('タイトル直下の「第2章」の後（「エピローグ」の前）に入ります。')
  })
})

describe('defaultEpisodeTarget', () => {
  it('最新話のある章を既定にする（候補になければ最初の候補）', () => {
    const { data, titleId } = setup(1)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    const r = addChapter(d, titleId)
    d = r.data
    expect(defaultEpisodeTarget(d, titleId, episodeTargets(d, titleId))).toBe(ch1)
    d = addEpisode(d, titleId, r.result).data
    expect(defaultEpisodeTarget(d, titleId, episodeTargets(d, titleId))).toBe(r.result)
    expect(defaultEpisodeTarget(d, titleId, [])).toBeUndefined()
  })

  it('話がなければ最初の候補', () => {
    const { data, titleId } = setup()
    const d = setChaptersEnabled(data, titleId, true)
    const targets = episodeTargets(d, titleId)
    expect(defaultEpisodeTarget(d, titleId, targets)).toBe(targets[0].chapterId)
  })
})

describe('特殊追加の位置', () => {
  it('見出しから既定の位置を決める', () => {
    expect(specialPositionPreference('プロローグ')).toBe('first')
    expect(specialPositionPreference(' エピローグ ')).toBe('last')
    expect(specialPositionPreference('あとがき')).toBe('last')
    expect(specialPositionPreference('幕間')).toBeNull()
  })

  it('章の中の位置だけに絞れる', () => {
    const { data, titleId } = setup(2)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    d = addChapter(d, titleId).data
    const within = optionsWithinChapter(insertOptions(d, titleId), ch1)
    expect(within.length).toBe(3) // 先頭・第1話の後・第2話の後
    expect(within.every((o) => o.slot.chapterId === ch1)).toBe(true)
  })

  it('findSlotIndex は同じ位置の選択肢を探す', () => {
    const { data, titleId, ids } = setup(3)
    const opts = insertOptions(data, titleId, ids[1])
    const current = findSlotIndex(opts, locatePiece(data, ids[1]))
    expect(opts[current].label).toContain('第1話')
    expect(findSlotIndex(opts, null)).toBe(-1)
  })
})

describe('章の解除で振り直される話数', () => {
  it('章ごとの話数では、中の話が章の外の話として数え直される', () => {
    const { data, titleId, ids } = setup(3)
    let d = setChaptersEnabled(data, titleId, true)
    // [第1話（直下）, 第1章[第1話, 第2話]]
    d = movePiece(d, ids[0], { chapterId: null, index: 0 })
    d = setNumbering(d, titleId, 'perChapter')
    const ch1 = d.titles[titleId].structure[1].id
    const r = renumberingOnRelease(d, ch1)
    expect(r.map((x) => [x.pieceId, x.before, x.after])).toEqual([
      [ids[1], '第1話', '第2話'],
      [ids[2], '第2話', '第3話'],
    ])
    // データは変わらない
    expect(d.chapters[ch1]).toBeDefined()
  })

  it('章の後ろにある章の外の話の話数が変わる場合も含める', () => {
    const { data, titleId, ids } = setup(3)
    let d = setChaptersEnabled(data, titleId, true)
    // [第1章[第1話, 第2話], 第1話（直下）]
    d = movePiece(d, ids[2], { chapterId: null, index: 1 })
    d = setNumbering(d, titleId, 'perChapter')
    const ch1 = d.titles[titleId].structure[0].id
    expect(renumberingOnRelease(d, ch1).map((x) => [x.pieceId, x.before, x.after])).toEqual([[ids[2], '第1話', '第3話']])
  })

  it('通し番号では話数は変わらない', () => {
    const { data, titleId } = setup(3)
    const d = setChaptersEnabled(data, titleId, true)
    expect(renumberingOnRelease(d, d.titles[titleId].structure[0].id)).toEqual([])
    expect(renumberingOnRelease(d, 'none')).toEqual([])
  })

  it('説明は題を添え、多ければ「ほか n話」にまとめる', () => {
    const items = [1, 2, 3].map((n) => ({
      pieceId: `p${n}`,
      before: `第${n}話`,
      after: `第${n + 1}話`,
      subtitle: n === 1 ? '旅立ち' : '',
    }))
    expect(formatRenumbering(items)).toBe('第1話「旅立ち」→第2話、第2話→第3話、第3話→第4話')
    expect(formatRenumbering(items, 2)).toBe('第1話「旅立ち」→第2話、第2話→第3話 ほか1話')
  })
})

describe('previewMoveLabel', () => {
  it('移動後の話数を返す', () => {
    const { data, titleId, ids } = setup(3)
    const opts = insertOptions(data, titleId, ids[0])
    expect(previewMoveLabel(data, ids[0], opts[opts.length - 1].slot)).toBe('第3話')
    // データは変わらない
    expect(locatePiece(data, ids[0])).toEqual({ chapterId: null, index: 0 })
  })
})

describe('stepAvailability', () => {
  /** movePieceStep が実際に動かすかどうかと一致すること */
  function expectMatchesDomain(data: AppData, titleId: ID) {
    const avail = stepAvailability(data, titleId)
    for (const [id, a] of Object.entries(avail)) {
      expect(a.up, `up ${id}`).toBe(movePieceStep(data, id, -1) !== data)
      expect(a.down, `down ${id}`).toBe(movePieceStep(data, id, 1) !== data)
    }
  }

  it('章なし: 端は動かせない', () => {
    const { data, titleId, ids } = setup(3)
    const a = stepAvailability(data, titleId)
    expect(a[ids[0]]).toEqual({ up: false, down: true })
    expect(a[ids[2]]).toEqual({ up: true, down: false })
    expectMatchesDomain(data, titleId)
  })

  it('章あり: 章の中の話は章の外へ出られる。ドメインの movePieceStep と一致する', () => {
    const { data, titleId } = setup(2)
    let d = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    d = setChaptersEnabled(d, titleId, true)
    const r = addChapter(d, titleId)
    d = addEpisode(r.data, titleId, r.result).data
    d = addSpecial(d, titleId, { chapterId: null, index: d.titles[titleId].structure.length }, 'エピローグ').data
    expectMatchesDomain(d, titleId)
    // 章を隠した（章管理オフ）状態でも一致する
    expectMatchesDomain(setChaptersEnabled(d, titleId, false), titleId)
  })

  it('章の上下', () => {
    const { data, titleId } = setup(1)
    let d = setChaptersEnabled(data, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    const r = addChapter(d, titleId)
    d = r.data
    expect(chapterStepAvailability(d, ch1)).toEqual({ up: false, down: true })
    expect(chapterStepAvailability(d, r.result)).toEqual({ up: true, down: false })
    expect(chapterStepAvailability(d, 'none')).toEqual({ up: false, down: false })
  })
})

describe('要約と集計', () => {
  it('採用中の稿・文字数・抜粋。採用がなければ active は null', () => {
    const { data, titleId, ids } = setup(2)
    const v1 = data.pieces[ids[0]].versionIds[0]
    let d = updateVersion(data, v1, { body: '　月の光が\n差し込む。' })
    const v2 = addVersion(d, ids[0], { body: '別案です' })
    d = setActiveVersion(v2.data, ids[0], v2.result)
    expect(pieceSummary(d, d.pieces[ids[0]])).toEqual({
      versionCount: 2,
      active: { name: '第2稿', chars: 4 },
      excerpt: '別案です',
    })
    d = setActiveVersion(d, ids[1], null)
    expect(pieceSummary(d, d.pieces[ids[1]]).active).toBeNull()

    const stats = titleStats(d, titleId)
    expect(stats).toMatchObject({ pieces: 2, episodes: 2, specials: 0, missingActive: 1, chars: 4, pages: 1 })
  })

  it('採用原稿なしは話と特殊ブロックを分けて数える', () => {
    const { data, titleId, ids } = setup(2)
    const sp = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    let d = setActiveVersion(sp.data, sp.result, null)
    d = setActiveVersion(d, ids[0], null)
    expect(titleStats(d, titleId)).toMatchObject({ missingActive: 2, missingEpisodes: 1, missingSpecials: 1 })
  })

  it('章ごとの集計', () => {
    const { data, titleId, ids } = setup(2)
    let d = updateVersion(data, data.pieces[ids[1]].versionIds[0], { body: 'あいうえお' })
    d = setChaptersEnabled(d, titleId, true)
    const ch1 = d.titles[titleId].structure[0].id
    expect(chapterStats(d, ch1)).toMatchObject({ pieces: 2, episodes: 2, chars: 5 })
    expect(chapterStats(d, 'none').pieces).toBe(0)
  })

  it('抜粋は空白を詰めて切り詰める', () => {
    expect(excerptOf('　一行目\n\n二行目  です')).toBe('一行目 二行目 です')
    expect(excerptOf('あ'.repeat(100), 10)).toBe(`${'あ'.repeat(10)}…`)
  })

  it('メモの抜粋は改行を残し、空行を詰める', () => {
    expect(memoExcerpt('・一つ目\n\n  ・二つ目\r\n・三つ目\n・四つ目\n・五つ目')).toBe('・一つ目\n・二つ目\n・三つ目\n・四つ目')
    expect(memoExcerpt('')).toBe('')
  })

  it('設定項目ごとのエントリ数', () => {
    const { data, titleId } = setup()
    const cats = categoriesOf(data, titleId)
    let d = addEntry(data, cats[0].id, '主人公').data
    d = addEntry(d, cats[0].id, 'ライバル').data
    const extra = addCategory(d, titleId, '用語')
    d = extra.data
    expect(entryCounts(d, [cats[0].id, cats[1].id, extra.result])).toEqual({
      [cats[0].id]: 2,
      [cats[1].id]: 0,
      [extra.result]: 0,
    })
  })
})

describe('抜粋（本文の先頭だけを見る）', () => {
  /** 以前の実装（本文全体を詰めてから切り詰める）。結果が同じであること */
  function reference(text: string, max = 90): string {
    const flat = text.replace(/\s+/gu, ' ').trim()
    const chars = Array.from(flat)
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
  }

  it('空白の詰め方・切り詰め・サロゲートペアが以前と同じ', () => {
    const samples = [
      '',
      '   ',
      '　月の光が\n\n差し込む。　',
      'あ'.repeat(90),
      'あ'.repeat(91),
      `${'あ'.repeat(89)} い`,
      `${'あ'.repeat(90)}   `,
      `${'あ'.repeat(90)}  い`,
      '𠮷'.repeat(95),
      '\t先頭の\r\n空白　と 途中の空白',
    ]
    for (const t of samples) {
      for (const max of [1, 5, 89, 90, 91]) expect(excerptOf(t, max), JSON.stringify([t, max])).toBe(reference(t, max))
    }
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const alphabet = ['あ', 'い', ' ', '\n', '　', '\t', '𠮷', 'a']
    for (let i = 0; i < 300; i++) {
      const t = Array.from({ length: Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
      const max = 1 + Math.floor(rnd() * 20)
      expect(excerptOf(t, max), JSON.stringify([t, max])).toBe(reference(t, max))
    }
  })
})

describe('一覧の各行', () => {
  /** 章あり・特殊ブロック・章の後ろのタイトル直下の話を含む構成 */
  function complex(): { data: AppData; titleId: ID } {
    const { data, titleId } = setup(4)
    let d = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    d = setChaptersEnabled(d, titleId, true)
    const ch2 = addChapter(d, titleId, '第二部')
    d = ch2.data
    d = addEpisode(d, titleId, ch2.result).data
    d = addEpisode(d, titleId, ch2.result).data
    d = addSpecial(d, titleId, { chapterId: ch2.result, index: 1 }, '幕間').data
    d = addEpisode(d, titleId, null).data
    return { data: d, titleId }
  }

  it('削除できるかは canDeletePiece と同じ（通し番号・章ごと・章を隠した時）', () => {
    const { data, titleId } = complex()
    for (const d of [data, setNumbering(data, titleId, 'perChapter'), setChaptersEnabled(data, titleId, false)]) {
      const perms = deletePermissions(d, titleId)
      const ids = Object.keys(d.pieces).filter((id) => d.pieces[id].titleId === titleId)
      expect(Object.keys(perms).sort()).toEqual([...ids].sort())
      for (const id of ids) expect(perms[id], id).toEqual(canDeletePiece(d, id))
    }
  })

  it('行の値: 表記・採用中の稿・稿の数。編集モードの値は渡した時だけ', () => {
    const { data, titleId, ids } = setup(3)
    let d = addVersion(data, ids[0], { body: '別案' }).data
    d = setActiveVersion(d, ids[1], null)
    d = movePiece(d, ids[2], { chapterId: null, index: 0 })
    const plain = pieceRows(d, titleId)
    expect(Object.keys(plain)).toEqual([ids[2], ids[0], ids[1]])
    expect(plain[ids[2]]).toMatchObject({ label: '第1話', fullLabel: '第1話', canUp: false, canDown: false, canDelete: false })
    expect(plain[ids[0]]).toMatchObject({ label: '第2話', versionCount: 2, version: d.versions[d.pieces[ids[0]].versionIds[0]] })
    expect(plain[ids[1]].version).toBeNull()

    const editing = pieceRows(d, titleId, { steps: stepAvailability(d, titleId), deletable: deletePermissions(d, titleId) })
    expect(editing[ids[2]]).toMatchObject({ canUp: false, canDown: true, canDelete: false })
    expect(editing[ids[2]].deleteReason).toContain('途中の話数は削除できません')
    expect(editing[ids[1]]).toMatchObject({ canUp: true, canDown: false, canDelete: true, deleteReason: undefined })
  })

  it('変わっていない行は同じ内容と判定され、話数が変わった行だけが変わる', () => {
    const { data, titleId, ids } = setup(5)
    const before = pieceRows(data, titleId)
    const after = pieceRows(movePieceStep(data, ids[3], -1), titleId)
    const same = [ids[0], ids[1], ids[4]]
    expect(sameRows(rowsFor(before, same), rowsFor(after, same))).toBe(true)
    expect(sameRows(rowsFor(before, [ids[2]]), rowsFor(after, [ids[2]]))).toBe(false)
    expect(sameRows(rowsFor(before, ids), rowsFor(before, ids.slice(0, 4)))).toBe(false)
    // 見つからない話は飛ばす
    expect(rowsFor(before, ['none', ids[0]]).map((r) => r.piece.id)).toEqual([ids[0]])
  })

  it('集計は本文を数え直した結果と同じ（稿ごとのキャッシュを使う）', () => {
    const { data, titleId, ids } = setup(3)
    let d = updateVersion(data, data.pieces[ids[0]].versionIds[0], { body: 'あい う\nえお' })
    d = updateVersion(d, d.pieces[ids[1]].versionIds[0], { body: 'か'.repeat(450) })
    expect(statsOfPieces(d, ids)).toMatchObject({ pieces: 3, chars: 455, pages: 1 + 2, missingActive: 0 })
    // 本文を編集すると新しい稿のレコードになるので、数え直される
    d = updateVersion(d, d.pieces[ids[0]].versionIds[0], { body: 'あ' })
    expect(statsOfPieces(d, ids).chars).toBe(451)
    expect(titleStats(d, titleId).chars).toBe(451)
  })
})
