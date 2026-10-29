// Markdown を表示する（markdown.ts で安全な HTML にしたもの）。Markdown.tsx から必要な時だけ読み込む。
import { useMemo } from 'react'
import { renderMarkdown } from './markdown'

export default function MarkdownView({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div className={`md${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} data-testid={testId} />
  )
}
