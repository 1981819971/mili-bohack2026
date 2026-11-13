# `app/` — 前端源码

> 2026-11-13 重写。旧版这份文档写的是 11-03 的「单文件版，双击即开」，
> 里面提到的 `米粒.html`、`assets/` 模型、三种小鸡形态、「教一条长一点」
> 全部已经不适用，按它操作只会 404。

## 唯一真源

`app.js`（ES module，约 13000 行）是前端**唯一真源**：页面、语音、家人端、
引导、作息画像 `MILI_RHYTHM` 都在里面。

`app_boot.js` 曾是它的手工副本，两份 13000 行只差 35 行，却已经逻辑漂移
（boot 版停在「满 3 天才写进画像」，线上版是「3 次或 3 天」）。
2026-11-13 起由 `build.mjs` 的 `toBoot()` 现场从 `app.js` 生成 boot 版，
副本已删除。**改前端只改 `app.js`。**

## 加载顺序（`index.html`）

```
memory.js → evolve.js → agent-memo.js → agent-tools.js → agent.js → app.js (module)
```

`memory.js` 必须第一个加载：后面三个模块在初始化时向总线登记自己的
`wipe()`，晚一步就会漏登记，「一键清空」只清到一部分。

## 各文件职责

| 文件 | 干什么 |
|---|---|
| `memory.js` | 统一记忆总线：`clearAll()` 唯一清空入口、`localDay()` 本地日期、`put()` 安全写入 |
| `agent-memo.js` | 事实记忆 + 成功工具序列；ADD-only 写入、validity window、gram 阈值召回 |
| `agent-tools.js` | 67 个工具的 JSON Schema 与执行，统一 `{ok, detail}`；`has()` 做工具名白名单 |
| `agent.js` | 直连 DeepSeek、systemPrompt、多轮工具选择、流式门、诚实检查 |
| `evolve.js` | **DEPRECATED**：11-07 旧意图正则引擎，断网兜底，默认关闭 |
| `app.js` | 前端主程序（含 `MILI_RHYTHM` 作息画像） |
| `build.mjs` | 构建线上版 + 单文件版；从 `app.js` 生成 boot 源码 |
| `index.html` / `app.css` / `design-tokens.css` | 页面骨架与样式 |
| `data.js` / `data_src.js` / `voice_bank.json` | 数据源与语音对照表 |

## 记忆机制

三条硬规矩，详见仓库根 `CONTRIBUTING.md`：

1. **写入只追加**：同 key 只累加 `n`，不覆盖正文；内容变了 `supersede()` 旧的再追加。
2. **删除不物理删**：打 `validTo` 失效戳，`history()` 可追溯；全量清空只走 `MILI_STORE.clearAll()`。
3. **两套门槛别混**：作息画像 >=3 次或跨 >=3 天；技能办成一次即可复用。

## 跑测试与检查（仓库根）

```bash
npm test        # 11 条记忆层回归断言
npm run check   # 6 个 JS 文件语法检查
npm run scan    # 敏感串扫描
```

## 构建

`node app/build.mjs` 需要 `vendor/three/`、`assets/`（模型、贴图、语音）等资源，
这些大体积文件不在本仓（脱敏公开仓）。缺资源时脚本会在读取
`vendor/three/three.module.js` 处报错，属预期行为；从真机工程同步资源目录后再跑。

## 现场配置

`agent.js` 的 `DS.key` 是占位符 `sk-REPLACE_WITH_YOUR_OWN_KEY`。
现场通过 `MILI_AGENT.setLLM({ base, model, key })` 填本机密钥，只落 localStorage，不进仓。
