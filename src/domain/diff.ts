// 推敲比較用の差分。まず行単位で比べ、変更された行どうしは文字単位で比べ直す。
// 長文でも固まらないよう、文字単位の比較には時間制限を付け、超えたら行単位の結果を使う。
import { diffChars, diffLines, type ChangeObject } from 'diff'

export type DiffSegment = { kind: 'same' | 'add' | 'del'; text: string }

const CHAR_DIFF_TIMEOUT_MS = 150

function push(out: DiffSegment[], kind: DiffSegment['kind'], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

function fromChanges(out: DiffSegment[], changes: ChangeObject<string>[]): void {
  for (const c of changes) push(out, c.added ? 'add' : c.removed ? 'del' : 'same', c.value)
}

/** base（採用原稿）から target（比較するバージョン）への差分 */
export function diffTexts(base: string, target: string): DiffSegment[] {
  if (base === target) return base ? [{ kind: 'same', text: base }] : []
  const lines = diffLines(base, target)
  const out: DiffSegment[] = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    if (cur.removed && next?.added) {
      const fine = diffChars(cur.value, next.value, { timeout: CHAR_DIFF_TIMEOUT_MS })
      if (fine) fromChanges(out, fine)
      else {
        push(out, 'del', cur.value)
        push(out, 'add', next.value)
      }
      i += 1
      continue
    }
    fromChanges(out, [cur])
  }
  return out
}

export function diffSummary(segments: DiffSegment[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const s of segments) {
    const n = Array.from(s.text.replace(/\s/g, '')).length
    if (s.kind === 'add') added += n
    if (s.kind === 'del') removed += n
  }
  return { added, removed }
}
