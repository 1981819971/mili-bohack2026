package com.mili.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * 吃药提醒：到点把米粒叫出来，让它自己说。
 *
 * 时间从 SharedPreferences 的 "mili_alarms" 读，格式：
 *   [{"h":8,"m":30,"who":"降压药","dose":"一次一片","on":true}, ...]
 *
 * 为什么用 AlarmManager 的 setExactAndAllowWhileIdle：
 * 普通 set() 在打盹模式下会延后几十分钟，吃药这种事不能延。
 */
public class MedAlarm extends BroadcastReceiver {

    public static final String EXTRA_WHO = "who";
    public static final String EXTRA_DOSE = "dose";

    @Override
    public void onReceive(Context c, Intent it) {
        String who = it.getStringExtra(EXTRA_WHO);
        String dose = it.getStringExtra(EXTRA_DOSE);
        String say = (who == null ? "该吃药啦！" : who + "该吃啦，" + (dose == null ? "" : dose) + "。");
        // 直接让桌宠跳出来说
        MilService.medRemind(c, say);
        // 明天的这一顿也续上
        if (who != null) scheduleAll(c);
    }

    /** 从偏好里重排所有闹钟 */
    public static void scheduleAll(Context c) {
        try {
            SharedPreferences sp = c.getSharedPreferences("mili_alarms", Context.MODE_PRIVATE);
            JSONArray arr = new JSONArray(sp.getString("list", "[]"));
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;

            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!o.optBoolean("on", true)) continue;
                int h = o.optInt("h", 8), m = o.optInt("m", 0);

                Calendar t = Calendar.getInstance();
                t.set(Calendar.HOUR_OF_DAY, h);
                t.set(Calendar.MINUTE, m);
                t.set(Calendar.SECOND, 0);
                t.set(Calendar.MILLISECOND, 0);
                if (t.getTimeInMillis() <= System.currentTimeMillis()) {
                    t.add(Calendar.DAY_OF_MONTH, 1);
                }

                Intent i2 = new Intent(c, MedAlarm.class);
                i2.putExtra(EXTRA_WHO, o.optString("who", ""));
                i2.putExtra(EXTRA_DOSE, o.optString("dose", ""));
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
                PendingIntent pi = PendingIntent.getBroadcast(c, 1000 + i, i2, flags);

                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        if (am.canScheduleExactAlarms()) {
                            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), pi);
                        } else {
                            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), pi);
                        }
                    } else {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), pi);
                    }
                } catch (SecurityException e) {
                    am.set(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), pi);
                }
            }
        } catch (Exception ignored) {}
    }

    /** 存一条提醒并重排。前端拍完药盒调这个。 */
    public static void add(Context c, int h, int m, String who, String dose) {
        try {
            SharedPreferences sp = c.getSharedPreferences("mili_alarms", Context.MODE_PRIVATE);
            JSONArray arr = new JSONArray(sp.getString("list", "[]"));
            JSONObject o = new JSONObject();
            o.put("h", h); o.put("m", m);
            o.put("who", who == null ? "" : who);
            o.put("dose", dose == null ? "" : dose);
            o.put("on", true);
            arr.put(o);
            sp.edit().putString("list", arr.toString()).apply();
            scheduleAll(c);
        } catch (Exception ignored) {}
    }

    public static String listJson(Context c) {
        SharedPreferences sp = c.getSharedPreferences("mili_alarms", Context.MODE_PRIVATE);
        return sp.getString("list", "[]");
    }
}
