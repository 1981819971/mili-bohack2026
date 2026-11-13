/* 端到端契约（纯 Node，不需要真机）：
   mock 一条 DeepSeek SSE 流 → 真跑 MILI_AGENT.run() → onDelta 喂给 MILI_STREAM
   → onStreamEnd 收尾 → 断言 r.streamed / 不丢字 / 尾段不重发 / 不补播。
   锁的是 2026-11-08「同一句念两遍」在真机上没法自动回归的那一环。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

/* 一条 SSE 响应：正文逐字吐，末尾给 finish_reason + usage。 */
function fakeSSE(chunks, reply) {
  const parts = [];
  chunks.forEach((c) => parts.push('data: ' + JSON.stringify({
    choices: [{ delta: { content: c }, index: 0, finish_reason: null }],
  }) + '\n\n'));
  parts.push('data: ' + JSON.stringify({
    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
  }) + '\n\n');
  parts.push('data: ' + JSON.stringify({
    choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 },
  }) + '\n\n');
  parts.push('data: [DONE]\n\n');
  const bytes = new TextEncoder().encode(parts.join(''));
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: bytes });
          },
        };
      },
    },
    text: async () => reply || '',
  };
}

function makeEnv(chunks, opts = {}) {
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    key: (i) => [...data.keys()][i],
    get length() { return data.size; },
  };
  const calls = [];
  const s = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Promise, RegExp, String, Number, Array, Object,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, TextDecoder, TextEncoder, URL,
    localStorage,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(fakeSSE(chunks));
    },
    document: {
      readyState: 'complete', addEventListener() {},
      querySelectorAll: () => [], getElementById: () => null,
      documentElement: { className: '' }, hidden: false,
    },
    navigator: {}, location: { href: 'file:///index.html' },
  };
  s.window = s;
  s.globalThis = s;
  vm.createContext(s);
  ['memory.js', 'context.js', 'agent-tools.js', 'tool-router.js', 'stream-speak.js', 'agent.js']
    .forEach((f) => vm.runInContext(read(f), s, { filename: f }));
  return { s, calls, data };
}

const REPLY = '我在呢，您接着说呀。';
const CHUNKS = [...REPLY];

test('纯说话轮才开流式；内核回传 streamed=true', async () => {
  const { s } = makeEnv(CHUNKS);
  const got = [];
  const r = await s.MILI_AGENT.run('你好呀', {
    tools: false, lite: true,
    onDelta: (c) => got.push(c),
    onStreamEnd: () => {},
  });
  assert.equal(r.err, null, 'err=' + r.err);
  assert.equal(r.said, REPLY);
  assert.equal(r.streamed, true, '必须回传确定性 streamed 标记');
  assert.ok(got.length >= 2, 'onDelta 至少被调 2 次，实际=' + got.length);
  assert.equal(got.join(''), REPLY, '增量拼接必须等于最终文本');
});

test('🔑 端到端不丢字：切出的段拼起来 == r.said，且 id 不重复', async () => {
  const { s } = makeEnv(CHUNKS);
  const turn = s.MILI_STREAM.createTurn('r1');
  const segs = [];
  const r = await s.MILI_AGENT.run('你好呀', {
    tools: false, lite: true,
    onDelta: (c) => turn.feed(c).forEach((x) => segs.push(x)),
    onStreamEnd: (finalText) => turn.end(finalText).forEach((x) => segs.push(x)),
  });
  const joined = segs.map((x) => x.text).join('');
  assert.equal(s.MILI_STREAM.norm(joined), s.MILI_STREAM.norm(r.said));
  assert.ok(segs.length >= 2, '首句必须提前切出，实际段数=' + segs.length);
  assert.equal(new Set(segs.map((x) => x.id)).size, segs.length);
  assert.equal(turn.reconcile.matched, true);
});

test('🔑 onStreamEnd 被重复调用（内核重试）尾段不重发', async () => {
  const { s } = makeEnv(CHUNKS);
  const turn = s.MILI_STREAM.createTurn('r2');
  const segs = [];
  let endCalls = 0;
  const r = await s.MILI_AGENT.run('你好呀', {
    tools: false, lite: true,
    onDelta: (c) => turn.feed(c).forEach((x) => segs.push(x)),
    onStreamEnd: (f) => {
      endCalls++;
      turn.end(f).forEach((x) => segs.push(x));
      turn.end(f).forEach((x) => segs.push(x));   // 模拟重复回调
      turn.end(f).forEach((x) => segs.push(x));
    },
  });
  assert.equal(endCalls, 1, '内核只应报一次说完');
  assert.equal(s.MILI_STREAM.norm(segs.map((x) => x.text).join('')),
    s.MILI_STREAM.norm(r.said), '重复回调不能多吐一个字');
  assert.equal(turn.stats().claimedEnd, true);
});

test('🔑 前端补播判据：r.streamed + 有段 ⇒ 绝不 say() 第二次', async () => {
  const { s } = makeEnv(CHUNKS);
  const turn = s.MILI_STREAM.createTurn('r3');
  const segs = [];
  const r = await s.MILI_AGENT.run('你好呀', {
    tools: false, lite: true,
    onDelta: (c) => turn.feed(c).forEach((x) => segs.push(x)),
    onStreamEnd: (f) => turn.end(f).forEach((x) => segs.push(x)),
  });
  const streamed = !!(r && r.streamed && (turn.segments.length || turn.spoken));
  assert.equal(streamed, true);
  assert.equal(segs.length >= 2, true);
  assert.equal(turn.reconcile.unread, '', '一致文本不应产生未读尾部');
});

test('挂工具的轮次不流式：模型可能半句转头办事', async () => {
  const { s } = makeEnv(CHUNKS);
  const got = [];
  const r = await s.MILI_AGENT.run('给闺女发微信说我挺好的', {
    lite: false,
    onDelta: (c) => got.push(c),
    onStreamEnd: () => {},
  });
  assert.equal(r.streamed, false, '第 0 轮挂工具时必须憋着');
  assert.equal(got.length, 0);
  assert.equal(r.said, REPLY, '整段文本照样在 r.said 里，前端会整段播报');
});
