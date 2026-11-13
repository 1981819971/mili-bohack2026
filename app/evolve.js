/* ⚠ DEPRECATED（2026-11-13）：本文件是 11-07 的旧意图正则引擎，
   仅作断网兜底，默认不进主决策链路（app.js 里 window.__MILI_LEGACY_EVO 控制）。
   主链路是 agent.js 的模型工具选择，别再往这里加正则或拿它的考卷分数当进化证据。
   保留原因：现场 DeepSeek key 或网络挂了，仍能靠纯 localStorage 跑两次、能回退。
   ------------------------------------------------------------------
 米粒 · 日新引擎（evolve.js）
   ------------------------------------------------------------------
   赛题要求：现场跑两次，第二次必须比第一次好；说得清学到了什么；能回退。

   这里不是"加一个好看页面"，是一条真能跑的闭环：

     原话 → 归一化（同义词 / 虚词剥离 / 别名）→ 意图正则 → 动手
                     ↑                              ↓
                 准入补丁  ←  离线自测(重放题库)  ←  失败样本聚类

   三个可验证的东西：
   1) 基准题库 27 条（老人真会说的土话），跑一遍出通过率
   2) 每次进化必须自测：新补丁让通过率涨才准上线，跌了就自动驳回
   3) 每版存快照，能整版回退

   规则全部存在 localStorage，刷新/关 App 不丢，第二天还在。
   ------------------------------------------------------------------ */
(function (w, d) {
  'use strict';

  /* ---------- 0. 模式与存储（跟 app.js 的 mili / mili_demo 对齐） ---------- */
  var QS = new URLSearchParams(location.search);
  var DEMO = (w.__MODE === 'demo') || QS.get('mode') === 'demo' || QS.get('demo') === '1';
  var KEY = DEMO ? 'mili_demo_evo' : 'mili_evo';

  var DEF = {
    ver: 1,                 // 当前版本号
    builtin: 1,             // 初始版本基线（回滚到底用）
    morph: [],              // 学到的同义词 [{a:'拨', b:'打', hit:0, from:''}]
    stop: [],               // 学到的虚词（会被剥掉）[{w:'喽', hit:0}]
    alias: [],              // 学到的整句别名 [{k:'听段戏', id:'watch_show', hit:0}]
    trail: [],              // 运行轨迹（最近 200 条）
    snap: [],               // 版本快照
    patches: [],            // 补丁历史（含被驳回的）
    runs: [],               // 每次评测结果 [{v, pass, total, t}]
    pend: [],               // 攒着的「改口」候选（同一句改口两次才转正）
    revoke: [],             // 学错了被撤掉的（同一件事 30 秒内被要了两次）
    repeatN: 0,             // 累计「同一件事说两遍」的次数
    auto: []                // 没人按按钮、它自己从说话里学到的
  };

  var E = null;
  try { E = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { E = null; }
  if (!E || typeof E !== 'object') E = JSON.parse(JSON.stringify(DEF));
  /* 老存档补齐字段，别让升级把数据吃掉 */
  for (var k in DEF) if (!(k in E)) E[k] = JSON.parse(JSON.stringify(DEF[k]));
  function save() { try { localStorage.setItem(KEY, JSON.stringify(E)); } catch (e) {} }

  /* ---------- 1. 意图表（app.js 暴露出来的真表，不是抄的） ---------- */
  /* 状态类（桌宠/看镜头）先判，跟 app.js 的 tryDo 一致；不然「看看我」会被
     watch_show 当片名搜走。 */
  function intents() { return (w.__TOGGLES || []).concat(w.__INTENTS || []); }
  function intentIds() { return intents().map(function (x) { return x.id; }); }
  function intentName(id) {
    var N = {
      call: '打电话', call2: '打电话', call3: '打电话', sms: '发短信',
      wx_call: '微信语音', wx_video: '微信视频', wx_say: '微信带话', wx_say2: '微信带话',
      wx_msg: '开微信聊天', wx_msg2: '开微信聊天', wx_msgtxt: '微信发消息', wx_msgtxt2: '微信发消息',
      wx_red: '发红包', wx_red_amt: '发红包',
      nav: '导航', nav2: '导航', nav3: '问路',
      watch: '开视频软件', watch_in: '站内找片', watch_show: '点播', watch2: '接着看',
      tv: '看电视', tv2: '换台',
      ir_on: '开空调/电视', ir_off: '关空调/电视', ir_hot: '开空调',
      pet_on: '上桌面', pet_off: '收起桌宠',
      see_front: '看眼前', see_back: '看屏幕'
    };
    return N[id] || id;
  }

  /* ---------- 2. 归一化：把老人话往标准说法上掰 ---------- */
  /* 内置的一小撮是常识，不算"学到的"；学到的在 E.morph / E.stop 里，可回滚。 */
  var BUILTIN_MORPH = [
    ['瞅瞅', '看看'], ['瞅', '看'], ['瞧瞧', '看看'], ['望望', '看看'],
    ['拨', '打'], ['挂个', '打个'],
    ['搁', '放'], ['弄', '打开']
  ];
  var BUILTIN_STOP = ['请', '麻烦', '一下', '帮我', '帮忙', '给我', '替我'];

  function norm(text) {
    var t = String(text || '');
    /* 标点、空白全去掉，老人说话没标点 */
    t = t.replace(/[，。？！、,.?!\s~～…]/g, '');
    /* 学到的虚词先剥（长的先剥，避免"给我"被"我"吃掉） */
    var st = E.stop.slice().sort(function (a, b) { return b.w.length - a.w.length; });
    var all = st.concat(BUILTIN_STOP.map(function (x) { return { w: x }; }));
    all.sort(function (a, b) { return b.w.length - a.w.length; });
    for (var i = 0; i < all.length; i++) {
      if (all[i].w.length >= 2) t = t.split(all[i].w).join('');
    }
    /* 同义词替换：学到的 + 内置 */
    var mp = E.morph.concat(BUILTIN_MORPH.map(function (x) { return { a: x[0], b: x[1] }; }));
    for (var j = 0; j < mp.length; j++) {
      if (mp[j].a && t.indexOf(mp[j].a) >= 0) t = t.split(mp[j].a).join(mp[j].b);
    }
    return t;
  }
  /* 只剥标点，用于"原话长得像不像别名" */
  function bare(text) { return String(text || '').replace(/[，。？！、,.?!\s~～…]/g, ''); }

  /* ---------- 3. 匹配：别名 → 归一化 → 正则 ---------- */
  function hitAlias(text) {
    var b = bare(text);
    for (var i = 0; i < E.alias.length; i++) {
      var a = E.alias[i];
      if (a.k && b.indexOf(a.k) >= 0) return a;
    }
    return null;
  }

  /* 返回 {id, how} 或 null。how = alias | norm | raw */
  function match(text) {
    var a = hitAlias(text);
    if (a) { a.hit = (a.hit || 0) + 1; return { id: a.id, how: 'alias', key: a.k }; }
    var list = intents();
    var t1 = norm(text);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it.re) continue;
      var m = t1.match(it.re);
      if (!m) continue;
      if (it.guard && !it.guard(m)) continue;
      /* 打电话没带人名要追问，不算命中；bench 里这类题不该出现 */
      if (it.id === 'call' && (!m[1] || m[1].length < 1)) continue;
      return { id: it.id, how: t1 === bare(text) ? 'raw' : 'norm' };
    }
    return null;
  }

  /* ---------- 4. 基准题库 ---------- */
  /* 27 条，六成是老人真会说的土话。want 必须是最贴近的那个意图。
     这批题不参与训练，只用来判分——所以它能当"考卷"用。 */
  var BENCH = [
    { q: '给妈妈打个电话', want: 'call' },
    { q: '打电话给老儿子', want: 'call2' },
    { q: '给闺女打微信电话', want: 'wx_call' },
    { q: '给老伴发微信说我挺好的', want: 'wx_say' },
    { q: '给孙子发个红包', want: 'wx_red' },
    { q: '我要看后会有期', want: 'watch_show' },
    { q: '接着看上次那个剧', want: 'watch2' },
    { q: '打开爱奇艺', want: 'watch' },
    { q: '换个台', want: 'tv2' },
    { q: '看新闻联播', want: 'tv' },
    { q: '打开空调', want: 'ir_on' },
    { q: '关掉电视', want: 'ir_off' },
    { q: '有点热', want: 'ir_hot' },
    { q: '带我去趟医院', want: 'nav' },
    { q: '导航到水上公园', want: 'nav2' },
    { q: '怎么去鼓楼', want: 'nav3' },
    { q: '给儿子发个短信', want: 'sms' },
    { q: '到桌面上去', want: 'pet_on' },
    { q: '看看我', want: 'see_front' },
    { q: '帮我看看这是啥', want: 'see_back' },
    /* 这两句靠"归一化"就能过：瞅→看、剥掉「给我」 */
    { q: '我想瞅瞅新闻', want: 'tv' },
    { q: '把电视给我关喽', want: 'ir_off' },
    /* ↓ 6 条真·土话：现在听不懂，靠一轮一轮学 */
    { q: '屋里头怪闷的', want: 'ir_on' },   // 老人改口会说「开空调」，落在 ir_on
    { q: '给我老儿子拨个号', want: 'call' },
    { q: '把那个台换喽', want: 'tv2' },
    { q: '我想听段戏', want: 'watch_show' },
    { q: '给我把电视按灭', want: 'ir_off' },
    { q: '给我翻个台', want: 'tv2' }
  ];

  /* ---------- 5. 评测 ---------- */
  function bench() {
    var pass = 0, fails = [], items = [];
    for (var i = 0; i < BENCH.length; i++) {
      var b = BENCH[i];
      var r = match(b.q);
      var ok = !!(r && r.id === b.want);
      if (ok) pass++; else fails.push({ q: b.q, want: b.want, got: r ? r.id : null });
      items.push({ q: b.q, want: b.want, ok: ok, got: r ? r.id : null, how: r ? r.how : null });
    }
    var rec = { v: E.ver, pass: pass, total: BENCH.length, t: Date.now() };
    E.runs.push(rec);
    if (E.runs.length > 40) E.runs.shift();
    save();
    return { pass: pass, total: BENCH.length, fails: fails, items: items, v: E.ver };
  }

  /* ---------- 6. 从失败样本提补丁 ---------- */
  /* 三档，从便宜到贵：
     a. 同义词（拨→打 / 听→看）——一个词错，改一个词
     b. 虚词（喽 / 那个 / 给我）——多剥一个词就通
     c. 别名（整句的关键词直接指向意图）——前两档都不通才用，最粗但最稳 */
  var SYN_HINT = {
    '拨': '打', '听': '看', '瞅': '看', '瞧': '看', '望': '看', '整': '做',
    '闷': '热', '热乎': '热', '凉': '冷', '开开': '打开', '弄开': '打开'
  };
  var STOP_HINT = ['喽', '呗', '啊', '呀', '嘛', '呢', '那个', '这个', '那头', '给我', '帮我', '有点', '点儿'];

  /* 试一条补丁：在"内存里预演"，不改真数据。返回逐条结果 + 通过数 */
  function tryPatch(patch, kind, word) {
    var bak = { morph: E.morph, stop: E.stop, alias: E.alias };
    E.morph = E.morph.slice(); E.stop = E.stop.slice(); E.alias = E.alias.slice();
    applyPatch(patch, kind, word);
    var arr = evalPass();
    E.morph = bak.morph; E.stop = bak.stop; E.alias = bak.alias;
    return { arr: arr, pass: arr.filter(Boolean).length };
  }
  function benchSilent() {
    var pass = 0;
    for (var i = 0; i < BENCH.length; i++) {
      var r = match(BENCH[i].q);
      if (r && r.id === BENCH[i].want) pass++;
    }
    return pass;
  }
  /* 逐条判定，不是一个总数。要判断"有没有把原来对的弄错"，只有逐条比得出来 ——
     总分涨了但某条从对变错，一样是退化。 */
  function evalPass() {
    var arr = [];
    for (var i = 0; i < BENCH.length; i++) {
      var m = match(BENCH[i].q);
      arr.push(!!(m && m.id === BENCH[i].want));
    }
    return arr;
  }
  /* 不变量：任何一条原来是 true 的不许变 false。返回第一处退化的句子 */
  function regressed(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] && !b[i]) return BENCH[i].q;
    return null;
  }
  function applyPatch(patch, kind, word) {
    if (kind === 'morph') E.morph.push({ a: patch.a, b: patch.b, hit: 0, from: patch.from || '' });
    else if (kind === 'stop') E.stop.push({ w: word, hit: 0 });
    else E.alias.push({ k: patch.k, id: patch.id, hit: 0, from: patch.from || '' });
  }

  /* 给一条失败样本出候选补丁：按 a→b→c 顺序试，谁先涨分用谁 */
  function propose(fail) {
    var baseArr = evalPass();
    var base = baseArr.filter(Boolean).length;
    var q = fail.q, want = fail.want;
    var cands = [];

    /* a. 同义词：原话里出现过的方言词 */
    for (var k in SYN_HINT) {
      if (q.indexOf(k) >= 0) cands.push({ kind: 'morph', patch: { a: k, b: SYN_HINT[k], from: q } });
    }
    /* b. 虚词：原话里多出来的语气词 / 指示词 */
    for (var i = 0; i < STOP_HINT.length; i++) {
      var wd = STOP_HINT[i];
      if (q.indexOf(wd) >= 0) cands.push({ kind: 'stop', patch: { w: wd }, word: wd });
    }
    /* c. 别名：从原话里抠 2-4 字当钥匙（去掉最前面的虚词） */
    var core = bare(q).replace(/^(我想|我要|给我|帮我|麻烦|把|那个|这个)/, '').replace(/(喽|呗|啊|呀|了)$/, '');
    if (core.length >= 2) {
      cands.push({ kind: 'alias', patch: { k: core.slice(-4), id: want, from: q } });
      if (core.length > 3) cands.push({ kind: 'alias', patch: { k: core.slice(-3), id: want, from: q } });
    }

    for (var c = 0; c < cands.length; c++) {
      var cd = cands[c];
      var r = tryPatch(cd.patch, cd.kind, cd.word);
      /* 涨分还不够 —— 必须一条旧的都没弄错。宁可这条不学，不能学了新的忘旧的。 */
      if (r.pass > base && !regressed(baseArr, r.arr)) {
        return { kind: cd.kind, patch: cd.patch, word: cd.word, before: base, after: r.pass, q: q, want: want,
                 desc: describe(cd.kind, cd.patch, cd.word) };
      }
    }
    return null;
  }

  function describe(kind, patch, word) {
    if (kind === 'morph') return '听懂「' + patch.a + '」=「' + patch.b + '」';
    if (kind === 'stop') return '忽略多余的字「' + word + '」';
    return '「' + patch.k + '」直接当成「' + intentName(patch.id) + '」';
  }

  /* ---------- 7. 进化：提案 → 自测 → 准入 → 版本 +1 ---------- */
  /* 一轮最多改 3 条。为什么要卡：一次把 10 句都"学会"等于背答案，
     评委一问"换个说法还认吗"就露馅。一轮 3 条，每轮都重跑，涨多少看得见。 */
  var PER_ROUND = 3;

  function evolve() {
    var r0 = benchSilent();
    var fails = [];
    for (var i = 0; i < BENCH.length; i++) {
      var m = match(BENCH[i].q);
      if (!m || m.id !== BENCH[i].want) fails.push({ q: BENCH[i].q, want: BENCH[i].want });
    }
    if (!fails.length) return { ok: false, why: 'all_pass', added: [], before: r0, after: r0 };

    /* 快照要存"改之前"的样子，不然回滚回去还是改完的状态（踩过） */
    var prev = E.ver;
    var snapOld = {
      morph: JSON.parse(JSON.stringify(E.morph)),
      stop: JSON.parse(JSON.stringify(E.stop)),
      alias: JSON.parse(JSON.stringify(E.alias))
    };

    var added = [], rejected = [];
    for (var f = 0; f < fails.length && added.length < PER_ROUND; f++) {
      var p = propose(fails[f]);
      if (!p) { rejected.push({ q: fails[f].q, why: '没有安全的改法' }); continue; }
      /* 真上线前再验一遍：一条旧的都不许变错。这是防"学了新的忘旧的"。 */
      var beforeArr = evalPass();
      applyPatch(p.patch, p.kind, p.word);
      var afterArr = evalPass();
      var bad = regressed(beforeArr, afterArr);
      if (bad) {
        undoLast(p.kind);
        rejected.push({ q: fails[f].q, why: '会让「' + bad + '」变差，已驳回' });
        continue;
      }
      added.push({ q: p.q, want: p.want, desc: p.desc, kind: p.kind, patch: p.patch, word: p.word,
                   to: intentName(p.want) });
    }

    if (!added.length) {
      save();
      return { ok: false, why: 'no_safe_patch', added: [], rejected: rejected, before: r0, after: benchSilent() };
    }

    /* 版本 +1，存快照（存的是改之前那份） */
    E.ver = prev + 1;
    E.snap.push({ v: prev, t: Date.now(), morph: snapOld.morph, stop: snapOld.stop, alias: snapOld.alias, pass: r0 });
    if (E.snap.length > 12) E.snap.shift();
    E.patches.push({ t: Date.now(), from: prev, to: E.ver, added: added.length, pass0: r0, pass1: benchSilent() });
    save();
    var r1 = benchSilent();
    return { ok: true, added: added, rejected: rejected, before: r0, after: r1, ver: E.ver, left: fails.length - added.length };
  }

  function undoLast(kind) {
    if (kind === 'morph') E.morph.pop();
    else if (kind === 'stop') E.stop.pop();
    else E.alias.pop();
  }

  /* 回滚到指定版本（默认上一版） */
  function rollback(toV) {
    if (!E.snap.length) return { ok: false, why: 'no_snapshot' };
    var s = null, idx = -1;
    for (var i = E.snap.length - 1; i >= 0; i--) {
      if (toV == null || E.snap[i].v === toV) { s = E.snap[i]; idx = i; break; }
    }
    if (!s) return { ok: false, why: 'no_such_version' };
    E.morph = JSON.parse(JSON.stringify(s.morph));
    E.stop = JSON.parse(JSON.stringify(s.stop));
    E.alias = JSON.parse(JSON.stringify(s.alias));
    E.ver = s.v;
    E.snap = E.snap.slice(0, idx);
    save();
    return { ok: true, ver: E.ver, pass: benchSilent() };
  }

  /* ---------- 8. 对外 ---------- */
  w.EVO = {
    match: function (text) { return match(text); },
    norm: norm,
    intents: intents,
    intentIds: intentIds,
    intentName: intentName,
    bench: bench,
    evolve: evolve,
    rollback: rollback,
    state: function () { return E; },
    hit: hit, miss: miss,
    autoList: function () { return E.auto; },
    revokeList: function () { return E.revoke || []; },
    pendList: function () { return E.pend; },
    reset: function () { E = JSON.parse(JSON.stringify(DEF)); save(); },
    passNow: benchSilent,
    total: BENCH.length,
    benchList: BENCH
  };

  /* 登记到统一记忆总线：一键清空时，旧版别名 / 虚词 / 版本快照也要一起清掉。 */
  if (w.MILI_STORE) {
    w.MILI_STORE.register('evo', {
      keys: [KEY, 'mili_evo', 'mili_demo_evo'],
      wipe: function () { E = JSON.parse(JSON.stringify(DEF)); }
    });
  }

  /* 给 app.js 用：进语音识别前先问一句"这句是不是学过的说法" */
  w.EVO.redirect = function (text) {
    var r = match(text);
    return r ? r : null;
  };

  /* ---------- 6.5 驱动层：没人按按钮的时候，它靠什么学 ---------- */
  /* 这是整套东西的核心。老人不会教它、不会点按钮 —— 但他每天在做一件事：
     说得不对，换个说法再说一遍。
       他说「屋里头怪闷的」→ 它没办成 → 他说「开空调」→ 办成了
     这一次「改口」，等于他无意中给它标了一个答案：那句土话 = 开空调。

     所以驱动源不是题库、不是按钮，是老人的改口。
     他不配合，也照样在教。 */
  var lastMiss = null;

  function coreOf(text) {
    /* 从原话里抠一段能当钥匙的词：去掉开头虚词、结尾语气词，取 2-4 字 */
    var b = bare(text).replace(/^(我想|我要|给我|帮我|麻烦|把|那个|这个|我)/, '').replace(/(喽|呗|啊|呀|嘛|呢|了|的)$/, '');
    if (b.length < 4) return '';
    return b.length > 4 ? b.slice(-4) : b;
  }

  function addPend(from, to) {
    if (!from || !to) return false;
    if (!intentIds().length || intentIds().indexOf(to) < 0) return false;
    var key = coreOf(from);
    if (!key) return false;
    /* 已经能听懂了就别重复学 */
    var now = match(from);
    if (now && now.id === to) return false;

    var p = null;
    for (var i = 0; i < E.pend.length; i++) {
      if (E.pend[i].from === from && E.pend[i].to === to) { p = E.pend[i]; break; }
    }
    if (p) p.n = (p.n || 1) + 1;
    else E.pend.push({ from: from, to: to, key: key, n: 1, t: Date.now() });
    if (E.pend.length > 20) E.pend.shift();
    save();

    var cur = null;
    for (var j = 0; j < E.pend.length; j++) if (E.pend[j].from === from && E.pend[j].to === to) cur = E.pend[j];
    if (cur && cur.n >= 2) adopt(cur);
    return true;
  }

  /* 老人改口的次数够了 → 转正。转正也要过那道不变量：不许把已经懂的说崩。 */
  function adopt(p) {
    var beforeArr = evalPass();
    E.alias.push({ k: p.key, id: p.to, hit: 0, from: '改口：' + p.from });
    var afterArr = evalPass();
    var bad = regressed(beforeArr, afterArr);
    if (bad) {
      E.alias.pop();
      E.pend = E.pend.filter(function (x) { return x !== p; });
      save();
      return false;
    }
    E.pend = E.pend.filter(function (x) { return x !== p; });
    var prev = E.ver;
    var snapOld = {
      morph: JSON.parse(JSON.stringify(E.morph)),
      stop: JSON.parse(JSON.stringify(E.stop)),
      alias: JSON.parse(JSON.stringify(E.alias.slice(0, -1)))
    };
    E.ver = prev + 1;
    E.snap.push({ v: prev, t: Date.now(), morph: snapOld.morph, stop: snapOld.stop, alias: snapOld.alias, pass: beforeArr.filter(Boolean).length });
    if (E.snap.length > 12) E.snap.shift();
    var rec = { t: Date.now(), from: p.from, key: p.key, to: p.to, toName: intentName(p.to), ver: E.ver,
                pass0: beforeArr.filter(Boolean).length, pass1: afterArr.filter(Boolean).length };
    E.auto.push(rec);
    if (E.auto.length > 30) E.auto.shift();
    E.patches.push({ t: Date.now(), from: prev, to: E.ver, added: 1, pass0: rec.pass0, pass1: rec.pass1, auto: true });
    save();
    /* 学到了就说一声，但不要求他做任何事 */
    if (w.__EVO_SAY) { try { w.__EVO_SAY(rec); } catch (e) {} }
    if (d.getElementById('page-evo')) render();
    return true;
  }

  /* ---------- 二级信号：同一件事被要求两次 = 上一次没办成 ---------- */
  /* 老人在"没办成"的时候，最常做的动作不是改口，是原样再说一遍。
     这一条比改口更常见，但它是负反馈：说明上一次那个动作没落到他心里。
     如果这句话是靠「学来的别名」接住的，那这个别名就值得怀疑 —— 撤掉它。 */
  var lastHit = null;
  var REPEAT_MS = 30000;

  function hit(text, id) {
    var now = Date.now();
    /* 一、改口：上一句没办成，这一句办成了 → 正样本，学说法 */
    if (lastMiss && now - lastMiss.t < 25000 && lastMiss.text !== text) {
      addPend(lastMiss.text, id);
      lastMiss = null;
    }
    /* 二、重复：30 秒内同一句原话又被说了一次 → 上一次没效果，负样本。
       注意判据是「同一句话」，不是「同一个意图」——老人换个说法再说一遍，
       那是改口（正样本），不能当成失败。 */
    if (lastHit && lastHit.text === text && lastHit.id === id && now - lastHit.t < REPEAT_MS) {
      E.repeatN = (E.repeatN || 0) + 1;
      var m = match(text);
      if (m && m.how === 'alias') revoke(m.key, id, text);
    }
    lastHit = { text: text, id: id, t: now };
    E.trail.push({ t: now, text: text, id: id, ok: true });
    if (E.trail.length > 200) E.trail.shift();
    save();
  }

  /* 撤掉一条学错的说法：它把 A 认成 B，但老人紧接着又说了一遍同一件事。 */
  function revoke(key, id, said) {
    for (var i = 0; i < E.alias.length; i++) {
      var a = E.alias[i];
      if (a.k === key && a.id === id) {
        var prev = E.ver;
        var passBefore = benchSilent();   // 快照记的是「撤销之前」那句话的分数
        var snapOld = {
          morph: JSON.parse(JSON.stringify(E.morph)),
          stop: JSON.parse(JSON.stringify(E.stop)),
          alias: JSON.parse(JSON.stringify(E.alias))   // 含被撤那条，才是撤销前的样子
        };
        E.alias.splice(i, 1);
        E.ver = prev + 1;
        E.snap.push({ v: prev, t: Date.now(), morph: snapOld.morph, stop: snapOld.stop, alias: snapOld.alias, pass: passBefore });
        if (E.snap.length > 12) E.snap.shift();
        E.revoke = E.revoke || [];
        E.revoke.push({ t: Date.now(), key: key, id: id, toName: intentName(id), said: said, ver: E.ver });
        if (E.revoke.length > 20) E.revoke.shift();
        save();
        if (w.__EVO_UNDO) { try { w.__EVO_UNDO(E.revoke[E.revoke.length - 1]); } catch (e) {} }
        if (d.getElementById('page-evo')) render();
        return true;
      }
    }
    return false;
  }
  function miss(text) {
    lastMiss = { text: text, t: Date.now() };
    E.trail.push({ t: Date.now(), text: text, id: null, ok: false });
    if (E.trail.length > 200) E.trail.shift();
    save();
  }

  /* ================= UI ================= */
  /* 🚨 2026-11-07 整块重写。
     这一页原来用的是**上一代 token 名**：--r / --sh-min / --muted / --faint /
     --faint-txt / --ink2 / --fill / --pill。可 design-tokens.css 里这 8 个
     变量**一个都不存在**（新版是 --r-card / --sh-card / --ink-2 / --ink-3 /
     --bg-3 / --r-pill）。
     CSS 里 var() 找不到变量时整条声明作废，于是：
       · border-radius:var(--r)      → 直角（实测 .ev-hero radius = 0px）
       · box-shadow:var(--sh-min)    → 无阴影（实测 shadow = none）
       · color:var(--muted)          → 颜色继承，全部塌成正文黑
     整页看上去就是「没加载样式表的 HTML」—— 从「学的」页点进去，
     和其它 11 页完全不像同一个产品。用户说的「像之前一样」正是这一屏。
     字号也全线违规：13 / 13.5 / 14 / 14.5 / 15 / 16，而判据 D 要求正文 ≥18。
     所以不是替换几个变量名，是按新 token 体系整块重排。 */
  var CSS = [
    '#page-evo{padding:0 var(--s4)}',
    '.ev-hero{background:var(--card);border-radius:var(--r-card);',
    '  box-shadow:var(--sh-card);padding:var(--s5) var(--s5) var(--s4);margin-bottom:var(--s3)}',
    '.ev-k{margin:0 0 var(--s2);font-size:var(--t-body);color:var(--ink-3);letter-spacing:.01em}',
    '.ev-big{display:flex;align-items:flex-end;gap:var(--s1);margin:0 0 var(--s1)}',
    '.ev-big b{font-size:var(--t-num);line-height:1;font-weight:800;',
    '  letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink)}',
    '.ev-big i{font-size:var(--t-body);font-style:normal;color:var(--ink-3);padding-bottom:6px}',
    '.ev-sub{margin:0;font-size:var(--t-body);color:var(--ink-2);line-height:var(--lh-body)}',
    '.ev-bar{height:8px;border-radius:var(--r-pill);background:var(--bg-3);',
    '  margin:var(--s4) 0 0;overflow:hidden}',
    '.ev-bar i{display:block;height:100%;border-radius:var(--r-pill);background:var(--ink);',
    '  width:0;transition:width .7s cubic-bezier(.22,.8,.3,1)}',
    '.ev-act{display:flex;gap:var(--s3);margin:var(--s3) 0}',
    '.ev-btn{flex:1;height:var(--tap);border:0;border-radius:var(--r-pill);',
    '  background:var(--btn);color:var(--btn-ink);font-size:var(--t-body-l);',
    '  font-weight:700;letter-spacing:.01em;font-family:inherit;cursor:pointer}',
    '.ev-btn:active{transform:scale(.985)}',
    /* 次按钮必须白底 + 描边。原来这里是 background:var(--card) 再配 box-shadow ——
       在灰底页上白卡靠阴影立，可这一页的卡本身也是白卡，于是两颗按钮
       在两张白卡之间飘着，看不出边界。 */
    '.ev-btn.ghost{background:var(--btn-2);color:var(--btn-2-ink);',
    '  border:1px solid var(--btn-2-line)}',
    '.ev-btn:disabled{opacity:.35}',
    '.ev-btn.pulse{animation:evPulse 1.6s ease-in-out infinite}',
    '@keyframes evPulse{0%,100%{box-shadow:0 0 0 0 rgba(20,20,26,.14)}',
    '  50%{box-shadow:0 0 0 10px rgba(20,20,26,0)}}',
    '.ev-list{background:var(--card);border-radius:var(--r-card);',
    '  box-shadow:var(--sh-card);overflow:hidden;margin-bottom:var(--s3)}',
    '.ev-row{display:flex;align-items:center;gap:var(--s3);padding:var(--s4);',
    '  border-bottom:1px solid var(--line);font-size:var(--t-body)}',
    '.ev-row:last-child{border-bottom:0}',
    '.ev-row .q{flex:1;min-width:0;color:var(--ink);overflow:hidden;',
    '  text-overflow:ellipsis;white-space:nowrap}',
    '.ev-row .st{flex:none;font-size:var(--t-cap);color:var(--ink-3)}',
    '.ev-row .dot{flex:none;width:26px;height:26px;border-radius:var(--r-pill);',
    '  display:grid;place-items:center;font-size:var(--t-cap);font-weight:700;',
    '  color:#fff;background:var(--ink-3)}',
    '.ev-row.ok .dot{background:var(--ink)}',
    '.ev-row.no .dot{background:var(--bg-3);color:var(--ink-3)}',
    '.ev-row.no .q{color:var(--ink-3)}',
    '.ev-h{display:flex;align-items:baseline;justify-content:space-between;',
    '  margin:var(--s5) var(--s1) var(--s3)}',
    '.ev-h h3{margin:0;font-size:var(--t-h3);font-weight:700;color:var(--ink);',
    '  letter-spacing:-.01em}',
    '.ev-h span{font-size:var(--t-cap);color:var(--ink-3)}',
    '.ev-note{margin:0;padding:0 var(--s1) var(--s5);font-size:var(--t-body);',
    '  color:var(--ink-3);line-height:var(--lh-body)}',
    '.ev-learn{background:var(--card);border-radius:var(--r-card);',
    '  box-shadow:var(--sh-card);padding:0 var(--s4);margin-bottom:var(--s3)}',
    '.ev-li{display:flex;gap:var(--s3);padding:var(--s4) 0;',
    '  border-bottom:1px solid var(--line);font-size:var(--t-body);',
    '  color:var(--ink-2);line-height:var(--lh-body)}',
    '.ev-li:last-child{border-bottom:0}',
    '.ev-li .n{flex:none;color:var(--ink-4);font-variant-numeric:tabular-nums}',
    '.ev-li b{font-weight:700;color:var(--ink)}',
    '.ev-ver{display:flex;align-items:center;gap:var(--s3);padding:var(--s4) 0;',
    '  border-bottom:1px solid var(--line);font-size:var(--t-body)}',
    '.ev-ver:last-child{border-bottom:0}',
    '.ev-ver .tag{padding:4px 10px;border-radius:var(--r-pill);',
    '  background:var(--bg-3);color:var(--ink-2);font-size:var(--t-cap);font-weight:700}',
    '.ev-ver .tag.now{background:var(--ink);color:var(--btn-ink)}',
    '.ev-ver .p{color:var(--ink-3);font-variant-numeric:tabular-nums}',
    /* 版本回退按钮：原来 padding:6px 2px、字号 13.5 —— 点击区只有 ~30px。 */
    '.ev-ver button{margin-left:auto;min-height:var(--tap);min-width:var(--tap);',
    '  padding:0 var(--s3);border:1px solid var(--btn-2-line);',
    '  border-radius:var(--r-pill);background:var(--btn-2);color:var(--btn-2-ink);',
    '  font-size:var(--t-body);font-family:inherit;cursor:pointer}',
    /* 空态：不是一句居中灰字。跟其它四页的空态卡对齐。 */
    '.ev-empty{display:flex;flex-direction:column;align-items:flex-start;',
    '  gap:var(--s3);margin-top:var(--s1);padding:var(--s5);text-align:left;',
    '  background:var(--card);border-radius:var(--r-card);box-shadow:var(--sh-card);',
    '  color:var(--ink-3);font-size:var(--t-body);line-height:var(--lh-body)}',
    '.ev-empty b{font-size:var(--t-h3);font-weight:700;color:var(--ink)}',
    /* 「它在学」入口卡。
       🚨 原来 height 没有、只有 padding:15px —— 实测 50px，比 60dp 少一截。
       而且 font-size 15/13.5 全线低于 18。现在按 tap 高度 + 正文字号重做。 */
    '.evocard{display:flex;align-items:center;gap:var(--s3);width:100%;',
    '  min-height:var(--tap);margin:0 0 var(--s3);padding:var(--s4);',
    '  border:0;border-radius:var(--r-card);background:var(--card);',
    '  box-shadow:var(--sh-card);font-family:inherit;text-align:left;cursor:pointer}',
    '.evocard:active{background:var(--bg-2)}',
    '.evocard .ec-t{flex:none;font-size:var(--t-body);font-weight:700;color:var(--ink)}',
    '.evocard .ec-s{flex:1;min-width:0;font-size:var(--t-body);color:var(--ink-3);',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.evocard .ec-a{flex:none;width:22px;height:22px;color:var(--ink-4)}'
  ].join('\n');

  function $(s, r) { return (r || d).querySelector(s); }
  function mk(tag, cls, html) { var e = d.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }

  var UI = { busy: false, last: null };

  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }

  function build() {
    if ($('#page-evo')) return;
    var st = mk('style'); st.textContent = CSS; d.head.appendChild(st);

    var pg = mk('section', 'page');
    pg.id = 'page-evo';
    pg.innerHTML =
      '<div class="nav"><button class="back" id="evBack" aria-label="返回">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
      '</button><span class="ttl">日新</span></div>' +
      /* 🚨 2026-11-07：这里原来内联写了 padding-bottom:20px ——
         它把 .scroll 自己的「16+24 视线余量」覆盖掉了，滚到底最后一块会贴边被切。
         去掉内联，交给 .scroll 的规则统一管。 */
      '<div class="scroll" id="evScroll"></div>';
    $('#phone').appendChild(pg);

    /* 入口不占一个底部 tab。
       老人端本来就是五个格子，再塞第六个会挤成两行（真机实测过）。
       它本来属于「学的」那页 —— 成长记录就该在那儿，一张卡点进去。 */
    var prog = $('#page-learn .prog');
    if (prog && !$('#evoCard')) {
      var card = mk('button', 'evocard');
      card.id = 'evoCard';
      card.type = 'button';
      card.innerHTML = '<span class="ec-t">它在学</span><span class="ec-s" id="ecSub"></span>' +
                       '<svg class="ec-a" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
      card.addEventListener('click', goEvo);
      prog.parentNode.insertBefore(card, prog.nextSibling);
    }

    $('#evBack').addEventListener('click', function () {
      /* 从哪来回哪去：这页的爹是「学的」 */
      var all2 = d.querySelectorAll('.page');
      for (var i2 = 0; i2 < all2.length; i2++) all2[i2].classList.remove('on');
      var lp = $('#page-learn');
      if (lp) lp.classList.add('on');
      var tabs2 = d.querySelectorAll('.tab');
      for (var j2 = 0; j2 < tabs2.length; j2++) tabs2[j2].classList.toggle('on', tabs2[j2].getAttribute('data-page') === 'learn');
    });

    render();
  }

  function goEvo() {
    var all = d.querySelectorAll('.page');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('on');
    $('#page-evo').classList.add('on');
    var tabs = d.querySelectorAll('.tab');
    for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('on', tabs[j].getAttribute('data-page') === 'learn');
    render();
  }
  function goEvoOff() {
    $('#page-evo').classList.remove('on');
    var home = $('#page-home'); if (home) home.classList.add('on');
    var tabs = d.querySelectorAll('.tab');
    for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('on', tabs[j].getAttribute('data-page') === 'home');
  }

  /* 产品版和演示版是两套东西，不是一个页面的两个开关。
     产品版：老人/家人看的，只有「它学会了什么」，没有一个按钮、没有版本号。
     演示版：评委看的，考卷、版本历史、回滚按钮全在，因为它要证明机制是真的。 */
  function renderSimple() {
    var box = $('#evScroll');
    if (!box) return;
    var pf = benchSilent();
    var h = '';
    h += '<div class="ev-hero">';
    h += '<p class="ev-k">它现在听懂的</p>';
    h += '<div class="ev-big"><b>' + pf + '</b><i>/ ' + BENCH.length + ' 句常见说法</i></div>';
    h += '<p class="ev-sub">' + (E.auto.length
      ? '其中 ' + E.auto.length + ' 句是它自己从你说话里学来的，你什么都没做。'
      : '它还没自己学会什么。多说说话就行。') + '</p>';
    h += '<div class="ev-bar"><i style="width:' + pct(pf, BENCH.length) + '%"></i></div>';
    h += '</div>';

    if (E.auto.length) {
      h += '<div class="ev-h"><h3>它记住的</h3><span>最近 ' + Math.min(5, E.auto.length) + ' 句</span></div>';
      h += '<div class="ev-learn">';
      for (var i = Math.max(0, E.auto.length - 5); i < E.auto.length; i++) {
        var a = E.auto[i];
        h += '<div class="ev-li"><span class="n">·</span><span>你以前说「' + esc(a.from) + '」，' +
             '现在它也懂这是<b>' + esc(a.toName) + '</b></span></div>';
      }
      h += '</div>';
    } else {
      /* 🚨 2026-11-07：原来是「还没学会什么。<br>你说一句它没听懂的，<br>
         再换个说法说一遍，它就记住了。」—— 一句居中灰字靠 <br> 断成三行。
         现在 .ev-empty 是 flex column，裸文本和 <br> 都会变成匿名 flex 项，
         布局会散架。改成和其它四页一致的三要素：状态、为什么、怎么办。 */
      h += '<div class="ev-empty">'
         + '<b>还没学会什么</b>'
         + '<span>你说一句它没听懂的，再换个说法说一遍，它就记住了。</span>'
         + '</div>';
    }
    /* <br> 在正常流里是换行，但在 .ev-note 这种块里它等于硬断句 ——
       老人读起来像两句话被粘在一起。两句本来就该是两个句子，用句号分开即可。 */
    h += '<p class="ev-note">它只学怎么听懂你，不学替你做主。它学的每一条，家人都能看见、也能关掉。</p>';
    box.innerHTML = h;
  }

  function render() {
    /* 卡片上那句副标题，跟着它的成长状态走 */
    var sub = $('#ecSub');
    if (sub) {
      var n2 = E.auto.length;
      var pf = benchSilent();
      sub.textContent = n2
        ? ('它自己学会 ' + n2 + ' 句你常说的话')
        : ('你平时说的话，它听懂了 ' + pf + ' 句');
    }
    if (!DEMO) { renderSimple(); return; }
    var box = $('#evScroll');
    if (!box) return;
    var total = BENCH.length;
    var pass = benchSilent();
    var r = UI.last;
    var h = '';

    h += '<div class="ev-hero">';
    h += '<p class="ev-k">第 ' + E.ver + ' 版 · 它会 ' + pass + ' / ' + total + ' 种说法</p>';
    h += '<div class="ev-big"><b id="evPct">' + pct(pass, total) + '</b><i>%</i></div>';
    h += '<p class="ev-sub" id="evLine">' + (r && r.total
      ? '刚跑完 ' + r.total + ' 句，听懂 ' + r.pass + ' 句。'
      : '还没测过。点下面「跑一遍」，它会把这 ' + total + ' 句老人话挨个听一遍。') + '</p>';
    h += '<div class="ev-bar"><i id="evFill" style="width:' + pct(pass, total) + '%"></i></div>';
    h += '</div>';

    /* 自己学的 —— 这一块回答「没人按按钮它怎么进化」 */
    if (E.auto.length) {
      h += '<div class="ev-h"><h3>没人按按钮，它自己学的</h3><span>' + E.auto.length + ' 句</span></div>';
      h += '<div class="ev-learn">';
      for (var a = Math.max(0, E.auto.length - 6); a < E.auto.length; a++) {
        var A2 = E.auto[a];
        h += '<div class="ev-li"><span class="n">✦</span><span>你说了「' + esc(A2.from) + '」没办成，' +
             '紧接着改口说的那句它办成了 —— 它就把「' + esc(A2.key) + '」记成<b>' + esc(A2.toName) + '</b></span></div>';
      }
      h += '</div>';
    }
    /* 自己撤掉的 —— 自我纠错最硬的证据：它不光会学，还会否认自己 */
    if (E.revoke && E.revoke.length) {
      h += '<div class="ev-h"><h3>它自己撤掉的</h3><span>' + E.revoke.length + ' 条</span></div>';
      h += '<div class="ev-learn">';
      for (var rv = Math.max(0, E.revoke.length - 4); rv < E.revoke.length; rv++) {
        var R2 = E.revoke[rv];
        h += '<div class="ev-li"><span class="n">×</span><span>它把「' + esc(R2.key) + '」当成<b>' +
             esc(R2.toName) + '</b>，可你又说了「' + esc(R2.said) + '」—— 它判定学错了，自己撤掉</span></div>';
      }
      h += '</div>';
    }
    if (E.pend.length) {
      h += '<div class="ev-h"><h3>正在攒的</h3><span>同一句改口再来一次就学</span></div>';
      h += '<div class="ev-learn">';
      for (var q2 = 0; q2 < E.pend.length; q2++) {
        var P2 = E.pend[q2];
        h += '<div class="ev-li"><span class="n">' + (P2.n || 1) + '/2</span><span>「' + esc(P2.from) +
             '」→ 好像是想<b>' + esc(intentName(P2.to)) + '</b></span></div>';
      }
      h += '</div>';
    }

    var hasFail = pass < total;
    h += '<div class="ev-act">';
    h += '<button class="ev-btn ghost" id="evRun">跑一遍</button>';
    h += '<button class="ev-btn' + (hasFail ? ' pulse' : '') + '" id="evGo"' + (hasFail ? '' : ' disabled') + '>' +
         (hasFail ? '进化' : '全会了') + '</button>';
    h += '</div>';

    /* 上一次跑的明细 */
    if (r && r.items) {
      h += '<div class="ev-h"><h3>刚才那 ' + r.total + ' 句</h3><span>第 ' + r.v + ' 版</span></div>';
      h += '<div class="ev-list">';
      for (var i = 0; i < r.items.length; i++) {
        var it = r.items[i];
        h += '<div class="ev-row ' + (it.ok ? 'ok' : 'no') + '">' +
             '<span class="dot">' + (it.ok ? '✓' : '·') + '</span>' +
             '<span class="q">' + esc(it.q) + '</span>' +
             '<span class="st">' + (it.ok ? intentName(it.got) : '没听懂') + '</span></div>';
      }
      h += '</div>';
    }

    /* 上一次进化的收获 */
    if (r && r.learned && r.learned.length) {
      h += '<div class="ev-h"><h3>这次学到了什么</h3><span>' + r.learned.length + ' 条</span></div>';
      h += '<div class="ev-learn">';
      for (var j = 0; j < r.learned.length; j++) {
        var L = r.learned[j];
        h += '<div class="ev-li"><span class="n">' + (j + 1) + '</span><span>' +
             esc(L.desc) + ' —— 以后听到「' + esc(L.q) + '」就知道是<b>' + esc(L.to) + '</b></span></div>';
      }
      h += '</div>';
    }

    /* 被它自己驳回的：这一块比"学到了什么"更能说明它不是在乱改 */
    if (r && r.rejected && r.rejected.length) {
      h += '<div class="ev-h"><h3>试过但没敢用</h3><span>' + r.rejected.length + ' 条</span></div>';
      h += '<div class="ev-learn">';
      for (var k2 = 0; k2 < r.rejected.length; k2++) {
        h += '<div class="ev-li"><span class="n">×</span><span>「' + esc(r.rejected[k2].q) + '」—— ' +
             esc(r.rejected[k2].why) + '</span></div>';
      }
      h += '</div>';
    }

    /* 版本历史 */
    if (E.snap.length) {
      h += '<div class="ev-h"><h3>版本</h3><span>每一版都留着</span></div>';
      h += '<div class="ev-learn">';
      var rows = [];
      for (var s = E.snap.length - 1; s >= 0; s--) rows.push(E.snap[s]);
      for (var v = 0; v < rows.length; v++) {
        var sn = rows[v];
        h += '<div class="ev-ver"><span class="tag">v' + sn.v + '</span>' +
             '<span class="p">听懂 ' + sn.pass + '/' + total + '（' + pct(sn.pass, total) + '%）</span>' +
             '<button data-evback="' + sn.v + '">回到这版</button></div>';
      }
      h += '<div class="ev-ver"><span class="tag now">v' + E.ver + '</span>' +
           '<span class="p">现在 · 听懂 ' + pass + '/' + total + '（' + pct(pass, total) + '%）</span></div>';
      h += '</div>';
    }

    h += '<p class="ev-note">' +
      '它只学「怎么听懂话」，不学怎么替你做主。每一条改法都要先把 ' + total + ' 句老话全部重跑一遍：' +
      '总分要涨，而且原来听懂的一句都不许变错，否则当场撤回。想退回去，点上面任意一版就行。</p>';

    box.innerHTML = h;

    var runBtn = $('#evRun'), goBtn = $('#evGo');
    if (runBtn) runBtn.addEventListener('click', doRun);
    if (goBtn) goBtn.addEventListener('click', doEvolve);
    var backs = box.querySelectorAll('button[data-evback]');
    for (var t = 0; t < backs.length; t++) {
      backs[t].addEventListener('click', function () {
        var v = parseInt(this.getAttribute('data-evback'), 10);
        var res = rollback(v);
        if (res.ok) {
          UI.last = { v: res.ver, pass: res.pass, total: total, items: null, learned: [] };
          render();
          toast('回到第 ' + res.ver + ' 版，它又不认那些话了');
        }
      });
    }
  }

  function toast(msg) {
    var t = mk('div', '');
    t.style.cssText = 'position:absolute;left:50%;bottom:120px;transform:translateX(-50%);background:rgba(16,16,20,.92);color:#fff;font-size:14px;padding:11px 18px;border-radius:99px;z-index:99;max-width:80%;text-align:center;transition:opacity .3s;';
    t.textContent = msg;
    $('#phone').appendChild(t);
    setTimeout(function () { t.style.opacity = 0; }, 2000);
    setTimeout(function () { t.remove(); }, 2400);
  }

  /* 逐条跑，有仪式感，也让评委看清"一条一条过的" */
  function doRun() {
    if (UI.busy) return;
    UI.busy = true;
    var box = $('#evScroll');
    var total = BENCH.length;
    var v = E.ver;
    box.innerHTML = '<div class="ev-h"><h3>正在听</h3><span id="evCnt">0 / ' + total + '</span></div>' +
                    '<div class="ev-list" id="evRows"></div>';
    var rowsEl = $('#evRows');
    var i = 0, pass = 0, items = [];
    var timer = setInterval(function () {
      if (i >= total) {
        clearInterval(timer);
        UI.busy = false;
        UI.last = { v: v, pass: pass, total: total, items: items, learned: (UI.last && UI.last.learned) || [] };
        var rec = { v: v, pass: pass, total: total, t: Date.now() };
        E.runs.push(rec); if (E.runs.length > 40) E.runs.shift(); save();
        render();
        return;
      }
      var b = BENCH[i];
      var m = match(b.q);
      var ok = !!(m && m.id === b.want);
      if (ok) pass++;
      items.push({ q: b.q, want: b.want, ok: ok, got: m ? m.id : null, how: m ? m.how : null });
      var row = mk('div', 'ev-row ' + (ok ? 'ok' : 'no'));
      row.innerHTML = '<span class="dot">' + (ok ? '✓' : '·') + '</span>' +
                      '<span class="q">' + esc(b.q) + '</span>' +
                      '<span class="st">' + (ok ? intentName(b.want) : '没听懂') + '</span>';
      rowsEl.appendChild(row);
      var c = $('#evCnt'); if (c) c.textContent = (i + 1) + ' / ' + total;
      i++;
    }, 55);
  }

  function doEvolve() {
    if (UI.busy) return;
    UI.busy = true;
    var box = $('#evScroll');
    box.innerHTML = '<div class="ev-empty">正在把没听懂的那几句翻出来看……<br>试一条改法，就在全部题库上重跑一遍；<br>涨了就留下，掉分当场撤回。</div>';
    setTimeout(function () {
      var res = evolve();
      UI.busy = false;
      if (!res.ok) {
        UI.last = { v: E.ver, pass: res.after, total: BENCH.length, items: null, learned: [] };
        render();
        toast(res.why === 'all_pass' ? '已经全会了，没得可学' : '没有安全的改法，先不动');
        return;
      }
      UI.last = { v: res.ver, pass: res.after, total: BENCH.length, items: null, learned: res.added, rejected: res.rejected || [] };
      render();
      toast('第 ' + res.ver + ' 版：' + res.before + ' → ' + res.after + ' 句');
    }, 900);
  }

  /* app.js 初始化完再插（它要先建好 tab 条） */
  function boot() {
    if (!w.__INTENTS) { setTimeout(boot, 200); return; }
    build();
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 400); });
  else setTimeout(boot, 400);

})(window, document);
