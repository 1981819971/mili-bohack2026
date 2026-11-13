# 后端接口契约（队友核查用）

> 2026-11-13 补齐。回应「前端能看到账号、配对、药品、健康数据等后端接口，
> 但只能确认调用方式，无法核实服务端实现」——服务端源码现在就在 `backend/`，
> 本文把每个接口、数据落点和边界一次列清。

## 服务端有两个 Python 进程 / 两份实现

| 文件 | 职责 | 数据落点 |
|---|---|---|
| `backend/mili_auth.py`（796 行） | 账号、登录票据、老人-家人配对、药箱、健康数据、行为日志 | SQLite：`MILI_DB`，默认 `/root/mili-data/mili.db`。表：`users` / `tokens` / `links` / `pairs` / `meds` / `acts` / `tries` / `vitals` |
| `backend/asr_server.py`（232 行） | SenseVoice 语音识别、`/state` 跨设备配置同步、健康检查 | 文件：`STATE_DIR`，默认 `/root/mili-state/<dev>.json`，单文件上限 512KB，原子写（`.tmp` + `os.replace`） |
| `backend/dev_server.py` | 本地开发用静态服务器 + `/tts` 转豆包 TTS + `/api/*` 透传到上面的服务 | 不存业务数据 |
| `backend/doubao_tts.py` | 豆包 TTS 封装 | 不存业务数据 |

两个服务都跑在 `YOUR_SERVER_HOST:9001`，前端统一用 `MILI_API`（`app/_acc_new.js:15`）访问。
公开仓里域名是占位符 `your-ecs-host.example.com` / `YOUR_SERVER_HOST`。

## 接口表

### 账号与配对（`mili_auth.py`，前端 `app/_acc_new.js`）

| 方法 | 路径 | 前端调用点 | 说明 |
|---|---|---|---|
| GET | `/auth/me` | `_acc_new.js:60` | 用票据换当前身份 |
| POST | `/auth/login` | `:81` | 登录，不带票据 |
| POST | `/auth/register` | `:104` | 注册 |
| POST | `/auth/logout` | `:126` | 注销 |
| POST | `/pair/new` | `:134` | 生成 6 位配对码（老人/家人任一方可出码） |
| POST | `/pair/bind` | `:148` | 用码绑定，body `{code}` |
| GET | `/pair/who` | `:161` | 查当前绑定关系 |
| POST | `/pair/unbind` | `:167` | 解绑，body `{uid}` |
| GET / PUT | `/med` | `:175` / `:197` | 药箱读写 |
| GET | `/elder?elder_id=` | `:205` | 老人档案卡 |
| POST | `/act` | `:216` | 行为日志上报 |

票据通过 `Authorization: Bearer <accToken>` 传递（`_acc_new.js:33`），角色 `elder` / `fam` 存在 `S.accRole`。
`mili_auth.py` 另有 `pair_code` / `pair_rotate` / `vital_post` / `vital_get` / `ping` 等服务端路由。

### 语音与状态（`asr_server.py`）

| 方法 | 路径 | 门禁 | 说明 |
|---|---|---|---|
| POST | `/asr` | `k=<ASR_TOKEN>` | multipart `audio`，转 16k wav 后送 SenseVoice，返回 `{text}` |
| GET | `/state?k=&dev=` | `k=<ASR_TOKEN>` | 读 `<dev>.json`，不存在返回 `{ok:true,data:null}` |
| PUT | `/state?k=&dev=` | `k=<ASR_TOKEN>` | 写 `<dev>.json`，>512KB 返回 413 |
| POST | `/probe` | **无门禁** | 把浏览器自测结果追加到 `/root/probe.log` |
| GET | `/health` | 无 | 返回模型与热词 |

前端 `/state` 调用点：`app/app.js:11842`（dev=note）、`:12213` / `:12225`（dev=cfg_<code>）、`:13377`。
`API()` 定义在 `app.js:3687`，返回 `http://YOUR_SERVER_HOST:9001`。

### 其它前端网络调用

| 路径 | 位置 | 说明 |
|---|---|---|
| `/tts?t=` | `app.js:1833`、`:4105` | 文本转语音，走本地开发服务器代理 |
| `http://YOUR_SERVER_HOST:9001/tv/` | `app.js:350` | CCTV 直播流中继 |

## 边界：哪些在本机、哪些在服务端

**服务端持有**（队友关注的这部分，现在能核实实现了）：
账号、票据、配对关系、云端药箱副本、健康数据（血压/血糖）、行为日志、跨设备同步配置。

**本机 localStorage 也存了一份**（`app/app.js:20-60`）：
`S.med`（药箱）、`S.vital` / `MILI_VITAL`（健康）、`S.accToken` / `accPhone` / `accName`、
`S.pairCode` / `pairFam`、`MILI_MEMO`（事实与技能）、`MILI_RHYTHM`（作息画像）、`EVO`（旧引擎状态）。

⚠️ **已知不一致**：药箱和健康数据在服务端与本机各有一份，`_acc_new.js` 的 `/med` 与 `app.js` 的 `S.med` 并立，
没有看到明确的同步/冲突解决逻辑。这是真实的技术债，别当成设计。

## 安全边界（评审也会问）

- `ASR_TOKEN` 是**单枚共享口令**（环境变量），不是按用户签发的票据；`mili_auth.py` 的 `Bearer` 票据与它是两套独立鉴权。
- `ASR_TOKEN` 为空时 `_gate()` 直接放行 —— 部署必须显式设置，公开仓不提供任何真实口令。
- `POST /probe` **没有门禁**，且写死 `/root/probe.log`。仅用于现场自测回传，不应对公网开放。
- `/state` 的 `dev` 参数经 `_state_path()` 做白名单化后拼路径，单文件 512KB 上限。
- 所有真实密钥、ECS 地址、手机号、学号、姓名在公开仓里都是占位符；`npm run scan` 每次提交前校验。

## 回归测试

`backend/test_auth.py` 是账号/配对的接口自测（已脱敏）。
记忆层的 11 条断言在 `tests/memory.test.mjs`，与后端无关、不需要起服务。
