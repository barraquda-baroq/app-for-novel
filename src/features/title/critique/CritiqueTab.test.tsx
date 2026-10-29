// 作品批評タブ: 批評プロンプト（このタイトル・共通）と、結果の貼り付け（Markdown + URL）・アーティファクトの URL
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shortId } from '../../../claude/refs'
import { createPersistence } from '../../../db/persistence'
import type { ID } from '../../../domain/types'
import { actions } from '../../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../../store/appStore'
import { copyText, downloadFile } from '../../../ui/browser'
import { AppFrame } from '../../../ui/Layout'
import { CritiqueTab } from './CritiqueTab'

vi.mock('../../../ui/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../ui/browser')>()
  return { ...original, copyText: vi.fn(async () => true), downloadFile: vi.fn() }
})

let n = 0

function renderTab(titleId: ID) {
  return render(
    <MemoryRouter initialEntries={[`/t/${titleId}?tab=critique`]}>
      <AppFrame>
        <CritiqueTab titleId={titleId} />
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

beforeEach(async () => {
  await initStore(createPersistence(`test-db-critique-${++n}`))
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  vi.mocked(copyText).mockClear()
  vi.mocked(downloadFile).mockClear()
})

describe('批評プロンプト', () => {
  it('このタイトル・共通に足して書き、並べ替え、Claude 用にコピーする', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['本文'])
    const other = actions.createTitle('別の作品')
    actions.addCritiquePrompt(other, { name: '別の作品のプロンプト' })
    renderTab(titleId)
    expect(screen.queryByText('別の作品のプロンプト')).toBeNull()

    await user.click(screen.getByTestId('add-title-prompt'))
    const name = await screen.findByTestId('prompt-name-input')
    expect(document.activeElement).toBe(name)
    await user.type(name, '構成')
    await user.type(screen.getByTestId('prompt-body-input'), '構成を批評してください')
    await user.tab()
    await waitFor(() =>
      expect(Object.values(getData().critiquePrompts).find((p) => p.name === '構成')?.body).toBe('構成を批評してください'),
    )

    await user.click(screen.getByTestId('add-shared-prompt'))
    // 足したプロンプトの名前の欄にフォーカスがある
    await waitFor(() =>
      expect(document.activeElement).toBe(within(screen.getByTestId('critique-prompts-shared')).getByTestId('prompt-name-input')),
    )
    await user.keyboard('共通')
    await user.tab()
    const shared = within(screen.getByTestId('critique-prompts-shared'))
    await waitFor(() => expect(shared.getByTestId('prompt-name').textContent).toBe('共通'))
    expect(Object.values(getData().critiquePrompts).find((p) => p.name === '共通')?.titleId).toBeNull()

    // このタイトルのプロンプトをもう1つ足して並べ替える
    actions.addCritiquePrompt(titleId, { name: '人物' })
    const titleGroup = within(screen.getByTestId('critique-prompts-title'))
    await waitFor(() => expect(titleGroup.getAllByTestId('prompt-name').map((e) => e.textContent)).toEqual(['構成', '人物']))
    await user.click(titleGroup.getAllByTestId('prompt-up')[1])
    expect(titleGroup.getAllByTestId('prompt-name').map((e) => e.textContent)).toEqual(['人物', '構成'])

    // Claude 用にコピー: 依頼文・プロンプトの短い id・タイトルの短い id が入る
    await user.click(titleGroup.getAllByTestId('prompt-copy')[1])
    const text = vi.mocked(copyText).mock.calls[0][0]
    const prompt = Object.values(getData().critiquePrompts).find((p) => p.name === '構成')!
    expect(text).toContain('構成を批評してください')
    expect(text).toContain(shortId('critiquePrompt', prompt.id))
    expect(text).toContain(shortId('title', titleId))
    expect(text).toContain('novel_add_critique_result')
  })
})

describe('批評の結果', () => {
  it('Markdown をそのまま貼り付けて URL と一緒に残し、日付ごとに出す。URL は https だけ', async () => {
    const user = userEvent.setup()
    const { titleId } = seedTitle(['あ'.repeat(100)])
    const promptId = actions.addCritiquePrompt(titleId, { name: '全体', body: '全体を批評して' })
    renderTab(titleId)
    expect(screen.getByTestId('critique-results-empty')).toBeTruthy()

    await user.click(screen.getByTestId('critique-paste'))
    const dialog = await screen.findByTestId('paste-dialog')
    expect((within(dialog).getByTestId('paste-prompt') as HTMLSelectElement).value).toBe(promptId)
    await user.click(within(dialog).getByTestId('paste-input'))
    await user.paste('## 総評\n良い作品です。<script>x</script>')
    await user.type(within(dialog).getByTestId('paste-url'), 'https://claude.ai/public/artifacts/abc')
    await waitFor(() => expect(within(dialog).getAllByTestId('paste-item')[0].getAttribute('data-status')).toBe('created'))
    await user.click(screen.getByTestId('paste-add'))
    await waitFor(() => expect(screen.queryByTestId('paste-dialog')).toBeNull())

    const result = Object.values(getData().critiqueResults)[0]
    expect(result).toMatchObject({
      promptId,
      promptName: '全体',
      promptText: '全体を批評して',
      artifactUrl: 'https://claude.ai/public/artifacts/abc',
      source: 'paste',
    })
    const card = screen.getByTestId('critique-result')
    expect(within(card).getByTestId('critique-result-title').textContent).toBe('全体')
    expect(within(card).getByTestId('critique-result-scope').textContent).toBe('タイトル全体')
    expect(within(card).getByTestId('critique-result-manuscript').textContent).toBe('100字・1話の時点（現在と同じ）')
    await waitFor(() => expect(within(card).getByTestId('critique-result-body').innerHTML).toContain('<h2>総評</h2>'))
    expect(within(card).getByTestId('critique-result-body').innerHTML).not.toContain('<script')
    expect(within(card).getByTestId('critique-result-prompt').textContent).toBe('全体を批評して')
    expect(screen.getAllByTestId('critique-day')).toHaveLength(1)

    // 原稿が変わると「現在 +n字」
    actions.addEpisode(titleId)
    const v = Object.values(getData().versions).find((x) => x.body === '')!
    actions.updateVersion(v.id, { body: 'い'.repeat(20) })
    await waitFor(() =>
      expect(within(card).getByTestId('critique-result-manuscript').textContent).toBe('100字・1話の時点（現在 +20字・2話）'),
    )

    // URL: http は保存せず知らせる。https は保存
    const url = within(card).getByTestId('critique-result-url')
    await user.clear(url)
    await user.type(url, 'http://example.com{Enter}')
    expect(card.textContent).toContain('https:// で始まる URL')
    expect(getData().critiqueResults[result.id].artifactUrl).toBe('https://claude.ai/public/artifacts/abc')
    await user.clear(url)
    await user.type(url, 'https://example.com/x{Enter}')
    expect(getData().critiqueResults[result.id].artifactUrl).toBe('https://example.com/x')

    // メモ
    await user.type(within(card).getByTestId('critique-result-note'), '第2章を見直す')
    await user.tab()
    await waitFor(() => expect(getData().critiqueResults[result.id].note).toBe('第2章を見直す'))
  })
})

describe('Claude に頼む（手動）', () => {
  it('依頼文と本文をパートに分けてコピーし、.txt で1つのファイルに保存する', async () => {
    const user = userEvent.setup()
    // 1話 3万字 × 3話 → 50,000字のパートに収まらないので分かれる
    const { titleId } = seedTitle(['あ'.repeat(30_000), 'い'.repeat(30_000), 'う'.repeat(30_000)])
    const promptId = actions.addCritiquePrompt(titleId, { name: '全体', body: 'この作品を厳しく批評して' })
    renderTab(titleId)
    await user.click(screen.getByTestId('critique-manual'))
    const dialog = await screen.findByTestId('manual-dialog')
    expect((within(dialog).getByTestId('manual-prompt') as HTMLSelectElement).value).toBe(promptId)
    const buttons = within(dialog).getAllByTestId('manual-copy-part')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    expect(buttons[0].textContent).toContain(`パート 1/${buttons.length} をコピー`)
    await user.click(buttons[0])
    const part1 = vi.mocked(copyText).mock.calls[0][0]
    expect(part1.startsWith(`【Novel Studio パート 1/${buttons.length}】`)).toBe(true)
    expect(part1).toContain('この作品を厳しく批評して')
    expect(part1.length).toBeLessThanOrEqual(50_000)
    await waitFor(() => expect(within(dialog).getAllByTestId('manual-copy-part')[0].className).toContain('is-copied'))

    // 話の範囲にすると範囲の表記が変わる
    await user.click(within(dialog).getByTestId('manual-range-pieces'))
    await user.selectOptions(within(dialog).getByTestId('manual-from'), '2')
    await user.selectOptions(within(dialog).getByTestId('manual-to'), '2')
    expect(within(dialog).getByTestId('manual-summary').textContent).toContain('第2話・全 1 パート')

    await user.click(within(dialog).getByTestId('manual-save-txt'))
    const [filename, content] = vi.mocked(downloadFile).mock.calls[0] as [string, string]
    expect(filename).toMatch(/^\d{8}海の記憶_作品批評の依頼\.txt$/)
    expect(content).toContain('【Novel Studio パート 1/1】')
    expect(content).toContain('い'.repeat(100))
    expect(content).not.toContain('あ'.repeat(100))
  })
})
