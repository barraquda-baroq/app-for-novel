import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPersistence } from '../../../db/persistence'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { AppFrame } from '../../../ui/Layout'
import { StrategyTab } from './StrategyTab'

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
    expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・6字・2話$/)
    expect(screen.getByTestId('snapshot-diff').textContent).toContain('変わっていません')
    expect(getData().submissions[subId].snapshot?.charCount).toBe(6)

    act(() => {
      actions.setActiveVersion(pieceIds[0], null)
    })
    expect(screen.getByTestId('snapshot-diff').textContent).toContain('記録した後に採用原稿が変わった話：1話')

    // 2回目は上書きの確認が出る
    await user.click(screen.getByTestId('snapshot-record'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '記録し直す' }))
    await waitFor(() => expect(screen.getByTestId('snapshot-info').textContent).toMatch(/記録・4字・2話$/))
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
