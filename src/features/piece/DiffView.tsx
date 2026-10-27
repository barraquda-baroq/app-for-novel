// 採用原稿 → 選んだ推敲バージョン の差分表示（読み取り専用）
import type { DiffSegment } from '../../domain/diff'

export function DiffView({ segments }: { segments: DiffSegment[] }) {
  return (
    <div
      className="manuscript diff-view pw-diff"
      data-testid="diff-view"
      data-scroll-sync="compare"
      tabIndex={0}
      role="document"
      aria-label="採用原稿との差分（読み取り専用）"
    >
      {segments.length === 0 ? (
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
}
