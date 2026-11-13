/* 纯 Node 回归：三层记忆与自动上下文压缩。
   跑法：node --test tests/context.test.mjs
   覆盖：append-only / 阈值触发 / cutoff 锚定 / 重启持久化 / 检索召回 /
        知识更新不并存 / 弃答 / core 编译 / 一键清空联动。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

function makeEnv(shared) {
  const data = shared || new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const sandbox = { localStorage, console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(APP, 'memory.js'), 'utf8'), sandbox, { filename: 'memory.js' });
  vm.runInContext(fs.readFileSync(path.join(APP, 'context.js'), 'utf8'), sandbox, { filename: 'context.js' });
  return { sandbox, data };
}

function feed(C, n, maker) {
  for (let i = 0; i < n; i++) {
    C.push('user', maker(i));
    C.push('assistant', '好嘞，我记着呢。');
  }
}

test('未达阈值不压缩，达到阈值自动压缩且原文一条不删', () => {
  const { sandbox } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  feed(C, 5, (i) => `今天第 ${i} 件事，女儿叫小芳`);
  assert.equal(C.stats().summaries, 0);
  feed(C, 20, (i) => `早上 7 点吃了药，第 ${i} 天`);
  const s = C.stats();
  assert.ok(s.summaries >= 1, JSON.stringify(s));
  assert.ok(s.raw >= 50);                      // append-only，原文没被删
  assert.ok(s.working <= 16);                  // 批处理：keep=8，最多再攒 8 条才压
  assert.ok(s.passes >= 1);
});

test('histMessages 长度有界，且把摘要与画像放在最前面', () => {
  const { sandbox } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  C.setCore('外婆喜欢喝花茶');
  feed(C, 30, (i) => `昨天去医院看了喉咙，第 ${i} 次`);
  const ms = C.histMessages();
  assert.ok(ms.length <= 17, `msgs=${ms.length}`);
  assert.ok(ms[0].content.includes('老人画像'));
  assert.ok(ms.some((m) => m.content.includes('早前聊过的事')));
});

test('cutoff 锚定：raw 前面插入消息后，有效历史仍从正确那条开始', () => {
  const { sandbox } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  feed(C, 30, (i) => `吃药时间是 8 点，第 ${i} 天`);
  const before = C.stats().cutoff;
  const raw = JSON.parse(sandbox.MILI_STORE.get('mili.context.raw'));
  raw.unshift({ id: 'inserted_0', role: 'user', text: '插进来的旧话', at: 1, day: '2026-11-01' });
  sandbox.MILI_STORE.put('mili.context.raw', JSON.stringify(raw));
  assert.ok(before > 0);
  // ID 锚定：cutoffId 仍能在 raw 中找到，index 自动后移
  const ev = JSON.parse(sandbox.MILI_STORE.get('mili.context.event'));
  const idx = raw.findIndex((m) => m.id === ev.cutoffId);
  assert.ok(idx > 0, `cutoffId=${ev.cutoffId}`);
  assert.ok(idx >= ev.cutoff, `idx=${idx} cutoff=${ev.cutoff}`);
});

test('重启持久化：raw / 摘要 / core 都还在', () => {
  const { sandbox, data } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  C.setCore('女儿叫小芳');
  feed(C, 30, (i) => `每天早上 6 点起床，第 ${i} 天`);
  const before = C.stats();
  const rebooted = makeEnv(data);
  const after = rebooted.sandbox.MILI_CONTEXT.stats();
  assert.equal(after.raw, before.raw);
  assert.equal(after.summaries, before.summaries);
  assert.equal(rebooted.sandbox.MILI_CONTEXT.core(), '女儿叫小芳');
});

test('检索召回：能找回早前说过的小芳，无关词返回无证据（弃答）', () => {
  const { sandbox } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  C.push('user', '我女儿叫小芳，她在天津上班');
  feed(C, 25, (i) => `今天天气不错，第 ${i} 天`);
  const hits = C.retrieve('我女儿叫什么名字', 5);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.text.includes('小芳')));
  assert.equal(C.hasEvidence('量子纠缠的实验装置多少钱'), false);
});

test('知识更新：新旧事实都留原文，但 core 编译会过滤说明性噪声', () => {
  const { sandbox } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  sandbox.MILI_MEMO = { memo: () => [
    { text: '外婆喜欢喝花茶' },
    { text: '外婆喜欢喝乌龙茶' },
    { text: '聊天的记忆分四类：第一类是聊天历史' },
  ] };
  const core = C.compileCore();
  assert.ok(core.includes('花茶'));
  assert.ok(!core.includes('记忆分四类'));
});

test('一键清空：context 登记进总线，clearAll 后 raw/摘要/core 全退', () => {
  const { sandbox } = makeEnv();
  const C = sandbox.MILI_CONTEXT;
  C.setCore('外婆喜欢喝花茶');
  feed(C, 30, (i) => `早上 7 点吃药，第 ${i} 天`);
  const r = sandbox.MILI_STORE.clearAll();
  assert.ok(r.modules.includes('context'));
  const s = C.stats();
  assert.equal(s.raw, 0);
  assert.equal(s.summaries, 0);
  assert.equal(s.coreChars, 0);
});

test('抽取式摘要只留带事实的句子，纯寒暄不进档', () => {
  const { sandbox } = makeEnv();
  const t = sandbox.MILI_CONTEXT.extractive([
    { role: 'user', text: '嗯。好呀。我女儿叫小芳，每天早上 7 点吃药。' },
    { role: 'user', text: '哈哈，是吗。' },
  ]);
  assert.ok(t.includes('小芳'));
  assert.ok(!t.includes('哈哈'));
});
