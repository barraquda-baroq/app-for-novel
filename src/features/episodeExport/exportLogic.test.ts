import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { createTitle } from '../../domain/entityOps'
import { addEpisode, addSpecial, setActiveVersion, updatePiece, updateVersion } from '../../domain/storyOps'
import { emptyData, type AppData, type ID } from '../../domain/types'
import {
  buildZip,
  canPickDirectory,
  DirectoryWriteError,
  exportErrorKind,
  exportErrorMessage,
  exportPreview,
  outFiles,
  pickDirectory,
  skippedNotice,
  writeFilesToDirectory,
  zipFileName,
  type DirectoryHandleLike,
} from './exportLogic'

const DATE = new Date(2026, 9, 28)

/** 第1話（題あり・ルビ）・第2話（採用なし）・第3話・プロローグ（採用なし）・あとがき */
function setup(): { data: AppData; titleId: ID } {
  const t = createTitle(emptyData(), '星の海')
  let d = t.data
  const e1 = addEpisode(d, t.result)
  d = updateVersion(e1.data, e1.data.pieces[e1.result].versionIds[0], { body: '｜魔法使い《ウィザード》が来た。\n二行目' })
  d = updatePiece(d, e1.result, { subtitle: '旅立ち' })
  const e2 = addEpisode(d, t.result)
  d = setActiveVersion(e2.data, e2.result, null)
  const e3 = addEpisode(d, t.result)
  d = updateVersion(e3.data, e3.data.pieces[e3.result].versionIds[0], { body: '三話の本文' })
  const pro = addSpecial(d, t.result, { chapterId: null, index: 0 }, 'プロローグ')
  d = setActiveVersion(pro.data, pro.result, null)
  const after = addSpecial(d, t.result, { chapterId: null, index: 4 }, 'あとがき')
  d = updateVersion(after.data, after.data.pieces[after.result].versionIds[0], { body: 'ありがとうございました' })
  return { data: d, titleId: t.result }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** 書き込みを覚えておく、フォルダの代わり */
function fakeDirectory(opts: { failOn?: string; error?: Error; permission?: PermissionState } = {}) {
  const files = new Map<string, string>()
  const aborted: string[] = []
  const dir: DirectoryHandleLike & { files: Map<string, string>; aborted: string[] } = {
    name: '原稿',
    files,
    aborted,
    getFileHandle: async (name: string) => ({
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
          abort: async () => {
            aborted.push(name)
          },
        }
      },
    }),
  }
  if (opts.permission) {
    dir.queryPermission = async () => opts.permission!
    dir.requestPermission = async () => opts.permission!
  }
  return dir
}

describe('書き出す前の一覧', () => {
  it('採用原稿のある話のファイル名（読む順）・飛ばす話の数・ZIP の名前', () => {
    const { data, titleId } = setup()
    const p = exportPreview(data, titleId, DATE)
    expect(p.entries.map((e) => e.name)).toEqual([
      '20261028星の海_第1話.txt',
      '20261028星の海_第3話.txt',
      '20261028星の海_あとがき.txt',
    ])
    expect(p.skippedEpisodes).toBe(1)
    expect(p.skippedSpecials).toBe(1)
    expect(p.zipName).toBe('20261028星の海.zip')
    expect(skippedNotice(p.skippedEpisodes, p.skippedSpecials)).toBe('採用原稿のない1話・特殊ブロック1件は書き出しません。')
    expect(skippedNotice(2, 0)).toBe('採用原稿のない2話は書き出しません。')
    expect(skippedNotice(0, 0)).toBe('')
  })

  it('ZIP の名前もファイル名に使えない文字を置き換える', () => {
    expect(zipFileName('星の/海?', DATE)).toBe('20261028星の_海_.zip')
    expect(zipFileName('  ', DATE)).toBe('20261028無題のタイトル.zip')
  })

  it('本文はルビ・傍点の記法のまま、改行は CRLF。見出しは選べる', () => {
    const { data, titleId } = setup()
    const { entries } = exportPreview(data, titleId, DATE)
    const [first] = [...outFiles(entries, true)]
    expect(first.text).toBe('第1話　旅立ち\r\n\r\n｜魔法使い《ウィザード》が来た。\r\n二行目')
    const plain = [...outFiles(entries, false)]
    expect(plain.map((f) => f.text)).toEqual([
      '｜魔法使い《ウィザード》が来た。\r\n二行目',
      '三話の本文',
      'ありがとうございました',
    ])
  })
})

describe('ZIP にまとめる（スマホなど）', () => {
  it('1話1ファイルの .txt（UTF-8）が入り、日本語のファイル名もそのまま', async () => {
    const { data, titleId } = setup()
    const { entries } = exportPreview(data, titleId, DATE)
    const progress: number[] = []
    const chunks = await buildZip(outFiles(entries, true), { mtime: DATE, onProgress: (n) => progress.push(n) })
    const zip = concat(chunks)
    // ZIP の印（PK）
    expect([zip[0], zip[1]]).toEqual([0x50, 0x4b])
    const files = unzipSync(zip)
    expect(Object.keys(files)).toEqual(entries.map((e) => e.name))
    expect(strFromU8(files['20261028星の海_第1話.txt'])).toBe('第1話　旅立ち\r\n\r\n｜魔法使い《ウィザード》が来た。\r\n二行目')
    expect(strFromU8(files['20261028星の海_あとがき.txt'])).toBe('あとがき\r\n\r\nありがとうございました')
    expect(progress).toEqual([1, 2, 3])
  })

  it('長い原稿でも途中で処理を譲りながら作れる', async () => {
    const body = '　夜明け前の港には、まだ誰の足音もなかった。\n'.repeat(4000)
    const files = Array.from({ length: 40 }, (_, i) => ({ name: `第${i + 1}話.txt`, text: body }))
    const zip = unzipSync(concat(await buildZip(files)))
    expect(Object.keys(zip)).toHaveLength(40)
    expect(strFromU8(zip['第40話.txt'])).toBe(body)
  })
})

describe('フォルダを選んで書く（Edge・Chrome のデスクトップ）', () => {
  it('showDirectoryPicker がある時だけフォルダを選べる', () => {
    expect(canPickDirectory({})).toBe(false)
    expect(canPickDirectory({ showDirectoryPicker: async () => fakeDirectory() })).toBe(true)
  })

  it('選んだフォルダに1ファイルずつ書く（同じ名前は上書き）', async () => {
    const { data, titleId } = setup()
    const { entries } = exportPreview(data, titleId, DATE)
    const dir = fakeDirectory()
    dir.files.set('20261028星の海_第3話.txt', '古い内容')
    const picker = vi.fn(async () => dir)
    const picked = await pickDirectory({ showDirectoryPicker: picker })
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readwrite' }))
    const progress: number[] = []
    expect(await writeFilesToDirectory(picked, outFiles(entries, false), (n) => progress.push(n))).toBe(3)
    expect([...dir.files.keys()].sort()).toEqual(entries.map((e) => e.name).sort())
    expect(dir.files.get('20261028星の海_第3話.txt')).toBe('三話の本文')
    expect(progress).toEqual([1, 2, 3])
  })

  it('書き込みの許可がなければ NotAllowedError', async () => {
    const dir = fakeDirectory({ permission: 'denied' })
    const err = await pickDirectory({ showDirectoryPicker: async () => dir }).catch((e: unknown) => e)
    expect(exportErrorKind(err)).toBe('permission')
    expect(exportErrorMessage(err)).toContain('許可')
    const granted = fakeDirectory({ permission: 'granted' })
    await expect(pickDirectory({ showDirectoryPicker: async () => granted })).resolves.toBe(granted)
  })

  it('途中で書けなかったら、書けた数とファイル名を知らせ、書きかけは残さない', async () => {
    const files = [
      { name: 'a.txt', text: 'A' },
      { name: 'b.txt', text: 'B' },
      { name: 'c.txt', text: 'C' },
    ]
    const dir = fakeDirectory({ failOn: 'b.txt' })
    const err = await writeFilesToDirectory(dir, files).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DirectoryWriteError)
    expect((err as DirectoryWriteError).written).toBe(1)
    expect(dir.aborted).toEqual(['b.txt'])
    expect(exportErrorKind(err)).toBe('error')
    expect(exportErrorMessage(err)).toBe('「b.txt」を書き出せませんでした（1件は書き出し済みです）: ディスクがいっぱいです')

    const denied = fakeDirectory({ failOn: 'a.txt', error: new DOMException('denied', 'NotAllowedError') })
    const err2 = await writeFilesToDirectory(denied, files).catch((e: unknown) => e)
    expect(exportErrorKind(err2)).toBe('permission')
  })

  it('フォルダを選ばずに閉じたら「やめた」扱い', () => {
    const abort = new DOMException('The user aborted a request.', 'AbortError')
    expect(exportErrorKind(abort)).toBe('cancel')
    expect(exportErrorMessage(abort)).toBe('フォルダを選ばなかったので、書き出していません')
    expect(exportErrorKind(new DOMException('x', 'SecurityError'))).toBe('permission')
    expect(exportErrorKind(new Error('x'))).toBe('error')
  })
})
