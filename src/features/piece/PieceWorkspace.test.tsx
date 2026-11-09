// 原稿画面のコンポーネントテスト（jsdom）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useAppUpdate, usePrefs, useToasts } from '../../store/uiStore'
import { useSync } from '../../sync/controller'
import { closeTopLayer } from '../../platform/nativeInit'
import { cancelAllDialogs } from '../../ui/dialogs'
import { AppFrame } from '../../ui/Layout'
import { draftKey, ownerLockName, readCrashDraft, writeCrashDraft } from './crashDraft'
import { JUMP_SHEET_QUERY } from './logic'
import { PieceWorkspace } from './PieceWorkspace'
import { pieceField, versionField } from './session'

// 差分の計算が「いつ」行われるかを数える（描画の中で計算していないことを確かめる）
const diffCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../domain/diff', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../domain/diff')>()
  return {
    ...mod,
    diffTexts: (base: string, target: string) => {
      diffCalls.count += 1
      return mod.diffTexts(base, target)
    },
  }
})

let n = 0

function seed(): { titleId: ID; pieceId: ID; v1: ID; v2: ID } {
  const titleId = actions.createTitle('差分の作品')
  const pieceId = actions.addEpisode(titleId)
  const v1 = getData().pieces[pieceId].versionIds[0]
  actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。' })
  const v2 = actions.addVersion(pieceId, { body: '春は曙。\nようやく白くなっていく山際。' })
  return { titleId, pieceId, v1, v2 }
}

/** 現在地の表示と、ブラウザの「戻る／進む」の代わり */
function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(-1)}>
        ブラウザで戻る
      </button>
      <button type="button" onClick={() => navigate(1)}>
        ブラウザで進む
      </button>
    </>
  )
}

/** 原稿画面は画面を離れる前の確認に useBlocker を使うので、アプリと同じくデータルーターで描く */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <AppFrame>
            <Outlet />
            <LocationProbe />
          </AppFrame>
        ),
        children: [
          { path: '/t/:titleId/p/:pieceId', element: <PieceWorkspace /> },
          { path: '/t/:titleId', element: <p data-testid="title-page">タイトル</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(async () => {
  diffCalls.count = 0
  await initStore(createPersistence(`test-db-piece-${++n}`))
})

afterEach(() => {
  cancelAllDialogs()
  cleanup()
  resetStoreForTests()
  usePrefs.getState().setPrefs({ showDiff: false })
  useToasts.setState({ toasts: [] })
  useAppUpdate.setState({ ready: false, apply: null })
  useSync.setState({ auth: 'idle', status: null, leader: false, everSignedIn: false })
  Reflect.deleteProperty(navigator, 'locks')
  localStorage.clear()
})

/** 別のタブが持っている（開いている）控えの持ち主のロックを、Web Locks の代わりに用意する */
function fakeLocks(heldOwners: string[]) {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: () => new Promise(() => {}),
      query: async () => ({ held: heldOwners.map((o) => ({ name: ownerLockName(o), mode: 'exclusive' })), pending: [] }),
    },
  })
}

const bodyOf = (versionId: ID) => getData().versions[versionId]?.body
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message)

describe('差分表示', () => {
  it('採用原稿が保存・同期で変わっても描画の中では差分を計算せず、少し待ってからまとめて計算し直す', async () => {
    const { titleId, pieceId, v1, v2 } = seed()
    usePrefs.getState().setPrefs({ showDiff: true })
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)

    const view = await screen.findByTestId('diff-view')
    await waitFor(() => expect(view.querySelector('.diff-add')).not.toBeNull())
    const initial = diffCalls.count
    expect(initial).toBe(1)

    // 採用原稿の保存（別の端末の編集が続けて届いた時など）
    act(() => actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。\n紫だちたる雲。' }))
    act(() => actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。\n紫だちたる雲の細く。' }))
    act(() => actions.updateVersion(v1, { body: '春は曙。\nやうやう白くなりゆく山際。\n紫だちたる雲の細くたなびきたる。' }))
    // 描画では計算しない（前回の差分を「計算中」として出しておく）
    expect(diffCalls.count).toBe(initial)
    expect(screen.getByTestId('diff-stale').textContent).toBe('差分を計算中…')

    // 落ち着いたら1回だけ計算し直す
    await waitFor(() => expect(screen.getByTestId('diff-stale').textContent).toBe(''))
    expect(diffCalls.count).toBe(initial + 1)
    expect(view.textContent).toContain('紫だちたる雲の細くたなびきたる。')
    expect(within(view).getByText(/紫だちたる雲の細くたなびきたる/).tagName).toBe('DEL')
  })

  it('別のバージョンに切り替えた時は、前のバージョンの差分を出さない', async () => {
    const { titleId, pieceId, v2 } = seed()
    const v3 = actions.addVersion(pieceId, { body: 'まったく別の書き出し。' })
    usePrefs.getState().setPrefs({ showDiff: true })
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const view = await screen.findByTestId('diff-view')
    await waitFor(() => expect(view.querySelector('.diff-add')).not.toBeNull())

    fireEvent.change(screen.getByTestId('version-select'), { target: { value: v3 } })
    expect(view.textContent).toBe('差分を計算中…')
    await waitFor(() => expect(view.querySelector('.diff-add')?.textContent).toContain('まったく別の書き出し'))
  })
})

describe('推敲バージョンの削除', () => {
  it('応募の記録に使われている稿は、確認文でそのことを知らせる', async () => {
    const { titleId, pieceId, v1 } = seed()
    const submissionId = actions.addSubmission(titleId, '星降る文学賞')
    actions.recordSubmissionSnapshot(submissionId)
    // 採用中の第1稿を選んで削除しようとする
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v1}`)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('delete-version'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('この稿は「星降る文学賞」の応募時の原稿として記録されています。')
    expect(dialog.textContent).toContain('削除しても応募時の原稿は残ります。')
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  })
})

describe('比較を開く・閉じる', () => {
  it('一覧から開いた比較は履歴に積み（戻るで一覧へ）、バージョンの切り替えは積まない', async () => {
    const { titleId, pieceId, v1, v2 } = seed()
    const list = `/t/${titleId}/p/${pieceId}`
    renderAt(list)
    const user = userEvent.setup()
    const location = () => screen.getByTestId('location').textContent
    const rows = await screen.findAllByTestId('version-row')
    await user.click(within(rows[0]).getByRole('button', { name: /を開いて比較する/ }))
    expect(location()).toBe(`${list}?v=${v2}`)
    await user.selectOptions(screen.getByTestId('version-select'), v1)
    expect(location()).toBe(`${list}?v=${v1}`)

    // ブラウザ・Android の「戻る」で一覧に戻る（切り替える前のバージョンには戻らない）
    await user.click(screen.getByRole('button', { name: 'ブラウザで戻る' }))
    expect(location()).toBe(list)
    expect(screen.getByTestId('versions-heading')).toBeTruthy()

    // 「進む」で比較に戻り、「一覧」ボタンは積んだ履歴を戻る
    await user.click(screen.getByRole('button', { name: 'ブラウザで進む' }))
    expect(location()).toBe(`${list}?v=${v1}`)
    await user.click(screen.getByTestId('back-to-list'))
    expect(location()).toBe(list)
    await user.click(screen.getByRole('button', { name: 'ブラウザで進む' }))
    expect(location()).toBe(`${list}?v=${v1}`)
  })

  it('URL で直接開いた比較の「一覧」は、履歴を戻らずに一覧を表示する', async () => {
    const { titleId, pieceId, v2 } = seed()
    const list = `/t/${titleId}/p/${pieceId}`
    renderAt(`${list}?v=${v2}`)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('back-to-list'))
    expect(screen.getByTestId('location').textContent).toBe(list)
    expect(screen.getByTestId('versions-heading')).toBeTruthy()
  })
})

describe('保存ボタン', () => {
  it('本文・話の題の編集は「保存」を押すまでストアに入れず、押すとまとめて書き込む', async () => {
    const { titleId, pieceId, v1 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = await screen.findByTestId('active-editor')
    expect(screen.getByTestId('save-button')).toHaveProperty('disabled', true)
    expect(screen.queryByTestId('unsaved-badge')).toBeNull()

    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}')
    await user.keyboard('紫だちたる雲')
    await user.type(screen.getByTestId('subtitle-input'), '春')
    expect(screen.getByTestId('unsaved-badge').textContent).toBe('未保存')
    expect(screen.getByTestId('save-button')).toHaveProperty('disabled', false)
    // ヘッダーの「保存済み」は出さない
    expect(document.querySelector('.save-status')).toBeNull()
    expect(bodyOf(v1)).toBe('春は曙。\nやうやう白くなりゆく山際。')
    expect(getData().pieces[pieceId].subtitle).toBe('')
    // 文字数は編集中の本文で数える
    expect(screen.getByTestId('active-count').textContent).toContain('23字')

    await user.click(screen.getByTestId('save-button'))
    expect(bodyOf(v1)).toBe('春は曙。\nやうやう白くなりゆく山際。紫だちたる雲')
    expect(getData().pieces[pieceId].subtitle).toBe('春')
    expect(screen.queryByTestId('unsaved-badge')).toBeNull()
    await waitFor(() => expect(toastTexts()).toContain('保存しました'))
  })

  it('「破棄」は確かめてから、保存した時の内容に戻す', async () => {
    const { titleId, pieceId, v1 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    await user.type(editor, '書きかけ')
    await user.click(screen.getByTestId('discard-button'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('保存していない編集を破棄しますか？')
    // 特殊ブロックの見出しも、捨てる編集に入る
    expect(dialog.textContent).toContain('（本文・稿の名前・推敲メモ・話の題・見出し）')
    await user.click(within(dialog).getByRole('button', { name: '破棄' }))
    expect(editor.value).toBe(bodyOf(v1))
    expect(screen.queryByTestId('unsaved-badge')).toBeNull()
    expect(localStorage.getItem(draftKey(pieceId))).toBeNull()
  })

  it('別の端末の編集が届いていたら、本文は上書きせずにこの端末の本文を新しい稿として残す', async () => {
    const { titleId, pieceId, v1 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    await user.type(editor, '（この端末）')
    // 同期で別の端末の本文が届いた（表示はこの端末の編集のまま）
    act(() => actions.updateVersion(v1, { body: '別の端末で書き直した本文' }))
    expect(editor.value).toContain('（この端末）')
    await user.click(screen.getByTestId('save-button'))
    expect(bodyOf(v1)).toBe('別の端末で書き直した本文')
    const ids = getData().pieces[pieceId].versionIds
    expect(ids).toHaveLength(3)
    const copy = getData().versions[ids[2]]
    expect(copy.name).toBe('第1稿（競合: ブラウザでの編集）')
    expect(copy.body).toContain('（この端末）')
    expect(editor.value).toBe('別の端末で書き直した本文')
    await waitFor(() =>
      expect(toastTexts()).toContain(
        '別の端末で「第1稿」が書き換えられていたため、この端末の本文を「第1稿（競合: ブラウザでの編集）」として残しました',
      ),
    )
  })

  it('採用・追加・削除などの前に、保存していない編集を保存するか聞く', async () => {
    const { titleId, pieceId, v1 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '足した')
    await user.click(screen.getByTestId('add-blank-version'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('保存していない編集があります。保存してから続けますか？')
    // キャンセル: 何もしない
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(getData().pieces[pieceId].versionIds).toHaveLength(2)
    expect(bodyOf(v1)).not.toContain('足した')
    // 保存して続ける
    await user.click(screen.getByTestId('add-blank-version'))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存して続ける' }))
    expect(bodyOf(v1)).toContain('足した')
    await waitFor(() => expect(getData().pieces[pieceId].versionIds).toHaveLength(3))
  })

  it('保存していない編集があるまま別の画面へ移ろうとすると確かめる（キャンセル・保存して移動・保存せずに移動）', async () => {
    const { titleId, pieceId, v1 } = seed()
    const { router } = renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const location = () => screen.getByTestId('location').textContent
    await user.type(await screen.findByTestId('active-editor'), 'A')

    // キャンセル: 留まる
    act(() => void router.navigate(`/t/${titleId}`))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('保存していない編集があります')
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(location()).toBe(`/t/${titleId}/p/${pieceId}`)
    expect(screen.getByTestId('unsaved-badge')).toBeTruthy()

    // 比較する稿を選ぶ（?v= だけが変わる）時は確かめない
    const rows = screen.getAllByTestId('version-row')
    await user.click(within(rows[0]).getByRole('button', { name: /を開いて比較する/ }))
    expect(location()).toContain('?v=')
    expect(screen.queryByRole('dialog')).toBeNull()

    // 保存して移動
    act(() => void router.navigate(`/t/${titleId}`))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存して移動' }))
    await screen.findByTestId('title-page')
    expect(bodyOf(v1)).toContain('A')
  })

  it('確かめている間にもう一度移動しようとしても（「戻る」の連打）、確認は1つだけ。キャンセルの後に選び直せる', async () => {
    const { titleId, pieceId, v1 } = seed()
    const { router } = renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), 'C')
    act(() => void router.navigate(`/t/${titleId}`))
    await screen.findByRole('dialog')
    act(() => void router.navigate(`/t/${titleId}`))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/p/${pieceId}`)

    act(() => void router.navigate(`/t/${titleId}`))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保存せずに移動' }))
    await screen.findByTestId('title-page')
    expect(bodyOf(v1)).not.toContain('C')
  })

  it('「保存せずに移動」は編集を捨てて移動する', async () => {
    const { titleId, pieceId, v1 } = seed()
    const { router } = renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), 'B')
    act(() => void router.navigate(`/t/${titleId}`))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存せずに移動' }))
    await screen.findByTestId('title-page')
    expect(bodyOf(v1)).not.toContain('B')
    expect(localStorage.getItem(draftKey(pieceId))).toBeNull()
  })
})

describe('最新話の「次の話を追加」', () => {
  /** 2話のタイトル（最後にエピローグを置くこともできる） */
  function twoEpisodes(epilogue = false) {
    const titleId = actions.createTitle('続きの作品')
    const first = actions.addEpisode(titleId)
    const last = actions.addEpisode(titleId)
    const ep = epilogue ? actions.addSpecial(titleId, { chapterId: null, index: 2 }, 'エピローグ') : null
    return { titleId, first, last, ep }
  }
  const episodes = (titleId: ID) => Object.values(getData().pieces).filter((p) => p.titleId === titleId && p.kind === 'episode')

  it('最新話では「次の話」の代わりに出て、押すと次の話を足して開く（ほかの話では今までどおり「次の話」）', async () => {
    const { titleId, first, last } = twoEpisodes()
    renderAt(`/t/${titleId}/p/${first}`)
    expect(await screen.findByTestId('next-piece')).toBeTruthy()
    expect(screen.queryByTestId('add-next-piece')).toBeNull()
    cleanup()
    renderAt(`/t/${titleId}/p/${last}`)
    const add = await screen.findByTestId('add-next-piece')
    expect(screen.queryByTestId('next-piece')).toBeNull()
    expect(add.getAttribute('aria-label')).toBe('次の話を追加')
    const user = userEvent.setup()
    await user.click(add)
    await waitFor(() => expect(episodes(titleId)).toHaveLength(3))
    const created = episodes(titleId).find((p) => p.id !== first && p.id !== last)!
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/p/${created.id}`))
    expect(toastTexts()).toContain('第3話を追加しました')
    // 足した話も最新話なので、また「次の話を追加」が出る
    expect(await screen.findByTestId('add-next-piece')).toBeTruthy()
  })

  it('保存していない編集があれば先に保存するか聞き、キャンセルなら何も足さない', async () => {
    const { titleId, last } = twoEpisodes()
    renderAt(`/t/${titleId}/p/${last}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '最終話の続き')
    await user.click(screen.getByTestId('add-next-piece'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('次の話を足す前に、この話で保存していない編集を保存します。')
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(episodes(titleId)).toHaveLength(2)
    expect(screen.getByTestId('location').textContent).toBe(`/t/${titleId}/p/${last}`)
    // 保存して次の話を追加
    await user.click(screen.getByTestId('add-next-piece'))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存して次の話を追加' }))
    await waitFor(() => expect(episodes(titleId)).toHaveLength(3))
    const v = getData().pieces[last].activeVersionId!
    expect(bodyOf(v)).toContain('最終話の続き')
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toBe(`/t/${titleId}/p/${last}`))
  })

  it('最後がエピローグなどの特殊ブロックなら、最新話では「次の話」（エピローグへ）、エピローグでは出さない', async () => {
    const { titleId, last, ep } = twoEpisodes(true)
    renderAt(`/t/${titleId}/p/${last}`)
    expect(await screen.findByTestId('next-piece')).toBeTruthy()
    expect(screen.queryByTestId('add-next-piece')).toBeNull()
    cleanup()
    renderAt(`/t/${titleId}/p/${ep}`)
    expect(((await screen.findByTestId('next-piece')) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('add-next-piece')).toBeNull()
  })
})

describe('話の一覧（左上の「第n話」から開く）', () => {
  /**
   * 章が2つ・プロローグ・幕に分けた話・採用原稿の無い話のあるタイトル。
   * 第一章　旅立ち: プロローグ・第1話 旅立ち・第2話（第1幕・第2幕）／第二章　帰郷: 第3話・第4話（採用原稿なし）
   */
  function seedStory() {
    const titleId = actions.createTitle('一覧の作品')
    const [e1, e2, e3, e4] = [1, 2, 3, 4].map(() => actions.addEpisode(titleId))
    const prologue = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
    actions.setChaptersEnabled(titleId, true)
    const ch1 = getData().titles[titleId].structure[0].id
    actions.updateChapter(ch1, { name: '第一章　旅立ち' })
    const ch2 = actions.addChapter(titleId, '第二章　帰郷')
    actions.movePiece(e4, { chapterId: ch2, index: 0 })
    actions.movePiece(e3, { chapterId: ch2, index: 0 })
    actions.updatePiece(e1, { subtitle: '旅立ち' })
    actions.updateVersion(getData().pieces[e2].versionIds[0], { body: '一幕目。二幕目。' })
    const acts = actions.separatePiece(e2, [4])
    actions.setActiveVersion(e4, null)
    return { titleId, prologue, e1, e2, e3, e4, acts }
  }
  const list = () => screen.getByTestId('piece-jump-list')
  const labels = (testId: string) =>
    within(list())
      .getAllByTestId(testId)
      .map((a) => a.querySelector('.rt-toc-label')?.textContent)
  const current = () => list().querySelector<HTMLAnchorElement>('[aria-current="page"]')
  const location = () => screen.getByTestId('location').textContent
  const linkOf = (label: string) =>
    [...list().querySelectorAll<HTMLAnchorElement>('a.rt-toc-link')].find(
      (a) => a.querySelector('.rt-toc-label')?.textContent === label,
    )!

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('通し読みの目次と同じ並び（章の区切り・プロローグ・幕・採用原稿なし）で開き、今の話に印を付けてフォーカスする。選ぶとその話へ移る', async () => {
    const { titleId, e1, e3 } = seedStory()
    renderAt(`/t/${titleId}/p/${e1}`)
    const user = userEvent.setup()
    const button = await screen.findByTestId('piece-jump')
    expect(button.getAttribute('aria-label')).toBe('第1話　話の一覧を開く')
    expect(button.getAttribute('title')).toBe('話の一覧を開く（話数は並び順で自動的に決まり、変更できません）')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await user.click(button)

    expect(screen.getByRole('dialog', { name: '話の一覧' })).toBeTruthy()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(list().id)
    expect([...list().querySelectorAll('.rt-toc-chapter')].map((c) => c.textContent)).toEqual(['第一章　旅立ち', '第二章　帰郷'])
    expect(labels('toc-link')).toEqual(['プロローグ', '第1話', '第2話', '第3話', '第4話'])
    expect(labels('toc-act-link')).toEqual(['第1幕', '第2幕'])
    expect(within(list()).getByText('旅立ち', { selector: '.rt-toc-subtitle' })).toBeTruthy()
    // 採用原稿の無い話は第4話だけ（幕に分けた話には付けない）
    expect(within(list()).getAllByTestId('toc-missing')).toHaveLength(1)
    expect(linkOf('第4話').textContent).toContain('採用原稿なし')
    expect(list().querySelector('.pj-head')?.textContent).toBe('話の一覧5')
    // 今の話に印が1つだけ付き、そこにフォーカスがある
    expect(list().querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(current()).toBe(linkOf('第1話'))
    expect(document.activeElement).toBe(current())
    // 項目は本当の行き先（Ctrl・⌘ を押しながらで新しいタブに開ける）
    expect(linkOf('第3話').getAttribute('href')).toBe(`/t/${titleId}/p/${e3}`)

    await user.click(linkOf('第3話'))
    expect(location()).toBe(`/t/${titleId}/p/${e3}`)
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    expect(screen.getByTestId('piece-label').textContent).toBe('第3話')
    // 移った先でも開ける（今の話は第3話）
    await user.click(screen.getByTestId('piece-jump'))
    expect(current()).toBe(linkOf('第3話'))
  })

  it('今の話を選ぶと閉じるだけ（保存していない編集があっても確かめない）。Esc で閉じて押した所へ戻る', async () => {
    const { titleId, e1 } = seedStory()
    renderAt(`/t/${titleId}/p/${e1}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '書きかけ')
    await user.click(screen.getByTestId('piece-jump'))
    await user.click(linkOf('第1話'))
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(location()).toBe(`/t/${titleId}/p/${e1}`)
    expect(screen.getByTestId('unsaved-badge')).toBeTruthy()

    await user.click(screen.getByTestId('piece-jump'))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('piece-jump'))
    // Android の「戻る」（Esc を送る）でも閉じる
    await user.click(screen.getByTestId('piece-jump'))
    act(() => expect(closeTopLayer()).toBe(true))
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('piece-jump'))
    // 押した所をもう一度押すと閉じる
    await user.click(screen.getByTestId('piece-jump'))
    await user.click(screen.getByTestId('piece-jump'))
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    // 外側を押しても閉じる
    await user.click(screen.getByTestId('piece-jump'))
    await user.click(screen.getByTestId('subtitle-input'))
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
  })

  it('開いたまま別の話へ移った時（ブラウザの「戻る」など）は閉じる', async () => {
    const { titleId, e1, e3 } = seedStory()
    const { router } = renderAt(`/t/${titleId}/p/${e3}`)
    const user = userEvent.setup()
    await screen.findByTestId('piece-jump')
    act(() => void router.navigate(`/t/${titleId}/p/${e1}`))
    await waitFor(() => expect(screen.getByTestId('piece-label').textContent).toBe('第1話'))
    await user.click(screen.getByTestId('piece-jump'))
    expect(current()).toBe(linkOf('第1話'))
    act(() => void router.navigate(-1))
    await waitFor(() => expect(location()).toBe(`/t/${titleId}/p/${e3}`))
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    expect(screen.getByTestId('piece-jump').getAttribute('aria-expanded')).toBe('false')
  })

  it('保存していない編集があれば、前後の話への移動と同じく確かめる（キャンセルで留まり、保存して移動もできる）', async () => {
    const { titleId, e1, e3 } = seedStory()
    renderAt(`/t/${titleId}/p/${e1}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), 'A')
    await user.click(screen.getByTestId('piece-jump'))
    await user.click(linkOf('第3話'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('保存していない編集があります')
    // 一覧は先に閉じている（確認と重ならない）
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(location()).toBe(`/t/${titleId}/p/${e1}`)
    expect(document.activeElement).toBe(screen.getByTestId('piece-jump'))

    await user.click(screen.getByTestId('piece-jump'))
    await user.click(linkOf('第3話'))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存して移動' }))
    await waitFor(() => expect(location()).toBe(`/t/${titleId}/p/${e3}`))
    expect(bodyOf(getData().pieces[e1].activeVersionId!)).toBe('A')
  })

  it('幕の画面では今の幕に印を付け、別の幕へ移れる。幕に分けた話を選ぶと幕の一覧へ（そこの「第n話」からも開ける）', async () => {
    const { titleId, e2, acts } = seedStory()
    renderAt(`/t/${titleId}/p/${acts[0]}`)
    const user = userEvent.setup()
    // 幕の画面の「第n話」は属する話のもの
    expect((await screen.findByTestId('piece-label')).textContent).toBe('第2話')
    await user.click(screen.getByTestId('piece-jump'))
    expect(current()).toBe(within(list()).getAllByTestId('toc-act-link')[0])
    await user.click(within(list()).getAllByTestId('toc-act-link')[1])
    expect(location()).toBe(`/t/${titleId}/p/${acts[1]}`)

    await user.click(screen.getByTestId('piece-jump'))
    expect(current()).toBe(within(list()).getAllByTestId('toc-act-link')[1])
    await user.click(linkOf('第2話'))
    expect(location()).toBe(`/t/${titleId}/p/${e2}`)
    expect(await screen.findByTestId('episode-folder')).toBeTruthy()
    const folderJump = screen.getByTestId('piece-jump')
    expect(within(folderJump).getByTestId('folder-label').textContent).toBe('第2話')
    await user.click(folderJump)
    expect(current()).toBe(linkOf('第2話'))
    await user.click(linkOf('プロローグ'))
    await waitFor(() => expect(location()).toMatch(/\/p\/[^/]+$/))
    expect(screen.queryByTestId('episode-folder')).toBeNull()
  })

  it('特殊ブロックの画面では「特殊」の札で開ける', async () => {
    const { titleId, prologue } = seedStory()
    renderAt(`/t/${titleId}/p/${prologue}`)
    const user = userEvent.setup()
    const badge = await screen.findByTestId('piece-jump')
    expect(badge.textContent).toBe('特殊')
    expect(badge.getAttribute('aria-label')).toBe('特殊　話の一覧を開く')
    // 見出しは今までどおり入力欄で直せる
    expect(screen.getByTestId('special-label-input')).toBeTruthy()
    await user.click(badge)
    expect(current()).toBe(linkOf('プロローグ'))
  })

  it('↑↓・Home・End で項目を動き（端で止まる）、Enter で移る', async () => {
    const { titleId, e1, e3 } = seedStory()
    renderAt(`/t/${titleId}/p/${e1}`)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('piece-jump'))
    const focused = () => document.activeElement?.querySelector('.rt-toc-label')?.textContent
    expect(focused()).toBe('第1話')
    await user.keyboard('{ArrowDown}')
    expect(focused()).toBe('第2話')
    await user.keyboard('{ArrowDown}')
    expect(focused()).toBe('第1幕')
    await user.keyboard('{End}')
    expect(focused()).toBe('第4話')
    await user.keyboard('{ArrowDown}')
    expect(focused()).toBe('第4話')
    await user.keyboard('{Home}')
    expect(focused()).toBe('プロローグ')
    await user.keyboard('{ArrowUp}')
    expect(focused()).toBe('プロローグ')
    await user.keyboard('{End}{ArrowUp}')
    expect(focused()).toBe('第3話')
    await user.keyboard('{Enter}')
    expect(location()).toBe(`/t/${titleId}/p/${e3}`)
    expect(screen.queryByTestId('piece-jump-list')).toBeNull()
  })

  it('スマホ・高さの低い画面では下からのシート（ダイアログ）で開き、選ぶと移る', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === JUMP_SHEET_QUERY,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    const { titleId, e1, e3 } = seedStory()
    renderAt(`/t/${titleId}/p/${e1}`)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('piece-jump'))
    const dialog = screen.getByRole('dialog', { name: '話の一覧' })
    expect(dialog.classList.contains('modal')).toBe(true)
    expect(screen.queryByTestId('piece-jump-pop')).toBeNull()
    expect(within(dialog).getByTestId('piece-jump-list')).toBeTruthy()
    // 見出しは Modal のもの（一覧の中には出さない）
    expect(list().querySelector('.pj-head')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(current()))
    expect(current()).toBe(linkOf('第1話'))
    await user.click(linkOf('第3話'))
    expect(location()).toBe(`/t/${titleId}/p/${e3}`)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('保存と一緒に変わる表示', () => {
  it('保存する前に稿が別の端末で削除されていたら、推敲メモの編集も新しい稿として残し、そう知らせる', async () => {
    const { titleId, pieceId, v2 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('version-note'), '長い推敲メモ')
    await waitFor(() => expect(readCrashDraft(pieceId)).not.toBeNull(), { timeout: 3000 })
    // 同期で別の端末の削除が届いた（比較は閉じるが、未保存のまま）
    act(() => void actions.deleteVersion(v2))
    await waitFor(() => expect(screen.queryByTestId('compare-pane')).toBeNull())
    expect(screen.getByTestId('unsaved-badge')).toBeTruthy()

    await user.click(screen.getByTestId('save-button'))
    const ids = getData().pieces[pieceId].versionIds
    const kept = getData().versions[ids[ids.length - 1]]
    expect(kept).toMatchObject({ name: '第2稿（競合: ブラウザでの編集）', note: '長い推敲メモ' })
    expect(screen.queryByTestId('unsaved-badge')).toBeNull()
    expect(localStorage.getItem(draftKey(pieceId))).toBeNull()
    await waitFor(() =>
      expect(toastTexts()).toContain(
        '「第2稿」が削除されていたため、この端末の編集を「第2稿（競合: ブラウザでの編集）」として残しました',
      ),
    )
  })

  it('比較の「採用原稿より±n字」は、採用原稿の保存していない編集も含めて数える', async () => {
    const { titleId, pieceId, v2 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const user = userEvent.setup()
    // 採用原稿 17字・推敲バージョン 18字
    expect((await screen.findByTestId('compare-delta')).textContent).toBe('採用原稿より+1字')
    const editor = screen.getByTestId('active-editor')
    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}あいう')
    await waitFor(() => expect(screen.getByTestId('compare-delta').textContent).toBe('採用原稿より−2字'))
    expect(bodyOf(getData().pieces[pieceId].versionIds[0])).not.toContain('あいう')
  })

  it('稿の一覧は、保存していない名前・本文・推敲メモを出し、編集のある稿に「未保存」の印を付ける', async () => {
    const { titleId, pieceId, v2 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('selected-version-name'), '改')
    const compare = screen.getByTestId('compare-editor')
    await user.click(compare)
    await user.keyboard('{Control>}{End}{/Control}あいう')
    await user.type(screen.getByTestId('version-note'), '狙いを書いた')
    await user.click(screen.getByTestId('back-to-list'))
    const rows = await screen.findAllByTestId('version-row')
    // 新しい順: 第2稿 → 第1稿（採用中）
    expect(within(rows[0]).getByTestId('version-row-name').textContent).toBe('第2稿改')
    await waitFor(() => expect(within(rows[0]).getByTestId('version-row-count').textContent).toBe('21字'))
    expect(rows[0].textContent).toContain('+4字')
    expect(rows[0].textContent).toContain('狙いを書いた')
    expect(within(rows[0]).getByTestId('version-row-dirty').textContent).toBe('未保存')
    expect(within(rows[0]).getByRole('button', { name: /未保存の編集あり/ })).toBeTruthy()
    expect(within(rows[1]).queryByTestId('version-row-dirty')).toBeNull()
    // 採用原稿に書き足すと、差も数え直す
    await user.click(screen.getByTestId('active-editor'))
    await user.keyboard('{Control>}{End}{/Control}えお')
    await waitFor(() => expect(rows[0].textContent).toContain('+2字'))
    await user.click(screen.getByTestId('save-button'))
    await waitFor(() => expect(screen.queryAllByTestId('version-row-dirty')).toHaveLength(0))
    expect(within(screen.getAllByTestId('version-row')[0]).getByTestId('version-row-name').textContent).toBe('第2稿改')
  })

  it('「保存して続ける」の後の削除・採用の確認と知らせは、保存した後の稿の名前を使う', async () => {
    const { titleId, pieceId, v2 } = seed()
    actions.addVersion(pieceId, { body: '三つ目の稿' })
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const user = userEvent.setup()
    const name = await screen.findByTestId('selected-version-name')
    await user.clear(name)
    await user.type(name, '改稿A')
    await user.click(screen.getByTestId('delete-version'))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保存して続ける' }))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('「改稿A」を削除しますか？'))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(toastTexts()).toContain('改稿Aをゴミ箱に移しました'))

    // 採用も同じ（一覧の行の「採用する」）
    const rows = await screen.findAllByTestId('version-row')
    await user.click(within(rows[0]).getByRole('button', { name: /を開いて比較する/ }))
    const second = await screen.findByTestId('selected-version-name')
    await user.clear(second)
    await user.type(second, '改稿B')
    await user.click(screen.getByTestId('adopt-button'))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保存して続ける' }))
    await waitFor(() => expect(toastTexts()).toContain('改稿Bを採用しました'))
  })

  it('アプリの更新は、保存していない編集を保存するか聞いてから行う（キャンセルしたら更新しない）', async () => {
    const { titleId, pieceId, v1 } = seed()
    const storedAtApply: (string | undefined)[] = []
    const apply = vi.fn(async () => {
      storedAtApply.push(bodyOf(v1))
    })
    useAppUpdate.setState({ ready: true, apply })
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = await screen.findByTestId('active-editor')
    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}更新前')

    // キャンセル: 更新せず、編集も残る
    await user.click(screen.getByTestId('app-update'))
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('保存していない編集があります。保存してから続けますか？')
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(apply).not.toHaveBeenCalled()
    expect(screen.getByTestId('unsaved-badge')).toBeTruthy()

    // 保存して更新: 保存してから更新する
    await user.click(screen.getByTestId('app-update'))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存して更新' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(storedAtApply[0]).toContain('更新前')
  })

  it('保存していない編集がある間は、同期の状態に「ほかの端末と同じ内容です」と言い切らない', async () => {
    const { titleId, pieceId } = seed()
    useSync.setState({
      auth: 'signedIn',
      leader: true,
      everSignedIn: true,
      status: { phase: 'synced', pending: 0, lastSyncedAt: Date.now(), error: null } as never,
    })
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const indicator = await screen.findByTestId('sync-indicator')
    expect(indicator.getAttribute('aria-label')).toContain('ほかの端末と同じ内容です')
    await user.type(screen.getByTestId('active-editor'), '未送信')
    expect(screen.getByTestId('sync-indicator').getAttribute('aria-label')).toContain('保存していない編集は、保存すると送ります')
    await user.click(screen.getByTestId('save-button'))
    expect(screen.getByTestId('sync-indicator').getAttribute('aria-label')).toContain('ほかの端末と同じ内容です')
  })
})

describe('巻き戻し・記号', () => {
  it('Ctrl+Z・Ctrl+Shift+Z・Ctrl+Y と記号バーで、項目ごとに戻す・進める', async () => {
    const { titleId, pieceId } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    const start = editor.value
    expect(screen.getByTestId('undo-button')).toHaveProperty('disabled', true)
    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}')
    await user.keyboard('あいう')
    // 記号バー（押してもフォーカスは本文のまま）
    await user.click(screen.getByTestId('symbol-dash'))
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe(`${start}あいう――`)
    await user.click(screen.getByTestId('undo-button'))
    expect(editor.value).toBe(`${start}あいう`)
    await user.keyboard('{Control>}z{/Control}')
    expect(editor.value).toBe(start)
    // カーソルは打つ前の位置に戻る
    expect(editor.selectionStart).toBe(start.length)
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    expect(editor.value).toBe(`${start}あいう`)
    await user.keyboard('{Control>}y{/Control}')
    expect(editor.value).toBe(`${start}あいう――`)
    expect(screen.getByTestId('redo-button')).toHaveProperty('disabled', true)
  })

  it('ルビ: 選んだ文字に ｜《》 を付け、カーソルを《》の中に置く', async () => {
    const { titleId, pieceId, v1 } = seed()
    act(() => actions.updateVersion(v1, { body: '漢字' }))
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    await user.click(editor)
    editor.setSelectionRange(0, 2)
    await user.click(screen.getByTestId('symbol-ruby'))
    expect(editor.value).toBe('｜漢字《》')
    expect(editor.selectionStart).toBe(4)
    await user.keyboard('かんじ')
    expect(editor.value).toBe('｜漢字《かんじ》')
    // 記号と読みは数えない
    await waitFor(() => expect(screen.getByTestId('active-count').textContent).toContain('2字'))
  })
})

describe('括弧（記号バーの「括弧」）', () => {
  it('空白とルビの間にあり、本文を書くまでは押せない。開くと5つの組が並び、フォーカスは本文のまま', async () => {
    const { titleId, pieceId } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    const ids = within(screen.getByTestId('symbol-bar'))
      .getAllByRole('button')
      .map((b) => b.dataset.testid)
    expect(ids.slice(ids.indexOf('symbol-space'), ids.indexOf('symbol-ruby') + 1)).toEqual([
      'symbol-space',
      'symbol-brackets',
      'symbol-ruby',
    ])
    const brackets = screen.getByTestId('symbol-brackets')
    expect(brackets).toHaveProperty('disabled', true)
    expect(brackets.getAttribute('aria-haspopup')).toBe('menu')
    await user.click(editor)
    expect(brackets).toHaveProperty('disabled', false)
    await user.click(brackets)
    const menu = screen.getByRole('menu', { name: '括弧' })
    expect(brackets.getAttribute('aria-expanded')).toBe('true')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual(['「」', '『』', '（）', '〈〉', '〝〟'])
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.dataset.testid),
    ).toEqual(['bracket-kagi', 'bracket-nijukagi', 'bracket-maru', 'bracket-yama', 'bracket-nonome'])
    expect(screen.getByRole('menuitem', { name: 'ちょんちょん括弧（〝〟）' })).toBeTruthy()
    expect(document.activeElement).toBe(editor)
    // もう一度押すと閉じる
    await user.click(brackets)
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(brackets.getAttribute('aria-expanded')).toBe('false')
  })

  it('選んでいない時は組を入れてカーソルを間に、選んでいる時は囲む。巻き戻し・進むは1手', async () => {
    const { titleId, pieceId, v1 } = seed()
    act(() => actions.updateVersion(v1, { body: '彼は猫だ' }))
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    await user.click(editor)
    editor.setSelectionRange(4, 4)
    await user.click(screen.getByTestId('symbol-brackets'))
    await user.click(screen.getByTestId('bracket-kagi'))
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(editor.value).toBe('彼は猫だ「」')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 5])
    expect(document.activeElement).toBe(editor)
    await user.keyboard('はい')
    expect(editor.value).toBe('彼は猫だ「はい」')

    editor.setSelectionRange(2, 3)
    await user.click(screen.getByTestId('symbol-brackets'))
    await user.click(screen.getByTestId('bracket-nijukagi'))
    expect(editor.value).toBe('彼は『猫』だ「はい」')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 5])
    await user.click(screen.getByTestId('undo-button'))
    expect(editor.value).toBe('彼は猫だ「はい」')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 3])
    await user.click(screen.getByTestId('redo-button'))
    expect(editor.value).toBe('彼は『猫』だ「はい」')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 5])
    // 保存していない編集になる（保存すると入る）
    await user.click(screen.getByTestId('save-button'))
    expect(bodyOf(v1)).toBe('彼は『猫』だ「はい」')
  })

  it('開いたまま別の記号を押しても1回で入る。本文を打ち始めた・Esc でも閉じる（Esc は本文に届かない）', async () => {
    const { titleId, pieceId } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    const start = editor.value
    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}')
    await user.click(screen.getByTestId('symbol-brackets'))
    await user.click(screen.getByTestId('symbol-dash'))
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(editor.value).toBe(`${start}――`)

    await user.click(screen.getByTestId('symbol-brackets'))
    expect(screen.getByTestId('bracket-menu')).toBeTruthy()
    await user.keyboard('あ')
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(editor.value).toBe(`${start}――あ`)

    const escapes = vi.fn()
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') escapes()
    })
    await user.click(screen.getByTestId('symbol-brackets'))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(escapes).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(editor)

    // Android の「戻る」でも閉じる
    await user.click(screen.getByTestId('symbol-brackets'))
    act(() => {
      closeTopLayer()
    })
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(document.activeElement).toBe(editor)
  })

  it('キーボードで開くと一覧にフォーカスし、←→ と Enter で入れて本文へ。Esc では括弧のボタンへ戻る', async () => {
    const { titleId, pieceId } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    const start = editor.value
    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}')
    const brackets = screen.getByTestId('symbol-brackets')
    brackets.focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByTestId('bracket-kagi'))
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByTestId('bracket-yama'))
    await user.keyboard('{Enter}')
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(editor.value).toBe(`${start}〈〉`)
    expect(document.activeElement).toBe(editor)
    expect(editor.selectionStart).toBe(start.length + 1)

    brackets.focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByTestId('bracket-kagi'))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(document.activeElement).toBe(brackets)
  })

  it('話の題（1行の欄）に移ると押せなくなり、開いていた一覧も閉じる。推敲メモでは使える', async () => {
    const { titleId, pieceId, v2 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const user = userEvent.setup()
    const editor = (await screen.findByTestId('active-editor')) as HTMLTextAreaElement
    await user.click(editor)
    await user.click(screen.getByTestId('symbol-brackets'))
    expect(screen.getByTestId('bracket-menu')).toBeTruthy()
    act(() => screen.getByTestId('subtitle-input').focus())
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    expect(screen.getByTestId('symbol-brackets')).toHaveProperty('disabled', true)

    // 推敲メモ（働き先が変わると、本文で開いた一覧は閉じる）
    await user.click(editor)
    await user.click(screen.getByTestId('symbol-brackets'))
    const note = (await screen.findByTestId('version-note')) as HTMLTextAreaElement
    await user.click(note)
    expect(screen.queryByTestId('bracket-menu')).toBeNull()
    await user.click(screen.getByTestId('symbol-brackets'))
    await user.click(screen.getByTestId('bracket-maru'))
    expect(note.value).toBe('（）')
    expect(document.activeElement).toBe(note)
  })
})

describe('端末内の控え', () => {
  it('編集は少し待ってから端末内に控え、保存したら消す', async () => {
    const { titleId, pieceId, v1 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '控え')
    await waitFor(() => expect(readCrashDraft(pieceId)?.edits[versionField(v1, 'body')]?.value).toContain('控え'), {
      timeout: 3000,
    })
    await user.click(screen.getByTestId('save-button'))
    expect(localStorage.getItem(draftKey(pieceId))).toBeNull()
  })

  it('開いた時に前回保存されなかった編集があれば、復元するか聞く', async () => {
    const { titleId, pieceId, v1 } = seed()
    writeCrashDraft(
      pieceId,
      {
        [versionField(v1, 'body')]: { base: bodyOf(v1)!, value: '復元する本文' },
        [pieceField(pieceId, 'subtitle')]: { base: '', value: '復元する題' },
      },
      'closed-tab',
      new Date(2026, 9, 28, 7, 40).getTime(),
    )
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('前回保存されなかった編集があります（2026/10/28 07:40）。復元しますか？')
    expect(dialog.textContent).toContain('第1稿の本文・話の題')
    await user.click(within(dialog).getByRole('button', { name: '復元' }))
    expect((screen.getByTestId('active-editor') as HTMLTextAreaElement).value).toBe('復元する本文')
    // 控えはこの画面のものとして書き直す（閉じたタブの持ち主のままにしない）
    expect(readCrashDraft(pieceId)?.owner).toBeTruthy()
    expect(readCrashDraft(pieceId)?.owner).not.toBe('closed-tab')
    expect((screen.getByTestId('subtitle-input') as HTMLInputElement).value).toBe('復元する題')
    expect(screen.getByTestId('unsaved-badge')).toBeTruthy()
    // 保存するまではストアに入れない
    expect(bodyOf(v1)).not.toBe('復元する本文')
    await user.click(screen.getByTestId('save-button'))
    expect(bodyOf(v1)).toBe('復元する本文')
  })

  it('同じ話を開いている別のタブの控えは、「前回保存されなかった編集」として聞かず、消しもしない', async () => {
    const { titleId, pieceId, v1 } = seed()
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: bodyOf(v1)!, value: '別のタブで書いている本文' } }, 'open-tab')
    fakeLocks(['open-tab'])
    renderAt(`/t/${titleId}/p/${pieceId}`)
    await screen.findByTestId('active-editor')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(readCrashDraft(pieceId)?.owner).toBe('open-tab')
  })

  it('控えを書いたタブが閉じていれば（ロックが無ければ）、復元するか聞く', async () => {
    const { titleId, pieceId, v1 } = seed()
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: bodyOf(v1)!, value: '落ちたタブの本文' } }, 'closed-tab')
    fakeLocks([])
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('前回保存されなかった編集があります')
  })

  it('「破棄」を選ぶと控えを消す', async () => {
    const { titleId, pieceId, v1 } = seed()
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: bodyOf(v1)!, value: '捨てる本文' } })
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '破棄' }))
    expect((screen.getByTestId('active-editor') as HTMLTextAreaElement).value).toBe(bodyOf(v1))
    expect(localStorage.getItem(draftKey(pieceId))).toBeNull()
    expect(screen.queryByTestId('unsaved-badge')).toBeNull()
  })
})

describe('保存先が無くなった編集（幕）', () => {
  /** 'AAABBBCCC' を3幕に分けた第1話（題「雨」） */
  function seedActs(): { titleId: ID; pieceId: ID; acts: ID[] } {
    const titleId = actions.createTitle('幕の作品')
    const pieceId = actions.addEpisode(titleId)
    actions.updatePiece(pieceId, { subtitle: '雨' })
    actions.updateVersion(getData().pieces[pieceId].versionIds[0], { body: 'AAABBBCCC' })
    const acts = actions.separatePiece(pieceId, [3, 6])
    return { titleId, pieceId, acts }
  }
  const versionsOf = (pieceId: ID) => getData().pieces[pieceId].versionIds.map((id) => getData().versions[id])

  it('開いている幕が別の画面・端末で前の幕とつながれても、編集を消さずに出し、前の幕の新しい稿として残せる', async () => {
    const { titleId, pieceId, acts } = seedActs()
    renderAt(`/t/${titleId}/p/${acts[1]}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '幕2の未保存')
    act(() => void actions.joinActWithNext(acts[0]))
    const view = await screen.findByTestId('orphan-edits')
    expect(view.getAttribute('data-reason')).toBe('joined')
    expect(view.textContent).toContain('前の幕とつながれたため')
    expect((screen.getByTestId('orphan-value') as HTMLTextAreaElement).value).toBe('BBB幕2の未保存')
    // 保存していない編集がある間は、画面を離れる時の確認も続く
    expect(document.querySelector('.save-status')).toBeNull()
    expect(screen.getByTestId('orphan-keep').textContent).toBe('「第1話　雨　第1幕」の新しい稿として残す')
    await user.click(screen.getByTestId('orphan-keep'))
    const kept = versionsOf(acts[0]).at(-1)!
    expect(kept.name).toBe('第1稿（競合: ブラウザでの編集）')
    expect(kept.body).toBe('BBB幕2の未保存')
    // 採用は変えない（つないだ本文はそのまま）
    expect(getData().versions[getData().pieces[acts[0]].activeVersionId!].body).toBe('AAABBB')
    await waitFor(() =>
      expect(toastTexts()).toContain(
        'この端末の編集を、「第1話　雨　第1幕」の新しい稿「第1稿（競合: ブラウザでの編集）」として残しました',
      ),
    )
    // 残したら、無くなった幕の表示（属していた話へ移れる）
    expect(await screen.findByTestId('not-found-action')).toBeTruthy()
    expect(localStorage.getItem(draftKey(acts[1]))).toBeNull()
    expect(getData().pieces[pieceId].actIds).toHaveLength(2)
  })

  it('セパレートが解除されたら、話の新しい稿として残す。画面を離れる時の「保存して移動」でも残す', async () => {
    const { titleId, pieceId, acts } = seedActs()
    const { router } = renderAt(`/t/${titleId}/p/${acts[2]}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '終わりの追記')
    act(() => void actions.unseparatePiece(pieceId))
    expect((await screen.findByTestId('orphan-edits')).getAttribute('data-reason')).toBe('unseparated')
    act(() => void router.navigate(`/t/${titleId}`))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存して移動' }))
    await screen.findByTestId('title-page')
    const kept = versionsOf(pieceId).at(-1)!
    expect(kept.body).toBe('CCC終わりの追記')
    expect(kept.name).toBe('第1稿（競合: ブラウザでの編集）')
    expect(getData().versions[getData().pieces[pieceId].activeVersionId!].body).toBe('AAABBBCCC')
  })

  it('開いている話が別の画面・端末で幕に分けられたら、黙って幕の一覧にせず、選んだ幕の新しい稿として残せる', async () => {
    const { titleId, pieceId, v1 } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '追記')
    act(() => void actions.separatePiece(pieceId, [5]))
    const view = await screen.findByTestId('orphan-edits')
    expect(view.getAttribute('data-reason')).toBe('split')
    expect(screen.queryByTestId('episode-folder')).toBeNull()
    const acts = getData().pieces[pieceId].actIds!
    await user.selectOptions(screen.getByTestId('orphan-target'), acts[1])
    await user.click(screen.getByTestId('orphan-keep'))
    const kept = versionsOf(acts[1]).at(-1)!
    expect(kept.body).toBe(`${bodyOf(v1)}追記`)
    // 話自身の稿は変えない
    expect(bodyOf(v1)).toBe('春は曙。\nやうやう白くなりゆく山際。')
    expect(await screen.findByTestId('episode-folder')).toBeTruthy()
  })

  it('話・幕が削除されて残し先が無ければ、ゴミ箱に残す', async () => {
    const { titleId, pieceId } = seed()
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('active-editor'), '消えた話の追記')
    act(() => actions.deletePiece(pieceId))
    expect((await screen.findByTestId('orphan-edits')).getAttribute('data-reason')).toBe('deleted')
    expect(screen.getByTestId('orphan-keep').textContent).toBe('ゴミ箱に残す')
    await user.click(screen.getByTestId('orphan-keep'))
    const entries = Object.values(getData().trashEntries)
    const conflict = entries.find((e) => e.reason === 'conflict')!
    expect(conflict.kind).toBe('version')
    const record = Object.values(getData().trashRecords).find((r) => r.entryId === conflict.id)!
    expect((record.record as { body: string }).body).toContain('消えた話の追記')
  })

  it('アプリが落ちて残った、なくなった幕の控えは、残った幕・話を開いた時に新しい稿として残せる', async () => {
    const { titleId, pieceId, acts } = seedActs()
    const vid = getData().pieces[acts[1]].activeVersionId!
    // 第2幕で書いていた控え（幕の場所つき）。その後で第1幕とつながれた
    writeCrashDraft(
      acts[1],
      { [versionField(vid, 'body')]: { base: 'BBB', value: 'BBB落ちる前の追記', label: '第1稿' } },
      'closed-tab',
      new Date(2026, 9, 28, 9, 5).getTime(),
      { parentId: pieceId, prevId: acts[0] },
    )
    act(() => void actions.joinActWithNext(acts[0]))
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('なくなった幕で保存されなかった編集があります（2026/10/28 09:05）')
    expect(dialog.textContent).toContain('「第1話　雨　第1幕」の新しい稿として残します')
    await user.click(within(dialog).getByRole('button', { name: '残す' }))
    await waitFor(() => expect(versionsOf(acts[0]).at(-1)!.body).toBe('BBB落ちる前の追記'))
    expect(localStorage.getItem(draftKey(acts[1]))).toBeNull()
  })

  it('幕に分けた話自身の控え（分ける前の編集）は、幕の一覧を開いた時に聞き、幕の新しい稿として残せる', async () => {
    const { titleId, pieceId, v1 } = seed()
    writeCrashDraft(pieceId, { [versionField(v1, 'body')]: { base: bodyOf(v1)!, value: '分ける前の編集' } }, 'closed-tab')
    act(() => void actions.separatePiece(pieceId, [5]))
    renderAt(`/t/${titleId}/p/${pieceId}`)
    const user = userEvent.setup()
    expect(await screen.findByTestId('episode-folder')).toBeTruthy()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('前回保存されなかった編集があります')
    await user.click(within(dialog).getByRole('button', { name: '復元' }))
    expect((await screen.findByTestId('orphan-edits')).getAttribute('data-reason')).toBe('split')
    await user.click(screen.getByTestId('orphan-keep'))
    const first = getData().pieces[pieceId].actIds![0]
    expect(versionsOf(first).at(-1)!.body).toBe('分ける前の編集')
    expect(await screen.findByTestId('episode-folder')).toBeTruthy()
  })
})

describe('コピー', () => {
  it('見出し（第n話　題）と、保存していない編集も含めた本文をコピーする', async () => {
    const { titleId, pieceId, v2 } = seed()
    act(() => actions.updatePiece(pieceId, { subtitle: '春' }))
    renderAt(`/t/${titleId}/p/${pieceId}?v=${v2}`)
    const user = userEvent.setup()
    // user-event はクリップボードを差し替えるので、その後で書き込みを見張る
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const editor = await screen.findByTestId('compare-editor')
    await user.click(editor)
    await user.keyboard('{Control>}{End}{/Control}追記')
    await user.click(screen.getByTestId('copy-selected'))
    expect(writeText).toHaveBeenCalledWith('第1話　春\n\n春は曙。\nようやく白くなっていく山際。追記')
    await user.click(screen.getByTestId('copy-active'))
    expect(writeText).toHaveBeenLastCalledWith('第1話　春\n\n春は曙。\nやうやう白くなりゆく山際。')
  })
})
