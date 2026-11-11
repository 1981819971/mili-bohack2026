/* 把 eval/run-*.json 转成 promptfoo 的 --model-outputs 输入。
   判分引擎用 promptfoo，不在这里重写；本脚本只做数据适配 + 打桩标记。
   用法：node eval/make-outputs.mjs [--file eval/run-xxx.json] [--run2]
   */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.resolve(HERE, ...p);

const argv = process.argv.slice(2);
const fileArg = argv.indexOf('--file');
const useRun2 = argv.includes('--run2');
const file = fileArg >= 0
  ? path.resolve(argv[fileArg + 1])
  : fs.readdirSync(HERE)
      .filter((f) => /^run-.*\.json$/.test(f))
      .sort()
      .map((f) => P(f))
      .pop();

if (!file || !fs.existsSync(file)) {
  console.error('找不到 run-*.json，先用 node _chick/eval-run.mjs 跑一次评测');
  process.exit(1);
}

const run = JSON.parse(fs.readFileSync(file, 'utf8'));
const set = useRun2 ? run.run2 : run.run1;
if (!set || !Array.isArray(set.rows) || !set.rows.length) {
  console.error('这一轮没有逐句 rows：' + (useRun2 ? 'run2' : 'run1'));
  if (useRun2) console.error('历史 run-*.json 的 run2 只存了 passed/rate，没有 rows。要逐句证据得重跑 _chick/eval-run.mjs 并补存 run2.rows。');
  process.exit(1);
}

/* 评测脚本 _chick/eval-run.mjs 第 22-35 行把工具调用全部打桩，
   只有 remember/recall 走真实现。stub 是「没有真拨号 / 真发微信」的代理判据，
   assert.js 会检查它；现场真机跑的结果不带这个标记，应当判失败，不许混进回归。 */
const outputs = set.rows.map((r) => JSON.stringify({
  id: r.id,
  cat: r.cat || '',
  q: r.q || '',
  want: r.want || [],
  got: r.got || '',
  ok: !!r.ok,
  ms: Number(r.ms) || 0,
  err: r.err || '',
  stub: true,
  phase: useRun2 ? 'RUN2' : 'RUN1',
  source: path.basename(file),
}));

const out = P('outputs.json');
fs.writeFileSync(out, JSON.stringify(outputs, null, 1), 'utf8');
console.log(`${path.basename(file)} · ${useRun2 ? 'RUN2' : 'RUN1'} · ${outputs.length} 条 → eval/outputs.json`);
