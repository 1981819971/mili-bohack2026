/* ============================================================================
 * eval/run-eval.mjs — 工具选择 + 长期记忆的回归基准
 *
 * 跑法（仓库根目录）：node eval/run-eval.mjs
 * 产物：eval/results.json
 *
 * 方法对齐：
 *   BFCL（AST 级工具选择）→ 首个工具命中率 / Recall@k / MRR；
 *   LongMemEval（ICLR 2025）→ 信息抽取 / 多会话 / 时序 / 知识更新 / 弃答；
 *   RAG-MCP → 检索前后注入工具数与 prompt 体积对比。
 *
 * 🚨 口径红线：这些数字只作**不变量校验与回归门禁**，不作进化证据，
 *    不进宣传片、不写进「第二次比第一次好」的叙事。
 *    eval/heldout.json 的 cases 赛前冻结，本脚本一个字都不改它。
 * ========================================================================== */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const EVAL = path.join(ROOT, 'eval');

function makeEnv() {
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const s = { localStorage, console: { log() {}, warn() {}, error() {} },
              Math, JSON, Date, Promise, setTimeout, clearTimeout };
  s.window = s; s.globalThis = s;
  vm.createContext(s);
  for (const f of ['memory.js', 'context.js', 'agent-memo.js', 'agent-tools.js', 'tool-router.js']) {
    vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), s, { filename: f });
  }
  return s;
}

/* ---------- 1. 工具选择基准（held-out 31 句，冻结） ---------- */
function toolSelection(s) {
  const held = JSON.parse(fs.readFileSync(path.join(EVAL, 'heldout.json'), 'utf8'));
  const all = s.MILI_TOOLS.schema();
  const allNames = all.map((t) => t.function.name);
  const fullChars = JSON.stringify(all).length;
  let firstHit = 0, recall = 0, rr = 0, toolsSum = 0, fallback = 0;
  let actN = 0, noToolN = 0;
  const details = [];
  for (const c of held.cases) {
    const r = s.MILI_TOOL_ROUTER.select(c.q, { minScore: 0 });
    if (r.fallback) fallback++;
    toolsSum += r.tools.length;
    const ranked = Object.keys(r.scores).sort((a, b) => r.scores[b] - r.scores[a]);
    const want = c.want || [];
    const rank = ranked.findIndex((n) => want.includes(n));
    /* want 为空＝这句话**不该调工具**（「你是谁呀」「把这个弄一下」）。
       它不是未命中，也不该进首个命中的分母 —— 否则 5 句必然算错，
       真实命中率被自己压低 14 个百分点。这类题单独记数量，
       由「不调工具」的专项测试去管，不混进工具选择准确率。 */
    if (want.length) {
      actN++;
      if (rank === 0) firstHit++;
      if (rank >= 0) { recall++; rr += 1 / (rank + 1); }
    } else {
      noToolN++;
    }
    const inSelected = want.some((n) => r.names.includes(n));
    details.push({ id: c.id, cat: c.cat, q: c.q, want: want,
                   top: ranked[0] || null, rank: rank < 0 ? null : rank + 1,
                   inSelected: inSelected, tools: r.tools.length, fallback: r.fallback });
  }
  const allN = held.cases.length;
  const n = actN || 1;   // 分母只算「确实该调工具」的句子
  return {
    cases: allN, actCases: actN, noToolCases: noToolN,
    firstToolHitRate: +(firstHit / n).toFixed(4),
    recallAtK: +(recall / n).toFixed(4), mrr: +(rr / n).toFixed(4),
    avgToolsInjected: +(toolsSum / allN).toFixed(2),
    fallbackRate: +(fallback / allN).toFixed(4),
    fullToolCount: allNames.length,
    fullSchemaChars: fullChars,
    approxCharsAfterRouting: Math.round(fullChars * (toolsSum / allN) / allNames.length),
    details,
  };
}

/* ---------- 2. 长期记忆探针（LongMemEval 风格） ---------- */
function memoryProbes(s) {
  const d = JSON.parse(fs.readFileSync(path.join(EVAL, 'memory-probes.json'), 'utf8'));
  const C = s.MILI_CONTEXT, M = s.MILI_MEMO;
  /* 灌会话原文 */
  d.sessions.forEach((sess) => sess.turns.forEach(([role, text]) => C.push(role, text, sess.day)));
  /* 模拟事实抽取写入（真实链路由 agent 的 remember 工具做） */
  d.sessions.forEach((sess) => sess.turns.forEach(([role, text]) => {
    if (role === 'user' && /(叫|喜欢|去|看的是|吃药|改喝)/.test(text)) M.add('fact', text, '老人说的');
  }));
  C.compileCore();
  /* 强制压一次，检验压缩后还能不能召回 */
  C.compact(true);

  let hit = 0, top1Hit = 0, abstainOk = 0, kuOk = 0, kuTotal = 0;
  const details = [];
  for (const p of d.probes) {
    const r = C.retrieve(p.q, 5);
    /* day 也纳入匹配：时序推理考的就是「哪天」，证据里的时间戳必须可见。 */
    const texts = r.map((x) => (x.day ? x.day + ' ' : '') + x.text).join(' ｜ ');
    let ok;
    if (p.expectAbstain) {
      const noEvidence = !C.hasEvidence(p.q);
      ok = noEvidence;
      if (ok) abstainOk++;
    } else if (p.wantAny) {
      ok = p.wantAny.every((x) => texts.includes(x));
    } else {
      ok = texts.includes(p.want);
      /* LongMemEval 官方 knowledge-update 判定：答案给的是更新后的值即可，
         即便同一条证据里顺带提到旧值也算对，不要求「不含旧值」。 */
      if (p.type === 'knowledge-update') {
        kuTotal++;
        ok = ok && !!(r[0] && r[0].text.includes(p.want));
        if (ok) kuOk++;
      }
    }
    if (ok) hit++;
    if (r[0] && p.want && r[0].text.includes(p.want)) top1Hit++;
    details.push({ id: p.id, type: p.type, q: p.q, ok: ok,
                   top1: r[0] ? r[0].text.slice(0, 70) : null, hits: r.length });
  }
  const n = d.probes.length;
  const abstainTotal = d.probes.filter((p) => p.expectAbstain).length;
  return {
    probes: n, overallAccuracy: +(hit / n).toFixed(4),
    top1Recall: +(top1Hit / (n - d.probes.filter((p) => p.expectAbstain).length || 1)).toFixed(4),
    abstainAccuracy: +(abstainOk / (abstainTotal || 1)).toFixed(4),
    knowledgeUpdateTop1: +(kuOk / (kuTotal || 1)).toFixed(4),
    contextStats: C.stats(), details,
  };
}

const s = makeEnv();
const tools = toolSelection(s);
const memory = memoryProbes(s);
const result = {
  at: new Date().toISOString(),
  disclaimer: '只作不变量校验与回归门禁，不作进化证据；held-out cases 赛前冻结未改',
  method: { toolSelection: 'BFCL 式首个工具命中 / Recall@k / MRR + RAG-MCP 检索前后体积',
            memory: 'LongMemEval 五能力本地化小集 + Recall@5 / 弃答率 / 知识更新新值优先' },
  tools, memory,
};
fs.writeFileSync(path.join(EVAL, 'results.json'), JSON.stringify(result, null, 2));

console.log(`=== 工具选择（held-out ${tools.cases} 句，其中该调工具 ${tools.actCases} 句；另有 ${tools.noToolCases} 句不该调，不计入分母）===`);
console.log(`首个工具命中 ${tools.firstToolHitRate}  Recall@k ${tools.recallAtK}  MRR ${tools.mrr}`);
console.log(`平均注入工具 ${tools.avgToolsInjected}/${tools.fullToolCount}  低置信度退回全量 ${tools.fallbackRate}`);
console.log(`schema 体积 ${tools.fullSchemaChars} → 约 ${tools.approxCharsAfterRouting} 字符`);
console.log('=== 长期记忆（LongMemEval 风格 10 题）===');
console.log(`总体 ${memory.overallAccuracy}  top1 召回 ${memory.top1Recall}  弃答 ${memory.abstainAccuracy}  知识更新 ${memory.knowledgeUpdateTop1}`);
console.log(`压缩状态 ${JSON.stringify(memory.contextStats)}`);
console.log('=== 未命中明细 ===');
console.log(JSON.stringify(memory.details.filter((x) => !x.ok), null, 1));
console.log('\n⚠ 只作回归门禁，不作进化证据。结果已写 eval/results.json');
