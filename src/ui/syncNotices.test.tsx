// 同期の知らせ: 新しい版のアプリで書かれたデータがある時の表示（データの形の版）と、幕の構成の競合の知らせの文
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConflictNote } from '../db/persistence'
import { separatePiece } from '../domain/acts'
import { createTitle } from '../domain/entityOps'
import { addEpisode, setActiveVersion, updatePiece, updateVersion } from '../domain/storyOps'
import { emptyData } from '../domain/types'
import { actsNoteMessage, conflictMessage } from '../store/appStore'
import { useAppUpdate } from '../store/uiStore'
import { useSync } from '../sync/controller'
import type { SyncStatus } from '../sync/engine'
import { AppFrame } from './Layout'
import { syncBadge } from './SyncIndicator'

afterEach(() => {
  cleanup()
  useSync.setState({ auth: 'idle', status: null, leader: false, everSignedIn: false })
  useAppUpdate.setState({ ready: false, apply: null })
})

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  phase: 'uploading',
  pending: 3,
  lastSyncedAt: null,
  error: null,
  ...over,
})

describe('新しい版のアプリで書かれたデータがある時', () => {
  it('ヘッダーの同期の表示は「要更新」で、送らずに残している件数も出す', () => {
    const badge = syncBadge({
      auth: 'signedIn',
      leader: true,
      everSignedIn: true,
      status: status({ outdated: { model: 3, appVersion: '2.3' } }),
    })
    expect(badge).toEqual({
      tone: 'warn',
      label: '要更新',
      detail:
        '新しいバージョンのアプリで保存されたデータがあります。アプリを更新してください（2.3 で保存。この端末の変更 3 件は送らずに残しています）',
    })
    // 版の記録が無い・この版と同じなら、今までどおり
    expect(syncBadge({ auth: 'signedIn', leader: true, everSignedIn: true, status: status({ outdated: null }) })?.label).toBe(
      '送信中',
    )
  })

  it('画面の上に知らせを出し、「更新する」で新しい版に切り替える（まだ届いていなければ読み込み直す）', async () => {
    useSync.setState({
      auth: 'signedIn',
      leader: true,
      everSignedIn: true,
      status: status({ pending: 0, outdated: { model: 3, appVersion: '2.3' } }),
    })
    const apply = vi.fn(async () => undefined)
    useAppUpdate.setState({ ready: true, apply })
    const router = createMemoryRouter([{ path: '/', element: <AppFrame>本文</AppFrame> }], { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)
    const banner = await screen.findByTestId('outdated-banner')
    expect(banner.textContent).toContain('新しいバージョンのアプリで保存されたデータがあります。アプリを更新してください')
    // 更新の知らせは1つにまとめる（新しい版があるという知らせは出さない）
    expect(screen.queryByTestId('update-banner')).toBeNull()
    fireEvent.click(screen.getByTestId('outdated-update'))
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
  })
})

describe('幕の構成の競合の知らせ', () => {
  function data() {
    const t = createTitle(emptyData(), '作品')
    const e = addEpisode(t.data, t.result)
    const vid = e.data.pieces[e.result].versionIds[0]
    const d0 = setActiveVersion(updateVersion(e.data, vid, { body: 'ABCDEF' }), e.result, vid)
    return { data: updatePiece(separatePiece(d0, e.result, [3]).data, e.result, { subtitle: '旅立ち' }), ep: e.result }
  }

  it('話の名前で知らせ、残した場所を添える（何も残さなければ添えない）', () => {
    const label = '第3話　旅立ち'
    expect(actsNoteMessage('lost', label, { versions: 0, trash: 2 })).toBe(
      '第3話　旅立ちの幕の分け方が別の端末と同時に変わりました。別の端末の分け方に合わせ、この端末での幕の操作は取り消しました（この端末で作った稿はゴミ箱に残しています）',
    )
    expect(actsNoteMessage('lost', label)).toBe(
      '第3話　旅立ちの幕の分け方が別の端末と同時に変わりました。別の端末の分け方に合わせ、この端末での幕の操作は取り消しました',
    )
    expect(actsNoteMessage('won', label, { versions: 1, trash: 1 })).toBe(
      '第3話　旅立ちの幕の分け方が別の端末と同時に変わりました。この端末のセパレート解除を優先し、別の端末で分けた・つないだ幕の稿は稿の一覧とゴミ箱に残しました',
    )
    expect(actsNoteMessage('won', label)).toBe(
      '第3話　旅立ちの幕の分け方が別の端末と同時に変わりました。この端末のセパレート解除を優先しました',
    )
    expect(actsNoteMessage('deletedHere', label)).toBe(
      '第3話　旅立ちを削除したため、別の端末で同時に分けた・つないだ幕の稿はゴミ箱に残しました',
    )
    expect(actsNoteMessage('deletedThere', label)).toContain('第3話　旅立ちは別の端末で削除されていました')
    expect(actsNoteMessage('mineDropped', label, { versions: 1, trash: 0 })).toBe(
      '第3話　旅立ちの幕が別の端末で分けられた・つながれたため、この端末での編集・採用の一部が採用原稿に入っていません（稿の一覧に残しています）',
    )
    expect(actsNoteMessage('theirsDropped', label)).toBe(
      '第3話　旅立ちの幕の操作と同時に別の端末で書き換えられた・採用された稿は、採用原稿に入れていません',
    )
    expect(actsNoteMessage('stale', label)).toContain('書き換えられる前の稿から分けられた・つながれた')
    expect(actsNoteMessage('source', label)).toContain('分ける前の採用稿が別の端末で書き換えられていました')
  })

  it('同じ話の知らせは1つにまとめ、ほかの競合の件数の前に出す', () => {
    const { data: d, ep } = data()
    const notes: ConflictNote[] = [
      { kind: 'acts', table: 'pieces', id: ep, detail: 'stale' },
      { kind: 'acts', table: 'pieces', id: ep, detail: 'lost', kept: { versions: 0, trash: 1 } },
      { kind: 'trash', table: 'memos', id: 'm' },
    ]
    expect(conflictMessage(notes, [d])).toBe(
      'ほかの端末と同時に編集されていました。第1話　旅立ちの幕の分け方が別の端末と同時に変わりました。別の端末の分け方に合わせ、この端末での幕の操作は取り消しました（この端末で作った稿はゴミ箱に残しています）。削除と編集が重なった内容など 1 件をゴミ箱に残しました。',
    )
    // 話がどこにも無ければ「幕に分けた話」
    expect(conflictMessage([{ kind: 'acts', table: 'pieces', id: 'gone', detail: 'deletedThere' }], [d])).toContain(
      '幕に分けた話は別の端末で削除されていました',
    )
    expect(conflictMessage([], [d])).toBeNull()
  })
})
