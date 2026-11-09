// 相対比較の作品の自動のタグ（2.7）: 「14 検索用タグ」の判定したジャンル・サブジャンルを、まだ取り込んでいない作品に付ける
// （src/domain/benchTags.ts の applyAutoGenreTags）。何も描かない。App の外枠に1つだけ置く（TrashPurge と同じ）。
// - 同期している端末では、同期を受け持つ画面で、クラウドと揃っている時だけ動かす（benchLogic.ts の autoTagGate）。
//   2台が同時に付けても、タグは並びとして合わせ、autoTagsFrom は新しい方になる（src/sync/merge.ts）
// - 作品・分析が変わってから少し待ってから付ける（ほかの端末の変更が何回かに分かれて届くのを待つ）
// - 前に当てた時から作品・分析の表が変わっていなければ当てない（同期の表示が変わる度に全作品を読まないように）
import { useEffect, useRef, useState } from 'react'
import { actions } from '../../store/actions'
import { getData, getPersistence, useApp } from '../../store/appStore'
import { useSync } from '../../sync/controller'
import { autoTagGate } from './benchLogic'

/** 作品・分析が変わってから付けるまで待つ長さ */
export const AUTO_TAG_DELAY_MS = 1500

export function BenchAutoTags() {
  const ready = useApp((s) => s.status === 'ready')
  const works = useApp((s) => s.data.benchWorks)
  const analyses = useApp((s) => s.data.benchAnalyses)
  /** この端末が一度でも同期したか（端末内の記録を読むまでは null） */
  const [hasUid, setHasUid] = useState<boolean | null>(null)
  const gate = useSync((s) => autoTagGate({ ...s, hasUid }))
  const last = useRef<{ works: object; analyses: object } | null>(null)

  useEffect(() => {
    if (!ready) return
    let alive = true
    const p = getPersistence()
    if (!p) {
      setHasUid(false)
      return
    }
    p.getMeta<string>('uid').then(
      (uid) => alive && setHasUid(Boolean(uid)),
      () => alive && setHasUid(true),
    )
    return () => {
      alive = false
    }
  }, [ready])

  useEffect(() => {
    if (!ready || !gate) return
    if (last.current && last.current.works === works && last.current.analyses === analyses) return
    const timer = window.setTimeout(() => {
      try {
        actions.applyAutoGenreTags()
      } catch (e) {
        console.warn('相対比較の作品に自動のタグを付けられませんでした', e)
      }
      const d = getData()
      last.current = { works: d.benchWorks, analyses: d.benchAnalyses }
    }, AUTO_TAG_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [ready, gate, works, analyses])

  return null
}
