// 同意の画面（GET /authorize）。claude.ai で「接続」を押した直後にだけ出る。
// クライアントの名前・確かめた公開元・戻り先は、クライアントが決めた文字なので必ずエスケープする。
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { escapeHtml, page } from '../http'

export function consentPage(details: ConsentDescription, handle: string, appOrigin: string, headers: Headers): Response {
  const name = escapeHtml(details.clientName || 'Claude')
  const domain = details.clientDomain
    ? `公開元（確かめ済み）: <strong>${escapeHtml(details.clientDomain)}</strong>`
    : '<span class="warn">公開元を確かめられないクライアントです（自分で登録したもの）。</span>'
  const app = escapeHtml(new URL(appOrigin).host)
  const body = `
<h1>Novel Studio コネクタ</h1>
<div class="card">
  <p><strong>${name}</strong>（claude.ai）が Novel Studio への接続を求めています。</p>
  <p class="muted">${domain}<br>許可した後の戻り先: <strong>${escapeHtml(details.redirectHost)}</strong></p>
  ${details.redirectIsLoopback ? '<p class="warn">この接続はこのパソコンのアプリ（Claude Code など）に渡されます。いま自分で接続を始めた時だけ続けてください。</p>' : ''}
</div>
<div class="card">
  <p>次の画面（Novel Studio: ${app}）で、Claude に見せるタイトルを選んで許可します。</p>
  <ul>
    <li>Claude ができること: 見せたタイトルの採用原稿と採用していない稿を含むすべての稿・設定・メモ・アイデア・戦略・作品批評を読む、推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果を<strong>足す</strong></li>
    <li>Claude ができないこと: 本文（稿）の書き換え・削除、ほかのタイトルを見ること</li>
  </ul>
  <p class="warn">この画面は claude.ai で「接続」を押した直後にだけ出ます。心当たりがなければ［やめる］を押してください。</p>
</div>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="buttons">
    <button class="primary" type="submit" name="decision" value="approve" data-testid="consent-approve">Novel Studio で確認する</button>
    <button type="submit" name="decision" value="deny" data-testid="consent-deny">やめる</button>
  </div>
</form>`
  // ［Novel Studio で確認する］はアプリへ、［やめる］は claude.ai へ転送される
  return page('Novel Studio への接続', body, {}, headers, [new URL(appOrigin).origin, 'https://claude.ai', 'https://claude.com'])
}
