// 差分の計算を別スレッドで行う（長文の差分でも入力が止まらないように）。useDiff.ts から使う。
import { diffTexts } from '../../domain/diff'

interface DiffRequest {
  id: number
  base: string
  target: string
}

self.onmessage = (e: MessageEvent<DiffRequest>) => {
  const { id, base, target } = e.data
  try {
    self.postMessage({ id, segments: diffTexts(base, target) })
  } catch {
    // 失敗したら呼び出し側がメインスレッドで計算し直す
    self.postMessage({ id, segments: null })
  }
}
