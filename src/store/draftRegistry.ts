// 入力欄（DraftInput / DraftTextarea）がまだストアに反映していない下書きの一覧。
// 画面を閉じる・裏に回る時に、ストアの保存より先にすべての下書きを反映するために使う。
import { useApp } from './appStore'

const dirtyDrafts = new Map<symbol, () => void>()

function publish(): void {
  const dirty = dirtyDrafts.size > 0
  if (useApp.getState().draftsDirty !== dirty) useApp.setState({ draftsDirty: dirty })
}

/** 下書きが未反映になった。flush は下書きをストアへ反映する関数 */
export function markDraftDirty(key: symbol, flush: () => void): void {
  dirtyDrafts.set(key, flush)
  publish()
}

export function markDraftClean(key: symbol): void {
  if (dirtyDrafts.delete(key)) publish()
}

/** 未反映の下書きをすべてストアへ反映する（同期的に終わる） */
export function flushAllDrafts(): void {
  for (const flush of [...dirtyDrafts.values()]) {
    try {
      flush()
    } catch (e) {
      console.error(e)
    }
  }
}

export function hasDirtyDrafts(): boolean {
  return dirtyDrafts.size > 0
}
