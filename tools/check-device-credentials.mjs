#!/usr/bin/env node
/* ============================================================================
 * 同步护栏：防止「把公开仓脱敏版整文件覆盖到真机」这类事故再发生。
 *
 * 用法：
 *   node tools/check-device-credentials.mjs <app目录> device   # 真机/主项目，必须有真实凭据
 *   node tools/check-device-credentials.mjs <app目录> public   # 公开仓，必须全是占位符
 *
 * 2026-11-13 23:4x 真事故：图快把公开仓 app.js / agent.js 整文件 cp 到
 * assets/web/，当场把真实 DeepSeek key 与 5 处 ECS 地址冲成占位符。
 * 以后任何同步脚本，在写盘前后都必须各跑一次本检查。异常退出码 = 1。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const mode = process.argv[3] || 'device';
if (!dir || !['device', 'public'].includes(mode)) {
  console.error('用法: node tools/check-device-credentials.mjs <app目录> device|public');
  process.exit(2);
}

function read(f) {
  try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return ''; }
}
const app = read('app.js'), agent = read('agent.js');
const st = {
  mode, dir,
  ecs: (app.match(/123\.56\.202\.41/g) || []).length,
  placeholderHost: (app.match(/YOUR_SERVER_HOST/g) || []).length,
  realKey: (agent.match(/sk-[A-Za-z0-9]{20,}/g) || []).length,
  placeholderKey: (agent.match(/REPLACE_WITH_YOUR_OWN_KEY/g) || []).length,
};
let problems = [];
if (!app || !agent) problems.push('app.js / agent.js 读不到，目录不对');
if (mode === 'device') {
  if (st.ecs < 1) problems.push('真机目录缺少 ECS 地址（疑似被脱敏版覆盖）');
  if (st.realKey < 1) problems.push('真机目录缺少真实 DeepSeek key');
  if (st.placeholderHost > 0) problems.push('真机目录出现 YOUR_SERVER_HOST 占位符');
  if (st.placeholderKey > 0) problems.push('真机目录出现占位 key');
} else {
  if (st.ecs > 0) problems.push('公开仓出现真实 ECS 地址（泄露风险）');
  if (st.realKey > 0) problems.push('公开仓出现真实 key（泄露风险）');
}
console.log(JSON.stringify({ ...st, ok: problems.length === 0, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
