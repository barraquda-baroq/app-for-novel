// 通し読みのアイコン（通し読み画面と、話の画面の「この話を通し読み」）
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

/** 1話だけの通し読み（縦の行のある1枚の紙） */
export function EpisodeReadIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M15 7v10M12 7v10M9 7v6" />
    </svg>
  )
}
