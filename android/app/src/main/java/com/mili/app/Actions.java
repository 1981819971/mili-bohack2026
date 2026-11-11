package com.mili.app;

import android.content.Context;
import android.os.Handler;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.ContactsContract;
import android.database.Cursor;
import android.telephony.SmsManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 干真事的地方：打电话、导航、发消息、开视频 App、开电视直播。
 *
 * 原则：能用标准 Intent 的绝不走无障碍。无障碍只在 Intent 办不到时才上
 * （比如微信里点具体某个聊天窗口），因为无障碍慢、脆、还容易被系统杀。
 *
 * 每个动作都返回一个 JSON：
 *   {"ok":true, "did":"call", "say":"给女儿打电话", "pkg":"com.android.dialer"}
 *   {"ok":false, "why":"no_app", "say":"这台手机上没装高德"}
 * 前端拿到 say 直接念，不用自己猜成功没成功。
 */
public class Actions {

    private final Context ctx;
    private final SharedPreferences sp;

    public Actions(Context c) {
        this.ctx = c.getApplicationContext();
        this.sp = ctx.getSharedPreferences("mili_actions", Context.MODE_PRIVATE);
    }

    /* ================= 1. 打电话 ================= */

    /** 按名字找人。先查通讯录，找不到就看是不是号码。 */
    public JSONObject call(String who) {
        try {
            String num = lookupNumber(who);
            if (num == null && who.matches("[0-9\\-+ ]{5,}")) {
                num = who.replaceAll("[^0-9+]", "");
            }
            if (num == null) {
                return fail("no_contact", "通讯录里没找到" + who + "，你告诉我号码也行。");
            }
            Intent i = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + num));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            noteOften("call", who);
            return ok("call", "正在给" + who + "打电话。");
        } catch (SecurityException e) {
            // 没有 CALL_PHONE 权限时退回拨号盘，让老人按一下绿色的
            return dialOnly(who);
        } catch (Exception e) {
            return fail("err", "打不出去，你试试直接按电话图标。");
        }
    }

    /** 拨号盘兜底（不需要打电话权限） */
    private JSONObject dialOnly(String who) {
        try {
            String num = lookupNumber(who);
            if (num == null) num = who;
            Intent i = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + num));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return ok("dial", "号码我填好了，你按一下绿色的那个键。");
        } catch (Exception e) {
            return fail("err", "拨号盘也打不开。");
        }
    }

    private String lookupNumber(String name) {
        if (name == null || name.isEmpty()) return null;
        Cursor c = null;
        try {
            Uri uri = Uri.withAppendedPath(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI,
                    Uri.encode(name));
            c = ctx.getContentResolver().query(uri,
                    new String[]{ContactsContract.CommonDataKinds.Phone.NUMBER}, null, null, null);
            if (c != null && c.moveToFirst()) {
                return c.getString(0).replaceAll("[^0-9+]", "");
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Exception ignored) {}
        }
        return null;
    }

    /** 2026-11-09：打电话页改成「点名字就拨」，前端要一份本机通讯录名单。
        2026-11-10 菲尔特：「打电话时好多人找不到」—— 40 个上限把通讯录后半截
        全砍了。现在全量返回（去重后最多 2000），前端自己按名字搜。
        自动接听的白名单也用这份名单：通讯录里的人一律接。 */
    public JSONArray allContacts() {
        JSONArray out = new JSONArray();
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                                 ContactsContract.CommonDataKinds.Phone.NUMBER},
                    ContactsContract.CommonDataKinds.Phone.NUMBER + " IS NOT NULL",
                    null,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC");
            if (c == null) return out;
            java.util.HashSet<String> seen = new java.util.HashSet<>();
            while (c.moveToNext() && out.length() < 2000) {
                String name = c.getString(0);
                String num  = c.getString(1);
                if (name == null || num == null) continue;
                String digits = num.replaceAll("[^0-9+]", "");
                if (digits.length() < 5 || !seen.add(digits)) continue;
                JSONObject o = new JSONObject();
                o.put("name", name.trim());
                o.put("number", digits);
                out.put(o);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Exception ignored) {}
        }
        return out;
    }

    /* ================= 2. 导航（实景） ================= */

    /** 去一个地方。优先高德（有实景路口放大），其次百度，再不行用系统地图。 */
    public JSONObject navigate(String place) {
        if (place == null || place.trim().isEmpty()) {
            return fail("no_place", "你要去哪儿呀？再说一遍地方名。");
        }
        String p = place.trim();
        noteOften("place", p);

        // 高德：直接进导航页，有实景放大图
        if (hasPkg("com.autonavi.minimap")) {
            try {
                String u = "androidamap://navi?sourceApplication=com.mili.app"
                        + "&poiname=" + URLEncoder.encode(p, "UTF-8")
                        + "&dev=0&style=2";
                // 有关键词但没坐标时，用关键字导航
                String u2 = "androidamap://keywordNavi?sourceApplication=com.mili.app"
                        + "&keyword=" + URLEncoder.encode(p, "UTF-8")
                        + "&style=2";
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u2));
                i.setPackage("com.autonavi.minimap");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return ok("nav_amap", "好，给你导航去" + p + "，高德上开了实景。");
            } catch (Exception ignored) {}
        }
        // 百度地图
        if (hasPkg("com.baidu.BaiduMap")) {
            try {
                String u = "baidumap://map/direction?destination="
                        + URLEncoder.encode(p, "UTF-8")
                        + "&mode=driving&src=com.mili.app";
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                i.setPackage("com.baidu.BaiduMap");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return ok("nav_baidu", "好，百度地图给你导航去" + p + "。");
            } catch (Exception ignored) {}
        }
        // 系统 geo:
        try {
            Intent i = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("geo:0,0?q=" + URLEncoder.encode(p, "UTF-8")));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return ok("nav_geo", "地图给你打开了，去" + p + "。");
        } catch (Exception e) {
            return fail("no_map", "这台手机上没装地图，让家里人装一个高德。");
        }
    }

    /** 用系统浏览器打开一个网页。只放 http/https，别的一律拒绝。 */
    public JSONObject openUrl(String url) {
        try {
            Uri u = Uri.parse(url == null ? "" : url.trim());
            String sch = u.getScheme();
            /* 只拦本地内容协议；App 深链（snssdk1128:// 等）放行 —— 抖音直达全屏用 */
            if ("file".equalsIgnoreCase(sch) || "content".equalsIgnoreCase(sch)) {
                return fail("bad_url", "这个链接打不开。");
            }
            Intent i = new Intent(Intent.ACTION_VIEW, u);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return ok("open_url", "打开了。");
        } catch (Exception e) {
            return fail("no_browser", "这台手机上打不开网页。");
        }
    }

    /* ================= 3. 微信：消息 / 语音通话 / 视频通话 / 红包 ================= */
    /**
     * 微信没有公开的自动化接口，所以分两步：
     * 1) 先用 scheme 把微信拉到前台（这一步稳）
     * 2) 具体的「点开某人 → 点语音通话」交给无障碍（Assists 那套思路）
     *
     * 这里负责第 1 步，并把「要找谁、要干什么」交给无障碍服务。
     */
    public JSONObject wechat(String who, String what) { return wechat(who, what, null); }

    /** 微信熟练度：录了几个点、成功几次、还缺哪步 */
    public String wxSkill() {
        WxFlow f = MiliAccessibilityService.wx();
        return f == null ? "{}" : f.skillJson();
    }

    /** 手动录一个点 */
    public boolean wxMark(String key, int x, int y) {
        WxFlow f = MiliAccessibilityService.wx();
        if (f == null) return false;
        f.savePoint(key, x, y);
        return true;
    }

    /** 挂断当前通话。通话界面是原生弹层，坐标单独录一次。 */
    public boolean wxHangup() {
        WxFlow f = MiliAccessibilityService.wx();
        if (f == null) return false;
        return f.hangup();
    }

    /** 通话中切扬声器 */
    public boolean wxSpeaker() {
        WxFlow f = MiliAccessibilityService.wx();
        if (f == null) return false;
        return f.speaker();
    }

    /** 通话一开始就挂一条通知，上面有「挂断」和「扬声器」两个按钮。
        这两个按钮走广播，不把 App 提到前台 —— 提到前台微信的通话界面就没了。 */
    private void notifyCall() {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager)
                    ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            String ch = "mili_call";
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new android.app.NotificationChannel(
                        ch, "通话中", android.app.NotificationManager.IMPORTANCE_HIGH));
            }
            int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
            }
            android.app.PendingIntent h = android.app.PendingIntent.getBroadcast(ctx, 1,
                    new Intent(HangupReceiver.A_HANGUP).setPackage(ctx.getPackageName()), flags);
            android.app.PendingIntent s = android.app.PendingIntent.getBroadcast(ctx, 2,
                    new Intent(HangupReceiver.A_SPEAKER).setPackage(ctx.getPackageName()), flags);

            android.app.Notification.Builder b = (android.os.Build.VERSION.SDK_INT >= 26)
                    ? new android.app.Notification.Builder(ctx, ch)
                    : new android.app.Notification.Builder(ctx);
            b.setSmallIcon(android.R.drawable.sym_action_call)
                    .setContentTitle("正在通话")
                    .setContentText("要挂断或开扬声器，点下面的按钮")
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .addAction(new android.app.Notification.Action.Builder(
                            android.R.drawable.ic_menu_close_clear_cancel, "挂断", h).build())
                    .addAction(new android.app.Notification.Action.Builder(
                            android.R.drawable.ic_lock_silent_mode_off, "扬声器", s).build());
            nm.notify(HangupReceiver.NID, b.build());
            Log.i("MiliWx", "通话通知已挂");
        } catch (Throwable e) {
            Log.i("MiliWx", "通话通知失败 " + e);
        }
    }

    public JSONObject wechat(String who, String what, String text) {
        if (!hasPkg("com.tencent.mm")) {
            return fail("no_wechat", "这台手机上没装微信。");
        }
        try {
            /* 必须用显式组件名。
               以前写的是隐式 Intent(ACTION_MAIN + CATEGORY_LAUNCHER + setPackage)，
               在 Android 13 上直接抛 ActivityNotFoundException —— 因为包可见性限制，
               系统不给解析这个隐式 Intent（日志里 xflg=0x4 就是被 visibility 挡掉的标记）。
               微信的桌面入口永远是 com.tencent.mm.ui.LauncherUI，写死它最稳。 */
            Intent i = new Intent();
            i.setComponent(new android.content.ComponentName(
                    "com.tencent.mm", "com.tencent.mm.ui.LauncherUI"));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);

            // 把任务交给无障碍服务，由它一步步点（text = 消息正文 / 红包金额）
            boolean started = MiliAccessibilityService.task(who, what, text);
            if (!started) {
                WxFlow f = MiliAccessibilityService.wx();
                String why = f == null ? "" : f.lastRefuse;
                Log.i("MiliWx", "task 没起来 why=" + why + " who=" + who);
                if (why.startsWith("relation:")) {
                    String rel = why.substring("relation:".length());
                    return fail("need_name",
                            "「" + rel + "」我还不认识是谁。你把名字告诉我，比如「给李昌洪打电话」。");
                }
                if (why.startsWith("nobody:")) {
                    String nm = why.substring(7);
                    return fail("no_contact",
                            "微信里没找到叫「" + nm + "」的人。你说下他的备注名，或者打开微信自己点。");
                }
                /* 2026-11-10：没真的进搜索页就停手了。如实说，不谎报「发好了」，
                   更不能让模型自己开微信去点 —— 那正是发错人的起点。 */
                if (why.startsWith("nosearch:")) {
                    String nm = why.substring(9);
                    return fail("no_search",
                            "微信里没搜着「" + nm + "」，我没敢乱点。你说下他的备注名，或者打开微信自己点一下。");
                }
                if ("unclear".equals(why)) {
                    return fail("need_name", "我没听清是谁。你说个名字，比如「给李昌洪发消息」。");
                }
                if (why.startsWith("notname:")) {
                    return fail("need_name",
                            "「" + why.substring(8) + "」不像是人名。你直接说名字，比如「给王炳皓发消息」。");
                }
                return fail("no_points", "微信我还没学会点哪里，先别急，等我一下。");
            }
            if ("call".equals(what) || "video".equals(what)) notifyCall();
            noteOften("wechat_" + what, who);
            /* 🚨 2026-11-10 菲尔特抓到「谎报发好」：task() 只是**启动**了流程，
               真正点没点中人是十几秒后 WxFlow.finish 的事。detail 说「我把话发了」
               就是骗人 —— 模型会照着说「发好啦」。改成只说「去办了」。 */
            try {
                String nm0 = Name.clean(who);
                String verb = "video".equals(what) ? ("我去给" + nm0 + "打视频了，你等一下啊。")
                            : "call".equals(what) ? ("我去给" + nm0 + "打语音了，你等一下啊。")
                            : "redpacket".equals(what) ? ("我去给" + nm0 + "发红包了，你等一下啊。")
                            : ("我去微信里给" + nm0 + "发了，你等一下啊。");
                JSONObject resp = ok("wechat_" + what, verb);
                return resp;
            } catch (Throwable ignored) {}

            String nm = Name.clean(who);
            if (nm.isEmpty()) nm = who;
            String say;
            if ("call".equals(what)) say = "好，我给你在微信里叫" + nm + "的语音通话。";
            else if ("video".equals(what)) say = "好，我给" + nm + "打视频。";
            else if ("redpacket".equals(what)) {
                say = (text == null || text.isEmpty())
                        ? "好，我给" + nm + "发个红包，金额你在屏幕上填一下。"
                        : "好，我给" + nm + "发 " + text + " 块的红包。";
            } else {
                say = (text == null || text.isEmpty())
                        ? "好，我给你打开" + nm + "的聊天窗口。"
                        : "好，我把话发给" + nm + "。";
            }
            return ok("wechat_" + what, say);
        } catch (Exception e) {
            // 别再吞掉了。上一版这里直接返回「微信打不开」，结果什么都查不出来。
            Log.e("MiliWx", "wechat 失败 what=" + what + " who=" + who + " : " + e);
            return fail("err", "微信打不开。" + e.getClass().getSimpleName());
        }
    }

    /* ================= 4. 视频 App：接着看 ================= */

    /**
     * 打开某个视频 App 并继续上次看的。
     * 各家 scheme 不一样，这里覆盖常见的几个；都没有就打开 App 首页。
     */
    public JSONObject watch(String appName) {
        String n = appName == null ? "" : appName;
        String[][] MAP = {
                // {包名, 名字, scheme}
                {"com.qiyi.video", "爱奇艺", "iqiyi://mobile/home"},
                {"com.hunantv.imgo.activity", "芒果TV", "imgotv://"},
                {"com.tencent.qqlive", "腾讯视频", "tenvideo://"},
                {"com.youku.phone", "优酷", "youku://"},
                {"com.ss.android.ugc.aweme", "抖音", "snssdk1128://"},
                {"com.phoenix.read", "红果短剧", ""},
                {"com.cctv.cctv", "央视影音", ""},
        };
        for (String[] row : MAP) {
            boolean nameHit = !n.isEmpty() && (row[1].contains(n) || n.contains(row[1]));
            boolean anyFallback = n.isEmpty();
            if ((nameHit || (anyFallback && hasPkg(row[0]))) && hasPkg(row[0])) {
                // 记住她上次用哪个
                if (!n.isEmpty()) noteOften("video", row[1]);
                try {
                    if (!row[2].isEmpty()) {
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(row[2]));
                        i.setPackage(row[0]);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        ctx.startActivity(i);
                    } else {
                        throw new Exception("no scheme");
                    }
                } catch (Exception e) {
                    Intent i = ctx.getPackageManager().getLaunchIntentForPackage(row[0]);
                    if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); }
                }
                // 让无障碍去点「继续观看」
                MiliAccessibilityService.task("", "resume");
                return ok("watch", "给你打开" + row[1] + "了，接着上次看。");
            }
        }
        /* 一台机上没装这些视频 App 时，老人其实是在悟空里追剧。 */
        if (n.isEmpty() && hasPkg(WUKONG_PKG)) return resumeWukong();
        return fail("no_video", "这台手机上没找到能放的视频软件。");
    }

    /**
     * 按剧名找片。老人说的是「我要看后会有期」这种，不是 App 名。
     * 做法：挑一个装了的视频 App 打开，然后让无障碍去搜索框里打剧名、点第一个结果。
     * 找不到任何视频 App 就退回浏览器搜一下。
     */
    public JSONObject watchShow(String show) {
        if (show == null || show.trim().isEmpty()) {
            return fail("no_show", "你想看什么呀？片名说给我听。");
        }
        String q = show.trim();
        String[][] APPS = {
                {"com.qiyi.video", "爱奇艺"},
                {"com.tencent.qqlive", "腾讯视频"},
                {"com.youku.phone", "优酷"},
                {"com.hunantv.imgo.activity", "芒果TV"},
        };
        for (String[] a : APPS) {
            if (!hasPkg(a[0])) continue;
            try {
                Intent i = ctx.getPackageManager().getLaunchIntentForPackage(a[0]);
                if (i == null) continue;
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                noteOften("show", q);
                // 等 App 起来，再让无障碍去搜
                MiliAccessibilityService.task("", "show", q);
                return ok("show_" + a[1], "好，我去" + a[1] + "里找《" + q + "》，找到了就给你放。");
            } catch (Exception ignored) {}
        }
        // 一个都没有：浏览器搜
        try {
            Intent i = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("https://www.bing.com/search?q=" + URLEncoder.encode(q + " 在线观看", "UTF-8")));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return ok("show_web", "手机上没装视频软件，我用浏览器给你找《" + q + "》。");
        } catch (Exception e) {
            return fail("no_video", "这台手机上既没视频软件也打不开浏览器。");
        }
    }

    /**
     * 按显示名找已装的 App。PackageManager 全量扫一遍，拿 label 对，
     * 不再维护写死的名单 —— 用户装什么就能用什么。
     */
    private String findAppByLabel(String want) {
        if (want == null || want.trim().isEmpty()) return null;
        String w = want.trim();
        android.content.pm.PackageManager pm = ctx.getPackageManager();
        Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (android.content.pm.ResolveInfo ri : pm.queryIntentActivities(probe, 0)) {
            String label;
            try { label = String.valueOf(ri.loadLabel(pm)); } catch (Exception e) { continue; }
            String pkg = ri.activityInfo.packageName;
            if (pkg.startsWith("com.android.") || pkg.equals("android")) continue;
            // 「悟空」能对上「悟空浏览器」，反过来也行
            if (label.contains(w) || w.contains(label)) {
                return pkg + "|" + label;
            }
        }
        return null;
    }

    /** 「用悟空浏览器找后会有期」：开指定 App，再让无障碍在里面搜片名。 */
    public JSONObject watchSearch(String appName, String show) {
        String app = appName == null ? "" : appName.trim();
        String showName = show == null ? "" : show.trim();
        if (app.isEmpty()) return watchShow(showName);

        String hit = findAppByLabel(app);
        String pkg = null, label = app;
        if (hit != null) {
            int i = hit.indexOf('|');
            pkg = hit.substring(0, i);
            label = hit.substring(i + 1);
        } else {
            // 显示名没对上，退回写死名单里带 scheme 的那几个
            String[][] MAP = {
                    {"com.qiyi.video", "爱奇艺"}, {"com.hunantv.imgo.activity", "芒果TV"},
                    {"com.tencent.qqlive", "腾讯视频"}, {"com.youku.phone", "优酷"},
                    {"com.ss.android.ugc.aweme", "抖音"},
            };
            for (String[] row : MAP) {
                if (row[1].contains(app) || app.contains(row[1])) {
                    pkg = row[0]; label = row[1]; break;
                }
            }
        }
        if (pkg == null) {
            return fail("no_app", "手机上没找到「" + app + "」，你看看图标在不在。");
        }
        try {
            /* 悟空浏览器：在它自己里面搜，不走百度。
               老人要的是悟空的结果页 —— 那儿直接带剧集和播放器；百度只是一张网页。 */
            if (pkg.equals(WUKONG_PKG) && !showName.isEmpty()) {
                return searchInWukong(showName, label);
            }
            /* 别的浏览器仍走 URL 直达：它们的输入框不认无障碍写入。 */
            boolean isBrowser = label.contains("浏览器") || pkg.equals("com.android.browser");
            if (isBrowser && !showName.isEmpty()) {
                Intent i = new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://m.baidu.com/s?word=" + URLEncoder.encode(showName, "UTF-8")));
                i.setPackage(pkg);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                noteOften("show", showName);
                return ok("search_url", "好，我在" + label + "里搜《" + showName + "》。");
            }
            Intent i = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return fail("no_app", "「" + label + "」打不开。");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            if (!showName.isEmpty()) {
                // 视频 App 没有公开搜索 URL，才走无障碍逐步搜
                new Handler(ctx.getMainLooper()).postDelayed(
                        () -> MiliAccessibilityService.task("", "show", showName), 2500);
                return ok("search_in", "好，我在" + label + "里找《" + showName + "》。");
            }
            return ok("open_app", "好，" + label + "打开了。");
        } catch (Exception e) {
            return fail("open_fail", "「" + label + "」打不开。");
        }
    }

    /* ================= 4.9 声音 / 播放控制 =================
       老人说「声音大点」「暂停」「下一集」，这些走系统媒体键和音量键，
       不管前台是抖音、红果还是悟空，都吃这一套。不用去点 App 里的按钮。 */

    public JSONObject volume(String act) {
        String a = act == null ? "" : act.trim().toLowerCase();
        try {
            android.media.AudioManager am = (android.media.AudioManager)
                    ctx.getSystemService(android.content.Context.AUDIO_SERVICE);
            if (am == null) return fail("no_audio", "调不了声音。");
            boolean up = !(a.contains("小") || a.contains("down") || a.contains("低") || a.contains("减"));
            int steps = (a.contains("大点") || a.contains("小点")) ? 2 : 3;
            for (int i = 0; i < steps; i++) {
                am.adjustStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                        up ? android.media.AudioManager.ADJUST_RAISE
                           : android.media.AudioManager.ADJUST_LOWER,
                        android.media.AudioManager.FLAG_SHOW_UI);
            }
            int now = am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
            int max = am.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC);
            int pct = max == 0 ? 0 : (now * 100 / max);
            return ok("volume", up ? ("声音调大了，现在 " + pct + "。") : ("声音调小了，现在 " + pct + "。"));
        } catch (Throwable t) {
            return fail("volume_fail", "调声音没成功。");
        }
    }

    /** pause / play / next / prev：发系统媒体键 */
    public JSONObject media(String act) {
        String a = act == null ? "" : act.trim().toLowerCase();
        int code;
        String say;
        if (a.contains("暂") || a.contains("停") || a.equals("pause")) {
            code = android.view.KeyEvent.KEYCODE_MEDIA_PAUSE; say = "暂停了。";
        } else if (a.contains("下一") || a.equals("next")) {
            code = android.view.KeyEvent.KEYCODE_MEDIA_NEXT; say = "下一集。";
        } else if (a.contains("上一") || a.equals("prev")) {
            code = android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS; say = "上一集。";
        } else {
            code = android.view.KeyEvent.KEYCODE_MEDIA_PLAY; say = "接着放。";
        }
        try {
            android.media.AudioManager am = (android.media.AudioManager)
                    ctx.getSystemService(android.content.Context.AUDIO_SERVICE);
            if (am == null) return fail("no_audio", "按不动。");
            am.dispatchMediaKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, code));
            am.dispatchMediaKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, code));
            /* 有些播放器只认「播放/暂停」这个切换键 */
            if (code == android.view.KeyEvent.KEYCODE_MEDIA_PAUSE
                    || code == android.view.KeyEvent.KEYCODE_MEDIA_PLAY) {
                am.dispatchMediaKeyEvent(new android.view.KeyEvent(
                        android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE));
                am.dispatchMediaKeyEvent(new android.view.KeyEvent(
                        android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE));
            }
            return ok("media", say);
        } catch (Throwable t) {
            return fail("media_fail", "按键没发出去。");
        }
    }

    /** CCTV 指定频道：中央一台/1套/新闻频道 … 走浏览器直播页（用户要求：CCTV 用浏览器） */
    private int curChannel() {
        try { return sp.getInt("tv_ch", 1); } catch (Throwable t) { return 1; }
    }
    private void setChannel(int n) {
        try { sp.edit().putInt("tv_ch", Math.max(1, Math.min(17, n))).apply(); } catch (Throwable ignored) {}
    }

    /** 「下个台」：台号 +1，重新开到直播页，并把新台号说给老人听。 */
    public JSONObject tvNext() {
        int n = curChannel() % 17 + 1;
        setChannel(n);
        JSONObject r = tvChannel("CCTV" + n);
        return ok("tv_next", "换到 CCTV-" + n + " 了。");
    }

    public JSONObject tvChannel(String ch) {
        String raw = ch == null ? "" : ch.trim();
        int num = 1;
        String name = "中央一台";
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(\\d{1,2})").matcher(raw);
        if (m.find()) {
            try { num = Integer.parseInt(m.group(1)); } catch (Throwable ignored) {}
        } else if (raw.contains("新闻")) { num = 13; }
        else if (raw.contains("财经")) { num = 2; }
        else if (raw.contains("综艺")) { num = 3; }
        else if (raw.contains("体育")) { num = 5; }
        else if (raw.contains("电影")) { num = 6; }
        else if (raw.contains("纪录")) { num = 9; }
        else if (raw.contains("少儿")) { num = 14; }
        else if (raw.contains("戏曲")) { num = 11; }
        name = "CCTV" + num;
        setChannel(num);

        /* 央视影音装了就走 App，并把当前台号报给老人。
           它的直播页是自绘的、节点树读不到，没法替他点某个频道卡片，
           所以米粒负责「开到直播页 + 说清是哪个台」，最后一下由他点。
           网页那条路移动端明确不给放，只留作没装 App 时的兜底。 */
        if (hasPkg("cn.cntv")) {
            Intent ci = ctx.getPackageManager().getLaunchIntentForPackage("cn.cntv");
            if (ci != null) {
                ci.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(ci);
                    new Handler(ctx.getMainLooper()).postDelayed(() -> {
                        try {
                            String r0 = MiliAccessibilityService.tapText("直播");
                            if (r0 == null || !r0.contains("\"ok\":true")) {
                                MiliAccessibilityService.tapPercent(0.361, 0.958);
                            }
                        } catch (Throwable ignored) {}
                    }, 2200);
                    return ok("tv_channel", "给你开到" + name + "了，在直播页点一下这个台就行。");
                } catch (Exception ignored) {}
            }
        }

        String url = "https://tv.cctv.com/live/cctv" + num + "/";
        String[] browsers = {"com.quark.browser", "com.android.browser"};
        for (String p : browsers) {
            if (!hasPkg(p)) continue;
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.setPackage(p);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return ok("tv_channel", "给你开" + name + "了。想停就说「米粒暂停」。");
            } catch (Exception ignored) {}
        }
        if (openInWukong(url)) return ok("tv_channel", "用悟空给你开" + name + "了。");
        return fail("no_browser", "这台手机上没找到能放电视的浏览器。");
    }

    /* ================= 5. 看电视 / 看短剧 ================= */

    /* 老人说「看电视」，可能是要看中央台，也可能是要看某个 App 里的短剧。
       所以分两条：tv() 管中央台直播，watchContent() 管「我想看 XX」。 */

    private static final String[][] VIDEO_APPS = {
            {"红果", "com.phoenix.read"},
            {"红果短剧", "com.phoenix.read"},
            {"哔哩", "tv.danmaku.bili"},
            {"b站", "tv.danmaku.bili"},
            {"抖音", "com.ss.android.ugc.aweme"},
            {"快手", "com.smile.gifmaker"},
            {"爱奇艺", "com.qiyi.video"},
            {"腾讯视频", "com.tencent.qqlive"},
            {"优酷", "com.youku.phone"},
            {"芒果", "com.hunantv.imgo.activity"},
            {"央视频", "cn.cctv.news"},
    };

    private static final String WUKONG_PKG = "com.cat.readall";
    private static final String WUKONG_CLS = "com.cat.readall.activity.BrowserMainActivity";

    /** 在悟空浏览器「里面」搜：开首页 → 点它自己的搜索框 → 写片名 → 点它自己的「搜索」。
        首页是自绘的，无障碍树抓不到搜索框，坐标按屏幕比例算；进搜索页后节点齐全。
        实测结果页自带全集剧集和播放器，不用再替老人点第一下。 */
    private JSONObject searchInWukong(String q, String label) {
        if (!openWukongHome()) return fail("open_fail", label + "打不开。");
        new Handler(ctx.getMainLooper()).postDelayed(() -> {
            try { MiliAccessibilityService.wukongSearch(q); } catch (Throwable ignored) {}
        }, 2200);
        noteOften("show", q);
        return ok("search_wukong", "好，我在" + label + "里搜《" + q + "》。");
    }

    /** 把悟空带回首页。
        坑：普通 launch 只把 task 栈里最上面那个页面带回来 —— 上次停在搜索页或播放页，
        再喊一句「用悟空找 XX」，出来的还是旧页面，首页搜索框根本不在。
        CLEAR_TOP 把根 Activity 上面的全清掉，才回得去。 */
    private boolean openWukongHome() {
        Intent i = ctx.getPackageManager().getLaunchIntentForPackage(WUKONG_PKG);
        if (i == null) return false;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try { ctx.startActivity(i); return true; } catch (Exception e) { return false; }
    }

    /** 「接着看 / 追剧」：老人在这台机上追的是悟空里的剧，不是抖音。
        首页那个「继续观看」浮层节点是可点的，实测点完直接进播放页。 */
    public JSONObject resumeWukong() {
        if (!hasPkg(WUKONG_PKG)) return fail("no_app", "手机上没找到悟空浏览器。");
        if (!openWukongHome()) return fail("open_fail", "悟空浏览器打不开。");
        Handler h = new Handler(ctx.getMainLooper());
        h.postDelayed(() -> {
            /* 「继续观看」浮层只在冷启出现一次，靠不住。常驻的是「影视」tab
               观看历史第一项 —— 它是自绘的，无障碍树抓不到节点，按屏幕比例点。
               实测 1080x2400 上 (173,705) 命中，换成比例 0.16 / 0.295。 */
            try { MiliAccessibilityService.tapPercent(0.16, 0.295); } catch (Throwable ignored) {}
        }, 2800);
        return ok("resume_wukong", "好，接着上次看。");
    }

    /** 用悟空浏览器开一个网址。
        悟空不接通用的 VIEW 跳转（实测会被系统浏览器截走），必须 setClassName 点名；
        包可见性还得在 Manifest 的 <queries> 里声明，否则这里根本看不见它。 */
    private boolean openInWukong(String url) {
        /* 只指定包名，让悟空自己挑能接 VIEW 的 Activity。
           adb 实测 `am start -a VIEW -d <url> -p com.cat.readall` 一次就进结果页；
           点名 setClassName 反而会因为栈顶是旧页面被吞掉，停在首页。 */
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.setPackage(WUKONG_PKG);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            ctx.startActivity(i);
            return true;
        } catch (Throwable t) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.setClassName(WUKONG_PKG, WUKONG_CLS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                ctx.startActivity(i);
                return true;
            } catch (Throwable t2) {
                try {
                    Intent i = ctx.getPackageManager().getLaunchIntentForPackage(WUKONG_PKG);
                    if (i == null) return false;
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                    return true;
                } catch (Throwable t3) { return false; }
            }
        }
    }

    /** 想看的内容 → 先开对应 App；手机上没有这个 App，才用悟空搜。 */
    public JSONObject watchContent(String what) {
        String w = what == null ? "" : what.trim();
        if (w.isEmpty()) return fail("empty", "你想看什么呀？说个名字。");

        String pkg = null, hit = null;
        for (String[] row : VIDEO_APPS) {
            if (w.contains(row[0]) || row[0].contains(w)) { pkg = row[1]; hit = row[0]; break; }
        }
        if (pkg != null && hasPkg(pkg)) {
            Intent i = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(i);
                    return ok("open_app", "给你打开" + hit + "了，你挑一个看。");
                } catch (Exception ignored) {}
            }
        }

        /* 手机上没有这个 App：在悟空浏览器里搜片名，不跳百度 */
        if (hasPkg(WUKONG_PKG)) return searchInWukong(w, "悟空浏览器");
        String url = "https://www.baidu.com/s?wd=" + Uri.encode(w);
        if (openInWukong(url)) {
            return ok("search_web", "手机上没装能放「" + w + "」的，我用悟空给你搜一下。");
        }
        if (hasPkg("com.quark.browser")) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.setPackage("com.quark.browser");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return ok("search_web", "我用夸克给你搜一下「" + w + "」。");
            } catch (Exception ignored) {}
        }
        return fail("no_app", "手机上没找到能放" + w + "的地方。");
    }

    /** 中央台直播 → 悟空优先；央视影音装着的话也行，但它在这台机上没有。 */
    public JSONObject tv() {
        String url = "https://tv.cctv.com/live/cctv1/";

        /* 央视影音装了就先用它：CCTV 网页在移动端直接不给放
           （页面写明「请使用电脑端或央视影音客户端观看」），网页那条路是死的。 */
        if (hasPkg("cn.cntv")) {
            Intent ci = ctx.getPackageManager().getLaunchIntentForPackage("cn.cntv");
            if (ci != null) {
                ci.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(ci);
                    /* 冷启落在「我的」页，老人不知道点哪。2 秒后替他切到「直播」tab。 */
                    new Handler(ctx.getMainLooper()).postDelayed(() -> {
                        try {
                            String r = MiliAccessibilityService.tapText("直播");
                            /* 央视影音的 tab 也读不到节点，按屏幕比例兜底。
                               实测 1080x2400 上 (390,2300) 正好命中「直播」。 */
                            if (r == null || !r.contains("\"ok\":true")) {
                                MiliAccessibilityService.tapPercent(0.361, 0.958);
                            }
                        } catch (Throwable ignored) {}
                    }, 2200);
                    return ok("tv_app", "给你打开央视影音了，中央一台在直播里，想停就说「米粒暂停」。");
                } catch (Exception ignored) {}
            }
        }

        if (openInWukong(url)) {
            return ok("tv_web", "用悟空浏览器给你放中央一台了。想停就说「米粒暂停」。");
        }

        /* 实测这台机装的是「央视影音」cn.cntv，不是 com.cctv.cctv / cn.cctv.news。
           CCTV 网页在移动端直接不给放（页面写明要电脑或客户端），所以优先 App。 */
        String[] cctvApps = {"cn.cntv", "com.cctv.cctv", "cn.cctv.news"};
        for (String p : cctvApps) {
            if (!hasPkg(p)) continue;
            Intent i = ctx.getPackageManager().getLaunchIntentForPackage(p);
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(i);
                    return ok("tv", "给你打开央视影音了，要看哪个台跟我说。");
                } catch (Exception ignored) {}
            }
        }

        String[] browsers = {"com.quark.browser", "com.android.browser"};
        for (String p : browsers) {
            if (!hasPkg(p)) continue;
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.setPackage(p);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                String name = "com.quark.browser".equals(p) ? "夸克" : "浏览器";
                return ok("tv_web", "用" + name + "给你放中央一台了。想停就说「米粒暂停」。");
            } catch (Exception ignored) {}
        }
        return fail("no_browser", "这台手机上没找到能放电视的浏览器。");
    }

    /* ================= 6. 发短信 ================= */

    public JSONObject sms(String who, String text) {
        try {
            String num = lookupNumber(who);
            if (num == null) return fail("no_contact", "通讯录里没找到" + who + "。");
            SmsManager sm = SmsManager.getDefault();
            sm.sendTextMessage(num, null, text == null ? "" : text, null, null);
            return ok("sms", "给" + who + "发出去了。");
        } catch (Exception e) {
            // 权限不够就打开短信界面填好
            try {
                Intent i = new Intent(Intent.ACTION_SENDTO);
                i.setData(Uri.parse("smsto:" + who));
                i.putExtra("sms_body", text == null ? "" : text);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return ok("sms_ui", "短信我给你写好了，你按发送。");
            } catch (Exception e2) {
                return fail("err", "短信发不出去。");
            }
        }
    }

    /* ================= 7. 常去的地方 / 常用的人 ================= */

    /** 记一次。用得越多排得越前，「越来越熟练」就是这个变量在起作用。 */
    private void noteOften(String kind, String value) {
        if (value == null || value.isEmpty()) return;
        try {
            String raw = sp.getString(kind, "{}");
            JSONObject o = new JSONObject(raw);
            o.put(value, o.optInt(value, 0) + 1);
            sp.edit().putString(kind, o.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** 取最常用的 n 个 */
    public List<String> mostOften(String kind, int n) {
        List<String> out = new ArrayList<>();
        try {
            JSONObject o = new JSONObject(sp.getString(kind, "{}"));
            List<Map.Entry<String, Integer>> list = new ArrayList<>();
            for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                list.add(new java.util.AbstractMap.SimpleEntry<>(k, o.optInt(k, 0)));
            }
            Collections.sort(list, new Comparator<Map.Entry<String, Integer>>() {
                @Override public int compare(Map.Entry<String, Integer> a, Map.Entry<String, Integer> b) {
                    return b.getValue() - a.getValue();
                }
            });
            for (int i = 0; i < Math.min(n, list.size()); i++) out.add(list.get(i).getKey());
        } catch (Exception ignored) {}
        return out;
    }

    public String oftenJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("call", new JSONArray(mostOften("call", 5)));
            o.put("place", new JSONArray(mostOften("place", 5)));
            o.put("video", new JSONArray(mostOften("video", 3)));
            o.put("wechat", new JSONArray(mostOften("wechat_call", 3)));
        } catch (Exception ignored) {}
        return o.toString();
    }

    /* ================= 8. 天气：真数据 ================= */

    /**
     * 用 wttr.in 拿真天气（免费、不要 key、返回 JSON）。
     * 以前界面上写死「18° 风3级 湿度46%」，口播又是另一套硬编码，
     * 两套数字各说各的 —— 老人一看就知道是假的。现在只有一个来源。
     *
     * 拿不到就返回 ok=false，让前端直说「没看上」，不编。
     */
    /** 英文天况 → 中文词。翻不出来返回空串，宁可不念也别念英文。 */
    private String zhSky(String d) {
        if (d == null || d.isEmpty()) return "";
        if (d.matches(".*[\\u4e00-\\u9fa5].*")) return d.trim();
        String s = d.toLowerCase();
        if (s.contains("sunny") || s.contains("clear")) return "晴";
        if (s.contains("partly cloudy")) return "多云";
        if (s.contains("cloudy")) return "阴天";
        if (s.contains("overcast")) return "阴沉沉的";
        if (s.contains("mist") || s.contains("fog")) return "有雾";
        if (s.contains("haze") || s.contains("smoke")) return "有点霾";
        if (s.contains("heavy rain")) return "下大雨";
        if (s.contains("rain") || s.contains("drizzle") || s.contains("shower")) return "下雨";
        if (s.contains("snow") || s.contains("sleet") || s.contains("blizzard")) return "下雪";
        if (s.contains("thunder") || s.contains("storm")) return "有雷雨";
        if (s.contains("wind")) return "风大";
        return "";
    }

    public JSONObject weather() {
        JSONObject r = new JSONObject();
        HttpURLConnection c = null;
        try {
            /* 先拿手机自己的位置。以前直接打 wttr.in 根路径，它按请求 IP 猜城市——
               服务器出口 IP 可能是任意地方，猜出来的是「鱼台」，跟老人站的街不是一条街。
               有坐标就按坐标查，没有才退回 IP 猜，并且在返回值里标明用的是哪种。 */
            double[] ll = lastLocation();
            String url = (ll != null)
                    ? "https://wttr.in/" + String.format(java.util.Locale.US, "%.3f,%.3f", ll[0], ll[1]) + "?format=j1&lang=zh"
                    : "https://wttr.in/?format=j1&lang=zh";
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(5000);
            c.setReadTimeout(7000);
            c.setRequestProperty("User-Agent", "curl/8");
            BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String ln;
            while ((ln = br.readLine()) != null) sb.append(ln);
            br.close();

            JSONObject j = new JSONObject(sb.toString());
            JSONObject cur = j.optJSONArray("current_condition") != null
                    ? j.getJSONArray("current_condition").getJSONObject(0) : null;
            if (cur == null) { r.put("ok", false); return r; }

            String temp = cur.optString("temp_C", "");
            String hum = cur.optString("humidity", "");
            String desc = "";
            org.json.JSONArray dl = cur.optJSONArray("lang_zh");
            if (dl != null && dl.length() > 0) desc = dl.getJSONObject(0).optString("value", "");
            if (desc.isEmpty()) {
                org.json.JSONArray dw = cur.optJSONArray("weatherDesc");
                if (dw != null && dw.length() > 0) desc = dw.getJSONObject(0).optString("value", "");
            }
            String windKph = cur.optString("windspeedKmph", "");
            String wind = windKph.isEmpty() ? "—" : windKph + " km/h";

            String city = "";
            org.json.JSONArray near = j.optJSONArray("nearest_area");
            if (near != null && near.length() > 0) {
                org.json.JSONArray ar = near.getJSONObject(0).optJSONArray("areaName");
                if (ar != null && ar.length() > 0) city = ar.getJSONObject(0).optString("value", "");
            }
            /* wttr 回的是拼音村名（实测拿到 Wudengfang），念给老人等于没说。
               有坐标就用系统反查中文地名，查得到就用中文的。 */
            String cityZh = "";
            if (ll != null) {
                try {
                    android.location.Geocoder g = new android.location.Geocoder(ctx, java.util.Locale.CHINA);
                    java.util.List<android.location.Address> as = g.getFromLocation(ll[0], ll[1], 1);
                    if (as != null && !as.isEmpty()) {
                        android.location.Address a = as.get(0);
                        String loc = a.getLocality();
                        String sub = a.getSubLocality();
                        String adm = a.getAdminArea();
                        cityZh = (sub != null && !sub.isEmpty()) ? sub
                                : (loc != null && !loc.isEmpty()) ? loc
                                : (adm != null ? adm : "");
                    }
                } catch (Throwable ignored) {}
            }
            if (!cityZh.isEmpty()) city = cityZh;

            /* wttr 有时候 lang_zh 是空的，desc 直接给英文（实测拿到 Partly Cloudy）。
               念给老人听不能带英文，这里先翻成中文词，翻不出来就不念天况。 */
            desc = zhSky(desc);

            /* 明天 / 后天：老人问「明天冷不冷」，以前这里只有 current_condition，
               所以不管问哪天都答「现在」—— 他听到的就是「它根本没听懂」。
               wttr 的 j1 里 weather[] 是逐日预报，第 0 天是今天，第 1 天明天。 */
            try {
                org.json.JSONArray days = j.optJSONArray("weather");
                if (days != null) {
                    for (int i = 1; i < days.length() && i <= 2; i++) {
                        org.json.JSONObject d = days.getJSONObject(i);
                        String sfx = (i == 1) ? "tom" : "aft";     // 明天 / 后天
                        r.put(sfx + "Max", d.optString("maxtempC", ""));
                        r.put(sfx + "Min", d.optString("mintempC", ""));
                        String dd = "";
                        int maxRain = 0;
                        org.json.JSONArray hr = d.optJSONArray("hourly");
                        if (hr != null && hr.length() > 4) {
                            org.json.JSONObject noon = hr.getJSONObject(4);   // 12:00
                            org.json.JSONArray dl2 = noon.optJSONArray("lang_zh");
                            if (dl2 != null && dl2.length() > 0) dd = dl2.getJSONObject(0).optString("value", "");
                            if (dd.isEmpty()) {
                                org.json.JSONArray dw2 = noon.optJSONArray("weatherDesc");
                                if (dw2 != null && dw2.length() > 0) dd = dw2.getJSONObject(0).optString("value", "");
                            }
                            for (int k = 0; k < hr.length(); k++) {
                                maxRain = Math.max(maxRain, hr.getJSONObject(k).optInt("chanceofrain", 0));
                            }
                        }
                        r.put(sfx + "Desc", zhSky(dd));
                        r.put(sfx + "Rain", maxRain);
                    }
                }
            } catch (Throwable ignored) {}

            // 一句能听懂的建议，不外推、不下医疗结论
            String tip = "现在" + (temp.isEmpty() ? "不清楚几度" : temp + "度") + "，"
                    + (desc.isEmpty() ? "" : desc) + "。";
            try {
                int t = Integer.parseInt(temp);
                if (t <= 8) tip += "出门多穿一件。";
                else if (t <= 16) tip += "出门穿件外套。";
                else if (t >= 30) tip += "外头热，少在外面久站。";
            } catch (Exception ignored) {}

            r.put("ok", true);
            r.put("temp", temp);
            r.put("hum", hum.isEmpty() ? "—" : hum + "%");
            r.put("wind", wind);
            r.put("src", ll != null ? "gps" : "ip");
            r.put("desc", desc.isEmpty() ? "—" : desc);
            r.put("city", city);
            r.put("tip", tip);
            return r;
        } catch (Exception e) {
            try { r.put("ok", false); r.put("why", e.getClass().getSimpleName()); } catch (Exception ignored) {}
            return r;
        } finally {
            if (c != null) try { c.disconnect(); } catch (Exception ignored) {}
        }
    }

    /* ================= 工具 ================= */

    /**
     * 取手机当前位置（纬经度）。只用最近一次已知位置，不主动发起定位请求——
     * 老人问天气不该弹出定位授权框，也不该为了一个温度耗电。
     * 没权限 / 没开定位 / 没缓存位置，一律返回 null，让调用方退回 IP 猜。
     */
    private double[] lastLocation() {
        try {
            if (ctx.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED
                && ctx.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) return null;
            android.location.LocationManager lm =
                    (android.location.LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null || !lm.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER)) {
                if (lm == null || !lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)) return null;
            }
            android.location.Location best = null;
            for (String p : new String[]{android.location.LocationManager.NETWORK_PROVIDER,
                                         android.location.LocationManager.GPS_PROVIDER}) {
                android.location.Location l = null;
                try { l = lm.getLastKnownLocation(p); } catch (Exception ignored) {}
                if (l == null) continue;
                // 超过 2 小时的旧位置就别用了，宁可退回 IP 猜
                if (System.currentTimeMillis() - l.getTime() > 2L * 3600 * 1000) continue;
                if (best == null || l.getTime() > best.getTime()) best = l;
            }
            if (best == null) return null;
            return new double[]{best.getLatitude(), best.getLongitude()};
        } catch (Exception e) {
            return null;
        }
    }

    private boolean hasPkg(String pkg) {
        try {
            ctx.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ============ 桌面大图标（2026-11-06：米粒自己就是桌面） ============
       老人点的是图标不是话。全部走标准 Intent，能不碰无障碍就不碰 ——
       无障碍慢、脆、还容易被系统杀，图标这点事轮不到它。
       拨号盘用 ACTION_DIAL（免 CALL_PHONE，老人自己按绿色键），
       短信用 ACTION_SENDTO sms:（进系统短信列表），
       微信用包名直达（queries 里已声明 com.tencent.mm）。 */
    public JSONObject launch(String kind) {
        try {
            Intent i = null;
            if ("dial".equals(kind)) {
                i = new Intent(Intent.ACTION_DIAL);
            } else if ("sms".equals(kind)) {
                i = new Intent(Intent.ACTION_SENDTO, Uri.parse("sms:"));
            } else if ("settings".equals(kind)) {
                i = new Intent(android.provider.Settings.ACTION_SETTINGS);
            } else if ("camera".equals(kind)) {
                i = new Intent(android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return ok("desk_camera", "好，拍照打开了。");
            } else if ("album".equals(kind)) {
                i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        "image/*");
                if (i.resolveActivity(ctx.getPackageManager()) == null)
                    i = ctx.getPackageManager().getLaunchIntentForPackage("com.android.gallery3d");
            } else if ("wechat".equals(kind)) {
                i = ctx.getPackageManager().getLaunchIntentForPackage("com.tencent.mm");
            }
            if (i == null) return fail("no_app", "这台手机上没装这个。");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return ok("desk_" + kind, "好，打开了。");
        } catch (Exception e) {
            return fail("open_fail", "打不开，让家里人看看。");
        }
    }

    /* 带参数版：拨号带号码、通话记录、手电筒。老人桌面的 DialerActivity/手电筒
       这类高频功能，Android 平台本来就是轮子，几行就够，不抄谁家的代码。 */
    public JSONObject launch(String kind, String arg) {
        try {
            Intent i = null;
            if ("dialnum".equals(kind)) {
                String num = arg == null ? "" : arg.replaceAll("[^0-9+*#]", "");
                if (num.length() == 0) return launch("dial");
                i = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + num));
            } else if ("calllog".equals(kind)) {
                /* 通话记录交给系统应用看（它有权限，我们不用申请 READ_CALL_LOG） */
                i = new Intent(Intent.ACTION_VIEW, android.provider.CallLog.Calls.CONTENT_URI);
            } else if ("torch".equals(kind)) {
                return torch();
            }
            if (i == null) return launch(kind);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return ok("desk_" + kind, "好，打开了。");
        } catch (Exception e) {
            return fail("open_fail", "打不开，让家里人看看。");
        }
    }

    /** 手电筒：相机闪光灯一次切换，免界面免权限（FLASHLIGHT 是普通权限）。
     *  2026-11-07：原来用 CameraManager.getTorchMode(id) 读当前状态，
     *  这个 getter 在本机 compileSdk 34 的 android.jar 里不存在（只有
     *  setTorchMode 和 TorchCallback），编译直接 1 error 卡死。
     *  改成自己记开关：老人第一次点必开、再点必关，行为反而更确定。
     *  进程被杀后状态归零，最多多点一次，不影响使用。 */
    private static boolean torchOn = false;
    /** 桌面图标用：按一下切换。 */
    public JSONObject torch() { return torchSet(!torchOn); }
    /** 语音工具用：老人说「开灯」「关灯」必须精确，不能靠 toggle 赌状态。 */
    public JSONObject torchSet(boolean on) {
        try {
            android.hardware.camera2.CameraManager cm =
                    (android.hardware.camera2.CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
            String id = cm.getCameraIdList()[0];
            torchOn = on;
            cm.setTorchMode(id, torchOn);
            return ok("torch", torchOn ? "手电筒开了。" : "手电筒关了。");
        } catch (Exception e) {
            return fail("torch_fail", "手电筒开不了，这台手机不让。");
        }
    }

    private JSONObject ok(String did, String say) {
        JSONObject o = new JSONObject();
        try { o.put("ok", true); o.put("did", did); o.put("say", say); } catch (Exception ignored) {}
        return o;
    }

    private JSONObject fail(String why, String say) {
        JSONObject o = new JSONObject();
        try { o.put("ok", false); o.put("why", why); o.put("say", say); } catch (Exception ignored) {}
        return o;
    }
}
