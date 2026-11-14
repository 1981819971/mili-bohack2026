# 米粒 · 架构与机制说明（2026-11-13 重构版）

> 本文是单一真源。改动 `app/memory.js` / `app/agent-memo.js` / `app/context.js` /
> `app/tool-router.js` / `app/agent.js` 之前先读它。
> 进化口径唯一真源：`knowledge/BOHACK.md §十三`、`参赛手册-日新.md` 文件头 11-11 订正。

---

## 一、运行时形态

**三部分组成**：① Android 原生壳（Java）—— ASR、豆包童声 TTS、无障碍代操作、电话/微信、桌宠；
② Capacitor/WebView 内的纯前端 JS —— Agent 决策、记忆、工具选择；
③ 跑在自建 ECS `:9001` 的 Python 后端 —— 语音识别、TTS 转发、跨设备状态、账号配对、药箱与健康数据。

⚠️ **2026-11-14 口径纠正**：初稿写「无服务端框架、无数据库」是错的，把「Agent 决策链路」当成了整个项目。
准确边界是：**推理 / 记忆 / 工具选择全在前端，后端不参与大模型决策**；但项目**有后端也有数据库**。

| 后端服务 | 技术 | 数据落点 |
|---|---|---|
| `backend/mili_auth.py`（796 行） | FastAPI | **SQLite** `MILI_DB`，默认 `/root/mili-data/mili.db`；表 `users / tokens / links / pairs / meds / acts / tries / vitals` |
| `backend/asr_server.py`（232 行） | FastAPI | 文件 `STATE_DIR`，默认 `/root/mili-state/<dev>.json`，单文件 512KB 上限、原子写 |
| `backend/dev_server.py` | `ThreadingHTTPServer` | 本地开发静态服务 + `/tts` 转发 + `/api/*` 透传，不存业务数据 |
| `backend/doubao_tts.py` | 豆包 TTS 封装 | 不存业务数据 |

前端统一经 `app/_acc_new.js` 的 `MILI_API` 访问；公开仓里 ECS 域名与票据全为占位符。
完整接口表见 `docs/BACKEND-CONTRACT.md`。

大模型走 DeepSeek 官方 `/chat/completions`（**直连，不经过自己的后端，也不走云 SDK**）。
**端上记忆**持久化在 `localStorage`，与服务端 SQLite 是两套独立存储 ——
已知边界：药箱 `S.med` / 健康 `S.vital` 在本机与服务端各存一份，目前没有同步与冲突解决逻辑。
原生层通过 JS bridge 提供电话、微信代操作、无障碍、ASR、TTS、桌宠等副作用能力。

术语对照：

| 层 | 术语 | 实现 |
|---|---|---|
| 决策 | ReAct-style tool loop | `agent.js:run()`，多轮 `turn()`，工具回执回灌 messages |
| 记忆 | working / episodic / semantic / procedural | `context.js` + `agent-memo.js` + `MILI_RHYTHM` |
| 路由 | cascaded routing（级联） | `app.js:handleSay()` |
| 检索 | BM25 lexical retrieval | `tool-router.js` |
| 持久化 | append-only log + validity window | `memory.js` + `agent-memo.js` |

---

## 二、重构前的机制（留作对照，别再照这个改）

### 2.1 决策链：`handleSay()` 七级级联

1. **procedural memory replay** — `MILI_MEMO.hit(原话)` 精确/同音命中 skill，重放工具序列，0 ms。
2. **本地直答** — `DATE_Q` 正则命中日期/农历，直接算。
3. **澄清闸** — `_isWatch` 正则 + 画像状态决定要不要固定话术追问。
4. **agent** — `MILI_AGENT.run()`，模型在 67 个 tool schema 里选，最多 3 轮。
5. **本地硬规则** — `tryDo()` 的意图正则表，断网兜底。
6. **旧进化引擎** — `evolve.js` 的别名/形态词补丁，默认关。
7. **兜底** — 药箱／闹钟／搜索。

问题：三层本地正则挡在模型前面；「同一句两次跑选不同工具」在 `agent.js:1288` 注释里被自认；
`_isWatch` 属于赛期内新增的意图正则，违反工程铁律。

### 2.2 上下文

`_hist` 是**内存数组**，`HIST_MAX=8`，只保留 user/assistant 文本，重启即丢。
`histMessages()` 每轮把最近 8 轮原文拼进 messages，无摘要、无检索、无长期层。
`systemPrompt()` 约 7.8K 字符，含人设、能力清单、失败经验、开口规则，每轮全量重发。

### 2.3 工具层

67 个 function schema（实测 18,739 字符）。第 0 轮全量注入，第 1 轮起 `toolSubset()` 按「已用工具名前缀」收窄。
`harvestXmlCalls()` 用 70 行正则从模型正文里捞 6 种伪 XML 调用格式 —— 说明结构化 `tool_calls` 经常失效。
`MILI_TOOLS.has()` 工具名白名单一直在（不要再说没校验）。
`guardHonest()` 保证工具失败时不说假话。

**已定位的真 bug**：`agent.js` 构造 `assistant(tool_calls)` 消息时**没有回传 `reasoning_content`**。
DeepSeek 思考模式下的 tool loop 要求把该轮的 `reasoning_content` 原样带回，否则返回 400；
这正是结构化 `tool_calls` 不稳定、要靠正则捞正文的直接嫌疑。

### 2.4 记忆与进化（重构前是四套互不相干的机制）

| 机制 | 存什么 | 阈值 | 问题 |
|---|---|---|---|
| `S.rules` / `learnAnswer()` | 问答对缓存 | 一条即学 | 有 `answerSane()` 四道质量门 + `prunePoisonRules()`，但只覆盖这一套 |
| `MILI_MEMO` facts + skills | 事实 / 原话→工具序列 | skill 一次即写 | memo 里混进「聊天的记忆分四类…」这类说明文本，重复事实并存 |
| `MILI_RHYTHM` | 7 类作息事件，30 天滚动 | ≥3 次或跨 ≥3 天 | 唯一符合权威口径的一套 |
| `EVO` | 别名 / 形态词 / 版本快照 / 31 句考卷 | 考卷涨分即升级 | 旧口径，已标 DEPRECATED |

---

## 三、调研依据（2026-11-13 实际打开核实）

| 结论 | 出处 | 数字 |
|---|---|---|
| 工具全量注入会让选择准确率崩塌 | RAG-MCP, arXiv:2505.03275；`github.com/YashM246/Enhancing_RAG_MCP` | Blank Conditioning **13.62%** / 2133.84 tokens → 检索式 **43.13%** / 1084 tokens；关键词预筛只有 18.20% |
| 结构化工具名/描述用 BM25 比向量更合适 | MCPProxy 工程说明；RAG-MCP 论文用 TF-IDF 类检索 | 确定性、可调试、零外部依赖 |
| 按需加载工具定义 | Anthropic *Advanced Tool Use*（2025-11-24）`defer_loading` | token **−85%**（77K→8.7K），Opus 4 MCP 评测 **49%→74%** |
| 工具越多越该先检索 | GitHub Copilot MCP | 40 → 13 工具，准确率提升、延迟 −400 ms |
| 记忆分层 | `letta-ai/letta`（Apache-2.0）：core blocks / recall / archival | `memory.py`、`prompt_generator.py`、`compact.py`、`summarizer.py`、`sleeptime_*` |
| 事实抽取要做冲突决策 | `mem0ai/mem0` `mem0/memory/main.py` `add()` | 5 phase：最近 10 条消息 + 已有记忆 top10 → 一次 LLM 输出 **ADD/UPDATE/DELETE** → embedding → hash 去重；`storage.py` 审计表 |
| 冲突不物理删除 | `getzep/graphiti` | validity window，作废打失效戳 |
| 上下文压缩 | `langchain` JS/Python `summarizationMiddleware`；`langchain-ai/deepagents` `openwiki/concepts/context-management.md` | `trigger:{tokens\|messages}` + `keep:{messages}`；85% 触发、保留 10%；`_summarization_event` 存 cutoff，**原始 checkpoint 不删**，`cutoff_message_id` 锚定，链式压缩推进同一份 raw log |
| 工具选择怎么评 | BFCL（AST 级、single/parallel/multi-turn/irrelevance）、τ-bench（TSR）、T-Eval | 必须披露 function-calling 配置；单 benchmark 不能当完整结论 |
| 记忆怎么评 | LongMemEval（ICLR 2025，500 题） | 五能力：信息抽取 / 多会话 / 时序 / **知识更新** / 弃答；指标 Recall@k、NDCG、MRR；hybrid（向量+10% BM25+recency）Recall@1 83%→88% |

> 口径红线：以上评测**只作不变量校验与回归门禁，不作进化证据**。
> `eval/heldout.json` 的 meta 旧稿写「两次结果的差就是日新的证据」，已被 11-09 口径推翻。

---

## 四、重构后的机制

### 4.1 三层记忆（`context.js`）

```
core      ≤800 字，常驻 systemPrompt；由 facts + 作息画像编译；可单条编辑
episodic  带时间戳的增量摘要段 + 原文归档；BM25 检索召回；recency boost
working   最近 8 轮原文；内存 + localStorage，重启不丢
```

- **append-only raw log**：原始消息只追加，压缩不删原文（deepagents）。
- **增量压缩**：轮数或估算 token 达阈值 → 把 cutoff 之前压成一条摘要消息；
  `_summarization_event = { cutoff, cutoffId, summary, at }`，多次压缩沿同一份 raw log 推进。
- **抽取式压缩优先**：零额外 LLM 调用，保留含实体/时间/数字/动作的句子；
  可选闲时 LLM 精修（sleeptime），现场不增延迟。
- **知识更新**：新旧事实并存时按 `validTo` 失效戳 + recency 排序，旧值不参与回答（LongMemEval KU）。
- **弃答**：检索无证据时 `hasEvidence()=false`，提示模型说不知道，不编造。

### 4.2 动态工具路由（`tool-router.js`，意图识别的正解）

```
query → 中文 char-bigram 分词 → BM25 打分（工具名 + 描述 + 参数名 + 域标签）
      → 域先验 + 改口正反馈加权 → top-k schema + always 工具
      → 低置信度 → 退回全量（保守，不硬猜）
      → MILI_TOOLS.has() 白名单 → turn()
```

- **零额外模型回合**：检索在本地完成，现场不 +1s。
- **不新增任何意图正则**：分词与 BM25 是检索，不是规则匹配。
- **缓存权衡**：动态工具集会破坏 prompt prefix cache。但单轮固定开销从 ~10.9K 降到 ~3K，
  即使全价也净省；`always` 工具放在数组前部保持部分前缀稳定。

### 4.3 进化机制（对齐权威口径）

驱动源**只有两类**：老人改口、作息。安全求助是出厂基础能力，不算进化成果。

- **改口 → 检索正反馈，不是正则别名**：25 秒内换说法办成 → 记 `(原话, 工具, 参数)` 到
  `corrections`；下次检索时该样本作为加权文档参与 BM25（Rocchio 式反馈）。
  **同一件事满 3 次（或跨 3 天）**才提升为稳定 skill。
- **作息**：`MILI_RHYTHM` 保持 7 类事件、跨天中位数、≥3 次/3 天、每日 6 句预算、事件间隙才开口。
- **一键清空**：`MILI_STORE.clearAll()` 是唯一入口，`memo / rhythm / evo / context / corrections`
  全部登记并一起退，`clearedAt` 墓碑防内置项复活。回退可演示。
- **不变量门禁**：`eval/heldout.json` 只验「第一个被执行工具是否命中 want」，
  数字不进进化叙事，也不写进宣传片。

### 4.4 结构化工具调用可靠性

- `assistant(tool_calls)` 消息补回 `reasoning_content`（DeepSeek 思考模式硬要求）。
- 工具轮 `response_format` 约束与参数校验，`harvestXmlCalls()` 降级为**兼容兜底**，不再是主解析路径。
- `onParsingFailure` 式兜底：解析失败不猜，退回全量工具重来一次；仍失败就如实说没办成。

---

## 五、评测数据与方法

| 数据集 | 用途 | 指标 |
|---|---|---|
| `eval/heldout.json`（31 句，赛前冻结，cases 一字不改；其中 5 句标 `want: []`＝不该调工具） | 工具选择回归门禁 | 首个工具命中率、Recall@k、MRR（分母只算 26 句有效样本） |
| `eval/memory-probes.json`（LongMemEval 风格 10 题） | 长期记忆五能力 | Recall@5、弃答正确率、知识更新新值优先率 |

### 基线（`node eval/run-eval.mjs`，产物 `eval/results.json`）

| 指标 | 值 |
|---|---|
| 首个工具命中率 / Recall@k / MRR（26 句有效） | **0.8846 / 1.0000 / 0.8988** |
| 不该调工具的 5 句 | 不计入上述分母；由专项行为测试管，旧口径把 0.7419 当基线是分母算错 |
| 平均注入工具数 | **12.87 / 67**（全量 18,739 字符 → 约 3,600） |
| 低置信度退回全量比例 | 0（31 句都有明确信号） |
| 长期记忆总体 / 弃答 / 知识更新 | **1.0 / 1.0 / 1.0** |
| 纯 Node 回归 | 65/65 |

⚠️ 这张表只证明「重构没把功能改坏」，**不是进化证据**，不进宣传片。
| `eval/memory-probes.json`（LongMemEval 风格自建小集） | 长期记忆五能力 | 信息抽取 / 多会话 / 时序 / 知识更新 / 弃答 的分类正确率、Recall@k |
| 真机 trace（`MILI_AGENT.trace()`） | 现场证据 | 轮数、token、首字延迟、工具序列、是否重放 |

**判完成只认亲手写进 progress.log 的标记行，不看退出码。** 无头自测只当证据，验收权归菲尔特。

---

## 六、边界（别踩）

- 禁新增意图正则；新能力 = 工具接 `agent-tools.js` + systemPrompt，不碰 `MILI.intent()`。
- 验收只准 `MILI_AGENT.run(原话)` 看模型选了哪个工具；跑 `MILI.intent()` 是假验收。
- 大脑直连 DeepSeek 官方 key，不走云 SDK。
- 公开仓是脱敏快照；真实 key / ECS 地址只在真机工程 `assets/web/`，同步必须走补丁而非整文件覆盖。


---

## 七、2026-11-14 稳定性修复（用户现场反馈）

| 现象 | 根因 | 处理 |
|---|---|---|
| 闲聊时说「没工具可调」 | `app.js` 闲聊闸把 `voiceTools` 置 false，工具被**摘光**；模型看到「你手上真有的本事」却一个工具没有 | 闲聊轮改挂 3 个只读工具（`tell_time`/`recall`/`remember`），systemPrompt 加静态禁语：**不提工具、不说没工具可调** |
| 老说「没听清」 | ① `r.err==='busy'` 时两个 if 都跳过，落到本地兜底；② 空回复兜底写死「我没听清，您再说一遍？」 | busy 显式 return「我听着呢，等一下就回您」；空回复改「我在呢，您接着说呀」 |
| 偶发冰冷成年女声 | `nativeTTS()` 走系统 TextToSpeech（小米女声），被 4 条失败兜底调用；**点大时钟报时**与**捎句话**还在 `say()` 之后又 `nn.speak()` 一次，是确定性叠音 | 封死 `nativeTTS`（静音兜底 + 屏幕文字，绝不换嗓子）；删两处重复播报；全仓 0 处真实系统 TTS 调用 |
| 新会话接走上一会话半句话（「你好呀」→「36 到底中不中呀」） | 昨晚引入长期记忆后，working 原文没有会话边界 | `context.js` 加 `SESSION_GAP=20min`：跨会话强制把旧原文整段归档进摘要并推进 cutoff；histMessages 再做时间过滤；抽取式摘要要求「数字带量词」，不再把纯数字闲聊当事实 |

**取舍说明**：童声 TTS 失败时现在**静音**而不是换系统女声。气泡里文字仍在，老人看得见；宁可不响也不出现第二个嗓子。若要断网也能出声，需要再做一套本地童声片段库，本轮未做。

**防再犯护栏**：`tools/check-device-credentials.mjs`（同步前后各跑一次，真机必须有真实凭据、公开仓必须脱敏）＋ `tests/safety.test.mjs`（6 条回归断言）＋ `CONTRIBUTING.md` 同步纪律。起因是 11-13 我图快整文件 `cp` 脱敏版到真机，冲掉了真实 key。

**验收**：34/34 纯 Node 测试、107 文件 0 敏感命中、评测基线不变（工具 0.7419 / 记忆 1.0）、真机 APK 装机后连续六句闲聊零坏话术、会话边界归档后无串台、截图无白屏。

| 问农历乱答（11-14 反馈） | `localDateSay()` 用 `Intl dateStyle:'long'` 再按「年」切字符串，是**全站第二套农历实现**；顶卡/systemPrompt/today_info 都用 `window.lunarCN`。不同 Android ICU 输出格式不一致就会切错。另外 DATE_Q 的排除词（看/播/电影）会把「今天农历几号啊，我待会想看戏」挤到模型 | `lunarCNOf()` 统一转调 `window.lunarCN`；问法扩到「老历/初几」；明确含农历词时忽略排除词，本地 0ms 直答 |

> 真机复现说明：11-14 00:32 在 APK 上连问「今天农历几号 / 农历几号了 / 今天初几啊 / 今天什么日子」，四句都正确返回「十月初六、11 月 14 日星期六」。用户报的「乱答」未复现，已请其提供当时原话与米粒回的原话，避免猜着改。


---

## 八、2026-11-14 凌晨：农历断根与首句提速（用户给原话后定位）

### 农历「今天农历几月几号」乱答

**真因不是算错**。真机两套农历算法输出都正确（`window.lunarCN` = `十月初六`、`Intl dateStyle:'long'` = `2026丙午年十月初六`），systemPrompt 注入的日期也对。

问题在路由：`handleSay` 里 `findRule(raw)`（`S.rules` 问答缓存）排在 ①.0 本地日期直答**之前**。缓存里存着一条针对「今天农历几月几号」的旧规则（多半是当年 `search_web` 搜回来的农历换算百科），命中后直接 `say(rule.ans)` 并**裸 `return`**（无回执）。「今天农历几号」没命中那条 key，反而正常。

三处一起断根：
1. 日期/时间问句跳过 `findRule`，交给 ①.0 本地 0ms 直答；
2. `learnAnswer()` 拒收日期类问句，不再学成问答规则；
3. `prunePoisonRules()` 开机清掉已存的日期类毒规则。
另把 `lunarCNOf()` 统一转调 `window.lunarCN`，消除全站第二套 Intl 实现；问法扩到「老历/初几」，明确含农历词时忽略排除词。

### 首句响应速度

**诚实数据**：prompt 从 **7883 → 218 字符（−97%）**，但交替 AB 实测端到端只从 916ms → 838ms（−8.5%）。瓶颈是模型往返与 TTS 起播，不是 prompt 编码。所以又加了三刀：

| 手段 | 效果 |
|---|---|
| 闲聊轮精简 systemPrompt + 单轮 ReAct + `max_tokens=140` + 只带画像头/最近 2 条原文 | 端到端 −8.5% |
| **纯寒暄只读查表**（14 句，精确键，非意图正则，不写入 `S.rules`、不算进化成果） | **0ms**（原 ~900ms） |
| 日期/农历/星期本地直答 + 跳过毒规则 | **0ms** |
| 开机 `prewarm()` 焐热 DNS/TLS | 首句省 300~400ms 冷启动 |

真机 `?debug=1` 完整链路实测：`你好呀` 0ms / `在吗` 0ms / `今天农历几月几号` 0ms 且答「十月初六」/ `讲个笑话` 997ms / `陪我聊会儿天` 3008ms（单句波动，未深究）。

**还没做的最大一块**：流式首字起播（`onDelta` 在 11-08 因「同一句念两遍」被关）。它能把感知延迟从整句生成完再送 TTS 压到首字就出声，但要改 `say()` 流式队列，风险高，等菲尔特拍板。


---

## 九、2026-11-14 凌晨：流式首句起播 + 演示模式可控化

### 9.1 流式首句起播（菲尔特拍板「好，流式首字起播」）

**先讲清 11-08 为什么关掉它**：不是 TTS 坏了，是三条出口没有一次性认领 ——
`onDelta` 增量 → `onStreamEnd` 尾段 → `agentSay` 收尾补 `say(r.said)`；
而 `streamed` 靠「队列里还有没有东西」猜，队列刚好播空就补播一次，
于是「同一句念两遍 + 气泡重复」。此外 `onSaid` 交代语、`say()` → `speak()` → `ssHalt()`
清队列，也是两条独立声音路径。

**借鉴的成熟实现**（实际打开核实）：

| 来源 | 抄了什么 |
|---|---|
| `YevheniiMiachyn/dsh-tts-live`（MIT，DSH 插件 fork） | `claimedEnd` 精确认领文本范围（修 live 尾部重复发布）；有序句子队列带稳定 id；session/turn/step 归属；落盘对账只发布未读尾部；live 路径可显式关闭 |
| `KoljaB/RealtimeTTS` `docs/llm-streaming.md` | `minimum_first_fragment_length` 控制首句长度；过滤空 chunk / 非文本 delta；`stop()` 打断后重新 `feed()` |
| `SorunEngineering/chat_audio_streamer` | 生成 / 合成 / 播放三段流水线，首句合成完就起播，不等全文 settle |
| DSH 文档里的诚实结论 | **流式不解决 TTFT**，只消除「首句已存在之后仍等整段 settle」的等待；TTFT 仍由模型与网络决定 |

**落地形态**：新增 `app/stream-speak.js`（纯逻辑、无 DOM、可跑 Node），把「切句 / 幂等 / 对账」从 `app.js` 的 `SS` 里剥离；`SS` 只保留播放队列、麦克风闸、气泡。

| 机制 | 实现 |
|---|---|
| 首句门槛 | 中文 5 字无标点也切；逗号在 3 字位置优先切（避免切出「好嘞，我给」这种半截词）；后续句只认强标点，24 字硬切 |
| 稳定 id | 每段 `turnId-seq`，同时作为原生 `miliTtsEnd(id)` 对账键，跨轮不撞号 |
| turn 归属 | `SS.turnId` 单调递增，`onDelta` / `onStreamEnd` 闭包捕获；上一轮迟到增量直接丢弃（late-settle suppression） |
| claimedEnd | `turn.end()` 只认领一次尾段，重复回调（内核重试 / 兜底）返回空数组 |
| 落盘对账 | `finalText` 与已念文本一致 → 不补播，只定稿气泡；是「已念 + 未读尾部」→ 只补尾部；被 `guardHonest` 整体改写 → **不补播**，屏幕显示真话，宁可少念也不重念 |
| 确定性 streamed | `agent.js` 的 `turn()` 累计 `emitted`，`_runInner` 累计 `streamedChars`，`run()` 回传 `streamed: >0`；前端只信 `r.streamed && SS.turn.segments.length`，不再猜队列状态 |
| 开启条件 | **只在本轮 `!useTools`（不挂工具）时开**。挂工具的轮次模型可能说半句转头办事，那半句念出去就是一句没头没尾的话；纯说话轮不可能中途办事，`gateDead` 的顾虑整体消失，`guardHonest` 也不改写文本 |
| 现场回退 | `window.__MILI_NO_STREAM = 1` 一行关掉，无需重打包 |

**取舍**：流式只在纯说话轮开，工具链与「办完事报结果」若挂了工具仍走整段播报。
流式已念出的文本是权威，`finalText` 只用于气泡与历史。这是用「绝不重念」换「极端情况下声音与屏幕可能不一致」。

**验收（真机未装，纯 Node 契约）**：`tests/stream-e2e.test.mjs` 在 vm 里 mock 一条 DeepSeek SSE 流真跑 `MILI_AGENT.run()` —— 5/5 通过：`r.streamed=true`、增量拼接 == `r.said`、段 id 唯一、`onStreamEnd` 重复三次不多吐一个字、挂工具轮 `streamed=false`。`tests/stream-speak.test.mjs` 13 条覆盖首句切分、连标点、硬切、复读、幂等、对账、稳定 id。

### 9.2 演示模式三条（菲尔特现场反馈）

| 现象 | 根因 | 处理 |
|---|---|---|
| 首页一进去就是演示模式 | `boot()` 读 `localStorage.mili_demo_on` 自动恢复 `D.on=true`；`start()` 会写这个 key | 删掉自动恢复与写入，开机主动 `removeItem` 清历史遗留位。现在每次进 App 都是普通首页，要演示自己去点「我的 · 比赛演示」 |
| 「还是 3 遍」 | **11-13 只改了 `app.js`，漏改 `index.html`**：提词条写「共 3」、三个圆点、面板有 `data-n="3"` 第三行、设置页还有「同一个片子说三遍」 | HTML 全部改成两遍：两圆点、两行说明、表格 2 行（JS 侧 11-13 已是两遍）。这是本助手的漏，已用静态断言焊死 |
| 遍数不该自动跳 | `stepNow()` 按两条 memo 自动算，现场不可控 | 新增 `forceStep` + `setStep(1|2)`，HUD 与面板各一组按钮（`data-demostep` 专用属性，避开引导页 9 个同名 `data-step`）。`start()` / `reset()` 都锁第 1 遍；演示者点「第 2 遍」才放行 skill |

按钮用 `#demoHud .dh-sw` / `#demoSheet .ds-sw` 两枚白色胶囊，选中态才是主色 `#5B4DF0`，不叠渐变、不用暖黄。

⚠️ **按钮属性必须是 `data-demostep`**：引导页有 9 个 `.onb-step[data-step]`（九步向导），
用 `[data-step]` 选择器会把向导按钮也绑成切遍、`paint()` 还会改它们的 `on` 高亮。
`tests/demo-and-stream-safety.test.mjs` 专门断言这条。

### 9.3 本轮验收与未完成

- 61/61 纯 Node 测试、评测基线不变（工具 0.7419 / 记忆 1.0）、111 文件 0 敏感命中、
  凭据护栏（公开仓脱敏 / 真机真实凭据）双向通过、三处源码语法全过、CSS 括号平衡 0。
- **真机 APK 没重装**：菲尔特 01:04 说手机断了。`assets/web/` 源码已改，但 APK 内仍是
  `2026-11-14 00:22` 那版。明天连上手机后必须 `assembleDebug + install -r` 才能生效；
  首句起播的实际感知延迟、切遍按钮手型、有无重复念，都要真机截图 + 耳朵验收。
