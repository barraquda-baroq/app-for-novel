# 公開と同期の準備（Firebase）

Novel Studio 2.x は、アプリを Firebase Hosting に置き、原稿を Cloud Firestore に保存して端末間で同期します。
Firebase プロジェクト `novel-studio-3352e`（Spark 無料プラン）を使います。

## 1. 一度だけ行うこと（Mac で）

1. [Node.js](https://nodejs.org/) の LTS 版（22 以上）を入れる。
2. ターミナルでリポジトリを取ってくる。

   ```bash
   git clone https://github.com/barraquda-baroq/app-for-novel.git
   cd app-for-novel
   git checkout claude/novel-writing-app
   npm ci
   ```

3. Firebase にログインする（ブラウザが開くので、Firebase のプロジェクトを作った Google アカウントを選ぶ）。

   ```bash
   npx firebase login
   ```

4. 公開する。ビルドして、アプリ（Hosting）とアクセスルール（Firestore のルール・索引の設定）をまとめて送ります。

   ```bash
   npm run deploy
   ```

   最後に `Hosting URL: https://novel-studio-3352e.web.app` と表示されれば完了です。

> アクセスルールを公開するまでは、ログインしても同期できません（「クラウドへのアクセスが拒否されました」と出ます）。
> 先に必ず `npm run deploy` を行ってください。

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
ログインしても、何も読めず、何も書けません（無料枠を使われることもありません）。

- 持ち主を変えたい時（別の Google アカウントに移したい時）は、[Firebase コンソールの Firestore](https://console.firebase.google.com/project/novel-studio-3352e/firestore) で
  `config` → `owner` の文書を削除してから、新しいアカウントでログインします。
- 同じ端末で以前と別のアカウントでログインした時は、同期を始める前に「このアカウントで同期しますか？」と確かめます
  （間違えて別のアカウントを選んでも、原稿がそのアカウントに写らないように）。

## 4. 更新する時

```bash
git pull
npm ci
npm run deploy
```

開いているアプリには「新しいバージョンのアプリがあります」と出るので、「更新する」を押すと切り替わります（書いている途中の内容は保存してから切り替わります）。

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

```bash
npm run test:sync        # 同期の結合テスト（2台の端末を動かす）
npm run test:e2e:sync    # ブラウザ2つで同期を確かめる E2E テスト

# 手で試す時
npx firebase emulators:start --only auth,firestore --project demo-novel-studio
VITE_FIREBASE_EMULATOR=127.0.0.1 npm run dev
```

エミュレーターにつないだ開発サーバーでは、「Google でログイン」を押すとエミュレーターの仮のログイン画面が開きます。
