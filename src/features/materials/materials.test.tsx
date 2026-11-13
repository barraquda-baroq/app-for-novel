// 資料（2.6。内部名は materials）の画面: ホームの棚（カード・追加・並べ替え・削除・検索の欄・タグのチップ・件数・タグを管理）、
// 資料の画面（タグ・項目ごとの記録・開閉・全文・足す・直す・削除・手動の依頼文・貼り付け）。相対比較（bench.test.tsx）と同じ確かめ。
// タグは作者が付けて管理する（Claude は付けない）
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shortId } from '../../claude/refs'
import { createPersistence } from '../../db/persistence'
import { listTrash } from '../../domain/trash'
import type { ID, MaterialNote } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { copyText } from '../../ui/browser'
import { AppFrame } from '../../ui/Layout'
import { MaterialShelf, resetMaterialShelfForTests } from '../home/MaterialShelf'
import { MaterialPage } from './MaterialPage'

vi.mock('../../ui/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ui/browser')>()
  return { ...original, copyText: vi.fn(async () => true) }
})

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-materials-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  resetMaterialShelfForTests()
  vi.mocked(copyText).mockClear()
})

/** 資料と記録（作った時刻をずらす） */
function seedMaterial(): ID {
  const materialId = actions.addMaterial({
    name: '江戸の町と暮らし',
    author: '山田',
    year: '2019',
    tags: ['歴史', '江戸'],
    pdfPlace: 'プロジェクト「資料」',
  })
  const at = (section: string, body: string, runDate: string, createdAt: number) => {
    const id = actions.addMaterialNote(materialId, { section, body, runDate })
    // 作った時刻を決める（項目のまとまりの順は、決まった4つの後は最初に記録した時刻）
    const data = getData()
    data.materialNotes[id] = { ...data.materialNotes[id], createdAt } as MaterialNote
    return id
  }
  at('年表', '## 年表\n- 1603 開府', '2026-10-05', 1)
  at('要約', '## 要約\n町の成り立ち。', '2026-10-01', 2)
  const paragraphs = Array.from({ length: 30 }, (_, i) => `段落${i + 1}。${'あ'.repeat(200)}`).join('\n\n')
  at('創作に役立つ知識', `## 知識\n長屋の間取り。\n\n${paragraphs}\n\n最後の一文。`, '2026-10-02', 3)
  at('要約', '## 要約（読み直し）\n火事と町の作り直し。', '2026-10-20', 4)
  return materialId
}

function renderShelf() {
  return render(
    <MemoryRouter>
      <AppFrame>
        <MaterialShelf headingId="h" />
      </AppFrame>
    </MemoryRouter>,
  )
}

function renderPage(materialId: ID) {
  const router = createMemoryRouter(
    [
      {
        path: '/materials/:materialId',
        element: (
          <AppFrame>
            <MaterialPage />
          </AppFrame>
        ),
      },
      { path: '/', element: <p data-testid="home-route">ホーム</p> },
    ],
    { initialEntries: [`/materials/${materialId}`] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const cardNames = () => screen.getAllByTestId('material-card').map((c) => within(c).getByTestId('material-card-name').textContent)

describe('ホームの棚「資料」', () => {
  it('資料名・書誌・記録の数と項目をカードに出し、足す・並べ替え・削除（ゴミ箱へ）ができる', async () => {
    const user = userEvent.setup()
    const materialId = seedMaterial()
    renderShelf()
    const card = screen.getByTestId('material-card')
    expect(within(card).getByTestId('material-card-name').textContent).toBe('江戸の町と暮らし')
    expect(within(card).getByTestId('material-card-biblio').textContent).toBe('山田・2019')
    expect(
      within(card)
        .getAllByTestId('material-card-tag')
        .map((t) => t.textContent),
    ).toEqual(['歴史', '江戸'])
    expect(within(card).getByTestId('material-card-tags').textContent).toBe('タグ: 歴史江戸')
    expect(within(card).getByTestId('material-card-count').textContent).toBe('記録 4件')
    // 決まった4つの順、その後にほかの項目
    expect(
      within(card)
        .getAllByTestId('material-card-section')
        .map((c) => c.textContent),
    ).toEqual(['要約2', '創作に役立つ知識', '年表'])
    expect(within(card).getByTestId('material-card-link').getAttribute('href')).toBe(`/materials/${materialId}`)
    // 見出しは帯の開け閉めのボタン（2.9。中は名前と件数）。名前は `-name` の部分
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('資料1件')
    expect(document.getElementById('h-name')?.textContent).toBe('資料')
    expect(screen.getByTestId('material-count').textContent).toBe('1')

    // 資料を追加（資料名は必須）
    expect(screen.getByTestId('new-material').textContent).toBe('資料を追加')
    await user.click(screen.getByTestId('new-material'))
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe('資料を追加')
    expect(screen.getByTestId('material-save').textContent).toBe('追加')
    await user.click(screen.getByTestId('material-save'))
    expect(screen.getByRole('alert').textContent).toBe('資料名を入れてください')
    await user.type(screen.getByTestId('material-name'), '和食の基本')
    await user.type(screen.getByTestId('material-author'), '鈴木')
    // タグは「、」で区切って足す（打ちかけのタグも保存に入る）。使っているタグを候補に出す
    const dialog0 = screen.getByTestId('material-dialog')
    expect(
      within(dialog0)
        .getAllByTestId('material-tag-suggestion')
        .map((b) => b.textContent),
    ).toEqual(['江戸', '歴史'])
    await user.type(within(dialog0).getByTestId('material-tag-input'), '料理、和食')
    expect(
      within(dialog0)
        .getAllByTestId('material-tag-chip-edit')
        .map((c) => c.textContent),
    ).toEqual(['料理'])
    await user.click(screen.getByTestId('material-save'))
    await waitFor(() => expect(screen.getAllByTestId('material-card')).toHaveLength(2))
    expect(Object.values(getData().materials).find((m) => m.name === '和食の基本')).toMatchObject({
      author: '鈴木',
      tags: ['料理', '和食'],
    })

    // 並べ替え
    await user.click(screen.getByTestId('material-edit-toggle'))
    await user.click(within(screen.getAllByTestId('material-card')[1]).getByTestId('material-up'))
    expect(cardNames()).toEqual(['和食の基本', '江戸の町と暮らし'])
    // 位置を選んで移動
    await user.click(within(screen.getAllByTestId('material-card')[1]).getByTestId('material-move'))
    await user.selectOptions(screen.getByTestId('material-move-target'), '0')
    await user.click(screen.getByTestId('material-move-submit'))
    await waitFor(() => expect(cardNames()).toEqual(['江戸の町と暮らし', '和食の基本']))

    // 削除（確かめてからゴミ箱へ。記録もいっしょに）
    await user.click(within(screen.getAllByTestId('material-card')[0]).getByTestId('material-delete'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「江戸の町と暮らし」を削除しますか？')
    expect(dialog.textContent).toContain('この資料を資料の棚から削除し、記録（4件）もいっしょにゴミ箱に移します。')
    expect(dialog.textContent).toContain('PDF そのものは claude.ai のプロジェクトにあるので、消えません。')
    await user.click(within(dialog).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(cardNames()).toEqual(['和食の基本']))
    expect(getData().materials[materialId]).toBeUndefined()
    expect(Object.values(getData().materialNotes)).toHaveLength(0)
    expect(listTrash(getData().trashEntries)[0]).toMatchObject({ kind: 'material', label: '江戸の町と暮らし' })
  })

  it('棚が空の時は説明と「資料を追加」（検索の欄は出さない）', () => {
    renderShelf()
    expect(screen.getByTestId('material-empty').textContent).toContain('PDF は claude.ai のプロジェクトに置いたまま')
    expect(within(screen.getByTestId('material-empty')).getByRole('button').textContent).toBe('資料を追加')
    expect(screen.getByTestId('material-count').textContent).toBe('0')
    expect(screen.queryByTestId('material-search')).toBeNull()
    expect(screen.queryByTestId('material-edit-toggle')).toBeNull()
  })

  it('検索の欄（資料名・著者・タグ・メモの部分一致）・タグのチップ（押すと絞る。いくつか選ぶとすべて持つ資料）・件数「n件／全N件」・解除', async () => {
    const user = userEvent.setup()
    actions.addMaterial({ name: '現代の特殊部隊', author: '山田', tags: ['ミリタリ', '現代', '戦闘'], note: '突入の手順' })
    actions.addMaterial({ name: '外科の歴史', author: '佐藤', tags: ['医療', '歴史'] })
    const sword = actions.addMaterial({ name: 'SWORD 図鑑', author: 'Smith', tags: ['武器', '戦闘'] })
    actions.addMaterial({ name: '戦国の城', author: '田中', tags: ['歴史', '戦闘'] })
    actions.addMaterial({ name: '和食の基本', author: '鈴木' })
    renderShelf()
    expect(cardNames()).toHaveLength(5)
    expect(screen.getByTestId('material-filter-count').textContent).toBe('')
    expect(screen.queryByTestId('material-filter-clear')).toBeNull()
    expect(screen.queryByTestId('material-tags-clear')).toBeNull()

    // タグのチップは使っているタグだけ（多い順、同じなら名前の順）。どれも選んでいない
    const chips = () => screen.getAllByTestId('material-tag-chip')
    const chip = (tag: string) => chips().find((c) => c.getAttribute('data-tag') === tag)!
    expect(chips().map((c) => c.textContent)).toEqual(['戦闘3件', '歴史2件', 'ミリタリ1件', '医療1件', '現代1件', '武器1件'])
    expect(chips().every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(screen.getByRole('group', { name: 'タグで絞る（選んだタグをすべて持つ資料だけ）' })).toBeTruthy()

    // 検索（全角と半角・大文字と小文字の違いは問わない）
    const search = screen.getByTestId('material-search')
    await user.type(search, 'ｓｗｏｒｄ')
    await waitFor(() => expect(cardNames()).toEqual(['SWORD 図鑑']))
    expect(screen.getByTestId('material-filter-count').textContent).toBe('1件／全5件')
    await user.clear(search)
    // メモ・著者・タグも探す
    await user.type(search, '突入')
    await waitFor(() => expect(cardNames()).toEqual(['現代の特殊部隊']))
    await user.clear(search)
    await user.type(search, '歴史')
    await waitFor(() => expect(cardNames()).toEqual(['外科の歴史', '戦国の城']))
    expect(screen.getByTestId('material-filter-count').textContent).toBe('2件／全5件')
    await user.clear(search)
    await waitFor(() => expect(cardNames()).toHaveLength(5))

    // タグのチップで絞る。いくつか選ぶと、選んだタグをすべて持つ資料だけ。もう一度押すと外す
    await user.click(chip('戦闘'))
    expect(chip('戦闘').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(cardNames()).toEqual(['現代の特殊部隊', 'SWORD 図鑑', '戦国の城']))
    expect(screen.getByTestId('material-filter-count').textContent).toBe('3件／全5件')
    await user.click(chip('歴史'))
    await waitFor(() => expect(cardNames()).toEqual(['戦国の城']))
    expect(screen.getByTestId('material-filter-count').textContent).toBe('1件／全5件')
    await user.click(chip('戦闘'))
    expect(chip('戦闘').getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(cardNames()).toEqual(['外科の歴史', '戦国の城']))
    // 検索の語と合わせて絞る
    await user.type(search, '城')
    await waitFor(() => expect(cardNames()).toEqual(['戦国の城']))
    // タグの選択だけを解除（検索の語は残す）
    await user.click(screen.getByTestId('material-tags-clear'))
    await waitFor(() => expect(chip('歴史').getAttribute('aria-pressed')).toBe('false'))
    expect(cardNames()).toEqual(['戦国の城'])
    expect((screen.getByTestId('material-search') as HTMLInputElement).value).toBe('城')

    // 当てはまるものが無い時と、解除
    await user.click(chip('医療'))
    await waitFor(() => expect(screen.getByTestId('material-no-match').textContent).toContain('当てはまる資料がありません'))
    expect(screen.getByTestId('material-filter-count').textContent).toBe('0件／全5件')
    await user.click(screen.getByTestId('material-filter-clear'))
    await waitFor(() => expect(cardNames()).toHaveLength(5))
    expect((screen.getByTestId('material-search') as HTMLInputElement).value).toBe('')
    expect(chips().every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(screen.getByTestId('material-filter-count').textContent).toBe('')
    expect(screen.queryByTestId('material-filter-clear')).toBeNull()

    // 絞り込みは、資料の画面から戻ってきても同じ（この起動の間）
    await user.click(chip('武器'))
    await waitFor(() => expect(cardNames()).toEqual(['SWORD 図鑑']))
    cleanup()
    renderShelf()
    expect(cardNames()).toEqual(['SWORD 図鑑'])
    expect(chip('武器').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('material-filter-count').textContent).toBe('1件／全5件')

    // 選んだタグの資料が無くなったら、そのタグは絞り込みから外す。タグが1つも無ければチップの代わりに案内
    actions.deleteMaterial(sword)
    await waitFor(() => expect(cardNames()).toHaveLength(4))
    expect(screen.getByTestId('material-filter-count').textContent).toBe('')
    for (const m of Object.values(getData().materials)) actions.setMaterialTags(m.id, [])
    await waitFor(() => expect(screen.queryByTestId('material-tags')).toBeNull())
    expect(screen.getByTestId('material-tags-hint').textContent).toContain('タグ（ミリタリ・現代など）を付けると')
  })

  it('タグが多い時は12個まで出し、「すべてのタグ」で全部（選んでいるタグはいつも出す）', async () => {
    const user = userEvent.setup()
    for (let i = 0; i < 15; i++) actions.addMaterial({ name: `資料${i + 1}`, tags: [`タグ${String(i + 1).padStart(2, '0')}`] })
    renderShelf()
    const chips = () => screen.getAllByTestId('material-tag-chip')
    expect(chips()).toHaveLength(12)
    const more = screen.getByTestId('material-tags-more')
    expect(more.textContent).toBe('すべてのタグ（15）')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await user.click(more)
    expect(chips()).toHaveLength(15)
    await user.click(chips()[14])
    await waitFor(() => expect(cardNames()).toEqual(['資料15']))
    await user.click(screen.getByTestId('material-tags-more'))
    expect(chips()).toHaveLength(13)
    expect(chips()[12].getAttribute('data-tag')).toBe('タグ15')
  })

  it('タグを管理: タグごとの件数。名前を変える（すべての資料で。もうあるタグならまとめる）・削除（確かめてから、すべての資料から外す）', async () => {
    const user = userEvent.setup()
    const a = actions.addMaterial({ name: '現代の特殊部隊', tags: ['ミリタリー', '現代'] })
    const b = actions.addMaterial({ name: '戦場の医療', tags: ['ミリタリ', '医療', 'ミリタリー'.normalize('NFD')] })
    const c = actions.addMaterial({ name: '戦国の城', tags: ['ミリタリー', '歴史'] })
    renderShelf()
    // 絞り込んでいるタグの名前を変えても、絞り込みは続く
    const chip = (tag: string) => screen.getAllByTestId('material-tag-chip').find((x) => x.getAttribute('data-tag') === tag)
    await user.click(chip('歴史')!)
    await waitFor(() => expect(cardNames()).toEqual(['戦国の城']))
    await user.click(screen.getByTestId('material-manage-tags-open'))
    const dialog = await screen.findByTestId('material-manage-tags')
    const rows = () => within(dialog).getAllByTestId('material-manage-tag')
    const row = (tag: string) => rows().find((r) => r.getAttribute('data-tag') === tag)!
    expect(rows().map((r) => r.textContent?.replace(/名前を変える|削除/g, ''))).toEqual([
      'ミリタリー3件',
      'ミリタリ1件',
      '医療1件',
      '現代1件',
      '歴史1件',
    ])

    // 名前を変える（すべての資料で付け替え）
    await user.click(within(row('歴史')).getByTestId('material-manage-rename'))
    const prompt = await screen.findByRole('dialog', { name: 'タグ「歴史」の名前を変える' })
    const input = within(prompt).getByRole('textbox')
    await user.clear(input)
    await user.type(input, '戦国')
    await user.click(within(prompt).getByRole('button', { name: '名前を変える' }))
    await waitFor(() => expect(getData().materials[c].tags).toEqual(['ミリタリー', '戦国']))
    expect(row('戦国')).toBeTruthy()
    expect(cardNames()).toEqual(['戦国の城'])
    expect(chip('戦国')?.getAttribute('aria-pressed')).toBe('true')

    // もうあるタグの名前にすると、確かめてからまとめる（両方が付いた資料では1つに）
    await user.click(within(row('ミリタリー')).getByTestId('material-manage-rename'))
    const prompt2 = await screen.findByRole('dialog', { name: 'タグ「ミリタリー」の名前を変える' })
    await user.clear(within(prompt2).getByRole('textbox'))
    await user.type(within(prompt2).getByRole('textbox'), 'ﾐﾘﾀﾘ')
    await user.click(within(prompt2).getByRole('button', { name: '名前を変える' }))
    const merge = await screen.findByRole('dialog', { name: 'タグ「ミリタリ」にまとめますか？' })
    expect(merge.textContent).toContain('タグ「ミリタリ」はもう1件の資料に付いています')
    await user.click(within(merge).getByRole('button', { name: 'まとめる' }))
    await waitFor(() => expect(getData().materials[a].tags).toEqual(['ミリタリ', '現代']))
    expect(getData().materials[b].tags).toEqual(['ミリタリ', '医療'])
    expect(getData().materials[c].tags).toEqual(['ミリタリ', '戦国'])
    expect(row('ミリタリ').textContent).toContain('3件')

    // 削除は確かめてから（やめれば何もしない）
    await user.click(within(row('ミリタリ')).getByTestId('material-manage-delete'))
    const cancel = await screen.findByRole('dialog', { name: 'タグ「ミリタリ」を削除しますか？' })
    expect(cancel.textContent).toContain('3件の資料からタグ「ミリタリ」を外します。資料とその記録は消えません')
    await user.click(within(cancel).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'タグ「ミリタリ」を削除しますか？' })).toBeNull())
    expect(getData().materials[a].tags).toEqual(['ミリタリ', '現代'])
    await user.click(within(row('ミリタリ')).getByTestId('material-manage-delete'))
    const confirm = await screen.findByRole('dialog', { name: 'タグ「ミリタリ」を削除しますか？' })
    await user.click(within(confirm).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(getData().materials[a].tags).toEqual(['現代']))
    expect(getData().materials[b].tags).toEqual(['医療'])
    expect(getData().materials[c].tags).toEqual(['戦国'])
    expect(Object.keys(getData().materials)).toHaveLength(3)
    expect(rows().map((r) => r.getAttribute('data-tag'))).toEqual(['医療', '現代', '戦国'])
    // 絞り込んでいたタグを削除すると、絞り込みから外す
    await user.click(within(row('戦国')).getByTestId('material-manage-delete'))
    await user.click(
      within(await screen.findByRole('dialog', { name: 'タグ「戦国」を削除しますか？' })).getByRole('button', { name: '削除' }),
    )
    await waitFor(() => expect(cardNames()).toHaveLength(3))
    expect('tags' in getData().materials[c]).toBe(false)
  })

  it('絞り込んでいる時の並べ替えは、見えている資料の間で動かす', async () => {
    const user = userEvent.setup()
    actions.addMaterial({ name: '江戸の町', tags: ['歴史'] })
    actions.addMaterial({ name: '外科', tags: ['医療'] })
    actions.addMaterial({ name: '戦国の城', tags: ['歴史'] })
    renderShelf()
    await user.click(screen.getAllByTestId('material-tag-chip')[0])
    await waitFor(() => expect(cardNames()).toEqual(['江戸の町', '戦国の城']))
    await user.click(screen.getByTestId('material-edit-toggle'))
    const cards = () => screen.getAllByTestId('material-card')
    expect((within(cards()[0]).getByTestId('material-up') as HTMLButtonElement).disabled).toBe(true)
    expect((within(cards()[1]).getByTestId('material-down') as HTMLButtonElement).disabled).toBe(true)
    // 戦国の城を上へ: 見えていない「外科」を越えて、江戸の町の前へ
    await user.click(within(cards()[1]).getByTestId('material-up'))
    await waitFor(() => expect(cardNames()).toEqual(['戦国の城', '江戸の町']))
    const order = Object.values(getData().materials)
      .sort((a, b) => a.order - b.order)
      .map((m) => m.name)
    expect(order).toEqual(['戦国の城', '江戸の町', '外科'])
    // 下へ: 江戸の町の後ろへ
    await user.click(within(cards()[0]).getByTestId('material-down'))
    await waitFor(() => expect(cardNames()).toEqual(['江戸の町', '戦国の城']))
    expect(
      Object.values(getData().materials)
        .sort((a, b) => a.order - b.order)
        .map((m) => m.name),
    ).toEqual(['江戸の町', '戦国の城', '外科'])
  })
})

describe('資料の画面', () => {
  it('項目ごと（決まった4つの順・まだ無い項目も出す・ほかの項目は後ろ）・中は新しい日付から。開閉し、長い記録は「全文を表示」', async () => {
    const user = userEvent.setup()
    const materialId = seedMaterial()
    renderPage(materialId)
    expect(screen.getByTestId('material-title').textContent).toBe('江戸の町と暮らし')
    expect(document.title).toContain('資料: 江戸の町と暮らし')
    expect(screen.getByRole('link', { name: '資料' }).getAttribute('href')).toBe('/?view=materials')
    expect(screen.getByTestId('material-edit').textContent).toBe('資料の情報を直す')
    expect(screen.getByTestId('material-biblio').textContent).toBe('山田・2019')
    expect(screen.getAllByTestId('material-tag').map((t) => t.textContent)).toEqual(['歴史', '江戸'])
    expect(screen.getByTestId('material-edit-tags').textContent).toBe('タグを編集')
    expect(screen.getByTestId('material-pdf-place').textContent).toBe('プロジェクト「資料」')
    const groups = screen.getAllByTestId('material-group')
    expect(groups.map((g) => g.getAttribute('data-section'))).toEqual([
      '要約',
      '創作に役立つ知識',
      '描写に使える部分',
      'サンプルシーン',
      '年表',
    ])
    expect(
      within(groups[0])
        .getAllByTestId('material-note-date-label')
        .map((d) => d.textContent),
    ).toEqual(['2026/10/20', '2026/10/01'])
    // まだ記録の無い決まった項目
    expect(within(groups[2]).getByTestId('material-group-empty').textContent).toContain('まだ記録がありません')
    expect(within(groups[3]).queryByTestId('material-note')).toBeNull()

    // 閉じている時は見本だけ
    const long = within(groups[1]).getByTestId('material-note')
    expect(within(long).queryByTestId('material-note-body')).toBeNull()
    await user.click(within(long).getByTestId('material-note-toggle'))
    expect(within(long).getByTestId('material-note-toggle').getAttribute('aria-expanded')).toBe('true')
    const body = await within(long).findByTestId('material-note-body')
    expect(body.textContent).not.toContain('最後の一文')
    await user.click(within(long).getByTestId('material-note-more'))
    await waitFor(() => expect(within(long).getByTestId('material-note-body').textContent).toContain('最後の一文'))
    // コピー
    await user.click(within(long).getByTestId('material-note-copy'))
    expect(vi.mocked(copyText).mock.calls[0][0]).toContain('最後の一文')
    // 閉じる・すべて開く
    await user.click(within(long).getByTestId('material-note-toggle'))
    expect(within(long).queryByTestId('material-note-body')).toBeNull()
    await user.click(screen.getByTestId('material-toggle-all'))
    expect(screen.getAllByTestId('material-note-body')).toHaveLength(4)
  })

  it('記録を追加（項目の候補）・直す・削除（ゴミ箱へ）。まだ無い項目からも足せる', async () => {
    const user = userEvent.setup()
    const materialId = seedMaterial()
    renderPage(materialId)
    await user.click(screen.getByTestId('material-add-note'))
    const dialog = await screen.findByTestId('material-note-dialog')
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe('記録を追加')
    // 決まった4つの後に、使ったことのある項目
    expect(
      within(dialog)
        .getAllByTestId('material-note-suggestion')
        .map((c) => c.textContent),
    ).toEqual(['要約', '創作に役立つ知識', '描写に使える部分', 'サンプルシーン', '年表'])
    await user.click(screen.getByTestId('material-note-save'))
    expect(screen.getByRole('alert').textContent).toBe('項目を入れてください（要約・創作に役立つ知識など）')
    await user.click(within(dialog).getByRole('button', { name: '描写に使える部分' }))
    await user.type(within(dialog).getByTestId('material-note-input'), '- 木戸の閉まる音')
    await user.click(screen.getByTestId('material-note-save'))
    const group = () =>
      screen.getAllByTestId('material-group').find((g) => g.getAttribute('data-section') === '描写に使える部分')!
    await waitFor(() => expect(within(group()).getAllByTestId('material-note')).toHaveLength(1))
    // 足した記録は開いている
    const added = within(group()).getByTestId('material-note')
    expect(within(added).getByTestId('material-note-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(Object.values(getData().materialNotes).find((n) => n.section === '描写に使える部分')?.source).toBe('manual')

    // 直す
    await user.click(within(added).getByTestId('material-note-edit'))
    const edit = await screen.findByTestId('material-note-dialog')
    const body = within(edit).getByTestId('material-note-input')
    await user.clear(body)
    await user.type(body, '直した記録')
    await user.click(screen.getByTestId('material-note-save'))
    await waitFor(() =>
      expect(Object.values(getData().materialNotes).find((n) => n.section === '描写に使える部分')?.body).toBe('直した記録'),
    )

    // 削除
    await user.click(within(added).getByTestId('material-note-delete'))
    const confirm = await screen.findByRole('dialog')
    expect(confirm.textContent).toContain('「描写に使える部分」の記録を削除しますか？')
    await user.click(within(confirm).getByRole('button', { name: '削除' }))
    await waitFor(() =>
      expect(Object.values(getData().materialNotes).find((n) => n.section === '描写に使える部分')).toBeUndefined(),
    )
    expect(listTrash(getData().trashEntries)[0]).toMatchObject({ kind: 'materialNote', parentLabel: '江戸の町と暮らし' })

    // まだ記録の無い項目の「この項目の記録を追加」は、その項目を入れて開く
    const scene = screen.getAllByTestId('material-group').find((g) => g.getAttribute('data-section') === 'サンプルシーン')!
    await user.click(within(scene).getByTestId('material-group-add'))
    const preset = await screen.findByTestId('material-note-dialog')
    expect((within(preset).getByTestId('material-note-section') as HTMLInputElement).value).toBe('サンプルシーン')
  })

  it('Claude に頼む（手動）: 項目を選んで依頼文をコピーし、貼り付けで記録を追加（2回目は増えない。ほかのツールは受け付けない）', async () => {
    const user = userEvent.setup()
    const materialId = seedMaterial()
    renderPage(materialId)
    await user.click(screen.getByTestId('material-manual'))
    const dialog = await screen.findByTestId('material-manual-dialog')
    // 既定は決まった4つ（使ったことのある項目は選ばずに出す）
    const sections = () => within(dialog).getAllByTestId('material-manual-section')
    expect(sections().map((c) => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['要約', 'true'],
      ['創作に役立つ知識', 'true'],
      ['描写に使える部分', 'true'],
      ['サンプルシーン', 'true'],
      ['年表', 'false'],
    ])
    expect(screen.getByTestId('material-manual-copy').textContent).toBe('依頼文をコピー（項目 4つ）')
    // 要約を外し、項目を足す
    await user.click(within(dialog).getByRole('button', { name: '要約' }))
    await user.type(within(dialog).getByTestId('material-manual-new-section'), '用語集')
    await user.click(within(dialog).getByTestId('material-manual-add-section'))
    expect(screen.getByTestId('material-manual-copy').textContent).toBe('依頼文をコピー（項目 4つ）')
    await user.click(within(dialog).getByTestId('material-manual-copy'))
    const prompt = vi.mocked(copyText).mock.calls[0][0]
    expect(prompt).toContain('このプロジェクトのナレッジにある資料『江戸の町と暮らし』（山田）の PDF')
    expect(prompt).toContain('- 創作に役立つ知識: 小説の設定・展開・人物に使えそうな知識')
    expect(prompt).toContain('- サンプルシーン: ')
    expect(prompt).toContain('- 用語集')
    expect(prompt).not.toContain('- 要約:')
    expect(prompt).not.toContain('- 年表')
    expect(prompt).toContain(`"material":"${shortId('material', materialId)}"`)
    expect(screen.getByTestId('material-manual-prompt').textContent).toBe(prompt)

    await user.click(screen.getByTestId('material-manual-open-paste'))
    const paste = await screen.findByTestId('paste-dialog')
    expect(paste.textContent).toContain('この資料の記録として残します。')
    const answer = [
      '記録しました。',
      '```novel-studio-v1',
      JSON.stringify({
        tool: 'novel_add_material_notes',
        input: {
          material: 'd:xxxx',
          items: [{ section: 'サンプルシーン', body_markdown: '## 場面\n木戸が閉まる。', run_date: '2026-11-01' }],
        },
      }),
      '```',
    ].join('\n')
    await user.click(within(paste).getByTestId('paste-input'))
    await user.paste(answer)
    await waitFor(() => expect(screen.getByTestId('paste-add').textContent).toBe('追加（1件）'))
    await user.click(screen.getByTestId('paste-add'))
    const scene = () => screen.getAllByTestId('material-group').find((g) => g.getAttribute('data-section') === 'サンプルシーン')!
    await waitFor(() => expect(within(scene()).getAllByTestId('material-note')).toHaveLength(1))
    const created = Object.values(getData().materialNotes).find((n) => n.section === 'サンプルシーン')
    expect(created).toMatchObject({ source: 'paste', materialId })
    // 同じ答えをもう一度
    await user.click(screen.getByTestId('material-paste'))
    const again = await screen.findByTestId('paste-dialog')
    await user.click(within(again).getByTestId('paste-input'))
    await user.paste(answer)
    await waitFor(() => expect(within(again).getByTestId('paste-summary').textContent).toBe('重複 1件'))
    expect((screen.getByTestId('paste-add') as HTMLButtonElement).disabled).toBe(true)
    // 相対比較の分析の答えは受け付けない
    await user.clear(within(again).getByTestId('paste-input'))
    await user.paste(
      [
        '```novel-studio-v1',
        JSON.stringify({
          tool: 'novel_add_bench_analysis',
          input: { work: 'w:xxxx', items: [{ viewpoint: '構成', body_markdown: 'x' }] },
        }),
        '```',
      ].join('\n'),
    )
    await waitFor(() => expect(within(again).getByTestId('paste-error').textContent).toContain('資料に記録を追加'))
  })

  it('資料を削除するとゴミ箱へ移り、ホームの棚へ戻る。無い資料は「見つかりません」', async () => {
    const user = userEvent.setup()
    const materialId = seedMaterial()
    const router = renderPage(materialId)
    await user.click(screen.getByTestId('material-delete'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「江戸の町と暮らし」を削除しますか？')
    expect(dialog.textContent).toContain('PDF そのものは claude.ai のプロジェクトにあるので、消えません。')
    await user.click(within(dialog).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(router.state.location.search).toBe('?view=materials'))
    expect(listTrash(getData().trashEntries)[0]).toMatchObject({ kind: 'material', label: '江戸の町と暮らし' })
    cleanup()
    renderPage('gone')
    expect(screen.getByText('資料が見つかりません。削除された可能性があります。')).toBeTruthy()
    expect(screen.getByRole('link', { name: '資料の一覧へ' }).getAttribute('href')).toBe('/?view=materials')
  })

  it('記録が無い時は案内。Claude が作った資料には「Claude が作成」の札（手で足した資料には出さない）', () => {
    const materialId = actions.addMaterial({ name: '和食の基本' })
    renderPage(materialId)
    expect(screen.getByTestId('material-notes-empty').textContent).toContain('まだ記録がありません。')
    expect(screen.getByTestId('material-notes-empty').textContent).toContain(
      '「この資料を読んで、要約・創作に役立つ知識・描写に使える部分・サンプルシーンを資料に追加して」',
    )
    expect(screen.queryByTestId('material-group')).toBeNull()
    expect(screen.queryByTestId('material-toggle-all')).toBeNull()
    expect(screen.getByTestId('material-pdf-place').textContent).toBe('（未記入）')
    expect(screen.queryByTestId('material-source')).toBeNull()
    cleanup()
    for (const [source, label] of [
      ['claude', 'Claude が作成'],
      ['paste', 'Claude（貼り付け）が作成'],
    ] as const) {
      const data = getData()
      data.materials[materialId] = { ...data.materials[materialId], source }
      renderPage(materialId)
      expect(screen.getByTestId('material-source').textContent).toBe(label)
      cleanup()
    }
  })

  it('資料の情報を直す（タグも直せる。使っているタグを候補に出す）', async () => {
    const user = userEvent.setup()
    const materialId = seedMaterial()
    actions.addMaterial({ name: '外科の歴史', tags: ['医療', '歴史'] })
    renderPage(materialId)
    await user.click(screen.getByTestId('material-edit'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading').textContent).toBe('資料の情報を直す')
    expect(
      within(dialog)
        .getAllByTestId('material-tag-chip-edit')
        .map((c) => c.textContent),
    ).toEqual(['歴史', '江戸'])
    // 候補は使っているタグのうち、まだ付けていないもの
    expect(
      within(dialog)
        .getAllByTestId('material-tag-suggestion')
        .map((b) => b.textContent),
    ).toEqual(['医療'])
    await user.click(within(dialog).getByRole('button', { name: 'タグ「医療」を付ける' }))
    await user.click(within(dialog).getByRole('button', { name: 'タグ「歴史」を外す' }))
    expect(document.activeElement).toBe(within(dialog).getByTestId('material-tag-input'))
    await user.type(screen.getByTestId('material-publisher'), '町の出版')
    await user.type(screen.getByTestId('material-memo'), '長屋の場面に使う')
    await user.click(screen.getByTestId('material-save'))
    await waitFor(() => expect(screen.getByTestId('material-biblio').textContent).toBe('山田・町の出版・2019'))
    expect(screen.getAllByTestId('material-tag').map((t) => t.textContent)).toEqual(['江戸', '医療'])
    expect(screen.getByTestId('material-note-text').textContent).toBe('長屋の場面に使う')
  })

  it('タグを編集: Enter・「、」・「,」で足し、×・Backspace で外す。20字・20個を超える分は足さない。保存するまで変えない', async () => {
    const user = userEvent.setup()
    const materialId = actions.addMaterial({ name: '現代の特殊部隊', author: '山田' })
    actions.addMaterial({ name: '戦国の城', tags: ['戦闘', '歴史'] })
    renderPage(materialId)
    expect(screen.getByTestId('material-no-tags').textContent).toBe('タグなし')
    expect(screen.getByTestId('material-edit-tags').textContent).toBe('タグを付ける')
    await user.click(screen.getByTestId('material-edit-tags'))
    const dialog = await screen.findByTestId('material-tags-dialog')
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe('「現代の特殊部隊」のタグ')
    const input = within(dialog).getByTestId('material-tag-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(within(dialog).getByLabelText('タグ')).toBe(input)
    const tags = () =>
      within(dialog)
        .queryAllByTestId('material-tag-chip-edit')
        .map((c) => c.textContent)
    await user.type(input, 'ミリタリ{Enter}')
    expect(tags()).toEqual(['ミリタリ'])
    expect(input.value).toBe('')
    await user.type(input, '現代,ﾐﾘﾀﾘ、 戦')
    expect(tags()).toEqual(['ミリタリ', '現代'])
    expect(input.value).toBe(' 戦')
    // 候補は打っている途中の文字を含むものだけ
    expect(
      within(dialog)
        .getAllByTestId('material-tag-suggestion')
        .map((b) => b.textContent),
    ).toEqual(['戦闘'])
    await user.click(within(dialog).getByTestId('material-tag-suggestion'))
    expect(tags()).toEqual(['ミリタリ', '現代', '戦闘'])
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    // 空の入力欄で Backspace は最後のタグを外す
    await user.type(input, '{Backspace}')
    expect(tags()).toEqual(['ミリタリ', '現代'])
    // 20字を超えるタグは足さない
    await user.type(input, `${'あ'.repeat(21)}{Enter}`)
    expect(within(dialog).getByTestId('material-tag-error').textContent).toContain('タグは20字までにしてください')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(tags()).toEqual(['ミリタリ', '現代'])
    // 打ち直すと理由は消える
    await user.type(input, '突入')
    expect(within(dialog).queryByTestId('material-tag-error')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBeNull()
    // 閉じると何も変えない
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
    expect('tags' in getData().materials[materialId]).toBe(false)

    // 保存（打ちかけのタグも入る）
    await user.click(screen.getByTestId('material-edit-tags'))
    const again = await screen.findByTestId('material-tags-dialog')
    await user.type(within(again).getByTestId('material-tag-input'), 'ミリタリ、現代、特殊部隊')
    await user.click(screen.getByTestId('material-tags-save'))
    await waitFor(() => expect(getData().materials[materialId].tags).toEqual(['ミリタリ', '現代', '特殊部隊']))
    expect(screen.getAllByTestId('material-tag').map((t) => t.textContent)).toEqual(['ミリタリ', '現代', '特殊部隊'])
    expect(screen.getByTestId('material-edit-tags').textContent).toBe('タグを編集')

    // 20個まで（それより多くは足さず、足せなかったタグは入力欄に残し、入力欄は読むだけにする（フォーカスは残る））
    await user.click(screen.getByTestId('material-edit-tags'))
    const full = await screen.findByTestId('material-tags-dialog')
    const many = Array.from({ length: 18 }, (_, i) => `t${i + 1}`).join('、')
    const fullInput = within(full).getByTestId('material-tag-input') as HTMLInputElement
    await user.click(fullInput)
    await user.paste(`${many}、`)
    expect(within(full).getAllByTestId('material-tag-chip-edit')).toHaveLength(20)
    expect(within(full).getByTestId('material-tag-error').textContent).toBe('タグは1つの資料に20個までです')
    expect(fullInput.value).toBe('t18')
    expect(fullInput.readOnly).toBe(true)
    expect(fullInput.disabled).toBe(false)
    // 20個のまま保存しようとすると、残ったタグを足せないので保存しない
    await user.click(screen.getByTestId('material-tags-save'))
    expect(screen.getByTestId('material-tags-dialog')).toBeTruthy()
    expect(getData().materials[materialId].tags).toHaveLength(3)
    // ×で外すと、また足せる（フォーカスは入力欄に戻る）
    await user.click(within(full).getByRole('button', { name: 'タグ「t17」を外す' }))
    expect(fullInput.readOnly).toBe(false)
    expect(document.activeElement).toBe(fullInput)
    await user.click(screen.getByTestId('material-tags-save'))
    await waitFor(() => expect(getData().materials[materialId].tags).toHaveLength(20))
    expect(getData().materials[materialId].tags).toContain('t18')
    expect(getData().materials[materialId].tags).not.toContain('t17')
  })

  it('20字を超えるタグは足さず、入力欄に残して保存しない（Enter でも［保存］でも）', async () => {
    const user = userEvent.setup()
    const materialId = actions.addMaterial({ name: '現代の特殊部隊', author: '山田' })
    renderPage(materialId)
    await user.click(await screen.findByTestId('material-edit-tags'))
    const dialog = await screen.findByTestId('material-tags-dialog')
    const input = within(dialog).getByTestId('material-tag-input') as HTMLInputElement
    const long = '第二次世界大戦期の特殊作戦部隊の装備と戦術'
    expect(Array.from(long).length).toBeGreaterThan(20)
    await user.type(input, `${long}{Enter}`)
    expect(within(dialog).getByTestId('material-tag-error').textContent).toContain('タグは20字までにしてください')
    expect(input.value).toBe(long)
    await user.click(screen.getByTestId('material-tags-save'))
    expect(screen.getByTestId('material-tags-dialog')).toBeTruthy()
    expect(getData().materials[materialId].tags ?? []).toEqual([])
    // 短くすれば足せる
    await user.clear(input)
    await user.type(input, '特殊部隊')
    await user.click(screen.getByTestId('material-tags-save'))
    await waitFor(() => expect(getData().materials[materialId].tags).toEqual(['特殊部隊']))
  })
})
