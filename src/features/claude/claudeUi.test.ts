import { describe, expect, it } from 'vitest'
import { setChaptersEnabled } from '../../domain/storyOps'
import { novel } from '../../test/claudeFixture'
import { WRITE_TOOL_LABELS } from '../../claude/records'
import { CLAUDE_ACCESS_HINTS } from './ClaudeAccessControl'
import { TRASH_RETENTION_DAYS } from '../../domain/trash'
import { CLAUDE_CAN, CLAUDE_CANNOT, itemStatusTone, manualFileName, resolveRange, sourceLabel } from './claudeUi'

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
      // 相対比較の分析・資料の記録はタイトルに属さないので、タイトルの「読む＋書き込む」の説明には書かない
      if (s !== '相対比較に分析' && s !== '資料に記録') expect(CLAUDE_ACCESS_HINTS.write, s).toContain(s)
      expect(can, s).toContain(s)
    }
  })

  it('Claude が足したカードをゴミ箱へ移せること（2.7）と、ほかの削除はできないことを書く', () => {
    const trash = CLAUDE_CAN.find((t) => t.includes('ゴミ箱へ移す'))
    expect(trash).toBeDefined()
    for (const word of [
      '作者が頼んだ時だけ',
      'Claude がコネクタで足した',
      '相対比較の分析',
      '資料の記録',
      `${TRASH_RETENTION_DAYS}日`,
      '「書き込みを許可」の時だけ',
    ])
      expect(trash, word).toContain(word)
    const cannot = CLAUDE_CANNOT.join('\n')
    expect(cannot).toContain('ゴミ箱へ移すこと以外の削除はできません')
    expect(cannot).not.toContain('削除もアプリでだけ')
  })

  it('2.8: アイデアを足す・ホームのアイデア・Claude が足したアイデアへの追記と、作者が書いたアイデアには追記しない・読まないことを書く', () => {
    const can = CLAUDE_CAN.join('\n')
    for (const word of ['アイデアを新しく足す', 'ホームのアイデア', '追記', '「Claude が作成」の印', '前の中身は消さず'])
      expect(can, word).toContain(word)
    // ゴミ箱へ移せるものにアイデアが入る（2.7 の言葉はそのまま）。Claude の追記は「作者が直した」に数えない
    const trash = CLAUDE_CAN.find((t) => t.includes('ゴミ箱へ移す'))!
    expect(trash).toContain('相対比較の分析・資料の記録・アイデア')
    expect(trash).toContain('Claude の追記は直したことに数えません')
    const cannot = CLAUDE_CANNOT.join('\n')
    for (const word of ['作者が書いたアイデアに追記する', '作者が書いたどのタイトルにも属さないアイデア', '前の中身は消せません'])
      expect(cannot, word).toContain(word)
    expect(CLAUDE_ACCESS_HINTS.write).toContain('アイデア')
    expect(CLAUDE_ACCESS_HINTS.write).toContain('追記')
    expect(CLAUDE_ACCESS_HINTS.read).toContain('アイデアなどは足せません')
  })

  it('2.9: アイデアをフォルダに入れる（無ければ作る・言わない時は先に聞く・ホームのフォルダは名前だけ）と、フォルダの整理はできないことを書く', () => {
    const can = CLAUDE_CAN.join('\n')
    for (const word of [
      'フォルダ（2段まで）に入れる',
      '言われたフォルダが無ければ作る',
      '書き込む前にどのフォルダに入れるかを聞きます',
      'Claude が作ったフォルダにも「Claude が作成」の印',
      'どのタイトルにも属さないフォルダは名前だけが見えます',
    ])
      expect(can, word).toContain(word)
    expect(CLAUDE_CANNOT.join('\n')).toContain('フォルダの名前の変更・削除・移動と、カードの移動（整理はアプリで作者がする）')
  })
})
