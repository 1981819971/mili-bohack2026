package com.mili.app;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.SystemClock;
import android.util.Log;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileWriter;
import java.net.URI;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.GZIPOutputStream;

/**
 * 豆包流式语音识别 2.0 —— 米粒的耳朵，边说边出字。
 *
 * 跟老路（CloudAsr）的区别，用一句话说清楚：
 *   老路 = 老人说完 → 等 1.2 秒确认不说了 → 录好的整段上传 → 服务器慢慢认 → 回字。
 *   这条 = 老人一开口就在传，每个字认出来就往回送；他住口的时候，字已经全在那儿了。
 *
 * 省掉的不是「模型算得快不快」，是「整段往返」这一趟。老人说完就能接话。
 *
 * 协议（火山 openspeech v3，二进制帧）：
 *   [4B header][4B seq][4B size][payload]
 *   header[0]=0x11  header[1]=(type<<4)|flags  header[2]=(json<<4)|gzip  header[3]=0
 *   首包 full client(type=1) 带 JSON 配置；之后 audio only(type=2) 送 PCM；末包 flags=0b0010 且 body 为空。
 *
 * 资源 ID 必须是 volc.seedasr.sauc.duration（2.0 是 seedasr，1.0 才是 bigasr，别混）。
 */
public class DuoAsr {

    private static final String TAG = "MiliDuoAsr";
    private static final String URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
    private static final String RES = "volc.seedasr.sauc.duration";
    /* 2026-11-12 20:44：菲尔特在火山控制台开通了「流式语音识别大模型」，
       本钥匙握手 101，与 TTS 共用同一把，旧钥匙已彻底停用。 */
    private static final String KEY = "aa9030d2-b42b-4056-9545-25a4cf9a7c51";

    private static final int SR = 16000;
    private static final int CHUNK = 1600;          // 100ms @16k/16bit/mono = 3200 字节
    private static final float MIN_VAD = 0.010f;   // 底噪阈值下限，避免静音或全零帧把阈值拉到零
    private static final int TAIL_MS = 1400;        // 住口多久算说完
    private static final int SENTENCE_TAIL_MS = 1000; // 有句末标点且文字、声音都稳定时提前收尾
    private static final int NO_VOICE_MS = 7000;    // 一直没人说话就收工
    private static final int MAX_MS = 25000;

    public interface OnText {
        /** partial：边听边出的半截字，用于显示和播放预连接，不拿去执行操作 */
        void onPartial(String text);
        /** final：整句定稿 */
        void onFinal(String text, boolean ok);
    }

    private final Context ctx;
    /* 2026-11-10 声纹接入在线链路：本轮麦克风攒下的 PCM。
       上限 25 秒 × 16k = 800KB，一句话足够；判完就丢，不落盘、不上传。 */
    private final short[] voiceCap = new short[SR * 25];
    private int voiceLen = 0;
    private final Object voiceLock = new Object();

    /* 2026-11-10 16:15 真机「一直显示在听、听不见」：屏幕上写着在听，
       原生却可能一帧真音频都没读到（麦被 KWS/MIUI 占着、WebSocket 没连上）。
       把最后一帧音频的时刻暴露给网页，让它能自己发现「假在听」，别再骗老人。 */
    public static volatile long lastPcmAt = 0;
    public static volatile long pcmFrames = 0;
    private final OnText cb;
    private WebSocketClient ws;
    private AudioRecord ar;
    private volatile boolean running = true;
    private volatile boolean finished = false;
    /* 2026-11-09：finish() 回给调用方的 ok 原本写成 !text.isEmpty()，
       意思是「有没有听到字」，却被 MainActivity 当成「在线连没连上」。
       结果安静会话（没说话也会正常定稿）被误判成在线失败，又去起本地
       sherpa-onnx 离线识别 —— 真机日志里 12 条「电平」就是这么来的。
       ok 现在只表示「服务端连上过」，与识别结果无关。 */
    private volatile boolean connected = false;
    private int seq = 1;

    private final StringBuilder partial = new StringBuilder();
    private volatile String best = "";
    private String speechKey = "";                // 只在 WebSocket 回调里更新，忽略标点修订
    private volatile long textChangedAt = 0;       // 录音线程也要知道识别文字是否仍在变化

    public DuoAsr(Context c, OnText cb) {
        this.ctx = c.getApplicationContext();
        this.cb = cb;
    }

    /** 开听。连不上就立刻回调 ok=false，调用方自己退回老路。 */
    public void start() {
        new Thread(new Runnable() {
            @Override public void run() { runSession(); }
        }, "mili-duo-asr").start();
    }

    /** 老人又点了一下＝「我说完了」，别再等静音 */
    public void stop() {
        running = false;
    }

    private void runSession() {
        final long t0 = System.currentTimeMillis();
        try {
            ws = new WebSocketClient(new URI(URL)) {
                @Override public void onOpen(ServerHandshake h) {
                    connected = true;
                    f("连上 " + h.getHttpStatus());
                    sendConfig();
                    startMic();
                }

                @Override public void onMessage(String s) { /* 二进制协议，不该走这里 */ }

                @Override public void onMessage(java.nio.ByteBuffer bb) {
                    byte[] b = new byte[bb.remaining()];
                    bb.get(b);
                    handle(b);
                }

                @Override public void onClose(int code, String reason, boolean remote) {
                    f("断开 " + code + " " + reason);
                    if (!finished) finish(best);
                }

                @Override public void onError(Exception e) {
                    f("出错 " + e);
                    if (!finished) finish(best);
                }
            };
            ws.addHeader("X-Api-Key", KEY);
            ws.addHeader("X-Api-Resource-Id", RES);
            ws.addHeader("X-Api-Connect-Id", "mili-" + System.currentTimeMillis());
            ws.setConnectionLostTimeout(15);
            if (!ws.connectBlocking(6, java.util.concurrent.TimeUnit.SECONDS)) {
                f("握手失败");
                finish("");
                return;
            }
            /* 录音线程自己管节奏，这里只负责兜底超时 */
            while (!finished && System.currentTimeMillis() - t0 < MAX_MS + 3000) {
                Thread.sleep(100);
            }
            if (!finished) finish(best);
        } catch (Throwable t) {
            f("会话异常 " + t);
            finish(best);
        } finally {
            releaseMic();
            try { if (ws != null) ws.close(); } catch (Throwable ignored) {}
        }
    }

    /* ================= 麦克风 ================= */

    private void startMic() {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    int min = AudioRecord.getMinBufferSize(SR,
                            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    /* 🚨 2026-11-10 真机根因：这台 MIUI 上 VOICE_RECOGNITION 的
                       增益极低，真人说话峰值 rms 只有 0.01，跟底噪一个量级，
                       全被 VAD 当成静音切掉 → 火山收 7 秒静音 → 定稿「」。
                       Kws 用 AudioSource.MIC 能听清「米粒米粒」，同一颗麦同一台机，
                       差别只剩 source。这里改成跟 KWS 一致，实证可用。 */
                    ar = new AudioRecord(MediaRecorder.AudioSource.MIC,
                            SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                            Math.max(min * 2, CHUNK * 8));
                    if (ar.getState() != AudioRecord.STATE_INITIALIZED) { f("麦克风打不开"); finish(""); return; }
                    try {
                        if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                            android.media.audiofx.AcousticEchoCanceler aec =
                                    android.media.audiofx.AcousticEchoCanceler.create(ar.getAudioSessionId());
                            if (aec != null) aec.setEnabled(true);
                        }
                    } catch (Throwable ignored) {}
                    ar.startRecording();
                    f("开始录");

                    short[] buf = new short[CHUNK];
                    synchronized (voiceLock) { voiceLen = 0; }
                    Voice.lastOwn = null;
                    long t0 = SystemClock.elapsedRealtime();
                    long lastVoice = t0;
                    boolean heard = false;
                    int packets = 0;
                    int zeroFrames = 0;
                    String stopWhy = "max";
                    /* 每 15 帧取较安静的四分位估计底噪，后续只下调阈值。
                       开头可能就在说话，不能把这批人声永久当成底噪。
                       静下来后重新估计，避免阈值高于整轮音量、一直等无人说话超时。 */
                    final float[] calib = new float[15];
                    int calibN = 0;
                    float vad = MIN_VAD;
                    double peak = 0;

                    while (running && !finished) {
                        /* 米粒自己在说话时不收 —— 但不能永久关闸：
                           TTS 的 onEnd 丢一次，MicGate 就会一直 speaking，
                           在线识别一帧都读不到（23:40 真机「根本不说话」）。
                           超过 12 秒就当它已经说完，强制开闸。 */
                        if (MicGate.isSpeaking() && MicGate.sinceShut() < 12000) {
                            t0 = SystemClock.elapsedRealtime();
                            lastVoice = t0;
                            Thread.sleep(60);
                            continue;
                        }
                        int n = ar.read(buf, 0, CHUNK);
                        if (n <= 0) { Thread.sleep(20); continue; }

                        double sum = 0;
                        for (int i = 0; i < n; i++) { double v = buf[i] / 32768.0; sum += v * v; }
                        double rms = Math.sqrt(sum / Math.max(1, n));
                        if (rms > peak) peak = rms;
                        calib[calibN++ % calib.length] = (float) rms;
                        if (calibN % calib.length == 0) {
                            float[] c = calib.clone();
                            java.util.Arrays.sort(c);
                            float nextVad = Math.max(MIN_VAD, c[calib.length / 4] * 2.2f);
                            if (calibN == calib.length || nextVad < vad) {
                                vad = nextVad;
                                f(String.format(java.util.Locale.CHINA,
                                        "底噪更新 四分位=%.4f 阈值=%.4f", c[calib.length / 4], vad));
                            }
                        }
                        if (calibN >= calib.length && rms > vad) {
                            heard = true;
                            lastVoice = SystemClock.elapsedRealtime();
                        }

                        /* 2026-11-10 订正 11-09 的「静音帧发静音包」：
                           当时阈值 0.02 是为了压底噪（当时底噪 0.0025），
                           但这台机 + 真人说话实测峰值才 0.01 —— 人声全被当静音切了，
                           火山收 7 秒静音包，定稿永远「」。
                           现在改成**全部发真音频**：持续心跳不丢，静音由服务端
                           自己的 VAD 判（qingjian / doubao-speech 同款做法）。
                           本地 VAD 只留一个职责：判「有没有人说话」来决定收轮。 */
                        /* 同一份真音频留一份给本地声纹引擎，判完即弃。 */
                        synchronized (voiceLock) {
                            int take = Math.min(n, voiceCap.length - voiceLen);
                            if (take > 0) {
                                System.arraycopy(buf, 0, voiceCap, voiceLen, take);
                                voiceLen += take;
                            }
                        }
                        sendPcm(pcmBytes(buf, n));
                        packets++;
                        lastPcmAt = System.currentTimeMillis();
                        pcmFrames++;

                        /* 2026-11-10：全 0 是「麦克风被别的进程占着」的确定信号，
                           真音频的底噪也绝不会是严格的 0。连满 1.5 秒就留一条，
                           别让下一次「一直在听没人应」又从头查。 */
                        if (rms == 0.0) zeroFrames++; else zeroFrames = 0;
                        if (zeroFrames == 15) f("警告：连续 1.5 秒音频全 0，麦克风被占了");

                        long now = SystemClock.elapsedRealtime();
                        long changedAt = textChangedAt;
                        boolean hasSpeech = heard || changedAt > 0;
                        String recognized = best.trim();
                        boolean sentenceEnded = !recognized.isEmpty()
                                && "。！？.!?".indexOf(recognized.charAt(recognized.length() - 1)) >= 0;
                        int tailMs = changedAt > 0 && sentenceEnded ? SENTENCE_TAIL_MS : TAIL_MS;
                        // 文字变化也算仍在说话；重复包和单纯补标点不会让等待反复续期。
                        if (hasSpeech && calibN >= calib.length
                                && now - Math.max(lastVoice, changedAt) >= tailMs) {
                            stopWhy = tailMs == SENTENCE_TAIL_MS ? "sentence" : "tail";
                            break;
                        }
                        if (!hasSpeech && now - t0 > NO_VOICE_MS) { stopWhy = "novoice"; break; }
                        if (now - t0 > MAX_MS) { stopWhy = "max"; break; }
                    }

                    ar.stop();
                    f("本轮送出 " + packets + " 包 / 峰值 rms="
                            + String.format(java.util.Locale.CHINA, "%.4f", peak)
                            + " / 收轮原因=" + stopWhy + " / 已出字=" + (best.isEmpty() ? "无" : best));
                    sendLast();
                    /* 等最终包回来。2026-11-10 真机：3 秒经常不够，
                       末包发出去后服务端还没回 definite 帧就主动收工，
                       定稿「」—— 老人明明说了话，一个字都到不了前端。 */
                    long w = SystemClock.elapsedRealtime();
                    while (!finished && SystemClock.elapsedRealtime() - w < 5000) Thread.sleep(50);
                    if (!finished) { f("等最终包 5 秒超时，best=「" + best + "」"); finish(best); }
                } catch (Throwable t) {
                    f("录音异常 " + t);
                    finish(best);
                } finally {
                    releaseMic();
                }
            }
        }, "mili-duo-mic").start();
    }

    private void releaseMic() {
        try { if (ar != null) { ar.stop(); ar.release(); ar = null; } } catch (Throwable ignored) {}
    }

    private static byte[] pcmBytes(short[] buf, int n) {
        byte[] out = new byte[n * 2];
        for (int i = 0; i < n; i++) {
            out[i * 2] = (byte) (buf[i] & 0xff);
            out[i * 2 + 1] = (byte) ((buf[i] >> 8) & 0xff);
        }
        return out;
    }

    /* ================= 协议 ================= */

    private void sendConfig() {
        try {
            JSONObject audio = new JSONObject();
            audio.put("format", "pcm");
            audio.put("codec", "raw");
            audio.put("rate", SR);
            audio.put("bits", 16);
            audio.put("channel", 1);

            JSONObject req = new JSONObject();
            req.put("model_name", "bigmodel");
            req.put("enable_itn", true);
            req.put("enable_punc", true);
            req.put("enable_ddc", true);
            req.put("result_type", "single");
            req.put("end_window_size", 800);
            /* 2026-11-10 菲尔特：「不止四川话，其他方言也要行」。
               豆包流式 ASR 2.0（volc.seedasr.sauc.duration）不传 language 时
               原生支持普通话 / 四川话 / 粤语 / 闽南语 / 上海话 / 陕西话 /
               山西话 / 客家话 / 冀鲁 / 兰银 / 江淮官话 + 英语 —— 千万别锁 zh-CN，
               一锁就把方言全挡在门外（language 本来也只在 nostream 生效）。
               原来这里写成 corpus:{context_data:[...]}，缺 context_type、字段名也不对，
               服务端直接忽略，等于热词一个都没生效。
               按官方文档 + GitHub VoxType 接入指南改成 corpus.context 纯文本字符串：
               一行一个热词，末行把「老人有方言口音」写进上下文。 */
            /* 🚨 2026-11-10 18:13 P0 真因（本机直连火山实测 + 官方文档）：
               corpus.context 必须是「JSON 字符串」，服务端会 unmarshal corpusCtx。
               11-10 早上改成一行一个热词的纯文本后，服务端第一帧就回
               "fail to unmarshal corpusCtx"，整个会话判 session failed，
               一个字都不返回 —— 老人说话、麦克风有 63 包真音频、声纹也判了，
               米粒却永远定稿「」、不回话。这不是麦、不是抢麦、不是模型。
               本机四组探测：纯文本 / JSON 数组 -> error 帧；
               不带 corpus、"{}"、官方 hotwords 字符串 -> 正常 result。
               官方格式："corpus":{"context":"{\"hotwords\":[{\"word\":\"米粒\"}]}"}
               方言不靠热词：audio 里不传 language，2.0 原生支持普通话/四川话/
               粤语/闽南语/上海话/陕西话/冀鲁/兰银/江淮（火山文档明示）。 */
            try {
                org.json.JSONArray hw = new org.json.JSONArray();
                for (String w : new String[]{
                        "王炳皓", "李昌洪", "刘沛东", "张桂芳", "米粒",
                        "手电筒", "付款码", "扫一扫"}) {
                    hw.put(new JSONObject().put("word", w));
                }
                JSONObject inner = new JSONObject().put("hotwords", hw);
                JSONObject corpus = new JSONObject().put("context", inner.toString());
                req.put("corpus", corpus);
                f("corpus 官方格式 hotwords=" + hw.length());
            } catch (Throwable t) { f("corpus 构造失败，改用不带热词 " + t); }

            JSONObject user = new JSONObject();
            user.put("uid", "mili");

            JSONObject cfg = new JSONObject();
            cfg.put("user", user);
            cfg.put("audio", audio);
            cfg.put("request", req);

            /* 验收要能证明「方言上下文真的发出去了」，不能只看「没报错」。 */
            f("配置帧 request=" + req.toString());
            ws.send(frame(0b0001, 0b0001, cfg.toString().getBytes("UTF-8"), seq++, true));
        } catch (Throwable t) {
            f("配置帧发失败 " + t);
        }
    }

    private synchronized void sendPcm(byte[] data) {
        try {
            if (ws == null || ws.isClosed()) return;
            ws.send(frame(0b0010, 0b0001, data, seq++, true));
        } catch (Throwable t) { f("送音频失败 " + t); }
    }

    private synchronized void sendLast() {
        try {
            if (ws == null || ws.isClosed()) return;
            /* 末包 8 字节：header(4) + payload size(4)=0。
               官方协议 flags=0b0010 = 「header 后 4 字节 NOT sequence number，
               仅指示此为最后一包（负包）」，0b0011 才是带负 seq 的末包。
               旧代码 flags=0b0010 却写了 int4(-seq)，服务端把 -72 当 size 读成
               4294967224，报 "declared body size does not match actual body size"。
               修前：双向流式在末包之前文字已经全部返回，但服务端回 error 帧，
               handle() 只能用最后一个 partial 定稿，丢掉最终 definite 帧里可能
               带上的 ITN / 标点修正。修后：能正常收到 flags=0x3 的最终帧。
               注意这不是「回复提速」的证据，别拿它当提速讲。实测见 dup/asr_lastprobe.mjs。 */
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write(new byte[]{0x11, (byte) ((0b0010 << 4) | 0b0010), 0x10, 0});
            o.write(int4(0));
            ws.send(o.toByteArray());
            f("发末包 无seq size=0");
        } catch (Throwable t) { f("末包失败 " + t); }
    }

    private static byte[] frame(int type, int flags, byte[] payload, int sq, boolean gz) throws Exception {
        byte[] body = payload;
        int comp = 0;
        if (gz) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            GZIPOutputStream g = new GZIPOutputStream(bo);
            g.write(payload);
            g.close();
            body = bo.toByteArray();
            comp = 1;
        }
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(new byte[]{0x11, (byte) ((type << 4) | flags), (byte) ((0b0001 << 4) | comp), 0});
        o.write(int4(sq));
        o.write(int4(body.length));
        o.write(body);
        return o.toByteArray();
    }

    private static byte[] int4(int v) {
        return new byte[]{(byte) (v >>> 24), (byte) (v >>> 16), (byte) (v >>> 8), (byte) v};
    }

    private static int readInt(byte[] b, int off) {
        return ((b[off] & 0xff) << 24) | ((b[off + 1] & 0xff) << 16) | ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff);
    }

    private void handle(byte[] b) {
        if (finished) return;
        try {
            if (b.length < 4) return;
            int type = (b[1] >> 4) & 0x0f;
            /* 🚨 服务端的错误帧 flags=0，Java 这边按「无 seq」算 size 会解歪，
               payload 校验失败直接 return —— 错误被静默吞掉，日志上只看得到
               「断开 1000 session failed」，查一整天都定位不到。
               先无条件把整包里的 error 文本挖出来打出来，再收工。 */
            if (type == 0b1111) {
                String raw = new String(b, "UTF-8");
                int p = raw.indexOf("\"error\"");
                f("服务端错帧 " + (p >= 0 ? raw.substring(p) : raw).replace("\n", " ").trim());
                connected = false;
                finish(best);
                return;
            }
            int flags = b[1] & 0x0f;
            int comp = b[2] & 0x0f;
            int off = 4;
            /* 只有 bit0 表示「有 sequence」。0b0010 是无 seq 的末包，
               旧代码把 0b0010 也算成有 seq，会多跳 4 字节把整个包解歪。 */
            boolean hasSeq = (flags & 0x01) != 0;
            if (hasSeq && b.length >= off + 4) off += 4;
            if (b.length < off + 4) {
                if ((flags & 0x02) != 0) finish(best);
                return;
            }
            int size = readInt(b, off);
            off += 4;
            if (size <= 0 || off + size > b.length) {
                if ((flags & 0x02) != 0) finish(best);
                return;
            }
            byte[] pl = new byte[size];
            System.arraycopy(b, off, pl, 0, size);
            if (comp == 1) {
                java.io.ByteArrayInputStream bi = new java.io.ByteArrayInputStream(pl);
                java.util.zip.GZIPInputStream gi = new java.util.zip.GZIPInputStream(bi);
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] tmp = new byte[4096];
                int n;
                while ((n = gi.read(tmp)) > 0) bo.write(tmp, 0, n);
                gi.close();
                pl = bo.toByteArray();
            }
            if (type == 0b1111) {
                f("服务端错 " + new String(pl, "UTF-8"));
                finish(best);
                return;
            }
            String s = new String(pl, "UTF-8");
            if (s.isEmpty()) {
                if ((flags & 0x02) != 0) finish(best);
                return;
            }
            JSONObject o = new JSONObject(s);
            JSONObject result = o.optJSONObject("result");
            if (result != null) {
                String t = result.optString("text", "");
                if (t != null && t.length() > 0) {
                    String key = t.replaceAll("[\\p{P}\\p{Z}\\s]", "");
                    if (!key.isEmpty() && !key.equals(speechKey)) {
                        speechKey = key;
                        textChangedAt = SystemClock.elapsedRealtime();
                    }
                    best = t;
                    if (!t.equals(partial.toString())) {
                        f("服务端出字「" + t + "」");
                        partial.setLength(0);
                        partial.append(t);
                        cb.onPartial(t);
                    }
                }
            }
            if ((flags & 0x02) != 0) { f("服务端末帧 best=「" + best + "」"); finish(best); }
        } catch (Throwable t) {
            f("解包失败 " + t);
        }
    }

    private final AtomicBoolean done = new AtomicBoolean(false);

    private void finish(String text) {
        if (!done.compareAndSet(false, true)) return;
        finished = true;
        running = false;
        releaseMic();
        String t = text == null ? "" : text.trim();
        f("定稿「" + t + "」");
        /* 声纹必须在把文字交给前端之前判完：前端读到 lastOwn 才决定
           这一轮挂不挂办事工具。没录过 / 太短一律放行，新手机不受影响。 */
        verifyVoice();
        cb.onFinal(t, connected);        // ok = 在线连上过，不是「有识别结果」
    }

    /** 一句话收工时判声纹。只做「能不能指挥办事」这一道闸，
        不拦闲聊、不拦没录过声纹的新手机，也不把音频留下来。 */
    private void verifyVoice() {
        Voice.lastOwn = null;
        try {
            if (!Voice.enrolled(ctx)) { f("声纹：没录过，放行"); return; }
            int n;
            short[] s;
            synchronized (voiceLock) {
                n = Math.min(voiceLen, voiceCap.length);
                s = java.util.Arrays.copyOf(voiceCap, n);
            }
            if (n < Voice.MIN) { f("声纹：这句只有 " + n + " 采样，太短，放行"); return; }
            float[] pcm = new float[n];
            for (int i = 0; i < n; i++) pcm[i] = s[i] / 32768.0f;
            Boolean own = Voice.verify(ctx, pcm, SR);
            Voice.lastOwn = own;
            f("声纹判定 " + (own == null ? "判不出/放行"
                    : (own.booleanValue() ? "是老人" : "不是老人，本轮不办事")));
        } catch (Throwable t) {
            f("声纹异常 " + t);
            Voice.lastOwn = null;
        }
    }

    private void f(String s) {
        Log.i(TAG, s);
        try {
            File file = new File(ctx.getExternalFilesDir(null), "kws.log");
            FileWriter w = new FileWriter(file, true);
            w.write(new SimpleDateFormat("HH:mm:ss.SSS", Locale.CHINA).format(new Date()) + " [duoasr] " + s + "\n");
            w.close();
        } catch (Throwable ignored) {}
    }
}
