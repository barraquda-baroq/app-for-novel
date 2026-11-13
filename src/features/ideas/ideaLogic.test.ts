import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addIdea,
  createTitle,
  deleteIdea,
  ideaSections,
  moveIdeaStep,
  moveIdeaTo,
  setIdeaChecked,
  sortIdeas,
} from '../../domain/entityOps'
import { parseBackup, toBackup } from '../../domain/backup'
import { containerKey } from '../../domain/ideaFolders'
import { createIdeaFolder } from '../../domain/ideaFolderOps'
import { repairData } from '../../domain/repair'
import { restoreTrashEntry } from '../../domain/trash'
import { emptyData, type AppData, type ID } from '../../domain/types'
import {
  UNASSIGNED_KEY,
  UNASSIGNED_NAME,
  bulkMovedMessage,
  canSaveIdea,
  CLAUDE_IDEA_BADGE,
  containerIdeas,
  cutAtBoundary,
  folderCountTitle,
  folderDeleteSubject,
  folderMoveTargets,
  ideaEditText,
  ideaModalDraftKey,
  ideaPlace,
  ideaPlaceName,
  ideaShortLabel,
  isSubmitShortcut,
  moveTargets,
  parseCollapsed,
  parseIdeaModalDraft,
  positionOptions,
  rebaseIdeaEdit,
  sectionDisplayName,
  sectionKey,
  serializeIdeaModalDraft,
  splitLead,
  subfolderInitialName,
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
  it('内容があればよい（見出しの入力欄はない）', () => {
    expect(canSaveIdea('')).toBe(false)
    expect(canSaveIdea('  \n ')).toBe(false)
    expect(canSaveIdea('内容')).toBe(true)
  })
})

describe('古い版の見出し', () => {
  it('編集ダイアログでは見出しを内容の1行目にまとめる。見出しが無ければ内容のまま', () => {
    expect(ideaEditText({ heading: '記憶を売る古書店', body: '客は記憶を売る。\n店主は読まない。' })).toBe(
      '記憶を売る古書店\n客は記憶を売る。\n店主は読まない。',
    )
    expect(ideaEditText({ heading: ' 見出しだけ ', body: '' })).toBe('見出しだけ')
    expect(ideaEditText({ heading: '', body: '内容だけ' })).toBe('内容だけ')
    expect(ideaEditText({ heading: '  ', body: '内容だけ' })).toBe('内容だけ')
  })

  it('カードでは、2行以上ある時だけ1行目を分けて目立たせる', () => {
    expect(splitLead('雨の駅\n来ない列車を待つ')).toEqual({ lead: '雨の駅', rest: '\n来ない列車を待つ' })
    expect(splitLead('一行だけ')).toEqual({ lead: '', rest: '一行だけ' })
    expect(splitLead('一行だけ\n  ')).toEqual({ lead: '', rest: '一行だけ\n  ' })
    expect(splitLead('\n2行目から')).toEqual({ lead: '', rest: '\n2行目から' })
    expect(splitLead('A\r\nB')).toEqual({ lead: 'A', rest: '\r\nB' })
  })
})

describe('済み（チェック）と並び', () => {
  let clock = 1_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock = 1_000
    vi.setSystemTime(clock)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  /** 1ミリ秒ずつ進める（済みにした順を分ける） */
  const tick = () => vi.setSystemTime((clock += 1))

  function fixture(): { data: AppData; ids: ID[] } {
    let data = emptyData()
    const ids: ID[] = []
    for (const body of ['A', 'B', 'C', 'D']) {
      const r = addIdea(data, null, '', body)
      data = r.data
      ids.push(r.result)
    }
    return { data, ids }
  }
  const bodies = (data: AppData) =>
    ideaSections(data)
      .at(-1)!
      .ideas.map((i) => `${i.body}${i.checked ? '✓' : ''}`)

  it('新しいアイデアは済みでない（checked: false・checkedAt: null）', () => {
    const { data, ids } = fixture()
    expect(data.ideas[ids[0]]).toMatchObject({ heading: '', checked: false, checkedAt: null })
  })

  it('済みにしたアイデアは下へ沈み、新しく済みにしたものから並ぶ。済みでないものは手で並べた順のまま', () => {
    let { data, ids } = fixture()
    tick()
    data = setIdeaChecked(data, ids[1], true)
    expect(bodies(data)).toEqual(['A', 'C', 'D', 'B✓'])
    tick()
    data = setIdeaChecked(data, ids[0], true)
    expect(bodies(data)).toEqual(['C', 'D', 'A✓', 'B✓'])
    expect(data.ideas[ids[0]].checkedAt).toBe(clock)
    // 同じ値にしても何も変わらない（済みにした日時も変えない）
    const before = data
    tick()
    data = setIdeaChecked(data, ids[0], true)
    expect(data).toEqual(before)
  })

  it('済みを外すと、済みでないアイデアの末尾に戻る（checkedAt は null）', () => {
    let { data, ids } = fixture()
    tick()
    data = setIdeaChecked(data, ids[0], true)
    tick()
    data = setIdeaChecked(data, ids[2], true)
    data = setIdeaChecked(data, ids[0], false)
    expect(bodies(data)).toEqual(['B', 'D', 'A', 'C✓'])
    expect(data.ideas[ids[0]]).toMatchObject({ checked: false, checkedAt: null })
  })

  it('checked を持たない古いアイデアは済みでない。checkedAt の無い済みは古い済みとして最後', () => {
    const { data, ids } = fixture()
    const legacy = { ...data.ideas[ids[0]] }
    delete legacy.checked
    delete legacy.checkedAt
    const list = sortIdeas([
      { ...data.ideas[ids[1]], checked: true, checkedAt: null },
      legacy,
      { ...data.ideas[ids[2]], checked: true, checkedAt: 5 },
    ])
    expect(list.map((i) => i.body)).toEqual(['A', 'C', 'B'])
  })

  it('↑↓と位置を選んで移動は、済みでないアイデアの中だけで動かす。済みのアイデアは動かさない', () => {
    let { data, ids } = fixture()
    tick()
    data = setIdeaChecked(data, ids[1], true)
    // C の1つ上は（済みの B を飛ばして）A
    data = moveIdeaStep(data, ids[2], -1)
    expect(bodies(data)).toEqual(['C', 'A', 'D', 'B✓'])
    // 済みのアイデアは↑↓でも位置を選んでも動かない
    expect(moveIdeaStep(data, ids[1], -1)).toEqual(data)
    expect(moveIdeaTo(data, ids[1], null, 0)).toEqual(data)
    // 位置は済みでないアイデアの中で数える（2 = D の前）
    data = moveIdeaTo(data, ids[2], null, 2)
    expect(bodies(data)).toEqual(['A', 'D', 'C', 'B✓'])
  })

  it('済みのアイデアをほかの仕切りへ移すと、済みのまま下にまとまる（位置は使わない）', () => {
    let { data, ids } = fixture()
    const t = createTitle(data, '星の海')
    data = addIdea(t.data, t.result, '', 'X').data
    tick()
    data = setIdeaChecked(data, ids[3], true)
    data = moveIdeaTo(data, ids[3], t.result, 0)
    expect(ideaSections(data)[0].ideas.map((i) => `${i.body}${i.checked ? '✓' : ''}`)).toEqual(['X', 'D✓'])
  })

  it('削除して戻しても済みのまま。済みでないアイデアは済みでないものの中の元の位置に戻る', () => {
    let { data, ids } = fixture()
    tick()
    data = setIdeaChecked(data, ids[0], true)
    data = deleteIdea(data, ids[0])
    data = deleteIdea(data, ids[2])
    expect(bodies(data)).toEqual(['B', 'D'])
    for (const id of Object.keys(data.trashEntries)) data = restoreTrashEntry(data, id).data
    expect(bodies(data)).toEqual(['B', 'C', 'D', 'A✓'])
    expect(data.ideas[ids[0]].checkedAt).toBe(clock)
  })

  it('古いバックアップ（見出しあり・済みの項目なし）も読み込め、済みでないアイデアとして並ぶ。済みは書き出して読み戻しても残る', () => {
    const ts = 1
    const old = {
      app: 'novel-studio',
      schemaVersion: 1,
      exportedAt: '2025-01-01T00:00:00.000Z',
      data: {
        ideas: {
          i1: { id: 'i1', titleId: null, heading: '古い見出し', body: '古い内容', order: 0, createdAt: ts, updatedAt: ts },
          i2: { id: 'i2', titleId: null, heading: '', body: '二つ目', order: 1, createdAt: ts, updatedAt: ts },
        },
      },
    }
    let data = parseBackup(JSON.stringify(old))
    expect(data.ideas.i1).toMatchObject({ heading: '古い見出し', body: '古い内容' })
    expect(bodies(data)).toEqual(['古い内容', '二つ目'])
    tick()
    data = setIdeaChecked(data, 'i1', true)
    const again = parseBackup(JSON.stringify(toBackup(data)))
    expect(again.ideas.i1).toMatchObject({ heading: '古い見出し', checked: true, checkedAt: clock })
    expect(bodies(again)).toEqual(['二つ目', '古い内容✓'])
  })

  it('修復: 古いアイデアに済みの項目を足さない（同期でほかの端末の「済み」を打ち消さない）。壊れた値は直す', () => {
    const { data, ids } = fixture()
    const legacy = { ...data.ideas[ids[0]] }
    delete legacy.checked
    delete legacy.checkedAt
    const input: AppData = {
      ...data,
      ideas: {
        ...data.ideas,
        [ids[0]]: legacy,
        [ids[1]]: { ...data.ideas[ids[1]], checked: 'yes' as unknown as boolean, checkedAt: 3 },
        [ids[2]]: { ...data.ideas[ids[2]], checked: true, checkedAt: 'x' as unknown as number },
      },
    }
    const r = repairData(input)
    expect('checked' in r.data.ideas[ids[0]]).toBe(false)
    expect(r.data.ideas[ids[1]]).toMatchObject({ checked: false, checkedAt: null })
    expect(r.data.ideas[ids[2]]).toMatchObject({ checked: true, checkedAt: null })
    expect(r.fixes).toHaveLength(2)
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

  it('行の頭の日付と時刻（Claude が作ったアイデアの1行目）は除く。日付と時刻だけの行なら次の空でない行（2.8）', () => {
    expect(titleNameFromIdea({ heading: '', body: '2026/11/12 14:32\u3000第3章の動機\n・兄を探す' })).toBe('第3章の動機')
    expect(titleNameFromIdea({ heading: '', body: '2026/11/12 14:32 灯台守の少女\n中身' })).toBe('灯台守の少女')
    expect(titleNameFromIdea({ heading: '', body: '2026/11/12 14:32\n\n  記憶を売る古書店  \n続き' })).toBe('記憶を売る古書店')
    expect(titleNameFromIdea({ heading: '', body: '2026/11/12 14:32' })).toBe('')
    // 日付と時刻に続けて書いた文字は日付の一部とみなさない。行の途中の日付は残す
    expect(titleNameFromIdea({ heading: '', body: '2026/11/12 14:32の約束' })).toBe('2026/11/12 14:32の約束')
    expect(titleNameFromIdea({ heading: '', body: '再会は2026/11/12 14:32' })).toBe('再会は2026/11/12 14:32')
    // 古い版の見出しはそのまま
    expect(titleNameFromIdea({ heading: '2026/11/12 14:32 見出し', body: '' })).toBe('2026/11/12 14:32 見出し')
    // 短い呼び名・ゴミ箱の名前は日付を残す（何のカードか分かるように）
    expect(ideaShortLabel({ heading: '', body: '2026/11/12 14:32\u3000第3章の動機\n中身' })).toBe(
      '2026/11/12 14:32\u3000第3章の動機',
    )
    // 日付と時刻だけの1行目（名前の無い Claude のアイデア）は、次の空でない行も付けて見分ける（24字まで。カードの表示は変えない）
    const a = ideaShortLabel({ heading: '', body: '2026/11/12 14:32\n【動機】\n・兄を探す' })
    const b = ideaShortLabel({ heading: '', body: '2026/11/12 14:32\n  港町の案\n・灯台' })
    expect(a).toBe('2026/11/12 14:32\u3000【動機】')
    expect(b).toBe('2026/11/12 14:32\u3000港町の案')
    expect(a).not.toBe(b)
    expect(ideaShortLabel({ heading: '', body: `2026/11/12 14:32\n${'あ'.repeat(30)}` })).toBe(
      `2026/11/12 14:32\u3000${'あ'.repeat(7)}…`,
    )
    expect(ideaShortLabel({ heading: '', body: '2026/11/12 14:32' })).toBe('2026/11/12 14:32')
    expect(splitLead('2026/11/12 14:32\n【動機】\n・兄を探す')).toEqual({
      lead: '2026/11/12 14:32',
      rest: '\n【動機】\n・兄を探す',
    })
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
  it('すべての仕切りを並び順どおりに返し、今いる入れ物に印を付ける', () => {
    let data = emptyData()
    const a = createTitle(data, '星の海')
    data = a.data
    const b = createTitle(data, '風の街')
    data = b.data
    const idea = addIdea(data, a.result, '', '案')
    data = idea.data
    data = addIdea(data, null, '', '別の案').data
    const sections = ideaSections(data)
    const targets = moveTargets(sections, ideaPlace(data, data.ideas[idea.result]))
    expect(targets.map((t) => [t.name, t.depth, t.count, t.current])).toEqual([
      ['星の海', 0, 1, true],
      ['風の街', 0, 0, false],
      [UNASSIGNED_NAME, 0, 1, false],
    ])
    expect(targets[0]).toMatchObject({ key: containerKey(a.result, null), titleId: a.result, folderId: null })
  })

  it('削除済みのタイトルを指すアイデアは「どのタイトルにも属さない」にいるとみなす', () => {
    const data = emptyData()
    const targets = moveTargets(ideaSections(data), ideaPlace(data, { titleId: 'gone' }))
    expect(targets).toEqual([
      { key: containerKey(null, null), titleId: null, folderId: null, depth: 0, name: UNASSIGNED_NAME, count: 0, current: true },
    ])
  })

  it('2.9: 木の形（仕切り → 1段目 → その中の2段目）。フォルダのある仕切りは「（フォルダの外）」、数はその入れ物にじかに入っているカード', () => {
    let data = emptyData()
    const t = createTitle(data, '星の庭')
    data = t.data
    const top = createIdeaFolder(data, t.result, null, '場面の相談')
    data = top.data
    const sub = createIdeaFolder(data, t.result, top.result, '雨の駅')
    data = sub.data
    const other = createIdeaFolder(data, t.result, null, '人物の相談')
    data = other.data
    data = addIdea(data, t.result, '', '外').data
    const inSub = addIdea(data, t.result, '', '駅の案', sub.result)
    data = inSub.data
    data = addIdea(data, t.result, '', '駅の案2', sub.result).data
    data = addIdea(data, t.result, '', '相談の案', top.result).data
    const targets = moveTargets(ideaSections(data), ideaPlace(data, data.ideas[inSub.result]))
    expect(targets.map((t) => [t.name, t.depth, t.count, t.current])).toEqual([
      ['星の庭（フォルダの外）', 0, 1, false],
      ['人物の相談', 1, 0, false],
      ['場面の相談', 1, 1, false],
      ['雨の駅', 2, 2, true],
      [UNASSIGNED_NAME, 0, 0, false],
    ])
    expect(targets[3]).toMatchObject({ titleId: t.result, folderId: sub.result, key: containerKey(t.result, sub.result) })
    // まとめて移す時に場所がそろっていなければ、印を付けない
    expect(moveTargets(ideaSections(data), null).some((t) => t.current)).toBe(false)
    // 入れ物のカード
    const section = ideaSections(data)[0]
    expect(containerIdeas(section, sub.result).map((i) => i.body)).toEqual(['駅の案', '駅の案2'])
    expect(containerIdeas(section, null).map((i) => i.body)).toEqual(['外'])
    expect(containerIdeas(section, 'gone')).toEqual([])
  })

  it('2.9: フォルダの移動先は、仕切りごとに「1段目にする」と自分以外の1段目。中にフォルダがあるとフォルダの行は選べない', () => {
    let data = emptyData()
    const t = createTitle(data, '星の庭')
    data = t.data
    const top = createIdeaFolder(data, t.result, null, '場面の相談')
    data = top.data
    const sub = createIdeaFolder(data, t.result, top.result, '雨の駅')
    data = sub.data
    const other = createIdeaFolder(data, null, null, '新作の相談')
    data = other.data
    const sections = ideaSections(data)
    const rows = (id: ID, hasSubfolders: boolean, place: { titleId: ID | null; parentId: ID | null }) =>
      folderMoveTargets(sections, { id, place, hasSubfolders }).map((r) => [r.name, r.depth, r.current, r.disabled])
    expect(rows(sub.result, false, { titleId: t.result, parentId: top.result })).toEqual([
      ['星の庭', 0, false, false],
      ['場面の相談', 1, true, false],
      [UNASSIGNED_NAME, 0, false, false],
      ['新作の相談', 1, false, false],
    ])
    expect(rows(top.result, true, { titleId: t.result, parentId: null })).toEqual([
      ['星の庭', 0, true, false],
      [UNASSIGNED_NAME, 0, false, false],
      ['新作の相談', 1, false, true],
    ])
  })

  it('まとめて移した時の知らせ: もう無かったカードの数を添える', () => {
    expect(bulkMovedMessage(8, 8, '新作の相談 › 2026/11/12　港町')).toBe('8件を「新作の相談 › 2026/11/12　港町」へ移しました')
    expect(bulkMovedMessage(6, 8, '星の庭')).toBe('6件を「星の庭」へ移しました（2件はもうありません）')
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

describe('フォルダの表記（2.9）', () => {
  it('場所は仕切りの名前とフォルダの名前を「 › 」でつなぐ', () => {
    expect(ideaPlaceName('星の庭', [])).toBe('星の庭')
    expect(ideaPlaceName('星の庭', ['場面の相談', '雨の駅'])).toBe('星の庭 › 場面の相談 › 雨の駅')
  })

  it('件数の説明は済みがある時だけ内訳を付ける', () => {
    expect(folderCountTitle(12, 2)).toBe('12件（うち済み 2件）')
    expect(folderCountTitle(3, 0)).toBe('3件')
  })

  it('削除の確かめの主語: 中のフォルダ・カードがあれば数を添え、空なら名前だけ', () => {
    expect(folderDeleteSubject('場面の相談', 2, 12)).toBe('フォルダ「場面の相談」と、中のフォルダ2つ・カード12件を')
    expect(folderDeleteSubject('場面の相談', 0, 5)).toBe('フォルダ「場面の相談」と、中のカード5件を')
    expect(folderDeleteSubject('場面の相談', 1, 0)).toBe('フォルダ「場面の相談」と、中のフォルダ1つを')
    expect(folderDeleteSubject('場面の相談', 0, 0)).toBe('フォルダ「場面の相談」を')
  })

  it('2段目の名前の初期値は日本時間の今日の日付と全角の空白', () => {
    expect(subfolderInitialName(Date.UTC(2026, 10, 12, 14, 59))).toBe('2026/11/12\u3000')
    expect(subfolderInitialName(Date.UTC(2026, 10, 12, 15, 0))).toBe('2026/11/13\u3000')
  })
})

describe('追加・編集ダイアログの下書き', () => {
  it('追加は仕切りごと、編集はアイデアごとに別のキー', () => {
    expect(ideaModalDraftKey({ mode: 'add', section: 'none' })).toBe('novel-studio:idea-modal-draft:new:none')
    expect(ideaModalDraftKey({ mode: 'add', section: 't1' })).toBe('novel-studio:idea-modal-draft:new:t1')
    expect(ideaModalDraftKey({ mode: 'edit', ideaId: 'i1' })).toBe('novel-studio:idea-modal-draft:edit:i1')
    // 2.9: フォルダに足す時はフォルダごと（仕切りのキーと重ならない）
    expect(ideaModalDraftKey({ mode: 'add', folderId: 'f1' })).toBe('novel-studio:idea-modal-draft:new:f:f1')
  })

  it('壊れた値は null', () => {
    expect(parseIdeaModalDraft(null)).toBeNull()
    expect(parseIdeaModalDraft('not json')).toBeNull()
    expect(parseIdeaModalDraft('{"heading":1,"body":"x"}')).toBeNull()
    expect(parseIdeaModalDraft('{"heading":""}')).toBeNull()
    expect(parseIdeaModalDraft('null')).toBeNull()
  })

  it('見出しのある古い下書きは、見出しを内容の1行目にまとめて読む', () => {
    expect(parseIdeaModalDraft('{"heading":"見出し","body":"内容"}')).toEqual({ body: '見出し\n内容' })
    expect(parseIdeaModalDraft('{"heading":"見出しだけ","body":""}')).toEqual({ body: '見出しだけ' })
    expect(parseIdeaModalDraft('{"heading":"","body":"内容"}')).toEqual({ body: '内容' })
    expect(parseIdeaModalDraft('{"body":"内容"}')).toEqual({ body: '内容' })
  })

  it('書く形は見出しが空（更新前の版の画面でも読める）。読み戻すと同じ内容', () => {
    const raw = serializeIdeaModalDraft('1行目\n2行目')
    expect(JSON.parse(raw)).toEqual({ heading: '', body: '1行目\n2行目' })
    expect(parseIdeaModalDraft(raw)).toEqual({ body: '1行目\n2行目' })
  })

  it('編集を始めた時の内容（base）も控えて読み戻す。base の無い古い下書き・文字列でない base は base 無し（2.8）', () => {
    const raw = serializeIdeaModalDraft('直した内容', '元の内容')
    expect(JSON.parse(raw)).toEqual({ heading: '', body: '直した内容', base: '元の内容' })
    expect(parseIdeaModalDraft(raw)).toEqual({ body: '直した内容', base: '元の内容' })
    // 空の base も控える（何も無い所から書き始めたもの）
    expect(parseIdeaModalDraft(serializeIdeaModalDraft('x', ''))).toEqual({ body: 'x', base: '' })
    expect(parseIdeaModalDraft('{"heading":"","body":"内容"}')).toEqual({ body: '内容' })
    expect(parseIdeaModalDraft('{"heading":"","body":"内容","base":3}')).toEqual({ body: '内容' })
    // 見出しのある古い下書きに base があっても、見出しは内容にまとめる
    expect(parseIdeaModalDraft('{"heading":"見出し","body":"内容","base":"元"}')).toEqual({ body: '見出し\n内容', base: '元' })
  })
})

describe('保存する内容（編集している間に届いた Claude の追記を残す。2.8）', () => {
  const BASE = '2026/11/12 14:32\u3000第3章の動機\n・兄を探す'
  const TAIL = '\n\n2026/11/13のセッションで以下の内容へ変更\n動機を変える'

  it('今の内容が始めた時のままなら、保存する内容のまま', () => {
    expect(rebaseIdeaEdit(BASE, `${BASE}\n作者の一行`, BASE)).toEqual({ body: `${BASE}\n作者の一行`, carried: false })
    expect(rebaseIdeaEdit(BASE, BASE, BASE)).toEqual({ body: BASE, carried: false })
  })

  it('始めた時の内容の後ろに追記が足されていれば、保存する内容の後ろに追記を残す', () => {
    const current = BASE + TAIL
    expect(rebaseIdeaEdit(BASE, `${BASE}\n作者の一行`, current)).toEqual({
      body: `${BASE}\n作者の一行${TAIL}`,
      carried: true,
    })
    // 保存する内容の終わりの空白は除いてからつなぐ（空行は1つ）
    expect(rebaseIdeaEdit(BASE, `作者が書き直した\n\n\u3000`, current)).toEqual({
      body: `作者が書き直した${TAIL}`,
      carried: true,
    })
    // 何も変えずに保存した時は、今の内容と同じになる（書き込まない）
    expect(rebaseIdeaEdit(BASE, BASE, current)).toEqual({ body: current, carried: true })
    // 2回の追記もまとめて残す
    const twice = `${current}\n\n2026/11/14のセッションで以下の内容へ変更\n二つ目`
    expect(rebaseIdeaEdit(BASE, 'x', twice).body).toBe(`x${twice.slice(BASE.length)}`)
  })

  it('保存する内容を空にした時は、追記だけ（先頭の空行は除く）', () => {
    expect(rebaseIdeaEdit(BASE, ' \n', BASE + TAIL)).toEqual({ body: TAIL.replace(/^\n+/, ''), carried: true })
  })

  it('ほかの変わり方（途中を直した・別の端末の書き換え）は、今までどおり保存する内容のまま', () => {
    expect(rebaseIdeaEdit(BASE, '作者', BASE.replace('兄', '弟'))).toEqual({ body: '作者', carried: false })
    expect(rebaseIdeaEdit(BASE, '作者', `${BASE}\n続き`)).toEqual({ body: '作者', carried: false })
    expect(rebaseIdeaEdit('', '作者', TAIL)).toEqual({ body: '作者', carried: false })
  })

  it('カードの印の文言', () => {
    expect(CLAUDE_IDEA_BADGE).toBe('Claude が作成')
  })
})
