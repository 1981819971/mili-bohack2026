package com.mili.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 无障碍：不只是看她卡在哪，也替她办事，而且越办越熟。
 *
 * A. 卡点：哪个 App、哪个页面、待了多久。超过 25 秒没换页 = 卡住了。
 * B. 办事：把「给女儿发微信语音」拆成几步，按节点特征去找、去点。
 * C. 熟练：每办成一次，把这次每步命中的节点特征存下来（mili_flow）。
 *          下次直接按特征找，命中率更高、用的时间更短。
 *          这就是「越来越熟练」在代码里的样子 —— 不是嘴上说的。
 *
 * 为什么不用坐标：分辨率、微信版本、字体大小全会让坐标飘。
 * 按 text / contentDescription 找才稳得住。
 */
public class MiliAccessibilityService extends AccessibilityService {

    private static final String TAG = "MiliAcc";

    /* ---------- A. 卡点（原有逻辑保留） ---------- */
    private static final long STUCK_MS = 25000;
    private static MiliAccessibilityService INSTANCE;

    private String lastPkg = "";
    private String lastPage = "";
    private long pageEnterAt = 0;
    private final List<JSONObject> pending = new ArrayList<>();

    /* ---------- B. 办事：只有坐标回放这一条路 ----------
       旧的那套「按节点文字找控件」已经整段删除，理由见文件末尾。
       微信把无障碍节点树封了（前台节点数 0），按文字找永远找不到。
       现在所有点击都由 WxFlow 用 dispatchGesture 回放实测坐标。 */
    private static WxFlow wxFlow;
    public static WxFlow wx() { return wxFlow; }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        INSTANCE = this;
        wxFlow = new WxFlow(this);
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info != null) {
                /* 只监听窗口切换。CONTENT_CHANGED 在大界面上是每秒几十次的洪水，
                   120ms 节流等于持续高频轰炸系统无障碍管线 —— 今天两次 system_server
                   崩溃（软重启）都发生在自动化流程运行时，先把这个负载砍掉。 */
                /* 窗口切换 + 通知。通知是低频事件，用来自动发现别人发来的红包；
                   CONTENT_CHANGED 仍然不开 —— 那是之前把 system_server 拖崩的洪水。 */
                info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                        | AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED;
                info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
                /* 微信是自绘界面，默认的树里只有最外层壳子、子节点一个都拿不到。
                   打开「包含不重要视图」才把里面的文字和按钮吐出来 ——
                   没有这个，搜人、点「视频通话」全都会找不到节点。 */
                info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
                info.notificationTimeout = 400;
                setServiceInfo(info);
            }
        } catch (Exception ignored) {}
    }

    /* 最近 20 个窗口事件，带时间戳。
       只看「最后一次」会被输入法弹窗骗到（实测前台已经是 SearchActivity，
       最后一条却是 SoftInputWindow），所以改成查一段时间里的全部窗口。 */
    private static final java.util.ArrayDeque<String> WIN_HIST = new java.util.ArrayDeque<>();

    /** 每行 "时间戳|包名/类名"，工具层自己按时间过滤。 */
    public static String recentWindows() {
        StringBuilder sb = new StringBuilder();
        synchronized (WIN_HIST) {
            for (String w : WIN_HIST) sb.append(w).append('\n');
        }
        return sb.toString();
    }

    /** 最近一次别的应用切到的窗口（pkg/Activity 名）。
        工具层拿它验「延时动作到底办没办成」—— Java 侧 startActivity 成功
        不等于点到了搜索页，以前光看 ok:true 会把没办成说成办成了。 */
    public static String lastWindow() {
        if (INSTANCE == null) return "";
        return INSTANCE.lastPkg + "/" + INSTANCE.lastPage;
    }

    public static boolean ready() { return INSTANCE != null; }

    /** 红包那套要用服务本身（截屏 + 手势），给它一个入口 */
    public static MiliAccessibilityService self() { return INSTANCE; }

    /** 任意界面的坐标点击（深链进抖音搜索页后点第一个视频进全屏用）。 */
    public static String tapAt(float fx, float fy) {
        final MiliAccessibilityService s = INSTANCE;
        if (s == null) return "{\"ok\":false,\"err\":\"no-a11y\"}";
        try {
            /* 2026-11-09：跟三入口同一个坑。DisplayMetrics.heightPixels 在
               小米 Android 16 上比真实物理高度少状态栏那截，下半屏（抖音
               「全屏观看」按钮 y≈0.594）会被点偏。改用 getRealSize()。 */
            /* AccessibilityService 是 Service，没有 Activity.getWindowManager()，
               要从 WINDOW_SERVICE 拿 WindowManager。 */
            android.view.WindowManager wm = (android.view.WindowManager)
                    s.getSystemService(android.content.Context.WINDOW_SERVICE);
            android.graphics.Point sz = new android.graphics.Point();
            wm.getDefaultDisplay().getRealSize(sz);
            int x = (int) (sz.x * fx);
            int y = (int) (sz.y * fy);
            android.graphics.Path p = new android.graphics.Path();
            p.moveTo(x, y);
            android.accessibilityservice.GestureDescription.StrokeDescription st =
                    new android.accessibilityservice.GestureDescription.StrokeDescription(p, 0, 60);
            android.accessibilityservice.GestureDescription g =
                    new android.accessibilityservice.GestureDescription.Builder().addStroke(st).build();
            boolean ok = Gestures.send(s, g, 60);
            return "{\"ok\":" + ok + ",\"x\":" + x + ",\"y\":" + y + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":" + JSONObject.quote(String.valueOf(e)) + "}";
        }
    }

    /** 现在最前面是哪个 App。微信把节点树封了，但窗口事件里的包名还是真的。 */
    public String fgPkg() { return lastPkg == null ? "" : lastPkg; }

    /** 派活。what: call / video / message / redpacket / resume / show
        text: 消息正文、红包金额、要搜的剧名 */
    public static void task(String who, String what) {
        task(who, what, null);
    }

    public static boolean task(String who, String what, String text) {
        if (wxFlow == null) return false;
        if (!wxFlow.ready(what)) return false;
        return wxFlow.start(who, what, text);
    }

    public void onAccessibilityEvent(AccessibilityEvent ev) {
        if (ev == null) return;
        int type = ev.getEventType();

        // A. 卡点
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            trackStuck(ev, type);
            autoAllowLaunch(ev);
            try {
                CharSequence pc = ev.getPackageName(), cc = ev.getClassName();
                String w = (pc == null ? "" : pc.toString()) + "/"
                        + (cc == null ? "" : cc.toString());
                synchronized (WIN_HIST) {
                    WIN_HIST.addLast(System.currentTimeMillis() + "|" + w);
                    while (WIN_HIST.size() > 20) WIN_HIST.removeFirst();
                }
            } catch (Throwable ignored) {}
        }

        /* 自动收红包：通知进来就自己走完并把「谁发的、多少钱」报给老人。
           只在微信包内转发，其它 App 一概不碰。 */
        try {
            CharSequence p = ev.getPackageName();
            if (p != null && "com.tencent.mm".equals(p.toString())) Hongbao.onEvent(ev);
        } catch (Throwable ignored) {}

    }

    /* ================= C. 放行 MIUI 的「启动应用」弹窗 =================
       MIUI 会在我们打开别的 App 时弹一句「米粒 想要打开 夸克，是否允许？」。
       老人根本不知道该点哪个，看到就是这个东西坏了 —— 实测就是这么卡住的。
       只认这一个弹窗（类名 ConfirmStartActivity，且按钮里有「始终允许」），
       别的系统弹窗一律不碰。 */
    private void autoAllowLaunch(AccessibilityEvent ev) {
        try {
            String cls = ev.getClassName() == null ? "" : ev.getClassName().toString();
            if (!cls.contains("ConfirmStartActivity")) return;
            final Handler h = new Handler(Looper.getMainLooper());
            for (int i = 1; i <= 4; i++) {
                h.postDelayed(new Runnable() {
                    @Override public void run() {
                        try {
                            AccessibilityNodeInfo root = getRootInActiveWindow();
                            if (root == null) return;
                            AccessibilityNodeInfo b = findText(root, "始终允许", 0);
                            if (b == null) return;
                            AccessibilityNodeInfo clk = clickableUp(b, 0);
                            boolean ok = clk != null && clk.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                            if (!ok) {
                                android.graphics.Rect r = new android.graphics.Rect();
                                b.getBoundsInScreen(r);
                                tapAt((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                            }
                            android.util.Log.i("MiliAcc", "已放行启动应用弹窗");
                        } catch (Throwable ignored) {}
                    }
                }, 350L * i);
            }
        } catch (Throwable ignored) {}
    }

    /* ================= A. 卡点 ================= */

    private void trackStuck(AccessibilityEvent ev, int type) {
        String pkg = ev.getPackageName() == null ? "" : ev.getPackageName().toString();
        if (pkg.equals(getPackageName())) return;

        CharSequence cls = ev.getClassName();
        String page = cls == null ? "" : cls.toString();
        long now = System.currentTimeMillis();

        if (!pkg.equals(lastPkg) || !page.equals(lastPage)) {
            if (pageEnterAt > 0 && now - pageEnterAt >= STUCK_MS) {
                record(lastPkg, lastPage, now - pageEnterAt);
            }
            lastPkg = pkg;
            lastPage = page;
            pageEnterAt = now;
        }
        if (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) pageEnterAt = now;
    }

    private void record(String pkg, String page, long ms) {
        try {
            JSONObject o = new JSONObject();
            o.put("pkg", pkg);
            o.put("page", shortName(page));
            o.put("sec", ms / 1000);
            o.put("at", System.currentTimeMillis());
            pending.add(o);
            flush();
        } catch (Exception ignored) {}
    }

    private String shortName(String cls) {
        if (cls == null || cls.isEmpty()) return "";
        int i = cls.lastIndexOf('.');
        String s = i >= 0 ? cls.substring(i + 1) : cls;
        return s.replace("Activity", "").replace("Layout", "");
    }

    private void flush() {
        try {
            SharedPreferences sp = getSharedPreferences("mili_acc", MODE_PRIVATE);
            JSONArray old = new JSONArray(sp.getString("stuck", "[]"));
            JSONArray arr = new JSONArray();
            int keep = 0;
            for (int i = pending.size() - 1; i >= 0 && keep < 20; i--, keep++) arr.put(pending.get(i));
            for (int i = 0; i < old.length() && arr.length() < 20; i++) arr.put(old.get(i));
            sp.edit().putString("stuck", arr.toString()).apply();
            pending.clear();
        } catch (Exception ignored) {}
    }

    /* ================= B. 办事：只走手势 =================

       旧的那套「按节点文字找控件」整段删掉了。原因不是它写得不好，是它在新版微信上
       根本不可能成功：微信把无障碍节点树封了，前台时 getRootInActiveWindow() 拿到的
       节点数是 0，加 FLAG_INCLUDE_NOT_IMPORTANT_VIEWS 还是 0。
       一条永远找不到目标的路，留着只会让「办了但没办成」这种事反复发生。

       现在只有一条路：坐标 + dispatchGesture 回放。坐标由 WxFlow 管。
       这个类剩下的职责只有两件：看她卡在哪、以及在没装微信时兜个底。 */

    /** 给外面看的熟练度：直接问 WxFlow，不问旧记忆 */
    public static String skillJson() {
        if (wxFlow == null) return "{}";
        return wxFlow.skillJson();
    }


    /* ---------- D. 调试：抓界面节点树 ----------
       微信对 uiautomator 有防护，dump 出来是空的。但无障碍服务自己拿到的树是真的。
       没有这个就只能靠猜微信的控件叫什么 —— 已经猜错过一次（视频通话要点两次）。

       麻烦在于：要抓的是微信的界面，那时我们的 WebView 在后台、CDP 不应答，
       没法从网页那边调。所以这里做成「布好哨、自己抓、落文件」：
       网页那边调 armDump() 把开关打开，之后无障碍服务每 900ms 自己把当前界面
       写进 files/accdump.json，电脑上 run-as 读出来就行。60 秒自动收工。 */
    private static volatile boolean DUMP_ARMED = false;
    private static volatile long DUMP_UNTIL = 0;
    private static final Handler DH = new Handler(Looper.getMainLooper());
    private static final Runnable DUMPER = new Runnable() {
        @Override public void run() {
            if (!DUMP_ARMED || System.currentTimeMillis() > DUMP_UNTIL) { DUMP_ARMED = false; return; }
            try {
                if (INSTANCE != null) {
                    String j = dumpJson();
                    java.io.FileOutputStream fo = INSTANCE.openFileOutput(
                            "accdump.json", android.content.Context.MODE_PRIVATE);
                    fo.write(j.getBytes("UTF-8"));
                    fo.close();
                }
            } catch (Exception ignored) {}
            DH.postDelayed(this, 900);
        }
    };

    /** 网页那边调：布 60 秒的哨 */
    public static void armDump() {
        DUMP_ARMED = true;
        DUMP_UNTIL = System.currentTimeMillis() + 60000;
        DH.removeCallbacks(DUMPER);
        DH.post(DUMPER);
    }

    public static void disarmDump() {
        DUMP_ARMED = false;
        DH.removeCallbacks(DUMPER);
    }

    public static String dumpJson() {
        if (INSTANCE == null) return "{\"err\":\"no_service\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"err\":\"no_root\"}";
        try {
            JSONObject out = new JSONObject();
            out.put("pkg", root.getPackageName() == null ? "" : root.getPackageName().toString());
            /* 屏幕尺寸一起给：JS 要把像素换成百分比坐标再点回来，
               少一次跨桥调用，也少一次「尺寸取错了点偏」。 */
            try {
                android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
                out.put("w", dm.widthPixels);
                out.put("h", dm.heightPixels);
            } catch (Throwable ignored) {}
            JSONArray arr = new JSONArray();
            walk(root, arr, 0, 22);
            out.put("nodes", arr);
            return out.toString();
        } catch (Exception e) {
            return "{\"err\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    /** 深度优先收集有意义的节点：有字的、可点的、可编辑的。纯容器跳过。 */
    /* ==========================================================================
     * 按文字找、按文字点、往框里打字
     *
     * 为什么要有这个：微信把节点树封了，只能靠提前量好的坐标；
     * 但抖音、红果、爱奇艺这些 App 的节点是可读的。
     * 有了「看见什么点什么」，模型就能自己在里面走 —— 搜剧名、挑第一集、点选集，
     * 而不是我们给每个 App 写一套坐标。老人说的剧名千千万，坐标是写不完的。
     * ======================================================================== */

    private static AccessibilityNodeInfo findText(AccessibilityNodeInfo n, String q, int depth) {
        if (n == null || depth > 26) return null;
        try {
            String t = n.getText() == null ? "" : n.getText().toString().trim();
            String d = n.getContentDescription() == null ? "" : n.getContentDescription().toString().trim();
            if ((!t.isEmpty() && t.contains(q)) || (!d.isEmpty() && d.contains(q))) {
                if (n.isVisibleToUser()) return n;
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo c = findText(n.getChild(i), q, depth + 1);
                if (c != null) return c;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** 往上找一个能点的祖先：很多文字节点自己不可点，包它的那一层才收点击 */
    private static AccessibilityNodeInfo clickableUp(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 6) return null;
        if (n.isClickable()) return n;
        return clickableUp(n.getParent(), depth + 1);
    }

    private static String rectStr(AccessibilityNodeInfo n) {
        android.graphics.Rect r = new android.graphics.Rect();
        n.getBoundsInScreen(r);
        return r.left + "," + r.top + "," + r.right + "," + r.bottom;
    }

    /** 把当前窗口的节点树打出来，排查「微信到底封没封节点」用。 */
    public static String dumpTree() {
        if (INSTANCE == null) return "no_service";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "no_root";
        StringBuilder sb = new StringBuilder();
        walkTree(root, sb, 0);
        return sb.length() == 0 ? "empty_tree" : sb.toString();
    }

    private static void walkTree(AccessibilityNodeInfo n, StringBuilder sb, int d) {
        if (n == null || d > 30 || sb.length() > 24000) return;
        try {
            CharSequence t = n.getText(), desc = n.getContentDescription();
            String id = n.getViewIdResourceName();
            if (t != null || desc != null || id != null) {
                android.graphics.Rect r = new android.graphics.Rect();
                n.getBoundsInScreen(r);
                sb.append(d).append(' ').append(n.getClassName()).append(" id=").append(id)
                  .append(" t=[").append(t == null ? "" : t.toString().replace("\n", " ")).append(']')
                  .append(" desc=[").append(desc == null ? "" : desc.toString().replace("\n", " ")).append(']')
                  .append(" clk=").append(n.isClickable()).append(" r=").append(r.toShortString()).append('\n');
            }
            for (int i = 0; i < n.getChildCount(); i++) walkTree(n.getChild(i), sb, d + 1);
        } catch (Throwable ignored) {}
    }

    /** 屏幕上点一下（给那些只认触摸、不认无障碍点击的控件） */
    private static boolean tapAt(int x, int y) {
        try {
            if (INSTANCE == null) return false;
            if (android.os.Build.VERSION.SDK_INT < 24) return false;
            android.graphics.Path p = new android.graphics.Path();
            p.moveTo(x, y);
            android.accessibilityservice.GestureDescription.StrokeDescription st =
                    new android.accessibilityservice.GestureDescription.StrokeDescription(p, 0, 60);
            android.accessibilityservice.GestureDescription g =
                    new android.accessibilityservice.GestureDescription.Builder().addStroke(st).build();
            return Gestures.send(INSTANCE, g, 60);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 找一段文字并点它。
        坑：同一个词在屏幕上可能出现好几次（搜索结果页的「搜索」按钮、输入框里的「搜索」字），
        第一个往往是不可点的文字。所以要遍历所有匹配，挑一个真能点的。 */
    public static String tapText(String q) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        String key = q == null ? "" : q.trim();
        if (key.isEmpty()) return "{\"ok\":false,\"err\":\"empty\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"ok\":false,\"err\":\"no_root\"}";

        java.util.List<AccessibilityNodeInfo> hits = new java.util.ArrayList<>();
        findAll(root, key, hits, 0);
        if (hits.isEmpty()) return "{\"ok\":false,\"err\":\"not_found\"}";

        AccessibilityNodeInfo fallback = null;
        for (AccessibilityNodeInfo n : hits) {
            AccessibilityNodeInfo clk = clickableUp(n, 0);
            if (clk != null && clk.isVisibleToUser()) {
                try {
                    if (clk.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                        return "{\"ok\":true,\"how\":\"click\",\"rect\":\"" + rectStr(clk) + "\"}";
                    }
                } catch (Throwable ignored) {}
            }
            if (fallback == null) fallback = n;
        }

        if (fallback == null) return "{\"ok\":false,\"err\":\"not_found\"}";
        try {
            android.graphics.Rect r = new android.graphics.Rect();
            fallback.getBoundsInScreen(r);
            boolean ok = tapAt((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            return "{\"ok\":" + ok + ",\"how\":\"tap\",\"rect\":\"" + rectStr(fallback) + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    /** 只在上半屏找并点。提交搜索时必须用它：
        键盘右下角那个「搜索」也在屏幕里，点它等于没提交。 */
    public static String tapTextTop(String q, int maxY) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        String key = q == null ? "" : q.trim();
        if (key.isEmpty()) return "{\"ok\":false,\"err\":\"empty\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"ok\":false,\"err\":\"no_root\"}";

        java.util.List<AccessibilityNodeInfo> hits = new java.util.ArrayList<>();
        findAll(root, key, hits, 0);
        for (AccessibilityNodeInfo n : hits) {
            android.graphics.Rect r = new android.graphics.Rect();
            n.getBoundsInScreen(r);
            if (maxY > 0 && r.top > maxY) continue;
            AccessibilityNodeInfo clk = clickableUp(n, 0);
            try {
                if (clk != null && clk.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    return "{\"ok\":true,\"how\":\"click\",\"rect\":\"" + rectStr(clk) + "\"}";
                }
                boolean ok = tapAt((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                if (ok) return "{\"ok\":true,\"how\":\"tap\",\"rect\":\"" + rectStr(n) + "\"}";
            } catch (Throwable ignored) {}
        }
        return "{\"ok\":false,\"err\":\"not_found\"}";
    }

    private static void findAll(AccessibilityNodeInfo n, String q,
                                java.util.List<AccessibilityNodeInfo> out, int depth) {
        if (n == null || depth > 26 || out.size() > 40) return;
        try {
            String t = n.getText() == null ? "" : n.getText().toString().trim();
            String d = n.getContentDescription() == null ? "" : n.getContentDescription().toString().trim();
            if ((!t.isEmpty() && t.contains(q)) || (!d.isEmpty() && d.contains(q))) {
                if (n.isVisibleToUser()) out.add(n);
            }
            for (int i = 0; i < n.getChildCount(); i++) findAll(n.getChild(i), q, out, depth + 1);
        } catch (Throwable ignored) {}
    }

    /* ================= 悟空浏览器里搜 =================
       老人要的是「在悟空里搜」，不是拿悟空打开一张百度网页。
       实测：悟空首页是自绘的，无障碍树里根本没有搜索框节点，只能按屏幕比例点一下；
       点进去以后搜索页节点是齐的，写字用 ACTION_SET_TEXT，提交必须精确找
       text=="搜索" 的黄色 Button —— 用 tapText("搜索") 会点中搜索框本身
       （它的 content-desc 里带「搜索框」三个字）。 */
    public static String wukongSearch(String q) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        final String text = q == null ? "" : q.trim();
        if (text.isEmpty()) return "{\"ok\":false,\"err\":\"empty\"}";
        final Handler h = new Handler(INSTANCE.getMainLooper());
        final int[] tries = {0};
        final Runnable[] step = new Runnable[1];
        step[0] = new Runnable() {
            @Override public void run() {
                try {
                    AccessibilityNodeInfo btn = findExact("搜索", 500);
                    if (btn == null) {
                        /* 还没进搜索页：按屏幕比例点首页搜索框，再回来看一眼 */
                        android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
                        tapAt((int) (dm.widthPixels * 0.28f), (int) (dm.heightPixels * 0.083f));
                        if (++tries[0] < 5) h.postDelayed(this, 800);
                        return;
                    }
                    typeText(text);
                    h.postDelayed(new Runnable() {
                        @Override public void run() {
                            try {
                                AccessibilityNodeInfo b = findExact("搜索", 500);
                                if (b == null) return;
                                android.graphics.Rect r = new android.graphics.Rect();
                                b.getBoundsInScreen(r);
                                AccessibilityNodeInfo clk = clickableUp(b, 0);
                                if (clk == null || !clk.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                                    tapAt((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                                }
                            } catch (Throwable ignored) {}
                        }
                    }, 700);
                } catch (Throwable ignored) {}
            }
        };
        h.postDelayed(step[0], 400);
        return "{\"ok\":true}";
    }

    /* ================= 网页播放器控制 =================
       系统媒体键对网页视频没用 —— 它得 App 自己注册媒体会话才收得到。
       实测悟空播放剧集时是横屏 WebView，节点里「上一集」「下一集」「播放」
       都能读到（有的挂在 text 上，有的只挂在 content-desc 上），直接点它们最稳。 */
    /* ================= 截一张屏，交给智能体看 =================
       2026-11-05 菲尔特：「手机上的 agent 到底能不能行，感觉它什么都做不了」。
       根子之一是它瞎 —— 只能读无障碍的文字节点，看不见界面长什么样。
       DeepSeek 本身没有视觉，所以这张图交给云视觉看一眼，描述再回给大脑。
       缩到宽 720 + JPEG 70，一张 60~90KB，不拖慢也不爆内存。 */
    public static String shotBase64() {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        if (android.os.Build.VERSION.SDK_INT < 30) return "{\"ok\":false,\"err\":\"too_old\"}";
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final String[] out = {null};
        try {
            INSTANCE.takeScreenshot(android.view.Display.DEFAULT_DISPLAY, INSTANCE.getMainExecutor(),
                new AccessibilityService.TakeScreenshotCallback() {
                    @Override public void onSuccess(AccessibilityService.ScreenshotResult r) {
                        try {
                            android.graphics.Bitmap b = android.graphics.Bitmap.wrapHardwareBuffer(
                                    r.getHardwareBuffer(), r.getColorSpace());
                            if (b != null) {
                                android.graphics.Bitmap c = b.copy(android.graphics.Bitmap.Config.ARGB_8888, false);
                                int w = c.getWidth();
                                int nw = Math.min(720, w);
                                int nh = (int) ((float) c.getHeight() * nw / w);
                                android.graphics.Bitmap s2 = android.graphics.Bitmap.createScaledBitmap(c, nw, nh, true);
                                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                                s2.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, bo);
                                out[0] = android.util.Base64.encodeToString(bo.toByteArray(),
                                        android.util.Base64.NO_WRAP);
                                try { s2.recycle(); c.recycle(); } catch (Throwable ignored) {}
                            }
                        } catch (Throwable ignored) {
                        } finally {
                            try { r.getHardwareBuffer().close(); } catch (Throwable ignored) {}
                            latch.countDown();
                        }
                    }
                    @Override public void onFailure(int code) { latch.countDown(); }
                });
            latch.await(2500, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (Throwable ignored) {}
        if (out[0] == null) return "{\"ok\":false,\"err\":\"shot_failed\"}";
        return "{\"ok\":true,\"b64\":\"" + out[0] + "\"}";
    }

    /* 一条龙：搜 → 点第一条 → 播放 → 全屏。
       2026-11-05 菲尔特：「怎么没有帮我点开后会友期自动全屏」。
       以前只做到「停在结果页」，最后三下还得老人自己点 —— 那不叫替他办事。
       悟空的搜索结果页是 WebView，节点树出得比原生慢，所以三段固定节拍，
       宁慢一点也别点空。 */
    public static String watchPlay(final String show) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        final String text = show == null ? "" : show.trim();
        if (text.isEmpty()) return "{\"ok\":false,\"err\":\"empty\"}";
        wukongSearch(text);
        final Handler h = new Handler(INSTANCE.getMainLooper());
        h.postDelayed(new Runnable() {
            @Override public void run() {
                try {
                    String t = tapFirstResult();
                    if (t == null || t.indexOf("\"ok\":true") < 0) {
                        /* 结果页的卡片大小不固定，bigClickable 可能挑不到 ——
                           退一步按比例点第一张卡的中心。 */
                        android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
                        tapAt((int) (dm.widthPixels * 0.5f), (int) (dm.heightPixels * 0.42f));
                    }
                } catch (Throwable ignored) {}
                h.postDelayed(new Runnable() {
                    @Override public void run() {
                        try { playerControl("播放"); } catch (Throwable ignored) {}
                        h.postDelayed(new Runnable() {
                            @Override public void run() {
                                try { playerControl("全屏"); } catch (Throwable ignored) {}
                            }
                        }, 1200);
                    }
                }, 2500);
            }
        }, 4500);
        return "{\"ok\":true,\"say\":\"找到「" + text + "」了，正在给你点开\"}";
    }

    /* 上下滑动。老人不用，智能体用 —— 它得能自己往下翻找东西，
       不能只点屏幕上第一屏看得见的那几个。 */
    public static String swipe(float fx1, float fy1, float fx2, float fy2) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        try {
            android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
            int x1 = (int) (dm.widthPixels * fx1), y1 = (int) (dm.heightPixels * fy1);
            int x2 = (int) (dm.widthPixels * fx2), y2 = (int) (dm.heightPixels * fy2);
            android.accessibilityservice.GestureDescription.Builder b =
                    new android.accessibilityservice.GestureDescription.Builder();
            android.graphics.Path p = new android.graphics.Path();
            p.moveTo(x1, y1);
            p.lineTo(x2, y2);
            b.addStroke(new android.accessibilityservice.GestureDescription.StrokeDescription(p, 0, 320));
            boolean ok = Gestures.send(INSTANCE, b.build(), 320);
            return "{\"ok\":" + ok + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    public static String playerControl(String cmd) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        String c = cmd == null ? "" : cmd;
        String[] keys;
        if (c.contains("下一")) keys = new String[]{"下一集"};
        else if (c.contains("上一")) keys = new String[]{"上一集"};
        else if (c.contains("全屏")) keys = new String[]{"全屏", "网页全屏", "退出全屏"};
        else keys = new String[]{"播放", "暂停"};

        String r0 = tryTapPlayer(keys);
        if (r0 != null) return r0;
        /* 控制栏收起来了：点一下画面把它唤出来，等节点树重建，再点一次。
           实测网页播放器的控制栏按钮 bounds 高度是 0（折叠态），
           isVisibleToUser() 会把它们全过滤掉 —— 所以这里不能按可见性筛。 */
        tapPercent(0.5, 0.5);
        try { Thread.sleep(600); } catch (Throwable ignored) {}
        String r1 = tryTapPlayer(keys);
        if (r1 != null) return r1;
        return "{\"ok\":false,\"err\":\"no_control\",\"hint\":\"已唤起控制栏\"}";
    }

    private static String tryTapPlayer(String[] keys) {
        for (String key : keys) {
            AccessibilityNodeInfo n = findByLabel(key, 0);
            if (n == null) continue;
            try {
                AccessibilityNodeInfo clk = clickableUp(n, 0);
                if (clk != null && clk.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    return "{\"ok\":true,\"how\":\"click\",\"key\":\"" + key + "\"}";
                }
                android.graphics.Rect r = new android.graphics.Rect();
                n.getBoundsInScreen(r);
                if (tapAt((r.left + r.right) / 2, (r.top + r.bottom) / 2)) {
                    return "{\"ok\":true,\"how\":\"tap\",\"key\":\"" + key + "\"}";
                }
            } catch (Throwable ignored) {}
        }
        return null;
    }

    /** text 或 content-desc 精确等于 label 的节点（控制栏按钮两种挂法都有）。 */
    private static AccessibilityNodeInfo findByLabel(String label, int maxY) {
        if (INSTANCE == null) return null;
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return null;
        return findByLabelIn(root, label, maxY, 0);
    }

    private static AccessibilityNodeInfo findByLabelIn(AccessibilityNodeInfo n, String label, int maxY, int depth) {
        if (n == null || depth > 26) return null;
        try {
            CharSequence t = n.getText();
            CharSequence d = n.getContentDescription();
            boolean hit = (t != null && label.equals(t.toString().trim()))
                    || (d != null && label.equals(d.toString().trim()));
            if (hit) {
                android.graphics.Rect r = new android.graphics.Rect();
                n.getBoundsInScreen(r);
                if (maxY <= 0 || r.top <= maxY) return n;
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo x = findByLabelIn(n.getChild(i), label, maxY, depth + 1);
                if (x != null) return x;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** 按屏幕比例点一下。悟空的信息流是自绘的，无障碍树里没有节点，
        只能靠位置；用比例而不是像素，换分辨率也不至于全废。 */
    public static String tapPercent(double fx, double fy) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        /* 2026-11-10 万能自适应：跟 tapAt 统一到真实物理尺寸，
           不再用 DisplayMetrics.heightPixels（那是扣了状态栏的可用区，下半屏会偏）。*/
        String r = tapAt((float) fx, (float) fy);
        boolean ok = r != null && r.indexOf("\"ok\":true") >= 0;
        return "{\"ok\":" + ok + "}";
    }

    /** 🚨 万能自适应（2026-11-10 菲尔特：「做一下万能自适应」）
        换手机时三套尺寸会打架：物理 1440x3200 / wm override 1080x2400 /
        DisplayMetrics 可用区 1080x2234。任何一套写死都会点偏。
        这里的做法不赌基准：
          ① 先按按钮上的文字找节点点（节点坐标永远是对的）；
          ② 找不到文字，就把同一个比例在三套基准上各点一次；
          ③ 每次点完由调用方校验结果（窗口切了没 / 横屏了没），命中才停手。
        这样换分辨率、换宽高比、App 改版挪了按钮，都还有机会命中。 */
    public static String tapTextAny(String... labels) {
        if (INSTANCE == null || labels == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        /* 2026-11-10 20:0x 菲尔特「按文字找节点会不会太慢？」：
           会。tapText 每次要遍历整棵无障碍树，微信/抖音又把树封死，
           找三四个词纯属白等。这里硬限 2 个词、总耗时 250ms，
           找不到立刻交回给坐标点击，绝不让老人干等。 */
        final long t0 = System.currentTimeMillis();
        int tried = 0;
        for (String q : labels) {
            if (q == null || q.isEmpty()) continue;
            if (tried >= 2 || System.currentTimeMillis() - t0 > 250) break;
            tried++;
            String r = tapText(q);
            if (r != null && r.indexOf("\"ok\":true") >= 0) {
                return "{\"ok\":true,\"how\":\"text\",\"label\":\"" + q + "\"}";
            }
        }
        return "{\"ok\":false,\"err\":\"no_text\"}";
    }

    /** 按可用区基准点一下（第二套基准，给自适应候选列表用）。 */
    public static String tapAtMetrics(double fx, double fy) {
        if (INSTANCE == null) return "{\"ok\":false}";
        try {
            android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
            return tapAbs((int) (dm.widthPixels * fx), (int) (dm.heightPixels * fy));
        } catch (Throwable t) { return "{\"ok\":false}"; }
    }

    /** 把 1080x2400 标定坐标按当前屏幕等比例换算（第三套基准）。 */
    public static String tapAtScaled1080(int x, int y) {
        if (INSTANCE == null) return "{\"ok\":false}";
        try {
            android.view.WindowManager wm = (android.view.WindowManager)
                    INSTANCE.getSystemService(android.content.Context.WINDOW_SERVICE);
            android.graphics.Point sz = new android.graphics.Point();
            wm.getDefaultDisplay().getRealSize(sz);
            return tapAbs(Math.round(x * sz.x / 1080f), Math.round(y * sz.y / 2400f));
        } catch (Throwable t) { return "{\"ok\":false}"; }
    }

    /** 按物理屏幕绝对像素点一下。
        2026-11-09 真机踩坑：tapPercent 用的是 DisplayMetrics.heightPixels，
        在小米 Android 16 上跟 adb wm size 的真实物理高度不一致（差状态栏那截），
        屏幕下半部的点击会被带偏 —— 微信「二维码收款」那一下正好偏了 100 多像素，
        点进了网页错误页。微信支付页必须用 getRealSize() 量出来的物理坐标。 */
    public static String tapAbs(int x, int y) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        boolean ok = tapAt(x, y);
        return "{\"ok\":" + ok + "}";
    }

    /** 精确按 text 找节点，只认上半屏 —— 排除键盘右下角那个「搜索」。 */
    private static AccessibilityNodeInfo findExact(String label, int maxY) {
        if (INSTANCE == null) return null;
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return null;
        return findExactIn(root, label, maxY, 0);
    }

    private static AccessibilityNodeInfo findExactIn(AccessibilityNodeInfo n, String label, int maxY, int depth) {
        if (n == null || depth > 26) return null;
        try {
            CharSequence t = n.getText();
            if (t != null && label.equals(t.toString().trim()) && n.isVisibleToUser()) {
                android.graphics.Rect r = new android.graphics.Rect();
                n.getBoundsInScreen(r);
                if (maxY <= 0 || r.top <= maxY) return n;
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo hit = findExactIn(n.getChild(i), label, maxY, depth + 1);
                if (hit != null) return hit;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** 往当前输入框里写字。先找焦点框，没有就找第一个可编辑的 */
    public static String typeText(String txt) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"ok\":false,\"err\":\"no_root\"}";
        AccessibilityNodeInfo box = findEditable(root, 0);
        if (box == null) return "{\"ok\":false,\"err\":\"no_input\"}";
        try {
            box.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            Bundle b = new Bundle();
            b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, txt);
            boolean ok = box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
            return "{\"ok\":" + ok + ",\"rect\":\"" + rectStr(box) + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    /**
     * 往当前输入框里写字（备用路线）：先放剪贴板，再让输入框粘贴。
     *
     * 为什么需要第二条路：有些输入框（浏览器地址栏、微信搜索框）对
     * ACTION_SET_TEXT 返回 true 却一个字都不进 —— typeText 看着成功，其实白干。
     * 这条走 ACTION_PASTE，绕开写字的接口，直接让输入框自己粘。
     */
    public static String pasteInto(String txt) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        android.content.ClipboardManager cm = (android.content.ClipboardManager)
                INSTANCE.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        if (cm == null) return "{\"ok\":false,\"err\":\"no_clip\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"ok\":false,\"err\":\"no_root\"}";
        AccessibilityNodeInfo box = findEditable(root, 0);
        if (box == null) return "{\"ok\":false,\"err\":\"no_input\"}";
        try {
            box.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            android.content.ClipData cd = android.content.ClipData.newPlainText("mili", txt);
            cm.setPrimaryClip(cd);
            boolean ok = box.performAction(AccessibilityNodeInfo.ACTION_PASTE);
            return "{\"ok\":" + ok + ",\"via\":\"paste\",\"rect\":\"" + rectStr(box) + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 26) return null;
        try {
            if (n.isEditable() && n.isVisibleToUser()) return n;
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo c = findEditable(n.getChild(i), depth + 1);
                if (c != null) return c;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** 点搜索结果里的第一条。
        搜索结果基本都是图片/视频块，没有可读文字，tap_text 找不到；
        但它们够大、在列表区、可点 —— 按这个特征找第一个。 */
    public static String tapFirstResult() {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"ok\":false,\"err\":\"no_root\"}";
        AccessibilityNodeInfo hit = bigClickable(root, 0);
        if (hit == null) return "{\"ok\":false,\"err\":\"not_found\"}";
        try {
            android.graphics.Rect r = new android.graphics.Rect();
            hit.getBoundsInScreen(r);
            boolean ok = tapAt((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            return "{\"ok\":" + ok + ",\"rect\":\"" + r.left + "," + r.top + "," + r.right + "," + r.bottom + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    private static AccessibilityNodeInfo bigClickable(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 24) return null;
        try {
            if (n.isVisibleToUser() && n.isClickable()) {
                android.graphics.Rect r = new android.graphics.Rect();
                n.getBoundsInScreen(r);
                int w = r.width(), h = r.height();
                /* 够大、在导航栏下方、不是整屏容器 */
                if (w > 280 && h > 280 && r.top > 300 && h < 1900) return n;
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo c = bigClickable(n.getChild(i), depth + 1);
                if (c != null) return c;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** 按一下系统返回键。
        为什么要这个：搜东西之前得先退回 App 首页，
        否则它还停在上次那个搜索结果页，界面上没有搜索入口。 */
    /* ==========================================================================
     * 全局键 / 长按 / 应用清单
     *
     * 这三样是「智能体自己动手」的底子，缺一样它就瘸：
     *   没有 home 键 —— 进了设置页就退不回桌面，只能在里面乱转；
     *   没有长按   —— 微信的复制 / 转发 / 删除菜单永远打不开（那些只在长按里）；
     *   没有清单   —— 老人说「那个看视频的」，它连装了什么都不知道。
     * ======================================================================== */

    /** 全局键。老人说不出口的东西，智能体得自己按得到。 */
    public static String pressKey(String key) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        String k = key == null ? "" : key.trim().toLowerCase();
        try {
            int a;
            if (k.equals("home") || k.equals("桌面")) a = GLOBAL_ACTION_HOME;
            else if (k.equals("back") || k.equals("返回")) a = GLOBAL_ACTION_BACK;
            else if (k.equals("recents") || k.equals("最近") || k.equals("多任务")) a = GLOBAL_ACTION_RECENTS;
            else if (k.equals("notifications") || k.equals("notif") || k.equals("通知")) a = GLOBAL_ACTION_NOTIFICATIONS;
            else if (k.equals("quick") || k.equals("quicksettings") || k.equals("下拉")) a = GLOBAL_ACTION_QUICK_SETTINGS;
            else return "{\"ok\":false,\"err\":\"bad_key\"}";
            boolean ok = INSTANCE.performGlobalAction(a);
            return "{\"ok\":" + ok + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    /** 长按某个点。菜单类操作全靠它。 */
    public static String longPress(double fx, double fy) {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        if (android.os.Build.VERSION.SDK_INT < 24) return "{\"ok\":false,\"err\":\"too_old\"}";
        try {
            android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
            int x = (int) (dm.widthPixels * fx), y = (int) (dm.heightPixels * fy);
            android.graphics.Path p = new android.graphics.Path();
            p.moveTo(x, y);
            android.accessibilityservice.GestureDescription.StrokeDescription st =
                    new android.accessibilityservice.GestureDescription.StrokeDescription(p, 0, 750);
            android.accessibilityservice.GestureDescription g =
                    new android.accessibilityservice.GestureDescription.Builder().addStroke(st).build();
            boolean ok = Gestures.send(INSTANCE, g, 750);
            return "{\"ok\":" + ok + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    /** 手机里装了哪些能打开的 App（中文名 + 包名）。自己装的排前面，系统应用丢掉。 */
    public static String listApps() {
        if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
        try {
            android.content.pm.PackageManager pm = INSTANCE.getPackageManager();
            java.util.List<android.content.pm.ApplicationInfo> all =
                    pm.getInstalledApplications(android.content.pm.PackageManager.GET_META_DATA);
            JSONArray arr = new JSONArray();
            for (android.content.pm.ApplicationInfo ai : all) {
                boolean sys = (ai.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
                if (sys) continue;
                android.content.Intent it = pm.getLaunchIntentForPackage(ai.packageName);
                if (it == null) continue;                 /* 打不开的（纯服务）不要 */
                String label;
                try { label = String.valueOf(pm.getApplicationLabel(ai)); } catch (Throwable t) { label = ai.packageName; }
                JSONObject o = new JSONObject();
                o.put("name", label);
                o.put("pkg", ai.packageName);
                arr.put(o);
                if (arr.length() >= 80) break;
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("apps", arr);
            return out.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    public static String pressBack() {
        try {
            if (INSTANCE == null) return "{\"ok\":false,\"err\":\"no_service\"}";
            boolean ok = INSTANCE.performGlobalAction(GLOBAL_ACTION_BACK);
            return "{\"ok\":" + ok + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }

    /** 当前界面上的文字清单，给模型「看」用 */
    public static String screenText() {
        if (INSTANCE == null) return "{\"err\":\"no_service\"}";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "{\"err\":\"no_root\"}";
        try {
            JSONObject out = new JSONObject();
            out.put("pkg", root.getPackageName() == null ? "" : root.getPackageName().toString());
            /* 屏幕尺寸一起给：JS 要把像素换成百分比坐标再点回来，
               少一次跨桥调用，也少一次「尺寸取错了点偏」。 */
            try {
                android.util.DisplayMetrics dm = INSTANCE.getResources().getDisplayMetrics();
                out.put("w", dm.widthPixels);
                out.put("h", dm.heightPixels);
            } catch (Throwable ignored) {}
            JSONArray arr = new JSONArray();
            walk(root, arr, 0, 22);
            out.put("nodes", arr);
            return out.toString();
        } catch (Throwable e) {
            return "{\"err\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    private static void walk(AccessibilityNodeInfo n, JSONArray arr, int depth, int maxDepth) {
        if (n == null || depth > maxDepth) return;
        try {
            String t = n.getText() == null ? "" : n.getText().toString().trim();
            String d = n.getContentDescription() == null ? "" : n.getContentDescription().toString().trim();
            String id = n.getViewIdResourceName() == null ? "" : n.getViewIdResourceName();
            boolean click = n.isClickable();
            boolean edit = n.isEditable();
            if (!t.isEmpty() || !d.isEmpty() || click || edit || !id.isEmpty()) {
                if (n.isVisibleToUser()) {
                    JSONObject o = new JSONObject();
                    if (!t.isEmpty()) o.put("t", t.length() > 40 ? t.substring(0, 40) : t);
                    if (!d.isEmpty()) o.put("d", d.length() > 40 ? d.substring(0, 40) : d);
                    if (!id.isEmpty()) o.put("id", id);
                    o.put("cls", shortCls(n.getClassName() == null ? "" : n.getClassName().toString()));
                    if (click) o.put("c", 1);
                    if (edit) o.put("e", 1);
                    android.graphics.Rect r = new android.graphics.Rect();
                    n.getBoundsInScreen(r);
                    o.put("b", r.left + "," + r.top + "," + r.right + "," + r.bottom);
                    o.put("dep", depth);
                    arr.put(o);
                }
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                walk(n.getChild(i), arr, depth + 1, maxDepth);
            }
        } catch (Exception ignored) {}
    }

    private static String shortCls(String c) {
        if (c == null || c.isEmpty()) return "";
        int i = c.lastIndexOf('.');
        return i >= 0 ? c.substring(i + 1) : c;
    }

    @Override public void onInterrupt() {}

    /* 2026-11-06 补的洞：INSTANCE 只在 onServiceConnected 里赋值，从来没清过。
       服务被系统解绑（MIUI 强停、内存回收、用户在设置里关掉）之后，INSTANCE 还指着那个
       死对象，ready() 照样返回 true —— 上层以为障碍在，照常派活，点击全部落空，
       表现就是「有时候成功，有时候一点反应都没有」。
       解绑时把它清掉，让上层能看见「它真的没了」，自愈才有触发条件。 */
    @Override public boolean onUnbind(android.content.Intent intent) {
        INSTANCE = null;
        wxFlow = null;
        synchronized (WIN_HIST) { WIN_HIST.clear(); }
        return super.onUnbind(intent);
    }

    @Override public void onDestroy() {
        INSTANCE = null;
        wxFlow = null;
        super.onDestroy();
    }
}
