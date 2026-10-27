import { useCallback, useState } from 'react'

/**
 * 下書き中の本文（文字数表示用）。id が変わったら保存済みの値に戻る。
 * onDraftChange は id ごとに同じ関数を返す（DraftTextarea の effect が回り続けないように）。
 */
export function useLiveMemoText(id: string, stored: string): [string, (text: string) => void] {
  const [live, setLive] = useState<{ id: string; text: string } | null>(null)
  const onDraftChange = useCallback((text: string) => setLive({ id, text }), [id])
  return [live && live.id === id ? live.text : stored, onDraftChange]
}
