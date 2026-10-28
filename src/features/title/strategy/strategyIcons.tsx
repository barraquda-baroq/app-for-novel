// 戦略タブだけで使うアイコン。応募順の並べ替えは、開閉の山形（∧∨）と見分けやすい矢印にする。
import type { SVGProps } from 'react'

function Arrow({ d, ...props }: SVGProps<SVGSVGElement> & { d: string }) {
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
      <path d={d} />
    </svg>
  )
}

export const ArrowUpIcon = (props: SVGProps<SVGSVGElement>) => <Arrow d="M12 19V5M6 11l6-6 6 6" {...props} />

export const ArrowDownIcon = (props: SVGProps<SVGSVGElement>) => <Arrow d="M12 5v14M6 13l6 6 6-6" {...props} />
