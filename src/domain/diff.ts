// 推敲比較用の差分。まず行単位で比べ、変更された行どうしは文字単位で比べ直す。
// 長文でも固まらないよう、文字単位の比較には時間制限を付ける。制限を超えた大きな変更は
// 行どうしを組にして比べ直し、それでも無理な時だけ行ごとの削除・追加として示す。
import { diffChars, diffLines, type ChangeObject } from 'diff'

export type DiffSegment = { kind: 'same' | 'add' | 'del'; text: string }

const CHAR_DIFF_TIMEOUT_MS = 150
const LINE_PAIR_TIMEOUT_MS = 30
/** 変更の間に挟まったこの長さ以下（1文字）の一致は、読みやすさのため変更に含める（「ゆっくり」と「踊っ」の「っ」等） */
const SHORT_MATCH = 1

function push(out: DiffSegment[], kind: DiffSegment['kind'], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

function fromChanges(out: DiffSegment[], changes: ChangeObject<string>[]): void {
  for (const c of changes) push(out, c.added ? 'add' : c.removed ? 'del' : 'same', c.value)
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** 大きな変更ブロックを、行どうしの組ごとに文字単位で比べる */
function diffBlockByLines(out: DiffSegment[], removed: string, added: string): void {
  const a = splitLines(removed)
  const b = splitLines(added)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? ''
    const y = b[i] ?? ''
    if (!x || !y) {
      push(out, 'del', x)
      push(out, 'add', y)
      continue
    }
    const fine = diffChars(x, y, { timeout: LINE_PAIR_TIMEOUT_MS })
    if (fine) fromChanges(out, fine)
    else {
      push(out, 'del', x)
      push(out, 'add', y)
    }
  }
}

/** 変更に挟まれた短い一致を変更に含め、削除→追加の順にまとめ直す */
function cleanupShortMatches(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  let del = ''
  let add = ''
  let inChange = false
  const flushChange = () => {
    push(out, 'del', del)
    push(out, 'add', add)
    del = ''
    add = ''
    inChange = false
  }
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (s.kind === 'del') {
      del += s.text
      inChange = true
    } else if (s.kind === 'add') {
      add += s.text
      inChange = true
    } else {
      const next = segments[i + 1]
      const short = Array.from(s.text).length <= SHORT_MATCH && !s.text.includes('\n')
      if (inChange && short && next && next.kind !== 'same') {
        del += s.text
        add += s.text
        continue
      }
      if (inChange) flushChange()
      push(out, 'same', s.text)
    }
  }
  if (inChange) flushChange()
  return out
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
      else diffBlockByLines(out, cur.value, next.value)
      i += 1
      continue
    }
    fromChanges(out, [cur])
  }
  return cleanupShortMatches(out)
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
