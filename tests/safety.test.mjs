/* 回归护栏：2026-11-14 修掉的三个用户可见问题，任何一条挂了都说明回归。
   跑法：node --test tests/safety.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const app = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
const agent = fs.readFileSync(path.join(APP, 'agent.js'), 'utf8');

test('系统成年女声：全站不再有任何真实的系统 TTS 调用', () => {
  const calls = [...app.matchAll(/\b(?:nn|n)\.speak\s*\(|speechSynthesis\.speak\s*\(/g)];
  assert.equal(calls.length, 0, `还有 ${calls.length} 处真实调用`);
  const fn = app.slice(app.indexOf('function nativeTTS('), app.indexOf('function nativeTTS(') + 700);
  assert.ok(!/\.speak\s*\(/.test(fn), 'nativeTTS 仍在调系统 TTS');
  assert.ok(/静音兜底/.test(fn), 'nativeTTS 应明确改为静音兜底');
});

test('报时与捎句话：不再二次播报', () => {
  /* 只查真实代码，别被注释里「删掉 nn.speak」的说明文字误伤 */
  const clock = app.slice(app.indexOf('function bindSpeakTime'), app.indexOf('function bindSpeakTime') + 600);
  assert.ok(!/const nn = NATIVE\(\)/.test(clock), '点时钟仍取原生 TTS 双播');
  const seg = app.slice(app.indexOf('const fireNote'), app.indexOf('const fireNote') + 700);
  assert.ok(!/try\s*\{\s*if\s*\(typeof nativeTTS/.test(seg), '捎句话仍重复播报');
});

test('闲聊：不再把工具摘光，只挂 3 个只读工具', () => {
  assert.ok(/const want = \['tell_time', 'recall', 'remember'\]/.test(app));
  assert.ok(/本轮只挂只读工具/.test(app));
  assert.ok(!/\[CHAT\] 这句是纯闲聊，本轮不挂工具/.test(app));
});

test('busy：显式 return，不再落到本地兜底说没听清', () => {
  assert.ok(/if \(r && r\.err === 'busy'\)[\s\S]{0,220}return r;/.test(app));
  assert.ok(!/: '我没听清，您再说一遍\？'/.test(agent), '空回复还在说没听清');
  assert.ok(/'我在呢，您接着说呀。'/.test(agent));
});

test('提示词：闲聊时不许提工具、不许说没工具可调', () => {
  assert.ok(/不要说「没工具可调」「我没有这个功能」/.test(agent));
});

test('农历：全站单一实现，问法覆盖初几/老历，农历问句不被排除词挤走', () => {
  assert.ok(!app.includes("dateStyle: 'long'"), '本地农历还有第二套 Intl 实现');
  assert.ok(app.includes('if (window.lunarCN) return window.lunarCN(d);'));
  assert.ok(app.includes('const askLunar = /农历|阴历|老历|初几/'));
  assert.ok(app.includes('const LUNAR_Q = /农历|阴历|老历|初几/'));
});

test('农历毒规则断根：日期问句跳过 findRule，也不许再学成问答规则', () => {
  assert.ok(app.includes('const DATE_SKIP_RULE'), 'findRule 仍在抢日期问句');
  assert.ok(app.includes('const rule = (DATE_SKIP_RULE.test(raw)'));
  assert.ok(app.includes('&& !/提醒|闹钟/.test(qq)) return null;'), '日期问句仍会学成规则');
  assert.ok(app.includes("/农历|阴历|几号|几月几|星期几|几点|什么日子/.test(String((r && r.q)"), '开机未清日期毒规则');
});

test('首句提速：闲聊走精简 systemPrompt、单轮、小 token 预算', () => {
  assert.ok(agent.includes('if (opts && opts.lite)'), '精简提示词没接上');
  assert.ok(agent.includes('const rounds = (opts && opts.lite) ? 1 : CFG.maxRounds'));
  assert.ok(agent.includes('maxTokens: (opts && opts.lite) ? 140'));
  assert.ok(app.includes('lite: Array.isArray(voiceTools)'));
  assert.ok(agent.includes('const _hist = (opts && opts.lite)'), '闲聊轮没裁历史');
  assert.ok(app.includes('const GREET_FAST = {'), '寒暄 0ms 直答表缺失');
  assert.ok(app.includes('__bootAt = Date.now();'), '开机预热缺失');
});

test('公开仓凭据：必须是脱敏版，防止真 key 被提交', () => {
  assert.equal((app.match(/123\.56\.202\.41/g) || []).length, 0);
  assert.equal((agent.match(/sk-[A-Za-z0-9]{20,}/g) || []).length, 0);
});
