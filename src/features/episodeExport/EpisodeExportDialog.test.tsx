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
import { EpisodeExportDialog } from './EpisodeExportDialog'
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

function fakeDirectory() {
  const files = new Map<string, string>()
  const dir: DirectoryHandleLike = {
    name: '原稿',
    getFileHandle: async (name) => ({
      createWritable: async () => {
        let buf = ''
        return {
          write: async (data: string) => {
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
