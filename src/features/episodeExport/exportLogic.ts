// 各話テキスト書き出しの手順（画面から切り離した部分）。
// - 書き出す前の一覧: ファイル名・採用原稿がなく飛ばす話の数・ZIP の名前
// - フォルダを選べる環境（Edge・Chrome のデスクトップ。window.showDirectoryPicker がある）: 選んだフォルダに1話1ファイルを書く
// - それ以外（iPhone・Android・Safari・Firefox）: 1つの ZIP（yyyymmddタイトル名.zip）にまとめて保存する
// 長編（数百話・数百万字）でも画面を長く止めないよう、本文のテキスト化・圧縮は1話ずつ行い、間で処理を譲る。
import { strToU8, Zip, ZipDeflate } from 'fflate'
import { episodeEntries, episodeFileText, fileSafe, yyyymmdd, type EpisodeEntry } from '../../domain/episodeExport'
import { activeVersion, flatten } from '../../domain/structure'
import type { AppData, ID } from '../../domain/types'

// ---------- 書き出す前の一覧 ----------

export interface ExportPreview {
  /** 書き出す話（読む順）。ファイル名は name */
  entries: EpisodeEntry[]
  /** 採用原稿がなく、書き出さない第n話の数 */
  skippedEpisodes: number
  /** 採用原稿がなく、書き出さない特殊ブロックの数 */
  skippedSpecials: number
  /** スマホなどで1つにまとめる時の ZIP の名前 */
  zipName: string
}

/** ZIP の名前: yyyymmddタイトル名.zip（中のファイルと同じ日付・タイトル名） */
export function zipFileName(titleName: string, date: Date): string {
  return `${yyyymmdd(date)}${fileSafe(titleName, '無題のタイトル')}.zip`
}

export function exportPreview(data: AppData, titleId: ID, date: Date): ExportPreview {
  let skippedEpisodes = 0
  let skippedSpecials = 0
  for (const item of flatten(data, titleId)) {
    const piece = data.pieces[item.pieceId]
    if (activeVersion(data, piece)) continue
    if (piece.kind === 'episode') skippedEpisodes += 1
    else skippedSpecials += 1
  }
  return {
    entries: episodeEntries(data, titleId, date),
    skippedEpisodes,
    skippedSpecials,
    zipName: zipFileName(data.titles[titleId]?.name ?? '', date),
  }
}

/** 「採用原稿のない2話・特殊ブロック1件は書き出しません。」（飛ばす話がなければ空文字） */
export function skippedNotice(episodes: number, specials: number): string {
  const parts: string[] = []
  if (episodes > 0) parts.push(`${episodes}話`)
  if (specials > 0) parts.push(`特殊ブロック${specials}件`)
  return parts.length > 0 ? `採用原稿のない${parts.join('・')}は書き出しません。` : ''
}

export interface OutFile {
  name: string
  text: string
}

/** 書き出すファイルを1つずつ作る（全話の本文をまとめて変換しないので、長編でもメモリを食わない） */
export function* outFiles(entries: readonly EpisodeEntry[], withHeading: boolean): Generator<OutFile> {
  for (const e of entries) yield { name: e.name, text: episodeFileText(e, withHeading) }
}

// ---------- 処理を譲る ----------

/** 続けて処理する長さの目安（ミリ秒）。これを超えたら一度ブラウザに処理を譲る */
const SLICE_MS = 30

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------- ZIP（スマホなど） ----------

export interface ZipOptions {
  /** ZIP の中のファイルの更新日時（省くと今） */
  mtime?: Date
  /** 1ファイル入れるたびに呼ばれる（入れた数） */
  onProgress?: (done: number) => void
}

/**
 * ファイルを1つの ZIP にまとめる（UTF-8 のファイル名。Windows・iPhone・Android の標準の機能で開ける）。
 * 戻り値は ZIP の中身（Blob にまとめて保存する）。
 */
export async function buildZip(files: Iterable<OutFile>, opts: ZipOptions = {}): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  const state: { error: Error | null } = { error: null }
  const zip = new Zip((err, chunk) => {
    if (err) state.error = err
    else chunks.push(chunk)
  })
  let sliceStart = performance.now()
  let done = 0
  for (const f of files) {
    const entry = new ZipDeflate(f.name, { level: 6 })
    if (opts.mtime) entry.mtime = opts.mtime
    zip.add(entry)
    entry.push(strToU8(f.text), true)
    if (state.error) throw state.error
    done += 1
    opts.onProgress?.(done)
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToBrowser()
      sliceStart = performance.now()
    }
  }
  zip.end()
  if (state.error) throw state.error
  return chunks
}

// ---------- フォルダを選んで書く（Edge・Chrome のデスクトップ） ----------
// File System Access API。TypeScript の標準の型にはまだないので、使う所だけを書く。

interface WritableLike {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

interface FileHandleLike {
  createWritable(): Promise<WritableLike>
}

export interface DirectoryHandleLike {
  name?: string
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandleLike>
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: string
}

interface PickerWindow {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<DirectoryHandleLike>
}

/** フォルダを選んで直接書き込めるか（Edge・Chrome のデスクトップ版など） */
export function canPickDirectory(win: object = window): boolean {
  return typeof (win as PickerWindow).showDirectoryPicker === 'function'
}

/** 書き出し先のフォルダを選んでもらい、書き込みの許可を確かめる。やめた時は AbortError、許可がなければ NotAllowedError */
export async function pickDirectory(win: object = window): Promise<DirectoryHandleLike> {
  const picker = (win as PickerWindow).showDirectoryPicker
  if (typeof picker !== 'function') throw new Error('この環境ではフォルダを選べません')
  // id を付けると、次に開いた時も同じフォルダから選べる
  const dir = await picker.call(win, { id: 'novel-studio-episodes', mode: 'readwrite', startIn: 'documents' })
  if (dir.queryPermission && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const state = dir.requestPermission ? await dir.requestPermission({ mode: 'readwrite' }) : 'denied'
    if (state !== 'granted') throw new DOMException('フォルダに書き込む許可がありません', 'NotAllowedError')
  }
  return dir
}

/** 途中のファイルで書けなかった（それまでに書けたファイルの数を持つ） */
export class DirectoryWriteError extends Error {
  readonly written: number
  readonly fileName: string
  readonly reason: unknown

  constructor(reason: unknown, fileName: string, written: number) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = 'DirectoryWriteError'
    this.reason = reason
    this.fileName = fileName
    this.written = written
  }
}

/** 選んだフォルダに1ファイルずつ書く（同じ名前のファイルは上書きする）。書けた数を返す */
export async function writeFilesToDirectory(
  dir: DirectoryHandleLike,
  files: Iterable<OutFile>,
  onProgress?: (done: number) => void,
): Promise<number> {
  let done = 0
  for (const f of files) {
    try {
      const handle = await dir.getFileHandle(f.name, { create: true })
      const writable = await handle.createWritable()
      try {
        await writable.write(f.text)
        await writable.close()
      } catch (e) {
        // 書きかけのファイルを残さない
        await writable.abort?.().catch(() => {})
        throw e
      }
    } catch (e) {
      throw new DirectoryWriteError(e, f.name, done)
    }
    done += 1
    onProgress?.(done)
  }
  return done
}

// ---------- うまくいかなかった時 ----------

export type ExportErrorKind = 'cancel' | 'permission' | 'error'

function errorName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : ''
}

/** やめた（AbortError）・許可がない（NotAllowedError / SecurityError）・そのほか */
export function exportErrorKind(e: unknown): ExportErrorKind {
  const name = errorName(e instanceof DirectoryWriteError ? e.reason : e)
  if (name === 'AbortError') return 'cancel'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission'
  return 'error'
}

/** トーストに出す文 */
export function exportErrorMessage(e: unknown): string {
  const kind = exportErrorKind(e)
  const written = e instanceof DirectoryWriteError && e.written > 0 ? `（${e.written}件は書き出し済みです）` : ''
  if (kind === 'cancel')
    return e instanceof DirectoryWriteError
      ? `書き出しが中断されました${written}`
      : 'フォルダを選ばなかったので、書き出していません'
  if (kind === 'permission') {
    return `フォルダに書き込む許可がないため、書き出せませんでした${written}。もう一度書き出して、ファイルの編集を許可するか、別のフォルダを選んでください`
  }
  const detail = e instanceof Error ? e.message : String(e)
  const where = e instanceof DirectoryWriteError ? `「${e.fileName}」を` : ''
  return `${where}書き出せませんでした${written}: ${detail}`
}
