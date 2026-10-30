// 起動アニメーション（src/launch/launch.js。index.html に埋め込んであり、アプリより先に動いている）とのつなぎ。
// アプリは最初の画面を出せたら知らせる。アニメーションも終わっていれば、それで消える（docs/SPEC.md の「起動アニメーション」）

interface LaunchGlobal {
  appReady?: () => void
  active?: () => boolean
}

const launch = (): LaunchGlobal | undefined => (window as unknown as { NovelStudioLaunch?: LaunchGlobal }).NovelStudioLaunch

/** アプリが最初の画面を出せた（起動アニメーションを出していなければ何もしない） */
export function notifyAppReady(): void {
  try {
    launch()?.appReady?.()
  } catch {
    /* アニメーションが消えなくても、5秒で消える */
  }
}

/** 起動アニメーションを出している（消えている途中も含む） */
export function launchActive(): boolean {
  try {
    return launch()?.active?.() ?? false
  } catch {
    return false
  }
}

/** 次に画面に描かれた後に fn を呼ぶ（requestAnimationFrame を2回。描画が止まっている間も timeoutMs で呼ぶ） */
export function afterNextPaint(fn: () => void, timeoutMs = 1000): void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    fn()
  }
  requestAnimationFrame(() => requestAnimationFrame(run))
  setTimeout(run, timeoutMs)
}
