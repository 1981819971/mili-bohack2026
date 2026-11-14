package com.mili.app;

import java.util.ArrayList;
import java.util.List;

/** 搜索直达后只做选片、全屏；界面就绪就继续，每次最多发一个手势。 */
final class DouyinPlayback {
    static final String PACKAGE = "com.ss.android.ugc.aweme";
    static final long TIMEOUT_MS = 14000;
    private static final long POLL_MS = 350;
    // 无法读到控件时沿用原流程的等待时间，不靠提前盲点提速。
    private static final long RESULT_FALLBACK_MS = 5200;
    private static final long FULLSCREEN_FALLBACK_MS = 8200;

    interface Host {
        long now();
        void later(Runnable action, long delayMs);
        boolean openSearch(String keyword);
        String window();
        boolean fullscreen();
        boolean tapResult(boolean coordinateFallback);
        boolean tapFullscreen(int attempt);
        void complete(String requestId, boolean ok, boolean fullscreen, String detail);
    }

    private final Host host;
    private final List<String> requests = new ArrayList<>();
    private String keyword = "", lastWindow = "";
    private long startedAt, windowAt, playerAt, lastTapAt;
    private int generation, fullscreenAttempts;
    private boolean running, sawApp, resultTapped, playerSeen, fullscreenTapped, resultFallbackTried;

    DouyinPlayback(Host host) { this.host = host; }

    void start(String query, String requestId) {
        String title = query == null ? "" : query.trim();
        if (title.isEmpty()) {
            host.complete(requestId, false, false, "您想看什么？片名说给我听。");
            return;
        }
        if (running) {
            if (keyword.equals(title)) requests.add(requestId);
            else host.complete(requestId, false, false, "正在打开上一部视频，等它打开再换吧。");
            return;
        }
        running = true;
        keyword = title;
        requests.clear();
        requests.add(requestId);
        startedAt = windowAt = host.now();
        playerAt = lastTapAt = 0;
        lastWindow = "";
        sawApp = resultTapped = playerSeen = fullscreenTapped = resultFallbackTried = false;
        fullscreenAttempts = 0;
        int ticket = ++generation;
        if (!host.openSearch(title)) {
            finish(false, false, "抖音没打开，您看看有没有装好。");
            return;
        }
        host.later(() -> tick(ticket), 200);
    }

    void cancel() {
        if (running) finish(false, false, "这次找视频已停止。");
    }

    private void tick(int ticket) {
        if (!running || generation != ticket) return;
        long now = host.now();
        String window = host.window();
        if (window == null) window = "";
        if (!window.equals(lastWindow)) { lastWindow = window; windowAt = now; }
        boolean inApp = window.startsWith(PACKAGE + "/");
        boolean inPlayer = inApp && (window.contains("Detail") || window.contains("Landscape"));
        if (inApp) sawApp = true;

        // 只依据当前窗口；历史横屏页和其它 App 的横屏都不能认作完成。
        if (inApp && resultTapped) {
            if (host.fullscreen()) {
                finish(true, true, "「" + keyword + "」的视频页面已全屏打开。");
                return;
            }
            if (inPlayer) {
                if (!playerSeen) { playerSeen = true; playerAt = now; }
            }
        }
        if (sawApp && !window.isEmpty() && !inApp) {
            finish(false, false, "您切换了页面，我先停下，免得点错。");
            return;
        }
        if (playerSeen && inApp && window.contains("Search")) {
            finish(false, false, "您回到了搜索页，我先停下，免得重复点。");
            return;
        }
        if (now - startedAt >= TIMEOUT_MS) {
            finish(inPlayer && playerSeen, false, inPlayer && playerSeen
                    ? "视频页面打开了，暂时没切到全屏。"
                    : "还没确认视频打开，我先停下，您可以点一下搜索结果。");
            return;
        }
        if (inApp && !resultTapped && window.contains("Search")
                && now - windowAt >= 400) {
            // 有可读结果就直接点；空壳页面等待原有时长后仅兜底一次。
            boolean tapped = host.tapResult(false);
            if (!tapped && !resultFallbackTried && now - startedAt >= RESULT_FALLBACK_MS) {
                resultFallbackTried = true;
                tapped = host.tapResult(true);
                if (!tapped) {
                    finish(false, false, "没点开搜索结果，我先停下，您可以自己点一下。");
                    return;
                }
            }
            if (tapped) { resultTapped = true; lastTapAt = now; }
        } else if (inPlayer && playerSeen && !fullscreenTapped && now - lastTapAt >= 1200) {
            if (fullscreenAttempts == 0 && host.tapFullscreen(0)) {
                fullscreenTapped = true; // 文字点中后只验证，不继续点画面。
            } else if (now - startedAt >= FULLSCREEN_FALLBACK_MS
                    && now - playerAt >= 1200 && fullscreenAttempts < 2) {
                fullscreenAttempts++;
                host.tapFullscreen(fullscreenAttempts);
                lastTapAt = now;
            }
        }
        host.later(() -> tick(ticket), POLL_MS);
    }

    private void finish(boolean ok, boolean fullscreen, String detail) {
        running = false;
        generation++;
        List<String> completed = new ArrayList<>(requests);
        requests.clear();
        for (String id : completed) host.complete(id, ok, fullscreen, detail);
    }
}
