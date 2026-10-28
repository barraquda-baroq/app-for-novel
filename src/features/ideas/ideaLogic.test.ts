import { describe, expect, it } from 'vitest'
import { ideaSections, addIdea, createTitle } from '../../domain/entityOps'
import { emptyData } from '../../domain/types'
import {
  UNASSIGNED_KEY,
  UNASSIGNED_NAME,
  canSaveIdea,
  cutAtBoundary,
  ideaModalDraftKey,
  ideaShortLabel,
  isSubmitShortcut,
  moveTargets,
  parseCollapsed,
  parseIdeaModalDraft,
  positionOptions,
  sectionDisplayName,
  sectionKey,
  submitShortcutLabel,
  titleIdFromKey,
  titleNameFromIdea,
  truncate,
} from './ideaLogic'

describe('仕切りのキー', () => {
  it('null は none、タイトルは ID のまま。相互に戻せる', () => {
    expect(sectionKey(null)).toBe(UNASSIGNED_KEY)
    expect(sectionKey('abc')).toBe('abc')
    expect(titleIdFromKey(UNASSIGNED_KEY)).toBeNull()
    expect(titleIdFromKey('')).toBeNull()
    expect(titleIdFromKey('abc')).toBe('abc')
  })

  it('表示名: 無題のタイトルと「どのタイトルにも属さない」', () => {
    expect(sectionDisplayName({ titleId: null, name: 'x' })).toBe(UNASSIGNED_NAME)
    expect(sectionDisplayName({ titleId: 't', name: '  ' })).toBe('無題のタイトル')
    expect(sectionDisplayName({ titleId: 't', name: ' 星の海 ' })).toBe('星の海')
  })
})

describe('保存できるか', () => {
  it('見出しか内容のどちらかがあればよい', () => {
    expect(canSaveIdea('', '')).toBe(false)
    expect(canSaveIdea('  ', '\n ')).toBe(false)
    expect(canSaveIdea('見出し', '')).toBe(true)
    expect(canSaveIdea('', '内容')).toBe(true)
  })
})

describe('アイデアからタイトル名を作る', () => {
  it('見出しがあれば見出し', () => {
    expect(titleNameFromIdea({ heading: ' 記憶を売る古書店 ', body: '本文' })).toBe('記憶を売る古書店')
  })

  it('見出しがなければ内容の最初の空でない行', () => {
    expect(titleNameFromIdea({ heading: '', body: '\n\n  灯台守の少女が  \n嵐の夜に' })).toBe('灯台守の少女が')
    expect(titleNameFromIdea({ heading: '', body: '一行目\r\n二行目' })).toBe('一行目')
  })

  it('長すぎる場合は「…」を付けずに切る（区切りがなければ40文字。サロゲートペアを壊さない）', () => {
    expect(titleNameFromIdea({ heading: 'あ'.repeat(50), body: '' })).toBe('あ'.repeat(40))
    expect(titleNameFromIdea({ heading: '𠮷'.repeat(50), body: '' })).toBe('𠮷'.repeat(40))
    expect(titleNameFromIdea({ heading: '', body: 'あ'.repeat(60) })).not.toContain('…')
    expect(truncate('𠮷'.repeat(5), 3)).toBe('𠮷𠮷𠮷…')
    expect(truncate('短い', 3)).toBe('短い')
  })

  it('長い文は40文字以内の最後の文の区切り、なければ読点などの区切りで切る', () => {
    const long = '雨の日にだけ開く駅のホームで、少女は毎朝、来ないはずの列車を待ち続けている。そして十年が過ぎた。'
    expect(titleNameFromIdea({ heading: '', body: long })).toBe(
      '雨の日にだけ開く駅のホームで、少女は毎朝、来ないはずの列車を待ち続けている',
    )
    // 文の区切りがなければ読点で
    const clauses = '灯台守の少女は嵐の夜に流れ着いた手紙を拾い、差出人を探して海沿いの町を一軒ずつ訪ね歩く'
    expect(cutAtBoundary(clauses, 40)).toBe('灯台守の少女は嵐の夜に流れ着いた手紙を拾い')
    // ！？ は題名の一部として残す
    expect(cutAtBoundary(`それでも灯りは消さない！${'あ'.repeat(40)}`, 40)).toBe('それでも灯りは消さない！')
    // ちょうど40文字の直後の区切りも使う
    expect(cutAtBoundary(`${'い'.repeat(40)}。続き`, 40)).toBe('い'.repeat(40))
    // 短すぎる切れ端にはしない（先頭近くの区切りは使わず40文字で切る）
    expect(cutAtBoundary(`あ、${'う'.repeat(50)}`, 40)).toBe(`あ、${'う'.repeat(38)}`)
  })

  it('収まる長さなら末尾の句点だけを落とす（自分で付けた「…」や「！」は残す）', () => {
    expect(titleNameFromIdea({ heading: '', body: '灯台守の少女が手紙を拾う。' })).toBe('灯台守の少女が手紙を拾う')
    expect(titleNameFromIdea({ heading: 'そして誰もいなくなった…', body: '' })).toBe('そして誰もいなくなった…')
    expect(titleNameFromIdea({ heading: '走れ！', body: '' })).toBe('走れ！')
  })

  it('空のアイデアは空文字。短い呼び名には代わりの表記', () => {
    expect(titleNameFromIdea({ heading: '', body: ' \n ' })).toBe('')
    expect(ideaShortLabel({ heading: '', body: '' })).toBe('（空のアイデア）')
    expect(ideaShortLabel({ heading: '', body: 'メモ' })).toBe('メモ')
  })
})

describe('ショートカット', () => {
  it('Ctrl/⌘+Enter だけを保存とみなし、変換中は除く', () => {
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true)
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false)
    expect(isSubmitShortcut({ key: 'a', ctrlKey: true, metaKey: false })).toBe(false)
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true })).toBe(false)
  })

  it('Mac では ⌘ と表記する', () => {
    expect(submitShortcutLabel('MacIntel')).toBe('⌘+Enter')
    expect(submitShortcutLabel('iPhone')).toBe('⌘+Enter')
    expect(submitShortcutLabel('Win32')).toBe('Ctrl+Enter')
    expect(submitShortcutLabel('Linux x86_64')).toBe('Ctrl+Enter')
  })
})

describe('移動先の候補', () => {
  it('すべての仕切りを並び順どおりに返し、今いる仕切りに印を付ける', () => {
    let data = emptyData()
    const a = createTitle(data, '星の海')
    data = a.data
    const b = createTitle(data, '風の街')
    data = b.data
    const idea = addIdea(data, a.result, '', '案')
    data = idea.data
    data = addIdea(data, null, '', '別の案').data
    const sections = ideaSections(data)
    const targets = moveTargets(sections, data.ideas[idea.result], (id) => Boolean(data.titles[id]))
    expect(targets.map((t) => [t.name, t.count, t.current])).toEqual([
      ['星の海', 1, true],
      ['風の街', 0, false],
      [UNASSIGNED_NAME, 1, false],
    ])
  })

  it('削除済みのタイトルを指すアイデアは「どのタイトルにも属さない」にいるとみなす', () => {
    const data = emptyData()
    const targets = moveTargets(ideaSections(data), { titleId: 'gone' }, () => false)
    expect(targets).toEqual([{ titleId: null, name: UNASSIGNED_NAME, count: 0, current: true }])
  })
})

describe('折りたたみの保存値', () => {
  it('壊れた値・文字列以外は無視する', () => {
    expect(parseCollapsed(null)).toEqual([])
    expect(parseCollapsed('not json')).toEqual([])
    expect(parseCollapsed('{"a":1}')).toEqual([])
    expect(parseCollapsed('["none", 3, "t1"]')).toEqual(['none', 't1'])
  })
})

describe('位置を選んで移動の候補', () => {
  it('先頭／○○の後／末尾を、移動するもの自身を除いた並びで作る', () => {
    expect(positionOptions(['A', 'B', 'C'])).toEqual([
      { index: 0, label: '先頭（「A」の前）' },
      { index: 1, label: '「A」の後' },
      { index: 2, label: '「B」の後' },
      { index: 3, label: '末尾（「C」の後）' },
    ])
    expect(positionOptions([])).toEqual([{ index: 0, label: '先頭' }])
  })

  it('長い名前は短くし、同じ表記が並ぶ時は何番目かを添える', () => {
    expect(positionOptions(['あ'.repeat(30)], 5)[0].label).toBe('先頭（「あああああ…」の前）')
    const labels = positionOptions(['同じ', '同じ', '別']).map((o) => o.label)
    expect(labels).toEqual(['先頭（「同じ」の前）', '「同じ」の後（2番目）', '「同じ」の後（3番目）', '末尾（「別」の後）'])
  })
})

describe('追加・編集ダイアログの下書き', () => {
  it('追加は仕切りごと、編集はアイデアごとに別のキー', () => {
    expect(ideaModalDraftKey({ mode: 'add', section: 'none' })).toBe('novel-studio:idea-modal-draft:new:none')
    expect(ideaModalDraftKey({ mode: 'add', section: 't1' })).toBe('novel-studio:idea-modal-draft:new:t1')
    expect(ideaModalDraftKey({ mode: 'edit', ideaId: 'i1' })).toBe('novel-studio:idea-modal-draft:edit:i1')
  })

  it('壊れた値は null', () => {
    expect(parseIdeaModalDraft(null)).toBeNull()
    expect(parseIdeaModalDraft('not json')).toBeNull()
    expect(parseIdeaModalDraft('{"heading":1,"body":"x"}')).toBeNull()
    expect(parseIdeaModalDraft('null')).toBeNull()
    expect(parseIdeaModalDraft('{"heading":"見出し","body":"内容"}')).toEqual({ heading: '見出し', body: '内容' })
  })
})
