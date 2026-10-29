// 推敲案の種類（コネクタの入力・手動連携の貼り付け・画面の表示で同じものを使う）。
// 値は ASCII の決まった語（保存する値が揺れないように）、日本語名は表示とツールの説明に使う。
// このフォルダ（src/claude）はアプリとコネクタ（Cloudflare Worker）の両方が使う純粋な部品。React・Dexie・Firebase・Zustand を読み込まない。
import type { ProofCategory } from '../domain/types'

export type { ProofCategory }

/** 種類（この順に並べる） */
export const PROOF_CATEGORIES: readonly ProofCategory[] = [
  'typo',
  'ra_nuki',
  'i_nuki',
  'cliche',
  'tic',
  'repetition',
  'notation',
  'symbols',
  'ruby',
  'grammar',
  'other',
]

export const PROOF_CATEGORY_LABELS: Record<ProofCategory, string> = {
  typo: '誤字脱字・変換ミス',
  ra_nuki: 'ら抜き',
  i_nuki: 'い抜き',
  cliche: '既成表現',
  tic: '作者の癖',
  repetition: '近接重複',
  notation: '表記ゆれ',
  symbols: '記号の作法',
  ruby: 'ルビ・傍点の記法',
  grammar: '文法・係り受け',
  other: 'その他',
}

export function isProofCategory(v: unknown): v is ProofCategory {
  return typeof v === 'string' && (PROOF_CATEGORIES as readonly string[]).includes(v)
}

/**
 * 表示する種類の名前。保存された名前（Claude が category_label で付けた名前・知らない種類の名前）があればそれ、無ければ
 * 決まった名前（知らない種類は「その他」）。手で足した・種類を変えた推敲案は、決まった名前を保存している
 */
export function proofCategoryLabel(category: string, stored?: string): string {
  return stored?.trim() || (isProofCategory(category) ? PROOF_CATEGORY_LABELS[category] : PROOF_CATEGORY_LABELS.other)
}

/** 「typo=誤字脱字・変換ミス, ra_nuki=ら抜き, …」（ツールの入力の説明・手動連携の依頼文に入れる） */
export const PROOF_CATEGORY_GUIDE = PROOF_CATEGORIES.map((c) => `${c}=${PROOF_CATEGORY_LABELS[c]}`).join(', ')
