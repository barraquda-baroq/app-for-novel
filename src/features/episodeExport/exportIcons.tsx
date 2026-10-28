// 各話テキスト書き出しのアイコン（重なった2枚の原稿）
import type { SVGProps } from 'react'

export const FilesIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg
    className="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...p}
  >
    <path d="M9 3h6l4 4v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M15 3v4h4" />
    <path d="M4 8v11a3 3 0 0 0 3 3h8" />
    <path d="M10 11h5M10 14h5" />
  </svg>
)
