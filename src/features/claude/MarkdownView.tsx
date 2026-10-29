// Markdown を表示する（renderMarkdown.ts で安全な HTML にしたもの）。Markdown.tsx から必要な時だけ読み込む。
// 分けた長い文（parts。markdownParts.ts）は、最初の部分をすぐに出し、残りは1つずつ次の機会に変換して足す
// （一度に全部を変換・配置して画面が止まらないように）。画面の外の部分は描かない（.md-section の content-visibility）。
import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { renderMarkdown } from './renderMarkdown'

export default function MarkdownView({
  parts,
  className,
  testId,
}: {
  parts: readonly string[]
  className?: string
  testId?: string
}) {
  // 出した部分の数（parts が変わったら、また最初の部分から）
  const [state, setState] = useState({ parts, shown: 1 })
  const shown = state.parts === parts ? state.shown : 1
  if (state.parts !== parts) setState({ parts, shown: 1 })
  const total = parts.length
  useEffect(() => {
    if (shown >= total) return
    const t = setTimeout(() => setState((s) => (s.parts === parts ? { parts, shown: s.shown + 1 } : s)), 0)
    return () => clearTimeout(t)
  }, [parts, shown, total])
  const cls = `md${className ? ` ${className}` : ''}`
  if (total <= 1) return <One key="one" className={cls} text={parts[0] ?? ''} testId={testId} />
  return (
    <div key="sections" className={`${cls} md-sections`} data-testid={testId} aria-busy={shown < total ? true : undefined}>
      {parts.slice(0, shown).map((p, i) => (
        <Section key={i} text={p} />
      ))}
    </div>
  )
}

function One({ className, text, testId }: { className: string; text: string; testId?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} data-testid={testId} />
}

/** 描く前の高さの見積もり（1字あたり。描いた後は実際の高さを覚える） */
const PX_PER_CHAR = 0.9

const Section = memo(function Section({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const style = useMemo(
    () => ({ containIntrinsicBlockSize: `auto ${Math.max(100, Math.round(text.length * PX_PER_CHAR))}px` }) as CSSProperties,
    [text],
  )
  return <div className="md-section" style={style} dangerouslySetInnerHTML={{ __html: html }} />
})
