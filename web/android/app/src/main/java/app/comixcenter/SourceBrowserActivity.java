package app.comixcenter;

import android.graphics.Color;
import android.os.Bundle;
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

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent().getStringExtra("url");
        if (!SourceBrowserPlugin.allowed(url)) { finish(); return; }
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
        TextView note = new TextView(this); note.setText("Source reader ? Complete any verification here. Back returns to the previous page.");
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
            @Override public void onPageFinished(WebView view, String next) { CookieManager.getInstance().flush(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) address.setText("Source unavailable. Tap Reload to retry.");
            }
        });
        root.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { if (browser.canGoBack()) browser.goBack(); else finish(); }
        });
        if (state == null || browser.restoreState(state) == null) browser.loadUrl(url);
    }
    @Override protected void onSaveInstanceState(Bundle state) { browser.saveState(state); super.onSaveInstanceState(state); }
    @Override protected void onPause() { if (browser != null) browser.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (browser != null) browser.onResume(); }
    @Override protected void onDestroy() { if (browser != null) { browser.stopLoading(); browser.destroy(); } super.onDestroy(); }
}
