// ファイルの保存（Capacitor の Filesystem・SaveAs は偽物）
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  /** 一時置き場に書かれた内容（appendFile の1回ごと） */
  const appended: { path: string; data: string; encoding?: string }[] = []
  return {
    native: true,
    appended,
    calls: [] as string[],
    saveAs: vi.fn(async (_o: { path: string; fileName: string; mimeType: string }) => ({ uri: 'content://saved' })),
    downloadFile: vi.fn(),
  }
})

vi.mock('./platform', () => ({ isNative: () => h.native }))
vi.mock('../ui/browser', () => ({ downloadFile: h.downloadFile }))
vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => (name === 'SaveAs' ? { saveAs: h.saveAs } : {}),
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    rmdir: vi.fn(async (o: { path: string }) => {
      h.calls.push(`rmdir ${o.path}`)
    }),
    writeFile: vi.fn(async (o: { path: string; data: string; recursive?: boolean }) => {
      h.calls.push(`writeFile ${o.path} ${JSON.stringify(o.data)} recursive=${o.recursive}`)
      return { uri: `file:///cache/${o.path}` }
    }),
    appendFile: vi.fn(async (o: { path: string; data: string; encoding?: string }) => {
      h.appended.push({ path: o.path, data: o.data, encoding: o.encoding })
    }),
    getUri: vi.fn(async (o: { path: string; directory: string }) => ({
      uri: `file:///cache/${encodeURI(o.path)}`,
    })),
  },
}))

import { BLOB_SLICE_BYTES, bytesToBase64, isSaveCancel, saveFile, TEXT_SLICE_CHARS, textSlices } from './saveFile'

const utf8 = (s: string) => new TextEncoder().encode(s)
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
/** バイト列が同じか（大きな配列を toEqual で比べると遅く、jsdom では別の Uint8Array にもなるため） */
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// jsdom の Blob には arrayBuffer() が無い（iPhone・Android の WebView にはある）
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as ArrayBuffer)
      r.onerror = () => reject(r.error)
      r.readAsArrayBuffer(this)
    })
  }
}

beforeEach(() => {
  h.native = true
  h.appended.length = 0
  h.calls.length = 0
  h.saveAs.mockClear()
  h.saveAs.mockImplementation(async () => ({ uri: 'content://saved' }))
  h.downloadFile.mockClear()
})

describe('textSlices', () => {
  it('つなぐと元の文字列。サロゲートペアは割らない', () => {
    const text = 'あ😀い😀'.repeat(5)
    for (const max of [2, 3, 4, 5, 7]) {
      const slices = textSlices(text, max)
      expect(slices.join('')).toBe(text)
      for (const s of slices) {
        expect(s.length).toBeLessThanOrEqual(max)
        // 割れたサロゲートは UTF-8 で別の文字（U+FFFD）になる
        expect(new TextDecoder().decode(utf8(s))).toBe(s)
      }
    }
  })

  it('空の文字列は何も書かない', () => {
    expect(textSlices('')).toEqual([])
  })
})

describe('アプリの saveFile', () => {
  it('文字列: 一時置き場を空にして書き、つないだ UTF-8 が元と同じ。SaveAs に URI・名前・種類を渡す', async () => {
    // 区切り目に絵文字が来るように、区切りの1文字前まで埋める
    const text = `${'あ'.repeat(TEXT_SLICE_CHARS - 1)}😀${'漢字かな'.repeat(1000)}`
    await expect(saveFile('20261029雨の話.txt', text, 'text/plain;charset=utf-8')).resolves.toBe('saved')
    expect(h.calls).toEqual(['rmdir exports', 'writeFile exports/20261029雨の話.txt "" recursive=true'])
    expect(h.appended.length).toBe(2)
    expect(h.appended.every((a) => a.encoding === 'utf8' && a.path === 'exports/20261029雨の話.txt')).toBe(true)
    const bytes = h.appended.map((a) => utf8(a.data))
    const joined = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0))
    let off = 0
    for (const b of bytes) {
      joined.set(b, off)
      off += b.length
    }
    expect(sameBytes(joined, utf8(text))).toBe(true)
    expect(h.saveAs).toHaveBeenCalledWith({
      path: `file:///cache/${encodeURI('exports/20261029雨の話.txt')}`,
      fileName: '20261029雨の話.txt',
      mimeType: 'text/plain',
    })
  })

  it('Blob: 3 の倍数ずつの base64 で、つなぐと元のバイト列（3 で割り切れない大きさ）', async () => {
    const size = BLOB_SLICE_BYTES * 2 + 1
    const src = new Uint8Array(size)
    for (let i = 0; i < size; i++) src[i] = (i * 31 + (i >> 8)) & 0xff
    const blob = new Blob([src], { type: 'application/zip' })
    await expect(saveFile('作品.zip', blob, 'application/zip')).resolves.toBe('saved')
    expect(h.appended.length).toBe(3)
    // encoding なし = base64 として書く
    expect(h.appended.every((a) => a.encoding === undefined)).toBe(true)
    // 途中に詰め物（=）が入らないので、つないだまま1つの base64 として読める
    expect(h.appended.slice(0, -1).every((a) => !a.data.includes('='))).toBe(true)
    expect(sameBytes(fromBase64(h.appended.map((a) => a.data).join('')), src)).toBe(true)
    expect(h.saveAs).toHaveBeenCalledWith(expect.objectContaining({ fileName: '作品.zip', mimeType: 'application/zip' }))
  })

  it('保存の画面でやめたら cancel（iPhone・Android の両方の言い方）', async () => {
    h.saveAs.mockRejectedValueOnce(Object.assign(new Error('Save canceled'), { code: 'CANCELED' }))
    await expect(saveFile('a.json', '{}', 'application/json')).resolves.toBe('cancel')
    h.saveAs.mockRejectedValueOnce(new Error('Save cancelled'))
    await expect(saveFile('a.json', '{}', 'application/json')).resolves.toBe('cancel')
  })

  it('保存できなければ投げる', async () => {
    h.saveAs.mockRejectedValueOnce(new Error('disk full'))
    await expect(saveFile('a.json', '{}', 'application/json')).rejects.toThrow('disk full')
  })

  it('名前の / は一時置き場のフォルダにしない', async () => {
    await saveFile('a/b.txt', 'x', 'text/plain')
    expect(h.appended[0].path).toBe('exports/a_b.txt')
    expect(h.saveAs).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'a/b.txt' }))
  })
})

describe('ブラウザの saveFile', () => {
  it('これまでどおりダウンロードする', async () => {
    h.native = false
    const blob = new Blob(['{}'])
    await expect(saveFile('backup.json', blob, 'application/json')).resolves.toBe('saved')
    expect(h.downloadFile).toHaveBeenCalledWith('backup.json', blob, 'application/json')
    expect(h.saveAs).not.toHaveBeenCalled()
    expect(h.appended).toEqual([])
  })
})

describe('bytesToBase64・isSaveCancel', () => {
  it('btoa と同じ', () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256)
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(...Array.from(bytes))))
  })

  it('やめたかどうか', () => {
    expect(isSaveCancel({ code: 'CANCELED', message: '' })).toBe(true)
    expect(isSaveCancel(new Error('User cancelled'))).toBe(true)
    expect(isSaveCancel(new Error('denied'))).toBe(false)
  })
})
