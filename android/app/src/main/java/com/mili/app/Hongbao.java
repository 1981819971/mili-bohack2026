package com.mili.app;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.accessibilityservice.GestureDescription;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;

/**
 * 领红包。
 *
 * 难点不在「点」，在「找」：红包在聊天里是别人什么时候发就什么时候出现，
 * 位置每次都不同；而微信把无障碍节点树封了（前台节点数恒 0），按控件找根本无从下手。
 *
 * 所以换了一条路：截屏看颜色。
 * 微信的红包气泡和「开」按钮都是同一个橙（约 #FA9D3B），
 * 在整个界面里这个色很少见 —— 找到橙色块就是红包。
 *   第一屏（聊天）：取「最靠下」的那块，那是最新一条
 *   第二屏（红包详情）：取「最大」的那块，那就是开
 *
 * 这条路的代价是必须能截屏（无障碍服务的 canTakeScreenshot），
 * 好处是完全不依赖微信内部结构，微信怎么改版都不影响。
 */
public class Hongbao {

    private static final String TAG = "MiliHb";
    private static final Handler UI = new Handler(Looper.getMainLooper());

    public interface Back { void done(boolean ok, String msg); }

    /* ================= 自动抢 =================
       参考 GitHub 上 WeChatLuckyMoney / GrabRedEnvelope 的思路（通知触发 + 窗口状态机 +
       红包签名去重），但按这台机的实际情况改了：
         实测微信把 AccessibilityService 的节点树也封了（dumpTree 返回 empty_tree），
         「按文本 / 控件 ID 找红包气泡」这条路走不通。
       能用的只有两样，都不依赖固定位置、也不锁定发的人：
         ① 系统通知（不经过微信节点树）—— 自动发现红包、从通知文字里读出是谁发的
         ② 本文件已有的「截屏找橙色块」—— 聊天页取最靠下那块（最新红包），
            红包弹框取最大那块（「开」），微信怎么改版都不影响
       窗口切换事件的 className 是系统级的，用来判断进没进红包弹框 / 详情页。 */
    private static volatile boolean busy = false;
    private static String lastSig = "", sender = "", amount = "", reportedSig = "";
    private static long lastSigAt = 0L;

    /** 由 MiliAccessibilityService.onAccessibilityEvent 转进来。 */
    public static void onEvent(AccessibilityEvent ev) {
        if (ev == null) return;
        int type = ev.getEventType();
        CharSequence pc = ev.getPackageName();
        String pkg = pc == null ? "" : pc.toString();
        if (!"com.tencent.mm".equals(pkg)) return;

        if (type == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            String txt = joinText(ev.getText());
            if (!txt.contains("红包")) {
                String a = parseAmount(txt);
                if (!a.isEmpty() && !a.equals(amount) && !lastSig.isEmpty()) {
                    amount = a;
                    UI.postDelayed(Hongbao::report, 500);
                } else armPatrol();
                return;
            }
            android.app.Notification n = (android.app.Notification) ev.getParcelableData();
            startFromNotification(txt, n == null ? null : n.contentIntent);
            return;
        }

        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence cc = ev.getClassName();
            String cls = cc == null ? "" : cc.toString().toLowerCase();
            /* 实测这台机的弹框叫 LuckyMoneyNewReceiveUI（中间多个 New），
               写死全名会漏。按包名特征模糊认，微信改版也不怕。 */
            if (cls.contains("luckymoney") && cls.contains("receiveui")) {
                busy = true;
                UI.postDelayed(() -> openPacket(null), 500);
            } else if (cls.contains("luckymoney") && cls.contains("detail")) {
                /* 详情页金额是自绘大字、节点树全空 —— 截屏 OCR 读出来 */
                UI.postDelayed(Hongbao::readDetailByOcr, 700);
            } else if (busy && (cls.contains("LauncherUI") || cls.contains("ChattingUI"))) {
                UI.postDelayed(() -> scanChat(null), 900);
            }
        }
    }

    /** 通知进来（无障碍或独立监听服务都走这里）：不锁发的人、不锁位置。 */
    public static void startFromNotification(String txt, android.app.PendingIntent pi) {
        if (txt == null || !txt.contains("红包")) return;
        /* 同一条通知会重复投递；5 分钟内同样的文字只认一次 */
        if (txt.equals(lastSig) && System.currentTimeMillis() - lastSigAt < 300000L) return;
        lastSig = txt; lastSigAt = System.currentTimeMillis(); reportedSig = "";
        sender = parseSender(txt);
        amount = parseAmount(txt);
        Log.i(TAG, "红包通知 来自=" + sender + " 金额=" + amount);
        try { if (pi != null) pi.send(); } catch (Throwable t) { Log.i(TAG, "通知打不开 " + t); }
        busy = true;
        UI.postDelayed(() -> scanChat(null), 1200);
        UI.postDelayed(() -> { busy = false; }, 30000);
    }

    private static long patrolUntil = 0L;
    private static final Runnable PATROL = new Runnable() {
        @Override public void run() {
            if (System.currentTimeMillis() > patrolUntil || busy) return;
            /* 只在微信前台扫：别在别的 App 上把橙色按钮当红包点了 */
            if (wxFront()) scanChat(null);
            UI.postDelayed(this, 2000);
        }
    };

    /** 群消息被折叠成「你收到 1 条消息」时，短时巡检补上。15 秒后自动停。 */
    /* 🚨 2026-11-10 菲尔特真机：巡逻在聊天页扫橙色块，把橙黄色奶龙表情包
       当成红包连点、还播报「有人给你发了红包，我帮你领一下」。
       红包只认一条路：系统通知里明确带「红包」字样（startFromNotification）。
       聊天页巡逻整条停用 —— 通知没有的红包，宁可错过也不许乱点。 */
    public static void armPatrol() {
        if (true) return;
        patrolUntil = System.currentTimeMillis() + 15000L;
        UI.removeCallbacks(PATROL);
        UI.postDelayed(PATROL, 1200);
    }

    /** 详情页：ML Kit 本地中文 OCR 读金额和「谁发的」，节点树读不到就只能看屏幕。 */
    private static void readDetailByOcr() {
        final MiliAccessibilityService s = MiliAccessibilityService.self();
        if (s == null || Build.VERSION.SDK_INT < 30) { report(); return; }
        shot(s, bmp -> {
            if (bmp == null) { report(); return; }
            try {
                com.google.mlkit.vision.text.TextRecognizer rec =
                        com.google.mlkit.vision.text.TextRecognition.getClient(
                                new com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions.Builder().build());
                com.google.mlkit.vision.common.InputImage img =
                        com.google.mlkit.vision.common.InputImage.fromBitmap(bmp, 0);
                rec.process(img)
                  .addOnSuccessListener(v -> {
                      try { absorbDetail(v.getText()); } catch (Throwable ignored) {}
                      report(); try { rec.close(); } catch (Throwable ignored) {}
                  })
                  .addOnFailureListener(e -> {
                      Log.i(TAG, "OCR 失败 " + e); report();
                      try { rec.close(); } catch (Throwable ignored) {}
                  });
            } catch (Throwable t) { Log.i(TAG, "OCR 异常 " + t); report(); }
        });
    }

    private static void absorbDetail(String raw) {
        String t = raw == null ? "" : raw.replace(" ", "").replace("\n", " ");
        String a = parseAmount(t);
        if (!a.isEmpty()) amount = a;
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("([\\u4e00-\\u9fa5A-Za-z0-9]{1,12})的红包").matcher(t);
            if (m.find()) sender = m.group(1);
        } catch (Throwable ignored) {}
        Log.i(TAG, "OCR 详情 来自=" + sender + " 金额=" + amount);
    }

    private static String joinText(java.util.List<CharSequence> ls) {
        if (ls == null) return "";
        StringBuilder b = new StringBuilder();
        for (CharSequence c : ls) if (c != null) b.append(c.toString()).append(' ');
        return b.toString().trim();
    }

    /** "王炳皓: [微信红包]恭喜发财" / "群名: 王炳皓: [微信红包]…" → 王炳皓 */
    private static String parseSender(String raw) {
        String t = raw.replace("[微信红包]", "").replace("微信红包", "").trim();
        String[] parts = t.split("[:：]");
        String who = parts.length >= 2 ? parts[parts.length - 2].trim() : parts[0].trim();
        if (who.isEmpty() && parts.length > 0) who = parts[0].trim();
        return who.length() > 20 ? who.substring(0, 20) : who;
    }

    private static String parseAmount(String raw) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("[¥￥]?(\\d+\\.\\d{2})").matcher(raw);
            return m.find() ? m.group(1) : "";
        } catch (Throwable t) { return ""; }
    }

    /** 聊天页：截屏找最靠下的橙色块 = 最新那个红包。不锁人、不锁位置。 */
    private static void scanChat(final Back back) {
        final MiliAccessibilityService s = MiliAccessibilityService.self();
        if (s == null || Build.VERSION.SDK_INT < 30) {
            if (back != null) back.done(false, "无障碍没开或系统太老");
            return;
        }
        shot(s, bmp -> {
            if (bmp == null) { if (back != null) back.done(false, "截屏没成功"); return; }
            int[] p = findCluster(bmp, false);
            if (p == null) { if (back != null) back.done(false, "这一屏没看到红包"); return; }
            Log.i(TAG, "聊天红包 " + p[0] + "," + p[1]);
            tap(s, p[0], p[1]);
            /* MIUI 上 TYPE_WINDOW_STATE_CHANGED 不一定投递，
               光靠窗口事件会卡在弹框上不拆。点完自己接着走，事件来了算加速。 */
            UI.postDelayed(() -> openPacket(back), 1400);
            if (back != null) back.done(true, "点到红包了");
        });
    }

    /** 红包弹框：找最大橙色块 = 「开」按钮。 */
    private static volatile long lastOpenAt = 0L;

    private static void openPacket(final Back back) {
        /* 窗口事件和主动状态机可能同时来，2 秒内只拆一次 */
        if (System.currentTimeMillis() - lastOpenAt < 2000L) return;
        lastOpenAt = System.currentTimeMillis();
        final MiliAccessibilityService s = MiliAccessibilityService.self();
        if (s == null || Build.VERSION.SDK_INT < 30) return;
        shot(s, bmp -> {
            if (bmp == null) return;
            /* 「開」是浅米黄圆，不是橙色 —— 按橙色找会落空（实测红包一直没拆）。
               先找米黄圆，找不到再退回橙色兜底。 */
            int[] q = findOpenButton(bmp);
            if (q == null) q = findCluster(bmp, true);
            if (q == null) { Log.i(TAG, "没找到开按钮（可能已领过）"); return; }
            Log.i(TAG, "开按钮 " + q[0] + "," + q[1]);
            tap(s, q[0], q[1]);
            /* 不依赖详情页类名 —— 微信改版换了 Activity 名也得报 */
            UI.postDelayed(Hongbao::readDetailByOcr, 2500);
            if (back != null) back.done(true, "点开了");
        });
    }

    /** 领完汇报：谁发的、多少钱。走桌宠气泡 + 原生 TTS，不抢界面。 */
    private static void report() {
        String sig = lastSig + "|" + amount;
        if (sig.equals(reportedSig)) return;
        reportedSig = sig;
        String who = sender == null || sender.isEmpty() ? "有人" : sender;
        String money = (amount == null || amount.isEmpty()) ? "" : ("，" + amount + " 元");
        String msg = who + "给你发了红包" + money + "，我已经帮你收好啦";
        try {
            Context c = MiliAccessibilityService.self();
            if (c != null) MilService.say(c, msg);
        } catch (Throwable t) { Log.i(TAG, "汇报失败 " + t); }
        busy = false;
    }


    /** 微信在前台才动手 —— 电视里天天说红包，不能在别的界面乱点 */
    public static boolean wxFront() {
        try {
            MiliAccessibilityService s = MiliAccessibilityService.self();
            return s != null && s.fgPkg().startsWith("com.tencent.mm");
        } catch (Throwable t) {
            return false;
        }
    }

    /** 调试：喂一段模拟的通知文字，验证「谁发的 / 多少钱 / 汇报话术」是否正确。
        真红包仍然要走系统通知，这个只用来在没有红包时验逻辑。 */
    public static String debugNotify(String text) {
        String t = text == null ? "" : text;
        sender = parseSender(t);
        amount = parseAmount(t);
        lastSig = t; reportedSig = "";
        return "sender=" + sender + " amount=" + amount;
    }

    /** 从聊天页开始：点最新那条红包 → 等详情页 → 点「开」 */
    public static void grab(final Back back) {
        final MiliAccessibilityService s = MiliAccessibilityService.self();
        if (s == null) { back.done(false, "无障碍没开，我按不到红包"); return; }
        if (Build.VERSION.SDK_INT < 30) { back.done(false, "这台手机系统太老，截不了屏"); return; }
        if (!wxFront()) { back.done(false, "先把微信聊天打开，我才知道点哪个"); return; }

        shot(s, new Shot() {
            @Override public void onBmp(Bitmap bmp) {
                if (bmp == null) { back.done(false, "截屏没成功"); return; }
                int[] p = findCluster(bmp, false);
                if (p == null) { back.done(false, "这一屏没看到红包"); return; }
                Log.i(TAG, "红包气泡 " + p[0] + "," + p[1]);
                tap(s, p[0], p[1]);

                UI.postDelayed(new Runnable() {
                    @Override public void run() { openPacket(back); }
                }, 1600);
            }
        });
    }

    /* ================= 截屏 ================= */

    private interface Shot { void onBmp(Bitmap b); }

    private static void shot(AccessibilityService s, final Shot cb) {
        try {
            s.takeScreenshot(Display.DEFAULT_DISPLAY, s.getMainExecutor(),
                    new AccessibilityService.TakeScreenshotCallback() {
                        @Override public void onSuccess(AccessibilityService.ScreenshotResult r) {
                            Bitmap copy = null;
                            try {
                                Bitmap b = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                                if (b != null) copy = b.copy(Bitmap.Config.ARGB_8888, false);
                            } catch (Throwable t) {
                                Log.i(TAG, "转图失败 " + t);
                            } finally {
                                try { r.getHardwareBuffer().close(); } catch (Throwable ignored) {}
                            }
                            cb.onBmp(copy);
                        }
                        @Override public void onFailure(int err) {
                            Log.i(TAG, "截屏失败 " + err);
                            cb.onBmp(null);
                        }
                    });
        } catch (Throwable t) {
            Log.i(TAG, "截屏异常 " + t);
            cb.onBmp(null);
        }
    }

    /* ================= 找橙色块 ================= */

    /**
     * @param biggest true 取最大的一块（详情页的「开」），false 取最靠下的一块（聊天里的最新红包）
     * @return 点击坐标（原图像素），没找到返回 null
     */
    private static int[] findCluster(Bitmap bmp, boolean biggest) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        final int step = 2;          // 隔点采样，够用且快
        final int cell = 24;         // 采样坐标下的格子边长
        int cw = w / step / cell + 1;
        int chh = h / step / cell + 1;

        int[][] acc = new int[chh][cw];
        for (int y = 0; y < h; y += step) {
            for (int x = 0; x < w; x += step) {
                int p = bmp.getPixel(x, y);
                int r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
                // 微信红包橙：#FA9D3B —— 红多、绿中、蓝少
                if (r >= 195 && g >= 105 && g <= 205 && b <= 135
                        && (r - g) >= 45 && (g - b) >= 40) {
                    acc[y / step / cell][x / step / cell]++;
                }
            }
        }

        int need = cell * cell / 5;   // 格子至少五分之一是橙的才算一块
        int bx = -1, by = -1, best = 0;
        for (int cy = 0; cy < chh; cy++) {
            for (int cx = 0; cx < cw; cx++) {
                int v = acc[cy][cx];
                if (v < need) continue;
                if (biggest) {
                    if (v > best) { best = v; bx = cx; by = cy; }
                } else {
                    // 最靠下：优先挑 y 大的
                    if (by < 0 || cy > by || (cy == by && v > best)) { best = v; bx = cx; by = cy; }
                }
            }
        }
        if (bx < 0) return null;

        // 在选中格子的 3×3 邻域里求橙色像素质心，点得更准
        long sx = 0, sy = 0, n = 0;
        int x0 = Math.max(0, (bx - 1) * cell * step), x1 = Math.min(w, (bx + 2) * cell * step);
        int y0 = Math.max(0, (by - 1) * cell * step), y1 = Math.min(h, (by + 2) * cell * step);
        for (int y = y0; y < y1; y += step) {
            for (int x = x0; x < x1; x += step) {
                int p = bmp.getPixel(x, y);
                int r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
                if (r >= 195 && g >= 105 && g <= 205 && b <= 135
                        && (r - g) >= 45 && (g - b) >= 40) {
                    sx += x; sy += y; n++;
                }
            }
        }
        if (n == 0) return new int[]{(int) ((bx + 0.5) * cell * step), (int) ((by + 0.5) * cell * step)};
        return new int[]{(int) (sx / n), (int) (sy / n)};
    }

    /** 找红包弹框里的「開」：浅米黄实心圆（约 #F0D9A8）。
        红色背景 g 太低、聊天灰白底 r≈b，都不会命中。取最大一块的质心。 */
    private static int[] findOpenButton(Bitmap bmp) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        final int step = 2, cell = 24;
        int cw = w / step / cell + 1, chh = h / step / cell + 1;
        int[][] acc = new int[chh][cw];
        for (int y = 0; y < h; y += step) {
            for (int x = 0; x < w; x += step) {
                int p = bmp.getPixel(x, y);
                int r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
                if (r >= 210 && g >= 180 && b >= 110 && b <= 210
                        && (r - g) >= 8 && (r - g) <= 75
                        && (g - b) >= 20 && (g - b) <= 105 && (r - b) >= 45) {
                    acc[y / step / cell][x / step / cell]++;
                }
            }
        }
        int need = cell * cell / 5, bx = -1, by = -1, best = 0;
        for (int cy = 0; cy < chh; cy++) {
            for (int cx = 0; cx < cw; cx++) {
                if (acc[cy][cx] > best && acc[cy][cx] >= need) {
                    best = acc[cy][cx]; bx = cx; by = cy;
                }
            }
        }
        if (bx < 0) return null;
        long sx = 0, sy = 0, n = 0;
        int x0 = Math.max(0, (bx - 1) * cell * step), x1 = Math.min(w, (bx + 2) * cell * step);
        int y0 = Math.max(0, (by - 1) * cell * step), y1 = Math.min(h, (by + 2) * cell * step);
        for (int y = y0; y < y1; y += step) {
            for (int x = x0; x < x1; x += step) {
                int p = bmp.getPixel(x, y);
                int r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
                if (r >= 210 && g >= 180 && b >= 110 && b <= 210
                        && (r - g) >= 8 && (r - g) <= 75 && (g - b) >= 20 && (g - b) <= 105) {
                    sx += x; sy += y; n++;
                }
            }
        }
        if (n == 0) return new int[]{(int) ((bx + 0.5) * cell * step), (int) ((by + 0.5) * cell * step)};
        return new int[]{(int) (sx / n), (int) (sy / n)};
    }

    /* ================= 点 ================= */

    private static void tap(MiliAccessibilityService s, int x, int y) {
        try {
            Path p = new Path();
            p.moveTo(x, y);
            GestureDescription g = new GestureDescription.Builder()
                    .addStroke(new GestureDescription.StrokeDescription(p, 0, 70))
                    .build();
            /* 这里**故意**不用 Gestures.send 等回调：抢红包的时间窗只有几百毫秒，
               等 onCompleted（手势时长 + 2 秒宽限）会直接错过那一拍。
               别的点击要确认结果，这里要的是快。 */
            s.dispatchGesture(g, null, null);
        } catch (Throwable t) {
            Log.i(TAG, "点失败 " + t);
        }
    }
}
