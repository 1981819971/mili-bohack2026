/* ============================================================================
 * app/agent-memo.js — 事实记忆（facts）与成功工具序列（skills）
 *
 * 变化（2026-11-13 重构）：
 *   1. 存储收进 app/memory.js 的统一总线；一键清空走 MILI_STORE.clearAll()，
 *      本模块的 reset() 只清自己，别再把它当成全量清空。
 *   2. 事实与技能都改成 ADD-only：写入只追加，同 key 不覆盖正文。
 *      内容变了 → 给旧记录打 validTo / supersededBy，再追加新记录（Graphiti
 *      的 validity window）。删除同理，不物理删，家人端仍可追溯。
 *      来源：mem0 2026-04 single-pass ADD-only（早期让模型判 ADD/UPDATE/DELETE
 *      又慢又删错，才改成只追加）。
 *   3. 删掉写死在源码里的 5 条出厂 skill（其中 2 条是误学的抱怨句，会乱打
 *      视频）。现场要求「零状态到场」，出厂不该带学习成果。
 *   4. skillFind() 只保留「精确 → 同音归一」两级，砍掉尾部 2 字重叠兜底：
 *      命中即 0ms 直接执行工具，模糊匹配的代价是误拨电话，不能赌。
 *   5. save() 不再空吞 QuotaExceededError，写入失败由总线置 writeFailed。
 * ========================================================================== */
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : globalThis;
  var STORE = W.MILI_STORE || null;

  var MEMO_MAX = 60;
  var SKILL_MAX = 40;
  var SKILL_MIN_HIT = 1;   /* 技能：办成一次即可复用；作息画像的 >=3 次/>=3 天
                              是另一条判据，见 app.js MILI_RHYTHM，两者别混。 */
  var DEFAULT_KEY = 'mili.memory.v2';
  var KEY = DEFAULT_KEY;
  var ST = null;

  function now() { return Date.now(); }
  function uid(p) { return p + now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function blank() { return { v: 2, facts: [], skills: [], cnt: {} }; }
  function ensure() { if (!ST) load(); return ST; }

  function readKey(k) {
    var raw = STORE ? STORE.get(k) : (function () {
      try { return W.localStorage.getItem(k); } catch (e) { return null; }
    })();
    try { return JSON.parse(raw || 'null'); } catch (e) { return null; }
  }
  function save() {
    ensure();
    if (STORE) return STORE.put(KEY, ST);
    try { W.localStorage.setItem(KEY, JSON.stringify(ST)); return true; } catch (e) { return false; }
  }

  /* 老版本 {memo,skill,cnt} → 新版本 {facts,skills,cnt}，只迁移一次 */
  function migrate(old) {
    var out = blank();
    if (!old || typeof old !== 'object') return out;
    (old.memo || []).forEach(function (m) {
      if (!m || !m.text) return;
      out.facts.push({
        id: m.id || uid('m'), k: m.k || norm(m.text), kind: m.kind || 'fact',
        text: m.text, src: m.src || '', n: m.n || 1,
        validFrom: m.at || now(), validTo: null, supersededBy: null, at: m.at || now()
      });
    });
    (old.skill || []).forEach(function (s) {
      if (!s || !s.k || !Array.isArray(s.tools)) return;
      out.skills.push({
        id: s.id || uid('s'), k: s.k, text: s.text || s.k, tools: s.tools,
        n: s.n || 1, on: s.on !== false, ms: s.ms || 0,
        validFrom: s.at || now(), validTo: null, supersededBy: null, at: s.at || now()
      });
    });
    out.cnt = old.cnt || {};
    return out;
  }

  function normalizeState() {
    if (!ST || typeof ST !== 'object') ST = blank();
    if (!Array.isArray(ST.facts)) ST.facts = [];
    if (!Array.isArray(ST.skills)) ST.skills = [];
    if (!ST.cnt || typeof ST.cnt !== 'object') ST.cnt = {};
    ST.v = 2;
  }

  function registerBus() {
    if (!STORE) return;
    STORE.register('memo', {
      keys: [KEY, DEFAULT_KEY, 'mili_agent_memo', 'mili_demo_agent',
             'mili_memory_v2', 'mili_demo_memory_v2'],
      wipe: function () { ST = blank(); }
    });
  }

  function load(storeKey) {
    if (storeKey) KEY = String(storeKey) + '_memory_v2';
    var parsed = readKey(KEY);
    if (!parsed || !Array.isArray(parsed.facts)) {
      var legacy = readKey(storeKey ? storeKey + '_agent' : 'mili_agent_memo')
                || readKey('mili_agent_memo');
      ST = migrate(legacy);
    } else {
      ST = parsed;
    }
    normalizeState();
    registerBus();
    save();
    return ST;
  }

  /* 文本归一化：只去语气词和标点，不动实词（动实词会把「关」和「开」归一掉） */
  function norm(t) {
    return String(t || '')
      .replace(/[，。？！、,.?!~～\s]/g, '')
      .replace(/^(哎|诶|那个|这个|我说|你看|你就|麻烦|帮我|给我|劳驾)+/, '')
      .replace(/(啊|呀|哦|啦|呢|吧|呗|嘛|喽|嘞|哟)+$/g, '')
      .toLowerCase();
  }

  function activeFacts() { return ST.facts.filter(function (f) { return !f.validTo; }); }
  function activeSkills() { return ST.skills.filter(function (s) { return !s.validTo; }); }

  function trim() {
    /* 只裁「有效」记录的上限；失效历史保留，可追溯，但不参与召回 */
    var f = activeFacts();
    while (f.length > MEMO_MAX) { var old = f.pop(); old.validTo = now(); old.supersededBy = 'overflow'; }
    var s = activeSkills();
    while (s.length > SKILL_MAX) { var os = s.pop(); os.validTo = now(); os.supersededBy = 'overflow'; }
  }

  /** 打失效戳，不物理删除。返回是否找到。 */
  function supersede(id, byId, reason) {
    ensure();
    var all = ST.facts.concat(ST.skills);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id && !all[i].validTo) {
        all[i].validTo = now();
        all[i].supersededBy = byId || reason || 'user_delete';
        save();
        return true;
      }
    }
    return false;
  }

  /* ==========================================================================
   * 一、事实记忆（ADD-only + validity window）
   * ======================================================================== */

  /* 事实质量门：拒收系统说明、元叙述、提示词片段。
     真机曾把「聊天的记忆分四类：第一类是聊天历史」当成老人事实写进画像，
     之后每轮都注入 systemPrompt，把模型行为带偏。宁可少记，不许记错。 */
  var FACT_NOISE = /(记忆分四类|第一类是|第二类是|系统提示|systemPrompt|引擎|正则|schema|prompt|TODO|调试|function\s*\()/i;
  function factSane(t) {
    if (FACT_NOISE.test(t)) return false;
    if (t.length > 30 && /[{}[\]<>;=]/.test(t)) return false;  // 代码片段不是事实
    return true;
  }

  function memoAdd(kind, text, src, meta) {
    ensure();
    var t = String(text || '').trim();
    if (t.length < 2 || !factSane(t)) return null;
    var k = norm(t);
    if (!k) return null;

    var hit = activeFacts().find(function (m) { return m.k === k; });
    if (hit) {
      /* 只追加证据，不覆盖正文。内容真变了要走 supersede + 新记录。 */
      hit.n = (hit.n || 1) + 1;
      hit.at = now();
      if (meta && meta.tag) hit.tag = meta.tag;
      save();
      return hit;
    }
    var rec = {
      id: uid('m'), k: k, kind: kind || 'fact', text: t,
      src: src || '', tag: (meta && meta.tag) || '',
      n: 1, validFrom: now(), validTo: null, supersededBy: null, at: now()
    };
    ST.facts.unshift(rec);
    trim();
    save();
    return rec;
  }

  /* 中文 2/3-gram 滑窗。旧实现把整句当成一个片段（「我女儿叫什么」），
     跟记下的「我女儿叫小芳」一个片段都对不上；换成滑窗后「女儿」「儿叫」
     都能命中。虚词 gram 全部过滤，避免「什么 / 给我」把记忆整本捞出来。 */
  var STOP_GRAM = /^(我|你|他|她|它|这|那|的|了|吧|呢|啊|呀|吗|给我|帮我|麻烦|一下|什么|怎么|多少|请问|现在|今天|明天|昨天|是不是|有没有|我们|你们|他们)/;
  function grams(s) {
    var chars = String(s || '').replace(/[^\u4e00-\u9fa5]/g, '');
    var out = [], seen = {};
    for (var n = 2; n <= 3; n++) {
      for (var i = 0; i + n <= chars.length; i++) {
        var g = chars.slice(i, i + n);
        if (seen[g] || STOP_GRAM.test(g)) continue;
        seen[g] = 1;
        out.push(g);
      }
    }
    return out;
  }

  /** 阈值召回：归一化包含命中，或 >=2 个不同实词 gram 命中。
     老实现是「任意 >=2 字片段命中就返回」，问句里出现一个虚词就能全捞出来。 */
  function memoFind(q) {
    ensure();
    var s = String(q || '').trim();
    if (!s) return [];
    var nq = norm(s);
    var parts = grams(s);
    var out = [];
    activeFacts().forEach(function (m) {
      if (!m || !m.text) return;
      if (m.k && nq && (m.k.indexOf(nq) >= 0 || nq.indexOf(m.k) >= 0)) { out.push(m); return; }
      var overlap = 0;
      for (var i = 0; i < parts.length; i++) if (m.text.indexOf(parts[i]) >= 0) overlap++;
      if (overlap >= 2) out.push(m);
    });
    out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return out;
  }

  /** 结构化查询，替掉业务代码里 /看视频用/ 这类正则 grep 自然语言记忆的做法。 */
  function query(opts) {
    ensure();
    opts = opts || {};
    return activeFacts().filter(function (m) {
      if (opts.kind && m.kind !== opts.kind) return false;
      if (opts.tag && m.tag !== opts.tag) return false;
      if (opts.contains && String(m.text).indexOf(opts.contains) < 0) return false;
      return true;
    });
  }

  function memoByKind(kind) {
    ensure();
    return activeFacts().filter(function (m) { return m.kind === kind; });
  }
  function memoDel(id) { return supersede(id, null, 'user_delete'); }

  function memoBrief(limit) {
    ensure();
    var n = limit || 6;
    var list = activeFacts().slice(0, n);
    if (!list.length) return '';
    var tag = { fact: '事实', preference: '喜好', event: '要办的事' };
    return list.map(function (m) { return '·[' + (tag[m.kind] || '事实') + '] ' + m.text; }).join('\n');
  }

  /* ==========================================================================
   * 二、skill 复用
   * ======================================================================== */

  function skillKey(text) { return norm(text); }

  /* 只归并「说错了也不改意思」的字，方向字一个都不进来 */
  var HOMO = {
    '打': '大', '刷': '耍', '据': '剧', '句': '剧',
    '瞅': '看', '瞧': '看', '厅': '听', '抬': '台',
    '坐': '做', '作': '做', '圆': '元', '份': '分'
  };
  function homoKey(k) {
    var s = '', str = String(k || '');
    for (var i = 0; i < str.length; i++) s += (HOMO[str[i]] || str[i]);
    return s;
  }
  /* 开/关 必须一致，否则「开电视」会被「关电视」认走 */
  function dirOf(k) {
    if (/关|停|别|不要|取消/.test(k)) return 'off';
    if (/开|启动|播|放|来一个|来个/.test(k)) return 'on';
    return '';
  }

  function sameTools(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every(function (t, i) {
      return t && b[i] && t.name === b[i].name &&
        JSON.stringify(t.args || {}) === JSON.stringify(b[i].args || {});
    });
  }

  function skillNote(text, tools) {
    ensure();
    if (!tools || !tools.length) return null;
    var k = skillKey(text);
    if (!k || k.length < 2) return null;
    var seq = tools.map(function (t) { return { name: t.name, args: t.args || {} }; });

    var s = activeSkills().find(function (x) { return x.k === k; });
    if (s) {
      if (sameTools(s.tools, seq)) {
        s.n = (s.n || 1) + 1;
        s.at = now();
        if (s.n >= SKILL_MIN_HIT) s.on = true;
        save();
        return s;
      }
      /* 序列变了：旧版本打失效戳，追加新版本，不原地覆盖 */
      supersede(s.id, null, 'sequence_changed');
    }
    var rec = {
      id: uid('s'), k: k, text: String(text).slice(0, 60), tools: seq,
      n: 1, on: SKILL_MIN_HIT <= 1, ms: 0,
      validFrom: now(), validTo: null, supersededBy: null, at: now()
    };
    ST.skills.unshift(rec);
    trim();
    save();
    return rec;
  }

  /** 精确 → 同音归一，两级。
     已删除尾部 2 字重叠兜底：这里一命中就会 0ms 直接执行工具序列，
     模糊匹配错了就是误拨电话 / 误关桌宠，没有第二次确认的机会。 */
  function skillFind(text) {
    ensure();
    var k = skillKey(text);
    if (!k || k.length < 2) return null;
    var s = activeSkills().find(function (x) { return x.k === k && x.on; });
    if (s) return s;
    /* 同音比较要做全，不能只在「查询串自己含可归并字」时才做：
       HOMO 是单向的（打→大），存储串含「打」、查询串含「大」时，
       查询串的 homoKey 等于自身，旧写法会直接跳过这一级。 */
    var hk = homoKey(k), d = dirOf(k);
    s = activeSkills().find(function (x) {
      return x.on && x.k !== k && homoKey(x.k) === hk && dirOf(x.k) === d;
    });
    return s || null;
  }

  function skillCost(text, ms) {
    ensure();
    var s = activeSkills().find(function (x) { return x.k === skillKey(text); });
    if (!s) return;
    s.ms = ms;
    save();
  }
  function skillList() { ensure(); return activeSkills().slice(); }
  function skillDel(id) {
    if (STORE) STORE.markDeletedSkill(id);   /* 阻止 mergeDefaults 把它加回来 */
    return supersede(id, null, 'user_delete');
  }
  function skillOn(id, on) {
    ensure();
    var s = activeSkills().find(function (x) { return x.id === id; });
    if (!s) return false;
    s.on = !!on;
    save();
    return true;
  }

  /** 只补本机没有的；用户显式删过的、已作废的一律不复活。
     默认列表为空 —— 出厂零状态，不带任何「学过的」痕迹。 */
  function mergeDefaults(list) {
    ensure();
    if (!Array.isArray(list) || !list.length) return 0;
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.k || !Array.isArray(s.tools) || !s.tools.length) continue;
      if (s.id && STORE && STORE.wasDeletedSkill(s.id)) continue;
      if (ST.facts.concat(ST.skills).some(function (x) { return x.id === s.id && !x.validTo; })) continue;
      if (activeSkills().some(function (x) { return x.k === s.k; })) continue;
      ST.skills.push({
        id: s.id || uid('builtin_'), k: s.k, text: s.text || s.k,
        tools: s.tools.map(function (t) { return { name: t.name, args: t.args || {} }; }),
        n: 1, on: s.on !== false, ms: 0,
        validFrom: now(), validTo: null, supersededBy: null, at: now()
      });
      added++;
    }
    trim();
    if (added) save();
    return added;
  }

  /* ==========================================================================
   * 三、计数
   * ======================================================================== */
  function bump(text) {
    ensure();
    var k = skillKey(text);
    if (!k) return 0;
    ST.cnt[k] = (ST.cnt[k] || 0) + 1;
    var ks = Object.keys(ST.cnt);
    if (ks.length > 200) {
      ks.sort(function (a, b) { return ST.cnt[a] - ST.cnt[b]; });
      for (var i = 0; i < 40; i++) delete ST.cnt[ks[i]];
    }
    save();
    return ST.cnt[k];
  }
  function countOf(text) { ensure(); return ST.cnt[skillKey(text)] || 0; }

  function reset() {
    /* 只清本模块。全量清空请用 MILI_STORE.clearAll()。 */
    ST = blank();
    save();
    return ST;
  }

  /* ==========================================================================
   * 对外（保持旧 API 全部可用，app.js 不用改调用点）
   * ======================================================================== */
  W.MILI_MEMO = {
    load: load,
    save: save,
    norm: norm,
    add: memoAdd,
    find: memoFind,
    query: query,
    byKind: memoByKind,
    del: memoDel,
    supersede: supersede,
    brief: memoBrief,
    memo: function () { ensure(); return activeFacts().slice(); },
    memoCount: function () { ensure(); return activeFacts().length; },
    note: skillNote,
    hit: skillFind,
    cost: skillCost,
    skills: skillList,
    skillDel: skillDel,
    skillOn: skillOn,
    mergeDefaults: mergeDefaults,
    skillCount: function () { ensure(); return activeSkills().length; },
    skillReady: function () { ensure(); return activeSkills().filter(function (s) { return s.on; }).length; },
    bump: bump,
    count: countOf,
    history: function () { ensure(); return { facts: ST.facts.slice(), skills: ST.skills.slice() }; },
    raw: function () { ensure(); return ST; },
    reset: reset
  };
})();
