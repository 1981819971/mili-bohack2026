package com.mili.app;

import net.sourceforge.pinyin4j.PinyinHelper;

/**
 * 从一句话里抠出「人名」，再转成微信认的搜索词。
 *
 * 两件事：
 * 1）老人不会说「搜索李昌洪」，他说「我想给李昌洪打个电话」。
 *    以前把整句当人名塞进搜索框，微信当然搜不到，米粒就回「没找到」——
 *    它不是在偷懒，是把「我想给…打个电话」当成了名字。
 * 2）微信搜联系人认拼音首字母：李昌洪 = lch。这比直接搜中文稳：
 *    识别把「昌」听成「仓」，中文就搜不到了，lch 照样能搜到。
 */
public class Name {

    /* 关系称呼。这些不是名字，得先问清楚是谁，不能拿去搜。 */
    private static final String[] RELATION = {
            "女儿", "儿子", "妈妈", "母亲", "妈", "爸爸", "父亲", "爸",
            "老伴", "媳妇", "老婆", "老公", "爱人", "孙子", "孙女", "外孙",
            "外孙女", "女婿", "儿媳", "哥哥", "姐姐", "弟弟", "妹妹",
            "大哥", "大姐", "老弟", "老妹", "亲戚", "家里人", "家人"
    };

    /* 句子里跟人名无关的部分，去掉之后剩下的才是名字 */
    private static final String[] NOISE = {
            "我想", "我要", "我要给", "帮我", "帮忙", "麻烦", "请你", "请",
            "给", "跟", "和", "找", "联系", "打", "发", "一个", "个",
            "微信", "消息", "短信", "电话", "视个频", "视频", "语音",
            "打个电话", "发个消息", "发条消息", "发条微信", "说", "一下",
            "吧", "呢", "啊", "呀", "呗", "好吗", "好不好", "行吗",
            "现在", "马上", "快点", "赶紧"
    };

    /** 抠出名字。抠不出干净的名字就返回空串（宁可问一句，也别乱搜）。 */
    public static String clean(String raw) {
        if (raw == null) return "";
        String s = raw.trim().replaceAll("[\\s，。？！、,.?!：:；;“”\"'（）()]", "");
        for (String n : NOISE) s = s.replace(n, "");
        s = s.trim();
        /* 去掉之后还剩一长串，说明它根本不是名字（比如一整句话没切干净） */
        if (s.length() > 6 && !s.equals("文件传输助手")) return "";
        return s;
    }

    /* 这些词永远不是人名。实测事故：把「消息」当成人名搜出去，
       甚至把「消息」两个字当成正文发了。名字校验必须硬。 */
    private static final String[] NOT_NAME = {
            "消息", "微信", "电话", "短信", "视频", "语音", "红包", "相册",
            "内容", "文字", "什么", "怎么", "为什么", "帮我", "你好", "在吗"
    };

    /** 像不像一个名字。不像就别拿去搜、别拿去发。 */
    public static boolean isNameish(String s) {
        if (s == null) return false;
        String n = s.trim();
        /* 2026-11-10：微信内置的「文件传输助手」放行 —— 它不是真人，
           是老人给自己存东西、也是核名链路测试的安全对象。 */
        if (n.equals("文件传输助手")) return true;
        if (n.length() < 1 || n.length() > 12) return false;
        for (String bad : NOT_NAME) if (n.contains(bad)) return false;
        int han = 0;
        for (char c : n.toCharArray()) if (c >= 0x4e00 && c <= 0x9fff) han++;
        /* 纯中文名 1~4 字；带英文/数字的放宽到 12 个字符 */
        if (han > 0 && n.length() > 4) return false;
        return true;
    }

    public static boolean isRelation(String s) {
        if (s == null || s.isEmpty()) return false;
        for (String r : RELATION) if (s.equals(r) || s.contains(r)) return true;
        return false;
    }

    /** 中文名 → 拼音首字母（李昌洪 → lch）。非中文原样返回。 */
    public static String initials(String name) {
        if (name == null || name.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (char c : name.toCharArray()) {
            if (c >= 0x4e00 && c <= 0x9fff) {
                String py = first(c);
                if (py == null || py.isEmpty()) return name;   // 有不认识的字就退回原名
                sb.append(py.charAt(0));
            } else if (Character.isLetterOrDigit(c)) {
                sb.append(Character.toLowerCase(c));
            }
        }
        String out = sb.toString();
        return out.isEmpty() ? name : out;
    }

    private static String first(char c) {
        try {
            String[] arr = PinyinHelper.toHanyuPinyinStringArray(c);
            if (arr == null || arr.length == 0) return null;
            /* 多音字取第一个读音，并去掉声调数字 */
            return arr[0].replaceAll("[0-9]", "");
        } catch (Throwable t) {
            return null;
        }
    }

    /** 最终要塞进搜索框的东西：中文名走拼音首字母，其它原样。 */
    public static String searchTerm(String raw) {
        String n = clean(raw);
        if (n.isEmpty()) return "";
        boolean hasHan = false;
        for (char c : n.toCharArray()) if (c >= 0x4e00 && c <= 0x9fff) { hasHan = true; break; }
        return hasHan ? initials(n) : n.toLowerCase();
    }
}
