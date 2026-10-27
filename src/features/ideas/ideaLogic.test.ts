import { describe, expect, it } from 'vitest'
import { ideaSections, addIdea, createTitle } from '../../domain/entityOps'
import { emptyData } from '../../domain/types'
import {
  UNASSIGNED_KEY,
  UNASSIGNED_NAME,
  canSaveIdea,
  ideaShortLabel,
  isSubmitShortcut,
  moveTargets,
  parseCollapsed,
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

  it('長すぎる場合は切り詰める（サロゲートペアを壊さない）', () => {
    expect(titleNameFromIdea({ heading: 'あ'.repeat(50), body: '' })).toBe(`${'あ'.repeat(40)}…`)
    expect(truncate('𠮷'.repeat(5), 3)).toBe('𠮷𠮷𠮷…')
    expect(truncate('短い', 3)).toBe('短い')
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
