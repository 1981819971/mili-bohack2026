/* ============================================================================
 * 米粒的记忆 —— 三类事实 + skill 复用
 *
 * 之前的 evolve.js 只学「词」：老人说「把电视给我关喽」学会了 → 记一条别名映射。
 * 下次换个说法（「电视关了」）就不认得。它学的是词形，不是事情。
 *
 * 这里换成分两类：
 *   memo   —— 事实/偏好/事件。老人说「我女儿叫小芳」就记下，下次能答。
 *   skill  —— 办成一件事的**成功工具序列**。同一句话再出现，0ms 重放，不再想。
 *
 * skill 是「第一次慢、下次快」真正落地的地方：
 *   第一次：「把电视给我关喽」→ hy3 想 1.6s → ir_power({device:'电视',on:false}) → ok
 *   第二次：同样的话 → 0ms 命中 skill → 直接执行 → ok
 *   这样「学会」是看得见的：耗时可测地从 1600ms 掉到 0ms，而且是同一件事真的办成了。
 *
 * 只记成功序列。失败的不记 —— 记住了失败的序列，下次还会失败。
 * ========================================================================== */
(function () {
  'use strict';

  const MEMO_MAX = 60;      // 事实最多 60 条
  const SKILL_MAX = 40;     // skill 最多 40 条
  /* 办成一次就该记住。
     之前定 2 次才升格，理由是「怕记错」—— 但「记错」的代价是可回滚的
     （重放失败就退回 agent 重想），而「记不住」的代价是老人每次都要等 2 秒。
     实测老人同一句话一天说好几遍，第一次就该快。 */
  const SKILL_MIN_HIT = 1;

  /* 🚨 2026-11-10 22:03 菲尔特最终拍板：
     「经验卡都可以留下，并且装入 APK 没关系」—— 经验卡算**能力**，随 APK 分发。
     但「数据」（称呼 / 同步码 / 联系人 / 账号 / 声纹）仍然一律不进包，
     亲友装上自己填。所以这里放的是本机学到的 5 条动作序列，不含任何号码/凭证。
     其中两条是老人抱怨被误当成指令记下的（会乱关桌宠、乱打视频），
     按「都可以留下」留档，但 on:false 停用，别在亲友机上误触发。 */
  const DEFAULT_SKILLS = [
    { k: '抖音打开天天耍大牌然后全屏', text: '抖音打开天天耍大牌，然后全屏',
      tools: [{ name: 'search_in_app', args: { app: '抖音', keyword: '天天耍大牌' } }],
      n: 1, on: true, ms: 0, id: 'builtin_douyin_tt' },
    { k: '给女儿打视频', text: '给女儿打视频',
      tools: [{ name: 'wechat_call', args: { who: '女儿', kind: 'video' } }],
      n: 1, on: true, ms: 0, id: 'builtin_wx_video_1' },
    { k: '给女儿打个视频', text: '给女儿打个视频',
      tools: [{ name: 'wechat_call', args: { who: '女儿', kind: 'video' } }],
      n: 1, on: true, ms: 0, id: 'builtin_wx_video_2' },
    { k: '而且当他说话的时候他的这个条会挡住', text: '而且当他说话的时候他的这个条会挡住',
      tools: [{ name: 'pet_toggle', args: { on: false } }],
      n: 1, on: false, ms: 0, id: 'builtin_mislearned_1' },
    { k: '微信这条路它怎么又做不好了吗之前不都是修', text: '微信这条路它怎么又做不好了吗之前不都是修',
      tools: [{ name: 'wechat_call', args: { who: '女儿', kind: 'video' } }],
      n: 1, on: false, ms: 0, id: 'builtin_mislearned_2' },
  ];

  let ST = null;            // {memo:[], skill:[], cnt:{}}
  let KEY = 'mili_agent_memo';

  /* 惰性初始化。之前只有 load() 会建 ST，别的接口在 load 之前被调用
     就会 TypeError（探针真的撞上了）。记忆是底层设施，任何入口
     都得能自己站起来，不能指望调用方记得先 load。 */
  function ensure() {
    if (!ST) load();
    return ST;
  }

  function load(storeKey) {
    if (storeKey) KEY = storeKey + '_agent';
    try { ST = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { ST = null; }
    if (!ST || typeof ST !== 'object') ST = { memo: [], skill: [], cnt: {} };
    if (!Array.isArray(ST.memo)) ST.memo = [];
    if (!Array.isArray(ST.skill)) ST.skill = [];
    if (!ST.cnt || typeof ST.cnt !== 'object') ST.cnt = {};
    mergeDefaults(DEFAULT_SKILLS);
    return ST;
  }

  function save() {
    ensure();
    try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch (e) {}
  }

  /* ---------- 文本归一化 ----------
     比 evolve.js 的 norm 保守一点：只去语气词和标点，不动实词。
     动实词会把「关」和「开」都归一掉，那是灾难。 */
  function norm(t) {
    return String(t || '')
      .replace(/[，。？！、,.?!~～\s]/g, '')
      .replace(/^(哎|诶|那个|这个|我说|你看|你就|麻烦|帮我|给我|劳驾)+/, '')
      .replace(/(啊|呀|哦|啦|呢|吧|呗|嘛|喽|嘞|哟)+$/g, '')
      .toLowerCase();
  }

  /* ==========================================================================
   * 一、事实记忆
   * ======================================================================== */

  /* 加一条。同一条重复说，就累加次数，不重复存。 */
  function memoAdd(kind, text, src) {
    ensure();
    const t = String(text || '').trim();
    if (!t || t.length < 2) return null;
    const k = norm(t);
    if (!k) return null;
    let hit = ST.memo.find((m) => m.k === k);
    if (hit) {
      hit.n = (hit.n || 1) + 1;
      hit.at = Date.now();
      save();
      return hit;
    }
    const rec = {
      k: k, kind: kind || 'fact', text: t,
      src: src || '', n: 1, at: Date.now(),
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    };
    ST.memo.unshift(rec);
    while (ST.memo.length > MEMO_MAX) ST.memo.pop();
    save();
    return rec;
  }

  /* 找。先按归一化包含匹配，再按字面包含。 */
  function memoFind(q) {
    ensure();
    const s = String(q || '').trim();
    if (!s) return [];
    const nq = norm(s);
    const out = [];
    for (const m of ST.memo) {
      if (!m || !m.text) continue;
      if (m.k && nq && (m.k.indexOf(nq) >= 0 || nq.indexOf(m.k) >= 0)) { out.push(m); continue; }
      /* 关键词散着命中的也算：老人问「我闺女叫啥」时，
         记的那条是「我女儿叫小芳」，字面不完全一样，靠拆词 */
      const parts = s.replace(/[，。？！、,.?!\s]/g, '').match(/[\u4e00-\u9fa5]{2,}/g) || [];
      for (const p of parts) {
        if (m.text.indexOf(p) >= 0) { out.push(m); break; }
      }
    }
    /* 事件类优先给最近的 */
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out;
  }

  function memoByKind(kind) {
    ensure();
    return ST.memo.filter((m) => m.kind === kind);
  }

  function memoDel(id) {
    ensure();
    const i = ST.memo.findIndex((m) => m.id === id);
    if (i < 0) return false;
    ST.memo.splice(i, 1);
    save();
    return true;
  }

  /* 给提示词用的摘要。只带最近几条，别把上下文撑爆。 */
  function memoBrief(limit) {
    ensure();
    const n = limit || 6;
    if (!ST.memo.length) return '';
    const tag = { fact: '事实', preference: '喜好', event: '要办的事' };
    return ST.memo.slice(0, n).map(function (m) {
      return '·[' + (tag[m.kind] || '事实') + '] ' + m.text;
    }).join('\n');
  }

  /* ==========================================================================
   * 二、skill 复用 —— 「下次快」落地的地方
   *
   * 一条 skill = 一句老人原话 + 一串成功办过的工具调用。
   * 触发条件比 memo 严：必须归一化后完全相同，才敢直接重放。
   * 差一个字都可能意思相反（「开电视」/「关电视」），不能模糊。
   * ======================================================================== */

  function skillKey(text) { return norm(text); }

  /* 记一次成功的执行序列。tools = [{name, args}, ...] */
  function skillNote(text, tools) {
    ensure();
    if (!tools || !tools.length) return null;
    const k = skillKey(text);
    if (!k || k.length < 2) return null;

    let s = ST.skill.find((x) => x.k === k);
    if (s) {
      s.n = (s.n || 1) + 1;
      s.at = Date.now();
      /* 说法次数够多、而且这次序列跟上次一致，才升格为可重放 */
      if (s.n >= SKILL_MIN_HIT) s.on = true;
      save();
      return s;
    }

    const rec = {
      k: k, text: String(text).slice(0, 60),
      tools: tools.map(function (t) { return { name: t.name, args: t.args || {} }; }),
      n: 1, at: Date.now(),
      /* 新记录也必须过升格判断。
         这里之前写死 on:false —— 注释写着「办成一次就该记住」，
         代码却是第一次永远记不住，得等老人说第二遍才生效。
         真机实测：同一条 skill 的 n 停在 1，skillReady 永远是 0，
         「第一次慢、下次快」在产品里一次都没兑现过。 */
      on: SKILL_MIN_HIT <= 1,
      ms: 0,
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    };
    ST.skill.unshift(rec);
    while (ST.skill.length > SKILL_MAX) ST.skill.pop();
    save();
    return rec;
  }

  /* 找一条能直接重放的 */
  function skillFind(text) {
    ensure();
    const k = skillKey(text);
    if (!k) return null;
    const s = ST.skill.find((x) => x.k === k && x.on);
    return s || null;
  }

  /* 记这次的耗时，用来在界面上显示「1600ms → 0ms」 */
  function skillCost(text, ms) {
    ensure();
    const k = skillKey(text);
    const s = ST.skill.find((x) => x.k === k);
    if (!s) return;
    s.ms = ms;
    save();
  }

  function skillList() { ensure(); return ST.skill.slice(); }

  function skillDel(id) {
    ensure();
    const i = ST.skill.findIndex((s) => s.id === id);
    if (i < 0) return false;
    ST.skill.splice(i, 1);
    save();
    return true;
  }

  /** 只补本机没有的，绝不覆盖本机后来学到的。给出厂内置和同步码拉回共用。 */
  function mergeDefaults(list) {
    ensure();
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const s of list) {
      if (!s || !s.k || !Array.isArray(s.tools) || !s.tools.length) continue;
      const i = ST.skill.findIndex((x) => x.k === s.k);
      if (i >= 0) { if (!ST.skill[i].on && s.on !== false) ST.skill[i].on = true; continue; }
      ST.skill.push({
        k: s.k, text: s.text || s.k,
        tools: s.tools.map((t) => ({ name: t.name, args: t.args || {} })),
        n: 1, at: Date.now(), on: s.on !== false, ms: 0,
        id: s.id || ('builtin_' + Date.now().toString(36)),
      });
      added++;
    }
    while (ST.skill.length > SKILL_MAX) ST.skill.pop();
    if (added) save();
    return added;
  }

  function skillOn(id, on) {
    ensure();
    const s = ST.skill.find((x) => x.id === id);
    if (!s) return false;
    s.on = !!on;
    save();
    return true;
  }

  /* ==========================================================================
   * 三、计数（「这句问第三回了」那种）
   * ======================================================================== */

  function bump(text) {
    ensure();
    const k = skillKey(text);
    if (!k) return 0;
    ST.cnt[k] = (ST.cnt[k] || 0) + 1;
    /* 别让计数表无限长 */
    const ks = Object.keys(ST.cnt);
    if (ks.length > 200) {
      ks.sort((a, b) => ST.cnt[a] - ST.cnt[b]);
      for (let i = 0; i < 40; i++) delete ST.cnt[ks[i]];
    }
    save();
    return ST.cnt[k];
  }

  function countOf(text) { ensure(); return ST.cnt[skillKey(text)] || 0; }

  /* ==========================================================================
   * 对外
   * ======================================================================== */
  window.MILI_MEMO = {
    load: load,
    save: save,
    norm: norm,

    /* 事实 */
    add: memoAdd,
    find: memoFind,
    byKind: memoByKind,
    del: memoDel,
    brief: memoBrief,
    memo: () => ensure().memo.slice(),
    memoCount: () => ensure().memo.length,

    /* skill */
    note: skillNote,
    hit: skillFind,
    cost: skillCost,
    skills: skillList,
    skillDel: skillDel,
    skillOn: skillOn,
    mergeDefaults: mergeDefaults,
    skillCount: () => ensure().skill.length,
    skillReady: () => ensure().skill.filter((s) => s.on).length,

    /* 计数 */
    bump: bump,
    count: countOf,

    /* 自测/演示 */
    raw: () => ensure(),
    reset: () => { ST = { memo: [], skill: [], cnt: {} }; save(); },
  };
})();
