package com.mili.app;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** 所有操作共用的被动提示。不接收触摸，不改变焦点或原有点击流程。 */
final class OperationNotice {
    private static final long TIMEOUT_MS = 45000;
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static final AtomicLong IDS = new AtomicLong();
    // 只在主线程读写；每个执行者收回自己的提示，避免旧任务收掉新任务。
    private static final Map<Long, Entry> ACTIVE = new LinkedHashMap<>();
    private static WindowManager manager;
    private static LinearLayout banner;
    private static TextView titleView;

    private OperationNotice() {}

    static long begin(String title) {
        long id = IDS.incrementAndGet();
        UI.post(() -> {
            Entry entry = new Entry(title, () -> finish(id));
            ACTIVE.put(id, entry);
            UI.postDelayed(entry.expire, TIMEOUT_MS);
            render();
        });
        return id;
    }

    static void end(long id) {
        if (id != 0) UI.post(() -> finish(id));
    }

    static void clear() {
        UI.post(() -> {
            for (Entry entry : ACTIVE.values()) UI.removeCallbacks(entry.expire);
            ACTIVE.clear();
            hide();
        });
    }

    private static void finish(long id) {
        Entry entry = ACTIVE.remove(id);
        if (entry == null) return;
        UI.removeCallbacks(entry.expire);
        render();
    }

    private static void render() {
        Entry latest = null;
        for (Entry entry : ACTIVE.values()) latest = entry;
        if (latest == null) { hide(); return; }
        try {
            if (banner == null) show();
            if (titleView != null) titleView.setText(latest.title);
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
        banner.setPadding(dp(context, 20), dp(context, 16), dp(context, 20), dp(context, 16));
        banner.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        // 与 design-tokens.css 的白卡、浅紫底、紫色点缀保持一致；只让背景半透明。
        GradientDrawable background = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] { 0xD9FFFFFF, 0xCCF4F5FF });
        background.setStroke(dp(context, 1), 0x80D8D8EE);
        background.setCornerRadius(dp(context, 20));
        banner.setBackground(background);
        banner.setElevation(dp(context, 4));
        TextView brand = text(context, 14);
        brand.setText("米粒 · 正在帮您");
        brand.setTextColor(0xFF4A3CD8);
        banner.addView(brand);
        titleView = text(context, 22);
        titleView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        titleView.setMaxLines(2);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.setMargins(0, dp(context, 8), 0, dp(context, 8));
        banner.addView(titleView, titleParams);
        TextView reminder = text(context, 18);
        reminder.setTextColor(0xFF3E4260);
        reminder.setText("请先别碰屏幕，稍等一下");
        banner.addView(reminder);
        android.util.DisplayMetrics display = context.getResources().getDisplayMetrics();
        int width = Math.min(dp(context, 336), display.widthPixels - dp(context, 48));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE, PixelFormat.TRANSLUCENT);
        // 居中后下移约 12% 屏高，避开顶部搜索栏，也不贴底部输入区。
        params.gravity = Gravity.CENTER;
        params.y = Math.round(display.heightPixels * 0.12f);
        manager.addView(banner, params);
    }

    private static TextView text(Context context, int size) {
        TextView text = new TextView(context);
        text.setTextColor(0xFF1B1D2E);
        text.setTextSize(size);
        text.setGravity(Gravity.CENTER);
        return text;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static void hide() {
        if (banner != null && manager != null) {
            try { manager.removeView(banner); } catch (Exception ignored) {}
        }
        banner = null;
        titleView = null;
        manager = null;
    }

    private static final class Entry {
        final String title;
        final Runnable expire;

        Entry(String title, Runnable expire) {
            this.title = title == null || title.trim().isEmpty() ? "米粒正在帮您操作" : title;
            this.expire = expire;
        }
    }
}
