// Claude 連携（推敲案・改稿案・作品批評・コネクタ）で使うアイコン。
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Svg({ children, ...rest }: IconProps & { children: React.ReactNode }) {
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

/** Claude が作った記録の印（きらめき） */
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
    <path d="M18.5 16v4M16.5 18h4" />
  </Svg>
)

/** フラグ（常に一番上） */
export const FlagIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" fill={filled ? 'currentColor' : 'none'} />
  </Svg>
)

/** 貼り付け（クリップボード） */
export const PasteIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="4.5" width="12" height="16" rx="2" />
    <path d="M9 4.5V3.8A.8.8 0 0 1 9.8 3h4.4a.8.8 0 0 1 .8.8v.7M9 11h6M9 15h4" />
  </Svg>
)

/** Claude に頼む（吹き出し） */
export const AskIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
    <path d="M8.5 9.5h7M8.5 12.5h4.5" />
  </Svg>
)

/** コネクタ（差し込み） */
export const PlugIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z" />
    <path d="M12 16v5" />
  </Svg>
)

/** 本文の中の場所へ（目） */
export const LocateIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
)
