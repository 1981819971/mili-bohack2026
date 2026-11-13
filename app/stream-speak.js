/* ==========================================================================
 * 流式首句起播：切句 / 对账 / 幂等（纯逻辑，无 DOM 依赖，可跑 Node 回归）
 *
 * 为什么单独一个文件：2026-11-08 关掉流式，是因为「同一句念两遍」。
 * 根因不在 TTS，在三条出口没有一次性认领：
 *   onDelta 增量 → onStreamEnd 尾巴 → agentSay 收尾补 say(r.said)
 * 再加 streamed 靠「队列里还有没有东西」猜，队列刚好空时就补播一次。
 *
 * 借鉴 YevheniiMiachyn/dsh-tts-live（MIT）的四条工程结论：
 *   ① 有序句子队列，一句一段带稳定 id，避免重复播放或乱序；
 *   ② 每条队列与 settle 片段都带 session/turn 归属（late-settle suppression）；
 *   ③ claimedEnd 精确认领文本范围，修「live 尾部重复发布」；
 *   ④ 落盘对账：finalText 到达后与已念文本对齐，只发布未读尾部。
 * 另借 KoljaB/RealtimeTTS 的 minimum_first_fragment_length 控制首句长度
 *（中文按字算，英文默认 12 字对老人太慢，这里首句 5 字就切）。
 *
 * 本模块只产出「该播哪些段」，播不播、怎么播、麦克风什么时候开，全在 app.js 的 SS。
 * ========================================================================== */
(function (W) {
  'use strict';

  var STRONG = /[。！？!?；;\n]/;
  var WEAK = /[，,、：:]/;
  var TAIL = /[。！？!?；;…\n」』"'）)】]/;
  var FIRST_MIN = 5;     // 首句：满 5 个字，没标点也切出去，先把第一声送进 TTS
  var HARD_MAX = 24;     // 后面句子一口气没标点，24 字硬切，别无限等
  var DUP_MIN = 12;      // 紧贴重复子串 ≥12 字才判复读，「谢谢谢谢」不算

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[\s，。！？、；：,.?!;:「」『』"'（）()]+/g, '');
  }

  /* 紧贴着的重复：末尾 L 个字，往前紧邻同样长度的位置又出现一遍。
     模型退化时整段重说，这里返回第二遍的起点，供调用方砍掉。 */
  function dupAt(s) {
    var n = s.length;
    for (var L = Math.min(60, n >> 1); L >= DUP_MIN; L--) {
      var tail = s.slice(n - L);
      var p = s.lastIndexOf(tail, n - L - 1);
      if (p >= 0 && n - L - p === L) return p;
    }
    return -1;
  }

  /* 从缓冲区切出一段。seq=0 是首句，门槛最松；force 是内核说完了，剩下的全吐。
     返回 {seg, rest}，切不动返回 null。纯函数，无副作用。 */
  function cut(buf, seq, force) {
    var b = String(buf == null ? '' : buf);
    if (!b) return null;
    var c = -1, i;
    if (seq === 0) {
      /* 逗号优先级高于「5 字硬切」。原来要求 i>=3，结果「好嘞，我给您看看」
         会先撞上 5 字硬切，切成「好嘞，我给」这种半截词 —— 听起来比慢一点更糟。
         弱标点放宽到 3 字（i>=2）：「好嘞，」虽然短，但是一句完整的话。 */
      for (i = 0; i < b.length; i++) {
        if (STRONG.test(b[i])) { c = i; break; }
        if (i >= 2 && WEAK.test(b[i])) { c = i; break; }
        if (i + 1 >= FIRST_MIN) { c = i; break; }   // 一个标点都没有：5 字先起播
      }
    } else {
      for (i = 0; i < b.length; i++) {
        if (STRONG.test(b[i])) { c = i; break; }
      }
    }
    if (c < 0 && b.length >= HARD_MAX) c = HARD_MAX - 1;
    if (c < 0 && force) c = b.length - 1;
    if (c < 0) return null;
    var j = c;
    while (j + 1 < b.length && TAIL.test(b[j + 1])) j++;  // 「？！」不拆成两段
    return { seg: b.slice(0, j + 1).trim(), rest: b.slice(j + 1) };
  }

  /* 一轮对话一个 turn。所有增量、收尾、对账都挂在这个对象上，
     跨轮的迟到 delta 由调用方比对 id 丢弃，不在这里判。 */
  function createTurn(turnId) {
    var t = {
      id: turnId,
      buf: '',          // 还没切成句的半句
      all: '',          // 收到的全部增量（只用于复读检测与对账）
      seq: 0,           // 已切出的段数
      spoken: '',       // 已交给播放层的全部文本
      segments: [],     // 稳定 id 的段清单，供验收与排障
      live: false,      // 收到过增量
      claimedEnd: false,// 🔑 尾段只认领一次
      dup: false,       // 已判复读，后面的增量一个字都不收
      reconcile: null   // 收尾对账结果：{finalText, matched, unread}
    };

    function emit(seg) {
      t.seq++;
      var s = { id: t.id + '-' + t.seq, seq: t.seq, turn: t.id, text: seg };
      t.segments.push(s);
      t.spoken += seg;
      return s;
    }

    function drain(force) {
      var out = [];
      for (;;) {
        var r = cut(t.buf, t.seq, force);
        if (!r) break;
        t.buf = r.rest;
        if (r.seg) out.push(emit(r.seg));
      }
      return out;
    }

    /* 内核吐一片 → 返回这一片新切出来的段（可能 0 段、可能多段）。 */
    t.feed = function (chunk) {
      if (t.claimedEnd || t.dup) return [];        // 收尾之后 / 已判复读：一律不收
      var s = String(chunk == null ? '' : chunk);
      if (!s) return [];
      t.live = true;

      var combined = t.all + s;
      var at = dupAt(combined);
      if (at >= 0) {
        /* 第二遍砍掉。已念出去的半句收不回来，但不会再念第三遍。 */
        t.dup = true;
        t.all = combined.slice(0, at);
        t.buf = t.all.slice(Math.min(t.all.length, t.spoken.length));
        t.claimedEnd = true;
        return drain(true);
      }
      t.all = combined;
      t.buf += s;
      return drain(false);
    };

    /* 内核报「说完了」。claimedEnd 保证重复调用（onStreamEnd + 兜底 + 重试）
       只会认领一次尾段，这是「同一句念两遍」的断点。 */
    t.end = function (finalText) {
      if (t.claimedEnd) return [];
      t.claimedEnd = true;
      t.live = false;
      var out = drain(true);
      t.buf = '';

      /* 落盘对账：finalText 是过完诚实检查/标点清洗的最终稿。
         - 与已念文本一致 → 什么都不补，只定稿气泡；
         - 是「已念文本 + 未读尾部」→ 把未读尾部补进队列（不丢字）；
         - 被 guardHonest 整体改写 → **不补播**，屏幕显示真话即可。
           补播会立刻变回 11-08 的「念两遍」，宁可少念也不能重念。 */
      var f = String(finalText == null ? '' : finalText);
      var nf = norm(f), ns = norm(t.spoken);
      var matched = !f || nf === ns;
      var unread = '';
      if (f && nf.indexOf(ns) === 0 && nf.length > ns.length) {
        /* 只把「没念过的尾部」找出来。按去标点后的长度回映射到原文不精确，
           这里用末段后缀比对，取 f 中不在 spoken 末尾的那截。 */
        var tail = f.slice(Math.max(0, f.length - (nf.length - ns.length) - 4));
        if (tail && norm(t.spoken).indexOf(norm(tail)) < 0) unread = tail;
      }
      t.reconcile = { finalText: f, matched: matched, unread: unread };
      if (unread) out.push(emit(unread));
      return out;
    };

    t.stats = function () {
      return {
        id: t.id, seq: t.seq, live: t.live, claimedEnd: t.claimedEnd,
        dup: t.dup, buf: t.buf.length, all: t.all.length,
        spoken: t.spoken, segments: t.segments.map(function (x) { return x.text; }),
        reconcile: t.reconcile
      };
    };
    return t;
  }

  W.MILI_STREAM = {
    cut: cut,
    dupAt: dupAt,
    norm: norm,
    createTurn: createTurn,
    FIRST_MIN: FIRST_MIN,
    HARD_MAX: HARD_MAX
  };
})(typeof window !== 'undefined' ? window : globalThis);
