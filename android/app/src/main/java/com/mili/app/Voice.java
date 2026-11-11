package com.mili.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 老人的声纹门卫 —— 只听主人的话。
 *
 * 2026-11-07 菲尔特的需求：「初始引导页加入录制老人声纹，不识别外界杂音」。
 * 之前的问题：连续监听开着，电视声、旁人说话全被当成老人的话塞进智能体，
 * 米粒答非所问、「莫名其妙做了些事」。
 *
 * 方案（GitHub 调研 2026-11-07）：
 *   sherpa-onnx 的说话人验证（speaker verification），模型用 3D-Speaker
 *   ERES2Net-Base 中文版（3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k，
 *   ~28MB，192 维声纹，16kHz）。社区实测：embedding 只要 10~50ms，
 *   同一人相似度 0.6+，不同人（含电视/家人）0.3 以下，阈值 0.45~0.5 稳。
 *   关键是它和 Asr/Kws 共用同一套 sherpa-onnx 引擎 —— 不加新运行时。
 *
 * 用法：
 *   录制：vpEnrollStart() 进录制态，Asr 把每一句的整段 PCM 喂给 feedEnroll()，
 *         集满 3 段自动收工，声纹质心存 SharedPreferences；
 *   验证：Asr 断句后把这句 PCM 喂给 verify() —— 返回 false 的句子直接丢，
 *         米粒不接、不答、不抢锁。没录过声纹返回 null（放行，行为不变）。
 */
public class Voice {
    private static final String TAG = "MiliVoice";
    private static final String MODEL =
            "sv/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
    private static final String SP_NAME = "mili_voice";
    private static final String SP_KEY = "vp_centroid";

    /* 声纹相似度门槛。同一人实测 0.6~0.75，电视里的人声 0.2~0.35。
       0.45 往外留了一截余量：老人感冒了、说话含糊也不至于被锁在门外。 */
    public static final float TH = 0.45f;
    /* 不足 0.8 秒的句子算不出可靠声纹 —— 直接放行（碎字本来就被长度规则挡了） */
    public static final int MIN = (int) (16000 * 0.8);

    private static com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor ex;
    private static com.k2fsa.sherpa.onnx.SpeakerEmbeddingManager mg;
    private static float[] centroid;        // 录制中的累加质心
    private static float[] stored;          // 已保存的声纹
    public static boolean enrollArmed = false;
    public static int enrollTarget = 3;
    public static int enrollTakes = 0;
    public static float lastScore = -1f;
    /** 最近一句在线识别结果的声纹判定：null=没录过 / 太短 / 判不出（一律放行），
        TRUE=老人本人，FALSE=不是老人（本轮不许指挥办事）。
        由 DuoAsr.finish() 在把文字交给前端之前写好，前端 vpLastOwn() 读它。 */
    public static volatile Boolean lastOwn = null;

    /** 录制进度回 JS：MainActivity 在 vpEnrollStart 时挂上 */
    public interface TakeCb { void onTake(int n, int target, float score, boolean done); }
    public static TakeCb cb;

    private static synchronized boolean load(Context ctx) {
        if (ex != null) return true;
        try {
            com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig cfg =
                    new com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig(MODEL, 2, false, "cpu");
            ex = new com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor(ctx.getAssets(), cfg);
            mg = new com.k2fsa.sherpa.onnx.SpeakerEmbeddingManager(ex.dim());
            stored = loadStored(ctx);
            if (stored != null) mg.add("owner", stored);
            android.util.Log.i(TAG, "声纹引擎就绪 dim=" + ex.dim()
                    + " 已录=" + (stored != null));
            return true;
        } catch (Throwable t) {
            android.util.Log.e(TAG, "声纹引擎加载失败 " + t);
            ex = null;
            return false;
        }
    }

    public static boolean enrolled(Context ctx) {
        return loadStored(ctx) != null;
    }

    /** 录制态喂一整句 PCM（16k float）。返回这段和当前质心的相似度；集满返回它自己。 */
    public static synchronized float feedEnroll(Context ctx, float[] pcm, int sr) {
        /* 2026-11-10 菲尔特「点了录完没反馈」：以前这三种情况静默返回，
           界面永远停在「开始录声音」，老人不知道是没听见还是坏了。
           现在每一句都给一次进度（score=-1 表示这句没收着）。 */
        if (!enrollArmed || pcm == null || pcm.length < MIN) { notify(-1f); return -1f; }
        if (!load(ctx)) { notify(-1f); return -1f; }
        float[] v = emb(pcm, sr);
        if (v == null) { notify(-1f); return -1f; }
        float score;
        if (centroid == null) {
            centroid = v.clone();
            score = 1f;
        } else {
            score = cosine(v, centroid);
            for (int i = 0; i < centroid.length; i++) {
                centroid[i] = (centroid[i] * enrollTakes + v[i]) / (enrollTakes + 1);
            }
        }
        enrollTakes++;
        android.util.Log.i(TAG, "录制第 " + enrollTakes + " 段，相似度 "
                + String.format(java.util.Locale.US, "%.3f", score));
        if (enrollTakes >= enrollTarget) {
            stored = centroid.clone();
            mg.release();
            mg = new com.k2fsa.sherpa.onnx.SpeakerEmbeddingManager(ex.dim());
            mg.add("owner", stored);
            saveStored(ctx, stored);
            enrollArmed = false;
            android.util.Log.i(TAG, "声纹录制完成，已保存");
        }
        notify(score);
        return score;
    }

    /** null = 没录过声纹（放行）；true = 是老人；false = 不是，这句丢掉 */
    public static synchronized Boolean verify(Context ctx, float[] pcm, int sr) {
        float[] v = loadStored(ctx);
        if (v == null || pcm == null || pcm.length < MIN) return null;
        if (!load(ctx)) return null;
        float[] e = emb(pcm, sr);
        if (e == null) return null;
        lastScore = cosine(e, v);
        boolean own = lastScore >= TH;
        android.util.Log.i(TAG, "验证 " + String.format(java.util.Locale.US, "%.3f", lastScore)
                + (own ? " 是老人" : " 不是，丢"));
        return own;
    }

    /** 开新一轮录制：质心清零、计数归零（MainActivity 的 vpEnrollStart 调） */
    public static synchronized void centroidReset() {
        centroid = null;
        enrollTakes = 0;
    }

    public static synchronized void reset(Context ctx) {
        try { ctx.getSharedPreferences(SP_NAME, Context.MODE_PRIVATE).edit().clear().apply(); } catch (Throwable ignored) {}
        stored = null; centroid = null; enrollTakes = 0; enrollArmed = false;
        if (mg != null) { mg.release(); mg = null; }
        if (ex != null) { ex.release(); ex = null; }
    }

    private static float[] emb(float[] pcm, int sr) {
        try {
            com.k2fsa.sherpa.onnx.OnlineStream st = ex.createStream();
            st.acceptWaveform(pcm, sr);
            st.inputFinished();
            float[] v = ex.compute(st);
            st.release();
            return (v == null || v.length == 0) ? null : v;
        } catch (Throwable t) {
            android.util.Log.e(TAG, "算声纹失败 " + t);
            return null;
        }
    }

    private static float cosine(float[] a, float[] b) {
        if (a == null || b == null || a.length != b.length) return -1f;
        double dot = 0, na = 0, nb = 0;
        for (int i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        if (na == 0 || nb == 0) return -1f;
        return (float) (dot / (Math.sqrt(na) * Math.sqrt(nb)));
    }

    private static float[] loadStored(Context ctx) {
        try {
            String s = ctx.getSharedPreferences(SP_NAME, Context.MODE_PRIVATE).getString(SP_KEY, null);
            if (s == null || s.isEmpty()) return null;
            String[] ps = s.split(",");
            float[] v = new float[ps.length];
            for (int i = 0; i < ps.length; i++) v[i] = Float.parseFloat(ps[i]);
            return v;
        } catch (Throwable t) { return null; }
    }

    private static void saveStored(Context ctx, float[] v) {
        try {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < v.length; i++) {
                if (i > 0) sb.append(',');
                sb.append(v[i]);
            }
            ctx.getSharedPreferences(SP_NAME, Context.MODE_PRIVATE)
                    .edit().putString(SP_KEY, sb.toString()).apply();
        } catch (Throwable ignored) {}
    }

    private static void notify(float score) {
        final TakeCb c = cb;
        if (c == null) return;
        final int n = enrollTakes, tgt = enrollTarget;
        final boolean done = !enrollArmed && enrollTakes >= enrollTarget;
        try { c.onTake(n, tgt, score, done); } catch (Throwable ignored) {}
    }
}
