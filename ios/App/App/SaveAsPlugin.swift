import Capacitor
import UIKit

/// ファイルの保存先を選んでもらう（src/platform/saveFile.ts の SaveAs）。
/// アプリの一時置き場（Cache）に書いたファイルを、「ファイル」の書き出しの画面で好きな場所へコピーする。
/// 保存される名前は一時置き場のファイルの名前（saveFile.ts の cacheName。とても長い名前は拡張子の前を少し縮めてある）。
/// やめた時は "Save canceled"（code CANCELED）で reject する（saveFile.ts の isSaveCancel が「やめた」と見る）
@objc(SaveAsPlugin)
public class SaveAsPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    public let identifier = "SaveAsPlugin"
    public let jsName = "SaveAs"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveAs", returnType: CAPPluginReturnPromise)
    ]

    /// 保存の画面を開いている呼び出し（同時に開くのは1つだけ）
    private var pending: CAPPluginCall?
    /// いま開いている保存の画面（遅れて届いた前の画面の知らせで、次の呼び出しをやめたことにしないため）
    private weak var picker: UIDocumentPickerViewController?

    @objc func saveAs(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let src = SaveAsPlugin.fileURL(path) else {
            call.reject("保存するファイルの場所がありません")
            return
        }
        guard FileManager.default.fileExists(atPath: src.path) else {
            call.reject("保存するファイルが見つかりません")
            return
        }
        DispatchQueue.main.async {
            guard let viewController = self.bridge?.viewController else {
                call.reject("保存の画面を開けませんでした")
                return
            }
            // 前の画面が閉じられずに残っていたら、そちらはやめたことにする
            self.pending?.reject("Save canceled", "CANCELED")
            self.pending = call
            let picker = UIDocumentPickerViewController(forExporting: [src], asCopy: true)
            picker.delegate = self
            // 下へスワイプして閉じられないようにする（閉じるのは「キャンセル」か保存だけ。スワイプでは上の2つが呼ばれない版がある）
            picker.isModalInPresentation = true
            // それでも利用者の操作で閉じられた時（iPad で外側をタップした時など）は、やめたことにする
            picker.presentationController?.delegate = self
            self.picker = picker
            viewController.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pending?.resolve(["uri": urls.first?.absoluteString ?? ""])
        pending = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pending?.reject("Save canceled", "CANCELED")
        pending = nil
    }

    /// 利用者の操作で画面が閉じられた（キャンセル・保存の時や、プログラムで閉じた時は呼ばれない）。
    /// iOS 17 以降は documentPickerWasCancelled も呼ばれることがあるが、pending を空にしているので二重にはならない
    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === picker else { return }
        pending?.reject("Save canceled", "CANCELED")
        pending = nil
    }

    /// Filesystem.getUri の file://…（日本語の名前は %XX になっている。なっていなくても受け取る）
    static func fileURL(_ value: String) -> URL? {
        if let url = URL(string: value), url.isFileURL {
            return url
        }
        if value.hasPrefix("file://") {
            let path = String(value.dropFirst("file://".count))
            return URL(fileURLWithPath: path.removingPercentEncoding ?? path)
        }
        if value.hasPrefix("/") {
            return URL(fileURLWithPath: value)
        }
        return nil
    }
}
