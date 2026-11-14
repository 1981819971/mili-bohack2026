package com.mili.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Locale;

public class MainActivity extends Activity {
    private WebView web;
    /* 拍照待写回的 Uri（onActivityResult 要用，必须在 Activity 层） */
    /* 静态：系统相机回来时 Activity 可能被重建，实例字段会丢， Uri 一丢
       照片就永远回不到网页 —— 这是「拍了药盒没反应」的一个老坑。 */
    private static android.net.Uri pendingShot;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private Actions actions;
    private DouyinPlayback douyinPlayback;
    private Vision vision;
    private android.webkit.ValueCallback<Uri[]> fileCb = null;
    private IrBlaster ir;
    private Llm llm;
    private Band band;
    private static final int REQ_CAM = 21;
    /* 扫二维码配对。扫到回来走 onActivityResult → pushScan。 */
    private static final int REQ_SCAN = 1009;
    /* 手环蓝牙权限（Android 12 起 SCAN/CONNECT 要单独要） */
    private static final int REQ_BAND = 1004;
    /* 线上页面 URL 的版本号。改了线上代码就改这个数字 ——
       WebView 会拿它当新的请求路径，不会继续吃旧缓存。 */
    private static final String BUILD_TAG = "241110p";

    /* 默认「包里有就用包里的」。带上 -e live 1 启动时全部走网络，
       用来验证线上部署的那份到底长什么样 —— 不重装也能对比。 */
    private boolean netFirst = false;

    /* 唤醒词：一直在听，听到「米粒」就弹说话层 */

    /** 藏起系统状态栏和导航栏。
        用 TRANSIENT_BARS_BY_SWIPE：老人从屏幕边上一划还能临时叫回来，
        不会出现「全屏以后退不出去」这种事。 */
    private void hideSystemBars() {
        try {
            /* 挖孔屏：不声明这个，状态栏藏了、内容也不往上长，
               顶上就留一条黑边（实测小米 24117RK2CC 就是这样）。 */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                getWindow().setAttributes(lp);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                getWindow().setDecorFitsSystemWindows(false);
                android.view.WindowInsetsController ic = getWindow().getInsetsController();
                if (ic != null) {
                    ic.hide(android.view.WindowInsets.Type.systemBars());
                    ic.setSystemBarsBehavior(
                            android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                                | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        } catch (Throwable ignored) {}
    }

    /* 弹窗、切回来、系统栏自己冒出来的时候都会重设一次，
       否则过一会儿状态栏又回来了（immersion 不是一次性的）。 */
    @Override
    public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) hideSystemBars();
    }

    /* 跌落检测要把确认层推到网页上，而传感器跑在 MilService 里，
       两者之间没有现成的引用。这里留一个静态口子：
       MilService → MainActivity.runJs() → evaluateJavascript。
       Activity 不在（没打开过 App）时返回 false，调用方自己兜底。 */
    public static MainActivity INST = null;

    public static boolean runJs(String js) {
        MainActivity a = INST;
        if (a == null || a.web == null) return false;
        final String code = js;
        final MainActivity act = a;
        a.ui.post(new Runnable() {
            @Override public void run() {
                try { act.web.evaluateJavascript(code, null); } catch (Throwable ignored) {}
            }
        });
        return true;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        INST = this;

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        /* ================= 真全屏 =================
           2026-11-05 菲尔特：「能不能真正的全屏，不要顶部的时间、日期和右边三个点」
           以前只删掉了网页里那条假状态栏，系统那条还在 —— 真机上就是两条时间叠着，
           删了一条还剩一条。这里把系统栏整条藏起来。
           用 immersive sticky：老人从边上滑一下还能临时叫出来，不会把自己关死。 */
        hideSystemBars();
        getWindow().setStatusBarColor(0xFFF2F2F5);
        getWindow().setNavigationBarColor(0xFFF2F2F5);

        /* 语速：上次调过的档位要接着用。
           老人说过一次「快一点」，第二次开机不能又回到默认速 —— 那等于他白说了。 */
        try {
            int saved = getSharedPreferences("mili", MODE_PRIVATE).getInt("ttsRate", -999);
            if (saved > -999) Doubao.speechRate = Math.max(-50, Math.min(100, saved));
        } catch (Throwable ignored) {}

        /* 一进 App 就把桌宠和离线唤醒拉起来。
           以前靠网页那边喊一声 startPet，网页没加载出来宠物就永远不出现 ——
           「办事的时候怎么没有悬浮窗」的根子在这儿。现在原生自己起，跟网页无关。 */
        try {
            /* 先把「我在前台」标上，再拉服务。
               服务是异步起来的，onResume 那次 setAppForeground 遇到 INST==null 会直接
               返回；不提前标这一笔，悬浮窗一挂出来就是可见的，App 里就多一只鸡。 */
            MilService.foregroundNow = true;
            if (android.provider.Settings.canDrawOverlays(this)) {
                Intent pi = new Intent(this, MilService.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(pi);
                else startService(pi);
                android.util.Log.i("MiliPet", "MainActivity 拉起桌宠");
            }
        } catch (Exception e) {
            android.util.Log.i("MiliPet", "拉起桌宠失败 " + e);
        }

        /* 🚨 22:0x：清数据 / 新装后系统会把无障碍开关抹成 null，而
           A11yKeeper 的 ticker 挂在无障碍服务里 —— 服务起不来就永远不自愈，
           微信和抖音的自动点击全废。这里由 Activity 独立补一次（后台线程，
           check 里重绑会占约 1 秒）。没 WRITE_SECURE_SETTINGS 就安静跳过。 */
        new Thread(new Runnable() { @Override public void run() {
            try { A11yKeeper.check(MainActivity.this); } catch (Throwable ignored) {}
        } }, "a11y-boot").start();

        /* 来电/微信来电自动接听：挂上监听，并把「接通了」的播报送回网页。
           进程活着就一直在听，跟网页加载没没关系 —— 来电不会等人。 */
        CallAnswer.init(this);
        CallAnswer.js = js -> ui.post(() -> {
            if (web != null) { try { web.evaluateJavascript(js, null); } catch (Throwable ignored) {} }
        });

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        /* 别弹「保存账号密码」那个框。实测注册完就弹一个蓝白大框挡在中间，
           老人不知道该点哪个，也不敢点。那是给浏览器用户用的，不是给他用的。 */
        s.setSaveFormData(false);
        s.setSavePassword(false);
        /* 页面是 https（托管域名），米粒自己的服务器是 http（YOUR_SERVER_HOST:9001，没有证书）。
           不放开这个开关，登录、配对、药箱全部会被 WebView 当「混合内容」直接掐断 ——
           而且报错在控制台里，界面上只会显示「连不上」，看不出来是被拦的。
           只放行混合内容，不放开任何别的策略。 */
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        /* 分享页会拦 WebView 的 UA（带 ; wv) 标记）—— 手机 Chrome 能开、App 里被拦，
           就是这个差别。伪装成正常 Chrome。 */
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        /* 每次启动都拿线上最新的。
           默认缓存模式下 WebView 会把 app.js 缓存住，线上改了代码手机还在跑旧的 ——
           结果就是「明明修好了，手机上还是老样子」，只有清缓存才生效。
           这个坑在真机上很隐蔽：页面能开、功能不报错，只是它跑的是一份旧逻辑。
           LOAD_NO_CACHE 配合下面 URL 上的版本号，两边都堵住。 */
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            /* ================= 只拦大资源，不拦逻辑 =================
               2026-11-05 踩到的坑：这里原来把线上域名下的 app.js / agent.js /
               agent-tools.js / app.css / index.html 全换成包里那份。
               结果是「页面看着是线上版，跑的是包里 21:50 的旧代码」——
               我在电脑上改了一整天智能体，手机上一点变化都没有，
               还以为是模型不行。
               要改的地方就在这一行判断：原来只有 vendor/ 和 assets/ 从包里出，页面本身走线上。
               2026-11-06 改成「包里有就用包里的」，理由很实在 —— 线上站点还停在旧版
               （发布被账号权限卡住），APK 装到手机上看见的是旧界面，跟本地验的完全两套。
               改成包内优先之后：装什么版本就是什么版本，断网也能开，跟线上不一致的风险归零。
               线上那边一旦发不出去，也不至于整个 App 停在旧版。
               注意：找不到就 return null 落回网络，不会把页面弄坏。 */
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView v, android.webkit.WebResourceRequest req) {
                try {
                    Uri u = req.getUrl();
                    if (netFirst) return null;   // 调试口：-e live 1，强制全走线上
                    if (u != null && "mili.app.workbuddy.host".equals(u.getHost())) {
                        String raw = u.getPath();
                        String rel = (raw == null) ? "" : (raw.startsWith("/") ? raw.substring(1) : raw);
                        /* 访问根路径时 rel 是空串。这里必须当成 index.html，
                           否则整份 HTML 会漏回网络、拿线上旧版，而 js/css 走包里新版 ——
                           新 js 找不到旧 HTML 里的节点，页面就是一片空白。
                           2026-11-06 就是这么白了一整页，查了很久。 */
                        if (rel.length() == 0) rel = "index.html";
                        if (!rel.contains("..")) {
                            android.webkit.WebResourceResponse r = fromAssets("/" + rel);
                            if (r != null) return r;
                        }
                    }
                } catch (Throwable ignored) {}
                return null;      // 包里没有的（比如以后新加的接口）照旧走网络
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                /* 断网就直说，别甩系统错误页。老人看到英文错误码只会更慌。 */
                String html = "<html><body style=\"background:#F2F2F5;font-family:sans-serif;"
                        + "display:grid;place-items:center;height:100%;margin:0\">"
                        + "<div style=\"text-align:center;padding:0 32px\">"
                        + "<p style=\"font-size:44px;margin:0\">🐥</p>"
                        + "<p style=\"font-size:19px;color:#3F3F46;margin:14px 0 6px\">网络断了一会儿</p>"
                        + "<p style=\"font-size:15px;color:#6B6B73;line-height:1.6\">联上网，我马上就回来</p>"
                        + "<button onclick=\"location.reload()\" style=\"margin-top:22px;border:0;border-radius:22px;"
                        + "background:#14151A;color:#fff;font-size:16px;padding:12px 34px\">再试一次</button>"
                        + "</div></body></html>";
                v.loadData(html, "text/html; charset=utf-8", "utf-8");
            }
        });
        /* 必须有 WebChromeClient：不然 prompt() / alert() 在 WebView 里是哑的。
           「添加家人」「加药」「教它一条」三个入口全用 prompt()，
           没有这个回调就是点了没反应 —— 现场演示直接断在这儿。 */
        web.setWebChromeClient(new WebChromeClient() {
            /* 2026-11-10：网页 console 一律转进 logcat。
               以前前端查「连续对话开了 2 毫秒就被关掉」只能靠猜，
               这次直接把 JS 那边的调用栈看到了 —— 现场排障也用得上。 */
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                if (m == null) return false;
                String tag = "MiliWeb";
                String msg = m.message() + "  @" + m.sourceId() + ":" + m.lineNumber();
                switch (m.messageLevel()) {
                    case ERROR: android.util.Log.e(tag, msg); break;
                    case WARNING: android.util.Log.w(tag, msg); break;
                    default: android.util.Log.i(tag, msg);
                }
                return true;
            }

            /* 网页要摄像头（getUserMedia）就给：拍药盒、未来的实景层都走这条 */
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try { request.grant(request.getResources()); } catch (Exception ignored) {}
                    }
                });
            }

            /* <input type=file> 的系统选择器：网页版通用的拍照上传路径 */
            @Override
            public boolean onShowFileChooser(WebView v, android.webkit.ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    try {
                        startActivityForResult(
                                android.content.Intent.createChooser(i, "选照片"), 777);
                    } catch (Exception e) {
                        startActivityForResult(i, 777);
                    }
                    fileCb = cb;
                    return true;
                } catch (Exception e) { return false; }
            }


            @Override
            public boolean onJsPrompt(WebView v, String url, String message,
                                      String defaultValue, final JsPromptResult result) {
                try {
                    final EditText et = new EditText(MainActivity.this);
                    et.setText(defaultValue == null ? "" : defaultValue);
                    et.setSelection(et.getText().length());
                    et.setTextSize(18);
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle(message)
                            .setView(et)
                            .setCancelable(false)
                            .setPositiveButton("好", new DialogInterface.OnClickListener() {
                                @Override public void onClick(DialogInterface d, int w) {
                                    result.confirm(et.getText().toString());
                                }
                            })
                            .setNegativeButton("算了", new DialogInterface.OnClickListener() {
                                @Override public void onClick(DialogInterface d, int w) {
                                    result.cancel();
                                }
                            })
                            .show();
                } catch (Exception e) {
                    result.confirm(defaultValue);
                }
                return true;
            }

            @Override
            public boolean onJsAlert(WebView v, String url, String message, final JsResult result) {
                try {
                    new AlertDialog.Builder(MainActivity.this)
                            .setMessage(message)
                            .setCancelable(false)
                            .setPositiveButton("知道了", new DialogInterface.OnClickListener() {
                                @Override public void onClick(DialogInterface d, int w) { result.confirm(); }
                            })
                            .show();
                } catch (Exception e) { result.confirm(); }
                return true;
            }
        });
        web.setBackgroundColor(0xFFF2F2F5);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        /* 2026-11-07 真机回归用：只给 debug 包开 WebView 远程调试，
           adb forward 后可在真机 WebView 里逐句跑 MILI_AGENT.run(原话)。
           发布包 BuildConfig.DEBUG=false，这一行不会生效。 */
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            WebView.setWebContentsDebuggingEnabled(true);
        web.addJavascriptInterface(new Bridge(), "MiliNative");

        initTts();
        actions = new Actions(this);
        vision = new Vision(this);
        ir = new IrBlaster(this);
        llm = new Llm(this);
        /* 手环：读到心率就推给网页。网页那边的入口是 window.__bandEv。
           这里不主动扫 —— 扫不扫由老人在「我的」页决定，这里只是把管道接好。 */
        band = new Band(this, new Band.Sink() {
            @Override public void push(final String json) {
                ui.post(new Runnable() { @Override public void run() {
                    try {
                        web.evaluateJavascript(
                            "window.__bandEv && window.__bandEv(" + json + ")", null);
                    } catch (Exception ignored) {}
                }});
            }
        });
        MedAlarm.scheduleAll(this);

        // 线上版：云 LLM 只认部署域名的 Origin，本地 file:// 用不了，
        // 所以不再打包 HTML，直接加载线上版（改版也不用重发 APK）。
        // 线上版：云 LLM 只认部署域名的 Origin。改版 = 重新部署 server/，不用重发 APK。
        // 调试口：adb am start -e url "http://127.0.0.1:8899/mili.html"
        // 带上 url 就加载它（配合 adb reverse 直接跑本地最新构建），不带就走线上。
        String dbgUrl = getIntent() != null ? getIntent().getStringExtra("url") : null;
        netFirst = getIntent() != null && "1".equals(getIntent().getStringExtra("live"));
        // 第二优先：APK 里自带的整页（现场断网也能跑，评委面前不赌网）
        boolean hasLocal = true;
        try { getAssets().open("mili.html").close(); } catch (Exception e) { hasLocal = false; }
        boolean demo = getIntent() != null && "1".equals(getIntent().getStringExtra("demo"));
        /* 🚨 2026-11-07：以前这里加载的是单文件版 mili.html?skip=1 —— URL 固定，
           WebView 把整页缓存住，改十次 CSS 页面上还是老样子（「换台键还在中间」、
           「两只鸡重影修不掉」全是它）。现在优先加载多文件版 web/index.html，
           并且每次启动带新时间戳，缓存彻底失效。单文件版只做兜底。 */
        String vTag = Long.toHexString(System.currentTimeMillis());
        /* 🚨 2026-11-09：正式包不再写死 skip=1。
           产品结构（11-08 拍板）：「老人端为主体，一打开就是引导页」。
           以前 URL 带 skip=1，app.js 读到就把 S.onboarded 置真，
           新装的机器直接跳进桌面 —— 注册 / 认人 / 配对码全被跳过，
           跟「前期注册登录」这条流程对不上。
           现在只有 demo=1（现场演示 / 快速验收）才跳过；
           老用户本来就有 localStorage，routeStart() 会照常直接进桌面。 */
        String skip = demo ? "skip=1&" : "";
        String localUrl = "file:///android_asset/web/index.html?" + skip + "v=" + vTag
                + (demo ? "&demo=1" : "");
        String singleUrl = "file:///android_asset/mili.html?" + skip + "v=" + vTag
                + (demo ? "&demo=1" : "");
        boolean hasWeb = true;
        try { getAssets().open("web/index.html").close(); } catch (Exception e) { hasWeb = false; }
        if (dbgUrl != null && dbgUrl.length() > 8) {
            web.loadUrl(dbgUrl);
        } else if (hasWeb) {
            web.loadUrl(localUrl);
        } else if (hasLocal) {
            web.loadUrl(singleUrl);
        } else {
            /* 带上版本号：线上每次部署都会改 app.js，URL 不变的话 WebView 可能
               直接拿旧的。版本号一改就是新的请求路径，缓存帮不上忙。 */
            web.loadUrl("https://mili.app.workbuddy.host/?sharecode=2DWCREA5M5&v=" + BUILD_TAG);
        handleWake(getIntent());
        }
        setContentView(web);
        /* 2026-11-10 菲尔特：把米粒设成默认桌面后立刻白屏、点什么都没反应。
           MIUI 用 HOME intent 拉起 launcher 时 WebView 偶发拿不到首帧。
           一次性看门狗：4 秒后页面还没 title 就重载本地页，别把人锁在白屏里。 */
        try {
            final String wDbg = dbgUrl, wLocal = localUrl, wSingle = singleUrl;
            final boolean wWeb = hasWeb, wSingleOk = hasLocal;
            final String watchdogUrl = (wDbg != null && wDbg.length() > 8) ? wDbg
                    : (wWeb ? wLocal : (wSingleOk ? wSingle : ""));
            if (!watchdogUrl.isEmpty()) {
                new android.os.Handler(getMainLooper()).postDelayed(new Runnable() {
                    @Override public void run() {
                        try {
                            if (isFinishing() || isDestroyed()) return;
                            CharSequence t = web.getTitle();
                            if (t == null || t.length() == 0) {
                                android.util.Log.i("MiliWeb", "首屏空白，重载 " + watchdogUrl);
                                web.loadUrl(watchdogUrl);
                            }
                        } catch (Throwable ignored) {}
                    }
                }, 4000);
            }
        } catch (Throwable ignored) {}

        // 从桌宠点进来的（"我要吃药"之类）
        handleAsk(getIntent());

        askPerms();
        /* 清除数据 / 重装之后，系统授权和本机状态会一起没。
           不弹这一句，老人看到的就是「米粒突然不会收红包了」，谁也不知道为什么。 */
        /* 只在冷启动后 15 秒内自动引导；超时就不再抢界面 */
        guideDeadline = System.currentTimeMillis() + 15000L;
        guideArmed = true;
        new android.os.Handler(getMainLooper()).postDelayed(() -> autoGuidePerms(), 2000);
    }

    /** 四个关键开关的真实状态。不读前端 S.perms —— 那是 localStorage 里的假状态，清数据就没了。 */
    private org.json.JSONObject permState() {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            String acc = getPackageName() + "/" + MiliAccessibilityService.class.getName();
            String on = android.provider.Settings.Secure.getString(
                    getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            o.put("acc", on != null && on.contains(acc));
            String nl = android.provider.Settings.Secure.getString(
                    getContentResolver(), "enabled_notification_listeners");
            o.put("notif", nl != null && nl.contains(getPackageName() + "/" + MiliNotifService.class.getName()));
            o.put("overlay", android.os.Build.VERSION.SDK_INT < 23
                    || android.provider.Settings.canDrawOverlays(this));
            o.put("mic", checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED);
            /* 2026-11-10 菲尔特：「设置里把权限开关专门用一个板块全部收纳进去，
               一目了然」。三项补齐，全部读系统真实状态，不读 localStorage 的假状态。 */
            o.put("camera", checkSelfPermission(android.Manifest.permission.CAMERA)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED);
            o.put("contacts", checkSelfPermission(android.Manifest.permission.READ_CONTACTS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED);
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                o.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(getPackageName()));
            } catch (Throwable t) { o.put("battery", false); }
            /* 2026-11-10 菲尔特：「所有权限开关一个一个引导打开，包括作为默认桌面的开关」。
               只读系统真实 HOME，不读本地标记 —— 老人在系统里改回去也得看得出来。 */
            o.put("home", isDefaultHome());
        } catch (Throwable ignored) {}
        return o;
    }

    /* 清除数据后全自动恢复权限：缺哪个就直接送到哪个系统页，
       从设置页回来（onResume）自动复查，接着送下一个，全齐了才停。
       无障碍开关本身 Android 不让代码代点，必须人亲手按一下 —— 这一下省不掉，
       但米粒会把他送到那一页、回来自己检查，不用他找设置菜单。 */
    private int guideCount = 0;
    private String lastGuide = "";
    private boolean guideArmed = false;
    private long guideDeadline = 0L;

    private String firstMissing(org.json.JSONObject st) {
        if (!st.optBoolean("acc")) return "acc";
        if (!st.optBoolean("notif")) return "notif";
        if (!st.optBoolean("overlay")) return "overlay";
        if (!st.optBoolean("mic")) return "mic";
        return null;
    }

    /** 这台手机当前的默认桌面是不是米粒。 */
    private boolean isDefaultHome() {
        try {
            Intent i = new Intent(Intent.ACTION_MAIN);
            i.addCategory(Intent.CATEGORY_HOME);
            android.content.pm.ResolveInfo r = getPackageManager().resolveActivity(i,
                    android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
            return r != null && r.activityInfo != null
                    && getPackageName().equals(r.activityInfo.packageName);
        } catch (Throwable t) { return false; }
    }

    private void openSettingFor(String k) {
        try {
            if ("home".equals(k)) {
                /* 送到系统的「默认应用 / 主屏幕」那一页，由老人亲手选，绝不代点。 */
                try {
                    startActivity(new Intent(android.provider.Settings.ACTION_HOME_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Throwable t1) {
                    Intent i = new Intent(Intent.ACTION_MAIN);
                    i.addCategory(Intent.CATEGORY_HOME);
                    startActivity(Intent.createChooser(i, "选默认桌面"));
                }
            } else if ("acc".equals(k)) {
                startActivity(new Intent("android.settings.ACCESSIBILITY_SETTINGS")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if ("notif".equals(k)) {
                startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if ("overlay".equals(k)) {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:" + getPackageName())));
            } else if ("mic".equals(k)) {
                askPerms();
            } else if ("camera".equals(k) || "contacts".equals(k)) {
                /* 运行时权限已经 grant 过；真要改只能去系统应用详情那一页。 */
                startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getPackageName()))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if ("battery".equals(k)) {
                /* 不申请 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 权限，
                   只把人送到系统的电池优化列表，由他亲手点。 */
                startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }
        } catch (Throwable ignored) {}
    }

    private void autoGuidePerms() {
        try {
            /* 只弹清单，绝不自动跳设置页。
               实测 MIUI 会反复清掉无障碍授权，自动跳会把老人正在看的电视、
               正在找的剧直接抢走 —— 那比少点一下按钮严重得多。
               数据恢复是全自动的；权限这一下 Android 本来就要人亲手开。 */
            if (!guideArmed || System.currentTimeMillis() > guideDeadline) {
                guideArmed = false;
                return;
            }
            guideArmed = false;      // 一次冷启动最多提示一次
            /* 2026-11-10 菲尔特：清数据后一打开就盖一张「还差几个开关」，
               可引导第 6 屏已经逐项带老人亲手开权限了，这一层纯属重复打扰。
               权限清单保留在设置里手动查，冷启动不再自动弹卡。 */
            return;
        } catch (Throwable ignored) {}
    }

    private void checkPermsOnBoot() {
        try {
            /* 2026-11-08 菲尔特：「不要老是跳出来还差几个开关」。
               以前每次冷启动都弹，点了「以后再说」下次照弹。现在：
               · 点过「以后再说」→ 7 天内绝不再提
               · 一生最多自动提 2 次（权限真缺的时候提两次足够，第三次是骚扰）
               · 想看清单去设置里手动点「权限检查」 */
            android.content.SharedPreferences sp0 = getSharedPreferences("mili_prefs", 0);
            long snooze = sp0.getLong("perm_snooze_until", 0L);
            int cnt = sp0.getInt("perm_card_count", 0);
            if (System.currentTimeMillis() < snooze) return;
            if (cnt >= 1) return;   /* 一生只自动弹一次：看过就够了，之后去设置里手动查 */

            final org.json.JSONObject st = permState();
            java.util.List<String> miss = new java.util.ArrayList<>();
            if (!st.optBoolean("acc")) miss.add("无障碍服务（点按钮、找剧、收红包）");
            if (!st.optBoolean("notif")) miss.add("通知使用权（自动收红包）");
            if (!st.optBoolean("overlay")) miss.add("悬浮窗（桌宠气泡）");
            if (!st.optBoolean("mic")) miss.add("麦克风（跟米粒说话）");
            if (miss.isEmpty()) return;
            showPermCard(st, miss);
        } catch (Throwable ignored) {}
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /* 权限清单卡片。
       2026-11-05 菲尔特：「这个提示无障碍界面好丑」。
       根因很具体：AlertDialog 在 MIUI 上会被系统整个换成它自己的深色弹窗 ——
       黑底、白字、一大坨，跟米粒一点关系都没有。所以这里不用 AlertDialog，
       自己搭一张白卡：图 + 标题 + 三条清单 + 一颗墨黑主按钮，和 App 里其他卡一个样。 */
    private void showPermCard(final org.json.JSONObject st, final java.util.List<String> miss) {
        try {
            try {
                android.content.SharedPreferences sp1 = getSharedPreferences("mili_prefs", 0);
                sp1.edit().putInt("perm_card_count", sp1.getInt("perm_card_count", 0) + 1).apply();
            } catch (Throwable ignored) {}
            final android.app.Dialog dlg = new android.app.Dialog(this, android.R.style.Theme_Translucent_NoTitleBar);
            dlg.requestWindowFeature(Window.FEATURE_NO_TITLE);

            final android.widget.LinearLayout card = new android.widget.LinearLayout(this);
            card.setOrientation(android.widget.LinearLayout.VERTICAL);
            card.setPadding(dp(24), dp(24), dp(24), dp(18));
            android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
            bg.setColor(0xFFFFFFFF);
            bg.setCornerRadius(dp(24));
            card.setBackground(bg);

            /* 图标：米粒自己的图标，让老人一眼知道这是谁在说话 */
            android.widget.ImageView ic = new android.widget.ImageView(this);
            try { ic.setImageResource(getApplicationInfo().icon); } catch (Throwable t) {}
            android.widget.LinearLayout.LayoutParams icp =
                    new android.widget.LinearLayout.LayoutParams(dp(52), dp(52));
            icp.bottomMargin = dp(14);
            ic.setLayoutParams(icp);
            card.addView(ic);

            android.widget.TextView title = new android.widget.TextView(this);
            title.setText("还差几个开关");
            title.setTextColor(0xFF1A1A1C);
            title.setTextSize(21);
            title.setTypeface(null, android.graphics.Typeface.BOLD);
            card.addView(title);

            android.widget.TextView sub = new android.widget.TextView(this);
            sub.setText("清除数据或重装以后，下面这几个要重新打开。不打开我也能陪你说话，只是有些事办不了。");
            sub.setTextColor(0xFF6B6B70);
            sub.setTextSize(14.5f);
            sub.setLineSpacing(dp(3), 1f);
            android.widget.LinearLayout.LayoutParams sp =
                    new android.widget.LinearLayout.LayoutParams(-1, -2);
            sp.topMargin = dp(8);
            sp.bottomMargin = dp(16);
            sub.setLayoutParams(sp);
            card.addView(sub);

            /* 清单：每行一个小圆点 + 一句话。不用「·」字符，位置对不齐。 */
            for (String m : miss) {
                android.widget.LinearLayout row = new android.widget.LinearLayout(this);
                row.setOrientation(android.widget.LinearLayout.HORIZONTAL);
                android.widget.LinearLayout.LayoutParams rp =
                        new android.widget.LinearLayout.LayoutParams(-1, -2);
                rp.bottomMargin = dp(11);
                row.setLayoutParams(rp);

                android.view.View dot = new android.view.View(this);
                android.graphics.drawable.GradientDrawable dg = new android.graphics.drawable.GradientDrawable();
                dg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
                dg.setColor(0xFFEFB55E);
                dot.setBackground(dg);
                android.widget.LinearLayout.LayoutParams dp2 =
                        new android.widget.LinearLayout.LayoutParams(dp(7), dp(7));
                dp2.rightMargin = dp(10);
                dp2.topMargin = dp(7);
                dot.setLayoutParams(dp2);
                row.addView(dot);

                android.widget.TextView tv = new android.widget.TextView(this);
                tv.setText(m);
                tv.setTextColor(0xFF1A1A1C);
                tv.setTextSize(15.5f);
                tv.setLineSpacing(dp(2), 1f);
                tv.setLayoutParams(new android.widget.LinearLayout.LayoutParams(-1, -2));
                row.addView(tv);
                card.addView(row);
            }

            /* 主按钮：墨黑胶囊，跟 App 里那颗一个色 */
            android.widget.TextView go = new android.widget.TextView(this);
            go.setText("去打开");
            go.setTextColor(0xFFFFFFFF);
            go.setTextSize(17);
            go.setTypeface(null, android.graphics.Typeface.BOLD);
            go.setGravity(android.view.Gravity.CENTER);
            android.graphics.drawable.GradientDrawable gb = new android.graphics.drawable.GradientDrawable();
            gb.setColor(0xFF1F1F22);
            gb.setCornerRadius(dp(26));
            go.setBackground(gb);
            android.widget.LinearLayout.LayoutParams gp =
                    new android.widget.LinearLayout.LayoutParams(-1, dp(52));
            gp.topMargin = dp(8);
            go.setLayoutParams(gp);
            go.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    dlg.dismiss();
                    if (!st.optBoolean("acc")) {
                        try { startActivity(new Intent("android.settings.ACCESSIBILITY_SETTINGS")
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
                    } else if (!st.optBoolean("notif")) {
                        try { startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
                    } else if (!st.optBoolean("overlay")) {
                        try { startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                android.net.Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) {}
                    } else askPerms();
                }
            });
            card.addView(go);

            android.widget.TextView later = new android.widget.TextView(this);
            later.setText("以后再说");
            later.setTextColor(0xFF8A8A90);
            later.setTextSize(15);
            later.setGravity(android.view.Gravity.CENTER);
            android.widget.LinearLayout.LayoutParams lp =
                    new android.widget.LinearLayout.LayoutParams(-1, dp(44));
            lp.topMargin = dp(4);
            later.setLayoutParams(lp);
            later.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    try {
                        getSharedPreferences("mili_prefs", 0).edit()
                                .putLong("perm_snooze_until",
                                        System.currentTimeMillis() + 7L * 24 * 3600 * 1000).apply();
                    } catch (Throwable ignored) {}
                    dlg.dismiss();
                }
            });
            card.addView(later);

            dlg.setContentView(card);
            dlg.setCancelable(true);
            Window w = dlg.getWindow();
            if (w != null) {
                w.setBackgroundDrawableResource(android.R.color.transparent);
                w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                WindowManager.LayoutParams lp2 = w.getAttributes();
                lp2.dimAmount = 0.38f;
                w.setAttributes(lp2);
                int sw = getResources().getDisplayMetrics().widthPixels;
                w.setLayout(Math.min(dp(360), (int) (sw * 0.88f)), WindowManager.LayoutParams.WRAP_CONTENT);
            }
            dlg.show();
        } catch (Throwable t) {
            /* 自定义卡片搭不起来（极端机型）才退回系统弹窗 —— 宁可丑，不能什么都不提示 */
            try {
                StringBuilder sb = new StringBuilder("清除数据或重装后，这几个开关要重新打开：\n");
                for (String m : miss) sb.append("· ").append(m).append('\n');
                new android.app.AlertDialog.Builder(this)
                        .setTitle("米粒还差几个开关")
                        .setMessage(sb.toString())
                        .setPositiveButton("去打开", (d, w2) -> {
                            if (!st.optBoolean("acc")) {
                                try { startActivity(new Intent("android.settings.ACCESSIBILITY_SETTINGS")
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
                            } else if (!st.optBoolean("notif")) {
                                try { startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
                            } else if (!st.optBoolean("overlay")) {
                                try { startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                        android.net.Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) {}
                            } else askPerms();
                        })
                        .setNegativeButton("稍后", null)
                        .show();
            } catch (Throwable ignored) {}
        }
    }

    /**
     * 运行时权限。以前一个都没申请 —— 麦克风没授权，桌宠的前台服务直接被系统拒掉；
     * 相机/通讯录/电话同理，点了也没反应。这里一次要齐，但只解释一次。
     */
    private void askPerms() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        java.util.List<String> need = new java.util.ArrayList<>();
        String[] want = {
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.CAMERA,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.CALL_PHONE,
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_SMS,
                // 自动接电话白名单：读来电号 + 替老人接听
                Manifest.permission.READ_PHONE_STATE,
        };
        for (String p : want) {
            try {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) need.add(p);
            } catch (Exception ignored) {}
        }
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != PackageManager.PERMISSION_GRANTED) {
                    need.add("android.permission.POST_NOTIFICATIONS");
                }
            } catch (Exception ignored) {}
        }
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                if (checkSelfPermission("android.permission.ANSWER_PHONE_CALLS")
                        != PackageManager.PERMISSION_GRANTED) {
                    need.add("android.permission.ANSWER_PHONE_CALLS");
                }
            } catch (Exception ignored) {}
        }
        if (need.isEmpty()) return;
        // 分两批：先要最关键的（麦克风+通知），其余的下一轮再要，
        // 一口气弹七八个框老人会懵。
        String[] first = new String[Math.min(2, need.size())];
        for (int i = 0; i < first.length; i++) first[i] = need.get(i);
        try {
            requestPermissions(first, 1001);
        } catch (Exception ignored) {}
    }

    /* 扫码结果回传给网页。空串表示没扫到 / 取消了 ——
       网页那边据此提示「让对方念数字给你」，而不是干等着。 */
    private void pushScan(final String code) {
        try {
            if (web == null) return;
            web.evaluateJavascript("window.__onScan && window.__onScan(" + JSONObject.quote(code) + ")", null);
        } catch (Exception ignored) {}
    }

    @Override
    public void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == 778) {
            /* 拍照回来：不论 RESULT_OK 与否，先看手上有没有图。MIUI 有的版本回 result=0
               但文件其实写进去了，所以以能不能读出来为准。 */
            final android.net.Uri u = pendingShot;
            pendingShot = null;
            if (u == null) return;
            new Thread(new Runnable() { @Override public void run() {
                try {
                    java.io.InputStream is = getContentResolver().openInputStream(u);
                    android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeStream(is);
                    if (is != null) is.close();
                    if (bmp == null) {
                        runOnUiThread(new Runnable() { @Override public void run() {
                            android.widget.Toast.makeText(MainActivity.this,
                                    "这张没拍着，再拍一次", android.widget.Toast.LENGTH_SHORT).show();
                        }});
                        return;
                    }
                    int w = bmp.getWidth(), h = bmp.getHeight();
                    float sc = Math.min(1f, 1024f / Math.max(w, h));
                    android.graphics.Bitmap small = android.graphics.Bitmap.createScaledBitmap(bmp,
                            Math.max(1, Math.round(w * sc)), Math.max(1, Math.round(h * sc)), true);
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, bos);
                    String b64 = android.util.Base64.encodeToString(bos.toByteArray(),
                            android.util.Base64.NO_WRAP);
                    final String js = "window.__onPhoto && window.__onPhoto('" + b64 + "')";
                    runOnUiThread(new Runnable() { @Override public void run() {
                        try { web.evaluateJavascript(js, null); } catch (Throwable t) {}
                    }});
                } catch (Throwable t) {
                    runOnUiThread(new Runnable() { @Override public void run() {
                        android.widget.Toast.makeText(MainActivity.this,
                                "照片读不出来，再拍一张", android.widget.Toast.LENGTH_SHORT).show();
                    }});
                }
            }}).start();
            return;
        }
        if (req == REQ_SCAN) {
            String code = "";
            if (res == RESULT_OK && data != null) {
                try { code = data.getStringExtra(ScanActivity.EXTRA_RESULT); } catch (Exception ignored) {}
            }
            pushScan(code == null ? "" : code);
            return;
        }
        if (req == 777) {
            /* 2026-11-09 22:25 第三次返工：原来整个分支绑在 fileCb != null 上，
               WebView 重建 / 选择器被系统回收时 fileCb 丢了，选了照片也
               静默无反应 —— 菲尔特说的「上传图片失败」。现在不依赖回调对象，
               只要拿到 Uri 就主动把图片送回网页。 */
            Uri picked = null;
            if (res == RESULT_OK && data != null) {
                if (data.getData() != null) picked = data.getData();
                else if (data.getClipData() != null && data.getClipData().getItemCount() > 0)
                    picked = data.getClipData().getItemAt(0).getUri();
            }
            if (picked != null) {
                try {
                    java.io.InputStream is = getContentResolver().openInputStream(picked);
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192]; int n;
                    while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
                    is.close();
                    String b64 = android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP);
                    web.evaluateJavascript("window.__pickedImage && window.__pickedImage('" + b64 + "')", null);
                } catch (Exception e) {
                    android.widget.Toast.makeText(MainActivity.this,
                            "这张照片读不出来，换一张试试", android.widget.Toast.LENGTH_SHORT).show();
                }
            }
            /* out 保持 null：网页那条 change 路就不再重复识别一次，
               但必须给 onReceiveValue 一个结果，否则 <input> 会卡住不能再次点。 */
            android.webkit.ValueCallback<Uri[]> f = fileCb; fileCb = null;
            if (f != null) { try { f.onReceiveValue(null); } catch (Exception ignored) {} }
            return;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == REQ_BAND) {
            /* 蓝牙权限回来。给了就接着开，没给就说清楚为什么读不到 ——
               老人不懂「权限」，他只需要知道「去哪儿打开」。 */
            boolean ok = false;
            try { ok = band.hasPerm(); } catch (Exception ignored) {}
            if (ok) {
                try { band.start(); } catch (Exception ignored) {}
            } else {
                try { web.evaluateJavascript(
                    "window.__bandEv && window.__bandEv({ev:'fail',txt:'没给蓝牙权限，读不到手环'})", null); } catch (Exception ignored) {}
            }
            return;
        }
        if (code == 1003) {
            /* 定位授权回来，告诉「我的」页一声，它自己刷新开关状态 */
            boolean ok = false;
            try {
                ok = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
            } catch (Exception ignored) {}
            try { web.evaluateJavascript("window.__locDone && window.__locDone(" + ok + ")", null); } catch (Exception ignored) {}
            return;
        }
        if (code == 1001) {
            // 剩下的接着要，一次别弹太多
            java.util.List<String> rest = new java.util.ArrayList<>();
            String[] want = {
                    Manifest.permission.CAMERA,
                    Manifest.permission.READ_CONTACTS,
                    Manifest.permission.CALL_PHONE,
                    Manifest.permission.RECEIVE_SMS,
                    Manifest.permission.READ_SMS,
                    // 粗定位就够报天气了，别为了一个温度要精确定位
                    Manifest.permission.ACCESS_COARSE_LOCATION,
            };
            for (String p : want) {
                try {
                    if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) rest.add(p);
                } catch (Exception ignored) {}
            }
            if (!rest.isEmpty()) {
                try {
                    requestPermissions(rest.toArray(new String[0]), 1002);
                } catch (Exception ignored) {}
            }
        }
    }

    /* ================= 前台 / 后台：桌宠让位 =================
       打开米粒时卡片里已经有一只鸡，如果悬浮窗那只也在，就成了「两只鸡」，
       老人会以为多出来一个假的。所以：本界面在前台 → 收起悬浮窗；退回桌面 → 放出来。 */
    @Override
    protected void onResume() {
        super.onResume();
        try { MilService.setAppForeground(true); } catch (Throwable ignored) {}
        /* 从系统设置页回来才复查；引导窗口过了就别再抢界面 */
        if (guideArmed) {
            new android.os.Handler(getMainLooper()).postDelayed(() -> autoGuidePerms(), 800);
        }
    }

    @Override
    protected void onPause() {
        try { MilService.setAppForeground(false); } catch (Throwable ignored) {}
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        setIntent(it);
        handleWake(it);
        handleAsk(it);
    }

    /** 把 APK 里的 web/ 目录当网站用。找不到就返回 null，自动回落到网络。 */
    private android.webkit.WebResourceResponse fromAssets(String path) {
        String rel = path.startsWith("/") ? path.substring(1) : path;
        if (rel.isEmpty() || rel.contains("..")) return null;
        String mime = rel.endsWith(".js") ? "application/javascript"
                : rel.endsWith(".css") ? "text/css"
                : rel.endsWith(".html") ? "text/html"
                : rel.endsWith(".json") ? "application/json"
                : rel.endsWith(".png") ? "image/png"
                : rel.endsWith(".jpg") || rel.endsWith(".jpeg") ? "image/jpeg"
                : rel.endsWith(".webp") ? "image/webp"
                : rel.endsWith(".svg") ? "image/svg+xml"
                : rel.endsWith(".woff2") ? "font/woff2"
                : rel.endsWith(".mp3") ? "audio/mpeg"
                : "application/octet-stream";
        try {
            java.io.InputStream in = getAssets().open("web/" + rel);
            android.webkit.WebResourceResponse r =
                    new android.webkit.WebResourceResponse(mime, "utf-8", in);
            return r;
        } catch (Throwable e) {
            return null;
        }
    }

    /* ================= 叫了一声「米粒」 =================
       熄屏时被叫：先把屏幕点亮（setTurnScreenOn 是 Android 8.1+ 的正规做法，
       比拿 WakeLock 硬点亮更省事，也不用 WAKE_LOCK 权限），再把说话界面抬出来。
       老人叫一声就该看到东西在动、听到有人在答应，不然就是「它没理我」。 */
    private void handleWake(Intent it) {
        if (it == null || !it.getBooleanExtra("wake", false)) return;
        it.removeExtra("wake");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setTurnScreenOn(true);
                setShowWhenLocked(true);
            }
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (Throwable ignored) {}

        // 页面要几秒才就绪，等 __openListen 出现再叫一次
        waitOpenListen(0);
    }

    private void waitOpenListen(final int n) {
        if (n > 30) return;
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                if (web == null) { waitOpenListen(n + 1); return; }
                /* 2026-11-06 晚：优先 __wakeIn（进通话态），老接口 __openListen 只作兜底。
                   原来这里调 __openListen，那是「按住说话」的旧面板 ——
                   喊了米粒，界面出来了却还是老面板，不是实时通话。 */
                web.evaluateJavascript(
                        "(function(){"
                        + " if (window.__wakeIn) { window.__wakeIn(); return 1; }"
                        + " if (window.__openListen) { window.__openListen(); return 1; }"
                        + " return 0; })()",
                        new android.webkit.ValueCallback<String>() {
                            @Override public void onReceiveValue(String v) {
                                if (v == null || !v.contains("1")) waitOpenListen(n + 1);
                            }
                        });
            }
        }, 200);
    }

    /** 桌宠点了某一项，回到主界面继续说 */
    private void handleAsk(Intent it) {
        if (it == null) return;
        final String ask = it.getStringExtra("ask");
        if (ask == null || ask.isEmpty()) return;
        it.removeExtra("ask");
        /* 冷启动时页面要 2~4 秒才就绪，500ms 后 MILI 还不存在，ask 就静默丢了。
           轮询等它就绪（最多 12 秒），就绪了才发，且只发一次。 */
        ui.postDelayed(new Runnable() {
            int tries = 0;
            @Override public void run() {
                final Runnable self = this;
                if (web == null || ++tries > 24) return;
                web.evaluateJavascript("!!window.MILI", new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String v) {
                        if (!"true".equals(v)) { ui.postDelayed(self, 500); return; }
                        if ("__listen__".equals(ask)) {
                            web.evaluateJavascript("window.__openListen && window.__openListen()", null);
                        } else {
                            web.evaluateJavascript("window.MILI.ask(" + JSONObject.quote(ask) + ")", null);
                        }
                    }
                });
            }
        }, 600);
    }

    /* ---------------- 说话 ---------------- */
    private void initTts() {
        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override public void onInit(int st) {
                if (st == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                    int r = tts.setLanguage(Locale.CHINA);
                    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                        tts.setLanguage(Locale.CHINESE);
                    }
                    tts.setSpeechRate(1.0f);
                    /* 抬到 1.55：这是兜底嗓子（语料没覆盖到的动态内容才用），
                       跟预生成童声放一起时，差别别大到像换了个人。 */
                    tts.setPitch(1.55f);
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        /* 2026-11-06：这三个回调原来是空的 —— 也就是麦克风总闸
                           从来没关过。米粒一念，识听器立刻把它自己的话录进去，
                           于是自问自答、越说越乱。这就是「聊天不连贯」的真凶之一。
                           现在：开口关闸，念完开闸。Asr 那边靠这个闸判断「现在是不是
                           该把音频喂给模型」，还是「只算音量、等老人插话」。 */
                        @Override public void onStart(String id) { MicGate.shut(); }
                        @Override public void onDone(String id) {
                            MicGate.open();
                            ui.post(new Runnable() {
                                @Override public void run() {
                                    try { web.evaluateJavascript("try{miliTtsDone()}catch(e){}", null); } catch (Throwable ignored) {}
                                }
                            });
                        }
                        @Override public void onError(String id) { MicGate.open(); }
                    });
                }
            }
        });
    }

    private void speakOut(final String text, final boolean slow) {
        if (text == null || text.isEmpty()) return;
        /* 先说豆包（首音 392ms，童声）。
           它一个字都吐不出来才退回系统 TTS —— 那条路虽然是机器音，
           但至少能让老人听见话，不至于对着空气等。 */
        MicGate.shut();
        Doubao.say(text, "sys", new Doubao.Sink() {
            @Override public void onStart() { MicGate.shut(); }
            /* 🚨 2026-11-10 真机根因：豆包这条路播完只开麦克风闸，从不通知网页。
               前端 ttsDone()（把状态从「在说」拨回「在听」）只挂在
               系统 TTS 的 UtteranceProgressListener 上 —— 而主链路全是豆包，
               所以每一句说完状态都卡在「在说」，看起来就是「没有变为在听」。
               这里补上跟系统 TTS 同款的回调。 */
            @Override public void onEnd(String id) {
                MicGate.open();
                ui.post(new Runnable() { @Override public void run() {
                    try { web.evaluateJavascript("try{miliTtsDone()}catch(e){}", null); }
                    catch (Throwable ignored) {}
                }});
            }
            @Override public void onFail() { speakSystem(text, slow); }
        });
    }

    private void speakSystem(final String text, final boolean slow) {
        /* 2026-11-12 21:18：这条是「冰冷女声」的唯一来源（小米系统 TTS）。
           加一行日志，现场一听到声音不对就能立刻判断是不是兜底到这儿了 ——
           正常情况下一句都不该出现。 */
        android.util.Log.i("MiliSysTts", "系统TTS兜底: " + text);
        ui.post(new Runnable() {
            @Override public void run() {
                if (tts == null || !ttsReady) { MicGate.open(); return; }
                tts.setSpeechRate(slow ? 0.9f : 1.02f);
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mili");
            }
        });
    }

    /** 一句播完了，告诉网页可以往下说。id 是网页自己编的，原样送回去。 */
    private void ttsEnd(final String id) {
        if (id == null) return;
        ui.post(new Runnable() {
            @Override public void run() {
                try {
                    web.evaluateJavascript(
                            "window.miliTtsEnd&&window.miliTtsEnd('" + id.replace("'", "") + "')", null);
                } catch (Throwable ignored) {}
            }
        });
    }

    /* ---------------- 听 ---------------- */
    /* 本地识别。系统那套 SpeechRecognizer 在这台机器上一直是哑的：
       小米语音服务收到我们的监听请求就回一句「调用方没有录音权限」，
       而我们权限明明是 granted —— MIUI 另有一套判定，跟它斗没意义。
       换成 sherpa-onnx 本地模型：不联网、不看权限脸色、说半句就出半句。 */

    private Asr asr;
    private DuoAsr duoAsr;
    private boolean asrBusy = false;
    /** 连续多少轮没听到字。空轮要退避，别 2 秒一次无限重连占着麦。 */
    private int cvEmptyRounds = 0;

    private void startLocalAsr() {
        android.util.Log.i("MiliCv", "startLocalAsr 进入 cvMode=" + Asr.cvMode);
        if (asrBusy) {                       // 再点一下＝说完了
            if (duoAsr != null) duoAsr.stop();
            if (asr != null) asr.stop();
            return;
        }
        asrBusy = true;
        MilService.pauseWake();              // 先把麦克风从唤醒那边拿过来

        /* 豆包流式识别 2.0（在线）：老人一开口就在传，说到一半屏幕上已经有字了。
           2026-11-09 菲尔特：「比赛肯定有网络，不要搞离线的东西」。
           原来这里有 duoFailed 永久降级位：断过一次就在整个进程内不再连在线，
           网络抖一下整场都退成 sherpa-onnx 本地离线识别。现在失败只影响当前
           这一轮，下一轮重新走在线；本地模型只留作唤醒词与断网静默兜底，
           不参与识别主链路、不写进任何演示或宣传。 */
        duoAsr = new DuoAsr(this, new DuoAsr.OnText() {
            @Override public void onPartial(String t) {
                emit(t, false);              // 边说边显示，让他知道自己被听见了
            }
            @Override public void onFinal(String t, boolean ok) {
                duoAsr = null;
                asrBusy = false;
                MilService.resumeWake();
                if (t != null && !t.isEmpty()) {
                    if (!localCommand(t)) emit(t, true);
                    return;
                }
                if (!ok) {                   // 真的没连上服务端：本轮兜底，下一轮仍试在线
                    asrBusy = true;
                    MilService.pauseWake();
                    startAsrFallback();
                    return;
                }
                emit("", true);              // 听清了，但他没说话
            }
        });
        duoAsr.start();
    }

    /** 在线本轮没连上时的兜底。2026-11-09 起不再有「手机离线识别」这一档。 */
    private void startAsrFallback() {
        /* 自己服务器上的云端识别仍是在线，只是换成说完再传。 */
        if (CloudAsr.configured(this)) {
            CloudAsr.listenOnce(this, new CloudAsr.Back() {
                @Override public void done(String t, boolean ok) {
                    asrBusy = false;
                    MilService.resumeWake();
                    if (t != null && !t.isEmpty()) {
                        if (!localCommand(t)) emit(t, true);
                    } else {
                        emit("", true);
                    }
                }
            });
            return;
        }
        /* 菲尔特 11-09：「比赛肯定有网络，不要搞离线的东西」。
           在线连不上就如实告诉老人没听清，绝不拿 sherpa-onnx 本地模型
           假装听懂（人名听错、方言乱转写，现场走这条就露馅）。
           本地模型现在只服务唤醒词（Kws）与声纹音频段（Voice），不做识别。 */
        asrBusy = false;
        MilService.resumeWake();
        android.util.Log.i("MiliAsrRoute", "在线未连通，不启用离线识别");
        emit("", true);
    }

    /* 🚨 2026-11-10 17:3x 真机根因（「唤醒后一直显示在听、听不见、过会儿消失」）：
       声纹录入 vpEnrollStart() 复用 startCv() 起了本地 Asr（sherpa-onnx）常驻，
       录不满 3 句就不收工；它一直占着麦克风、把底噪当人声「出字」，
       在线 DuoAsr 抢不到麦，前端 cvPcmAge 一直老就写「正在重开耳朵」。
       进通话前无条件清场：谁占着都放掉，再把麦克风交给在线那条。 */
    private void releaseAllMicOwners() {
        try { Voice.enrollArmed = false; Voice.cb = null; } catch (Throwable ignored) {}
        Asr.cvMode = false;
        asrBusy = false;
        if (duoAsr != null) { try { duoAsr.stop(); } catch (Throwable ignored) {} duoAsr = null; }
        if (asr != null) { try { asr.stop(); } catch (Throwable ignored) {} }
        try { MilService.resumeWake(); } catch (Throwable ignored) {}
    }

    /* ==================== 声纹录入用的本地音频流 ====================
       2026-11-09 起这条不再是「连续对话识别」：它只给 vpEnrollStart() 提供
       逐句音频段（Voice.feedEnroll / Voice.verify 是本地声纹特征，不需要网络，
       也不是语音识别）。识别主链路与连续对话都改走在线 DuoAsr，见下面
       startCvOnline() / cvNextRound()。 */
    private void startCv() {
        if (Asr.cvMode && asr != null && asrBusy) return;   // 已经在听，别叠加麦克风
        Asr.cvMode = true;
        asrBusy = true;
        MilService.pauseWake();
        if (asr != null) { try { asr.stop(); } catch (Throwable ignored) {} }
        asr = new Asr(this, new Asr.OnText() {
            @Override public void onText(String t, boolean fin) {
                /* 声纹录入期间本地识别只用来切音频段，绝不把底噪当人话推给前端。
                   以前这里一路 emit，米粒就自己在「虚空对话」。 */
                if (Voice.enrollArmed) return;
                if (!fin) { emit(t, false); return; }
                /* 注意这里没有 asrBusy = false：麦克风不放手，下一句接着听 */
                if (localCommand(t)) return;
                emit(t, true);
            }
        });
        asr.setOnBarge(new Asr.OnBarge() {
            @Override public void onBarge() {
                ui.post(new Runnable() { @Override public void run() {
                    /* 先掐声音，再开麦。
                       反过来的话，开麦那一瞬间豆包还在响，老人刚开口就先把自己的
                       半句话录进去了 —— 识别出来又是一轮新的回答，两个声音叠着说。
                       原来这里只停了系统 TTS，豆包那条路根本没被按住。 */
                    Doubao.stop();
                    if (tts != null && ttsReady) { try { tts.stop(); } catch (Throwable ignored) {} }
                    MicGate.open();
                    try { web.evaluateJavascript("try{miliOnBarge()}catch(e){}", null); } catch (Throwable ignored) {}
                }});
            }
        });
        ui.postDelayed(new Runnable() {
            @Override public void run() { if (asr != null) asr.start(); }
        }, 320);
    }

    /* ==================== 连续对话（在线版）====================
       2026-11-09 菲尔特：「比赛肯定有网络，不要搞离线的东西」。
       老 startCv() 只走本地 sherpa-onnx，且 asrBusy 句末不复位，把在线
       链路彻底锁死。现在改成「在线逐句 + 自动续听」：每句用 DuoAsr 单
       会话收完，米粒说完（MicGate 开闸）后自动重连下一轮，老人不用再点。
       开关默认关，主链路本来就是 startLocalAsr() 的在线单句。 */
    private void startCvOnline() {
        android.util.Log.i("MiliCv", "startCvOnline 进入 cvMode=" + Asr.cvMode + " duo=" + (duoAsr != null));
        if (Asr.cvMode && duoAsr != null) {
            android.util.Log.i("MiliCv", "startCvOnline 已在听，直接返回");
            return;
        }
        Asr.cvMode = true;
        MilService.pauseWake();
        if (asr != null) { try { asr.stop(); } catch (Throwable ignored) {} }
        /* 2026-11-10 真机复现「一直在听、一句话不答」：
           日志是「本轮送出 0 包 / 峰值 rms=0.0000」——麦克风一帧真音频都读不到。
           Kws.pause() 虽然同步 ar.release() 了，MIUI 的 PAL 输入会话拆除是异步的，
           紧接着 openMic 会撞在「concurrency not allowed」上，两边都读不到。
           这里给 180ms 让会话真正拆完再开麦。宁可慢 0.18 秒，不能一句话都听不见。 */
        ui.postDelayed(new Runnable() { @Override public void run() {
            android.util.Log.i("MiliCv", "180ms 后 cvMode=" + Asr.cvMode + " duo=" + (duoAsr != null));
            if (!Asr.cvMode || duoAsr != null) {
                android.util.Log.i("MiliCv", "180ms 后条件不满足，不开麦");
                return;
            }
            cvNextRound();
        }}, 180);
    }

    private void cvNextRound() {
        if (!Asr.cvMode || duoAsr != null) return;
        /* 每轮从零计帧，别拿上一轮的旧时间骗前端说「有音频」。 */
        DuoAsr.lastPcmAt = 0; DuoAsr.pcmFrames = 0;
        asrBusy = true;
        duoAsr = new DuoAsr(this, new DuoAsr.OnText() {
            @Override public void onPartial(String t) { emit(t, false); }
            @Override public void onFinal(String t, boolean ok) {
                duoAsr = null;
                asrBusy = false;
                if (t != null && !t.isEmpty()) {
                    cvEmptyRounds = 0;
                    if (!localCommand(t)) emit(t, true);
                } else {
                    cvEmptyRounds++;
                    if (!ok) {
                        /* 在线真断了也不落离线：等 1.2 秒重连（比赛有网） */
                        ui.postDelayed(new Runnable() { @Override public void run() {
                            cvNextRound();
                        }}, 1200);
                        return;
                    }
                }
                if (!Asr.cvMode) { MilService.resumeWake(); return; }
                /* 空轮退避：老人只是顿一下时别一秒一轮地重连占麦，
                   真说了字（cvEmptyRounds 归零）立刻恢复 350ms 的顺滑节奏。 */
                final long delay = cvEmptyRounds >= 4 ? 2500
                        : cvEmptyRounds >= 2 ? 1200 : 350;
                /* 等米粒把话讲完再开下一轮麦，否则会把它自己的声音
                   当成老人新说的一句，又触发一轮回答。闸丢了也别无限等。 */
                final Runnable[] wait = new Runnable[1];
                wait[0] = new Runnable() { @Override public void run() {
                    if (!Asr.cvMode) return;
                    if (MicGate.isSpeaking() && MicGate.sinceShut() < 12000) {
                        ui.postDelayed(wait[0], 250); return;
                    }
                    cvNextRound();
                }};
                ui.postDelayed(wait[0], delay);
            }
        });
        duoAsr.start();
    }

    /** 本地就能办的一句话。返回 true 表示已经处理完，不用再问云端。 */
    private boolean localCommand(String raw) {
        String s = raw == null ? "" : raw.replace(" ", "");
        if (s.isEmpty()) return false;

        int key = 0;
        if (s.contains("暂停") || s.contains("停一下")) key = android.view.KeyEvent.KEYCODE_MEDIA_PAUSE;
        else if (s.contains("播放") || s.contains("接着放") || s.contains("继续放")) key = android.view.KeyEvent.KEYCODE_MEDIA_PLAY;
        else if (s.contains("下一集") || s.contains("下集")) key = android.view.KeyEvent.KEYCODE_MEDIA_NEXT;
        else if (s.contains("上一集") || s.contains("上集")) key = android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS;
        if (key != 0) {
            try {
                android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    am.dispatchMediaKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, key));
                    am.dispatchMediaKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, key));
                }
            } catch (Throwable ignored) {}
            speakOut(key == android.view.KeyEvent.KEYCODE_MEDIA_PAUSE ? "暂停了" : "好嘞", false);
            return true;
        }
        return false;
    }

    /** 结果回给网页 */
    private void emit(final String text, final boolean isFinal) {
        // 有效文字刚出现就预连接播放；只准备连接，定稿之前不播报、不执行操作。
        if (!isFinal && text != null && text.trim().length() >= 2) {
            try { Doubao.prepare(); } catch (Throwable ignored) {}
        }
        ui.post(new Runnable() {
            @Override public void run() {
                if (web == null) return;
                String js = "window.__onSpeech && window.__onSpeech("
                        + JSONObject.quote(text) + "," + (isFinal ? "true" : "false") + ")";
                web.evaluateJavascript(js, null);
            }
        });
    }

    /* ---------------- 联网搜索：必应 ---------------- */
    private void searchWeb(final String q, final int cbId) {
        new Thread(new Runnable() {
            @Override public void run() {
                String json = "[]";
                try {
                    String url = "https://cn.bing.com/search?q=" + URLEncoder.encode(q, "UTF-8") + "&setlang=zh-CN";
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod("GET");
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(6000);
                    c.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36");
                    c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
                    BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String ln;
                    while ((ln = r.readLine()) != null) sb.append(ln).append('\n');
                    r.close();
                    c.disconnect();
                    json = Parse.bing(sb.toString());
                } catch (Exception e) {
                    json = "[]";
                }
                final String out = json;
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (web != null) {
                            web.evaluateJavascript("window.__onSearch && window.__onSearch("
                                    + cbId + "," + JSONObject.quote(out) + ")", null);
                        }
                    }
                });
            }
        }).start();
    }

    /* ---------------- 无障碍记录：她卡在哪 ---------------- */
    private String stuckJson() {
        SharedPreferences sp = getSharedPreferences("mili_acc", Context.MODE_PRIVATE);
        String s = sp.getString("stuck", "[]");
        return s == null ? "[]" : s;
    }

    /* ---------------- 桥 ---------------- */
    public class Bridge {
        /* ===== 2026-11-11：跨 App 时唯一靠得住的「等」 =====
           米粒把拼多多/抖音切到前台后，本 Activity 进后台，
           Chromium 立刻把页面里的 setTimeout 节流到每分钟一次 ——
           agent-tools.js 里每个 await wait(2600) 都会变成「永久等待」。
           真机实证（cb4a7512 20:32:31 open_app 成功 → 20:36:11
           search_in_app 才报「等太久」，代码里写的超时是 8 秒，实际 220 秒）。
           桥方法跑在 Java 线程上，不受页面生命周期节流限制，
           Thread.sleep 是唯一能老实数完这 2600 毫秒的地方。
           约束：只给「等界面加载」用，单次上限 15 秒，不做长轮询。 */
        /* 2026-11-11 评测 #22「屏幕亮一点」一直是功能缺口（模型只能去乱按按键）。
           两级实现：
           ① 有 WRITE_SETTINGS（少数机型/系统签名能拿到）→ 改系统亮度，全局生效；
           ② 拿不到就改**自己这个窗口**的亮度 —— 不需要任何权限，立刻见效。
              小米实测 adb 的 appops / pm grant 都改不动这个授权，老人也不可能自己
              翻三层设置去找「修改系统设置」这个开关，所以②才是主路径。
              代价：只对米粒自己的界面有效，切到别的 App 会回到系统亮度。
              对老人来说够了 —— 他说「看不清」，看的就是米粒这块屏。 */
        @JavascriptInterface
        public String setBrightness(String dir) {
            final boolean up = !"down".equals(dir);
            /* ① 有系统权限就走全局 */
            try {
                if (android.provider.Settings.System.canWrite(MainActivity.this)) {
                    android.content.ContentResolver cr = getContentResolver();
                    int cur = android.provider.Settings.System.getInt(
                            cr, android.provider.Settings.System.SCREEN_BRIGHTNESS);
                    int next = up ? Math.min(255, cur + 70) : Math.max(15, cur - 70);
                    android.provider.Settings.System.putInt(
                            cr, android.provider.Settings.System.SCREEN_BRIGHTNESS, next);
                    return "{\"ok\":true,\"detail\":\"" + (up ? "屏幕调亮了。" : "屏幕调暗了。") + "\"}";
                }
            } catch (Throwable ignored) {}
            /* ② 没权限就调自己窗口的亮度 */
            try {
                final float delta = up ? 0.25f : -0.25f;
                /* got[0] 把真正写进去的值带回来 —— 截图截不到窗口亮度（screencap 是原始帧，
                   合成器的亮度乘数不在里面），只能靠这个数自证有没有生效。 */
                final float[] got = { -1f };
                runOnUiThread(new Runnable() { @Override public void run() {
                    try {
                        android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
                        float cur = lp.screenBrightness;
                        if (cur < 0f) cur = 0.5f;          /* 跟随系统时给个中间值做起点 */
                        lp.screenBrightness = Math.max(0.12f, Math.min(1f, cur + delta));
                        getWindow().setAttributes(lp);
                        got[0] = getWindow().getAttributes().screenBrightness;
                    } catch (Throwable ignored) {}
                }});
                try { Thread.sleep(80); } catch (Throwable ignored) {}
                if (got[0] < 0f) {
                    return "{\"ok\":false,\"detail\":\"屏幕亮度没调成，系统不让改。\"}";
                }
                return "{\"ok\":true,\"detail\":\"" + (up ? "屏幕调亮了。" : "屏幕调暗了。")
                        + "\",\"v\":" + got[0] + "}";
            } catch (Throwable t) {
                return "{\"ok\":false,\"detail\":\"屏幕亮度没调成。\"}";
            }
        }

        @JavascriptInterface
        public String sleepMs(int ms) {
            int n = Math.max(0, Math.min(ms, 15000));
            try { Thread.sleep(n); } catch (Throwable ignored) {}
            return "{\"ok\":true,\"ms\":" + n + "}";
        }

        @JavascriptInterface
        public boolean isAvailable() { return true; }

        @JavascriptInterface
        public void speak(String text, boolean slow) { speakOut(text, slow); }

        @JavascriptInterface
        public void stopSpeak() {
            Doubao.stop();
            ui.post(new Runnable() { @Override public void run() {
                if (tts != null && ttsReady) tts.stop();
            }});
        }

        /* ===== 流式说话（2026-11-06）=====
           网页那边按标点把回复切成一句一句，每切好一句就调一次这里。
           带 id 是为了对账：原生播完回 window.miliTtsEnd(id)，
           网页的队列才往下走一句 —— 不回声就不知道该不该说下一句。 */
        @JavascriptInterface
        public void ttsSay(final String text, final String id) {
            MicGate.shut();
            Doubao.say(text, id, new Doubao.Sink() {
                @Override public void onStart() { MicGate.shut(); }
                /* 注意：这里不能 open。
                   流式是一次回复切好几句、一句接一句念，句子之间只隔几百毫秒的握手。
                   每句念完就开麦的话，第二句刚开始念，麦克风已经在录它自己了 ——
                   识别器把它的下半句当成老人说话，于是又触发一轮回答，
                   两个声音就同时在喇叭里响（实测就是这么吵起来的）。
                   麦克风整轮只由网页那边统一开：队列空了、内核也说完了才 open。 */
                @Override public void onEnd(String i) { MicGate.shut(); ttsEnd(i); }
                @Override public void onFail() {
                    /* 豆包一句话都没说出来（断网/欠费）。
                       系统 TTS 是离线的，这时候它比什么都可靠。
                       麦先别开 —— 系统 TTS 一样会从喇叭里出来。 */
                    MicGate.shut();
                    speakSystem(text, true);
                    ui.postDelayed(new Runnable() {
                        @Override
                        public void run() { ttsEnd(id); }
                    }, Math.max(1400, text.length() * 280));
                }
            });
        }

        @JavascriptInterface
        public void ttsStop() { Doubao.stop(); MicGate.open(); }

        @JavascriptInterface
        public boolean ttsReady() { return true; }

        /* 预连接（2026-11-12）。老人刚说完一句、模型还在想的那一两秒里，
           把豆包的 ws 一路握手到「就等文本」，省掉每句话都要付的 1.5 秒往返。
           重复调用无副作用，25 秒没过期就直接复用。 */
        @JavascriptInterface
        public void ttsPrepare() {
            try { Doubao.prepare(); } catch (Throwable ignored) {}
        }

        @JavascriptInterface
        public void ttsVoice(String v) { if (v != null && v.length() > 3) Doubao.voice = v; }

        @JavascriptInterface
        public void listen() { ui.post(new Runnable() { @Override public void run() { startLocalAsr(); }}); }

        /* ===== 连续对话（2026-11-06）=====
           菲尔特：「怎么顺畅连贯的语音聊天」。
           以前一问一答之间隔着一个按钮 —— 那次 startLocalAsr 收完一句就
           release 麦克风，要再听必须再调一次。现在 cvStart 开一条常驻的听：
           一句说完不退出，交出去接着听，直到 cvStop 或久无声音才收工。 */
        @JavascriptInterface
        public void cvStart() {
            ui.post(new Runnable() { @Override public void run() {
                /* 先把声纹录入/本地 ASR 占着的麦抢回来，再开在线耳。
                   不抢就是「一直在听、听不见说话」的死循环。 */
                releaseAllMicOwners();
                startCvOnline();
            }});
        }

        /* 前端硬自检：屏幕写「在听」时，原生到底有没有真读到音频帧。
           返回最后一帧距今毫秒数；-1 = 这轮还没开始录音（前端不据此判错）。 */
        @JavascriptInterface
        public long cvPcmAge() {
            /* 在线耳没在跑时返回 -1。以前读的是静态 lastPcmAt，耳朵早停了
               还拿旧时间戳算帧龄，前端就一遍遍「正在重开耳朵」。 */
            if (duoAsr == null || DuoAsr.lastPcmAt <= 0) return -1;
            return System.currentTimeMillis() - DuoAsr.lastPcmAt;
        }

        @JavascriptInterface
        public long cvPcmFrames() { return duoAsr == null ? 0 : DuoAsr.pcmFrames; }

        @JavascriptInterface
        public void cvStop() {
            ui.post(new Runnable() { @Override public void run() {
                android.util.Log.i("MiliCv", "cvStop 被调：连续对话收工");
                Asr.cvMode = false;
                if (duoAsr != null) { try { duoAsr.stop(); } catch (Throwable ignored) {} }
                duoAsr = null;
                if (asr != null) asr.stop();
                asrBusy = false;
                /* 2026-11-06 菲尔特：「叫米粒不理我」。
                   真因就在这一行：startCv() 里 MilService.pauseWake() 把唤醒词
                   的麦克风让出来了，挂断时却没人还回去。于是打开 app 聊过一次之后，
                   离线唤醒永久处于 pause 状态 —— 喊破喉咙也不会应。
                   resumeWake 必须在 micStop 之后调，让它重新抢回录音。 */
                MilService.resumeWake();
            }});
        }

        @JavascriptInterface
        public boolean cvOn() { return duoAsr != null; }

        private Runnable enrollTimeout = null;

        /** 声纹录入最长 60 秒：没录满也收工，绝不把本地麦克风留到通话里。 */
        private void armEnrollTimeout() {
            if (enrollTimeout != null) ui.removeCallbacks(enrollTimeout);
            enrollTimeout = new Runnable() { @Override public void run() {
                if (!Voice.enrollArmed) return;
                android.util.Log.i("MiliCv", "声纹录入 60 秒没满 3 句，自动收工让麦");
                if (web != null) web.evaluateJavascript(
                        "window.__onVoiceTimeout && window.__onVoiceTimeout()", null);
                vpEnrollStop();
            }};
            ui.postDelayed(enrollTimeout, 60000);
        }

        /* ===== 2026-11-10 菲尔特：紧急号码 / 摔倒开关 / 按句录声纹 ===== */
        @JavascriptInterface
        public String setSosNum(String num) {
            String v = num == null ? "" : num.replaceAll("[^0-9+]", "");
            try {
                getSharedPreferences("mili", MODE_PRIVATE).edit()
                        .putString("sos_num", v).apply();
            } catch (Throwable ignored) {}
            android.util.Log.i("MiliSos", "紧急联系人号码已存 " + (v.isEmpty() ? "空" : v));
            return "{\"ok\":true,\"num\":\"" + v + "\"}";
        }

        @JavascriptInterface
        public String setFallEnabled(boolean on) {
            try {
                getSharedPreferences("mili", MODE_PRIVATE).edit()
                        .putBoolean("fall_enabled", on).apply();
            } catch (Throwable ignored) {}
            android.util.Log.i("MiliSos", "摔倒检测 " + (on ? "开" : "关"));
            return "{\"ok\":true}";
        }

        /** 按号码直拨：紧急呼叫与摔倒自动求助都走这里，不再靠通讯录按名字猜。 */
        @JavascriptInterface
        public String callNum(String num) {
            String v = num == null ? "" : num.replaceAll("[^0-9+]", "");
            if (v.length() < 5) return "{\"ok\":false,\"why\":\"号码还没填\"}";
            try {
                Intent c = new Intent(Intent.ACTION_CALL, android.net.Uri.parse("tel:" + v));
                c.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(c);
                return "{\"ok\":true,\"num\":\"" + v + "\"}";
            } catch (Throwable t) {
                return "{\"ok\":false,\"why\":\"" + String.valueOf(t.getMessage()) + "\"}";
            }
        }

        /* ===== 手动录声纹（2026-11-10 20:0x 菲尔特「3 秒太短，不能我自己点结束吗」）=====
           原来 vpTakeOnce() 固定收 3 秒，老人还没念完就被掐断，
           而且 vpEnrollStart() 结尾 resumeWake() 把麦克风又还给唤醒服务，
           录音线程读到的全是 0 → 界面写「这句没收着」。
           现在：点一下开始录，自己点一下结束；期间唤醒服务全程暂停。 */
        private android.media.AudioRecord vpRec = null;
        private volatile boolean vpRecording = false;
        private short[] vpBuf = null;
        private int vpGot = 0;
        private static final int VP_MAX_S = 12;      /* 最长 12 秒兜底，防老人忘了点结束 */

        @JavascriptInterface
        public void vpTakeStart() {
            ui.post(new Runnable() { @Override public void run() {
                try { if (duoAsr != null) { duoAsr.stop(); duoAsr = null; } } catch (Throwable ignored) {}
                try { if (asr != null) { asr.stop(); asr = null; } } catch (Throwable ignored) {}
                Asr.cvMode = false; asrBusy = false;
                /* 🚨 关键：录入全程不许 resumeWake，否则 KWS 抢麦、读到 0 帧 */
                try { MilService.pauseWake(); } catch (Throwable ignored) {}
                Voice.enrollArmed = true;
                if (Voice.cb == null) {
                    Voice.cb = new Voice.TakeCb() {
                        @Override public void onTake(int n, int target, float score, boolean done) {
                            if (web == null) return;
                            web.evaluateJavascript("window.__onVoiceTake && window.__onVoiceTake("
                                    + n + "," + target + "," + score + "," + done + ")", null);
                        }
                    };
                }
                final int SR = 16000;
                try {
                    int min = android.media.AudioRecord.getMinBufferSize(SR,
                            android.media.AudioFormat.CHANNEL_IN_MONO,
                            android.media.AudioFormat.ENCODING_PCM_16BIT);
                    vpRec = new android.media.AudioRecord(
                            android.media.MediaRecorder.AudioSource.MIC, SR,
                            android.media.AudioFormat.CHANNEL_IN_MONO,
                            android.media.AudioFormat.ENCODING_PCM_16BIT,
                            Math.max(min * 2, 3200 * 8));
                    if (vpRec.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                        android.util.Log.i("MiliVoice", "AudioRecord 没起来（麦克风被占？）");
                        if (Voice.cb != null) Voice.cb.onTake(Voice.enrollTakes, 3, -1f, false);
                        return;
                    }
                    vpBuf = new short[SR * VP_MAX_S];
                    vpGot = 0;
                    vpRecording = true;
                    vpRec.startRecording();
                    android.util.Log.i("MiliVoice", "开始录，等老人自己点结束（最长 12 秒）");
                    new Thread(new Runnable() { @Override public void run() {
                        while (vpRecording && vpGot < vpBuf.length) {
                            int n = vpRec.read(vpBuf, vpGot, Math.min(1600, vpBuf.length - vpGot));
                            if (n > 0) vpGot += n; else break;
                        }
                    }}, "mili-vp-rec").start();
                    /* 12 秒兜底自动收工，别一直占着麦 */
                    ui.postDelayed(new Runnable() { @Override public void run() {
                        if (vpRecording) vpTakeStop();
                    }}, VP_MAX_S * 1000L);
                } catch (Throwable t) {
                    android.util.Log.i("MiliVoice", "起录失败 " + t);
                    vpRecording = false;
                    if (Voice.cb != null) Voice.cb.onTake(Voice.enrollTakes, 3, -1f, false);
                }
            }});
        }

        @JavascriptInterface
        public void vpTakeStop() {
            ui.post(new Runnable() { @Override public void run() {
                vpRecording = false;
                try { Thread.sleep(120); } catch (Throwable ignored) {}
                try { if (vpRec != null) { vpRec.stop(); vpRec.release(); } } catch (Throwable ignored) {}
                vpRec = null;
                int got = vpGot;
                short[] buf = vpBuf;
                vpBuf = null; vpGot = 0;
                /* 录完才把麦克风还给唤醒服务 —— 这就是「录不进去」的真因 */
                try { MilService.resumeWake(); } catch (Throwable ignored) {}
                if (buf == null || got < 16000 * 1) {   /* 至少 1 秒才算一句 */
                    android.util.Log.i("MiliVoice", "太短或没收到帧 got=" + got);
                    if (Voice.cb != null) Voice.cb.onTake(Voice.enrollTakes, 3, -1f, false);
                    return;
                }
                float[] pcm = new float[got];
                for (int i = 0; i < got; i++) pcm[i] = buf[i] / 32768.0f;
                android.util.Log.i("MiliVoice", "本句收 " + got + " 采样，喂声纹引擎");
                Voice.feedEnroll(MainActivity.this, pcm, 16000);
            }});
        }

        /** 录一句：固定收 3 秒 PCM 直接喂 Voice.feedEnroll，
            不再靠 sherpa 本地识别切句（底噪被当话、段太短喂不进 Voice.MIN）。 */
        @JavascriptInterface
        public void vpTakeOnce() {
            ui.post(new Runnable() { @Override public void run() {
                try { if (duoAsr != null) { duoAsr.stop(); duoAsr = null; } } catch (Throwable ignored) {}
                try { if (asr != null) { asr.stop(); asr = null; } } catch (Throwable ignored) {}
                Asr.cvMode = false; asrBusy = false;
                try { MilService.pauseWake(); } catch (Throwable ignored) {}
                new Thread(new Runnable() { @Override public void run() {
                    android.media.AudioRecord rec = null;
                    try {
                        final int SR = 16000;
                        int min = android.media.AudioRecord.getMinBufferSize(SR,
                                android.media.AudioFormat.CHANNEL_IN_MONO,
                                android.media.AudioFormat.ENCODING_PCM_16BIT);
                        rec = new android.media.AudioRecord(
                                android.media.MediaRecorder.AudioSource.MIC, SR,
                                android.media.AudioFormat.CHANNEL_IN_MONO,
                                android.media.AudioFormat.ENCODING_PCM_16BIT,
                                Math.max(min * 2, 3200 * 8));
                        if (rec.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                            if (Voice.cb != null) Voice.cb.onTake(Voice.enrollTakes, 3, -1f, false);
                            return;
                        }
                        rec.startRecording();
                        short[] cap = new short[SR * 3];
                        int got = 0;
                        while (got < cap.length) {
                            int n = rec.read(cap, got, Math.min(1600, cap.length - got));
                            if (n > 0) got += n; else break;
                        }
                        float[] pcm = new float[got];
                        for (int i = 0; i < got; i++) pcm[i] = cap[i] / 32768.0f;
                        android.util.Log.i("MiliVoice", "本句收 " + got + " 采样，喂声纹引擎");
                        Voice.feedEnroll(MainActivity.this, pcm, SR);
                    } catch (Throwable t) {
                        android.util.Log.i("MiliVoice", "录一句失败 " + t);
                        if (Voice.cb != null) Voice.cb.onTake(Voice.enrollTakes, 3, -1f, false);
                    } finally {
                        if (rec != null) { try { rec.stop(); rec.release(); } catch (Throwable ignored) {} }
                        try { MilService.resumeWake(); } catch (Throwable ignored) {}
                    }
                }}, "mili-vp-take").start();
            }});
        }

        /* ===== 老人声纹（2026-11-07）=====
           引导页「录声音」三步：进来录 3 句，集满自动收工。
           每录一段回 window.__onVoiceTake(已录, 目标, 相似度, 完成否)。 */
        @JavascriptInterface
        public void vpEnrollStart() {
            ui.post(new Runnable() { @Override public void run() {
                /* 🚨 2026-11-10 菲尔特「点击录完没有反馈」的根因之一：
                   在线连续对话还占着麦克风时 Asr.cvMode 是 true，startCv() 的
                   「已经在听」guard 会直接 return —— 界面点了「开始录声音」，
                   一句都不收，也没有任何提示。录入前先把在线那条路收干净。 */
                try { if (duoAsr != null) { duoAsr.stop(); duoAsr = null; } } catch (Throwable ignored) {}
                try { if (asr != null) { asr.stop(); asr = null; } } catch (Throwable ignored) {}
                Asr.cvMode = false;
                asrBusy = false;
                try { MilService.pauseWake(); } catch (Throwable ignored) {}

                Voice.enrollArmed = true;
                Voice.enrollTakes = 0;
                Voice.centroidReset();
                Voice.cb = new Voice.TakeCb() {
                    @Override public void onTake(int n, int target, float score, boolean done) {
                        if (web == null) return;
                        String js = "window.__onVoiceTake && window.__onVoiceTake("
                                + n + "," + target + "," + score + "," + done + ")";
                        web.evaluateJavascript(js, null);
                    }
                };
                /* 🚨 20:2x 真机实弹：这个「初始化 0/3」回调会把前端刚置的
                   state.rec 打回 false —— 点一下开始，界面立刻变回「未开始」，
                   第二次点击被当成「又开一次录音」，永远走不到 vpTakeStop。
                   点开始时前端自己会画「正在录」，这里什么都不用回。 */
                /* 2026-11-10 18:2x：不再 startCv()。本地 sherpa 把底噪当人声切句，
                   段长够不到 Voice.MIN(0.8 秒)，三句永远录不满；它还一直占着麦，
                   唤醒后在线 ASR 抢不到。改成前端逐句点「录这一句」→ vpTakeOnce()。 */
                /* 🚨 不要 resumeWake：录入期间唤醒服务必须一直暂停，
                   否则 KWS 占麦，AudioRecord 读到 0 帧 → 界面永远「没收着」。
                   由 vpTakeStop() / vpEnrollStop() 收工时再还回去。 */
            }});
        }

        @JavascriptInterface
        public void vpEnrollStop() {
            ui.post(new Runnable() { @Override public void run() {
                if (enrollTimeout != null) { ui.removeCallbacks(enrollTimeout); enrollTimeout = null; }
                Voice.enrollArmed = false;
                Voice.cb = null;
                Asr.cvMode = false;
                if (asr != null) { try { asr.stop(); } catch (Throwable ignored) {} }
                asrBusy = false;
                try { MilService.resumeWake(); } catch (Throwable ignored) {}
            }});
        }

        @JavascriptInterface
        public boolean vpEnrolled() { return Voice.enrolled(MainActivity.this); }

        /** 最近一句在线识别的声纹判定：none=没录过 / unknown=太短判不出 /
            own=老人 / other=不是老人。前端只在 other 时把本轮办事工具下架，
           闲聊照常，新手机没录过声纹也照常能用。 */
        @JavascriptInterface
        public String vpLastOwn() {
            if (!Voice.enrolled(MainActivity.this)) return "none";
            Boolean b = Voice.lastOwn;
            return b == null ? "unknown" : (b.booleanValue() ? "own" : "other");
        }

        @JavascriptInterface
        public void vpReset() { Voice.reset(MainActivity.this); }

        /** 自动接听配置：家人名单（name/phone/wx）+ 两个开关，网页端推过来 */
        @JavascriptInterface
        public String callConfig(String json) { return CallAnswer.setConfig(MainActivity.this, json).toString(); }

        /** 查当前配置，网页端排障用 */
        @JavascriptInterface
        public String callConfigGet() { return CallAnswer.config(MainActivity.this).toString(); }

        /** 调试验证：假装来了个电话，按号码跑白名单匹配+播报链路（不走真铃） */
        @JavascriptInterface
        public String callTest(String num) {
            CallAnswer.testRing(num);
            return "{\"ok\":true}";
        }

        /** 深链跳转（抖音搜索直达全屏）：openUrl 现已放行自定义 scheme */
        @JavascriptInterface
        public String deeplink(String uri) { return actions.openUrl(uri).toString(); }

        /** 手动打开权限检查卡（设置里点「权限检查」用；自动弹窗一生只弹一次）。
            这里绕过节流：用户主动点的，永远给看。 */
        @JavascriptInterface
        public String permCheckNow() {
            runOnUiThread(new Runnable() { @Override public void run() {
                try {
                    org.json.JSONObject st = MainActivity.this.permState();
                    java.util.List<String> miss = new java.util.ArrayList<>();
                    if (!st.optBoolean("acc")) miss.add("无障碍服务（点按钮、找剧、收红包）");
                    if (!st.optBoolean("notif")) miss.add("通知使用权（自动收红包）");
                    if (!st.optBoolean("overlay")) miss.add("悬浮窗（桌宠气泡）");
                    if (!st.optBoolean("mic")) miss.add("麦克风（跟米粒说话）");
                    if (miss.isEmpty()) {
                        android.widget.Toast.makeText(MainActivity.this,
                                "四个开关都开着，米粒能干的活全都能干。",
                                android.widget.Toast.LENGTH_LONG).show();
                        return;
                    }
                    showPermCard(st, miss);
                } catch (Throwable t) {}
            }});
            return "{\"ok\":true}";
        }

        /* ===== 真拍照（药盒识别用）=====
           2026-11-08：项目里一直没有拍照能力，「拍照添加药品」实际只开相册选图，
           用户点「拍照」看到的是选照片 —— 等于这个功能是假的。
           用 MediaStore 拿一个可写 content:// URI，不引 androidx/FileProvider。 */
        @JavascriptInterface
        public String snapPhoto() {
            try {
                long ts = System.currentTimeMillis();
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "mili_" + ts + ".jpg");
                cv.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                pendingShot = getContentResolver().insert(
                        android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                if (pendingShot == null) return "{\"ok\":false,\"why\":\"建不了照片\"}";
                Intent i = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                i.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, pendingShot);
                i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivityForResult(i, 778);
                return "{\"ok\":true}";
            } catch (Throwable t) {
                return "{\"ok\":false,\"why\":\"" + String.valueOf(t.getMessage()).replace("\"", "") + "\"}";
            }
        }

        /** 退出米粒桌面：关自启、记状态、把系统桌面还回去（用户在弹窗里选系统桌面）。
            2026-11-08 菲尔特：「设置里要退出键，退出持久化桌面」——
            装成桌面后没有出口，等于把手机锁在米粒里，这不行。 */
        @JavascriptInterface
        public String exitHome() {
            try {
                getSharedPreferences("mili_prefs", 0).edit()
                        .putBoolean("home_exited", true).apply();
            } catch (Throwable ignored) {}
            try {
                android.content.ComponentName br = new android.content.ComponentName(
                        MainActivity.this, com.mili.app.BootStart.class);
                getPackageManager().setComponentEnabledSetting(br,
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP);
            } catch (Throwable ignored) {}
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_HOME_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                return "{\"ok\":true}";
            } catch (Throwable t) {
                /* 有些 ROM 没这个页面：退回桌面选择器 */
                try {
                    Intent p = new Intent(Intent.ACTION_MAIN);
                    p.addCategory(Intent.CATEGORY_HOME);
                    p.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(Intent.createChooser(p, "选系统桌面"));
                    return "{\"ok\":true,\"chooser\":true}";
                } catch (Throwable t2) { return "{\"ok\":false}"; }
            }
        }

        /** 重新把米粒设成桌面（退出后想回去，一键）。 */
        @JavascriptInterface
        public String enterHome() {
            try {
                getSharedPreferences("mili_prefs", 0).edit()
                        .putBoolean("home_exited", false).apply();
            } catch (Throwable ignored) {}
            try {
                android.content.ComponentName br = new android.content.ComponentName(
                        MainActivity.this, com.mili.app.BootStart.class);
                getPackageManager().setComponentEnabledSetting(br,
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP);
            } catch (Throwable ignored) {}
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_HOME_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                return "{\"ok\":true}";
            } catch (Throwable t) { return "{\"ok\":false}"; }
        }

        /** 现在是不是米粒当桌面（系统默认 HOME）。 */
        @JavascriptInterface
        public boolean isDefaultHome() {
            try {
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_MAIN);
                i.addCategory(android.content.Intent.CATEGORY_HOME);
                android.content.pm.ResolveInfo r =
                        getPackageManager().resolveActivity(i, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
                return r != null && r.activityInfo != null
                        && getPackageName().equals(r.activityInfo.packageName);
            } catch (Throwable t) { return false; }
        }

        /** 打开系统的「默认桌面」选择页 —— 老人端一键设成米粒。 */
        @JavascriptInterface
        public String openHomeSettings() {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_HOME_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                return "{\"ok\":true}";
            } catch (Throwable t) {
                /* 有的 ROM 没这个页面，退系统设置首页 */
                try {
                    Intent i2 = new Intent(android.provider.Settings.ACTION_SETTINGS);
                    i2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i2);
                    return "{\"ok\":true,\"fallback\":true}";
                } catch (Throwable t2) { return "{\"ok\":false}"; }
            }
        }

        /** 电视全屏横屏：Manifest 已配 configChanges，转屏不重建 Activity */
        @JavascriptInterface
        public String screenLand() {
            runOnUiThread(new Runnable() { @Override public void run() {
                setRequestedOrientation(
                        android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }});
            return "{\"ok\":true}";
        }

        /** 回竖屏 */
        @JavascriptInterface
        public String screenPort() {
            runOnUiThread(new Runnable() { @Override public void run() {
                setRequestedOrientation(
                        android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            }});
            return "{\"ok\":true}";
        }

        /** 任意界面按屏幕比例点一下（进抖音搜索结果页点第一个视频进全屏） */
        @JavascriptInterface
        public String tapAt(double fx, double fy) {
            return MiliAccessibilityService.tapAt((float) fx, (float) fy);
        }

        /** 现在屏幕是不是横着。抖音全屏是横屏，用它判断「全屏观看」点没点中，
            避免多点一次 —— 横屏后画面中间是播放/暂停，多点一下就把节目停了。 */
        @JavascriptInterface
        public boolean isLandscape() {
            try {
                int r = ((android.view.WindowManager) getSystemService(WINDOW_SERVICE))
                        .getDefaultDisplay().getRotation();
                return r == android.view.Surface.ROTATION_90 || r == android.view.Surface.ROTATION_270;
            } catch (Throwable t) { return false; }
        }

        /** 老人说「接一下」：接起正在响铃的电话 */
        @JavascriptInterface
        public String answerRing() {
            boolean ok = CallAnswer.answer(MainActivity.this);
            return "{\"ok\":true,\"say\":\"好，接上啦。\"}";
        }

        /** 老人说「挂了吧」：挂断当前通话 */
        @JavascriptInterface
        public String endRing() {
            boolean ok = CallAnswer.endCall(MainActivity.this);
            return ok ? "{\"ok\":true,\"say\":\"挂了。\"}" : "{\"ok\":false,\"why\":\"没有正在通的电话\"}";
        }

        /** 老人插话了：停播报，把闸打开，让识别接着收这一句 */
        @JavascriptInterface
        public void bargeStop() {
            ui.post(new Runnable() { @Override public void run() {
                if (tts != null && ttsReady) { try { tts.stop(); } catch (Throwable ignored) {} }
                MicGate.open();
            }});
        }

        /* ===== 跌落确认（2026-11-10）=====
           前端确认层上的两颗按钮，和老人开口说话，都走这里。
           不写意图正则：说「我没事」由模型调 fall_answer 工具，按钮直接调这两个口子。 */
        @JavascriptInterface
        public void fallCancel() { MilService.cancelFall("老人点了按钮/开了口"); }

        @JavascriptInterface
        public void fallNow() { MilService.fallNow("老人当场要求叫人"); }

        @JavascriptInterface
        public boolean fallPending() { return MilService.fallPendingNow(); }

        /* 网页里用 <audio> 播预生成童声时，系统 TTS 一次都没被调用，
           UtteranceProgressListener 那些回调也就一个都不会来 ——
           麦克风总闸等于没关，它照样把自己念的话录进去。
           这两个口子专门给网页那一路用：开播关闸，播完开闸。 */
        @JavascriptInterface
        public void micShut() { MicGate.shut(); }

        @JavascriptInterface
        public void micOpen() { MicGate.open(); }

        /* 语速：老人说「再快一点 / 慢一点」时由智能体调这个，不用回来改代码重装。
           范围按火山接口的 [-50,100] 卡住，越界会把语速调成怪声。
           返回值是改完之后的档位，前端可以直接念给老人听，也算一个凭据。 */
        @JavascriptInterface
        public int ttsRate(int set) {
            if (set > -999) {
                Doubao.speechRate = Math.max(-50, Math.min(100, set));
                try {
                    getSharedPreferences("mili", MODE_PRIVATE).edit()
                            .putInt("ttsRate", Doubao.speechRate).apply();
                } catch (Throwable ignored) {}
            }
            return Doubao.speechRate;
        }

        @JavascriptInterface
        public void stopListen() {
            ui.post(new Runnable() { @Override public void run() {
                if (asr != null) asr.stop();
            }});
        }

        /* 双端分离总闸：家人端 true → 唤醒暂停、桌宠收起、TTS 立刻闭嘴。
           写进 SP，开机重启也记得住。 */
        @JavascriptInterface
        public void setFamilyMode(final boolean fam) {
            /* 2026-11-08 事故：这个值曾经落盘，一次家人端测试把它写成 true，
               之后每次开机 MilService 读到就 wakeOn=false —— 桌宠不显示、喊米粒不答应，
               用户看到的就是「桌宠没了」。端状态只该在本次进程里生效，
               开机永远按老人端来（要静音就在家人端里待着）。 */
            /* 22:55：家人端只走临时态，不再动用户持久化的「喊米粒唤醒」设置。 */
            try { MilService.setFamilyMode(fam); } catch (Throwable t) {}
            if (fam) {
                try { Doubao.stop(); } catch (Throwable t) {}
                try { Asr.cvMode = false; } catch (Throwable t) {}
            }
        }

        /** 唤醒交给常驻服务（本地关键词，喊「米粒」就应），网页这边只要保证服务在跑 */
        @JavascriptInterface
        public void startWakeWord() {
            ui.post(new Runnable() { @Override public void run() {
                try {
                    Intent i = new Intent(MainActivity.this, MilService.class);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
                    else startService(i);
                } catch (Exception ignored) {}
            }});
        }

        @JavascriptInterface
        public void stopWakeWord() { try { MilService.setWakeEnabled(false); } catch (Throwable t) {} }

        /* 设置页「喊米粒唤醒」真开关。关掉后本地关键词监听也不起，
           麦克风彻底不占；写进 SharedPreferences，开机重启也不会自己回来。 */
        @JavascriptInterface
        public boolean wakeVisible() {
            try { return MilService.wakeEnabled(); } catch (Throwable t) { return true; }
        }

        @JavascriptInterface
        public void setWakeVisible(final boolean on) {
            try { MilService.setWakeUserEnabled(on); } catch (Throwable t) {}
        }

        /* 桌面大图标（2026-11-06 米粒自己当桌面）：拨号盘/短信/微信/相册/相机/设置，
           全部标准 Intent 直达，见 Actions.launch() */
        @JavascriptInterface
        public String deskLaunch(String kind) { return actions.launch(kind).toString(); }

        @JavascriptInterface
        public String deskGo(String kind, String arg) { return actions.launch(kind, arg).toString(); }

        @JavascriptInterface
        public String torch() { return actions.torch().toString(); }

        /* 家人端引导 → 老人端：用 6 位码当共享键，真跨设备同步配置。
           走原生 HTTP，避开 WebView 对 http 的混合内容拦截。 */
        @JavascriptInterface
        public String cfgPut(String code, String json) {
            return StateBackup.cfgPut(MainActivity.this, code, json);
        }

        @JavascriptInterface
        public String cfgGet(String code) {
            return StateBackup.cfgGet(MainActivity.this, code);
        }

        /* 语音「开灯 / 关灯」走精确开关，不走 toggle。 */
        @JavascriptInterface
        public String torchSet(boolean on) { return actions.torchSet(on).toString(); }

        @JavascriptInterface
        public void search(String q, int cbId) { searchWeb(q, cbId); }

        @JavascriptInterface
        public String stuck() { return stuckJson(); }

        /* 真跳系统设置，不是假开关 */
        @JavascriptInterface
        public void openAccessibility() {
            try {
                startActivity(new Intent("android.settings.ACCESSIBILITY_SETTINGS")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {}
        }

        /** 固化老人状态：写私有 SP + 公共 Downloads（清数据不删）。 */
        @JavascriptInterface
        public void saveState(String j) { StateBackup.save(MainActivity.this, j); }

        /** 启动读回。清数据后 localStorage 空了，用这个自动恢复。 */
        @JavascriptInterface
        public String loadState() { return StateBackup.load(MainActivity.this); }

        /** 给「我的」页看：四个开关的真实状态。 */
        @JavascriptInterface
        public String permState() { return MainActivity.this.permState().toString(); }

        /** 权限板块专用：一行一个 key，点了直接送进对应的系统设置页。
            不代点、不写假状态；从设置页回来 onResume 会重新读 permState()。 */
        @JavascriptInterface
        public void openPerm(final String k) {
            runOnUiThread(new Runnable() { @Override public void run() {
                openSettingFor(k == null ? "" : k);
            }});
        }

        /** 通知使用权设置页（自动收红包靠它）。 */
        @JavascriptInterface
        public void openNotifSettings() {
            try { startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void openAppSettings() {
            try {
                Intent i = new Intent("android.settings.APPLICATION_DETAILS_SETTINGS");
                i.setData(android.net.Uri.parse("package:" + getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception e) {}
        }

        @JavascriptInterface
        public boolean hasTts() { return ttsReady; }
        @JavascriptInterface
        public boolean hasAsr() { return true; }

        /** 识别服务器地址（自己的服务器，跑 FunASR/FireRedASR 都行）。空串＝用手机上的离线模型 */
        @JavascriptInterface
        public void setAsrEndpoint(String url) { CloudAsr.setEndpoint(MainActivity.this, url); }

        @JavascriptInterface
        public String asrEndpoint() { return CloudAsr.endpoint(MainActivity.this); }

        /* ================= 真办事 =================
           全部返回 JSON 字符串，前端拿 s.say 直接念。
           做不成的会说明原因，不假装做成了。 */

        @JavascriptInterface
        public String call(String who) { return actions.call(who).toString(); }

        /** 想看某个内容：有 App 就开 App，没有才用悟空浏览器搜 */
        @JavascriptInterface
        /* 想看某个内容：先看手机上有没有对应 App，没有才用悟空搜。
           名字不能叫 watch —— Bridge 里已经有一个 watch(app) 是「打开某个视频 App」的老接口，
           重名会编不过（刚踩过）。 */
        public String watchWhat(String what) { return actions.watchContent(what).toString(); }

        /** 领红包：位置不固定，靠截屏找橙色块，找到就点。
            2026-11-07 实测踩到的坑：以前这里立刻返回「我找找红包」，
            真结果走 __onHongbao 异步回 —— 智能体拿到的永远是 ok:true，
            「领到了」和「没找到」它分不清，下一句就只能瞎说。
            改成同步等 grab 走完（正常 8~12 秒），把真结果交回给模型。 */
        @JavascriptInterface
        public String hongbao() {
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            final String[] out = {null};
            Hongbao.grab(new Hongbao.Back() {
                @Override public void done(final boolean ok, final String msg) {
                    speakOut(msg, false);
                    JSONObject o = new JSONObject();
                    try { o.put("ok", ok); o.put("detail", msg); } catch (Throwable ignored) {}
                    out[0] = o.toString();
                    ui.post(new Runnable() { @Override public void run() {
                        if (web != null) web.evaluateJavascript(
                                "window.__onHongbao && window.__onHongbao("
                                        + JSONObject.quote(msg) + "," + ok + ")", null);
                    }});
                    latch.countDown();
                }
            });
            try { latch.await(35, java.util.concurrent.TimeUnit.SECONDS); } catch (Throwable ignored) {}
            return out[0] != null ? out[0]
                    : "{\"ok\":false,\"detail\":\"等了半天没结果，红包可能已经领过了。\"}";
        }

        @JavascriptInterface
        public String navigate(String place) { return actions.navigate(place).toString(); }

        /** 打开一个 http/https 页面（CCTV 直播、片库这类）。网页端用不到，走 window.open。 */
        @JavascriptInterface
        public String openUrl(String url) { return actions.openUrl(url).toString(); }

        /* 抖音只走搜索深链、选片、全屏这一条短路；最终结果异步回传。 */
        private DouyinPlayback douyinPlayer() {
            if (douyinPlayback == null) douyinPlayback = new DouyinPlayback(new DouyinPlayback.Host() {
                public long now() { return android.os.SystemClock.uptimeMillis(); }
                public void later(Runnable action, long delayMs) { ui.postDelayed(action, delayMs); }
                public String window() { return MiliAccessibilityService.currentWindow(); }
                public boolean openSearch(String keyword) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(
                                "snssdk1128://search?keyword=" + java.net.URLEncoder.encode(keyword, "UTF-8")));
                        intent.setPackage(DouyinPlayback.PACKAGE);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                        return true;
                    } catch (Exception e) { return false; }
                }
                public boolean fullscreen() {
                    String current = window();
                    if (!current.startsWith(DouyinPlayback.PACKAGE + "/")) return false;
                    return current.contains("Landscape")
                            || ((current.contains("Detail")) && getResources().getConfiguration().orientation
                                == android.content.res.Configuration.ORIENTATION_LANDSCAPE);
                }
                public boolean tapResult(boolean fallback) {
                    return succeeded(fallback ? MiliAccessibilityService.tapAt(0.5f, 0.43f)
                            : MiliAccessibilityService.tapFirstResult());
                }
                public boolean tapFullscreen(int attempt) {
                    if (attempt == 0) return succeeded(MiliAccessibilityService.tapTextAny("全屏观看", "全屏"));
                    // 每次只发一个手势，不再同时按两套屏幕基准连点。
                    return succeeded(MiliAccessibilityService.tapAt(0.5f, attempt == 1 ? 0.572f : 0.480f));
                }
                public void complete(String id, boolean ok, boolean fullscreen, String detail) {
                    JSONObject result = new JSONObject();
                    try {
                        result.put("ok", ok);
                        result.put("completed", true);
                        result.put("fullscreen", fullscreen);
                        result.put("detail", detail);
                    } catch (Exception ignored) {}
                    android.util.Log.i("MiliDouyin", "complete ok=" + ok + " fullscreen=" + fullscreen);
                    MainActivity.runJs("window.__onDouyinResult && window.__onDouyinResult("
                            + JSONObject.quote(id) + "," + result + ")");
                }
                private boolean succeeded(String json) {
                    try { return new JSONObject(json).optBoolean("ok"); }
                    catch (Exception e) { return false; }
                }
            });
            return douyinPlayback;
        }

        @JavascriptInterface
        public String playDouyinTask(String keyword, String requestId) {
            if (!MiliAccessibilityService.ready())
                return "{\"ok\":false,\"detail\":\"请先打开米粒的无障碍服务。\"}";
            ui.post(() -> douyinPlayer().start(keyword, requestId));
            return "{\"ok\":true,\"pending\":true}";
        }

        @JavascriptInterface
        public String searchState() { return MiliAccessibilityService.searchState(); }

        /** 旧页面只收到进行中回执，不能把它当成已播放。 */
        @JavascriptInterface
        public String playDouyin(String keyword) { return playDouyinTask(keyword, "legacy"); }

        @JavascriptInterface
        public void stopDouyin() {
            ui.post(() -> { if (douyinPlayback != null) douyinPlayback.cancel(); });
        }

        @JavascriptInterface
        public String watch(String app) { return actions.watch(app).toString(); }

        /** 按剧名找片（「我要看后会有期」这种） */
        @JavascriptInterface
        public String watchShow(String name) { return actions.watchShow(name).toString(); }
        /** 「接着看 / 追剧」：直接续悟空里那部剧，不再落到抖音首页。 */
        @JavascriptInterface
        public String resumeWukong() { return actions.resumeWukong().toString(); }

        /** 用指定 App 找片：「用悟空浏览器找后会有期」 */
        @JavascriptInterface
        public String watchSearch(String app, String show) {
            return actions.watchSearch(app, show).toString();
        }

        /** 微信发文字：who 给谁，text 发什么 */
        @JavascriptInterface
        public String wxText(String who, String text) {
            return actions.wechat(who, "message", text).toString();
        }

        /** 微信发红包：amount 是金额字符串，比如 "88" */
        @JavascriptInterface
        public String wxRed(String who, String amount) {
            return actions.wechat(who, "redpacket", amount).toString();
        }

        /** 微信语音通话 */
        @JavascriptInterface
        public String wxCall(String who) {
            return actions.wechat(who, "call", null).toString();
        }

        /** 微信视频通话 */
        @JavascriptInterface
        public String wxVideo(String who) {
            return actions.wechat(who, "video", null).toString();
        }

        /** 把一段字塞进系统剪贴板。中文没法用 input text 打字，只能靠粘贴 */
        @JavascriptInterface
        public boolean clip(String s) {
            try {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(android.content.ClipData.newPlainText("mili", s == null ? "" : s));
                return true;
            } catch (Exception e) { return false; }
        }

        /** 读剪贴板，验证上一步写进去了没 */
        @JavascriptInterface
        public String clipGet() {
            try {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                android.content.ClipData d = cm.getPrimaryClip();
                if (d == null || d.getItemCount() == 0) return "";
                CharSequence t = d.getItemAt(0).coerceToText(MainActivity.this);
                return t == null ? "" : t.toString();
            } catch (Exception e) { return ""; }
        }

        /** 微信流程熟练度：录了几个点、成功几次、还缺哪步 */
        @JavascriptInterface
        public String wxSkill() { return actions.wxSkill(); }

        /** 屏幕三套尺寸都报出来，排查坐标偏移用 */
        @JavascriptInterface
        public String scrInfo() {
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
                o.put("metrics", dm.widthPixels + "x" + dm.heightPixels);
                android.view.WindowManager wm =
                        (android.view.WindowManager) getSystemService(Context.WINDOW_SERVICE);
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Rect b = wm.getCurrentWindowMetrics().getBounds();
                    o.put("curWin", b.width() + "x" + b.height());
                    android.graphics.Rect mb = wm.getMaximumWindowMetrics().getBounds();
                    o.put("maxWin", mb.width() + "x" + mb.height());
                }
                android.util.DisplayMetrics r = new android.util.DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(r);
                o.put("real", r.widthPixels + "x" + r.heightPixels);
                o.put("density", dm.density);
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        /** 手动录一个点：key 是步骤名，x/y 是屏幕绝对像素 */
        @JavascriptInterface
        public boolean wxMark(String key, int x, int y) {
            return actions.wxMark(key, x, y);
        }

        /** 挂断当前微信通话 */
        @JavascriptInterface
        public boolean wxHangup() { return actions.wxHangup(); }

        /** 通话中切扬声器 */
        @JavascriptInterface
        public boolean wxSpeaker() { return actions.wxSpeaker(); }

        @JavascriptInterface
        public String tv() { return actions.tv().toString(); }

        /* ---- 声音 / 播放 / 频道 ---- */
        @JavascriptInterface
        public String volume(String act) { return actions.volume(act).toString(); }

        @JavascriptInterface
        public String media(String act) { return actions.media(act).toString(); }

        @JavascriptInterface
        public String tvChannel(String ch) { return actions.tvChannel(ch).toString(); }

        /** 「下个台」：台号 +1 并开到直播页。 */
        @JavascriptInterface
        public String tvNext() { return actions.tvNext().toString(); }

        /* ---- 看屏幕、按字点、打字：模型自己在 App 里走 ----
           微信封了节点树只能靠坐标；抖音、红果这些是可读的，
           有这三个，它就能「搜剧名 → 点第一条 → 点选集」。 */
        @JavascriptInterface
        public String tapText(String q) { return MiliAccessibilityService.tapText(q); }

        @JavascriptInterface
        public String typeText(String t) { return MiliAccessibilityService.typeText(t); }
        /** 强制跑一遍收红包（不依赖通知/窗口事件），真机验收用。 */
        @JavascriptInterface
        public String testHb() {
            Hongbao.startFromNotification("王炳皓 2510977: [微信红包]恭喜发财，大吉大利", null);
            return "started";
        }

        /** 调试：模拟一条红包通知文字，验解析与汇报话术。 */
        @JavascriptInterface
        public String debugHongbao(String t) { return Hongbao.debugNotify(t); }

        /** 调试：打印当前窗口无障碍节点树。 */
        @JavascriptInterface
        public String nodeTree() { return MiliAccessibilityService.dumpTree(); }

        /** 界面结构（JSON）：每个有字/可点/可输入的节点带像素框，外加屏幕宽高。
            智能体靠这个「看懂这一屏」，再用 tapAtPercent 点回去。 */
        @JavascriptInterface
        public String nodeMap() { return MiliAccessibilityService.dumpJson(); }

        /** 全局键：home / back / recents / notifications / quick */
        @JavascriptInterface
        public String pressKey(String key) { return MiliAccessibilityService.pressKey(key); }

        /** 长按百分比坐标处（微信的复制/转发菜单只有长按才出） */
        @JavascriptInterface
        public String longPress(double fx, double fy) { return MiliAccessibilityService.longPress(fx, fy); }

        /** 手机上装了哪些能打开的 App */
        @JavascriptInterface
        public String listApps() {
            /* 无障碍没开的时候也能列应用：直接用 PackageManager，不依赖服务实例 */
            String r = MiliAccessibilityService.listApps();
            if (r != null && r.indexOf("\"ok\":true") >= 0) return r;
            try {
                org.json.JSONArray arr = new org.json.JSONArray();
                android.content.pm.PackageManager pm = getPackageManager();
                java.util.List<android.content.pm.ApplicationInfo> all =
                        pm.getInstalledApplications(android.content.pm.PackageManager.GET_META_DATA);
                java.util.List<String[]> out = new java.util.ArrayList<String[]>();
                for (android.content.pm.ApplicationInfo ai : all) {
                    if ((ai.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                    if (pm.getLaunchIntentForPackage(ai.packageName) == null) continue;
                    String label;
                    try { label = String.valueOf(pm.getApplicationLabel(ai)); }
                    catch (Throwable t) { label = ai.packageName; }
                    out.add(new String[]{label, ai.packageName});
                }
                java.util.Collections.sort(out, new java.util.Comparator<String[]>() {
                    @Override public int compare(String[] a, String[] b) { return a[0].compareTo(b[0]); }
                });
                for (int i = 0; i < out.size() && i < 400; i++) {
                    org.json.JSONObject o = new org.json.JSONObject();
                    o.put("name", out.get(i)[0]);
                    o.put("pkg", out.get(i)[1]);
                    arr.put(o);
                }
                org.json.JSONObject res = new org.json.JSONObject();
                res.put("ok", true);
                res.put("apps", arr);
                return res.toString();
            } catch (Throwable t) {
                return "{\"ok\":false,\"err\":\"pm_fail\"}";
            }
        }

        /** 最近收到的通知（智能体读「谁给我发了什么」用） */
        @JavascriptInterface
        public String recentNotifs(int limit, int minutes) { return MiliNotifService.recentJson(limit, minutes); }

        /** 直接点网页播放器的播放/暂停/上一集/下一集/全屏。 */
        @JavascriptInterface
        public String playerControl(String cmd) { return MiliAccessibilityService.playerControl(cmd); }

        /** 搜到就点开、起播、全屏 —— 一条龙，老人不用再点三下。 */
        @JavascriptInterface
        public String watchPlay(String show) { return MiliAccessibilityService.watchPlay(show); }

        /** 截一张屏（base64 JPEG），让云视觉看这个界面是什么。 */
        @JavascriptInterface
        public String shotScreen() { return MiliAccessibilityService.shotBase64(); }

        /** 滑动：智能体自己往下翻找东西用的，老人不直接碰。 */
        @JavascriptInterface
        public String swipe(float fx1, float fy1, float fx2, float fy2) {
            return MiliAccessibilityService.swipe(fx1, fy1, fx2, fy2);
        }

        /** 按屏幕比例点一下（自绘界面用，调试也用得上）。 */
        @JavascriptInterface
        public String tapPercent(double fx, double fy) { return MiliAccessibilityService.tapPercent(fx, fy); }

        /** 备用打法：走剪贴板粘贴。有些框不认 SET_TEXT（返回 true 但一个字不进）。 */
        @JavascriptInterface
        public String pasteText(String t) { return MiliAccessibilityService.pasteInto(t); }

        /** 后台播童声片段（原生 MediaPlayer，WebView 后台静音也不受影响）。 */
        @JavascriptInterface
        public boolean playVoice(String src) { return MilService.playVoice(MainActivity.this, src); }

        /** 让桌宠冒一句话，App 留在后台。老人看电视时用它，别把界面抢走。 */
        @JavascriptInterface
        public String petSay(String t) { MilService.say(MainActivity.this, t); return "{\"ok\":true}"; }

        @JavascriptInterface
        public String screenText() { return MiliAccessibilityService.screenText(); }

        /** 点搜索结果的第一条（图片/视频块没有文字，只能按大小找） */
        @JavascriptInterface
        public String tapResult() { return MiliAccessibilityService.tapFirstResult(); }

        /** 按一下返回键 */
        @JavascriptInterface
        public String pressBack() { return MiliAccessibilityService.pressBack(); }

        /* ==================================================================
           2026-11-09 菲尔特：「收款码和付款码功能都加上吧，主打付款码和微信扫一扫」
           —— 微信「+」菜单三步直达（真机 cb4a7512 / 微信 8.0.80 / 1080×2400 实测）

           为什么不再用 scheme：
             GitHub xFelino/url-schemes-collecting 明确写「最新版微信不能再从外部调用」；
             EggUncle/XposedNavigationBar 2017 年就记下 weixin://dl/scan 失效。
             本机实测 weixin://scanqrcode / weixin://dl/scan / ShortCutDispatchAction /
             显式 BaseScanUI，全部落到 MMWebViewUI「对不起，当前页面无法访问」。
             微信 8.0.80 还把无障碍节点树返回空壳（407B），按文字找按钮也走不通。
           唯一走得通的：无障碍 dispatchGesture 坐标回放（项目 WxFlow 已有这套能力）。

           实测坐标（1080×2400，按屏幕比例存，换分辨率自适应）：
             右上角 +          (1000,150)  → 0.926 / 0.0625
             扫一扫 菜单第三项  (860,650)   → 0.796 / 0.271  → BaseScanUI ✅
             收付款 菜单第四项  (860,802)   → 0.796 / 0.334  → UIPageFragmentActivity（付款码，防截屏）✅
             二维码收款         (540,1750)  → 0.500 / 0.729  → WalletCollectQrCodeUI ✅
           老人只点一次，中间三下由米粒代点；最后那一下永远归微信、归老人自己。
           ================================================================== */
        private void wxViaMenu(final String kind) {
            ui.post(new Runnable() { @Override public void run() {
                /* 显式组件名：Android 13+ 的包可见性会把隐式 LAUNCHER intent 挡掉
                   （日志 xflg=0x4），Actions.wechat 里已经踩过这个坑。 */
                try {
                    Intent i = new Intent();
                    i.setComponent(new android.content.ComponentName(
                            "com.tencent.mm", "com.tencent.mm.ui.LauncherUI"));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    startActivity(i);
                } catch (Exception e) { return; }

                /* 用 getRealSize() 的物理分辨率缩放，不用 DisplayMetrics.heightPixels：
                   后者少了状态栏那截，屏幕下半部（二维码收款在 y=1750）会被点偏。 */
                final android.graphics.Point SZ = new android.graphics.Point();
                MainActivity.this.getWindowManager().getDefaultDisplay().getRealSize(SZ);
                final float KX = SZ.x / 1080f, KY = SZ.y / 2400f;
                final int[] PLUS   = {(int) (1000 * KX), (int) (150  * KY)};
                final int[] SCAN   = {(int) ( 860 * KX), (int) (650  * KY)};
                final int[] WALLET = {(int) ( 860 * KX), (int) (802  * KY)};
                final int[] COLLECT= {(int) ( 540 * KX), (int) (1750 * KY)};

                ui.postDelayed(new Runnable() { @Override public void run() {
                    MiliAccessibilityService.tapAbs(PLUS[0], PLUS[1]);   // 右上角 +
                }}, 900);
                ui.postDelayed(new Runnable() { @Override public void run() {
                    if ("scan".equals(kind)) MiliAccessibilityService.tapAbs(SCAN[0], SCAN[1]);
                    else MiliAccessibilityService.tapAbs(WALLET[0], WALLET[1]); // 收付款 / 付款码
                }}, 1550);
                if ("receive".equals(kind)) {
                    /* 支付页 FLAG_SECURE + 首次加载慢，11-09 首版 2750ms 点早了，
                       落到了网页错误页 MMWebViewUI。放宽到 3600ms。 */
                    ui.postDelayed(new Runnable() { @Override public void run() {
                        MiliAccessibilityService.tapAbs(COLLECT[0], COLLECT[1]); // 二维码收款
                    }}, 3600);
                }
            }});
        }

        @JavascriptInterface
        public void wxScan()        { wxViaMenu("scan"); }
        @JavascriptInterface
        public void wxPayCode()     { wxViaMenu("pay"); }
        @JavascriptInterface
        public void wxReceiveCode() { wxViaMenu("receive"); }

        /** 打电话页的「点名字就拨」名单：把本机通讯录里有号码的人交给前端。
            只读前 40 个，多了老人也翻不动。 */
        @JavascriptInterface
        public String contacts() {
            return actions.allContacts().toString();
        }

        /** 扫二维码。开相机扫到就回调 window.__onScan(code)，扫不到就 __onScan('')。
            配对码在老人手机上，家人得用自己这台扫 —— 这就是那个入口。 */
        @JavascriptInterface
        public void scanCode() {
            ui.post(new Runnable() { @Override public void run() {
                try {
                    Intent it = new Intent(MainActivity.this, ScanActivity.class);
                    startActivityForResult(it, REQ_SCAN);
                } catch (Exception e) {
                    pushScan("");
                }
            }});
        }

        /** 只在上半屏按字点（提交搜索时避开键盘上的同名按键） */
        @JavascriptInterface
        public String tapTextTop(String q, int maxY) {
            return MiliAccessibilityService.tapTextTop(q, maxY);
        }

        @JavascriptInterface
        public String sms(String who, String text) {
            return actions.sms(who, text).toString();
        }

        /** 真天气（wttr.in）。拿不到就返回 ok=false，前端直说没看上。 */
        @JavascriptInterface
        public String weather() { return actions.weather().toString(); }

        /* 定位：天气要按老人站的地方报，不按服务器出口 IP 猜。
           只给「我的」页那个开关用 —— 不给别的页面随便调，免得弹框吓到老人。 */
        @JavascriptInterface
        public boolean locGranted() {
            try {
                return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface
        public void askLoc() {
            ui.post(new Runnable() { @Override public void run() {
                try {
                    if (locGranted()) { web.evaluateJavascript("window.__locDone && window.__locDone(true)", null); return; }
                    requestPermissions(new String[]{
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                            Manifest.permission.ACCESS_FINE_LOCATION}, 1003);
                } catch (Exception e) {}
            }});
        }

        /* ---- 手环心率 ----
           华为手环打开「设置 → 心率广播」后，会按蓝牙标准对外提供心率服务。
           这里读的就是那个标准服务，不需要华为账号、不需要华为 SDK。
           只有老人亲手打开开关时才扫 —— 常驻扫描一天能把电耗光。 */

        @JavascriptInterface
        public boolean bandOn() { try { return band.isRunning(); } catch (Exception e) { return false; } }

        @JavascriptInterface
        public boolean bandFresh() { try { return band.fresh(); } catch (Exception e) { return false; } }

        @JavascriptInterface
        public int bandBpm() { try { return band.lastBpm(); } catch (Exception e) { return 0; } }

        @JavascriptInterface
        public long bandAt() { try { return band.lastAt(); } catch (Exception e) { return 0; } }

        /** 一句话说清楚现在什么状态。网页拿这个直接念给老人听。 */
        @JavascriptInterface
        public String bandStatus() { try { return band.status(); } catch (Exception e) { return "没开"; } }

        @JavascriptInterface
        public boolean bandBtOn() { try { return band.btOn(); } catch (Exception e) { return false; } }

        @JavascriptInterface
        public boolean bandHasPerm() { try { return band.hasPerm(); } catch (Exception e) { return false; } }

        /** 开始读。没权限就先把权限要了，回来再开。 */
        @JavascriptInterface
        public void bandStart() {
            ui.post(new Runnable() { @Override public void run() {
                try {
                    if (band.hasPerm()) { band.start(); return; }
                    String[] want = android.os.Build.VERSION.SDK_INT >= 31
                            ? new String[]{Manifest.permission.BLUETOOTH_SCAN,
                                           Manifest.permission.BLUETOOTH_CONNECT}
                            : new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
                    requestPermissions(want, REQ_BAND);
                } catch (Exception e) {
                    try { web.evaluateJavascript(
                        "window.__bandEv && window.__bandEv({ev:'fail',txt:'蓝牙权限要不来'})", null); } catch (Exception ignored) {}
                }
            }});
        }

        @JavascriptInterface
        public void bandStop() { ui.post(new Runnable() { @Override public void run() {
            try { band.stop(); } catch (Exception ignored) {}
        }}); }

        /** 常去的人 / 常去的地方（「越来越熟练」的可见证据之一） */
        @JavascriptInterface
        public String often() { return actions.oftenJson(); }
        /** 办事熟练度：每件事干过几次，记了几步 */
        @JavascriptInterface
        public String skill() { return MiliAccessibilityService.skillJson(); }

        /** 无障碍服务有没有开 */
        @JavascriptInterface
        public boolean accOn() { return MiliAccessibilityService.ready(); }

        /** 最近一次切到的窗口，给工具层验「真办成了没」。 */
        @JavascriptInterface
        public String lastWindow() { return MiliAccessibilityService.lastWindow(); }

        /** 最近 20 个窗口事件（带时间戳），验延时动作真办成没。 */
        @JavascriptInterface
        public String recentWindows() { return MiliAccessibilityService.recentWindows(); }

        /** 调试用：把微信当前界面的真实节点树吐出来。uiautomator 被微信挡住，只有这条路 */
        @JavascriptInterface
        public String accDump() { return MiliAccessibilityService.dumpJson(); }

        /** 调试用：布哨，之后 60 秒内无障碍服务自己把界面写进 files/accdump.json */
        @JavascriptInterface
        public void accArm() { MiliAccessibilityService.armDump(); }

        @JavascriptInterface
        public void accDisarm() { MiliAccessibilityService.disarmDump(); }

        /* ---- 桌宠 ---- */
        @JavascriptInterface
        public void startPet() {
            try {
                Intent i = new Intent(MainActivity.this, MilService.class);
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O)
                    startForegroundService(i);
                else startService(i);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void stopPet() {
            try { stopService(new Intent(MainActivity.this, MilService.class)); } catch (Exception ignored) {}
        }

        /* 2026-11-09 设置里那颗「桌宠在桌面显示」开关，读写真状态，
           不是只存个值的假开关。关掉后连悬浮窗一起收，不是设个透明度。 */
        @JavascriptInterface
        public boolean petVisible() {
            return getSharedPreferences("mili", MODE_PRIVATE)
                    .getBoolean("pet_visible", true);
        }

        @JavascriptInterface
        public void setPetVisible(final boolean on) {
            getSharedPreferences("mili", MODE_PRIVATE).edit()
                    .putBoolean("pet_visible", on).apply();
            ui.post(new Runnable() { @Override public void run() {
                try {
                    if (on) {
                        Intent i = new Intent(MainActivity.this, MilService.class);
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O)
                            startForegroundService(i); else startService(i);
                    } else {
                        stopService(new Intent(MainActivity.this, MilService.class));
                    }
                } catch (Throwable ignored) {}
            }});
        }

        /** 悬浮窗权限（桌宠要用） */
        @JavascriptInterface
        public boolean canOverlay() {
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.M) return true;
            return android.provider.Settings.canDrawOverlays(MainActivity.this);
        }

        @JavascriptInterface
        public void askOverlay() {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:" + getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception ignored) {}
        }

        /* ---- 吃药提醒 ---- */
        @JavascriptInterface
        public void addAlarm(int h, int m, String who, String dose) {
            MedAlarm.add(MainActivity.this, h, m, who, dose);
        }

        @JavascriptInterface
        public String alarms() { return MedAlarm.listJson(MainActivity.this); }

        /* ---- 其他 App ---- */
        @JavascriptInterface
        public boolean hasApp(String pkg) {
            try { return getPackageManager().getLaunchIntentForPackage(pkg) != null; }
            catch (Exception e) { return false; }
        }

        /** 别名：网页里习惯写 launch(pkg)，真名是 launchApp —— 少一个转发就静默失败，
            抽屉里点应用没反应就是它。两头都留着，谁调都通。 */
        @JavascriptInterface
        public void launch(String pkg) { launchApp(pkg); }

        @JavascriptInterface
        public void launchApp(String pkg) {
            try {
                Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
                if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); }
            } catch (Exception ignored) {}
        }

        /** 按中文名打开 App（2026-11-12 菲尔特：不管什么软件都要认得）。
            走 Actions.findAppByLabel：PackageManager 全量扫标签，不靠写死名单。 */
        @JavascriptInterface
        public String openByName(String name) {
            return actions.openAppByName(name).toString();
        }

        /** 点掉开屏弹窗（淘宝双11 红包、升级提示这类）。
            只认死几个「关闭」类文字，命中一个就停；点不到就什么都不做，
            绝不按比例乱点 —— 购物页上乱点一下可能就下单了。
            延迟两次：深链跳过去，弹窗一般 1~2.5 秒后才盖上来。 */
        @JavascriptInterface
        public String dismissCovers() {
            final String[] WORDS = {"开心收下", "我知道了", "以后再说", "暂不更新", "跳过", "关闭"};
            final Runnable once = new Runnable() {
                @Override public void run() {
                    for (String w : WORDS) {
                        try {
                            String r = MiliAccessibilityService.tapText(w);
                            if (r != null && r.indexOf("\"ok\":true") >= 0) return;
                        } catch (Throwable ignored) {}
                    }
                }
            };
            ui.postDelayed(once, 1200);
            ui.postDelayed(once, 2600);
            return "{\"ok\":true}";
        }

        /* ---- 眼睛 ---- */
        @JavascriptInterface
        public boolean canSee() { return Vision.hasPermission(MainActivity.this); }

        @JavascriptInterface
        public void askSee() { Vision.askPermission(MainActivity.this, REQ_CAM); }

        /**
         * 拍一张。facing: 0 后置 1 前置。
         * 结果通过 window.__onPhoto(id, base64, w, h) 回传。
         */
        @JavascriptInterface
        public void shoot(int facing, final int cbId) {
            vision.shoot(facing, new Vision.Shot() {
                @Override public void got(final String b64, final int w, final int h) {
                    ui.post(new Runnable() {
                        @Override public void run() {
                            if (web == null) return;
                            web.evaluateJavascript("window.__onPhoto && window.__onPhoto("
                                    + cbId + "," + JSONObject.quote(b64) + "," + w + "," + h + ")", null);
                        }
                    });
                }
                @Override public void failed(final String why) {
                    ui.post(new Runnable() {
                        @Override public void run() {
                            if (web == null) return;
                            web.evaluateJavascript("window.__onPhoto && window.__onPhoto("
                                    + cbId + ",null,0,0," + JSONObject.quote(why) + ")", null);
                        }
                    });
                }
            });
        }

        /* ---- 家电（红外）---- */
        @JavascriptInterface
        public boolean hasIr() { return ir.has(); }

        @JavascriptInterface
        public String irPower(String device, boolean on) {
            return ir.power(device, on).toString();
        }

        /* ---- 防诈骗 ---- */
        @JavascriptInterface
        public String scamLog() { return ScamGuard.logJson(MainActivity.this); }

        /** 手动试一条（演示用）：念一遍它会怎么判 */
        @JavascriptInterface
        public String scamCheck(String text) {
            int lv = ScamGuard.judge(text);
            try {
                return new JSONObject()
                        .put("lv", lv)
                        .put("say", lv == 2 ? "这条不对劲，别理。"
                                : lv == 1 ? "这条有点可疑，你看一眼。" : "这条正常。")
                        .toString();
            } catch (Exception e) { return "{}"; }
        }

        /* ---- 大模型 ---- */
        @JavascriptInterface
        public boolean llmReady() { return llm.configured(); }

        @JavascriptInterface
        public void llmConfig(String base, String key, String model) { llm.save(base, key, model); }

        @JavascriptInterface
        public String llmModel() { return llm.model(); }

        /** 问大模型，结果回调 window.__onLlm(id, text, why) */
        @JavascriptInterface
        public void llmAsk(String q, final int cbId) {
            llm.ask(Llm.PERSONA, q, new Llm.Back() {
                @Override public void ok(final String text) {
                    ui.post(new Runnable() {
                        @Override public void run() {
                            if (web == null) return;
                            web.evaluateJavascript("window.__onLlm && window.__onLlm("
                                    + cbId + "," + JSONObject.quote(text) + ",null)", null);
                        }
                    });
                }
                @Override public void fail(final String why) {
                    ui.post(new Runnable() {
                        @Override public void run() {
                            if (web == null) return;
                            web.evaluateJavascript("window.__onLlm && window.__onLlm("
                                    + cbId + ",null," + JSONObject.quote(why) + ")", null);
                        }
                    });
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (douyinPlayback != null) douyinPlayback.cancel();
        if (INST == this) INST = null;
        if (asr != null) { try { asr.stop(); } catch (Exception ignored) {} asr = null; }
        if (tts != null) { try { tts.stop(); tts.shutdown(); } catch (Exception e) {} tts = null; }
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
