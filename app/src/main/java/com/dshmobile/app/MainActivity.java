package com.dshmobile.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.webkit.HttpAuthHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * DSH Remote —— DeepSeek Harness 手机端壳应用。
 * 全屏 WebView 加载认证代理的 /mobile 界面；服务器地址/账号/密码内置，
 * 只填一次，以后打开即连。WebSocket（审批推送）由 WebView 原生支持。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dsh";
    private static final String KEY_URL = "url";
    private static final String KEY_USER = "user";
    private static final String KEY_PASS = "pass";

    private WebView web;
    private SharedPreferences prefs;
    private TextView connStatus;
    /** 当前允许提交凭证的服务器 host（安全校验：凭证只交给配置的服务器） */
    private volatile String allowedHost = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // 升级迁移：旧版明文密码 → Keystore 加密存储（一次性，无感）
        migrateLegacyPassword();
        web = findViewById(R.id.web);
        connStatus = findViewById(R.id.connStatus);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 全链路 HTTPS（cloudflared 隧道），混合内容默认拒绝（不显式放行）
        // 移动端资源已带版本号（?v=mtime），WebView 无缓存模式确保永远加载最新
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                // 安全校验：只把凭证交给用户配置的服务器地址。
                // 修复 HIGH-1：此前不校验 host，WebView 中任何页面/子资源触发
                // 401 质询都会静默泄露 DSH 用户名密码（可控制整台电脑的钥匙）。
                if (allowedHost != null && allowedHost.equalsIgnoreCase(host)) {
                    // 自动携带内置凭证，手机端无需再输密码
                    String user = prefs.getString(KEY_USER, "dsh");
                    String pass = CredentialStore.decrypt(prefs.getString(KEY_PASS, ""));
                    if (!pass.isEmpty()) {
                        handler.proceed(user, pass);
                        return;
                    }
                }
                handler.cancel();
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                connStatus.setText("连接中…");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                connStatus.setText("已连接");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame() && error != null) {
                    connStatus.setText("连接失败");
                }
            }

        });

        web.setWebChromeClient(new WebChromeClient());

        Button settingsBtn = findViewById(R.id.settingsBtn);
        settingsBtn.setOnClickListener(v -> showSettings());

        String url = prefs.getString(KEY_URL, "");
        if (url.isEmpty()) {
            showSettings();
        } else {
            loadConfigured(url);
        }
    }

    /** 升级迁移：旧版明文密码 → Keystore 加密存储（一次性，无感）。 */
    private void migrateLegacyPassword() {
        String p = prefs.getString(KEY_PASS, "");
        if (!p.isEmpty() && !CredentialStore.isEncrypted(p)) {
            String enc = CredentialStore.encrypt(p);
            if (enc != null) {
                prefs.edit().putString(KEY_PASS, enc).apply();
            }
        }
    }

    /** 加载配置的地址；若填的是域名（自动发现模式），先经 DoH 解析出当前隧道域名。 */
    private void loadConfigured(String url) {
        String u = url.trim();
        // 全链路 HTTPS（cloudflared 隧道）：拒绝明文 http，防止 Basic Auth 密码被中间人嗅探
        if (u.startsWith("https://")) {
            allowedHost = Uri.parse(u).getHost(); // 记录允许提交凭证的服务器
            web.loadUrl(u);
            return;
        }
        if (u.startsWith("http://")) {
            connStatus.setText("仅支持 https 地址");
            android.widget.Toast.makeText(MainActivity.this,
                    "请使用 https:// 开头的地址（明文 http 会泄露密码）",
                    android.widget.Toast.LENGTH_LONG).show();
            return;
        }
        final String host = u;
        connStatus.setText("自动发现中…");
        new Thread(() -> {
            final String tunnel = dohResolve(host);
            new Handler(Looper.getMainLooper()).post(() -> {
                if (tunnel != null && !tunnel.isEmpty()) {
                    allowedHost = tunnel; // 记录解析出的隧道地址（自动发现模式）
                    web.loadUrl("https://" + tunnel + "/mobile");
                } else {
                    connStatus.setText("自动发现失败");
                    android.widget.Toast.makeText(MainActivity.this,
                            "无法解析 " + host + " 的隧道地址，请在设置里填写完整地址（https://…/mobile）",
                            android.widget.Toast.LENGTH_LONG).show();
                }
            });
        }).start();
    }

    /**
     * 通过阿里 DoH（国内可达 + 开放 CORS）查询域名的 DNS 记录，
     * 从响应中提取 CNAME(5)/TXT(16) 里的隧道域名（xxx.trycloudflare.com）。
     */
    private String dohResolve(String host) {
        try {
            String q = Uri.encode(host);
            URL u = new URL("https://dns.alidns.com/resolve?name=" + q + "&type=TXT");
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            c.setRequestMethod("GET");
            c.setRequestProperty("Accept", "application/dns-json");
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            int code = c.getResponseCode();
            if (code != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            in.close();
            JSONObject j = new JSONObject(bos.toString(StandardCharsets.UTF_8.name()));
            JSONArray ans = j.optJSONArray("Answer");
            if (ans == null) return null;
            for (int i = 0; i < ans.length(); i++) {
                JSONObject a = ans.optJSONObject(i);
                if (a == null) continue;
                int type = a.optInt("type", -1);
                String data = a.optString("data", "");
                if ((type == 5 || type == 16) && data.contains("trycloudflare.com")) {
                    return data.replaceFirst("\\.$", "").trim();
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 服务器设置对话框：地址 + 账号 + 密码，保存后立即重连。 */
    private void showSettings() {
        LinearLayout ll = new LinearLayout(this);
        ll.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        ll.setPadding(pad, pad / 2, pad, 0);

        EditText url = new EditText(this);
        url.setHint("服务器地址，如 https://xxx.trycloudflare.com/mobile");
        url.setText(prefs.getString(KEY_URL, ""));
        url.setSingleLine(true);

        EditText user = new EditText(this);
        user.setHint("用户名（默认 dsh）");
        user.setText(prefs.getString(KEY_USER, "dsh"));
        user.setSingleLine(true);

        EditText pass = new EditText(this);
        pass.setHint("密码");
        pass.setText(CredentialStore.decrypt(prefs.getString(KEY_PASS, "")));
        pass.setSingleLine(true);

        ll.addView(url);
        ll.addView(user);
        ll.addView(pass);

        new AlertDialog.Builder(this)
                .setTitle("DSH 服务器设置")
                .setMessage("填完整地址如 https://xxx.trycloudflare.com/mobile；或填固定域名如 mydsh.de5.net（自动发现当前隧道）")
                .setView(ll)
                .setPositiveButton("保存并连接", (d, w) -> {
                    String u = url.getText().toString().trim();
                    // 密码走 Keystore 加密；加密失败宁可存空（下次重填）也不留明文
                    String encPass = CredentialStore.encrypt(pass.getText().toString());
                    prefs.edit()
                            .putString(KEY_URL, u)
                            .putString(KEY_USER, user.getText().toString().trim())
                            .putString(KEY_PASS, encPass == null ? "" : encPass)
                            .apply();
                    if (!u.isEmpty()) loadConfigured(u);
                })
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从后台回来时如果页面为空则重载
        if (web != null && web.getUrl() == null && !prefs.getString(KEY_URL, "").isEmpty()) {
            loadConfigured(prefs.getString(KEY_URL, ""));
        }
    }
}
