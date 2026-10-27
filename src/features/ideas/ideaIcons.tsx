// アイデア・ホーム画面で使う、共通アイコン集にないアイコン。
import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Svg({ children, ...rest }: IconProps & { children: ReactNode }) {
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

/** どのタイトルにも属さない（受け箱） */
export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13h4l1.5 3h5L16 13h4" />
    <path d="M5.5 5h13L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z" />
  </Svg>
)

/** アイデアからタイトルを作る */
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </Svg>
)
