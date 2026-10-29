import Capacitor

/// アプリの画面（Capacitor の WebView）。アプリの中に入れたプラグインをここで登録する（SceneDelegate.swift から使う）
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // ファイルの保存（src/platform/saveFile.ts の SaveAs）
        bridge?.registerPluginInstance(SaveAsPlugin())
    }
}
