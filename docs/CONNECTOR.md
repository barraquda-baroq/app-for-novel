# Claude 用コネクタ（Novel Studio 2.3）

Claude（claude.ai・Claude のデスクトップアプリ・iPhone / Android の Claude アプリ）から Novel Studio の原稿を読み、
推敲案・改稿案・戦略メモ・作品批評をアプリに足してもらうための仕組みです（リモート MCP サーバー）。
Cloudflare の無料プラン（Workers Free）に、あなた専用のコネクタを1つ置きます。

- Claude ができること: 「Claude に見せる」にしたタイトルの採用原稿・目次・設定・メモ・アイデア・戦略・作品批評を読む／本文を検索する／
  推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果を**足す**
- Claude ができないこと: 本文（稿）・全体戦略・応募計画の書き換え、何かの削除、見せていないタイトルを見ること、
  ゴミ箱・応募時の原稿の控えを見ること、端末で保存していない・まだ送っていない編集を見ること
- 足された記録は、アプリの 戦略（推敲案・改稿案・戦略メモ）と 作品批評 に、各端末が同期すると出ます。そこから先はふつうの記録として
  チェック・編集・削除できます（全体戦略に足す・応募計画にする、はアプリのボタンで行います）
- コネクタを使わない時も、アプリの「Claude に頼む（手動）」でプロンプトと本文をコピーし、結果を貼り付けて同じことができます

## 仕組み

```
claude.ai（Anthropic のクラウドから）
   │  MCP（https://novel-studio-connector.<サブドメイン>.workers.dev/mcp）・OAuth のトークン
   ▼
Cloudflare Worker「novel-studio-connector」（あなたのアカウント・無料プラン）
   ├ OAuth（claude.ai の公開の識別子だけを受け付ける。接続のたびに同意の画面）
   ├ MCP のツール（読む 10・足す 5）
   └ Vault（Durable Object）: コネクタ自身の匿名の Firebase アカウント（更新用トークンは暗号化）、持ち主の記録の写し、数の記録
   ▼  匿名のアカウントの ID トークン
Firebase（novel-studio-3352e）: アクセスルールで「読む＋Claude の6つの表に作るだけ」に絞られる
   ▲
Novel Studio（アプリ）: 連携の画面で、持ち主が許可する（config/connector）
```

- コネクタはあなたの Google アカウントのトークンを持ちません。持っているのは、アプリで許可した**匿名のアカウント**だけで、
  そのアカウントにできることはアクセスルール（`firestore.rules`）で「持ち主の記録を読む」「Claude の6つの表に新しく作る」に限られます
  （書き換え・削除・原稿の表への書き込み・バックアップからの復元の印は、ルールで拒まれます）。
- 連携の許可は、claude.ai で「接続」を始めたブラウザと、あなたが Novel Studio にログインしているブラウザの両方がそろわないと完成しません
  （だれかが自分の接続のリンクをあなたに開かせても、連携はできません）。
- アプリの 設定 → Claude 連携 の［連携を解除］で、その場で読めなくなります。

---

## 1. 一度だけの準備

Windows（PowerShell）でも Mac（ターミナル）でも、手順とコマンドは同じです（コマンドは1行ずつ入力して Enter）。
iOS / Android のアプリを作る 2.4 だけは Mac が要りますが、コネクタの準備には要りません。

### 1-A. あなたが手で行うこと

1. **Node.js 22 以上を入れる**
   - Windows: <https://nodejs.org/ja> から LTS 版のインストーラーを入れる。スタートメニューで「PowerShell」を開き、`node -v` が `v22` 以上なら OK。
     初めての時だけ `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行し、確かめられたら `Y` を入力して Enter（npm のコマンドを動かせるようにする設定。
     管理者でなくてよい。docs/DEPLOY.md の手順 1 と同じ）。終わったら PowerShell を閉じて開き直す
   - Mac: 同じページから LTS 版を入れる。「ターミナル」で `node -v` が `v22` 以上なら OK
2. **Cloudflare に登録する（無料・カード不要）**
   1. <https://dash.cloudflare.com/sign-up/workers-and-pages> で登録し、届いたメールの確認リンクを押す
   2. 右上の人のアイコン →「My Profile」→「Authentication」で **2段階認証を有効にする**（原稿を読む仕組みを置く場所なので必須）
   3. 左のメニューの「Workers & Pages」を開き、workers.dev のサブドメイン（例: `baroq`）を決める
      （コネクタの URL が `https://novel-studio-connector.baroq.workers.dev` になります）
3. **Firebase で匿名ログインを有効にする**
   1. [Firebase コンソール](https://console.firebase.google.com/project/novel-studio-3352e/authentication/providers) → novel-studio-3352e →
      「Authentication」→「ログイン方法」→「新しいプロバイダを追加」→「匿名」→ 有効にして「保存」
   2. コネクタ専用の身元に使います。何ができるかはアクセスルールで「読む＋Claude の記録を足す」だけに絞られています。
      「匿名のアカウントを自動で削除する」設定（Identity Platform の自動クリーンアップ）は有効にしないでください（連携が切れます）
4. **リポジトリを最新にして、部品を入れる**（PowerShell・ターミナルで1行ずつ）

   ```
   cd app-for-novel
   git pull
   npm ci
   npm --prefix connector ci
   ```

   Firebase にまだログインしていなければ `npx firebase login` も（docs/DEPLOY.md の手順 1）。
5. **準備のスクリプトを動かす**

   ```
   npm run connector:setup
   ```

   Cloudflare にログインしていなければブラウザが開くので、ログインして「Allow」を押します。最後に
   `claude.ai に登録する URL: https://novel-studio-connector.<サブドメイン>.workers.dev/mcp` と出れば完了です（この URL は秘密ではありません）。
   「匿名ログインが無効です」と出たら、手順 3 をやり直して、もう一度 `npm run connector:setup` を実行します。
6. **すべての端末のアプリを 2.3 にする**: Windows（Edge のアプリ）・iPhone・Android で「新しいバージョンのアプリがあります」→［更新する］を押し、
   設定 → 同期 が「同期済み」になるまで待つ（2.3 では初回だけ全件を受け取り直します）。
   古い版のアプリで「バックアップから復元」「すべて削除」をすると、Claude の記録が消えるので、先にすべての端末を更新してください。
7. **claude.ai にコネクタを登録する**（パソコンのブラウザで。スマホのアプリからは登録できません）
   1. claude.ai →「カスタマイズ」→「コネクタ」→「+ 追加」→「カスタムコネクタを追加」
   2. 名前 `Novel Studio`、URL は手順 5 の `…/mcp`（アプリの 設定 → Claude 連携 からもコピーできます）→「続行」
   3. 認証:「今すぐサインイン」
   4. OAuth クライアント:「Claudeの公開されたアイデンティティを使用（推奨）」
   5. リクエストヘッダー: 空のまま →「追加」
8. **Novel Studio で許可する**
   1. 開いた「Novel Studio コネクタ」の画面で［Novel Studio で確認する］を押す
   2. Novel Studio の画面が開く（ログインしていなければ Google でログイン。そのブラウザもふつうの同期する端末になります）
   3. Claude に見せるタイトルを選び（「見せない／読むだけ／読む＋書き込む」）、「推敲案などの書き込みも許可」を確かめて［許可する］
   4. claude.ai に戻り、「接続済み」になれば完了
9. **ツールの許可を決める**: 「カスタマイズ → コネクタ → Novel Studio」のツールの権限で、読む系（〜を見る・〜を読む・検索）は「常に許可」、
   足す系（推敲案を追加 など）は最初は「承認が必要」がおすすめです。足す系は本文を書き換えないので、慣れたら「常に許可」でも構いません。
   リサーチモードでは確認なしにツールが呼ばれるので、そのチャットではコネクタをオフにしてください（権限の表示名は画面と少し違うことがあります）。
10. **iPhone・Android の Claude アプリ**: 同じアカウントならそのまま使えます。チャットの「＋」→「コネクタ」で Novel Studio をオンにします。

### 1-B. `npm run connector:setup` が自動で行うこと

1. Cloudflare にログインしているかを確かめる（していなければ `wrangler login` でブラウザを開く）
2. コネクタを公開する（`wrangler deploy`。OAuth 用の KV と Vault の Durable Object も自動で作られる）
3. 公開した URL を `connector.local.json`（リポジトリの直下。Git には入らない）に書き、URL を渡して公開し直す
4. 鍵 `TOKEN_ENC_KEY`（32バイトの乱数）を作り、**画面に出さずに** `wrangler secret put` に渡す（もう設定されていれば、そのまま使う）
5. コネクタを確かめる（`npm run connector:check` と同じ。Firebase の匿名ログインが無効ならここで止まって直し方を出す）
6. アプリとアクセスルールを公開する（`npm run deploy` と同じ。コネクタの URL がアプリに入る）
7. claude.ai に登録する URL を出す

どの手順でも、秘密（鍵・トークン）を入力・コピーすることはありません。

---

## 2. 試す

claude.ai のチャットで（Novel Studio のコネクタをオンにして）:

- 「Novel Studio のタイトル一覧を見せて」
- 「『星の庭』の目次と文字数を見せて」
- 「第1話を読んで、ら抜き・誤字脱字・既成表現の推敲案を追加して」→ アプリの 戦略 → 推敲案 に数秒〜数十秒で出ます
- 「全体を通して、構成と人物の批評をして、作品批評に記録して」
- 「この作品で狙えるコンテストを3つ挙げて、戦略メモに追加して」→ 戦略 → 戦略メモ の［応募計画にする］で応募計画に

大きなタイトル（数十万字）は、Claude が 2万字ずつ（多い時は6万字ずつ）読み進めます。推敲は範囲を区切って何回かに分けると確実です
（推敲案の一覧に「未確認 #41〜#300」のように残りの範囲が出ます）。

---

## 3. 更新する時

```
git pull
npm ci
npm --prefix connector ci
npm run deploy
```

`npm run deploy` は、アプリ・アクセスルール・コネクタをまとめて公開します（`connector.local.json` がある時だけコネクタも）。

---

## 4. やめる時・止める時

| したいこと | 方法 |
| --- | --- |
| すぐに止める | アプリの 設定 → Claude 連携 →［連携を解除］（その場でコネクタは何も読めなくなる。もう一度使う時は claude.ai で接続し直す） |
| 書き込みだけ止める | 同じ画面の「書き込みを許可」をオフ（読むのは続く。アクセスルールで止まる） |
| あるタイトルだけ見せない | タイトル画面の「Claude に見せる」のチップで「見せない」を選ぶ |
| claude.ai から外す | 「カスタマイズ → コネクタ → Novel Studio」でコネクタを削除 |
| コネクタそのものを消す | `npx --prefix connector wrangler delete --name novel-studio-connector`（Cloudflare から消える。鍵を消すだけなら `npx --prefix connector wrangler secret delete TOKEN_ENC_KEY --name novel-studio-connector`）。リポジトリの直下で実行する |

完全にやめる時は、アプリで［連携を解除］してから claude.ai でコネクタを削除し、必要なら Cloudflare からも消してください。

---

## 5. つながらない時

| 出ること | 直し方 |
| --- | --- |
| `npm run connector:setup` で「匿名ログインが無効です」 | 1-A の手順 3 をやり直して、もう一度 `npm run connector:setup` |
| `npm run connector:setup` で「公開できなかったか、URL が分かりませんでした」 | Cloudflare の「Workers & Pages」で workers.dev のサブドメインを決めたか確かめる。`npx --prefix connector wrangler whoami` でログインを確かめる |
| 「コネクタの部品が入っていません」 | `npm --prefix connector ci` |
| `npm` で「スクリプトの実行が無効になっているため…npm.ps1 を読み込むことができません」（Windows） | PowerShell で `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行して `Y`、PowerShell を開き直す（`npm.cmd`・`npx.cmd` と打っても動く） |
| claude.ai で「Authorization with the MCP server failed」など | `npm run connector:check` を実行して ✗ の行を直す。エラーの画面の `ofid_…` を控えておく |
| それでもつながらない | 最後の手段: `connector/wrangler.jsonc` の `ENABLE_DCR` を `"true"` にして `npm run deploy`。claude.ai でコネクタを削除し、OAuth クライアントを「自動的に登録」にして追加し直す（認証の設定は後から変えられないため）。その後の `npm run connector:check`・`npm run connector:setup` は、wrangler.jsonc に合わせて DCR が有効なことを確かめる |
| Novel Studio の画面で「このアカウントは Novel Studio の持ち主ではありません」 | 最初に同期を始めた Google アカウントでログインし直す |
| 「連携の確かめの期限が切れたか、別のブラウザで開かれました」 | claude.ai で接続を始めたのと同じブラウザで、もう一度「接続」から（iPhone では、パソコンで接続するのがおすすめ） |
| Claude が「初回の取り込み中（1,200/4,800件）」と言う | 連携した直後に、コネクタが原稿の写しを作っています。1〜数分待ってからもう一度 |
| 「書き込みは停止中です」 | アプリの 設定 → Claude 連携 で「書き込みを許可」をオン |
| 「アプリの版が古いままです」「コネクタを更新してください」（データの形） | すべての端末のアプリを更新して同期する／`npm run deploy` でコネクタを更新する（読むのは続けられる） |
| 「Novel Studio 側で連携が解除されています」・claude.ai が接続し直しを求める | アプリで連携が解除されたか、コネクタの身元が使えなくなった。claude.ai でコネクタに接続し直し、アプリでもう一度許可する |
| 「今日のコネクタ用の読み取り枠を使い切りました」 | アプリの同期の分を残すための上限（1日 15,000 回）。日本時間16時（11/1〜3月は17時）に戻る |
| 「Firebase の今日の無料枠を使い切りました」 | アプリの同期も止まっている。同じ時刻に戻る |
| Cloudflare の Workers Logs に「Exceeded CPU」が続く | 無料プランの CPU の上限（10ms）を超えている。Workers Paid（月 5 USD）に切り替える（コードの変更は要らない）。切り替えたら `connector/wrangler.jsonc` の `limits` と `WORK_BUDGET_CHARS` を上げてもよい |

ログ（Cloudflare の「Workers & Pages → novel-studio-connector → Logs」）には、原稿・トークン・URL の問い合わせ部分は出しません。

---

## 6. 無料枠の目安

| 項目 | 無料枠 | コネクタの使い方 |
| --- | --- | --- |
| Cloudflare Workers のリクエスト | 1日 10万回 | 1回のツールの呼び出しで数回 |
| Cloudflare KV の書き込み | 1日 1,000回 | 接続（認可）とトークンの更新のたびに数回 |
| Firestore の読み取り（アプリと共通） | 1日 5万回 | 連携した直後に全件を1回（記録の数だけ）。その後はツールの呼び出しごとに変わった分だけ（最低3回）。コネクタは1日 15,000 回までで止まる |
| Firestore の書き込み（アプリと共通） | 1日 2万回 | 足した記録の数だけ（推敲案 100件で 101回）。コネクタは1日 5,000 回までで止まる |

コネクタが書いた記録は、オンラインの各端末が1回ずつ読みます。

---

## 7. 安全のための決まり（要点）

- 受け付けるのは claude.ai の公開の識別子（`https://claude.ai/oauth/mcp-oauth-client-metadata`）と、claude.ai / claude.com の決まった戻り先だけ。
  接続の要求は1時間20回・1日60回まで（いたずらで OAuth の KV の書き込み枠を使い切られないように）
- 同意は覚えない（接続のたびに確かめる）。トークンは1時間、更新用トークンは180日使わなければ切れる
- 連携の許可: アプリが `config/connector` に `pairing = sha256(s + "." + k)`（`s` は claude.ai から始めた接続の印、`k` はアプリの中で作った乱数）を書き、
  コネクタは「claude.ai から始めたブラウザの cookie」と「アプリが渡した k」の両方がそろい、15分以内で、まだ使っていない時だけ完成させる
- OAuth の許可は、その時の連携（持ち主と、`config/connector` を作った時刻 = 連携の代）に結び付ける。［連携を解除］すると、その後に連携し直しても
  （別の Claude のアカウント・別の戻り先からでも）前の許可は使えない（ツールは 401、トークンの更新は断られる）。解除しないで別の Claude を足す・
  「書き込みを許可」を切り替えるだけなら、前の許可も使える。連携の記録は読むツールの前にも1分ごとに確かめる
- 受け付けない `client_id`（公開の識別子の URL）は、取りに行く前に断る（`/authorize`・`/oauth/token`）
- コネクタの URL はアプリに組み込む（`connector.local.json` からビルドの時に）。リンクの中の URL やコネクタの身元は信用しない
- コネクタの書き込みは「無い時だけ作る」（内容から作った id）。同じ結果を2回送っても1つ、アプリで削除した推敲案は「以前に削除」で戻ってこない
  （ゴミ箱から消えて30日たった後は、削除の印をもとに判断する）
- Cloudflare のアカウントを乗っ取られると、原稿を読まれる・不要な記録を足される恐れがあります（書き換え・削除・アカウントの乗っ取りはできません）。
  Cloudflare の2段階認証は必ず有効にしてください。止める時はアプリの［連携を解除］がいちばん早い

---

## 8. 手で確かめる（受け入れの確認リスト）

公開した後、または大きく変えた後に:

- [ ] `npm run connector:check` がすべて ✓
  （MCP Inspector などほかのクライアントは、受け付けの決まり（§7: claude.ai の公開の識別子と決まった戻り先だけ）で断られます。確かめには使えません）
- [ ] claude.ai（ブラウザ）: 接続できる（Novel Studio の同意の画面 → アプリの連携の画面を通る）。コネクタの設定に 15 のツールが日本語の題で並ぶ。
      読むツールをすべて1回ずつ（タイトル一覧・目次・採用原稿・稿の一覧・検索・設定/メモ/アイデア・戦略・作品批評・推敲案の一覧・状態）
- [ ] claude.ai: 足すツールを1回ずつ（推敲案・改稿案・戦略メモ・批評プロンプト・批評の結果）。承認の画面にツールの日本語の題が出る。アプリに出る
- [ ] Claude のデスクトップアプリ・iPhone・Android の Claude アプリで、コネクタをオンにして読む・足すが動く
- [ ] 同じ推敲案をもう一度足すように頼むと「重複」になる。アプリで削除した推敲案は「以前に削除」になる
- [ ] タイトルを「見せない」にすると、タイトル一覧から消える
- [ ] アプリで［連携を解除］→ 次のツールの呼び出しで claude.ai が接続し直しを求める
- [ ] Cloudflare の Workers Logs で、最初の取り込みの1歩・目次・6万字の読み取り・いちばん大きなタイトルの検索の CPU 時間を見る（「Exceeded CPU」が無いこと）
- [ ] しばらく（数分）ツールを呼ばずに待ってから（Durable Object が作り直される）、タイトル一覧と目次の CPU 時間も見る（写しを SQLite から作り直す。稿の本文は読まないが、原稿の多いアカウントでは 10ms を超えることがある。続くなら Workers Paid へ）
- [ ] Firebase コンソールの「使用量」で、読み取り・書き込みが目安どおり

---

## 9. 開発者向け

```
npm run test:connector        # 単体テスト・Workers の実行環境（workerd）のテスト・公開する形の確かめ
npm run test:connector:emu    # Firebase エミュレーターでの結合テスト（本番のアクセスルール・アプリの端末と一緒に。Java が必要）
npm run test:e2e:sync         # ブラウザでの同期の E2E。e2e/pairing.sync.spec.ts は本物のコネクタ・アプリの画面・エミュレーターで連携を通しで確かめる
npm --prefix connector run typecheck
npm --prefix connector run gen-schemas    # ツールの入力の形（src/mcp/schemas.ts）を変えた時
npm --prefix connector run bundle-check   # dexie・firebase・react・zustand が入っていないか
```

- `connector/src/index.ts`: OAuth の設定（`@cloudflare/workers-oauth-provider`）・毎日の片付け
- `connector/src/auth/`: 受け付けるクライアント・同意の画面・連携の確かめ（`/authorize`・`/pair/callback`・`/connect/identity`）
- `connector/src/mcp/`: MCP のサーバー（`@modelcontextprotocol/server`。状態を持たない）・ツールの一覧・入力の形・サーバーの説明
- `connector/src/vault/`: Vault（Durable Object）の中身（身元・写し・書き込み・数の上限・ツールの結果の文字の形）
- アプリの純粋な部品（`src/domain`・`src/claude`・`src/sync/codec.ts`・`merge.ts`）をそのまままとめて使う（文字数・話数・id・推敲案の場所がアプリと同じ）
- アプリとの連携の決まり（連携の画面の URL・`/connect/identity` の答え・k・指紋 `sha256hex(s + '.' + k)`・`/pair/callback` の引数・15分）は
  `src/claude/pairing.ts` にあり、アプリの連携の画面（`src/features/claude/connectLogic.ts`）とコネクタ（`connector/src/auth/routes.ts`・
  `connector/src/vault/core.ts`）が同じものを使う。決まりの値は `src/test/pairingFixture.ts`（両方のテストで使う）
- `e2e/pairing.sync.spec.ts`: wrangler の `createTestHarness` でこの Worker をテストの中に立ち上げ（workerd。Durable Object・KV も本物）、
  ブラウザのアプリ（開発サーバー）からコネクタへの通信をそこへ渡して、接続 → 同意 → アプリで許可 → トークン → ツール → 書き込みの停止 →
  連携の解除 を確かめる。claude.ai の代わりはテストが務める（クライアントは DCR で登録。CIMD は workerd のテストで確かめる）。
  コネクタの部品が無ければ飛ばす
- 手元で動かす: `npx firebase emulators:start --config firebase.emu.json --only auth,firestore --project demo-novel-studio` を動かしたまま、
  `connector/.dev.vars` に `FIREBASE_EMULATOR_HOST=127.0.0.1`・`FIREBASE_PROJECT_ID=demo-novel-studio`・`FIREBASE_API_KEY=fake-api-key`・
  `TOKEN_ENC_KEY=（16字以上の適当な文字）`・`APP_ORIGIN=http://localhost:5173`・`ALLOW_LOCALHOST_APP=true` を書いて `npm --prefix connector run dev`
  （`.dev.vars` は Git に入りません。手元の Vault・KV の中身は `connector/.wrangler/` に残り、消すと最初からになります）
  動いていれば `http://localhost:8787/` に「未連携」と出て、`/connect/identity` がエミュレーターの匿名の身元を返します
- アプリもこの手元のコネクタにつなぐ時は、もう1つの画面で開発サーバーを動かします（`connector.local.json` があれば、そちらが優先されます）
  - Mac（ターミナル）: `VITE_FIREBASE_EMULATOR=127.0.0.1 VITE_CONNECTOR_ORIGIN=http://localhost:8787 npm run dev`
  - Windows（PowerShell）: `$env:VITE_FIREBASE_EMULATOR="127.0.0.1"; $env:VITE_CONNECTOR_ORIGIN="http://localhost:8787"; npm run dev`
    （`$env:` は PowerShell の画面を閉じるまで残ります。開発サーバー用の画面で動かし、終わったら閉じてください。同じ画面で公開する時は先に
    `Remove-Item Env:VITE_FIREBASE_EMULATOR, Env:VITE_CONNECTOR_ORIGIN -ErrorAction SilentlyContinue`。`npm run deploy` はこれらを公開するアプリに入れません）
  - 設定 → Claude 連携 に `http://localhost:8787/mcp` が出ます。連携の画面（`#/claude/connect`）は claude.ai の接続から開かれるので、
    手で通して試すより `e2e/pairing.sync.spec.ts` を動かす方が確実です
