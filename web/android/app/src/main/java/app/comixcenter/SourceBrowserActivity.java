package app.comixcenter;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.content.Intent;
import org.json.JSONObject;
import org.json.JSONTokener;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/** Source-owned content stays in a separate WebView with no Capacitor/native bridge. */
public class SourceBrowserActivity extends AppCompatActivity {
    private WebView browser;
    private TextView address;
    private ProgressBar progress;
    private String initialUrl;
    private String lastUrl;
    private String lastPage = "";
    private int lastScroll;
    private long lastUpdated;
    private boolean closing;
    private boolean restored;
    private boolean restoring;
    private int restoreAttempts;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable sample = new Runnable() {
        @Override public void run() { capturePosition(null); handler.postDelayed(this, 2000); }
    };

    private void restorePosition() {
        if (restored || restoring || browser == null) return;
        restoring = true;
        String page = JSONObject.quote(lastPage == null ? "" : lastPage);
        browser.evaluateJavascript("(()=>{const text=" + page + ";const option=[...document.querySelectorAll('select option')].find(o=>o.textContent.trim()===text);if(text&&!option)return false;if(option){option.parentElement.value=option.value;option.parentElement.dispatchEvent(new Event('change',{bubbles:true}));}setTimeout(()=>window.scrollTo(0," + Math.max(0,lastScroll) + "),500);return true;})()", value -> {
            restoring = false;
            if ("true".equals(value) || ++restoreAttempts >= 20) restored = true;
            else handler.postDelayed(this::restorePosition, 500);
        });
    }

    private void capturePosition(Runnable done) {
        if (browser == null || !restored || !SourceBrowserPlugin.allowed(browser.getUrl())) { if (done != null) done.run(); return; }
        browser.evaluateJavascript("JSON.stringify({url:location.href,scroll:Math.round(window.scrollY),page:[...document.querySelectorAll('select option:checked')].map(o=>o.textContent.trim()).find(t=>/^Page \\d+ \\/ \\d+/.test(t))||''})", value -> {
            try {
                JSONObject position = new JSONObject((String) new JSONTokener(value).nextValue());
                if (SourceBrowserPlugin.allowed(position.optString("url"))) {
                    lastUrl = position.getString("url"); lastScroll = Math.max(0, position.optInt("scroll"));
                    lastPage = position.optString("page", "");
                    position.put("updated", System.currentTimeMillis());
                    getSharedPreferences("source-reading", MODE_PRIVATE).edit().putString(initialUrl, position.toString()).apply();
                }
            } catch (Exception ignored) { /* Some challenge documents cannot be sampled. */ }
            if (done != null) done.run();
        });
    }

    @Override public void finish() {
        if (closing) return;
        closing = true;
        Runnable complete = () -> {
            if (isFinishing()) return;
            Intent result = new Intent(); result.putExtra("url", lastUrl); result.putExtra("page", lastPage); result.putExtra("scroll", lastScroll);
            setResult(RESULT_OK, result); super.finish();
        };
        capturePosition(complete);
        handler.postDelayed(() -> { if (!isFinishing()) complete.run(); }, 700);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent().getStringExtra("url");
        if (!SourceBrowserPlugin.allowed(url)) { finish(); return; }
        initialUrl = url; lastUrl = url;
        try {
            JSONObject saved = new JSONObject(getSharedPreferences("source-reading", MODE_PRIVATE).getString(url, "{}"));
            if (SourceBrowserPlugin.allowed(saved.optString("url"))) {
                lastUrl = saved.getString("url"); lastScroll = saved.optInt("scroll"); lastPage = saved.optString("page");
                lastUpdated = saved.optLong("updated");
            }
        } catch (Exception ignored) { /* First visit. */ }
        long externalUpdated = 0;
        try { externalUpdated = Long.parseLong(getIntent().getStringExtra("resumeUpdated")); } catch (Exception ignored) { }
        if (externalUpdated > lastUpdated && SourceBrowserPlugin.allowed(getIntent().getStringExtra("resumeUrl"))) {
            lastUrl = getIntent().getStringExtra("resumeUrl"); lastScroll = getIntent().getIntExtra("resumeScroll", 0);
            lastPage = getIntent().getStringExtra("resumePage");
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(20, 22, 25));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        Button close = new Button(this); close.setText("Close"); close.setOnClickListener(v -> finish());
        toolbar.addView(close);
        address = new TextView(this); address.setTextColor(Color.WHITE); address.setTextSize(14);
        address.setPadding(12, 12, 12, 12); address.setMaxLines(2);
        toolbar.addView(address, new LinearLayout.LayoutParams(0, -2, 1));
        Button reload = new Button(this); reload.setText("Reload"); reload.setOnClickListener(v -> browser.reload());
        toolbar.addView(reload); root.addView(toolbar);
        TextView note = new TextView(this); note.setText("Source reader - Your place is saved. Complete any verification here.");
        note.setTextColor(Color.LTGRAY); note.setPadding(16, 8, 16, 8); root.addView(note);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); root.addView(progress);
        browser = new WebView(this);
        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setBuiltInZoomControls(true); settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        browser.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value); progress.setVisibility(value < 100 ? android.view.View.VISIBLE : android.view.View.GONE);
            }
        });
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (SourceBrowserPlugin.allowed(request.getUrl().toString())) return false;
                address.setText("This link is outside the supported comic sources."); return true;
            }
            @Override public void onPageStarted(WebView view, String next, android.graphics.Bitmap icon) {
                address.setText(android.net.Uri.parse(next).getHost());
            }
            @Override public void onPageFinished(WebView view, String next) {
                CookieManager.getInstance().flush();
                restorePosition();
            }
            @Override public void onPageCommitVisible(WebView view, String next) { restorePosition(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) address.setText("Source unavailable. Tap Reload to retry.");
            }
        });
        root.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { if (browser.canGoBack()) browser.goBack(); else finish(); }
        });
        if (state == null || browser.restoreState(state) == null) browser.loadUrl(lastUrl);
    }
    @Override protected void onSaveInstanceState(Bundle state) { browser.saveState(state); super.onSaveInstanceState(state); }
    @Override protected void onPause() { handler.removeCallbacks(sample); capturePosition(null); if (browser != null) browser.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (browser != null) { browser.onResume(); handler.postDelayed(sample, 2000); } }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); if (browser != null) { browser.stopLoading(); browser.destroy(); } super.onDestroy(); }
}
