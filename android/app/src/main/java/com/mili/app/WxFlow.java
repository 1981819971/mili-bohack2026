package com.mili.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Path;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 微信自动化：按比例坐标点，用 dispatchGesture 回放。
 *
 * 为什么不按控件名找：新版微信把无障碍节点树封了。
 * 我们实测过 —— 微信在前台时 getRootInActiveWindow() 只有个壳，节点数 0；
 * 打开 FLAG_INCLUDE_NOT_IMPORTANT_VIEWS 也一样。这不是配置错，是微信故意的。
 * GitHub 上 davidche1116/wechat_video_call 的 README 也写明了这一点，
 * 它的做法就是「不内置硬编码坐标，让用户在本机录点，再用 dispatchGesture 回放」。
 *
 * 所以这里存的是「比例坐标」：x/屏宽、y/屏高，都落在 0~1。
 * 换分辨率、换密度都不用重录，这是比硬编码像素坐标强的地方。
 *
 * 一次微信视频的完整路径（用户在自己手机上实际点过一遍录下来的）：
 *   搜索 → 输入名字 → 点第一个结果 → 聊天页右下「+」→ 面板「视频通话」
 *   → 底部弹层「视频通话」→ 拨出
 *
 * 「越来越熟练」在这里是真的：
 *   第一次没有坐标，只能靠猜 + 现场校准，慢且可能错；
 *   录下来之后第二次开始全是定长手势，一条直线点完，不再试探。
 */
public class WxFlow {

    private static final String TAG = "MiliWx";
    private static final String SP = "mili_wx";

    /** 是不是正在通话。唤醒服务靠它决定要不要放开「挂断」「声音大点」两句指令。 */
    public static volatile boolean inCall = false;

    /* 每一步一个 key。所有场景共用同一套点，缺哪个补哪个。 */
    public static final String[] STEPS = {
            "search",       // 聊天列表右上角放大镜
            "searchbox",    // 顶部搜索框
            "paste",        // 长按搜索框后气泡里的「粘贴」
            "result",       // 搜索结果第一个人
            "plus",         // 聊天页右下「+」
            "panelvideo",   // 「+」面板里的「视频通话」
            "confirmvideo", // 底部弹层里的「视频通话」
            "panelcall",    // 面板里的「语音通话」
            "confirmcall",  // 底部弹层里的「语音通话」
            "inputbox",     // 聊天输入框
            "clipbar",      // 输入法上方那条剪贴板提示（点一下把文字塞进去）
            "send",         // 发送按钮
            "back",         // 左上角返回
            "hangup",       // 通话界面的挂断键
            "speaker",      // 通话界面的扬声器开关
    };

    /** 每一步在界面上的中文名，给「校准」界面显示用 */
    public static String zh(String key) {
        switch (key) {
            case "search": return "右上角搜索图标";
            case "searchbox": return "顶部搜索框";
            case "paste": return "长按后气泡里的「粘贴」";
            case "result": return "搜出来的第一个人";
            case "plus": return "聊天页右下角 +";
            case "panelvideo": return "面板里的「视频通话」";
            case "confirmvideo": return "弹层里的「视频通话」";
            case "panelcall": return "面板里的「语音通话」";
            case "confirmcall": return "弹层里的「语音通话」";
            case "inputbox": return "聊天输入框";
            case "clipbar": return "输入法上方的剪贴板提示条";
            case "send": return "发送按钮";
            case "back": return "左上角返回";
            case "hangup": return "通话界面的挂断键";
            case "speaker": return "通话界面的扬声器开关";
            default: return key;
        }
    }

    /** 2026-11-10：logcat 的 main 缓冲在这台机几秒就被系统日志冲掉，
        核名诊断全丢。改写文件，和 kws.log 一个机制。 */
    private static void flog(String s) {
        Log.i("MiliWx", s);
        try {
            android.content.Context c = wxCtx;
            if (c == null) return;
            java.io.File f = new java.io.File(c.getExternalFilesDir(null), "wx.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.CHINA)
                    .format(new java.util.Date()) + " " + s + "\n");
            w.close();
        } catch (Throwable ignored) {}
    }

    private final AccessibilityService svc;
    private static Context wxCtx = null;
    private final Handler ui = new Handler(Looper.getMainLooper());

    /* 当前任务 */
    private String curWho = null;
    private String curWhat = null;   // message / video / call
    private String curText = null;
    private int curIdx = 0;
    private long lastStepAt = 0;
    /** 本次任务什么时候派的。判断「有没有真的走过搜索页」只看这之后的窗口事件，
        免得把上一次任务残留在搜索页的历史算进来。 */
    private long taskStartAt = 0;
    private boolean running = false;
    /** 上一次为什么没起任务：relation:女儿 / unclear / 空 */
    public String lastRefuse = "";

    public WxFlow(AccessibilityService s) { this.svc = s; wxCtx = s.getApplicationContext(); seedDefaults(); }

    /* ================= 出厂坐标 =================
       这台机器上真人手点量出来的 15 个点（1080x2400 那套屏）。
       为什么要内置一份：重装 APK 会把 SharedPreferences 清空 ——
       实测就是这样，坐标全丢，老人点「发微信」，App 只把微信打开就停在聊天列表，
       日志里只有一句「task 没起来：坐标没录全」。
       存的是「像素 + 当时屏尺寸」，回放时按比例换算，换分辨率也不会点歪。 */
    private static final Object[][] DEFAULT_POINTS = {
            {"search", 924, 185}, {"searchbox", 572, 212}, {"paste", 430, 421},
            {"result", 400, 465}, {"inputbox", 500, 2265}, {"clipbar", 115, 1552},
            {"send", 985, 1312}, {"plus", 1015, 2279},
            {"panelvideo", 663, 1623}, {"panelcall", 663, 1623},
            {"confirmvideo", 540, 1955}, {"confirmcall", 540, 2105},
            {"back", 57, 215}, {"hangup", 530, 2035}, {"speaker", 840, 2035},
    };

    /** 只补缺的，不覆盖用户自己录过的点 */
    private void seedDefaults() {
        try {
            SharedPreferences p = sp();
            boolean any = false;
            for (Object[] d : DEFAULT_POINTS) {
                String k = (String) d[0];
                if (p.getString(k, null) != null) continue;
                JSONObject o = new JSONObject();
                o.put("x", d[1]);
                o.put("y", d[2]);
                o.put("w", 1080);
                o.put("h", 2400);
                p.edit().putString(k, o.toString()).apply();
                any = true;
            }
            if (any) Log.i(TAG, "已补入出厂坐标");
        } catch (Throwable t) {
            Log.i(TAG, "补出厂坐标失败 " + t);
        }
    }

    /* ================= 坐标存取 =================
       坑：这台机器物理 1440x3200，系统 Override 成 1080x2400，
       而 getDisplayMetrics() 给的是「可用窗口高度」2234（扣了状态栏和导航栏）。
       adb input tap / screencap 用的是整屏 1080x2400。
       三套尺寸不一致，所以不能只存 0~1 的比例 —— 必须连「当时是在多大的屏上量的」一起存。 */

    /** 存一个点。x/y 是屏幕绝对像素，同时记下当时屏幕尺寸，回放时按比例换 */
    public void savePoint(String key, int x, int y) {
        try {
            int w = screenW(), h = screenH();
            if (w <= 0 || h <= 0) return;
            JSONObject o = new JSONObject();
            o.put("x", x);
            o.put("y", y);
            o.put("w", w);
            o.put("h", h);
            sp().edit().putString(key, o.toString()).apply();
            Log.i(TAG, "录点 " + key + " -> " + x + "," + y + " 屏 " + w + "x" + h);
        } catch (Exception e) {
            Log.i(TAG, "savePoint 失败 " + e);
        }
    }

    /** 读一个点，按当前屏幕尺寸换算成绝对像素。没录过返回 null。 */
    private int[] point(String key) {
        try {
            String raw = sp().getString(key, null);
            if (raw == null) return null;
            JSONObject o = new JSONObject(raw);
            int w = screenW(), h = screenH();
            int rw = o.optInt("w", 0), rh = o.optInt("h", 0);
            double x, y;
            if (rw > 0 && rh > 0) {
                /* 新格式：存的是像素 + 量的时候的屏幕尺寸 */
                x = o.getDouble("x") * (double) w / rw;
                y = o.getDouble("y") * (double) h / rh;
            } else {
                /* 旧格式：只有比例 */
                x = o.getDouble("x") * w;
                y = o.getDouble("y") * h;
            }
            int ix = (int) Math.round(x), iy = (int) Math.round(y);
            if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
            return new int[]{ix, iy};
        } catch (Exception e) {
            return null;
        }
    }

    public boolean hasPoint(String key) { return point(key) != null; }

    /** 还缺哪几步 —— 校准界面用它来提示「下一步点哪儿」 */
    public JSONArray missing(String what) {
        JSONArray arr = new JSONArray();
        for (String k : needFor(what)) if (!hasPoint(k)) arr.put(k);
        return arr;
    }

    /** 某件事需要哪几步。视频和语音共用前几步，只是最后点的不一样。
        「paste」这一步是必须的：微信搜索框不认 ACTION_SET_TEXT，中文只能靠长按粘贴。
        实测抄下来的：长按搜索框 → 气泡里第二个选项「粘贴」→ 文字才进得去。 */
    public String[] needForText(String what, String text) {
        String[] all = needFor(what);
        /* 「只打开聊天」不能走到发送那步。
           实测事故：没给正文时照样点了输入框和发送键，把搜索用的 lch 直接发给了对方。 */
        if ("message".equals(what) && (text == null || text.isEmpty())) {
            java.util.ArrayList<String> keep = new java.util.ArrayList<>();
            for (String k : all) {
                if ("inputbox".equals(k) || "clipbar".equals(k) || "send".equals(k)) continue;
                keep.add(k);
            }
            return keep.toArray(new String[0]);
        }
        return all;
    }

    public static String[] needFor(String what) {
        if ("video".equals(what)) {
            return new String[]{"back", "back", "search", "searchbox", "paste", "result", "plus",
                    "panelvideo", "confirmvideo"};
        }
        if ("call".equals(what)) {
            return new String[]{"back", "back", "search", "searchbox", "paste", "result", "plus",
                    "panelcall", "confirmcall"};
        }
        return new String[]{"back", "back", "search", "searchbox", "paste", "result",
                "inputbox", "clipbar", "send"};
    }

    /** 全齐了吗 */
    public boolean ready(String what) {
        for (String k : needFor(what)) if (!hasPoint(k)) return false;
        return true;
    }

    /** 熟练度：录了几个点、点成功几次 */
    public String skillJson() {
        JSONObject o = new JSONObject();
        try {
            int have = 0;
            for (String k : STEPS) if (hasPoint(k)) have++;
            o.put("points", have);
            o.put("total", STEPS.length);
            o.put("done", sp().getInt("done", 0));
            o.put("fail", sp().getInt("fail", 0));
            JSONArray v = missing("video");
            o.put("videoReady", v.length() == 0);
            o.put("videoMissing", v);
        } catch (Exception ignored) {}
        return o.toString();
    }

    /* ================= 执行 ================= */

    public boolean isRunning() { return running; }

    /** 挂断。不在任何 needFor 里 —— 通话是异步的，什么时候挂断由用户决定。 */
    public boolean hangup() {
        int[] p = point("hangup");
        if (p == null) return false;
        tap(p[0], p[1], null);
        inCall = false;
        Log.i(TAG, "挂断 " + p[0] + "," + p[1]);
        return true;
    }

    /** 通话中切扬声器。位置和挂断同一行，在最右边那个。 */
    public boolean speaker() {
        int[] p = point("speaker");
        if (p == null) return false;
        tap(p[0], p[1], null);
        Log.i(TAG, "扬声器 " + p[0] + "," + p[1]);
        return true;
    }

    /** 派一件事。返回 false 表示坐标还没录全。 */
    public boolean start(String who, String what, String text) {
        if (!ready(what)) return false;
        /* 名字必须抠得出来，否则会在搜索框里塞一句「我想给女儿打个电话」，
           微信搜不到，老人看到的就是「没找到」。 */
        String nm = Name.clean(who);
        /* 2026-11-10 菲尔特定论：老流程（搜拼音首字母 → 点第一个结果）本身是对的。
           之前把「女儿」「老伴」这类微信备注名当关系称呼一律拒发，是流程被改坏的起点 ——
           模型被拒后不甘心，绕开 wechat_message 自己开微信在聊天列表里瞎点，
           差点把消息发到「软件学院」群。备注名就叫「女儿」，就该拿去搜。
           这里只留「别把一整句话塞进搜索框」的校验，不再拦称呼。 */
        if (nm.isEmpty() || !Name.isNameish(nm)) {
            lastRefuse = nm.isEmpty() ? "unclear" : "notname:" + nm;
            Log.i(TAG, "名字没抠干净，不搜：「" + who + "」→「" + nm + "」");
            return false;
        }
        lastRefuse = "";
        /* 2026-11-10：连着派两件事时，旧的 runStep 链和新的抢同一个 Runnable，
           两条链互相覆盖 curIdx，结果两件都办不成。先把旧的收干净再起新的。 */
        if (running) stop();
        curWho = who;
        curWhat = what;
        curText = text;
        curIdx = 0;
        lastStepAt = 0;
        taskStartAt = System.currentTimeMillis();
        running = true;
        waitWx(0);
        return true;
    }

    public void stop() {
        running = false;
        curWho = curWhat = curText = null;
        curIdx = 0;
        ui.removeCallbacks(runStep);
    }

    /* 等微信真的到前台再动手。
       踩过的坑：点完图标立刻开始点坐标，头几步全点在我们自己 App 上，
       等微信起来时已经走到「输入框 / 发送」那几步 —— 于是把搜索用的拼音
       直接发给了上一个聊天对象（实测把 lch 发到了他妈那儿）。 */
    private void waitWx(final int n) {
        if (!running) return;
        if (n >= 16) {
            flog("等了 4 秒窗口事件仍没报微信，按流程停手（不盲点）");
            finish(false);
            return;
        }
        boolean up = false;
        try {
            up = wxUp(MiliAccessibilityService.self());
        } catch (Throwable ignored) {}
        if (up) {
            /* 1400ms：startActivity 之后窗口事件会先到，聊天列表还在渲染。
               700ms 就开点，头几步全点在没加载完的旧页面上 —— 这正是
               「没去搜索、后面还在盲点」的老坑。 */
            flog("微信已在前台，等界面稳了再按流程点");
            ui.postDelayed(runStep, 1400);
        } else {
            ui.postDelayed(new Runnable() {
                @Override public void run() { waitWx(n + 1); }
            }, 250);
        }
    }

    /** 微信到底在前台没有。
        🚨 2026-11-10 真机定论：只看 fgPkg()（窗口事件的 lastPkg）会误判。
        上一条发完消息后键盘没收，搜狗输入法的窗口事件把 lastPkg 盖成了
        com.sohu.inputmethod.sogou.xiaomi —— 接着打视频就白等 10 秒，
        waitWx 超时 finish(false)，视频/语音全没拨出去（logcat 13:53:10 / 13:53:29）。
        根节点包名是第二个可靠来源，它认的是真正前台的那个窗口。 */
    private boolean wxUp(MiliAccessibilityService s) {
        if (s == null) return false;
        if (s.fgPkg().startsWith("com.tencent.mm")) return true;
        try {
            android.view.accessibility.AccessibilityNodeInfo root = s.getRootInActiveWindow();
            CharSequence p = root == null ? null : root.getPackageName();
            if (p != null && p.toString().startsWith("com.tencent.mm")) {
                flog("窗口事件被输入法盖住，根节点包名确认在微信");
                return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    private final Runnable runStep = new Runnable() {
        @Override public void run() {
            if (!running) return;
            String[] need = needForText(curWhat, curText);
            if (curIdx >= need.length) { finish(true); return; }

            String key = need[curIdx];

            // 拨号键一按下去就算「通话中」，语音指令从这一刻起对外开着
            if ("confirmvideo".equals(key) || "confirmcall".equals(key)) inCall = true;

            /* 「粘贴」这一步：先在搜索框上长按，等气泡出来，再点气泡里的「粘贴」。
               以前这里调的是 ACTION_PASTE —— 那需要拿到有焦点的可编辑节点，
               而微信把节点树封了，所以从来没生效过。现在全用手势。 */
            if ("paste".equals(key)) {
                /* 以前是「长按搜索框 → 点气泡里的粘贴」。新版微信在那个气泡最前面
                   加了「AI写作」，把「粘贴」挤走，一点就进 AI 面板，整条流程全乱。
                   现在改点输入法自己的剪贴板条 —— 位置由键盘决定，跟微信怎么改版无关。
                   （坐标是用户亲手点的，不是我量的像素。） */
                final int[] cb = point("clipbar");
                flog("paste：剪贴板条坐标 " + (cb == null ? "null" : (cb[0] + "," + cb[1])));
                if (cb == null) { finish(false); return; }
                tap(cb[0], cb[1], new Runnable() {
                    @Override public void run() {
                        ui.postDelayed(new Runnable() {
                            @Override public void run() {
                                curIdx++;
                                lastStepAt = System.currentTimeMillis();
                                ui.postDelayed(runStep, gapFor("paste"));
                            }
                        }, 420);
                    }
                });
                return;
            }

            /* 需要打字的一步：先把内容塞进剪贴板，等下点剪贴板提示条才有东西可插。
               searchbox 塞的是人名（搜谁），inputbox 塞的是要说的话。 */
            if ("searchbox".equals(key) && curWho != null && !curWho.isEmpty()) {
                /* 塞拼音首字母：李昌洪 → lch。中文名被识别听错一个字就搜不到，
                   首字母往往还对得上，这就是「用拼音找人」的意义。 */
                copyToClipboard(Name.searchTerm(curWho));
            }
            if ("inputbox".equals(key) && curText != null && !curText.isEmpty()) {
                copyToClipboard(curText);
            }

            /* 🚨 2026-11-10 菲尔特定论：老流程（搜拼音首字母 → 点第一个结果）
               本身是对的，别再改它。之前发到「软件学院」是因为**根本没进搜索页**，
               后面还在按坐标盲点 result，等于在聊天列表里点了一个群。
               这里不再核名、不再三态降级，只加一道硬闸：
               本次任务没真的走进微信搜索页，就绝不点这一下 —— 宁可发不出去，
               绝不发给错的人。 */
            if ("result".equals(key)) {
                if (!inWxSearch()) {
                    flog("没进微信搜索页，按流程停手，绝不盲点 result（防发错人）");
                    lastRefuse = "nosearch:" + Name.clean(curWho == null ? "" : curWho);
                    finish(false);
                    return;
                }
                /* 🚨 2026-11-10 21:0x 菲尔特：「不要你那个什么用文字来候选，
                   太麻烦了，就用我们之前的直接点」。彻底删掉 checkContact /
                   findAccessibilityNodeInfosByText / 7 组候选重试 —— 一次标定
                   坐标点下去就往下走，不等、不核名、不重试。这就是 11-10
                   真机 3/3 通过的老流程，别再往里加「聪明」的东西。 */
                int[] rp = point("result");
                if (rp == null) { finish(false); return; }
                flog("回退老流程：点一次标定坐标 (" + rp[0] + "," + rp[1] + ")");
                tap(rp[0], rp[1], new Runnable() {
                    @Override public void run() {
                        ui.postDelayed(new Runnable() {
                            @Override public void run() {
                                curIdx++;
                                lastStepAt = System.currentTimeMillis();
                                ui.postDelayed(runStep, gapFor("result"));
                            }
                        }, 400);
                    }
                });
                return;
            }

            int[] p = point(key);
            if (p == null) { finish(false); return; }

            tap(p[0], p[1], new Runnable() {
                @Override public void run() {
                    ui.postDelayed(new Runnable() {
                        @Override public void run() {
                            curIdx++;
                            lastStepAt = System.currentTimeMillis();
                            ui.postDelayed(runStep, gapFor(key));
                        }
                    }, 400);
                }
            });
        }
    };

    /** 本次任务有没有真的走进微信搜索页。
        微信把节点树封死了，但窗口切换事件里的 Activity 类名是真的 ——
        搜索页固定是 com.tencent.mm/.plugin.fts.ui.FTSMainUI。
        这是「按没按流程走」唯一靠得住的证据，比看坐标点了几次强。 */
    private boolean inWxSearch() {
        /* 🚨 2026-11-10 21:1x 微信三条（发消息/视频/语音）全废的真因：
           只读 lastWindow()，而它被 MIUI 输入法浮层盖成
           `com.miui.contentextension/android.widget.RelativeLayout` ——
           真机日志：前台明明是 FTSMainUI 微信搜索页、剪贴板也已粘进人名，
           这里却报「没找到搜索页证据」→ finish(false) → 整条流程停手。
           wxUp() 用根节点包名/fgPkg 判微信，是同一文件里已验证可靠的信号
           （日志「窗口事件被输入法盖住，根节点包名确认在微信」就是它打的）。
           先认这个，再退回窗口历史。绝不因为浮层把老人挡在门外。 */
        try {
            if (wxUp(MiliAccessibilityService.self())) { flog("根节点/fgPkg 确认在微信，按老流程点结果"); return true; }
        } catch (Throwable ignored) {}
        try {
            String hist = MiliAccessibilityService.recentWindows();
            if (hist != null) {
                for (String line : hist.split("\n")) {
                    int p = line.indexOf('|');
                    if (p <= 0) continue;
                    long ts;
                    try { ts = Long.parseLong(line.substring(0, p).trim()); }
                    catch (Exception e) { continue; }
                    if (ts < taskStartAt - 800) continue;   // 只看这一趟的窗口事件
                    String w = line.substring(p + 1);
                    if (isSearchWindow(w)) { flog("搜索页窗口证据：" + w); return true; }
                }
            }
            /* 微信冷启时可能直接落在上次残留的搜索页，窗口事件不会再触发一次，
               所以当前窗口也要认。 */
            String now = MiliAccessibilityService.lastWindow();
            if (isSearchWindow(now)) { flog("当前就在搜索页：" + now); return true; }
            flog("没找到搜索页证据，当前窗口=" + now);
        } catch (Throwable t) {
            flog("inWxSearch 异常 " + t);
        }
        return false;
    }

    private static boolean isSearchWindow(String w) {
        if (w == null || !w.startsWith("com.tencent.mm/")) return false;
        return w.contains("FTSMainUI") || w.contains("FTS") || w.contains("Search");
    }

    private void dumpNodes(android.view.accessibility.AccessibilityNodeInfo n,
                           StringBuilder sb, int depth) {
        if (n == null || depth > 6 || sb.length() > 600) return;
        CharSequence tx = n.getText();
        CharSequence dc = n.getContentDescription();
        if ((tx != null && tx.length() > 0) || (dc != null && dc.length() > 0)) {
            sb.append('[').append(tx == null ? "" : tx).append('|').append(dc == null ? "" : dc).append("] ");
        }
        for (int i = 0; i < n.getChildCount(); i++) dumpNodes(n.getChild(i), sb, depth + 1);
    }

    /** 结果点中之后统一推进流程，别把 curIdx++ 复制五份。 */
    private void advanceAfterResult() {
        ui.postDelayed(new Runnable() { @Override public void run() {
            curIdx++;
            lastStepAt = System.currentTimeMillis();
            ui.postDelayed(runStep, gapFor("result"));
        } }, 900);
    }

    /** 自适应候选：1080x2400 标定坐标 + 三套基准换算，逐个点、逐个校验。
        校验标准是「窗口离开 FTS 搜索页」—— 点空了就换下一处，绝不蒙着眼往下走。 */
    /* 2026-11-10 19:4x 按菲尔特图一真机截图标定（1080x2400）：
       搜索框 y≈214，「最常使用」标题 y≈365，「女儿 联系人」那行 y≈506，
       「联系人」标题 y≈675，第一条联系人 y≈810。
       微信把无障碍节点树封死了（本机 uiautomator dump 一个 text 都没有），
       所以按名字找节点常常落空，必须靠这组候选；把「女儿」那一行排最前。 */
    private static final int[][] RESULT_CAND_1080 = {
            {260, 506},   /* 最常使用 · 女儿（图一里就是这条没被点进去）*/
            {400, 506}, {540, 506},
            {400, 465},   /* 原标定 */
            {540, 810},   /* 联系人区第一条 */
            {540, 350}, {540, 600}
    };
    private void tryResultCandidate(final int which) {
        /* 20:0x 已停用的慢路径：7 组候选串行。保留代码只为兼容老数据，
           result 步不再调用它。别再启用 —— 菲尔特明确嫌慢。 */
        if (which >= RESULT_CAND_1080.length) {
            flog("自适应候选全试完，还是没进聊天页，停手不盲发");
            lastRefuse = "nosearch:" + Name.clean(curWho == null ? "" : curWho);
            finish(false);
            return;
        }
        final int x = RESULT_CAND_1080[which][0], y = RESULT_CAND_1080[which][1];
        /* 两套基准各点一次：原始 1080 逻辑坐标、按真实屏缩放 */
        tap(x, y, null);
        ui.postDelayed(new Runnable() { @Override public void run() {
            try { MiliAccessibilityService.tapAtScaled1080(x, y); } catch (Throwable ignored) {}
        } }, 220);
        ui.postDelayed(new Runnable() { @Override public void run() {
            if (!inWxSearch()) { flog("候选 " + which + " 命中，已离开搜索页"); advanceAfterResult(); }
            else tryResultCandidate(which + 1);
        } }, 1000);
    }

    /** 在搜索结果里找「名字整名相等」的联系人并点它。
       必须整名相等：搜「女儿」时「软件学院女儿们互帮群」这种包含关系的也不点。
       找不到返回 false，由调用方如实报「没找到这个人」。 */
    /** 返回 null=节点树读不到结果（沿用盲点）；true=整名命中（精确点它）；false=明确不匹配（拒发）。 */
    private Boolean checkContact(String who) {
        final String target = Name.clean(who == null ? "" : who);
        if (target.isEmpty()) return false;
        android.view.accessibility.AccessibilityNodeInfo root =
                svc == null ? null : svc.getRootInActiveWindow();
        if (root == null) return false;
        java.util.List<android.view.accessibility.AccessibilityNodeInfo> hits =
                root.findAccessibilityNodeInfosByText(target);
        if (hits == null || hits.isEmpty()) {
            flog("findAccessibilityNodeInfosByText 命中 0 条，节点树不可读");
            return null;
        }
        for (android.view.accessibility.AccessibilityNodeInfo nd : hits) {
            if (nd == null || nd.getText() == null) continue;
            final String tx = nd.getText().toString();
            if (!target.equals(Name.clean(tx))) continue;   // 整名相等，防「含字」误点
            android.view.accessibility.AccessibilityNodeInfo p = nd;
            for (int i = 0; i < 6 && p != null; i++) {
                if (p.isClickable()) {
                    final android.graphics.Rect r = new android.graphics.Rect();
                    p.getBoundsInScreen(r);
                    flog("精确命中联系人「" + tx + "」(" + r.centerX() + "," + r.centerY() + ")");
                    tap(r.centerX(), r.centerY(), new Runnable() { @Override public void run() {} });
                    return Boolean.TRUE;
                }
                p = p.getParent();
            }
        }
        /* 2026-11-10 真机定论：微信把整棵节点树封死了 —— dump 一个文本节点
           都没有（空字符串）。树里没有可读文本就等于「读不到」，走原盲点流程，
           这正是之前一直通的那条路。核名只在树真的可读时才把关。 */
        try {
            StringBuilder dump = new StringBuilder();
            dumpNodes(root, dump, 0);
            flog("结果页节点文本 dump：" + dump.substring(0, Math.min(500, dump.length())));
            if (dump.length() == 0) return null;   // 整棵树封死 = 读不到 → 原盲点流程
        } catch (Throwable ignored) {}
        flog("结果可读但没有整名叫「" + target + "」的条目，拒发");
        return Boolean.FALSE;
    }

    /** 每步之间留多久。搜索后要等结果，弹层出来要等动画 —— 不能一律同一个间隔。 */
    private long gapFor(String key) {
        switch (key) {
            case "search": return 2000;      // 等搜索页真的切过来（原来 1200 太急）
            case "searchbox": return 900;    // 等键盘出来
            case "paste": return 2200;       // 等搜索结果（原来 1800 太急）
            case "result": return 1500;      // 等聊天页
            case "plus": return 1200;        // 等面板
            case "inputbox": return 1400;    // 等键盘完全弹起，剪贴板条才会出来
            case "clipbar": return 900;      // 等文字进输入框
            case "panelvideo":
            case "panelcall": return 1200;   // 等弹层
            default: return 900;
        }
    }

    private void finish(boolean ok) {
        running = false;
        try {
            sp().edit().putInt(ok ? "done" : "fail",
                    sp().getInt(ok ? "done" : "fail", 0) + 1).apply();
        } catch (Exception ignored) {}
        flog("微信流程结束 ok=" + ok + " what=" + curWhat);
        curWho = curWhat = curText = null;
        curIdx = 0;
    }

    /* ================= 手势 ================= */

    /** 点一下。用 GestureDescription，比 performAction 靠谱 —— 微信不吃 performAction。 */
    private void tap(int x, int y, final Runnable after) {
        try {
            Path p = new Path();
            p.moveTo(x, y);
            GestureDescription.StrokeDescription st =
                    new GestureDescription.StrokeDescription(p, 0, 60);
            GestureDescription g = new GestureDescription.Builder().addStroke(st).build();
            svc.dispatchGesture(g, new AccessibilityService.GestureResultCallback() {
                @Override public void onCompleted(GestureDescription d) {
                    if (after != null) ui.post(after);
                }
                @Override public void onCancelled(GestureDescription d) {
                    Log.i(TAG, "手势被取消 " + x + "," + y);
                    if (after != null) ui.post(after);
                }
            }, ui);
        } catch (Exception e) {
            Log.i(TAG, "tap 失败 " + e);
            if (after != null) ui.post(after);
        }
    }

    /* ================= 剪贴板 ================= */

    private void copyToClipboard(String s) {
        try {
            ClipboardManager cm = (ClipboardManager) svc.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("mili", s));
            Log.i(TAG, "剪贴板 -> " + s);
        } catch (Exception e) {
            Log.i(TAG, "剪贴板失败 " + e);
        }
    }

    /** 长按。微信的长按菜单要按够 700ms 以上才出来，600ms 太短。 */
    private void longPress(int x, int y, final Runnable after) {
        try {
            Path p = new Path();
            p.moveTo(x, y);
            GestureDescription.StrokeDescription st =
                    new GestureDescription.StrokeDescription(p, 0, 800);
            GestureDescription g = new GestureDescription.Builder().addStroke(st).build();
            svc.dispatchGesture(g, new AccessibilityService.GestureResultCallback() {
                @Override public void onCompleted(GestureDescription d) {
                    if (after != null) ui.post(after);
                }
                @Override public void onCancelled(GestureDescription d) {
                    Log.i(TAG, "长按被取消 " + x + "," + y);
                    if (after != null) ui.post(after);
                }
            }, ui);
        } catch (Exception e) {
            Log.i(TAG, "longPress 失败 " + e);
            if (after != null) ui.post(after);
        }
    }

    /* ================= 屏幕尺寸 =================
       实测这台机器有三套尺寸，全部不一样：
         getResources().getDisplayMetrics()  -> 1080x2234  （扣了状态栏 166px）
         getRealMetrics()                    -> 1080x2400
         getCurrentWindowMetrics().getBounds()-> 1080x2400
       adb screencap / input tap 用的也是 1080x2400。
       dispatchGesture 的坐标系跟 adb input tap 是同一套，都是整屏 1080x2400。
       所以必须用 currentWindowMetrics —— 用 metrics 会让所有 y 坐标整体上移 166px，
       点「+」会点到聊天内容上，这是真机上已经踩过的坑。 */
    private int screenW() { return realSize()[0]; }
    private int screenH() { return realSize()[1]; }

    private int[] realSize() {
        try {
            android.view.WindowManager wm =
                    (android.view.WindowManager) svc.getSystemService(Context.WINDOW_SERVICE);
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Rect b = wm.getCurrentWindowMetrics().getBounds();
                return new int[]{b.width(), b.height()};
            }
            android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            return new int[]{dm.widthPixels, dm.heightPixels};
        } catch (Throwable e) {
            android.util.DisplayMetrics dm = svc.getResources().getDisplayMetrics();
            return new int[]{dm.widthPixels, dm.heightPixels};
        }
    }

    private SharedPreferences sp() {
        return svc.getSharedPreferences(SP, Context.MODE_PRIVATE);
    }
}
