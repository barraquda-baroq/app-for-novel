// 応募計画の、原稿と一緒に提出する文章（梗概・あらすじ、キャッチコピー）の文字数と規定。
// 戦略タブ・Claude 用のコネクタ・手動連携の依頼文で、同じ数え方（原稿と同じ countChars: 空白・改行、
// ルビ・傍点の記号とルビの読みを除く）と同じ言い方を使う。
import { countChars, formatCount } from './text'
import type { Submission } from './types'

/** 文字数を規定と比べる、原稿と一緒に提出する文章 */
export type SubmissionTextField = 'synopsis' | 'catchphrase'

export const SUBMISSION_TEXT_FIELDS: readonly SubmissionTextField[] = ['synopsis', 'catchphrase']

export interface SubmissionTextDef {
  /** 名前（「梗概・あらすじ」） */
  name: string
  /** 短い名前（畳んだカードの札） */
  short: string
  min: 'synopsisMin' | 'catchphraseMin'
  max: 'synopsisMax' | 'catchphraseMax'
}

export const SUBMISSION_TEXT: Record<SubmissionTextField, SubmissionTextDef> = {
  synopsis: { name: '梗概・あらすじ', short: '梗概', min: 'synopsisMin', max: 'synopsisMax' },
  catchphrase: { name: 'キャッチコピー', short: 'キャッチコピー', min: 'catchphraseMin', max: 'catchphraseMax' },
}

/** 提出する文章と、その文字数の規定に使う項目 */
export type SubmissionTextSource = Partial<
  Pick<Submission, SubmissionTextField | SubmissionTextDef['min'] | SubmissionTextDef['max']>
>

/** 提出する文章の本文と規定（後から足した項目なので、古いデータで無ければ空・規定なし） */
export function submissionTextOf(
  s: SubmissionTextSource,
  field: SubmissionTextField,
): { text: string; min: number | null; max: number | null } {
  const def = SUBMISSION_TEXT[field]
  return { text: s[field] ?? '', min: s[def.min] ?? null, max: s[def.max] ?? null }
}

export interface TextLimitCheck {
  state: 'ok' | 'short' | 'over'
  /** 下限まで足りない／上限を超えた字数 */
  diff: number
  /** 「あと150字」「12字超えています」「規定内」 */
  text: string
}

/** 文字数が規定（下限・上限）に収まっているか。どちらも未設定なら null */
export function textLimitCheck(count: number, min: number | null, max: number | null): TextLimitCheck | null {
  if (min === null && max === null) return null
  if (min !== null && count < min) return { state: 'short', diff: min - count, text: `あと${formatCount(min - count)}字` }
  if (max !== null && count > max) return { state: 'over', diff: count - max, text: `${formatCount(count - max)}字超えています` }
  return { state: 'ok', diff: 0, text: '規定内' }
}

/** 「100〜300字」「100字以上」「300字以内」（どちらも未設定なら空文字） */
export function textLimitRange(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${formatCount(min)}〜${formatCount(max)}字`
  if (min !== null) return `${formatCount(min)}字以上`
  if (max !== null) return `${formatCount(max)}字以内`
  return ''
}

export interface SubmissionTextStatus {
  field: SubmissionTextField
  text: string
  /** 空白・改行を除いた文字数 */
  count: number
  min: number | null
  max: number | null
  check: TextLimitCheck | null
}

export function submissionTextStatus(s: SubmissionTextSource, field: SubmissionTextField): SubmissionTextStatus {
  const { text, min, max } = submissionTextOf(s, field)
  const count = countChars(text)
  return { field, text, count, min, max, check: textLimitCheck(count, min, max) }
}

/** 「330字（規定 100〜300字・30字超えています）」「17字」（Claude に渡す文の中で使う） */
export function textCountLabel(st: Pick<SubmissionTextStatus, 'count' | 'min' | 'max' | 'check'>): string {
  const n = `${formatCount(st.count)}字`
  return st.check ? `${n}（規定 ${textLimitRange(st.min, st.max)}・${st.check.text}）` : n
}

/** 1行に詰めて、長ければ切る */
function clipLine(text: string, n: number): string {
  const one = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(one)
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : one
}

/**
 * Claude に渡す応募計画の一覧の、後から足した項目の抜粋（規定の備考・提出する梗概／キャッチコピーの文字数と規定・特記事項）。
 * 書いていない項目（梗概・キャッチコピーは規定も無いもの）は出さない。clip は1行に詰めて切る関数
 */
export function submissionExtraLines(
  s: SubmissionTextSource & Partial<Pick<Submission, 'limitNote' | 'specialNotes'>>,
  clip: (text: string, n: number) => string = clipLine,
): string[] {
  const out: string[] = []
  const note = (s.limitNote ?? '').trim()
  if (note) out.push(`規定の備考: ${clip(note, 60)}`)
  for (const field of SUBMISSION_TEXT_FIELDS) {
    const st = submissionTextStatus(s, field)
    if (!st.text.trim() && !st.check) continue
    // キャッチコピーは短いので中身も添える
    const quote = field === 'catchphrase' && st.text.trim() ? ` 「${clip(st.text, 40)}」` : ''
    out.push(`${SUBMISSION_TEXT[field].name}: ${textCountLabel(st)}${quote}`)
  }
  const special = (s.specialNotes ?? '').trim()
  if (special) out.push(`特記事項: ${clip(special, 60)}`)
  return out
}
