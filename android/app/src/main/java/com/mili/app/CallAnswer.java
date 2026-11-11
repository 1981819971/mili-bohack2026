package com.mili.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyManager;
import android.telecom.TelecomManager;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 电话自动接听（白名单）。
 *
 * 2026-11-07 菲尔特：「加一个自动接电话的白名单」。
 * 设计：
 *   · 2026-11-10 菲尔特：「不管是谁都只要在通讯录里的，都自动接听」。
 *     现在两条路都算数：① 网页推来的家人名单；② 直接查系统通讯录全体。
 *     ② 不走网页 —— pm clear / 网页还没起来时照样生效。
 *     通讯录里没有的真陌生号照常响铃，米粒不碰。
 *   · 响铃 → 读来电号 → 和名单后缀匹配（防 +86 / 区号前缀对不上）→
 *     对上了才接：API 26+ 走 TelecomManager.acceptRingingCall()，
 *     不行就退无障碍点拨号界面的「接听」。
 *   · 接通后回网页一声（window.__onCallAnswered(名字, 'phone')），
 *     米粒当面说「闺女来电话，我帮你接了」—— 老人得知道刚才是谁、发生了什么。
 *
 * 微信语音/视频的自动接在 MiliNotifService 里（它守着通知这条路），
 * 接通后也走这里的 notifyJs 播报，配置也共用同一个 SP。
 */
public class CallAnswer {

    private static final String TAG = "MiliCall";
    private static final String SP = "mili_call";

    /** 网页那边的执行器，MainActivity 挂上来。null 就只接不报。 */
    public interface Js { void eval(String js); }
    public static Js js;

    private static volatile boolean started = false;
    private static Context appCtx;
    private static boolean ringHandled = false;   // 一次响铃只接一次

    /* ================= 配置：网页端推过来的名单和开关 ================= */

    /** json: {"phoneAuto":true,"wxAuto":true,"list":[{"name":"闺女","phone":"188...","wx":""}]} */
    public static JSONObject setConfig(Context c, String json) {
        JSONObject out = new JSONObject();
        try {
            JSONObject in = new JSONObject(json == null ? "{}" : json);
            SharedPreferences.Editor ed = sp(c).edit();
            ed.putBoolean("phoneAuto", in.optBoolean("phoneAuto", true));
            ed.putBoolean("wxAuto", in.optBoolean("wxAuto", true));
            ed.putBoolean("contactAuto", in.optBoolean("contactAuto", true));
            JSONArray wl = in.optJSONArray("list");
            /* 2026-11-10：清空数据＝新手机，S.fam 是空的，推过来的名单也空 ——
               自动接听等于没开（真机 shared_prefs 里 wl=[]）。
               名单空时按通讯录里明确的家人称呼补一份，只认手机号/座机，
               客服、短信、服务号一律不进；补不到就保持空，绝不把所有来电都接。 */
            if (wl == null || wl.length() == 0) {
                JSONArray auto = autoFamilyFromContacts(c);
                if (auto.length() > 0) {
                    wl = auto;
                    android.util.Log.i(TAG, "名单为空，通讯录自动补 " + auto.length() + " 人");
                }
            }
            /* 2026-11-10 菲尔特：「自动识别通讯录和正规电话」。
               家里人名单常常只填了称呼（「闺女」「女儿」）没填号码，
               matchPhone 拿空号去比，来电永远对不上 → 自动接听像没做一样。
               这里按通讯录显示名补一次号，补不到就原样留着等家人手填。 */
            int filled = 0;
            if (wl != null) for (int i = 0; i < wl.length(); i++) {
                JSONObject p = wl.optJSONObject(i);
                if (p == null) continue;
                if (!p.optString("phone", "").trim().isEmpty()) continue;
                String nm = p.optString("name", "").trim();
                if (nm.isEmpty()) continue;
                String got = lookupPhoneByDisplayName(c, nm);
                if (got != null && !got.isEmpty()) { p.put("phone", got); filled++; }
            }
            ed.putString("wl", wl == null ? "[]" : wl.toString());
            ed.apply();
            out.put("ok", true);
            out.put("phone", wl == null ? 0 : wl.length());
            out.put("filled", filled);
            android.util.Log.i(TAG, "白名单更新 " + (wl == null ? 0 : wl.length())
                    + " 人，通讯录补号 " + filled + " 个");
        } catch (Throwable t) {
            try { out.put("ok", false); out.put("err", t.getClass().getSimpleName()); } catch (Throwable ignored) {}
        }
        return out;
    }

    public static JSONObject config(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("phoneAuto", sp(c).getBoolean("phoneAuto", true));
            o.put("wxAuto", sp(c).getBoolean("wxAuto", true));
            o.put("contactAuto", sp(c).getBoolean("contactAuto", true));
            JSONArray wl;
            try { wl = new JSONArray(sp(c).getString("wl", "[]")); } catch (Throwable e) { wl = new JSONArray(); }
            o.put("list", wl);
        } catch (Throwable ignored) {}
        return o;
    }

    /** 名单为空时，从通讯录里挑「明确的家人称呼」当初始白名单。
        只收长度≥7 位的正规号码，客服/短信/服务号全排除；最多 6 人。
        绝不把通讯录所有人都接进来 —— 自动接起诈骗电话比不接更危险。 */
    private static JSONArray autoFamilyFromContacts(Context c) {
        JSONArray out = new JSONArray();
        final String[] keys = {"女儿", "闺女", "儿子", "爸爸", "妈妈", "老伴",
                "爷爷", "奶奶", "外公", "外婆", "爸", "妈"};
        final String[] junk = {"钉钉", "客服", "短信", "快递", "外卖", "银行", "官方"};
        try {
            android.database.Cursor cur = c.getContentResolver().query(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{
                            android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                            android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER},
                    null, null, null);
            if (cur == null) return out;
            java.util.HashSet<String> seen = new java.util.HashSet<String>();
            while (cur.moveToNext() && out.length() < 6) {
                String nm = cur.getString(0), ph = cur.getString(1);
                if (nm == null || ph == null) continue;
                boolean bad = false;
                for (String j : junk) if (nm.contains(j)) { bad = true; break; }
                if (bad) continue;
                String digits = ph.replaceAll("[^0-9]", "");
                if (digits.length() < 7 || seen.contains(digits)) continue;
                String hit = null;
                for (String k : keys) if (nm.contains(k)) { hit = k; break; }
                if (hit == null) continue;
                seen.add(digits);
                JSONObject p = new JSONObject();
                p.put("name", nm);
                p.put("phone", ph);
                p.put("wx", "");
                p.put("auto", true);
                out.put(p);
            }
            cur.close();
        } catch (Throwable t) {
            android.util.Log.i(TAG, "通讯录自动补名单读不到 " + t);
        }
        return out;
    }

    /** 按通讯录显示名找号码。模糊匹配是为了兼容「闺女」「女儿」这类备注，
        取第一个号码；找不到返回 null，绝不猜一个号填进去。 */
    private static String lookupPhoneByDisplayName(Context c, String name) {
        try {
            android.content.ContentResolver cr = c.getContentResolver();
            android.database.Cursor cur = cr.query(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{ android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER },
                    android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                    new String[]{ "%" + name + "%" }, null);
            if (cur == null) return null;
            String got = null;
            if (cur.moveToFirst()) got = cur.getString(0);
            cur.close();
            return got;
        } catch (Throwable t) {
            android.util.Log.i(TAG, "通讯录补号读不到 " + t);
            return null;
        }
    }

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(SP, Context.MODE_PRIVATE);
    }

    /* ================= 来电监听 ================= */

    /** 幂等：MainActivity 和 MilService 谁先起来都行。 */
    public static void init(Context c) {
        if (started) return;
        appCtx = c.getApplicationContext();
        try {
            TelephonyManager tm = (TelephonyManager)
                    appCtx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return;
            tm.listen(new PhoneStateListener() {
                @Override public void onCallStateChanged(int state, String num) {
                    if (state == TelephonyManager.CALL_STATE_RINGING) onRinging(num);
                    else if (state == TelephonyManager.CALL_STATE_IDLE) ringHandled = false;
                }
            }, PhoneStateListener.LISTEN_CALL_STATE);
            started = true;
            android.util.Log.i(TAG, "来电监听已挂");
        } catch (Throwable t) {
            android.util.Log.i(TAG, "来电监听挂不上 " + t);
        }
    }

    private static void onRinging(String num) {
        if (ringHandled) return;
        if (appCtx == null) return;
        try {
            JSONObject cfg = config(appCtx);
            if (!cfg.optBoolean("phoneAuto", true)) return;
            String who = matchPhone(cfg.optJSONArray("list"), num);
            if (who == null && cfg.optBoolean("contactAuto", true))
                who = contactName(appCtx, num);      // 通讯录里的人一律接
            if (who == null) return;                  // 真陌生号：照常响铃，不碰
            ringHandled = true;
            android.util.Log.i(TAG, "白名单来电 " + who + " " + num + "，自动接");
            accept();
            notifyJs(who, "phone");
        } catch (Throwable t) {
            android.util.Log.i(TAG, "onRinging " + t);
        }
    }

    /** 号码对上名单里哪个人。后缀匹配，最少比 7 位 —— 防 +86、防 0 前缀、防带横线。 */
    static String matchPhone(JSONArray wl, String num) {
        if (wl == null || num == null) return null;
        String a = num.replaceAll("[^0-9]", "");
        if (a.length() < 7) return null;              // 隐藏号码/空号：不接
        for (int i = 0; i < wl.length(); i++) {
            JSONObject p = wl.optJSONObject(i);
            if (p == null) continue;
            String b = p.optString("phone", "").replaceAll("[^0-9]", "");
            if (b.length() < 7) continue;
            if (a.endsWith(b) || b.endsWith(a)) {
                String n = p.optString("name", "").trim();
                return n.isEmpty() ? "家里人" : n;
            }
        }
        return null;
    }

    /** 通讯录里有没有这个号。后缀比对防 +86 / 区号 / 横线对不上。
        直接读系统通讯录，不依赖网页推名单 —— 清数据后不用等前端启动就生效。 */
    static String contactName(Context c, String num) {
        if (c == null || num == null) return null;
        String a = num.replaceAll("[^0-9]", "");
        if (a.length() < 7) return null;
        android.database.Cursor cur = null;
        try {
            cur = c.getContentResolver().query(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                                 android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER},
                    android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER + " IS NOT NULL",
                    null, null);
            if (cur == null) return null;
            while (cur.moveToNext()) {
                String n = cur.getString(0);
                String b = cur.getString(1);
                if (b == null) continue;
                String d = b.replaceAll("[^0-9]", "");
                if (d.length() < 7) continue;
                if (a.endsWith(d) || d.endsWith(a)) {
                    return (n == null || n.trim().isEmpty()) ? "通讯录里的人" : n.trim();
                }
            }
        } catch (Throwable t) {
            android.util.Log.i(TAG, "查通讯录失败 " + t);
        } finally {
            if (cur != null) try { cur.close(); } catch (Throwable ignored) {}
        }
        return null;
    }

    /** 调试验证：不走真铃，直接按来电号跑「读配置→白名单匹配→播报」完整链路。不碰 TelecomManager。 */
    public static void testRing(String num) {
        if (appCtx == null) { android.util.Log.i(TAG, "测试响铃：监听还没初始化"); return; }
        android.util.Log.i(TAG, "测试响铃 " + num);
        try {
            JSONObject cfg = config(appCtx);
            if (!cfg.optBoolean("phoneAuto", true)) {
                android.util.Log.i(TAG, "测试响铃：phoneAuto=false 不接"); return;
            }
            String who = matchPhone(cfg.optJSONArray("list"), num);
            if (who == null && cfg.optBoolean("contactAuto", true)) who = contactName(appCtx, num);
            if (who == null) {
                android.util.Log.i(TAG, "测试响铃：陌生号不接 " + num); return;
            }
            android.util.Log.i(TAG, "白名单来电 " + who + " " + num + "，自动接（测试）");
            notifyJs(who, "phone");
        } catch (Throwable t) {
            android.util.Log.i(TAG, "testRing " + t);
        }
    }

    /** 接。TelecomManager 是正路；不行就退无障碍去点「接听」。 */
    private static void accept() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                int gr = appCtx.checkSelfPermission("android.permission.ANSWER_PHONE_CALLS");
                if (gr == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    TelecomManager tcm = (TelecomManager)
                            appCtx.getSystemService(Context.TELECOM_SERVICE);
                    if (tcm != null) { tcm.acceptRingingCall(); return; }
                }
            }
        } catch (Throwable t) {
            android.util.Log.i(TAG, "acceptRingingCall 不行 " + t);
        }
        /* 兜底：拨号界面的「接听」两个字是可读的。点 6 次，出了节点就点中。 */
        final Handler h = new Handler(Looper.getMainLooper());
        h.postDelayed(new Runnable() {
            @Override public void run() {
                try {
                    String r = MiliAccessibilityService.tapText("接听");
                    if (r != null && r.contains("\"ok\":true")) return;
                    h.postDelayed(this, 700);
                } catch (Throwable ignored) {}
            }
        }, 600);
    }

    /* ================= 接 / 挂（老人说「接一下」「挂了吧」时走这里） ================= */

    /** 接起正在响铃的电话。正路 TelecomManager，不行就无障碍点「接听」。 */
    public static boolean answer(Context c) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26 &&
                    c.checkSelfPermission("android.permission.ANSWER_PHONE_CALLS")
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                TelecomManager tcm = (TelecomManager)
                        c.getApplicationContext().getSystemService(Context.TELECOM_SERVICE);
                if (tcm != null) { tcm.acceptRingingCall(); return true; }
            }
        } catch (Throwable ignored) {}
        /* 兜底：无障碍点「接听」，点 8 次给系统界面留时间 */
        final Handler h = new Handler(Looper.getMainLooper());
        h.postDelayed(new Runnable() {
            int tries = 0;
            @Override public void run() {
                try {
                    String r = MiliAccessibilityService.tapText("接听");
                    if (r != null && r.contains("\"ok\":true")) return;
                    if (++tries < 8) h.postDelayed(this, 500);
                } catch (Throwable ignored) {}
            }
        }, 300);
        return true;
    }

    /** 挂断当前通话（响铃拒接 / 通话中挂断）。 */
    public static boolean endCall(Context c) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 28 &&
                    c.checkSelfPermission("android.permission.ANSWER_PHONE_CALLS")
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                TelecomManager tcm = (TelecomManager)
                        c.getApplicationContext().getSystemService(Context.TELECOM_SERVICE);
                if (tcm != null) { tcm.endCall(); return true; }
            }
        } catch (Throwable ignored) {}
        try {
            String r = MiliAccessibilityService.tapText("挂断");
            if (r != null && r.contains("\"ok\":true")) return true;
        } catch (Throwable ignored) {}
        return false;
    }

    /* ================= 接通播报（电话和微信共用） ================= */

    public static void notifyJs(String name, String kind) {
        if (js == null) return;
        try {
            String who = (name == null || name.trim().isEmpty()) ? "家里人" : name.trim();
            js.eval("window.__onCallAnswered && window.__onCallAnswered("
                    + JSONObject.quote(who) + ",'" + kind + "')");
        } catch (Throwable ignored) {}
    }
}
