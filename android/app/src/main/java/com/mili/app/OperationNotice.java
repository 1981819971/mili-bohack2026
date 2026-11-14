package com.mili.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** 所有操作共用的被动提示。不接收触摸，不改变焦点或原有点击流程。 */
final class OperationNotice {
    private static final long TIMEOUT_MS = 45000;
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static final AtomicLong IDS = new AtomicLong();
    // 只在主线程读写；每个执行者收回自己的提示，避免旧任务收掉新任务。
    private static final Map<Long, Runnable> ACTIVE = new HashMap<>();
    private static WindowManager manager;
    private static LinearLayout banner;

    private OperationNotice() {}

    // 保留参数以兼容现有调用方；提示不存储或显示具体任务。
    static long begin(String ignoredTitle) {
        long id = IDS.incrementAndGet();
        UI.post(() -> {
            Runnable expire = () -> finish(id);
            ACTIVE.put(id, expire);
            UI.postDelayed(expire, TIMEOUT_MS);
            render();
        });
        return id;
    }

    static void end(long id) {
        if (id != 0) UI.post(() -> finish(id));
    }

    static void clear() {
        UI.post(() -> {
            for (Runnable expire : ACTIVE.values()) UI.removeCallbacks(expire);
            ACTIVE.clear();
            hide();
        });
    }

    private static void finish(long id) {
        Runnable expire = ACTIVE.remove(id);
        if (expire == null) return;
        UI.removeCallbacks(expire);
        render();
    }

    private static void render() {
        if (ACTIVE.isEmpty()) { hide(); return; }
        try {
            if (banner == null) show();
        } catch (Exception e) {
            hide();
            Log.i("MiliOperation", "操作提示暂不可显示：" + e.getClass().getSimpleName());
        }
    }

    private static void show() {
        MiliAccessibilityService service = MiliAccessibilityService.self();
        if (service == null) return;
        Context context = service;
        manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        banner = new LinearLayout(context);
        banner.setOrientation(LinearLayout.VERTICAL);
        banner.setGravity(Gravity.CENTER);
        banner.setPadding(dp(context, 32), dp(context, 48), dp(context, 32), dp(context, 48));
        banner.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        banner.setBackground(featheredBackground());
        TextView status = text(context, 32);
        status.setText("正在操作");
        banner.addView(status);
        TextView reminder = text(context, 32);
        reminder.setText("别动屏幕");
        LinearLayout.LayoutParams reminderParams = new LinearLayout.LayoutParams(-1, -2);
        reminderParams.topMargin = dp(context, 8);
        banner.addView(reminder, reminderParams);
        android.util.DisplayMetrics display = context.getResources().getDisplayMetrics();
        int width = Math.min(dp(context, 336), display.widthPixels - dp(context, 48));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE, PixelFormat.TRANSLUCENT);
        // 中心从屏幕中点上移 1/6 屏高，落在从上往下约 1/3 的位置。
        params.gravity = Gravity.CENTER;
        params.y = -Math.round(display.heightPixels / 6f);
        manager.addView(banner, params);
    }

    private static TextView text(Context context, int size) {
        TextView text = new TextView(context);
        text.setTextColor(0xFFFFFFFF);
        text.setTextSize(size);
        text.setGravity(Gravity.CENTER);
        text.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return text;
    }

    /** 椭圆形紫色渐变：文字区域保留深色，四周逐渐透明，没有描边或阴影硬边。 */
    private static Drawable featheredBackground() {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new RadialGradient(0, 0, 1,
                new int[] { 0xEB4A3CD8, 0xEB4A3CD8, 0x995B4DF0, 0x005B4DF0 },
                new float[] { 0, 0.55f, 0.8f, 1 }, Shader.TileMode.CLAMP));
        return new Drawable() {
            @Override public void draw(Canvas canvas) {
                if (getBounds().isEmpty()) return;
                int saved = canvas.save();
                canvas.translate(getBounds().exactCenterX(), getBounds().exactCenterY());
                canvas.scale(getBounds().width() / 2f, getBounds().height() / 2f);
                canvas.drawCircle(0, 0, 1, paint);
                canvas.restoreToCount(saved);
            }

            @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
            @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static void hide() {
        if (banner != null && manager != null) {
            try { manager.removeView(banner); } catch (Exception ignored) {}
        }
        banner = null;
        manager = null;
    }
}
