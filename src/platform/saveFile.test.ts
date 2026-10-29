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
// 本物の registerPlugin と同じく Proxy を返す。どの名前にも関数を返し、プラグインに無いメソッド（then など）は
// 「not implemented」で失敗する（受け取った resolve / reject は呼ばない。await したり async 関数から返したりすると終わらない）
vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => {
    const methods: Record<string, unknown> = name === 'SaveAs' ? { saveAs: h.saveAs } : {}
    return new Proxy(
      {},
      {
        get: (_t, prop) =>
          methods[String(prop)] ?? (() => Promise.reject(new Error(`"${name}.${String(prop)}()" is not implemented on android`))),
      },
    )
  },
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

import {
  BLOB_SLICE_BYTES,
  bytesToBase64,
  CACHE_NAME_MAX_BYTES,
  cacheName,
  isSaveCancel,
  saveFile,
  TEXT_SLICE_CHARS,
  textSlices,
} from './saveFile'

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

  it('保存の途中でもう一度呼ばれたら（2回目のタップ）、重ねて書かずに cancel。終わった後はまた保存できる', async () => {
    let finish!: (v: { uri: string }) => void
    h.saveAs.mockImplementationOnce(() => new Promise<{ uri: string }>((resolve) => (finish = resolve)))
    // 区切りが2つになる長さ（2回目の rmdir・writeFile が1回目の appendFile の間に入ると、中身が消えたり二重になったりする）
    const text = `${'あ'.repeat(TEXT_SLICE_CHARS)}${'い'.repeat(5)}`
    const first = saveFile('長い話.txt', text, 'text/plain;charset=utf-8')
    const second = saveFile('長い話.txt', text, 'text/plain;charset=utf-8')
    await expect(second).resolves.toBe('cancel')
    await vi.waitFor(() => expect(h.saveAs).toHaveBeenCalledTimes(1))
    // 1回目の保存の画面はまだ開いている。その間に押されても何もしない
    await expect(saveFile('別の話.txt', 'x', 'text/plain')).resolves.toBe('cancel')
    expect(h.calls).toEqual(['rmdir exports', 'writeFile exports/長い話.txt "" recursive=true'])
    expect(h.appended.map((a) => a.data).join('')).toBe(text)
    expect(h.saveAs).toHaveBeenCalledTimes(1)
    finish({ uri: 'content://saved' })
    await expect(first).resolves.toBe('saved')
    // 終わったら、次の保存はふつうに動く
    h.calls.length = 0
    h.appended.length = 0
    await expect(saveFile('次.txt', 'y', 'text/plain')).resolves.toBe('saved')
    expect(h.calls).toEqual(['rmdir exports', 'writeFile exports/次.txt "" recursive=true'])
    expect(h.appended.map((a) => a.data)).toEqual(['y'])
    expect(h.saveAs).toHaveBeenCalledTimes(2)
  })

  it('保存できなかった後や、やめた後も、次の保存はできる', async () => {
    h.saveAs.mockRejectedValueOnce(new Error('disk full'))
    await expect(saveFile('a.txt', 'x', 'text/plain')).rejects.toThrow('disk full')
    h.saveAs.mockRejectedValueOnce(Object.assign(new Error('Save canceled'), { code: 'CANCELED' }))
    await expect(saveFile('a.txt', 'x', 'text/plain')).resolves.toBe('cancel')
    await expect(saveFile('a.txt', 'x', 'text/plain')).resolves.toBe('saved')
    expect(h.saveAs).toHaveBeenCalledTimes(3)
  })

  it('名前の / は一時置き場のフォルダにしない', async () => {
    await saveFile('a/b.txt', 'x', 'text/plain')
    expect(h.appended[0].path).toBe('exports/a_b.txt')
    expect(h.saveAs).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'a/b.txt' }))
  })
})

describe('一時置き場の名前（cacheName）', () => {
  /** 長い題名と応募先の「応募時の原稿」の名前（SubmissionCard。題名・応募先はそれぞれ 80 文字まで） */
  const submission = `${'あ'.repeat(68)}_第12回ネット小説大賞_応募時の原稿.txt`

  it('255 バイトを超える名前は、拡張子を残して 240 バイト以下に縮める（元の名前の頭の部分）', () => {
    expect(utf8(submission).length).toBe(257)
    const name = cacheName(submission)
    expect(utf8(name).length).toBeLessThanOrEqual(CACHE_NAME_MAX_BYTES)
    expect(name.endsWith('.txt')).toBe(true)
    expect(submission.startsWith(name.slice(0, -'.txt'.length))).toBe(true)
    // 縮めすぎない（あと1文字入れると上限を超える）
    expect(utf8(name).length).toBeGreaterThan(CACHE_NAME_MAX_BYTES - 3)
  })

  it('絵文字（4 バイト・サロゲートペア）は割らない', () => {
    const name = cacheName(`${'😀'.repeat(100)}.zip`)
    expect(name).toBe(`${'😀'.repeat(59)}.zip`)
    expect(utf8(name).length).toBeLessThanOrEqual(CACHE_NAME_MAX_BYTES)
    expect(new TextDecoder().decode(utf8(name))).toBe(name)
  })

  it('短い名前はそのまま。/ は _ にする。空なら file', () => {
    expect(cacheName('20261029雨の話.txt')).toBe('20261029雨の話.txt')
    expect(cacheName('a/b.txt')).toBe('a_b.txt')
    expect(cacheName('a\\b.txt')).toBe('a_b.txt')
    expect(cacheName('')).toBe('file')
    // 拡張子が無い（または長すぎる）名前は、名前全体を縮める
    expect(cacheName('あ'.repeat(100))).toBe('あ'.repeat(80))
  })

  it('アプリの saveFile: 一時置き場には縮めた名前で書き、保存の画面には元の名前を渡す', async () => {
    await expect(saveFile(submission, '原稿', 'text/plain;charset=utf-8')).resolves.toBe('saved')
    const path = `exports/${cacheName(submission)}`
    expect(h.calls).toEqual(['rmdir exports', `writeFile ${path} "" recursive=true`])
    expect(h.appended.map((a) => a.path)).toEqual([path])
    expect(h.saveAs).toHaveBeenCalledWith({
      path: `file:///cache/${encodeURI(path)}`,
      fileName: submission,
      mimeType: 'text/plain',
    })
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
