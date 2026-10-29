/// <reference types="@capacitor/keyboard" />
/// <reference types="@capacitor/splash-screen" />
/// <reference types="@capacitor-firebase/authentication" />
// iPhone / Android アプリ（Capacitor）の設定。画面は Web 版と同じコードを `npm run build:native` で作った dist-native を載せる
// （サービスワーカーを入れない。vite.config.ts の native モード）。手順は docs/MOBILE.md
import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

const config: CapacitorConfig = {
  appId: 'jp.barraquda.novelstudio',
  appName: 'Novel Studio',
  webDir: 'dist-native',
  // 画面の origin で端末内のデータ（IndexedDB）の置き場所が決まる。既定が変わっても動かないよう書いておく。
  // 一度入れた後は絶対に変えない（変えると「データが全部消えた」ように見える）
  server: { hostname: 'localhost', androidScheme: 'https', iosScheme: 'capacitor' },
  ios: { contentInset: 'never', allowsLinkPreview: false },
  plugins: {
    // iPhone だけ。画面は縮めず、キーボードの高さを CSS 変数 --kb-native で受け取る（src/platform/keyboard.ts）。
    // resizeOnFullScreen は付けない（SystemBars と合わない）
    Keyboard: { resize: KeyboardResize.None },
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
    // 最初の描画の後に消す（src/main.tsx）。白い画面が一瞬出ないように
    SplashScreen: { launchAutoHide: false, backgroundColor: '#2f3a4f', showSpinner: false, launchFadeOutDuration: 150 },
    // 端末の Google のアカウント選択で ID トークンだけ受け取り、ログインは Web と同じ Firebase JS SDK で行う（src/sync/firebase.ts）
    FirebaseAuthentication: { skipNativeAuth: true, providers: ['google.com'] },
    // Firestore の常時接続には本物の fetch / XHR が要る
    CapacitorHttp: { enabled: false },
  },
  experimental: {
    ios: {
      spm: {
        swiftToolsVersion: '6.1',
        // SPM のパッケージ名の衝突を避ける（プラグインの issue #959）
        packageOptions: { '@capacitor-firebase/authentication': { symlink: true } },
        // Facebook の SDK を入れない
        packageTraits: { '@capacitor-firebase/authentication': ['Google'] },
      },
    },
  },
}

export default config
