package com.mili.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/* 从必应结果页里抠出三条摘要。不引第三方库，纯正则，包体小。 */
public class Parse {
    private static final Pattern BLOCK = Pattern.compile("<li class=\"b_algo\".*?</li>", Pattern.DOTALL);
    private static final Pattern TITLE = Pattern.compile("<h2[^>]*>(.*?)</h2>", Pattern.DOTALL);
    private static final Pattern PARA = Pattern.compile("<p[^>]*>(.*?)</p>", Pattern.DOTALL);
    private static final Pattern CITE = Pattern.compile("<cite[^>]*>(.*?)</cite>", Pattern.DOTALL);
    private static final Pattern TAG = Pattern.compile("<[^>]+>");

    public static String bing(String html) {
        JSONArray out = new JSONArray();
        if (html == null) return out.toString();
        Matcher m = BLOCK.matcher(html);
        int n = 0;
        while (m.find() && n < 4) {
            String b = m.group();
            String t = clean(first(TITLE, b));
            String a = clean(first(PARA, b));
            String s = clean(first(CITE, b));
            if (a.isEmpty()) continue;
            try {
                JSONObject o = new JSONObject();
                o.put("t", cut(t, 70));
                o.put("a", cut(a, 260));
                o.put("s", cut(s, 40));
                out.put(o);
                n++;
            } catch (Exception e) { }
        }
        return out.toString();
    }

    private static String first(Pattern p, String s) {
        Matcher m = p.matcher(s);
        return m.find() ? m.group(1) : "";
    }

    private static final java.util.regex.Pattern NUM_ENT =
            java.util.regex.Pattern.compile("&#(x?)([0-9a-fA-F]{1,6});");

    /** 解所有数字字符实体。必应标题里大量 &amp;#183; 这种，不解码就原样念给老人。 */
    private static String decodeEntities(String s) {
        java.util.regex.Matcher m = NUM_ENT.matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            try {
                int cp = m.group(1).isEmpty()
                        ? Integer.parseInt(m.group(2))
                        : Integer.parseInt(m.group(2), 16);
                m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(
                        new String(Character.toChars(cp))));
            } catch (Exception e) {
                m.appendReplacement(sb, "");
            }
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private static String clean(String s) {
        if (s == null) return "";
        String r = TAG.matcher(s).replaceAll("");
        // 常见命名实体先换，再统一解数字实体（&#183; / &#0183; / &#x2F; 之类）
        r = r.replace("&ensp;", " ").replace("&nbsp;", " ")
             .replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
             .replace("&lt;", "<").replace("&gt;", ">").replace("&middot;", "·");
        r = decodeEntities(r);
        r = r.replaceAll("\\s+", " ").trim();
        // 去掉标题里常见的站点尾巴「- 知乎」「| 百度健康」
        r = r.replaceAll("\\s*[|｜]\\s*[^|｜]{0,12}$", "");
        return r;
    }

    private static String cut(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }
}
