package com.mili.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 大模型。走标准 OpenAI 兼容的 /chat/completions，
 * 这样换服务商只改 baseUrl 和 model 两个字符串，代码不用动。
 *
 * 默认配置留空 —— 因为现在没有可用的 key。
 * 配置读 SharedPreferences("mili_llm")：
 *   baseUrl  例如 https://xxx/v1
 *   apiKey
 *   model    例如 glm-5.3-flash
 *
 * 没配 key 的时候直接回退到本地逻辑（离线常识 + 必应搜索），
 * 不会卡住、不会报错弹窗。老人不该看到「网络异常」这种字。
 */
public class Llm {

    public interface Back {
        void ok(String text);
        void fail(String why);
    }

    private final Context ctx;
    private final Handler ui = new Handler(Looper.getMainLooper());

    public Llm(Context c) { this.ctx = c.getApplicationContext(); }

    public boolean configured() {
        SharedPreferences sp = ctx.getSharedPreferences("mili_llm", Context.MODE_PRIVATE);
        return !sp.getString("baseUrl", "").isEmpty() && !sp.getString("apiKey", "").isEmpty();
    }

    public void save(String baseUrl, String key, String model) {
        ctx.getSharedPreferences("mili_llm", Context.MODE_PRIVATE).edit()
                .putString("baseUrl", baseUrl == null ? "" : baseUrl.trim())
                .putString("apiKey", key == null ? "" : key.trim())
                .putString("model", model == null ? "" : model.trim())
                .apply();
    }

    public String model() {
        String m = ctx.getSharedPreferences("mili_llm", Context.MODE_PRIVATE).getString("model", "");
        return m.isEmpty() ? "glm-5.3-flash" : m;
    }

    /**
     * 问一句。system 写米粒的人设，user 是老人说的话。
     * 提示词刻意写死「只说一句、不超过 40 字、不用书面语」——
     * 模型天然爱长篇大论，给老人念会听不完。
     */
    public void ask(final String system, final String user, final Back cb) {
        if (!configured()) { cb.fail("not_configured"); return; }

        new Thread(new Runnable() {
            @Override public void run() {
                String out = null;
                String err = "";
                HttpURLConnection c = null;
                try {
                    SharedPreferences sp = ctx.getSharedPreferences("mili_llm", Context.MODE_PRIVATE);
                    String base = sp.getString("baseUrl", "").trim();
                    if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
                    String url = base + "/chat/completions";

                    JSONObject body = new JSONObject();
                    body.put("model", model());
                    body.put("temperature", 0.6);
                    body.put("max_tokens", 260);
                    JSONArray msgs = new JSONArray();
                    if (system != null && !system.isEmpty()) {
                        msgs.put(new JSONObject().put("role", "system").put("content", system));
                    }
                    msgs.put(new JSONObject().put("role", "user").put("content", user));
                    body.put("messages", msgs);

                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(7000);
                    c.setReadTimeout(14000);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setRequestProperty("Authorization", "Bearer " + sp.getString("apiKey", ""));

                    OutputStream os = c.getOutputStream();
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    os.close();

                    int code = c.getResponseCode();
                    java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (is == null) { err = "http_" + code; }
                    else {
                        BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                        StringBuilder sb = new StringBuilder();
                        String ln;
                        while ((ln = r.readLine()) != null) sb.append(ln);
                        r.close();
                        String txt = sb.toString();
                        if (code >= 400) {
                            err = "http_" + code;
                        } else {
                            JSONObject j = new JSONObject(txt);
                            JSONArray ch = j.optJSONArray("choices");
                            if (ch != null && ch.length() > 0) {
                                JSONObject msg = ch.getJSONObject(0).optJSONObject("message");
                                if (msg != null) out = msg.optString("content", "");
                            }
                        }
                    }
                } catch (Exception e) {
                    err = e.getClass().getSimpleName();
                } finally {
                    if (c != null) try { c.disconnect(); } catch (Exception ignored) {}
                }

                final String o = out, e2 = err;
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (o != null && !o.trim().isEmpty()) cb.ok(o.trim());
                        else cb.fail(e2.isEmpty() ? "empty" : e2);
                    }
                });
            }
        }).start();
    }

    /** 米粒的人设。换模型可以，这段别乱改 —— 它决定了说话像不像小孩。 */
    public static final String PERSONA =
            "你是米粒，一只刚出壳不久的小鸡，陪一位中国老人。"
            + "说话像五六岁小孩：短句、口语、带「呀、哦、啦、呢」这种语气词。"
            + "每次只答一句，不超过40个字。不用书面语，不列条条框框，不说「首先」「其次」。"
            + "不装懂。不知道就说不知道，然后说「要不你问问家里人」。"
            + "涉及吃药、身体不舒服，只给最保守的建议（坐下、歇会儿、喝温水、去医院），绝不给药量。";
}
