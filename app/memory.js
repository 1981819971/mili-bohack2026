/* ============================================================================
 * app/memory.js — 米粒统一记忆总线
 *
 * 为什么有这个文件：
 *   之前 MILI_MEMO / MILI_RHYTHM / EVO 各写各的 localStorage key，
 *   各有各的 reset()，「一键清空」只清了其中一套，另外两套原封不动。
 *   这里把所有记忆模块登记到一条总线上，清空只留一个入口。
 *
 * 借鉴的架构模式（只抄思想，不引依赖）：
 *   mem0 2026-04「single-pass ADD-only」—— 写入只追加，冲突不原地改；
 *   Graphiti「validity window」—— 作废打失效戳、不物理删除、可追溯。
 *   这两条在 agent-memo.js 的 facts / skills 集合里落地。
 *
 * 依赖：无。必须在 agent-memo.js、evolve.js、app.js 之前加载。
 * 可在 Node vm 里直接跑（window 不存在时退到 globalThis + 内存 storage）。
 * ========================================================================== */
(function (w) {
  'use strict';

  var BUS_KEY = 'mili.memory.bus';
  var SCHEMA = 2;

  var LS = (function () {
    try { if (w.localStorage) return w.localStorage; } catch (e) {}
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  })();

  var modules = {};
  var bus = loadBus();

  function loadBus() {
    try {
      var o = JSON.parse(LS.getItem(BUS_KEY) || 'null');
      if (o && o.v === SCHEMA) return o;
    } catch (e) {}
    return { v: SCHEMA, clearedAt: 0, writeFailed: false, deletedSkills: {} };
  }

  function persist() {
    try { LS.setItem(BUS_KEY, JSON.stringify(bus)); bus.writeFailed = false; return true; }
    catch (e) { bus.writeFailed = true; return false; }
  }

  /** 统一写入口。任何模块都不许再自己 try{...}catch(e){} 吞掉写入失败。 */
  function put(key, value) {
    try {
      LS.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      bus.writeFailed = false;
      return true;
    } catch (e) { bus.writeFailed = true; return false; }
  }
  function get(key) { try { return LS.getItem(key); } catch (e) { return null; } }
  function drop(key) { try { LS.removeItem(key); } catch (e) {} }

  /** 本地日期。禁止 toISOString()：那是 UTC，北京时间 08:00 前会串到昨天。 */
  function localDay(ts) {
    var d = ts instanceof Date ? ts : new Date(ts === undefined ? Date.now() : ts);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /** 登记一个记忆模块：mod = { keys: string[], wipe: function } */
  function register(name, mod) {
    if (!name || !mod || typeof mod.wipe !== 'function') return false;
    modules[name] = { keys: Array.isArray(mod.keys) ? mod.keys.slice() : [], wipe: mod.wipe };
    return true;
  }

  /**
   * 唯一的一键清空入口。
   *   ① 让每个模块先清自己的内存态 —— 否则下一次 persist 会把旧数据写回来
   *   ② 物理删除所有登记 key + 历史遗留 key
   *   ③ 留下 clearedAt 墓碑，模块据此拒绝复活内置项
   */
  function clearAll() {
    var names = Object.keys(modules);
    for (var i = 0; i < names.length; i++) {
      try { modules[names[i]].wipe(); } catch (e) {}
    }
    var keys = {};
    names.forEach(function (n) { modules[n].keys.forEach(function (k) { keys[k] = 1; }); });
    ['mili_agent_memo', 'mili_demo_agent', 'mili.rhythm', 'mili_evo', 'mili_demo_evo',
     'mili.memory.v2', 'mili.memory.v2_demo'].forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(drop);
    bus.clearedAt = Date.now();
    bus.deletedSkills = {};
    persist();
    return { ok: true, modules: names, at: bus.clearedAt, writeOk: !bus.writeFailed };
  }

  function clearedAt() { return bus.clearedAt || 0; }
  function writeOk() { return !bus.writeFailed; }
  function markDeletedSkill(id) { if (id) { bus.deletedSkills[id] = 1; persist(); } }
  function wasDeletedSkill(id) { return !!(id && bus.deletedSkills[id]); }

  w.MILI_STORE = {
    version: SCHEMA,
    register: register,
    clearAll: clearAll,
    clearedAt: clearedAt,
    localDay: localDay,
    put: put,
    get: get,
    drop: drop,
    writeOk: writeOk,
    markDeletedSkill: markDeletedSkill,
    wasDeletedSkill: wasDeletedSkill,
    _modules: function () { return Object.keys(modules); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
