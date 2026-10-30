import { describe, expect, it } from 'vitest'
import { setChaptersEnabled } from '../../domain/storyOps'
import { novel } from '../../test/claudeFixture'
import { WRITE_TOOL_LABELS } from '../../claude/records'
import { CLAUDE_ACCESS_HINTS } from './ClaudeAccessControl'
import { CLAUDE_CAN, itemStatusTone, manualFileName, resolveRange, sourceLabel } from './claudeUi'

describe('手動連携の範囲', () => {
  it('タイトル全体・章・話の範囲（番号は範囲の中に収め、逆なら入れ替える）', () => {
    const n = novel(['一', '二', '三', '四'])
    expect(resolveRange(n.data, n.titleId, { kind: 'all' })).toEqual({ rangeLabel: 'タイトル全体' })
    expect(resolveRange(n.data, n.titleId, { kind: 'pieces', from: 2, to: 3 })).toEqual({
      selection: { from: '#2', to: '#3' },
      rangeLabel: '第2話〜第3話',
      scope: { from: '#2', to: '#3' },
    })
    expect(resolveRange(n.data, n.titleId, { kind: 'pieces', from: 9, to: 0 }).rangeLabel).toBe('第1話〜第4話')
    expect(resolveRange(n.data, n.titleId, { kind: 'pieces', from: 3, to: 3 }).rangeLabel).toBe('第3話')
    // 章が無ければタイトル全体
    expect(resolveRange(n.data, n.titleId, { kind: 'chapter', chapterId: 'nope' }).rangeLabel).toBe('タイトル全体')
    const data = setChaptersEnabled(n.data, n.titleId, true)
    const chapterId = Object.values(data.chapters)[0].id
    expect(resolveRange(data, n.titleId, { kind: 'chapter', chapterId })).toEqual({
      selection: { chapter: chapterId },
      rangeLabel: '第1章',
    })
  })

  it('話が無い時はタイトル全体', () => {
    const n = novel([])
    expect(resolveRange(n.data, n.titleId, { kind: 'pieces', from: 1, to: 2 }).rangeLabel).toBe('タイトル全体')
  })
})

describe('表記', () => {
  it('「.txt で保存」のファイル名（使えない文字は置き換える）', () => {
    expect(manualFileName('星の/庭', 'critique', '2026-10-28')).toBe('20261028星の_庭_作品批評の依頼.txt')
    expect(manualFileName('', 'proofreading', '2026-01-02')).toBe('20260102無題のタイトル_ワードサーチの依頼.txt')
  })

  it('作ったもの・貼り付けの結果の表記', () => {
    expect(sourceLabel('claude')).toBe('Claude')
    expect(sourceLabel('paste')).toBe('Claude（貼り付け）')
    expect(sourceLabel('manual')).toBeNull()
    expect(itemStatusTone('created')).toBe('ok')
    expect(itemStatusTone('duplicate')).toBe('skip')
    expect(itemStatusTone('previously_deleted')).toBe('skip')
    expect(itemStatusTone('not_found')).toBe('warn')
    expect(itemStatusTone('ambiguous')).toBe('warn')
  })
})

describe('Claude ができること（同意・設定の画面）', () => {
  it('読めるもの（すべての稿・アイデアも）と、足せるもの（書き込みのツールすべて）を書く', () => {
    const can = CLAUDE_CAN.join('\n')
    for (const word of ['採用していない稿', 'すべての稿', 'アイデア', '作品批評', '推敲案を読む']) expect(can).toContain(word)
    // 書き込みのツールで足せるもの（「推敲案を追加」→ 推敲案、「作品批評の結果を記録」→ 批評の結果）
    const subjects = Object.values(WRITE_TOOL_LABELS).map((l) =>
      l.replace(/を(追加|保存|記録)$/, '').replace(/^作品批評の/, '批評の'),
    )
    for (const s of subjects) {
      // ベンチ作品の分析はタイトルに属さないので、タイトルの「読む＋書き込む」の説明には書かない
      if (s !== 'ベンチ作品の分析') expect(CLAUDE_ACCESS_HINTS.write, s).toContain(s)
      expect(can, s).toContain(s)
    }
  })
})
