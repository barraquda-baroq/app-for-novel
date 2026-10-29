// 受け付けるクライアント（GET /authorize で、同意の画面を作る前＝KV に書く前に確かめる）。
// - claude.ai の公開の識別子（CIMD: client_id が https://claude.ai/… の URL）だけ。Claude Code は ALLOW_CLAUDE_CODE の時だけ
// - 戻り先は claude.ai / claude.com の決まった URL だけ（Claude Code はローカルの /callback）
// - DCR（ENABLE_DCR）で登録したクライアントも、戻り先が同じ決まりに合う時だけ
import type { WorkerConfig } from '../env'

export const CLAUDE_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']
export const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata'

const isLoopbackCallback = (uri: string) => {
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/callback'
  } catch {
    return false
  }
}

export type PolicyResult = { ok: true } | { ok: false; reason: string; message: string }

const refuse = (reason: string, message: string): PolicyResult => ({ ok: false, reason, message })

/** 戻り先が受け付けるものか（Claude Code はローカルの /callback も） */
export function allowedRedirect(uri: string, claudeCode: boolean): boolean {
  return CLAUDE_REDIRECTS.includes(uri) || (claudeCode && isLoopbackCallback(uri))
}

export function checkClient(req: { clientId: string; redirectUri: string }, cfg: WorkerConfig): PolicyResult {
  let host = ''
  let isCimd = false
  try {
    const u = new URL(req.clientId)
    isCimd = u.protocol === 'https:'
    host = u.host
  } catch {
    isCimd = false
  }
  const claudeCode = req.clientId === CLAUDE_CODE_CIMD
  if (isCimd) {
    if (host !== 'claude.ai') return refuse('client_host', 'このコネクタは claude.ai からの接続だけを受け付けます。')
    if (claudeCode && !cfg.allowClaudeCode)
      return refuse('claude_code', 'Claude Code からの接続は受け付けていません（wrangler.jsonc の ALLOW_CLAUDE_CODE）。')
  } else if (!cfg.enableDcr) {
    return refuse('client_dcr', 'このコネクタは claude.ai の「Claudeの公開されたアイデンティティを使用（推奨）」での接続だけを受け付けます。')
  }
  // ローカルの /callback は Claude Code（公開の識別子か、DCR で登録したもの）だけ
  const loopbackOk = cfg.allowClaudeCode && (claudeCode || !isCimd)
  if (!allowedRedirect(req.redirectUri, loopbackOk))
    return refuse('redirect', '戻り先が claude.ai ではありません。この接続は受け付けません。')
  return { ok: true }
}

/** DCR の登録（ENABLE_DCR の時だけ）: 戻り先がすべて決まりに合う時だけ受け付ける */
export function checkRegistration(metadata: Record<string, unknown>, cfg: WorkerConfig): PolicyResult {
  const uris = metadata.redirect_uris
  if (!Array.isArray(uris) || !uris.length) return refuse('redirect', 'redirect_uris がありません')
  for (const u of uris) if (typeof u !== 'string' || !allowedRedirect(u, cfg.allowClaudeCode)) return refuse('redirect', '戻り先が claude.ai ではありません')
  return { ok: true }
}
