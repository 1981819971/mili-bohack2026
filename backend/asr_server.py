# -*- coding: utf-8 -*-
"""
米粒的耳朵（服务端）—— 录音进来，文字出去。

模型：SenseVoice-Small（int8 ONNX，约 230MB），中文/方言/口音都在行，
跑在 CPU 上也够快（2 核实测一句话 0.3~0.8 秒）。用 sherpa-onnx 推理，不装 torch，
省内存省磁盘 —— 这台机器只有 8G 内存，能省就省。

两个专门为「老人说话」做的处理：
1) 热词纠正：ASR 把「王炳皓」听成「王浩」这种，用拼音相似度拉回来。
   家里人名字就那么几个，硬纠正是最划算的准确率。
2) 数字规整：二十三点 → 23点，星期三不动。

接口：
    POST /asr   multipart/form-data，字段 audio（wav/mp3 都行）
    GET  /health
"""
import os
import re
import subprocess
import tempfile

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse

PORT = int(os.environ.get("PORT", "9001"))
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "models"))
HOTWORDS = [w.strip() for w in os.environ.get("ASR_HOTWORDS", "").split(",") if w.strip()]
ASR_TOKEN = os.environ.get("ASR_TOKEN", "").strip()   # 端口对公网开着，得有个门禁

app = FastAPI(title="米粒 ASR", docs_url=None, redoc_url=None)

_recognizer = None


# ---------------------------------------------------------------- 引擎

def build():
    import sherpa_onnx
    model = os.path.join(MODEL_DIR, "model.int8.onnx")
    tokens = os.path.join(MODEL_DIR, "tokens.txt")
    if not (os.path.exists(model) and os.path.exists(tokens)):
        raise RuntimeError(f"模型没就位：{MODEL_DIR}")
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=int(os.environ.get("ASR_THREADS", "2")),
        use_itn=True,          # 数字/日期说人话
        language="zh",
        debug=False,
    )


def warm():
    global _recognizer
    if _recognizer is None:
        _recognizer = build()
    return _recognizer


# ---------------------------------------------------------------- 音频

def to_wav(data: bytes) -> str:
    """统一成 16k 单声道 wav。已经是 wav 就不转，省一次 ffmpeg。"""
    fd, path = tempfile.mkstemp(suffix=".bin")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    if data[:4] == b"RIFF":
        return path
    out = path + ".wav"
    rc = subprocess.call(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
         "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", out]
    )
    try:
        os.remove(path)
    except OSError:
        pass
    if rc != 0 or not os.path.exists(out):
        raise RuntimeError("音频转码失败")
    return out


# ---------------------------------------------------------------- 人名纠正

def pinyin_of(s: str) -> str:
    """不需要精确声调，只要音骨架，用来判断「听起来像不像」。"""
    try:
        from pypinyin import lazy_pinyin
        return "".join(lazy_pinyin(s))
    except Exception:
        return s


def fix_names(text: str) -> str:
    """把听错的人名拉回热词。只动「长度接近且拼音相近」的片段。"""
    if not text or not HOTWORDS:
        return text
    out = text
    for name in HOTWORDS:
        if name in out:
            continue
        py_name = pinyin_of(name)
        best, best_score = None, 0.0
        # 在文本里滑一个和名字等长的窗口
        n = len(name)
        for i in range(0, max(1, len(out) - n + 1)):
            seg = out[i:i + n]
            if len(seg) < n:
                break
            py_seg = pinyin_of(seg)
            if not py_seg:
                continue
            same = sum(1 for a, b in zip(py_seg, py_name) if a == b)
            score = same / max(len(py_name), 1)
            if score > best_score:
                best, best_score = (i, seg), score
        # 拼音骨架七成以上像，且首字相同，才敢替换
        if best and best_score >= 0.7 and pinyin_of(best[1])[0] == py_name[0]:
            i, seg = best
            out = out[:i] + name + out[i + n:]
    return out


# ---------------------------------------------------------------- 路由

# ---------------------------------------------------------------- 状态固化
# 老人手机清除数据 / 换机之后，自动把状态从服务器拉回来。
# 用 ANDROID_ID 做设备键（清数据不变），不走账号登录 —— 账号 token 也会被清掉。
STATE_DIR = os.environ.get("STATE_DIR", "/root/mili-state")


def _state_path(dev: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "", dev)[:64]
    if not safe:
        raise ValueError("bad dev")
    return os.path.join(STATE_DIR, safe + ".json")


def _gate(request: Request):
    if ASR_TOKEN and request.query_params.get("k", "") != ASR_TOKEN:
        return JSONResponse({"ok": False, "err": "forbidden"}, status_code=403)
    return None


@app.get("/state")
def state_get(request: Request, dev: str = ""):
    denied = _gate(request)
    if denied: return denied
    try: p = _state_path(dev)
    except Exception: return JSONResponse({"ok": False, "err": "bad dev"}, status_code=400)
    if not os.path.exists(p): return {"ok": True, "data": None}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return {"ok": True, "data": f.read()}
    except Exception as e:
        return JSONResponse({"ok": False, "err": str(e)}, status_code=500)


@app.put("/state")
async def state_put(request: Request, dev: str = ""):
    denied = _gate(request)
    if denied: return denied
    try: p = _state_path(dev)
    except Exception: return JSONResponse({"ok": False, "err": "bad dev"}, status_code=400)
    body = await request.body()
    if len(body) > 512 * 1024:
        return JSONResponse({"ok": False, "err": "too big"}, status_code=413)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "wb") as f: f.write(body)
        os.replace(tmp, p)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "err": str(e)}, status_code=500)


@app.post("/probe")
async def probe(request: Request):
    """自测回传：把浏览器里跑出来的结果写进文件，方便我在服务器上直接看。

    2026-11-14：加两道闸。这个端点没有鉴权，公网可写 ——
    一条几十 MB 的 body 就能把 /root 写满，把 ECS 上的服务一起拖死。
      ① 单次 body 上限 64KB，超了直接 413；
      ② 日志超过 4MB 就轮转一次（probe.log -> probe.log.1），最多留两份。
    """
    body = await request.body()
    if len(body) > 64 * 1024:
        return JSONResponse({"ok": False, "err": "probe body too large"}, status_code=413)
    path = "/root/probe.log"
    try:
        if os.path.exists(path) and os.path.getsize(path) > 4 * 1024 * 1024:
            os.replace(path, path + ".1")
    except OSError:
        pass
    with open(path, "a", encoding="utf-8") as f:
        f.write(body.decode("utf-8", "replace") + "\n")
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True, "model": "sensevoice-int8", "hotwords": HOTWORDS}


@app.post("/asr")
async def asr(request: Request, audio: UploadFile = File(...)):
    if ASR_TOKEN and request.query_params.get("k", "") != ASR_TOKEN:
        return JSONResponse({"text": "", "error": "forbidden"}, status_code=403)
    data = await audio.read()
    if not data:
        return JSONResponse({"text": "", "error": "empty"}, status_code=400)
    wav = None
    try:
        wav = to_wav(data)
        rec = warm()
        import wave as _w
        import numpy as _np
        with _w.open(wav, "rb") as f:
            sr = f.getframerate()
            raw = f.readframes(f.getnframes())
        samples = _np.frombuffer(raw, dtype=_np.int16).astype(_np.float32) / 32768.0
        s = rec.create_stream()
        s.accept_waveform(sr, samples)      # sherpa-onnx 只有这个接口，没有 accept_wave_file
        rec.decode_stream(s)
        text = (s.result.text or "").strip()
        text = re.sub(r"<\|[^|]*\|>", "", text).strip()
        text = fix_names(text)
        return {"text": text}
    except Exception as e:                       # noqa: BLE001
        import traceback
        traceback.print_exc()
        return JSONResponse({"text": "", "error": str(e)}, status_code=500)
    finally:
        if wav and os.path.exists(wav):
            try:
                os.remove(wav)
            except OSError:
                pass


if __name__ == "__main__":
    import uvicorn
    warm()
    uvicorn.run(app, host="0.0.0.0", port=PORT, workers=1)
