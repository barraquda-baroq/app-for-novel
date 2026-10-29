# 公開と同期の準備（Firebase）

Novel Studio 2.x は、アプリを Firebase Hosting に置き、原稿を Cloud Firestore に保存して端末間で同期します。
Firebase プロジェクト `novel-studio-3352e`（Spark 無料プラン）を使います。
2.3 の Claude 用のコネクタ（Cloudflare Worker）の準備は [CONNECTOR.md](CONNECTOR.md) にまとめています。

公開の作業は **Windows（PowerShell）でも Mac（ターミナル）でも同じ手順・同じコマンド**でできます（コマンドは1行ずつ入力して Enter）。
Mac が要るのは 2.4 の iPhone / Android のアプリを作る時だけです。

## 1. 一度だけ行うこと（Windows か Mac で）

1. [Node.js](https://nodejs.org/ja) の LTS 版（22 以上）と [Git](https://git-scm.com/) を入れる。
   - Windows: インストーラーで入れてから、スタートメニューで「PowerShell」を開く
     - 初めての時だけ: PowerShell で `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行し、確かめられたら `Y` を入力して Enter（npm のコマンドを動かせるようにする設定。管理者でなくてよい）。終わったら PowerShell を閉じて開き直す
   - Mac: インストーラーで入れてから、「ターミナル」を開く（Git は `git --version` を実行すると入れ方が出る）
   - どちらも `node -v` が `v22` 以上なら OK
2. リポジトリを取ってくる（PowerShell・ターミナルで1行ずつ）。

   ```
   git clone https://github.com/barraquda-baroq/app-for-novel.git
   cd app-for-novel
   git checkout claude/novel-writing-app
   npm ci
   ```

3. Firebase にログインする（ブラウザが開くので、Firebase のプロジェクトを作った Google アカウントを選ぶ）。

   ```
   npx firebase login
   ```

4. 公開する。ビルドして、アプリ（Hosting）とアクセスルール（Firestore のルール・索引の設定）をまとめて送ります
   （`scripts/deploy.mjs`。Claude 用のコネクタを準備した後は、コネクタも一緒に公開します）。

   ```
   npm run deploy
   ```

   最後に `Hosting URL: https://novel-studio-3352e.web.app` と表示され、`公開しました。` と出れば完了です。

> アクセスルールを公開するまでは、ログインしても同期できません（「クラウドへのアクセスが拒否されました」と出ます）。
> 先に必ず `npm run deploy` を行ってください。

> Windows で `npm` を実行して「このシステムではスクリプトの実行が無効になっているため、ファイル …\npm.ps1 を読み込むことができません」と出たら、
> 手順 1 の `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行してから PowerShell を開き直してください（`npm.cmd`・`npx.cmd` と打っても動きます）。

5. Google ログインの戻り先を登録する（最初の1回だけ）。アプリはログインの画面も `novel-studio-3352e.web.app` で開くので、
   Google 側にその戻り先を教えておきます。これをしないと、ログインの画面に「エラー 400: redirect_uri_mismatch」と出ます。
   1. [Google Cloud コンソールの「認証情報」](https://console.cloud.google.com/apis/credentials?project=novel-studio-3352e) を開く
      （Firebase と同じ Google アカウントで。プロジェクトが「novel-studio-3352e」になっていることを確かめる）。
   2. 「OAuth 2.0 クライアント ID」の **Web client (auto created by Google Service)** を押す。
   3. 「承認済みのリダイレクト URI」の「URI を追加」で次を足して、「保存」を押す（元からある `…firebaseapp.com/__/auth/handler` は消さない）。

      ```
      https://novel-studio-3352e.web.app/__/auth/handler
      ```

   4. 反映まで数分かかることがあります。


## 2. 各端末で使い始める

### Windows（Edge）

1. Edge で <https://novel-studio-3352e.web.app> を開く。
2. アドレスバーの右にある「アプリをインストール」を押す（見当たらない時は「…」→「アプリ」→「このサイトをアプリとしてインストール」）。
   スタートメニューから専用のウィンドウで開けるようになります。
3. 右上の歯車（アプリの設定）→「同期」→「Google でログイン」。

### iPhone・Android（アプリ版ができるまで）

同じアドレスを Safari（iPhone）・Chrome（Android）で開き、「ホーム画面に追加」してからログインします。
2.4 で iPhone・Android のアプリ版を用意したら、そちらに移ります（データはクラウドから受け取るので、移すものはありません）。

### 初めてログインした時

その端末に入っていた内容とクラウドの内容が合わさります（どちらも消えません）。
同じバックアップを2台で復元していた場合のように、同じものが両方にあった時は1つにまとまります。

## 3. 持ち主のアカウント

最初にログインして同期を始めた Google アカウントが、このクラウドの「持ち主」になります（Firestore の `config/owner` に記録）。
アクセスルールで、持ち主のアカウントだけが原稿を読み書きできるようにしているので、ほかの人が自分の Google アカウントで
ログインしても、何も読めず、何も書けません。
（拒否された読み取りも無料枠の回数には数えられるため、悪意を持って大量に試されると、その日の読み取りの枠が減ることはあります。
原稿が見られることはありません。）

- 持ち主を変えたい時（別の Google アカウントに移したい時）は、[Firebase コンソールの Firestore](https://console.firebase.google.com/project/novel-studio-3352e/firestore) で
  `config` → `owner` の文書を削除してから、新しいアカウントでログインします。
  前の持ち主のアカウントでログインしたままの端末は、記録が消えたことに気付いて同期を止めます（持ち主を取り戻しません）。
  その端末では、ログアウトしてから新しいアカウントでログインし直してください。
- 前の持ち主のアカウントの原稿は、クラウドの `users/<前の uid>` の下に残ります（新しい持ち主からは見えません）。
  移したい時は、前のアカウントの端末でバックアップを書き出し、新しいアカウントの端末で復元してください。
- 同じ端末で以前と別のアカウントでログインした時は、同期を始める前に「このアカウントで同期しますか？」と確かめます
  （間違えて別のアカウントを選んでも、原稿がそのアカウントに写らないように）。

## 4. 更新する時

```
git pull
npm ci
npm run deploy
```

Claude 用のコネクタを使っている時は、`npm ci` の後に `npm --prefix connector ci` も実行してください（`npm run deploy` がコネクタも公開します）。
コネクタの URL を控えた `connector.local.json` は、`npm run connector:setup` を実行したパソコンにだけあります。別のパソコンから更新する時は、
そのパソコンでも先に一度 `npm run connector:setup` を実行する（同じコネクタ・鍵・連携をそのまま使います）か、`connector.local.json` を
コピーしてください。無いまま公開すると、アプリは「コネクタ未設定」になり、コネクタも更新されません（docs/CONNECTOR.md の 3）。

開いているアプリには「新しいバージョンのアプリがあります」と出るので、「更新する」を押すと切り替わります（書いている途中の内容は保存してから切り替わります）。

2.2 からは、アプリがクラウドに「データの形の版」（Firestore の `users/<uid>/meta/app`）を自動で記録します（上げるだけで、下げることはありません）。これより古い版のアプリは、この記録が自分より新しいと受け取りだけを続け、送るのを止めて「要更新」と出します（その端末で書いた内容は端末内に残り、アプリを更新すると送ります）。新しい版のアプリをやめて前の版に戻したい時は、Firebase コンソールの Firestore でこの文書を削除してください（開いている端末が自分の版を記録し直し、送るのを再開します。新しい版のアプリを開いている端末があると、また上がります）。この記録のためのアクセスルールも一緒に公開するので、更新はいつもどおり `npm run deploy` で行ってください。

## 5. 無料枠の目安（Spark プラン）

| 項目 | 1日の無料枠 | このアプリでの使い方 |
| --- | --- | --- |
| 書き込み | 2万回 | 編集を数秒ごとにまとめて送る。1時間書き続けて数百回程度 |
| 読み取り | 5万回 | 起動時は前回からの差分だけ。新しい端末で初めてログインした時だけ全件 |
| 保存容量 | 1 GiB | 文字だけなので、長編を何本も書いても数十 MB 程度 |

無料枠を超えた日は、その日のうちは同期が止まり（「今日の無料枠を使い切りました」と出ます）、翌日に自動で再開します。
その間も端末内には保存されています。

## 6. 開発者向け: エミュレーターで試す

Firebase のエミュレーター（Java が必要）で、本物のクラウドに触れずに同期を試せます。

```
npm run test:sync           # 同期の結合テスト（2台の端末を動かす）
npm run test:e2e:sync       # ブラウザ2つで同期を確かめる E2E テスト（Claude 用のコネクタとの連携の通しのテストも）
npm run test:connector:emu  # Claude 用のコネクタの結合テスト（docs/CONNECTOR.md）
```

`npm run test:e2e:sync` の `e2e/pairing.sync.spec.ts` は、本物のコネクタ（Cloudflare Worker）をテストの中で動かすので、
先に `npm --prefix connector ci` が要ります（入っていなければ、そのテストだけ飛ばします）。

手で試す時（テスト用のアクセスルール firestore.emu.rules を使う。持ち主の制限は外してある）は、1つ目の画面でエミュレーターを動かしたまま、
2つ目の画面で開発サーバーを動かします。

```
npx firebase emulators:start --config firebase.emu.json --only auth,firestore --project demo-novel-studio
```

- Mac（ターミナル）: `VITE_FIREBASE_EMULATOR=127.0.0.1 npm run dev`
- Windows（PowerShell）: `$env:VITE_FIREBASE_EMULATOR="127.0.0.1"; npm run dev`
  （PowerShell の `$env:` はその画面を閉じるまで残ります。開発サーバーはこのための PowerShell の画面で動かし、終わったら画面を閉じてください。
  同じ画面で `npm run deploy` をする時は、先に `Remove-Item Env:VITE_FIREBASE_EMULATOR, Env:VITE_CONNECTOR_ORIGIN -ErrorAction SilentlyContinue` を実行します。
  `npm run deploy` はこれらの開発用の値を公開するアプリに入れませんが、念のため）

エミュレーターにつないだ開発サーバーでは、「Google でログイン」を押すとエミュレーターの仮のログイン画面が開きます。
