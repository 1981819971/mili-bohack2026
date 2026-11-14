package com.mili.app;

import android.os.Handler;
import android.os.SystemClock;
import java.util.function.BooleanSupplier;

/** 已有等待的提前结束检查；无法确认就绪时，仍按原等待时长继续原流程。 */
final class UiWait {
    private UiWait() {}

    static void before(Handler handler, long maximumMs, BooleanSupplier ready, Runnable next) {
        before(handler, maximumMs, ready, () -> true, next);
    }

    static void before(Handler handler, long maximumMs, BooleanSupplier ready,
                       BooleanSupplier active, Runnable next) {
        long deadline = SystemClock.uptimeMillis() + maximumMs;
        handler.post(new Runnable() {
            @Override public void run() {
                if (!active.getAsBoolean()) return;
                boolean ok;
                try { ok = ready.getAsBoolean(); } catch (Exception e) { ok = false; }
                long left = deadline - SystemClock.uptimeMillis();
                if (ok || left <= 0) { next.run(); return; }
                handler.postDelayed(this, Math.min(200, left));
            }
        });
    }

    /** 保留同步桥方法的返回方式；只把原来的整段 sleep 改为可提前结束的检查。 */
    static void pause(long maximumMs, BooleanSupplier ready) {
        long deadline = SystemClock.uptimeMillis() + maximumMs;
        while (true) {
            try { if (ready.getAsBoolean()) return; } catch (Exception ignored) {}
            long left = deadline - SystemClock.uptimeMillis();
            if (left <= 0) return;
            try { Thread.sleep(Math.min(100, left)); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }
}
