package com.mili.app;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotter;
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotterResult;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

/**
 * 离线唤醒：听到「米粒」就答应，不联网、不上传。
 *
 * 为什么不用安卓自带的 SpeechRecognizer：
 * 那玩意儿是「云端识别 + 一轮就断」，在 MIUI 上后台被限到 code=9（权限不足），
 * 而且每次都要连一次服务器，等三五秒，还得自己写重连。老人家喊一句等三秒，
 * 喊两次就放弃了。
 * sherpa-onnx 的关键词检测是本地小模型（3.3M 参数），10 毫秒出一帧，喊完就有反应。
 *
 * 关键词用拼音拼：模型词表是「声母 + 带调韵母」，所以「米莉」「米力」这些同音字
 * 天然都能唤醒 —— 不用给每个人名开花名册。
 *
 * 两句指令（挂断电话 / 声音大点）只在通话中打开，不然电视里说一句「挂断」就把电话挂了。
 */
public class Kws implements Runnable {

    private static final String TAG = "MiliKws";

    private static final String DIR = "kws/";
    private static final String ENC = DIR + "encoder-epoch-12-avg-2-chunk-16-left-64.onnx";
    private static final String DEC = DIR + "decoder-epoch-12-avg-2-chunk-16-left-64.onnx";
    private static final String JOI = DIR + "joiner-epoch-12-avg-2-chunk-16-left-64.onnx";
    private static final String TOK = DIR + "tokens.txt";

    private static final int SR = 16000;
    private static final int CHUNK = 3200;          // 0.2 秒一帧，够快但不烧 CPU

    /* 关键词用拼音拼，写在 assets/kws/keywords.txt。
       五句一直挂着：三句是叫醒，两句是通话指令。
       为什么指令也常挂 —— 换关键词要重建解码流，通话中途重建会漏掉开头几个字；
       反正「挂断电话」这四个字平时没人说，认出来了再由上层判断在不在通话里。 */
    private static final String KW_ALL =
            "m ǐ l ì @米粒\n" +
            "x iǎo m ǐ l ì @小米粒\n" +
            "m ǐ l ì m ǐ l ì @米粒米粒\n" +
            "g uà d uàn d iàn h uà @挂断电话\n" +
            "sh ēng y īn d à d iǎn @声音大点\n" +
            "l ǐng h óng b āo @领红包\n";

    public interface OnWord { void onWord(String w); }

    private final Context ctx;
    private final OnWord cb;

    private KeywordSpotter ks;
    private OnlineStream st;
    private AudioRecord ar;
    private android.media.audiofx.AcousticEchoCanceler aec;
    private volatile boolean run = false;
    private volatile boolean ready = false;
    private volatile boolean callMode = false;
    private volatile boolean needNewStream = false;
    /** 用户要点「我有话跟米粒说」时，得先把麦克风让出去 —— 一个麦克风不能两家同时开 */
    private volatile boolean paused = false;
    /** 上一帧是否处在「米粒在说话」里 —— 用来判断边沿，只在说完那一刻重置一次流 */
    private volatile boolean wasSpeaking = false;
    private Thread th;

    public Kws(Context c, OnWord cb) {
        this.ctx = c.getApplicationContext();
        this.cb = cb;
    }

    /** 模型起来了没有。起来之前喊是没反应的，Service 拿它决定要不要回退旧方案。 */
    public boolean isReady() { return ready; }

    /** 通话状态记一下。关键词一直五句都认，判断交给上层（MilService）。 */
    public void setCallMode(boolean on) { callMode = on; }

    /** 让出麦克风（用户要说话了）。返回后最多 200 毫秒内录音就停。 */
    public void pause() {
        paused = true;
        /* 同步把 AudioRecord 交出去。以前只在主循环下一轮（150ms）才释放，
           在线识别常常抢在这之前开麦，MIUI PAL 直接报
           VOICE_RECOGNITION "concurrency not allowed" —— 两边都读不到音。 */
        releaseMicNow();
        f("让麦克风");
    }

    /** 只交录音通道，不卸模型；pause/resume 之间来回切不用重新加载唤醒模型。 */
    private synchronized void releaseMicNow() {
        if (ar != null) {
            try { ar.stop(); } catch (Exception ignored) {}
            try { ar.release(); } catch (Exception ignored) {}
            ar = null;
        }
    }

    public void resume() {
        paused = false;
        f("收回麦克风");
    }

    /** 麦克风现在还让着别人吗。服务那边的看门狗靠它兜底 —— 见 MilService.callTick。 */
    public boolean isPaused() { return paused; }

    public synchronized void start() {
        if (run) return;
        run = true;
        th = new Thread(this, "mili-kws");
        th.start();
    }

    public synchronized void stop() {
        run = false;
        release();
        if (th != null) { try { th.interrupt(); } catch (Exception ignored) {} th = null; }
    }

    /* ================= 主循环 ================= */

    @Override public void run() {
        f("线程启动");
        if (!load()) {
            f("模型没起来，退出唤醒");
            run = false;
            return;
        }
        ready = true;
        f("离线唤醒就绪");

        short[] pcm = new short[CHUNK];
        float[] f = new float[CHUNK];

        while (run) {
            if (paused) {
                releaseMicNow();
                sleep(150);
                continue;
            }
            if (ar == null) {
                ar = openMic();
                if (ar == null) { sleep(2000); continue; }
            }
            if (st == null || needNewStream) {
                needNewStream = false;
                newStream();
                if (st == null) { sleep(1000); continue; }
            }

            /* 米粒自己在说话：读掉但不喂模型，否则会把自己念的话当成用户说的。
               2026-11-06 晚修：原来这里每读一帧就 newStream() 一次 ——
               米粒念一句话 3 秒 = 30 次重建，KWS 永远处在「刚建流」的冷启动态，
               这段时间老人喊「米粒」必聋。日志实证 16:33:25.804 / 26.004 / 26.201
               200 毫秒内连着三条「流已建」。
               现在只在「说完」那一帧重建一次：说话期间什么都别做。 */
            if (MicGate.isSpeaking()) {
                try { ar.read(pcm, 0, CHUNK); } catch (Exception ignored) {}
                wasSpeaking = true;
                continue;
            }
            if (wasSpeaking) {
                wasSpeaking = false;
                newStream();
                f("米粒说完了，唤醒流重置一次");
            }

            int n;
            try {
                n = ar.read(pcm, 0, CHUNK);
            } catch (Exception e) {
                Log.i(TAG, "读麦克风出错 " + e);
                n = -1;
            }
            if (n <= 0) {
                /* 通话时麦克风被系统占着，这里会一直读不到。等一会儿再试，
                   不退出循环 —— 挂了电话就自动接上了。 */
                sleep(500);
                continue;
            }

            for (int i = 0; i < n; i++) f[i] = pcm[i] / 32768.0f;
            try {
                st.acceptWaveform(f, SR);
                while (ks.isReady(st)) ks.decode(st);
                KeywordSpotterResult r = ks.getResult(st);
                String kw = r == null ? "" : r.getKeyword();
                if (kw != null && kw.length() > 0) {
                    f("听到 " + kw);
                    ks.reset(st);
                    if (cb != null) cb.onWord(kw);
                }
            } catch (Throwable t) {
                f("解码出错，重建流 " + t);
                needNewStream = true;
                sleep(300);
            }
        }
        release();
    }

    /* ================= 引擎 ================= */

    private boolean load() {
        try {
            f("开始加载模型");
            FeatureConfig feat = new FeatureConfig();
            feat.setSampleRate(SR);
            feat.setFeatureDim(80);

            OnlineTransducerModelConfig tr = new OnlineTransducerModelConfig();
            tr.setEncoder(ENC);
            tr.setDecoder(DEC);
            tr.setJoiner(JOI);

            OnlineModelConfig mc = new OnlineModelConfig();
            mc.setTransducer(tr);
            mc.setTokens(TOK);
            mc.setNumThreads(2);
            mc.setProvider("cpu");
            mc.setModelType("zipformer2");

            KeywordSpotterConfig cfg = new KeywordSpotterConfig();
            cfg.setFeatConfig(feat);
            cfg.setModelConfig(mc);
            cfg.setMaxActivePaths(4);
            cfg.setKeywordsFile("kws/keywords.txt");   // 建引擎时必须能读到真文件，空串会让底层直接 exit(255)
            cfg.setKeywordsScore(2.0f);     // 给足分，宁可漏一次也别瞎应
            /* 0.25 太严：真人隔一米说话（不是贴着手机念）经常差一点点过不去，
               表现就是「叫它没反应」。降到 0.18，宁可偶尔多应一次。 */
            cfg.setKeywordsThreshold(0.18f);
            cfg.setNumTrailingBlanks(2);

            ks = new KeywordSpotter(ctx.getAssets(), cfg);
            f("模型加载完成");
            return ks != null;
        } catch (Throwable t) {
            f("加载失败 " + t);
            ks = null;
            return false;
        }
    }

    private void newStream() {
        try {
            if (st != null) { try { st.release(); } catch (Throwable ignored) {} st = null; }
            st = ks.createStream(KW_ALL);
            f("流已建 五句关键词");
        } catch (Throwable t) {
            Log.e(TAG, "建流失败 " + t);
            st = null;
        }
    }

    private AudioRecord openMic() {
        try {
            int min = AudioRecord.getMinBufferSize(SR,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int buf = Math.max(min * 2, CHUNK * 4);

            /* 2026-11-06 晚：优先用普通 MIC，不再优先 VOICE_RECOGNITION。
               MIUI 的 VOICE_RECOGNITION 音源不做 AGC，还带单声道降噪，
               老人站两三米外喊「米粒」，进来只剩 0.0001 量级的电平 ——
               模型听不见，表现就是「更多时候唤不醒」。MIC 有系统 AGC，远场好得多。 */
            AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.MIC,
                    SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                r.release();
                r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
                if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                    r.release();
                    f("麦克风打不开");
                    return null;
                }
            }
            /* 回声消除：外放时喇叭的声音会进麦克风，硬件 AEC 能先砍掉一大半。
               软件闸（MicGate）负责剩下的。 */
            try {
                if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                    aec = android.media.audiofx.AcousticEchoCanceler.create(r.getAudioSessionId());
                    if (aec != null) { aec.setEnabled(true); }
                }
            } catch (Throwable ignored) {}
            r.startRecording();
            f("麦克风已开 " + SR + "Hz 单声道");
            return r;
        } catch (Throwable t) {
            Log.e(TAG, "开麦克风失败 " + t);
            return null;
        }
    }

    private void release() {
        ready = false;
        if (ar != null) {
            try { ar.stop(); } catch (Exception ignored) {}
            try { ar.release(); } catch (Exception ignored) {}
            ar = null;
        }
        if (st != null) { try { st.release(); } catch (Throwable ignored) {} st = null; }
        if (ks != null) { try { ks.release(); } catch (Throwable ignored) {} ks = null; }
    }

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }

    /* 日志同时写一份到文件。
       logcat 在这台机器上会被系统自己的喇叭刷掉（MIUI 语音服务一秒几十条），
       现场排查只能靠文件。路径：/sdcard/Android/data/com.mili.app/files/kws.log */
    private void f(String s) {
        Log.i(TAG, s);
        try {
            java.io.File f = new java.io.File(ctx.getExternalFilesDir(null), "kws.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.CHINA)
                    .format(new java.util.Date()) + " " + s + "\n");
            w.close();
        } catch (Throwable ignored) {}
    }
}
