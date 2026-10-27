// 通し読み画面だけで使うアイコン
import type { SVGProps } from 'react'

export function VerticalTextIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M17 4v16M12 4v11M7 4v7" />
      <path d="m15 18 2 2 2-2" />
    </svg>
  )
}

export function TextSizeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 19 9 6l5 13M5.8 14.5h6.4M15 19l3-7.5 3 7.5M16 16.8h4" />
    </svg>
  )
}
