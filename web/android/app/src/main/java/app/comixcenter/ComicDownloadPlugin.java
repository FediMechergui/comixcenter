package app.comixcenter;

import android.net.Uri;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Direct comic files stream to private disk, never to base64 bridge messages. */
@CapacitorPlugin(name = "ComicDownload")
public class ComicDownloadPlugin extends Plugin {
    private static final long LIMIT = 64L * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final ConcurrentHashMap<String, Transfer> active = new ConcurrentHashMap<>();
    private static class Transfer {
        volatile boolean cancelled, expired;
        volatile HttpURLConnection connection;
        void stop() { if (connection != null) connection.disconnect(); }
    }
    private File directory() { return new File(getContext().getCacheDir(), "comic-downloads"); }
    private boolean validId(String id) { return id != null && id.matches("[a-f0-9-]{36}"); }
    private URL checkedUrl(String value) throws Exception {
        URL url = new URL(value);
        if (!(url.getProtocol().equals("http") || url.getProtocol().equals("https")) || url.getHost().isEmpty() || url.getUserInfo() != null) throw new Exception("Unsupported download address");
        return url;
    }
    private boolean sameOrigin(URL a, URL b) {
        int ap = a.getPort() == -1 ? a.getDefaultPort() : a.getPort();
        int bp = b.getPort() == -1 ? b.getDefaultPort() : b.getPort();
        return a.getProtocol().equals(b.getProtocol()) && a.getHost().equalsIgnoreCase(b.getHost()) && ap == bp;
    }
    @Override public void load() {
        File[] files = directory().listFiles();
        if (files != null) for (File file : files) if (file.isFile() && file.getName().matches("[a-f0-9-]{36}\\.(part|comic)")) file.delete();
    }
    @PluginMethod public void recover(PluginCall call) { call.resolve(); } // load() clears abandoned files once per process.
    @PluginMethod public synchronized void start(PluginCall call) {
        String id = call.getString("id");
        if (!validId(id)) { call.reject("Invalid transfer id"); return; }
        URL url;
        try { url = checkedUrl(call.getString("url")); } catch (Exception error) { call.reject("Use a direct HTTP or HTTPS comic file address"); return; }
        String authorization = call.getString("authorization", "");
        if (authorization.length() > 4096 || authorization.contains("\r") || authorization.contains("\n")) { call.reject("Invalid authorization header"); return; }
        if (!active.isEmpty()) { call.reject("Another download is still active"); return; }
        Transfer transfer = new Transfer(); active.put(id, transfer);
        worker.execute(() -> download(call, id, url, authorization, transfer));
    }
    private void progress(String id, long received, long total) {
        JSObject event = new JSObject(); event.put("id", id); event.put("received", received);
        if (total >= 0) event.put("total", total);
        notifyListeners("progress", event);
    }
    private void download(PluginCall call, String id, URL initial, String authorization, Transfer transfer) {
        File partial = new File(directory(), id + ".part"), complete = new File(directory(), id + ".comic");
        boolean success = false;
        JSObject result = null; String failure = null;
        java.util.concurrent.ScheduledFuture<?> deadline = deadlines.schedule(() -> { transfer.expired = true; transfer.stop(); }, 120, TimeUnit.SECONDS);
        try {
            if (!directory().isDirectory() && !directory().mkdirs()) throw new Exception("Cannot create temporary download storage");
            URL url = initial; HttpURLConnection connection = null;
            for (int redirects = 0; redirects <= 5; redirects++) {
                if (transfer.cancelled || transfer.expired) throw new Exception("Transfer stopped");
                connection = (HttpURLConnection) url.openConnection(); transfer.connection = connection;
                connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("User-Agent", "ComixCenter/0.4.1");
                connection.setRequestProperty("Accept-Encoding", "identity");
                if (!authorization.isEmpty()) connection.setRequestProperty("Authorization", authorization);
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirects == 5) throw new Exception("The download redirected too many times");
                    URL next = checkedUrl(new URL(url, location).toString());
                    if (url.getProtocol().equals("https") && !next.getProtocol().equals("https")) throw new Exception("The source redirected to an insecure connection");
                    if (!sameOrigin(url, next)) authorization = "";
                    connection.disconnect(); url = next; continue;
                }
                if (status < 200 || status >= 300) throw new Exception("The download source answered HTTP " + status);
                break;
            }
            if (connection == null) throw new Exception("The source did not answer");
            long total = connection.getContentLengthLong();
            if (total > LIMIT) throw new Exception("That comic exceeds the 64 MB import limit");
            String type = connection.getContentType();
            if (type != null && type.toLowerCase(Locale.ROOT).contains("text/html")) throw new Exception("The source returned a web page instead of a comic file");
            long received = 0, lastEvent = 0;
            progress(id, 0, total);
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (transfer.cancelled || transfer.expired) throw new Exception("Transfer stopped");
                    received += count;
                    if (received > LIMIT) throw new Exception("That comic exceeds the 64 MB import limit");
                    output.write(buffer, 0, count);
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastEvent > 150) { progress(id, received, total); lastEvent = now; }
                }
            }
            if (transfer.cancelled || transfer.expired) throw new Exception("Transfer stopped");
            if (received == 0 || (total >= 0 && total != received)) throw new Exception("The download was empty or interrupted. Retry the source");
            if (!partial.renameTo(complete)) throw new Exception("Cannot finish the temporary download");
            progress(id, received, total);
            result = new JSObject(); result.put("id", id); result.put("uri", Uri.fromFile(complete).toString()); result.put("received", received);
            success = true;
        } catch (Exception error) {
            failure = transfer.cancelled ? "Download cancelled" : transfer.expired ? "The download exceeded its two-minute limit" :
                error instanceof java.io.IOException ? "The download connection was interrupted. Retry when connected" : error.getMessage();
        } finally {
            deadline.cancel(false); transfer.stop(); partial.delete(); if (!success) complete.delete(); active.remove(id);
        }
        if (success) call.resolve(result); else call.reject(failure == null ? "The download failed" : failure);
    }
    @PluginMethod public void cancel(PluginCall call) {
        Transfer transfer = active.get(call.getString("id", ""));
        if (transfer != null) { transfer.cancelled = true; transfer.stop(); }
        call.resolve();
    }
    @PluginMethod public void discard(PluginCall call) {
        String id = call.getString("id");
        if (!validId(id)) { call.reject("Invalid transfer id"); return; }
        if (active.containsKey(id)) { call.reject("Cancel the active transfer before discarding it"); return; }
        new File(directory(), id + ".part").delete(); new File(directory(), id + ".comic").delete(); call.resolve();
    }
    @Override protected void handleOnDestroy() {
        for (Transfer transfer : active.values()) { transfer.cancelled = true; transfer.stop(); }
        worker.shutdownNow(); deadlines.shutdownNow();
    }
}
