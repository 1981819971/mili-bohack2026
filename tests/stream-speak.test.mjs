/* 纯 Node 回归：流式首句起播的切句 / 幂等 / 对账。
   跑法：node --test tests/stream-speak.test.mjs
   这些断言锁的是 2026-11-08「同一句念两遍」的四个死因：
   尾段重复认领、迟到 delta 复活、finalText 补播、跨轮串音。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

function load() {
  const s = { console, Date, Math, JSON, RegExp, String, Number, Array, Object };
  s.window = s;
  s.globalThis = s;
  vm.createContext(s);
  vm.runInContext(fs.readFileSync(path.join(APP, 'stream-speak.js'), 'utf8'), s, {
    filename: 'stream-speak.js',
  });
  return s.MILI_STREAM;
}

function collect(S, chunks, finalText) {
  const t = S.createTurn('t7');
  const segs = [];
  chunks.forEach((c) => t.feed(c).forEach((x) => segs.push(x)));
  if (finalText !== undefined) t.end(finalText).forEach((x) => segs.push(x));
  return { t, segs, text: segs.map((x) => x.text).join('') };
}

test('首句 5 个字没标点也切出去 —— 不等句号才起播', () => {
  const S = load();
  const r = collect(S, ['我在呢，您'], '我在呢，您接着说呀。');
  assert.ok(r.segs.length >= 1, '首句必须立刻出段');
  assert.ok(r.segs[0].text.length <= 6, '首句要短，实测=' + r.segs[0].text);
  assert.equal(r.segs[0].text, '我在呢，');   // 逗号先切，比硬凑 5 字自然
});

test('首句遇逗号（≥4 字）优先切，不会被 5 字门槛拖住', () => {
  const S = load();
  const r = S.cut('好嘞，我给您看看。', 0, false);
  assert.equal(r.seg, '好嘞，');
  assert.equal(r.rest, '我给您看看。');
});

test('后续句只认强标点，逗号不剁碎合成器', () => {
  const S = load();
  const r = S.cut('我给您看看，等一下啊。还有一句。', 1, false);
  assert.equal(r.seg, '我给您看看，等一下啊。');
  assert.equal(r.rest, '还有一句。');
});

test('连着的标点一起带走，不拆成两段念两次问号', () => {
  const S = load();
  const r = S.cut('真的吗？！后面还有。', 0, false);
  assert.equal(r.seg, '真的吗？！');
  assert.equal(r.rest, '后面还有。');
});

test('一口气 24 字没标点硬切，不无限等', () => {
  const S = load();
  const r = S.cut('一'.repeat(30), 1, false);
  assert.ok(r && r.seg.length === 24);
});

test('force 把没标点的尾巴吐干净 —— 一个字都不丢', () => {
  const S = load();
  const r = collect(S, ['今天天气真不错，', '我陪您聊会儿天'], '今天天气真不错，我陪您聊会儿天');
  const joined = S.norm(r.text);
  assert.equal(joined, S.norm('今天天气真不错，我陪您聊会儿天'));
});

test('🔑 claimedEnd：end() 调三次，尾段只认领一次', () => {
  const S = load();
  const t = S.createTurn('t1');
  t.feed('我在呢，您接着说呀');
  const a = t.end('我在呢，您接着说呀');
  const b = t.end('我在呢，您接着说呀');
  const c = t.end('我在呢，您接着说呀');
  assert.ok(a.length >= 1, '第一次要 flush 尾巴');
  assert.equal(b.length, 0, '第二次必须为空');
  assert.equal(c.length, 0, '第三次必须为空');
});

test('🔑 收尾之后的迟到 delta 一律不收（late-settle suppression）', () => {
  const S = load();
  const t = S.createTurn('t2');
  t.feed('我在呢');
  t.end('我在呢');
  const late = t.feed('，您接着说呀。乖乖');
  assert.equal(late.length, 0);
  assert.ok(t.stats().claimedEnd);
});

test('🔑 finalText 与已念文本一致时不补播（11-08 念两遍的断点）', () => {
  const S = load();
  const t = S.createTurn('t3');
  const first = t.feed('我在呢，您接着说呀。');
  const tail = t.end('我在呢，您接着说呀。');
  assert.equal(tail.length, 0);
  assert.equal(t.reconcile.matched, true);
  assert.equal(first.map((x) => x.text).join(''), '我在呢，您接着说呀。');
});

test('🔑 finalText 被 guardHonest 整体改写：不补播，只留对账记录', () => {
  const S = load();
  const t = S.createTurn('t4');
  t.feed('电视打开啦。');
  const tail = t.end('这我没办成，您再说一遍？');
  assert.equal(tail.length, 0, '补播就变回念两遍');
  assert.equal(t.reconcile.matched, false);
  assert.equal(t.reconcile.finalText, '这我没办成，您再说一遍？');
});

test('模型紧贴复读 ≥12 字：砍掉第二遍，不再念第三遍', () => {
  const S = load();
  const line = '今天天气真不错呀，我陪您聊会儿天。';
  const t = S.createTurn('t5');
  t.feed(line);
  const again = t.feed(line);
  assert.equal(again.length, 0);
  assert.equal(t.stats().dup, true);
  assert.equal(t.feed('后面再长一句也别念了。').length, 0);
});

test('稳定 id 唯一、带 turn 归属、seq 单调递增', () => {
  const S = load();
  const r = collect(S, ['我在呢，您接着说呀。', '今天天气真不错。', '咱们慢慢聊。'], undefined);
  const ids = r.segs.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((x) => x.indexOf('t7-') === 0));
  assert.deepEqual([...r.segs.map((x) => x.seq)].sort((a, b) => a - b),
    r.segs.map((x) => x.seq));
  assert.ok(r.segs.every((x) => x.turn === 't7'));
});

test('两轮互不影响：各自的 turn 独立，空 chunk / 空 buf 不炸', () => {
  const S = load();
  const a = S.createTurn('a');
  const b = S.createTurn('b');
  assert.equal(a.feed('').length, 0);
  assert.equal(S.cut('', 0, true), null);
  a.feed('第一轮的半句');
  b.feed('第二轮的另一句');
  assert.notEqual(a.stats().spoken, b.stats().spoken);
  assert.equal(a.stats().claimedEnd, false);
  assert.equal(b.stats().claimedEnd, false);
});
