// ファイルの保存（バックアップ・各話の ZIP・通し読みのテキストなど）。
// - ブラウザ: これまでどおりダウンロードする（src/ui/browser.ts の downloadFile）
// - アプリ: WebView のダウンロードは何もしないので、端末の一時置き場（Cache）に書いてから、
//   アプリの SaveAs（iPhone はファイルの「書き出し」の画面、Android は「保存」の画面）で保存先を選んでもらう。
//   SaveAs はアプリの中に入れた小さなプラグイン（ios/App/App/SaveAsPlugin.swift・android/…/SaveAsPlugin.java）。
import { registerPlugin } from '@capacitor/core'
import { notify, notifyError } from '../store/uiStore'
import { downloadFile } from '../ui/browser'
import { isNative } from './platform'

export type SaveResult = 'saved' | 'cancel'

interface SaveAsPlugin {
  /** path = 一時置き場のファイルの URI（file://…）。fileName は保存先で付ける名前（iPhone は path の名前になる） */
  saveAs(options: { path: string; fileName: string; mimeType: string }): Promise<{ uri: string }>
}

const SaveAs = registerPlugin<SaveAsPlugin>('SaveAs')

/** 一時置き場のフォルダ（保存のたびに作り直す） */
const EXPORT_DIR = 'exports'
/** 文字列を書く単位（文字数）。ネイティブとのやり取りを小分けにする */
export const TEXT_SLICE_CHARS = 1_000_000
/** Blob を書く単位（バイト）。3 の倍数にして、base64 の途中に詰め物（=）が入らないようにする */
export const BLOB_SLICE_BYTES = 3 * 1024 * 1024

/**
 * 文字列を、サロゲートペア（絵文字など）を割らずに max 文字以下ずつに分ける
 * （UTF-8 にする時、割れた片方は別の文字に化けるため）
 */
export function textSlices(text: string, max = TEXT_SLICE_CHARS): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + max)
    if (end < text.length && end - i > 1) {
      const c = text.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff) end -= 1
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

/** バイト列を base64 にする（大きな配列でも引数の数の上限を超えないよう、小分けに文字にする） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** Blob を base64 の切れ端にして順に渡す（1つずつ読むので、大きなファイルでも一度にメモリへ載せない） */
export async function* blobBase64Slices(blob: Blob, sliceBytes = BLOB_SLICE_BYTES): AsyncGenerator<string> {
  if (sliceBytes % 3 !== 0) throw new Error('sliceBytes は 3 の倍数')
  for (let off = 0; off < blob.size; off += sliceBytes) {
    const bytes = new Uint8Array(await blob.slice(off, off + sliceBytes).arrayBuffer())
    yield bytesToBase64(bytes)
  }
}

/** 保存の画面でやめた */
export function isSaveCancel(e: unknown): boolean {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return code === 'CANCELED' || /cancel/i.test(message)
}

/** 一時置き場に置くファイルの名前（フォルダの区切りになる文字を入れない） */
const cacheName = (name: string) => name.replace(/[\\/]/g, '_') || 'file'

/**
 * ファイルを保存する。'saved' = 保存した（ブラウザはダウンロードを始めた）、'cancel' = 保存の画面でやめた。
 * 保存できなかった時は投げる
 */
export async function saveFile(name: string, content: string | Blob, mime: string): Promise<SaveResult> {
  if (!isNative()) {
    downloadFile(name, content, mime)
    return 'saved'
  }
  const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem')
  const directory = Directory.Cache
  // 前に保存したファイルが残らないよう、一時置き場を空にしてから書く
  await Filesystem.rmdir({ path: EXPORT_DIR, directory, recursive: true }).catch(() => undefined)
  const path = `${EXPORT_DIR}/${cacheName(name)}`
  await Filesystem.writeFile({ path, data: '', directory, encoding: Encoding.UTF8, recursive: true })
  if (typeof content === 'string') {
    for (const data of textSlices(content)) await Filesystem.appendFile({ path, data, directory, encoding: Encoding.UTF8 })
  } else {
    // encoding を付けないと base64 として受け取って、そのバイト列を書く
    for await (const data of blobBase64Slices(content)) await Filesystem.appendFile({ path, data, directory })
  }
  const { uri } = await Filesystem.getUri({ path, directory })
  try {
    // 保存の画面に渡す種類は「text/plain」の形だけ（;charset=… を付けると、Android で種類を見分けられないことがある）
    await SaveAs.saveAs({ path: uri, fileName: name, mimeType: mime.split(';')[0].trim() })
    return 'saved'
  } catch (e) {
    if (isSaveCancel(e)) return 'cancel'
    throw e
  }
}

/**
 * テキスト（.txt・UTF-8）を保存する（通し読み・応募時の原稿・Claude への手動の依頼）。
 * アプリでは保存できたら知らせる（ブラウザはダウンロードの表示が出るので、これまでどおり何も出さない）。
 * 保存できなかった時は知らせて null
 */
export async function saveTextFile(name: string, text: string): Promise<SaveResult | null> {
  try {
    const result = await saveFile(name, text, 'text/plain;charset=utf-8')
    if (result === 'saved' && isNative()) notify(`${name} を保存しました`)
    return result
  } catch (e) {
    notifyError(`保存できませんでした: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
