// Firestore の REST API の値（Value）と JavaScript の値の変換。
// - integerValue は 10進の文字列、timestampValue は RFC 3339（マイクロ秒まで）。時刻は文字列のまま持つ（cursor にそのまま使う）
// - 記録の文書の項目（table・id・json・chunks・deleted・hash・updated・device・parent・index・reset）だけを扱う

export type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { referenceValue: string }
  | { mapValue: { fields?: Record<string, Value> } }
  | { arrayValue: { values?: Value[] } }
  | { bytesValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }

export type Fields = Record<string, Value>

/** 時刻の値（timestampValue の文字列のまま） */
export interface Timestamp {
  timestamp: string
}

export type Plain = string | number | boolean | null | Timestamp | Plain[] | { [k: string]: Plain }

export function fromValue(v: Value | undefined): Plain {
  if (!v) return null
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('nullValue' in v) return null
  if ('timestampValue' in v) return { timestamp: v.timestampValue }
  if ('referenceValue' in v) return v.referenceValue
  if ('mapValue' in v) return fromFields(v.mapValue.fields ?? {})
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromValue)
  if ('bytesValue' in v) return v.bytesValue
  return null
}

export function fromFields(fields: Fields): { [k: string]: Plain } {
  const out: { [k: string]: Plain } = {}
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v)
  return out
}

export function toValue(x: Plain | undefined): Value {
  if (x === null || x === undefined) return { nullValue: null }
  if (typeof x === 'string') return { stringValue: x }
  if (typeof x === 'boolean') return { booleanValue: x }
  if (typeof x === 'number') return Number.isSafeInteger(x) ? { integerValue: String(x) } : { doubleValue: x }
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } }
  if ('timestamp' in x && typeof (x as Timestamp).timestamp === 'string' && Object.keys(x).length === 1)
    return { timestampValue: (x as Timestamp).timestamp }
  const fields: Fields = {}
  for (const [k, v] of Object.entries(x)) fields[k] = toValue(v as Plain)
  return { mapValue: { fields } }
}

/**
 * RFC 3339 の時刻をマイクロ秒（1970年からの整数）にする。並べ替え・比べるのに使う
 * （ナノ秒までの文字列が来ても、マイクロ秒より下は切り捨てる）
 */
export function timestampMicros(ts: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts)
  if (!m) return Number.NaN
  const ms = Date.parse(`${m[1]}${m[3]}`)
  const frac = (m[2] ?? '').padEnd(6, '0').slice(0, 6)
  return ms * 1000 + Number(frac)
}

export function timestampMillis(ts: string): number {
  return Math.floor(timestampMicros(ts) / 1000)
}
