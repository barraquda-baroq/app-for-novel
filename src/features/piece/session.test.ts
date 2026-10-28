// 原稿画面の編集セッション: 保存するまでストアに入れない・保存・破棄・競合・巻き戻し・端末内の控え
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPieceEdits } from '../../domain/pieceEdits'
import { updateVersion } from '../../domain/storyOps'
import type { AppData } from '../../domain/types'
import { createTitle } from '../../domain/entityOps'
import { addEpisode } from '../../domain/storyOps'
import { emptyData } from '../../domain/types'
import { draftKey, readCrashDraft, removeCrashDraft, resolveCrashDraft, writeCrashDraft } from './crashDraft'
import { EditSession, parseFieldKey, pieceField, versionField } from './session'
import { describeEdits, storedFieldValue } from './usePieceSession'

const caret = (n: number) => ({ start: n, end: n })
const opts = { conflictName: (n: string) => `${n}（競合: この端末での編集）` }

function setup() {
  let data: AppData = emptyData()
  const t = createTitle(data, '作品')
  data = t.data
  const e = addEpisode(data, t.result)
  data = e.data
  const pieceId = e.result
  const v1 = data.pieces[pieceId].versionIds[0]
  data = updateVersion(data, v1, { body: '元の本文' })
  return { data, pieceId, v1 }
}

/** 末尾に打つ */
function typeAt(s: EditSession, key: string, stored: string, text: string, at: number) {
  const before = s.display(key, stored)
  s.change(key, stored, {
    value: before + text,
    selBefore: caret(before.length),
    selAfter: caret(before.length + text.length),
    inputType: 'insertText',
    at,
  })
}

describe('項目の名前', () => {
  it('稿と話の項目を作り、読み戻せる', () => {
    expect(parseFieldKey(versionField('v1', 'body'))).toEqual({ target: 'version', id: 'v1', field: 'body' })
    expect(parseFieldKey(pieceField('p1', 'subtitle'))).toEqual({ target: 'piece', id: 'p1', field: 'subtitle' })
    expect(parseFieldKey('version:v1:nope')).toBeNull()
    expect(parseFieldKey('piece:p1:body')).toBeNull()
    expect(parseFieldKey('garbage')).toBeNull()
  })
})

describe('編集セッション', () => {
  it('編集はセッションの中だけで持ち、保存すると base と一緒に書き込む', () => {
    const { data, pieceId, v1 } = setup()
    const s = new EditSession(pieceId)
    const key = versionField(v1, 'body')
    const listener = vi.fn()
    s.subscribe(listener)
    expect(s.isDirty()).toBe(false)
    typeAt(s, key, '元の本文', '。追記', 0)
    expect(s.isDirty()).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(s.display(key, '元の本文')).toBe('元の本文。追記')
    expect(s.pendingEdits()).toEqual([{ target: 'version', id: v1, field: 'body', base: '元の本文', value: '元の本文。追記' }])

    const edits = s.pendingEdits()
    const r = applyPieceEdits(data, pieceId, edits, opts)
    expect(r.data.versions[v1].body).toBe('元の本文。追記')
    s.markSaved(edits)
    expect(s.isDirty()).toBe(false)
    // 保存した後も、続けて巻き戻せる（保存先の値と表示が同じ）
    const u = s.undo(key, r.data.versions[v1].body)
    expect(u?.value).toBe('元の本文')
    expect(s.isDirty()).toBe(true)
    expect(s.field(key)?.edit?.base).toBe('元の本文。追記')
  })

  it('編集を始めた時の値に戻ったら、編集なしと同じ', () => {
    const s = new EditSession('p')
    const key = pieceField('p', 'subtitle')
    typeAt(s, key, '', 'あ', 0)
    expect(s.isDirty()).toBe(true)
    s.change(key, '', { value: '', selBefore: caret(1), selAfter: caret(0), inputType: 'deleteContentBackward', at: 10 })
    expect(s.isDirty()).toBe(false)
    expect(s.display(key, '')).toBe('')
  })

  it('base は編集を始めた時の保存先の値。編集中に保存先が変わっても base は変えない（保存の時に競合を見つける）', () => {
    const { data, pieceId, v1 } = setup()
    const s = new EditSession(pieceId)
    const key = versionField(v1, 'body')
    typeAt(s, key, '元の本文', 'A', 0)
    // 同期で別の端末の本文が届いた（表示はこの端末の編集のまま）
    const remote = updateVersion(data, v1, { body: '別の端末の本文' })
    typeAt(s, key, '別の端末の本文', 'B', 50)
    expect(s.display(key, '別の端末の本文')).toBe('元の本文AB')
    expect(s.field(key)?.edit?.base).toBe('元の本文')
    const edits = s.pendingEdits()
    const r = applyPieceEdits(remote, pieceId, edits, opts)
    expect(r.data.versions[v1].body).toBe('別の端末の本文')
    expect(r.result.conflicts).toHaveLength(1)
    // 競合した本文は保存先の値を表示し直し、履歴も捨てる
    s.markSaved(edits, new Set([key]))
    expect(s.isDirty()).toBe(false)
    expect(s.display(key, r.data.versions[v1].body)).toBe('別の端末の本文')
    expect(s.canUndo(key)).toBe(false)
  })

  it('破棄すると、すべての項目が保存先の値に戻り、履歴も消える', () => {
    const s = new EditSession('p')
    typeAt(s, versionField('v', 'body'), '本文', 'を足す', 0)
    typeAt(s, versionField('v', 'name'), '第1稿', '改', 0)
    const rev = s.namesRevision()
    s.discard()
    expect(s.isDirty()).toBe(false)
    expect(s.display(versionField('v', 'body'), '本文')).toBe('本文')
    expect(s.canUndo(versionField('v', 'body'))).toBe(false)
    expect(s.namesRevision()).toBeGreaterThan(rev)
  })

  it('巻き戻し・進むは項目ごと。日本語入力は変換中の値を履歴に積まず、確定した時に1手にする', () => {
    const s = new EditSession('p')
    const body = versionField('v', 'body')
    const note = versionField('v', 'note')
    typeAt(s, body, '', 'あいう', 0)
    typeAt(s, note, '', 'メモ', 0)
    // 変換中
    s.setValue(body, '', 'あいうかん')
    s.setValue(body, '', 'あいう漢')
    expect(s.field(body)?.history.undo).toHaveLength(1)
    // 確定
    s.change(body, '', { before: 'あいう', value: 'あいう漢字', selBefore: caret(3), selAfter: caret(5), kind: 'ime', at: 100 })
    expect(s.field(body)?.history.undo).toHaveLength(2)
    expect(s.undo(body, '')?.value).toBe('あいう')
    expect(s.display(note, '')).toBe('メモ')
    expect(s.redo(body, '')?.value).toBe('あいう漢字')
    expect(s.undo(note, '')?.value).toBe('')
    expect(s.display(body, '')).toBe('あいう漢字')
  })

  it('編集中に保存先が変わった後で、書き始めの値まで巻き戻しても、別の端末の本文に切り替えず「進む」で戻せる', () => {
    const s = new EditSession('p')
    const key = versionField('v', 'body')
    typeAt(s, key, 'A', 'abc', 0)
    // 同期で別の端末の本文 X が届いた（表示はこの端末の編集のまま）
    expect(s.display(key, 'X')).toBe('Aabc')
    expect(s.undo(key, 'X')?.value).toBe('A')
    expect(s.display(key, 'X')).toBe('A')
    expect(s.isDirty()).toBe(true)
    expect(s.redo(key, 'X')?.value).toBe('Aabc')
    expect(s.display(key, 'X')).toBe('Aabc')
    // 打ち消して書き始めの値に戻しても同じ
    s.change(key, 'X', { value: 'A', selBefore: caret(4), selAfter: caret(1), inputType: 'deleteContentBackward', at: 5000 })
    expect(s.display(key, 'X')).toBe('A')
    expect(s.isDirty()).toBe(true)
    // 保存先の値と同じにしたら、編集なし
    s.change(key, 'X', { value: 'X', selBefore: { start: 0, end: 1 }, selAfter: caret(1), inputType: 'insertText', at: 9000 })
    expect(s.isDirty()).toBe(false)
    expect(s.display(key, 'X')).toBe('X')
  })

  it('保存先の値が別の操作で変わって表示が変わったら、それまでの履歴は捨てる', () => {
    const s = new EditSession('p')
    const key = versionField('v', 'name')
    typeAt(s, key, '第1稿', '改', 0)
    s.undo(key, '第1稿')
    // 編集していない間に、保存先の名前が別の端末で変わった
    expect(s.redo(key, '別の名前')).toBeNull()
    expect(s.canRedo(key)).toBe(false)
  })

  it('稿の名前を変えると namesRevision が増える（比較の選択肢を描き直す）', () => {
    const s = new EditSession('p')
    const rev = s.namesRevision()
    typeAt(s, versionField('v', 'body'), '', 'あ', 0)
    expect(s.namesRevision()).toBe(rev)
    typeAt(s, versionField('v', 'name'), '', 'あ', 0)
    expect(s.namesRevision()).toBe(rev + 1)
  })
})

describe('端末内の控え（アプリが落ちた時のため）', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('控えて読み戻し、base ごと復元する', () => {
    const { data, pieceId, v1 } = setup()
    const s = new EditSession(pieceId)
    typeAt(s, versionField(v1, 'body'), '元の本文', '。続き', 0)
    typeAt(s, pieceField(pieceId, 'subtitle'), '', '旅立ち', 0)
    expect(writeCrashDraft(pieceId, s.edits(), s.owner, 1234)).toBe(true)
    const draft = readCrashDraft(pieceId)!
    expect(draft.at).toBe(1234)
    const edits = resolveCrashDraft(draft, (k) => storedFieldValue(data, pieceId, k))
    expect(edits).toEqual(s.edits())
    expect(describeEdits(data, edits)).toBe('第1稿の本文・話の題')

    const restored = new EditSession(pieceId)
    restored.restore(edits)
    expect(restored.isDirty()).toBe(true)
    expect(restored.display(versionField(v1, 'body'), '元の本文')).toBe('元の本文。続き')
    // 復元した編集は保存できる
    const r = applyPieceEdits(data, pieceId, restored.pendingEdits(), opts)
    expect(r.data.versions[v1].body).toBe('元の本文。続き')
    expect(r.data.pieces[pieceId].subtitle).toBe('旅立ち')
  })

  it('もう保存されている項目は復元しない', () => {
    const { data, pieceId, v1 } = setup()
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: '前の本文', value: '元の本文' } })
    const edits = resolveCrashDraft(readCrashDraft(pieceId)!, (k) => storedFieldValue(data, pieceId, k))
    expect(edits).toEqual({})
  })

  it('控えた後で保存先が変わっていたら、復元した編集を保存する時に競合として別の稿に残す', () => {
    const { data: d0, pieceId, v1 } = setup()
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: '元の本文', value: 'この端末の本文' } })
    const data = updateVersion(d0, v1, { body: '別の端末の本文' })
    const edits = resolveCrashDraft(readCrashDraft(pieceId)!, (k) => storedFieldValue(data, pieceId, k))
    const s = new EditSession(pieceId)
    s.restore(edits)
    const r = applyPieceEdits(data, pieceId, s.pendingEdits(), opts)
    expect(r.data.versions[v1].body).toBe('別の端末の本文')
    expect(r.data.versions[r.result.conflicts[0].newVersionId].body).toBe('この端末の本文')
  })

  it('容量が足りない時は、長い base を指紋だけにして控える。指紋が合えば保存先の値を base にする', () => {
    const { data, pieceId, v1 } = setup()
    const long = 'あ'.repeat(300)
    const d = updateVersion(data, v1, { body: long })
    const real = Storage.prototype.setItem
    let calls = 0
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      calls += 1
      if (calls === 1) throw new DOMException('quota', 'QuotaExceededError')
      real.call(this, k, v)
    })
    try {
      expect(writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: long, value: `${long}い` } })).toBe(true)
    } finally {
      spy.mockRestore()
    }
    const draft = readCrashDraft(pieceId)!
    expect(draft.edits[versionField(v1, 'body')].base).toBeUndefined()
    expect(draft.edits[versionField(v1, 'body')].baseHash).toBeTruthy()
    const same = resolveCrashDraft(draft, (k) => storedFieldValue(d, pieceId, k))
    expect(same[versionField(v1, 'body')].base).toBe(long)
    // 保存先が変わっていたら、base は保存先と違う値になる（保存の時に競合として扱う）
    const changed = resolveCrashDraft(draft, () => '別の本文')
    expect(changed[versionField(v1, 'body')].base).not.toBe('別の本文')
  })

  it('壊れた控えは読まずに消す。編集がなければ控えを消す', () => {
    localStorage.setItem(draftKey('p'), '{壊れた')
    expect(readCrashDraft('p')).toBeNull()
    expect(localStorage.getItem(draftKey('p'))).toBeNull()
    writeCrashDraft('p', { [pieceField('p', 'subtitle')]: { base: '', value: 'あ' } })
    expect(readCrashDraft('p')).not.toBeNull()
    writeCrashDraft('p', {})
    expect(localStorage.getItem(draftKey('p'))).toBeNull()
    writeCrashDraft('p', { [pieceField('p', 'subtitle')]: { base: '', value: 'あ' } })
    removeCrashDraft('p')
    expect(readCrashDraft('p')).toBeNull()
  })

  it('稿が削除されていても、本文・稿の名前・推敲メモを復元する（保存すると新しい稿になる）。話が無ければ話の題は戻さない', () => {
    const { data, pieceId } = setup()
    writeCrashDraft(pieceId, {
      [versionField('gone', 'body')]: { base: '', value: '消えた稿の本文', label: '第2稿' },
      [versionField('gone', 'name')]: { base: '第2稿', value: '改' },
      [versionField('gone', 'note')]: { base: '', value: '消えた稿のメモ', label: '第2稿' },
      [pieceField('gone-piece', 'subtitle')]: { base: '', value: '題' },
    })
    const edits = resolveCrashDraft(readCrashDraft(pieceId)!, () => undefined)
    expect(Object.keys(edits).sort()).toEqual(
      [versionField('gone', 'body'), versionField('gone', 'name'), versionField('gone', 'note')].sort(),
    )
    expect(edits[versionField('gone', 'body')].label).toBe('第2稿')
    // 保存すると、名前とメモも一緒に新しい稿として残る
    const s = new EditSession(pieceId)
    s.restore(edits)
    const r = applyPieceEdits(data, pieceId, s.pendingEdits(), opts)
    expect(r.result.dropped).toEqual([])
    expect(r.data.versions[r.result.conflicts[0].newVersionId]).toMatchObject({
      name: '改（競合: この端末での編集）',
      body: '消えた稿の本文',
      note: '消えた稿のメモ',
    })
  })

  it('推敲メモだけの控えも、稿が削除されていれば復元する', () => {
    const { pieceId } = setup()
    writeCrashDraft(pieceId, { [versionField('gone', 'note')]: { base: '', value: 'メモだけ', label: '第2稿' } })
    const edits = resolveCrashDraft(readCrashDraft(pieceId)!, () => undefined)
    expect(edits).toEqual({ [versionField('gone', 'note')]: { base: '', value: 'メモだけ', label: '第2稿' } })
  })

  it('控えには書いた画面の印（owner）を入れ、消す時は自分の控えだけを消す', () => {
    const { pieceId } = setup()
    const edits = { [pieceField(pieceId, 'subtitle')]: { base: '', value: 'あ' } }
    writeCrashDraft(pieceId, edits, 'tab-a', 10)
    expect(readCrashDraft(pieceId)).toMatchObject({ owner: 'tab-a', at: 10 })
    // 別のタブ（tab-b）が保存・破棄しても、tab-a の控えは消さない
    removeCrashDraft(pieceId, 'tab-b')
    expect(readCrashDraft(pieceId)?.owner).toBe('tab-a')
    writeCrashDraft(pieceId, {}, 'tab-b')
    expect(readCrashDraft(pieceId)?.owner).toBe('tab-a')
    removeCrashDraft(pieceId, 'tab-a')
    expect(readCrashDraft(pieceId)).toBeNull()
    // 持ち主の印の無い古い控えは、どの画面からでも消せる
    writeCrashDraft(pieceId, edits)
    expect(readCrashDraft(pieceId)?.owner).toBeUndefined()
    removeCrashDraft(pieceId, 'tab-b')
    expect(readCrashDraft(pieceId)).toBeNull()
  })
})
