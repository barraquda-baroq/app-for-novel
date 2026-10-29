// 画面のパス。HashRouter を使うので静的ホスティングやアプリへの組み込みでもそのまま動く。
import type { ID } from './domain/types'

export type TitleTab = 'story' | 'settings' | 'strategy' | 'critique' | 'ideas'

/** 原稿画面のクエリ: 推敲案の場所を開いて、抜き出した箇所を選ぶ（src/features/piece/ProofPanel.tsx） */
export const PROOF_PARAM = 'ps'

export const paths = {
  home: () => '/',
  appSettings: () => '/settings',
  trash: () => '/trash',
  title: (titleId: ID, tab?: TitleTab) => (tab && tab !== 'story' ? `/t/${titleId}?tab=${tab}` : `/t/${titleId}`),
  chapter: (titleId: ID, chapterId: ID) => `/t/${titleId}/c/${chapterId}`,
  piece: (titleId: ID, pieceId: ID, versionId?: ID) => `/t/${titleId}/p/${pieceId}${versionId ? `?v=${versionId}` : ''}`,
  /** 原稿画面を開いて推敲案の箇所を選ぶ */
  pieceProof: (titleId: ID, pieceId: ID, suggestionId: ID) =>
    `/t/${titleId}/p/${pieceId}?${PROOF_PARAM}=${encodeURIComponent(suggestionId)}`,
  /** セパレート（幕に分ける・幕をさらに分ける）の画面 */
  separate: (titleId: ID, pieceId: ID) => `/t/${titleId}/p/${pieceId}/separate`,
  memo: (titleId: ID, memoId: ID) => `/t/${titleId}/m/${memoId}`,
  read: (titleId: ID, chapterId?: ID) => `/t/${titleId}/read${chapterId ? `?chapter=${chapterId}` : ''}`,
  /** Claude 用のコネクタとの連携（コネクタの画面から開かれる。s はコネクタが渡す連携の印） */
  claudeConnect: () => '/claude/connect',
}
