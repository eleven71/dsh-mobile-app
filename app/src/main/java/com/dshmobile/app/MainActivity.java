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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
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
                // 自动携带内置凭证，手机端无需再输密码
                String user = prefs.getString(KEY_USER, "dsh");
                String pass = prefs.getString(KEY_PASS, "");
                if (!pass.isEmpty()) {
                    handler.proceed(user, pass);
                } else {
                    handler.cancel();
                }
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

    /** 加载配置的地址；若填的是域名（自动发现模式），先经 DoH 解析出当前隧道域名。 */
    private void loadConfigured(String url) {
        if (url.startsWith("http")) {
            web.loadUrl(url);
            return;
        }
        final String host = url.trim();
        connStatus.setText("自动发现中…");
        new Thread(() -> {
            final String tunnel = dohResolve(host);
            new Handler(Looper.getMainLooper()).post(() -> {
                if (tunnel != null && !tunnel.isEmpty()) {
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
        url.setHint("服务器地址，如 http://192.168.1.100:8082/mobile");
        url.setText(prefs.getString(KEY_URL, ""));
        url.setSingleLine(true);

        EditText user = new EditText(this);
        user.setHint("用户名（默认 dsh）");
        user.setText(prefs.getString(KEY_USER, "dsh"));
        user.setSingleLine(true);

        EditText pass = new EditText(this);
        pass.setHint("密码");
        pass.setText(prefs.getString(KEY_PASS, ""));
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
                    prefs.edit()
                            .putString(KEY_URL, u)
                            .putString(KEY_USER, user.getText().toString().trim())
                            .putString(KEY_PASS, pass.getText().toString())
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
