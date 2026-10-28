// 各話テキスト書き出しの E2E テスト。
// フォルダを選べる環境（Edge・Chrome のデスクトップ）は showDirectoryPicker を差し替えて、書かれたファイルを確かめる。
// フォルダを選べない環境（iPhone・Android・Safari・Firefox）は showDirectoryPicker を消し、保存された ZIP を開いて確かめる。
import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { openApp, seed } from './helpers'

interface PickerHook {
  __written: Record<string, string>
  __pickerCalls: number
  __downloadNames?: string[]
}

/** showDirectoryPicker を、書いた内容を window.__written に覚える偽物にする */
async function stubDirectoryPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as PickerHook & { showDirectoryPicker: unknown }
    w.__written = {}
    w.__pickerCalls = 0
    w.showDirectoryPicker = async () => {
      w.__pickerCalls += 1
      return {
        name: '原稿フォルダ',
        getFileHandle: async (name: string) => ({
          createWritable: async () => {
            let buf = ''
            return {
              write: async (data: string) => {
                buf += data
              },
              close: async () => {
                w.__written[name] = buf
              },
            }
          },
        }),
      }
    }
  })
}

/** フォルダを選べない環境にする（iPhone・Android・Safari・Firefox と同じ） */
async function removeDirectoryPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker
    delete (Window.prototype as unknown as Record<string, unknown>).showDirectoryPicker
  })
}

/**
 * ボタンを押して保存されたファイルの名前と中身。名前は <a download> の値を見る
 * （UTF-8 でないロケールのヘッドレス Chromium では、日本語のファイル名が suggestedFilename() で "download" になるため）。
 */
async function downloadFrom(page: Page, button: Locator): Promise<{ name: string; bytes: Uint8Array }> {
  await page.evaluate(() => {
    const w = window as unknown as PickerHook
    if (w.__downloadNames) return
    w.__downloadNames = []
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.__downloadNames!.push(this.download)
      return original.call(this)
    }
  })
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  const name = await page.evaluate(() => (window as unknown as PickerHook).__downloadNames!.at(-1) ?? '')
  return { name, bytes: new Uint8Array(readFileSync(await download.path())) }
}

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** プロローグ・第1話（題・ルビ）・第2話（採用原稿なし）・第3話 */
async function seedNovel(page: Page): Promise<string> {
  return seed(page, ({ actions, getData }) => {
    const titleId = actions.createTitle('星の海')
    const bodies = ['｜魔法使い《ウィザード》が来た。\n《《夜》》だった。', '書きかけ', '三話の本文']
    bodies.forEach((body, i) => {
      const id = actions.addEpisode(titleId)
      actions.updateVersion(getData().pieces[id].versionIds[0], { body })
      if (i === 0) actions.updatePiece(id, { subtitle: '旅立ち' })
      if (i === 1) actions.setActiveVersion(id, null)
    })
    const pro = actions.addSpecial(titleId, { chapterId: null, index: 0 }, 'プロローグ')
    actions.updateVersion(getData().pieces[pro].versionIds[0], { body: 'はじまり' })
    return titleId
  })
}

function names(date: string): string[] {
  return [`${date}星の海_プロローグ.txt`, `${date}星の海_第1話.txt`, `${date}星の海_第3話.txt`]
}

test.describe('各話テキスト書き出し', () => {
  test('タイトル画面から: フォルダを選べる環境では、選んだフォルダに1話1ファイルを書き出す', async ({ page }) => {
    await stubDirectoryPicker(page)
    await openApp(page)
    const titleId = await seedNovel(page)
    await openApp(page, `/t/${titleId}`)

    await page.getByTestId('episode-export-open').click()
    const dialog = page.getByTestId('episode-export-dialog')
    await expect(dialog).toHaveAttribute('data-method', 'directory')
    const date = today()
    await expect(page.getByTestId('export-file')).toHaveText(names(date))
    await expect(page.getByTestId('export-count')).toHaveText('3件')
    await expect(page.getByTestId('export-skipped')).toHaveText('採用原稿のない1話は書き出しません。')
    await expect(page.getByTestId('export-method')).toContainText('同じ名前のファイルがあると、上書きされます')
    await expect(page.getByTestId('export-heading')).toBeChecked()

    await page.getByTestId('export-submit').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: '3件のファイルを「原稿フォルダ」に書き出しました' })).toBeVisible()
    const written = await page.evaluate(() => (window as unknown as PickerHook).__written)
    expect(Object.keys(written).sort()).toEqual(names(date).sort())
    // 本文はルビ・傍点の記法のまま、改行は CRLF、先頭に見出し
    expect(written[`${date}星の海_第1話.txt`]).toBe('第1話　旅立ち\r\n\r\n｜魔法使い《ウィザード》が来た。\r\n《《夜》》だった。')
    expect(written[`${date}星の海_プロローグ.txt`]).toBe('プロローグ\r\n\r\nはじまり')
    expect(await page.evaluate(() => (window as unknown as PickerHook).__pickerCalls)).toBe(1)
  })

  test('フォルダを選ばずに閉じたら、知らせてダイアログはそのまま', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
        throw new DOMException('The user aborted a request.', 'AbortError')
      }
    })
    await openApp(page)
    const titleId = await seedNovel(page)
    await openApp(page, `/t/${titleId}`)
    await page.getByTestId('episode-export-open').click()
    await page.getByTestId('export-submit').click()
    await expect(page.getByRole('status').filter({ hasText: 'フォルダを選ばなかったので、書き出していません' })).toBeVisible()
    await expect(page.getByTestId('episode-export-dialog')).toBeVisible()
    await expect(page.getByTestId('export-submit')).toBeEnabled()
  })

  test('通し読みから: フォルダを選べない環境では、1つの ZIP（yyyymmddタイトル名.zip）にまとめて保存する', async ({ page }) => {
    await removeDirectoryPicker(page)
    await openApp(page)
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).showDirectoryPicker)).toBe('undefined')
    const titleId = await seedNovel(page)
    await openApp(page, `/t/${titleId}/read`)

    await page.getByTestId('episode-export-open').click()
    await expect(page.getByTestId('episode-export-dialog')).toHaveAttribute('data-method', 'zip')
    const date = today()
    await expect(page.getByTestId('export-zip-name')).toHaveText(`${date}星の海.zip`)
    await expect(page.getByTestId('export-file')).toHaveText(names(date))
    // 見出しを入れない
    await page.getByTestId('export-heading').uncheck()

    const { name, bytes } = await downloadFrom(page, page.getByTestId('export-submit'))
    expect(name).toBe(`${date}星の海.zip`)
    await expect(page.getByTestId('episode-export-dialog')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: `${date}星の海.zip を保存しました` })).toBeVisible()
    const files = unzipSync(bytes)
    expect(Object.keys(files)).toEqual(names(date))
    expect(strFromU8(files[`${date}星の海_第1話.txt`])).toBe('｜魔法使い《ウィザード》が来た。\r\n《《夜》》だった。')
    expect(strFromU8(files[`${date}星の海_第3話.txt`])).toBe('三話の本文')
  })

  test('幅 360px でもはみ出さず、ボタンとチェックボックスは押しやすい大きさ', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await removeDirectoryPicker(page)
    await openApp(page)
    const titleId = await seed(page, ({ actions, getData }) => {
      const id = actions.createTitle('とても長いタイトル名のテスト用作品・副題もかなり長めに付けてみる')
      for (let i = 0; i < 30; i++) {
        const p = actions.addEpisode(id)
        actions.updateVersion(getData().pieces[p].versionIds[0], { body: `第${i + 1}話の本文。` })
      }
      return id
    })
    const noHorizontalScroll = async () => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
    const heightOf = async (l: Locator) => (await l.boundingBox())!.height

    for (const hash of [`/t/${titleId}`, `/t/${titleId}/read`]) {
      await openApp(page, hash)
      const open = page.getByTestId('episode-export-open')
      await expect(open).toBeVisible()
      expect(await heightOf(open)).toBeGreaterThanOrEqual(34)
      await noHorizontalScroll()
      await open.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await noHorizontalScroll()
      const box = (await dialog.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(360)
      // ファイル名の一覧は枠の中でスクロールする（ダイアログからはみ出さない）
      const list = page.getByTestId('export-files')
      expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await heightOf(page.locator('.ex-option'))).toBeGreaterThanOrEqual(34)
      expect(await heightOf(page.getByTestId('export-submit'))).toBeGreaterThanOrEqual(34)
      await expect(page.getByTestId('export-submit')).toBeInViewport()
      if (hash.endsWith('/read')) {
        await page.screenshot({ path: `e2e/artifacts/screens/episode-export-360.png` })
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
  })
})
