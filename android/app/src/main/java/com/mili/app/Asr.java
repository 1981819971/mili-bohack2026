package com.mili.app;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import com.k2fsa.sherpa.onnx.EndpointConfig;
import com.k2fsa.sherpa.onnx.EndpointRule;
import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizerResult;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

/**
 * 「我有话跟米粒说」的耳朵：本地中文识别，边说边出字。
 *
 * 为什么不用系统那套 SpeechRecognizer：
 * 这台机器上它一直不工作。日志摆着 —— 小米的语音服务起监听时回一句
 *   "startListening received from a caller without permission RECORD_AUDIO"
 * 明明我们的录音权限是 granted、appops 也是 allow，它就是不放行（MIUI 的权限判定另有一套）。
 * 表现就是：点按钮、说话、一点反应都没有，连错误回调都吞了。
 * 与其跟小米的权限规则斗，不如把这 25MB 模型塞进 APK：不联网、不看权限脸色、说半句就出半句。
 *
 * 和 Kws（唤醒）共用同一套 sherpa-onnx 引擎，只是换了个模型。
 */
public class Asr implements Runnable {

    private static final String TAG = "MiliAsr";

    private static final String DIR = "asr/";
    private static final String ENC = DIR + "encoder-epoch-99-avg-1.int8.onnx";
    private static final String DEC = DIR + "decoder-epoch-99-avg-1.int8.onnx";
    private static final String JOI = DIR + "joiner-epoch-99-avg-1.int8.onnx";
    private static final String TOK = DIR + "tokens.txt";

    private static final int SR = 16000;
    private static final int CHUNK = 1600;          // 0.1 秒一帧，边说边出字

    private static final long MAX_MS = 20000;       // 一次最多听 20 秒
    private static final long IDLE_MS = 8000;       // 一直没声就放弃
    private static final long CV_IDLE_MS = 60000;   // 连续模式下没声多久才收工
    /* 2026-11-06 晚：从 0.0025 降到 0.0015。
       真机日志实测：老人正常说话，rms 落在 0.0002~0.0017，
       老门槛 0.0025 几乎只在大声时过线 → lastVoice 不刷新 → 静音计时一路跑，
       句子被提前收掉。降下来让「有人在说话」这件事能被确认。 */
    private static final float VOICE_RMS = 0.0015f;
    /* 先前仅凭 MIC 电平判插话，喇叭回声也会满足阈值，导致播报被自身掐断。
       阈值和持续时间不是可靠的人声来源判别，暂不据此触发自动打断。 */
    /* 外放回声仅靠音量和持续时间无法与真人说话可靠区分。
       暂停自动插话，避免无人在说话时掐断播报；播报完毕仍继续听下一句。
       待接入可靠的回声消除/语音判别后再恢复自动插话。 */
    private static final boolean AUTO_BARGE_ENABLED = false;
    private static final float BARGE_RMS = 0.075f;
    private static final int BARGE_FRAMES = 18;
    private static final long BARGE_GRACE_MS = 1200;

    /* ============ 断句（2026-11-06 晚重写）============
       菲尔特：「我还没说完话就打断了」。
       原来断句交给 sherpa 的端点规则（r1=1.6 / r2=1.2）。
       问题是它在「有解码结果后静音 1.2 秒」就判结束 ——
       老人说「我……血压……有点高」，想词的那一下正好 1.2 秒，句子当场被切。
       日志实证：48.126 停到 48.405（0.28 秒）就继续吐字，
       却被引擎判成「一句话说完：一下光飞步劝钱家」，连乱码都交了。
       现在不信引擎，自己按两件事判：
         ① 真实人声静音满 1.8 秒（2 秒太慢，老人等不及；1.2 太急）
         ② 至少 2 个字（单个「嗯」「啊」不是一句话）
       并且「模型出字」也算人声 —— 它在往外吐字，就说明人还在说。 */
    /* 1.6 秒：比原来引擎的 1.2 宽容三成，老人想词、换气都够；
       再往上（1.8/2.0）听感就开始"说完还得愣一下"，菲尔特已经两次说慢。 */
    private static final long END_SILENCE_MS = 1600;
    private static final int END_MIN_CHARS = 2;

    public interface OnText { void onText(String text, boolean isFinal); }

    private final Context ctx;
    private final OnText cb;

    private volatile boolean run = false;
    private android.media.audiofx.AcousticEchoCanceler aec;
    private volatile boolean stopAsked = false;
    private Thread th;

    private static OnlineRecognizer cached;        // 首次加载 2 秒，之后复用
    private static boolean cacheTried = false;

    /* ==================== 连续对话（2026-11-06）====================
       菲尔特：「怎么顺畅连贯的语音聊天」。
       不连贯的根不在识别质量，在结构：一次 start() 只收一句话，说完就 release
       麦克风，老人要再说一句得再按一次。每句话之间隔着一个按钮，这就聊不起来。

       现在 cvMode 打开时：一句话说完不退出，交出去、重置、接着听。
       另外 TTS 播报期间麦克风照样读，但这段音频不喂模型（喂了就是自问自答），
       只算音量 —— 老人一开口就把米粒掐掉。这叫打断（barge-in）。
       没有它，老人插一句嘴，机器只会继续念自己的。
       ================================================================= */
    public static volatile boolean cvMode = false;

    /** 被打断：原生侧停 TTS，前端把气泡收掉。 */
    public interface OnBarge { void onBarge(); }
    private OnBarge barge;
    public void setOnBarge(OnBarge b) { this.barge = b; }


    public Asr(Context c, OnText cb) {
        this.ctx = c.getApplicationContext();
        this.cb = cb;
    }

    public void start() {
        if (run) return;
        new Thread(new Runnable() {
            @Override public void run() { try { Para.ready(ctx); } catch (Throwable ignored) {} }
        }, "mili-para-warm").start();
        run = true;
        stopAsked = false;
        th = new Thread(this, "mili-asr");
        th.start();
    }

    /** 用户松手/再点一下：不再收新声音，把已经听到的出成最终结果 */
    public void stop() { stopAsked = true; }

    /** 模型能不能用。界面靠它决定要不要提示「这台机器先别用嘴」。 */
    public static boolean available() { return true; }

    /* ================= 主流程 ================= */

    @Override public void run() {
        OnlineRecognizer rec = engine();
        if (rec == null) {
            f("识别引擎起不来");
            done("", true);
            run = false;
            return;
        }

        AudioRecord ar = null;
        OnlineStream st = null;
        try {
            ar = openMic();
            if (ar == null) { done("", true); return; }
            st = rec.createStream("");

            short[] pcm = new short[CHUNK];
            float[] fbuf = new float[CHUNK];
            /* 把整段音频留一份：说完之后要用更准的模型重听一遍 */
            float[] keep = new float[SR * 25];
            int keepLen = 0;
            long t0 = System.currentTimeMillis();
            long lastVoice = t0;
            String last = "";

            long dbgAt = 0; int badReads = 0;
            boolean heard = false;   // 还没听到人说话之前，不能因为「安静」就收工
            long heardAt = 0;
            int bargeFrames = 0;     // 播报期间连续够响的帧数
            boolean bargeDone = false; // 这一句播报已经掐过一次了，不再掐
            /* 底噪估计的初值：这台机在 MIC 音源下的静态底噪大约就是这个量级。
               三秒之内会被真实底噪顶掉，初值不准也不影响。 */
            double noise = 0.0012;
            while (!stopAsked) {
                int n = ar.read(pcm, 0, CHUNK);
                if (n <= 0) { badReads++; Thread.sleep(30); continue; }

                double sum = 0;
                for (int i = 0; i < n; i++) {
                    float v = pcm[i] / 32768.0f;
                    fbuf[i] = v;
                    sum += v * v;
                }
                double rms = Math.sqrt(sum / Math.max(1, n));

                /* 底噪自适应（2026-11-06 晚补）。
                   换成 MIC 音源以后系统 AGC 把电平抬了近十倍，
                   原来那个固定的 VOICE_RMS 立刻失效：
                   真机日志里环境底噪常年就在 0.001~0.003 之间晃，
                   而门槛 0.0015 比底噪还低 —— lastVoice 每帧都被刷新，
                   老人说完话，静音计时永远跑不到 1.6 秒，句子收不了尾。
                   现在改成跟着底噪走：比底噪高 3 倍、且绝对值过 0.003 才算人声。
                   底噪本身用「向下快跟、向上极慢」的 EMA 估，
                   这样电视声、风扇声进来也不会把门槛一路顶上去。 */
                if (rms < noise) noise = noise * 0.7 + rms * 0.3;
                else noise = noise * 0.9995 + rms * 0.0005;
                final double voiceThr = Math.max(0.0030, noise * 3.0);

                /* 米粒正在念的时候，麦克风照样开着，但这段音频不喂识别模型 ——
                   喂了就是自问自答（它念「哎我在」，识别器立刻听成「我在」）。
                   这里只干一件事：看老人有没有插话。
                   连着 3 帧（0.3 秒）都够响才算真开口，咳嗽一声不算。 */
                if (MicGate.isSpeaking()) {
                    /* 播报开始 1.2 秒内一律不判打断：豆包首包抖动 + 回声收敛，
                       这段时间的电平最不可信。 */
                    if (!AUTO_BARGE_ENABLED || bargeDone || MicGate.sinceShut() < BARGE_GRACE_MS) {
                        bargeFrames = 0;
                        continue;
                    }
                    if (rms > BARGE_RMS) {
                        if (++bargeFrames >= BARGE_FRAMES) {
                            bargeFrames = 0;
                            bargeDone = true;
                            f("有人插话，掐掉播报（连 " + BARGE_FRAMES + " 帧 > " + BARGE_RMS + "）");
                            if (barge != null) { try { barge.onBarge(); } catch (Throwable ignored) {} }
                        }
                    } else {
                        bargeFrames = 0;
                    }
                    continue;
                }
                bargeFrames = 0;
                bargeDone = false;

                if (rms > voiceThr) {
                    lastVoice = System.currentTimeMillis();
                    if (!heard) { heard = true; heardAt = lastVoice; f("有声音了"); }
                }
                if (System.currentTimeMillis() - dbgAt > 1000) {
                    dbgAt = System.currentTimeMillis();
                    f("电平 " + String.format(java.util.Locale.US, "%.4f", rms)
                            + " 阈 " + String.format(java.util.Locale.US, "%.4f", voiceThr)
                            + " 底噪 " + String.format(java.util.Locale.US, "%.4f", noise)
                            + " 空读=" + badReads);
                }

                if (keepLen + n <= keep.length) {
                    System.arraycopy(fbuf, 0, keep, keepLen, n);
                    keepLen += n;
                }
                st.acceptWaveform(fbuf, SR);
                while (rec.isReady(st)) rec.decode(st);

                long now = System.currentTimeMillis();
                OnlineRecognizerResult r = rec.getResult(st);
                String t = r == null ? "" : clean(r.getText());
                if (!t.isEmpty() && !t.equals(last)) {
                    last = t;
                    heard = true;
                    /* 模型还在往外吐字，就说明人还在说 —— 这是比电平更可靠的续命信号。
                       日志里老人说话电平只有 0.0002~0.0017，光看电平会误判。 */
                    lastVoice = now;
                    f("出字：" + t);
                    done(t, false);
                }
                /* 断句（2026-11-06 晚重写）：不再问引擎，自己看静音。
                   条件只有两条 —— ① 人声静音满 1.8 秒 ② 至少 2 个字。
                   引擎的 isEndpoint 是「静音 1.2 秒就判完」，把老人想词的那一下
                   当成句号，所以才有「我还没说完就打断」。 */
                if (!last.isEmpty() && now - lastVoice > END_SILENCE_MS) {
                    /* 只有一个字（「姐」「嗯」「啊」）不是一句话：
                       既不该交出去跑一轮对话，也不能留在流里 ——
                       留着的话下一句会跟它拼成「姐今天几号」。
                       静音够了就原地丢掉，从头再听。 */
                    if (cleanLen(last) < END_MIN_CHARS) {
                        f("丢弃碎字：" + last);
                        try { st.release(); } catch (Throwable ignored) {}
                        st = rec.createStream("");
                        last = ""; heard = false; keepLen = 0;
                        t0 = now; lastVoice = now;
                        continue;
                    }
                    f("一句话说完（静音 " + (now - lastVoice) + "ms）：" + last);
                    if (!cvMode) break;

                    /* ===== 声纹门卫（2026-11-07）=====
                       keep 里是这句话的完整 PCM，还没被重置 —— 正好用来验声。
                       录制态：这句拿去录声纹，不交给对话；
                       验证态：不是老人的声音，整句丢掉，米粒不理。
                       路上电视里的人在说话、家人在旁边搭腔，都过不了这道门。 */
                    final float[] vseg = java.util.Arrays.copyOf(keep, keepLen);
                    if (Voice.enrollArmed) {
                        float sc = Voice.feedEnroll(ctx, vseg, SR);
                        f("声纹录制第 " + Voice.enrollTakes + "/" + Voice.enrollTarget
                                + " 段，score=" + String.format(java.util.Locale.US, "%.3f", sc));
                        try { st.release(); } catch (Throwable ignored) {}
                        st = rec.createStream("");
                        last = ""; heard = false; keepLen = 0;
                        t0 = now; lastVoice = now;
                        continue;
                    }
                    Boolean own = Voice.verify(ctx, vseg, SR);
                    if (own != null && !own.booleanValue()) {
                        f("声纹不符，这句不理：" + last);
                        try { st.release(); } catch (Throwable ignored) {}
                        st = rec.createStream("");
                        last = ""; heard = false; keepLen = 0;
                        t0 = now; lastVoice = now;
                        continue;
                    }
                    /* 过了声纹门（或没录过声纹），走原流程 */

                    /* 连续模式：这句交出去，原地重置，接着听下一句。
                       老人不用再按任何东西 —— 这就是「连贯」的全部秘密。 */
                    final String one = last;
                    final float[] seg = java.util.Arrays.copyOf(keep, keepLen);
                    final int segLen = keepLen;
                    /* 长句不再等准模型。原来端点一触发就必须等 Paraformer 跑完
                       （约 130ms，加载未热时更久）才发 final，老人听感就是
                       「话说完了，机器先愣一下」。现在：超过 6 个字直接交流式结果，
                       准模型只写日志；6 个字以内才等（短句最容易错，等得也短）。 */
                    final boolean waitPara = cleanLen(one) <= 6;
                    try { st.release(); } catch (Throwable ignored) {}
                    st = rec.createStream("");
                    last = ""; heard = false; keepLen = 0;
                    t0 = now; lastVoice = now;
                    if (!waitPara) done(one, true);
                    new Thread(new Runnable() {
                        @Override public void run() {
                            String out = one;
                            try {
                                if (segLen > SR / 4 && Para.ready(ctx)) {
                                    String a = Para.decode(seg, SR);
                                    if (a != null && !a.trim().isEmpty()) out = a;
                                }
                            } catch (Throwable ignored) {}
                            /* 只发一次 final —— 发两次前端会当成两句话，跑两轮对话。 */
                            if (waitPara) done(out, true);
                            else if (!out.equals(one)) f("准模型（仅记录）：" + one + " → " + out);
                        }
                    }, "mili-para-cv").start();
                    continue;
                }

                /* 2026-11-06 晚修：20 秒上限只管单次录音。
                   连续对话里也套这个上限的话，老人安静 20 秒（很正常，
                   他在看电视、在等药劲儿）识别线程就自己退出了，
                   可界面还挂着通话 —— 中间那 25 秒喊它、说话它全是聋的。
                   连续模式什么时候收工交给 CV_IDLE_MS，不许中途自杀。 */
                if (!cvMode && now - t0 > MAX_MS) { f("到 20 秒上限"); break; }
                if (now - lastVoice > (cvMode ? CV_IDLE_MS : IDLE_MS)) {
                    f(cvMode ? "连续模式：一直没声音，收工" : "一直没声音，收工");
                    break;
                }
            }

            /* 连续模式走不到这里：每一句都是端点触发后当场交出去的，
               final 早就发过了。再走一遍收尾会把最后一句重复发一次，
               前端就当成老人说了两遍，跑两轮对话。 */
            if (cvMode) return;

            // 收尾：把最后一段再推一次解码，拿完整结果
            if (st != null) {
                st.inputFinished();
                while (rec.isReady(st)) rec.decode(st);
                long now = System.currentTimeMillis();
                OnlineRecognizerResult r = rec.getResult(st);
                String t = r == null ? "" : clean(r.getText());
                if (!t.isEmpty()) last = t;
            }
            /* 用 Paraformer 把整段重新听一遍。它比流式小模型准得多，
               少字多字错字大多在这一步被纠正回来。 */
            String accurate = "";
            try {
                long t1 = System.currentTimeMillis();
                /* 前提：真有人说过话。Paraformer 拿到一段纯静音会自己编 ——
                   实测编出过「你的你的的的的的的」，比不给更糟。 */
                if (heard && last.length() > 0 && keepLen > SR / 2 && Para.ready(ctx)) {
                    accurate = Para.decode(java.util.Arrays.copyOf(keep, keepLen), SR);
                } else {
                    f("没有人声，跳过准模型");
                }
                f("准模型重听 " + (System.currentTimeMillis() - t1) + "ms →「" + accurate + "」（流式给的：「" + last + "」）");
            } catch (Throwable t) {
                f("准模型重听失败 " + t);
            }
            if (accurate != null && !accurate.isEmpty()) {
                last = accurate;
                done(last, false);      // 先把纠正后的字显示出来
            }
            /* 非连续模式同样过声纹门：录了声纹之后，不是老人的声音不开口 */
            if (!last.isEmpty() && heard && keepLen > Voice.MIN) {
                Boolean ownNcv = Voice.verify(ctx, java.util.Arrays.copyOf(keep, keepLen), SR);
                if (ownNcv != null && !ownNcv.booleanValue()) {
                    f("声纹不符（单次模式），这句不理：" + last);
                    last = "";
                }
            }
            f("最终：" + last);
            done(last, true);
        } catch (Throwable e) {
            f("识别出错 " + e);
            done("", true);
        } finally {
            if (ar != null) {
                try { ar.stop(); } catch (Exception ignored) {}
                try { ar.release(); } catch (Exception ignored) {}
            }
            if (st != null) { try { st.release(); } catch (Throwable ignored) {} }
            run = false;
        }
    }

    /* ================= 引擎 ================= */

    private OnlineRecognizer engine() {
        synchronized (Asr.class) {
            if (cached != null) return cached;
            if (cacheTried) return null;
            cacheTried = true;
            try {
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
                mc.setModelType("zipformer");

                OnlineRecognizerConfig cfg = new OnlineRecognizerConfig();
                cfg.setFeatConfig(feat);
                cfg.setModelConfig(mc);
                /* greedy 快但容易错字；老人说话含糊、还常带方言音，用 beam search 换准确率。
           4 路 beam 在这台机器上一帧仍然只花十几毫秒，感觉不出慢。 */
                cfg.setDecodingMethod("modified_beam_search");
                cfg.setEnableEndpoint(true);
                cfg.setMaxActivePaths(4);

                /* 断句：2026-11-06 菲尔特说「回复的时间太慢」，一半是这里拖的。
                   原来 r1=3.0 秒、r2=2.6 秒 —— 老人说完一句，引擎要干等 2.6 秒
                   才认「他说完了」，这 2.6 秒纯粹是白等，跟模型一点关系没有。
                   底下还有 0.6 秒的确认，加上模型 1.5 秒，一共四五秒才出声。

                   现在 r1=1.6 / r2=1.2：
                     · 1.2 秒够他把「我 想 给 女儿 打个 电话」中间的停顿说完 ——
                       这个间隔实测老人正常换气在 0.6~0.9 秒，1.2 留了余量；
                     · 真遇到他停下来想词，超过 1.2 秒会被切一句，
                       但模型听着上下文照样能接，比每次多等 1.4 秒划算得多。
                   r3（最长一句 25 秒）不动，那是兜住一口气说很长的情况。 */
                EndpointRule r1 = new EndpointRule(false, 1.6f, 0.0f);
                EndpointRule r2 = new EndpointRule(true, 1.2f, 0.0f);
                EndpointRule r3 = new EndpointRule(false, 0.0f, 25.0f);
                EndpointConfig ep = new EndpointConfig(r1, r2, r3);
                cfg.setEndpointConfig(ep);

                cached = new OnlineRecognizer(ctx.getAssets(), cfg);
                f("识别引擎就绪");
                return cached;
            } catch (Throwable t) {
                f("引擎加载失败 " + t);
                return null;
            }
        }
    }

    private AudioRecord openMic() {
        try {
            int min = AudioRecord.getMinBufferSize(SR,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int buf = Math.max(min * 2, CHUNK * 8);
            /* 2026-11-06 晚：MIC 优先（不再优先 VOICE_RECOGNITION）。
               同一台小米上实测，VOICE_RECOGNITION 不做 AGC，正常说话电平 0.0002~0.0017，
               连 VOICE_RMS 都过不去 → 说话不续命、句子被提前收。
               换成 MIC 后系统 AGC 会把电平拉起来。 */
            AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.MIC,
                    SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                r.release();
                r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
                if (r.getState() != AudioRecord.STATE_INITIALIZED) { r.release(); f("麦克风打不开"); return null; }
            }
            try {
                if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                    aec = android.media.audiofx.AcousticEchoCanceler.create(r.getAudioSessionId());
                    if (aec != null) aec.setEnabled(true);
                }
            } catch (Throwable ignored) {}
            r.startRecording();
            return r;
        } catch (Throwable t) {
            f("开麦克风失败 " + t);
            return null;
        }
    }

    /** 模型输出带 ▁ 和空格，中文要拼回去 */
    private String clean(String s) {
        if (s == null) return "";
        return s.replace("▁", " ").replaceAll("\\s+", " ").trim();
    }

    /** 去掉标点空格之后的字数。判「这是不是一句完整的话」用。 */
    private static int cleanLen(String s) {
        if (s == null) return 0;
        return s.replaceAll("[\\s，。？！、,.?!…~～—\\-]", "").length();
    }

    private void done(final String t, final boolean fin) {
        if (cb == null) return;
        try { cb.onText(t, fin); } catch (Throwable ignored) {}
    }

    private void f(String s) {
        Log.i(TAG, s);
        try {
            java.io.File file = new java.io.File(ctx.getExternalFilesDir(null), "kws.log");
            java.io.FileWriter w = new java.io.FileWriter(file, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.CHINA)
                    .format(new java.util.Date()) + " [asr] " + s + "\n");
            w.close();
        } catch (Throwable ignored) {}
    }
}
