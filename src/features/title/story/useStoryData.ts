// 本編の一覧・集計を、本編に関わるデータが変わった時だけ計算し直すためのフック。
import { useMemo } from 'react'
import type { AppData, ID } from '../../../domain/types'
import { useData } from '../../../store/appStore'

/**
 * 本編（話・推敲バージョン・章と、このタイトルの並び・章の設定）が変わった時だけ新しくなる data。
 * あらすじ・設定項目・戦略・メモなどの編集では同じオブジェクトを返すので、
 * `useMemo(() => 導出(storyData, ...), [storyData, ...])` の集計や一覧の行を数え直さずに済む。
 *
 * 本編の導出（話数・並び・採用原稿・集計）専用。タイトル名など本編以外の値は、ここから読まず useData() から読むこと
 * （本編以外の変更では古いままになる）。
 */
export function useStoryData(titleId: ID): AppData {
  const data = useData()
  const title = data.titles[titleId]
  const { pieces, versions, chapters } = data
  const structure = title?.structure
  const chaptersEnabled = title?.chaptersEnabled
  const numbering = title?.numbering
  // 依存に挙げた値だけが本編の導出に使われる（data 全体を依存にすると、あらすじの入力でも数え直す）
  return useMemo(() => data, [titleId, pieces, versions, chapters, structure, chaptersEnabled, numbering])
}
