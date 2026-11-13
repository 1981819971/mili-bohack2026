# 构建说明：这个仓能跑什么、还缺什么

> 2026-11-13 补齐。回应队友「github 上的不完整」——把能公开的都补了，
> 剩下的都是**二进制资源与本机配置**，逐项列清楚，不再含糊说「脱敏」。

## 一句话定位

`mili-bohack2026` 是**赛事代码申报仓 + 3 人协作阅读仓**。源码、构建脚本、服务端实现、接口契约齐全；
大体积二进制素材与真实密钥不进仓。它不是「clone 下来直接出 APK」的完整工程，但也不是只有几页前端代码。

## 现在就能跑（零依赖）

```bash
npm test        # 11 条记忆层回归断言
npm run check   # JS 语法检查
npm run scan    # 敏感串扫描
```

后端可以单独起（需要 Python 3.10+）：

```bash
python -m pip install -r backend/requirements.txt
ASR_TOKEN=<自定口令> uvicorn backend.asr_server:app --port 9001
python -m pip install -r backend/requirements-dev.txt   # 本地开发服务器 / TTS 代理可选
```

## 2026-11-13 已补齐

| 类别 | 文件 |
|---|---|
| Android 构建 | `android/build.gradle`、`settings.gradle`、`gradle.properties`、`app/build.gradle` |
| Android 清单与资源 | `app/src/main/AndroidManifest.xml`、`res/**`（values / xml / mipmap / drawable，含 11 个图标 PNG） |
| 前端第三方库 | `app/vendor/`（three.js、GLTFLoader、OrbitControls、BufferGeometryUtils、lunar.js、qrcode.js，1.8MB）、`app/assets/vendor/hls.min.js`（0.4MB） |
| 服务端实现 | `backend/mili_auth.py`（账号/配对/药箱/健康数据，SQLite）、`backend/asr_server.py`（语音识别 + 状态同步）、`backend/dev_server.py`（本地静态服务器 + TTS 透传）、`backend/doubao_tts.py` |
| 依赖与测试 | `backend/requirements.txt`、`backend/requirements-dev.txt`、`backend/test_auth.py` |

以上全部经过 `npm run scan` 脱敏校验：ECS 地址、`sk-` 密钥、真实手机号、学号、姓名均已替换为占位符。

## 仍然缺的（逐项说明为什么）

| 路径 | 用途 | 为什么不在仓 | 怎么拿 |
|---|---|---|---|
| `android/app/libs/sherpa-onnx.aar` | 离线唤醒引擎（含 arm64 so） | 第三方二进制，体积大、跟随上游版本 | sherpa-onnx 官方 release，按 `app/build.gradle` 的版本放进去 |
| `android/app/libs/Java-WebSocket-1.5.6.jar` | 豆包全双工语音 WebSocket | 第三方二进制 | Maven Central `org.java-websocket:Java-WebSocket:1.5.6` |
| `android/app/src/main/assets/asr/`、`asr2/`、`kws/`、`sv/` | ONNX 语音模型（约数百 MB） | `.gitignore` 排除 `*.onnx`，体积与授权 | 从真机工程同步，或按 `backend/README.md` 下载对应模型 |
| `android/app/src/main/assets/web/` | APK 内嵌前端 | **生成物**，不是源码 | 跑 `node app/build.mjs` 生成后拷入 |
| `android/app/src/main/assets/pet_*` | 桌宠贴图 | 素材，`.gitignore` 排除 `*.png` | 从真机工程同步 |
| `app/assets/m*-rig*.glb`、`poses/`、`voice/` | 3D 小鸡模型、姿态图、87 条童声音频 | 共 16.9MB，二进制素材 | 从真机工程同步；模型可用 `build.mjs` 的占位分支跳过 |
| `android/local.properties` | 本机 Android SDK 路径 | 每台机器不同，`.gitignore` 排除 | 自己新建，写 `sdk.dir=...` |
| `gradlew` / `gradle/wrapper/` | Gradle wrapper | 真机工程本来就没用 wrapper | 本机装 Gradle 8.x，或执行 `gradle wrapper` 生成 |
| `.env` / `credentials*` | 运行密钥 | **绝不进仓** | 用环境变量注入，见下表 |
| `米粒.html` / `米粒-演示版.html` | 单文件离线版 | 构建产物（15MB+） | `node app/build.mjs` 生成 |

## 运行密钥（环境变量，不落盘）

| 变量 | 用在哪 | 公开仓里的值 |
|---|---|---|
| `ASR_TOKEN` | `asr_server.py` 的 `/asr`、`/state` 门禁 | 空（未设置时**不校验**，部署必须设） |
| `MILI_DB` | `mili_auth.py` 的 SQLite 路径 | `/root/mili-data/mili.db`（默认值） |
| `STATE_DIR` | `asr_server.py` 的状态文件目录 | `/root/mili-state`（默认值） |
| `MODEL_DIR` | SenseVoice ONNX 模型目录 | `backend/models` |
| `PORT` | 服务端口 | `9001` |
| DeepSeek API key | `agent.js` 的 `DS.key` | `sk-REPLACE_WITH_YOUR_OWN_KEY`，现场用 `MILI_AGENT.setLLM()` 注入 |

## 完整构建路径

1. `npm test && npm run check && npm run scan` —— 三条全绿
2. 按上表补齐 `android/app/libs/`、`assets/asr/`、`app/assets/`
3. 新建 `android/local.properties` 写本机 SDK 路径
4. `node app/build.mjs` 生成 `server/` 与单文件版（需要 `app/vendor/three/`，已补）
5. 把 `server/` 同步到 `android/app/src/main/assets/web/`
6. Android Studio 打开 `android/`，或 `gradle assembleDebug -PmiliAbi=arm64-v8a`

> 前端 `index.html` 的 importmap 指向 `./vendor/three/three.module.js`，该目录已补齐；
> `assets/vendor/hls.min.js` 也已补齐。缺的只剩模型、贴图和音频。

## 与真机工程的关系

真机源码与素材在队长的本地工程，不在 GitHub。本仓是**脱敏快照**：
新增/修改源码后用工作区的 `sync_missing_files.py` / `sync_public_repo.py` 同步，
逐文件脱敏后再 `npm run scan`。**不要整目录复制。**
