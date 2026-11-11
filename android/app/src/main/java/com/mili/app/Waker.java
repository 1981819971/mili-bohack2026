package com.mili.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 让米粒别被系统清掉。
 *
 * 实测：MIUI 上「退到后台不到一会儿就没了」，那不是我们的代码挂了 ——
 * 是省电策略把常驻服务收了。自家的进程防不住别人家的清理器，
 * 唯一稳的办法是「被收掉之后自己爬起来」：
 * 挂一个每 15 分钟的闹钟，响了就看一眼服务在不在，不在就拉起来。
 *
 * 为什么用 setInexactRepeating 而不是 setExactAndAllowWhileIdle：
 * 后者在 targetSdk 33+ 要 SCHEDULE_EXACT_ALARM 权限，老人机器上还得手动开；
 * 我们要的只是「大约十几分钟自检一次」，不需要精确到秒。
 */
public class Waker {

    private static final String TAG = "MiliWaker";
    public static final String A_TICK = "com.mili.app.KEEPALIVE";
    private static final int REQ = 7301;

    public static void schedule(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = PendingIntent.getBroadcast(c, REQ,
                    new Intent(c, BootStart.class).setAction(A_TICK),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            // 第一次 1 分钟后，之后每 15 分钟；待机时系统会放宽，但一定会来
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    60_000L, 15 * 60 * 1000L, pi);
            Log.i(TAG, "自检闹钟已挂");
        } catch (Throwable t) {
            Log.i(TAG, "挂闹钟失败 " + t);
        }
    }

    public static void cancel(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = PendingIntent.getBroadcast(c, REQ,
                    new Intent(c, BootStart.class).setAction(A_TICK),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.cancel(pi);
        } catch (Throwable ignored) {}
    }
}
