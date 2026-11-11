package com.mili.app;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 独立的通知监听，不依赖无障碍服务的通知事件。
 * 无障碍那条路在 MIUI 上不一定投递（实测 xml 没声明 typeNotificationStateChanged 时
 * 一条红包通知都收不到），而这个服务是系统专门给「读通知」用的，稳得多。
 */
public class MiliNotifService extends NotificationListenerService {

    private static final String TAG = "MiliNotif";

    /* 最近收到的通知，留给智能体自己读。
       为什么要在原生侧存：它读的是「刚才谁给我发了什么」，
       而通知栏本身要看一眼才知道，多一步就多一次失败。
       只留最近 30 条、只留摘要，不落盘、不上传。 */
    private static final java.util.ArrayDeque<String> RECENT =
            new java.util.ArrayDeque<String>();
    private static final int RECENT_MAX = 30;

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) return;
        /* 先记下所有 App 的通知，再走微信那条老逻辑 ——
           以前这里第一行就把非微信的全 return 了，智能体等于什么都不知道。 */
        try {
            Notification nn = sbn.getNotification();
            Bundle ex = nn == null ? null : nn.extras;
            CharSequence title = ex == null ? null : ex.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = ex == null ? null : ex.getCharSequence(Notification.EXTRA_TEXT);
            CharSequence big = ex == null ? null : ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
            String body = (text == null ? "" : text.toString());
            if (big != null && big.length() > body.length()) body = big.toString();
            String line = System.currentTimeMillis() + "\t" + sbn.getPackageName() + "\t"
                    + (title == null ? "" : title.toString()) + "\t" + body;
            synchronized (RECENT) {
                RECENT.addFirst(line);
                while (RECENT.size() > RECENT_MAX) RECENT.removeLast();
            }
        } catch (Throwable ignored) {}

        if (!"com.tencent.mm".equals(sbn.getPackageName())) return;
        try {
            Notification n = sbn.getNotification();
            Bundle ex = n == null ? null : n.extras;
            CharSequence title = ex == null ? null : ex.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = ex == null ? null : ex.getCharSequence(Notification.EXTRA_TEXT);
            CharSequence big = ex == null ? null : ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
            String t = (title == null ? "" : title.toString()) + ": "
                     + (text == null ? "" : text.toString()) + " "
                     + (big == null ? "" : big.toString());
            Log.i(TAG, "微信通知 " + t);
            /* 微信语音/视频来电自动接（2026-11-07）。
               正路是通知自带的动作按钮：新版微信的来电通知 actions 里就有
               「语音接听 / 视频接听」，直接替老人 send 那个 PendingIntent，
               不用碰它封死的节点树。没有动作按钮才开通话页再点「接听」字样。
               名单过滤跟电话共用一份：家人列表里没人留微信号时默认都接，
               留了就对不上不接 —— 防骚扰电话打微信里来。 */
            if (isWxCallInvite(title == null ? "" : title.toString(),
                    text == null ? "" : text.toString())) {
                answerWxCall(t, n);
                return;
            }
            if (t.contains("红包")) {
                /* 群通知格式：「群名: 王炳皓: [微信红包]恭喜发财」—— 不锁人 */
                Hongbao.startFromNotification(t, n == null ? null : n.contentIntent);
            } else {
                /* 群消息常被折叠成「你收到 1 条消息」，里面一个「红包」字都没有。
                   收到任何微信通知都开 15 秒短时巡检，靠颜色在聊天里找红包，
                   不长期轮询、不耗电，也不会在别的 App 上乱点。 */
                Hongbao.armPatrol();
            }
        } catch (Throwable t) { Log.i(TAG, "读通知失败 " + t); }
    }

    /** 来电邀请判断。微信通知标题就是来电人，正文带「邀请你 … 通话」。 */
    private static boolean isWxCallInvite(String title, String text) {
        String s = title + " " + text;
        if (!(s.contains("邀请你") || s.contains("邀请您"))) return false;
        return s.contains("通话") || s.contains("语音") || s.contains("视频");
    }

    private static long lastWxCallAt = 0;

    private void answerWxCall(String text, Notification n) {
        long now = System.currentTimeMillis();
        if (now - lastWxCallAt < 8000) return;       // 同一通电话的通知会连发好几条
        try {
            android.content.Context ctx = this;
            JSONObject cfg = CallAnswer.config(ctx);
            if (!cfg.optBoolean("wxAuto", true)) return;

            /* 名单过滤：title 一般就是来电人的微信名。
               家人里只要有一个留了微信名，就对名单；一个都没留，才默认都接。 */
            String who = "";
            String title = text.contains(":") ? text.substring(0, text.indexOf(':')) : "";
            JSONArray wl = cfg.optJSONArray("list");
            boolean anyWx = false;
            String hitName = null;
            if (wl != null) for (int i = 0; i < wl.length(); i++) {
                JSONObject p = wl.optJSONObject(i);
                if (p == null) continue;
                String wx = p.optString("wx", "").trim();
                String nm = p.optString("name", "").trim();
                if (!wx.isEmpty()) anyWx = true;
                boolean m = (!wx.isEmpty() && title.contains(wx))
                         || (!nm.isEmpty() && !nm.equals("家里人") && title.contains(nm));
                if (m) { hitName = wx.isEmpty() ? nm : wx; break; }
            }
            if (anyWx && hitName == null) {
                Log.i(TAG, "微信来电不在名单里，不接：" + title);
                return;
            }
            lastWxCallAt = now;
            who = hitName == null ? title : hitName;
            final String whoF = who;                     // 内部类要用，得是 final
            Log.i(TAG, "微信来电，自动接：" + who + "（" + text + "）");

            /* 正路：通知自带「接听」动作按钮 */
            if (n != null && n.actions != null) {
                for (android.app.Notification.Action a : n.actions) {
                    String at = a.title == null ? "" : a.title.toString();
                    if (at.contains("接听")) {
                        try { a.actionIntent.send(ctx, 0, null); } catch (Throwable ignored) {}
                        CallAnswer.notifyJs(whoF, "wx");
                        return;
                    }
                }
            }
            /* 兜底：点通知开通话页，再让无障碍找「接听」两个字点。 */
            if (n != null && n.contentIntent != null) {
                try { n.contentIntent.send(ctx, 0, null); } catch (Throwable ignored) {}
            }
            final android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
            final boolean[] done = {false};
            h.postDelayed(new Runnable() {
                @Override public void run() {
                    if (done[0]) return;
                    try {
                        String r = MiliAccessibilityService.tapText("接听");
                        if (r != null && r.contains("\"ok\":true")) {
                            done[0] = true;
                            CallAnswer.notifyJs(whoF, "wx");
                            return;
                        }
                    } catch (Throwable ignored) {}
                    h.postDelayed(this, 900);
                }
            }, 1200);
        } catch (Throwable t) {
            Log.i(TAG, "answerWxCall " + t);
        }
    }

    /** 给智能体读的最近通知（新的在前）。minutes>0 时只要这几分钟内的。 */
    public static String recentJson(int limit, int minutes) {
        long cut = minutes > 0 ? System.currentTimeMillis() - minutes * 60000L : 0;
        org.json.JSONArray arr = new org.json.JSONArray();
        try {
            synchronized (RECENT) {
                for (String line : RECENT) {
                    String[] p = line.split("\t", 4);
                    if (p.length < 4) continue;
                    long ts;
                    try { ts = Long.parseLong(p[0]); } catch (Throwable e) { continue; }
                    if (cut > 0 && ts < cut) continue;
                    org.json.JSONObject o = new org.json.JSONObject();
                    o.put("t", ts);
                    o.put("pkg", p[1]);
                    o.put("title", p[2]);
                    o.put("text", p[3].length() > 120 ? p[3].substring(0, 120) : p[3]);
                    arr.put(o);
                    if (arr.length() >= Math.max(1, limit)) break;
                }
            }
            org.json.JSONObject out = new org.json.JSONObject();
            out.put("ok", true);
            out.put("list", arr);
            return out.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + t.getClass().getSimpleName() + "\"}";
        }
    }
}
