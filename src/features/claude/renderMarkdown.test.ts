import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown'

describe('批評の結果・戦略メモの Markdown（そのまま信用しない）', () => {
  it('ふつうの Markdown は HTML にする', () => {
    const html = renderMarkdown('## 総評\n- **良い点**\n- 直す点\n\n1行目\n2行目')
    expect(html).toContain('<h2>総評</h2>')
    expect(html).toContain('<strong>良い点</strong>')
    expect(html).toContain('1行目<br>')
  })

  it('生の HTML は文字として出す', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('リンクは https だけ。新しいタブで開き、rel="noopener noreferrer" を付ける', () => {
    const ok = renderMarkdown('[公式](https://example.com/a)')
    expect(ok).toContain('href="https://example.com/a"')
    expect(ok).toContain('target="_blank"')
    expect(ok).toContain('rel="noopener noreferrer"')
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](http://example.com)',
      '[x](data:text/html,hi)',
      '<javascript:alert(1)>',
    ]) {
      expect(renderMarkdown(bad)).not.toContain('<a ')
    }
  })

  it('URL のような文字は勝手にリンクにしない', () => {
    expect(renderMarkdown('https://example.com を見る')).not.toContain('<a ')
  })

  it('画像は読み込まず、リンクにする', () => {
    const html = renderMarkdown('![図の説明](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://example.com/a.png"')
    expect(html).toContain('［画像］図の説明')
    expect(renderMarkdown('![x](http://example.com/a.png)')).not.toContain('href=')
  })
})
