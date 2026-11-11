package com.mili.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.telephony.SmsMessage;

import java.util.regex.Pattern;

/**
 * 防诈骗：短信和来电先过一遍，不对就拦下来喊她。
 *
 * 不弹通知了事 —— 老人不看通知。直接让桌宠跳出来，用童声说人话。
 *
 * 判据（按危险程度排）：
 *   高危：要验证码 / 要银行卡密码 / 让转到「安全账户」/ 冒充公检法
 *   中危：陌生人让转账 / 中奖要领奖 / 点链接
 *   可疑：陌生号码 + 提到钱
 *
 * 判定原则：宁可多提醒一句，也不能漏。但也不乱喊 ——
 * 银行正常的余额变动短信里也有「元」，不能一看有钱字就报警。
 */
public class ScamGuard extends BroadcastReceiver {

    /* 高危：几乎可以肯定是骗 */
    private static final Pattern[] HIGH = {
            Pattern.compile("(验证码|校验码).{0,12}(发给|告诉|提供|报给)"),
            Pattern.compile("(安全账户|安全账号|资金核查|账户核查)"),
            Pattern.compile("(涉嫌|疑似).{0,10}(洗钱|犯罪|案件|违法)"),
            Pattern.compile("(公安|法院|检察院|警察).{0,20}(配合|调查|冻结|拘)"),
            Pattern.compile("(银行卡|卡号).{0,10}(密码|有效期|背面三位|CVV)", Pattern.CASE_INSENSITIVE),
            Pattern.compile("(注销|解冻).{0,10}(需要|要).{0,6}(转账|汇款|打款)"),
    };

    /* 中危：需要人再看一眼 */
    private static final Pattern[] MID = {
            Pattern.compile("(中奖|中奖了|恭喜您).{0,20}(领取|领奖|点击|手续费|税费)"),
            Pattern.compile("(点击|打开|登录).{0,10}(链接|网址).{0,10}(领|奖|退款|补贴)"),
            Pattern.compile("(退款|理赔|补偿).{0,14}(点击|加微信|加QQ|提供)"),
            Pattern.compile("(刷单|兼职|日赚|日结).{0,10}(元|佣金|返利)"),
            Pattern.compile("(转账|汇款|打款).{0,10}(到|至).{0,10}(账户|卡号)"),
    };

    /* 银行正常短信里会出现这些，说明是官方通知，不是找你要钱 */
    private static final Pattern SAFE = Pattern.compile(
            "(尾号|余额|消费|入账|到账|活期|定期|您账户|账单|还款成功|交易成功|验证码\\d{4,6}，)");

    private static final Pattern URGENT = Pattern.compile("(今天|立即|马上|限时|最后|否则|立刻)");

    @Override
    public void onReceive(Context c, Intent it) {
        try {
            if (it == null) return;
            String action = it.getAction();
            if ("android.provider.Telephony.SMS_RECEIVED".equals(action)) {
                checkSms(c, it);
            }
        } catch (Exception ignored) {}
    }

    private void checkSms(Context c, Intent it) {
        StringBuilder all = new StringBuilder();
        String from = "";
        try {
            Bundle b = it.getExtras();
            if (b == null) return;
            Object[] pdus = (Object[]) b.get("pdus");
            String fmt = b.getString("format");
            if (pdus == null) return;
            for (Object p : pdus) {
                SmsMessage m = SmsMessage.createFromPdu((byte[]) p, fmt);
                if (m == null) continue;
                if (from.isEmpty()) from = m.getOriginatingAddress();
                all.append(m.getMessageBody());
            }
        } catch (Exception e) { return; }

        String text = all.toString();
        if (text.isEmpty()) return;

        int level = judge(text);
        if (level == 0) return;

        String who = from == null || from.isEmpty() ? "一个陌生号码" : shortNum(from);
        String say;
        if (level == 2) {
            say = who + "发来的短信，不对劲，你别理。要是让你转钱、要验证码，千万别给。";
        } else {
            say = who + "发来的，看着像骗人的。你拿不准就问我，或者打给孩子。";
        }
        // 让桌宠跳出来说
        MilService.medRemind(c, say);
        // 记一笔，界面上能看到今天拦了几条
        note(c, from, level, text);
    }

    /** 0 安全 1 可疑 2 高危 */
    static int judge(String text) {
        if (text == null || text.isEmpty()) return 0;
        // 官方银行通知先排除，别误伤
        boolean looksOfficial = SAFE.matcher(text).find();

        for (Pattern p : HIGH) {
            if (p.matcher(text).find()) return 2;
        }
        int mid = 0;
        for (Pattern p : MID) {
            if (p.matcher(text).find()) { mid = 1; break; }
        }
        if (mid == 1) {
            if (looksOfficial) return 0;      // 「您账户到账」这种是正常通知
            return URGENT.matcher(text).find() ? 2 : 1;
        }
        return 0;
    }

    private String shortNum(String n) {
        String s = n.replaceAll("[^0-9]", "");
        if (s.length() >= 7) return "尾号" + s.substring(s.length() - 4) + "的号码";
        return n;
    }

    private void note(Context c, String from, int level, String text) {
        try {
            android.content.SharedPreferences sp = c.getSharedPreferences("mili_guard", Context.MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("blocks", "[]"));
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("from", from == null ? "" : from);
            o.put("lv", level);
            o.put("at", System.currentTimeMillis());
            o.put("txt", text.length() > 60 ? text.substring(0, 60) : text);
            org.json.JSONArray out = new org.json.JSONArray();
            out.put(o);
            for (int i = 0; i < arr.length() && i < 29; i++) out.put(arr.get(i));
            sp.edit().putString("blocks", out.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** 给界面看的：拦过几条 */
    public static String logJson(Context c) {
        android.content.SharedPreferences sp = c.getSharedPreferences("mili_guard", Context.MODE_PRIVATE);
        return sp.getString("blocks", "[]");
    }
}
