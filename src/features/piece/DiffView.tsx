// 採用原稿 → 選んだ推敲バージョン の差分表示（読み取り専用）
// 計算中も同じ要素を使う（スクロール同期の対象が入れ替わらないように）。
// 長文では要素が多いので、差分が変わらない限り描き直さない（採用原稿の自動保存のたびに描き直さない）。
import { memo } from 'react'
import type { DiffSegment } from '../../domain/diff'

export const DiffView = memo(function DiffView({ segments }: { segments: DiffSegment[] | null }) {
  return (
    <div
      className={`manuscript diff-view pw-diff${segments ? '' : ' is-pending'}`}
      data-testid="diff-view"
      data-scroll-sync="compare"
      tabIndex={0}
      role="document"
      aria-label="採用原稿との差分（読み取り専用）"
      aria-busy={segments ? undefined : true}
    >
      {segments === null ? (
        <span className="faint" data-testid="diff-pending">
          差分を計算中…
        </span>
      ) : segments.length === 0 ? (
        <span className="faint">（本文がありません）</span>
      ) : (
        segments.map((s, i) =>
          s.kind === 'same' ? (
            <span key={i}>{s.text}</span>
          ) : s.kind === 'add' ? (
            <ins key={i} className="diff-add">
              {s.text}
            </ins>
          ) : (
            <del key={i} className="diff-del">
              {s.text}
            </del>
          ),
        )
      )}
    </div>
  )
})
