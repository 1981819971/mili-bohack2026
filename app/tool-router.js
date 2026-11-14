/* ============================================================================
 * app/tool-router.js — 动态工具检索（意图识别层）
 *
 * 为什么有这个文件：
 *   69 个工具 schema 全量注入每轮要 8K tokens，且 RAG-MCP 实测这种
 *   Blank Conditioning 下工具选择准确率只有 13.62%；检索式 top-k 是 43.13%。
 *   以前靠「模型在 69 个 schema 里挑」，同一句两次跑会选不同工具 ——
 *   这不是模型笨，是候选集里干扰项太多。
 *
 * 借鉴（只抄算法，不引依赖）：
 *   RAG-MCP (arXiv:2505.03275) 检索式工具选择；
 *   MCPProxy 的论证：结构化工具名/描述用 BM25 比向量更准、确定、可调试；
 *   Anthropic Tool Search Tool 的 deferred loading 思想；
 *   LongMemEval 的 hybrid 结论：向量为主时加 10% BM25 显著提升 Recall@1。
 *
 * 硬约束：
 *   ！不新增任何意图正则。这里只有分词 + 检索 + 打分，没有 if(/看|听/) 路由。
 *   ！零额外模型回合：检索在本地完成，不增加现场延迟。
 *   ！低置信度退回全量，绝不硬猜。
 *   ！所有工具名必须过 MILI_TOOLS.has() 白名单。
 * ========================================================================== */
(function (w) {
  'use strict';

  var STORE = w.MILI_STORE || null;
  var KEY = 'mili.tool.corrections';
  var MAX_CORRECTIONS = 200;
  var TOP_K = 8;
  var K1 = 1.5, B = 0.75;

  /* 域目录：静态文本，只是检索用的语料，不是意图规则。
     每组给一组老人真实说法当「语义锚」，等价于 semantic-router 的 Route utterances，
     但通过 BM25 参与打分，不做任何 if/else 匹配。 */
  var DOMAINS = {
    comm:  { label: '通讯 联系 打电话 发消息 微信 短信 视频通话 接电话 挂断 通知 联系人 闺女 女儿 老伴',
             tools: ['call_phone', 'wechat_message', 'wechat_call', 'wechat_redpacket', 'send_sms',
                     'answer_call', 'hang_up', 'read_notifications', 'grab_redpacket'] },
    media: { label: '看戏 看电视 看视频 短剧 新闻 戏曲 频道 换台 下一集 暂停 全屏 接着看 播放 音量 亮度',
             tools: ['ir_power', 'tv_next', 'player_control', 'play_video', 'watch_video', 'media',
                     'tv_channel', 'watch_news', 'play_direct', 'resume_show', 'volume',
                     'set_brightness', 'search_in_app'] },
    ui:    { label: '点一下 屏幕上 找按钮 输入文字 滑动 翻页 返回 截图 看屏幕 复制 粘贴 长按 等一下',
             tools: ['ui_map', 'tap_at', 'swipe_screen', 'wait_for', 'find_text', 'press_key',
                     'long_press', 'screen_text', 'tap_text', 'type_text', 'paste_text',
                     'scroll_screen', 'go_back', 'read_screen', 'look_screen', 'tap_result'] },
    health:{ label: '吃药 药箱 血压 心率 体温 记录 摔倒 头晕 急救 救命 求助 挂号 预约 闹钟 提醒 任务',
             tools: ['check_meds', 'log_vital', 'vital_report', 'register_hospital', 'emergency',
                     'fall_answer', 'set_alarm', 'add_task', 'list_tasks', 'finish_task'] },
    info:  { label: '今天几号 农历 星期 天气 搜一下 查一查 想起来了 记住 回忆 地图 导航 悟空 网址 打开应用',
             tools: ['search_web', 'search_wukong', 'open_map', 'open_url', 'open_app', 'list_apps',
                     'remember', 'recall', 'get_weather', 'today_info', 'tell_time'] },
    device:{ label: '手电筒 拍照 桌宠 语速 声音大小 设置 开关',
             tools: ['torch', 'take_photo', 'pet_toggle', 'set_speech_rate'] },
    pay:   { label: '付钱 收款 扫码 付款码 收红包 买东西 购物 确认 取消',
             tools: ['scan_pay', 'receive_code', 'wechat_scan', 'wechat_pay_code', 'shop_search',
                     'confirm_pending', 'cancel_pending'] },
  };

  /* 每次都带上的通用工具（对齐 agent.js 的 TOOL_ALWAYS）。 */
  var ALWAYS = ['search_web', 'recall', 'remember', 'tell_time', 'read_screen', 'go_back'];

  var domainOf = {};
  Object.keys(DOMAINS).forEach(function (d) {
    DOMAINS[d].tools.forEach(function (n) { (domainOf[n] = domainOf[n] || []).push(d); });
  });

  /* ---------- 分词：中文 char-bigram + 单字 + 英文/数字词 ----------
     纯字符切分，不含任何「意图」判定；只是把文本变成可检索的 term。 */
  function tokenize(s) {
    var out = [];
    var str = String(s || '').toLowerCase();
    var buf = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      var code = str.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) {
        if (buf) { out.push(buf); buf = ''; }
        out.push(c);
        if (i + 1 < str.length) {
          var c2 = str.charAt(i + 1), c2code = str.charCodeAt(i + 1);
          if (c2code >= 0x4e00 && c2code <= 0x9fff) out.push(c + c2);
        }
      } else if (/[a-z0-9_]/.test(c)) {
        buf += c;
      } else {
        if (buf) { out.push(buf); buf = ''; }
        if (c === '_') out.push('_');
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  function termFreq(terms) {
    var f = {};
    for (var i = 0; i < terms.length; i++) f[terms[i]] = (f[terms[i]] || 0) + 1;
    return f;
  }

  /* ---------- BM25 ---------- */
  function bm25(qTerms, docs) {
    var N = docs.length;
    if (!N) return {};
    var df = {}, dl = [], avgdl = 0;
    docs.forEach(function (d, i) {
      var tf = termFreq(d.terms);
      Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      d._tf = tf;
      dl[i] = d.terms.length;
      avgdl += dl[i];
    });
    avgdl = avgdl / N || 1;
    var qtf = termFreq(qTerms);
    var scores = {};
    docs.forEach(function (d, i) {
      var s = 0;
      Object.keys(qtf).forEach(function (t) {
        var f = d._tf[t] || 0;
        if (!f) return;
        var idf = Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
        var norm = f * (K1 + 1) / (f + K1 * (1 - B + B * dl[i] / avgdl));
        s += idf * norm * Math.min(3, qtf[t]);
      });
      scores[d.name] = (scores[d.name] || 0) + s * (d.weight || 1);
    });
    return scores;
  }

  /* ---------- 改口样本：进化的检索正反馈 ----------
     老人换说法办成后记一条 (原话, 工具)。它不是规则，是额外文档：
     下次相似说法检索时，该工具的语料里多了一条真实老人原话，排序自然上移。
     同一件事满 3 次（或跨 3 天）才把权重提到稳定档 —— 对齐权威口径阈值。 */
  var corrections = loadCorrections();

  function loadCorrections() {
    try { return JSON.parse((STORE && STORE.get ? STORE.get(KEY) : w.localStorage.getItem(KEY)) || '[]') || []; }
    catch (e) { return []; }
  }
  function saveCorrections() {
    try {
      var s = JSON.stringify(corrections);
      if (STORE && STORE.put) STORE.put(KEY, s); else w.localStorage.setItem(KEY, s);
      return true;
    } catch (e) { return false; }
  }

  function learn(utterance, toolName) {
    var u = String(utterance || '').trim().slice(0, 120);
    var n = String(toolName || '').trim();
    if (!u || !n || (w.MILI_TOOLS && !w.MILI_TOOLS.has(n))) return false;
    var day = STORE && STORE.localDay ? STORE.localDay() : String(Date.now()).slice(0, 10);
    var hit = null;
    for (var i = 0; i < corrections.length; i++) {
      if (corrections[i].u === u && corrections[i].tool === n) { hit = corrections[i]; break; }
    }
    if (hit) {
      hit.n = (hit.n || 1) + 1;
      if (hit.days.indexOf(day) < 0) hit.days.push(day);
      hit.at = Date.now();
    } else {
      corrections.push({ u: u, tool: n, n: 1, days: [day], at: Date.now() });
    }
    if (corrections.length > MAX_CORRECTIONS) {
      /* 次数降序；次数相同按时间降序 —— 老人**最新**学会的说法最该留住。
         只按 n 排时全是 n=1，稳定排序会保留最早的 200 条、把最新的截掉。
         同一毫秒内的多条 at 相同，所以再拿数组下标兜底：越靠后越新。 */
      var order = new Map();
      corrections.forEach(function (c, i) { order.set(c, i); });
      corrections.sort(function (a, b) {
        return (b.n || 0) - (a.n || 0) || (b.at || 0) - (a.at || 0) ||
               (order.get(b) - order.get(a));
      });
      corrections.length = MAX_CORRECTIONS;
    }
    return saveCorrections();
  }

  function stable(c) { return (c.n || 0) >= 3 || (c.days && c.days.length >= 3); }

  /* 回退单条学习：删掉某句话对某个工具的样本。
     回退是「skill + correction 两份记录一起退」，只删 skill 的话，
     BM25 里那条真实原话还在，下次还会把同一个工具往上顶。
     技能记录的 text 截到 60 字，所以按前 60 字比对，不做模糊包含。 */
  function forget(utterance, toolName) {
    var t = String(utterance || '').trim();
    if (!t) return 0;
    var n = String(toolName || '').trim();
    var cut = t.slice(0, 60);
    var before = corrections.length;
    corrections = corrections.filter(function (c) {
      var sameTool = !n || c.tool === n;
      var sameText = c.u === t || String(c.u || '').slice(0, 60) === cut;
      return !(sameTool && sameText);
    });
    var removed = before - corrections.length;
    if (removed) saveCorrections();
    return removed;
  }

  /* ---------- 建索引 ---------- */
  function buildDocs() {
    var all = (w.MILI_TOOLS && w.MILI_TOOLS.schema) ? w.MILI_TOOLS.schema() : [];
    var docs = [];
    all.forEach(function (t) {
      var fn = t.function || {};
      var name = fn.name || '';
      var pnames = Object.keys((fn.parameters && fn.parameters.properties) || {});
      var ds = domainOf[name] || [];
      /* 三份文档分开建：名称权重最高（「微信」必须压过「发」这类通用字），
         描述/参数居中，域标签只做轻微偏置 —— 否则同域所有工具分数被拉平，
         检索等于没做（第一版实测 send_sms 与 wechat_message 只差 1.5%）。 */
      docs.push({ name: name, terms: tokenize(name.replace(/_/g, ' ')), weight: 2.2 });
      docs.push({ name: name, terms: tokenize([fn.description || '', pnames.join(' ')].join(' ')), weight: 1 });
      ds.forEach(function (d) {
        docs.push({ name: name, terms: tokenize(DOMAINS[d].label), weight: 0.25 });
      });
    });
    /* 改口样本作为额外文档：稳定样本权重更高（Rocchio 式正反馈） */
    corrections.forEach(function (c) {
      if (!c.u || !c.tool) return;
      docs.push({ name: c.tool, terms: tokenize(c.u), weight: stable(c) ? 2.2 : 1.2 });
    });
    return { docs: docs, all: all };
  }

  /* ---------- 选工具 ----------
     返回 { tools, names, scores, confidence, fallback }。
     fallback=true 表示低置信度，调用方应退回全量 schema（绝不硬猜）。 */
  function select(text, opts) {
    opts = opts || {};
    var built = buildDocs();
    if (!built.all.length) return { tools: [], names: [], scores: {}, confidence: 0, fallback: true };
    var q = tokenize(text);
    var scores = bm25(q, built.docs);

    /* 已用过的工具 + 同族：保留原 toolSubset 的「别逼它说办不了」优点。
       这是运行时状态偏置，不是意图规则。 */
    (opts.used || []).forEach(function (n) {
      scores[n] = (scores[n] || 0) + 3;
      var ds = domainOf[n] || [];
      ds.forEach(function (d) {
        DOMAINS[d].tools.forEach(function (m) { scores[m] = (scores[m] || 0) + 0.8; });
      });
    });
    /* 最近用过的工具轻微 recency boost（LongMemEval hybrid 结论） */
    (opts.recent || []).forEach(function (n, i) {
      scores[n] = (scores[n] || 0) + Math.max(0, 1.5 - i * 0.3);
    });

    var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; });
    var top1 = scores[ranked[0]] || 0;
    var top2 = scores[ranked[1]] || 0;
    var ambiguous = top1 > 0 && (top1 - top2) / top1 < 0.06;  // 前两名分不开
    var weak = top1 < (opts.minScore === undefined ? 1.2 : opts.minScore);
    /* 只有真的没信号才退回全量。分不开 ≠ 没信号：把领先工具所在域整组带上，
       既保留兄弟工具（toolSubset 的老教训），又不会退回 69 个全量。 */
    var fallback = !q.length || weak;

    var k = opts.topK || TOP_K;
    var picked = {};
    ALWAYS.forEach(function (n) { picked[n] = 1; });
    ranked.slice(0, k).forEach(function (n) { if (scores[n] > 0) picked[n] = 1; });
    if (ambiguous) {
      (domainOf[ranked[0]] || []).forEach(function (d) {
        DOMAINS[d].tools.forEach(function (n) { picked[n] = 1; });
      });
    }

    var names = Object.keys(picked).filter(function (n) {
      return !w.MILI_TOOLS || w.MILI_TOOLS.has(n);
    });
    var tools = built.all.filter(function (t) { return names.indexOf((t.function || {}).name) >= 0; });

    /* 太少就退回全量，宁可多花几 K 也别让它没得选 */
    if (tools.length < 6 || fallback) {
      return { tools: built.all, names: built.all.map(function (t) { return (t.function || {}).name; }),
               scores: scores, confidence: top1, fallback: true };
    }
    return { tools: tools, names: names, scores: scores, confidence: top1, fallback: false };
  }

  function stats() {
    return { corrections: corrections.length, stable: corrections.filter(stable).length,
             domains: Object.keys(DOMAINS).length };
  }

  w.MILI_TOOL_ROUTER = {
    select: select,
    learn: learn,
    stats: stats,
    tokenize: tokenize,
    bm25: bm25,
    corrections: function () { return corrections.slice(); },
    forget: forget,
    reset: function () { corrections = []; return saveCorrections(); },
  };

  /* 一键清空必须连改口样本一起退 */
  if (STORE && STORE.register) {
    STORE.register('tool-router', { keys: [KEY], wipe: function () { corrections = []; } });
  }
})(typeof window !== 'undefined' ? window : globalThis);
