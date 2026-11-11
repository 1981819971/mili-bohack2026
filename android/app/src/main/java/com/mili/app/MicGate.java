package com.mili.app;

/**
 * 麦克风总闸。
 *
 * 解决的问题：「它把自己的声音也录进去了」。
 * 米粒说话走的是同一个喇叭，麦克风就在旁边 —— 不加闸的话，
 * 它念完一句，识别器又把这句话当成用户在说话，于是自问自答、越说越乱。
 * （实测日志里就出现过：米粒说完「哎，我在」，紧接着识别出「我在」。）
 *
 * 所以：TTS 一开口就关闸，说完再开。Kws（唤醒）和 Asr（识别）都要看这个闸。
 * 光靠 AEC 不够 —— 回声消除在手机喇叭外放、音量大的时候消不干净。
 */
public class MicGate {

    /** 正在出声。true 时任何录音都不喂给模型。 */
    private static volatile boolean speaking = false;

    /** 上一次关闸的时刻。Asr 用它判断「播报刚开始那 1.2 秒别误判打断」。 */
    private static volatile long shutAt = 0;

    public static void shut() {
        if (!speaking) shutAt = System.currentTimeMillis();
        speaking = true;
    }

    public static void open() { speaking = false; }

    public static boolean isSpeaking() { return speaking; }

    /** 距离上次关闸过了多少毫秒。没关过闸就返回一个很大的数。 */
    public static long sinceShut() {
        long t = shutAt;
        if (t <= 0) return Long.MAX_VALUE / 4;
        return System.currentTimeMillis() - t;
    }
}
