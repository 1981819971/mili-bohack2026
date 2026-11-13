"""豆包语音合成 2.0（双向流式）—— 米粒的嘴

为什么换掉 edge_tts：
  edge_tts 在国内实测首块稳定 1.3~2.0 秒，而且跟文本长短无关 ——
  那 2 秒是微软服务端的响应时间，复用连接也压不下来。
  老人说完一句话，2 秒没声，就是「没反应」。
  豆包实测首字节 122ms、首音 392ms，同样的网络条件，快 5 倍。

协议：火山 openspeech v3 二进制帧
  header 4 字节 | event 4 字节(BE) | [session_id 长度 + 内容] | payload 长度(BE) | payload
  header[0] = 版本<<4 | 头长
  header[1] = 消息类型<<4 | 标志位
  header[2] = 序列化方式<<4 | 压缩方式
"""

import asyncio
import json
import os
import struct
import uuid

import websockets

URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
# 2026-11-06 菲尔特在豆包语音控制台「API Key 管理」新建的（默认体验中心）
_DEFAULT_KEY = "aa9030d2-b42b-4056-9545-25a4cf9a7c51"
KEY = os.environ.get("DOUBAO_TTS_KEY", _DEFAULT_KEY).strip()
# 童声候选（基频实测）：
#   zh_male_naiqimengwa_uranus_bigtts        奶气萌娃   348Hz  最像小孩
#   zh_male_tiancaitongsheng_uranus_bigtts   天才童声   312Hz
#   zh_female_yingtaowanzi_uranus_bigtts     樱桃丸子   286Hz  女童
#   zh_female_mengyatou_uranus_bigtts        萌丫头     286Hz
SPEAKER = os.environ.get("DOUBAO_TTS_VOICE", "zh_male_naiqimengwa_uranus_bigtts")
RESOURCE = "seed-tts-2.0"

_PROTO = 0b0001
_HDR = 0b0001
_M_FULL_CLIENT = 0b0001
_M_FULL_SERVER = 0b1001
_M_AUDIO_SERVER = 0b1011
_M_ERROR = 0b1111
_F_EVENT = 0b0100
_S_JSON = 0b0001

EV_START_CONN = 1
EV_FINISH_CONN = 2
EV_CONN_STARTED = 50
EV_CONN_FAILED = 51
EV_CONN_FINISHED = 52
EV_START_SESSION = 100
EV_FINISH_SESSION = 102
EV_SESSION_STARTED = 150
EV_SESSION_FINISHED = 152
EV_SESSION_FAILED = 153
EV_TASK = 200
EV_TTS_RESPONSE = 352


def available():
    return bool(KEY)


def _header(msg_type, flags, ser):
    return bytes([(_PROTO << 4) | _HDR, (msg_type << 4) | flags, (ser << 4) | 0, 0])


def _frame(event, payload, session_id=None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    out = bytearray(_header(_M_FULL_CLIENT, _F_EVENT, _S_JSON))
    out += struct.pack(">i", event)
    if session_id:
        sid = session_id.encode("utf-8")
        out += struct.pack(">i", len(sid)) + sid
    out += struct.pack(">i", len(body)) + body
    return bytes(out)


def _parse(buf):
    if len(buf) < 8:
        return None
    msg_type = buf[1] >> 4
    flags = buf[1] & 0x0F
    off = 4
    event = 0
    if flags & _F_EVENT:
        event = struct.unpack(">i", buf[off:off + 4])[0]
        off += 4
    if off + 4 > len(buf):
        return {"type": msg_type, "event": event, "payload": b""}
    maybe = struct.unpack(">i", buf[off:off + 4])[0]
    if 0 < maybe < 200 and off + 4 + maybe <= len(buf):
        off += 4 + maybe
    if off + 4 > len(buf):
        return {"type": msg_type, "event": event, "payload": b""}
    size = struct.unpack(">i", buf[off:off + 4])[0]
    off += 4
    payload = buf[off:off + size] if 0 < size <= len(buf) - off else b""
    return {"type": msg_type, "event": event, "payload": payload}


async def _synth_async(text, speech_rate=-4, on_chunk=None):
    session_id = "mili-" + uuid.uuid4().hex[:12]
    chunks = []
    params = {
        "speaker": SPEAKER,
        "audio_params": {"format": "mp3", "sample_rate": 24000},
        "speech_rate": speech_rate,
    }
    try:
        ws = await websockets.connect(
            URL,
            additional_headers={
                "X-Api-Key": KEY,
                "X-Api-Resource-Id": RESOURCE,
                "X-Api-Connect-Id": session_id,
            },
            max_size=32 * 1024 * 1024,
            open_timeout=10,
        )
    except TypeError:
        # 老版本 websockets 用 extra_headers
        ws = await websockets.connect(
            URL,
            extra_headers={
                "X-Api-Key": KEY,
                "X-Api-Resource-Id": RESOURCE,
                "X-Api-Connect-Id": session_id,
            },
            max_size=32 * 1024 * 1024,
            open_timeout=10,
        )

    try:
        await ws.send(_frame(EV_START_CONN, {"event": EV_START_CONN}))
        finished = False
        while not finished:
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
            m = _parse(raw)
            if not m:
                continue
            ev = m["event"]
            if m["type"] == _M_ERROR or ev in (EV_CONN_FAILED, EV_SESSION_FAILED):
                raise RuntimeError("豆包报错: %s" % m["payload"][:200].decode("utf-8", "replace"))
            if ev == EV_CONN_STARTED:
                await ws.send(_frame(
                    EV_START_SESSION,
                    {"event": EV_START_SESSION, "req_params": params},
                    session_id,
                ))
            elif ev == EV_SESSION_STARTED:
                await ws.send(_frame(
                    EV_TASK,
                    {"event": EV_TASK, "req_params": dict(params, text=text)},
                    session_id,
                ))
                await ws.send(_frame(EV_FINISH_SESSION, {"event": EV_FINISH_SESSION}, session_id))
            elif ev == EV_TTS_RESPONSE or m["type"] == _M_AUDIO_SERVER:
                if m["payload"]:
                    chunks.append(m["payload"])
                    if on_chunk:
                        on_chunk(m["payload"])
            elif ev == EV_SESSION_FINISHED:
                await ws.send(_frame(EV_FINISH_CONN, {"event": EV_FINISH_CONN}))
            elif ev == EV_CONN_FINISHED:
                finished = True
    finally:
        try:
            await ws.close()
        except Exception:
            pass
    return b"".join(chunks)


def synth_blocking(text, speech_rate=-4):
    """同步调用入口 —— server 是 http.server 的多线程模型，不是异步的。"""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_synth_async(text, speech_rate))
    finally:
        loop.close()


async def _synth_seq(texts, speech_rate=-4, on_chunk=None):
    """一次连接说多句。句间零握手，省掉每句 110ms。"""
    session_id = "mili-" + uuid.uuid4().hex[:12]
    params = {
        "speaker": SPEAKER,
        "audio_params": {"format": "mp3", "sample_rate": 24000},
        "speech_rate": speech_rate,
    }
    ws = await websockets.connect(
        URL,
        additional_headers={
            "X-Api-Key": KEY,
            "X-Api-Resource-Id": RESOURCE,
            "X-Api-Connect-Id": session_id,
        },
        max_size=32 * 1024 * 1024,
        open_timeout=10,
    )
    try:
        await ws.send(_frame(EV_START_CONN, {"event": EV_START_CONN}))
        while True:
            m = _parse(await asyncio.wait_for(ws.recv(), timeout=15))
            if m and m["event"] == EV_CONN_STARTED:
                break
        await ws.send(_frame(EV_START_SESSION, {"event": EV_START_SESSION, "req_params": params}, session_id))
        while True:
            m = _parse(await asyncio.wait_for(ws.recv(), timeout=15))
            if m and m["event"] == EV_SESSION_STARTED:
                break
        for t in texts:
            await ws.send(_frame(EV_TASK, {"event": EV_TASK, "req_params": dict(params, text=t)}, session_id))
        await ws.send(_frame(EV_FINISH_SESSION, {"event": EV_FINISH_SESSION}, session_id))
        buf = []
        while True:
            m = _parse(await asyncio.wait_for(ws.recv(), timeout=20))
            if not m:
                continue
            if m["event"] == EV_SESSION_FINISHED:
                break
            if m["event"] == EV_TTS_RESPONSE or m["type"] == _M_AUDIO_SERVER:
                if m["payload"]:
                    buf.append(m["payload"])
                    if on_chunk:
                        on_chunk(m["payload"])
        await ws.send(_frame(EV_FINISH_CONN, {"event": EV_FINISH_CONN}))
        return b"".join(buf)
    finally:
        try:
            await ws.close()
        except Exception:
            pass
