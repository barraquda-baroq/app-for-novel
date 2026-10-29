// バックアップの書き出し: 保存できた時だけ「最後に書き出した日時」を記録して知らせる（保存は偽物）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from '../../store/uiStore'
import { BACKUP_EXPORTED, exportBackup, readLastBackup } from './backupExport'
import { LAST_BACKUP_KEY } from './settingsLogic'

const h = vi.hoisted(() => ({
  saveFile: vi.fn(async (_name: string, _content: string | Blob, _mime: string): Promise<'saved' | 'cancel'> => 'saved'),
}))
vi.mock('../../platform/saveFile', () => ({ saveFile: h.saveFile }))

const events: string[] = []
window.addEventListener(BACKUP_EXPORTED, () => events.push(BACKUP_EXPORTED))

beforeEach(() => {
  localStorage.removeItem(LAST_BACKUP_KEY)
  events.length = 0
  useToasts.setState({ toasts: [] })
  h.saveFile.mockReset()
})

describe('exportBackup', () => {
  it('保存できたら日時を記録し、知らせる', async () => {
    h.saveFile.mockResolvedValue('saved')
    await expect(exportBackup()).resolves.toBe(true)
    const [name, content, mime] = h.saveFile.mock.calls[0]
    expect(name).toMatch(/^novel-studio-backup-.*\.json$/)
    expect(content).toBeInstanceOf(Blob)
    expect(mime).toBe('application/json')
    expect(readLastBackup()).toBeTypeOf('number')
    expect(events).toEqual([BACKUP_EXPORTED])
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['バックアップを書き出しました'])
  })

  it('保存の画面でやめたら、日時も知らせも残さない', async () => {
    h.saveFile.mockResolvedValue('cancel')
    await expect(exportBackup()).resolves.toBe(false)
    expect(readLastBackup()).toBeNull()
    expect(events).toEqual([])
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('保存できなければエラーを知らせ、日時は残さない', async () => {
    h.saveFile.mockRejectedValue(new Error('disk full'))
    await expect(exportBackup()).resolves.toBe(false)
    expect(readLastBackup()).toBeNull()
    expect(useToasts.getState().toasts.map((t) => [t.kind, t.message])).toEqual([['error', '書き出せませんでした: disk full']])
  })
})
