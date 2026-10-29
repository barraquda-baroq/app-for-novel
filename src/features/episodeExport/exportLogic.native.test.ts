// アプリ（iPhone / Android）ではフォルダを選ばず、ZIP にまとめて保存する
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform/platform', () => ({ isNative: () => true }))

import { canPickDirectory } from './exportLogic'

describe('canPickDirectory（アプリ）', () => {
  it('showDirectoryPicker があっても選べない（Android の WebView では呼ぶと失敗する）', () => {
    expect(canPickDirectory({ showDirectoryPicker: async () => ({}) })).toBe(false)
    expect(canPickDirectory({})).toBe(false)
  })
})
