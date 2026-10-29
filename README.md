# Novel Studio — 小説執筆アプリ

アイデア・設定・話数単位の原稿と推敲バージョン・コンテスト応募戦略を、タイトルごとにまとめて管理する小説執筆アプリです。
Windows ではブラウザで動く PWA（Chrome・Edge の「アプリとしてインストール」）、iPhone・Android では同じ画面を載せた専用のアプリ（2.4。Capacitor）で使います。
データは端末内（IndexedDB）に保存され、Google アカウントでログインすると、Firebase（Cloud Firestore）を通して Windows・iPhone・Android の間でリアルタイムに同期します（2.x）。

## できること

| 機能 | 内容 |
| --- | --- |
| アイデア領域 | タイトルの数だけ最初から仕切りがあり、最後に「どのタイトルにも属さない」仕切りがある。アイデアは仕切り間で移動・並べ替えできる |
| タイトル | タイトルごとに 設定項目・本編（章／第n話／特殊ブロック）・メモ・戦略・アイデア を管理 |
| 設定項目 | キャラクター・世界観などの項目を後から自由に追加。項目ごとにフィールドのテンプレートを持てる |
| 章（大長編） | オン/オフ切り替え。章はフォルダとして話をまとめ、並べ替えできる。話数は通し番号／章ごとを選べる |
| 第n話 | 「話数追加」で必ず最新話が作られ、表記は変更不可。並べ替えると話数が書き換わる。途中の話数は削除できない（最後の話だけ削除可） |
| 特殊追加 | プロローグ・エピローグなど話数に属さないブロックを、好きな位置に後から差し込める。見出しは自由に編集できる |
| メモ | タイトル付きの付箋。タイトル画面の一番下に常に表示 |
| 推敲バージョン | 1話に何稿でも持てる。複製・クリップボードへのコピー。「採用する」で採用原稿を切り替え、採用なしにもできる |
| 比較画面 | 採用原稿の右（スマホは下）に推敲バージョンの一覧。選ぶと採用原稿と並べて比較でき、比率はスライダー／境界のドラッグで変更。差分ハイライトあり |
| 原稿の編集 | 本文・稿の名前・推敲メモ・話の題は「保存」（Ctrl/⌘+S）で確定。保存せずに離れる時は確認。巻き戻し／進む（30手）、記号バー（ダッシュ・三点リーダー・全角空白・ルビ・傍点）、見出し付きコピー |
| セパレート（幕） | 採用した話を WEB 掲載用に「第n話　題　第x幕」へ分ける（話数は増えない）。一覧の右クリック（スマホは長押し）・「…」から。カーソルを置いて Enter か「ここで区切る」で分割点を置く。幕ごとに稿・採用・比較ができ、さらに分ける・次の幕とつなぐ・セパレート解除もできる |
| 通し読み | 採用原稿だけをタイトル全体・章ごとに通して読む。採用原稿がない話は「採用原稿がありません。」と表示。縦書き表示・テキスト書き出し |
| 戦略 | 応募先コンテストを応募順に並べ、締切・規定（文字数または原稿用紙換算枚数）・状態・結果・改稿方針・再応募方針を管理。応募時点の採用原稿（どの話にどの稿を採用していたかと本文の控え）を記録し、あとから読む・書き出せる |
| 戦略メモ・改稿案・推敲案（2.3） | 戦略タブに、Claude が提案した戦略メモ（［応募計画にする］［全体戦略に追記］）、改稿案（チェックすると斜線＋グレーで下へ）、推敲案（フラグを立てたものが上・新しい順、種類つき。押すと本文のその箇所を開く。チェックで消し込み）を並べる |
| 作品批評（2.3） | タイトルの新しいタブ。批評プロンプト（このタイトルのもの・共通のもの）と、日付ごとの批評の結果（Markdown・アーティファクトの URL・メモ） |
| Claude 連携（2.3） | claude.ai に Novel Studio のコネクタ（リモート MCP）を足すと、Claude が「Claude に見せる」タイトルの採用原稿を読み、推敲案・改稿案・戦略メモ・作品批評を足せる（本文は書き換えない）。コネクタが無くても「Claude に頼む（手動）」でコピーと貼り付けで使える |
| 同期 | Google でログインすると、どの端末で書いた内容も自動で同じになる。オフラインでも書け、つながった時に送る。同時に同じ稿の本文を直していたら、片方を「（競合: ○○での編集）」の別の稿として残す |
| バックアップ | 全データを JSON で書き出し・復元。しばらく書き出していないとホームでお知らせ |

### データを失わないための仕組み

- 入力中の文字は最大 1.5 秒で反映し、2 秒以内に端末へ保存。画面を閉じる・アプリを切り替える瞬間の変更も控えておき、次回起動時に復元
- 原稿画面の保存していない編集も端末内に控え、アプリが落ちても次にその話を開いた時に復元できる
- 同じ端末の複数のタブで編集しても、相手の変更を上書きせず項目ごとに合わせて保存
- 保存できない時は画面上部で知らせ、自動で再試行
- 壊れたバックアップや参照の切れたデータは読み込み時に自動で修復
- アプリの更新は「更新する」を押した時だけ（執筆中に勝手に再読み込みしない）

詳しい仕様と設計上の決定は [docs/SPEC.md](docs/SPEC.md)（1.x）と [docs/SPEC-2.md](docs/SPEC-2.md)（2.x）を参照してください。
公開（Firebase Hosting）と同期の準備は [docs/DEPLOY.md](docs/DEPLOY.md) に、Claude 用のコネクタ（2.3。claude.ai から原稿を読み、推敲案・作品批評などを足してもらう）の準備は [docs/CONNECTOR.md](docs/CONNECTOR.md) に、iPhone・Android のアプリ（2.4）の作り方と入れ方は [docs/MOBILE.md](docs/MOBILE.md) にまとめています（Windows でも Mac でも同じ手順。iPhone のアプリだけは Mac が要ります）。

## 使い方（開発）

```bash
npm install
npm run dev        # http://localhost:5173 で起動
npm test           # 単体テスト（Vitest）
npm run test:e2e   # E2E テスト（Playwright: デスクトップ幅とスマホ幅）
npm run build      # dist/ に本番ビルド（PWA）
npm run build:native  # dist-native/ に iPhone・Android のアプリに載せる画面（サービスワーカーなし）
npm run format     # Prettier で整形

npm run test:sync      # 同期の結合テスト（Firebase エミュレーター。Java が必要）
npm run test:e2e:sync  # ブラウザ2つで同期を確かめる E2E テスト（同上。コネクタとの連携の通しのテストも）
npm run deploy         # Firebase Hosting とアクセスルール（とコネクタ）を公開（docs/DEPLOY.md）

npm run connector:setup     # Claude 用のコネクタの準備（初めての時に1回。docs/CONNECTOR.md）
npm run test:connector      # コネクタのテスト（単体・Workers の実行環境・公開する形）
npm run test:connector:emu  # コネクタの結合テスト（Firebase エミュレーター）

npm run mobile:doctor    # iPhone・Android のアプリの準備の確かめ（docs/MOBILE.md）
npm run mobile:keystore  # Android の署名の鍵を作る（最初に一度）
npm run mobile:firebase  # Firebase にアプリを登録し、ログインの設定ファイルを取ってくる
npm run android:install  # Android のアプリを作って、USB でつないだスマホに入れる
npm run ios:open         # （Mac）iPhone のアプリを作って Xcode で開く（アーカイブして TestFlight へ）
```

`dist/` は相対パスで出力されるので、任意の静的ホスティング（GitHub Pages など）にそのまま置けます。
`.github/workflows/pages.yml` は main ブランチを GitHub Pages に公開します（リポジトリの Settings → Pages で Source を「GitHub Actions」にし、このブランチを main に取り込んでください）。

## アプリとしてインストールする

公開先は <https://novel-studio-3352e.web.app>（Firebase Hosting。公開の手順は [docs/DEPLOY.md](docs/DEPLOY.md)）。

- **Windows（デスクトップ）**: Edge / Chrome のアドレスバーのインストールボタン。一度開けばオフラインでも動きます
- **iPhone**: 専用のアプリ（Mac で作って TestFlight から入れる。[docs/MOBILE.md](docs/MOBILE.md)）
- **Android**: 専用のアプリ（Windows か Mac で作って USB で入れる。[docs/MOBILE.md](docs/MOBILE.md)）

アプリを用意するまでは、iPhone は Safari の「ホーム画面に追加」、Android は Chrome の「アプリをインストール」でも使えます。

アプリは [Capacitor](https://capacitorjs.com/) 8 で Web 版の画面を包んだものです（`capacitor.config.ts`・`ios/`・`android/`）。
`vite.config.ts` は `base: './'`、ルーティングは HashRouter なので、`npm run build:native` の `dist-native/` をそのまま載せています。

## 構成

```
src/domain/    ドメインロジック（純粋関数・テスト済み）
src/claude/    Claude 連携の純粋な部品（推敲案の場所・内容から作る id・Claude に渡す形・手動連携・コネクタとの連携の決まり。コネクタと共有）
src/db/        IndexedDB への保存（Dexie）と同期の送信待ち
src/sync/      クラウドとの同期（Firebase。マージ・送受信・ログイン）
src/store/     状態管理（Zustand）と UI から呼ぶ actions
src/ui/        共通部品（ダイアログ・分割ペイン・自動保存入力など）
src/features/  各画面
src/platform/  iPhone・Android のアプリだけの動き（ログイン・キーボード・ファイルの保存・更新のしかたなど。Web 版では何もしない）
ios/ android/  iPhone・Android のアプリのプロジェクト（Capacitor。アイコンの元は assets/）
scripts/       公開（deploy.mjs）・アプリの準備とインストール（mobile.mjs）のスクリプト
e2e/           Playwright の E2E テスト
connector/     Claude 用のコネクタ（Cloudflare Worker。リモート MCP サーバー。src/domain・src/claude の純粋な部品を共有）
```
