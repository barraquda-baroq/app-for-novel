# iPhone・Android のアプリ（2.4）

Novel Studio 2.4 から、iPhone と Android では「ホーム画面に追加」した Web 版の代わりに、専用のアプリを使います。
画面と機能は Web 版（Windows の Edge のアプリ）と同じで、同じクラウド（Firebase）で同期します。

- **iPhone**: Mac で作り、Apple の **TestFlight**（テスト版の配布のしくみ。審査なし）から自分の iPhone に入れます。
- **Android**: Windows か Mac で作り、**USB でつないで**スマホに入れます（Google Play は使いません）。

手順は **Windows（PowerShell）でも Mac（ターミナル）でも同じコマンド**です（コマンドは1行ずつ入力して Enter）。
面倒な設定はスクリプト（`scripts/mobile.mjs`）がするので、Xcode や Android Studio の設定を手で変える必要はありません。

## 0. はじめに

### 必要なもの

| | Android | iPhone |
| --- | --- | --- |
| パソコン | Windows か Mac | Mac（この手順は Apple シリコンの Mac で書いています。13 インチの M2 の MacBook など） |
| アカウント | Firebase のプロジェクトを作った Google アカウント | 同じ Google アカウントと、Apple Developer Program に入っている Apple アカウント |
| その他 | USB ケーブル（データ通信ができるもの） | iPhone に TestFlight アプリ（App Store で無料） |

### チャットに貼らないもの（秘密）

- Apple アカウントのパスワード、2 ファクタ認証のコード
- Android の署名の鍵（`.jks` のファイル）とそのパスワード、`android/keystore.properties`

次のものは秘密ではありません（困った時に Claude に見せて大丈夫です）: `google-services.json`、`GoogleService-Info.plist`、
鍵の指紋（SHA-1・SHA-256）、Apple のチーム ID。一覧は [9](#9-秘密かどうかの一覧)。

## 1. 共通（Windows・Mac のどちらでも、最初に一度）

1. Node.js 24 LTS（22 以上なら動きます）と Git を入れる（[DEPLOY.md](DEPLOY.md) の手順 1 と同じ）。
2. リポジトリを最新にして、部品を入れる（初めてのパソコンでは DEPLOY.md の手順 2 の `git clone` から）。

   ```
   git pull
   npm ci
   ```

3. Firebase にログインする（済んでいれば不要。ブラウザが開くので、Firebase のプロジェクトを作った Google アカウントを選ぶ）。

   ```
   npx firebase login
   ```

   前にログインしていても、長く使っていないと切れていることがあります。`mobile:firebase` で「ログインが切れています」と出た時は `npx firebase login --reauth`。違うアカウントで入った時（「…を操作できません」）は `npx firebase logout` → `npx firebase login`。

4. そろっているものを確かめる（パスワードやファイルの中身は表示しません。✗ のものは、この後の手順で用意します）。

   ```
   npm run mobile:doctor
   ```

> Windows ではリポジトリを `C:\Users\<名前>\dev\app-for-novel` のような、自分のフォルダの中の**短い場所**に置いてください。
> 深いフォルダ（デスクトップの奥など）だと、Android のビルドで「パスが長すぎる」と失敗することがあります。
> `C:\dev` のような C ドライブの直下は、このパソコンのほかの利用者も読み書きできるので使わないでください（署名の鍵のパスワードを書いた `android/keystore.properties` が置かれます）。

## 2. Android（Windows・Mac）

この手順は Google Pixel と Gboard（Google の日本語入力）で書いています。ほかのメーカーのスマホも同じ流れですが、設定の場所の名前が少し違います。

### 1. Android Studio を入れる

1. <https://developer.android.com/studio> から Android Studio（いまの版は Rabbit 2）をダウンロードして入れる。
   - Windows: インストーラーを既定のまま進める
   - Mac: 開いた画面で Android Studio を「アプリケーション」に入れる
2. Android Studio を一度起動し、最初の画面（Setup Wizard）を **「Standard」** で最後まで進めて「Finish」を押す（ライセンスは「Accept」）。
   Android の開発の部品（SDK）が入ります。数 GB のダウンロードで、時間がかかります。終わったら Android Studio は閉じてかまいません。

Java は Android Studio に入っているもの（JBR）をスクリプトが使うので、別に入れる必要はありません。

### 2. 署名の鍵を作る（最初に一度だけ）

アプリには「署名の鍵」が要ります。**同じ鍵で作った版でないと、入れてあるアプリを上書き（更新）できません。**
鍵をなくすと更新できなくなり、入れ直すとスマホの中のデータが消えるので、大事に保管します。

```
npm run mobile:keystore
```

- パスワードを2回入力します（8 文字以上、半角の英数字と記号。**入力しても画面には何も出ないのが正常です**）。
- 鍵は `C:\Users\<名前>\NovelStudioKeys\novelstudio-release.jks`（Mac は `~/NovelStudioKeys/novelstudio-release.jks`）にできます。
- 終わったら必ず:
  - 鍵のファイルを **USB メモリとクラウド（Google ドライブ・iCloud Drive など）の2か所**にコピーする
  - パスワードを**パスワード管理アプリ**に入れる
- 鍵の設定は `android/keystore.properties` に書かれます（リポジトリには入りません）。

### 3. Firebase の設定（最初に一度だけ）

Firebase に Android のアプリを登録し、鍵の指紋（SHA-1・SHA-256）を登録して、ログインの設定ファイル（`android/app/google-services.json`）を取ってきます。

```
npm run mobile:firebase -- --android
```

- 「完了しました」と出れば OK です。
- 「まだできていません」と出たら、Firebase の準備に時間がかかっています。1〜2分待ってから、もう一度同じコマンドを実行してください。
  何度やっても同じ時は [4. Firebase の手作業での設定](#4-firebase-の手作業での設定)。

### 4. スマホの準備（最初に一度だけ）

1. スマホの **設定 > デバイス情報 > ビルド番号** を **7 回**タップする（「デベロッパーになりました」と出る。PIN を聞かれたら入力）。
2. **設定 > システム > 開発者向けオプション > USB デバッグ** をオンにする。
3. USB ケーブル（データ通信のできるもの）でパソコンとつなぐ。
4. Windows でスマホが見つからない時は、Google USB Driver を入れる:
   Android Studio の最初の画面（Welcome to Android Studio）の **More Actions（または ⋮）> SDK Manager** →「**SDK Tools**」タブで「Google USB Driver」にチェック →「OK」（プロジェクトを開いている時は **Tools > SDK Manager**）。
   それでも見つからない時は、Windows の「デバイス マネージャー」でスマホを右クリック →「ドライバーの更新」→「コンピューターを参照」で
   `C:\Users\<名前>\AppData\Local\Android\Sdk\extras\google\usb_driver` を選ぶ。
   （Pixel 以外のスマホは、メーカーの USB ドライバーを入れます）

### 5. 入れる

スマホのロックを外して USB でつないだまま:

```
npm run android:install
```

初めての時は、始めてすぐスマホに「USB デバッグを許可しますか？」と出ます。**「このパソコンからの接続を常に許可」にチェック**して「許可」を押してください（1 分ほど待ちます）。
続けて、アプリの画面のビルド → Android のアプリのビルド（初めての時は部品のダウンロードで 5〜15 分）→ スマホへのインストールまで自動で行います。
「入れました。」と出たら、スマホで Novel Studio を開き、設定（右上の歯車）→「同期」→「Google でログイン」。

Android Studio で開いて ▶ で入れることもできます（`npm run android:open`。同じ鍵で署名されます）。

### 6. 更新

新しい版が出た時（アプリに「更新のしかた」と出た時も）:

```
git pull
npm ci
npm run android:install
```

今のアプリの上に入れ直すので、データはそのまま残ります。**アプリをアンインストール（削除）しないでください**
（まだ同期していない、スマホの中のデータが消えます）。

### 7. 困ったとき

| 表示 | どうする |
| --- | --- |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE`・「署名の鍵が違います」 | 入っているアプリと違う鍵で作りました（別のパソコンの鍵など）。**アプリは削除せず**、前と同じ鍵を使います（[8](#8-2台目のパソコン)）。どうしても入れ直す時は、先に同期済みになっていることとバックアップの書き出しを確かめてから |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | 古い版を入れようとしました。`git pull` してからもう一度 |
| 「スマホが見つかりません」 | USB デバッグがオンか、データ通信のできるケーブルか、スマホのロックを外したか。Windows は Google USB Driver（[4](#4-スマホの準備最初に一度だけ)） |
| 「USB デバッグを許可していません」 | スマホの画面の確認で「許可」を押す（出ていなければケーブルを挿し直す） |
| ログインで「署名（SHA-1）とアプリの署名が合っていません」 | [Android の署名](#android-の署名) |
| `mobile:firebase` で「Firebase のログインが切れています」 | `npx firebase login --reauth`（ブラウザで Firebase のプロジェクトを作った Google アカウントを選ぶ）してから、もう一度 |
| `mobile:firebase` で「Firebase のプロジェクト … を操作できません」 | 違う Google アカウントで入っています。`npx firebase logout` → `npx firebase login` で、プロジェクトを作ったアカウントを選ぶ |
| 「パスが長すぎる」「Filename longer than 260 characters」（Windows） | リポジトリを `C:\Users\<名前>\dev\app-for-novel` のような自分のフォルダの中の短い場所に `git clone` し直す（`android/keystore.properties` は `npm run mobile:keystore -- --use <鍵>` で作り直す） |
| Play プロテクトの警告 | 自分で作ったアプリなので「インストールする」（「詳細」の中にあることがあります） |
| 鍵のパスワードを忘れた | 取り戻す方法はありません。新しい鍵で作るには、アプリを削除して入れ直す（データが消えるので、先に同期とバックアップ）。パスワード管理アプリを確かめてください |

### Android の署名

ログインで「Firebase に登録した署名（SHA-1）とアプリの署名が合っていません」と出た時は、アプリを作った鍵の指紋が Firebase に登録されていません。
アプリを作ったパソコンで次を実行し、終わったら `npm run android:install` で入れ直します。

```
npm run mobile:firebase -- --android
```

`npm run android:install` 以外の方法（Android Studio の既定の鍵など）で作ったアプリは、鍵が違うのでログインできません。

### 8. 2台目のパソコン

Windows と Mac の両方から入れる時は、**同じ鍵**を使います（新しく作らない）。

1. 1台目の `novelstudio-release.jks` を、USB メモリなどで2台目に持ってくる。
2. 2台目で:

   ```
   npm run mobile:keystore -- --use <鍵のファイルの場所>
   npm run mobile:firebase -- --android
   ```

   （場所は、ファイルをターミナル・PowerShell の画面にドラッグすると入ります）
3. 鍵は2台目の `NovelStudioKeys` にもコピーされます。以後は `npm run android:install` だけです。

## 3. iPhone（Mac）

### 1. Apple Developer Program を確かめる

登録は済んでいるので、確かめるだけです。<https://developer.apple.com/account> に Apple アカウントでサインインし、
「メンバーシップの詳細」で次を見ます。

- メンバーシップが有効で、期限が切れていないこと（年 US$99 の自動更新。切れると TestFlight の版が使えなくなります）
- **チーム ID**（英大文字と数字の 10 文字）。手順 4 で使います（秘密ではありません）

### 2. macOS と Xcode を入れる

1. 先に macOS を新しくする（システム設定 > 一般 > ソフトウェアアップデート）。Xcode 27 は macOS Tahoe 26.6 以降が要ります。
2. Mac の空きを **40 GB くらい**作る（Xcode と iOS の部品で 30 GB 以上使います）。
3. App Store で「Xcode」を入れる（いまの版は 27.x。26 以上なら使えます）。
4. Xcode を一度起動する。「追加のコンポーネント」・使う機種を聞かれたら **iOS** にチェックして入れる（時間がかかります）。

### 3. Xcode に Apple アカウントを入れる

Xcode のメニュー **Xcode > Settings…（設定…）> Accounts** の左下の「＋」→「Apple Account」で、Apple Developer Program の Apple アカウントでサインインします。
チームの一覧にあなたの名前のチームが出れば OK です（「Personal Team」ではない方）。

### 4. リポジトリと Firebase の設定

1. Mac でも [1. 共通](#1-共通windowsmac-のどちらでも最初に一度) をする（Node.js・Git・`npm ci`・`npx firebase login`）。ログインが切れている・違うアカウントの時の直し方も、そこの手順 3 にあります。
2. Claude 用のコネクタを使っている時は、Windows のパソコンの `connector.local.json`（リポジトリの直下）を Mac のリポジトリの直下にコピーする（秘密ではありません。無いとアプリの「Claude 連携」が「コネクタ未設定」になります）。
3. Firebase に iPhone のアプリを登録し、ログインの設定ファイルを取ってくる（`<チームID>` は手順 1 の 10 文字）:

   ```
   npm run mobile:firebase -- --ios --team <チームID>
   ```

   `ios/App/App/GoogleService-Info.plist` と `ios/App/local.xcconfig`（Google ログインの戻り先とチーム ID）ができます（どちらもリポジトリには入りません）。
   「まだできていません」と出たら、1〜2分待ってからもう一度。

### 5. App Store Connect にアプリを作る（最初に一度だけ）

ブラウザ（Windows でも可）で <https://appstoreconnect.apple.com> を開き、**アプリ > ＋ > 新規 App**:

| 項目 | 入れるもの |
| --- | --- |
| プラットフォーム | iOS |
| 名前 | 例:「Novel Studio barraquda」（App Store 全体で重複できないので、ほかと違う名前なら何でもよい。iPhone のホーム画面の名前は「Novel Studio」のまま） |
| プライマリ言語 | 日本語 |
| バンドル ID | `jp.barraquda.novelstudio` |
| SKU | `novelstudio`（自分用の管理番号。何でもよい） |
| ユーザアクセス | フルアクセス |

バンドル ID が一覧に出ない時は、先に手順 6 の 1〜2（iPhone をつないで送り先に選ぶ。Xcode が登録します）をしてから戻ってきてください。

### 6. アーカイブして TestFlight に上げる

```
npm run ios:open
```

アプリの画面をビルドして、Xcode でプロジェクトを開きます。

1. 初めて開いた時は、部品（Swift Package）の取得に数分〜10分かかります（左下に進み具合）。終わるまで待つ。
2. **最初に一度だけ**: iPhone を USB で Mac につなぎ、ロックを外して「このコンピュータを信頼しますか？」で「信頼」（iPhone のパスコード）。
   iPhone の **設定 > プライバシーとセキュリティ > デベロッパモード** をオンにする（再起動します）。
   Xcode の上の真ん中の送り先で自分の iPhone を一度選ぶ。Xcode が iPhone とアプリ（バンドル ID）を Apple に登録します（「Register Device」と出たら押す）。
   左の「App」> **Signing & Capabilities** に赤いエラーが無くなれば OK（iPhone は外してよい）。
   Apple は、登録した iPhone が1台も無いと署名の設定（プロビジョニングプロファイル）を作れないので、これをしないと次の Archive が失敗します。
3. Xcode の上の真ん中で、送り先を **「Any iOS Device (arm64)」** にする。
4. メニュー **Product > Archive**。数分でビルドが終わり、「Organizer」の画面が開きます。
5. 「Distribute App」→ **「TestFlight & App Store」** →「Distribute」。チームや署名は設定済みなので、選ぶ必要はありません。
   - 「codesign がキーチェーンの…を使用しようとしています」と出たら、Mac のログインパスワードを入れて「常に許可」
   - 暗号化（輸出コンプライアンス）の質問は出ません（設定済み）
6. 「Uploaded」と出れば完了です。

### 7. TestFlight で iPhone に入れる

1. Apple から「処理が完了しました」のメールが来るのを待つ（数分〜30分）。
2. App Store Connect の **アプリ > Novel Studio … > TestFlight > 内部テスト** の「＋」でグループを作り（名前は「自分」など）、
   テスターに自分を追加し、**「自動配信を有効にする」**をオンにする。
3. iPhone に **TestFlight** アプリ（App Store、無料）を入れ、届いた招待（メールか TestFlight アプリ）を開いて「インストール」。
4. TestFlight アプリで Novel Studio を開き、**「自動アップデート」をオン**にする。
5. Novel Studio を開き、設定（右上の歯車）→「同期」→「Google でログイン」。初めては「"google.com" を使用してサインイン」の確認が出るので「続ける」。

### 8. 更新・90日の期限

- **更新**: Mac で `git pull` → `npm ci` → 手順 6 をやり直すだけです（版の番号は Claude が上げています）。iPhone には TestFlight から自動で入ります。
  同じ版をもう一度上げる時（期限の延長など）は、Xcode がビルド番号を自動で上げます（Distribute の途中の「Manage Version and Build Number」はオンのまま）。
- **90日の期限**: TestFlight の版は、上げてから **90 日**で使えなくなります。**80 日以内を目安に**新しい版を上げてください
  （更新が無くても手順 6 をもう一度でよい）。期限が近づくと、アプリにお知らせが出ます。設定の「このアプリについて」にも期限が出ます。
- **アプリは削除しない**: 期限が切れても、新しい版を入れればデータはそのままです。削除すると、まだ同期していないデータが消えます。
- メンバーシップの更新を切らさない。版が急に全部使えなくなった時は、App Store Connect の「ビジネス」に、同意していない新しい契約が無いか見る。

### 9. 困ったとき

| 表示 | どうする |
| --- | --- |
| Xcode のビルドで「Google ログインの設定がありません」 | 手順 4 の `npm run mobile:firebase -- --ios --team <チームID>` をしてから、もう一度 `npm run ios:open` |
| Xcode の左の一覧で `GoogleService-Info.plist` が赤い | 同上（ファイルはリポジトリに入らないので、Mac ごとに作ります） |
| 「Signing for "App" requires a development team」 | 同上（チーム ID が `ios/App/local.xcconfig` に無い） |
| 「Xcode ではなく Command Line Tools が選ばれています」 | ターミナルで `sudo xcode-select -s /Applications/Xcode.app`（Mac のログインパスワード） |
| 「Your team has no devices from which to generate a provisioning profile」・「No profiles for 'jp.barraquda.novelstudio' were found」 | iPhone が Apple に登録されていません。手順 6 の 2（USB でつないで「信頼」、送り先に自分の iPhone を選ぶ）をしてから、送り先を「Any iOS Device (arm64)」に戻して Product > Archive |
| Apple から「ITMS-91053: Missing API declaration」のメール | メールの本文（API の名前）を Claude に見せる（`ios/App/App/PrivacyInfo.xcprivacy` に足します） |
| 部品（Swift Package）の取得に失敗する | Xcode のメニュー **File > Packages > Reset Package Caches**、それでもだめなら Xcode を閉じて `npm run ios:open` をもう一度 |

### ログインの設定

iPhone で「Google でログイン」を押しても何も起きない・「ログインの画面が応答しませんでした」と出る時:

1. Mac で `npm run mobile:doctor` を実行し、iPhone の項目がすべて ✓ か確かめる。✗ があれば手順 4 をやり直し、手順 6 で上げ直す。
2. それでも同じ時は [4. Firebase の手作業での設定](#4-firebase-の手作業での設定)。

### 開発中の確かめ（Xcode の ▶）

キーボードの上の記号バーなどを細かく確かめる時は、TestFlight を通さずに Xcode から直接 iPhone に入れられます。

1. iPhone を USB で Mac につなぎ、iPhone の **設定 > プライバシーとセキュリティ > デベロッパモード** をオンにする（再起動します。手順 6 の 2 で済んでいれば、つなぐだけ）。
2. `npm run ios:open` → Xcode の送り先に自分の iPhone を選び、▶ を押す。
3. 画面の中を調べる時は、iPhone の **設定 > アプリ > Safari > 詳細 > Web インスペクタ** をオンにし、Mac の Safari の **設定 > 詳細 >「Web 開発者用の機能を表示」**をオンにして、Safari の「開発」メニューから iPhone の Novel Studio を選ぶ。

▶ で入れたアプリと TestFlight のアプリは同じアプリです（データもそのまま）。

## 4. Firebase の手作業での設定

`npm run mobile:firebase` が何度やっても「まだできていません」の時だけ行います。

1. [Firebase コンソール](https://console.firebase.google.com/project/novel-studio-3352e/authentication/providers) の
   **Authentication > ログイン方法（Sign-in method）> Google** を開き、有効のまま **「保存」** を押す
   （新しく登録したアプリのログインの設定が作られ直します）。
2. 2〜3分待ってから、`npm run mobile:firebase -- --android`（iPhone は `-- --ios --team <チームID>`）をもう一度。
3. それでも iPhone で「CLIENT_ID がありません」と出る時（最後の手段）: [Google Cloud コンソールの「認証情報」](https://console.cloud.google.com/apis/credentials?project=novel-studio-3352e) の
   「＋ 認証情報を作成 > OAuth クライアント ID」で、種類「iOS」、バンドル ID `jp.barraquda.novelstudio` のものを作り、表示されたクライアント ID
   （`…apps.googleusercontent.com`）を付けて実行する:

   ```
   npm run mobile:firebase -- --ios --team <チームID> --ios-client-id <クライアントID>
   ```

ログインで「このクライアントからのリクエストはブロックされています」のように出る時は、Google Cloud コンソールの「認証情報」の
API キー（Browser key）に「ウェブサイトの制限」が付いていないか見ます。付いていれば、`capacitor://localhost/*` と `https://localhost/*` を足します。

## 5. 初めて開いたとき

- アプリでログインすれば、クラウドの内容がすべて入ります（Windows の Edge のアプリで書いた内容も）。
- Safari・Chrome で「ホーム画面に追加」した Web 版と、アプリの中のデータは別々です（同じクラウドで同期します）。
  Web 版を消す前に、Web 版を開いて **「同期済み」** になっていることを確かめてください（同期していないデータは、アプリへは移りません。
  その時は Web 版でバックアップを書き出し、アプリの設定 >「データ」で復元します）。

## 6. データが消える操作

次をすると、その端末の中のデータが消えます。する前に、**同期済み**であることと、**バックアップの書き出し**（設定 >「データ」）を確かめてください。

- アプリの削除（アンインストール）
- 端末の設定からアプリの「ストレージを消去」（Android）
- 違う鍵で作った Android のアプリを入れるための削除
- iPhone の TestFlight の版の削除（期限が切れても削除しない。新しい版を入れれば戻ります）

機種変更の時は、新しい端末にアプリを入れてログインします（Android はバックアップからの引き継ぎで写しません）。

## 7. 版を上げる（Claude・開発者向け）

版の元は `package.json` の `version`（例 `2.4.0`）です。上げる時は次を一緒に変えます（`src/platform/version.test.ts` がそろっているか確かめます）。

- `package.json` の `version`
- `src/sync/appVersion.ts` の `APP_VERSION`（`2.4` の形）
- `ios/App/novelstudio.xcconfig` の `MARKETING_VERSION`（`2.4.0`）と `CURRENT_PROJECT_VERSION`（`20400`）

Android の `versionCode`（`20400`）・`versionName` は `android/app/build.gradle` が `package.json` から作ります。

スクリプトを使わずに手で写す時は、`npm run build:native` の後に `npx cap sync android`・`npx cap sync ios` とプラットフォームを付けます
（付けない `npx cap sync` は、Windows では iPhone の部分（Swift Package のシンボリックリンク）で失敗します）。
`ios/` の Xcode のプロジェクトのファイル（`project.pbxproj`）を手で直した時は、CI の `ios` が通ることを確かめてください。
iPhone の部品（Swift Package）の版は `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` に控えてあり、
Mac の Xcode も CI と同じ版を使います（プラグインを上げて版が変わると、CI の `ios` が警告と新しい中身を出すので、それで置き換えます）。

データの形の版（`DATA_MODEL`）を上げる版を出す時は、先に TestFlight に上げて `npm run android:install` もし、
両方の端末に新しい版を入れてから `npm run deploy` します（同じ日に続けて。古い版のアプリは送るのを止めて「要更新」になります）。

## 8. 2.4 の受け入れチェックリスト

**iPhone（TestFlight の版）**

- [ ] 入れて開く: 白い画面が一瞬出ない、アイコンが正しい
- [ ] Google でログイン（「"google.com" を使用してサインイン」の確認を含む）。タイトルが届き、「同期済み」になる
- [ ] iPhone で書いた内容が PC の Web 版に出る。その逆も
- [ ] 原稿の画面で日本語かな入力: 記号バーが変換候補のすぐ上にある。記号・ルビ・傍点・戻す・進む・「キーボードを閉じる」が動く
- [ ] ローマ字・英語・絵文字のキーボード、変換候補を広げた時、横向き、キーボードを出したままアプリを裏に回して戻る
- [ ] アイデアの入力・設定の入力欄がキーボードの上に見え、「完了」が出る
- [ ] 長押しのメニュー: リンクのプレビューや文字の選択が出ず、軽く振動する
- [ ] 各話の ZIP の書き出し: 「ファイル」の保存の画面が開き、日本語の名前で保存される
- [ ] バックアップの書き出し: 保存すると日付が変わる。やめると変わらない。バックアップの復元もできる
- [ ] 保存の画面（ZIP・バックアップ）は下へスワイプしても閉じない。「キャンセル」で閉じると、ZIP は「保存先を選ばなかったので、書き出していません」と出て、バックアップのボタンはまた押せる
- [ ] 全文コピーをメモに貼れる
- [ ] ホワイト・ダーク・ディープダークでステータスバーの文字が読める。「端末の設定に合わせる」が端末の設定に従う
- [ ] 「手順を見る」などのリンクが Safari で開く
- [ ] ログアウト → 別のアカウントでログイン（断られる）→ ログアウト → 正しいアカウントでログイン
- [ ] 機内モードで書き、つないだら同期される
- [ ] 設定の「このアプリについて」に 2.4 と期限が出る
- [ ] 書いた直後にアプリを上にスワイプして閉じても、内容が残るか、次に開いた時に復元できる
- [ ] もう一つの版を TestFlight に上げて更新しても（同じ版の上げ直しも）、内容・ログイン・「同期済み」が残る。Xcode の ▶ で入れた版と TestFlight の版を入れ替えても同じ

**Android**

- [ ] `npm run android:install` が通る
- [ ] アカウントを選んでログインし、同期される
- [ ] ログアウト → 別のアカウントでログイン（断られる）→ ログアウト → 正しいアカウントでログイン
- [ ] 機内モードで書き、つないだら同期される
- [ ] Gboard: 記号バーが候補の帯のすぐ上にある。フローティングのキーボードでも使える
- [ ] 戻るボタン: 開いている画面（ダイアログ・原稿画面の「表示」「…」・推敲案の一覧）を閉じる → 前の画面に戻る → いちばん上ではアプリを閉じる（書いた内容は残る）
- [ ] ZIP・バックアップで「保存」の画面が開き、「ダウンロード」にも Google ドライブにも保存できる
- [ ] コピー
- [ ] 画面の端まで表示されても、ステータスバー・ジェスチャーの帯の下に隠れるものがない。どの外観でもアイコンが読める
- [ ] もう一度 `npm run android:install` してもデータが残る
- [ ] 「端末の設定に合わせる」で、端末のダークモードの切り替えに従う
- [ ] 設定の「このアプリについて」に 2.4 とビルドした日が出る

## 9. 秘密かどうかの一覧

| もの | 秘密 | 置き場所 | リポジトリ |
| --- | --- | --- | --- |
| Apple アカウントのパスワード・2 ファクタのコード | **秘密** | 自分だけ | 入れない |
| 署名の鍵（`novelstudio-release.jks`）とパスワード | **秘密** | `NovelStudioKeys` と、USB メモリ・クラウドの控え。パスワードはパスワード管理アプリ | 入れない |
| `android/keystore.properties`（鍵の場所とパスワード） | **秘密** | 各パソコン（`npm run mobile:keystore` が作る） | 入れない |
| `android/app/google-services.json` | 秘密ではない | 各パソコン（`npm run mobile:firebase` が作る） | 入れない（公開リポジトリなので、念のため） |
| `ios/App/App/GoogleService-Info.plist` | 秘密ではない | Mac（同上） | 入れない |
| `ios/App/local.xcconfig`（Google ログインの戻り先・チーム ID） | 秘密ではない | Mac（同上） | 入れない |
| 鍵の指紋（SHA-1・SHA-256）、チーム ID | 秘密ではない | — | — |
| `connector.local.json`（コネクタの URL） | 秘密ではない | コネクタを使うパソコン | 入れない |
