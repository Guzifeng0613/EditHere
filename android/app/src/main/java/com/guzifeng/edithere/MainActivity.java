package com.guzifeng.edithere;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * EditHere 安卓壳：加载离线单文件 Web 版，桥接文件选择、下载与剪贴板，
 * 注入 bridge.js 完成双指缩放/平移手势翻译。页面本身零修改。
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK = 1001;
    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private final StringBuilder fileBuffer = new StringBuilder();

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false); // file:///android_asset 仍可访问

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                injectBridge(view);
            }

            // 页面是离线单文件；桥接对象暴露了写文件能力，禁止一切非 asset 导航，
            // 防止被注入的页面跳转到外部站点后继续调用 AndroidBridge。
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                return !(u.startsWith("file:///android_asset/") || u.startsWith("blob:")
                        || u.startsWith("data:") || u.startsWith("javascript:"));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                // 页面 accept 含 image/* video/* .json .zip .edithere-web
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "image/*", "video/*", "application/json", "text/plain",
                        "application/zip", "application/octet-stream"});
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_PICK);
                } catch (Exception e) {
                    pickCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }
        });

        web.loadUrl("file:///android_asset/EditHere.html");
    }

    private void injectBridge(WebView view) {
        try (InputStream in = getAssets().open("bridge.js");
             java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            view.evaluateJavascript(out.toString("UTF-8"), null);
        } catch (Exception e) {
            toast("注入桥接失败: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || pickCallback == null) return;
        Uri[] uris = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                uris = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) uris[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[]{data.getData()};
            }
        }
        pickCallback.onReceiveValue(uris);
        pickCallback = null;
    }

    private boolean exiting;

    /**
     * 页面用 beforeunload 拦未保存退出，但 WebView 不触发它。已有素材打开时
     * 返回键先确认：可直接「保存项目」或丢弃退出；没有素材时直接退出。
     */
    @Override
    public void onBackPressed() {
        if (exiting) { super.onBackPressed(); return; }
        web.evaluateJavascript("(function(){var b=document.getElementById('export');return !!b&&!b.disabled;})()", value -> {
            if (!"true".equals(value)) { finish(); return; }
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("退出编辑？")
                    .setMessage("未保存的批注和布局调整会丢失。可先「保存项目」到下载目录。")
                    .setPositiveButton("保存项目", (d, w) -> web.evaluateJavascript(
                            "(function(){var t=document.getElementById('utility-toggle'),b=document.getElementById('save-project');"
                                    + "if(t&&getComputedStyle(t).display!=='none'&&t.getAttribute('aria-expanded')!=='true')t.click();"
                                    + "if(b&&!b.disabled)b.click();})()", null))
                    .setNegativeButton("不保存退出", (d, w) -> { exiting = true; finish(); })
                    .setNeutralButton("取消", null)
                    .show());
        });
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    /** JS 桥：剪贴板 + 分块文件保存（避免超大 base64 单次跨桥）。 */
    private class Bridge {
        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("EditHere", text));
                toast("JSON 已复制到剪贴板");
            });
        }

        @JavascriptInterface
        public void beginFile() {
            synchronized (fileBuffer) { fileBuffer.setLength(0); }
        }

        @JavascriptInterface
        public void appendFile(String base64Chunk) {
            synchronized (fileBuffer) { fileBuffer.append(base64Chunk); }
        }

        @JavascriptInterface
        public void endFile(String name, String mime) {
            String base64;
            synchronized (fileBuffer) {
                base64 = fileBuffer.toString();
                fileBuffer.setLength(0);
            }
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty()
                            ? "application/octet-stream" : mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(
                            MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new IllegalStateException("MediaStore 插入失败");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        out.write(bytes);
                    }
                } else {
                    // API 26–28 写公共下载目录需运行时权限
                    if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1002);
                        toast("需要存储权限才能保存，请授权后重试");
                        return;
                    }
                    File dir = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File f = new File(dir, safe);
                    try (OutputStream out = new FileOutputStream(f)) {
                        out.write(bytes);
                    }
                }
                toast("已保存到下载目录: " + safe);
            } catch (Exception e) {
                toast("保存失败: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void log(String msg) {
            android.util.Log.i("EditHereBridge", msg);
        }
    }
}