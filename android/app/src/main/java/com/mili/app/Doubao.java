package com.mili.app;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.util.Log;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

import java.net.URI;
import java.nio.charset.Charset;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 豆包语音合成 2.0 —— 米粒的嘴，在本机直连。
 *
 * 为什么不用服务端中转：
 *   老人说完一句话，中间每多一跳就多一百多毫秒。直连实测首音 392ms，
 *   中转要再走一趟 ECS。这台机器上本来就有 WiFi，多那一跳不值。
 *
 * 为什么不要 mp3：
 *   audio_params 直接要 pcm，回来就是 16bit 小端裸流，AudioTrack.write 灌进去就响。
 *   mp3 还要解码一道，白费 CPU，还会多攒一个解码缓冲的延迟。
 *
 * 为什么每句一个连接：
 *   句间握手约 110ms，JS 那边是按标点切句的，两句之间本来就有停顿，
 *   110ms 藏得住。等体感真到了要抠这一百毫秒的时候，再改成常驻连接。
 */
public class Doubao {

    private static final String TAG = "MiliDoubao";

    private static final String URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
    private static final String RESOURCE = "seed-tts-2.0";
    /* 2026-11-06 菲尔特在豆包语音控制台「API Key 管理」建的 */
    private static final String KEY = "aa9030d2-b42b-4056-9545-25a4cf9a7c51";

    /* 音色：童声。基频实测 348Hz，六个候选里最高（成人女声约 200Hz，童声 300Hz 以上）。 */
    public static volatile String voice = "zh_male_naiqimengwa_uranus_bigtts";
    /* 语速。实测基准 9.8 秒/24 字（约 2.4 字每秒，老人听广播是 4~5 字每秒）：
         0 → 9.82 秒   30 → 7.23 秒   42 → 7.06~8.18 秒   60 → 5.63 秒   80 → 4.57 秒   100 → 4.81 秒
       55 落在 5.5 秒上下，约 4.3 字每秒，是正常聊天速度。
       真人觉得不合适不用回来改代码：说一句「快一点」就走 ttsRate 调，调完存盘、开机照用。 */
    public static volatile int speechRate = 55;

    private static final int SR = 24000;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    /* ---- 协议常量 ---- */
    private static final int M_FULL_CLIENT = 0b0001;
    private static final int M_FULL_SERVER = 0b1001;
    private static final int M_AUDIO_SERVER = 0b1011;
    private static final int M_ERROR = 0b1111;
    private static final int F_EVENT = 0b0100;
    private static final int S_JSON = 0b0001;

    private static final int EV_START_CONN = 1;
    private static final int EV_FINISH_CONN = 2;
    private static final int EV_CONN_STARTED = 50;
    private static final int EV_CONN_FAILED = 51;
    private static final int EV_CONN_FINISHED = 52;
    private static final int EV_START_SESSION = 100;
    private static final int EV_FINISH_SESSION = 102;
    private static final int EV_SESSION_STARTED = 150;
    private static final int EV_SESSION_FINISHED = 152;
    private static final int EV_SESSION_FAILED = 153;
    private static final int EV_TASK = 200;
    private static final int EV_TTS_RESPONSE = 352;

    /* 每句一个播放器。
       以前是全类共用一条 AudioTrack：旧句念到一半被打断时，GEN 只能挡住「还没收到的音频」，
       已经写进 AudioTrack 缓冲的那几百毫秒照旧从喇叭里出来；新句的 ws 一连上又往同一条 track 里写，
       两段声音就叠在一起 —— 老人听到的就是「好几个声音同时在说话」。
       现在改成一句一条，换句时把上一条 pause + flush + release，
       旧句当场断掉，新句从干净的缓冲里起头。 */
    private static final Object TRACK_LOCK = new Object();
    /* 打断用：每说一句就 +1。旧连接看到号变了立刻闭麦，
       否则老人插嘴之后，前一句的尾巴还会接着念出来。 */
    private static final AtomicInteger GEN = new AtomicInteger(0);
    private static volatile boolean speaking = false;
    /* 当前正在出声的那一句。stop() 要靠它把播放器收掉。 */
    private static volatile Ctx active;

    public interface Sink {
        void onStart();
        void onEnd(String id);
        /** 一个字都没说出来。调用方应该退回系统 TTS，不能让老人对着空气等。 */
        void onFail();
    }

    /* ---------------- 播放器 ---------------- */

    /** 造一条新的播放器。一条 track 只服务一句话，播完就 release。 */
    private static AudioTrack buildTrack() {
        int buf = AudioTrack.getMinBufferSize(SR, AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT);
        if (buf <= 0) buf = 4096;
        /* 2 倍最小缓冲：太小，孩子说话的短句会断续；太大，打断会迟钝。 */
        return new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SR)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setBufferSizeInBytes(buf * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
    }

    /** 老人插话了：立刻闭嘴。已经排进播放器缓冲的声音也要一并作废。 */
    public static void stop() {
        GEN.incrementAndGet();
        speaking = false;
        Ctx c = active;
        active = null;
        if (c != null) c.kill();
    }

    public static boolean isSpeaking() { return speaking; }

    /** 预热：第一句往往要等 WebSocket 握手，提前把播放器参数走一遍能省一点。
        播放器现在是一句一条，这里只热身，不长期占着。 */
    public static void warm() {
        new Thread(new Runnable() {
            @Override public void run() {
                AudioTrack t = null;
                try {
                    t = buildTrack();
                } catch (Throwable ignored) {
                } finally {
                    if (t != null) { try { t.release(); } catch (Throwable ignored) {} }
                }
            }
        }).start();
    }

    /* ---------------- 协议 ---------------- */

    private static byte[] header(int type, int flags, int ser) {
        return new byte[] {
                (byte) ((0b0001 << 4) | 0b0001),
                (byte) ((type << 4) | flags),
                (byte) ((ser << 4) | 0),
                0
        };
    }

    private static ByteBuffer frame(int event, String json, String sid) {
        byte[] body = json.getBytes(UTF8);
        byte[] s = sid == null ? null : sid.getBytes(UTF8);
        int total = 4 + 4 + (s != null ? 4 + s.length : 0) + 4 + body.length;
        ByteBuffer b = ByteBuffer.allocate(total);
        b.put(header(M_FULL_CLIENT, F_EVENT, S_JSON));
        b.putInt(event);
        if (s != null) {
            b.putInt(s.length);
            b.put(s);
        }
        b.putInt(body.length);
        b.put(body);
        b.position(0);
        return b;
    }

    /** 返回 {type, event, payloadBytes} */
    private static Object[] parse(byte[] raw) {
        if (raw == null || raw.length < 8) return null;
        int type = (raw[1] >> 4) & 0x0f;
        int flags = raw[1] & 0x0f;
        int off = 4;
        int event = 0;
        if ((flags & F_EVENT) != 0) {
            if (off + 4 > raw.length) return null;
            event = ((raw[off] & 0xff) << 24) | ((raw[off + 1] & 0xff) << 16)
                    | ((raw[off + 2] & 0xff) << 8) | (raw[off + 3] & 0xff);
            off += 4;
        }
        if (off + 4 <= raw.length) {
            int maybe = ((raw[off] & 0xff) << 24) | ((raw[off + 1] & 0xff) << 16)
                    | ((raw[off + 2] & 0xff) << 8) | (raw[off + 3] & 0xff);
            if (maybe > 0 && maybe < 200 && off + 4 + maybe <= raw.length) {
                off += 4 + maybe;
            }
        }
        if (off + 4 > raw.length) return new Object[] {type, event, new byte[0]};
        int size = ((raw[off] & 0xff) << 24) | ((raw[off + 1] & 0xff) << 16)
                | ((raw[off + 2] & 0xff) << 8) | (raw[off + 3] & 0xff);
        off += 4;
        byte[] payload = new byte[0];
        if (size > 0 && off + size <= raw.length) {
            payload = new byte[size];
            System.arraycopy(raw, off, payload, 0, size);
        }
        return new Object[] {type, event, payload};
    }

    /* ==========================================================================
     * 预连接（2026-11-12 菲尔特：「打电话第一句话回话太慢」）
     * --------------------------------------------------------------------------
     * 实测拆出来是这样的（真机，文字到出声 1.7~2.3 秒）：
     *     模型吐第一个字        243 ms
     *     TTS 握手 → 出声       ~1500 ms   ← 全在这里
     * 而那 1.5 秒里，真正在合成的时间只有几百毫秒，其余全是往返：
     *     ws 握手 → START_CONN → CONN_STARTED → START_SESSION →
     *     SESSION_STARTED → 才轮到发文本。
     * 关键观察：**前三步跟要念什么字一点关系都没有**。
     * 所以它们可以提前做掉 —— 老人还在说话、模型还在想的时候，
     * 就把这条连接一路推到 SESSION_STARTED，停在门口等着。
     * 真要开口时只剩「发文本 + 等首包」，把 1.5 秒砍成 0.4 秒上下。
     *
     * 三条保险（宁可退回老路，也不许没声音）：
     *   ① 预连接只活 25 秒；过期就关掉，不占服务端连接数
     *   ② 音色/语速一变（params 不相等）就不用它
     *   ③ 任何一步出错只把这条标死，say() 照走原来那条路
     * ======================================================================== */
    private static volatile Ready ready = null;

    /** 一条已经握手到 SESSION_STARTED、还没发文本的连接。 */
    private static final class Ready {
        WebSocketClient ws;
        String sid;
        String params;
        volatile boolean sess = false;   // 服务端说 SESSION_STARTED 了
        volatile boolean dead = false;
        long at = System.currentTimeMillis();
    }

    /* ws → 这一句的 Ctx。预连阶段还没有 Ctx，就是空的。 */
    private static final java.util.Map<WebSocketClient, Ctx> OWNER =
            java.util.Collections.synchronizedMap(new java.util.WeakHashMap<WebSocketClient, Ctx>());

    /**
     * 提前把连接推到「就等文本」那一步。重复调用无副作用；过期会重建。
     * 只该在进通话/准备开口的前一刻调 —— 平时调等于挂着一条闲连接。
     */
    public static void prepare() {
        Ready r = ready;
        long now = System.currentTimeMillis();
        if (r != null && !r.dead && (r.sess || now - r.at < 6000)) {
            if (now - r.at < 25000) return;      // 还新鲜，正等着用
        }
        if (r != null) {
            try { r.ws.close(); } catch (Throwable ignored) {}
            ready = null;
        }
        final Ready nr = new Ready();
        nr.sid = "mili" + now;
        nr.params = buildParams(speechRate);
        ready = nr;
        WebSocketClient ws = openWs(nr.sid, nr.params, nr, null);
        if (ws == null) { ready = null; return; }
        nr.ws = ws;
    }

    /* ---------------- 说一句 ---------------- */

    /**
     * 说一句。text 为空直接回调结束。
     * 回调都跑在后台线程，要动 UI 请自己 post。
     */
    public static void say(final String text, final String id, final Sink sink) {
        if (text == null || text.trim().isEmpty()) {
            if (sink != null) sink.onEnd(id);
            return;
        }
        /* 开口之前先把上一句彻底掐掉。
           不这么做的话，上一句已经进了硬件缓冲的尾巴会跟这一句一起响。 */
        stop();

        final Ctx ctx = new Ctx(GEN.incrementAndGet(), id, text, sink);
        active = ctx;
        final String sid = "mili" + System.currentTimeMillis();

        /* 2026-11-06 晚：删掉「短句降回 0 速」那条。
           原来 text.length()<=8 就把 rate 压回 0（正常速），本意是短句别太快，
           结果它把米粒最高频的那几句全拖慢了 ——「好嘞」「我在呢」「哎，我在」
           偏偏全是 8 字以内。老人听到的绝大多数就是这些短句，
           等于整台机器一直是正常速，我调 speechRate 调了个寂寞。
           现在一视同仁，统一用 speechRate。 */
        int rate = speechRate;

        /* 🚨 speech_rate 必须写在 audio_params 里面，写在外层会被服务端静默忽略。
           这是「调了 32、调了 42，老人听着一点没变」的唯一原因 —— 不是调得不够狠，
           是那个数字根本没上桌。2026-11-06 实测（同一段 24 字文本，pcm 24k）：
             外层 42 → 9.83 秒（和 0 速 9.82 秒完全一致，等于没传）
             audio_params 内 42 → 7.06 秒（快 1.39 倍）
             audio_params 内 100 → 4.81 秒（快 2.04 倍）
           探针留在 dup/rate-test.mjs，改语速前后都能重跑对账。 */
        final String params = buildParams(rate);
        /* 打出来，以后老人再说「语速没变」第一眼就能看出发出去的到底是什么。
           2026-11-06 就是缺这一行，才让「顶层写 42」这个错一直藏着。 */
        Log.i(TAG, "say rate=" + rate + " params=" + params);

        /* 预连接正好走到「就等文本」、音色语速也没变 → 直接把文本发过去。
           握手、START_CONN、START_SESSION 三步已经在老人说话那会儿做完了。 */
        Ready r = ready;
        if (r != null && r.sess && !r.dead && params.equals(r.params)
                && System.currentTimeMillis() - r.at < 25000) {
            ready = null;
            OWNER.put(r.ws, ctx);
            try {
                r.ws.send(frame(EV_TASK,
                        "{\"event\":" + EV_TASK + ",\"req_params\":" + insertText(params, ctx.text) + "}", r.sid));
                r.ws.send(frame(EV_FINISH_SESSION, "{\"event\":" + EV_FINISH_SESSION + "}", r.sid));
                Log.i(TAG, "say on prewired conn sid=" + r.sid);
                return;
            } catch (Throwable e) {
                OWNER.remove(r.ws);
                try { r.ws.close(); } catch (Throwable ignored) {}
                Log.w(TAG, "prewired send fail, fallback: " + e);
            }
        }
        WebSocketClient ws = openWs(sid, params, null, ctx);
        if (ws == null) { ctx.fail(); return; }
        /* 看门狗：连上了也把文本发出去了，但十秒内一个音频字节都没回来。
           以前这种情况会一直挂着 —— 不出声、不报错、麦克风还被 ttsSay 关着，
           整台机器看起来就是死了。宁可退回系统 TTS，也不能让老人对着哑巴手机等。 */
        new Thread(new Runnable() {
            @Override public void run() {
                try { Thread.sleep(10000); } catch (InterruptedException ignored) { return; }
                if (!ctx.heard && !ctx.done.get()) {
                    Log.w(TAG, "10 秒没收到音频，兜底失败");
                    ctx.fail();
                }
            }
        }).start();
    }

    /** 一句话的参数。预连接要用同一份去比对，所以抽出来。 */
    private static String buildParams(int rate) {
        return "{\"speaker\":\"" + voice + "\","
                + "\"audio_params\":{\"format\":\"pcm\",\"sample_rate\":" + SR
                + ",\"speech_rate\":" + rate + "}}";
    }

    /**
     * 开一条 ws。ctx 为 null 就是预连接（还没决定要念什么）。
     * 预连接阶段收到的几个事件由 preMsg 处理；一旦 say() 把 ctx 挂进 OWNER，
     * 后面所有消息都按正常那一套走 —— 同一条连接，前后两段身份不同而已。
     */
    private static WebSocketClient openWs(final String sid, final String params,
                                          final Ready pre, final Ctx ctx) {
        try {
            WebSocketClient ws = new WebSocketClient(new URI(URL)) {
                @Override public void onOpen(ServerHandshake h) {
                    Log.i(TAG, "ws open sid=" + sid + " ctx=" + (ctx != null));
                    if (ctx != null && GEN.get() != ctx.gen) {
                        try { close(); } catch (Throwable ignored) {}
                        return;
                    }
                    /* 🚨 2026-11-12 21:05 补上的一个致命遗漏。
                       onMessage 靠 OWNER.get(ws) 找「这条连接的回包该谁处理」：
                       预连接那条在 say() 里 put 过，所以一直好用；
                       而 say() 新建的连接**从来没 put 过** —— 服务端回的
                       ConnectionStarted 进来，OWNER 里查不到，pre 也是 null，
                       两边都不认，消息就直接丢了：START_SESSION 永远发不出去，
                       老人听到的是「一句话都不说」，而 MicGate 已经在 ttsSay 第一行
                       把麦克风关了 —— 于是连「叫我」也不应。
                       现场表现就是「打开不说话、叫它也不理」，一句错都不报。 */
                    if (ctx != null) OWNER.put(this, ctx);
                    send(frame(EV_START_CONN, "{\"event\":" + EV_START_CONN + "}", null));
                }

                @Override public void onMessage(ByteBuffer buf) {
                    byte[] raw = new byte[buf.remaining()];
                    buf.get(raw);
                    Ctx c = OWNER.get(this);
                    if (raw.length > 0) {
                        int t0 = (raw[1] >> 4) & 0x0f, e0 = raw.length > 7 ? ((raw[6] & 0xff) << 8) | (raw[7] & 0xff) : -1;
                        if (t0 != M_AUDIO_SERVER) Log.i(TAG, "msg type=" + t0 + " event=" + e0 + " len=" + raw.length);
                    }
                    if (c != null) { handleMessage(raw, this, sid, params, c); return; }
                    if (pre != null) preMsg(pre, this, sid, params, raw);
                }

                @Override public void onMessage(String s) { /* 不该出现，忽略 */ }

                @Override public void onClose(int code, String reason, boolean remote) {
                    Log.i(TAG, "ws close code=" + code + " remote=" + remote + " reason=" + reason);
                    if (pre != null) pre.dead = true;
                    if (ctx == null) return;
                    if (GEN.get() != ctx.gen) { return; }   // 被打断：这是正常收场，别回调
                    ctx.fail();
                }

                @Override public void onError(Exception e) {
                    Log.w(TAG, "ws error: " + e);
                    if (pre != null) pre.dead = true;
                    if (ctx != null && GEN.get() == ctx.gen) ctx.fail();
                }
            };
            ws.addHeader("X-Api-Key", KEY);
            ws.addHeader("X-Api-Resource-Id", RESOURCE);
            ws.addHeader("X-Api-Connect-Id", sid);
            ws.setConnectionLostTimeout(20);
            ws.connect();
            return ws;
        } catch (Throwable e) {
            Log.w(TAG, "connect fail: " + e);
            return null;
        }
    }

    /** 预连阶段：握手 → 建会话 → 就绪。就绪后停在门口，等 say() 把文本交过来。 */
    private static void preMsg(Ready pre, WebSocketClient ws, String sid, String params, byte[] raw) {
        Object[] m = parse(raw);
        if (m == null) return;
        int type = (Integer) m[0];
        int event = (Integer) m[1];
        if (type == M_ERROR || event == EV_CONN_FAILED || event == EV_SESSION_FAILED) {
            pre.dead = true;
            try { ws.close(); } catch (Throwable ignored) {}
            return;
        }
        if (event == EV_CONN_STARTED) {
            ws.send(frame(EV_START_SESSION,
                    "{\"event\":" + EV_START_SESSION + ",\"req_params\":" + params + "}", sid));
        } else if (event == EV_SESSION_STARTED) {
            pre.sess = true;
            Log.i(TAG, "prewired ready sid=" + sid);
        }
    }

    /** 一句一句话的状态。只允许回调一次 —— 关连接和收尾会同时触发，不挡住会重入。 */
    private static final class Ctx {
        final int gen;
        final String id;
        final String text;
        final Sink sink;
        final java.util.concurrent.atomic.AtomicBoolean done =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        volatile boolean heard = false;
        /* 这一句自己的播放器，别人碰不到 */
        AudioTrack at;
        /* 已经灌进播放器的字节数，用来判断「是不是真播完了」 */
        long written = 0;

        Ctx(int gen, String id, String text, Sink sink) {
            this.gen = gen;
            this.id = id;
            this.text = text;
            this.sink = sink;
        }

        /** 取这一句的播放器，没有就建一条。 */
        AudioTrack track() {
            synchronized (TRACK_LOCK) {
                if (at == null) at = buildTrack();
                return at;
            }
        }

        /** 立刻断掉：已经在缓冲里的声音也一起丢掉。 */
        void kill() {
            synchronized (TRACK_LOCK) {
                if (at == null) return;
                try { at.pause(); } catch (Throwable ignored) {}
                try { at.flush(); } catch (Throwable ignored) {}
                try { at.release(); } catch (Throwable ignored) {}
                at = null;
            }
        }

        /* 服务端说「写完了」不等于「播完了」。
           AudioTrack 里还压着几十到几百毫秒的声音，这时候就回调 onEnd，
           网页会马上派下一句过来，于是新旧两段在喇叭里叠成一片。
           所以先盯着播放头，等真正的出声位置追上写入量，再说这一句完了。 */
        void drainThenEnd() {
            final AudioTrack t = at;
            final long total = written;
            new Thread(new Runnable() {
                @Override public void run() {
                    int waited = 0;
                    while (t != null && GEN.get() == gen && waited < 4000) {
                        long played;
                        try {
                            played = t.getPlaybackHeadPosition() * 2L;   // 单声道 16bit：一帧两字节
                        } catch (Throwable e) {
                            break;
                        }
                        if (played >= total) break;
                        try { Thread.sleep(25); } catch (InterruptedException e) { break; }
                        waited += 25;
                    }
                    end();
                    kill();
                }
            }).start();
        }

        void end() {
            if (done.compareAndSet(false, true)) {
                speaking = false;
                if (active == this) active = null;
                if (sink != null) sink.onEnd(id);
            }
        }

        void fail() {
            if (done.compareAndSet(false, true)) {
                speaking = false;
                if (active == this) active = null;
                /* 断开时也要把播放器收掉：读到一半网断了，剩下的声音不该还在响 */
                kill();
                if (sink != null) {
                    if (heard) sink.onEnd(id); else sink.onFail();
                }
            }
        }
    }

    private static void handleMessage(byte[] raw, WebSocketClient ws, String sid,
                                      String params, Ctx ctx) {
        if (GEN.get() != ctx.gen) {     // 已经被人插嘴打断了，剩下的音频全扔掉
            try { ws.close(); } catch (Throwable ignored) {}
            return;
        }
        Object[] m = parse(raw);
        if (m == null) return;
        int type = (Integer) m[0];
        int event = (Integer) m[1];
        byte[] payload = (byte[]) m[2];

        if (type == M_ERROR || event == EV_CONN_FAILED || event == EV_SESSION_FAILED) {
            Log.w(TAG, "server error: " + new String(payload, UTF8));
            try { ws.close(); } catch (Throwable ignored) {}
            ctx.fail();
            return;
        }

        if (event == EV_CONN_STARTED) {
            String sj = "{\"event\":" + EV_START_SESSION + ",\"req_params\":" + params + "}";
            ByteBuffer fb = frame(EV_START_SESSION, sj, sid);
            int flen = fb.remaining();
            try {
                ws.send(fb);
                Log.i(TAG, "START_SESSION 已发 len=" + flen + " sid=" + sid);
            } catch (Throwable e) {
                Log.w(TAG, "START_SESSION 发送异常 " + e);
            }
        } else if (event == EV_SESSION_STARTED) {
            ws.send(frame(EV_TASK,
                    "{\"event\":" + EV_TASK + ",\"req_params\":" + insertText(params, ctx.text) + "}", sid));
            ws.send(frame(EV_FINISH_SESSION,
                    "{\"event\":" + EV_FINISH_SESSION + "}", sid));
        } else if (type == M_AUDIO_SERVER || event == EV_TTS_RESPONSE) {
            if (payload.length > 0) {
                if (!ctx.heard) {
                    ctx.heard = true;
                    speaking = true;
                    if (ctx.sink != null) ctx.sink.onStart();
                }
                AudioTrack t = ctx.track();
                int off = 0;
                try {
                    if (t.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) t.play();
                    /* 必须整块写完。write 只写一半就返回时剩下的音频就丢了，
                       一句话中间会突然少几个字。 */
                    while (off < payload.length && GEN.get() == ctx.gen) {
                        int n = t.write(payload, off, payload.length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                } catch (Throwable e) {
                    Log.w(TAG, "write fail: " + e);
                    return;
                }
                ctx.written += Math.max(0, off);
            }
        } else if (event == EV_SESSION_FINISHED) {
            ws.send(frame(EV_FINISH_CONN, "{\"event\":" + EV_FINISH_CONN + "}", null));
        } else if (event == EV_CONN_FINISHED) {
            try { ws.close(); } catch (Throwable ignored) {}
            /* 不能直接 end —— 播放器里还有没响完的声音 */
            ctx.drainThenEnd();
        }
    }

    /** 把 text 塞进已经拼好的 params 字符串里（避免为了一个字段重建整个 JSON）。 */
    private static String insertText(String params, String text) {
        String esc = text.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ");
        return params.substring(0, params.length() - 1) + ",\"text\":\"" + esc + "\"}";
    }
}
