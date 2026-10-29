package jp.barraquda.novelstudio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // アプリの中に入れたプラグインは super.onCreate より前に登録する（ファイルの保存。src/platform/saveFile.ts の SaveAs）
        registerPlugin(SaveAsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
