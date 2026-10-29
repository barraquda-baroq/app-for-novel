import { describe, expect, it } from 'vitest'
import { HEAD_CHARS, markdownHead, markdownSections, SECTION_CHARS, SizedCache } from './markdownParts'
import { renderMarkdown } from './renderMarkdown'

/** 見出し・段落・リスト・引用が続く、批評の結果らしい Markdown */
function critique(chars: number, salt = ''): string {
  const out: string[] = []
  let n = 0
  for (let i = 1; n < chars; i++) {
    const block = [
      `## ${i}. 第${i}章について${salt}`,
      '',
      `主人公の葛藤が${'丁寧に描かれていますが、場面の切り替えがやや急です。'.repeat(3)}`,
      '',
      '- **良い点**: 人物の動機がはっきりしている',
      '- **直す点**: 説明の台詞が続く',
      '',
      '> 「窓の外を見た」から始まる段落は、視点が揺れています。',
      '',
    ].join('\n')
    out.push(block)
    n += block.length + 1
  }
  return out.join('\n')
}

describe('長い Markdown の頭（閉じている時の表示）', () => {
  it('短い文はそのまま全体', () => {
    const text = critique(2_000)
    expect(markdownHead(text)).toEqual({ text, cut: false })
  })

  it('25万字の結果は、最初の 3,000〜6,000 字ほどを見出しか段落の切れ目で切る', () => {
    const text = critique(250_000)
    const head = markdownHead(text)
    expect(head.cut).toBe(true)
    expect(head.text.length).toBeGreaterThanOrEqual(HEAD_CHARS)
    expect(head.text.length).toBeLessThanOrEqual(HEAD_CHARS * 2)
    expect(text.startsWith(head.text)).toBe(true)
    // 切れ目は、次の行が見出しか、空行の後の行
    const next = text.slice(head.text.length)
    expect(next.startsWith('## ') || head.text.endsWith('\n\n')).toBe(true)
    // 同じ文は覚えておいた頭を返す
    expect(markdownHead(text)).toBe(head)
  })

  it('全文の表示の最初の部分は、頭と同じ', () => {
    const text = critique(60_000)
    expect(markdownSections(text)[0]).toBe(markdownHead(text).text)
  })

  it('切れ目の無い1行だけの長い文も、行の途中で切る（絵文字の間では切らない）', () => {
    const text = '😀'.repeat(10_000)
    const head = markdownHead(text)
    expect(head.cut).toBe(true)
    expect(head.text.length).toBeLessThanOrEqual(HEAD_CHARS * 2)
    expect(head.text.length % 2).toBe(0)
    expect(Array.from(head.text).every((c) => c === '😀')).toBe(true)
  })

  it('長い1行の前の短い行だけで頭を終えない', () => {
    const text = `## 総評\n${'あ'.repeat(20_000)}`
    const head = markdownHead(text)
    expect(head.cut).toBe(true)
    expect(head.text.length).toBe(HEAD_CHARS * 2)
  })

  it('コードブロックの中では段落の切れ目でも切らず、長すぎて切る時は閉じて開き直す', () => {
    const code = Array.from({ length: 2_000 }, (_, i) => `line ${i}\n`).join('\n')
    const text = `前置き\n\n~~~text\n${code}~~~\n\n後ろの段落`
    const sections = markdownSections(text)
    expect(sections.length).toBeGreaterThan(1)
    for (const s of sections) {
      const opens = (s.match(/^~~~/gm) ?? []).length
      expect(opens % 2).toBe(0)
    }
    // 開き直した部分も、コードブロックとして変換される
    expect(renderMarkdown(sections[1])).toContain('<pre><code class="language-text">')
    expect(sections.join('')).toContain('後ろの段落')
  })

  it('リストの続きの段落（字下げした行）では切らない', () => {
    const items = Array.from({ length: 400 }, (_, i) => `- 項目${i}\n\n  続きの段落${'。'.repeat(20)}\n`).join('\n')
    const sections = markdownSections(items)
    expect(sections.length).toBeGreaterThan(1)
    for (const s of sections.slice(1)) expect(s.startsWith('- ')).toBe(true)
  })

  it('参照形式のリンクの定義は、分けたどの部分からも使える', () => {
    const text = `[公式][site] を見てください。\n\n${critique(40_000)}\n\n[site]: https://example.com/a\n`
    const head = markdownHead(text)
    expect(head.cut).toBe(true)
    expect(renderMarkdown(head.text)).toContain('href="https://example.com/a"')
    const sections = markdownSections(text)
    expect(sections.length).toBeGreaterThan(1)
    expect(renderMarkdown(sections[0])).toContain('href="https://example.com/a"')
  })
})

describe('長い Markdown の分け方（全文の表示）', () => {
  it('25万字の結果を、16,000〜32,000 字ほどの部分に分け、つなぐと元の文（と同じ表示）になる', () => {
    const text = critique(250_000)
    const sections = markdownSections(text)
    expect(sections.length).toBeGreaterThanOrEqual(8)
    expect(sections.length).toBeLessThanOrEqual(Math.ceil(250_000 / SECTION_CHARS) + 1)
    expect(sections.join('')).toBe(text)
    for (const s of sections.slice(1, -1)) {
      expect(s.length).toBeGreaterThanOrEqual(SECTION_CHARS)
      expect(s.length).toBeLessThanOrEqual(SECTION_CHARS * 2)
    }
    // 分けて変換しても、見出しの数は同じ
    const count = (html: string) => (html.match(/<h2>/g) ?? []).length
    expect(sections.reduce((n, s) => n + count(renderMarkdown(s)), 0)).toBe(count(renderMarkdown(text)))
  })

  it('100万字でも、すぐに分けられる（同じ文は覚えておく）', () => {
    const text = critique(1_000_000, '（長）')
    const t0 = performance.now()
    const sections = markdownSections(text)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(sections.length).toBeGreaterThan(30)
    expect(markdownSections(text)).toBe(sections)
  })
})

describe('覚えておく文字数の上限', () => {
  it('上限を超えたら、長く使っていないものから忘れる', () => {
    const c = new SizedCache<number>(10)
    c.set('a', 1, 4)
    c.set('b', 2, 4)
    expect(c.get('a')).toBe(1)
    c.set('c', 3, 4)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(1)
    expect(c.get('c')).toBe(3)
    c.set('huge', 4, 11)
    expect(c.get('huge')).toBeUndefined()
  })
})

describe('変換した HTML を覚えておく', () => {
  it('同じ文は変換し直さない', () => {
    const text = critique(20_000, '（覚える）')
    const a = renderMarkdown(text)
    expect(renderMarkdown(text)).toBe(a)
  })
})
