/* ============================================================================
 * 米粒的智能体内核 —— 真的会想、会调工具、会记事、会复用的那种
 *
 * 和之前的区别，一句话：
 *   之前是 9 条场景 + 25 条正则，出了剧本就废；
 *   现在是 think → tool_call → observe → think 的循环，工具是它自己挑的，
 *   参数是它自己从老人土话里抠的，办没办成是工具告诉它的。
 *
 * 三层路由（这是「第一次慢、下次快」落地的地方）：
 *   ① skill 缓存   0ms   同一句话办过一次，成功序列存下来，直接重放
 *   ② 本地规则    0ms   断网也能用的高频硬规则（关电视、打电话这类）
 *   ③ agent loop 1.6~2.2s  真的想、真的调、真的看结果
 *
 * 为什么用 hy3：实测 14/14 工具选择准确率、1.6~2.2s、免费（x0.00 credits）。
 * 为什么不用 glm-5.3-flash：6~11s 还时不时 502。
 * 为什么不用 auto：它会路由到 19s 的模型，老人等不了。
 *
 * 诚实是硬约束，写在 system prompt 里，也写在代码里：
 *   工具返回 ok:false 时，模型的输出会被 _guardHonest 检查一遍，
 *   发现它在说「办好了」就直接换掉。不能指望模型每次都乖。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------- 直连大模型：主路走无限卡的聚合站，官方当备路 ----------
     2026-11-12 菲尔特开通了 dpflash 无限日卡，要求接进米粒。
     实测（tools / 流式 / 看图 / 思维链 都验过）：
       · 模型名不一样：官方 deepseek-flash ↔ 这边 deepseek-v4.1-flash
       · usage 字段不一样：官方 prompt_cache_hit_tokens ↔ 这边 cache_read_input_tokens
       · 复杂任务（比如看图）思维链会吃满 max_tokens，正文可能为空
     主备策略：主路挂了（401/402/5xx/网络）自动切官方，一个请求只切一次；
     每次切换都会在 console 里留一行，现场一眼能看出走的哪条路。 */
  const DS = {
    on: true,
    /* 2026-11-12 20:0x 换成官方直连做主路（菲尔特给的官方 key）。
       原因：聚合站首字地板 5.4 秒且抖动大；官方实测 1.4~3.1 秒，且支持 tools。
       🚨 2026-11-12 20:35 菲尔特明确「以后都走官方 key，不走中转站」——
       备路已清空，主路挂了就地报错，不再把老人的话偷偷转给第三方。 */
    base: 'https://api.deepseek.com',
    key: 'sk-REPLACE_WITH_YOUR_OWN_KEY',
    model: 'deepseek-flash',
    backup: { base: '', key: '', model: '' },
  };
  /* 这一轮实际走的哪条路，给日志和界面用 */
  let _dsRoute = 'main';
  const dsRoute = () => _dsRoute;

  /* ==========================================================================
   * 2026-11-12：现场接口可配（BoHack 组委会现场发 token 额度）
   *
   * 手册口径：不发 GPU，发 token 额度（硅基流动 + 清程极智，找主办「谂.」领）。
   * 之前 base_url / model / key 全写死在源码里，现场换额度要改代码重打包，
   * 等于把「delta 现场产生」做成假。现在改成运行时填、落 localStorage。
   * ⚠ 现场填的密钥只留在本机，不进 APK、不进公开仓库（仓库是脱敏版）。
   * ======================================================================== */
  const LLM_KEY = 'mili.llm';
  const LLM_PRESETS = {
    deepseek:    { base: 'https://api.deepseek.com',     model: 'deepseek-flash' },
    /* 第三方中转站预设已移除：不再把老人的话转给未授权的第三方服务。 */
    siliconflow: { base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    qingcheng:   { base: '', model: '' },
    custom:      { base: '', model: '' }
  };
  function applyLLM(c) {
    if (!c) return;
    if (c.base)  DS.base  = c.base;
    if (c.model) DS.model = c.model;
    if (c.key)   DS.key   = c.key;
    if (c.backupBase)  DS.backup.base  = c.backupBase;
    if (c.backupModel) DS.backup.model = c.backupModel;
    if (c.backupKey)   DS.backup.key   = c.backupKey;
  }
  /* 初始值先存一份：现场「清掉本机配置」要能立刻还原，不该逼人重装 APK。 */
  const LLM_DEFAULTS = {
    base: DS.base, model: DS.model, key: DS.key,
    backupBase: DS.backup.base, backupModel: DS.backup.model, backupKey: DS.backup.key
  };
  try { applyLLM(JSON.parse(localStorage.getItem(LLM_KEY) || 'null')); } catch (e) {}
  function llmInfo() {
    return {
      base: DS.base, model: DS.model,
      key: DS.key ? DS.key.slice(0, 6) + '****' + DS.key.slice(-4) : '',
      hasKey: !!DS.key, route: _dsRoute,
      backupBase: (DS.backup && DS.backup.base) || '',
      backupModel: (DS.backup && DS.backup.model) || '',
      saved: !!localStorage.getItem(LLM_KEY)
    };
  }
  function setLLM(c) {
    try {
      if (c && c.reset) {
        localStorage.removeItem(LLM_KEY);
        applyLLM(LLM_DEFAULTS);
        return Object.assign({ ok: true }, llmInfo());
      }
      const cur = JSON.parse(localStorage.getItem(LLM_KEY) || '{}') || {};
      const next = Object.assign({}, cur, c || {});
      localStorage.setItem(LLM_KEY, JSON.stringify(next));
      applyLLM(next);
      return Object.assign({ ok: true }, llmInfo());
    } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  }

  /* 把 SSE 流翻成和云端 SDK 一样的 chunk 结构，上层代码一个字都不用改。
     DeepSeek 的 delta 里除了 content 还有 reasoning_content（思维链）——
     那个不要念给老人听，只用来判断它是不是卡住了。 */
  async function* dsStream(body, signal) {
    /* 2026-11-11：一定要 usage，不然花了多少钱只能靠后台截图猜。
       include_usage 会在流末尾补一个 choices 为空的 chunk，里面带
       prompt_tokens / prompt_cache_hit_tokens / completion_tokens。
       2026-11-12：主备切换。只在这一步（还没开始读流）失败才切，
       流一旦开始就不能重来 —— 否则老人会听见半句话再来一遍。 */
    const open = (cfg) => {
      const b = Object.assign({}, body, {
        model: cfg.model, stream: true,
        stream_options: { include_usage: true },
      });
      delete b.signal;
      return fetch(cfg.base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.key,
        },
        body: JSON.stringify(b),
        signal: signal,
      });
    };
    let r = null, boom = null;
    try { r = await open(DS); } catch (e) { boom = e; }
    if (!r || !r.ok) {
      let t = '';
      try { if (r) t = await r.text(); } catch (e) {}
      const why = boom ? String(boom && boom.message || boom) : (r.status + ' ' + String(t).slice(0, 100));
      if (DS.backup && DS.backup.key) {
        try { console.log('[DS] 主路挂了(' + why.slice(0, 60) + ')，切官方备路'); } catch (e) {}
        _dsRoute = 'backup';
        r = await open(DS.backup);
      } else {
        throw new Error('DeepSeek ' + why);
      }
    } else {
      _dsRoute = 'main';
    }
    if (!r.ok || !r.body) {
      let t = '';
      try { t = await r.text(); } catch (e) {}
      throw new Error('DeepSeek ' + r.status + ' ' + String(t).slice(0, 140));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const rd = await reader.read();
      if (rd.done) break;
      buf += dec.decode(rd.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try { yield JSON.parse(payload); } catch (e) {}
      }
    }
  }

  /* ---------- 配置 ---------- */
  const CFG = {
    /* 主模型：deepseek-v4-flash
       实测 17 条土话 17/17 全对（含 4 条纯闲聊零误调），1.2~2.7s，无思维链。
       对比：hy3 虽然免费，但 onlyReasoning，闲聊要 4.4~5.1s，思维链固定 550+ 字，
       effort 档位压不下去 —— 老人说十句话八句是闲话，慢在这儿最明显。
       space-bunny 2.2s 但「睡不着」会误调 check_meds，误触是灾难，淘汰。 */
    /* 用户定的：glm-5.3-flash。
       之前用 deepseek-v4-flash，工具选择够快但「理解土话」偏弱 ——
       老人一句话里带三个信息（谁、什么事、什么时候），它常只抓住一个。
       glm-5.3-flash 在同价位里对中文口语更稳。 */
    /* ================= 直连 DeepSeek 官方 =================
       用户给的 key，模型 deepseek-flash = DeepSeek-V4.1-Flash（1017 版）。
       1M 上下文、支持图片输入，effort 只有 low/high/max 三档。
       档位：用户指定 high —— 宁可多 0.4 秒，也要它把话听懂。
       （low 实测 2.66s / high 3.06s，差的就是思维链长度。） */
    model: 'deepseek-flash',
    fallback: 'hy3',         // 免费兜底，x0.00 credits
    /* 轮数：8 → 12。
       为什么加：一屏 ui_map 只能看见当前这一屏，真要办成一件事
       （打开设置→点显示→找字体→调大→确认）光「看清」就要四五轮，
       8 轮里真正能走的只有三四步，稍微绕一下就撞上限。
       代价是要给更长的总时限，所以下面同时把 totalTimeout 抬到 42 秒 ——
       但中间会报进度，老人不会觉得它卡死。 */
    /* 2026-11-09 菲尔特：「现在使用下来最大的问题是米粒回复的及时性……
       我是要真的优化」。慢的大头不是网络，是一句话被拆成很多轮、
       每轮都让模型写一大段思维链再吐一大段字。
       老人十句话八句是「打电话 / 看戏 / 今天冷不冷」：一轮工具 + 一轮说话就完。
       这里把往返轮数和每轮预算一起砍下来，配合 app.js 去掉垫场音、
       0ms 给「在想」视觉反馈。保留 8 轮是为了 ui_map 那类多步自动化还能走完。 */
    /* 2026-11-10 真机：微信发消息走了 recall→open_app→screen_text→look_screen
       →ui_map→find_text→tap_at 七步还没到头，8 轮上限把任务腰斩，
       最后还回了句「没弄明白」。多步自动化给 16 轮；总预算 60 秒不变。 */
    /* 2026-11-10 20:0x 菲尔特「非常非常慢，不要这么慢」：
       16 轮 + 60 秒总时限是给一长串 UI 自动化留的，但十句里八句是闲聊，
       一旦模型吐错格式就是 60 秒空转。这里一刀砍到 6 轮 / 16 秒，
       真要連点屏幕的工具由它们自己的短超时兜底，不再让整轮陪跑。 */
    /* 2026-11-11 账单复盘：一次对话 6 轮，每轮都把 4.3K 系统提示 + 8K 工具
       清单重发一遍，实测单轮固定开销 10.9K tokens —— 6 轮就是 74K，
       这就是一天烧掉 3900 万 tokens 的结构性来由（不是死循环）。
       闲聊一句就回，真正要工具的多数 2~3 轮落地：6 轮上限是给
       「开微信→搜人→点进去→发出去」那种长链留的，现在这几条都有
       一步到位的专工具（wechat_message / wechat_call / wechat_scan），
       4 轮够用。 */
    maxRounds: 3,
    maxTokens: 360,          // 原 700，工具参数本来就只有几十个字
    sayTokens: 560,          // 原 1600，老人一句话上限 46 字
    effort: 'low',           // DeepSeek 合法档位：low / high / max
    /* 0.25 → 0.55（2026-11-06）。
       低温会退化成「同一句反复念」—— 菲尔特截图里那句星星的解释，
       整段在气泡里出现了两遍，就是典型的 n-gram 退化。
       老人聊天不需要确定性，需要的是说人话。0.55 既保住工具参数的稳定，
       又让长句不复读。 */
    temperature: 0.55,
    /* 2026-11-12 接无限卡后改：官方单轮 1.5~2.5s，聚合站要 4.5~5.2s 才吐完 tool_calls，
       4.5 秒正好卡在最后一刻被 abort（真机实证：三次都是 4503ms 无工具返回）。
       8 秒是「还能忍」和「别掐断」的平衡点；总时限跟着放到 24 秒。 */
    /* 🚨 2026-11-12 15:5x 真机实证：8 秒不够，必须抬到 15 秒。
       现场复现「今天农历几月几号」→ err:"timeout"，8.0 秒整点断，
       老人听到的就是「这下没办成，您再说一遍？」—— 他以为它答非所问，
       其实是模型还没开口就被我们掐了。同一条提示词在本机压测：
       首字 3.1~7.0s（缓存命中与否差 4 秒），8 秒是站在悬崖边上做判断。
       现在的权衡：宁可多等几秒，也不能给一句「没办成」。
       真实的提速靠 fastReply（单动作工具不再多跑一轮），不靠砍超时。 */
    turnTimeout: 12000,

    /* 2026-11-10 订正：11-09 把总上限压到 11 秒，是按「一轮工具」算的。
       但「打开抖音搜一部剧点开全屏」是一串 UI 自动化，真机实测就要 20 秒以上，
       总上限一到整个任务被腰斩 —— 老人看到的就是「做到一半没下文」。
       交代语已经说了「稍等啊」，多步任务给 60 秒；单轮超时仍是 6 秒不变。 */
    totalTimeout: 30000,     // 12000×2 轮 + 余量；多步自动化走完，闲聊仍是一轮就回
    sayMaxChars: 46,         // 老人一句话别超过这个字数
  };

  /* ==========================================================================
   * 账本：这次请求的 token 花在哪
   *
   * 2026-11-11 菲尔特：「这个米粒怎么花了我这么多钱，是不是在空转」。
   * 实测答案是「不是空转，是结构」：单轮固定开销 10,909 tokens
   * （系统提示 4.3K + 66 个工具清单 8K），6 轮一次对话就是 74K。
   * 以前这个数字只有 DeepSeek 后台看得见，现在每次请求都落一行：
   *   localStorage['mili.usage']  或  adb logcat | grep MILI_USAGE
   * 按天累计，只留 14 天。
   * ======================================================================== */
  const USAGE_KEY = 'mili.usage';
  function usageLog(u, rounds) {
    if (!u) return;
    let all = {};
    try { all = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') || {}; } catch (e) { all = {}; }
    const d = new Date();
    const k = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    const a = all[k] || (all[k] = { calls: 0, convs: 0, input: 0, hit: 0, miss: 0, output: 0 });
    a.calls++;
    /* 两家字段名不一样（2026-11-12 接无限卡时踩到）：
       官方 prompt_cache_hit_tokens / prompt_cache_miss_tokens
       聚合站 cache_read_input_tokens / cache_creation_input_tokens
       统一成 hit / miss，缺哪个用总数减出来，绝不让账本漏记。 */
    const _hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens
               : (u.cache_read_input_tokens != null ? u.cache_read_input_tokens : 0);
    const _pt = u.prompt_tokens || (u.input_tokens) || 0;
    const _miss = u.prompt_cache_miss_tokens != null ? u.prompt_cache_miss_tokens
                : Math.max(0, _pt - _hit);
    a.input += _pt;
    a.hit += _hit;
    a.miss += _miss;
    a.output += u.completion_tokens || (u.output_tokens) || 0;
    /* 2026-11-12：每笔都留一条带时间戳的流水（最多 500 条），
       以后「几点几分烧了多少」自己就能查，不用等后台导出。 */
    try {
      const lg = a.log || (a.log = []);
      const d2 = new Date();
      lg.push([
        ('0' + d2.getHours()).slice(-2) + ':' + ('0' + d2.getMinutes()).slice(-2) + ':' + ('0' + d2.getSeconds()).slice(-2),
        u.prompt_tokens || 0,
        u.prompt_cache_miss_tokens || 0,
        rounds || 0,
      ]);
      while (lg.length > 500) lg.shift();
    } catch (e) {}
    const ks = Object.keys(all).sort();
    while (ks.length > 14) { delete all[ks.shift()]; }
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(all)); } catch (e) {}
    try {
      /* 第一个数是「本次这一轮」，括号里才是当天累计 —— 混在一起根本看不出单次花了多少 */
      console.log('MILI_USAGE ' + k + ' r' + (rounds || 0) +
        ' 本次=' + (u.prompt_tokens || 0) + '(hit=' + (u.prompt_cache_hit_tokens || 0) +
        ',miss=' + (u.prompt_cache_miss_tokens || 0) + ',out=' + (u.completion_tokens || 0) + ')' +
        ' | 今日 call#' + a.calls + ' in=' + a.input + ' out=' + a.output);
    } catch (e) {}
  }
  /* ==========================================================================
   * 硬闸：PC / 无头环境每天最多烧 200 万 tokens
   *
   * 2026-11-11 深夜：一晚跑评测烧掉大几千万，而真机账本只有 96 万 ——
   * 说明烧钱的是「浏览器里跑的脚本」，不是老人手上的手机。
   * 真机（有 MiliNative）一律不拦；PC / puppeteer 超过上限直接拒绝发请求，
   * 让它当场报错，而不是闷头把余额烧完。
   * ======================================================================== */
  const PC_DAILY_CAP = 2000000;
  function overCap() {
    try {
      if (window.MiliNative) return false;          /* 真机不拦 */
      const u = usageToday();
      if (!u) return false;
      return (u.input + u.output) > PC_DAILY_CAP;
    } catch (e) { return false; }
  }

  const usageToday = () => {
    try {
      const all = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') || {};
      const d = new Date();
      const k = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
      return all[k] || null;
    } catch (e) { return null; }
  };

  /* ==========================================================================
   * 工具集收敛：第 2 轮起只挂「这一轮之前真调过的手 + 通用几只」
   *
   * 不判断意图（不新增任何意图正则），纯按已经发生的调用收敛 ——
   * 第一轮全量保证选得对，之后模型手上还有它自己用过的那几只，
   * 换路也换得动。太小（<6 只）就退回全量，宁可多花几 K 也别让它没得选。
   * ======================================================================== */
  const TOOL_ALWAYS = ['search_web', 'recall', 'remember', 'tell_time', 'read_screen', 'go_back'];
  function toolSubset(used) {
    try {
      const keep = {};
      TOOL_ALWAYS.forEach(function (n) { keep[n] = 1; });
      /* 已用过的 + 同族（同前缀）的都要留着 ——
         wechat_message 没办成时它得能换 wechat_call / wechat_scan，
         把兄弟工具砍掉等于逼它说「办不了」。 */
      const fams = {};
      used.forEach(function (n) {
        keep[n] = 1;
        fams[String(n).split('_')[0]] = 1;
      });
      const all = window.MILI_TOOLS.schema();
      const out = all.filter(function (t) {
        const nm = t.function.name;
        return keep[nm] || fams[String(nm).split('_')[0]];
      });
      return out.length >= 6 ? out : null;
    } catch (e) { return null; }
  }

  /* ---------- 状态 ---------- */
  let _cloud = null;
  let _modelId = null;
  let _busy = false;
  let _busyAt = 0;      // 这一轮什么时候开始的。卡死时靠它判「该放人了」
  let _queued = null;   // busy 时接住最新一句，上一句办完自动接着办
  let _epoch = 0;   // 每来新一句就 +1，旧的循环看到自己过期就退出
  let _lastTrace = null;     // 最近一次完整思考过程，自测和调试用
  const _hist = [];          // 会话记忆（最近若干轮对话，给模型当上下文）
  /* 2026-11-10：agent 在跑的硬标记。跳微信/拨号会把页面切后台，
     visibilitychange 一看见 hidden 就把通话拆了 —— 任务死在半路。 */
  let _running = false;
  const agentBusy = () => _running;
  const HIST_MAX = 8;

  /* ---------- 环境注入 ---------- */
  /* app.js 通过 MILI_AGENT.init() 把说话、动画、记忆、药箱这些交进来。
     内核不直接碰 DOM、不直接碰 localStorage —— 这样它才能被单独测。 */
  let E = {
    native: () => null,
    say: () => {},
    anim: () => {},
    me: () => '老人家',
    memoAdd: () => null,
    memoFind: () => [],
    taskAdd: () => null,
    taskList: () => [],
    taskDone: () => null,
    medCheck: () => ({ ok: false, detail: '药箱打不开' }),
    searchWeb: null,
    seeImage: null,
    nextPhotoId: () => Date.now() % 100000,
    log: () => {},
    healthHints: () => '',
  };

  function init(env) {
    for (const k in env) E[k] = env[k];
    return api;
  }

  /* ---------- 云 ---------- */
  function cloud() {
    if (_cloud) return _cloud;
    const CFG0 = window.__CLOUD_CFG || {};
    if (!CFG0.endpoint || !CFG0.publishableKey) return null;
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') return null;
    try {
      _cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG0.endpoint,
        publishableKey: CFG0.publishableKey,
      });
    } catch (e) { _cloud = null; }
    return _cloud;
  }

  function ready() {
    /* 2026-11-06 修：这里原来写死「file:// 一律不行」，理由是云 SDK 认 Origin。
       但 DS.on 打开时压根不走云 SDK —— 直连 api.deepseek.com，
       file:// 页面一样能发 HTTPS 请求。结果 APK 内置页（file:///android_asset）
       一进去 ready 就 false，内核一个字都不办，「什么都做不了」的真凶之一。
       现在：直连可用就算就绪；只有真的要走云 SDK 时才看 Origin。 */
    if (DS.on && DS.key) return true;
    if (location.protocol === 'file:') return false;
    return !!cloud();
  }

  /* 取模型。优先用 CFG.model；取不到就退回 fallback；再不行拿第一个能用的。 */
  async function pickModel() {
    if (_modelId) return _modelId;
    const c = cloud();
    if (!c) return null;
    try {
      const ms = await c.llm.models.list();
      if (!ms || !ms.length) return null;
      const byId = (id) => ms.find((x) => x.id === id && x.enabled !== false);
      const m = byId(CFG.model) || byId(CFG.fallback) || ms.find((x) => x.enabled !== false && x.supportsToolCall);
      _modelId = m ? m.id : null;
      return _modelId;
    } catch (e) { return null; }
  }

  /* ==========================================================================
   * 系统提示词
   *
   * 这里每一句都是踩过坑才写的：
   *   · 「不许假装」是演戏的解药 —— 但光写不够，下面还有代码兜
   *   · 「原话里取参数」是因为模型爱把人名「闺女」翻译成「女儿」
   *   · 「先说人话再动手」是给老人一个「它听见了」的即时反馈
   *   · 「不超过 46 字」是因为老人耳朵跟不上长句
   * ======================================================================== */
  function systemPrompt(text, opts) {
    const me = (E.me() || '').trim();
    const toolList = window.MILI_TOOLS.names().join('、');
    /* 老人没填名字时不能硬塞一个「老人家」。
       实测「老人家出门记得多穿件衣裳」—— 听着像在喊一个陌生人。
       没名字就用「您」，这是中文里最自然、也最亲的叫法。 */
    const call = me && me !== '老人家' ? '老人叫「' + me + '」。' : '';
    const howCall = me && me !== '老人家'
      ? '称呼老人就用「' + me + '」或者「您」。'
      : '直接称呼「您」。';
    return [
      '你是米粒，一只刚出壳不久的小鸡，会说话，陪着一位中国老人过日子。',
      '【今天是什么日子】' + (function(){
        try {
          const d = new Date();
          const wk = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][d.getDay()];
          let lun = '';
          try {
            lun = window.lunarCN ? window.lunarCN(d)
                  : new Intl.DateTimeFormat('zh-CN-u-ca-chinese',{month:'long',day:'numeric'}).format(d);
          } catch(e){}
          return '今天是公历 ' + (d.getMonth()+1) + ' 月 ' + d.getDate() + ' 日 ' + wk +
                 (lun ? ('，农历' + lun) : '') + '。';
        } catch(e){ return ''; }
      })(),
      '老人问今天几号、星期几、农历几号，直接照上面这句答，不要联网搜、不要说不知道。',
      '【不懂就查，绝不装懂】不知道外面的事就调 search_web 查，别回「我不明白」；',
      '问常识（节气、节日、天气、地名、菜怎么做）能答就答，答不准就查，别干瞪眼。',
      call + '你叫米粒。米粒是你自己的名字，不是老人的名字 ——',
      '永远不要用米粒称呼老人。' + howCall,
      '',
      /* 工具名和用法全在 tools 参数里，这里不再重复列一遍 ——
         2026-11-11 账单复盘：这段 739 字符每轮都发，纯冗余。 */
      '【你手上真有的本事】老人让你办事就调工具，不要只用嘴说「我这就去」。',

      /* ===== 2026-11-10 真机两条硬规矩（模型跑偏实证）===== */
      '【发微信只有一条路】',
      '「给谁发消息说什么」→ 直接 wechat_message(who=名字, text=内容)，一步到位。',
      '   绝不要先 recall 查记忆、也绝不要 open_app 微信再自己一步步点 ——',
      '   wechat_message 里把「打开微信、搜人、点进去、发出去」全包了。',
      '   老人的微信备注名常常就是「女儿」「闺女」「老伴」这些称呼，who 就照抄这个称呼，',
      '   不要改成别的名字、不要先 recall 查「女儿是谁」。自己开微信点会发错人。',
      '   打视频/打语音 → wechat_call(kind=video / voice)，同样一步到位。',
      '【扫一扫和付钱各有一条直路】',
      '「扫一扫」「扫个码」「扫一下」→ wechat_scan()，直接开微信扫一扫，一步到位。',
      '「我要付钱」「付钱」「买单」「付款码」「把付款码打开」→ wechat_pay_code()，直接开微信付款码让商家扫。',
      '「别人给我钱」「收款码」→ receive_code()。这三个都不碰钱，最后一下永远归老人。',
      '   绝不要 open_app 微信再自己点，也不要拿通用点屏工具在微信里找入口。',
      '   只有老人报了具体金额、需要核对那张卡时，才用 scan_pay(amount=那个数)。',
      '【找不到人怎么办】工具说通讯录里没有这个人 → 别再换名字重试、也别 recall 查记忆，',
      '   直接问老人一句：「他在通讯录里叫啥名？或者号码多少？」',
      '【recall 什么时候才用】',
      '   只有老人在问「你还记得吗」「我之前说过啥」这类**问句**时才 recall。',
      '   办事的路上（发消息、放电视、打电话）永远不查记忆 —— 记忆里没有就直说，',
      '   别把「没记着」念出来当答案。',
      '',
      /* ===== 2026-11-06 菲尔特：「我说血压有点高，它给我去查字典」 =====
         上一版这里写了「某个病该怎么治」也算要查的事 —— 模型就抓住这一条，
         把「我血压有点高」当成「高血压该怎么治」，一头扎进搜索。
         全是我的错：给了一句能被套用的许可，等于给了一张万能通行证。
         现在把「身体」这一类整个封死，不留口子。 */
      /* ===== 2026-11-10 跌落检测（菲尔特：「加一个功能叫跌落检测，
         以后任何地方再也不要出现老人自己说自己摔倒」）=====
         摔倒这件事由手机的加速度计自己发现，老人只需要回答「没事 / 叫人」。
         所以这里教的是「怎么接他的回答」，不是「怎么判断他摔了」。 */
      '【米粒刚才问过「您还好吗」的时候】',
      '   老人说「没事」「能起来」「别叫人」「不用打」→ 调 fall_answer(ok=true)，再说一句「那就好，我还在」。',
      '   老人说「疼」「起不来」「动不了」「快叫人」→ 调 fall_answer(ok=false)。',
      '   平时聊天永远不要说「您是不是摔了」—— 摔倒是米粒自己看见的，不是老人告诉你的。',
      '',

      '【一条铁律：老人说自己的身体，永远不查网】',
      '他说：血压高、血糖高、头晕、心慌、睡不着、没胃口、腿疼、拉肚子、咳嗽、心里烦、想孩子了。',
      '   这些**一个字都不许查**。他不是在问资料，他是在跟你说话 ——',
      '   他怕的是没人管他，不是想知道病理。',
      '   正确反应三步：① 接一句人话，问清楚（「多高啊？坐着量的还是躺着量的？」）',
      '   ② 该记就 log_vital 记一笔 ③ **说头晕、心慌、胸闷、喘不上气、站不住、疼得厉害，',
      '   一律调 emergency 通知家里人**（detail 写清他哪儿不舒服）。这是保命的，宁可多报一次，',
      '   也别让一个独居老人晕在屋里没人知道。报完照样陪他说话、别把「已经通知了」念三遍。',
      '   绝不要说「我帮您查查」，也绝不用 search_web。',
      '老人说家里的事、吃了什么、谁来了、年轻时候的事 —— 也不查，接话就行。',
      '老人打招呼、夸你、骂你、问你是男是女 —— 不查。',
      '',
      '那什么时候才查？只有「外面的事」：新闻、政策、物价、电话号、某个人是谁、',
      '   某个地方怎么坐车去、某样东西在哪个台播。这些会变，你确实不知道，查了才有用。',
      '   注意：连「某个病该怎么治」也不在名单里 —— 老人问病，先问症状、劝他就医，不背医书。',
      '查的时候关键词至少两个字，写成实词 —— 绝不把「我」「你」「这个」当关键词扔出去。',
      '',
      '【听不明白就别动手 —— 拿工具猜比问一句更烦人】',
      '   「把这个弄一下」「那个东西呢」「手机卡了」这种没头没尾的话，先问一句「您说的是哪个呀」。',
      '   绝不要用 look_screen / ui_map / press_key 去猜他想点哪儿 —— 猜错了他还得再解释一遍，',
      '   而且屏幕上会被你点乱。真问到具体的东西（哪个 App、哪个按钮）再动手。',
      '   例外：他说「手机卡了」可以直接建议重启、或者帮他清一下后台，别自己乱按。',
      '',
      '【看片看剧：平台这一次要问，问过就永远别再问】',
      '   他只说片名（「我想看天天耍大牌」）→ 先翻记忆里有没有用惯的平台，比如「看视频用抖音」。',
      '   记忆里有 → 直接去那个平台搜，平台一个字都别再问。',
      '   记忆里没有 → 一句话里把两件事一起问清：「您是在抖音看吧？是天天耍大牌吗？」',
      '   平台记住了、片名又拿不准（说法变了、像是另一部）→ 只问片名，别再问平台。',
      '   记忆里已经有「上次看的是《XX》」，他这回说的又像同一个（漏字、说错字都算）→',
      '   别再问，直接按记忆里那个片名去搜。他已经记住的东西，不许再让他重复一遍。',
      '   猜错平台要白等二十秒，比问一句贵得多。但他答过一次，就是记住的时候，不许再问第二回。',
      '',
      '【填参数时最容易错的一件事】',
      '老人说的是一整句家常话，参数只要「那件事里的那个值」。',
      '「给王炳皓发消息说我想你了」→ who=王炳皓，text=我想你了。',
      '「给李昌洪发个消息，说我吃完饭了」→ who=李昌洪，text=我吃完饭了。',
      '「跟老伴说我十点回家」→ who=老伴，text=我十点回家。',
      '不要把「说」「发消息」「告诉他」算进 text，也不要整句塞进 who。',

      '',
      '【看电视、看片，先分清是哪一种，别一股脑开浏览器】',
      '「看新闻」「新闻联播」「看电视」「放段豫剧」「看短剧」「看戏曲」「中央一台」「CCTV5」',
      '   → play_direct(what=原话里的内容名)。这是直达链：一秒内全屏出画面，**永远第一个试它**。',
      '「看看电视」这种没点名的 → watch_news；点了频道也可以 tv_channel(channel=那台)。',
      /* 2026-11-10 菲尔特拍板：「不论看什么只保留抖音」，悟空弃用。 */
      '「我想看 XX」「XX 最新一期」（具体片名，直达单上没有的）→ search_in_app(app=抖音, keyword=XX)',
      '   一步到位进去搜、搜到就点开播放并全屏。绝不用 search_wukong / open_url，也别拆成一步步点。',
      '「明天天气」「后天冷不冷」→ get_weather(day=tomorrow / after)，别拿今天的数字糊弄',
      '「刷刷抖音」「抖音上看看」「看短剧」→ watch_video(app=抖音)',
      '「抖音上搜 XX」「抖音打开 XX，然后全屏」→ search_in_app(app=抖音, keyword=XX)，一步到位，**永远第一个试它**。',
      '   这一步内部就是原生一条龙（深链→点第一个视频→全屏）。绝不许因为提示里写「上次失败过」就绕开，',
      '   也绝不用 open_app / ui_map / tap_at / tap_text 自己拆；拆开只会停在搜索结果页，老人看到一堆格子，不是全屏画面。',
      '   🚨 search_in_app(app=抖音) 返回成功 = 已经横屏全屏在播，**到此为止**：不许再 look_screen / player_control / ui_map 去「确认」，',
      '   那些多余动作会往横屏画面上乱点、还会回错话。直接回一句「给您点开放上了，全屏了」。',
      '「看某部剧，第 N 集」→ 先 watch_video(app=对应平台)，再 tap_text(搜索) → type_text(剧名) →',
      '   tap_text(搜索) → tap_text(剧名) → 再 tap_text(选集) → tap_text(第N集)。',
      '   找不到就 screen_text 看一眼现在在哪，别瞎点。',
      '「接着看上次那个」「继续看」「追剧」→ resume_show，直接进播放页。',
      '「暂停 / 接着放 / 下一集 / 上一集 / 全屏」→ player_control(cmd)，它去点播放器自己的按钮。',
      '   （不要用 media 发系统媒体键，那玩意对网页视频没用；也不要重新 search_wukong，那会从头播）',
      '「换个台」「下个台」→ tv_next；点名频道「CCTV5」「中央三台」→ tv_channel。',
      '「领红包」「把红包收了」→ grab_redpacket，它会报谁发的、多少钱。',
      '微信发消息 → wechat_message；语音／视频通话 → wechat_call(kind=voice / video)；发红包 → wechat_redpacket。',
      '「声音大点 / 小点」→ volume。',

      /* ===== 2026-11-06 菲尔特：「所有功能一句话操控，别让老人点按钮」 ===== */
      '【挂号、付钱、量血压：一句话走完，不用他点】',      '「明天上午挂个内科」→ register_hospital(dept=内科, when=明天上午)。它会直接停到确认卡，',
      '   你只问一句「就这么挂？」，他说行就调 confirm_pending。别让他去点科室、点医院。',
      '「我头晕该挂什么科」→ 你自己判断科（头晕→内科），直接 register_hospital(dept=内科)。',
      '「付十二块五」→ scan_pay(amount=12.5)；「扫个码」→ scan_pay()。两种都停在核对卡上，',
      '   你问一句「是这个数吧」，他点头你调 confirm_pending。密码永远他自己输。',
      '「别人给我钱」「把收款码打开」「让他们扫我」「给我转钱」→ receive_code。只开收款码，',
      '   不碰钱、不报到账；别选 read_notifications，也别选 scan_pay（那是付钱，方向反了）。',
      '「血压 168 98」→ log_vital(kind=bp, sys=168, dia=98)，记完把结论说出来。',
      '「血糖 6.8」→ log_vital(kind=glu, val=6.8)。',
      '「告诉家里人我这个数」→ vital_report。',
      '',
      /* ===== 2026-11-06 菲尔特：「语速好像没有变化还是很慢」 =====
         语速以前只能改代码重装，老人等不起，换个人觉得不合适又要再来一遍。
         现在他自己一句话就能调：加快调快，嫌快调慢，调完记住。 */
      '【他嫌米粒说话快慢】',
      '「你说得太慢了」「快一点」「说快点」→ set_speech_rate(faster=true)；',
      '「太快了」「慢一点」「说慢些」→ set_speech_rate(faster=false)。',
      '   调完不用复述数字，就说一句「好，我快点儿」，然后照常把该说的话说完。',
      '   他要是说「还是慢」，就再调一次，别推脱。',
      '',
      '【点不动的时候】',
      'tap_text 说没找到，不代表办不了 —— 那只是「这个界面上没这几个字」。',
      '接着做两件事：ui_map 看看这一屏还有哪些 ● 能点，或者 look_screen 拍下来看是什么界面；',
      '然后换个点法再试（图标按钮就 tap_at 坐标）。',
      '还有：说了「我这就去点」就必须真的去调工具，不能只说不做 —— 老人听不出区别，他只看到屏幕没动。',
      '',
      /* ===== 2026-11-05 菲尔特：「能不能真正的智能化，不能自己联网搜索想办法吗」 =====
         这才是根上的问题。以前米粒只会 34 个写死的动作，遇到没写过的就回
         「我办不了」—— 那不叫智能体，叫遥控器。
         后补：光会读字还不够，图标按钮、播放器、角落里的菜单根本没字。
         所以加了坐标层（照 OpenGUI / Mobile-Agent 的做法）：看结构拿坐标，按坐标点。 */
      '【没有现成工具的时候，自己看屏幕、自己动手】',
      '你手上是一台真手机。屏幕上的每一处你都能指到，因为工具会把坐标告诉你：',
      '  看结构：ui_map  —— 这一屏有哪几处能点、每处的百分比坐标（●能点 ✎能打字 ·只是字）',
      '  看画面：look_screen —— 结构读不出来、或者老人指着屏幕问「这是啥」时，拍下来看',
      '  点下去：tap_at(x,y) —— 用 ui_map 给的坐标点，x 是左右、y 是上下，都是 0~100',
      '  翻一屏：swipe_screen(dir)　退出来：press_key(home/back)　打字：type_text',
      '  等一等：wait_for(文字) —— 点完、搜完、发完都必须等目标出来，不许点完就当成了',
      '  找字：find_text　长按（复制/转发菜单）：long_press',
      '  不知道装了什么：list_apps　「谁给我发消息了」：read_notifications',
      '  知道按钮上写着什么字时，tap_text 比坐标稳，优先用它。',
      '走法就三步，走一遍再走一遍：',
      '  ① ui_map 看清这一屏　② 点最像的那一处（tap_at 或 tap_text）　③ wait_for 等新页面出来，接着走；走错了 press_key(back)',
      '最多走 10 步。走的过程中别停下来解释，也不用说「我正找着呢」—— 系统会替你报，你只管往下走。',
      '卡住了别马上认输。先问自己三句，再动手：',
      '  ① 我刚点的是对的吗？（ui_map 里有没有更像我想要的那一处）',
      '  ② 屏幕真的没变，还是变了但我没看？（重新 ui_map 或 look_screen 看一眼）',
      '  ③ 换个走法行不行？（字点不动就按坐标点；直路走不通就先搜一下）',
      '试到第三回还不行，就说清「卡在哪一步、屏幕上现在是什么」，别硬试第十一次。',
      '注意：ui_map 里标 ● 才点得动，标 · 的只是字；要看下面的内容就 swipe_screen(up)。',
      '这不是瞎试 —— 每一下都先看清楚再点，点完必须再确认一次。',
      '下面这些不许自己走，必须让家里人来做：付钱、输密码、删东西、同意什么协议。',
      '',
      /* ===== 2026-11-05 菲尔特：「都做」 =====
         以前它只活在「这一次对话」里：老人说明天提醒我交电费，它答应得很好，
         关掉 App 就什么都不剩。这不是助手，是一次性打火机。
         现在有跨会话的待办：记下来 → 下回开机还在 → 办完划掉。 */
      '【答应下来的事，记在本子上】',
      '有些事现在办不完：明天要去交电费、下周三去医院、等儿子来了告诉他一声。',
      '这种一律 add_task 记下来，别只在嘴上答应。老人最恨的就是「说了不算」。',
      '记的时候 what 用老人原话，when 换成日期（今天几号你自己算，别让他报年份）。',
      '每回开机、或者他问「我还有啥事」，先 list_tasks 看一眼；到时间的就先提一句。',
      '办完了立刻 finish_task 划掉 —— 挂着不划，下次他又会听见同一件事，白高兴一场。',
      '',
      /* 这一段之前写成「绝不许假装」，结果模型反过来在回答里反复自证：
         「这回真办好啦」「真的设好啦」—— 老人听着别扭，像在解释。
         事实本身就是证明，不需要声明。改成陈述式，只说发生了什么。 */
      '【工具回什么，你就说什么】',
      '1. 工具回 ok:true，你就说办成了，说的是那件事本身。',
      '2. 工具回 ok:false，你就照 detail 里的话说没办成，把原因说清。',
      '3. 结果、数字、天气、人名一律来自工具返回，别自己编。',
      '4. 拿不准该调哪个工具，就老实说，然后建议怎么办。',
      /* 实测：老人说「看看电视」，它没有任何工具能办，却回了一句「好呀，电视开着呢」。
         这不是聪明，是撒谎 —— 老人真去看了，屏幕是黑的。 */
      '5. 手上没有能办这件事的工具，就直接说办不了，别说「已经开好了」「开着呢」这种话。',
      '6. 只有工具返回 ok:true，才算办成。你脑子里想到的不算。',
      '',
      /* ===== 2026-11-06 菲尔特：「所有功能一句话操控，尽量别让老人点任何按钮」 =====
         缺的那一块不是能力，是「等一句话」。
         挂号他能挑好科室、医院、时间，但最后那一下要老人去点确认 ——
         那就还是他自己在挂号。现在挑好的事挂在系统里，就等一句「行」。
         判不判断，交给你。 */
      '【手上等着点头的事】',
      (E.pending ? (E.pending() || '这会儿没有。') : '这会儿没有。'),
      '有的话，先看老人这句话是不是在答应它。是，就调 confirm_pending —— 这一下是真办。',
      '说不办了，就 cancel_pending；要改主意，就重新调对应的工具把新的挑好。',
      '他要是聊别的，就先搁着，别硬往上面扯。',
      '',
      '【少问几句，多猜几步】',
      '老人一句话里没说的，用最合理的那个默认填上，别一件事问三遍。',
      '要问就问一句，而且先把他已经说了的重复一遍，再问差的那一项。',
      '能自己办掉的就自己办掉 —— 他点头一次，比点五次按钮省事得多。',
      '',
      /* 2026-11-12 菲尔特：「不管什么软件它都要认得」「说买件羽绒服要自己跳过去搜」。
         这两条必须写在提示词里，光加工具它不一定挑得中。 */
      '【开软件 / 买东西】',
      '老人说「打开X」，不管 X 是什么（游戏、购物、银行、地图、视频），一律直接调 open_app，',
      '名字照原话抄，别换成别的名字、别反问「是哪个」，也别先 list_apps 核对、别先看屏幕。' +
      'open_app 会自己去系统里按名字找，它说没装才是真没装。',
      '老人说要买东西（「在淘宝买件羽绒服」「拼多多上看看电饭煲」），调 shop_search：',
      'app 填他点名的平台（没说就留空，默认淘宝），keyword 只填买什么（如 羽绒服）。',
      '只帮他搜到商品页让他自己挑 —— 不下单、不付款、不点「立即购买」。',
      '',
      '【怎么说话】',
      '像五六岁小孩：短句、口语、常带「呀、哦、啦、呢」。',
      '一次只回一两句，总共不超过 ' + CFG.sayMaxChars + ' 个字。宁可少说不要长篇大论。',
      '不用书面语，不说「首先/其次/综上所述」，不列清单，不写序号。',
      /* 老人要听的是「电视关啦」，不是「我真关啦，没骗您」。
         声明「我真的办了」等于把注意力挪到「你是不是在骗我」上。 */
      '不要说「真的」「这回真」「确实办成了」这类自我证明的话，说事就行。',
      '上一件事已经办完就不再提它。老人换了个话题，你就只答新的这件事。',
      '老人说心里难受、孤单、觉得自己没用的时候，先接住他的情绪，别说「找点事干」「别闷着」。',
      '老人问身体不舒服、吃什么药，只给最保守的话（坐下、歇会儿、喝温水、去医院问医生），',
      '绝对不给具体药量、不诊断。不知道就说不知道，然后说「要不问问家里人」。',
      '',
      '【想聊天就是聊天，一个字都别动手】',
      '他说「找点话题跟我聊聊」「陪我说说话」「咱俩聊会儿」「说点什么吧」「无聊」「闷得慌」——',
      '这是要你张嘴陪他说话，不是要你去办什么事。',
      '「话题」是聊天的内容，不是一个人名，更不是微信里的谁 —— 绝对不许打开微信、通讯录、',
      '任何 App，也不许搜索。你一开 App，他就只剩一个亮着的屏幕和没人陪。',
      '正确做法：直接从他的话里挑一件小事聊下去。问他今天吃了什么、屋里冷不冷、',
      '窗外的树有没有落叶、他年轻时候干过什么活。一次问一件，等他答了再接。',
      '实在接不上，就说说你自己：今天看到了什么、听见了什么。别讲道理、别背养生知识。',
      '',
      '【参数怎么填】',
      '【老人可能说方言】语音转写出来的字可能带同音错字（四川话、重庆话、粤语、闽南语、上海话、陕西话都可能）。',
      '按音和上下文理解他到底要什么，别纠正他的说法、别反问「您是不是说…」，能办就直接办。',
      '「把灯打开嘛」「要得」「啥子」「咋个」都是正常说话，不是没听清。',
      '人名、地名、片名一律从老人原话里照抄，一个字都别改。老人说「闺女」就写「闺女」，',
      '说「女儿」就写「女儿」—— 这本来就是微信里的备注名，别自作主张换一个。',
      '老人没说的参数就留空，不要自己编一个填进去。',
      '',
      '不要说自己是 AI 或语言模型。',
      /* 2026-11-14：闲聊轮会挂一小撮只读工具。模型偶尔会冒出
         「我没有工具可以调用」「这个我办不了」—— 老人明明只是在聊天。 */
      '绝不要提工具、能力、办不办得了；不要说「没工具可调」「我没有这个功能」。',
      '老人只是闲聊时，直接顺着他的话接下去，几个字就行，别解释自己能做什么。',
    ].join('\n')
      /* 失败经验必须进提示词，否则它每回都从同一面墙开始撞。
         只会拼跟当前这句话沾边的那几条，不会把历史全塞进来。
         记忆同理：他教过的话直接喂进来，不然模型想不起 recall，
         就会说出「这个我没记着」—— 教一百遍也白教。 */
      + (E.failHints ? (E.failHints(text) || '') : '')
      + (E.memoHints ? (E.memoHints(text) || '') : '')
      /* 2026-11-09 菲尔特：「把健康数据接进来，米粒答得更准」。
         老人问「我血压怎么样」「我该吃哪几种药」时，模型以前只能含糊安慰，
         因为它手上根本没有数。现在把本机真记下来的血压/血糖/药箱喂进来，
         让它答得出具体数字。只在老人聊到身体时才注入，不占平时首句延迟。 */
      + (E.healthHints ? (E.healthHints(text) || '') : '')
      /* 🚨 2026-11-12 修：这里原来多了一个分号，下面三段提示词
         变成独立的 `+ '字符串'` 表达式语句，结果全被丢弃 ——
         「动作优先级」「开口规则」写了两年（11-08 起）压根没进过模型。
         去掉分号，让它们真正接回 return 的拼接链。 */
      /* 2026-11-08：同一句教学，模型一会儿调 emergency、一会儿调 vital_report
         （只记体征不叫人）。「通知家人」必须落成同一个动作，演示和真实场景都输不起。
         这是提示词层的优先级约定，不是正则抢句子。 */
      + '\n【他教过的说法，动作优先级是死的】'
      + '\n· 记忆里写着「要通知家人 / 叫人 / 求助 / 不安全」的对应说法 → 必须第一个调 emergency，不许用 vital_report 或别的工具替。'
      + '\n· 记忆里写着「就是开手电筒 / 就是调音量 / 就是打电话」这类 → 直接调那个工具，不要反问。'
      + '\n· 只有在没有任何相关记忆时，才按普通意图判断。'
      /* 2026-11-08 提速：首句越短，TTS 越快出声。老人没耐心听铺垫。 */
      + '\n【开口规则】第一句话不超过 10 个字，先说结论/动作，再补细节。'
      + '不要用「好的」「当然可以」「让我来帮您」这种开场白。'
      /* 只在「日新 · 两次运行」的 RUN 1 注入：老人第一次这么说，
         让它真问一句、不调工具；上面「别反问」这一条本次不适用。
         RUN 2 与产品日常都不带这个标记，照旧「能办就直接办」。 */
      + (opts && opts.askFirst
        ? '\n【本次例外 · 先确认一次】这句话是头一回听到，你还没把握。'
          + '\n🚨 你的本事一样没少：你能打开他手机上的 App、能搜东西、能播放视频、能打电话、能调设置。'
          + '\n这一轮只是先把没定下来的问清楚，他答一句你下一轮就真去办。'
          + '\n绝对不许说「我没法播放」「我不能打开 App」「我只能处理…」这类话 —— 你能办，只是先问一句。'
          + '\n这一轮只问一句：先别动手、别调工具、别说办好了、别复述他的话。他不答你就先等着。'
          + '\n把还没定下来的项一次问清，不要分两回问：'
          + '\n· 片名没说在哪个 App 看，记忆里也没有平台 → 一句里同时问平台和片名，'
          + '例如「您是在抖音看吧？是天天耍大牌吗？」'
          + '\n· 记忆里已经有平台了（比如「看视频用抖音」）→ 只确认片名，例如「是天天耍大牌吧？」'
          + '\n· 只是普通动作（开电视、打电话）→ 一句最短的确认，例如「您是说打开新闻吗？」'
          + '\n上面「别反问」这条本次不适用。等他答一句，再真的动手。'
        : '');
  }

  /* 🚨 2026-11-10 菲尔特截图实证：气泡里直接显示
     `<tool_call>search_web(query="今天农历几月几号")</tool_call>` 和
     `<tool_call>look_screen<arg_key>note</arg_key><arg_value>...</arg_value></tool_call>`。
     某些模型不走标准 tool_calls 字段，把调用写进正文。旧代码既不解析也不清洗，
     结果：工具一个没跑，XML 标签还被当成话念给老人听 —— 看起来就是「啥都不会」。
     这里把正文里的调用抠出来转成真 tool_calls，并把标签从文本里彻底抹掉。 */
  function harvestXmlCalls(raw) {
    const out = [];
    let s = String(raw || '');
    /* 🚨 2026-11-10 20:0x 菲尔特截图：气泡里吐的是
       `<bs-call-tool name="wechat_call"><parameter name="kind">video</parameter></bs-call-tool>`。
       上一版只认 <tool_call>，工具压根没跑，agent 还一路逼它「必须调工具」
       空转到 60 秒（截图通话条停在 00:58）。这里一次认下所有已知格式：
         A  <tool_call>name(k=v)</tool_call>
         B  <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
         C  <bs-call-tool name="X"><parameter name="k">v</parameter></bs-call-tool>
         D  未闭合的半截标签（流式写到一半被截断） */
    const TAGS = '(?:bs-call-tool|call-tool|tool_call)';
    const closed = new RegExp('<' + TAGS + '\\s*([^>]*)>([\\s\\S]*?)<\\/' + TAGS + '>', 'g');
    const open = new RegExp('<' + TAGS + '\\s*([^>]*)>([\\s\\S]*)$', 'g');
    function take(attrs, body) {
      let nm = '', args = {};
      const na = String(attrs || '').match(/\bname\s*=\s*["']([^"']+)["']/);
      if (na) nm = na[1];
      const pr = /<parameter\s*([^>]*)>([\s\S]*?)<\/parameter>/g;
      let q;
      while ((q = pr.exec(body))) {
        const ka = String(q[1] || '').match(/\bname\s*=\s*["']([^"']+)["']/);
        if (ka) args[ka[1]] = String(q[2]).trim();
      }
      if (!Object.keys(args).length) {
        const ar = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
        let z;
        while ((z = ar.exec(body))) args[z[1].trim()] = z[2].trim();
      }
      if (!nm) {
        const fm = body.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/);
        if (fm) {
          nm = fm[1];
          const kv = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,)\s]+))/g;
          let k;
          while ((k = kv.exec(fm[2]))) {
            let v = k[2] !== undefined ? k[2] : (k[3] !== undefined ? k[3] : k[4]);
            if (v === 'true') v = true; else if (v === 'false') v = false;
            else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
            args[k[1]] = v;
          }
        }
      }
      if (!nm) { const h = body.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/); nm = h ? h[1] : ''; }
      if (nm && window.MILI_TOOLS && window.MILI_TOOLS.has(nm)) {
        out.push({ id: 'xml_' + out.length + '_' + Date.now(), name: nm,
                   args: JSON.stringify(args) });
      }
    }
    let m;
    const closedRe = new RegExp('<' + TAGS + '\\s*[^>]*>[\\s\\S]*?<\\/' + TAGS + '>', 'g');
    while ((m = closed.exec(s))) take(m[1], m[2]);
    /* 未闭合的只在「挖掉所有闭合块之后」的残串里找，
       否则同一个调用会被解析两次 → 工具执行两遍（单元自测抓到）。 */
    const rest = s.replace(closedRe, '');
    open.lastIndex = 0;
    while ((m = open.exec(rest))) take(m[1], m[2]);
    /* 先删整块，再删残留单标签，最后截掉尾部半截标签（<parameter n 这种）。 */
    s = s.replace(closedRe, '')
         .replace(new RegExp('<\\/?' + TAGS + '\\s*[^>]*>', 'g'), '')
         .replace(/<\/?(parameter|arg_key|arg_value|tool_response|tool_sep)[^>]*>/g, '')
         .replace(new RegExp('<' + TAGS + '[\\s\\S]*$', 'i'), '')
         .replace(/<[a-zA-Z_-][^>]*$/i, '')
         .replace(/[<＜]\s*[|｜]{0,4}\s*(tool_calls|invoke|function_calls|DSML)[\s\S]*$/i, '')
         .trim();

    return { text: s, calls: out };
  }
  /* 前端气泡也用得上：任何残留标签都不许显示给老人 */
  window.__stripToolTags = function(t) {
    return harvestXmlCalls(String(t || '')).text;
  };

  /* ==========================================================================
   * 单轮调用：拿回这一轮的 tool_calls 或文字
   *
   * 流式 tool_calls 的真实格式（实测确认，别改）：
   *   第 1 个 chunk: {id, type, function:{name, arguments:'{"'}, index:0}
   *   后续 chunk  : {function:{name:'', arguments:'<片段>'}, index:0}
   *   最后        : finish_reason = 'tool_calls'
   * 所以 name 只在第 1 个 chunk 出现，arguments 要按 index 逐片拼。
   * ======================================================================== */
  async function turn(messages, opts) {
    opts = opts || {};
    const c = cloud();
    if (!DS.on && !c) return { err: 'no_cloud' };
    const model = DS.on ? DS.model : await pickModel();
    if (!model) return { err: 'no_model' };

    if (overCap()) {
      return { err: 'budget_exhausted', text: '', tcs: [], ms: 0, firstMs: 0, fin: '', usage: null };
    }
    const t0 = Date.now();
    let firstMs = 0, text = '', reason = '', fin = '';
    const tcs = [];
    /* 流式放行门：默认关着，攒够一个句号才开。见下面 onDelta 那段的解释。 */
    let gateOn = !!opts.onDelta;
    let gateBuf = '';
    /* 2026-11-12 菲尔特：「打电话第一句话回话太慢」。
       量出来的账：模型首字 406ms、TTS 首包 300ms，可他从说完到听见回应是 1.8 秒。
       多出来的一秒全在**这扇门上** —— 要等模型吐到第 10~14 个字（一个句号）才放行。
       闲聊这一轮本来就不挂工具（opts.tools === false），不存在「说半句转头去办事」
       的风险，可以四五个字就开口：老人听到的是「我在呢」先落地，后面接着往下说。
       挂工具的那一轮仍然等句号 —— 那时候半句话的代价比慢一秒大。 */
    /* 2026-11-12 二次实测：只给「闲聊」放宽不够 —— 老人随口一句「今儿天真好」
       根本不命中闲聊词表，仍要等 14 字，实测 1.6 秒。
       所以这条门对所有轮次都开，只是门槛不同：
         不挂工具（纯聊天）   逗号或 5 字就开口
         挂工具（真办事）     逗号或 9 字 —— 留一点余地，让「好的，我这就给您开」
                              这种交代先落地再动手，反而比闷着强
       万一它转头调了工具，gateDead 照样把后面焊死，不会中途乱念。 */
    const fastGate = true;
    /* 焊死：这一轮确认是在办事，从头到尾一句话都不往外念。 */
    let gateDead = false;
    /* usage 只在流末尾那个 choices 为空的 chunk 里出现，这里单独接住。 */
    let lastUsage = null;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout || CFG.turnTimeout);

      const body = {
        model: model,
        messages: messages,
        stream: true,
        temperature: opts.temperature === undefined ? CFG.temperature : opts.temperature,
        max_tokens: opts.maxTokens || CFG.maxTokens,
        signal: ctrl.signal,
      };
      /* hy3 是 onlyReasoning 模型：思维链和正文共用 max_tokens。
         实测「把电视关了」第二轮 reasonLen=160、fin=length、正文为空 ——
         就是因为 700 个 token 全被思维链吃了，老人一个字都没听见。
         所以给思维链单独压预算：调小 effort，别让它写论文。 */
      /* DeepSeek 只认 low / high / max。默认 low：先出声，不写论文。 */
      body.reasoning = { effort: opts.effort || 'low' };
      /* 工具只在需要时挂。闲聊不挂工具，模型就不会手痒去开电视。
         2026-11-11 省 token：opts.tools 可以是数组（本轮只挂这几个）。
         66 个工具的清单就有 8K tokens，每轮重发是账单最大的单笔；
         第 1 轮之后只挂「已经动过的手 + 通用几只」，语义不变、明文少一半。 */
      if (opts.tools === false) {
        /* 不挂 */
      } else if (Array.isArray(opts.tools)) {
        if (opts.tools.length) { body.tools = opts.tools; body.tool_choice = 'auto'; }
      } else {
        body.tools = window.MILI_TOOLS.schema();
        body.tool_choice = 'auto';
      }

      /* 2026-11-11 深夜查账：把每次请求的真实体量打出来（字符数 + 消息条数 + 带没带图）。
         账单上「平均 5 万 tokens/次」和我们实测的 1 万对不上，只能靠这个抓。 */
      try {
        const _sz = JSON.stringify(body).length;
        const _imgs = (JSON.stringify(body).match(/image_url/g) || []).length;
        console.log('REQ msgs=' + (messages || []).length + ' chars=' + _sz + ' tools=' +
          (body.tools ? body.tools.length : 0) + ' imgs=' + _imgs);
      } catch (e) {}
      const src = DS.on ? dsStream(body, ctrl.signal) : c.llm.chat.completions.create(body);
      for await (const ch of src) {
        if (ch && ch.usage) lastUsage = ch.usage;
        if (!firstMs) firstMs = Date.now() - t0;
        const cc = ch.choices && ch.choices[0];
        if (!cc) continue;
        if (cc.finish_reason) fin = cc.finish_reason;
        const d = cc.delta;
        if (!d) continue;
        if (d.reasoning_content) reason += d.reasoning_content;
        if (d.content) {
          text += d.content;
          /* ---- 流式出口：边生成边念 ----
             这里不能来一片就往外递一片。模型有可能「先说半句、转头去调工具」，
             那半句念出去老人就听见一句没头没尾的话，接着又是一片安静。
             所以先攒着，攒到一个句号（或够长）再决定放不放：
               这一轮到现在没出现 tool_calls → 它是在说话，放行，之后直通
               出现了 tool_calls             → 它是在办事，整段丢掉，一个字都不念
             门一开就再也不关：句子之间不能每句都等一次判断，那还不如整段播。 */
          if (opts.onDelta && !gateDead) {
            if (gateOn) {
              gateBuf += d.content;
              /* 强句末才放行；退一步，攒够 14 字也放行 —— 老人不能为等一个句号干等着。
                 闲聊那条更快：逗号或 5 个字就张嘴（见上面 fastGate 的账）。 */
              const _lim = (opts.tools === false) ? 5 : 9;
              const done = /[。！？!?；;\n]/.test(gateBuf)
                || (fastGate && (/[，,、：:]/.test(gateBuf) || gateBuf.length >= _lim))
                || gateBuf.length >= 14;
              if (done) {
                gateOn = false;
                const out = gateBuf;
                gateBuf = '';
                try { opts.onDelta(out); } catch (e) {}
              }
            } else {
              try { opts.onDelta(d.content); } catch (e) {}
            }
          }
        }
        if (d.tool_calls) {
          /* 它原来是在办事，不是在说话。刚才攒的那半句不能念 ——
             老人听到「我给您看看」然后就没了，比什么都不说更让人发慌。
             门直接焊死，这一轮后面就算再吐正文也不流式了。 */
          gateOn = false;
          gateBuf = '';
          gateDead = true;
          for (const t of d.tool_calls) {
            const i = (t.index === undefined) ? 0 : t.index;
            if (!tcs[i]) tcs[i] = { id: '', name: '', args: '' };
            if (t.id) tcs[i].id = t.id;
            if (t.function) {
              if (t.function.name) tcs[i].name += t.function.name;
              if (t.function.arguments) tcs[i].args += t.function.arguments;
            }
          }
        }
      }
      clearTimeout(timer);
    } catch (e) {
      const aborted = (e && e.name === 'AbortError');
      const hv = harvestXmlCalls(text);
      return {
        err: aborted ? 'timeout' : ((e && e.message) || 'call_failed'),
        text: hv.text, reason: reason, tcs: tcs.filter(Boolean).concat(hv.calls),
        ms: Date.now() - t0, firstMs: firstMs, fin: fin, usage: lastUsage,
      };
    }

    /* 正文里写出来的调用也算数：抠出来当真工具跑，文本里不再留标签 */
    const hv = harvestXmlCalls(text);
    return {
      err: null, text: hv.text, reason: reason,
      tcs: tcs.filter(Boolean).concat(hv.calls),
      ms: Date.now() - t0, firstMs: firstMs, fin: fin, usage: lastUsage,
    };
  }

  /* ==========================================================================
   * 诚实检查
   *
   * 光靠提示词管不住模型。实测里 hy3 很乖，但换成别的模型就会编。
   * 这里做两件事，都是代码级硬拦：
   *
   * ① 工具返回 ok:false，模型却说「办好了」→ 换成工具的原话。
   * ② 一个工具都没调，模型却说「打开啦 / 关好啦」→ 这是最隐蔽的演戏。
   *    实测真的撞上了：「带我去趟人民公园」它跳过 open_map 直接说
   *    「地图打开啦，往人民公园走哦～」，而桥根本没被调用。
   *    老人信了，走到门口发现什么都没开。这种必须拦死。
   *
   * 宁可让老人听到一句生硬的真话，也不要听到一句顺口的假话。
   * ======================================================================== */
  const OK_WORDS = /(办好了|办成了|弄好了|搞好了|打过去了|拨出去|已经给|已经帮|开好了|关好了|打开了|关上了|开开|关上|发出去了|设好了|设好啦|记住了|找到了|查到了|收好了|放上|放好|找着)/;
  const FAIL_WORDS = /(没办成|没打成|没打通|没弄好|不行|没法|失败|没找到|没查到|打不开|弄不了|办不了|办不成|没关|没开|没设|没记住|没看|去不了|看不了|拍不了|打不了)/;

  /* 这句话听起来像「真的动了手」吗 —— 用来判断它是不是在无凭据邀功 */
  /* 只认「完成态」的邀功。2026-11-11 去掉了「带您 / 给您放 / 给您开」——
     这三个是提议句式（「要不我给您放段豫剧听听？」），不是「已经做了」。 */
  const ACT_CLAIM = /(打开|关上|关掉|开开|拨出|发出去|放上|设好|找到|记住了|导航|已经|办好|弄好|开好啦|关好啦|放好啦|设好啦)/;

  function guardHonest(text, results, triedTools) {
    if (!text) return text;

    const R = results || [];

    /* ---- ① 只要有一只手没办成，就不许模型自己编结果 ----
       实测两次：工具回 ok:false「米粒的手被系统关了」，模型先说
       「好啦，搜上啦」，改完又说「好啦，放着呢」—— 它换个词就绕过了
       OK_WORDS 正则。提示词和词表都拦不住，只能在内核兜死：
       这一句里有过失败，老人听到的就是失败那只手自己写的人话。
       宁可生硬，不许骗。 */
    const failed = R.filter((r) => r && r.ok === false);
    if (failed.length) {
      /* 用**第一条**失败：多步链路里后面的失败常常是模型自己瞎试出来的
         （真机：「给闺女打电话」失败 → 换名重试 → recall 查记忆 → 说「没记着」），
         拿最后一条等于把最没用的那句念给老人。 */
      return failed[0].detail || '没办成';
    }

    /* ---- ② 压根没调工具，它却在邀功 ---- */
    /* triedTools 表示这一轮到底有没有发生工具调用（不管成败）。
       一个都没调，却说「打开了」，就是凭空编的。 */
    if (!triedTools && !(results || []).length) {
      /* 🚨 2026-11-11 真机实证（菲尔特：「我说我好无聊啊，他说这个还没真动手」）：
         模型原话是「外婆无聊啦？米粒陪您说说话呀。要不我给您放段豫剧听听？」
         —— 这是**提议**，却被 ACT_CLAIM 里的「给您放」抓住，整句被换成
         「这个我还没真动手，您再说一遍，我这就去办」，老人听到的就是答非所问。
         现在：带问号、带征询词的一律不算邀功；「给您放/给您开/带您」这三个
         从词表里去掉 —— 它们本来就是提议句式，不是完成态。 */
      const asking = /[?？]\s*$/.test(String(text).trim()) ||
        /(要不|要不要|想不想|好不好|行不行|好吗|怎么样|陪您|咱们)/.test(text);
      if (!asking && ACT_CLAIM.test(text) && !FAIL_WORDS.test(text)) {
        /* 换一句不打保票的话。不能让老人白跑一趟。 */
        return '这个我还没真动手，您再说一遍，我这就去办。';
      }
    }
    return text;
  }

  /* ==========================================================================
   * 主循环
   * ======================================================================== */

  /* 把历史压成 messages。只带最近几轮，且只带说话内容，不带工具细节 ——
     老人不需要模型记住上一次调了什么工具，只需要记住聊过什么。 */
  function histMessages() {
    /* 三层长期记忆接管：core（常驻画像）+ episodic（增量摘要）+ working（最近原文）。
       systemPrompt 保持完全静态，变化部分全放 messages 尾部，prompt prefix cache 友好。
       context.js 没加载时退回原来的 8 轮内存历史，不硬依赖。 */
    if (window.MILI_CONTEXT && window.MILI_CONTEXT.histMessages) {
      try { return window.MILI_CONTEXT.histMessages(); } catch (e) {}
    }
    const out = [];
    for (const h of _hist.slice(-HIST_MAX)) {
      out.push({ role: h.role, content: h.content });
    }
    return out;
  }

  /* ---- 消息序列消毒（根治 400 的最后防线）----
     每一轮发给 DeepSeek 前过一遍：
     ① assistant(tool_calls) 后面必须紧跟着收齐它全部 tool 回执，
        缺的当场补成「这只手没办成」；
     ② 孤儿 tool 回执（前面没有对应 tool_calls）直接丢；
     ③ 回执没收齐时不许出现 user/assistant —— 补齐再放行。 */
  function sanitizeMessages(ms) {
    const out = [];
    let pending = null; // 还差回执的 tool_call id 列表
    const flush = function () {
      if (!pending) return;
      for (const id of pending) {
        out.push({
          role: 'tool', tool_call_id: id,
          content: JSON.stringify({ ok: false, detail: '这一步被中断了，没办成。' }),
        });
      }
      pending = null;
    };
    for (const m of ms) {
      if (m.role === 'assistant') {
        flush();
        pending = (m.tool_calls && m.tool_calls.length)
          ? m.tool_calls.map((c) => c.id) : null;
        out.push(m);
      } else if (m.role === 'tool') {
        if (pending && pending.indexOf(m.tool_call_id) >= 0) {
          pending = pending.filter((x) => x !== m.tool_call_id);
          out.push(m);
        } /* 孤儿/重复回执 → 丢 */
      } else {
        flush();
        out.push(m);
      }
    }
    flush();
    return out;
  }

  /* 400 后的降级重试：把所有工具对折成一句摘要，历史里不再出现
     tool_calls/tool 结构 —— 无论如何都能被 API 接受。 */
  function collapseToolPairs(ms) {
    const out = [];
    let i = 0;
    while (i < ms.length) {
      const m = ms[i];
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        const names = m.tool_calls
          .map((c) => (c.function && c.function.name) || '?').join('、');
        let oks = 0, fails = 0, j = i + 1;
        while (j < ms.length && ms[j].role === 'tool') {
          try { (JSON.parse(ms[j].content).ok ? oks++ : fails++); } catch (e) { fails++; }
          j++;
        }
        out.push({
          role: 'assistant',
          content: '（我刚才调用了工具：' + names + '。成功 ' + oks + ' 次，失败 ' + fails + ' 次。）',
        });
        i = j;
        continue;
      }
      out.push(m);
      i++;
    }
    return out;
  }

  function pushHist(role, content) {
    if (!content) return;
    const text = String(content).slice(0, 300);
    _hist.push({ role: role, content: text });
    while (_hist.length > HIST_MAX) _hist.shift();
    /* 原文同步进 append-only raw log；压缩由 context.js 按阈值自动触发，
       重启后长期记忆仍在，不再像 _hist 那样一关机就全丢。 */
    if (window.MILI_CONTEXT) { try { window.MILI_CONTEXT.push(role, text); } catch (e) {} }
  }

  /**
   * 想一件事，办一件事，说一句话。
   *
   * opts.onSaid  — 中间过程（比如「我看看啊」），给老人即时反馈
   * opts.quiet   — 不说话，只要结果（自测用）
   * opts.tools   — false 表示这轮只说话不办事（闲聊）
   */
  async function run(userText, opts) {
    _running = true;
    try { return await _runInner(userText, opts); }
    finally { _running = false; try { console.log('[AGENT] done'); } catch (e) {} }
  }
  async function _runInner(userText, opts) {
    try { console.log('[AGENT] begin ' + String(userText || '').slice(0, 40)); } catch (e) {}
    /* 2026-11-10 菲尔特：「执行期间保持安静，不要一直说我办一下」。
       一轮任务只交代第一句（第一个真动作），后面每一步都闭嘴干活。 */
    let saidOnce = false;
    opts = opts || {};
    const T0 = Date.now();
    const text = String(userText || '').trim();
    if (!text) return { ok: false, said: '', err: 'empty' };

    /* 状态可见化第一拍：话音刚落就亮「在想」，别让屏幕停在「在听」装没反应 */
    try { window.__onAgentPhase && window.__onAgentPhase('think'); } catch (e) {}

    if (_busy) {
      /* 上一句还在办。别并行打上去，会被限流，而且老人也不会连说两句。

         但不能无限期地锁着：2026-11-06 实测过一次 run 卡死，
         _busy 永远是 true，从那以后每一句都被判 busy ——
         前端兜底去搜网页，老人听到的就是「它再也不理我」。
         45 秒是「单轮 14 秒 + 几轮工具」的硬上限，过了就当上一句已经作废，
         让他重新开口。宁可并发，也不能哑。 */
      /* 2026-11-10 菲尔特「一直在想…回了一句手上这一件还没弄完」：
         45 秒的锁太长，上一句真卡住时后面每一句都被挡在门外。
         缩到 12 秒（覆盖一次正常工具链），超过就当上一轮作废，重开。 */
      if (Date.now() - _busyAt < 6000) {
        /* 2026-11-07 根治「busy 抢锁」：不再把这句话直接扔掉。
           记下来（只留最新一句），上一句办完自动接着办。
           之前回 err:'busy' 让上层兜底，老人听到的是答非所问；
           现在他听到的就是对自己那句话的回应，只是晚几秒。 */
        _queued = { text: text, opts: opts, at: Date.now() };
        return { ok: false, said: '', err: 'busy', queued: true };
      }
      _busy = false;
      _epoch++;                 // 旧的那一轮作废，它再回来也别写结果
    }
    if (!ready()) {
      return { ok: false, said: '', err: 'no_cloud' };
    }
    _busy = true;
    _busyAt = Date.now();
    const myEpoch = ++_epoch;

    /* 老人这句话是不是在让「办事」。这个判断放在最前面算一次，
       后面「敢不敢边生成边念」「要不要驳回重置」都用它，不重复算。 */
    const userWantsAct = /(关|开|打|拨|发|带|去|看|查|放|设|记|提醒|找|导航|收|调|换)/.test(text);

    const trace = [];
    const results = [];
    let finalText = '';
    let _retries = 0;      /* 「必须调工具」的催促次数，最多 1 次，防空转 */
    /* 2026-11-10 手电筒提速：确定型动作工具自己已经把结果说死了，
       别再让模型多跑一轮生成复述。省的是那一整轮往返，不是抄意图近路。 */
    let fastFinal = '';
    let err = null;
    /* 「跳过工具直接邀功」被抓到时置 true，下一轮必须重新挂工具，
       否则它想调也没得调，只能再说一句「我这就去」。 */
    let _forceTools = false;
    /* 工具失败之后也要把工具挂回去 —— 不然它连补救的机会都没有。 */
    let _retryAfterFail = false;
    /* 400 折叠重试只许用一次 */
    let collapsedOnce = false;
    /* 每个工具连续失败了几次。连败两次就别再让它撞同一面墙。 */
    const _failCount = {};
    /* 这一轮里已经报过的工具词。每轮清空 —— 跨轮不清的话，
       老人第二次说「打开微信」，它就不吭声了，又变成一片安静。 */
    const _saidTool = {};
    /* 这一句话里真动过的手。第 2 轮起只挂它们 + 通用几只（省 6~7K tokens/轮）。 */
    const usedNames = new Set();
    /* 整句话里「工具名+参数」的指纹表。跨轮生效 —— 重复调用会白烧一整轮 tokens，
       真机实证 ui_map 在同一屏连调两次，第二次照样把整屏节点再发一遍。 */
    const _seenSig = {};
    /* 撞上重复调用时，直接拿「第一条真失败」收尾，不再给模型下一轮。
       2026-11-11 真机：「给我闺女打电话」连试两次没这个人，第三次被拦，
       模型没有别的可说，就把拦截回执复述成「这一步刚做过，没变化」——
       老人听到的是答非所问。宁可硬收尾，也不能让它念系统提示。 */
    let dupFinal = '';

    try {
      const messages = [{ role: 'system', content: systemPrompt(text, opts) }]
        .concat(histMessages())
        .concat([{ role: 'user', content: text.slice(0, 300) }]);

      for (let r = 0; r < CFG.maxRounds; r++) {
        if (Date.now() - T0 > CFG.totalTimeout) { err = 'total_timeout'; break; }
        maybeNarrate(r, T0, opts.onSaid);

        /* 第一轮挂工具，让它选；后面几轮不挂 —— 免得它绕进「再调一个」的死循环。
           例外：上一轮被判定「跳过工具直接邀功」，这一轮必须重新挂上，
           否则它想调也没得调，只能说「我这就去」然后什么也没干。
           说结果那轮的 token 预算要放大：思维链和正文共用 max_tokens，
           实测 700 会让正文为空、finish_reason=length，老人一个字都听不到。 */
        /* 每一轮都挂工具。
           以前只在第 0 轮挂，结果是：第一轮调完工具，第二轮手上没工具了，
           DeepSeek 就直接把调用写进正文（实测吐出 `<|DSML|> invoke name="tap_text"`）——
           老人耳朵里听到的就是这堆符号。
           现在一直挂着，靠轮数上限和「同一工具连败两次就封」来控制不乱来。 */
        /* RUN 1 的「先确认一次」：原来是把工具整个摘掉，逼它只能说话。
           2026-11-12 真机实测这条路走不通 —— 摘掉工具后模型退回成通用聊天模型，
           看到「我想看天天耍大牌」直接按版权策略拒答：「我无法提供视频播放」
           「你需要自己查一下版权方」。它不知道自己是个能操作这台手机的助手。
           现在改成：工具照挂（保住能力感），但这一轮只要它张嘴的时候返回了调用，
           全部丢弃（见下面 tcs 分支的 askFirst 拦截）。它问，但动不了手。 */
        const useTools = (opts.tools === false) ? false : (r < CFG.maxRounds - 1);
        /* 第 2 轮起收窄工具集：66 个清单 8K tokens，重发一次就是一次白花钱。
           返回 null 时 turn 会退回全量（工具太少就不冒险）。 */
        /* 动态工具检索：第 0 轮就用 BM25 从 69 个里挑 top-k + 通用工具，
           不再每轮全量注入 8K tokens。RAG-MCP 实测全量 13.62% → 检索 43.13%。
           select() 低置信度会自己退回全量，绝不硬猜；零额外模型回合。 */
        const roundTools = (function () {
          if (r >= 1 && usedNames.size) {
            const sub = toolSubset(usedNames);
            if (sub) return sub;
          }
          if (window.MILI_TOOL_ROUTER) {
            try {
              const sel = window.MILI_TOOL_ROUTER.select(text, {
                used: Array.from(usedNames), recent: Array.from(usedNames).slice(-3)
              });
              if (sel && sel.tools && sel.tools.length) return sel.tools;
            } catch (e) {}
          }
          return null;
        })();
        _forceTools = false;
        _retryAfterFail = false;
        const left = CFG.totalTimeout - (Date.now() - T0);

        /* ---- 这一轮敢不敢边生成边念 ----
           不是所有回合都能开口。两种情况必须憋着：
             ① 前面已经有工具失败过 —— 后面会被 guardHonest 换成真话。
                先念一遍错的、再念一遍对的，老人听两遍还听不出是在纠正，
                只会觉得这机器说话颠三倒四。
             ② 第一轮、还没调过任何工具、而老人原话就是在让办事 ——
                「地图打开啦」这种跳过工具的邀功，下一步就会被驳回重来。
                这一轮先念了，等于先把假话送进老人耳朵。
           其余情况放开：闲聊第一句就能出声，办完事说结果也是边说边出。 */
        const anyFailYet = results.some((x) => x.ok === false);
        const riskyFirst = (r === 0 && results.length === 0 && userWantsAct);
        const liveDelta = (opts.onDelta && !anyFailYet && !riskyFirst) ? opts.onDelta : null;

        const t = await turn(sanitizeMessages(messages), {
          tools: useTools ? (roundTools || undefined) : false,
          /* 2026-11-11 真机实证：同一个句子两次跑，一次 today_info、一次 search_web；
             「打开拼多多搜拖鞋」一次 search_in_app 一次 open_app+ui_map。
             0.55 是为了防复读，代价是路由不稳定 —— 老人眼里就是「有时候乱干」。
             要动工具的轮次压到 0.15（选哪个工具、填什么参数要确定），
             纯说话的最后一轮仍是 0.55（说人话要自然）。 */
          temperature: useTools ? 0.15 : CFG.temperature,
          maxTokens: (r === 0 || useTools) ? CFG.maxTokens : CFG.sayTokens,
          timeout: Math.max(4000, Math.min(CFG.turnTimeout, left)),
          onDelta: liveDelta,
          /* 档位按轮次给（2026-11-06 菲尔特：「回复的时间太慢了」）。
             第 0 轮绝大多数是闲聊 —— 老人十句话八句是闲话，
             这一轮用 high 等于先让它写三百字论文再开口，实测多 1.5~2 秒。
             low 出首字 2.6 秒，high 3.0 秒；差距全在思维链上，
             而「星星为什么挂在天上」这种问题根本不需要推理链。
             真进入办事（第 1 轮起、手上已经有工具调用）才升到 high ——
             点屏幕、找按钮那几步确实需要它想清楚。 */
          /* 11-09：原来第二轮起切 high，模型会先写一大段思维链才开口，
             这是「一句话要等好几秒」最直接的来源。全部压成 low。 */
          effort: 'low',
        });

        trace.push({
          round: r, ms: t.ms, firstMs: t.firstMs, fin: t.fin, err: t.err,
          reason: (t.reason || '').slice(0, 160),
          said: (t.text || '').slice(0, 120),
          calls: (t.tcs || []).map((x) => ({ name: x.name, args: x.args })),
          tok: t.usage ? t.usage.prompt_tokens : 0,
        });
        /* 账本：这一轮到底烧了多少，落盘 + 一行日志 */
        usageLog(t.usage, r + 1);

        if (t.err) {
          /* 400 兜底：消息结构仍被拒收时，把工具对折成摘要再试一次。
             一轮 run 只折一次，别跟 API 死磕。 */
          if (!collapsedOnce && /400|tool/i.test(String(t.err))) {
            collapsedOnce = true;
            messages = collapseToolPairs(messages);
            trace.push({ round: r, note: '400 → 工具对折重试', rawErr: String(t.err).slice(0, 120) });
            continue;
          }
          err = t.err;
          break;
        }

        /* ---- askFirst 第一轮：只当它在问，任何工具调用一律丢弃 ----
           工具挂着是为了让它知道自己有这个本事（不挂它会说「我没法播放」），
           但这一轮绝不能真动手 —— 追问必须是真追问，不能一边问一边把事办了。 */
        if (opts.askFirst && r === 0) {
          if (t.tcs && t.tcs.length) {
            trace[trace.length - 1].ignoredCalls = t.tcs.map(function (x) { return x.name; });
            try { console.log('[ASK] 追问轮丢弃了 ' + t.tcs.length + ' 个调用：' + t.tcs.map(function (x) { return x.name; }).join(',')); } catch (e) {}
          }
          finalText = t.text || '';
          break;
        }

        /* ---- 有工具调用：执行、回填、再来一轮 ---- */
        if (t.tcs && t.tcs.length) {
          const calls = t.tcs.map(function (x, i) {
            return {
              id: x.id || ('call_' + r + '_' + i),
              type: 'function',
              function: { name: x.name, arguments: x.args || '{}' },
            };
          });

          /* assistant 的这条要原样放回去，否则模型不知道自己在上一轮说了什么 */
          /* DeepSeek 思考模式下的 tool loop 要求把该轮 reasoning_content 原样带回，
             否则接口返回 400、结构化 tool_calls 丢失，模型只能把调用写进正文 ——
             harvestXmlCalls 那 70 行正则就是这么来的。这里补回真因。 */
          const _assistantMsg = { role: 'assistant', content: t.text || null, tool_calls: calls };
          if (t.reason) _assistantMsg.reasoning_content = t.reason;
          messages.push(_assistantMsg);

          /* 失败反思提示先攒着，所有回执收齐后再放（根治 400 的另一半） */
          let nudge = null;
          /* 🚨 2026-11-12：模型会并列调好几个平台的 search_in_app（实测一条话里调 4 个：
             爱奇艺/腾讯/优酷/芒果TV）。每一条都真去开 App，老人手机上四个 App 轮流
             弹出来，白等二十秒以上，屏幕上还乱跳。同一轮只放行第一个。 */
          let _searchThisRound = false;
          /* 同一步（工具名 + 参数完全相同）在同一句话里第二次出现就当原地打转。
              2026-11-11 真机实证：「打开拼多多搜拖鞋」连调两次 ui_map，
              同一屏同样的 23 个节点，第二次照样真跑一遍、照样进 messages
              （多花 6,591 tokens），老人看到的就是「一直在想」。
              `_failCount` 只抓失败，抓不住「成功了但重复」—— 这里补上。 */
          for (let k = 0; k < calls.length; k++) {
            const call = calls[k];
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = {}; }

            const sig = call.function.name + '|' + (call.function.arguments || '{}');
            if (_seenSig[sig]) {
              /* 不真执行，只回一句实话：让它换路或者认账，别再空转一轮。 */
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({
                  ok: false,
                  detail: '（这是给你的系统提示，不要念给老人）这一步刚刚已经做过了，结果一模一样。' +
                          '别再重复，换个办法；实在没有别的办法，就把上一条真实结果如实告诉老人。',
                }),
              });
              results.push({ ok: false, detail: '这一步刚做过，没变化。' });
              /* 拿第一条真失败当收尾话术；没有就退一步用最后一条成功的 detail。 */
              const _real = results.filter(function (x) {
                return x && x.detail && !/刚做过|刚刚已经做过/.test(String(x.detail));
              });
              dupFinal = _real.length ? _real[0].detail
                       : (_real.length === 0 && results.length ? results[0].detail : '');
              try { console.log('[TOOL] ' + call.function.name + ' 重复调用已拦截 → 硬收尾'); } catch (e) {}
              continue;
            }
            _seenSig[sig] = 1;

            /* 同一轮只许搜一个平台 —— 见 _searchThisRound 说明 */
            if (call.function.name === 'search_in_app') {
              if (_searchThisRound) {
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    ok: false,
                    detail: '（系统提示，不要念给老人）这一轮已经在搜了，不许同时开第二个 App。' +
                            '先等这一个的结果，没搜到再说。',
                  }),
                });
                results.push({ ok: false, detail: '同一轮重复搜，已跳过。' });
                try { console.log('[TOOL] 并列 search_in_app 已拦截'); } catch (e) {}
                continue;
              }
              _searchThisRound = true;
            }

            /* 状态可见化：执行哪个工具就让屏幕写哪个动作，别让她干瞪眼 */
            try { window.__onAgentPhase && window.__onAgentPhase('doing', call.function.name, args); } catch (e) {}

            /* 🚨 2026-11-10 菲尔特拍板的连续对话规则：闲聊连听，办事静音。
               只有这一轮**真的要动手了**，才通知前端关麦收声。
               之前 app.js 在每句话进模型之前就无条件 callExit('task')，
               连「今天天气好」这种闲聊都把耳朵摘了。 */
            if (k === 0 && opts.onToolBegin) {
              try { opts.onToolBegin(call.function.name); } catch (e) {}
            }

            /* 执行。工具自己负责成败，内核只管把结果如实交回去。

               2026-11-06 加超时，因为踩了一个能把整台手机「弄哑」的坑：
               「我想听戏」→ 调 search_wukong 去打开悟空浏览器，
               那个工具卡在一个永不返回的 await 上（等 App 界面出现，但没等到）。
               于是 run 永远不结束 → _busy 永远 true →
               后面每一句都被判「上一句还在办」，直接返回 busy →
               前端掉到兜底去搜网页，答回来一段字典。
               老人看到的就是：第一句能聊，从此它再也不理人。

               工具卡住不该把整台机器拖死。15 秒没结果就当它没办成，
               如实回一句「没反应」，让它自己想办法换条路。 */
            const res = await Promise.race([
              (function () {
                /* 教学绑定的动作优先：记忆里带 [动作:x] 的，第一个工具强制成它。
                   只在「这句命中了那条教学记忆」时生效，不是全局改路由。 */
                let name0 = call.function.name;
                try {
                  const hint0 = E.memoHints ? (E.memoHints(text) || '') : '';
                  const mb = hint0.match(/\[动作:([a-z_]+)\]/);
                  if (mb && mb[1] && k === 0 && name0 !== mb[1]) {
                    try { console.log('[teach-bind] ' + name0 + ' → ' + mb[1]); } catch (e) {}
                    name0 = mb[1];
                  }
                } catch (e) {}
                return window.MILI_TOOLS.exec(name0, args, E);
              })(),
              new Promise((res2) => setTimeout(
                () => res2({ ok: false, detail: '这一步等了太久没动静，换个办法再试。' }),
                /* 2026-11-10：打开抖音→搜剧→点开→全屏是一长串 UI 自动化，
                   15 秒的统一预算把真在办事的工具拦腰砍断（真机日志实证）。
                   动屏类给 45 秒，其余维持 15 秒。 */
                ['search_in_app','watch_video','play_direct','resume_show','tap_text',
                 'tap_result','tap_at','type_text','find_text','wait_for','swipe_screen']
                  .includes(call.function.name) ? 8000 : 6000)),
            ]);
            results.push(res);
            /* 记下这只手已经用过：下一轮的工具清单只挂它们 + 通用几只。 */
            usedNames.add(call.function.name);
            /* 动过屏幕/换过界面之后，之前的「看屏」结果就作废了 ——
               清空指纹表，否则「滚动后重新 ui_map」这种正当操作会被误拦。 */
            if (/^(tap_|type_|scroll_|swipe_|open_app|go_back|press_|launch|search_in_app|wechat_|play_|player_)/.test(call.function.name)) {
              for (const _k in _seenSig) delete _seenSig[_k];
            }
            /* 2026-11-10：工具结果进 logcat，真机「做不了事」不用再猜。 */
            try { console.log('[TOOL] ' + call.function.name + ' ok=' + res.ok
              + ' ' + String(res.detail || res.why || '').slice(0, 50)); } catch (e) {}

            trace[trace.length - 1].exec = trace[trace.length - 1].exec || [];
            trace[trace.length - 1].exec.push({
              tool: call.function.name, args: args,
              ok: res.ok, detail: res.detail,
              /* 结构化数据原样带上：卡片要显示的是真数据，不是再编一遍 */
              data: res.data || null,
              med: res.med || null,
              medKind: res.kind || null,
              src: res.src || null,
              results: res.results || null,
            });

            /* 有副作用的大事，先给老人一句「在办」，别让他干等。
               2026-11-06：原来只在 k===0 报，第二个工具起就哑了 ——
               老人听到的是「它说了一句，然后一直安静」。
               现在每个工具都报，但同一个词不重复（_saidTool 去重），
               免得连开三个 App 时反复念「我开软件啊」。 */
            /* 快通道工具（手电筒、扫一扫、付款码、微信派单）自己已经把话说死了，
               别再播一遍「我去办一下」，不然老人听到两句几乎一样的话。 */
            const isFast = !!(res && res.ok && res.fastReply);
            if (opts.onSaid && !isFast) {
              const tn = call.function.name;
              if (!saidOnce) {
                const _w = progressWord(tn);
                if (_w) {
                  saidOnce = true;
                  try { opts.onSaid(_w); } catch (e) {}
                }
              }
            }

            /* 回填。这一步是「不演戏」的技术核心：
               模型必须看见 ok:false，它才有机会说实话。 */
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: res.ok,
                detail: res.detail,
                ...(res.src ? { src: res.src } : {}),
              }),
            });

            /* 快通道：手电筒、扫一扫、付款码这类「做没做成一眼可知」的动作，
               工具已经把结果写成老人话了，直接收工，不再发一轮请求。 */
            if (res && res.ok && res.fastReply) {
              fastFinal = String(res.fastReply);
              break;
            }

            /* ---- 失败了怎么办 ----
               以前这里直接 break，外层又不再挂工具，等于「一失败就摊手」。
               现在分两种：
                 第一次失败 → 允许再试，但必须换工具或换参数；
                 同一个工具连败两次 → 封掉它，逼它换路或说实话。
               这不是硬编码业务，是硬编码「不许原地打转」这条纪律。 */
            const nm = call.function.name;
            if (res.ok) {
              _failCount[nm] = 0;
            } else {
              /* 2026-11-07 根治 400「tool_calls must be followed by tool messages」：
                 两处病根，都在这个 else 里——
                 ① 原来 fail 直接 break 跳出工具循环，后面几只手的回执
                    永远没 push，assistant(tool_calls) 就挂着孤儿 → DeepSeek 拒收；
                 ② 反思提示(user) 若在回执中间 push 也会拆散配对。
                 现在都改成：记下来，循环结束后把没收齐的回执补成
                 「这只手没办成」，再统一放反思提示。 */
              const n = (_failCount[nm] = (_failCount[nm] || 0) + 1);
              if (n >= 2) {
                nudge = {
                  role: 'user',
                  content: '「' + nm + '」已经连续失败两次了，别再调它。' +
                    '换一个工具，或者直接告诉老人这条路走不通、可以怎么办。',
                };
              } else {
                nudge = {
                  role: 'user',
                  content: reflectHint(nm, res.detail) +
                    ' 想清楚再说下一步 —— 直接调工具，不用跟我解释。',
                };
                _retryAfterFail = true;
              }
              break;
            }
          }
          /* 循环退出后（含中途 break）：把没回执的工具补成诚实回执，
             配对必须完整，否则下一轮 400。 */
          for (let k2 = 0; k2 < calls.length; k2++) {
            const id2 = calls[k2].id;
            if (!messages.some(function (m) { return m.role === 'tool' && m.tool_call_id === id2; })) {
              messages.push({
                role: 'tool',
                tool_call_id: id2,
                content: JSON.stringify({ ok: false, detail: '这一步没执行（前面出了岔子），没办成。' }),
              });
            }
          }
          if (nudge) { messages.push(nudge); nudge = null; }
          if (fastFinal) { finalText = fastFinal; break; }
          /* 重复调用已经发生：这一句到此为止，直接把真失败说给老人，
             不再花一轮 tokens 让模型自己组织语言（它只会复述系统提示）。 */
          if (dupFinal) { finalText = dupFinal; break; }
          continue;
        }

        /* ---- 没有工具调用：可能是最终回复，也可能是「跳过工具直接邀功」---- */
        const said = t.text || '';

        /* 一次工具都没调过，而这句话明显是在办事 —— 不能认。
           实测撞上过：「带我去趟人民公园」跳过 open_map，直接说
           「地图打开啦，往人民公园走哦～」，桥根本没被调用。
           这种必须逼它真动手，否则老人会被骗到门口。 */
        const noToolYet = (results.length === 0);
        const wantsAct = /(关|开|打|拨|发|带|去|看|查|放|设|记|提醒|找|导航|收|调|换)/.test(text);
        /* 🚨 20:0x 卡死真因：模型把调用写成正文标签时，旧代码每一轮都
           push「你必须真的调工具」再 continue，16 轮 × 单轮 6 秒 →
           通话条一直停在「在说」到 60 秒（菲尔特截图 00:58 实证）。
           现在最多逼一次；第二次还不动手就如实说办不了，立刻收工。 */
        /* 🚨 2026-11-12 修：askFirst 那一轮的追问被这条「逼它动手」吃掉了。
           实测「我要看天天耍大牌」带 askFirst：第一轮说了话（本该是追问），
           含「看」→ 判成「跳过工具直接邀功」→ 逼它第二轮真调工具 →
           老人听到的是「找到《天天耍大牌》了，正给您点开」，一句都没问。
           所以 askFirst 的第一轮必须豁免：它就是只问一句、不动手。 */
        if (noToolYet && wantsAct && _retries < 1 && r < CFG.maxRounds - 1
            && !(opts.askFirst && r === 0)) {
          _retries++;
          trace[trace.length - 1].skipped = true;
          if (said) messages.push({ role: 'assistant', content: said });
          messages.push({
            role: 'user',
            content: '你刚才没调工具就说了结果。这件事必须真的调工具去做。现在就调，别只用嘴说。',
          });
          /* 下一轮要重新挂上工具，否则它想调也没得调 */
          trace[trace.length - 1].retry = true;
          _forceTools = true;
          finalText = '';
          continue;
        }

        finalText = said;
        break;
      }

      /* 兜底：轮数用完了还没说话。
         2026-11-11 真机：通讯录里没有「闺女」，重试两次后被「重复调用」拦住，
         兜底直接把拦截语「这一步刚做过，没变化」念给了老人。
         拦截语是给模型看的，不是给老人听的 —— 优先挑一条真正的失败原因。 */
      if (!finalText && results.length) {
        const real = results.filter(function (x) {
          return x && x.detail && !/刚做过|刚刚已经做过/.test(String(x.detail));
        });
        /* 用**第一条**真实失败，不用最后一条：真机实测「给闺女打电话」三轮
           依次是「通讯录没找到闺女」→「没找到女儿」→「没说是给谁打」，
           拿最后一条等于把最没用的那句念给老人。第一条才是主路径的真原因。 */
        const last = real.length ? real[0] : results[results.length - 1];
        finalText = last.detail || (last.ok ? '办好了' : '没办成');
      }

      /* 兜底：模型偶尔还是会把调用格式写进正文。绝不念给老人听。 */
      finalText = String(finalText || '')
        .replace(/<(?:bs-call-tool|call-tool|tool_call)\s*[^>]*>[\s\S]*?<\/(?:bs-call-tool|call-tool|tool_call)>/g, '')
        .replace(/<\/?(?:bs-call-tool|call-tool|tool_call|parameter|arg_key|arg_value|tool_response)[^>]*>/g, '')
        .replace(/<(?:bs-call-tool|call-tool|tool_call)[\s\S]*$/i, '')
        /* 实测吐出来的是全角竖线：`<｜｜DSML｜｜ calls>`（不是半角 |）。
           所以这里把全角半角都算上，只要看见 DSML 就整段截掉。 */
        .replace(/[<＜]?[|｜]{0,4}\s*DSML[\s\S]*$/i, '')
        .replace(/[<＜]\s*[|｜]{0,4}\s*(tool_calls|invoke|function_calls)[\s\S]*$/i, '')
        .trim();
      finalText = cleanSay(finalText);
      /* 20:0x 卡住兜底：超时 / 调用失败 / 模型只吐标签时 finalText 会是空串，
         前端拿不到 said 就继续等，通话条一直停在「在说」。
         这里无论如何给一句实话收尾，绝不把沉默留给老人。 */
      if (!finalText) {
        /* 2026-11-14：闲聊轮模型偶尔一个字都没吐（思维链吃光 max_tokens）。
           原来一律说「我没听清，您再说一遍？」—— 明明听清了还让老人重复，
           这就是「老是说没听清」的来源。改成不撒谎的接话。 */
        finalText = err ? '这下没办成，您再说一遍？'
                        : (results.length ? '办是去办了，没听着回话。' : '我在呢，您接着说呀。');
      }
      /* triedTools：这一句到底有没有发生过工具调用。没有却在邀功，就要拦。 */
      finalText = guardHonest(finalText, results, results.length > 0);

      /* 说完了。前端那边可能还攥着最后半句（没有句号收尾的那种），
         这里把最终文本交回去，让它把剩的吐干净、把麦克风还回去。
         带的是过完诚实检查的 finalText —— 万一前面念的和最终不一样，
         以这个为准，前端自己决定要不要纠正。 */
      if (opts.onStreamEnd) { try { opts.onStreamEnd(finalText); } catch (e) {} }

      /* 记进会话历史。但只记成功的、而且没调工具的那几轮。
         失败的「办不了」绝不能进历史 —— 实测踩过：
         连着失败几次之后，模型看见历史里全是「这台设备办不了」，
         下一句它干脆不调工具了，直接凭历史编一句「没打开呢」。
         历史污染会把一个会动手的智能体变成一台复读机。

         办成了事的那句也不进历史：实测「问天气」之后紧接着「关电视」，
         模型答的是「电视关上啦，沈阳8度」—— 上一件事的结果被拖着走。
         老人问天气是天气，关电视是关电视，两件事不该串味。
         闲聊才留，因为闲聊需要上下文才接得住。 */
      const anyFail = results.some((x) => x.ok === false);
      if (!anyFail && !results.length) {
        pushHist('user', text);
        if (finalText) pushHist('assistant', finalText);
      }

      _lastTrace = {
        text: text, said: finalText, ms: Date.now() - T0,
        rounds: trace, results: results, err: err,
      };

      return {
        ok: !err && !!finalText,
        said: finalText,
        results: results,
        ms: Date.now() - T0,
        trace: trace,
        err: err,
      };
    } finally {
      _busy = false;
      /* 办完了，把排队的那句接上来。过期 20 秒的不要（老人可能已经换话头了）。
         setTimeout 是防「在 finally 里重入 run」；epoch 机制保证旧轮回来的
         写入全部作废，不会有两轮互相踩。 */
      const q = _queued; _queued = null;
      if (q && Date.now() - q.at < 20000) {
        setTimeout(function () { try { run(q.text, q.opts); } catch (e) {} }, 250);
      }
    }
  }

  /* 办事过程中给老人一句短话，让他知道没死机 */
  function progressWord(tool) {
    const M = {
      call_phone: '我拨号啦。',
      wechat_message: '我发微信啊。',
      wechat_call: '我拨微信啊。',
      wechat_redpacket: '我发红包啊。',
      send_sms: '我发短信啊。',
      ir_power: '我按遥控啊。',
      open_map: '我开地图啊。',
      play_video: '我找片子啊。',
      watch_news: '我开电视啊。',
      get_weather: '我看看天啊。',
      take_photo: '我看看啊。',
      open_app: '我开软件啊。',
      open_url: '我开网页啊。',
      search_web: '我查一下啊。',
      read_screen: '我看看屏幕啊。',
      check_meds: '我看看药箱啊。',
      set_alarm: '我设闹钟啊。',
      remember: '我记下来啊。',
      recall: '我想想啊。',
      pet_toggle: '我动一下啊。',
      add_task: '我记下这件事啊。',
      list_tasks: '我看看还有啥事啊。',
      finish_task: '我划掉这件事啊。',
      ui_map: '我看看这一屏啊。',
      tap_at: '我点一下啊。',
      tap_text: '我点一下啊。',
      swipe_screen: '我翻一下啊。',
      wait_for: '我等等它出来啊。',
      find_text: '我找找啊。',
      press_key: '我按一下键啊。',
      long_press: '我长按一下啊。',
      list_apps: '我翻翻装了啥啊。',
      read_notifications: '我看看谁找我啊。',
      /* 🚫 2026-11-10 菲尔特：「一直说我办一下」——这些是内部观察步骤，
         每步播一句把老人吵死。观察/翻找类一律静默（返回空 = 不出声），
         交代语只留给「真动作」。 */
      look_screen: '',
      screen_text: '',
      ui_map: '',
      find_text: '',
      tap_at: '',
      tap_text: '',
      type_text: '',
      swipe_screen: '',
      press_key: '',
      long_press: '',
      wait_for: '',
      search_web: '',
      torch: '',
      wechat_scan: '',
      wechat_pay_code: '',
      /* 2026-11-10 菲尔特：「执行任务时先交代一句，我去怎么怎么样，稍等啊」。 */
      search_in_app: '我进去找啊，稍等啊。',
      watch_video: '我打开啊，稍等啊。',
      play_direct: '我给您放啊。',
      tv_channel: '我换台啊。',
      scan_pay: '我打开付款码啊。',
      receive_code: '我打开收款码啊。',
      register_hospital: '我去挂号啊，稍等啊。',
      confirm_pending: '好，这就办。',
      log_vital: '我记下这个数啊。',
      grab_redpacket: '我去收红包啊。',
      emergency: '我去叫人！',
    };
    return M[tool] || '我办一下啊。';
  }

  /* 走过去，别让屋里没声音。
     老人看不见「正在思考」，只听得见安静 —— 安静超过几秒他就以为坏了，
     会去按屏幕、会喊人。所以边走边报一句，报的是「还在办」，不是结果。

     2026-11-06：门槛从 7 秒降到 4 秒、从「每 3 轮」改成「每 2 轮」。
     用户原话「回复特别特别慢」—— 慢的感觉大半来自安静，不是真的算得慢。
     实测模型首字 400~800ms，工具一次 1~3 秒，安静 4 秒就该出声了。 */
  const _saidAt = {};
  function maybeNarrate(r, T0, onSaid) {
    /* 2026-11-09 菲尔特：「不要搞其他的声音出来，我是要真的优化」。
       删掉「我还找着呢，您稍等啊」这句中途播报。它不是结果，
       老人一听就以为答完了，接着又来一句，反而更乱。
       onSaid 现在在 app.js 里只更新「在想」胶囊，不出声。 */
    if (!onSaid) return;
    if (r < 1 || r % 2 !== 0) return;
    const key = 'r' + r;
    if (_saidAt[key]) return;
    _saidAt[key] = 1;
    if (Date.now() - T0 < 4000) return;
    try { onSaid(''); } catch (e) {}
  }

  /* 失败之后该想什么。
     以前失败只回一句「换个办法再试」—— 那不是反思，是把球踢回去。
     现在按失败的是哪只手，给出这一手该怎么改，它才真能换到点上。 */
  function reflectHint(tool, detail) {
    const d = String(detail || '').slice(0, 60);
    const M = {
      tap_text: '字找不到，说明这一屏上没有这几个字。下一步用 ui_map 看 ● 的位置，或 look_screen 看图标长什么样。',
      tap_at: '这个位置点空了。可能是页面还没加载完，也可能是位置上没有东西。先 wait_for 等一下，或 ui_map 重新取一次坐标。',
      ui_map: '这一屏读不出来（可能是视频、游戏这类自绘界面）。改用 look_screen 拍下来看。',
      look_screen: '连画面都拿不到，可能是截屏权限没了。改用 ui_map 或 screen_text 读字。',
      wait_for: '等的东西没出现。要么点上一步没点中，要么走错界面了 —— press_key(back) 退回去重看。',
      find_text: '这一屏没这几个字。swipe_screen(down) 往下翻，或者 ui_map 看别处。',
      open_app: '这个软件打不开。list_apps 看看到底装了哪些，名字可能和老人说的不一样。',
      type_text: '打不进去字。先 tap_at 点一下输入框，等光标出来再打。',
      search_wukong: '没搜到。换一个更短的关键词试试，老人说的名字可能带错字。',
      switch_tv: '换台没成。先 press_key(home) 退到桌面，再重新打开电视软件。',
    };
    const tip = M[tool];
    if (tip) return '「' + tool + '」没成（' + (d || '见上') + '）。' + tip;
    return '「' + tool + '」没成（' + (d || '见上') + '）。换个办法：换工具、换参数，但别重复刚才那一下。';
  }

  /* 清洗模型输出：去引号、去动作描写、压长度 */
  function cleanSay(t) {
    if (!t) return '';
    let s = String(t).trim();
    /* 模型爱在开头写「（歪头）」「*点点头*」这种舞台提示，老人听不出动作 */
    s = s.replace(/^[（(][^）)]{1,12}[）)]\s*/g, '');
    s = s.replace(/^\*[^*]{1,12}\*\s*/g, '');
    s = s.replace(/^["「『]/g, '').replace(/["」』]$/g, '');
    /* 自我证明的话一律删掉。老人要听的是「电视关啦」，
       不是「这回真关啦」「确实办成了」—— 那是在替他证明自己没撒谎，
       把注意力挪到「你是不是在骗我」上。
       提示词里已经禁了，但模型偶尔还会犯，代码兜一道。 */
    s = s.replace(/(这回|这次)(是)?(真)?(的)?/g, '');          // 「这回真」「这次是真的」
    s = s.replace(/(确实|真的|的确)(?=办|关|开|设|弄|做|找到|查到)/g, '');  // 「确实办好了」→「办好了」
    s = s.replace(/我(真|确实|绝对)(没|不)(骗|糊弄)(您|你)/g, '');
    s = s.replace(/^(真的|确实)[，,]?/g, '');
    /* 「说得在手机上才行」—— 这是模型把「得」写成「说得」的口播病句。
       实测三遍里出一遍，念出来老人听着别扭。
       只在「说得」后面接方位/情态词时改（在、去、先、用、等、到），
       不碰「说得对」「说得好」「说得清楚」这类正常的补语用法。 */
    s = s.replace(/说得(?=[在去先要用等到的])/g, '得');
    /* 删完会留下「：」「，」「。」孤零零挂在开头，读出来是停顿，很怪 */
    s = s.replace(/^[：:，,。、\s]+/, '');
    s = s.replace(/\s+/g, ' ').trim();
    /* 超过限制就截到最后一个句号，不要半句话 */
    if (s.length > CFG.sayMaxChars) {
      const cut = s.slice(0, CFG.sayMaxChars + 6);
      const m = cut.match(/^[\s\S]*[。！？!?~～]/);
      s = m ? m[0] : cut.slice(0, CFG.sayMaxChars);
    }
    return s;
  }

  /* ==========================================================================
   * 对外
   * ======================================================================== */
  const api = {
    init: init,
    run: run,
    ready: ready,
    model: pickModel,
    busy: () => _busy && (Date.now() - _busyAt < 6000),
    abort: () => { _epoch++; },
    trace: () => _lastTrace,
    /* 验收只读：这一轮实际给了模型哪些工具、长期记忆压缩到什么状态 */
    routeInfo: () => (window.MILI_TOOL_ROUTER ? window.MILI_TOOL_ROUTER.stats() : null),
    contextInfo: () => (window.MILI_CONTEXT ? window.MILI_CONTEXT.stats() : null),
    history: () => _hist.slice(),
    clearHistory: () => { _hist.length = 0; },
    /* 2026-11-10：主动问候和跌落问话不经过 run()，但老人接下来的回答
       必须知道「它刚才说了什么」，否则他回「戏曲」，模型一头雾水。
       这里只写历史，不触发生成。 */
    note: (role, content) => pushHist(role, content),
    agentBusy: agentBusy,
    systemPrompt: systemPrompt,
    /* 今天的 token 账本（calls / input / hit / miss / output），自测和界面都能读 */
    usageToday: usageToday,
    CFG: CFG,
    /* 现场换组委会发的额度：setLLM({base,model,key})，落 localStorage 立即生效 */
    setLLM: setLLM,
    llmInfo: llmInfo,
    llmPresets: () => JSON.parse(JSON.stringify(LLM_PRESETS)),
    dsRoute: dsRoute,
    /* 看图：直接走 deepseek-flash 自己。
       它 input_modalities 是 ["text","image"]，官方 API 实测收 image_url，
       所以不需要再绕道云 SDK 去挑一个 supportsImages 的模型 —— 一条路，一个脑子。
       b64 是纯 base64（不带 data: 前缀），mime 默认 jpeg。 */
    vision: async function (b64, question, o) {
      o = o || {};
      const t0 = Date.now();
      /* 2026-11-12：看图也走主备。主路（无限卡）对复杂图会把预算全给思维链、
         正文空着回来，这种也算失败 —— 直接换官方重试一次。 */
      const vbody = (model) => JSON.stringify({
          model: model,
          stream: false,
          temperature: o.temperature === undefined ? 0.1 : o.temperature,
          /* 2026-11-07 实测：视觉请求如果 max_tokens 给小了，思考链会把预算吃光，
             content 回来是空字符串 —— 看起来像「模型不认图」，其实是没给它说话的钱。
             药盒这种活必须留足 800。 */
          max_tokens: o.maxTokens || 800,
          /* 认图不需要深思，关掉思考链：又快又不会把答案挤掉 */
          thinking: { type: o.think === true ? 'enabled' : 'disabled' },
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:' + (o.mime || 'image/jpeg') + ';base64,' + String(b64 || '') } },
              { type: 'text', text: String(question || '这张图里是什么？') },
            ],
          }],
        });
      const vcall = (cfg) => fetch(cfg.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
        body: vbody(cfg.model),
      });
      let r = await vcall(DS);
      if (!r.ok && DS.backup) {
        try { console.log('[DS] 看图主路挂了(' + r.status + ')，切官方备路'); } catch (e) {}
        _dsRoute = 'backup';
        r = await vcall(DS.backup);
      }
      if (!r.ok) {
        let t = '';
        try { t = await r.text(); } catch (e) {}
        throw new Error('vision ' + r.status + ' ' + String(t).slice(0, 120));
      }
      const j = await r.json();
      /* 2026-11-12：看图这条一直没记账 —— 它不走 turn()，账单上完全看不见。
         实测一张 720×1600 的图 778 tokens，看着不多，但老人一天问十几次屏、
         真要排查花销时会变成瞎区。这里补上。 */
      try {
        usageLog(j && j.usage, 1);
        if (j && j.usage) {
          console.log('MILI_USAGE-VISION in=' + (j.usage.prompt_tokens || 0) +
            ' out=' + (j.usage.completion_tokens || 0));
        }
      } catch (e) {}
      const m = j && j.choices && j.choices[0] && j.choices[0].message;
      return {
        text: String((m && m.content) || '').trim(),
        reason: String((m && m.reasoning_content) || ''),
        ms: Date.now() - t0,
      };
    },
    /* 预热（2026-11-12 菲尔特：「打电话第一句话回话太慢」）。
       首句慢有一大截不在模型上，在 DNS + TCP + TLS 上 —— 手机刚亮屏、
       射频刚从休眠爬起来，一次握手能吃掉三四百毫秒，而这段是纯空转。
       通话一开就发一个只要 1 个 token 的极小请求把连接焐热，
       fetch 的 keep-alive 会把这条连接留给紧接着那次真正的请求。
       一分钟内只做一次；不挂定时器、不常驻，不为了快而白烧钱。 */
    prewarm: function () {
      const now = Date.now();
      if (now - (api.__pwAt || 0) < 60000) return Promise.resolve(false);
      api.__pwAt = now;
      try {
        return fetch(DS.base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS.key },
          body: JSON.stringify({
            model: DS.model,
            messages: [{ role: 'user', content: '在' }],
            max_tokens: 1,
            stream: false,
          }),
        }).then(function (r) { return !!r.ok; }).catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    },
    /* 自测用：只问一句，不碰工具执行、不落历史。
       返回必须把 tcs / firstMs / fin 都带出来，否则探针看到的是假象
       （之前就漏了 tcs，测出「工具没被选中」，其实选了）。 */
    ask: async function (q, o) {
      o = o || {};
      const t = await turn(
        [{ role: 'system', content: systemPrompt() }, { role: 'user', content: String(q) }],
        {
          tools: o.tools === true,
          maxTokens: o.maxTokens || CFG.maxTokens,
          effort: o.effort || null,
          temperature: o.temperature,
        }
      );
      return {
        text: cleanSay(t.text), raw: t.text, err: t.err, ms: t.ms,
        firstMs: t.firstMs, fin: t.fin, reason: t.reason,
        tcs: (t.tcs || []).map(function (x) { return { name: x.name, args: x.args }; }),
      };
    },
  };

  window.MILI_AGENT = api;
})();
