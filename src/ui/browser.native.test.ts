// アプリ（iPhone / Android）のクリップボードとファイル選択（Capacitor は偽物）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from '../store/uiStore'

const h = vi.hoisted(() => ({
  native: true,
  write: vi.fn(async (_o: { string: string }) => {}),
}))
vi.mock('../platform/platform', () => ({ isNative: () => h.native }))
vi.mock('@capacitor/clipboard', () => ({ Clipboard: { write: h.write } }))

import { backupAccept, copyText, pickTextFile } from './browser'

const writeText = vi.fn(async (_t: string) => {})

beforeEach(() => {
  h.native = true
  h.write.mockReset()
  writeText.mockReset()
  useToasts.setState({ toasts: [] })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('アプリは端末のクリップボードに入れる', async () => {
    await expect(copyText('第1話　雨\n\n本文', '全文をコピーしました')).resolves.toBe(true)
    expect(h.write).toHaveBeenCalledWith({ string: '第1話　雨\n\n本文' })
    expect(writeText).not.toHaveBeenCalled()
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['全文をコピーしました'])
  })

  it('入れられなければ知らせる', async () => {
    h.write.mockRejectedValue(new Error('denied'))
    await expect(copyText('x')).resolves.toBe(false)
    expect(useToasts.getState().toasts.map((t) => [t.kind, t.message])).toEqual([['error', 'コピーできませんでした']])
  })

  it('ブラウザはこれまでどおり navigator.clipboard', async () => {
    h.native = false
    await expect(copyText('x')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('x')
    expect(h.write).not.toHaveBeenCalled()
  })
})

describe('pickTextFile', () => {
  const pickedAccept = () => {
    let accept = ''
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      accept = this.accept
      this.dispatchEvent(new Event('cancel'))
    })
    return () => accept
  }

  it('アプリはテキスト・種類の分からないファイルも選べる（中身は読み込みで確かめる）', async () => {
    const accept = pickedAccept()
    await expect(pickTextFile()).resolves.toBeNull()
    expect(accept()).toBe('.json,application/json,text/plain,application/octet-stream')
    expect(backupAccept()).toBe(accept())
  })

  it('ブラウザは .json だけ', async () => {
    h.native = false
    const accept = pickedAccept()
    await pickTextFile()
    expect(accept()).toBe('.json,application/json')
  })
})
