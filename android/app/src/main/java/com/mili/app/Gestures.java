package com.mili.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 发手势，并且知道它到底有没有落地。
 *
 * <p>照抄 dsh-Go {@code phone/a11y/Actuator.kt} 的 {@code gesture()}（AGPL-3.0）里那一步：
 * dispatchGesture 的返回值只代表「系统收下了这个请求」，不代表手指真的划过屏幕 ——
 * 手势进了系统的输入管线之后照样可能被吞掉（窗口正在切换、有悬浮层挡着、
 * 输入法还没收起来）。dsh-Go 用 CountDownLatch 等 GestureResultCallback，拿到的才是
 * 「onCompleted」这个真结果。
 *
 * <p>米粒原来的写法是 {@code dispatchGesture(g, null, null)}：发完就报 ok，于是出现
 * 「它说点好了，其实屏幕没动」。这个类就是补这一步。
 *
 * <p>⚠️ 主线程上不能等 —— 等下去就是 ANR。主线程调用时降级成「发出去了」并打一条警告，
 * 至少要能在 logcat 里看出来这次结果没确认。
 */
public final class Gestures {

    private static final String TAG = "MiliGesture";

    /** 等结果的上限 = 手势时长 + 这么多，留够系统回调的时间。 */
    private static final long GRACE_MS = 2000L;

    private Gestures() {}

    /**
     * @param durationMs 手势本身的时长（StrokeDescription 的 duration），用来算等待上限
     * @return true = 系统回报 onCompleted（真走完了）；false = 没发出去 / 被取消 / 超时没回音
     */
    public static boolean send(AccessibilityService svc, GestureDescription g, long durationMs) {
        if (svc == null || g == null) return false;

        // 主线程：只能发，不能等。等下去界面就卡死，MIUI 直接判 ANR。
        if (Looper.myLooper() == Looper.getMainLooper()) {
            final boolean sent = svc.dispatchGesture(g, null, null);
            if (sent) Log.w(TAG, "主线程发手势，结果无法确认 —— 调用方最好换到工作线程");
            return sent;
        }

        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] completed = { false };
        final boolean sent = svc.dispatchGesture(g,
                new AccessibilityService.GestureResultCallback() {
                    @Override public void onCompleted(GestureDescription d) {
                        completed[0] = true;
                        latch.countDown();
                    }
                    @Override public void onCancelled(GestureDescription d) {
                        latch.countDown();
                    }
                }, null);
        if (!sent) return false;

        try {
            if (!latch.await(durationMs + GRACE_MS, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "手势发出去了但一直没回调 —— 按没点成处理");
                return false;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        if (!completed[0]) Log.i(TAG, "手势被取消（onCancelled）—— 屏幕多半没动");
        return completed[0];
    }
}
