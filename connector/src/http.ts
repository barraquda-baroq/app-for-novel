// 小さな道具: HTML の画面（日本語・スマホ幅・明るい/暗い）、JSON、エスケープ。

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f4ef;--fg:#1f2430;--muted:#5d6472;--card:#fff;--line:#d9d4c7;--accent:#2f3a4f;--accent-fg:#fff;--warn:#8a4b00}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--fg:#e8e6e1;--muted:#a3a8b3;--card:#1d2027;--line:#343844;--accent:#c9d4ea;--accent-fg:#14161b;--warn:#f0b35c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,-apple-system,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.25rem;line-height:1.4;margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0;overflow-wrap:anywhere}
.muted{color:var(--muted);font-size:.9rem}
.warn{color:var(--warn)}
ul{padding-left:1.2em;margin:8px 0}
.buttons{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}
button,.button{min-height:44px;padding:10px 18px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
code{font-size:.9em}
`

/** 画面（自分の HTML。外から来た文字はすべて escapeHtml してから入れる） */
export function page(
  title: string,
  body: string,
  init: ResponseInit = {},
  headers?: Headers,
  /** フォームの送り先（送った後の転送先も含む。Chrome は転送先も確かめる） */
  formAction: string[] = [],
): Response {
  const h = headers ?? new Headers(init.headers)
  h.set('Content-Type', 'text/html; charset=utf-8')
  h.set('Cache-Control', 'no-store')
  h.set('X-Frame-Options', 'DENY')
  h.set('Referrer-Policy', 'no-referrer')
  // 枠に入れさせない（同意の画面のライブラリの決まりと同じ）。スクリプトは使わない
  h.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formAction.map((o) => ` ${o}`).join('')}; frame-ancestors 'none'; base-uri 'none'`,
  )
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  return new Response(html, { ...init, headers: h })
}

/** 失敗の画面（どこへも転送しない） */
export function errorPage(message: string, status = 400): Response {
  return page(
    'Novel Studio コネクタ',
    `<h1>Novel Studio コネクタ</h1><div class="card"><p>${escapeHtml(message)}</p></div><p class="muted">この画面は閉じてかまいません。</p>`,
    { status },
  )
}

export function json(value: unknown, init: ResponseInit = {}, headers?: Headers): Response {
  const h = headers ?? new Headers(init.headers)
  h.set('Content-Type', 'application/json; charset=utf-8')
  h.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(value), { ...init, headers: h })
}
