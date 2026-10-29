# Novel Studio コネクタ（Claude 用のリモート MCP サーバー）

Cloudflare Worker（無料プラン）で動く、Novel Studio 専用のコネクタです。準備・使い方・止め方・つながらない時は
[../docs/CONNECTOR.md](../docs/CONNECTOR.md) を見てください（Windows でも Mac でも同じ手順）。

- 準備（初めての時に1回）: リポジトリの直下で `npm run connector:setup`
- 公開（更新）: リポジトリの直下で `npm run deploy`（アプリ・アクセスルールと一緒に）
- 確かめ: `npm run connector:check`
- テスト: `npm run test:connector`（単体・workerd・公開する形）、`npm run test:connector:emu`（Firebase エミュレーター）

部品の版は決めてあります（`package.json`。公開から2週間以上たった版）。`npm --prefix connector ci` で入れてください。

| フォルダ | 中身 |
| --- | --- |
| `src/index.ts` | OAuth（`@cloudflare/workers-oauth-provider`）の設定・毎日の片付け |
| `src/auth/` | 受け付けるクライアント・同意の画面・連携の確かめ（`/authorize`・`/pair/callback`・`/connect/identity`） |
| `src/mcp/` | MCP のサーバー（`@modelcontextprotocol/server`。状態を持たない）・ツールの一覧・入力の形（`schemas.ts` → `schemas.gen.ts`）・サーバーの説明 |
| `src/vault/` | Vault（Durable Object）: 匿名の身元・持ち主の記録の写し（差分の読み取り）・作るだけの書き込み・数の上限・ツールの結果 |
| `scripts/` | 準備・公開・確かめ・テスト・JSON Schema の作り直し・公開する形の確かめ（Node だけ。シェルを使わない） |
| `test/unit` | 単体テスト（Node。Firebase は `test/support/fakeFirebase.ts`） |
| `test/worker` | Workers の実行環境（`@cloudflare/vitest-pool-workers`）でのテスト |
| `test/emu` | Firebase エミュレーターでの結合テスト（本番のアクセスルール・アプリの端末と一緒に） |
