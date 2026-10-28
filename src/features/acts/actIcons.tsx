// セパレート（幕）で使うアイコン（共通の icons.tsx にないもの）
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

/** 区切る（はさみ） */
export const ScissorsIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
  </Svg>
)

/** 幕に分ける（1つを上下に分ける） */
export const SplitActsIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="7" rx="1.5" />
    <rect x="4" y="14" width="16" height="7" rx="1.5" />
    <path d="M2 12h3M8 12h2M13 12h2M19 12h3" />
  </Svg>
)

/** つなぐ（2つを1つに） */
export const JoinActsIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="1.5" />
    <path d="M9 12h6M12 9v6" />
  </Svg>
)

/** セパレート解除（分かれた2つを1つに戻す） */
export const UnsplitIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="1.5" />
    <path d="M8 9.5 12 12l4-2.5M8 14.5 12 12l4 2.5" />
  </Svg>
)

/** 幕に分けた話（重なった紙） */
export const ActsIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 3h9a2 2 0 0 1 2 2v12" />
    <rect x="4" y="7" width="12" height="14" rx="1.5" />
    <path d="M7 11h6M7 14h6M7 17h4" />
  </Svg>
)
