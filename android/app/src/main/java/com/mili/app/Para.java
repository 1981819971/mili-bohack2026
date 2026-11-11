package com.mili.app;

import android.content.Context;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;

/**
 * 第二次识别：说完了，用更准的模型把整句话重听一遍。
 *
 * 为什么要两遍：
 * 边听边出字用的是 14M 的流式小模型，快，但中文错字、少字、多字很常见
 * —— 老人骂「太太太太差」就是它。真正拿去办事的那句，得换 82MB 的 Paraformer
 * 把整段音频重新解一遍：同一段声音，准确率高一大截，代价只是多说 0.5 秒。
 *
 * 分工：
 *   流式模型 → 边听边显示，给「它在听我说话」的实时反馈
 *   Paraformer → 说完之后算最终结果，拿这个去执行
 */
public class Para {

    private static final String TAG = "MiliPara";
    private static final String DIR = "asr2/";
    private static final String MODEL = DIR + "model.int8.onnx";
    private static final String TOK = DIR + "tokens.txt";

    private static OfflineRecognizer rec;
    private static boolean tried = false;

    /** 懒加载：第一次要用才读 82MB，别拖慢启动 */
    public static synchronized boolean ready(Context ctx) {
        if (rec != null) return true;
        if (tried) return false;
        tried = true;
        try {
            long t0 = System.currentTimeMillis();
            FeatureConfig feat = new FeatureConfig();
            feat.setSampleRate(16000);
            feat.setFeatureDim(80);

            OfflineParaformerModelConfig pm = new OfflineParaformerModelConfig();
            pm.setModel(MODEL);

            OfflineModelConfig mc = new OfflineModelConfig();
            mc.setParaformer(pm);
            mc.setTokens(TOK);
            mc.setNumThreads(2);
            mc.setProvider("cpu");
            mc.setModelType("paraformer");
            mc.setDebug(false);

            OfflineRecognizerConfig cfg = new OfflineRecognizerConfig();
            cfg.setFeatConfig(feat);
            cfg.setModelConfig(mc);
            cfg.setDecodingMethod("greedy_search");

            rec = new OfflineRecognizer(ctx.getAssets(), cfg);
            Log.i(TAG, "准确模型就绪 " + (System.currentTimeMillis() - t0) + "ms");
            return rec != null;
        } catch (Throwable t) {
            Log.e(TAG, "准确模型加载失败 " + t);
            rec = null;
            return false;
        }
    }

    /** 整段音频直接解码。失败返回空串，调用方自己退回流式结果。 */
    public static String decode(float[] pcm, int sampleRate) {
        if (rec == null || pcm == null || pcm.length == 0) return "";
        OfflineStream st = null;
        try {
            st = rec.createStream();
            st.acceptWaveform(pcm, sampleRate);
            rec.decode(st);
            OfflineRecognizerResult r = rec.getResult(st);
            String t = r == null ? "" : r.getText();
            return t == null ? "" : t.replace("▁", " ").replaceAll("\\s+", " ").trim();
        } catch (Throwable t) {
            Log.e(TAG, "解码失败 " + t);
            return "";
        } finally {
            if (st != null) { try { st.release(); } catch (Throwable ignored) {} }
        }
    }
}
