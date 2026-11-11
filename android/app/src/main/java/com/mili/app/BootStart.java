package com.mili.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 开机自启 + 定时自检。
 *
 * 老人不会主动开 App，得让它自己一直在。
 * 开机拉一次；之后每 15 分钟自己对一次账（见 Waker），
 * 被省电策略收掉了也会自己爬起来 —— 这是「退到后台一会儿就没了」的正解。
 */
public class BootStart extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent it) {
        if (it == null) return;
        String a = it.getAction();
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(a);
        boolean tick = Waker.A_TICK.equals(a);
        if (!boot && !tick) return;
        /* 2026-11-08：用户点过「退出米粒桌面」就别再自己回来。
           组件通常已被 disable，这里再兜一层（ROM 可能把 disable 重置）。 */
        try {
            if (c.getSharedPreferences("mili_prefs", 0).getBoolean("home_exited", false)) return;
        } catch (Throwable ignored) {}

        try {
            Intent s = new Intent(c, MilService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(s);
            else c.startService(s);
        } catch (Exception ignored) {}

        if (boot) {
            Waker.schedule(c);
            MedAlarm.scheduleAll(c);
        }
    }
}
