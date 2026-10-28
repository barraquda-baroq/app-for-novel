// 内容の比較（キーの順番と undefined の項目は問わない）。同期で届いたレコードはキーが並べ替えてあるので、
// JSON 文字列の比較では同じ内容でも違うと判定してしまう。

/** 同じ内容か（キーの順番は問わない） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    if (a.length !== bb.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false
  return true
}
