package com.mili.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 云端识别：录音 → 传到自己的服务器 → 服务器用大模型（FunASR / FireRedASR2 / Whisper 任选）听。
 *
 * 为什么换掉手机上的离线小模型：
 * 手机上那些 100MB 以内的模型，中文人名几乎必错（实测「王炳皓」听成「王浩」）。
 * 服务器上跑的是工业级模型（FireRedASR2-AED 在中文公开测试集上错字率 0.5~3%），
 * 差的是一个数量级 —— 这不是调参能补的，是模型大小和训练数据量的差距。
 *
 * 只在「用户点了说话」或「被唤醒之后」这两段录音，不常驻上传，隐私和流量都可控。
 * 传的是 16k 单声道 16bit，一句话大概 30~120KB。
 */
public class CloudAsr {

    private static final String TAG = "MiliCloudAsr";
    private static final String SP = "mili_asr";

    /** 服务器地址，形如 https://your-server/asr ；空表示没配，退回离线 */
    public static String endpoint(Context c) {
        SharedPreferences sp = c.getSharedPreferences(SP, Context.MODE_PRIVATE);
        return sp.getString("endpoint", "").trim();
    }

    public static void setEndpoint(Context c, String url) {
        c.getSharedPreferences(SP, Context.MODE_PRIVATE).edit()
                .putString("endpoint", url == null ? "" : url.trim()).apply();
    }

    public static boolean configured(Context c) {
        String e = endpoint(c);
        return e.startsWith("http");
    }

    public interface Back { void done(String text, boolean ok); }

    /** 录一句（不说话超时就收），上传，回文字。 */
    public static void listenOnce(final Context ctx, final Back cb) {
        new Thread(new Runnable() {
            @Override public void run() {
                AudioRecord ar = null;
                try {
                    final int SR = 16000;
                    final int CH = 1600;
                    int min = AudioRecord.getMinBufferSize(SR,
                            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    ar = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                            SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                            Math.max(min * 2, CH * 8));
                    if (ar.getState() != AudioRecord.STATE_INITIALIZED) {
                        cb.done("", false);
                        return;
                    }
                    try {
                        if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                            android.media.audiofx.AcousticEchoCanceler aec =
                                    android.media.audiofx.AcousticEchoCanceler.create(ar.getAudioSessionId());
                            if (aec != null) aec.setEnabled(true);
                        }
                    } catch (Throwable ignored) {}
                    ar.startRecording();

                    short[] buf = new short[CH];
                    ByteArrayOutputStream pcm = new ByteArrayOutputStream();
                    long t0 = System.currentTimeMillis();
                    long lastVoice = t0;
                    boolean heard = false;
                    final float TH = 0.0025f;

                    while (System.currentTimeMillis() - t0 < 20000) {
                        /* 米粒自己在说话时录到的是它自己（实测把它那句「说吧」原样传了回来）。
                           等它说完再开始收。 */
                        if (MicGate.isSpeaking()) { t0 = System.currentTimeMillis(); Thread.sleep(60); continue; }
                        int n = ar.read(buf, 0, CH);
                        if (n <= 0) { Thread.sleep(20); continue; }
                        double sum = 0;
                        for (int i = 0; i < n; i++) { double v = buf[i] / 32768.0; sum += v * v; }
                        double rms = Math.sqrt(sum / Math.max(1, n));
                        if (rms > TH) { heard = true; lastVoice = System.currentTimeMillis(); }
                        if (heard) for (int i = 0; i < n; i++) {
                            pcm.write(buf[i] & 0xff);
                            pcm.write((buf[i] >> 8) & 0xff);
                        }
                        if (heard && System.currentTimeMillis() - lastVoice > 1200) break;
                        if (!heard && System.currentTimeMillis() - t0 > 8000) break;
                    }
                    ar.stop();
                    ar.release();
                    ar = null;

                    byte[] raw = pcm.toByteArray();
                    if (!heard || raw.length < SR) { cb.done("", true); return; }

                    String text = post(ctx, wav(raw, SR), SR);
                    f(ctx, "云端返回：" + text);
                    cb.done(text == null ? "" : text, text != null);
                } catch (Throwable t) {
                    f(ctx, "云端识别出错 " + t);
                    cb.done("", false);
                } finally {
                    if (ar != null) { try { ar.release(); } catch (Throwable ignored) {} }
                }
            }
        }, "mili-cloud-asr").start();
    }

    /* ================= 上传 ================= */

    private static String post(Context ctx, byte[] wav, int sr) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(endpoint(ctx));
            c = (HttpURLConnection) u.openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(6000);
            c.setReadTimeout(20000);
            String b = "----mili" + System.currentTimeMillis();
            c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + b);
            c.setRequestProperty("X-Sample-Rate", String.valueOf(sr));

            OutputStream os = c.getOutputStream();
            DataOutputStream w = new DataOutputStream(os);
            w.writeBytes("--" + b + "\r\n");
            w.writeBytes("Content-Disposition: form-data; name=\"audio\"; filename=\"a.wav\"\r\n");
            w.writeBytes("Content-Type: audio/wav\r\n\r\n");
            w.write(wav);
            w.writeBytes("\r\n--" + b + "--\r\n");
            w.flush();
            w.close();

            int code = c.getResponseCode();
            if (code != 200) { f(ctx, "服务器回 " + code); return null; }
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String ln;
            while ((ln = r.readLine()) != null) sb.append(ln);
            r.close();
            return parse(sb.toString());
        } catch (Throwable t) {
            f(ctx, "上传失败 " + t);
            return null;
        } finally {
            if (c != null) try { c.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** 只要能取出 text，不管服务端返回 {"text":..} 还是 {"data":{"text":..}} */
    private static String parse(String json) {
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            if (o.has("text")) return o.optString("text", "");
            if (o.has("data")) {
                Object d = o.get("data");
                if (d instanceof org.json.JSONObject) return ((org.json.JSONObject) d).optString("text", "");
                if (d instanceof String) return (String) d;
            }
            if (o.has("result")) return o.optString("result", "");
            return "";
        } catch (Throwable t) {
            return json == null ? "" : json.trim();
        }
    }

    private static byte[] wav(byte[] pcm, int sr) {
        int len = pcm.length;
        byte[] h = new byte[44];
        long total = len + 36;
        h[0]='R'; h[1]='I'; h[2]='F'; h[3]='F';
        h[4]=(byte)(total&0xff); h[5]=(byte)((total>>8)&0xff); h[6]=(byte)((total>>16)&0xff); h[7]=(byte)((total>>24)&0xff);
        h[8]='W'; h[9]='A'; h[10]='V'; h[11]='E'; h[12]='f'; h[13]='m'; h[14]='t'; h[15]=' ';
        h[16]=16; h[20]=1; h[22]=1;
        h[24]=(byte)(sr&0xff); h[25]=(byte)((sr>>8)&0xff); h[26]=(byte)((sr>>16)&0xff); h[27]=(byte)((sr>>24)&0xff);
        int br = sr * 2;
        h[28]=(byte)(br&0xff); h[29]=(byte)((br>>8)&0xff); h[30]=(byte)((br>>16)&0xff); h[31]=(byte)((br>>24)&0xff);
        h[32]=2; h[34]=16;
        h[36]='d'; h[37]='a'; h[38]='t'; h[39]='a';   // 少了这四个字母，服务端解不出 wav（实测报 fmt/data chunk missing）
        h[40]=(byte)(len&0xff); h[41]=(byte)((len>>8)&0xff); h[42]=(byte)((len>>16)&0xff); h[43]=(byte)((len>>24)&0xff);
        byte[] out = new byte[44 + len];
        System.arraycopy(h, 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, len);
        return out;
    }

    private static void f(Context ctx, String s) {
        Log.i(TAG, s);
        try {
            File file = new File(ctx.getExternalFilesDir(null), "kws.log");
            FileWriter w = new FileWriter(file, true);
            w.write(new SimpleDateFormat("HH:mm:ss.SSS", Locale.CHINA).format(new Date()) + " [cloud] " + s + "\n");
            w.close();
        } catch (Throwable ignored) {}
    }
}
