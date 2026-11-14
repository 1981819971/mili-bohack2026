/* 纯 Node 回归：BM25 动态工具检索。
   跑法：node --test tests/tool-router.test.mjs
   覆盖：中文分词 / 检索选对工具 / 低置信度保守兜底 / 改口正反馈 / 白名单 / 一键清空联动。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

const FAKE_TOOLS = [
  ['wechat_message', '给微信联系人发消息，一步到位，who 是备注名'],
  ['wechat_call', '打微信视频或语音电话给联系人'],
  ['call_phone', '拨打电话给某人'],
  ['send_sms', '发短信给某人'],
  ['watch_news', '打开电视看新闻联播或央视'],
  ['play_video', '播放短视频或短剧'],
  ['search_in_app', '在应用里搜索片名或内容'],
  ['ui_map', '读取当前屏幕的控件树，找按钮'],
  ['tap_at', '点一下屏幕坐标'],
  ['check_meds', '查看药箱和吃药记录'],
  ['emergency', '紧急求助，通知家人'],
  ['search_web', '联网搜索资料'],
  ['recall', '回忆以前说过的事'],
  ['remember', '记住一句话'],
  ['tell_time', '报当前时间'],
  ['read_screen', '读出屏幕上有什么'],
  ['go_back', '返回上一屏'],
];

function makeEnv() {
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const sandbox = { localStorage, console, setTimeout, clearTimeout, Date, Math, JSON };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(APP, 'memory.js'), 'utf8'), sandbox, { filename: 'memory.js' });
  const names = new Set(FAKE_TOOLS.map((t) => t[0]));
  sandbox.MILI_TOOLS = {
    schema: () => FAKE_TOOLS.map(([name, desc]) => ({ type: 'function', function: {
      name, description: desc, parameters: { type: 'object', properties: { who: { type: 'string' } }, required: [] } } })),
    has: (n) => names.has(n),
    names: () => Array.from(names),
  };
  vm.runInContext(fs.readFileSync(path.join(APP, 'tool-router.js'), 'utf8'), sandbox, { filename: 'tool-router.js' });
  return { sandbox, data };
}

test('分词：中文产生单字 + bigram，英文数字成词', () => {
  const { sandbox } = makeEnv();
  const t = sandbox.MILI_TOOL_ROUTER.tokenize('给闺女发微信 abc123');
  assert.ok(t.includes('闺女') && t.includes('微信') && t.includes('abc123'));
});

test('BM25：给闺女发微信说我挺好的 → wechat_message 排在第一', () => {
  const { sandbox } = makeEnv();
  const r = sandbox.MILI_TOOL_ROUTER.select('给闺女发微信说我挺好的', { minScore: 0 });
  assert.equal(r.fallback, false);
  assert.equal(r.names[0] === 'wechat_message' || r.scores.wechat_message === Math.max(...Object.values(r.scores)), true);
  assert.ok(r.names.includes('wechat_message'));
  assert.ok(r.names.includes('search_web'));   // ALWAYS 常带
  assert.ok(r.tools.length >= 6);
});

test('BM25：看新闻联播 → 媒体域工具分数高于通讯域', () => {
  const { sandbox } = makeEnv();
  const r = sandbox.MILI_TOOL_ROUTER.select('我要看新闻联播', { minScore: 0 });
  assert.ok(r.scores.watch_news > r.scores.wechat_message);
});

test('低置信度：无意义输入退回全量，不硬猜', () => {
  const { sandbox } = makeEnv();
  const r = sandbox.MILI_TOOL_ROUTER.select('嗯', { minScore: 999 });
  assert.equal(r.fallback, true);
  assert.equal(r.tools.length, FAKE_TOOLS.length);
});

test('改口正反馈：同一说法学满 3 次变稳定，检索分数上升', () => {
  const { sandbox } = makeEnv();
  const R = sandbox.MILI_TOOL_ROUTER;
  const before = R.select('放那个戏给我看', { minScore: 0 }).scores.play_video || 0;
  for (let i = 0; i < 3; i++) assert.equal(R.learn('放那个戏给我看', 'play_video'), true);
  const s = R.stats();
  assert.equal(s.corrections, 1);
  assert.equal(s.stable, 1);
  const after = R.select('放那个戏给我看', { minScore: 0 }).scores.play_video || 0;
  assert.ok(after > before, `after=${after} before=${before}`);
});

test('白名单：未知工具名不许被学进样本', () => {
  const { sandbox } = makeEnv();
  assert.equal(sandbox.MILI_TOOL_ROUTER.learn('随便一句话', 'not_exist'), false);
});

test('一键清空：改口样本登记进总线，clearAll 后归零', () => {
  const { sandbox } = makeEnv();
  sandbox.MILI_TOOL_ROUTER.learn('给闺女发消息', 'wechat_message');
  assert.equal(sandbox.MILI_TOOL_ROUTER.stats().corrections, 1);
  const r = sandbox.MILI_STORE.clearAll();
  assert.ok(r.modules.includes('tool-router'));
  assert.equal(sandbox.MILI_TOOL_ROUTER.stats().corrections, 0);
});

test('域目录完整覆盖真实 67 个工具，且没有编造的工具名', () => {
  const env = { console, Math, JSON, Date, Promise, setTimeout, clearTimeout };
  env.window = env; env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(APP, 'agent-tools.js'), 'utf8'), env, { filename: 'agent-tools.js' });
  const real = env.MILI_TOOLS.schema().map((t) => t.function.name);
  assert.equal(real.length, 67, `真实工具数变了：${real.length}`);
  const router = fs.readFileSync(path.join(APP, 'tool-router.js'), 'utf8');
  const missing = [...real].filter((n) => !router.includes("'" + n + "'"));  // 跨 vm realm 数组要复制到本 realm 再断言
  assert.deepEqual(missing, [], '这些工具没进任何检索域');
  const defined = [...fs.readFileSync(path.join(APP, 'agent-tools.js'), 'utf8')
    .matchAll(/\bdef\('([a-z0-9_]+)'/g)].map((m) => m[1]);
  const listed = [...router.matchAll(/'([a-z][a-z0-9_]{2,})'/g)].map((m) => m[1]);
  const known = new Set([...defined, ...real, 'search_web', 'recall', 'remember', 'tell_time', 'read_screen', 'go_back']);
  const ghosts = [...new Set(listed)].filter((n) => /_[a-z]/.test(n) && !known.has(n) && !n.startsWith('mili.'));
  assert.deepEqual(ghosts, [], '域目录里写了不存在的工具');
});

test('样本淘汰：超过 200 条时保留最新的改口，不留下最早的', () => {
  const { sandbox } = makeEnv();
  const R = sandbox.MILI_TOOL_ROUTER;
  /* 201 条互不相同的说法，全部 n=1。只按 n 排序时稳定排序会保留最早的，
     把最新学会的截掉 —— 老人刚纠正过的那句反而丢了。 */
  for (let i = 0; i < 205; i++) R.learn('说法' + i, 'wechat_message');
  const c = R.corrections();
  assert.equal(c.length, 200, `淘汰后应保留 200 条，实际 ${c.length}`);
  const us = c.map((x) => x.u);
  assert.ok(us.includes('说法204'), '最新学会的说法被丢掉了');
  assert.ok(!us.includes('说法0'), '最早的说法没有被淘汰');
});

test('回退单条：forget 只删指定说法+工具，别的学习不动', () => {
  const { sandbox } = makeEnv();
  const R = sandbox.MILI_TOOL_ROUTER;
  R.learn('把那个戏给我放上', 'play_video');
  R.learn('给闺女发个消息', 'wechat_message');
  assert.equal(R.stats().corrections, 2);
  assert.equal(R.forget('把那个戏给我放上', 'play_video'), 1);
  assert.equal(R.stats().corrections, 1);
  assert.equal(R.corrections()[0].tool, 'wechat_message');
  /* 工具名不匹配时不误删 */
  assert.equal(R.forget('给闺女发个消息', 'play_video'), 0);
});
