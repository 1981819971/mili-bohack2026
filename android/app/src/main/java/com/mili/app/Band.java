package com.mili.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import java.util.UUID;

/**
 * 手环心率读取。
 *
 * 为什么在原生层写：Android WebView 里没有 Web Bluetooth，网页端拿不到 BLE。
 * 要读手环，只能在 Java 里读，再推给网页。
 *
 * 为什么走标准心率服务：华为手环打开「设置 → 心率广播」后，会按蓝牙规范
 * 对外提供 0x180D 心率服务。这是公开标准 —— 不需要华为账号、不需要私有协议、
 * 不需要华为 SDK。任何人任何设备都能连上读。
 *
 * 什么时候才扫：只有老人在「我的」页亲手打开这个开关时才扫。
 * 常驻扫描很费电，老人的手机撑不住一天。读完就停。
 *
 * 读不到要说清楚为什么，不能只说「失败」：
 *   没开蓝牙 / 没授权 / 手环没在广播 / 手环没戴着 / 广播被手环自己停了
 * 这五种情况老人自己能处理，说清楚了才不用打电话问。
 */
public class Band {

    /* 标准蓝牙心率服务。写死是刻意的 —— 这是规范定义的常量，不会变。 */
    private static final UUID SVC_HR = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");
    private static final UUID CHR_HR = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb");
    private static final UUID DSC_CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    /* 扫 20 秒。老人开完广播再点开关，一般 5 秒内就能扫到；
       20 秒扫不到就是真的没在广播，再等也没用，早点告诉他。 */
    private static final long SCAN_MS = 20000;
    /* 断了以后 8 秒重连一次。手环抬手熄屏、走远又走回来，都会断。 */
    private static final long RETRY_MS = 8000;
    /* 超过这么久没收到心率，就认定「读不到了」—— 手环摘下来就不广播了 */
    private static final long STALE_MS = 90000;

    private final Context ctx;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Sink sink;

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private volatile boolean running = false;
    private boolean scanning = false;

    /* 记最后一个心率值，网页随时来问都能答，不用等下一次回调 */
    private volatile int lastBpm = 0;
    private volatile long lastAt = 0;
    private volatile String lastName = "";
    private volatile String lastAddr = "";
    private volatile String fail = "";

    public interface Sink {
        void push(String json);
    }

    public Band(Context c, Sink s) {
        this.ctx = c;
        this.sink = s;
    }

    /* ---------------- 对外 ---------------- */

    public boolean isRunning() { return running; }
    public int lastBpm() { return lastBpm; }
    public long lastAt() { return lastAt; }

    /** 现在读得到吗：在跑、连上了、而且数据是新鲜的 */
    public boolean fresh() {
        return running && lastAt > 0 && (System.currentTimeMillis() - lastAt) < STALE_MS;
    }

    /** 一句话说清楚现在的状态。网页拿这个直接念给老人听。 */
    public String status() {
        if (!running) return "没开";
        if (fail != null && !fail.isEmpty()) return fail;
        if (lastAt <= 0) return "正在连手环";
        long gap = System.currentTimeMillis() - lastAt;
        if (gap >= STALE_MS) return "手环没在报心率了";
        return "读到了";
    }

    /** 蓝牙相关权限齐了吗。Android 12 起分家成 SCAN/CONNECT 两个。 */
    public boolean hasPerm() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                return ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                        && ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
            }
            return ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    /** 蓝牙开关。没开就别扫了，扫了也是白扫。 */
    public boolean btOn() {
        try {
            BluetoothManager m = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (m == null) return false;
            adapter = m.getAdapter();
            return adapter != null && adapter.isEnabled();
        } catch (Exception e) {
            return false;
        }
    }

    /** 开始读。已经在跑就直接返回，不重复扫。 */
    public synchronized void start() {
        if (running) { emit("already", ""); return; }

        if (!btOn()) { fail = "手机蓝牙没开"; emit("fail", fail); return; }
        if (!hasPerm()) { fail = "还没给蓝牙权限"; emit("fail", fail); return; }

        running = true;
        fail = "";
        lastAt = 0;
        lastBpm = 0;
        emit("scan", "");
        scanNow();
    }

    /** 停。网页关开关、或者老人退出，都要停 —— 不停会一直耗电。 */
    public synchronized void stop() {
        running = false;
        fail = "";
        stopScan();
        closeGatt();
        lastBpm = 0;
        lastAt = 0;
        emit("stop", "");
    }

    /* ---------------- 扫描 ---------------- */

    private void scanNow() {
        if (!running) return;
        try {
            BluetoothManager m = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (m == null) { fail = "这台手机不支持蓝牙"; running = false; emit("fail", fail); return; }
            adapter = m.getAdapter();
            if (adapter == null || !adapter.isEnabled()) { fail = "手机蓝牙没开"; running = false; emit("fail", fail); return; }
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) { fail = "拿不到蓝牙扫描器"; running = false; emit("fail", fail); return; }

            /* 不加过滤器，自己判断。原因：有些手环在广播里不带服务 UUID，
               加了过滤器反而扫不到。宁可我这边多判一次，也不能漏。 */
            ScanSettings st = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();

            scanning = true;
            scanner.startScan(null, st, cb);

            /* 扫满 20 秒还没有，就停手报清楚 */
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    if (!running || gatt != null) return;
                    if (lastAt > 0) return;
                    stopScan();
                    fail = "没找到手环。要开蓝牙、戴在手上，还要在手表里打开「心率广播」";
                    emit("fail", fail);
                }
            }, SCAN_MS);

        } catch (SecurityException e) {
            fail = "蓝牙权限被拒了";
            running = false;
            emit("fail", fail);
        } catch (Exception e) {
            fail = "扫描起不来：" + e.getClass().getSimpleName();
            running = false;
            emit("fail", fail);
        }
    }

    private void stopScan() {
        if (!scanning) return;
        scanning = false;
        try { if (scanner != null) scanner.stopScan(cb); } catch (Exception ignored) {}
    }

    private final ScanCallback cb = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult r) { consider(r); }
        @Override public void onBatchScanResults(java.util.List<ScanResult> rs) {
            if (rs != null) for (ScanResult r : rs) consider(r);
        }
        @Override public void onScanFailed(int err) {
            scanning = false;
            fail = "蓝牙扫描失败（错误码 " + err + "）";
            emit("fail", fail);
        }
    };

    /* 是不是手环。两条任一：
       ① 广播里带标准心率服务 —— 这是最硬的证据
       ② 名字里有 HUAWEI / BAND / 华为 —— 兜底，有些固件不广播 UUID */
    private void consider(ScanResult r) {
        if (!running || gatt != null) return;
        if (r == null || r.getDevice() == null) return;
        try {
            boolean hasSvc = false;
            if (r.getScanRecord() != null && r.getScanRecord().getServiceUuids() != null) {
                /* 广播里给的是 ParcelUuid，不是 UUID —— 得 .getUuid() 才拿到真身 */
                for (android.os.ParcelUuid pu : r.getScanRecord().getServiceUuids()) {
                    if (pu != null && SVC_HR.equals(pu.getUuid())) { hasSvc = true; break; }
                }
            }
            String nm = r.getDevice().getName();
            if (nm == null) nm = "";
            boolean looks = nm.toUpperCase().contains("HUAWEI")
                    || nm.toUpperCase().contains("BAND")
                    || nm.contains("华为");

            if (!hasSvc && !looks) return;

            /* 找到了。先停扫再连 —— 边扫边连会互相干扰 */
            stopScan();
            connect(r.getDevice(), nm, hasSvc);
        } catch (Exception ignored) {}
    }

    /* ---------------- 连接 ---------------- */

    private void connect(BluetoothDevice d, String name, boolean confirmed) {
        try {
            lastName = name;
            lastAddr = d.getAddress();
            emit("found", name);
            gatt = d.connectGatt(ctx, false, gcb, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException e) {
            fail = "蓝牙权限被拒了";
            emit("fail", fail);
        } catch (Exception e) {
            fail = "连不上：" + e.getClass().getSimpleName();
            emit("fail", fail);
        }
    }

    private final BluetoothGattCallback gcb = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int st, int ns) {
            if (ns == BluetoothProfile.STATE_CONNECTED) {
                emit("connected", lastName);
                try { g.discoverServices(); } catch (Exception ignored) {}
            } else if (ns == BluetoothProfile.STATE_DISCONNECTED) {
                closeGatt();
                if (!running) return;
                /* 断了先别急着报失败 —— 老人抬手熄屏、走开两步都会断。
                   给它一次重连机会，真的连不上才说。 */
                emit("lost", lastName);
                ui.postDelayed(new Runnable() {
                    @Override public void run() {
                        if (!running || gatt != null) return;
                        if (lastAt > 0) { scanNow(); return; }
                        scanNow();
                    }
                }, RETRY_MS);
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int st) {
            try {
                BluetoothGattService s = g.getService(SVC_HR);
                if (s == null) {
                    /* 连上了但没有心率服务 —— 说明连错了设备，或者手环没开广播 */
                    fail = "连上了，但这台设备没在广播心率";
                    emit("fail", fail);
                    closeGatt();
                    return;
                }
                BluetoothGattCharacteristic c = s.getCharacteristic(CHR_HR);
                if (c == null) {
                    fail = "手环有心率服务，但读不到心率值";
                    emit("fail", fail);
                    closeGatt();
                    return;
                }
                g.setCharacteristicNotification(c, true);
                BluetoothGattDescriptor d = c.getDescriptor(DSC_CCCD);
                if (d != null) {
                    if (Build.VERSION.SDK_INT >= 33) {
                        g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    } else {
                        d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        g.writeDescriptor(d);
                    }
                }
                fail = "";
                emit("ready", lastName);
            } catch (Exception e) {
                fail = "订阅心率失败";
                emit("fail", fail);
            }
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] val) {
            handleHr(val);
        }

        /* Android 13 以下走这个老签名 */
        @SuppressWarnings("deprecation")
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            handleHr(c.getValue());
        }
    };

    /* 按蓝牙规范解析心率测量值。
       flags bit0=0 → 心率是 uint8；=1 → uint16（心率不可能到 255 以上，但规范留了）。
       bit3=1 表示后面还带能耗字段 —— 不解析也无所谓，前面两位够了。 */
    private void handleHr(byte[] v) {
        if (v == null || v.length < 2) return;
        try {
            int flags = v[0] & 0xFF;
            int bpm;
            if ((flags & 0x01) != 0) {
                if (v.length < 3) return;
                bpm = (v[1] & 0xFF) | ((v[2] & 0xFF) << 8);
            } else {
                bpm = v[1] & 0xFF;
            }
            /* 0 是「测不出」，不是「心跳停了」。当成没数据，别吓人。 */
            if (bpm <= 0 || bpm > 250) return;

            lastBpm = bpm;
            lastAt = System.currentTimeMillis();
            emitHr(bpm);
        } catch (Exception ignored) {}
    }

    private void closeGatt() {
        try {
            if (gatt != null) { gatt.close(); gatt = null; }
        } catch (Exception ignored) {}
    }

    /* ---------------- 推给网页 ---------------- */

    private void emit(String ev, String txt) {
        sink.push("{\"ev\":\"" + esc(ev) + "\",\"txt\":\"" + esc(txt)
                + "\",\"bpm\":" + lastBpm + ",\"at\":" + lastAt + "}");
    }

    private void emitHr(int bpm) {
        sink.push("{\"ev\":\"hr\",\"bpm\":" + bpm + ",\"at\":" + lastAt
                + ",\"name\":\"" + esc(lastName) + "\"}");
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }
}
