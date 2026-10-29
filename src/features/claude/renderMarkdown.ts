// 批評の結果・戦略メモの Markdown を HTML にする（markdown-it）。Claude が書いた文なので、そのまま信用しない:
// - 生の HTML は使わない（html: false。<script> などは文字として出る）
// - リンクは https:// だけ（javascript: などは文字のまま）。新しいタブで開き、rel="noopener noreferrer" を付ける
// - 画像は読み込まない（外のサーバーに見たことが伝わらないように）。「［画像］説明」のリンクにする
// - URL のような文字を勝手にリンクにしない（linkify: false）
// 変換した HTML は覚えておく（タブを開き直すたびに変換し直さない。長い文は markdownParts.ts で分けてから渡す）。
import MarkdownIt, { type MarkdownIt as Renderer } from 'markdown-it'
import { SizedCache } from './markdownParts'

const SAFE_LINK = /^https:\/\/[^\s]+$/i

function create(): Renderer {
  const md = new MarkdownIt('default', { html: false, linkify: false, breaks: true, typographer: false })
  md.validateLink = (url: string) => SAFE_LINK.test(url.trim())
  const esc = md.utils.escapeHtml
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const t = tokens[idx]
    t.attrSet('target', '_blank')
    t.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, idx, options)
  }
  md.renderer.rules.image = (tokens, idx) => {
    const t = tokens[idx]
    const src = String(t.attrGet('src') ?? '')
    const alt = t.content.trim() || src
    return `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer" class="md-image-link">［画像］${esc(alt)}</a>`
  }
  return md
}

let instance: Renderer | null = null

/** 変換した HTML（Markdown と HTML の文字数の合計で、400万字まで） */
const rendered = new SizedCache<string>(4_000_000)

/** Markdown を、画面に出せる HTML にする */
export function renderMarkdown(text: string): string {
  const hit = rendered.get(text)
  if (hit !== undefined) return hit
  instance ??= create()
  const html = instance.render(text)
  rendered.set(text, html, text.length + html.length)
  return html
}
