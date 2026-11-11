package com.mili.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.util.Log;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.animation.ObjectAnimator;


import java.util.ArrayList;
import java.util.Locale;

/**
 * 桌宠服务：米粒常驻在桌面上，不打开 App 也能说话。
 *
 * 三件事：
 * 1. 悬浮窗（一只会呼吸的小鸡，能拖走，点一下弹对话）
 * 2. 常驻唤醒（听到「米粒」就冒出来）
 * 3. 吃药提醒（到点自己跳出来喊）
 *
 * 为什么用 ImageView 而不是 WebView：
 * 实测这台 MIUI 上「透明 overlay + WebView」窗口加上了、图也加载了（日志 confirmed），
 * 就是一个像素都不画。WebView 进悬浮窗本来就脆，静态精灵没必要绕这一圈。
 * 换成 ImageView + ObjectAnimator，稳、轻、一改就出来。
 */
public class MilService extends Service {

    private static final String TAG = "MiliPet";

    public static final String ACTION_START = "com.mili.app.START";
    public static final String ACTION_STOP = "com.mili.app.STOP";
    public static final String ACTION_WAKE = "com.mili.app.WAKE";
    public static final String ACTION_MED = "com.mili.app.MED";
    /* 让桌宠冒一句话，不切到 App —— 看电视、看视频的时候用它 */
    public static final String ACTION_SAY = "com.mili.app.SAY";

    private WindowManager wm;
    private ImageView pet;
    private FrameLayout bubbleWin;
    private WindowManager.LayoutParams blp;
    private TextView bubble;
    private FrameLayout root;
    private WindowManager.LayoutParams lp;
    private boolean shown = false;
    private boolean petWatchOn = false;
    private boolean frontWatchOn = false;
    private boolean appFront = false;   // 米粒自己的界面在前台时，桌宠让位
    private int PET_PX = 190;           // 悬浮窗边长（物理 px），拖动限界要用
    private static final int BUB_W = 420, BUB_H = 150;   // 气泡窗尺寸

    /* 静态的「App 现在在前台吗」。
       为什么非要有它：onResume 里调 setAppForeground(true) 的时候，前台服务往往才刚
       startForegroundService 出去，INST 还是 null，那次调用直接 return 了；等 showPet
       真把窗口挂上去时，appFront 又回到默认 false —— 结果 App 里永远悬着一只鸡，
       而且那是个 340×340 的真窗口，隐藏时也照吃触摸，正好压住按钮右半边。
       所以用一个不依赖 INST 的静态标记，建窗时以它为准。 */
    public static volatile boolean foregroundNow = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private static MilService INST;
    /** 用户要说话时先让麦克风：MainActivity 在同一个进程里，直接喊一声就行 */
    public static void pauseWake() {
        MilService s = INST;
        /* 2026-11-10：这两个 null 以前是静默的，真机查「没人应」时看不出
           到底没让麦、还是根本没走到——白白多查两小时。现在都留一行。 */
        if (s == null) { Log.i(TAG, "pauseWake：服务还没起来，唤醒的麦没让出来"); return; }
        if (s.kws == null) { Log.i(TAG, "pauseWake：kws 还没建，唤醒的麦没让出来"); return; }
        s.kws.pause();
    }
    public static void resumeWake() {
        MilService s = INST;
        if (s == null || s.kws == null) return;
        /* 2026-11-10：真机日志里 5 毫秒内被连调 3 次 resume，
           KWS 200ms 就把麦克风抢回去，在线识别一帧真音频都读不到。
           只要连续对话还开着（Asr.cvMode），麦克风就归它，唤醒别来抢。 */
        if (Asr.cvMode) { Log.i(TAG, "resumeWake：连续对话还占着麦，先不收回"); return; }
        s.kws.resume();
    }

    private long holdUntil = 0;      // 自己说话时别把自己唤醒

    private Kws kws;                 // 离线唤醒（本地模型，24 小时听着）
    private boolean cmdArmed = false;
    /** 唤醒被暂停已经持续了几个 1.5 秒刻度。到 7 就认定是误暂停，硬收回。 */
    private int pausedTicks = 0;

    private TextToSpeech tts;
    private boolean ttsReady = false;

    @Override
    public void onCreate() {
        super.onCreate();
        INST = this;
        /* 先把前台通知挂上，再去干 TTS 初始化和唤醒词这些耗时的事。
           系统给 startForegroundService 的死线只有 5 秒，
           等到 onStartCommand 排队排到才调 startForeground，机器一慢就超时被杀。
           这里先占位（不带麦克风类型），onStartCommand 里再按需升级类型。 */
        /* 22:52 真机日志：不带类型的 startForeground 在这台 Android 16 上必抛
           SecurityException（manifest 里声明了 specialUse，系统要求
           FOREGROUND_SERVICE_SPECIAL_USE）。onStartCommand 后来带 microphone
           类型重试才成功 —— 等于每次冷启动都白崩一次、还留一条异常日志。
           这里直接按 onStartCommand 同一套写法起，退路也留着。 */
        try {
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                startForeground(7, buildNotice(),
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(7, buildNotice());
            }
        } catch (Exception e) {
            try { startForeground(7, buildNotice()); }
            catch (Exception e2) { Log.i(TAG, "onCreate 前台化失败 " + e2); }
        }
        Waker.schedule(this);          // 被清掉也能自己爬起来
        A11yKeeper.startTicker(this);  // 无障碍掉线自动接回去（MIUI 强停会抹掉它）
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        initTts();
        /* 跌落检测：手机自己发现，不靠老人开口（2026-11-10 菲尔特要求）。
           挂在常驻服务里，因为它必须比页面活得久 —— 老人摔的时候不会先打开 App。 */
        try {
            FallDetect.start(this, new FallDetect.Listener() {
                @Override public void onFallSuspected(float g) { onFall(g); }
            });
        } catch (Throwable t) { Log.i(TAG, "跌落检测没起来 " + t); }
        /* 开机一律按老人端来：唤醒要起、桌宠要显示。
           2026-11-08 事故复盘：以前这里读 family_mode，一次测试残留让它变成 false，
           开机后桌宠消失、喊米粒没反应 —— 一个临时 UI 状态不该决定系统级行为。 */
        /* 2026-11-09 22:15 菲尔特：「怎么一直在录音，不是说好只有叫它它才
           录音和说话吗」。设置里给一颗真开关「喊米粒唤醒」：关掉后
           本地 KWS 也不许起、麦克风彻底不占，开机重启也不自己回来。 */
        SharedPreferences sp = getSharedPreferences("mili", MODE_PRIVATE);
        /* 22:34 那版有回归：切一次家人端就把 wake_on 误写成 false 并落盘。
           已经中招的设备升级到本版时，用一次性版本戳把毒值复位成默认「开」；
           之后用户亲手拨的开关照常持久化，不再被这次迁移覆盖。 */
        if (!sp.getBoolean("wake_pref_v2", false)) {
            sp.edit().putBoolean("wake_on", true).putBoolean("wake_pref_v2", true).apply();
            Log.i(TAG, "升级迁移：清掉家人端误写的 wake_on=false");
        }
        wakeOn = sp.getBoolean("wake_on", true);
        if (wakeOn) startWake();
        else Log.i(TAG, "设置里关了语音唤醒，本地麦克风不启动");
    }

    @Override
    public int onStartCommand(Intent it, int flags, int startId) {
        String a = it == null ? ACTION_START : (it.getAction() == null ? ACTION_START : it.getAction());
        if (ACTION_STOP.equals(a)) { stopSelf(); return START_NOT_STICKY; }

        boolean fg = false;
        try {
            /* 必须带上 microphone 这个前台服务类型。
               以前只写了 specialUse，结果系统把录音权限判成「仅前台可用」
               （appops 显示 RECORD_AUDIO: foreground），常驻唤醒在后台根本拿不到麦克风，
               表现就是「叫米粒没反应」。 */
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                startForeground(7, buildNotice(),
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(7, buildNotice());
            }
            fg = true;
        } catch (Exception e) {
            Log.i(TAG, "前台化失败（带麦克风类型）" + e);
        }
        /* 降级：不带类型再试一次。
           Android 12+ 在录音权限被拒 / 被清时，带 MICROPHONE 类型会抛 SecurityException。
           以前这个异常被 catch 吞掉，就再也没调用过 startForeground ——
           系统等 5 秒直接杀进程报 ForegroundServiceDidNotStartInTimeException。
           2026-11-06 模拟器清数据后实测崩过一次，就是这条路径。 */
        if (!fg) {
            try { startForeground(7, buildNotice()); fg = true; }
            catch (Exception e2) { Log.i(TAG, "前台化失败（无类型）" + e2); }
        }
        /* 两种都成不了就别硬留着：停在「已请求前台但没前台」的状态必崩。 */
        if (!fg) { stopSelf(); return START_NOT_STICKY; }
        if (!shown) showPet();

        if (ACTION_WAKE.equals(a)) {
            wakeUp();
        } else if (ACTION_MED.equals(a)) {
            String say = it.getStringExtra("say");
            wakeUp();
            sayIt(say == null ? "该吃药啦！" : say);
        } else if (ACTION_SAY.equals(a)) {
            /* 只冒气泡 + 出声，不 wakeUp、不抢焦点 —— 老人正在看视频，别把界面抢走。
               红包汇报光有气泡不够：他在看电视，根本不会盯桌宠，必须念出来。 */
            String say = it.getStringExtra("say");
            /* 气泡照旧；声音由前端 speak() 的童声片段经 playVoice 播，
               这里再念一遍系统 TTS 会叠成两个声音，而且音色冰冷。 */
            if (say != null && say.length() > 0) bubble(say);
        }
        return START_STICKY;
    }

    /** App 在前台就把桌宠收起来。
        实测问题：打开米粒后，卡片里有一只鸡，右上角悬浮窗还有一只 —— 两只同时出现，
        老人会以为是「多出来一个假的」。前台时藏，退到桌面再出来。 */
    public static void setAppForeground(boolean front) {
        foregroundNow = front;
        if (INST == null) return;
        INST.appFront = front;
        INST.ui.post(new Runnable() {
            @Override public void run() {
                INST.applyFront(front);
            }
        });
    }

    /** 前台就收起来，而且必须连触摸一起关掉。
        只 setVisibility(GONE) 是不够的：窗口还在，340×340 那块区域照样把点击吃掉，
        老人点「就那么办」的右半边没反应 —— 这种坑查一天也查不出来。 */
    private void applyFront(boolean front) {
        appFront = front;
        applyHidden();
    }

    /** 两种「该收起来」的原因：App 在前台、或者切到了家人端。
        以前把 wakeOn（用户唤醒开关）也当显示总闸 —— 关一次唤醒、切一次家人端
        就把整只桌宠弄没了，窗口再也建不回来。现在窗口永远建好，只切可见性。 */
    private void applyHidden() {
        try {
            if (root == null) return;
            /* 2026-11-09 22:00 菲尔特：「桌宠不要出现在米粒应用内部」。
               鸡和头顶气泡两个窗一起收，别只藏一半。 */
            boolean hide = appFront || famMode;
            root.setVisibility(hide ? View.GONE : View.VISIBLE);
            if (bubbleWin != null) bubbleWin.setVisibility(hide ? View.GONE : View.VISIBLE);
            if (hide) {
                if (bubble != null) bubble.setVisibility(View.GONE);
                ui.removeCallbacks(hideBubble);
            }
            if (lp != null && wm != null && shown) {
                if (hide) lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                else lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                wm.updateViewLayout(root, lp);
            }
        } catch (Throwable ignored) {}
    }

    /* ================= 悬浮窗 ================= */

    private void showPet() {
        if (shown) return;
        /* 2026-11-09 22:55：桌宠显示只归「桌宠开关」和「家人端临时态」管，
           不再跟 wakeOn 绑。以前这里 `if (!wakeOn) return`，设置里关一次语音唤醒
           （或上一版误写盘的 wake_on=false）就把整只鸡弄没了，喊也不应。 */
        /* 设置里关掉就是真关掉：连开机自启也不许把它再挂回来 */
        if (!getSharedPreferences("mili", MODE_PRIVATE).getBoolean("pet_visible", true)) {
            Log.i(TAG, "设置里关了桌宠，不显示"); return;
        }
        Log.i(TAG, "showPet begin");
        /* 建窗这一刻以静态标记为准，别指望 onResume 那次调用 —— 那时 INST 还没生出来。 */
        appFront = foregroundNow;
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        /* 2026-11-09 22:00 菲尔特：「这么大一只，小一点」「可以拖动但不要超过
           屏幕边界，可以直接把它拖消失了都」。
           旧版 440×440 px 在 1080 宽屏上占掉近半屏，而且 FLAG_LAYOUT_NO_LIMITS
           允许窗口坐标跑到屏幕外，拖一下就没了。
           GitHub 依据：aminography/FloatingWindowApp、StareBrain Part 17 ——
           TOP|START 绝对锚点 + getRawX/Y 拖动 + x.coerceIn(0, screenW-viewW)。
           这里 190 px，去掉 NO_LIMITS，enableDrag 双向 clamp。 */
        PET_PX = 190;
        lp = new WindowManager.LayoutParams(
                PET_PX, PET_PX, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        /* App 在前台时这块必须不吃触摸，否则按钮右半边永远点不动 */
                        | (appFront ? WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE : 0),
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        lp.x = Math.max(0, sw - PET_PX - 24);
        lp.y = Math.max(0, sh - PET_PX - 420);

        /* 气泡独立窗：跟着桌宠缩小，位置在宠物窗正上方，中心线对齐。 */
        int bw = BUB_W, bh = BUB_H;
        blp = new WindowManager.LayoutParams(
                bw, bh, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                PixelFormat.TRANSLUCENT);
        blp.gravity = Gravity.TOP | Gravity.START;
        blp.x = Math.max(0, lp.x + (PET_PX - bw) / 2);
        blp.y = Math.max(0, lp.y - bh - 8);

        root = new FrameLayout(this);

        /* 2026-11-09 21:33 菲尔特：「这个桌宠小鸡太白了，边框什么鬼，上github找找办法吧」
           GitHub 调研结论（出处写在 tools/make_pet_chick_anim_1109.py 头部）：
             · MerZlin/dsh-pet-indesktop docs/ANDROID.md —— 悬浮桌宠帧自带底色，
               悬浮窗只负责画帧，不额外套背景板/描边 → 删掉那层 OVAL plate。
             · Pavneet-Sing/Demos AnimatedImageDrawable —— decodeDrawable + start()
               + setFilterBitmap(true)；官方 REPEAT_INFINITE 保证一直动。
           「太白」根因是素材：pet_idle.webp 从黑底视频抠图，颜色早被冲淡，
           光修 alpha 救不回颜色。改用 app/assets/chick-idle.mp4（首屏那只
           毛茸茸黄鸡的原视频）逐帧生成 pet_chick_anim.webp：49 帧 / 12fps /
           440×440 / 每帧 alpha 全 255，不抠图、不调色、不加重绘。 */
        pet = new ImageView(this);
        boolean animLoaded = false;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            try {
                android.graphics.ImageDecoder.Source src =
                        android.graphics.ImageDecoder.createSource(getAssets(),
                                "pet_subject.webp");
                android.graphics.drawable.Drawable dr =
                        android.graphics.ImageDecoder.decodeDrawable(src,
                                new android.graphics.ImageDecoder.OnHeaderDecodedListener() {
                                    @Override
                                    public void onHeaderDecoded(
                                            android.graphics.ImageDecoder decoder,
                                            android.graphics.ImageDecoder.ImageInfo info,
                                            android.graphics.ImageDecoder.Source s) {
                                        decoder.setAllocator(
                                                android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE);
                                    }
                                });
                if (dr instanceof android.graphics.drawable.AnimatedImageDrawable) {
                    android.graphics.drawable.AnimatedImageDrawable aid =
                            (android.graphics.drawable.AnimatedImageDrawable) dr;
                    aid.setFilterBitmap(true);
                    aid.setRepeatCount(
                            android.graphics.drawable.AnimatedImageDrawable.REPEAT_INFINITE);
                }
                pet.setImageDrawable(dr);
                if (dr instanceof android.graphics.drawable.Animatable) {
                    ((android.graphics.drawable.Animatable) dr).start();
                }
                animLoaded = true;
                Log.i(TAG, "只留主体的黄鸡桌宠已加载 pet_subject.webp（49帧/透明底/无边框）");
            } catch (Throwable e) {
                Log.e(TAG, "动态桌宠解码失败，退静态 " + e.getMessage());
            }
        }
        if (!animLoaded) {
            try {
                java.io.InputStream is = getAssets().open("pet_solid.png");
                android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeStream(is);
                is.close();
                pet.setImageBitmap(bmp);
                Log.i(TAG, "退回静态 pet_solid.png");
            } catch (Exception e) {
                try {
                    java.io.InputStream is = getAssets().open("pet_chick.png");
                    android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeStream(is);
                    is.close();
                    pet.setImageBitmap(bmp);
                    Log.i(TAG, "退回 pet_chick.png");
                } catch (Exception e2) { Log.e(TAG, "桌宠图没读到 " + e2.getMessage()); }
            }
        }
        pet.setAlpha(1f);                 /* 明确不许任何 View 级透明 */
        pet.setScaleType(ImageView.ScaleType.FIT_CENTER);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(-1, -1);
        root.addView(pet, plp);

        // 轻浮：Y 轴 ±6px、1.8 秒一个来回，看起来像在呼吸
        ObjectAnimator floatAnim = ObjectAnimator.ofFloat(pet, "translationY", 0f, -8f);
        floatAnim.setDuration(1600);
        floatAnim.setRepeatMode(ObjectAnimator.REVERSE);
        floatAnim.setRepeatCount(ObjectAnimator.INFINITE);
        floatAnim.setInterpolator(new android.view.animation.AccelerateDecelerateInterpolator());
        floatAnim.start();

        // 气泡：独立窗口，压在小鸡头顶 —— 不再挤在 340px 的宠物窗里被裁掉
        bubble = new TextView(this);
        bubble.setTextColor(0xFF14151A);
        bubble.setTextSize(15);
        bubble.setGravity(Gravity.CENTER);
        bubble.setPadding(30, 18, 30, 18);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(0xFFFFFFFF);
        bg.setCornerRadius(34);
        bubble.setBackground(bg);
        bubble.setElevation(10);
        bubble.setVisibility(View.GONE);
        bubble.setMaxWidth(540);
        bubbleWin = new FrameLayout(this);
        bubbleWin.addView(bubble, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        try {
            wm.addView(bubbleWin, blp);
        } catch (Throwable e) {
            Log.e(TAG, "bubble addView failed " + e.getClass().getSimpleName());
            bubbleWin = null;
        }

        try {
            wm.addView(root, lp);
            shown = true;
            /* 窗口是新建的，但 App 可能早在前台了 —— onResume 那会儿 root 还是 null，
               那次 setAppForeground 什么都没做，之后没人再收它。
               实测后果：角色门和权限卡上横着一只鸡，正好压在要点的按钮旁边。 */
            if (appFront || famMode) applyHidden();   // 鸡和气泡一起收，别只藏一半
            Log.i(TAG, "overlay added ok");
        } catch (Exception e) {
            Log.e(TAG, "addView failed: " + e.getClass().getSimpleName() + " " + e.getMessage());
            shown = false;
            stopSelf();
            return;
        }

        /* ---- 每 6 秒体检一次：窗口还在不在、还看不看得见 ----
           MIUI 会在 App 退到后台后把悬浮窗策略性隐藏（mPolicyVisibility=false），
           窗口对象还在、addView 也不报错，但屏幕上一片空 —— 老人看到的就是「桌宠没了」。
           这里发现不可见就拆了重挂，屡试屡验。 */
        if (!petWatchOn) {
            petWatchOn = true;
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    try {
                        /* 家人端是我们自己收起来的，别当成「被系统藏了」反复重挂 */
                        if (root != null && shown && !appFront && !famMode) {
                            boolean visible = root.isShown()
                                    && root.getVisibility() == View.VISIBLE
                                    && root.getWindowVisibility() == View.VISIBLE;
                            if (!visible) {
                                Log.i(TAG, "桌宠被系统藏了，重挂一次");
                                try { wm.removeView(root); } catch (Throwable ignored) {}
                                try { wm.addView(root, lp); } catch (Throwable e) {
                                    Log.e(TAG, "重挂失败 " + e.getClass().getSimpleName());
                                }
                            }
                        }
                    } catch (Throwable ignored) {}
                    ui.postDelayed(this, 6000);
                }
            }, 6000);
        }

        // 点一下：开主界面（那边对话、药箱、记录都全）
        root.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openMain(null); }
        });
        enableDrag(root);

        /* 前台状态兜底：Activity 的 onResume/onPause 在系统弹权限框、跨应用
           跳转时可能丢一次，静态标记和窗口就对不上 —— 老人看到的就是
           「桌宠跑到米粒里面」。每秒对一次，不一致立刻纠正。 */
        if (!frontWatchOn) {
            frontWatchOn = true;
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    try {
                        if (shown && root != null && appFront != foregroundNow)
                            applyFront(foregroundNow);
                    } catch (Throwable ignored) {}
                    ui.postDelayed(this, 1000);
                }
            }, 1000);
        }

        // 启动冒一下头
        ui.postDelayed(new Runnable() {
            @Override public void run() { bubble("我在这儿呢"); }
        }, 700);
    }

    /** 头顶冒一句话，几秒后自己收回去 */
    private void bubble(final String text) {
        if (bubble == null) return;
        ui.post(new Runnable() {
            @Override public void run() {
                /* App 在前台时由页面上的状态胶囊说话；家人端也不许冒气泡 */
                if (appFront || famMode) return;
                bubble.setText(text);
                bubble.setVisibility(View.VISIBLE);
                bubble.setAlpha(0f);
                bubble.animate().alpha(1f).setDuration(180).start();
                ui.removeCallbacks(hideBubble);
                ui.postDelayed(hideBubble, Math.max(2600, text.length() * 220));
            }
        });
    }

    private final Runnable hideBubble = new Runnable() {
        @Override public void run() {
            if (bubble == null) return;
            bubble.animate().alpha(0f).setDuration(200)
                    .withEndAction(new Runnable() {
                        @Override public void run() {
                            if (bubble != null) bubble.setVisibility(View.GONE);
                        }
                    }).start();
        }
    };

    private void openMain(String ask) {
        try {
            Intent i = new Intent(MilService.this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (ask != null) i.putExtra("ask", ask);
            startActivity(i);
        } catch (Exception e) {
            Log.e(TAG, "openMain failed: " + e);
        }
    }

    /** 拖着走，但永远不许拖出屏幕。
        GitHub：aminography/FloatingWindowApp（getRawX/Y 增量 + updateViewLayout）、
        StareBrain Part 17（x.coerceIn(0, screenW - viewW) 双向 clamp）。
        旧版三处错：ACTION_DOWN 返回 false 收不到后续 MOVE；gravity=END 时 x 要
        取反而写成了 startX-dx；只 clamp 下限 0、没有上限，再加 NO_LIMITS 就能拖没。 */
    private void enableDrag(final View v) {
        v.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY;
            boolean moved;

            private int[] screen() {
                android.graphics.Point sz = new android.graphics.Point();
                try { wm.getDefaultDisplay().getRealSize(sz); }
                catch (Throwable t) {
                    sz.x = getResources().getDisplayMetrics().widthPixels;
                    sz.y = getResources().getDisplayMetrics().heightPixels;
                }
                return new int[]{sz.x, sz.y};
            }

            @Override public boolean onTouch(View view, MotionEvent e) {
                if (lp == null) return false;
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY();
                        startX = lp.x; startY = lp.y; moved = false;
                        return true;    // 必须 true，否则后面 MOVE/UP 全收不到
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (e.getRawX() - downX);
                        int dy = (int) (e.getRawY() - downY);
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                        if (!moved) return true;
                        int[] s = screen();
                        int w = v.getWidth() > 0 ? v.getWidth() : PET_PX;
                        int h = v.getHeight() > 0 ? v.getHeight() : PET_PX;
                        int maxX = Math.max(0, s[0] - w), maxY = Math.max(0, s[1] - h);
                        lp.x = Math.max(0, Math.min(startX + dx, maxX));
                        lp.y = Math.max(0, Math.min(startY + dy, maxY));
                        try { wm.updateViewLayout(v, lp); } catch (Throwable ignored) {}
                        /* 气泡跟着鸡走，也夹在屏内 */
                        if (blp != null && bubbleWin != null) {
                            int bw = blp.width > 0 ? blp.width : BUB_W;
                            int bh = blp.height > 0 ? blp.height : BUB_H;
                            blp.x = Math.max(0, Math.min(lp.x + (w - bw) / 2, Math.max(0, s[0] - bw)));
                            blp.y = Math.max(0, Math.min(lp.y - bh - 8, Math.max(0, s[1] - bh)));
                            try { wm.updateViewLayout(bubbleWin, blp); } catch (Throwable ignored) {}
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        if (!moved) view.performClick();   // 轻点还是开主界面
                        else try {
                            getSharedPreferences("mili", MODE_PRIVATE).edit()
                                    .putInt("pet_x", lp.x).putInt("pet_y", lp.y).apply();
                        } catch (Throwable ignored) {}
                        return true;
                }
                return false;
            }
        });
    }

    private void hidePet() {
        if (!shown) return;
        try { wm.removeView(pet.getParent() == null ? pet : (View) pet.getParent()); } catch (Exception ignored) {}
        if (bubbleWin != null) { try { wm.removeView(bubbleWin); } catch (Throwable ignored) {} bubbleWin = null; }
        shown = false;
    }

    /* ================= 唤醒 ================= */

    /* wakeOn = 用户设置里的「喊米粒唤醒」：只管本地 KWS 占不占麦，
       不再管桌宠显不显示。famMode = 家人端临时态，只在本次进程有效。
       2026-11-09 22:55 拆开这两个概念：以前混成一个标志，关唤醒 / 切家人端
       都会把整只桌宠连窗口一起弄没，而且再也建不回来。 */
    private static volatile boolean wakeOn = true;
    private static volatile boolean famMode = false;

    /** 运行时开关：只动本地唤醒，绝不写盘、绝不碰桌宠窗口。 */
    public static void setWakeEnabled(final boolean on) {
        wakeOn = on;
        final MilService s = INST;
        if (s == null) return;
        s.ui.post(new Runnable() { @Override public void run() {
            try {
                if (on && famMode) return;                    // 家人端不许起
                if (on && s.kws == null) s.startWake();      // 开机时是关的，现在补起来
                else if (s.kws != null) { if (on) s.kws.resume(); else s.kws.pause(); }
            } catch (Throwable t) {}
        }});
    }

    /** 家人端临时态：暂停唤醒、把鸡和气泡一起收起来；切回来原样恢复。
        只在本次进程有效，绝不落盘（11-08 事故就是这里写盘写坏了）。 */
    public static void setFamilyMode(final boolean fam) {
        famMode = fam;
        final MilService s = INST;
        if (s == null) return;
        s.ui.post(new Runnable() { @Override public void run() {
            try {
                if (s.kws != null) {
                    if (fam) s.kws.pause();
                    else if (wakeOn) s.kws.resume();
                }
                s.applyHidden();
            } catch (Throwable t) {}
        }});
    }

    /** 设置页「喊米粒唤醒」：只有用户亲手拨的这颗开关才写盘、开机也作数。 */
    public static void setWakeUserEnabled(final boolean on) {
        if (INST != null) {
            try {
                INST.getSharedPreferences("mili", MODE_PRIVATE).edit()
                        .putBoolean("wake_on", on)
                        .putBoolean("wake_pref_v2", true).apply();
            } catch (Throwable ignored) {}
        }
        setWakeEnabled(on);
    }

    public static boolean wakeEnabled() { return wakeOn; }

    private void startWake() {
        /* 正路：本地离线唤醒。
           不上传、不联网、喊完就有反应 —— 「随时随地叫米粒」得靠这个，
           云端识别一轮一断，后台还会被 MIUI 掐掉。 */
        if (kws != null) return;
        if (!wakeOn || famMode) { flog("设置/家人端：唤醒不启动"); return; }
        flog("startWake 进入");
        kws = new Kws(this, new Kws.OnWord() {
            @Override public void onWord(String w) { onWakeWord(w); }
        });
        kws.start();
        flog("Kws.start 已调用");

        // 模型 13MB，实测 0.6 秒就绪。8 秒还没起来说明真出问题了，记一笔。
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                boolean ok = kws != null && kws.isReady();
                flog(ok ? "8 秒检查：离线唤醒在位" : "8 秒检查：离线唤醒还没起来");
            }
        }, 8000);

        // 通话状态轮询：只有通话中才放开「挂断」「声音大点」两句
        ui.post(callTick);
    }

    /** 每 1.5 秒看一眼在不在通话里，避免电视里说一句「挂断」就把电话挂了 */
    private final Runnable callTick = new Runnable() {
        @Override public void run() {
            boolean in = false;
            try { in = WxFlow.inCall; } catch (Throwable ignored) {}
            if (in != cmdArmed) {
                cmdArmed = in;
                if (kws != null) kws.setCallMode(in);
            }

            /* 2026-11-06 晚 · 唤醒看门狗。
               cvStop 里的 resumeWake 是「还麦」的唯一出口。它只要漏一次
               （页面崩了、切页时 Asr 没停干净、我哪次改了调用顺序），
               离线唤醒就永久 pause —— 老人那边听到的就是「更多时候唤不醒」。
               现在每 1.5 秒看一眼：已经不在连续对话里，唤醒却还让着麦，
               连续 10 秒都这样就硬收回。给 10 秒是怕打断单次录音。 */
            if (kws != null && !Asr.cvMode && kws.isPaused()) {
                /* 🚨 2026-11-10 真机根因：这道看门狗把连续对话掐死了。
                   老人喊「米粒」→ KWS 让出麦克风 → 在线识别接管。
                   10.5 秒后这里认定「误暂停」，把麦硬抢回唤醒那边，
                   DuoAsr 从此读到全 0：日志「本轮送出 0 包 / 峰值 rms=0.0000」，
                   表现就是「一直在听、一句话都不答」。
                   连续对话用麦期间（Asr.cvMode）一律不算误暂停。 */
                if (Asr.cvMode) { pausedTicks = 0; }
                else {
                    pausedTicks++;
                    if (pausedTicks >= 7) {      // 1.5s × 7 ≈ 10s
                        pausedTicks = 0;
                        kws.resume();
                        flog("看门狗：唤醒被误暂停，收回麦克风");
                    }
                }
            } else {
                pausedTicks = 0;
            }
            ui.postDelayed(this, 1500);
        }
    };

    /** 给电视的遥控键：暂停 / 播放 / 上一集 / 下一集。
        走系统媒体键 —— 正在播的不论是悟空浏览器还是别的播放器，都吃这一套。 */
    private void mediaKey(int code) {
        try {
            android.media.AudioManager am = (android.media.AudioManager)
                    getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            android.view.KeyEvent down = new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, code);
            android.view.KeyEvent up = new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, code);
            am.dispatchMediaKeyEvent(down);
            am.dispatchMediaKeyEvent(up);
            flog("媒体键 " + code);
        } catch (Throwable t) {
            flog("媒体键失败 " + t);
        }
    }

    /** 听到关键词之后干什么 */
    private void onWakeWord(String w) {
        /* 家人端：喊破嗓子也不应；设置里关了唤醒也不应。 */
        if (!wakeOn || famMode) return;
        String k = w == null ? "" : w.replace(" ", "");
        boolean calling = false;
        try { calling = WxFlow.inCall; } catch (Throwable ignored) {}

        if (k.contains("挂断")) {
            flog("指令：挂断（通话中=" + calling + "）");
            if (!calling) { bubble("现在没在通话，不用挂"); return; }
            hangupNow();
            return;
        }
        if (k.contains("大点") || k.contains("声音")) {
            flog("指令：扬声器（通话中=" + calling + "）");
            if (!calling) { bubble("现在没在通话"); return; }
            speakerNow();
            return;
        }
        if (k.startsWith("米粒") && (k.contains("暂停") || k.contains("播放")
                || k.contains("下一集") || k.contains("上一集") || k.contains("全屏"))) {
            String cmd = k.contains("下一集") ? "下一集"
                    : k.contains("上一集") ? "上一集"
                    : k.contains("全屏") ? "全屏"
                    : k.contains("暂停") ? "暂停" : "播放";
            /* 先点播放器自己的按钮 —— 系统媒体键对网页视频、抖音、红果都不管用。 */
            String r = MiliAccessibilityService.playerControl(cmd);
            if (r != null && r.contains("\"ok\":true")) {
                bubble(cmd.equals("播放") ? "接着放" : cmd + "了");
                return;
            }
            /* 按钮没找着（控制栏收起、或换了个播放器）才退回媒体键。 */
            if (k.contains("暂停")) { mediaKey(android.view.KeyEvent.KEYCODE_MEDIA_PAUSE); bubble("暂停了"); }
            else if (k.contains("播放")) { mediaKey(android.view.KeyEvent.KEYCODE_MEDIA_PLAY); bubble("接着放"); }
            else if (k.contains("下一集")) { mediaKey(android.view.KeyEvent.KEYCODE_MEDIA_NEXT); bubble("下一集"); }
            else if (k.contains("上一集")) { mediaKey(android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS); bubble("上一集"); }
            else bubble("没找到全屏按钮");
            return;
        }
        if (k.contains("红包")) {
            flog("指令：领红包");
            Hongbao.grab(new Hongbao.Back() {
                @Override public void done(boolean ok, String msg) {
                    flog("红包结果：" + ok + " " + msg);
                    bubble(msg);
                }
            });
            return;
        }
        if (k.contains("米粒")) {
            if (System.currentTimeMillis() < holdUntil) return;   // 自己在说话，别自己叫自己
            flog("唤醒命中");
            wakeUp();
        }
    }

    private void hangupNow() {
        try {
            WxFlow f = MiliAccessibilityService.wx();
            if (f != null && f.hangup()) { bubble("挂了，这就挂了"); return; }
        } catch (Throwable t) {
            Log.i(TAG, "语音挂断失败 " + t);
        }
        bubble("我按不到挂断键，你按屏幕中间那个红的");
    }

    private void speakerNow() {
        try {
            WxFlow f = MiliAccessibilityService.wx();
            if (f != null && f.speaker()) { bubble("按了扬声器"); return; }
        } catch (Throwable t) {
            Log.i(TAG, "语音扬声器失败 " + t);
        }
        bubble("扬声器没按上，你点屏幕右边那个");
    }

    /** 写一份现场日志到文件 —— logcat 这台机器上被系统语音服务刷得看不见 */
    private void flog(String s) {
        Log.i(TAG, s);
        try {
            java.io.File f = new java.io.File(getExternalFilesDir(null), "kws.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", Locale.CHINA)
                    .format(new java.util.Date()) + " [svc] " + s + "\n");
            w.close();
        } catch (Throwable ignored) {}
    }

    /** 冒出来 + 出声答应。
        「叫它没回应」有一半是没听见：气泡太小、他根本没看屏幕。
        所以这里真的开口说话，声音会给回馈。 */
    private void wakeUp() {
        holdUntil = System.currentTimeMillis() + 4000;
        if (!shown) showPet();
        bubble("哎，我在");

        /* 2026-11-06 晚：无条件把界面抬出来。
           原来只在熄屏时抬，理由是「亮屏时怕抢走电视画面」——
           代价是菲尔特说的「叫了米粒，只冒个气泡，没打开对话界面」。
           老人喊一声要的是「有人应、屏幕上有东西」，不是自己再去桌面找图标。
           电视那条以后用「不抢音频焦点」解决，不该拿唤醒体验去换。 */
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            i.putExtra("wake", true);
            startActivity(i);
            flog("唤醒：已抬界面，交给页面进通话");
        } catch (Throwable t) {
            flog("抬界面失败 " + t);
        }

        /* 应答换成米粒自己的嗓子（豆包童声）。
           原来走系统 TTS —— 那就是菲尔特听到的「冰冷女声」，
           而且 setSpeechRate(0.88f) 比正常还慢 12%。 */
        MicGate.shut();
        Doubao.say("哎，我在", "wake" + System.currentTimeMillis(), new Doubao.Sink() {
            @Override public void onStart() { MicGate.shut(); }
            @Override public void onEnd(String id) { MicGate.open(); }
            @Override public void onFail() {
                MicGate.open();
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (tts != null && ttsReady) {
                            tts.speak("哎，我在", TextToSpeech.QUEUE_FLUSH, null, "wake");
                        }
                    }
                });
            }
        });
    }

    /* 后台用原生 MediaPlayer 播童声片段：WebView 在后台音频会被系统掐掉。
       支持 http(s) 地址，也支持打包在 assets/web/assets/voice/ 里的 mp3。 */
    private static android.media.MediaPlayer voiceMp = null;

    public static boolean playVoice(android.content.Context c, String src) {
        if (c == null || src == null || src.isEmpty()) return false;
        try {
            if (voiceMp != null) {
                try { voiceMp.stop(); voiceMp.release(); } catch (Throwable ignored) {}
                voiceMp = null;
            }
            android.media.MediaPlayer mp = new android.media.MediaPlayer();
            mp.setAudioStreamType(android.media.AudioManager.STREAM_MUSIC);
            if (src.startsWith("http")) {
                mp.setDataSource(src);
            } else {
                String name = src.substring(src.lastIndexOf('/') + 1);
                android.content.res.AssetFileDescriptor afd =
                        c.getAssets().openFd("web/assets/voice/" + name);
                mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
                afd.close();
            }
            mp.setOnPreparedListener(m -> { try { m.start(); } catch (Throwable ignored) {} });
            mp.setOnCompletionListener(m -> {
                try { m.release(); } catch (Throwable ignored) {}
                if (voiceMp == m) voiceMp = null;
            });
            mp.setOnErrorListener((m, what, extra) -> {
                try { m.release(); } catch (Throwable ignored) {}
                if (voiceMp == m) voiceMp = null;
                return true;
            });
            mp.prepareAsync();
            voiceMp = mp;
            return true;
        } catch (Throwable e) {
            android.util.Log.i(TAG, "童声播放失败 " + e);
            return false;
        }
    }

    /* ================= 跌落检测（2026-11-10 菲尔特要求）=================
       「加一个功能叫跌落检测，以后任何地方再也不要出现老人自己说自己摔倒」。
       所以这里不是等老人开口，是手机自己发现、自己问、自己叫人。
       判据在 FallDetect.java（失重 → 触地 → 静止）。
       20 秒窗口不是多余，是必须的：手机从桌上掉下去一样会触发。 */
    private static final long FALL_GRACE_MS = 20000L;
    private Runnable fallFire;
    private boolean fallPending = false;

    private void onFall(float g) {
        /* 2026-11-10 菲尔特：设置里的「摔倒检测」开关关掉时，
           原生这一路也不许触发确认层 / 倒计时 / 自动拨号。 */
        try {
            if (!getSharedPreferences("mili", MODE_PRIVATE)
                    .getBoolean("fall_enabled", true)) {
                flog("摔倒检测已关闭，忽略 " + String.format("%.2f", g) + "g");
                return;
            }
        } catch (Throwable ignored) {}
        if (fallPending) return;
        fallPending = true;
        flog(String.format("疑似跌落 %.2fg，开始 %d 秒确认", g, FALL_GRACE_MS / 1000));
        try { showPet(); } catch (Throwable ignored) {}
        bubble("您还好吗？");
        /* 只说加速度计真测到的事：手机跟着人掉了那一下。
           不写「听见响」——麦克风只跑唤醒词，不做声音分析，说听见就是假能力。 */
        sayIt("您还好吗？刚才那一下不对劲。要是没事，按一下屏幕，或者跟我说句话。");
        /* 网页在就推大字确认层（米粒是 launcher，基本总在）；
           不在就只有语音这一路，倒计时照跑 —— 宁可多打一次，不能漏。 */
        boolean pushed = MainActivity.runJs("window.MILI_FALL && window.MILI_FALL(20)");
        if (!pushed) flog("页面没打开，确认层推不过去，只走语音和倒计时");

        if (fallFire != null) ui.removeCallbacks(fallFire);
        fallFire = new Runnable() {
            @Override public void run() {
                fallFire = null;
                if (!fallPending) return;      /* 期间被取消了 */
                fallPending = false;
                flog("跌落确认超时，无人应答 → 叫人");
                bubble("我这就叫人");
                sayIt("一直没人应，我这就给家里人打电话。");
                boolean done = MainActivity.runJs("window.MILI_SOS && window.MILI_SOS()");
                if (!done) {
                    /* 页面真的不在：按绑定时存下的紧急联系人号码直接拨。
                       没存过号码就只出声，不瞎拨 —— 拨错一次比漏一次更可怕。 */
                    String num = getSharedPreferences("mili", MODE_PRIVATE)
                            .getString("sos_num", "");
                    if (num != null && num.replaceAll("[^0-9]", "").length() >= 5) {
                        try {
                            Intent c = new Intent(Intent.ACTION_CALL,
                                    android.net.Uri.parse("tel:" + num.replaceAll("[^0-9+]", "")));
                            c.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(c);
                            flog("页面不在，原生直接拨 " + num);
                        } catch (Throwable t) { flog("原生拨号失败 " + t); }
                    } else {
                        flog("没存紧急联系人号码，不瞎拨");
                    }
                }
            }
        };
        ui.postDelayed(fallFire, FALL_GRACE_MS);
    }

    /** 老人按了「我没事」/ 开口说话了 → 撤掉倒计时 */
    public static void cancelFall(String by) {
        MilService s = INST;
        if (s == null) return;
        if (!s.fallPending) return;
        s.fallPending = false;
        if (s.fallFire != null) { s.ui.removeCallbacks(s.fallFire); s.fallFire = null; }
        s.flog("跌落确认已取消：" + by);
        s.bubble("那就好。");
    }

    /** 老人自己说「快叫人」/ 点了「马上叫人」→ 不等到点，立刻升级 */
    public static void fallNow(String by) {
        MilService s = INST;
        if (s == null) return;
        if (s.fallFire != null) { s.ui.removeCallbacks(s.fallFire); s.fallFire = null; }
        s.fallPending = false;
        s.flog("跌落当场升级：" + by);
        s.bubble("我这就叫人");
        s.sayIt("好，我这就给家里人打电话。");
        MainActivity.runJs("window.MILI_SOS && window.MILI_SOS()");
    }

    public static boolean fallPendingNow() {
        MilService s = INST;
        return s != null && s.fallPending;
    }

    private void sayIt(final String text) {
        holdUntil = System.currentTimeMillis() + Math.max(3000, text.length() * 220);
        bubble(text);
        ui.post(new Runnable() {
            @Override public void run() {
                if (tts != null && ttsReady) {
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mili");
                }
            }
        });
    }

    /* ================= 通知（前台服务必须有） ================= */

    private Notification buildNotice() {
        String ch = "mili_pet";
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel c = new NotificationChannel(ch, "米粒在桌面上", NotificationManager.IMPORTANCE_MIN);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, ch)
                : new Notification.Builder(this);
        return b.setContentTitle("米粒在呢")
                .setContentText("点一下回到米粒")
                .setSmallIcon(android.R.drawable.btn_star)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    /* ================= 语音 ================= */

    private void initTts() {
        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override public void onInit(int st) {
                if (st == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                    tts.setLanguage(Locale.CHINA);
                    tts.setSpeechRate(0.88f);
                    tts.setPitch(1.12f);
                    /* 一开口就把麦克风闸上：不然它念完，识别器把这句话当成用户说的，
                       自问自答。onDone 一定回来，onError 也兜一下。 */
                    tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                        @Override public void onStart(String id) { MicGate.shut(); }
                        @Override public void onDone(String id) { MicGate.open(); }
                        @Override public void onError(String id) { MicGate.open(); }
                    });
                }
            }
        });
    }



    @Override
    public void onDestroy() {
        if (INST == this) INST = null;
        if (fallFire != null) { ui.removeCallbacks(fallFire); fallFire = null; }
        fallPending = false;
        try { FallDetect.stop(); } catch (Throwable ignored) {}
        ui.removeCallbacks(callTick);
        if (kws != null) { try { kws.stop(); } catch (Exception ignored) {} kws = null; }
        if (tts != null) { try { tts.shutdown(); } catch (Exception ignored) {} tts = null; }
        hidePet();
        super.onDestroy();
    }

    /** 用户从最近任务里划掉时，别等 15 分钟的闹钟，立刻爬起来 */
    @Override public void onTaskRemoved(Intent root) {
        super.onTaskRemoved(root);
        flog("被划掉了，准备自己回来");
        android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            Intent i = new Intent(this, BootStart.class).setAction(Waker.A_TICK);
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(this, 7302, i,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            am.set(android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + 3000, pi);
        }
    }

    @Override public IBinder onBind(Intent i) { return null; }

    /* ---------- 外部调用 ---------- */
    public static void wake(Context c) {
        Intent i = new Intent(c, MilService.class);
        i.setAction(ACTION_WAKE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
        else c.startService(i);
    }

    /** 让桌宠说一句，App 保持后台。看电视时用它，不切界面。 */
    public static void say(Context c, String text) {
        if (text == null || text.trim().length() == 0) return;
        Intent i = new Intent(c, MilService.class);
        i.setAction(ACTION_SAY);
        i.putExtra("say", text);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
            else c.startService(i);
        } catch (Throwable ignored) {}
    }

    public static void medRemind(Context c, String say) {
        Intent i = new Intent(c, MilService.class);
        i.setAction(ACTION_MED);
        i.putExtra("say", say);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
        else c.startService(i);
    }
}
