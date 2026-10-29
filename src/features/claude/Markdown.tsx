// 批評の結果・戦略メモの Markdown。変換の部品（markdown-it）は表示する時に読み込み、読み込むまではそのままの文を出す。
import { lazy, Suspense } from 'react'
import './claude.css'

const MarkdownView = lazy(() => import('./MarkdownView'))

export function Markdown({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  return (
    <Suspense
      fallback={
        <div className={`md md-plain${className ? ` ${className}` : ''}`} data-testid={testId}>
          {text}
        </div>
      }
    >
      <MarkdownView text={text} className={className} testId={testId} />
    </Suspense>
  )
}
