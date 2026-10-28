import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../../db/persistence'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { AppFrame } from '../../../ui/Layout'
import { SettingsTab } from './SettingsTab'

let n = 0

function Location() {
  const loc = useLocation()
  return <output data-testid="location">{loc.pathname + loc.search}</output>
}

function renderTab(titleId: ID, search = '?tab=settings') {
  return render(
    <MemoryRouter initialEntries={[`/t/${titleId}${search}`]}>
      <AppFrame>
        <SettingsTab titleId={titleId} />
        <Location />
      </AppFrame>
    </MemoryRouter>,
  )
}

function categoryOf(titleId: ID, name: string): ID {
  return Object.values(getData().settingCategories).find((c) => c.titleId === titleId && c.name === name)!.id
}

beforeEach(async () => {
  await initStore(createPersistence(`test-db-settings-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
})

describe('設定タブ', () => {
  it('プリセットから項目を追加すると、名前とテンプレートが入って選ばれた状態になる', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    renderTab(titleId)
    expect(screen.getAllByTestId('category-item').map((b) => b.textContent)).toEqual(['キャラクター0', '世界観0'])
    expect(screen.getByTestId('category-title').textContent).toBe('キャラクター')

    await user.click(screen.getByTestId('add-category'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /魔法・技術/ }))
    expect(within(dialog).getByTestId<HTMLInputElement>('category-name-input').value).toBe('魔法・技術')
    // 名前は自由に書き換えられる（テンプレートはそのまま）
    await user.clear(within(dialog).getByTestId('category-name-input'))
    await user.type(within(dialog).getByTestId('category-name-input'), '魔導体系')
    await user.click(within(dialog).getByTestId('category-submit'))

    const id = categoryOf(titleId, '魔導体系')
    expect(getData().settingCategories[id].fieldTemplate).toEqual(['原理', '制約', '代償'])
    await waitFor(() => expect(screen.getByTestId('category-title').textContent).toBe('魔導体系'))
    expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}?tab=settings&cat=${id}`)
    expect(screen.getByTestId('template-keys').textContent).toBe('原理・制約・代償')
  })

  it('エントリを追加すると名前の欄にフォーカスし、名前とフィールドを保存できる', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    renderTab(titleId)
    await user.click(screen.getByTestId('add-entry'))
    const card = screen.getByTestId('entry-card')
    const name = within(card).getByTestId('entry-name')
    expect(document.activeElement).toBe(name)
    await user.type(name, 'ミナト{Enter}')
    const values = within(card).getAllByTestId('field-value')
    await user.type(values[1], '17')
    await user.tab()

    const entry = Object.values(getData().settingEntries)[0]
    expect(entry.name).toBe('ミナト')
    expect(entry.fields.find((f) => f.key === '年齢')?.value).toBe('17')
    expect(entry.fields).toHaveLength(7)

    // 畳むと要約が出る
    await user.click(within(card).getByTestId('entry-close'))
    expect(within(card).getByTestId('entry-summary').textContent).toBe('年齢：17')
  })

  it('フィールドの保存は保存時点の最新データから組み立て、他のフィールドの変更を上書きしない', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    const entryId = actions.addEntry(categoryOf(titleId, 'キャラクター'), '澪')
    renderTab(titleId)
    await user.click(screen.getByTestId('entry-toggle'))
    const values = screen.getAllByTestId('field-value')

    // 「読み」を入力中（まだ保存していない）のうちに、別の操作で「年齢」が保存される
    await user.type(values[0], 'みお')
    const [yomi, age] = getData().settingEntries[entryId].fields
    act(() =>
      actions.updateEntry(entryId, {
        fields: getData().settingEntries[entryId].fields.map((f) => (f.id === age.id ? { ...f, value: '26' } : f)),
      }),
    )
    await user.tab()

    const fields = getData().settingEntries[entryId].fields
    expect(fields.find((f) => f.id === yomi.id)?.value).toBe('みお')
    expect(fields.find((f) => f.id === age.id)?.value).toBe('26')
  })

  it('フィールドの追加・並べ替え・削除', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    const world = categoryOf(titleId, '世界観')
    const entryId = actions.addEntry(world, '浮遊大陸')
    renderTab(titleId, `?tab=settings&cat=${world}`)
    await user.click(screen.getByTestId('entry-toggle'))
    expect(screen.queryAllByTestId('entry-field')).toHaveLength(0)

    await user.click(screen.getByTestId('add-field'))
    expect(document.activeElement).toBe(screen.getAllByTestId('field-key')[0])
    await user.type(screen.getAllByTestId('field-key')[0], '高度')
    await user.click(screen.getByTestId('add-field'))
    await user.type(screen.getAllByTestId('field-key')[1], '人口')
    await user.tab()
    expect(getData().settingEntries[entryId].fields.map((f) => f.key)).toEqual(['高度', '人口'])

    // 並べ替え・削除はフィールドごとの「…」メニューから
    await user.click(screen.getAllByTestId('field-menu')[1])
    await user.click(screen.getByTestId('field-up'))
    expect(getData().settingEntries[entryId].fields.map((f) => f.key)).toEqual(['人口', '高度'])
    // 空のフィールドは確認なしで削除
    await user.click(screen.getAllByTestId('field-menu')[0])
    await user.click(screen.getByTestId('field-remove'))
    expect(getData().settingEntries[entryId].fields.map((f) => f.key)).toEqual(['高度'])
  })

  it('同じ行の項目名と内容の欄で key が重ならない（重複キーの警告を出さない）', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    actions.addEntry(categoryOf(titleId, 'キャラクター'), '澪')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderTab(titleId)
      await user.click(screen.getByTestId('entry-toggle'))
      expect(screen.getAllByTestId('entry-field')).toHaveLength(7)
      const duplicateKey = errors.mock.calls.filter((args) => args.some((a) => String(a).includes('same key')))
      expect(duplicateKey).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('キーボードだけでフィールドを続けて入力できる（Enter で内容へ、Tab は1行に3か所）', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    const entryId = actions.addEntry(categoryOf(titleId, 'キャラクター'), '澪')
    renderTab(titleId)
    await user.click(screen.getByTestId('entry-toggle'))
    const keys = () => screen.getAllByTestId('field-key')
    const values = () => screen.getAllByTestId('field-value')
    const menus = () => screen.getAllByTestId('field-menu')

    // 項目名で Enter → 同じ行の内容へ
    await user.click(keys()[0])
    await user.clear(keys()[0])
    await user.type(keys()[0], 'よみがな{Enter}')
    expect(document.activeElement).toBe(values()[0])
    await user.type(values()[0], 'みお')
    // 内容 → 「…」メニュー → 次の行の項目名
    await user.tab()
    expect(document.activeElement).toBe(menus()[0])
    await user.tab()
    expect(document.activeElement).toBe(keys()[1])
    await user.tab()
    expect(document.activeElement).toBe(values()[1])
    await user.type(values()[1], '26')
    await user.tab()
    const fields = getData().settingEntries[entryId].fields
    expect(fields[0]).toMatchObject({ key: 'よみがな', value: 'みお' })
    expect(fields[1]).toMatchObject({ key: '年齢', value: '26' })

    // メニューはキーボードで操作でき、並べ替えた後もその行のメニューにフォーカスが残る
    expect(document.activeElement).toBe(menus()[1])
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByTestId('field-up'))
    await user.keyboard('{ArrowDown}{Enter}')
    expect(getData().settingEntries[entryId].fields.slice(0, 3).map((f) => f.key)).toEqual(['よみがな', '性別', '年齢'])
    await waitFor(() => expect(document.activeElement).toBe(menus()[2]))
  })

  it('エントリの並べ替えと、別の項目への移動', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    const chara = categoryOf(titleId, 'キャラクター')
    const world = categoryOf(titleId, '世界観')
    actions.addEntry(chara, 'アオイ')
    const beni = actions.addEntry(chara, 'ベニ')
    renderTab(titleId)
    const names = () => screen.getAllByTestId('entry-name-label').map((e) => e.textContent)
    expect(names()).toEqual(['アオイ', 'ベニ'])

    await user.click(screen.getAllByTestId('entry-toggle')[1])
    expect(screen.getByTestId<HTMLButtonElement>('entry-down').disabled).toBe(true)
    await user.click(screen.getByTestId('entry-up'))
    expect(names()).toEqual(['ベニ', 'アオイ'])

    await user.selectOptions(screen.getByTestId('entry-move'), world)
    expect(getData().settingEntries[beni].categoryId).toBe(world)
    expect(names()).toEqual(['アオイ'])
    expect(screen.getAllByTestId('category-item')[1].textContent).toBe('世界観1')
  })

  it('項目の削除は確認し、中のエントリも消える', async () => {
    const user = userEvent.setup()
    const titleId = actions.createTitle('作品')
    const chara = categoryOf(titleId, 'キャラクター')
    actions.addEntry(chara, 'アオイ')
    renderTab(titleId)
    await user.click(screen.getByTestId('category-menu'))
    await user.click(screen.getByTestId('category-delete'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('エントリ（1件）もすべて削除されます')
    await user.click(within(dialog).getByRole('button', { name: '削除' }))
    expect(getData().settingCategories[chara]).toBeUndefined()
    expect(Object.values(getData().settingEntries)).toHaveLength(0)
    await waitFor(() => expect(screen.getByTestId('category-title').textContent).toBe('世界観'))
  })
})
