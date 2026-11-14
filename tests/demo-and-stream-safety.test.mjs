/* 静态回归：演示模式三条硬规矩 + 流式首句起播的接线。
   这些是 2026-11-14 菲尔特在真机上亲眼看出来的问题，改完用断言焊死，
   免得下次改前端又被覆盖回去。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const app = norm('app/app.js');
const agent = norm('app/agent.js');
const html = norm('app/index.html');
const css = norm('app/app.css');

test('首页不再自动进演示模式：localStorage 开关位已删', () => {
  assert.ok(!app.includes("getItem('mili_demo_on')"), 'boot 仍在自动恢复演示模式');
  assert.ok(!app.includes("setItem('mili_demo_on'"), 'start 仍在写持久化开关');
  assert.ok(app.includes("localStorage.removeItem('mili_demo_on')"), '开机没清历史遗留开关位');
  assert.ok(app.includes('var D = {\n    on: false,'), '默认必须是关');
});

test('遍数由演示者手动切：forceStep / setStep / 两组按钮', () => {
  assert.ok(app.includes('forceStep: 0'), '缺 forceStep 状态');
  assert.ok(app.includes('if (D.forceStep) return D.forceStep;'), 'stepNow 没尊重手动覆盖');
  assert.ok(app.includes('function setStep(n)'), '缺手动切遍入口');
  assert.ok(app.includes('setStep: setStep,'), 'setStep 没导出，现场没法用 CDP 切');
  assert.ok(app.includes("querySelectorAll('[data-demostep]')"), '按钮没绑事件');
  assert.equal((html.match(/data-demostep=/g) || []).length, 4, 'HUD + 面板各两个按钮');
  assert.ok(html.includes('第 1 遍 · 会追问') && html.includes('第 2 遍 · 直接跳'));
});

test('🔑 专用属性：引导页 9 个 data-step 没被误绑', () => {
  assert.equal((html.match(/data-step=/g) || []).length, 9);
  assert.equal((app.match(/querySelectorAll\('\[data-step\]'\)/g) || []).length, 0);
  assert.ok(app.includes("querySelectorAll('.onb-step')"), '引导页原逻辑还在');
});

test('彻底两遍：HTML 里没有第三遍的任何痕迹', () => {
  assert.ok(!html.includes('共 3'), '提词条还写着共 3');
  assert.ok(html.includes('第 1 遍 / 共 2'));
  assert.ok(!html.includes('data-n="3"'), '面板还有第三行');
  assert.ok(html.includes('<span class="dh-dots" id="dhDots"><i class="on"></i><i></i></span>'));
  assert.ok(!html.includes('说三遍'), '说明文字还说三遍');
  assert.ok(html.includes('这两遍的实测'));
  assert.ok(app.includes('D.runs = { 1: null, 2: null }'));
  assert.ok(app.includes("'第 ' + s + ' 遍 / 共 2'"));
  assert.ok(app.includes('return stepNow() < 2;'), 'blockSkill 只挡第 1 遍');
});

test('切换按钮有样式，且不碰全站配色', () => {
  assert.ok(css.includes('#demoHud .dh-sw'), '缺切换按钮样式');
  assert.ok(css.includes('.ds-sw button.on{background:var(--accent)'));
  assert.ok(!/#[0-9a-fA-F]{6}.*(?:暖黄|orange)/.test(css));
});

test('🔑 改口只记一次：learn() 重复调用会让 3 次阈值提前达成', () => {
  assert.equal((app.match(/MILI_TOOL_ROUTER\.learn\(/g) || []).length, 1,
    '一次改口被记两次 n，两次改口就凑满 3 次升稳定档');
});

test('流式首句起播：onDelta 接回、确定性 streamed、纯说话轮才开', () => {
  assert.ok(!app.includes('onDelta: null,'), '流式还关着');
  assert.ok(app.includes('window.__MILI_NO_STREAM'), '缺现场一键回退开关');
  assert.ok(app.includes('ssFeed(chunk, myTurn)'), 'onDelta 没带 turn 归属');
  assert.ok(app.includes('ssEnd(finalText, myTurn)'), 'onStreamEnd 没带 turn 归属');
  assert.ok(app.includes('r && r.streamed && SS.turn'), 'streamed 还在靠队列状态猜');
  assert.ok(agent.includes('streamed: streamedChars > 0'), '内核没回传 streamed');
  assert.ok(agent.includes('!useTools && !anyFailYet && !riskyFirst'), '挂工具轮没被排除');
  assert.ok(html.includes('stream-speak.js'), 'index.html 没加载新模块');
  assert.ok(app.includes('window.MILI_STREAM'), 'SS 没接新模块');
  assert.ok(app.includes('const id = it.id ||'), '没用稳定 id 对账');
});
