import { describe, expect, it } from 'vitest'
import { paragraphAt, paragraphSpans } from '../../claude/anchor'
import { diffTexts, type DiffSegment } from '../../domain/diff'
import {
  bodyOffsetOfDisplay,
  clampParagraph,
  displayRangeOf,
  paragraphItems,
  paragraphLabel,
  paragraphTarget,
  paragraphTargetMessage,
  parseParagraphNumber,
} from './paragraphList'

describe('段落の一覧の行', () => {
  it('番号はコネクタと同じ（空行・空白だけの行は数えない）。書き出しはルビ・傍点の記法と読み、行の頭の空白を除いた20字', () => {
    const body = [
      '',
      '　｜漢字《かんじ》の《《傍点》》がある段落。',
      '　\t',
      '',
      '　二十字よりずっと長い段落の書き出しはここで切って三点リーダーを付ける。',
      '短い',
    ].join('\n')
    const items = paragraphItems(body)
    expect(items.map((it) => [it.n, it.label])).toEqual([
      [1, '漢字の傍点がある段落。'],
      [2, '二十字よりずっと長い段落の書き出しはここ…'],
      [3, '短い'],
    ])
    for (const it of items) expect(paragraphAt(body, it.start)).toBe(it.n)
  })

  it('ちょうど20字は「…」を付けず、サロゲートペアは1字で数えて途中で切らない', () => {
    const twenty = 'あ'.repeat(20)
    expect(paragraphLabel(twenty, { start: 0, end: 20 })).toBe(twenty)
    const kichi = '𠮷'.repeat(21)
    const label = paragraphLabel(kichi, { start: 0, end: kichi.length })
    expect(label).toBe(`${'𠮷'.repeat(20)}…`)
    expect(label.endsWith('\ud842…')).toBe(false)
    // 記法が20字の境目をまたいでも、親文字だけで数える
    const ruby = `${'あ'.repeat(18)}｜漢字《かんじ》の後ろ`
    expect(paragraphLabel(ruby, { start: 0, end: ruby.length })).toBe(`${'あ'.repeat(18)}漢字…`)
  })

  it('カーソルの段落: 空行の中は次の段落、最後の段落より後ろは最後の段落。段落が無ければ null', () => {
    const body = '一\n\n二\n\n'
    const total = paragraphSpans(body).length
    const at = (offset: number) => clampParagraph(paragraphAt(body, offset), total)
    expect(at(0)).toBe(1)
    expect(at(2)).toBe(2)
    // 最後の段落より後ろ（終わりの空行）は最後の段落
    expect(paragraphAt(body, body.length)).toBe(3)
    expect(at(body.length)).toBe(2)
    expect(clampParagraph(0, total)).toBe(1)
    expect(clampParagraph(null, total)).toBeNull()
    expect(clampParagraph(1, 0)).toBeNull()
  })
})

describe('番号の欄', () => {
  it('「28」「¶28」「２８」「¶２８」と前後の空白を受け付ける', () => {
    for (const raw of ['28', '¶28', '２８', '¶２８', ' 28 ', '¶ 28', '　２８　', '028'])
      expect(parseParagraphNumber(raw), raw).toBe(28)
    for (const raw of ['', '¶', 'abc', '2 8', '-3', '2.5', '二十八', '28段落', '¶¶28', '12345678']) {
      expect(parseParagraphNumber(raw), raw).toBeNull()
    }
  })

  it('範囲の外は移らずに言う（0・段落の数より大きい・段落が無い）', () => {
    expect(paragraphTarget('', 10)).toEqual({ kind: 'empty' })
    expect(paragraphTarget('  ', 10)).toEqual({ kind: 'empty' })
    expect(paragraphTarget('x', 10)).toEqual({ kind: 'invalid' })
    expect(paragraphTarget('¶10', 10)).toEqual({ kind: 'ok', n: 10 })
    expect(paragraphTarget('1', 10)).toEqual({ kind: 'ok', n: 1 })
    expect(paragraphTarget('0', 10)).toEqual({ kind: 'out', n: 0, total: 10 })
    expect(paragraphTarget('１１', 10)).toEqual({ kind: 'out', n: 11, total: 10 })
    expect(paragraphTarget('1', 0)).toEqual({ kind: 'out', n: 1, total: 0 })
    expect(paragraphTargetMessage(paragraphTarget('1200', 1000))).toBe('¶1,200 はありません（この稿は全1,000段落です）')
    expect(paragraphTargetMessage(paragraphTarget('1', 0))).toBe('この稿には段落がありません')
    expect(paragraphTargetMessage(paragraphTarget('x', 10))).toBe('番号を数字で入れてください（例: 28）')
    expect(paragraphTargetMessage(paragraphTarget('3', 10))).toBe('')
    expect(paragraphTargetMessage(paragraphTarget('', 10))).toBe('')
  })
})

describe('差分の表示の位置', () => {
  const display = (segs: DiffSegment[]) => segs.map((s) => s.text).join('')
  const body = (segs: DiffSegment[]) =>
    segs
      .filter((s) => s.kind !== 'del')
      .map((s) => s.text)
      .join('')

  it('段落の範囲を写すと、表示でも同じ文字（削除された文字は、同じ行の頭・終わりにくっついたものだけ足す）', () => {
    const segs: DiffSegment[] = [
      { kind: 'same', text: '一段落目。\n' },
      { kind: 'del', text: '消した' },
      { kind: 'add', text: '足した' },
      { kind: 'same', text: '二段落目' },
      { kind: 'del', text: 'の終わり' },
      { kind: 'same', text: '\n' },
      { kind: 'del', text: '消した段落\n' },
      { kind: 'same', text: '三段落目。' },
    ]
    const b = body(segs)
    const d = display(segs)
    const spans = paragraphSpans(b)
    expect(spans.map((s) => b.slice(s.start, s.end))).toEqual(['一段落目。', '足した二段落目', '三段落目。'])
    const ranges = spans.map((s) => displayRangeOf(segs, s.start, s.end))
    expect(ranges.map((r) => d.slice(r.start, r.end))).toEqual(['一段落目。', '消した足した二段落目の終わり', '三段落目。'])
  })

  it('表示の位置から稿の本文の位置へ（削除された文字の中は、その前の位置）', () => {
    const segs: DiffSegment[] = [
      { kind: 'same', text: 'ab' },
      { kind: 'del', text: 'XY' },
      { kind: 'add', text: 'c' },
      { kind: 'same', text: '\nd' },
    ]
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((p) => bodyOffsetOfDisplay(segs, p))).toEqual([0, 1, 2, 2, 2, 3, 4, 5])
  })

  it('実際の差分でも、各段落の写した範囲の稿の文字は元の段落と同じ', () => {
    const before = '　春は曙。\n\n　やうやう白くなりゆく山際。\n　少し明かりて。\n\n　紫だちたる雲の細くたなびきたる。'
    const after = '　春は曙。\n\n　ようやく白くなっていく山際。\n\n　紫だちたる雲が細くたなびいている。\n　夏は夜。'
    const segs = diffTexts(before, after)
    expect(body(segs)).toBe(after)
    const d = display(segs)
    for (const s of paragraphSpans(after)) {
      const r = displayRangeOf(segs, s.start, s.end)
      // 表示の範囲から削除された文字を除くと、稿の段落の文字
      const kept = [...Array(r.end - r.start).keys()]
        .map((k) => r.start + k)
        .filter((p) => bodyOffsetOfDisplay(segs, p + 1) > bodyOffsetOfDisplay(segs, p))
        .map((p) => d[p])
        .join('')
      expect(kept).toBe(after.slice(s.start, s.end))
      expect(d.slice(r.start, r.end)).not.toMatch(/\n/)
    }
  })
})

describe('長い話', () => {
  it('2万字・400段落の本文でも、一覧を作るのは一瞬（開いている間だけ作る）', () => {
    const body = Array.from({ length: 400 }, (_, i) =>
      `　第${i + 1}段落。${i % 9 === 0 ? '｜漢字《かんじ》' : ''}地の文が続きます。`.padEnd(48, 'あ'),
    )
      .join('\n\n')
      .padStart(20_000, '\n')
    expect(body.length).toBeGreaterThanOrEqual(20_000)
    paragraphItems(body)
    const t = performance.now()
    for (let k = 0; k < 10; k++) {
      const items = paragraphItems(body)
      expect(items).toHaveLength(400)
    }
    // 1回あたり 20ms 未満（ふつうは 1ms ほど）
    expect((performance.now() - t) / 10).toBeLessThan(20)
    expect(paragraphItems(body)[399].label.startsWith('第400段落。')).toBe(true)
  })
})
