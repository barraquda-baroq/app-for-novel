import Capacitor
import UIKit

/// アプリの画面（Capacitor の WebView）。アプリの中に入れたプラグインをここで登録する（SceneDelegate.swift から使う）
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // ファイルの保存（src/platform/saveFile.ts の SaveAs）
        bridge?.registerPluginInstance(SaveAsPlugin())
        // 画面の地の色を、起動の画面（LaunchScreen.storyboard）と同じ無地にする（端末のライト／ダーク）。
        // 起動の画面を消してから起動アニメーション（src/launch/launch.js）の最初の絵が出るまでの間も、同じ色のままにする
        if let color = UIColor(named: "LaunchBackground") {
            webView?.backgroundColor = color
            webView?.scrollView.backgroundColor = color
        }
    }
}
