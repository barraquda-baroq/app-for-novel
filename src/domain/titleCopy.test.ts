// タイトルのコピー（第二稿。src/domain/titleCopy.ts）: 写すもの・写さないもの、幕に分けた話、並び、名前の候補、修復を通しても変わらないこと
import { describe, expect, it } from 'vitest'
import * as A from './acts'
import * as B from './benchOps'
import * as C from './claudeOps'
import * as E from './entityOps'
import * as F from './ideaFolderOps'
import { buildReadThrough, readBlocksText, type ReadBlock } from './readthrough'
import { repairData } from './repair'
import * as S from './storyOps'
import { actsOf, flatten, isSplit, pieceFullLabel } from './structure'
import { textHash } from './text'
import { copyTitle, copyTitleName, suggestCopyTitleName } from './titleCopy'
import { DomainError, TABLE_NAMES, TITLE_CLAUDE_TABLES, emptyData, type AppData, type ID, type TableName } from './types'
import { nextVersionNumber } from './versionNumber'
import { structureProblems } from '../test/actsScenarios'

// ---------- 用意 ----------

/** 修復を通した形（起動時と同じ。ストアのデータはこの形） */
const view = (d: AppData) => repairData(d).data

function setBody(d: AppData, pieceId: ID, body: string, note = ''): AppData {
  return S.updateVersion(d, d.pieces[pieceId].activeVersionId!, { body, note })
}

/**
 * 章ありのタイトル「海の町」と、その前後のタイトル。中身:
 * - 第1章: 第1話（第1〜3稿。第2稿を採用）・第2話（4つに分けて第3幕と第4幕をつなぎ、第2幕の採用を外した。第1幕に採用していない稿）
 * - 第2章: 幕間（特殊ブロック。採用稿あり）・第3話（稿はあるが採用なし）
 * - タイトル直下: プロローグ（先頭）・エピローグ（末尾。稿なし）
 * - 設定項目（キャラクター・世界観・アイテム）とエントリ、メモ2つ、全体戦略、相対比較する作品、ページの字数×行数
 * - 写さないもの: 応募計画（応募時の原稿の控えつき）、推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果、アイデアとフォルダ、
 *   ゴミ箱のメモ
 */
function fixture() {
  let d = emptyData()
  const before = E.createTitle(d, '前の話')
  d = before.data
  const t = E.createTitle(d, '海の町')
  d = t.data
  const titleId = t.result
  const after = E.createTitle(d, '後の話')
  d = after.data
  d = E.updateTitle(d, titleId, { synopsis: '港町の物語', strategyNote: '新人賞を狙う' })
  d = S.setChaptersEnabled(d, titleId, true)
  d = S.setNumbering(d, titleId, 'perChapter')
  const ch1 = Object.values(d.chapters).find((c) => c.titleId === titleId)!.id
  d = S.updateChapter(d, ch1, { name: '第一章　出航', note: '章のメモ' })

  // 第1章の第1話: 第1稿・第2稿（複製）・第3稿。第2稿を採用
  let r: { data: AppData; result: ID } = S.addEpisode(d, titleId, ch1)
  d = r.data
  const ep1 = r.result
  d = S.updatePiece(d, ep1, { subtitle: '朝の港' })
  d = setBody(d, ep1, '一話の初稿。', '初稿のメモ')
  r = S.duplicateVersion(d, d.pieces[ep1].activeVersionId!)
  d = r.data
  const ep1v2 = r.result
  d = S.updateVersion(d, ep1v2, { body: '一話の改稿。', note: '採用した稿のメモ' })
  r = S.addVersion(d, ep1, { body: '一話の没稿。' })
  d = r.data
  d = S.setActiveVersion(d, ep1, ep1v2)

  // 第2話: 話自身の稿を2つ（第1稿を採用）にしてから4つの幕に分け、第3幕と第4幕をつなぎ、第2幕の採用を外す
  r = S.addEpisode(d, titleId, ch1)
  d = r.data
  const ep2 = r.result
  d = S.updatePiece(d, ep2, { subtitle: '嵐' })
  const body2 = 'あいうえおかきくけこさしすせそ'
  d = setBody(d, ep2, body2)
  d = S.addVersion(d, ep2, { body: '分ける前の別の稿' }).data
  const split = A.separatePiece(d, ep2, [5, 10, 12])
  d = split.data
  const [act1, act2, act3] = split.result
  d = A.joinActWithNext(d, act3).data
  d = S.addVersion(d, act1, { body: '第1幕の別の稿' }).data
  d = S.setActiveVersion(d, act2, null)

  // 第2章: 幕間（特殊ブロック）・第3話（採用なし）
  const c2 = S.addChapter(d, titleId, '第二章')
  d = c2.data
  const ch2 = c2.result
  r = S.addSpecial(d, titleId, { chapterId: ch2, index: 0 }, '幕間')
  d = r.data
  const interlude = r.result
  d = setBody(d, interlude, '幕間の本文。')
  r = S.addEpisode(d, titleId, ch2)
  d = r.data
  const ep3 = r.result
  d = setBody(d, ep3, '三話の書きかけ。')
  d = S.setActiveVersion(d, ep3, null)

  // タイトル直下: プロローグ（先頭）・エピローグ（末尾。稿を消して稿なし）
  r = S.addSpecial(d, titleId, { chapterId: null, index: 0 }, 'プロローグ')
  d = r.data
  const prologue = r.result
  d = setBody(d, prologue, 'はじまりの本文。')
  r = S.addSpecial(d, titleId, { chapterId: null, index: d.titles[titleId].structure.length }, 'エピローグ')
  d = r.data
  const epilogue = r.result
  d = S.deleteVersion(d, d.pieces[epilogue].versionIds[0])

  // 設定項目・エントリ・メモ
  const chara = E.categoriesOf(d, titleId).find((c) => c.name === 'キャラクター')!
  r = E.addEntry(d, chara.id, '主人公')
  d = r.data
  const hero = r.result
  d = E.updateEntry(d, hero, {
    body: '船乗りの娘',
    fields: d.settingEntries[hero].fields.map((f) => (f.key === '年齢' ? { ...f, value: '17' } : f)),
  })
  r = E.addCategory(d, titleId, 'アイテム', ['由来'])
  d = r.data
  d = E.addEntry(d, r.result, '羅針盤').data
  r = E.addMemo(d, titleId, '構成メモ')
  d = r.data
  d = E.updateMemo(d, r.result, { body: '三幕構成にする' })
  d = E.addMemo(d, titleId, '取材メモ').data
  r = E.addMemo(d, titleId, '消したメモ')
  d = E.deleteMemo(r.data, r.result)

  // 全体戦略以外のタイトルの項目
  r = B.addBenchWork(d, { name: '灯台守の娘' })
  d = r.data
  const bench = r.result
  d = B.addTitleBenchWork(d, titleId, bench)
  d = E.setTitlePageSetup(d, titleId, { chars: 30, lines: 20 })

  // 写さないもの
  r = E.addSubmission(d, titleId, '海の新人賞')
  d = r.data
  d = E.recordSubmissionSnapshot(d, r.result)
  d = C.addRevisionIdea(d, titleId, { heading: '改稿案', pieceIds: [ep1] }).data
  d = C.addProofSuggestion(d, titleId, { pieceId: ep1, excerpt: '改稿' }).data
  d = C.addStrategyNote(d, titleId, { heading: '戦略メモ' }).data
  r = C.addCritiquePrompt(d, titleId, { name: '批評プロンプト' })
  d = r.data
  d = C.addCritiqueResult(d, titleId, { promptId: r.result, resultMarkdown: '批評' }).data
  r = F.createIdeaFolder(d, titleId, null, '相談')
  d = r.data
  d = E.addIdea(d, titleId, '', 'アイデア', r.result).data

  return {
    data: view(d),
    titleId,
    beforeId: before.result,
    afterId: after.result,
    ch1,
    ch2,
    ep1,
    ep1v2,
    ep2,
    acts: [act1, act2, act3],
    ep3,
    interlude,
    prologue,
    epilogue,
    bench,
  }
}

/** 章なしのタイトル（話2つと特殊ブロック1つ） */
function flatFixture() {
  const t = E.createTitle(emptyData(), '短編')
  let d = t.data
  let r = S.addEpisode(d, t.result)
  d = setBody(r.data, r.result, '一話。')
  r = S.addEpisode(d, t.result)
  d = setBody(r.data, r.result, '二話。')
  r = S.addSpecial(d, t.result, { chapterId: null, index: 2 }, 'あとがき')
  d = setBody(r.data, r.result, 'あとがきの本文。')
  return { data: view(d), titleId: t.result }
}

/** 通し読みの中身（id を除く。並び・表記・本文・稿の名前） */
function readable(d: AppData, titleId: ID) {
  return buildReadThrough(d, titleId).map((b: ReadBlock) => {
    if (b.type === 'chapter') return { type: b.type, name: b.name, note: b.note }
    if (b.type === 'chapterEnd') return { type: b.type }
    return {
      type: b.type,
      kind: b.kind,
      label: b.label,
      subtitle: b.subtitle,
      body: b.body,
      versionName: b.versionName,
      acts: b.acts?.map((a) => ({ label: a.label, body: a.body, versionName: a.versionName })) ?? null,
    }
  })
}

/** タイトルの配下のレコード（表ごと） */
function owned(d: AppData, titleId: ID) {
  const of = <T extends { titleId: ID | null }>(rows: Record<ID, T>) => Object.values(rows).filter((r) => r.titleId === titleId)
  return {
    chapters: of(d.chapters),
    pieces: of(d.pieces),
    versions: of(d.versions),
    memos: of(d.memos),
    settingCategories: of(d.settingCategories),
    settingEntries: of(d.settingEntries),
  }
}

/** レコードの中の文字列をすべて（入れ子も） */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out)
  return out
}

// ---------- テスト ----------

describe('タイトルのコピー（第二稿）', () => {
  it('元のタイトルは1つも変わらない（どの表のレコードも同じもの）。写さない表は表ごと同じ', () => {
    const f = fixture()
    const { data: after } = copyTitle(f.data, f.titleId, '海の町（第二稿）')
    for (const table of TABLE_NAMES) {
      for (const [id, rec] of Object.entries(f.data[table])) {
        // 後ろのタイトルは並び順だけずれる（下のテスト）
        if (table === 'titles' && id === f.afterId) continue
        expect(after[table][id], `${table}/${id}`).toBe(rec)
      }
    }
    const untouched: TableName[] = [
      'submissions',
      'snapshotTexts',
      ...TITLE_CLAUDE_TABLES,
      'ideas',
      'ideaFolders',
      'benchWorks',
      'benchAnalyses',
      'trashEntries',
      'trashRecords',
    ]
    for (const table of untouched) expect(after[table], table).toBe(f.data[table])
    // 用意した写さないものが、ちゃんとある（推敲案の実行の記録は手で書いた推敲案では作らない）
    for (const table of untouched.filter((t) => t !== 'proofBatches' && t !== 'benchAnalyses')) {
      expect(Object.keys(f.data[table]).length, table).toBeGreaterThan(0)
    }
    // 応募計画・Claude の記録・アイデアは写しに無い
    expect(Object.values(after.submissions).every((s) => s.titleId === f.titleId)).toBe(true)
    expect(Object.values(after.ideas).every((i) => i.titleId === f.titleId)).toBe(true)
  })

  it('タイトルの項目: あらすじ・章・話数の振り方・全体戦略・相対比較する作品・ページの字数×行数を写し、名前は渡したもの', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, '  海の町（第二稿）  ')
    const src = f.data.titles[f.titleId]
    const copy = after.titles[result]
    expect(copy.name).toBe('海の町（第二稿）')
    expect(copy.synopsis).toBe('港町の物語')
    expect(copy.strategyNote).toBe('新人賞を狙う')
    expect(copy.chaptersEnabled).toBe(true)
    expect(copy.numbering).toBe('perChapter')
    expect(copy.benchWorkIds).toEqual([f.bench])
    expect(copy.pageSetup).toEqual({ chars: 30, lines: 20 })
    expect(copy.pageSetup).not.toBe(src.pageSetup)
    expect(copy.structure.map((n) => n.type)).toEqual(src.structure.map((n) => n.type))
    expect(copy.createdAt).toBeGreaterThanOrEqual(src.createdAt)
    expect(copy.updatedAt).toBe(copy.createdAt)
    // ホームの集計も同じ
    expect(E.titleSummary(after, result)).toEqual(E.titleSummary(f.data, f.titleId))
  })

  it.each([
    ['none', 'none'],
    ['read', 'read'],
    ['write', 'write'],
    ['無い', undefined],
  ] as const)('Claude に見せるか（%s）はそのまま写す（無ければ無いまま）', (_, access) => {
    const f = flatFixture()
    const data = access ? C.setTitleClaudeAccess(f.data, f.titleId, access) : f.data
    expect('claudeAccess' in data.titles[f.titleId]).toBe(access !== undefined)
    const { data: after, result } = copyTitle(data, f.titleId, 'コピー')
    expect(after.titles[result].claudeAccess).toBe(access)
    expect('claudeAccess' in after.titles[result]).toBe(access !== undefined)
  })

  it('相対比較する作品は今ある作品だけ（ゴミ箱の作品の印は写さない。元のタイトルの印はそのまま）', () => {
    const f = fixture()
    let d = B.addBenchWork(f.data, { name: '消える作品' })
    const gone = d.result
    let data = B.addTitleBenchWork(d.data, f.titleId, gone)
    data = B.deleteBenchWork(data, gone)
    // 修復を通す前（端末内の内容）: 元のタイトルにはゴミ箱の作品の印が残っている
    expect(data.titles[f.titleId].benchWorkIds).toEqual([f.bench, gone])
    const { data: after, result } = copyTitle(data, f.titleId, 'コピー')
    expect(after.titles[result].benchWorkIds).toEqual([f.bench])
    expect(after.titles[f.titleId].benchWorkIds).toEqual([f.bench, gone])
    // 選んでいないタイトルは選んでいないまま（項目を足さない）
    const flat = flatFixture()
    d = copyTitle(flat.data, flat.titleId, 'コピー')
    expect('benchWorkIds' in d.data.titles[d.result]).toBe(false)
    expect('pageSetup' in d.data.titles[d.result]).toBe(false)
  })

  it('本編: 章・話・特殊ブロックを同じ並び・同じ項目で写し、通し読みも同じ（章ありのタイトル）', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, 'コピー')
    expect(readable(after, result)).toEqual(readable(f.data, f.titleId))
    expect(readBlocksText(buildReadThrough(after, result))).toBe(readBlocksText(buildReadThrough(f.data, f.titleId)))
    // 話の表記（第n話・題・特殊ブロックの見出し）も同じ
    const labels = (d: AppData, id: ID) => flatten(d, id).map((x) => pieceFullLabel(d, d.pieces[x.pieceId]))
    expect(labels(after, result)).toEqual(labels(f.data, f.titleId))
    // 章: 名前・メモ・中の話の並び
    const chapters = (d: AppData, id: ID) =>
      d.titles[id].structure
        .filter((n) => n.type === 'chapter')
        .map((n) => {
          const ch = d.chapters[n.id]
          return { name: ch.name, note: ch.note, pieces: ch.pieceIds.map((p) => pieceFullLabel(d, d.pieces[p])) }
        })
    expect(chapters(after, result)).toEqual(chapters(f.data, f.titleId))
    // 話・特殊ブロックの項目（id・タイトル・稿・時刻を除く）はそのまま
    const fields = (d: AppData, id: ID) =>
      flatten(d, id).map((x) => {
        const {
          id: _id,
          titleId: _t,
          activeVersionId: _a,
          versionIds: _v,
          actIds,
          createdAt: _c,
          updatedAt: _u,
          ...rest
        } = d.pieces[x.pieceId]
        return { ...rest, acts: actIds?.length ?? null }
      })
    expect(fields(after, result)).toEqual(fields(f.data, f.titleId))
  })

  it('本編: 章なしのタイトル・章をオフにしたタイトル（章の構成は残したまま）も同じに写す', () => {
    const flat = flatFixture()
    let r = copyTitle(flat.data, flat.titleId, 'コピー')
    expect(readable(r.data, r.result)).toEqual(readable(flat.data, flat.titleId))
    expect(r.data.titles[r.result].chaptersEnabled).toBe(false)
    expect(Object.values(r.data.chapters)).toHaveLength(0)

    const f = fixture()
    const off = view(S.setChaptersEnabled(f.data, f.titleId, false))
    r = copyTitle(off, f.titleId, 'コピー')
    const copy = r.data.titles[r.result]
    expect(copy.chaptersEnabled).toBe(false)
    expect(readable(r.data, r.result)).toEqual(readable(off, f.titleId))
    // オンに戻すと元と同じ章の構成で出る
    const on = (d: AppData, id: ID) => readable(S.setChaptersEnabled(d, id, true), id)
    expect(on(r.data, r.result)).toEqual(on(off, f.titleId))
  })

  it('稿: 各話・幕の採用稿だけを、名前・本文・推敲メモごと写す（採用していない稿は写さない。次の稿の番号は写した稿の続き）', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, 'コピー')
    const copyOf = (pieceId: ID) => {
      const i = flatten(f.data, f.titleId).findIndex((x) => x.pieceId === pieceId)
      return after.pieces[flatten(after, result)[i].pieceId]
    }
    const ep1 = copyOf(f.ep1)
    expect(ep1.versionIds).toHaveLength(1)
    const v = after.versions[ep1.activeVersionId!]
    expect(v).toMatchObject({ name: '第2稿（第1稿を複製）', body: '一話の改稿。', note: '採用した稿のメモ', pieceId: ep1.id })
    expect(v.titleId).toBe(result)
    // 複製元（第1稿）は写さないので null
    expect(f.data.versions[f.ep1v2].sourceVersionId).not.toBeNull()
    expect(v.sourceVersionId).toBeNull()
    expect(nextVersionNumber(after, ep1)).toBe(3)
    // 採用稿のない話は稿なし（稿はあっても写さない）
    const ep3 = copyOf(f.ep3)
    expect(f.data.pieces[f.ep3].versionIds.length).toBeGreaterThan(0)
    expect(ep3).toMatchObject({ activeVersionId: null, versionIds: [] })
    expect(copyOf(f.epilogue)).toMatchObject({ activeVersionId: null, versionIds: [], label: 'エピローグ' })
    // 写した稿の数 = 採用稿の数
    const adopted = Object.values(f.data.pieces).filter((p) => p.titleId === f.titleId && p.activeVersionId).length
    expect(Object.values(after.versions).filter((x) => x.titleId === result)).toHaveLength(adopted)
    // 採用していない稿の本文は写しに無い
    const bodies = Object.values(after.versions)
      .filter((x) => x.titleId === result)
      .map((x) => x.body)
    for (const gone of ['一話の初稿。', '一話の没稿。', '分ける前の別の稿', '第1幕の別の稿', '三話の書きかけ。'])
      expect(bodies).not.toContain(gone)
  })

  it('幕に分けた話: 各幕の採用稿と、話自身の採用稿（分けた元の稿）だけを写す。幕の形は正しく、読む順・本文は元と同じ', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, 'コピー')
    expect(structureProblems(after)).toEqual([])
    const i = flatten(f.data, f.titleId).findIndex((x) => x.pieceId === f.ep2)
    const ep2 = after.pieces[flatten(after, result)[i].pieceId]
    expect(isSplit(ep2)).toBe(true)
    const acts = actsOf(after, ep2)
    expect(acts).toHaveLength(3)
    expect(acts.every((a) => a.parentId === ep2.id && a.titleId === result && a.kind === 'act')).toBe(true)
    // 幕の作った時刻は読む順に1ずつずれる（acts.ts の newAct と同じ）
    expect(acts.map((a) => a.createdAt - acts[0].createdAt)).toEqual([0, 1, 2])
    const srcActs = actsOf(f.data, f.data.pieces[f.ep2])
    // 第1幕: 第1稿（分けた時の稿）だけ。複製元は写した話自身の採用稿で、指紋もそのまま
    const own = after.versions[ep2.activeVersionId!]
    expect(ep2.versionIds).toEqual([own.id])
    expect(own).toMatchObject({ name: '第1稿', body: 'あいうえおかきくけこさしすせそ', pieceId: ep2.id })
    const a1 = after.versions[acts[0].activeVersionId!]
    expect(acts[0].versionIds).toEqual([a1.id])
    expect(a1).toMatchObject({ name: '第1稿', body: 'あいうえお', sourceVersionId: own.id, sourceHash: textHash(own.body) })
    expect(a1.sourceHash).toBe(f.data.versions[srcActs[0].activeVersionId!].sourceHash)
    // 第2幕: 採用稿が無いので稿なし
    expect(acts[1]).toMatchObject({ activeVersionId: null, versionIds: [] })
    // 第3幕: つないだ稿。複製元（つなぐ前のこの幕の稿）は写さないので、複製元も指紋も外す
    const a3 = after.versions[acts[2].activeVersionId!]
    expect(a3).toMatchObject({ name: '第2稿（つないだ稿）', body: 'さしすせそ', sourceVersionId: null })
    expect(f.data.versions[srcActs[2].activeVersionId!].sourceHash).toBeTypeOf('string')
    expect('sourceHash' in a3).toBe(false)
    // 本文と集計は元と同じ（採用原稿なし 1幕）
    expect(E.titleSummary(after, result).missingActs).toBe(1)
  })

  it('幕に分けた話: つなぐ・セパレート解除は元と同じ条件で断り、採用稿をそろえると写しの中だけで動く（元は変わらない）', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, 'コピー')
    const i = flatten(f.data, f.titleId).findIndex((x) => x.pieceId === f.ep2)
    const ep2 = flatten(after, result)[i].pieceId
    const acts = actsOf(after, after.pieces[ep2]).map((a) => a.id)
    // 採用稿のない第2幕を含むつなぐ・解除は、元と同じ理由で断る
    expect(A.joinError(after, acts[0])).toBe(A.joinError(f.data, f.acts[0]))
    expect(A.joinError(after, acts[0])).toBe('第2幕に採用稿がないため、つなげません')
    expect(A.unseparateError(after, ep2)).toBe(A.unseparateError(f.data, f.ep2))
    expect(() => A.unseparatePiece(after, ep2)).toThrow(DomainError)

    // 写しの第2幕に稿を足して採用すると、つなぐ・解除ができる
    const added = S.addVersion(after, acts[1], { body: 'かきくけこ' })
    let d = S.setActiveVersion(added.data, acts[1], added.result)
    const joined = A.joinActWithNext(d, acts[1])
    expect(joined.data.versions[joined.result]).toMatchObject({ name: '第2稿（つないだ稿）', body: 'かきくけこさしすせそ' })
    // 写しには採用していない稿が無いので、つないでもゴミ箱へは何も入らない
    expect(joined.data.trashEntries).toBe(after.trashEntries)

    d = view(d)
    const un = A.unseparatePiece(d, ep2)
    const v = un.data.versions[un.result]
    // 番号は写した話自身の採用稿（第1稿）の続き。複製元と指紋もその稿
    expect(v).toMatchObject({
      name: '第2稿（幕をつないだ稿）',
      body: 'あいうえおかきくけこさしすせそ',
      sourceVersionId: after.pieces[ep2].activeVersionId,
      sourceHash: textHash('あいうえおかきくけこさしすせそ'),
    })
    expect(un.data.trashEntries).toBe(d.trashEntries)
    expect(un.data.pieces[ep2].actIds).toEqual([])
    // 元のタイトルの話・幕・稿はそのまま
    for (const id of [f.ep2, ...f.acts.filter((a) => f.data.pieces[a])]) expect(un.data.pieces[id]).toBe(f.data.pieces[id])
    expect(readable(un.data, f.titleId)).toEqual(readable(f.data, f.titleId))
  })

  it('設定項目とエントリ（項目の値・本文・並び）、メモ（名前・本文・並び）を写す。ゴミ箱のメモは写さない', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, 'コピー')
    const settings = (d: AppData, id: ID) =>
      E.categoriesOf(d, id).map((c) => ({
        name: c.name,
        fieldTemplate: c.fieldTemplate,
        order: c.order,
        entries: E.entriesOf(d, c.id).map((e) => ({
          name: e.name,
          body: e.body,
          order: e.order,
          fields: e.fields.map((x) => ({ key: x.key, value: x.value })),
        })),
      }))
    expect(settings(after, result)).toEqual(settings(f.data, f.titleId))
    expect(settings(after, result).map((c) => c.name)).toEqual(['キャラクター', '世界観', 'アイテム'])
    for (const c of E.categoriesOf(after, result)) {
      for (const e of E.entriesOf(after, c.id)) expect(e).toMatchObject({ titleId: result, categoryId: c.id })
    }
    const memos = (d: AppData, id: ID) => E.memosOf(d, id).map((m) => ({ name: m.name, body: m.body, order: m.order }))
    expect(memos(after, result)).toEqual(memos(f.data, f.titleId))
    expect(memos(after, result).map((m) => m.name)).toEqual(['構成メモ', '取材メモ'])
  })

  it('id はすべて新しく、写しのレコードは元のタイトルの配下を1つも指さない', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, 'コピー')
    const src = owned(f.data, f.titleId)
    // 元のタイトルの配下の id（採用していない稿・設定エントリの項目の id も）
    const originalIds = new Set<string>([
      f.titleId,
      ...Object.values(src).flatMap((rows) => rows.map((r) => r.id)),
      ...src.settingEntries.flatMap((e) => e.fields.map((x) => x.id)),
    ])
    const copy = owned(after, result)
    const { benchWorkIds: _bench, ...title } = after.titles[result]
    const strings = stringsIn([title, copy])
    expect(strings.filter((s) => originalIds.has(s))).toEqual([])
    // 新しい id は、コピーの前のデータのどの表にも無い
    const all = new Set(TABLE_NAMES.flatMap((t) => Object.keys(f.data[t])))
    const fresh = [
      result,
      ...Object.values(copy).flatMap((rows) => rows.map((r) => r.id)),
      ...copy.settingEntries.flatMap((e) => e.fields.map((x) => x.id)),
    ]
    expect(fresh.filter((id) => all.has(id) || originalIds.has(id))).toEqual([])
    expect(new Set(fresh).size).toBe(fresh.length)
    // 写しの中の参照は写しの中を指す
    const ids = new Set(fresh)
    for (const n of after.titles[result].structure) expect(ids.has(n.id)).toBe(true)
    for (const c of copy.chapters) for (const p of c.pieceIds) expect(ids.has(p)).toBe(true)
    for (const p of copy.pieces) {
      for (const x of [p.activeVersionId, ...p.versionIds, ...(p.actIds ?? []), p.parentId]) {
        if (x) expect(ids.has(x)).toBe(true)
      }
    }
    for (const v of copy.versions) {
      expect(ids.has(v.pieceId)).toBe(true)
      if (v.sourceVersionId) expect(ids.has(v.sourceVersionId)).toBe(true)
    }
  })

  it('作った時刻・更新した時刻は今（元の時刻を写さない）', () => {
    const f = fixture()
    const old = 1_000_000
    const aged: AppData = { ...f.data }
    for (const table of ['titles', 'chapters', 'pieces', 'versions', 'memos', 'settingCategories', 'settingEntries'] as const) {
      aged[table] = Object.fromEntries(
        Object.entries(f.data[table]).map(([id, r]) => [id, { ...r, createdAt: old, updatedAt: old }]),
      ) as never
    }
    const startedAt = Date.now()
    const { data: after, result } = copyTitle(aged, f.titleId, 'コピー')
    const copy = owned(after, result)
    for (const r of [after.titles[result], ...Object.values(copy).flat()]) {
      expect(r.createdAt).toBeGreaterThanOrEqual(startedAt)
      expect(r.updatedAt).toBeGreaterThanOrEqual(startedAt)
    }
  })

  it('修復を通しても変わらない（写しの形は修復が直す所が無い）', () => {
    const f = fixture()
    expect(repairData(f.data).fixes).toEqual([])
    const { data: after } = copyTitle(f.data, f.titleId, 'コピー')
    const repaired = repairData(after)
    expect(repaired.fixes).toEqual([])
    expect(repaired.data).toBe(after)
    // 章をオフにした・幕を解除した（幕の並びが空の）タイトルも
    let d = view(S.setChaptersEnabled(f.data, f.titleId, false))
    const ep = Object.values(d.pieces).find((p) => p.titleId === f.titleId && isSplit(p))!
    const withAdopted = S.addVersion(d, f.acts[1], { body: 'かきくけこ' })
    d = view(A.unseparatePiece(S.setActiveVersion(withAdopted.data, f.acts[1], withAdopted.result), ep.id).data)
    expect(d.pieces[ep.id].actIds).toEqual([])
    const again = copyTitle(d, f.titleId, 'コピー')
    expect(repairData(again.data).fixes).toEqual([])
    const unsplit = Object.values(again.data.pieces).find(
      (p) => p.titleId === again.result && p.kind === 'episode' && Array.isArray(p.actIds),
    )!
    expect(unsplit.actIds).toEqual([])
  })

  it('並び: 写しは元のすぐ後ろ。後ろのタイトルだけ並び順をずらし、元と前のタイトルは書き換えない', () => {
    const f = fixture()
    const { data: after, result } = copyTitle(f.data, f.titleId, '海の町（第二稿）')
    expect(E.sortedTitles(after).map((t) => t.name)).toEqual(['前の話', '海の町', '海の町（第二稿）', '後の話'])
    expect(after.titles[f.beforeId]).toBe(f.data.titles[f.beforeId])
    expect(after.titles[f.titleId]).toBe(f.data.titles[f.titleId])
    expect(after.titles[f.afterId].order).toBe(f.data.titles[f.afterId].order + 1)
    // アイデアの仕切りも同じ順（写しの仕切りは空）
    expect(E.ideaSections(after).map((s) => [s.name, s.ideas.length])).toEqual([
      ['前の話', 0],
      ['海の町', 1],
      ['海の町（第二稿）', 0],
      ['後の話', 0],
      ['どのタイトルにも属さない', 0],
    ])
    // 写しの写しは写しのすぐ後ろ
    const again = copyTitle(after, result, '海の町（第三稿）')
    expect(E.sortedTitles(again.data).map((t) => t.name)).toEqual([
      '前の話',
      '海の町',
      '海の町（第二稿）',
      '海の町（第三稿）',
      '後の話',
    ])
    // 最後のタイトルの写しは末尾（ほかは書き換えない）
    const last = copyTitle(f.data, f.afterId, '後の話（第二稿）')
    expect(E.sortedTitles(last.data).map((t) => t.name)).toEqual(['前の話', '海の町', '後の話', '後の話（第二稿）'])
    for (const id of [f.beforeId, f.titleId, f.afterId]) expect(last.data.titles[id]).toBe(f.data.titles[id])
  })

  it('並び: 間の空いた並び順は、空いている所に入れて後ろを書き換えない。同じ並び順のタイトルは順を保ってずらす', () => {
    let d = emptyData()
    const names = ['一', '二', '三', '四']
    const ids = names.map((name) => {
      const r = E.createTitle(d, name)
      d = r.data
      return r.result
    })
    // 一=0・二=5・三=5（id の順で二と三の順が決まる）・四=6
    const [x, y] = [ids[1], ids[2]].sort()
    d = { ...d, titles: { ...d.titles } }
    d.titles[ids[0]] = { ...d.titles[ids[0]], order: 0, name: '一' }
    d.titles[x] = { ...d.titles[x], order: 5, name: '二' }
    d.titles[y] = { ...d.titles[y], order: 5, name: '三' }
    d.titles[ids[3]] = { ...d.titles[ids[3]], order: 6, name: '四' }
    const gap = copyTitle(d, ids[0], '一のコピー')
    expect(E.sortedTitles(gap.data).map((t) => t.name)).toEqual(['一', '一のコピー', '二', '三', '四'])
    for (const id of ids) expect(gap.data.titles[id]).toBe(d.titles[id])
    // 二（5）の写し（6）: 三（5）・四（6）は 7・8 へ
    const tie = copyTitle(d, x, '二のコピー')
    expect(E.sortedTitles(tie.data).map((t) => [t.name, t.order])).toEqual([
      ['一', 0],
      ['二', 5],
      ['二のコピー', 6],
      ['三', 7],
      ['四', 8],
    ])
  })

  it('名前が空・タイトルが無い時は断る（何も書き換えない）', () => {
    const f = flatFixture()
    expect(() => copyTitle(f.data, f.titleId, '　 ')).toThrow('新しいタイトルの名前を入れてください')
    expect(() => copyTitle(f.data, 'none', 'コピー')).toThrow('タイトルが見つかりません')
  })
})

describe('コピーで作るタイトルの名前の候補', () => {
  it.each([
    ['海の町', '海の町（第二稿）'],
    ['海の町（第二稿）', '海の町（第三稿）'],
    ['海の町（第一稿）', '海の町（第二稿）'],
    ['海の町（第九稿）', '海の町（第十稿）'],
    ['海の町（第十九稿）', '海の町（第二十稿）'],
    ['海の町（第百九十九稿）', '海の町（第二百稿）'],
    ['海の町（第一〇稿）', '海の町（第十一稿）'],
    ['海の町（第3稿）', '海の町（第4稿）'],
    ['海の町（第9稿）', '海の町（第10稿）'],
    ['海の町（第３稿）', '海の町（第４稿）'],
    ['海の町（第９稿）', '海の町（第１０稿）'],
    ['海の町(第2稿)', '海の町(第3稿)'],
    ['  海の町（第二稿）  ', '海の町（第三稿）'],
    ['', '無題のタイトル（第二稿）'],
    ['第二稿の海', '第二稿の海（第二稿）'],
    ['海の町（第二稿）続', '海の町（第二稿）続（第二稿）'],
    ['海の町（第十百稿）', '海の町（第十百稿）（第二稿）'],
  ])('「%s」→「%s」', (name, expected) => {
    expect(copyTitleName(name)).toBe(expected)
  })

  it('候補の名前のタイトルがもうあれば、空くまで番号を進める（同じ元を2回・3回コピーした時に同じ名前を出さない）', () => {
    expect(suggestCopyTitleName('海の町', ['海の町', '後の話'])).toBe('海の町（第二稿）')
    expect(suggestCopyTitleName('海の町', ['海の町', '海の町（第二稿）'])).toBe('海の町（第三稿）')
    expect(suggestCopyTitleName('海の町', ['海の町', '海の町（第三稿）', '海の町（第二稿）'])).toBe('海の町（第四稿）')
    // 空いている番号の次からは進めない（第二稿が空いていれば第二稿）
    expect(suggestCopyTitleName('海の町', ['海の町', '海の町（第三稿）'])).toBe('海の町（第二稿）')
    // 番号付きの元・半角の数字・前後の空白
    expect(suggestCopyTitleName('海の町（第二稿）', ['海の町（第二稿）', '海の町（第三稿）'])).toBe('海の町（第四稿）')
    expect(suggestCopyTitleName('海の町（第3稿）', ['海の町（第3稿）', ' 海の町（第4稿） '])).toBe('海の町（第5稿）')
    // 書き方の違う名前（漢数字と半角の数字）は別の名前
    expect(suggestCopyTitleName('海の町', ['海の町', '海の町（第2稿）'])).toBe('海の町（第二稿）')
    // 番号を読めない長さの名前でも止まり、今あるタイトルの名前は出さない
    const huge = `海の町（第${Number.MAX_SAFE_INTEGER}稿）`
    const taken = [huge, `${huge}（第二稿）`, `${huge}（第三稿）`]
    expect(suggestCopyTitleName(huge, taken)).toBe(`${huge}（第四稿）`)
  })
})
