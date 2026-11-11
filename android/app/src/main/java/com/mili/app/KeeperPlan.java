package com.mili.app;

/**
 * 自愈的决策部分，和 Android 隔开 —— 逻辑照抄 dsh-Go 的 {@code KeeperPlan}（AGPL-3.0），
 * 去掉 Kotlin 语法，行为一一对应。
 *
 * <p>ENABLED_ACCESSIBILITY_SERVICES 的格式是 {@code pkg/cls} 或 {@code pkg/.Short}，
 * 多个用 {@code :} 连接。这里只增删我们那一条，别人的原样保留。
 */
public final class KeeperPlan {

    public enum Step { NONE, ADD, REBIND }

    /** 抽出来是为了测试时喂假时间。 */
    public interface Clock { long now(); }

    private static final long NEVER = Long.MIN_VALUE;

    /** 在名单里但一直没绑上，超过这么久就是系统的「无法运行」态，得手动重绑。 */
    public static final long UNBOUND_MS = 10_000L;
    /** 稳定绑住这么久，说明上次掉线不是反复争夺，退避可以清零。 */
    public static final long STABLE_MS = 60_000L;

    private static final long FIRST_WAIT_MS = 5_000L;
    private static final long MAX_WAIT_MS = 10 * 60_000L;

    private final String pkg;
    private final String cls;
    private final String me;

    private long unboundSince = NEVER;
    private long heldSince = NEVER;
    private int writes = 0;
    private long nextAt = 0L;

    public KeeperPlan(String pkg, String cls) {
        this.pkg = pkg;
        this.cls = cls;
        this.me = pkg + "/" + cls;
    }

    /**
     * 现在该做什么。
     *
     * @param on        功能是否开着
     * @param granted   是否持有 WRITE_SECURE_SETTINGS
     * @param list      读到的 ENABLED_ACCESSIBILITY_SERVICES 原文（可能为 null）
     * @param connected 我们的服务是否已绑定
     * @param now       当前时间（毫秒，任意基准，单调即可）
     */
    public Step next(boolean on, boolean granted, String list, boolean connected, long now) {
        if (!on) {
            unboundSince = NEVER;
            heldSince = NEVER;
            writes = 0;
            nextAt = 0L;
            return Step.NONE;
        }
        if (connected) {
            unboundSince = NEVER;
            if (heldSince == NEVER) heldSince = now;
            if (now - heldSince >= STABLE_MS) {
                writes = 0;
                nextAt = 0L;
            }
            return Step.NONE;
        }
        heldSince = NEVER;
        if (!granted) {
            unboundSince = NEVER;
            return Step.NONE;
        }

        final Step step;
        if (!listed(list)) {
            step = Step.ADD;
        } else {
            if (unboundSince == NEVER) unboundSince = now;
            // 刚写进去那一会儿系统还在绑定，别急着判定失败。
            if (now - unboundSince < UNBOUND_MS) return Step.NONE;
            step = Step.REBIND;
        }

        if (now < nextAt) return Step.NONE;
        writes = Math.min(writes + 1, 8);
        nextAt = now + backoff(writes);
        unboundSince = NEVER;
        return step;
    }

    public boolean listed(String list) {
        if (list == null || list.isEmpty()) return false;
        for (String e : list.split(":")) {
            if (ours(e)) return true;
        }
        return false;
    }

    /** 名单加上我们（已有则原样返回）。 */
    public String withMe(String list) {
        if (listed(list)) return list == null ? "" : list;
        if (list == null || list.isEmpty()) return me;
        return list + ":" + me;
    }

    /** 名单去掉我们。 */
    public String withoutMe(String list) {
        if (list == null || list.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (String e : list.split(":")) {
            if (ours(e)) continue;
            if (sb.length() > 0) sb.append(':');
            sb.append(e);
        }
        return sb.toString();
    }

    private boolean ours(String entry) {
        if (entry == null) return false;
        final String e = entry.trim();
        final int slash = e.indexOf('/');
        if (slash <= 0) return false;
        if (!e.substring(0, slash).equals(pkg)) return false;
        final String c = e.substring(slash + 1);
        return c.equals(cls) || (c.startsWith(".") && (pkg + c).equals(cls));
    }

    /** 连续第 n 次写入之后等多久：5s, 10s, 20s … 封顶 10 分钟。 */
    public static long backoff(int n) {
        final int k = Math.max(0, Math.min(n - 1, 7));
        return Math.min(FIRST_WAIT_MS << k, MAX_WAIT_MS);
    }
}
