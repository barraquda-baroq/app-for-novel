// 各話テキスト書き出しのダイアログ: フォルダを選べる環境（showDirectoryPicker）と、ZIP にまとめる環境の両方。
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistence } from '../../db/persistence'
import type { ID } from '../../domain/types'
import { actions } from '../../store/actions'
import { getData, initStore, resetStoreForTests } from '../../store/appStore'
import { useToasts } from '../../store/uiStore'
import { downloadFile } from '../../ui/browser'
import { EpisodeExportDialog, progressAnnouncement } from './EpisodeExportDialog'
import type { DirectoryHandleLike } from './exportLogic'

vi.mock('../../ui/browser', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../ui/browser')>()
  return { ...mod, downloadFile: vi.fn() }
})

let n = 0
const win = window as unknown as { showDirectoryPicker?: unknown }

beforeEach(async () => {
  await initStore(createPersistence(`test-db-episode-export-${++n}`))
  useToasts.setState({ toasts: [] })
  vi.mocked(downloadFile).mockClear()
})

afterEach(() => {
  cleanup()
  resetStoreForTests()
  delete win.showDirectoryPicker
})

function today(): string {
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 第1話（題・ルビ）・第2話（採用なし）・第3話 */
function seed(): ID {
  const titleId = actions.createTitle('月の庭')
  const bodies = ['｜月《つき》が出た。\n二行目', '', '三話']
  bodies.forEach((body, i) => {
    const id = actions.addEpisode(titleId)
    actions.updateVersion(getData().pieces[id].versionIds[0], { body })
    if (i === 0) actions.updatePiece(id, { subtitle: '夜' })
    if (i === 1) actions.setActiveVersion(id, null)
  })
  return titleId
}

/** 書いたファイルを覚えるフォルダの代わり。failOn のファイルは書く時に error で失敗する */
function fakeDirectory(opts: { failOn?: string; error?: Error } = {}) {
  const files = new Map<string, string>()
  const dir: DirectoryHandleLike = {
    name: '原稿',
    getFileHandle: async (name) => ({
      createWritable: async () => {
        let buf = ''
        return {
          write: async (data: string) => {
            if (name === opts.failOn) throw opts.error ?? new Error('ディスクがいっぱいです')
            buf += data
          },
          close: async () => {
            files.set(name, buf)
          },
        }
      },
    }),
  }
  return { dir, files }
}

function toasts() {
  return useToasts.getState().toasts.map((t) => [t.kind, t.message])
}

async function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

describe('各話テキスト書き出し', () => {
  it('フォルダを選べる環境: 一覧・上書きの注意を出し、選んだフォルダに1話1ファイルを書く', async () => {
    const user = userEvent.setup()
    const { dir, files } = fakeDirectory()
    const picker = vi.fn(async () => dir)
    win.showDirectoryPicker = picker
    const titleId = seed()
    const onClose = vi.fn()
    render(<EpisodeExportDialog titleId={titleId} onClose={onClose} />)

    const date = today()
    expect(screen.getByTestId('episode-export-dialog').dataset.method).toBe('directory')
    expect(screen.getAllByTestId('export-file').map((li) => li.textContent)).toEqual([
      `${date}月の庭_第1話.txt`,
      `${date}月の庭_第3話.txt`,
    ])
    expect(screen.getByTestId('export-count').textContent).toBe('2件')
    expect(screen.getByTestId('export-skipped').textContent).toBe('採用原稿のない1話は書き出しません。')
    expect(screen.getByTestId('export-method').textContent).toContain('同じ名前のファイルがあると、上書きされます')
    const heading = screen.getByTestId<HTMLInputElement>('export-heading')
    expect(heading.checked).toBe(true)

    await user.click(screen.getByTestId('export-submit'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(picker).toHaveBeenCalledTimes(1)
    expect(files.get(`${date}月の庭_第1話.txt`)).toBe('第1話　夜\r\n\r\n｜月《つき》が出た。\r\n二行目')
    expect(files.get(`${date}月の庭_第3話.txt`)).toBe('第3話\r\n\r\n三話')
    expect(toasts()).toEqual([['info', '2件のファイルを「原稿」に書き出しました']])
    expect(downloadFile).not.toHaveBeenCalled()
  })

  it('フォルダを選ばずに閉じた・許可がない時は知らせて、ダイアログは開いたまま', async () => {
    const user = userEvent.setup()
    const titleId = seed()
    const onClose = vi.fn()
    win.showDirectoryPicker = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    })
    render(<EpisodeExportDialog titleId={titleId} onClose={onClose} />)
    await user.click(screen.getByTestId('export-submit'))
    await waitFor(() => expect(toasts()).toEqual([['info', 'フォルダを選ばなかったので、書き出していません']]))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('export-submit').textContent).toBe('書き出す')
    expect(screen.getByTestId<HTMLButtonElement>('export-submit').disabled).toBe(false)

    win.showDirectoryPicker = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    await user.click(screen.getByTestId('export-submit'))
    await waitFor(() => expect(toasts().at(-1)?.[0]).toBe('error'))
    expect(toasts().at(-1)?.[1]).toContain('フォルダに書き込む許可がない')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('途中のファイルで書けなかったら、ファイル名と書けた数を知らせ、ダイアログは開いたまま書き出し直せる', async () => {
    const user = userEvent.setup()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const date = today()
    const { dir, files } = fakeDirectory({ failOn: `${date}月の庭_第3話.txt` })
    win.showDirectoryPicker = vi.fn(async () => dir)
    const titleId = seed()
    const onClose = vi.fn()
    render(<EpisodeExportDialog titleId={titleId} onClose={onClose} />)
    await user.click(screen.getByTestId('export-submit'))
    await waitFor(() =>
      expect(toasts().at(-1)).toEqual([
        'error',
        `「${date}月の庭_第3話.txt」を書き出せませんでした（1件は書き出し済みです）: ディスクがいっぱいです`,
      ]),
    )
    expect(onClose).not.toHaveBeenCalled()
    const submit = screen.getByTestId<HTMLButtonElement>('export-submit')
    expect(submit.textContent).toBe('書き出す')
    expect(submit.disabled).toBe(false)
    expect(submit.getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByTestId('export-progress-status').textContent).toBe('')
    expect([...files.keys()]).toEqual([`${date}月の庭_第1話.txt`])
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
  })

  it('途中で書き込みが中断されたら（AbortError）、「やめた」ではなく中断のエラーとして知らせる', async () => {
    const user = userEvent.setup()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const date = today()
    const { dir } = fakeDirectory({
      failOn: `${date}月の庭_第3話.txt`,
      error: new DOMException('The operation was aborted.', 'AbortError'),
    })
    win.showDirectoryPicker = vi.fn(async () => dir)
    const onClose = vi.fn()
    render(<EpisodeExportDialog titleId={seed()} onClose={onClose} />)
    await user.click(screen.getByTestId('export-submit'))
    await waitFor(() => expect(toasts().at(-1)).toEqual(['error', '書き出しが中断されました（1件は書き出し済みです）']))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('export-submit').textContent).toBe('書き出す')
    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('書き出している間もボタンはフォーカスを残し（押せない印は aria-disabled）、二度押しでは書き出さない。進み具合は読み上げる', async () => {
    const user = userEvent.setup()
    const { dir } = fakeDirectory()
    let release: (d: DirectoryHandleLike) => void = () => {}
    const picker = vi.fn(() => new Promise<DirectoryHandleLike>((resolve) => (release = resolve)))
    win.showDirectoryPicker = picker
    const onClose = vi.fn()
    render(<EpisodeExportDialog titleId={seed()} onClose={onClose} />)
    const submit = screen.getByTestId<HTMLButtonElement>('export-submit')
    submit.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('true'))
    expect(submit.disabled).toBe(false)
    expect(document.activeElement).toBe(submit)
    expect(submit.textContent).toBe('書き出し中…（0/2）')
    expect(screen.getByTestId('export-progress-status').textContent).toBe('書き出し中（0%）')
    // 閉じる（×）も押せない印を付ける
    expect(screen.getByTestId('modal-close').getAttribute('aria-disabled')).toBe('true')
    await user.keyboard('{Enter}')
    await user.click(submit)
    expect(picker).toHaveBeenCalledTimes(1)
    await act(async () => release(dir))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(picker).toHaveBeenCalledTimes(1)
  })

  it('進み具合の読み上げは1割ずつ', () => {
    expect(progressAnnouncement(0, 300)).toBe('書き出し中（0%）')
    expect(progressAnnouncement(29, 300)).toBe('書き出し中（0%）')
    expect(progressAnnouncement(30, 300)).toBe('書き出し中（10%）')
    expect(progressAnnouncement(299, 300)).toBe('書き出し中（90%）')
    expect(progressAnnouncement(300, 300)).toBe('書き出し中（100%）')
  })

  it('タイトル全体を書き出すことを示し、通し読みで章を選んでいる時はそのことも知らせる', () => {
    const titleId = seed()
    const { unmount } = render(<EpisodeExportDialog titleId={titleId} onClose={() => {}} />)
    expect(screen.getByText(/」全体の採用原稿を、1話1ファイル/)).toBeTruthy()
    expect(screen.queryByTestId('export-scope-note')).toBeNull()
    unmount()
    render(<EpisodeExportDialog titleId={titleId} scopedToChapter onClose={() => {}} />)
    expect(screen.getByTestId('export-scope-note').textContent).toContain('タイトル全体の各話を書き出します')
  })

  it('フォルダを選べない環境（iPhone・Android など）: 1つの ZIP にまとめて保存する', async () => {
    const user = userEvent.setup()
    const titleId = seed()
    const onClose = vi.fn()
    render(<EpisodeExportDialog titleId={titleId} onClose={onClose} />)
    const date = today()
    expect(screen.getByTestId('episode-export-dialog').dataset.method).toBe('zip')
    expect(screen.getByTestId('export-zip-name').textContent).toBe(`${date}月の庭.zip`)

    // 見出しを入れない
    await user.click(screen.getByTestId('export-heading'))
    await user.click(screen.getByTestId('export-submit'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(downloadFile).toHaveBeenCalledTimes(1)
    const [name, blob] = vi.mocked(downloadFile).mock.calls[0] as [string, Blob]
    expect(name).toBe(`${date}月の庭.zip`)
    expect(blob.type).toBe('application/zip')
    const zip = unzipSync(await readBlob(blob))
    expect(Object.keys(zip)).toEqual([`${date}月の庭_第1話.txt`, `${date}月の庭_第3話.txt`])
    expect(strFromU8(zip[`${date}月の庭_第1話.txt`])).toBe('｜月《つき》が出た。\r\n二行目')
    expect(toasts()).toEqual([['info', `${date}月の庭.zip を保存しました（2件のファイル）`]])
  })

  it('採用原稿のある話がなければ書き出せない。開いている間に原稿が変わると一覧も変わる', async () => {
    const titleId = actions.createTitle('空')
    const id = actions.addEpisode(titleId)
    actions.setActiveVersion(id, null)
    render(<EpisodeExportDialog titleId={titleId} onClose={() => {}} />)
    expect(screen.getByTestId('export-empty')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('export-submit').disabled).toBe(true)
    act(() => actions.setActiveVersion(id, getData().pieces[id].versionIds[0]))
    expect(screen.getAllByTestId('export-file')).toHaveLength(1)
    expect(screen.getByTestId<HTMLButtonElement>('export-submit').disabled).toBe(false)
  })
})
