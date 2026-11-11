package com.mili.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

/**
 * 无障碍自愈 —— 逻辑照抄 dsh-Go 的 {@code phone/a11y/A11yKeeper.kt}（AGPL-3.0），
 * 只把「开关」和「服务类名」换成米粒自己的。
 *
 * <p>为什么需要它：MIUI/HyperOS 强制停止、系统内存回收、用户在设置里手滑关掉，都会把
 * ENABLED_ACCESSIBILITY_SERVICES 里我们那一项抹掉。抹掉之后无障碍不再绑定，小米粒的
 * 「替老人点手机」全部失效，而且没有任何提示 —— 老人只会觉得「它坏了」。
 *
 * <p>拿到 WRITE_SECURE_SETTINGS（adb {@code pm grant} 一次即可，见 tools/grant-perms.sh）后：
 * <ul>
 *   <li>我们不在名单里 → ADD，把 {@code pkg/cls} 写回去并置 ACCESSIBILITY_ENABLED=1；</li>
 *   <li>在名单里但 10 秒还没绑定上（系统的「无法运行」态）→ REBIND，先移出并关掉，
 *       隔 1 秒再移入并打开，逼系统重新走一遍绑定；</li>
 *   <li>连续写入按 5s→10s→20s… 指数退避，最多 10 分钟一次，连续稳定 60 秒后退避清零 ——
 *       不会和系统打循环战把无障碍管线拖崩（这个项目已经因为高频事件崩过 system_server）。</li>
 * </ul>
 *
 * <p>只写 {@code ENABLED_ACCESSIBILITY_SERVICES} 与 {@code ACCESSIBILITY_ENABLED} 两项，
 * 其他无障碍条目原样保留，不碰别人。
 */
public final class A11yKeeper {

    private static final String TAG = "MiliA11yKeeper";

    /** 移出到移回之间的间隔：系统必须看见两次写入，才不会当成一次无效改动。 */
    private static final long REBIND_GAP_MS = 1000L;

    private static final KeeperPlan PLAN =
            new KeeperPlan("com.mili.app", "com.mili.app.MiliAccessibilityService");

    private static final KeeperPlan.Clock CLOCK = SystemClock::elapsedRealtime;

    private A11yKeeper() {}

    /** WRITE_SECURE_SETTINGS 是否已授予（需 adb 或 root 给一次）。 */
    public static boolean granted(Context context) {
        return context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 看一眼现状，该修就修。
     *
     * @return true 表示「该开的都开着」，或者正在拉起来的过程中。任何线程可调；
     *         重绑那一步会占用约 1 秒，所以别在主线程上顺手调用。
     */
    public static synchronized boolean check(Context context) {
        final Context app = context.getApplicationContext();
        final boolean on = true;                       // 米粒的障碍服务没有独立开关，装了就该在
        final boolean connected = MiliAccessibilityService.ready();
        final boolean granted = on && !connected && granted(app);
        final String list = granted ? read(app) : null;

        final KeeperPlan.Step step = PLAN.next(on, granted, list, connected, CLOCK.now());
        try {
            switch (step) {
                case ADD:
                    write(app, PLAN.withMe(list), true);
                    Log.i(TAG, "无障碍被移出名单，已写回");
                    break;
                case REBIND:
                    write(app, PLAN.withoutMe(list), false);
                    SystemClock.sleep(REBIND_GAP_MS);
                    if (!granted(app)) return false;
                    write(app, PLAN.withMe(read(app)), true);
                    Log.i(TAG, "无障碍在名单里但没绑定，已重绑");
                    break;
                case NONE:
                default:
                    break;
            }
        } catch (Exception e) {
            Log.w(TAG, "自愈失败", e);
        }
        return on;
    }

    private static String read(Context app) {
        return Settings.Secure.getString(
                app.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
    }

    private static void write(Context app, String list, boolean enable) {
        Settings.Secure.putString(
                app.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, list);
        if (enable) {
            Settings.Secure.putInt(
                    app.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 1);
        }
    }

    /** 覆盖安装之后进程会重启，重启时无障碍常常还没绑上 —— 在这里补一次。 */
    public static final class Receiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent == null || !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
            final PendingResult pending = goAsync();
            new Thread(() -> {
                try { check(context); } finally { pending.finish(); }
            }, "mili-a11y-keeper").start();
        }
    }

    /* 常驻看门狗：只在「没绑上」的时候才动，绑着的时候这个线程每 5 秒只是读一个 static 布尔，
       几乎不耗电。
       为什么不放在主线程的 Handler 里：REBIND 要 sleep 1 秒，主线程睡 1 秒会卡住整个界面，
       MIUI 还可能判成 ANR。 */
    private static Thread ticker;

    public static synchronized void startTicker(final Context context) {
        if (ticker != null && ticker.isAlive()) return;
        final Context app = context.getApplicationContext();
        ticker = new Thread(() -> {
            while (true) {
                try {
                    if (!MiliAccessibilityService.ready()) check(app);
                } catch (Throwable ignored) {
                    // 自愈本身不能把进程带崩
                }
                try {
                    Thread.sleep(5000L);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "mili-a11y-tick");
        ticker.setDaemon(true);
        ticker.start();
    }
}
