package com.mili.app;

import android.content.Context;
import android.hardware.ConsumerIrManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 遥控器：开空调、开电视。
 *
 * 老实说清楚这个能力的天花板：
 * 1. 手机得真有红外发射头（小米/华为部分机型有，大部分没有）
 * 2. 每台空调的红外码都不一样，没法凭空猜
 *
 * 所以这里的做法是「学一次，一直用」：
 *   家里人配对时，把码录进来（code 数组），存到本地。
 *   之后老人说「开空调」，米粒就把那个码发出去。
 *
 * 没有红外硬件的手机，直接说清楚控制不了，不假装成功。
 */
public class IrBlaster {

    private final Context ctx;

    public IrBlaster(Context c) { this.ctx = c.getApplicationContext(); }

    /** 这台手机有没有红外发射 */
    public boolean has() {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) return false;
            ConsumerIrManager ir = (ConsumerIrManager) ctx.getSystemService(Context.CONSUMER_IR_SERVICE);
            return ir != null && ir.hasIrEmitter();
        } catch (Exception e) { return false; }
    }

    /** 发一串 NEC 码。pattern 是 [载波开, 载波关, 开, 关, ...] 微秒 */
    private boolean send(int freq, int[] pattern) {
        try {
            ConsumerIrManager ir = (ConsumerIrManager) ctx.getSystemService(Context.CONSUMER_IR_SERVICE);
            if (ir == null || !ir.hasIrEmitter()) return false;
            ir.transmit(freq, pattern);
            return true;
        } catch (Exception e) { return false; }
    }

    /** 取设备配置：{"ac":{"freq":38000,"on":[...],"off":[...]}} */
    private JSONObject conf() {
        try {
            return new JSONObject(ctx.getSharedPreferences("mili_ir", Context.MODE_PRIVATE)
                    .getString("devices", "{}"));
        } catch (Exception e) { return new JSONObject(); }
    }

    public JSONObject power(String device, boolean on) {
        JSONObject r = new JSONObject();
        try {
            if (!has()) {
                r.put("ok", false);
                r.put("why", "no_ir");
                r.put("say", "这台手机没有红外，遥控不了" + (device.contains("空调") ? "空调" : "电视") + "。让家里人装个万能遥控吧。");
                return r;
            }
            String key = device.contains("空调") ? "ac" : device.contains("电视") ? "tv" : "ac";
            JSONObject d = conf().optJSONObject(key);
            if (d == null) {
                r.put("ok", false);
                r.put("why", "no_code");
                r.put("say", "这台" + (key.equals("ac") ? "空调" : "电视") + "还没学过，让家里人拿手机对着按一下，学一次就行。");
                return r;
            }
            JSONArray arr = d.optJSONArray(on ? "on" : "off");
            if (arr == null) {
                r.put("ok", false);
                r.put("why", "no_code");
                r.put("say", key.equals("ac") ? "开机码还没录进来。" : "电视的开机码还没录进来。");
                return r;
            }
            int[] p = new int[arr.length()];
            for (int i = 0; i < arr.length(); i++) p[i] = arr.optInt(i, 0);
            boolean sent = send(d.optInt("freq", 38000), p);
            r.put("ok", sent);
            if (sent) {
                r.put("say", (key.equals("ac") ? "空调" : "电视") + (on ? "给你开开了。" : "关上了。"));
            } else {
                r.put("why", "send_failed");
                r.put("say", "发了没反应，可能挡住了。你正对着再试一次？");
            }
            return r;
        } catch (Exception e) {
            try { r.put("ok", false); r.put("say", "遥控没成功。"); } catch (Exception ignored) {}
            return r;
        }
    }

    /** 家人学码时调用：把红外码存进去 */
    public void learn(String device, boolean on, int freq, int[] pattern) {
        try {
            android.content.SharedPreferences sp =
                    ctx.getSharedPreferences("mili_ir", Context.MODE_PRIVATE);
            JSONObject all = conf();
            String key = device.contains("空调") ? "ac" : "tv";
            JSONObject d = all.optJSONObject(key);
            if (d == null) d = new JSONObject();
            d.put("freq", freq);
            JSONArray a = new JSONArray();
            for (int v : pattern) a.put(v);
            d.put(on ? "on" : "off", a);
            all.put(key, d);
            sp.edit().putString("devices", all.toString()).apply();
        } catch (Exception ignored) {}
    }
}
