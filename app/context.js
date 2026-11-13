/* ============================================================================
 * app/context.js — 三层长期记忆与自动上下文压缩
 *
 * 为什么有这个文件：
 *   重构前 _hist 是一个内存数组，HIST_MAX=8，重启即丢，无摘要、无检索、无长期层。
 *   老人上午说的「女儿叫小芳」，下午换一屏、重启一次就没了。
 *
 * 分层（术语对齐 Letta / MemGPT）：
 *   core      ≤800 字常驻画像摘要，可单条编辑（对应 memory blocks）
 *   episodic  带时间戳的增量摘要段 + append-only 原文归档，BM25 检索召回
 *   working   最近 8 轮原文，内存 + localStorage，重启不丢
 *
 * 借鉴（只抄算法，不引依赖）：
 *   langchain/deepagents `SummarizationMiddleware`：trigger/keep 阈值、
 *     _summarization_event 存 cutoff、原始 checkpoint 只追加不删、链式压缩推进同一份 raw log；
 *   Letta `compact.py` / `summarizer.py` / `sleeptime_*`：闲时整理画像；
 *   LongMemEval (ICLR 2025)：知识更新、时序推理、弃答三类能力必须显式建模；
 *   LongMemEval 复现结论：hybrid（语义 + 10% BM25 + recency）Recall@1 83%→88%。
 *
 * 现场约束：压缩默认走**抽取式**（零额外 LLM 调用、零延迟）。
 *   LLM 精修只在显式调用 refine() 时做，留给闲时，不在对话关键路径上。
 * ========================================================================== */
(function (w) {
  'use strict';

  var STORE = w.MILI_STORE || null;
  var LS = (function () {
    try { if (w.localStorage) return w.localStorage; } catch (e) {}
    var m = {};
    return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
             setItem: function (k, v) { m[k] = String(v); },
             removeItem: function (k) { delete m[k]; } };
  })();
  function get(k) { try { return STORE && STORE.get ? STORE.get(k) : LS.getItem(k); } catch (e) { return null; } }
  function put(k, v) {
    try { var s = typeof v === 'string' ? v : JSON.stringify(v);
      if (STORE && STORE.put) return STORE.put(k, s);
      LS.setItem(k, s); return true;
    } catch (e) { return false; }
  }

  var K_RAW = 'mili.context.raw';
  var K_EVENT = 'mili.context.event';
  var K_CORE = 'mili.context.core';
  var WORK_MAX = 8;          // keep：压缩后保留的原文轮数
  var TRIGGER = 8;           // trigger：超出 keep 窗口多少条就压一次（≈4 轮对话）
  var MAX_SUMMARIES = 6;     // 摘要段数上限，超过就链式再压缩
  var CORE_LIMIT = 800;
  var SUMMARY_LIMIT = 620;
  /* 会话边界：超过 20 分钟没说话，上一会话的原文不再当成「当前对话」。
     没有这条，上午聊的半句会被下午第一句接走 —— 真机复现过
     「你好呀」回成「36 到底中不中呀」。 */
  var SESSION_GAP = 20 * 60 * 1000;

  function blankEvent() { return { cutoff: 0, cutoffId: '', summaries: [], at: 0, passes: 0 }; }

  var raw = load(K_RAW, []);
  var ev = load(K_EVENT, blankEvent());
  var coreText = String(get(K_CORE) || '');
  var seq = 0;

  function load(k, dflt) {
    try { var v = JSON.parse(get(k) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function persist() { put(K_RAW, raw); put(K_EVENT, ev); put(K_CORE, coreText); }

  /* ---------- 分词 / BM25（与 tool-router 同一套，纯字符 n-gram） ---------- */
  function tokenize(s) {
    var out = [], str = String(s || '').toLowerCase(), buf = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i), code = str.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) {
        if (buf) { out.push(buf); buf = ''; }
        out.push(c);
        if (i + 1 < str.length && str.charCodeAt(i + 1) >= 0x4e00 && str.charCodeAt(i + 1) <= 0x9fff)
          out.push(c + str.charAt(i + 1));
      } else if (/[a-z0-9_]/.test(c)) buf += c;
      else { if (buf) { out.push(buf); buf = ''; } }
    }
    if (buf) out.push(buf);
    return out;
  }
  function tf(terms) { var f = {}; for (var i = 0; i < terms.length; i++) f[terms[i]] = (f[terms[i]] || 0) + 1; return f; }

  /* ---------- append-only raw log ---------- */
  function push(role, content, dayOverride) {
    var text = String(content == null ? '' : content).trim();
    if (!text) return null;
    /* dayOverride 只给「导入历史会话 / 离线回放」用；真实对话一律按本地当天记。 */
    var day = dayOverride || (STORE && STORE.localDay ? STORE.localDay() : new Date().toLocaleDateString('zh-CN'));
    var nowMs = Date.now();
    var prevAt = raw.length ? (raw[raw.length - 1].at || 0) : 0;
    /* 跨会话：先把上一会话整段压成摘要并推进 cutoff，working 从这一句重新开始。 */
    if (prevAt && nowMs - prevAt > SESSION_GAP) maybeCompact(true, true);
    var m = { id: 'c' + (nowMs.toString(36)) + '_' + (++seq), role: role === 'assistant' ? 'assistant' : 'user',
              text: text.slice(0, 500), at: nowMs, day: day };
    raw.push(m);
    put(K_RAW, raw);
    maybeCompact();
    return m.id;
  }

  /* ---------- 抽取式摘要：零 LLM 调用 ----------
     保留带实体/时间/数字/动作的句子，丢纯寒暄；按时间标前缀。
     这不是「总结得漂亮」，是「不丢事实」—— LongMemEval 的信息抽取与时序推理考的就是这个。 */
  /* 强信号才算「事实」。旧版只要含「是」「要」就留，「哈哈，是吗」也被当成事实存进摘要。 */
  var CHITCHAT = /^(嗯|哦|啊|呃|好呀|好了|好的|是吗|对|对呀|行|没事|哈哈|呵呵|谢谢|谢谢你|不客气)[\s，。！？、,.?!]*$/;
  function salient(s) {
    var t = String(s || '').trim();
    if (t.length < 5 || CHITCHAT.test(t)) return false;
    if (/^(嗯|哦|啊|好|是|对|行|没|哈)/.test(t) && t.length < 10) return false;
    /* 光有数字不算事实：「36 到底中不中呀」这种闲聊也会被存进摘要，
       隔天又被当成当前话题接走。数字必须带量词（点/次/天/号/岁/块…）。 */
    if (/[0-9０-９]/.test(t) && /(点|次|天|号|岁|年|月|日|块|元|个|分|集|片)/.test(t)) return true;
    if (/(女儿|儿子|老伴|闺女|孙子|外孙|名字|住在|喜欢|不爱|每天|早上|上午|下午|晚上|昨天|今天|上次|记得|别|要去|吃过|看过|买过|挂号|约了|点|号|岁|药|医院)/.test(t)) return true;
    return false;
  }
  function extractive(messages) {
    var seen = {}, lines = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m || m.role !== 'user') continue;           // assistant 的寒暄不入档
      var parts = String(m.text || '').split(/[。！？；\n]/);
      for (var j = 0; j < parts.length; j++) {
        var s = parts[j].trim();
        var key = s.replace(/[\s，。！？、,.?!;:]/g, '');
        if (!salient(s) || !key || seen[key] || key.length > 80) continue;
        seen[key] = 1;
        lines.push(s.slice(0, 60));
      }
    }
    var out = lines.join('；');
    return out.slice(0, SUMMARY_LIMIT);
  }

  /* ---------- 增量压缩 + cutoff 锚定 ----------
     raw 只追加不删；event 记录「有效历史从哪条开始」。
     cutoffId 优先于 cutoffIndex（deepagents 的 anchor_summarization_event）：
     将来若裁剪 raw，ID 仍在就能重新定位，不会把活着的对话切掉。 */
  function anchor() {
    if (!ev.cutoffId) return ev.cutoff || 0;
    for (var i = 0; i < raw.length; i++) if (raw[i].id === ev.cutoffId) return i;
    return Math.min(ev.cutoff || 0, raw.length);   // ID 找不到就退回旧 index，不硬猜
  }
  function maybeCompact(force, all) {
    var cut = anchor();
    /* all=true 用于会话边界：把旧会话全部归档，不保留原文窗口。 */
    var pending = raw.length - cut - (all ? 0 : WORK_MAX);
    if (!force && pending < TRIGGER) return { compacted: false, pending: pending };
    if (pending <= 0) return { compacted: false, pending: pending };
    var from = cut, to = all ? raw.length : raw.length - WORK_MAX;
    var slice = raw.slice(from, to);
    var text = extractive(slice);
    var day = (slice[0] && slice[0].day) || '';
    if (text) ev.summaries.push({ day: day, text: text, from: from, to: to, at: Date.now() });
    ev.cutoff = to;
    ev.cutoffId = raw[to] ? raw[to].id : '';
    ev.at = Date.now();
    ev.passes = (ev.passes || 0) + 1;
    /* 链式再压缩：摘要段太多会重新把上下文撑大，把最旧的几段合并成一条更短的 */
    if (ev.summaries.length > MAX_SUMMARIES) {
      var old = ev.summaries.splice(0, ev.summaries.length - MAX_SUMMARIES + 1);
      ev.summaries.unshift({ day: old[0].day, text: extractive(old.map(function (x) {
        return { role: 'user', text: x.text }; })), from: old[0].from, to: old[old.length - 1].to, at: Date.now(), merged: old.length });
    }
    put(K_EVENT, ev);
    return { compacted: true, pending: raw.length - anchor() - WORK_MAX, summaries: ev.summaries.length };
  }

  /* ---------- 读：给模型组装有效历史 ----------
     systemPrompt 保持完全静态，变化部分全放 messages 尾部 —— prompt prefix cache 友好。 */
  function summaryBlock() {
    if (!ev.summaries.length) return '';
    return '【早前聊过的事（摘要，供参考，不是本轮说的话）】' +
      ev.summaries.map(function (s) { return (s.day ? s.day + '：' : '') + s.text; }).join(' ｜ ');
  }
  function coreBlock() { return coreText ? '【老人画像】' + coreText.slice(0, CORE_LIMIT) : ''; }
  function histMessages() {
    var out = [];
    var head = [coreBlock(), summaryBlock()].filter(Boolean).join('\n');
    if (head) out.push({ role: 'user', content: head });
    var cut = anchor(), nowMs = Date.now();
    for (var i = cut; i < raw.length; i++) {
      var m = raw[i];
      /* 双保险：即便忘了归档，也不把 20 分钟前的原话当成本轮上下文。 */
      if (m.at && nowMs - m.at > SESSION_GAP) continue;
      out.push({ role: m.role, content: m.text });
    }
    /* 兜底上限：即便 raw 异常膨胀也不让请求爆掉 */
    return out.slice(-(WORK_MAX * 2 + 1));
  }

  /* ---------- 检索召回（hybrid：BM25 + recency + 摘要权重） ---------- */
  function retrieve(query, k) {
    k = k || 5;
    var q = tokenize(query), qtf = tf(q);
    if (!Object.keys(qtf).length) return [];
    var docs = [];
    ev.summaries.forEach(function (s, i) {
      docs.push({ text: s.text, at: s.at || 0, day: s.day, terms: tokenize(s.text), weight: 1.15, src: 'summary', i: i });
    });
    for (var i = anchor(); i < raw.length; i++) {
      var m = raw[i];
      docs.push({ text: m.text, at: m.at, day: m.day, terms: tokenize(m.text), weight: 1, src: 'raw', i: i });
    }
    if (!docs.length) return [];
    var df = {}, dl = [], avg = 0;
    docs.forEach(function (d, j) {
      var f = tf(d.terms); Object.keys(f).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      d._f = f; dl[j] = d.terms.length; avg += dl[j];
    });
    avg = avg / docs.length || 1;
    var N = docs.length, maxAt = Date.now();
    docs.forEach(function (d, j) {
      var s = 0;
      Object.keys(qtf).forEach(function (t) {
        var f = d._f[t] || 0; if (!f) return;
        var idf = Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
        s += idf * (f * 2.5 / (f + 1.5 * (1 - 0.75 + 0.75 * dl[j] / avg)));
      });
      var recency = Math.max(0, 1 - (maxAt - (d.at || 0)) / (30 * 864e5));  // 30 天线性衰减
      d.score = s * d.weight + recency * 0.15;
    });
    return docs.filter(function (d) { return d.score > 0.35; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, k)
      .map(function (d) { return { text: d.text, day: d.day, score: +d.score.toFixed(3), src: d.src }; });
  }
  /* 弃答（LongMemEval 的 ABS 能力）：只有「查询里的实词确实出现在召回证据里」
     才算有证据。纯 BM25 分数会被「我 / 叫 / 什么」这类共享虚字骗过 ——
     实测「我孙子叫什么名字」会召回「我女儿叫小芳」，然后模型编出一个名字。
     这是检索结果的相关性校验（query-term coverage），不是意图规则。 */
  var VAGUE = /(我|你|他|她|它|的|了|吗|呢|啊|呀|吧|什么|怎么|哪|几|叫|名字|时候|请问|是不是|有没有|现在|今天|昨天|上次)/g;
  function anchorsOf(q) {
    var s = String(q || '').replace(VAGUE, ' ');
    var out = [];
    s.split(/\s+/).forEach(function (seg) {
      for (var i = 0; i < seg.length - 1; i++) {
        var g = seg.slice(i, i + 2);
        if (g.trim() && out.indexOf(g) < 0) out.push(g);
      }
      if (seg.length === 1 && seg.trim() && out.indexOf(seg) < 0) out.push(seg);
    });
    return out;
  }
  function hasEvidence(query, threshold) {
    var r = retrieve(query, 5);
    if (!r.length) return false;
    var a = anchorsOf(query);
    if (a.length) {
      var best = 0;
      r.forEach(function (h) {
        var c = a.filter(function (x) { return h.text.indexOf(x) >= 0; }).length / a.length;
        if (c > best) best = c;
      });
      if (best < 0.5) return false;
    }
    return r[0].score >= (threshold === undefined ? 0.35 : threshold);
  }

  /* ---------- core 画像（可单条编辑，对齐 Letta memory blocks） ---------- */
  function core() { return coreText; }
  function setCore(text) { coreText = String(text || '').slice(0, CORE_LIMIT); put(K_CORE, coreText); return coreText; }
  function compileCore() {
    var bits = [];
    try {
      var M = w.MILI_MEMO;
      if (M && M.memo) M.memo().slice(0, 12).forEach(function (f) {
        if (f && f.text && !/记忆分四类|第一类是|引擎|正则/.test(f.text)) bits.push(f.text);
      });
    } catch (e) {}
    try {
      var R = w.MILI_RHYTHM;
      if (R && R.profile) {
        var p = R.profile();
        Object.keys(p).forEach(function (k) {
          if (p[k] && p[k].t != null) {
            var hh = ('0' + Math.floor(p[k].t / 60)).slice(-2), mm = ('0' + (p[k].t % 60)).slice(-2);
            bits.push(k + '约' + hh + ':' + mm + (p[k].top ? '（' + p[k].top + '）' : ''));
          }
        });
      }
    } catch (e) {}
    var seen = {}, uniq = [];
    bits.forEach(function (b) { var k = b.replace(/\s/g, ''); if (!seen[k]) { seen[k] = 1; uniq.push(b); } });
    return setCore(uniq.join('；'));
  }

  /* ---------- 闲时精修（可选，需要时显式调，不在对话关键路径） ---------- */
  function refine(summarizer) {
    if (typeof summarizer !== 'function') return Promise.resolve(null);
    var cut = anchor(), slice = raw.slice(Math.max(0, cut - WORK_MAX), cut);
    if (!slice.length) return Promise.resolve(null);
    return Promise.resolve(summarizer(slice.map(function (m) { return m.role + '：' + m.text; }).join('\n')))
      .then(function (text) {
        if (!text) return null;
        ev.summaries.push({ day: slice[0].day, text: String(text).slice(0, SUMMARY_LIMIT),
                            from: slice[0].id || '', to: cut, at: Date.now(), refined: true });
        put(K_EVENT, ev);
        return String(text);
      });
  }

  function stats() {
    return { raw: raw.length, cutoff: anchor(), working: Math.max(0, raw.length - anchor()),
             summaries: ev.summaries.length, passes: ev.passes || 0,
             coreChars: coreText.length, writeOk: !STORE || STORE.writeOk !== false };
  }
  function history() { return raw.slice(); }
  function reset() { raw = []; ev = blankEvent(); coreText = ''; persist(); }

  w.MILI_CONTEXT = {
    push: push, compact: maybeCompact, histMessages: histMessages,
    retrieve: retrieve, hasEvidence: hasEvidence,
    core: core, setCore: setCore, compileCore: compileCore,
    refine: refine, stats: stats, history: history, reset: reset,
    tokenize: tokenize, extractive: extractive,
  };

  if (STORE && STORE.register) {
    STORE.register('context', {
      keys: [K_RAW, K_EVENT, K_CORE],
      wipe: function () { raw = []; ev = blankEvent(); coreText = ''; }
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
