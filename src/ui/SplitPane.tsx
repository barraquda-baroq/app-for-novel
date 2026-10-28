// 2つの領域を左右（horizontal）または上下（vertical）に分割し、境界をドラッグして比率を変えられるペイン。
// マウス・タッチ・キーボード（矢印キー）に対応。
import { useRef, useState, type ReactNode } from 'react'
import { clampRatio } from '../store/uiStore'

export interface SplitPaneProps {
  orientation: 'horizontal' | 'vertical'
  /** first 側の割合（0.15〜0.85） */
  ratio: number
  onRatioChange: (ratio: number) => void
  first: ReactNode
  second: ReactNode
  firstLabel?: string
  secondLabel?: string
  className?: string
}

export function SplitPane({
  orientation,
  ratio,
  onRatioChange,
  first,
  second,
  firstLabel,
  secondLabel,
  className,
}: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const r = clampRatio(ratio)

  const ratioFromPointer = (clientX: number, clientY: number) => {
    const rect = container.current?.getBoundingClientRect()
    if (!rect) return r
    const pos = orientation === 'horizontal' ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height
    return clampRatio(pos)
  }

  return (
    <div ref={container} className={`split ${orientation}${className ? ` ${className}` : ''}`}>
      <section className="split-pane" style={{ flexBasis: `${r * 100}%`, flexGrow: 0, flexShrink: 0 }} aria-label={firstLabel}>
        {first}
      </section>
      <div
        className={`split-divider${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-label="表示比率を変更"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(r * 100)}
        tabIndex={0}
        data-testid="split-divider"
        onPointerDown={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => {
          if (!dragging) return
          onRatioChange(ratioFromPointer(e.clientX, e.clientY))
        }}
        onPointerUp={(e) => {
          ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
          setDragging(false)
        }}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => onRatioChange(0.5)}
        onKeyDown={(e) => {
          const back = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
          const fwd = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
          if (e.key === back) onRatioChange(clampRatio(r - 0.02))
          else if (e.key === fwd) onRatioChange(clampRatio(r + 0.02))
          else if (e.key === 'Home') onRatioChange(0.15)
          else if (e.key === 'End') onRatioChange(0.85)
          else if (e.key === 'Enter') onRatioChange(0.5)
          else return
          e.preventDefault()
        }}
      >
        <span className="grip" aria-hidden="true">
          {orientation === 'horizontal' ? '⋮' : '⋯'}
        </span>
      </div>
      <section className="split-pane" style={{ flex: 1 }} aria-label={secondLabel}>
        {second}
      </section>
    </div>
  )
}
