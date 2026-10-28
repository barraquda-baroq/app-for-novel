import { useEffect, useState } from 'react'
import { usePrefs } from '../store/uiStore'

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (!window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * 広い画面（デスクトップ）なら左右、スマホ・タブレットの縦持ちなら上下。
 * スマホの横持ち（高さが低い横長の画面）は上下に分けると1行も見えないので左右にする
 * （キーボードで縦に縮んだ縦持ち画面を横持ちと誤判定しないよう、縦横比 4:3 以上で判定する）。設定で固定もできる。
 */
export function useSplitOrientation(): 'horizontal' | 'vertical' {
  const pref = usePrefs((s) => s.splitOrientation)
  const wide = useMediaQuery('(min-width: 900px)')
  const shortLandscape = useMediaQuery('(min-aspect-ratio: 4/3) and (max-height: 600px)')
  if (pref === 'horizontal') return 'horizontal'
  if (pref === 'vertical') return 'vertical'
  return wide || shortLandscape ? 'horizontal' : 'vertical'
}

export function useIsMobile(): boolean {
  return !useMediaQuery('(min-width: 721px)')
}

/** ドキュメントタイトルを設定する */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — Novel Studio` : 'Novel Studio'
  }, [title])
}
