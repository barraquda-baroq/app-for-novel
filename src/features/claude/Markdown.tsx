// 批評の結果・戦略メモの Markdown。変換の部品（markdown-it）は表示する時に読み込み、読み込むまではそのままの文を出す。
// 長い文は一度に全部を変換・表示しない（markdownParts.ts。25万字・100万字の結果でも画面が止まらないように）:
// - preview（閉じている時。外側で高さを切って見せる）: 最初の 3,000 字ほどの頭だけを変換する
// - 全文: 頭のあとを 16,000 字ほどずつに分け、MarkdownView が1つずつ変換して足す。画面の外の部分は描かない
import { lazy, Suspense, useMemo } from 'react'
import { markdownHead, markdownSections } from './markdownParts'
import './claude.css'

const MarkdownView = lazy(() => import('./MarkdownView'))

export function Markdown({
  text,
  preview = false,
  className,
  testId,
}: {
  text: string
  /** 閉じている時の表示（頭だけ。「全文を表示」で false にする） */
  preview?: boolean
  className?: string
  testId?: string
}) {
  const parts = useMemo(() => (preview ? [markdownHead(text).text] : markdownSections(text)), [text, preview])
  return (
    <Suspense
      fallback={
        <div className={`md md-plain${className ? ` ${className}` : ''}`} data-testid={testId}>
          {parts[0]}
        </div>
      }
    >
      <MarkdownView parts={parts} className={className} testId={testId} />
    </Suspense>
  )
}
