package app.comixcenter;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SourceBrowserPlugin.class);
        registerPlugin(ComicDownloadPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new RouteAwareWebViewClient(bridge));
    }

    /**
     * The web app is a static export with one index.html per route (/library/index.html, ...).
     * Capacitor's file server answers every extension-less path with the root index.html, which
     * would open the home screen on a reload or deep link. Serve the route's own page instead.
     */
    static class RouteAwareWebViewClient extends BridgeWebViewClient {

        private final Bridge bridge;

        RouteAwareWebViewClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String path = url.getPath();
            if ("localhost".equals(url.getHost()) && path != null && path.length() > 1 && !hasExtension(path)) {
                String asset = "public" + (path.endsWith("/") ? path : path + "/") + "index.html";
                try {
                    InputStream page = bridge.getContext().getAssets().open(asset);
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-cache");
                    return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers, page);
                } catch (IOException notARoute) {
                    // Not one of our pages: let Capacitor handle it
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        private static boolean hasExtension(String path) {
            String last = path.substring(path.lastIndexOf('/') + 1);
            return last.contains(".");
        }
    }
}
