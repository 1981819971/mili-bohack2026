import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const read = name => fs.readFileSync(path.join(APP, name), 'utf8').replace(/\r\n/g, '\n');

function response(text = '我在呢，您接着说呀。', call) {
  const delta = call ? { tool_calls: [{ index: 0, id: 'test-call', type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: text };
  const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta, index: 0, finish_reason: null }] }) +
    '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  let sent = false;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
    if (sent) return { done: true }; sent = true; return { done: false, value: bytes };
  } }) } };
}

function env(shared = new Map()) {
  const controls = { fail: new Set(), failRemove: new Set(), fetch: null, memory: () => ({ facts: [], events: [], intent: null, question: '' }) };
  const requests = [];
  const memoryRequests = [];
  const s = { Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, TextDecoder, TextEncoder, URL, performance,
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: k => shared.get(k) ?? null,
      setItem: (k, v) => { if (controls.fail.has(k)) throw Error('QuotaExceededError'); shared.set(k, String(v)); },
      removeItem: k => { if (controls.failRemove.has(k)) throw Error('Denied'); shared.delete(k); },
    },
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      if (request.messages[0]?.content?.startsWith('你是米粒的记忆整理器')) {
        memoryRequests.push(request);
        return response(JSON.stringify(await controls.memory(JSON.parse(request.messages[1].content))));
      }
      requests.push(request); return controls.fetch ? controls.fetch(request) : response();
    },
    document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [], getElementById: () => null, documentElement: { className: '' }, hidden: false },
    navigator: {}, location: { href: 'file:///index.html' },
  };
  s.window = s; s.globalThis = s;
  vm.createContext(s);
  for (const name of ['memory.js', 'context.js', 'agent-memo.js', 'semantic-memory.js', 'agent-tools.js', 'tool-router.js', 'agent.js']) vm.runInContext(read(name), s, { filename: name });
  s.MILI_AGENT.init({ memoAdd: (kind, text, meta) => s.MILI_MEMO.add(kind, text, 'test', meta),
    memoFind: q => s.MILI_CONTEXT.recall(q), native: () => null });
  return { s, controls, requests, memoryRequests, data: shared };
}

function meaning(text, evidence, key = 'user.preference', extra = {}) {
  return { facts: [{ text, evidence, key, kind: 'fact', confidence: 0.96, uncertain: false,
    durable: true, asserted: true, entities: [], ...extra }], events: [], intent: null, question: '' };
}

test('普通与精简闲聊的真实模型请求都包含相关长期事实、画像和独立的当前问句', async () => {
  for (const lite of [false, true]) {
    const { s, requests } = env();
    s.MILI_MEMO.add('fact', '我女儿叫小芳', 'test');
    s.MILI_CONTEXT.push('user', '我女儿叫小芳');
    for (let i = 0; i < 30; i++) s.MILI_CONTEXT.push('user', '早上七点吃药，第' + i + '天');
    const result = await s.MILI_AGENT.run('我女儿叫什么名字', { tools: false, lite });
    assert.equal(result.err, null);
    const messages = requests[0].messages;
    assert.ok(messages.some(m => m.content?.includes('小芳')));
    assert.ok(messages.some(m => m.content?.includes('老人画像')));
    assert.equal(messages.at(-1).content, '我女儿叫什么名字');
    assert.ok(messages.length <= (lite ? 5 : 11));
  }
});

test('历史原文在多次压缩及重启后仍可检索，助手猜测不能成为事实证据', () => {
  const { s, data } = env();
  const C = s.MILI_CONTEXT;
  C.push('user', '我女儿叫小芳，她在天津上班');
  C.push('assistant', '您孙子叫小明。');
  for (let i = 0; i < 130; i++) C.push('user', '今天去医院拿药，第' + i + '次');
  const reboot = env(data).s.MILI_CONTEXT;
  assert.ok(reboot.recall('女儿叫什么名字').some(m => m.text.includes('小芳')));
  assert.equal(reboot.recall('孙子叫什么名字').length, 0);
});

test('事实更正一次提交：旧值失效、新值有效，画像及历史都不能复活旧值', () => {
  const { s } = env(); const M = s.MILI_MEMO, C = s.MILI_CONTEXT;
  const old = M.add('fact', '我女儿叫小芳', 'test', { key: 'daughter.name' });
  C.push('user', '我女儿叫小芳'); C.push('assistant', '小芳，我记着啦。');
  const updated = M.add('fact', '我女儿叫小红', 'test', { key: 'daughter.name', replaces: old.id });
  assert.ok(updated);
  assert.equal(M.memoCount(), 1);
  assert.equal(M.history().facts.find(m => m.id === old.id).supersededBy, updated.id);
  assert.ok(C.histMessages('我女儿叫什么名字').some(m => m.content.includes('小红')));
  assert.ok(!C.histMessages('我女儿叫什么名字').some(m => m.content.includes('小芳')));
});

test('事实单条删除会从工作窗口、画像和历史检索中同时排除', () => {
  const { s } = env(); const M = s.MILI_MEMO, C = s.MILI_CONTEXT;
  const fact = M.add('fact', '我女儿叫小芳', 'test');
  C.push('user', fact.text); C.push('assistant', '小芳，我记着啦。');
  C.compileCore(); M.del(fact.id);
  assert.equal(C.recall('女儿叫什么名字').length, 0);
  assert.ok(!C.histMessages('女儿叫什么名字').some(m => m.content.includes('小芳')));
});

test('事实及更正写盘失败时回滚内存，不会把未保存内容说成记住了', async () => {
  const { s, controls } = env(); const M = s.MILI_MEMO;
  const old = M.add('fact', '我女儿叫小芳', 'test', { key: 'daughter.name' });
  controls.fail.add('mili.memory.v2');
  assert.equal(M.add('fact', '我女儿叫小红', 'test', { key: 'daughter.name' }), null);
  assert.equal(M.memo()[0].id, old.id);
  assert.equal(M.history().facts.length, 1);
  const result = await s.MILI_TOOLS.exec('remember', { fact: '我喜欢喝花茶', kind: 'preference' }, {
    memoAdd: (kind, text, meta) => M.add(kind, text, 'test', meta),
  });
  assert.equal(result.ok, false);
});

test('一个 key 写失败，其他 key 的成功写入不能抹掉错误状态', () => {
  const { s, controls } = env(); controls.fail.add('broken');
  assert.equal(s.MILI_STORE.put('broken', 'x'), false);
  s.MILI_STORE.put('healthy', 'y');
  assert.equal(s.MILI_STORE.writeOk(), false);
  assert.equal(s.MILI_CONTEXT.stats().writeOk, false);
  controls.fail.clear(); s.MILI_STORE.put('broken', 'fixed');
  assert.equal(s.MILI_STORE.writeOk(), true);
});

test('技能更换序列写失败时保留旧版本；调用者改参数不会偷偷改变持久化技能', () => {
  const { s, controls } = env(); const M = s.MILI_MEMO;
  const tools = [{ name: 'ir_power', args: { on: true } }];
  M.note('打开电视', tools); tools[0].args.on = false;
  const hit = M.hit('打开电视'); hit.tools[0].args.on = false;
  assert.equal(M.hit('打开电视').tools[0].args.on, true);
  controls.fail.add('mili.memory.v2');
  assert.equal(M.note('打开电视', [{ name: 'open_app', args: { app: '电视' } }]), null);
  assert.equal(M.hit('打开电视').tools[0].name, 'ir_power');
  assert.equal(M.history().skills.length, 1);
});

test('新观看事件按结构键替换，过期事件不参与召回', () => {
  const { s } = env(); const M = s.MILI_MEMO;
  M.add('event', '上次看的是《西游记》', 'test', { key: 'video.last_title' });
  M.add('event', '上次看的是《红楼梦》', 'test', { key: 'video.last_title' });
  assert.equal(M.memoCount(), 1);
  M.add('event', '今天下午三点去医院', 'test', { expiresAt: Date.now() - 1000 });
  assert.equal(M.find('下午三点去医院').length, 0);
});

test('演示空间的事实、聊天、画像和路由样本不读取产品空间', () => {
  const { s } = env();
  s.MILI_MEMO.load('mili'); s.MILI_MEMO.add('fact', '我女儿叫小芳');
  s.MILI_CONTEXT.push('user', '我女儿叫小芳');
  s.MILI_CONTEXT.setCore('产品专属画像');
  s.MILI_TOOL_ROUTER.learn('打开我的电视', 'ir_power');
  s.MILI_MEMO.load('mili_demo'); s.MILI_CONTEXT.configure('mili_demo'); s.MILI_TOOL_ROUTER.configure('mili_demo');
  assert.equal(s.MILI_MEMO.memoCount(), 0);
  assert.equal(s.MILI_CONTEXT.stats().raw, 0);
  assert.equal(s.MILI_CONTEXT.core(), '');
  assert.equal(s.MILI_TOOL_ROUTER.stats().corrections, 0);
  s.MILI_MEMO.load('mili'); s.MILI_CONTEXT.configure('mili'); s.MILI_TOOL_ROUTER.configure('mili');
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  assert.equal(s.MILI_CONTEXT.stats().raw, 1);
  assert.equal(s.MILI_TOOL_ROUTER.stats().corrections, 1);
});

test('路由样本写失败不累加成功次数，删除技能会同时撤销其路由样本', () => {
  const { s, controls } = env(); const R = s.MILI_TOOL_ROUTER, M = s.MILI_MEMO;
  controls.fail.add('mili.tool.corrections');
  assert.equal(R.learn('打开电视', 'ir_power'), false);
  assert.equal(R.stats().corrections, 0);
  controls.fail.clear(); R.learn('打开电视', 'ir_power');
  const skill = M.note('打开电视', [{ name: 'ir_power', args: { on: true } }]);
  assert.equal(M.skillDel(skill.id), true);
  assert.equal(R.stats().corrections, 0);
});

test('作息画像每次请求自动刷新，同时保留手工编辑的画像', () => {
  const { s } = env(); const C = s.MILI_CONTEXT;
  C.setCore('喜欢别人叫我外婆');
  s.MILI_RHYTHM = { profile: () => ({ tv: { t: 1140, days: 3, top: '戏曲' } }) };
  let block = C.histMessages('今天看什么').map(m => m.content).join('\n');
  assert.ok(block.includes('19:00') && block.includes('外婆'));
  s.MILI_RHYTHM.profile = () => ({ tv: null });
  block = C.histMessages('今天看什么').map(m => m.content).join('\n');
  assert.ok(!block.includes('19:00'));
});

test('已成功的任务进原文档案，但不挤进当前闲聊工作窗口', () => {
  const { s } = env();
  s.MILI_AGENT.note('user', '打开电视', { task: true });
  s.MILI_AGENT.note('assistant', '电视打开了。', { task: true });
  s.MILI_AGENT.note('user', '我女儿叫小芳');
  assert.equal(s.MILI_CONTEXT.history().length, 3);
  assert.ok(!s.MILI_CONTEXT.histMessages('你好呀').some(m => m.content.includes('电视打开了')));
});

test('清空会取消等待中的旧请求，迟到回复不能回写历史', async () => {
  const { s, controls } = env(); let release;
  const spoken = [];
  controls.fetch = () => new Promise(resolve => { release = resolve; });
  const running = s.MILI_AGENT.run('我女儿叫小芳', { tools: false, lite: true, onDelta: text => spoken.push(text) });
  assert.equal(typeof release, 'function');
  const result = s.MILI_STORE.clearAll(); assert.equal(result.ok, true);
  release(response('小芳，我记着啦。'));
  const old = await running;
  assert.equal(old.cancelled, true);
  assert.equal(s.MILI_CONTEXT.stats().raw, 0);
  assert.equal(s.MILI_AGENT.history().length, 0);
  assert.equal(spoken.length, 0);
});

test('remember 的真实工具链能传递更正 id，精简轮也能确认保存结果', async () => {
  const { s, controls } = env();
  const old = s.MILI_MEMO.add('fact', '我女儿叫小芳', 'test');
  controls.memory = () => meaning('我女儿叫小红', '女儿叫小红', 'daughter.name', {
    replaces: old.id, entities: [{ value: '小红', quote: '小红' }] });
  controls.fetch = () => response('', { name: 'remember', args: { kind: 'fact', fact: '我女儿叫小红', replaces: old.id } });
  const result = await s.MILI_AGENT.run('更正一下，我女儿叫小红', { lite: true,
    tools: s.MILI_TOOLS.schema().filter(t => t.function.name === 'remember') });
  assert.equal(result.err, null);
  assert.ok(result.said.includes('小红'));
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  assert.equal(s.MILI_MEMO.memo()[0].text, '我女儿叫小红');
});

test('recall 同时查有效事实和历史原文，查无结果是成功的空查询', async () => {
  const { s } = env();
  s.MILI_CONTEXT.push('user', '我女儿叫小芳');
  const E = { memoFind: q => s.MILI_CONTEXT.recall(q) };
  const hit = await s.MILI_TOOLS.exec('recall', { query: '女儿叫什么名字' }, E);
  assert.equal(hit.found, true); assert.ok(hit.detail.includes('小芳'));
  const empty = await s.MILI_TOOLS.exec('recall', { query: '孙子叫什么名字' }, E);
  assert.equal(empty.ok, true); assert.equal(empty.found, false);
});

test('模型在 recall 回执中能拿到旧事实 id，随后更正而非追加冲突事实', async () => {
  const { s, controls, requests } = env();
  const old = s.MILI_MEMO.add('fact', '我家的猫叫咪咪');
  controls.memory = () => meaning('我家的猫叫旺财', '宠物名字改成旺财', 'pet.name', {
    replaces: old.id, entities: [{ value: '旺财', quote: '旺财' }] });
  let round = 0;
  controls.fetch = () => ++round === 1
    ? response('', { name: 'recall', args: { query: '我家的猫' } })
    : response('', { name: 'remember', args: { fact: '我家的猫叫旺财', kind: 'fact', replaces: old.id } });
  const result = await s.MILI_AGENT.run('把我家的宠物名字改成旺财', { tools: s.MILI_TOOLS.schema(), memoryObserved: true });
  assert.equal(result.err, null);
  const toolReply = requests[1].messages.find(m => m.role === 'tool');
  assert.equal(JSON.parse(toolReply.content).evidence[0].id, old.id);
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  assert.equal(s.MILI_MEMO.memo()[0].text, '我家的猫叫旺财');
});

test('清空遇到持久化删除失败必须报告失败', () => {
  const { s, controls } = env(); s.MILI_MEMO.add('fact', '我女儿叫小芳');
  controls.failRemove.add('mili.memory.v2');
  const result = s.MILI_STORE.clearAll();
  assert.equal(result.ok, false); assert.ok(result.errors.includes('mili.memory.v2'));
});

// 提取真实函数做副作用契约验证，无需加载 3D/UI 或真拨号。
function replayEnv(results) {
  const s = env().s;
  const app = read('app.js');
  const start = app.indexOf('async function replaySkill(');
  const end = app.indexOf('/* 主入口：', start);
  const calls = [], said = [], failures = [];
  Object.assign(s, { S: {}, nativeReady: () => true, NATIVE: () => ({}), performance,
    skillSane: () => true, say: line => said.push(line), logDid() {}, showRecall() {},
    skillSayOf: () => '办好了。', noteFail: (...args) => failures.push(args), photoId: 0 });
  s.MILI_MEMO.note('开电视再打电话', [{ name: 'ir_power', args: { on: true } }, { name: 'call_phone', args: { who: '女儿' } }]);
  s.MILI_TOOLS.exec = async name => { calls.push(name); const next = results.shift(); if (next instanceof Error) throw next; return next; };
  vm.runInContext(app.slice(start, end), s);
  return { s, calls, said, failures };
}

test('技能后半段失败：不报成功、不从头重试，并停用这条经验', async () => {
  const { s, calls, said } = replayEnv([{ ok: true }, { ok: false, detail: '没接通' }]);
  const result = await s.replaySkill('开电视再打电话');
  assert.equal(result.ok, false); assert.equal(result.handled, true); assert.equal(result.partial, true);
  assert.equal(calls.length, 2); assert.ok(!said.includes('办好了。'));
  assert.equal(s.MILI_MEMO.hit('开电视再打电话'), null);
});

test('技能首步抛异常或只部分完成：同样停下，不进入成功路径', async () => {
  for (const failure of [new Error('bridge offline'), { ok: true, partial: true }]) {
    const { s, calls } = replayEnv([failure]);
    const result = await s.replaySkill('开电视再打电话');
    assert.equal(result.ok, false); assert.equal(calls.length, 1);
  }
});

test('成功序列不能截掉动态时间或屏幕点击的后半段', () => {
  const { s } = env();
  const app = read('app.js');
  const start = app.indexOf('const SIDE_EFFECT =');
  const end = app.indexOf('/* ==========================================================================', start);
  vm.runInContext(app.slice(start, end), s);
  const trace = [{ exec: [{ ok: true, tool: 'open_app', args: { app: '闹钟' } },
    { ok: true, tool: 'set_alarm', args: { time: '明早八点' } }] }];
  assert.equal(s.goodCalls([], trace).length, 0);
  assert.equal(s.goodCalls([], [{ exec: [{ ok: true, partial: true, tool: 'search_in_app', args: { keyword: '西游记' } }] }]).length, 0);
});

test('不满足摘要强信号的更正原话仍能参与检索', () => {
  const { s } = env();
  s.MILI_CONTEXT.push('user', '我喜欢喝花茶，早上七点吃药');
  s.MILI_CONTEXT.push('user', '我现在改喝乌龙茶了，花茶不喝了');
  assert.ok(s.MILI_CONTEXT.retrieve('我现在喝什么茶')[0].text.includes('乌龙茶'));
});

test('清空演示空间不会物理删除产品空间的记忆与路由样本', () => {
  const { s, data } = env();
  s.MILI_MEMO.load('mili'); s.MILI_MEMO.add('fact', '我女儿叫小芳');
  s.MILI_CONTEXT.push('user', '我女儿叫小芳');
  s.MILI_TOOL_ROUTER.learn('打开电视', 'ir_power');
  s.MILI_STORE.configure('mili_demo'); s.MILI_MEMO.load('mili_demo');
  s.MILI_CONTEXT.configure('mili_demo'); s.MILI_TOOL_ROUTER.configure('mili_demo');
  s.MILI_MEMO.add('fact', '这是一条演示记忆');
  assert.equal(s.MILI_STORE.clearAll().ok, true);
  assert.ok(data.has('mili_memory_v2'));
  assert.ok(data.has('mili.context.raw'));
  assert.ok(data.has('mili.tool.corrections'));
  s.MILI_STORE.configure('mili'); s.MILI_MEMO.load('mili');
  assert.equal(s.MILI_MEMO.memoCount(), 1);
});

test('全量清空包含主界面的旧问答缓存与失败记录，并保留账号配置', () => {
  const { s } = env();
  s.S = { rules: [{ ans: '旧回答' }], fails: [{ tool: 'old' }], q: { old: 3 }, unknown: ['旧问题'], memo: { old: true }, accToken: 'test-account' };
  let saved = false; s.save = () => { saved = true; return true; };
  const app = read('app.js'); const start = app.indexOf("if (window.MILI_STORE) window.MILI_STORE.register('app-learning', {");
  const end = app.indexOf('\n});', start) + '\n});'.length;
  vm.runInContext(app.slice(start, end), s);
  assert.equal(s.MILI_STORE.clearAll().ok, true);
  assert.equal(s.S.rules.length, 0); assert.equal(s.S.fails.length, 0);
  assert.equal(Object.keys(s.S.q).length, 0); assert.equal(s.S.accToken, 'test-account');
  assert.equal(saved, true);
});

test('清空时已启动工具的迟到写入也会被拦住', async () => {
  const { s, controls } = env(); let release, toolEnv;
  controls.fetch = () => response('', { name: 'remember', args: { kind: 'fact', fact: '我女儿叫小芳' } });
  s.MILI_TOOLS.exec = (name, args, E) => new Promise(resolve => { toolEnv = E; release = resolve; });
  const running = s.MILI_AGENT.run('记住我女儿叫小芳', { lite: true, tools: s.MILI_TOOLS.schema() });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(toolEnv);
  s.MILI_STORE.clearAll();
  assert.equal(toolEnv.memoAdd('fact', '我女儿叫小芳'), null);
  release({ ok: true, detail: '旧工具回来了' });
  assert.equal((await running).cancelled, true);
  assert.equal(s.MILI_MEMO.memoCount(), 0);
});

test('真实作息聚合至少需要三天，同一天重复三次不能凑成三天', () => {
  const { s, data, controls } = env(); s.STORE_KEY = 'mili';
  const today = s.MILI_STORE.localDay();
  data.set('mili.rhythm', JSON.stringify({ days: {
    '2026-10-01': { tv: [{ t: 1140, x: '戏曲' }] },
    '2026-10-02': { tv: [{ t: 1150, x: '戏曲' }] },
    [today]: { tv: [{ t: 1160, x: '戏曲' }], med: [{ t: 480 }, { t: 490 }, { t: 500 }] },
  }, nudges: {} }));
  const app = read('app.js'); const start = app.indexOf("(function () {\n  const KEY = STORE_KEY + '.rhythm';");
  const end = app.indexOf('\n})();', start) + '\n})();'.length;
  vm.runInContext(app.slice(start, end), s);
  assert.equal(s.MILI_RHYTHM.profile().tv.days, 3);
  assert.equal(s.MILI_RHYTHM.profile().tv.t, 1150);
  assert.equal(s.MILI_RHYTHM.profile().med, null);
  controls.fail.add('mili.rhythm');
  const before = JSON.stringify(s.MILI_RHYTHM.dump());
  assert.equal(s.MILI_RHYTHM.note('tv', '新闻'), false);
  assert.equal(JSON.stringify(s.MILI_RHYTHM.dump()), before);
});

test('闲时精修的迟到结果不能在清空后复活摘要', async () => {
  const { s } = env(); const C = s.MILI_CONTEXT;
  for (let i = 0; i < 20; i++) C.push('user', '早上七点吃药，第' + i + '天');
  let release;
  const pending = C.refine(() => new Promise(resolve => { release = resolve; }));
  assert.equal(typeof release, 'function');
  s.MILI_STORE.clearAll(); release('旧的女儿名字叫小芳');
  assert.equal(await pending, null);
  assert.equal(C.stats().summaries, 0);
});

test('自动问答缓存过期后不能抢答，人工配置不受缓存时限影响', () => {
  const { s } = env();
  s.S = { rules: [
    { k: '今天出门穿什么', ans: '旧天气回答', auto: true, born: Date.now() - 2 * 3600e3 },
    { k: '女儿的称呼', ans: '小芳', auto: false, born: 1 },
  ] };
  const app = read('app.js'); const start = app.indexOf('function learnKey(');
  const end = app.indexOf('/* ---------- 1) 学会答 ---------- */', start);
  vm.runInContext(app.slice(start, end), s);
  assert.equal(s.findRule('今天出门穿什么'), null);
  assert.equal(s.findRule('女儿的称呼').ans, '小芳');
});

test('损坏的历史或记忆记录不会拖垮启动与召回', () => {
  const data = new Map([
    ['mili.context.raw', '{"wrong":true}'],
    ['mili.context.event', '{"summaries":[null],"cutoff":-100}'],
    ['mili.memory.v2', '{"facts":[null,{}],"skills":[null,{}]}'],
    ['mili.tool.corrections', '{"wrong":true}'],
  ]);
  const { s } = env(data);
  assert.equal(s.MILI_CONTEXT.stats().raw, 0);
  assert.equal(s.MILI_MEMO.memoCount(), 0);
  assert.equal(s.MILI_MEMO.skillCount(), 0);
  assert.equal(s.MILI_TOOL_ROUTER.stats().corrections, 0);
  assert.equal(s.MILI_CONTEXT.recall('我女儿叫什么名字').length, 0);
});

function memoryScreens(s) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  Object.assign(s, { E9: escape, esc: escape, S: { rules: [], unknown: [] },
    head: () => '', nav: () => '', msg: () => '' });
  const app = read('app.js');
  const start = app.indexOf('  function rhythmPage(){');
  vm.runInContext(app.slice(start, app.indexOf('  /* ---- ③ 双端切换', start)), s);
  const learn = app.indexOf('    learn: function(){');
  const body = app.slice(learn + '    learn: '.length, app.indexOf('    did: function(){', learn)).trim().replace(/,$/, '');
  vm.runInContext('this.renderNotebook = ' + body, s);
}

function explicitRemember(s, text) {
  const app = read('app.js');
  const start = app.indexOf('  try {\n    const rawT = String(text');
  const end = app.indexOf('  /* 电视层开着时的快速通道', start);
  s.text = text; s.quiet = false; s.say = line => { s.spoken = line; };
  return vm.runInContext('(async function(){' + app.slice(start, end) + '})()', s);
}

test('用户说帮我记住后，两处记忆页面都从真实事实库显示，重启后仍存在', async () => {
  const { s, data, controls } = env(); s.MILI_MEMO.load('mili'); memoryScreens(s);
  controls.memory = () => meaning('我女儿叫小芳', '女儿叫小芳', 'daughter.name', { entities: [{ value: '小芳', quote: '小芳' }] });
  for (const prefix of ['记住：', '帮我记住，', '请你帮我记一下：', '米粒，帮我记住：']) {
    const result = await explicitRemember(s, prefix + '我女儿叫小芳');
    assert.equal(result.ok, true);
  }
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  assert.ok(JSON.parse(data.get('mili_memory_v2')).facts.some(m => m.text === '我女儿叫小芳'));
  assert.ok(s.rhythmPage().includes('我女儿叫小芳'));
  assert.ok(s.renderNotebook().includes('我女儿叫小芳'));
  const reboot = env(data).s; reboot.MILI_MEMO.load('mili'); memoryScreens(reboot);
  assert.ok(reboot.rhythmPage().includes('我女儿叫小芳'));
  assert.ok(reboot.renderNotebook().includes('我女儿叫小芳'));
});

test('两处记忆页面正确处理空态、过期、更正、删除及 HTML 内容', () => {
  const { s } = env(); memoryScreens(s);
  assert.ok(s.rhythmPage().includes('还没有保存的事'));
  assert.ok(s.renderNotebook().includes('还没有记下的事'));
  const old = s.MILI_MEMO.add('fact', '女儿叫旧名字', 'test', { key: 'daughter' });
  const fact = s.MILI_MEMO.add('fact', '女儿叫小红', 'test', { key: 'daughter', replaces: old.id });
  s.MILI_MEMO.add('event', '过期的事情', 'test', { expiresAt: Date.now() - 1000 });
  s.MILI_MEMO.add('fact', '我的备注是<img src=x>', 'test');
  for (const html of [s.rhythmPage(), s.renderNotebook()]) {
    assert.ok(html.includes('女儿叫小红'));
    assert.ok(!html.includes('女儿叫旧名字') && !html.includes('过期的事情'));
    assert.ok(html.includes('&lt;img src=x&gt;') && !html.includes('<img src=x>'));
  }
  const app = read('app.js');
  const start = app.indexOf("    if (d === 'memoryDrop') {");
  const end = app.indexOf("    if (d === 'rhythmDrop')", start);
  s.d = 'memoryDrop'; s.n = { dataset: { id: fact.id } };
  s.setMsg = () => {}; s.render = () => {};
  vm.runInContext('(function(){' + app.slice(start, end) + '})()', s);
  assert.ok(!s.rhythmPage().includes('女儿叫小红'));
  assert.ok(!s.renderNotebook().includes('女儿叫小红'));
  assert.equal(s.MILI_CONTEXT.recall('女儿叫小红').length, 0);
});

test('显式记住指令存储失败时不能报成功，也不在页面显示', async () => {
  const { s, controls } = env(); s.MILI_MEMO.load('mili'); memoryScreens(s);
  controls.memory = () => meaning('我喜欢喝花茶', '喜欢喝花茶');
  controls.fail.add('mili_memory_v2');
  assert.equal((await explicitRemember(s, '帮我记住，我喜欢喝花茶')).ok, false);
  assert.ok(s.spoken.includes('没存下来'));
  assert.ok(!s.rhythmPage().includes('我喜欢喝花茶'));
  assert.ok(!s.renderNotebook().includes('我喜欢喝花茶'));
});

test('普通精简聊天无需记住指令或工具，也能后台形成规范语义事实并展示', async () => {
  const { s, controls, memoryRequests, data } = env();
  const raw = '那个，我喝茶不放唐的，喝甜的我不喜欢';
  controls.memory = input => {
    assert.equal(input.user_text, raw);
    return meaning('喝茶不加糖', '喝茶不放唐的', 'user.tea.sugar', { kind: 'preference' });
  };
  await s.MILI_AGENT.run(raw, { tools: false, lite: true });
  await s.MILI_SEMANTIC.flush();
  const record = s.MILI_MEMO.memo()[0];
  assert.equal(record.text, '喝茶不加糖');
  assert.equal(record.semantic.rawText, raw);
  assert.equal(memoryRequests.length, 1);
  assert.equal(memoryRequests[0].tools, undefined);
  assert.ok(s.MILI_CONTEXT.history().some(m => m.text === raw));
  memoryScreens(s);
  assert.ok(s.rhythmPage().includes('喝茶不加糖'));
  assert.ok(!s.rhythmPage().includes('不放唐'));
  const reboot = env(data).s;
  assert.equal(reboot.MILI_MEMO.memo()[0].text, '喝茶不加糖');
  assert.ok(reboot.MILI_CONTEXT.histMessages('我喝茶要加糖吗').some(m => m.content.includes('喝茶不加糖')));
});

test('多种口语表达用同一事项键归并，明确更正后旧语义失效', async () => {
  const { s, controls } = env();
  controls.memory = () => meaning('喝茶不加糖', '茶里别放糖', 'user.tea.sugar', { kind: 'preference' });
  await s.MILI_SEMANTIC.observe('我茶里别放糖啊');
  controls.memory = () => meaning('喝茶不加糖', '喝茶不要糖', 'user.tea.sugar', { kind: 'preference' });
  await s.MILI_SEMANTIC.observe('喝茶不要糖，记着哈');
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  const old = s.MILI_MEMO.memo()[0];
  controls.memory = () => meaning('喝茶加少量糖', '现在喝茶可以放一点糖', 'user.tea.sugar', { kind: 'preference', replaces: old.id });
  await s.MILI_SEMANTIC.observe('我现在喝茶可以放一点糖');
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  assert.equal(s.MILI_MEMO.memo()[0].text, '喝茶加少量糖');
  assert.ok(s.MILI_MEMO.history().facts.find(f => f.id === old.id).validTo);
});

test('人名同音猜写、低信心和非当前原文证据都不能成为确定事实', async () => {
  for (const extra of [
    { key: 'daughter.name', entities: [{ value: '晓芳', quote: '小方' }] },
    { key: 'daughter.name', entities: [] },
    { confidence: 0.7 }, { uncertain: true }, { evidence: '助手说女儿叫晓芳' },
    { asserted: false }, { durable: false },
  ]) {
    const { s, controls } = env();
    controls.memory = () => ({ ...meaning('女儿叫晓芳', '女儿叫小方', 'daughter', extra), question: '名字是哪两个字？' });
    const result = await s.MILI_SEMANTIC.remember('我女儿叫小方');
    assert.equal(result.ok, false);
    assert.equal(s.MILI_MEMO.memoCount(), 0);
    assert.equal(result.detail, '名字是哪两个字？');
  }
});

test('自动整理得到问句、假设或闲聊的空结果时不保存，也不新增习惯', async () => {
  const { s, controls } = env(); const events = [];
  s.MILI_RHYTHM = { note: (...args) => { events.push(args); return true; } };
  for (const raw of ['我女儿叫什么名字？', '如果我喜欢甜茶呢', '我还没吃饭', '我饿了', '明天吃饭去', '我女儿吃饭了']) {
    controls.memory = () => ({ facts: [], events: [], intent: null, question: '' });
    await s.MILI_SEMANTIC.observe(raw);
  }
  assert.equal(s.MILI_MEMO.memoCount(), 0);
  assert.equal(events.length, 0);
  // 主入口不能再凭“饿/做饭/吃饭”字样记一次 meal。
  const block = read('app.js').slice(read('app.js').indexOf('  /* 每说一句话都是一次'), read('app.js').indexOf('  /* ===== 「记住'));
  assert.ok(!block.includes("note('meal')"));
});

test('习惯只接收本人当前已发生的高信心事件，重复分析只记录一次', async () => {
  const { s, controls, memoryRequests } = env(); const events = [];
  s.MILI_RHYTHM = { note: (...args) => { events.push(args); return true; } };
  controls.memory = () => ({ facts: [], intent: null, events: [
    { kind: 'meal', evidence: '刚吃过饭', occurred: true, subject: 'self', time: 'now', confidence: 0.98, uncertain: false },
    { kind: 'meal', evidence: '刚吃过饭', occurred: true, subject: 'self', time: 'now', confidence: 0.98, uncertain: false },
    { kind: 'med', evidence: '刚吃过饭', occurred: true, subject: 'other', time: 'now', confidence: 0.98, uncertain: false },
    { kind: 'sleep', evidence: '刚吃过饭', occurred: true, subject: 'self', time: 'past', confidence: 0.98, uncertain: false },
  ] });
  await Promise.all([s.MILI_SEMANTIC.observe('我刚吃过饭'), s.MILI_SEMANTIC.observe('我刚吃过饭')]);
  assert.equal(memoryRequests.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'meal');
  assert.ok(Number.isFinite(events[0][2]));
  assert.equal(events[0][3].evidence, '刚吃过饭');
});

test('后台语义分析没回来时，正常对话仍能先完成', async () => {
  const { s, controls } = env(); let release;
  controls.memory = () => new Promise(resolve => { release = resolve; });
  const result = await s.MILI_AGENT.run('我喝茶不加糖', { lite: true, tools: false });
  assert.equal(result.err, null);
  assert.equal(s.MILI_MEMO.memoCount(), 0);
  release(meaning('喝茶不加糖', '喝茶不加糖', 'user.tea.sugar'));
  await s.MILI_SEMANTIC.flush();
  assert.equal(s.MILI_MEMO.memoCount(), 1);
});

test('自动分析与 remember 工具共用原始用户证据，只请求一次语义整理', async () => {
  const { s, controls, memoryRequests } = env();
  controls.memory = () => meaning('喝茶不加糖', '喝茶不放糖', 'user.tea.sugar');
  controls.fetch = () => response('', { name: 'remember', args: { fact: '模型乱猜成了喜欢甜茶', kind: 'preference' } });
  const result = await s.MILI_AGENT.run('我喝茶不放糖', { lite: true, tools: s.MILI_TOOLS.schema() });
  assert.equal(result.err, null);
  assert.ok(result.said.includes('喝茶不加糖'));
  assert.equal(memoryRequests.length, 1);
  assert.equal(s.MILI_MEMO.memo()[0].text, '喝茶不加糖');
});

test('解析失败不退回原句直接存储；remember 缺少原始证据时拒绝写入', async () => {
  const { s, controls } = env(); controls.memory = () => '不是合法的结构化结果';
  const result = await s.MILI_SEMANTIC.remember('帮我记住我喜欢花茶');
  assert.equal(result.ok, false);
  assert.equal(s.MILI_MEMO.memoCount(), 0);
  const tool = await s.MILI_TOOLS.exec('remember', { fact: '模型猜的偏好', kind: 'preference' }, {
    memoAdd: () => { throw Error('must not bypass semantic memory'); },
  });
  assert.equal(tool.ok, false);
});

test('清空和切换演示空间时，迟到的自动分析不能写回事实或习惯', async () => {
  for (const clear of [true, false]) {
    const { s, controls } = env(); let release; const events = [];
    s.MILI_RHYTHM = { note: (...args) => { events.push(args); return true; } };
    controls.memory = () => new Promise(resolve => { release = resolve; });
    const pending = s.MILI_SEMANTIC.observe('我喝茶不加糖');
    if (clear) s.MILI_STORE.clearAll();
    else { s.MILI_SEMANTIC.configure('mili_demo'); s.MILI_MEMO.load('mili_demo'); }
    release(meaning('喝茶不加糖', '喝茶不加糖', 'user.tea.sugar'));
    assert.equal((await pending).cancelled, true);
    assert.equal(s.MILI_MEMO.memoCount(), 0);
    assert.equal(events.length, 0);
  }
});

test('用户删除旧事实后，正在整理的更正结果不能将它复活', async () => {
  const { s, controls } = env(); let release;
  const old = s.MILI_MEMO.add('preference', '喝茶不加糖', '', { key: 'user.tea.sugar' });
  controls.memory = () => new Promise(resolve => { release = resolve; });
  const pending = s.MILI_SEMANTIC.observe('现在喝茶加一点糖');
  s.MILI_MEMO.del(old.id);
  release(meaning('喝茶加少量糖', '喝茶加一点糖', 'user.tea.sugar', { replaces: old.id }));
  const result = await pending;
  assert.equal(result.saved.length, 0);
  assert.equal(result.rejected, 1);
  assert.equal(s.MILI_MEMO.memoCount(), 0);
});

test('成功操作保存规范语义标签，实际执行参数保持原样；删除技能也删除语义路由样本', async () => {
  const { s, controls } = env();
  const raw = '那个，电视给我打开嘛';
  controls.memory = () => ({ facts: [], events: [], intent: { text: '打开电视', evidence: '电视给我打开',
    confidence: 0.96, uncertain: false, entities: [] } });
  const tools = [{ name: 'ir_power', args: { on: true } }];
  const pending = s.MILI_SEMANTIC.learnSkill(raw, tools);
  tools[0].args.on = false;
  const skill = await pending;
  assert.equal(skill.intent, '打开电视');
  assert.equal(skill.text, raw);
  assert.equal(s.MILI_MEMO.hit(raw).tools[0].args.on, true);
  assert.equal(s.MILI_MEMO.hit('打开电视').tools[0].args.on, true);
  assert.equal(s.MILI_MEMO.hit('关闭电视'), null);
  assert.equal(s.MILI_TOOL_ROUTER.corrections()[0].u, '打开电视');
  assert.equal(s.MILI_TOOL_ROUTER.corrections()[0].n, 1, '一次成功操作只能增加一次路由样本计数');
  s.MILI_MEMO.skillDel(skill.id);
  assert.equal(s.MILI_TOOL_ROUTER.stats().corrections, 0);
});

test('只整理成功操作意图时，旧原话中的事实不会再次被提取覆盖新事实', async () => {
  const { s, controls } = env();
  const latest = s.MILI_MEMO.add('preference', '喝乌龙茶', '', { key: 'user.tea.type' });
  controls.memory = input => {
    assert.equal(input.intent_only, true);
    return { ...meaning('喝花茶', '我喝花茶', 'user.tea.type'), intent: {
      text: '打开电视', evidence: '开电视', confidence: 0.95, uncertain: false, entities: [] } };
  };
  await s.MILI_SEMANTIC.learnSkill('我喝花茶，帮我开电视', [{ name: 'ir_power', args: { on: true } }]);
  assert.equal(s.MILI_MEMO.memo()[0].id, latest.id);
  assert.equal(s.MILI_MEMO.memo()[0].text, '喝乌龙茶');
});

test('删除语义事实后，对应的含错字原话也不能通过历史召回复活', async () => {
  const { s, controls } = env();
  const raw = '那个我喝茶不放唐的';
  controls.memory = () => meaning('喝茶不加糖', '喝茶不放唐的', 'user.tea.sugar');
  await s.MILI_SEMANTIC.observe(raw);
  s.MILI_CONTEXT.push('user', raw);
  s.MILI_CONTEXT.push('assistant', '知道啦。');
  s.MILI_MEMO.del(s.MILI_MEMO.memo()[0].id);
  assert.equal(s.MILI_CONTEXT.recall('喝茶放唐').length, 0);
});

test('工具只是派单成功时，不得学成已经观看或完成操作的记忆', async () => {
  const { s } = env(); let writes = 0;
  const result = await s.MILI_TOOLS.exec('search_in_app', { app: '抖音', keyword: '西游记' }, {
    native: () => ({ playDouyin: () => JSON.stringify({ ok: true, say: '正在查找' }) }),
    memoAdd: () => { writes++; },
  });
  assert.equal(result.pending, true);
  assert.equal(writes, 0);
  const app = read('app.js'), start = app.indexOf('const SIDE_EFFECT =');
  vm.runInContext(app.slice(start, app.indexOf('/* ==========================================================================', start)), s);
  assert.equal(s.goodCalls([], [{ exec: [{ tool: 'search_in_app', args: { keyword: '西游记' }, ok: true, pending: true }] }]).length, 0);
});

test('刚删除的事实不能被分析缓存虚报已保存；明确再次交代时重新提交', async () => {
  const { s, controls, memoryRequests } = env();
  controls.memory = () => meaning('喝茶不加糖', '喝茶不加糖', 'user.tea.sugar');
  const first = await s.MILI_SEMANTIC.remember('帮我记住喝茶不加糖');
  s.MILI_MEMO.del(first.saved[0].id);
  const second = await s.MILI_SEMANTIC.remember('帮我记住喝茶不加糖');
  assert.equal(second.ok, true);
  assert.equal(memoryRequests.length, 2);
  assert.equal(s.MILI_MEMO.memoCount(), 1);
  assert.notEqual(second.saved[0].id, first.saved[0].id);
});
