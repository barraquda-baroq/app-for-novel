// 画面のパス。HashRouter を使うので静的ホスティングやアプリへの組み込みでもそのまま動く。
import type { ID } from './domain/types'

export type TitleTab = 'story' | 'settings' | 'strategy' | 'ideas'

export const paths = {
  home: () => '/',
  appSettings: () => '/settings',
  title: (titleId: ID, tab?: TitleTab) => (tab && tab !== 'story' ? `/t/${titleId}?tab=${tab}` : `/t/${titleId}`),
  chapter: (titleId: ID, chapterId: ID) => `/t/${titleId}/c/${chapterId}`,
  piece: (titleId: ID, pieceId: ID, versionId?: ID) => `/t/${titleId}/p/${pieceId}${versionId ? `?v=${versionId}` : ''}`,
  memo: (titleId: ID, memoId: ID) => `/t/${titleId}/m/${memoId}`,
  read: (titleId: ID, chapterId?: ID) => `/t/${titleId}/read${chapterId ? `?chapter=${chapterId}` : ''}`,
}
