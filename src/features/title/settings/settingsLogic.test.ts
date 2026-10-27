import { describe, expect, it } from 'vitest'
import type { SettingField } from '../../../domain/types'
import {
  addMissingTemplateFields,
  appendField,
  CATEGORY_PRESETS,
  entrySummary,
  moveField,
  parseTemplate,
  patchField,
  removeField,
} from './settingsLogic'

const fields = (): SettingField[] => [
  { id: 'a', key: '読み', value: 'みお' },
  { id: 'b', key: '年齢', value: '' },
  { id: 'c', key: '性格', value: '穏やか\nだが頑固' },
]

describe('設定項目のプリセット', () => {
  it('依頼どおりの名前とテンプレートを持つ', () => {
    const byName = Object.fromEntries(CATEGORY_PRESETS.map((p) => [p.name, p.fieldTemplate]))
    expect(byName['キャラクター']).toEqual(['読み', '年齢', '性別', '立場・役割', '性格', '外見', '背景'])
    expect(byName['世界観']).toEqual([])
    expect(byName['用語集']).toEqual(['読み', '意味'])
    expect(byName['地理・地名']).toEqual(['読み', '概要'])
    expect(byName['組織・勢力']).toEqual(['目的', '構成員', '拠点'])
    expect(byName['歴史・年表']).toEqual(['時期', '出来事'])
    expect(byName['魔法・技術']).toEqual(['原理', '制約', '代償'])
    expect(byName['アイテム']).toEqual(['所有者', '効果', '由来'])
  })
})

describe('テンプレートの入力', () => {
  it('1行に1つ。前後の空白・空行・重複は除く', () => {
    expect(parseTemplate(' 読み \n\n年齢\r\n読み\n  \n二つ名')).toEqual(['読み', '年齢', '二つ名'])
    expect(parseTemplate('')).toEqual([])
  })
})

describe('エントリの要約', () => {
  it('入力済みのフィールドを「キー：値」で並べ、改行は空白にまとめる', () => {
    expect(entrySummary({ fields: fields(), body: '本文' })).toBe('読み：みお ／ 性格：穏やか だが頑固')
  })

  it('フィールドが空なら自由記述の冒頭、長ければ省略する', () => {
    expect(entrySummary({ fields: [{ id: 'x', key: '読み', value: ' ' }], body: '  祖母の\n蔵書 ' })).toBe('祖母の 蔵書')
    expect(entrySummary({ fields: [], body: 'あ'.repeat(100) }, 10)).toBe(`${'あ'.repeat(10)}…`)
    expect(entrySummary({ fields: [], body: '' })).toBe('')
  })

  it('項目名のないフィールドは値だけを出す', () => {
    expect(entrySummary({ fields: [{ id: 'x', key: ' ', value: 'メモ' }], body: '' })).toBe('メモ')
  })
})

describe('フィールドの配列操作', () => {
  it('patchField は id で探して書き換え、変化がなければ null', () => {
    const f = fields()
    expect(patchField(f, 'b', { value: '26' })?.map((x) => x.value)).toEqual(['みお', '26', '穏やか\nだが頑固'])
    expect(patchField(f, 'b', { value: '' })).toBeNull()
    expect(patchField(f, 'zzz', { value: '1' })).toBeNull()
    // 元の配列は変えない
    expect(f[1].value).toBe('')
  })

  it('moveField は端では null', () => {
    expect(moveField(fields(), 'c', -1)?.map((x) => x.id)).toEqual(['a', 'c', 'b'])
    expect(moveField(fields(), 'a', -1)).toBeNull()
    expect(moveField(fields(), 'c', 1)).toBeNull()
  })

  it('removeField / appendField', () => {
    expect(removeField(fields(), 'b')?.map((x) => x.id)).toEqual(['a', 'c'])
    expect(removeField(fields(), 'nope')).toBeNull()
    const r = appendField(fields(), '口癖')
    expect(r.fields).toHaveLength(4)
    expect(r.fields[3]).toEqual({ id: r.fieldId, key: '口癖', value: '' })
  })

  it('addMissingTemplateFields は足りない項目だけを末尾に足す', () => {
    const next = addMissingTemplateFields(fields(), ['読み', '二つ名', '性格', '出身'])
    expect(next?.map((x) => x.key)).toEqual(['読み', '年齢', '性格', '二つ名', '出身'])
    expect(next?.[0]).toEqual(fields()[0])
    expect(addMissingTemplateFields(fields(), ['読み'])).toBeNull()
  })
})
