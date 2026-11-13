# 协作说明（3 人队）

队伍「刺客伍六七」：黄盛田（队长）、黄琰、刘沛卓。
本仓库是**脱敏公开仓**：密钥、服务器地址、手机号、真实联系人、APK 与素材都不在仓内，不能直接跑出可安装的成品。要跑真机，见文末「与真机工程的关系」。

## 上手三步

```bash
npm test     # 记忆层回归，11 条断言，纯 Node 无依赖
npm run check  # 6 个 JS 文件的语法检查
npm run scan   # 敏感串扫描，命中就别提交
```

三条全绿再开工。Node >= 18。

## 代码结构：谁是真源

| 文件 | 职责 |
|---|---|
| `app/app.js` | **前端唯一真源**（约 13000 行）。页面、语音、家人端、引导、作息画像 `MILI_RHYTHM` 都在这里 |
| `app/memory.js` | 统一记忆总线。**唯一的一键清空入口** `MILI_STORE.clearAll()`，另提供本地日期 `localDay()` 与安全写入 `put()` |
| `app/agent-memo.js` | 事实记忆 + 成功工具序列。ADD-only 写入、validity window、阈值召回 |
| `app/agent.js` | 大模型调用、systemPrompt、多轮工具选择、诚实检查 |
| `app/agent-tools.js` | 67 个工具的 schema 与执行，统一返回 `{ok, detail}` |
| `app/evolve.js` | **DEPRECATED**。11-07 旧意图正则引擎，只作断网兜底，默认关闭（`window.__MILI_LEGACY_EVO`） |
| `tests/memory.test.mjs` | 记忆层回归测试 |
| `tools/scan-secrets.mjs` | 提交前敏感串自检 |
| `eval/` | 31 句 held-out 与 promptfoo 断言 |

**别再建第二份 `app.js` 副本。** 历史上 `app_boot.js` 是它的手工拷贝，两份 13000 行只差 35 行却已经逻辑漂移（boot 版停在「满 3 天」，线上版是「3 次或 3 天」）。2026-11-13 起 `build.mjs` 的 `toBoot()` 现场从 `app.js` 生成 boot 版，`app_boot.js` 已删除。改前端只改 `app/app.js`。

## 加载顺序（`app/index.html`）

```
memory.js → evolve.js → agent-memo.js → agent-tools.js → agent.js → app.js (module)
```

`memory.js` 必须第一：另外三个模块会在加载时向总线登记自己的清空回调，晚一步就登记不上，「一键清空」会漏掉它们。

## 记忆机制的三条硬规矩

1. **写入只追加**。同一 key 重复出现只累加 `n`，不覆盖正文；内容变了要走 `supersede(id)` 给旧记录打 `validTo`，再追加新记录。来源：mem0 2026-04 single-pass ADD-only，以及 Graphiti 的 validity window。
2. **删除不物理删**。家人端「单条删」「整页清空」都只打失效戳，`history()` 可追溯。全量清空统一调 `MILI_STORE.clearAll()`，不要自己 `localStorage.removeItem()`。
3. **作息画像与技能是两回事**。`MILI_RHYTHM` 要 ≥3 次或跨 ≥3 天才写进画像；`MILI_MEMO` 的技能办成一次即可复用。对外别说成同一个门槛。

新增记忆模块时，必须调 `MILI_STORE.register(name, { keys, wipe })` 登记，否则一键清空会漏掉它。

## 提交规范

- 一个能说清一句话成果的阶段提交一次。message 写成果，不写 `fix` / `update` / `wip`。
- 提交前跑 `npm test && npm run check && npm run scan`。
- **禁止** `--date` 回溯时间、`--amend`、`rebase -i`、`push --force`。赛事按提交时间戳区分开赛前基线与赛期产出，历史被改写一次整条时间线就不可信。
- **禁止**提交 APK、成片、素材、任何 `sk-` 开头的真 key、ECS 地址、状态口令、真实手机号、学号。`.gitignore` 只挡文件类型，不挡内容。
- 改了脱敏规则记得同步 `tools/scan-secrets.mjs` 与工作区的 `sync_public_repo.py`。

## 31 句回归怎么跑

仓内有 `eval/heldout.json`（31 句）、`eval/assert.js`、`eval/assertions.yaml`、`eval/outputs.json`、`eval/make-outputs.mjs`。
`outputs.json` 的真值来自真机 `MILI_AGENT.run(原话)` 看模型选了哪个工具，**不是**跑 `MILI.intent()` 或 `EVO.match()`——那两个是假验收。
逐句结果落盘后再用 promptfoo 独立断言：

```bash
node eval/make-outputs.mjs
npx promptfoo eval --assertions eval/assertions.yaml --model-outputs eval/outputs.json
```

仓内没有自动跑满 31 句真机的脚本（那需要 Android 设备），别照旧 README 找 `scoreboard.html` 或 `_chick/eval-run.mjs`，两个都不存在。31 句只作回归门禁，**不拿分数涨幅当进化证据**。

## 与真机工程的关系

本仓是**脱敏快照**，真机源码与资源在队长的本地工程，不在 GitHub：

- 缺 `app/vendor/three/`、`app/assets/`（模型、贴图、音频）、`android/app/src/main/assets/` 等大体积资源，所以 `node app/build.mjs` 直接跑会因读不到 `vendor/three/three.module.js` 报错。要构建单文件版，先从真机工程同步这些目录，或改 `build.mjs` 跳过缺失资源。
- `app/agent.js` 的 `DS.key` 是 `sk-REPLACE_WITH_YOUR_OWN_KEY`，`LLM_PRESETS` 只留官方 DeepSeek 与硅基流动。现场通过 `MILI_AGENT.setLLM({...})` 填本机密钥，不进仓。
- 从真机同步代码到本仓必须走脱敏脚本（工作区 `sync_public_repo.py`），逐文件替换后再 `npm run scan`。**不要整目录复制。**

## 别做的事

- 别往 `evolve.js` 加新正则，也别拿它 27 句考卷的分数当进化证据。
- 别把开发日记写进 systemPrompt。历史决策放 `docs/` 或 commit message，提示词只留规则。
- 别让 skill 模糊匹配直接执行副作用工具（`wechat_call` / `send_sms` / `emergency`）。命中即 0ms 重放，没有第二次确认。
