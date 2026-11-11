package com.mili.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 通话中的「挂断」和「扬声器」。
 *
 * 为什么必须走广播，而不是我们 App 页面上的按钮：
 * 微信的通话界面在它自己的 Activity 里。我们 App 一旦到前台，通话界面就被顶掉
 * —— 实测切过去 2 秒后 VideoActivity 直接没了，手势会点在我们自己页面上。
 * 通知栏里的动作按钮用广播触发，不抢前台，手势才能落在微信通话界面上。
 *
 * 动作名故意写成我们自己的包名，避免和别的 App 撞。
 */
public class HangupReceiver extends BroadcastReceiver {

    public static final String A_HANGUP = "com.mili.app.HANGUP";
    public static final String A_SPEAKER = "com.mili.app.SPEAKER";
    /** 自测用：让手机自己念一句话，用来验证「喊米粒」能不能被听到（喇叭 → 麦克风） */
    public static final String A_SAY = "com.mili.app.SAY";
    /** 自测用：把麦克风闸强行打开（正常流程由 TTS 起落控制） */
    public static final String A_GATE = "com.mili.app.GATE";
    public static final int NID = 7701;

    @Override
    public void onReceive(Context ctx, Intent it) {
        String a = it == null ? null : it.getAction();

        if (A_GATE.equals(a)) {
            boolean on = it.getBooleanExtra("on", true);
            if (on) MicGate.open(); else MicGate.shut();
            return;
        }

        if (A_SAY.equals(a)) {
            String t = it.getStringExtra("t");
            say(ctx, t == null ? "米粒" : t);
            return;
        }

        WxFlow f = MiliAccessibilityService.wx();
        Log.i("MiliWx", "收到广播 " + a + " flow=" + (f != null));
        if (f == null) return;

        if (A_HANGUP.equals(a)) {
            f.hangup();
            try {
                NotificationManager nm = (NotificationManager)
                        ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                nm.cancel(NID);
            } catch (Throwable ignored) {}
        } else if (A_SPEAKER.equals(a)) {
            f.speaker();
        }
    }

    private void say(final Context ctx, final String t) {
        final android.speech.tts.TextToSpeech[] h = new android.speech.tts.TextToSpeech[1];
        h[0] = new android.speech.tts.TextToSpeech(ctx, new android.speech.tts.TextToSpeech.OnInitListener() {
            @Override public void onInit(int st) {
                if (st != android.speech.tts.TextToSpeech.SUCCESS) {
                    Log.i("MiliKws", "自测朗读：TTS 起不来 " + st);
                    return;
                }
                h[0].setLanguage(java.util.Locale.CHINA);
                h[0].setSpeechRate(0.9f);
                h[0].speak(t, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "selftest");
                Log.i("MiliKws", "自测朗读：" + t);
            }
        });
    }
}
