package com.mili.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import android.provider.Settings;
import java.util.Iterator;
import java.util.Map;
import android.content.SharedPreferences;
import org.json.JSONObject;

/**
 * 老人数据的固化备份。
 *
 * 为什么不能只写 App 私有目录：清除数据会把 getFilesDir / SharedPreferences /
 * WebView localStorage 一起删干净，老人回到家就得重新配对、规则全没。
 *
 * 这里把状态同时写进公共 Downloads（MediaStore，Android 10+ 不需要任何权限）。
 * 清 App 数据不会删公共文件，所以下次启动能自动读回来 —— 不联网、不登录、不用人管。
 * 私有 SP 仍然写一份，正常启动时读它更快；公共文件只在私有那份没了时才用。
 */
public class StateBackup {

    private static final String TAG = "MiliBackup";
    private static final String NAME = "mili-state.json";
    private static final String PREF = "mili_state_local";
    /* 原生侧的状态也在 App 私有目录里，清数据同样会没 */
    private static final String[] PREF_FILES = {
            "mili_actions", "mili_acc", "mili_alarms", "mili_llm",
            "mili_ir", "mili_cloud_asr"
    };

    public static void save(Context c, String json) {
        if (c == null || json == null) return;
        /* 前端的 S + 原生那几个偏好，打成一个包，一次写两处 */
        String full = json;
        try {
            JSONObject all = new JSONObject(json);
            all.put("_native", collectPrefs(c));
            full = all.toString();
        } catch (Throwable ignored) {}
        final String data = full;
        try {
            c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .edit().putString("s", data).commit();
        } catch (Throwable t) { Log.i(TAG, "私有备份失败 " + t); }
        try { writePublic(c, data); }
        catch (Throwable t) { Log.i(TAG, "公共备份失败 " + t); }
        syncUp(c, data);
    }

    /** 启动读回。私有那份在（正常启动）就直接用；没了才去公共文件找。 */
    public static String load(Context c) {
        if (c == null) return "";
        String raw = "";
        try {
            String s = c.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString("s", "");
            if (s != null && s.length() > 2) raw = s;
        } catch (Throwable ignored) {}
        if (raw.isEmpty()) {
            try { raw = readPublic(c); }
            catch (Throwable t) { Log.i(TAG, "读公共备份失败 " + t); }
        }
        if (raw.isEmpty()) {
            /* 本地两份都没了（清数据 / 换机）：从菲尔特的服务器拉 */
            try { raw = syncDown(c); }
            catch (Throwable t) { Log.i(TAG, "云端恢复失败 " + t); }
        }
        try {
            JSONObject o = new JSONObject(raw);
            JSONObject nat = o.optJSONObject("_native");
            if (nat != null) { restorePrefs(c, nat); o.remove("_native"); }
            return o.toString();
        } catch (Throwable t) { return raw; }
    }

    private static JSONObject collectPrefs(Context c) {
        JSONObject all = new JSONObject();
        for (String f : PREF_FILES) {
            try {
                SharedPreferences sp = c.getSharedPreferences(f, Context.MODE_PRIVATE);
                JSONObject one = new JSONObject();
                for (Map.Entry<String, ?> e : sp.getAll().entrySet()) one.put(e.getKey(), e.getValue());
                all.put(f, one);
            } catch (Throwable ignored) {}
        }
        return all;
    }

    private static void restorePrefs(Context c, JSONObject all) {
        for (String f : PREF_FILES) {
            JSONObject one = all.optJSONObject(f);
            if (one == null) continue;
            try {
                SharedPreferences.Editor ed = c.getSharedPreferences(f, Context.MODE_PRIVATE).edit();
                Iterator<String> it = one.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = one.opt(k);
                    if (v instanceof Boolean) ed.putBoolean(k, (Boolean) v);
                    else if (v instanceof Integer) ed.putInt(k, (Integer) v);
                    else if (v instanceof Long) ed.putLong(k, (Long) v);
                    else if (v instanceof Float) ed.putFloat(k, (Float) v);
                    else ed.putString(k, String.valueOf(v));
                }
                ed.commit();
            } catch (Throwable ignored) {}
        }
    }

    /* ================= 阿里云 ECS（YOUR_SERVER_HOST:9001，复用米粒自己的 ASR 服务） =========
       用 ANDROID_ID 做设备键：清除数据不会变，所以不用账号、不用登录、不用人管。 */
    private static final String STATE_URL = "http://YOUR_SERVER_HOST:9001/state?k=YOUR_STATE_KEY&dev=";

    private static String devId(Context c) {
        String id = "";
        try { id = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ANDROID_ID); }
        catch (Throwable ignored) {}
        return (id == null || id.isEmpty()) ? "unknown" : id;
    }

    private static void syncUp(final Context c, final String data) {
        new Thread(() -> {
            HttpURLConnection cn = null;
            try {
                cn = (HttpURLConnection) new URL(STATE_URL + devId(c)).openConnection();
                cn.setRequestMethod("PUT");
                cn.setConnectTimeout(4000);
                cn.setReadTimeout(4000);
                cn.setDoOutput(true);
                cn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                cn.getOutputStream().write(data.getBytes(StandardCharsets.UTF_8));
                cn.getResponseCode();
            } catch (Throwable t) { Log.i(TAG, "上传跳过（离线也能用） " + t);
            } finally { if (cn != null) cn.disconnect(); }
        }, "mili-state-up").start();
    }

    /* ================= 家人端 → 老人端配置同步（2026-11-07 v9）=================
       服务端 /state 的 dev 是任意字符串，所以拿家人给的 6 位码当共享键：
       家人 PUT 到 dev=cfg_<码>，老人端 GET 同一个键。
       走原生 HttpURLConnection，绕开 WebView 的 CORS / mixed-content 拦截。
       同步阻塞在调用方线程（桥方法自己不在主线程跑），超时 4 秒即放弃。 */
    public static String cfgPut(Context c, String code, String data) {
        HttpURLConnection cn = null;
        try {
            String safe = (code == null ? "" : code.replaceAll("[^0-9]", ""));
            if (safe.length() != 6) return "{\"ok\":false,\"why\":\"同步码要 6 位\"}";
            cn = (HttpURLConnection) new URL(STATE_URL + "cfg_" + safe).openConnection();
            cn.setRequestMethod("PUT");
            cn.setConnectTimeout(4000); cn.setReadTimeout(4000);
            cn.setDoOutput(true);
            cn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            cn.getOutputStream().write(String.valueOf(data).getBytes(StandardCharsets.UTF_8));
            int rc = cn.getResponseCode();
            return rc == 200 ? "{\"ok\":true}" : "{\"ok\":false,\"why\":\"服务器回 " + rc + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"why\":\"连不上服务器\"}";
        } finally { if (cn != null) cn.disconnect(); }
    }

    public static String cfgGet(Context c, String code) {
        HttpURLConnection cn = null;
        try {
            String safe = (code == null ? "" : code.replaceAll("[^0-9]", ""));
            if (safe.length() != 6) return "{\"ok\":false,\"why\":\"同步码要 6 位\"}";
            cn = (HttpURLConnection) new URL(STATE_URL + "cfg_" + safe).openConnection();
            cn.setRequestMethod("GET");
            cn.setConnectTimeout(4000); cn.setReadTimeout(4000);
            if (cn.getResponseCode() != 200) return "{\"ok\":false,\"why\":\"连不上服务器\"}";
            BufferedReader br = new BufferedReader(new InputStreamReader(
                    cn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String ln;
            while ((ln = br.readLine()) != null) sb.append(ln);
            br.close();
            org.json.JSONObject o = new org.json.JSONObject(sb.toString());
            String d = o.optString("data", "");
            if (d.isEmpty()) return "{\"ok\":false,\"why\":\"这个码还没人配置过\"}";
            return "{\"ok\":true,\"cfg\":" + d + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"why\":\"没拉到配置\"}";
        } finally { if (cn != null) cn.disconnect(); }
    }

    private static String syncDown(Context c) {
        HttpURLConnection cn = null;
        try {
            cn = (HttpURLConnection) new URL(STATE_URL + devId(c)).openConnection();
            cn.setRequestMethod("GET");
            cn.setConnectTimeout(3500);
            cn.setReadTimeout(3500);
            if (cn.getResponseCode() != 200) return "";
            BufferedReader br = new BufferedReader(new InputStreamReader(
                    cn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String ln;
            while ((ln = br.readLine()) != null) sb.append(ln);
            br.close();
            /* {"ok":true,"data":"<状态 JSON 字符串>"} 或 {"ok":true,"data":null} */
            org.json.JSONObject o = new org.json.JSONObject(sb.toString());
            return o.optString("data", "");
        } catch (Throwable t) { Log.i(TAG, "云端读取跳过 " + t); return ""; }
        finally { if (cn != null) cn.disconnect(); }
    }

    /* 分区存储下，App 查不到「上一次安装会话」写进 MediaStore 的文件
       （文件 owner 变了），于是每次 save 都 insert 一份新的，系统自动改名
       "mili-state (1).json"。把第一次拿到的 Uri 存进私有 SP，之后直接覆写它。
       清数据后 SP 没了 → 退回模糊查询 → 最多多一份，不会再无限堆积。 */
    private static final String URI_KEY = "public_uri";

    private static Uri cachedUri(Context c) {
        try {
            String v = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .getString(URI_KEY, "");
            return (v == null || v.isEmpty()) ? null : Uri.parse(v);
        } catch (Throwable t) { return null; }
    }

    private static void saveUri(Context c, Uri u) {
        if (u == null) return;
        try {
            c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .edit().putString(URI_KEY, u.toString()).commit();
        } catch (Throwable ignored) {}
    }

    private static Uri findUri(ContentResolver r) {
        Uri col = Build.VERSION.SDK_INT >= 29
                ? MediaStore.Downloads.EXTERNAL_CONTENT_URI
                : MediaStore.Files.getContentUri("external");
        /* 坑：MediaStore 遇到同名文件会自动改成 "mili-state (1).json"，
           精确查 DISPLAY_NAME='mili-state.json' 永远查不到，于是每次 save
           都 insert 一个新文件 —— 实测 Download 里堆了 15 份副本，
           恢复时还会读到旧的假状态。改成模糊匹配 + 取最新的一个来覆写。 */
        try (Cursor cur = r.query(col,
                new String[]{MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME},
                MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ? AND "
                        + MediaStore.MediaColumns.DISPLAY_NAME + " NOT LIKE ?",
                new String[]{"mili-state%", "%.bak%"},
                MediaStore.MediaColumns._ID + " DESC")) {
            if (cur != null && cur.moveToFirst()) {
                return ContentUris.withAppendedId(col, cur.getLong(0));
            }
        } catch (Throwable t) { Log.i(TAG, "找备份失败 " + t); }
        return null;
    }

    private static void writePublic(Context c, String json) throws Exception {
        /* 内容没变就别碰公共文件 —— 少一次 insert 就少一份副本 */
        try { if (json.equals(readPublic(c))) return; } catch (Throwable ignored) {}
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ContentResolver r = c.getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            Uri u = cachedUri(c);
            if (u != null) {
                try (OutputStream os = r.openOutputStream(u, "wt")) {
                    if (os != null) { os.write(bytes); return; }
                } catch (Throwable ignored) {}
            }
            u = findUri(r);
            if (u == null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, NAME);
                v.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                u = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (u == null) return;
                saveUri(c, u);
                try (OutputStream os = r.openOutputStream(u)) { if (os != null) os.write(bytes); }
                v.clear();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                r.update(u, v, null, null);
            } else {
                saveUri(c, u);
                try (OutputStream os = r.openOutputStream(u, "wt")) { if (os != null) os.write(bytes); }
            }
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists() && !dir.mkdirs()) return;
            try (FileOutputStream os = new FileOutputStream(new File(dir, NAME))) { os.write(bytes); }
        }
    }

    private static String readPublic(Context c) throws Exception {
        ContentResolver r = c.getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            Uri u = cachedUri(c);
            if (u != null) {
                try (InputStream is = r.openInputStream(u)) { return all(is); }
                catch (Throwable ignored) {}
            }
            u = findUri(r);
            if (u != null) {
                try (InputStream is = r.openInputStream(u)) { saveUri(c, u); return all(is); }
                catch (Throwable t) { Log.i(TAG, "读失败 " + t); }
            }
        } else {
            File f = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS), NAME);
            if (f.exists()) {
                try (InputStream is = new FileInputStream(f)) { return all(is); }
                catch (Throwable t) { Log.i(TAG, "读失败 " + t); }
            }
        }
        return "";
    }

    private static String all(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) b.write(buf, 0, n);
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }
}
