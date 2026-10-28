import { describe, expect, it } from 'vitest'
import { parseBackup, toBackup } from '../../domain/backup'
import { addIdea, createTitle } from '../../domain/entityOps'
import { emptyData } from '../../domain/types'
import { addEpisode, updateVersion } from '../../domain/storyOps'
import {
  backupChunks,
  backupFileName,
  backupTextLength,
  COMPACT_BACKUP_CHARS,
  confirmsDeleteAll,
  countsSummary,
  dataCounts,
  detectPlatform,
  formatBytes,
  isEmptyData,
  LAST_BACKUP_KEY,
  localKeysToClear,
  readExportedAt,
} from './settingsLogic'

describe('バックアップのファイル名', () => {
  it('端末の現地時刻で novel-studio-backup-YYYYMMDD-HHmm.json', () => {
    expect(backupFileName(new Date(2026, 0, 2, 3, 4, 59))).toBe('novel-studio-backup-20260102-0304.json')
    expect(backupFileName(new Date(2026, 11, 31, 23, 59))).toBe('novel-studio-backup-20261231-2359.json')
  })
})

describe('件数', () => {
  it('すべてのテーブルの件数を主要なものから並べる', () => {
    let data = emptyData()
    const t = createTitle(data, '星の海')
    data = addIdea(t.data, t.result, '', '案').data
    const counts = dataCounts(data)
    expect(counts.map((c) => c.label)).toEqual([
      'タイトル',
      '話',
      '推敲バージョン',
      '章',
      'アイデア',
      'メモ',
      '設定項目',
      '設定のエントリ',
      '応募計画',
    ])
    expect(counts.find((c) => c.table === 'titles')?.count).toBe(1)
    expect(counts.find((c) => c.table === 'ideas')?.count).toBe(1)
    // 既定の設定項目（キャラクター・世界観）
    expect(counts.find((c) => c.table === 'settingCategories')?.count).toBe(2)
    expect(countsSummary(counts)).toMatch(/^タイトル 1件、話 0件、推敲バージョン 0件、章 0件、アイデア 1件、/)
  })

  it('応募時の原稿の控え（snapshotTexts）は内部の表なので、件数・確認文に出さない', () => {
    const data = createTitle(emptyData(), '星の海').data
    data.snapshotTexts = { k1: { id: 'k1', body: '応募した本文' } }
    const counts = dataCounts(data)
    expect(counts.map((c) => c.table)).not.toContain('snapshotTexts')
    expect(countsSummary(counts)).not.toContain('控え')
  })

  it('バックアップから読み込んだ（一部のテーブルしかない）データも数えられる', () => {
    const data = parseBackup(JSON.stringify({ app: 'novel-studio', schemaVersion: 1, data: { ideas: {} } }))
    expect(dataCounts(data).every((c) => c.count === 0)).toBe(true)
    expect(isEmptyData(data)).toBe(true)
    expect(isEmptyData(createTitle(emptyData(), 'x').data)).toBe(false)
  })
})

describe('バックアップの書き出し', () => {
  function sample() {
    let data = emptyData()
    const t = createTitle(data, '星の海')
    data = t.data
    const e = addEpisode(data, t.result)
    data = e.data
    data = updateVersion(data, data.pieces[e.result].versionIds[0], { body: '本文\n「台詞」\t"引用"\\' })
    data = addIdea(data, null, '案', '内容').data
    data.snapshotTexts = { '1': { id: '1', body: '数字のキー' }, k: { id: 'k', body: '控え' } }
    return data
  }

  it('小分けにしてつなげると JSON.stringify と同じ（インデントなし）。読み込み直すと元のデータ', () => {
    const data = sample()
    const file = toBackup(data, new Date('2026-01-02T03:04:05Z'))
    const parts = [...backupChunks(file, false)]
    expect(parts.length).toBeGreaterThan(5)
    const json = parts.join('')
    expect(json).toBe(JSON.stringify(file))
    expect(json).not.toContain('\n')
    // インデントを付けた書き出しと同じ内容として読み込める
    expect(parseBackup(json)).toEqual(parseBackup([...backupChunks(file, true)].join('')))
    expect(Object.values(parseBackup(json).versions)[0].body).toBe('本文\n「台詞」\t"引用"\\')
    expect(readExportedAt(json)).toBe(Date.parse('2026-01-02T03:04:05Z'))
  })

  it('空のデータも書き出せる。小さいデータはインデントを付けて読みやすく', () => {
    const file = toBackup(emptyData(), new Date(0))
    expect([...backupChunks(file, false)].join('')).toBe(JSON.stringify(file))
    expect([...backupChunks(file, true)]).toEqual([JSON.stringify(file, null, 2)])
  })

  it('文字列の長さの合計で、大きいデータかどうかを決める', () => {
    const data = sample()
    const small = backupTextLength(data)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(COMPACT_BACKUP_CHARS)
    const v = Object.values(data.versions)[0]
    const big = updateVersion(data, v.id, { body: 'あ'.repeat(COMPACT_BACKUP_CHARS) })
    expect(backupTextLength(big)).toBeGreaterThan(COMPACT_BACKUP_CHARS)
  })
})

describe('容量の表記', () => {
  it('B / KB / MB / GB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(300 * 1024 * 1024 * 1024)).toBe('300 GB')
    expect(formatBytes(undefined)).toBe('不明')
    expect(formatBytes(Number.NaN)).toBe('不明')
  })
})

describe('書き出し日時', () => {
  it('バックアップの exportedAt を読む。読めなければ null', () => {
    const at = new Date('2026-01-02T03:04:05Z')
    expect(readExportedAt(JSON.stringify(toBackup(emptyData(), at)))).toBe(at.getTime())
    expect(readExportedAt('{"exportedAt": "not a date"}')).toBeNull()
    expect(readExportedAt('{}')).toBeNull()
    expect(readExportedAt('null')).toBeNull()
    expect(readExportedAt('broken')).toBeNull()
  })
})

describe('端末の種類', () => {
  it('iPhone / iPad（Mac を名乗るタッチ端末を含む）/ Android / その他', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('desktop')
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 7)')).toBe('android')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop')
  })
})

describe('すべて削除の確認入力', () => {
  it('「削除」と入力された時だけ', () => {
    expect(confirmsDeleteAll('削除')).toBe(true)
    expect(confirmsDeleteAll(' 削除 ')).toBe(true)
    expect(confirmsDeleteAll('さくじょ')).toBe(false)
    expect(confirmsDeleteAll('')).toBe(false)
    expect(confirmsDeleteAll(null)).toBe(false)
  })
})

describe('すべて削除・復元で消す、この端末の状態', () => {
  const keys = [
    'novel-studio:prefs',
    'novel-studio:piece-scroll-sync',
    'novel-studio:last-backup',
    'novel-studio:idea-draft:home',
    'novel-studio:idea-draft:title:t1',
    'novel-studio:idea-modal-draft:new:none',
    'novel-studio:idea-modal-draft:edit:i1',
    'novel-studio:idea-collapsed',
    'novel-studio:collapsed-chapters:t1',
    'novel-studio:recovery:abc',
    'novel-studio:home-view',
    'other-app:setting',
  ]

  it('表示の設定以外のこのアプリのキーを消す（ほかのサイトのキーには触れない）', () => {
    expect(localKeysToClear(keys)).toEqual([
      'novel-studio:last-backup',
      'novel-studio:idea-draft:home',
      'novel-studio:idea-draft:title:t1',
      'novel-studio:idea-modal-draft:new:none',
      'novel-studio:idea-modal-draft:edit:i1',
      'novel-studio:idea-collapsed',
      'novel-studio:collapsed-chapters:t1',
      'novel-studio:recovery:abc',
      'novel-studio:home-view',
    ])
  })

  it('残すキーを足せる（復元では最後に書き出した日時を残す）', () => {
    const cleared = localKeysToClear(keys, ['novel-studio:prefs', 'novel-studio:piece-scroll-sync', LAST_BACKUP_KEY])
    expect(cleared).not.toContain(LAST_BACKUP_KEY)
    expect(cleared).not.toContain('novel-studio:prefs')
    expect(cleared).toContain('novel-studio:recovery:abc')
  })
})
