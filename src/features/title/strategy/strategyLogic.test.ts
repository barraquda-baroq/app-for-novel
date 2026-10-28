import { describe, expect, it } from 'vitest'
import {
  addSubmission,
  compareSnapshotWithCurrent,
  createTitle,
  recordSubmissionSnapshot,
  snapshotCounts,
  takeSnapshot,
  updateSubmission,
} from '../../../domain/entityOps'
import { bodyMetrics } from '../../../domain/text'
import {
  addEpisode,
  addSpecial,
  addVersion,
  deletePiece,
  setActiveVersion,
  updatePiece,
  updateVersion,
} from '../../../domain/storyOps'
import { emptyData, type AppData, type Submission, type SubmissionSnapshot, type SubmissionStatus } from '../../../domain/types'
import {
  compareSnapshots,
  currentManuscript,
  daysUntil,
  deadlineInfo,
  followUpLines,
  formatYmd,
  isHttpUrl,
  limitBadgeText,
  limitBasis,
  limitCheck,
  limitRange,
  limitTense,
  limitUnitOf,
  manuscriptDeps,
  manuscriptSummary,
  parseLimit,
  pieceCountLabel,
  resultInfo,
  snapshotChangeSummary,
  snapshotPages,
  snapshotView,
  sortByDeadline,
  statusPhase,
  statusTone,
  toYmd,
} from './strategyLogic'

const today = new Date(2026, 9, 27, 15, 30) // 2026/10/27（ローカル時刻）

/** 本文の控えがない時の数え直し（記録した数のまま） */
const NO_TEXTS = { snapshotTexts: {} }
const recount = (snap: SubmissionSnapshot | null) => (snap ? snapshotCounts(NO_TEXTS, snap) : null)

/** 画面と同じく、記録を数え直した数と合わせて並べる */
function viewOf(data: AppData, titleId: string, snap: SubmissionSnapshot) {
  return snapshotView(snap, currentManuscript(data, titleId), snapshotCounts(data, snap))
}

describe('締切', () => {
  it('ローカルの日付で日数を数える', () => {
    expect(daysUntil('2026-10-27', today)).toBe(0)
    expect(daysUntil('2026-10-28', today)).toBe(1)
    expect(daysUntil('2026-12-31', today)).toBe(65)
    expect(daysUntil('2026-10-20', today)).toBe(-7)
    expect(daysUntil('2027-10-27', today)).toBe(365)
    expect(daysUntil('', today)).toBeNull()
    expect(daysUntil('2026-02-30', today)).toBeNull()
    expect(daysUntil('2026/12/31', today)).toBeNull()
  })

  it('表示用の文言と注意の度合い', () => {
    expect(deadlineInfo({ deadline: '2026-12-31', status: 'planned' }, today)).toEqual({
      text: '締切 2026/12/31（あと65日）',
      tone: 'muted',
      days: 65,
    })
    expect(deadlineInfo({ deadline: '2026-11-05', status: 'considering' }, today)?.tone).toBe('warn')
    expect(deadlineInfo({ deadline: '2026-10-27', status: 'planned' }, today)?.text).toBe('締切 2026/10/27（今日まで）')
    expect(deadlineInfo({ deadline: '2026-10-01', status: 'planned' }, today)).toMatchObject({
      text: '締切を過ぎています（2026/10/01）',
      tone: 'danger',
    })
    // 応募済みなら締切を過ぎていても注意しない
    expect(deadlineInfo({ deadline: '2026-10-01', status: 'submitted' }, today)?.tone).toBe('muted')
    expect(deadlineInfo({ deadline: '', status: 'planned' }, today)).toBeNull()
    expect(formatYmd('2026-01-05')).toBe('2026/01/05')
    expect(formatYmd('不明')).toBe('')
    expect(toYmd(today)).toBe('2026-10-27')
  })

  it('結果発表までの日数', () => {
    expect(resultInfo('2026-11-08', today)).toEqual({ text: '結果発表まであと12日（2026/11/08）', tone: 'muted', days: 12 })
    expect(resultInfo('2026-10-27', today)?.text).toBe('結果発表は今日（2026/10/27）')
    expect(resultInfo('2026-10-01', today)).toMatchObject({ text: '結果発表日を過ぎています（2026/10/01）', tone: 'warn' })
    expect(resultInfo('', today)).toBeNull()
  })
})

describe('規定（文字数・原稿用紙換算枚数）', () => {
  it('不足・超過・規定内', () => {
    expect(limitCheck(78_800, 80_000, 120_000)).toEqual({ state: 'short', diff: 1_200, text: 'あと1,200字必要' })
    expect(limitCheck(121_200, 80_000, 120_000)).toEqual({ state: 'over', diff: 1_200, text: '1,200字超過' })
    expect(limitCheck(80_000, 80_000, 120_000)?.text).toBe('規定内')
    expect(limitCheck(120_000, null, 120_000)?.text).toBe('規定内')
    expect(limitCheck(0, 1, null)?.text).toBe('あと1字必要')
    expect(limitCheck(5_000, null, null)).toBeNull()
    // 原稿用紙換算の枚数
    expect(limitCheck(68, 80, 130, 'pages')).toEqual({ state: 'short', diff: 12, text: 'あと12枚必要' })
    expect(limitCheck(131, 80, 130, 'pages')?.text).toBe('1枚超過')
  })

  it('応募した後は、応募した時の事実として言う（「あと…必要」は応募前だけ）', () => {
    expect(limitTense('considering')).toBe('before')
    expect(limitTense('planned')).toBe('before')
    for (const st of ['submitted', 'reviewing', 'passed', 'won', 'rejected', 'withdrawn'] as const) {
      expect(limitTense(st)).toBe('after')
    }
    const short = limitCheck(55_131, 100_000, null, 'chars', 'after')!
    expect(short).toEqual({ state: 'short', diff: 44_869, text: '規定に44,869字不足' })
    expect(limitBadgeText(short, 'snapshot')).toBe('応募時 規定に44,869字不足')
    expect(limitCheck(131, 80, 130, 'pages', 'after')?.text).toBe('規定を1枚超過')
    const ok = limitCheck(90_000, 80_000, 120_000, 'chars', 'after')!
    expect(limitBadgeText(ok, 'snapshot')).toBe('応募時 規定内')
    // 現在の採用原稿と比べた時は「応募時」を付けない
    expect(limitBadgeText(limitCheck(78_800, 80_000, null)!, 'current')).toBe('あと1,200字必要')
  })

  it('範囲の表記', () => {
    expect(limitRange(80_000, 120_000)).toBe('80,000〜120,000字')
    expect(limitRange(80_000, null)).toBe('80,000字以上')
    expect(limitRange(null, 120_000)).toBe('120,000字以内')
    expect(limitRange(null, null)).toBe('')
    expect(limitRange(80, 130, 'pages')).toBe('80〜130枚')
    expect(limitRange(null, 300, 'pages')).toBe('300枚以内')
  })

  it('入力欄の値を安全に数値にする（空欄は null、読めなければ undefined）', () => {
    expect(parseLimit('')).toBeNull()
    expect(parseLimit('   ')).toBeNull()
    expect(parseLimit('100000')).toBe(100_000)
    expect(parseLimit('100,000')).toBe(100_000)
    expect(parseLimit('１２万')).toBe(120_000)
    expect(parseLimit('1.5万字')).toBe(15_000)
    expect(parseLimit('８０，０００文字')).toBe(80_000)
    expect(parseLimit('250枚')).toBe(250)
    expect(parseLimit('たくさん')).toBeUndefined()
    expect(parseLimit('-100')).toBeUndefined()
    expect(parseLimit('1e5')).toBeUndefined()
  })

  it('単位は未設定なら文字数。応募前は現在の原稿、応募後は応募時の原稿と比べる', () => {
    expect(limitUnitOf({})).toBe('chars')
    expect(limitUnitOf({ limitUnit: 'pages' })).toBe('pages')
    const current = { chars: 2_000, pages: 5 }
    const snapshot = { at: 0, charCount: 1_500, activeVersions: {}, pages: 4 }
    const rec = recount(snapshot)
    expect(limitBasis({ status: 'planned', snapshot, limitUnit: 'chars' }, current, rec)).toEqual({
      source: 'current',
      amount: 2_000,
    })
    expect(limitBasis({ status: 'considering', snapshot: null, limitUnit: 'pages' }, current, null)).toEqual({
      source: 'current',
      amount: 5,
    })
    expect(limitBasis({ status: 'submitted', snapshot, limitUnit: 'chars' }, current, rec)).toEqual({
      source: 'snapshot',
      amount: 1_500,
    })
    expect(limitBasis({ status: 'reviewing', snapshot, limitUnit: 'pages' }, current, rec)).toEqual({
      source: 'snapshot',
      amount: 4,
    })
    expect(limitBasis({ status: 'won', snapshot, limitUnit: undefined }, current, rec)).toEqual({
      source: 'snapshot',
      amount: 1_500,
    })
    // 応募後で記録がなければ比べない
    expect(limitBasis({ status: 'submitted', snapshot: null }, current, null)).toBeNull()
    // 古い記録（枚数なし・本文の控えなし）は枚数で比べられない
    const old = { at: 0, charCount: 10, activeVersions: {} }
    expect(limitBasis({ status: 'submitted', snapshot: old, limitUnit: 'pages' }, current, recount(old))).toBeNull()
  })

  it('応募時の原稿の枚数（古い記録は本文の控えから数える）', () => {
    expect(snapshotPages({ at: 0, charCount: 0, activeVersions: {}, pages: 7 }, NO_TEXTS)).toBe(7)
    expect(snapshotPages({ at: 0, charCount: 0, activeVersions: {} }, NO_TEXTS)).toBeNull()
    const piece = {
      kind: 'episode' as const,
      label: '第1話',
      subtitle: '',
      versionId: 'v',
      versionName: '第1稿',
      chars: 0,
      textKey: null,
      hash: '',
    }
    expect(
      snapshotPages(
        {
          at: 0,
          charCount: 0,
          activeVersions: {},
          pieces: { a: { ...piece, body: 'あ'.repeat(401) }, b: { ...piece, body: null } },
        },
        NO_TEXTS,
      ),
    ).toBe(2)
  })
})

describe('状態', () => {
  it('グループごとの色', () => {
    expect(statusTone('considering')).toBe('neutral')
    expect(statusTone('planned')).toBe('neutral')
    expect(statusTone('submitted')).toBe('accent')
    expect(statusTone('reviewing')).toBe('accent')
    expect(statusTone('passed')).toBe('active')
    expect(statusTone('won')).toBe('active')
    expect(statusTone('rejected')).toBe('danger')
    expect(statusTone('withdrawn')).toBe('faint')
  })

  it('応募前・結果待ち・終了の区分', () => {
    expect(statusPhase('considering')).toBe('before')
    expect(statusPhase('planned')).toBe('before')
    expect(statusPhase('submitted')).toBe('waiting')
    expect(statusPhase('reviewing')).toBe('waiting')
    for (const st of ['passed', 'won', 'rejected', 'withdrawn'] as const) expect(statusPhase(st)).toBe('finished')
  })

  it('結果・講評／改稿方針／再応募方針の1行の抜粋', () => {
    expect(followUpLines({ result: '一次落選。\n  中盤が遅い', revisionPlan: '', resubmissionPlan: 'あ'.repeat(90) })).toEqual([
      { field: 'result', label: '結果・講評', text: '一次落選。 中盤が遅い' },
      { field: 'revisionPlan', label: '改稿方針', text: '' },
      { field: 'resubmissionPlan', label: '再応募方針', text: 'あ'.repeat(80) + '…' },
    ])
  })
})

function sub(id: string, order: number, deadline: string, status: SubmissionStatus = 'planned', resultOn = ''): Submission {
  return { id, order, deadline, status, resultOn } as Submission
}

describe('締切順', () => {
  it('応募前は締切の早い順、未設定はその後。元の配列は変えない', () => {
    const list = [
      sub('a', 0, ''),
      sub('b', 1, '2026-12-01'),
      sub('c', 2, '2026-11-01'),
      sub('d', 3, '2026-12-01'),
      sub('e', 4, ''),
    ]
    expect(sortByDeadline(list, today).map((s) => s.id)).toEqual(['c', 'b', 'd', 'a', 'e'])
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('応募前の締切が近いもの → 応募済み・選考中 → 終了・締切を過ぎたもの', () => {
    const list = [
      sub('won', 0, '2026-01-10', 'won'),
      sub('reviewing', 1, '2026-09-01', 'reviewing', '2026-12-20'),
      sub('past', 2, '2026-10-01', 'planned'),
      sub('soon', 3, '2026-11-30', 'considering'),
      sub('submitted', 4, '2026-10-20', 'submitted', '2026-11-15'),
      sub('later', 5, '2027-03-01', 'planned'),
      sub('undated', 6, '', 'planned'),
      sub('rejected', 7, '2025-12-01', 'rejected'),
      sub('today', 8, '2026-10-27', 'planned'),
    ]
    expect(sortByDeadline(list, today).map((s) => s.id)).toEqual([
      'today',
      'soon',
      'later',
      'undated',
      'submitted',
      'reviewing',
      'rejected',
      'won',
      'past',
    ])
  })
})

describe('URL', () => {
  it('http(s) だけを開けるリンクにする', () => {
    expect(isHttpUrl('https://example.com/a?b=1')).toBe(true)
    expect(isHttpUrl(' http://example.com ')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('example.com')).toBe(false)
    expect(isHttpUrl('https://')).toBe(false)
  })
})

function setup(): { data: AppData; titleId: string; pieces: string[] } {
  let data = emptyData()
  const t = createTitle(data, '作品')
  data = t.data
  const pieces: string[] = []
  for (const body of ['あいうえお', 'かきく\nけこ', 'さしす']) {
    const r = addEpisode(data, t.result)
    data = r.data
    data = updateVersion(data, data.pieces[r.result].versionIds[0], { body })
    pieces.push(r.result)
  }
  return { data, titleId: t.result, pieces }
}

describe('現在の原稿', () => {
  it('採用原稿だけを数え、採用原稿がない話と特殊ブロックを分けて数える', () => {
    const s = setup()
    let data = setActiveVersion(s.data, s.pieces[2], null)
    data = addSpecial(data, s.titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    const epi = addSpecial(data, s.titleId, { chapterId: null, index: 4 }, 'エピローグ')
    data = setActiveVersion(epi.data, epi.result, null)
    // プロローグは採用中の稿が空（0字・0枚）、第3話とエピローグは採用原稿なし
    expect(manuscriptSummary(data, s.titleId)).toEqual({
      chars: 10,
      pages: 2,
      episodes: 3,
      specials: 2,
      missingActive: 2,
      missingEpisodes: 1,
      missingSpecials: 1,
    })
  })

  it('ルビ・傍点の記号とルビの読みは、現在の原稿・応募時の記録の文字数・枚数に数えない', () => {
    const s = setup()
    const v = s.data.pieces[s.pieces[0]].versionIds[0]
    // 第1話: 魔法使い・が・来た = 7字（ルビの読みを数えると 20字を超える）
    let data = updateVersion(s.data, v, { body: '｜魔法使い《ウィザード》が《《来た》》' })
    expect(manuscriptSummary(data, s.titleId).chars).toBe(7 + 5 + 3)
    const sub = addSubmission(data, s.titleId, '賞')
    data = recordSubmissionSnapshot(sub.data, sub.result)
    const snap = data.submissions[sub.result].snapshot!
    expect(snap.charCount).toBe(15)
    expect(snap.pieces![s.pieces[0]].chars).toBe(7)
    expect(viewOf(data, s.titleId, snap).rows[0].chars).toBe(7)
    // 古い記録（本文が記録の中にある）の枚数も、記号と読みを除いて数える: 400字の段落なら1枚（読みを数えると2枚）
    expect(
      snapshotPages(
        {
          at: 0,
          charCount: 0,
          activeVersions: {},
          pieces: {
            a: {
              kind: 'episode',
              label: '第1話',
              subtitle: '',
              versionId: 'v',
              versionName: '第1稿',
              chars: 0,
              textKey: null,
              hash: '',
              body: `${'あ'.repeat(19)}漢《${'よみ'.repeat(30)}》${'い'.repeat(380)}`,
            },
          },
        },
        NO_TEXTS,
      ),
    ).toBe(1)
  })

  it('2.0 までの数え方（ルビの記号と読みも数えた）の記録は、本文の控えから数え直して表示・規定の判定・差に使う', () => {
    const s = setup()
    const body = `｜魔法使い《ウィザード》が来た。\n${'あ'.repeat(19)}漢《${'よみ'.repeat(30)}》${'い'.repeat(380)}`
    let data = updateVersion(s.data, s.data.pieces[s.pieces[0]].versionIds[0], { body })
    const sub = addSubmission(data, s.titleId, '賞')
    data = recordSubmissionSnapshot(sub.data, sub.result)
    const fresh = data.submissions[sub.result].snapshot!
    // 2.0 までの端末で記録した時の数（記号とルビの読みも数えていた）に置き換える
    const oldChars = Array.from(body.replace(/\s/g, '')).length
    const first = fresh.pieces![s.pieces[0]]
    const old: SubmissionSnapshot = {
      ...fresh,
      charCount: fresh.charCount - first.chars + oldChars,
      pages: 99,
      pieces: { ...fresh.pieces, [s.pieces[0]]: { ...first, chars: oldChars } },
    }
    data = updateSubmission(data, sub.result, { snapshot: old, status: 'submitted', minChars: null, maxChars: 420 })
    const snap = data.submissions[sub.result].snapshot!
    expect(snap.charCount).toBeGreaterThan(fresh.charCount)

    // 数え直した数は、本文の控えを今の数え方で数えた数と同じ（記録そのものは書き換えない）
    const texts = Object.values(snap.pieces!).map((p) => data.snapshotTexts[p.textKey!])
    const expected = texts.reduce((n, t) => n + bodyMetrics(t).chars, 0)
    const expectedPages = texts.reduce((n, t) => n + bodyMetrics(t).manuscriptPages, 0)
    const counts = snapshotCounts(data, snap)
    expect(counts.charCount).toBe(expected)
    expect(counts.charCount).toBe(fresh.charCount)
    expect(counts.pages).toBe(expectedPages)
    expect(counts.chars[s.pieces[0]]).toBe(bodyMetrics(data.snapshotTexts[first.textKey!]).chars)
    expect(data.submissions[sub.result].snapshot!.charCount).toBe(old.charCount)

    // 内訳の文字数・規定の判定・今の原稿との差
    const view = viewOf(data, s.titleId, snap)
    expect(view.rows.map((r) => r.chars)).toEqual(Object.values(counts.chars))
    expect(view.rows[0].chars).toBe(fresh.pieces![s.pieces[0]].chars)
    const current = manuscriptSummary(data, s.titleId)
    const basis = limitBasis(data.submissions[sub.result], current, counts)
    expect(basis).toEqual({ source: 'snapshot', amount: expected })
    // 記録した数（記号と読みを含む）では「規定を超過」になる原稿も、数え直すと規定内
    expect(limitCheck(basis!.amount, null, 420, 'chars', 'after')?.state).toBe('ok')
    expect(limitCheck(snap.charCount, null, 420, 'chars', 'after')?.state).toBe('over')
    expect(limitBasis({ ...data.submissions[sub.result], limitUnit: 'pages' }, current, counts)).toEqual({
      source: 'snapshot',
      amount: expectedPages,
    })
    expect(view.diff.charDelta).toBe(0)
    expect(compareSnapshotWithCurrent(data, s.titleId, snap).charDelta).toBe(0)
    // 記録の後に1字足すと、差は +1字（記録した数のままだと記号と読みの分だけずれる）
    data = updateVersion(data, data.pieces[s.pieces[1]].activeVersionId!, { body: 'かきくけこさ' })
    expect(viewOf(data, s.titleId, snap).diff.charDelta).toBe(1)
    expect(compareSnapshotWithCurrent(data, s.titleId, snap).charDelta).toBe(1)
  })

  it('本文の控えが欠けている話（まだ届いていない等）は記録した数を使い、枚数は記録した枚数', () => {
    const s = setup()
    const sub = addSubmission(s.data, s.titleId, '賞')
    const data = recordSubmissionSnapshot(sub.data, sub.result)
    const snap = data.submissions[sub.result].snapshot!
    const id = s.pieces[1]
    const missing: SubmissionSnapshot = {
      ...snap,
      pages: 7,
      pieces: { ...snap.pieces, [id]: { ...snap.pieces![id], textKey: null, chars: 50 } },
    }
    const counts = snapshotCounts(data, missing)
    expect(counts.chars[id]).toBe(50)
    expect(counts.charCount).toBe(snap.charCount - snap.pieces![id].chars + 50)
    expect(counts.pages).toBe(7)
  })

  it('話数の表記は特殊ブロックを話に数えない', () => {
    expect(pieceCountLabel(3, 0)).toBe('3話')
    expect(pieceCountLabel(3, 1)).toBe('3話＋特殊1')
    expect(pieceCountLabel(0, 2)).toBe('特殊2')
    expect(pieceCountLabel(0, 0)).toBe('0話')
  })
})

describe('応募時スナップショットとの比較', () => {
  it('記録した話を記録順に並べ、稿の切り替え・本文の編集・追加・削除を印す', () => {
    const { titleId, pieces, ...rest } = setup()
    let data = updatePiece(rest.data, pieces[0], { subtitle: '朝' })
    const sp = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ')
    data = updateVersion(sp.data, sp.data.pieces[sp.result].versionIds[0], { body: 'はじまり' })
    const s = addSubmission(data, titleId, '賞')
    data = recordSubmissionSnapshot(s.data, s.result)
    const snap = data.submissions[s.result].snapshot!

    const first = viewOf(data, titleId, snap)
    expect(first.detailed).toBe(true)
    expect([first.episodes, first.specials]).toEqual([3, 1])
    expect(first.rows.map((r) => [r.label, r.subtitle, r.versionName, r.chars, r.change])).toEqual([
      ['プロローグ', '', '第1稿', 4, null],
      ['第1話', '朝', '第1稿', 5, null],
      ['第2話', '', '第1稿', 5, null],
      ['第3話', '', '第1稿', 3, null],
    ])
    expect(snapshotChangeSummary(first.diff)).toBe('')

    // 稿の名前を変えただけでは変わったことにしない
    data = updateVersion(data, data.pieces[pieces[1]].activeVersionId!, { name: '決定稿' })
    expect(viewOf(data, titleId, snap).rows.every((r) => r.change === null)).toBe(true)

    // 第1話: 別の稿に切り替え／第2話: 同じ稿のまま本文を編集／第3話を削除し、新しい第3話を追加
    const v = addVersion(data, pieces[0], { body: '新しい' })
    data = setActiveVersion(v.data, pieces[0], v.result)
    data = updateVersion(data, data.pieces[pieces[1]].activeVersionId!, { body: 'かきくけこさ' })
    data = deletePiece(data, pieces[2])
    const added = addEpisode(data, titleId)
    data = added.data
    const view = viewOf(data, titleId, snap)
    expect(view.rows.map((r) => [r.label, r.change])).toEqual([
      ['プロローグ', null],
      ['第1話', 'switched'],
      ['第2話', 'edited'],
      ['第3話', 'removed'],
      ['第3話', 'added'],
    ])
    expect(view.rows.at(-1)).toMatchObject({ pieceId: added.result, versionName: null, chars: 0 })
    expect(snapshotChangeSummary(view.diff)).toBe('稿の切り替え 1件、本文の編集 1件、追加 1件、削除 1件')
    // 記録時 4+5+5+3=17字 → 現在 4+3+6+0=13字
    expect(view.diff.charDelta).toBe(-4)
    // 使い回す今の状態との比較は、domain の比較（その場で今の状態を作る）と同じ結果
    expect(compareSnapshots(snap, currentManuscript(data, titleId), snapshotCounts(data, snap))).toEqual(
      compareSnapshotWithCurrent(data, titleId, snap),
    )
  })

  it('記録した時に採用原稿がなかった話は「採用原稿なし」として並べる', () => {
    const { data: base, titleId, pieces } = setup()
    const s = addSubmission(setActiveVersion(base, pieces[1], null), titleId, '賞')
    const data = recordSubmissionSnapshot(s.data, s.result)
    const view = viewOf(data, titleId, data.submissions[s.result].snapshot!)
    expect(view.rows.map((r) => [r.label, r.noActive])).toEqual([
      ['第1話', false],
      ['第2話', true],
      ['第3話', false],
    ])
  })

  it('今の原稿の状態は、原稿（話・稿・章・並び）が変わった時だけ作り直す', () => {
    const { data, titleId, pieces } = setup()
    const deps = (d: AppData) => manuscriptDeps(d, titleId)
    const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
    // 全体戦略・応募計画の入力では変わらない
    const s = addSubmission(data, titleId, '賞')
    expect(same(deps(data), deps(s.data))).toBe(true)
    const noted = { ...data, titles: { ...data.titles, [titleId]: { ...data.titles[titleId], strategyNote: 'メモ' } } }
    expect(same(deps(data), deps(noted))).toBe(true)
    // 本文・採用の変更では変わる
    expect(same(deps(data), deps(updateVersion(data, data.pieces[pieces[0]].versionIds[0], { body: '別' })))).toBe(false)
    expect(same(deps(data), deps(setActiveVersion(data, pieces[0], null)))).toBe(false)
  })

  it('古い記録（話ごとの内容なし）は件数だけ。特殊ブロックは話に数えない', () => {
    const s = setup()
    const data = addSpecial(s.data, s.titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    const full = takeSnapshot(data, s.titleId)
    const old = { at: full.at, charCount: full.charCount, activeVersions: full.activeVersions }
    const view = viewOf(data, s.titleId, old)
    expect(view.detailed).toBe(false)
    expect(view.rows).toEqual([])
    expect([view.episodes, view.specials]).toEqual([3, 1])
    expect(snapshotPages(old, data)).toBeNull()
    // 文字数は記録した数のまま
    expect(snapshotCounts(data, old)).toEqual({ charCount: full.charCount, pages: null, chars: {} })
  })
})
