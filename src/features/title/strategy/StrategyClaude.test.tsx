// 戦略タブの 2.3 の区切り（戦略メモ・改稿案・推敲案）と、結果の貼り付け
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewPaste } from '../../../claude/paste'
import { createPersistence } from '../../../db/persistence'
import { listTrash } from '../../../domain/trash'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { AppFrame } from '../../../ui/Layout'
import { StrategyTab } from './StrategyTab'

let n = 0

function Where() {
  const loc = useLocation()
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>
}

function renderTab(titleId: ID) {
  return render(
    <MemoryRouter initialEntries={[`/t/${titleId}?tab=strategy`]}>
      <AppFrame>
        <Routes>
          <Route path="/t/:titleId" element={<StrategyTab titleId={titleId} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </AppFrame>
    </MemoryRouter>,
  )
}

function seedTitle(bodies: string[]): { titleId: ID; pieceIds: ID[] } {
  const titleId = actions.createTitle('海の記憶')
  const pieceIds = bodies.map((body) => {
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body })
    return id
  })
  return { titleId, pieceIds }
}

const fence = (v: unknown) => '```novel-studio-v1\n' + JSON.stringify(v) + '\n```'

function paste(titleId: ID, v: unknown, now = Date.now()) {
  const p = previewPaste(getData(), fence(v), { titleId, now })
  if (!p.ok) throw new Error(p.error)
  return actions.addClaudeRecords(p.records)
}

const proofCall = (items: unknown[], label = 'ワードサーチ') => ({
  tool: 'novel_add_proofreading',
  input: { title_id: 'x', run_label: label, covered: ['#1', '#2'], items },
})

beforeEach(async () => {
  await initStore(createPersistence(`test-db-strategy-claude-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
})

describe('改稿案', () => {
  it('足すと開いて見出しを書け、チェックすると斜線で下へ沈み、外すと戻る', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    actions.addRevisionIdea(titleId, { heading: '先の案' })
    renderTab(titleId)
    await user.click(screen.getByTestId('add-revision-idea'))
    const input = await screen.findByTestId('revision-heading-input')
    expect(document.activeElement).toBe(input)
    await user.type(input, '終盤を書き直す')
    await user.tab()
    await waitFor(() => expect(Object.values(getData().revisionIdeas).some((r) => r.heading === '終盤を書き直す')).toBe(true))
    const headings = () => screen.getAllByTestId('revision-heading').map((e) => e.textContent)
    expect(headings()).toEqual(['先の案', '終盤を書き直す'])

    await user.click(screen.getAllByTestId('revision-check')[0])
    expect(headings()).toEqual(['終盤を書き直す', '先の案'])
    const sunk = screen.getAllByTestId('revision-idea')[1]
    expect(sunk.getAttribute('data-checked')).toBe('true')
    expect(sunk.className).toContain('is-checked')
    expect(screen.getByTestId('revision-checked-count').textContent).toContain('1件')

    await user.click(within(sunk).getByTestId('revision-check'))
    expect(headings()).toEqual(['終盤を書き直す', '先の案'])
    expect(screen.getAllByTestId('revision-idea').every((e) => e.getAttribute('data-checked') === 'false')).toBe(true)
  })

  it('関係する話を足すとチップになり、押すと話を開く', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seedTitle(['一', '二'])
    actions.addRevisionIdea(titleId, { heading: '案' })
    renderTab(titleId)
    await user.click(screen.getByTestId('revision-toggle'))
    await user.selectOptions(screen.getByTestId('revision-piece-add'), pieceIds[1])
    expect(Object.values(getData().revisionIdeas)[0].pieceIds).toEqual([pieceIds[1]])
    await user.click(screen.getByTestId('revision-toggle'))
    const chip = screen.getByTestId('revision-piece-chip')
    expect(chip.textContent).toBe('第2話')
    await user.click(chip)
    expect(screen.getByTestId('where').textContent).toBe(`/t/${titleId}/p/${pieceIds[1]}`)
  })
})

describe('推敲案', () => {
  it('フラグ → 新しい順、チェックしたものは下へ。種類・状態で絞り込み、チェック済みはまとめて1件でゴミ箱へ', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['窓から見れる景色。食べれる。', '来れる。ありきたりな夕焼け。'])
    paste(
      titleId,
      proofCall([
        { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' },
        { piece: '#1', excerpt: '食べれる', category: 'ra_nuki', suggestion: '食べられる', reason: 'ら抜き' },
      ]),
      Date.now() - 60_000,
    )
    paste(
      titleId,
      proofCall(
        [
          { piece: '#2', excerpt: '来れる', category: 'ra_nuki', reason: 'ら抜き', important: true },
          { piece: '#2', excerpt: 'ありきたりな夕焼け', category: 'cliche', reason: '既成表現' },
        ],
        '2回目',
      ),
    )
    renderTab(titleId)
    const excerpts = () => screen.getAllByTestId('proof-item').map((e) => within(e).getByTestId('proof-jump').textContent)
    expect(excerpts()[0]).toContain('来れる')
    expect(screen.getAllByTestId('proof-location')[0].textContent).toBe('第2話 ¶1')
    expect(screen.getAllByTestId('proof-category').map((e) => e.textContent)).toContain('既成表現')
    expect(screen.getByTestId('proof-runs').textContent).toContain('2回目 2件')
    expect(screen.getByTestId('proof-coverage').textContent).toContain('すべて確認済み')

    // フラグを立てると一番上に
    const shoku = screen.getAllByTestId('proof-item').find((e) => e.textContent?.includes('食べれる'))!
    await user.click(within(shoku).getByTestId('proof-flag'))
    // フラグを立てたもの同士は新しい順
    expect(excerpts().slice(0, 2)).toEqual(['「来れる」', '「食べれる」→食べられる'])

    // チェックしたものは下へ（斜線）
    const first = screen.getAllByTestId('proof-item')[0]
    await user.click(within(first).getByTestId('proof-check'))
    const items = screen.getAllByTestId('proof-item')
    expect(items.at(-1)?.getAttribute('data-done')).toBe('true')
    expect(items.at(-1)?.textContent).toContain('来れる')
    expect(excerpts()[0]).toContain('食べれる')

    // 絞り込み
    await user.selectOptions(screen.getByTestId('proof-category-filter'), 'cliche')
    expect(excerpts()).toEqual(['「ありきたりな夕焼け」'])
    await user.selectOptions(screen.getByTestId('proof-category-filter'), '')
    await user.click(screen.getByTestId('proof-status-done'))
    expect(screen.getAllByTestId('proof-item')).toHaveLength(1)
    await user.click(screen.getByTestId('proof-status-all'))

    // もう1件チェックして、まとめて削除
    await user.click(within(screen.getAllByTestId('proof-item')[0]).getByTestId('proof-check'))
    await user.click(screen.getByTestId('proof-delete-checked'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('2件')
    await user.click(within(dialog).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(screen.getAllByTestId('proof-item')).toHaveLength(2))
    const entries = listTrash(getData().trashEntries)
    expect(entries).toHaveLength(1)
    expect(entries[0].recordIds).toHaveLength(2)
  })

  it('押すと話を開いて箇所を選ぶ（?ps=）。本文が変わって見つからなければそう出す', async () => {
    const user = userEvent.setup()
    const { titleId, pieceIds } = seedTitle(['一。', '窓から見れる景色。'])
    paste(titleId, proofCall([{ piece: '#2', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' }]))
    const id = Object.keys(getData().proofSuggestions)[0]
    renderTab(titleId)
    act(() => {
      actions.updateVersion(getData().pieces[pieceIds[1]].versionIds[0], { body: '窓から見られる景色。' })
    })
    expect(screen.getByTestId('proof-location').textContent).toBe('第2話・本文が変わりました（直した可能性）')
    act(() => {
      actions.updateVersion(getData().pieces[pieceIds[1]].versionIds[0], { body: '前の段落。\n\n窓から見れる景色。' })
    })
    expect(screen.getByTestId('proof-location').textContent).toBe('第2話 ¶2')
    await user.click(screen.getByTestId('proof-jump'))
    expect(screen.getByTestId('where').textContent).toBe(`/t/${titleId}/p/${pieceIds[1]}?ps=${id}`)
  })
})

describe('戦略メモ', () => {
  it('全体戦略に追記し、コンテストの候補を応募計画にする（2回目は作った応募計画を開く）', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    actions.updateTitle(titleId, { strategyNote: 'これまでの方針' })
    paste(titleId, {
      tool: 'novel_add_strategy_note',
      input: {
        title_id: 'x',
        run_date: '2026-10-28',
        heading: '新人賞を狙う',
        body: '## 狙い\n長編の新人賞。<b>太字</b>',
        contests: [
          {
            name: '星海小説大賞',
            organizer: '星海文庫',
            deadline: '2027-03-31',
            limit: { min: 80000, unit: 'chars' },
            fit: '相性が良い',
            plan: '第2章を締める',
          },
        ],
      },
    })
    renderTab(titleId)
    const memo = screen.getByTestId('strategy-memo')
    expect(within(memo).getByTestId('strategy-memo-source').textContent).toBe('Claude（貼り付け）')
    expect(within(memo).getByTestId('strategy-memo-date').textContent).toBe('10/28')
    await waitFor(() => expect(within(memo).getByTestId('strategy-memo-body').innerHTML).toContain('<h2>狙い</h2>'))
    expect(within(memo).getByTestId('strategy-memo-body').innerHTML).not.toContain('<b>')
    expect(memo.textContent).toContain('規定 80,000字以上')

    await user.click(within(memo).getByTestId('strategy-memo-append'))
    expect(getData().titles[titleId].strategyNote).toBe(
      'これまでの方針\n\n【Claude 2026-10-28】新人賞を狙う\n## 狙い\n長編の新人賞。<b>太字</b>',
    )
    expect(within(memo).getByTestId('strategy-memo-applied')).toBeTruthy()

    await user.click(within(memo).getByTestId('strategy-contest-plan'))
    const subs = Object.values(getData().submissions)
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({
      contestName: '星海小説大賞',
      organizer: '星海文庫',
      deadline: '2027-03-31',
      minChars: 80000,
      overview: '相性が良い',
      revisionPlan: '第2章を締める',
    })
    expect(within(memo).getByTestId('strategy-contest-open')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('submission-editor')).toBeTruthy())
  })
})

describe('結果を貼り付け', () => {
  it('1件ごとの結果を見せてから追加し、同じものを2回貼り付けても増えない', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['窓から見れる景色。', '見れる。見れる。'])
    renderTab(titleId)
    const answer =
      '推敲案です。\n\n' +
      fence(
        proofCall([
          { piece: '#1', excerpt: '見れる', category: 'ra_nuki', suggestion: '見られる', reason: 'ら抜き' },
          { piece: '#2', excerpt: '見れる', category: 'ra_nuki', reason: 'ら抜き' },
          { piece: '#9', excerpt: 'x', category: 'typo', reason: '無い話' },
        ]),
      )
    await user.click(screen.getByTestId('proof-claude-paste'))
    const dialog = await screen.findByTestId('paste-dialog')
    const input = within(dialog).getByTestId('paste-input')
    await user.click(input)
    await user.paste(answer)
    await waitFor(() => expect(within(dialog).getAllByTestId('paste-item')).toHaveLength(3))
    expect(
      within(dialog)
        .getAllByTestId('paste-item')
        .map((e) => e.getAttribute('data-status')),
    ).toEqual(['created', 'ambiguous', 'not_found'])
    const add = screen.getByTestId('paste-add')
    expect(add.textContent).toBe('追加（1件）')
    await user.click(add)
    await waitFor(() => expect(screen.queryByTestId('paste-dialog')).toBeNull())
    expect(Object.values(getData().proofSuggestions).map((s) => [s.excerpt, s.source])).toEqual([['見れる', 'paste']])
    expect(Object.keys(getData().proofBatches)).toHaveLength(1)

    // 2回目: 重複
    await user.click(screen.getByTestId('proof-claude-paste'))
    const again = await screen.findByTestId('paste-dialog')
    await user.click(within(again).getByTestId('paste-input'))
    await user.paste(answer)
    await waitFor(() => expect(within(again).getAllByTestId('paste-item')[0].getAttribute('data-status')).toBe('duplicate'))
    expect((screen.getByTestId('paste-add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('コードブロックが無い・壊れている時はそう出す', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    renderTab(titleId)
    await user.click(screen.getByTestId('strategy-claude-paste'))
    const dialog = await screen.findByTestId('paste-dialog')
    await user.click(within(dialog).getByTestId('paste-input'))
    await user.paste('ただの文です')
    await waitFor(() => expect(within(dialog).getByTestId('paste-error').textContent).toContain('novel-studio-v1'))
    await user.clear(within(dialog).getByTestId('paste-input'))
    await user.paste('```novel-studio-v1\n{"tool": "novel_add_strategy_note", "input": {')
    await waitFor(() => expect(within(dialog).getByTestId('paste-error').textContent).toContain('JSON'))
  })
})
