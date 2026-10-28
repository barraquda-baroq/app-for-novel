// 「今日」（端末のローカル日付）。開いたまま日付が変わっても締切・結果発表までの日数が古くならないよう、
// 次の午前0時と、画面に戻ってきた時（visibilitychange / focus）に更新する。
import { useEffect, useState } from 'react'
import { isSameDay } from './strategyLogic'

export function useToday(): Date {
  const [today, setToday] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      const now = new Date()
      setToday((prev) => (isSameDay(prev, now) ? prev : now))
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      const now = new Date()
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      // 少し遅らせて、確実に日付が変わってから更新する
      timer = setTimeout(
        () => {
          refresh()
          schedule()
        },
        nextMidnight.getTime() - now.getTime() + 1000,
      )
    }
    // スリープ明けなどでタイマーが遅れることがあるので、画面に戻った時にも確かめる
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return
      refresh()
      schedule()
    }
    // マウント前に日付が変わっていた場合にも追従する
    refresh()
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  return today
}
