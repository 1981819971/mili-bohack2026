package com.mili.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Size;
import android.view.Surface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.List;

/**
 * 米粒的眼睛：用后置/前置摄像头拍一张，回给网页。
 *
 * 为什么不用 CameraX：它要多引一堆 androidx 依赖，而这个项目刻意零依赖
 * （android.useAndroidX=false）。Camera2 是系统自带的，够用。
 *
 * 前端拿到 base64 的 jpeg，可以：
 *   1) 发给多模态模型问「这是什么」
 *   2) 拍药盒认药名
 *   3) 拍人认脸（合照、看看孙子）
 */
public class Vision {

    public interface Shot {
        void got(String base64Jpeg, int w, int h);
        void failed(String why);
    }

    private final Activity act;
    private final Handler ui = new Handler(android.os.Looper.getMainLooper());

    private CameraDevice cam;
    private CameraCaptureSession sess;
    private ImageReader reader;
    private HandlerThread bg;

    public Vision(Activity a) { this.act = a; }

    public static boolean hasPermission(Activity a) {
        return a.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    public static void askPermission(Activity a, int code) {
        a.requestPermissions(new String[]{Manifest.permission.CAMERA}, code);
    }

    /** facing: 0 后置(看东西) 1 前置(看人) */
    public void shoot(final int facing, final Shot cb) {
        if (!hasPermission(act)) { cb.failed("no_permission"); return; }
        try {
            CameraManager cm = (CameraManager) act.getSystemService(Activity.CAMERA_SERVICE);
            String pick = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics ch = cm.getCameraCharacteristics(id);
                Integer f = ch.get(CameraCharacteristics.LENS_FACING);
                int want = facing == 1
                        ? CameraCharacteristics.LENS_FACING_FRONT
                        : CameraCharacteristics.LENS_FACING_BACK;
                if (f != null && f == want) { pick = id; break; }
                if (pick == null) pick = id;    // 找不到指定朝向就用第一个
            }
            if (pick == null) { cb.failed("no_camera"); return; }
            final String camId = pick;

            CameraCharacteristics ch = cm.getCameraCharacteristics(camId);
            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size size = null;
            if (map != null) {
                Size[] all = map.getOutputSizes(ImageFormat.JPEG);
                if (all != null && all.length > 0) {
                    // 挑一个 1280 左右的，太大传不动
                    Arrays.sort(all, (a, b) -> Math.abs(a.getWidth() - 1280) - Math.abs(b.getWidth() - 1280));
                    size = all[0];
                }
            }
            if (size == null) size = new Size(1280, 720);

            if (bg != null) bg.quit();
            bg = new HandlerThread("mili-cam");
            bg.start();
            Handler h = new Handler(bg.getLooper());

            reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader r) {
                    Image im = r.acquireNextImage();
                    if (im == null) return;
                    ByteBuffer buf = im.getPlanes()[0].getBuffer();
                    byte[] bytes = new byte[buf.remaining()];
                    buf.get(bytes);
                    int w = im.getWidth(), hh = im.getHeight();
                    im.close();
                    closeCam();
                    String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                    cb.got(b64, w, hh);
                }
            }, h);

            cm.openCamera(camId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    cam = d;
                    try {
                        Surface s = reader.getSurface();
                        d.createCaptureSession(java.util.Collections.singletonList(s), new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(CameraCaptureSession ss) {
                                sess = ss;
                                try {
                                    CaptureRequest.Builder b = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                    b.addTarget(reader.getSurface());
                                    b.set(CaptureRequest.CONTROL_AF_MODE,
                                            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                    ss.capture(b.build(), null, null);
                                } catch (Exception e) { closeCam(); cb.failed("capture"); }
                            }
                            @Override public void onConfigureFailed(CameraCaptureSession ss) {
                                closeCam(); cb.failed("config");
                            }
                        }, h);
                    } catch (Exception e) { closeCam(); cb.failed("session"); }
                }
                @Override public void onDisconnected(CameraDevice d) { d.close(); cam = null; }
                @Override public void onError(CameraDevice d, int code) {
                    d.close(); cam = null; cb.failed("cam_error_" + code);
                }
            }, h);

        } catch (SecurityException e) {
            cb.failed("no_permission");
        } catch (Exception e) {
            cb.failed("err:" + e.getClass().getSimpleName());
        }
    }

    private void closeCam() {
        try { if (sess != null) sess.close(); } catch (Exception ignored) {}
        try { if (cam != null) cam.close(); } catch (Exception ignored) {}
        try { if (reader != null) reader.close(); } catch (Exception ignored) {}
        sess = null; cam = null; reader = null;
        try { if (bg != null) bg.quit(); } catch (Exception ignored) {}
        bg = null;
    }
}
