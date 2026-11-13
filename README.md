# 米粒 Mili

装在老人手机上的助手。它记得住。

BoHack 2026 · 日新主题赛道（Built for Better）参赛作品。
本仓库用于赛事「既有代码申报」：2026-11-13 14:00 之前的提交是开赛前代码基线，之后的提交均为 42 小时赛期内产出。

## 是什么

一台 Android 手机装上米粒后，老人喊一声就能打电话、发微信、放电视、提醒吃药、通知家人。
它自己从老人的改口与作息里学会「这句话等于这个动作」；学的每一条都带版本快照、全量回归和一键回退。

## 架构

- `app/app.js`：WebView 前端**唯一真源**（页面、语音、家人端、引导、作息画像）。单文件版由 `build.mjs` 现场生成，不再手工维护第二份 13000 行副本
- `app/memory.js`：统一记忆总线，`MILI_STORE.clearAll()` 是唯一的一键清空入口
- `app/agent-memo.js`：事实记忆与成功工具序列，ADD-only 写入 + validity window
- `app/agent.js` / `app/agent-tools.js`：直连大模型做工具选择，67 个工具，`MILI_TOOLS.has()` 白名单校验
- `app/evolve.js`：**DEPRECATED**，11-07 旧意图正则引擎，仅断网兜底，默认关闭
- `android/` 原生层：离线唤醒 sherpa-onnx、流式 ASR、TTS、无障碍代操作、桌宠、状态备份
- `eval/`：31 句 held-out 回归门禁（promptfoo 断言），只作不变量校验，不作进化证据
- `backend/`：ECS 9001 服务端实现 —— 账号/配对/药箱/健康数据（`mili_auth.py`）、语音识别与状态同步（`asr_server.py`）、开发服务器与豆包 TTS
- `docs/BUILD.md`：现在能跑什么、还缺哪些二进制素材与本机配置（逐项清单）
- `docs/BACKEND-CONTRACT.md`：全部后端接口、数据落点、本机与服务端边界、安全边界
- `tests/memory.test.mjs`：纯 Node 回归测试；`CONTRIBUTING.md` 是 3 人协作与上手说明

## 运行

Android Studio 打开 `android/`，需自备大模型 API Key 与 ASR/TTS 服务配置。
仓库内所有密钥、服务器地址、手机号均已替换为占位符，**不能开箱即用**——这是刻意的脱敏，评审请以现场真机为准。

## 评测口径

见 `eval/README.md`。31 句是老人说法整理版；同一份集、代码没改，两次跑会漂 1 句。
因此本项目**不拿分数涨幅当进化证据**，主证据是单句因果链：
Run1 追问 → 现场一次反馈 → Run2 直达 → 点回退 → 第三次又问。

## 申报

见 `SUBMISSION.md`。开赛前已有内容＝本仓库在 2026-11-13 14:00 之前的全部提交；
2026-11-13 14:00 之后的所有提交均在 42 小时赛期内产生。

供 BoHack 2026 评审与「刺客伍六七」队伍内部协作使用。
