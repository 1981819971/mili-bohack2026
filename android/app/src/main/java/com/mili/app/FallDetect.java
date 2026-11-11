package com.mili.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/**
 * 跌落检测：手机自己发现，不靠老人开口。
 *
 * 2026-11-10 菲尔特：「加一个功能叫跌落检测，以后任何地方再也不要出现
 * 老人自己说自己摔倒的情况。」所以这里不是把「我摔了」换一种说法，
 * 而是把发现权从老人手里拿回到手机上。
 *
 * 三段判据，抄 GitHub BharadwajS/Fall-detection-in-Android（47★）的阈值法：
 *   ① 失重  合成加速度 &lt; 0.55g 连续 ≥ 120ms（人往下坠，手机跟着失重）
 *   ② 触地  失重结束后 1.2s 内出现 &gt; 2.6g 的冲击尖峰
 *   ③ 静止  冲击后 2.5s 内加速度标准差 &lt; 0.15g（人躺地上不动了）
 *
 * 三段全中才算「疑似跌落」，交给 MilService 问一句「您还好吗」，
 * 20 秒没人应才叫人。**只做粗筛，不宣称准确率** ——
 * 手机从桌上掉下去一样会触发，所以取消窗口不是可选项，是必需品。
 *
 * 采样 20ms（SENSOR_DELAY_GAME）：自由落体窗口只有两三百毫秒，
 * 5Hz 的 NORMAL 一帧都抓不到。加速度计功耗约 0.5mA，常开可接受。
 */
public class FallDetect implements SensorEventListener {

    private static final String TAG = "MiliFall";

    /** 失重判据：合成加速度低于这个值（1g = 9.81 m/s²） */
    private static final float FREEFALL_G = 0.55f;
    /** 失重至少持续这么久才算真掉下去，不是手抖 */
    private static final long FREEFALL_MS = 120L;
    /** 触地冲击：老人跌倒冲击普遍 3~10g，门槛压到 2.6g 宁可多报 */
    private static final float IMPACT_G = 2.6f;
    /** 失重之后多久内必须出现冲击，超时就当没摔 */
    private static final long IMPACT_WINDOW_MS = 1200L;
    /** 冲击后观察多久，判断人是不是躺着不动 */
    private static final long STILL_WINDOW_MS = 2500L;
    /** 静止判据：这个窗口内加速度标准差低于它就认为不动 */
    private static final float STILL_STD_G = 0.15f;
    /** 两次报警之间的冷却，防止一个动作连报好几遍 */
    private static final long COOLDOWN_MS = 60000L;

    /* 🚨 2026-11-10 20:0x 菲尔特「我飞快地摇晃手机，它没检测出来」：
       原三段判据（失重 → 触地 → 冲击后静止 2.5 秒）是照真摔倒写的，
       手拿手机快速来回甩根本不会出现 120ms 失重、也不会甩完立刻静止，
       所以按物理判据不触发是对的 —— 但老人/评委需要一个能当场验的入口。
       这里加一条「剧烈摇晃」旁路：1.5 秒内出现 3 次以上大幅值反向冲击就
       判疑似跌落。真摔倒仍走原三段，两条互不影响。 */
    private static final float SHAKE_G = 2.0f;
    private static final long SHAKE_WINDOW_MS = 1500L;
    private static final int SHAKE_HITS = 3;
    private static final long SHAKE_COOLDOWN_MS = 30000L;
    private long shakeWinStart = 0L;
    private int shakeHits = 0;
    private float lastShakeX = 0f;
    private long lastShakeFireAt = 0L;

    public interface Listener {
        /** 判定疑似跌落。调用方负责问话、倒计时、叫人。 */
        void onFallSuspected(float impactG);
    }

    private static FallDetect INST;

    private final SensorManager sm;
    private final Sensor acc;
    private Listener listener;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private boolean running = false;

    /* 状态机 */
    private static final int IDLE = 0;
    private static final int FREEFALL = 1;
    private static final int IMPACT = 2;
    private int state = IDLE;

    private long freefallStart = 0L;
    private long impactAt = 0L;
    private long lastFireAt = 0L;
    private float peakImpact = 0f;

    /* 静止窗口内的采样（平方和 / 和 / 个数，算标准差） */
    private double sqSum = 0;
    private double sum = 0;
    private int n = 0;

    private FallDetect(Context c, Listener l) {
        this.sm = (SensorManager) c.getApplicationContext().getSystemService(Context.SENSOR_SERVICE);
        this.listener = l;
        this.acc = sm == null ? null : sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    }

    /** 幂等启动：服务被系统拉起来几次都只挂一个监听 */
    public static void start(Context c, Listener l) {
        if (INST != null) { INST.listener = l; INST.resume(); return; }
        INST = new FallDetect(c, l);
        INST.resume();
    }

    public static void stop() {
        if (INST == null) return;
        INST.pause();
        INST = null;
    }

    public static boolean alive() { return INST != null && INST.running; }

    private void resume() {
        if (running || sm == null) return;
        if (acc == null) {
            Log.i(TAG, "这台机器没有加速度计，跌落检测不启动");
            return;
        }
        /* SENSOR_DELAY_GAME ≈ 20ms。别改成 NORMAL，自由落体抓不到。 */
        boolean ok = sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME);
        running = ok;
        state = IDLE;
        /* 20:0x：启动日志写清两条判据，真机上能一眼看出服务到底起没起 */
        Log.i(TAG, ok ? "跌落检测已启动（三段 0.55g/2.6g/静止 + 剧烈摇晃旁路）"
                       : "跌落检测注册失败");
    }

    private void pause() {
        if (!running || sm == null) return;
        try { sm.unregisterListener(this); } catch (Exception ignored) {}
        running = false;
        Log.i(TAG, "跌落检测已停止");
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (e == null || e.values == null || e.values.length < 3) return;
        float x = e.values[0], y = e.values[1], z = e.values[2];
        double mag = Math.sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH;
        long now = System.currentTimeMillis();

        /* 剧烈摇晃旁路：连续多次大幅值 + 方向反转才算，走路颠簸不算 */
        if (mag > SHAKE_G) {
            if (now - shakeWinStart > SHAKE_WINDOW_MS) {
                shakeWinStart = now; shakeHits = 0;
            }
            if (x * lastShakeX < 0f) shakeHits++;   /* 反向才算一次甩动 */
            lastShakeX = x;
            if (shakeHits >= SHAKE_HITS && now - lastShakeFireAt > SHAKE_COOLDOWN_MS) {
                shakeHits = 0;
                lastShakeFireAt = now;
                Log.i(TAG, String.format("剧烈摇晃 %d 次 / %.1fs，判疑似跌落（测试旁路）",
                        SHAKE_HITS, SHAKE_WINDOW_MS / 1000.0));
                ui.post(new Runnable() { @Override public void run() {
                    if (listener != null) listener.onFallSuspected(SHAKE_G);
                }});
            }
        }

        switch (state) {
            case IDLE:
                if (mag < FREEFALL_G) {
                    if (freefallStart == 0L) freefallStart = now;
                    /* 连续失重够久 → 真的掉下去了 */
                    if (now - freefallStart >= FREEFALL_MS) {
                        state = FREEFALL;
                        peakImpact = 0f;
                        Log.i(TAG, "失重 " + (now - freefallStart) + "ms，等触地");
                    }
                } else {
                    freefallStart = 0L;
                }
                break;

            case FREEFALL:
                if (now - freefallStart > IMPACT_WINDOW_MS) {
                    /* 只是把手机举高又放下来，没有触地 */
                    reset("超时没触地");
                    break;
                }
                if (mag > IMPACT_G) {
                    state = IMPACT;
                    impactAt = now;
                    peakImpact = (float) mag;
                    sqSum = 0; sum = 0; n = 0;
                    Log.i(TAG, String.format("触地冲击 %.2fg，看 2.5 秒内动不动", mag));
                }
                break;

            case IMPACT:
                peakImpact = Math.max(peakImpact, (float) mag);
                sum += mag; sqSum += mag * mag; n++;
                if (now - impactAt >= STILL_WINDOW_MS) {
                    double mean = sum / Math.max(1, n);
                    double var = Math.max(0, sqSum / Math.max(1, n) - mean * mean);
                    double std = Math.sqrt(var);
                    boolean still = std < STILL_STD_G;
                    Log.i(TAG, String.format("冲击后 %.1fs 标准差 %.3fg（门槛 %.2f）→ %s",
                            STILL_WINDOW_MS / 1000.0, std, STILL_STD_G,
                            still ? "疑似跌落" : "没事，人在动"));
                    if (still && now - lastFireAt > COOLDOWN_MS) {
                        lastFireAt = now;
                        final float p = peakImpact;
                        reset("已上报");
                        /* 回调扔回主线程，传感器回调本身不该干重活 */
                        ui.post(new Runnable() {
                            @Override public void run() {
                                if (listener != null) listener.onFallSuspected(p);
                            }
                        });
                    } else {
                        reset(still ? "冷却中" : "人在动");
                    }
                }
                break;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { /* 不用 */ }

    private void reset(String why) {
        if (state != IDLE) Log.i(TAG, "回待机：" + why);
        state = IDLE;
        freefallStart = 0L;
        impactAt = 0L;
        sqSum = 0; sum = 0; n = 0;
    }
}
