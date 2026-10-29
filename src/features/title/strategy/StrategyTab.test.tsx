import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../../db/persistence'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { useToasts } from '../../../store/uiStore'
import { downloadFile } from '../../../ui/browser'
import { AppFrame } from '../../../ui/Layout'
import { StrategyTab } from './StrategyTab'
import { toYmd } from './strategyLogic'

// 書き出しはファイル名と内容だけを確かめる
vi.mock('../../../ui/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../ui/browser')>()
  return { ...original, downloadFile: vi.fn() }
})

let n = 0

function renderTab(titleId: ID) {
  return render(
    <MemoryRouter initialEntries={[`/t/${titleId}?tab=strategy`]}>
      <AppFrame>
        <StrategyTab titleId={titleId} />
      </AppFrame>
    </MemoryRouter>,
  )
}

/** 本文つきの話を作ったタイトル */
function seedTitle(bodies: string[]): { titleId: ID; pieceIds: ID[] } {
  const titleId = actions.createTitle('海の記憶')
  const pieceIds = bodies.map((body) => {
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body })
    return id
  })
  return { titleId, pieceIds }
}

async function addViaPrompt(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByTestId('add-submission'))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByRole('textbox'), name)
  await user.click(within(dialog).getByRole('button', { name: '追加' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

beforeEach(async () => {
  await initStore(createPersistence(`test-db-strategy-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  vi.useRealTimers()
  vi.mocked(downloadFile).mockClear()
  // 前のテストのトーストを持ち越さない
  useToasts.setState({ toasts: [] })
})

describe('戦略タブ', () => {
  it('現在の原稿（採用原稿のみ）と全体戦略', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seedTitle(['あ'.repeat(1200), 'い'.repeat(800), 'う'.repeat(50)])
    actions.setActiveVersion(pieceIds[2], null)
    renderTab(titleId)
    expect(screen.getByTestId('summary-chars').textContent).toBe('2,000字')
    expect(screen.getByTestId('summary-pages').textContent).toBe('約5枚')
    expect(screen.getByTestId('summary-episodes').textContent).toBe('3話')
    expect(screen.getByTestId('summary-missing').textContent).toContain('採用原稿なし 1話')
    expect(screen.getByTestId('submissions-empty')).toBeTruthy()

    await user.type(screen.getByTestId('strategy-note'), 'まずは長編賞へ')
    await user.tab()
    expect(getData().titles[titleId].strategyNote).toBe('まずは長編賞へ')
  })

  it('応募先を追加すると開いた状態になり、規定文字数の過不足が見出しに出る', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['あ'.repeat(1200), 'い'.repeat(800)])
    renderTab(titleId)
    await addViaPrompt(user, '海風小説大賞')

    const card = screen.getByTestId('submission-card')
    expect(within(card).getByTestId('submission-editor')).toBeTruthy()
    expect(within(card).getByTestId('submission-name').textContent).toBe('海風小説大賞')
    expect(within(card).getByTestId('submission-status').textContent).toBe('検討中')
    expect(within(card).queryByTestId('submission-limit')).toBeNull()

    await user.type(within(card).getByTestId('submission-min'), '3200{Enter}')
    expect(within(card).getByTestId('submission-limit').textContent).toBe('あと1,200字必要')
    await user.type(within(card).getByTestId('submission-max'), '1,500{Enter}')
    // 下限 > 上限の注意
    expect(card.textContent).toContain('下限が上限より大きくなっています')
    await user.clear(within(card).getByTestId('submission-min'))
    await user.type(within(card).getByTestId('submission-min'), '{Enter}')
    expect(within(card).getByTestId('submission-limit').textContent).toBe('500字超過')
    const s = Object.values(getData().submissions)[0]
    expect([s.minChars, s.maxChars]).toEqual([null, 1500])

    // 状態を変えると見出しのバッジも変わる
    await user.selectOptions(within(card).getByTestId('submission-status-select'), 'won')
    expect(within(card).getByTestId('submission-status').textContent).toBe('受賞')
    expect(card.getAttribute('data-status')).toBe('won')
  })

  it('応募時の原稿を記録し、その後に採用原稿が変わった話の数を出す', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seedTitle(['一話', '二話です'])
    const subId = actions.addSubmission(titleId, '潮騒文庫新人賞')
    renderTab(titleId)
    await user.click(screen.getByTestId('submission-toggle'))
    await user.click(screen.getByTestId('snapshot-record'))
    expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・6字・約2枚・2話$/)
    expect(screen.getByTestId('snapshot-diff').textContent).toContain('変わっていません')
    expect(getData().submissions[subId].snapshot?.charCount).toBe(6)

    act(() => {
      actions.setActiveVersion(pieceIds[0], null)
    })
    expect(screen.getByTestId('snapshot-diff').textContent).toBe('記録した後に変わったもの：稿の切り替え 1件（文字数 −2字）')

    // 2回目は上書きの確認が出る
    await user.click(screen.getByTestId('snapshot-record'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '記録し直す' }))
    await waitFor(() => expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・4字・約1枚・2話$/))
  })

  it('応募順の入れ替えと、締切順の表示（応募順は変えない）', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    const a = actions.addSubmission(titleId, 'A賞')
    const b = actions.addSubmission(titleId, 'B賞')
    const c = actions.addSubmission(titleId, 'C賞')
    actions.updateSubmission(a, { deadline: '2099-12-01' })
    actions.updateSubmission(c, { deadline: '2099-01-01' })
    renderTab(titleId)
    const names = () => screen.getAllByTestId('submission-name').map((e) => e.textContent)
    expect(names()).toEqual(['A賞', 'B賞', 'C賞'])

    await user.click(screen.getAllByRole('button', { name: '応募順を下げる' })[0])
    expect(names()).toEqual(['B賞', 'A賞', 'C賞'])
    expect(getData().submissions[b].order).toBeLessThan(getData().submissions[a].order)
    expect(screen.getAllByTestId('submission-number').map((e) => e.textContent)).toEqual(['応募順 1', '応募順 2', '応募順 3'])

    await user.click(screen.getByTestId('sort-deadline'))
    expect(names()).toEqual(['C賞', 'A賞', 'B賞'])
    expect(screen.getAllByTestId('submission-number').map((e) => e.textContent)).toEqual(['応募順 3', '応募順 2', '応募順 1'])
    expect(screen.queryAllByRole('button', { name: '応募順を上げる' })).toHaveLength(0)
    expect(
      Object.values(getData().submissions)
        .sort((x, y) => x.order - y.order)
        .map((s) => s.contestName),
    ).toEqual(['B賞', 'A賞', 'C賞'])
  })
})

describe('戦略タブ（規定の備考・提出する梗概／キャッチコピー・特記事項）', () => {
  it('入力中の文字数（原稿と同じ数え方）と規定の判定を出し、畳むと規定を外れたものに札が出る', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    const subId = actions.addSubmission(titleId, '海風小説大賞')
    actions.updateSubmission(subId, { status: 'planned' })
    renderTab(titleId)
    const card = screen.getByTestId('submission-card')
    await user.click(within(card).getByTestId('submission-toggle'))
    const count = (id: string) => within(card).getByTestId(`${id}-count`)

    // 規定の備考は規定の欄の中（文字数の下）
    const limits = within(card).getByRole('group', { name: '規定の単位' }).closest('fieldset')!
    await user.type(within(limits).getByTestId('submission-limit-note'), 'ルビ不可')

    // 梗概・あらすじ: 空白・改行、ルビの記号と読みは数えない。規定が無ければ数だけ
    expect(count('submission-synopsis').textContent).toBe('0字（空白・改行を除く）')
    await user.type(within(card).getByTestId('submission-synopsis'), '｜海辺《うみべ》の 町\n少女')
    expect(count('submission-synopsis').textContent).toBe('6字（空白・改行を除く）')
    await user.type(within(card).getByTestId('submission-synopsis-min'), '1万{Enter}')
    expect(count('submission-synopsis').textContent).toBe('6字（空白・改行を除く） → あと9,994字')
    expect(count('submission-synopsis').className).toContain('is-short')
    await user.clear(within(card).getByTestId('submission-synopsis-min'))
    await user.type(within(card).getByTestId('submission-synopsis-min'), '{Enter}')
    await user.type(within(card).getByTestId('submission-synopsis-max'), '5{Enter}')
    expect(count('submission-synopsis').textContent).toBe('6字（空白・改行を除く） → 1字超えています')
    expect(count('submission-synopsis').className).toContain('is-over')
    // 数字として読めない値は保存しない
    await user.clear(within(card).getByTestId('submission-synopsis-max'))
    await user.type(within(card).getByTestId('submission-synopsis-max'), 'たくさん{Enter}')
    expect(await screen.findByText(/梗概・あらすじの文字数は数字で入力してください/)).toBeTruthy()
    expect(within(card).getByTestId('submission-synopsis-max')).toHaveProperty('value', '5')

    // キャッチコピー
    await user.type(within(card).getByTestId('submission-catchphrase'), 'その嘘は、世界を救う')
    await user.type(within(card).getByTestId('submission-catchphrase-min'), '20{Enter}')
    expect(count('submission-catchphrase').textContent).toBe('10字（空白・改行を除く） → あと10字')
    await user.type(within(card).getByTestId('submission-catchphrase-max'), '10{Enter}')
    // 下限が上限より大きい
    expect(within(card).getByTestId('submission-catchphrase-box').textContent).toContain('下限が上限より大きくなっています')
    await user.clear(within(card).getByTestId('submission-catchphrase-max'))
    await user.type(within(card).getByTestId('submission-catchphrase-max'), '40{Enter}')

    await user.type(within(card).getByTestId('submission-special-notes'), '担当さんに確認')
    await user.tab()
    expect(getData().submissions[subId]).toMatchObject({
      limitNote: 'ルビ不可',
      synopsis: '｜海辺《うみべ》の 町\n少女',
      synopsisMin: null,
      synopsisMax: 5,
      catchphrase: 'その嘘は、世界を救う',
      catchphraseMin: 20,
      catchphraseMax: 40,
      specialNotes: '担当さんに確認',
    })

    // 畳むと、規定を外れたものに札が出る
    await user.click(within(card).getByTestId('submission-close'))
    expect(
      within(card)
        .getAllByTestId('submission-text-limit')
        .map((c) => c.textContent),
    ).toEqual(['梗概 +1字', 'キャッチコピー あと10字'])

    // 応募時の原稿を記録すると、提出した梗概・キャッチコピーも控える（後から直しても変わらない）
    await user.click(within(card).getByTestId('submission-toggle'))
    await user.click(within(card).getByTestId('snapshot-record'))
    expect(within(card).getByTestId('snapshot-synopsis-toggle').textContent).toBe('提出した梗概・あらすじ（6字）')
    expect(within(card).getByTestId('snapshot-catchphrase-text').textContent).toBe('その嘘は、世界を救う')
    act(() => {
      actions.updateSubmission(subId, { catchphrase: '直したコピー', status: 'submitted' })
    })
    expect(within(card).getByTestId('snapshot-catchphrase-text').textContent).toBe('その嘘は、世界を救う')
    // 応募した後は札を出さない
    await user.click(within(card).getByTestId('submission-close'))
    expect(within(card).queryAllByTestId('submission-text-limit')).toHaveLength(0)
  })

  it('細かな規定の書き場所は「規定の備考」だけ（コンテストの概要の例には応募規定を挙げず、規定の備考へ案内する）', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    actions.addSubmission(titleId, '海風小説大賞')
    renderTab(titleId)
    const card = screen.getByTestId('submission-card')
    await user.click(within(card).getByTestId('submission-toggle'))
    const overview = within(card).getByTestId('submission-overview').getAttribute('placeholder') ?? ''
    expect(overview).not.toContain('応募規定')
    expect(overview).toContain('「規定の備考」')
    expect(within(card).getByTestId('submission-limit-note').getAttribute('placeholder')).toContain('ルビ不可')
  })

  it('梗概の文字数の規定は、日本語入力で「10万」と変換している途中では保存・判定せず、確定した時に保存する', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    const subId = actions.addSubmission(titleId, '海風小説大賞')
    renderTab(titleId)
    const card = screen.getByTestId('submission-card')
    await user.click(within(card).getByTestId('submission-toggle'))
    await user.type(within(card).getByTestId('submission-synopsis'), '海辺の町')
    await user.tab()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const input = within(card).getByTestId('submission-synopsis-min') as HTMLInputElement
    act(() => input.focus())
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '１０' } })
    fireEvent.change(input, { target: { value: '１０ま' } })
    // ふつうの欄が反映される 1.5 秒を過ぎても、変換中の入力は保存しない（注意も出さず、入力欄も作り直さない）
    act(() => vi.advanceTimersByTime(2000))
    expect(useToasts.getState().toasts).toEqual([])
    expect(screen.queryByText(/梗概・あらすじの文字数は数字で入力してください/)).toBeNull()
    expect(within(card).getByTestId('submission-synopsis-min')).toBe(input)
    expect(input.value).toBe('１０ま')
    expect(document.activeElement).toBe(input)
    expect(getData().submissions[subId].synopsisMin).toBeNull()
    expect(within(card).getByTestId('submission-synopsis-count').textContent).toBe('4字（空白・改行を除く）')

    fireEvent.compositionEnd(input)
    fireEvent.change(input, { target: { value: '１０万' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(getData().submissions[subId].synopsisMin).toBe(100_000)
    expect(within(card).getByTestId('submission-synopsis-count').textContent).toBe('4字（空白・改行を除く） → あと99,996字')
  })

  it('長い梗概の控えは畳んでおき、開くと読める。古い記録・空の控えは出さない', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    const a = actions.addSubmission(titleId, 'A賞')
    actions.updateSubmission(a, { synopsis: 'あ'.repeat(300), catchphrase: '' })
    actions.recordSubmissionSnapshot(a)
    const b = actions.addSubmission(titleId, 'B賞')
    actions.recordSubmissionSnapshot(b)
    renderTab(titleId)
    const [cardA, cardB] = screen.getAllByTestId('submission-card')
    await user.click(within(cardA).getByTestId('submission-toggle'))
    expect(within(cardA).getByTestId('snapshot-synopsis-toggle').textContent).toBe('提出した梗概・あらすじ（300字）')
    expect(within(cardA).queryByTestId('snapshot-synopsis-text')).toBeNull()
    expect(within(cardA).queryByTestId('snapshot-catchphrase')).toBeNull()
    await user.click(within(cardA).getByTestId('snapshot-synopsis-toggle'))
    expect(within(cardA).getByTestId('snapshot-synopsis-text').textContent).toBe('あ'.repeat(300))
    await user.click(within(cardB).getByTestId('submission-toggle'))
    expect(within(cardB).getByTestId('snapshot-info')).toBeTruthy()
    expect(within(cardB).queryByTestId('snapshot-texts')).toBeNull()
  })
})

describe('戦略タブ（現在の原稿・応募時の原稿）', () => {
  it('採用原稿なしは話と特殊ブロックを分けて数える', () => {
    const { titleId, pieceIds } = seedTitle(['本文', '本文'])
    actions.setActiveVersion(pieceIds[1], null)
    const sp = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
    actions.setActiveVersion(sp, null)
    renderTab(titleId)
    expect(screen.getByTestId('summary-missing').textContent).toBe('採用原稿なし 1話＋特殊1（文字数に含まれていません）')
  })

  it('応募時の原稿の内訳（記録順・稿・文字数・その後の変化）を出し、読める・書き出せる', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seedTitle(['一話の本文', '二話の本文'])
    actions.updatePiece(pieceIds[0], { subtitle: '旅立ち' })
    const sp = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
    actions.updateVersion(getData().pieces[sp].versionIds[0], { body: '序' })
    const subId = actions.addSubmission(titleId, '潮騒文庫新人賞')
    actions.recordSubmissionSnapshot(subId)
    // 記録後: 第1話は稿の名前だけ変更（変化なし）、第2話は本文を編集、第3話を追加
    actions.updateVersion(getData().pieces[pieceIds[0]].activeVersionId!, { name: '決定稿' })
    actions.updateVersion(getData().pieces[pieceIds[1]].activeVersionId!, { body: '二話の本文を直した' })
    actions.addEpisode(titleId)
    renderTab(titleId)
    await user.click(screen.getByTestId('submission-toggle'))

    // 特殊ブロックは話に数えない
    expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・11字・約3枚・2話＋特殊1$/)
    expect(screen.getAllByTestId('snapshot-piece').map((r) => r.textContent)).toEqual([
      'プロローグ第1稿・1字',
      '第1話旅立ち第1稿・5字',
      '第2話第1稿・5字本文を編集',
      '第3話記録後に追加追加',
    ])
    expect(screen.getByTestId('snapshot-diff').textContent).toBe(
      '記録した後に変わったもの：本文の編集 1件、追加 1件（文字数 +4字）',
    )

    await user.click(screen.getByTestId('snapshot-export'))
    expect(downloadFile).toHaveBeenCalledTimes(1)
    const [fileName, text] = vi.mocked(downloadFile).mock.calls[0]
    expect(fileName).toBe('海の記憶_潮騒文庫新人賞_応募時の原稿.txt')
    expect(text).toBe('海の記憶\n\nプロローグ\n\n序\n\n\n第1話　旅立ち\n\n一話の本文\n\n\n第2話\n\n二話の本文\n')

    await user.click(screen.getByTestId('snapshot-read'))
    const reader = await screen.findByTestId('snapshot-reader')
    expect(reader.textContent).toContain('二話の本文')
    expect(reader.textContent).not.toContain('直した')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('snapshot-reader')).toBeNull())
  })

  it('以前の形式の記録（話ごとの内容なし）は件数と、記録し直しの案内だけを出す', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['一話', '二話'])
    actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
    const subId = actions.addSubmission(titleId, '旧賞')
    actions.recordSubmissionSnapshot(subId)
    const snap = getData().submissions[subId].snapshot!
    actions.updateSubmission(subId, { snapshot: { at: snap.at, charCount: snap.charCount, activeVersions: snap.activeVersions } })
    renderTab(titleId)
    await user.click(screen.getByTestId('submission-toggle'))
    expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・4字・2話＋特殊1$/)
    expect(screen.getByTestId('snapshot-legacy').textContent).toContain('「記録し直す」')
    expect(screen.queryByTestId('snapshot-pieces')).toBeNull()
    expect(screen.queryByTestId('snapshot-export')).toBeNull()
  })

  it('2.0 までの数え方（ルビの記号と読みも数えた）の記録も、画面では本文の控えから数え直した文字数を出す', async () => {
    const user = userEvent.setup()
    // 表示される文字: 魔法使いが来た。（8字）。2.0 までは記号と読みも数えて 16字
    const { titleId, pieceIds } = seedTitle(['｜魔法使い《ウィザード》が来た。'])
    const subId = actions.addSubmission(titleId, '潮騒文庫新人賞')
    actions.recordSubmissionSnapshot(subId)
    const snap = getData().submissions[subId].snapshot!
    const piece = snap.pieces![pieceIds[0]]
    actions.updateSubmission(subId, {
      snapshot: { ...snap, charCount: 16, pieces: { [pieceIds[0]]: { ...piece, chars: 16 } } },
      status: 'submitted',
      maxChars: 10,
    })
    // 記録の後に1字足した
    actions.updateVersion(getData().pieces[pieceIds[0]].activeVersionId!, { body: '｜魔法使い《ウィザード》が来た。ね' })
    renderTab(titleId)

    // 見出しの規定の判定は、数え直した 8字で（記録した 16字なら「規定を6字超過」）
    expect(screen.getByTestId('submission-limit').textContent).toBe('応募時 規定内')
    await user.click(screen.getByTestId('submission-toggle'))
    expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・8字・約1枚・1話$/)
    expect(screen.getByTestId('snapshot-piece').textContent).toBe('第1話第1稿・8字本文を編集')
    expect(screen.getByTestId('snapshot-diff').textContent).toBe('記録した後に変わったもの：本文の編集 1件（文字数 +1字）')
    expect(screen.getByTestId('submission-limit-detail').textContent).toBe('応募時の原稿 8字 → 規定内')
    await user.click(screen.getByTestId('snapshot-read'))
    const reader = await screen.findByTestId('snapshot-reader')
    expect(reader.textContent).toContain('に記録・8字')
    // 記録そのものは書き換えない
    expect(getData().submissions[subId].snapshot!.charCount).toBe(16)
  })

  it('状態を応募済みにすると応募時の原稿の記録をすすめ、記録する時は空の応募日に今日を入れる', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['一話', '二話です'])
    const a = actions.addSubmission(titleId, 'A賞')
    const b = actions.addSubmission(titleId, 'B賞')
    actions.updateSubmission(b, { submittedOn: '2026-01-05' })
    renderTab(titleId)
    const cards = screen.getAllByTestId('submission-card')

    // 記録しない
    await user.click(within(cards[0]).getByTestId('submission-toggle'))
    await user.selectOptions(within(cards[0]).getByTestId('submission-status-select'), 'submitted')
    let dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('現在の採用原稿（6字・2話）')
    expect(dialog.textContent).toContain('応募日には今日')
    await user.click(within(dialog).getByRole('button', { name: '記録しない' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(getData().submissions[a]).toMatchObject({ status: 'submitted', snapshot: null, submittedOn: '' })

    // 応募日が入っていれば応募日はそのまま
    await user.click(within(cards[1]).getByTestId('submission-toggle'))
    await user.selectOptions(within(cards[1]).getByTestId('submission-status-select'), 'submitted')
    dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toContain('応募日には今日')
    await user.click(within(dialog).getByRole('button', { name: '記録する' }))
    await waitFor(() => expect(getData().submissions[b].snapshot?.charCount).toBe(6))
    expect(getData().submissions[b].submittedOn).toBe('2026-01-05')
    // 記録があれば、選考中にしても尋ねない
    await user.selectOptions(within(cards[1]).getByTestId('submission-status-select'), 'reviewing')
    expect(screen.queryByRole('dialog')).toBeNull()

    // 応募前に戻してから応募済みにし、記録する → 応募日に今日
    await user.selectOptions(within(cards[0]).getByTestId('submission-status-select'), 'planned')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.selectOptions(within(cards[0]).getByTestId('submission-status-select'), 'submitted')
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '記録する' }))
    await waitFor(() => expect(getData().submissions[a].snapshot).not.toBeNull())
    expect(getData().submissions[a].submittedOn).toBe(toYmd(new Date()))
  })
})

describe('戦略タブ（状態ごとの見出し・規定）', () => {
  it('応募前は締切と現在の原稿、結果待ちは応募日・結果発表と応募時の原稿、終了後は結果と次の一手を出す', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 27, 10, 0))
    const { titleId, pieceIds } = seedTitle(['あ'.repeat(1000)])
    const before = actions.addSubmission(titleId, '応募前')
    actions.updateSubmission(before, { status: 'planned', deadline: '2026-11-06', minChars: 1200 })
    const waiting = actions.addSubmission(titleId, '選考中')
    actions.updateSubmission(waiting, {
      status: 'reviewing',
      deadline: '2026-10-01',
      submittedOn: '2026-09-30',
      resultOn: '2026-11-08',
      minChars: 1200,
    })
    actions.recordSubmissionSnapshot(waiting)
    const unrecorded = actions.addSubmission(titleId, '記録なし')
    actions.updateSubmission(unrecorded, { status: 'submitted', deadline: '2026-10-01', resultOn: '2026-10-20', minChars: 1200 })
    const finished = actions.addSubmission(titleId, '落選')
    actions.updateSubmission(finished, {
      status: 'rejected',
      deadline: '2026-06-01',
      minChars: 99_999,
      result: '一次選考で落選。\n中盤が遅いとの講評。',
      revisionPlan: '中盤を削る',
    })
    // 記録後に原稿を1,500字に増やした（応募時は1,000字）
    actions.updateVersion(getData().pieces[pieceIds[0]].activeVersionId!, { body: 'あ'.repeat(1500) })
    renderTab(titleId)
    const [c1, c2, c3, c4] = screen.getAllByTestId('submission-card')

    expect(within(c1).getByTestId('submission-deadline').textContent).toBe('締切 2026/11/06（あと10日）')
    expect(within(c1).getByTestId('submission-limit').textContent).toBe('規定内')

    expect(within(c2).queryByTestId('submission-deadline')).toBeNull()
    expect(within(c2).getByTestId('submission-submitted-on').textContent).toBe('応募日 2026/09/30')
    expect(within(c2).getByTestId('submission-result-on').textContent).toBe('結果発表まであと12日（2026/11/08）')
    // 応募時の原稿（1,000字）と比べ、応募した時の事実として言う（「あと…必要」は応募前だけ）
    expect(within(c2).getByTestId('submission-limit').textContent).toBe('応募時 規定に200字不足')
    expect(within(c2).getByTestId('submission-limit').getAttribute('title')).toBe('規定 1,200字以上（応募時の原稿 1,000字）')

    // 応募後で記録がなければ、見出しでは規定を判定しない
    expect(within(c3).getByTestId('submission-result-on').textContent).toBe('結果発表日を過ぎています（2026/10/20）')
    expect(within(c3).queryByTestId('submission-limit')).toBeNull()

    // 終了: 締切・規定の注意は出さず、結果 → 改稿方針 → 再応募方針の抜粋を出す
    expect(within(c4).queryByTestId('submission-deadline')).toBeNull()
    expect(within(c4).queryByTestId('submission-limit')).toBeNull()
    expect(
      within(c4)
        .getAllByTestId('submission-followup')
        .map((e) => e.textContent),
    ).toEqual(['結果・講評一次選考で落選。 中盤が遅いとの講評。', '改稿方針中盤を削る', '再応募方針未記入'])
  })

  it('結果待ちの詳細では応募時の原稿と比べ、記録がなければ現在の原稿で比べていることを示す', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['あ'.repeat(1000)])
    const id = actions.addSubmission(titleId, 'A賞')
    actions.updateSubmission(id, { status: 'submitted', minChars: 1200 })
    renderTab(titleId)
    await user.click(screen.getByTestId('submission-toggle'))
    expect(screen.getByTestId('submission-limit-detail').textContent).toBe(
      '現在の採用原稿 1,000字 → 規定に200字不足（応募時の原稿が未記録のため、現在の採用原稿と比べています）',
    )
    await user.click(screen.getByTestId('snapshot-record'))
    expect(screen.getByTestId('submission-limit-detail').textContent).toBe('応募時の原稿 1,000字 → 規定に200字不足')
  })

  it('規定を原稿用紙換算の枚数で入れられる', async () => {
    const user = userEvent.setup()
    // 2,000字の1段落 → 100行 → 5枚
    const { titleId } = seedTitle(['あ'.repeat(2000)])
    const id = actions.addSubmission(titleId, 'A賞')
    renderTab(titleId)
    await user.click(screen.getByTestId('submission-toggle'))
    const card = screen.getByTestId('submission-card')
    expect(card.textContent).toContain('規定（空白・改行を除いた文字数）')
    await user.click(screen.getByTestId('limit-unit-pages'))
    expect(getData().submissions[id].limitUnit).toBe('pages')
    expect(screen.getByTestId('limit-unit-pages').getAttribute('aria-pressed')).toBe('true')
    expect(card.textContent).toContain('規定（400字詰め原稿用紙換算の枚数）')

    await user.type(screen.getByTestId('submission-min'), '17枚{Enter}')
    expect(getData().submissions[id].minChars).toBe(17)
    expect(screen.getByTestId('submission-limit').textContent).toBe('あと12枚必要')
    expect(screen.getByTestId('submission-limit').getAttribute('title')).toBe('規定 17枚以上（現在の採用原稿 約5枚）')
    expect(screen.getByTestId('submission-limit-detail').textContent).toBe('現在の採用原稿 約5枚 → あと12枚必要')
    await user.clear(screen.getByTestId('submission-min'))
    await user.type(screen.getByTestId('submission-min'), '{Enter}')
    await user.type(screen.getByTestId('submission-max'), '4{Enter}')
    expect(screen.getByTestId('submission-limit').textContent).toBe('1枚超過')
  })

  it('規定に数字でない値を入れて Tab で移っても、フォーカスは次の欄に残る', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    const id = actions.addSubmission(titleId, 'A賞')
    actions.updateSubmission(id, { maxChars: 5000 })
    renderTab(titleId)
    await user.click(screen.getByTestId('submission-toggle'))
    await user.type(screen.getByTestId('submission-min'), 'たくさん')
    await user.tab()
    // 読めない値の欄だけが保存済みの値に戻り、移った先の欄はそのまま
    expect(document.activeElement).toBe(screen.getByTestId('submission-max'))
    expect(screen.getByTestId<HTMLInputElement>('submission-min').value).toBe('')
    expect(screen.getByTestId<HTMLInputElement>('submission-max').value).toBe('5000')
    expect(getData().submissions[id].minChars).toBeNull()
  })

  it('開いたまま日付が変わっても、画面に戻った時に締切までの日数を更新する', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 27, 23, 59, 30))
    const { titleId } = seedTitle(['本文'])
    const id = actions.addSubmission(titleId, 'A賞')
    actions.updateSubmission(id, { status: 'planned', deadline: '2026-10-30' })
    renderTab(titleId)
    expect(screen.getByTestId('submission-deadline').textContent).toBe('締切 2026/10/30（あと3日）')
    vi.setSystemTime(new Date(2026, 9, 28, 0, 0, 5))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByTestId('submission-deadline').textContent).toBe('締切 2026/10/30（あと2日）')
  })

  it('締切順は応募前で締切が近いもの、結果待ち、終了・締切切れの順', async () => {
    const user = userEvent.setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 27, 10, 0))
    const { titleId } = seedTitle(['本文'])
    const add = (name: string, patch: Parameters<typeof actions.updateSubmission>[1]) =>
      actions.updateSubmission(actions.addSubmission(titleId, name), patch)
    add('受賞', { status: 'won', deadline: '2026-01-10' })
    add('選考中', { status: 'reviewing', deadline: '2026-09-01', resultOn: '2026-12-20' })
    add('締切切れ', { status: 'planned', deadline: '2026-10-01' })
    add('来月', { status: 'considering', deadline: '2026-11-30' })
    renderTab(titleId)
    await user.click(screen.getByTestId('sort-deadline'))
    expect(screen.getAllByTestId('submission-name').map((e) => e.textContent)).toEqual(['来月', '選考中', '受賞', '締切切れ'])
  })
})
