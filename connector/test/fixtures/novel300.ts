// テスト用: 300話・約30万字の長編（ルビ・幕・特殊ブロック・設定・メモ・応募計画・推敲案・改稿案・戦略メモ・作品批評つき）。
// どのツールの結果も10万字を超えないことを確かめるのに使う。
import { buildProofreading, buildStrategyNote } from '../../../src/claude/records'
import { addClaudeRecords, addCritiquePrompt, addCritiqueResult, addRevisionIdea } from '../../../src/domain/claudeOps'
import { addCategory, addEntry, addIdea, addMemo, addSubmission, updateEntry, updateMemo, updateSubmission } from '../../../src/domain/entityOps'
import type { AppData, ID } from '../../../src/domain/types'
import { addPrologue, novel, splitEpisode } from '../../../src/test/claudeFixture'

const SENTENCES = [
  '窓から見れる景色は、いつもと同じ灰色だった。',
  '｜彼女《かのじょ》は小さく息を吐いて、《《何も》》言わなかった。',
  '雨の音だけが、静かな部屋を満たしていく。',
  '駅までの道は、思っていたよりずっと長かった。',
  '「本当に、それでいいの？」と彼は尋ねた。',
  '遠くで電車の音が聞こえる――それは約束の合図だった……。',
]

function body(n: number, chars = 1_000): string {
  // 話ごとに1つだけの文（推敲案の引用の場所が1つに決まるように）
  const paras: string[] = [`　第${n}話だけの文、番号${n}号。もう一つの固有文${n}号。`]
  let len = paras[0].length
  let i = n
  while (len < chars) {
    const p = Array.from({ length: 3 }, () => SENTENCES[i++ % SENTENCES.length]).join('')
    paras.push(`　${p}`)
    len += p.length + 2
  }
  return paras.join('\n')
}

export interface Novel300 {
  data: AppData
  titleId: ID
  ids: ID[]
}

export function novel300(): Novel300 {
  const n = novel(
    Array.from({ length: 300 }, (_, i) => body(i)),
    { name: '星の庭', subtitles: Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? `題その${i + 1}` : '')) },
  )
  addPrologue(n, 'プロローグ', body(999, 2_000))
  splitEpisode(n, n.ids[10], [300, 600])
  splitEpisode(n, n.ids[120], [500])
  let data = n.data
  const t = n.titleId
  data = { ...data, titles: { ...data.titles, [t]: { ...data.titles[t], synopsis: 'あらすじ。'.repeat(100), strategyNote: '全体戦略のメモ。\n'.repeat(500) } } }
  for (let i = 0; i < 20; i++) {
    const m = addMemo(data, t, `メモ${i + 1}`)
    data = updateMemo(m.data, m.result, { body: body(i, 3_000) })
  }
  const cat = addCategory(data, t, 'キャラクター', ['年齢', '性格'])
  data = cat.data
  for (let i = 0; i < 40; i++) {
    const e = addEntry(data, cat.result, `人物${i + 1}`)
    data = updateEntry(e.data, e.result, { body: body(i, 2_000) })
  }
  for (let i = 0; i < 30; i++) data = addIdea(data, t, `アイデア${i + 1}`, body(i, 1_500)).data
  for (let i = 0; i < 5; i++) {
    const s = addSubmission(data, t, `新人賞${i + 1}`)
    data = updateSubmission(s.data, s.result, { deadline: '2026-12-01', minChars: 100_000, maxChars: 150_000, overview: body(i, 3_000) })
  }
  for (let i = 0; i < 40; i++) data = addRevisionIdea(data, t, { heading: `改稿案${i + 1}`, body: body(i, 5_000), pieceIds: [n.ids[i]] }).data
  for (let i = 0; i < 6; i++) data = addCritiquePrompt(data, i < 4 ? t : null, { name: `批評${i + 1}`, body: body(i, 2_000) }).data
  for (let i = 0; i < 12; i++) data = addCritiqueResult(data, t, { resultMarkdown: `# 批評\n${body(i, 20_000)}`, runDate: `2026-10-${String(10 + i).padStart(2, '0')}` }).data
  const ctx = { source: 'paste' as const, now: Date.UTC(2026, 9, 28) }
  // 推敲案 500件（5回の実行）
  for (let run = 0; run < 5; run++) {
    const items = Array.from({ length: 100 }, (_, i) => {
      const k = run * 60 + Math.floor(i / 2)
      return {
        // #1 はプロローグ、#2 から第1話（本文は body(0)）
        piece: `#${Math.min(299, k) + 2}`,
        excerpt: i % 2 ? `番号${Math.min(299, k)}号` : `固有文${Math.min(299, k)}号`,
        context_before: '',
        category: i % 3 ? 'repetition' : 'cliche',
        suggestion: '言い換え案'.repeat(10),
        reason: '理由の説明。'.repeat(20),
        important: i % 17 === 0,
      }
    })
    const r = buildProofreading(data, { title_id: t, run_label: `ワードサーチ${run + 1}`, items, covered: items.map((x) => x.piece) }, ctx)
    data = addClaudeRecords(data, r.records).data
  }
  for (let i = 0; i < 8; i++) {
    const r = buildStrategyNote(
      data,
      {
        title_id: t,
        heading: `戦略${i + 1}`,
        body: body(i, 8_000),
        run_date: `2026-10-${String(20 + i).padStart(2, '0')}`,
        contests: Array.from({ length: 5 }, (_, k) => ({ name: `賞${k + 1}`, deadline: '2027-01-31', fit: '相性'.repeat(50), plan: '方針'.repeat(300) })),
      },
      ctx,
    )
    data = addClaudeRecords(data, r.records).data
  }
  return { data, titleId: t, ids: n.ids }
}
