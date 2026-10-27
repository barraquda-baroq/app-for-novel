import { afterEach, describe, expect, it, vi } from 'vitest'
import { addSubmission, createTitle, takeSnapshot, updateSubmission } from '../../../domain/entityOps'
import { addEpisode, addSpecial, addVersion, deletePiece, setActiveVersion, updateVersion } from '../../../domain/storyOps'
import { emptyData, type AppData, type Submission } from '../../../domain/types'
import {
  charLimitCheck,
  charLimitRange,
  compareSnapshot,
  daysUntil,
  deadlineInfo,
  formatYmd,
  isHttpUrl,
  manuscriptSummary,
  parseCharLimit,
  sortByDeadline,
  statusTone,
} from './strategyLogic'

const today = new Date(2026, 9, 27, 15, 30) // 2026/10/27（ローカル時刻）

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
  })
})

describe('規定文字数', () => {
  it('不足・超過・規定内', () => {
    expect(charLimitCheck(78_800, 80_000, 120_000)).toEqual({ state: 'short', diff: 1_200, text: 'あと1,200字必要' })
    expect(charLimitCheck(121_200, 80_000, 120_000)).toEqual({ state: 'over', diff: 1_200, text: '1,200字超過' })
    expect(charLimitCheck(80_000, 80_000, 120_000)?.text).toBe('規定内')
    expect(charLimitCheck(120_000, null, 120_000)?.text).toBe('規定内')
    expect(charLimitCheck(0, 1, null)?.text).toBe('あと1字必要')
    expect(charLimitCheck(5_000, null, null)).toBeNull()
  })

  it('範囲の表記', () => {
    expect(charLimitRange(80_000, 120_000)).toBe('80,000〜120,000字')
    expect(charLimitRange(80_000, null)).toBe('80,000字以上')
    expect(charLimitRange(null, 120_000)).toBe('120,000字以内')
    expect(charLimitRange(null, null)).toBe('')
  })

  it('入力欄の値を安全に数値にする（空欄は null、読めなければ undefined）', () => {
    expect(parseCharLimit('')).toBeNull()
    expect(parseCharLimit('   ')).toBeNull()
    expect(parseCharLimit('100000')).toBe(100_000)
    expect(parseCharLimit('100,000')).toBe(100_000)
    expect(parseCharLimit('１２万')).toBe(120_000)
    expect(parseCharLimit('1.5万字')).toBe(15_000)
    expect(parseCharLimit('８０，０００文字')).toBe(80_000)
    expect(parseCharLimit('たくさん')).toBeUndefined()
    expect(parseCharLimit('-100')).toBeUndefined()
    expect(parseCharLimit('1e5')).toBeUndefined()
  })
})

describe('状態の色分け', () => {
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
})

function sub(id: string, order: number, deadline: string): Submission {
  return { id, order, deadline } as Submission
}

describe('締切順', () => {
  it('締切の早い順、未設定は最後、同じ日は応募順。元の配列は変えない', () => {
    const list = [
      sub('a', 0, ''),
      sub('b', 1, '2026-12-01'),
      sub('c', 2, '2026-11-01'),
      sub('d', 3, '2026-12-01'),
      sub('e', 4, ''),
    ]
    expect(sortByDeadline(list).map((s) => s.id)).toEqual(['c', 'b', 'd', 'a', 'e'])
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
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
  it('採用原稿だけを数え、採用原稿がない話を数える', () => {
    let { data, titleId, pieces } = setup()
    data = setActiveVersion(data, pieces[2], null)
    data = addSpecial(data, titleId, { chapterId: null, index: 0 }, 'プロローグ').data
    // プロローグは採用中の稿が空（0字・0枚）、第3話は採用原稿なし
    expect(manuscriptSummary(data, titleId)).toEqual({ chars: 10, pages: 2, episodes: 3, specials: 1, missingActive: 1 })
  })
})

describe('応募時スナップショットとの比較', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('採用の切り替え・追加・削除を「変わった話」、同じ稿の編集を別に数える', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0))
    let { data, titleId, pieces } = setup()
    const s = addSubmission(data, titleId, '賞')
    data = s.data
    const snap = takeSnapshot(data, titleId)
    data = updateSubmission(data, s.result, { snapshot: snap })
    expect(compareSnapshot(data, titleId, snap)).toEqual({ switched: 0, edited: 0, recordedPieces: 3, charDelta: 0 })

    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))
    // 第1話: 別の稿に切り替え
    const v = addVersion(data, pieces[0], { body: '新しい' })
    data = setActiveVersion(v.data, pieces[0], v.result)
    // 第2話: 同じ稿のまま本文を編集
    data = updateVersion(data, data.pieces[pieces[1]].activeVersionId!, { body: 'かきくけこさ' })
    // 第4話を追加（空の稿が採用される）
    data = addEpisode(data, titleId).data
    const diff = compareSnapshot(data, titleId, snap)
    expect(diff.switched).toBe(2)
    expect(diff.edited).toBe(1)
    // 記録時 5+5+3=13字 → 現在 3+6+3+0=12字
    expect(diff.charDelta).toBe(-1)

    // 最後の話を削除すると、追加した話は数えなくなり、削除した話が数えられる
    const last = Object.keys(data.pieces).find((id) => !pieces.includes(id))!
    data = deletePiece(data, last)
    data = deletePiece(data, pieces[2])
    expect(compareSnapshot(data, titleId, snap).switched).toBe(2)
  })
})
