// Firestore の無料枠（Spark）の日付は太平洋時間で切り替わる。コネクタが1日に使う読み取り・書き込みの数を数え、
// 上限（DAILY_READ_BUDGET・DAILY_WRITE_BUDGET）を超えたら止める（アプリの同期の分を残すため）。
// 太平洋時間の0時は、夏時間の間は日本時間16時、冬時間（2026-11-01 から）は17時。

const pacificDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const pacificParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
})

/** 太平洋時間の日付（YYYY-MM-DD） */
export function pacificDay(ts: number): string {
  return pacificDate.format(new Date(ts))
}

/** その時刻の太平洋時間と UTC の差（分。夏時間 -420、冬時間 -480） */
function pacificOffsetMinutes(ts: number): number {
  const p = Object.fromEntries(pacificParts.formatToParts(new Date(ts)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute))
  return Math.round((asUtc - Math.floor(ts / 60_000) * 60_000) / 60_000)
}

/** 次に枠が戻る時刻（次の太平洋時間の0時） */
export function nextPacificMidnight(ts: number): number {
  const [y, m, d] = pacificDay(ts).split('-').map(Number)
  // 次の日の0時（太平洋時間）。差はその0時の時点のもの（夏時間の切り替えの日をまたいでも合うように、2回で決める）
  const wall = Date.UTC(y, m - 1, d + 1, 0, 0)
  const first = wall - pacificOffsetMinutes(ts) * 60_000
  return wall - pacificOffsetMinutes(first) * 60_000
}

/** 「日本時間16時」「日本時間17時」（次に枠が戻る時刻） */
export function resetLabel(ts: number): string {
  const at = nextPacificMidnight(ts)
  const jst = new Date(at + 9 * 3_600_000)
  const today = new Date(ts + 9 * 3_600_000)
  const sameDay = jst.getUTCDate() === today.getUTCDate()
  const minutes = jst.getUTCMinutes()
  return `${sameDay ? '' : '明日の'}日本時間${jst.getUTCHours()}時${minutes ? `${minutes}分` : ''}`
}

export interface QuotaCounts {
  day: string
  reads: number
  writes: number
}

export function freshQuota(ts: number, prev: QuotaCounts | null): QuotaCounts {
  const day = pacificDay(ts)
  return prev && prev.day === day ? prev : { day, reads: 0, writes: 0 }
}

export function readBudgetMessage(ts: number): string {
  return `今日のコネクタ用の読み取り枠を使い切りました（アプリの同期を守るため）。${resetLabel(ts)}に回復します。`
}

export function writeBudgetMessage(ts: number): string {
  return `今日のコネクタ用の書き込み枠を使い切りました（アプリの同期を守るため）。${resetLabel(ts)}に回復します。`
}

export function firestoreQuotaMessage(ts: number): string {
  return `Firebase の今日の無料枠を使い切りました（アプリの同期も止まっている可能性があります）。${resetLabel(ts)}に回復します。`
}
