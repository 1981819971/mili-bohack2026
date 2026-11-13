/* 纯 Node 回归测试：不依赖浏览器、不依赖 npm 包。
   跑法（仓库根目录）：node --test tests/memory.test.mjs

   这些断言对应 2026-11-13 修掉的几个真实缺陷，任何一条挂了都说明回归了：
   UTC 日期串天 / 一键清空只清一套 / ADD-only 被改回覆盖 / skill 模糊重放误拨。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

function makeEnv() {
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (globalThis.__FAIL_WRITES) throw new Error('QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
  const sandbox = { localStorage, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['memory.js', 'agent-memo.js']) {
    vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, data };
}

test('本地日期：07:00 的作息事件必须记在当天，不能串到前一天', () => {
  const { sandbox } = makeEnv();
  const d = new Date(2026, 10, 14, 7, 0, 0); // 本地时间 11-14 早上 7 点
  assert.equal(sandbox.MILI_STORE.localDay(d), '2026-11-14');
});

test('一键清空：memo / rhythm / evo 三套一起退，清空后不能 0ms 重放', () => {
  const { sandbox, data } = makeEnv();
  const M = sandbox.MILI_MEMO;
  M.add('fact', '我女儿叫小芳', '老人说的');
  M.note('给女儿打视频', [{ name: 'wechat_call', args: { who: '女儿' } }]);
  data.set('mili.rhythm', JSON.stringify({ days: { '2026-11-14': {} }, nudges: {} }));
  data.set('mili_evo', JSON.stringify({ ver: 9 }));

  let rhythmWiped = false;
  sandbox.MILI_STORE.register('rhythm', {
    keys: ['mili.rhythm'], wipe: () => { rhythmWiped = true; },
  });
  sandbox.MILI_STORE.register('evo', {
    keys: ['mili_evo'], wipe: () => {},
  });

  const r = sandbox.MILI_STORE.clearAll();
  // vm 上下文里的数组与 Node 主上下文原型不同，比字符串而不是 deepEqual
  assert.equal(Array.from(r.modules).sort().join(','), 'evo,memo,rhythm');
  assert.equal(rhythmWiped, true);
  assert.equal(data.has('mili.rhythm'), false);
  assert.equal(data.has('mili_evo'), false);
  assert.equal(M.memoCount(), 0);
  assert.equal(M.skillCount(), 0);
  assert.equal(M.hit('给女儿打视频'), null);
  assert.ok(sandbox.MILI_STORE.clearedAt() > 0);
});

test('ADD-only：同一 key 重复写入不覆盖正文，只累加证据', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  M.add('fact', '我女儿叫小芳', '老人说的');
  const again = M.add('fact', '我女儿叫小芳', '老人说的');
  assert.equal(M.memoCount(), 1);
  assert.equal(again.n, 2);
  assert.equal(again.text, '我女儿叫小芳');
  assert.equal(again.validTo, null);
});

test('删除 = 打失效戳，不物理删，history 仍可追溯', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  const rec = M.add('fact', '我闺女叫小芳', '老人说的');
  assert.equal(M.del(rec.id), true);
  assert.equal(M.memoCount(), 0);
  const hist = M.history().facts;
  assert.equal(hist.length, 1);
  assert.ok(hist[0].validTo > 0);
  assert.equal(hist[0].supersededBy, 'user_delete');
});

test('召回阈值：实词 gram 能召回，虚词/无关句不会把整本记忆捞出来', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  M.add('fact', '我女儿叫小芳', '老人说的');
  assert.ok(M.find('女儿叫什么名字').length >= 1, '「女儿 / 儿叫」应命中');
  assert.equal(M.find('我没事').length, 0, '无关句不应命中');
  assert.equal(M.find('今天天气怎么样').length, 0, '虚词句不应命中');
});

test('skill 序列变化：旧版本失效，追加新版本而非原地覆盖', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  M.note('打开电视', [{ name: 'ir_power', args: { on: true } }]);
  M.note('打开电视', [{ name: 'player_control', args: { act: 'play' } }]);
  assert.equal(M.skillCount(), 1);
  const hist = M.history().skills;
  assert.equal(hist.length, 2);
  assert.ok(hist.some((s) => s.validTo && s.supersededBy === 'sequence_changed'));
});

test('skill 命中只认精确/同音，尾部重叠不再误触发直接拨号', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  M.note('打开天天耍大牌', [{ name: 'play_video', args: { title: '天天耍大牌' } }]);
  assert.ok(M.hit('打开天天耍大牌'));
  assert.equal(M.hit('我要看耍大牌'), null, '旧第③级尾部重叠兜底必须失效');
  assert.ok(M.hit('大开天天耍大牌'), '同音归一仍应命中');
});

test('方向字：开/关不能互相认走', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  M.note('关掉电视', [{ name: 'ir_power', args: { on: false } }]);
  assert.equal(M.hit('开开电视'), null);
});

test('用户删过的内置 skill 不会被 mergeDefaults 复活', () => {
  const { sandbox } = makeEnv();
  const M = sandbox.MILI_MEMO;
  const preset = [{ id: 'builtin_test', k: '给女儿打视频', text: '给女儿打视频',
                    tools: [{ name: 'wechat_call', args: { who: '女儿' } }] }];
  assert.equal(M.mergeDefaults(preset), 1);
  M.skillDel(M.skills()[0].id);
  assert.equal(M.mergeDefaults(preset), 0);
  assert.equal(M.skillCount(), 0);
});

test('写入失败不再被静默吞掉：总线置 writeFailed', () => {
  globalThis.__FAIL_WRITES = true;
  try {
    const { sandbox } = makeEnv();
    sandbox.MILI_MEMO.add('fact', '写不进去的一条', '老人说的');
    assert.equal(sandbox.MILI_STORE.writeOk(), false);
  } finally {
    globalThis.__FAIL_WRITES = false;
  }
});

test('老版本 {memo,skill,cnt} 数据能迁移进新结构', () => {
  const { sandbox, data } = makeEnv();
  data.set('mili_agent_memo', JSON.stringify({
    memo: [{ id: 'm_old', k: '我女儿叫小芳', text: '我女儿叫小芳', kind: 'fact', n: 3, at: 1 }],
    skill: [], cnt: {},
  }));
  // 重新加载模块，触发迁移
  delete sandbox.MILI_MEMO;
  vm.runInContext(fs.readFileSync(path.join(APP, 'agent-memo.js'), 'utf8'), sandbox,
    { filename: 'agent-memo.js' });
  const M = sandbox.MILI_MEMO;
  M.load();
  assert.equal(M.memoCount(), 1);
  assert.equal(M.memo()[0].text, '我女儿叫小芳');
  assert.equal(M.memo()[0].validTo, null);
});
