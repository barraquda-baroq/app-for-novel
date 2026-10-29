package jp.barraquda.novelstudio;

import android.os.Bundle;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // アプリの中に入れたプラグインは super.onCreate より前に登録する（ファイルの保存。src/platform/saveFile.ts の SaveAs）
        registerPlugin(SaveAsPlugin.class);
        super.onCreate(savedInstanceState);
        // 画面（WebView）の地の色を、起動の画面と同じ無地にする（res/values・values-night の launch_background）。
        // 起動の画面を消してから起動アニメーション（src/launch/launch.js）の最初の絵が出るまでの間に、白が一瞬出ないように
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(ContextCompat.getColor(this, R.color.launch_background));
        }
    }
}
