package app.comixcenter;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;

@CapacitorPlugin(name = "SourceBrowser")
public class SourceBrowserPlugin extends Plugin {
    static boolean allowed(String value) {
        if (value == null) return false;
        Uri uri = Uri.parse(value);
        String host = uri.getHost();
        return "https".equals(uri.getScheme()) && uri.getUserInfo() == null
            && (uri.getPort() == -1 || uri.getPort() == 443)
            && ("batcave.biz".equals(host) || "readcomicsonline.ru".equals(host)
                || "getcomics.org".equals(host) || "www.getcomics.org".equals(host));
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (!allowed(url)) { call.reject("Unsupported source address"); return; }
        getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(getContext(), SourceBrowserActivity.class);
            intent.putExtra("url", url);
            intent.putExtra("resumeUrl", call.getString("resumeUrl"));
            intent.putExtra("resumePage", call.getString("resumePage", ""));
            intent.putExtra("resumeScroll", call.getInt("resumeScroll", 0));
            intent.putExtra("resumeUpdated", call.getString("resumeUpdated", "0"));
            startActivityForResult(call, intent, "sourceClosed");
        });
    }

    @ActivityCallback
    private void sourceClosed(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject saved = new JSObject();
        Intent data = result.getData();
        if (data != null && allowed(data.getStringExtra("url"))) {
            saved.put("url", data.getStringExtra("url"));
            saved.put("page", data.getStringExtra("page"));
            saved.put("scroll", data.getIntExtra("scroll", 0));
        }
        call.resolve(saved);
    }
}
