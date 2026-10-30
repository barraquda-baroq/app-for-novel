// 相対比較（内部名は bench）の画面: ホームの棚（カード・追加・並べ替え・削除）、作品の画面（観点ごとの分析・開閉・全文・足す・
// 直す・削除・手動の依頼文・貼り付け）、作品批評タブの「相対比較する作品」（選ぶ・外す・結果の比べた作品）と手動の依頼の分析
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shortId } from '../../claude/refs'
import { createPersistence } from '../../db/persistence'
import { listTrash } from '../../domain/trash'
import type { BenchAnalysis, ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { copyText } from '../../ui/browser'
import { AppFrame } from '../../ui/Layout'
import { ManualDialog } from '../claude/ManualDialog'
import { BenchShelf } from '../home/BenchShelf'
import { CritiqueTab } from '../title/critique/CritiqueTab'
import { BenchWorkPage } from './BenchWorkPage'

vi.mock('../../ui/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ui/browser')>()
  return { ...original, copyText: vi.fn(async () => true) }
})

let n = 0

beforeEach(async () => {
  await initStore(createPersistence(`test-db-bench-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  vi.mocked(copyText).mockClear()
})

/** 作品と分析（作った時刻をずらす） */
function seedWork(): { workId: ID; titleId: ID } {
  const titleId = actions.createTitle('星の庭')
  const workId = actions.addBenchWork({ name: '銀河の果て', author: '山田', year: '2019', pdfPlace: 'プロジェクト「相対比較」' })
  const at = (viewpoint: string, body: string, runDate: string, createdAt: number) => {
    const id = actions.addBenchAnalysis(workId, { viewpoint, body, runDate })
    const a = getData().benchAnalyses[id]
    // 作った時刻を決める（観点のまとまりの順は最初に分析した時刻）
    const data = getData()
    data.benchAnalyses[id] = { ...a, createdAt } as BenchAnalysis
    return id
  }
  at('文体', '## 文体\n短い文を重ねる。', '2026-10-01', 1)
  const paragraphs = Array.from({ length: 30 }, (_, i) => `段落${i + 1}。${'あ'.repeat(200)}`).join('\n\n')
  at('構成', `## 構成\n三幕。\n\n${paragraphs}\n\n最後の一文。`, '2026-10-02', 2)
  at('文体', '## 文体（読み直し）\n会話が多い。', '2026-10-20', 3)
  actions.addTitleBenchWork(titleId, workId)
  return { workId, titleId }
}

function renderPage(workId: ID) {
  const router = createMemoryRouter(
    [
      {
        path: '/bench/:workId',
        element: (
          <AppFrame>
            <BenchWorkPage />
          </AppFrame>
        ),
      },
      { path: '/', element: <p data-testid="home-route">ホーム</p> },
    ],
    { initialEntries: [`/bench/${workId}`] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('ホームの棚「相対比較」', () => {
  it('作品名・著者・分析の数と観点・比べるタイトルをカードに出し、足す・並べ替え・削除（ゴミ箱へ）ができる', async () => {
    const user = userEvent.setup()
    const { workId } = seedWork()
    render(
      <MemoryRouter>
        <AppFrame>
          <BenchShelf headingId="h" />
        </AppFrame>
      </MemoryRouter>,
    )
    const card = screen.getByTestId('bench-card')
    expect(within(card).getByTestId('bench-card-name').textContent).toBe('銀河の果て')
    expect(within(card).getByTestId('bench-card-author').textContent).toBe('山田・2019')
    expect(within(card).getByTestId('bench-card-count').textContent).toBe('分析 3件')
    expect(
      within(card)
        .getAllByTestId('bench-card-viewpoint')
        .map((c) => c.textContent),
    ).toEqual(['文体2', '構成'])
    expect(within(card).getByTestId('bench-card-comparing').textContent).toBe('比べるタイトル: 『星の庭』')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('相対比較')

    // 作品を追加（作品名は必須）
    expect(screen.getByTestId('new-bench-work').textContent).toBe('作品を追加')
    await user.click(screen.getByTestId('new-bench-work'))
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe('作品を追加')
    expect(screen.getByTestId('bench-work-save').textContent).toBe('追加')
    await user.click(screen.getByTestId('bench-work-save'))
    expect(screen.getByRole('alert').textContent).toBe('作品名を入れてください')
    await user.type(screen.getByTestId('bench-work-name'), '海の記憶')
    await user.type(screen.getByTestId('bench-work-author'), '佐藤')
    await user.click(screen.getByTestId('bench-work-save'))
    await waitFor(() => expect(screen.getAllByTestId('bench-card')).toHaveLength(2))

    // 並べ替え
    await user.click(screen.getByTestId('bench-edit-toggle'))
    const cards = () => screen.getAllByTestId('bench-card').map((c) => within(c).getByTestId('bench-card-name').textContent)
    await user.click(within(screen.getAllByTestId('bench-card')[1]).getByTestId('bench-up'))
    expect(cards()).toEqual(['海の記憶', '銀河の果て'])

    // 削除（確かめてからゴミ箱へ。相対比較する作品にしているタイトルでは、ゴミ箱にある間は出ない）
    await user.click(within(screen.getAllByTestId('bench-card')[1]).getByTestId('bench-delete'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「銀河の果て」を相対比較から削除しますか？')
    expect(dialog.textContent).toContain('この作品を相対比較から削除し、分析（3件）もいっしょにゴミ箱に移します。')
    expect(dialog.textContent).toContain(
      '相対比較する作品にしているタイトル（1件）では、ゴミ箱にある間は相対比較する作品に出ません',
    )
    await user.click(within(dialog).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(cards()).toEqual(['海の記憶']))
    expect(getData().benchWorks[workId]).toBeUndefined()
    expect(listTrash(getData().trashEntries)[0]).toMatchObject({ kind: 'benchWork', label: '銀河の果て' })
  })

  it('棚が空の時は説明と「作品を追加」', () => {
    render(
      <MemoryRouter>
        <AppFrame>
          <BenchShelf headingId="h" />
        </AppFrame>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('bench-empty').textContent).toContain('PDF は claude.ai のプロジェクトに置いたまま')
    expect(within(screen.getByTestId('bench-empty')).getByRole('button').textContent).toBe('作品を追加')
    expect(screen.getByTestId('bench-count').textContent).toBe('0')
  })
})

describe('作品の画面', () => {
  it('観点ごと（最初に分析した順）・中は新しい日付から。開閉し、長い分析は「全文を表示」で全部', async () => {
    const user = userEvent.setup()
    const { workId } = seedWork()
    renderPage(workId)
    expect(screen.getByTestId('bench-work-title').textContent).toBe('銀河の果て')
    expect(document.title).toContain('相対比較: 銀河の果て')
    expect(screen.getByRole('link', { name: '相対比較' }).getAttribute('href')).toBe('/?view=bench')
    expect(screen.getByTestId('bench-work-edit').textContent).toBe('作品の情報を直す')
    expect(screen.getByTestId('bench-work-pdf-place').textContent).toBe('プロジェクト「相対比較」')
    expect(screen.getByTestId('bench-work-comparing').textContent).toBe('『星の庭』')
    const groups = screen.getAllByTestId('bench-group')
    expect(groups.map((g) => g.getAttribute('data-viewpoint'))).toEqual(['文体', '構成'])
    const dates = within(groups[0])
      .getAllByTestId('bench-analysis-date-label')
      .map((d) => d.textContent)
    expect(dates).toEqual(['2026/10/20', '2026/10/01'])
    // 閉じている時は見本だけ
    const long = within(groups[1]).getByTestId('bench-analysis')
    expect(within(long).queryByTestId('bench-analysis-body')).toBeNull()
    await user.click(within(long).getByTestId('bench-analysis-toggle'))
    expect(within(long).getByTestId('bench-analysis-toggle').getAttribute('aria-expanded')).toBe('true')
    const body = await within(long).findByTestId('bench-analysis-body')
    expect(body.textContent).not.toContain('最後の一文')
    await user.click(within(long).getByTestId('bench-analysis-more'))
    await waitFor(() => expect(within(long).getByTestId('bench-analysis-body').textContent).toContain('最後の一文'))
    // コピー
    await user.click(within(long).getByTestId('bench-analysis-copy'))
    expect(vi.mocked(copyText).mock.calls[0][0]).toContain('最後の一文')
    // 閉じる
    await user.click(within(long).getByTestId('bench-analysis-toggle'))
    expect(within(long).queryByTestId('bench-analysis-body')).toBeNull()
    // すべて開く
    await user.click(screen.getByTestId('bench-toggle-all'))
    expect(screen.getAllByTestId('bench-analysis-body')).toHaveLength(3)
  })

  it('分析を足す（観点の候補）・直す・削除（ゴミ箱へ）', async () => {
    const user = userEvent.setup()
    const { workId } = seedWork()
    renderPage(workId)
    await user.click(screen.getByTestId('bench-add-analysis'))
    const dialog = await screen.findByTestId('bench-analysis-dialog')
    const chips = within(dialog)
      .getAllByTestId('bench-analysis-suggestion')
      .map((c) => c.textContent)
    // すべての作品の観点（多い順）と、既定の観点
    expect(chips.slice(0, 2)).toEqual(['文体', '構成'])
    expect(chips).toContain('冒頭の掴み')
    await user.click(within(dialog).getByRole('button', { name: '冒頭の掴み' }))
    await user.type(within(dialog).getByTestId('bench-analysis-input'), '一文目で謎を置く。')
    await user.click(screen.getByTestId('bench-analysis-save'))
    await waitFor(() =>
      expect(screen.getAllByTestId('bench-group').map((g) => g.getAttribute('data-viewpoint'))).toContain('冒頭の掴み'),
    )
    // 足した分析は開いている
    const added = within(screen.getByText('冒頭の掴み', { selector: 'h3' }).closest('section')!).getByTestId('bench-analysis')
    expect(within(added).getByTestId('bench-analysis-toggle').getAttribute('aria-expanded')).toBe('true')
    // 直す
    await user.click(within(added).getByTestId('bench-analysis-edit'))
    const edit = await screen.findByTestId('bench-analysis-dialog')
    const body = within(edit).getByTestId('bench-analysis-input')
    await user.clear(body)
    await user.type(body, '直した分析')
    await user.click(screen.getByTestId('bench-analysis-save'))
    await waitFor(() =>
      expect(Object.values(getData().benchAnalyses).find((a) => a.viewpoint === '冒頭の掴み')?.body).toBe('直した分析'),
    )
    // 削除
    await user.click(within(added).getByTestId('bench-analysis-delete'))
    const confirm = await screen.findByRole('dialog')
    await user.click(within(confirm).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(Object.values(getData().benchAnalyses).find((a) => a.viewpoint === '冒頭の掴み')).toBeUndefined())
    expect(listTrash(getData().trashEntries)[0]).toMatchObject({ kind: 'benchAnalysis', parentLabel: '銀河の果て' })
  })

  it('Claude に頼む（手動）: 観点を選んで依頼文をコピーし、貼り付けで分析を足す（2回目は増えない）', async () => {
    const user = userEvent.setup()
    const { workId } = seedWork()
    renderPage(workId)
    await user.click(screen.getByTestId('bench-manual'))
    const dialog = await screen.findByTestId('bench-manual-dialog')
    // 既定の観点は選んである。人物を外し、観点を足す
    await user.click(within(dialog).getByRole('button', { name: '人物' }))
    await user.type(within(dialog).getByTestId('bench-manual-new-viewpoint'), '会話の運び')
    await user.click(within(dialog).getByTestId('bench-manual-add-viewpoint'))
    await user.click(within(dialog).getByTestId('bench-manual-copy'))
    const prompt = vi.mocked(copyText).mock.calls[0][0]
    expect(prompt).toContain('このプロジェクトのナレッジにある作品『銀河の果て』（山田）の PDF')
    expect(prompt).toContain('- 構成\n- 文体\n- 冒頭の掴み\n- 会話の運び')
    expect(prompt).not.toContain('- 人物')
    expect(prompt).toContain(`"work":"${shortId('benchWork', workId)}"`)

    await user.click(screen.getByTestId('bench-manual-open-paste'))
    const paste = await screen.findByTestId('paste-dialog')
    const answer = [
      '分析しました。',
      '```novel-studio-v1',
      JSON.stringify({
        tool: 'novel_add_bench_analysis',
        input: {
          work: 'w:xxxx',
          items: [{ viewpoint: '会話の運び', body_markdown: '## 会話\n間が良い。', run_date: '2026-10-30' }],
        },
      }),
      '```',
    ].join('\n')
    const input = within(paste).getByTestId('paste-input')
    await user.click(input)
    await user.paste(answer)
    await waitFor(() => expect(screen.getByTestId('paste-add').textContent).toBe('追加（1件）'))
    await user.click(screen.getByTestId('paste-add'))
    await waitFor(() =>
      expect(screen.getAllByTestId('bench-group').map((g) => g.getAttribute('data-viewpoint'))).toContain('会話の運び'),
    )
    expect(Object.values(getData().benchAnalyses).find((a) => a.viewpoint === '会話の運び')?.source).toBe('paste')
    // 同じ答えをもう一度
    await user.click(screen.getByTestId('bench-paste'))
    const again = await screen.findByTestId('paste-dialog')
    await user.click(within(again).getByTestId('paste-input'))
    await user.paste(answer)
    await waitFor(() => expect(within(again).getByTestId('paste-summary').textContent).toBe('重複 1件'))
    expect((screen.getByTestId('paste-add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('作品を削除するとゴミ箱へ移り、ホームの棚へ戻る。無い作品は「見つかりません」', async () => {
    const user = userEvent.setup()
    const { workId } = seedWork()
    const router = renderPage(workId)
    await user.click(screen.getByTestId('bench-work-delete'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('「銀河の果て」を相対比較から削除しますか？')
    expect(dialog.textContent).toContain('PDF そのものは claude.ai のプロジェクトにあるので、消えません。')
    await user.click(within(dialog).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(router.state.location.search).toBe('?view=bench'))
    cleanup()
    renderPage('gone')
    expect(screen.getByText('相対比較の作品が見つかりません。削除された可能性があります。')).toBeTruthy()
    expect(screen.getByRole('link', { name: '相対比較の一覧へ' })).toBeTruthy()
  })

  it('Claude が作った作品には「Claude が作成」の札（アプリのほかの表記と同じく Claude のあとに空白）。手で足した作品には出さない', () => {
    const { workId } = seedWork()
    renderPage(workId)
    expect(screen.queryByTestId('bench-work-source')).toBeNull()
    cleanup()
    for (const [source, label] of [
      ['claude', 'Claude が作成'],
      ['paste', 'Claude（貼り付け）が作成'],
    ] as const) {
      const data = getData()
      data.benchWorks[workId] = { ...data.benchWorks[workId], source }
      renderPage(workId)
      expect(screen.getByTestId('bench-work-source').textContent).toBe(label)
      cleanup()
    }
  })

  it('作品の情報を直す', async () => {
    const user = userEvent.setup()
    const { workId } = seedWork()
    renderPage(workId)
    await user.click(screen.getByTestId('bench-work-edit'))
    await user.type(screen.getByTestId('bench-work-genre'), 'SF')
    await user.type(screen.getByTestId('bench-work-note'), '冒頭を参考に')
    await user.click(screen.getByTestId('bench-work-save'))
    await waitFor(() => expect(screen.getByTestId('bench-work-biblio').textContent).toBe('山田・2019・SF'))
    expect(screen.getByTestId('bench-work-note-text').textContent).toBe('冒頭を参考に')
  })
})

describe('作品批評タブ', () => {
  function renderTab(titleId: ID) {
    return render(
      <MemoryRouter>
        <AppFrame>
          <CritiqueTab titleId={titleId} />
        </AppFrame>
      </MemoryRouter>,
    )
  }

  it('相対比較する作品を選ぶ・外す。批評の結果には「比べた作品」を出す', async () => {
    const user = userEvent.setup()
    const { workId, titleId } = seedWork()
    const other = actions.addBenchWork({ name: '海の記憶', author: '佐藤' })
    renderTab(titleId)
    const row = screen.getByTestId('critique-bench')
    expect(within(row).getByRole('heading').textContent).toBe('相対比較する作品')
    expect(
      within(row)
        .getAllByTestId('critique-bench-chip')
        .map((c) => c.textContent),
    ).toEqual(['『銀河の果て』'])
    await user.selectOptions(within(row).getByTestId('critique-bench-add'), other)
    await waitFor(() => expect(getData().titles[titleId].benchWorkIds).toEqual([workId, other]))
    await user.click(within(screen.getAllByTestId('critique-bench-chip')[0]).getByTestId('critique-bench-remove'))
    await waitFor(() => expect(getData().titles[titleId].benchWorkIds).toEqual([other]))
    // 相対比較の作品はすべて選んだので、選ぶ欄は出ない
    actions.addTitleBenchWork(titleId, workId)
    await waitFor(() => expect(screen.queryByTestId('critique-bench-add')).toBeNull())

    const resultId = actions.addCritiqueResult(titleId, { resultMarkdown: '## 比べると' })
    const added = actions.addClaudeRecords([
      {
        table: 'critiqueResults',
        record: { ...getData().critiqueResults[resultId], id: 'cq-bench', benchWorkIds: [workId, 'gone'] },
      },
    ])
    expect(added).toEqual(['cq-bench'])
    const chips = await screen.findAllByTestId('critique-result-bench-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['『銀河の果て』'])
    expect(screen.getByTestId('critique-result-bench').textContent).toContain('比べた作品:')
    expect(screen.getByTestId('critique-result-bench').textContent).toContain('ほか1作品は相対比較から削除されています')
  })

  it('相対比較が空なら、ホームの「相対比較」へ案内する', () => {
    const titleId = actions.createTitle('作品')
    renderTab(titleId)
    expect(screen.getByTestId('critique-bench-empty').textContent).toBe(
      '相対比較にまだ作品がありません。ホームの「相対比較」で追加してください。',
    )
    expect(screen.getByRole('link', { name: 'ホームの「相対比較」' }).getAttribute('href')).toBe('/?view=bench')
  })

  it('手動の依頼: 「相対比較する作品の分析も入れる」で分析をパートに入れる（外せば入れない）', async () => {
    const user = userEvent.setup()
    const { titleId } = seedWork()
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body: '冒頭の本文。' })
    render(
      <MemoryRouter>
        <AppFrame>
          <ManualDialog titleId={titleId} task="critique" tasks={['critique']} onClose={() => undefined} />
        </AppFrame>
      </MemoryRouter>,
    )
    const check = screen.getByTestId('manual-include-bench') as HTMLInputElement
    expect(check.checked).toBe(true)
    expect(check.closest('label')!.textContent).toBe('相対比較する作品の分析も入れる（『銀河の果て』）')
    await user.click(screen.getAllByTestId('manual-copy-part')[0])
    expect(vi.mocked(copyText).mock.calls[0][0]).toContain('=== 相対比較する作品の分析（1作品）===')
    expect(vi.mocked(copyText).mock.calls[0][0]).toContain('短い文を重ねる')
    await user.click(check)
    await user.click(screen.getAllByTestId('manual-copy-part')[0])
    expect(vi.mocked(copyText).mock.calls[1][0]).not.toContain('相対比較する作品の分析')
  })
})
