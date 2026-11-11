package com.mili.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.media.Image;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 扫二维码配对。
 *
 * 为什么自己写这一页：配对码在老人的手机上，家人得用自己手机扫。
 * 装个带 Activity 的第三方扫码库要拖进来一堆依赖，国产 ROM 上还常常
 * 因为缺 Google Play 服务打不开 —— 这里只用 ZXing core 的解码器，
 * 相机自己开，500KB，模拟器也能跑。
 *
 * 只认二维码，不认条形码：配对码是 6 位数字画成的二维码，
 * 认条形码反而会把货架上的商品扫进来。
 *
 * 为什么 implements LifecycleOwner：CameraX 的 bindToLifecycle 要一个
 * 能报生命周期的对象。项目里没有 appcompat，就自己拿 LifecycleRegistry 撑起来 ——
 * 比为了这一个页面把整个 appcompat 拖进来轻得多。
 */
public class ScanActivity extends Activity implements androidx.lifecycle.LifecycleOwner {

    public static final String EXTRA_RESULT = "scan_result";
    private static final String TAG = "MiliScan";
    private static final int REQ_CAM = 41;

    private PreviewView preview;
    private TextView tip;
    private ExecutorService pool;
    private MultiFormatReader reader;
    private volatile boolean done = false;
    private ProcessCameraProvider provider;

    private final androidx.lifecycle.LifecycleRegistry lifecycle =
            new androidx.lifecycle.LifecycleRegistry(this);

    @NonNull
    @Override
    public androidx.lifecycle.Lifecycle getLifecycle() {
        return lifecycle;
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        lifecycle.setCurrentState(androidx.lifecycle.Lifecycle.State.CREATED);
        /* 白底、无标题 —— 跟 App 里其他页一个样，不要系统那种黑相机界面 */
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        preview = new PreviewView(this);
        preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        /* 中间挖个取景框，用四条白边围出来 —— 不画框的话老人不知道往哪对 */
        View box = new View(this);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(dp(240), dp(240), Gravity.CENTER);
        box.setLayoutParams(blp);
        box.setBackground(makeFrame());
        root.addView(box);

        tip = new TextView(this);
        tip.setText("把对方的二维码放进框里");
        tip.setTextSize(17);
        tip.setTextColor(0xFFFFFFFF);
        tip.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.gravity = Gravity.BOTTOM;
        tlp.bottomMargin = dp(72);
        tip.setLayoutParams(tlp);
        root.addView(tip);

        TextView cancel = new TextView(this);
        cancel.setText("不扫了");
        cancel.setTextSize(16);
        cancel.setTextColor(0xFFDDDDDD);
        cancel.setGravity(Gravity.CENTER);
        cancel.setPadding(dp(20), dp(14), dp(20), dp(14));
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        clp.bottomMargin = dp(18);
        cancel.setLayoutParams(clp);
        cancel.setOnClickListener(v -> finishNoResult());
        root.addView(cancel);

        setContentView(root);

        pool = Executors.newSingleThreadExecutor();
        reader = new MultiFormatReader();
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        List<BarcodeFormat> fmts = new ArrayList<>();
        fmts.add(BarcodeFormat.QR_CODE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, fmts);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
            else openCamera();
        } else {
            openCamera();
        }
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /* 四条白边围成取景框。中间是透明的，相机画面透过来。 */
    private android.graphics.drawable.Drawable makeFrame() {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(0x00000000);
        g.setStroke(dp(2), 0x99FFFFFF);
        g.setCornerRadius(dp(16));
        return g;
    }

    @Override
    public void onRequestPermissionsResult(int req, @NonNull String[] p, @NonNull int[] r) {
        super.onRequestPermissionsResult(req, p, r);
        if (req == REQ_CAM) {
            if (r.length > 0 && r[0] == PackageManager.PERMISSION_GRANTED) openCamera();
            else { tip.setText("没给相机权限。让对方把 6 位数字念给你，填在输入框里也一样。"); }
        }
    }

    private void openCamera() {
        ListenableFuture<ProcessCameraProvider> fut = ProcessCameraProvider.getInstance(this);
        fut.addListener(() -> {
            try {
                provider = fut.get();

                /* 取景：铺满，让老人看到整个画面 */
                Preview pv = new Preview.Builder().build();
                pv.setSurfaceProvider(preview.getSurfaceProvider());

                /* 分析帧：要 YUV_420_888，直接喂给 ZXing 的 PlanarYUVLuminanceSource，
                   不用先转 Bitmap —— 转一次就多几毫秒，扫码会卡。 */
                ResolutionSelector rs = new ResolutionSelector.Builder()
                        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                        .build();
                ImageAnalysis ia = new ImageAnalysis.Builder()
                        .setResolutionSelector(rs)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();
                ia.setAnalyzer(pool, this::analyze);

                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, pv, ia);
            } catch (Exception e) {
                Log.w(TAG, "相机开不了", e);
                tip.setText("相机开不了。让对方把 6 位数字念给你，填在输入框里也一样。");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    /* 每一帧都试一次解码。扫到就立刻回传并关页 ——
       让老人举着手机等「识别成功」那一下，是最难熬的。 */
    private void analyze(ImageProxy ip) {
        if (done) { ip.close(); return; }
        try {
            if (ip.getFormat() != ImageFormat.YUV_420_888) { ip.close(); return; }
            ByteBuffer buf = ip.getPlanes()[0].getBuffer();
            int w = ip.getWidth(), h = ip.getHeight();
            byte[] data = new byte[buf.remaining()];
            buf.get(data);
            /* 只取中间那块，跟取景框对齐。整帧解码慢，而且边上的字会干扰。 */
            int cw = (int) (w * 0.72f), ch = (int) (h * 0.72f);
            int left = (w - cw) / 2, top = (h - ch) / 2;
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(
                    data, w, h, left, top, cw, ch, false);
            BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
            Result r = reader.decodeWithState(bmp);
            if (r != null && r.getText() != null) {
                String t = r.getText().trim();
                /* 只回传 6 位数字。二维码里要是别的东西（网址、名片），
                   这里就当没扫到 —— 配对页只认码。 */
                String digits = t.replaceAll("\\D", "");
                if (digits.length() >= 6) {
                    done = true;
                    final String out = digits.substring(0, 6);
                    runOnUiThread(() -> finishWith(out));
                }
            }
        } catch (Exception ignored) {
            /* 没扫到是常态，每帧都会抛 NotFoundException，不用管 */
        } finally {
            try { ip.close(); } catch (Exception ignored) {}
        }
    }

    private void finishWith(String code) {
        try { reader.reset(); } catch (Exception ignored) {}
        Intent d = new Intent();
        d.putExtra(EXTRA_RESULT, code);
        setResult(RESULT_OK, d);
        finish();
    }

    private void finishNoResult() {
        setResult(RESULT_CANCELED);
        finish();
    }

    @Override
    protected void onStart() {
        super.onStart();
        lifecycle.setCurrentState(androidx.lifecycle.Lifecycle.State.STARTED);
    }

    @Override
    protected void onResume() {
        super.onResume();
        lifecycle.setCurrentState(androidx.lifecycle.Lifecycle.State.RESUMED);
    }

    @Override
    protected void onPause() {
        lifecycle.setCurrentState(androidx.lifecycle.Lifecycle.State.STARTED);
        super.onPause();
    }

    @Override
    protected void onStop() {
        lifecycle.setCurrentState(androidx.lifecycle.Lifecycle.State.CREATED);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        lifecycle.setCurrentState(androidx.lifecycle.Lifecycle.State.DESTROYED);
        done = true;
        try { if (provider != null) provider.unbindAll(); } catch (Exception ignored) {}
        try { if (pool != null) pool.shutdownNow(); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
