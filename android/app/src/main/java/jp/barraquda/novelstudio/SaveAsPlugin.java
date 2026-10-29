package jp.barraquda.novelstudio;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * ファイルの保存先を選んでもらう（src/platform/saveFile.ts の SaveAs）。
 * アプリの一時置き場（Cache）に書いたファイルを、Android の「保存」の画面（ACTION_CREATE_DOCUMENT）で選んだ場所へコピーする。
 * 権限は要らない。やめた時は "Save canceled"（code CANCELED）で reject する（saveFile.ts の isSaveCancel が「やめた」と見る）
 */
@CapacitorPlugin(name = "SaveAs")
public class SaveAsPlugin extends Plugin {

    @PluginMethod
    public void saveAs(PluginCall call) {
        File src = sourceFile(call.getString("path"));
        if (src == null || !src.isFile()) {
            call.reject("保存するファイルが見つかりません");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mimeType", "application/octet-stream"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("fileName", "file"));
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Save canceled", "CANCELED");
            // startActivityForResult が控えた呼び出しは、終わったら手放す（残しておくと保存のたびに溜まる）
            bridge.releaseCall(call);
            return;
        }
        Uri dest = data.getData();
        File src = sourceFile(call.getString("path"));
        // コピーは画面の処理（メインスレッド）の外で行う
        bridge.execute(() -> {
            // "wt": 同じ名前のファイルを選んで上書きした時に、前の中身を残さない
            try (InputStream in = new FileInputStream(src); OutputStream out = getContext().getContentResolver().openOutputStream(dest, "wt")) {
                if (out == null) throw new java.io.IOException("保存先を開けませんでした");
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
                JSObject ret = new JSObject();
                ret.put("uri", dest.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("保存できませんでした: " + e.getMessage(), e);
            } finally {
                bridge.releaseCall(call);
            }
        });
    }

    /** Filesystem.getUri の file://…（日本語の名前は %XX になっている）を、端末のファイルにする */
    private static File sourceFile(String path) {
        if (path == null) return null;
        Uri uri = Uri.parse(path);
        if ("file".equals(uri.getScheme()) && uri.getPath() != null) return new File(uri.getPath());
        if (path.startsWith("/")) return new File(path);
        return null;
    }
}
