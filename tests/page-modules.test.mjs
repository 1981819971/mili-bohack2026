/* 构建清单一致性：三处产物（单文件 / server / APK assets）必须与 index.html 同源。
 *
 * 这类 bug 的共同点是「不崩，只是慢慢变空」：
 * 新增 context.js / tool-router.js / stream-speak.js 时三处手写清单全漏，
 * 产物静默退回旧行为（没有 BM25、没有三层记忆、没有流式）。
 * 这里锁死两件事：
 *   ① index.html 引用的本地模块，解析结果必须完整；
 *   ② build.mjs 必须用解析结果，而不是再手写一份数组。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageModules } from '../tools/page-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');

test('index.html 的本地模块清单完整，且顺序就是加载顺序', () => {
  const mods = pageModules(html);
  assert.deepEqual(mods, [
    'memory.js', 'context.js', 'evolve.js', 'agent-memo.js', 'agent-tools.js',
    'tool-router.js', 'stream-speak.js', 'agent.js', 'app.js',
  ]);
  for (const f of ['context.js', 'tool-router.js', 'stream-speak.js', 'app.js']) {
    assert.ok(mods.includes(f), `解析结果漏了 ${f}`);
  }
});

test('build.mjs 三处清单都来自 pageModules，不再手写模块数组', () => {
  const build = fs.readFileSync(path.join(ROOT, 'app', 'build.mjs'), 'utf8');
  assert.match(build, /pageModules\(html\)/, 'build.mjs 没有使用 index.html 解析结果');
  assert.match(build, /PAGE_MODULES/, 'build.mjs 没有 PAGE_MODULES');
  /* 旧的手写清单特征：单文件版只列 4 个模块、server 只列 3 个。 */
  assert.ok(!/R\('\.\/memory\.js'\),\s*\n\s*R\('\.\/agent-memo\.js'\)/.test(build),
    'build.mjs 里还留着单文件版的手写模块数组');
  assert.ok(!/for \(const f of \['agent-memo\.js', 'agent-tools\.js', 'agent\.js'\]\)/.test(build),
    'build.mjs 里还留着 server 版的手写模块数组');
});
