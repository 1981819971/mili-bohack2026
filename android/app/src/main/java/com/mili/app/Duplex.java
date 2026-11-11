package com.mili.app;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.util.Base64;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayDeque;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 豆包端到端实时语音（Seeduplex）—— 全双工那一套。
 *
 * 和旧的 Asr.java 的根本区别：
 *   旧的：开麦 → 端点检测 → 收一句 → 关麦 → 想 → 念。每一步之间都有一道门。
 *   新的：麦一直开，音频一直上行，模型自己判断你在说、说完了、还是插嘴。
 *        麦克风永不关，这就是"连贯"的物理基础。
 *
 * 三个容易翻车的点，都在代码里标了：
 *   ① 回声。外放 + 开麦 = 它听见自己。必须开 AEC，且必须走 MODE_IN_COMMUNICATION。
 *   ② 节奏。官方要求 20ms 一包（640 字节）按实时节奏发，快了慢了都报错。
 *      所以不能用定时器，直接阻塞读 AudioRecord —— 它天然就是实时节奏。
 *   ③ 断连。必须 session.close 并收到回复才关，直接断会 55000001。
 */
public class Duplex {

    private static final String WSS = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
    private static final int IN_RATE = 16000;
    private static final int OUT_RATE = 24000;
    private static final int PKT = 640;          // 20ms @16k s16 mono

    public interface Cb {
        /** 除音频以外的事件，原样转给 JS。音频在原生侧直接播，不过桥。 */
        void onEvent(String json);
    }

    private static volatile boolean on = false;
    private static WebSocketClient ws;
    private static AudioRecord rec;
    private static AudioTrack trk;
    private static Thread micT, playT;
    private static Cb cb;
    private static Context appCtx;
    private static AudioManager am;
    private static AcousticEchoCanceler aec;
    private static NoiseSuppressor ns;
    private static AutomaticGainControl agc;

    private static final AtomicBoolean speaking = new AtomicBoolean(false);
    /** 下行音频队列。有界，超了丢最老的 —— 宁可少听半句，不要越说越滞后。 */
    private static final ArrayDeque<byte[]> playQ = new ArrayDeque<>();
    private static final int PLAYQ_MAX = 60;      // 60 × 20ms ≈ 1.2s

    public static boolean isOn() { return on; }
    public static boolean isSpeaking() { return speaking.get(); }

    /* ======================================================================
     * 开局
     * ==================================================================== */
    public static void start(Context ctx, final String key, final String voice,
                             final String instructions, final String toolsJson, Cb c) {
        if (on) return;
        appCtx = ctx.getApplicationContext();
        cb = c;
        on = true;

        try {
            ws = new WebSocketClient(new URI(WSS)) {
                @Override public void onOpen(ServerHandshake h) {
                    post("{\"type\":\"ws.open\"}");
                    createSession(key, voice, instructions, toolsJson);
                }
                @Override public void onMessage(String msg) { route(msg); }
                @Override public void onClose(int code, String reason, boolean remote) {
                    on = false;
                    post("{\"type\":\"ws.close\",\"code\":" + code + ",\"reason\":"
                            + JSONObject.quote(reason == null ? "" : reason) + "}");
                }
                @Override public void onError(Exception e) {
                    post("{\"type\":\"ws.error\",\"msg\":"
                            + JSONObject.quote(e == null ? "?" : String.valueOf(e.getMessage())) + "}");
                }
            };
            ws.addHeader("X-Api-Key", key);
            ws.addHeader("X-Api-Resource-Id", "volc.speech.dialog");
            ws.addHeader("X-Api-Connect-Id", "mili-" + System.currentTimeMillis());
            /* 关掉自带的心跳：服务端不认它的 ping，60 秒会误判断线 */
            ws.setConnectionLostTimeout(0);
            ws.connect();
        } catch (Exception e) {
            on = false;
            post("{\"type\":\"ws.error\",\"msg\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
        }
    }

    private static void createSession(String key, String voice, String instructions, String toolsJson) {
        try {
            JSONObject input = new JSONObject()
                    .put("format", new JSONObject().put("type", "pcm").put("rate", IN_RATE));
            JSONObject output = new JSONObject()
                    .put("format", new JSONObject().put("type", "pcm_s16le").put("rate", OUT_RATE));
            JSONObject audio = new JSONObject()
                    .put("input", input)
                    .put("output", output)
                    .put("voice", voice)
                    .put("speed", -4)      // 慢一点，老人听得清
                    .put("loudness", 0);

            JSONObject s = new JSONObject()
                    .put("model", "1.2.6.1")
                    .put("instructions", instructions == null ? "" : instructions)
                    .put("audio", audio);

            if (toolsJson != null && toolsJson.length() > 2) {
                try { s.put("tools", new JSONArray(toolsJson)); } catch (Exception ignore) {}
            }

            send(new JSONObject().put("type", "session.create").put("session", s));
        } catch (Exception e) {
            post("{\"type\":\"ws.error\",\"msg\":" + JSONObject.quote("建会话失败: " + e.getMessage()) + "}");
        }
    }

    /* ======================================================================
     * 下行事件
     * ==================================================================== */
    private static void route(String msg) {
        String type = "";
        try {
            JSONObject o = new JSONObject(msg);
            type = o.optString("type", "");

            if ("session.created".equals(type)) {
                String sid = o.optJSONObject("session") != null
                        ? o.optJSONObject("session").optString("id", "") : "";
                post("{\"type\":\"session.created\",\"id\":" + JSONObject.quote(sid) + "}");
                openAudio();
                return;
            }

            if ("response.output_audio.delta".equals(type)) {
                if (!speaking.getAndSet(true)) post("{\"type\":\"say.start\"}");
                String b64 = o.optString("delta", "");
                if (b64.isEmpty()) b64 = o.optString("audio", "");
                if (!b64.isEmpty()) {
                    byte[] pcm = Base64.decode(b64, Base64.DEFAULT);
                    synchronized (playQ) {
                        while (playQ.size() >= PLAYQ_MAX) playQ.pollFirst();
                        playQ.addLast(pcm);
                        playQ.notifyAll();
                    }
                }
                return;   // 音频不过桥
            }

            if ("response.output_audio.done".equals(type)) {
                post("{\"type\":\"say.end\"}");
                return;
            }

            /* 工具调用 —— 这条必须送到 JS，工具都是 JS 那边实现的 */
            if ("response.function_call_arguments.done".equals(type)) {
                post(msg);
                return;
            }

            if ("error".equals(type)) {
                post(msg);
                return;
            }

            post(msg);
        } catch (Exception e) {
            post("{\"type\":\"parse.error\",\"raw\":" + JSONObject.quote(type) + "}");
        }
    }

    private static void post(String json) {
        if (cb != null) {
            try { cb.onEvent(json); } catch (Exception ignore) {}
        }
    }

    private static void send(JSONObject o) {
        try {
            if (ws != null && ws.isOpen()) ws.send(o.toString());
        } catch (Exception ignore) {}
    }

    /* ======================================================================
     * 音频
     * ==================================================================== */
    private static void openAudio() {
        if (!on) return;
        try {
            am = (AudioManager) appCtx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                am.setSpeakerphoneOn(true);
            }

            /* 播放端。24k 单声道 s16，缓冲给 2 倍最小，太小会断，太大会滞后。 */
            int outMin = AudioTrack.getMinBufferSize(OUT_RATE,
                    AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            trk = new AudioTrack.Builder()
                    .setAudioAttributes(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(OUT_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(Math.max(outMin * 2, 8192))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            trk.play();

            /* 采集端。VOICE_COMMUNICATION 是为了让系统把这条流的回声消掉 ——
               换成 MIC 或 VOICE_RECOGNITION，AEC 基本不生效，它就自己跟自己聊起来了。 */
            int inMin = AudioRecord.getMinBufferSize(IN_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int buf = Math.max(inMin * 2, PKT * 8);
            rec = tryRec(MediaRecorder.AudioSource.VOICE_COMMUNICATION, buf);
            if (rec == null) rec = tryRec(MediaRecorder.AudioSource.MIC, buf);
            if (rec == null) {
                post("{\"type\":\"mic.error\",\"msg\":\"麦克风打不开\"}");
                return;
            }
            rec.startRecording();

            int sid = rec.getAudioSessionId();
            try {
                if (AcousticEchoCanceler.isAvailable()) {
                    aec = AcousticEchoCanceler.create(sid);
                    if (aec != null) aec.setEnabled(true);
                }
            } catch (Exception ignore) {}
            try {
                if (NoiseSuppressor.isAvailable()) {
                    ns = NoiseSuppressor.create(sid);
                    if (ns != null) ns.setEnabled(true);
                }
            } catch (Exception ignore) {}
            /* AGC 先不开：老人声音本来就不大，自动增益会把底噪一起抬上来，
               而豆包那边对底噪很敏感（<-50dBFS），开了反而更差。 */
            agc = null;

            post("{\"type\":\"audio.open\",\"aec\":" + (aec != null) + ",\"ns\":" + (ns != null) + "}");

            startMic();
            startPlay();
        } catch (Exception e) {
            post("{\"type\":\"audio.error\",\"msg\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
        }
    }

    private static AudioRecord tryRec(int src, int buf) {
        try {
            AudioRecord r = new AudioRecord(src, IN_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
            if (r.getState() == AudioRecord.STATE_INITIALIZED) return r;
            r.release();
        } catch (Exception ignore) {}
        return null;
    }

    /** 麦克风线程：阻塞读，天然就是 20ms 一包的实时节奏，不用定时器。 */
    private static void startMic() {
        micT = new Thread(() -> {
            byte[] buf = new byte[PKT];
            while (on && rec != null) {
                int n;
                try { n = rec.read(buf, 0, PKT); } catch (Exception e) { break; }
                if (n <= 0) { safeSleep(20); continue; }
                if (!on) break;
                byte[] out = (n == PKT) ? buf : java.util.Arrays.copyOf(buf, n);
                try {
                    send(new JSONObject().put("type", "input_audio_buffer.append")
                            .put("audio", Base64.encodeToString(out, Base64.NO_WRAP)));
                } catch (Exception ignore) {}
            }
        }, "mili-duplex-mic");
        micT.setPriority(Thread.MAX_PRIORITY);
        micT.start();
    }

    /** 播放线程：从队列取 PCM 写 AudioTrack。写是阻塞的，写多久就是放多久。 */
    private static void startPlay() {
        playT = new Thread(() -> {
            while (on) {
                byte[] pcm = null;
                synchronized (playQ) {
                    if (playQ.isEmpty()) {
                        try { playQ.wait(80); } catch (InterruptedException e) { break; }
                        if (playQ.isEmpty()) {
                            if (speaking.get()) { speaking.set(false); post("{\"type\":\"say.done\"}"); }
                            continue;
                        }
                    }
                    pcm = playQ.pollFirst();
                }
                if (pcm == null || trk == null) continue;
                try { trk.write(pcm, 0, pcm.length); } catch (Exception e) { break; }
            }
        }, "mili-duplex-play");
        playT.setPriority(Thread.MAX_PRIORITY);
        playT.start();
    }

    /* ======================================================================
     * 工具回传
     * ==================================================================== */
    /** JS 把工具跑完，结果按 call_id 送回来。 */
    public static void toolResult(String callId, String json) {
        try {
            JSONArray content = new JSONArray().put(
                    new JSONObject().put("type", "text").put("text", json == null ? "{}" : json));
            JSONObject item = new JSONObject()
                    .put("role", "tool")
                    .put("call_id", callId)
                    .put("content", content);
            send(new JSONObject().put("type", "conversation.item.create").put("item", item));
        } catch (Exception ignore) {}
    }

    /** 老人插嘴：主动打断它正在说的这句。 */
    public static void cancelSay() {
        clearQ();
        speaking.set(false);
        send0("{\"type\":\"response.cancel\"}");
    }

    /** 让模型主动说一句（开机问候之类）。 */
    public static void kick(String text) {
        try {
            JSONArray content = new JSONArray().put(
                    new JSONObject().put("type", "text").put("text", text));
            JSONObject item = new JSONObject()
                    .put("role", "user")
                    .put("content", content);
            send(new JSONObject().put("type", "conversation.item.create").put("item", item));
            send(new JSONObject().put("type", "response.create"));
        } catch (Exception ignore) {}
    }

    private static void send0(String raw) {
        try { if (ws != null && ws.isOpen()) ws.send(raw); } catch (Exception ignore) {}
    }

    private static void clearQ() {
        synchronized (playQ) { playQ.clear(); }
        if (trk == null) return;
        try { trk.pause(); trk.flush(); trk.play(); } catch (Exception ignore) {}
    }

    /* ======================================================================
     * 收工
     * ==================================================================== */
    public static void stop() {
        if (!on) return;
        on = false;

        /* 先文明告别，再断。直接断会 55000001 ContextCanceled。 */
        send0("{\"type\":\"session.close\"}");
        safeSleep(220);

        try { if (micT != null) micT.interrupt(); } catch (Exception ignore) {}
        try { if (playT != null) playT.interrupt(); } catch (Exception ignore) {}
        micT = null; playT = null;

        try { if (rec != null) { rec.stop(); } } catch (Exception ignore) {}
        try { if (rec != null) rec.release(); } catch (Exception ignore) {}
        rec = null;

        try { if (trk != null) { trk.stop(); } } catch (Exception ignore) {}
        try { if (trk != null) trk.release(); } catch (Exception ignore) {}
        trk = null;

        try { if (aec != null) { aec.setEnabled(false); aec.release(); } } catch (Exception ignore) {}
        try { if (ns != null) { ns.setEnabled(false); ns.release(); } } catch (Exception ignore) {}
        aec = null; ns = null; agc = null;

        try { if (am != null) am.setMode(AudioManager.MODE_NORMAL); } catch (Exception ignore) {}

        try { if (ws != null) ws.close(); } catch (Exception ignore) {}
        ws = null;
        clearQ();
        speaking.set(false);
        post("{\"type\":\"duplex.stop\"}");
    }

    private static void safeSleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignore) {}
    }
}
