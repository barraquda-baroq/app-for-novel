// テスト用の保存先（何も保存しない）。必要な操作だけ差し替えて使う。
import type { Persistence, SaveOutcome } from '../db/persistence'
import { emptyData } from '../domain/types'

export const emptyOutcome = (): SaveOutcome => ({ merged: {}, dropped: {}, written: [] })

export function fakePersistence(over: Partial<Persistence> = {}): Persistence {
  return {
    load: async () => emptyData(),
    save: async () => emptyOutcome(),
    replaceAll: async () => {},
    applyRemote: async () => [],
    readOutbox: async () => [],
    completeUpload: async () => {},
    outboxCount: async () => 0,
    markAllDirty: async () => {},
    getMeta: async () => undefined,
    setMeta: async () => {},
    close: () => {},
    ...over,
  }
}
