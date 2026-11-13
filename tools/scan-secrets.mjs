/* 提交前敏感串自检。命中任意一条即以非零退出码失败。
   跑法：npm run scan
   只扫文本内容，不打印命中串本身（避免把密钥带进 CI 日志）。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR = new Set(['.git', 'node_modules', 'build', 'dist']);
const SELF = path.resolve(ROOT, 'tools', 'scan-secrets.mjs');

const RULES = [
  ['真实 API key', /sk-(?!REPLACE_WITH_YOUR_OWN_KEY)[A-Za-z0-9]{20,}/],
  ['ECS 地址', /123\.56\.202\.41/],
  ['状态接口口令', /[?&]k=(?!YOUR_STATE_KEY)[A-Za-z0-9_-]{8,}/],
  ['阿里云 AccessKey', /LTAI[A-Za-z0-9]{12,}/],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{24,}/],
  /* 白名单是 UI 里的两个占位示例号；(?<!\d) 会把
     「By / 1068707153301001181」这种短信通道号中间的数字段排除掉。 */
  ['真实手机号', /(?<!\d)(?!13800000000|13800138000)1[3-9]\d{9}(?!\d)/],
  ['学号', /2513976/],
  ['第三方中转域名', /6\.6666166\.xyz/],
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

let hits = 0;
let files = 0;
for (const file of walk(ROOT)) {
  if (path.resolve(file) === SELF) continue;   // 跳过规则文件自身
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  files++;
  for (const [label, re] of RULES) {
    const n = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (n && n.length) {
      hits += n.length;
      console.error(`  !! ${path.relative(ROOT, file)}  [${label}] x${n.length}`);
    }
  }
}

if (hits) {
  console.error(`\n敏感串扫描失败：${files} 个文件里命中 ${hits} 处。修掉再提交。`);
  process.exit(1);
}
console.log(`敏感串扫描通过：${files} 个文件，0 命中。`);
