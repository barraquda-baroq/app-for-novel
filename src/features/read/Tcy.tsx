// 縦書きで2桁までの半角数字を縦中横にする（見出しの「第12話」など。横書きではそのまま並ぶ）
import { splitTcy } from './readLogic'

export function Tcy({ text }: { text: string }) {
  return (
    <>
      {splitTcy(text).map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <span key={i} className="rt-tcy">
            {part.tcy}
          </span>
        ),
      )}
    </>
  )
}
