// 原稿画面だけで使うアイコン（共通の icons.tsx にないもの）
import type { ReactNode, SVGProps } from 'react'

function Svg({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
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
      {...rest}
    >
      {children}
    </svg>
  )
}

export const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
)

export const SlidersIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </Svg>
)

/** 複製して推敲（ページ＋ペン） */
export const ReviseIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
    <path d="M9 8h6M9 12h3" />
    <path d="m14 20 .7-2.8 4.6-4.6a1.4 1.4 0 0 1 2 2l-4.6 4.6z" />
  </Svg>
)

/** 採用を解除（丸に斜線） */
export const UnadoptIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="m6.5 17.5 11-11" />
  </Svg>
)
