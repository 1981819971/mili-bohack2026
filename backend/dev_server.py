# -*- coding: utf-8 -*-
"""米粒的线上版：静态资源 + 童声合成。

为什么还要一个服务端？
1. 发页面和资源（部署要求必须有个 HTTP 服务）
2. /tts：动态内容（模型现想出来的话）也用同一副 XiaoyiNeural 念，
   跟预生成的 87 句听不出差别。模型调用仍然由前端 SDK 直连，不经过这里。

官方明确禁止自建后端中转模型 —— 所以这里一行模型调用都没有。

资源为什么要分开发，而不是全塞进一个 HTML：
    之前是 12.83MB 单文件，其中 11.94MB 是 base64 的模型和音频。
    WebView 一打开就得先解析整个巨型 <script>，再解码 8MB 的 ArrayBuffer，
    内存峰值直接顶满 —— 手机上表现为「经常卡死、点什么都没反应」。
    现在模型和音频是独立文件，按需下载，首屏只要 three + app.js。
"""
import asyncio
import gzip
import hashlib
import io
import os
import urllib.error
import urllib.request

# 开发模式（MILI_DEV=1）：一律 no-store。
# 默认缓存一天会把改过的 app.js 锁在 WebView 里 —— 改半天代码，手机上跑的还是旧的。
_DEV = os.environ.get("MILI_DEV") == "1"
_CACHE = "no-store, must-revalidate" if _DEV else "public, max-age=86400"

# 开发期的 /api 透传目标（例：MILI_API_UP=http://YOUR_SERVER_HOST:9001）。
# 为什么需要：模拟器到 ECS 的 9001 连得上但收不到一个字，同一请求在主机上是 200。
# 为了在模拟器里把登录/配对/传话这条链跑通，借这个静态服务同源转一层 ——
# 同源还有好处：没有跨域，WebView 里也不会被明文策略挑出来。
# 线上不设这个环境变量，这块代码就是死的。
_UP = os.environ.get("MILI_API_UP", "").rstrip("/")

# 显式关掉环境里的代理：本机起服务时常被 HTTP_PROXY 带偏，转出去变成 502。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts
import queue
import threading

import doubao_tts

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".ttscache")
os.makedirs(CACHE, exist_ok=True)

# 跟预生成语料完全同一副嗓子、同一组参数
VOICE = "zh-CN-XiaoyiNeural"
RATE = "-6%"
PITCH = "+34Hz"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}

# 这些后缀才值得 gzip（glb/mp3/png 本身就是压缩格式，再压没意义还费 CPU）
GZIP_EXT = {".html", ".js", ".mjs", ".css", ".json", ".svg"}


def _cache_key(text: str) -> str:
    """缓存键要把合成引擎和音色都算进去。
    不然后来换了嗓子，老人听到的还是旧音色的缓存，查半天查不出问题。"""
    if doubao_tts.available():
        feel = "doubao|" + doubao_tts.SPEAKER
    else:
        feel = "edge|" + VOICE + RATE + PITCH
    return hashlib.md5((feel + text).encode("utf-8")).hexdigest()


def tts_bytes(text: str) -> bytes:
    """同一句话只合成一次，之后走磁盘缓存。

    优先豆包语音合成 2.0（首音 392ms）；
    豆包不通（没 key / 网络断 / 欠费）才退回 edge_tts（首音 2000ms）。
    这条兜底必须留着 —— 老人不会因为服务欠费就不过日子。
    """
    path = os.path.join(CACHE, _cache_key(text) + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 500:
        return open(path, "rb").read()

    data = b""
    if doubao_tts.available():
        try:
            data = doubao_tts.synth_blocking(text, speech_rate=-8)
        except Exception as e:
            print("[tts] 豆包失败，退回 edge_tts：%s" % e, flush=True)
            data = b""

    if len(data) <= 500:
        async def run():
            com = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
            buf = bytearray()
            async for chunk in com.stream():
                if chunk["type"] == "audio":
                    buf.extend(chunk["data"])
            return bytes(buf)

        data = asyncio_run(run())

    if len(data) > 500:
        with open(path, "wb") as f:
            f.write(data)
    return data


def tts_stream(text: str):
    """边合成边把音频块吐出来。

    以前是 tts_bytes：把整句合成完、攒成一个 bytes 再一次性发。
    于是「第一句已经到了」这件事，客户端要等服务端全部搞完才知道 ——
    手机上表现就是：模型已经说完第一句了，还要再干等一秒多才有声音。

    现在改成生成器，一个块好了就往外递一块。配合前端的 <audio preload>，
    合成和播放是重叠的，首声只等第一块。

    已缓存的句子照样整块返回 —— 磁盘读比网络快得多，再分块是自找麻烦。
    """
    path = os.path.join(CACHE, _cache_key(text) + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 500:
        yield open(path, "rb").read()
        return

    q = queue.Queue()
    SENTINEL = object()

    def worker():
        buf = bytearray()

        def push(d):
            buf.extend(d)
            q.put(bytes(d))

        try:
            if doubao_tts.available():
                loop = asyncio.new_event_loop()
                try:
                    loop.run_until_complete(_doubao_synth(text, push))
                except Exception as e:
                    # 一个字都没吐出去才允许兜底。
                    # 已经发了一半再换引擎，客户端听到的是两个人的声音。
                    if buf:
                        raise
                    print("[tts-stream] 豆包失败，退回 edge_tts：%s" % e, flush=True)
                finally:
                    loop.close()

            if len(buf) <= 500:
                async def run():
                    com = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
                    async for chunk in com.stream():
                        if chunk["type"] == "audio":
                            push(chunk["data"])

                asyncio_run(run())

            if len(buf) > 500:
                with open(path, "wb") as f:
                    f.write(bytes(buf))
        except Exception as e:
            q.put(e)
        finally:
            q.put(SENTINEL)

    threading.Thread(target=worker, daemon=True).start()

    while True:
        item = q.get()
        if item is SENTINEL:
            return
        if isinstance(item, Exception):
            raise item
        yield item


async def _doubao_synth(text, on_chunk):
    from doubao_tts import _synth_async
    await _synth_async(text, speech_rate=-8, on_chunk=on_chunk)


def asyncio_run(coro):
    """edge_tts 需要事件循环。新线程里没有，得自己建。"""
    import asyncio
    try:
        loop = asyncio.new_event_loop()
        return loop.run_until_complete(coro)
    finally:
        try:
            loop.close()
        except Exception:
            pass


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"      # 长连接：一个 TCP 里连拉十几个资源，手机端省一大截

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype, cache=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache or _CACHE)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _file(self, rel, cache=None):
        """发一个静态文件。带 gzip 和 ETag，省流量也省解析。"""
        # 目录穿越防护：拼出来的路径必须还在 HERE 里
        p = os.path.normpath(os.path.join(HERE, rel.lstrip("/")))
        if not p.startswith(os.path.normpath(HERE)):
            self._send(403, b"forbidden", "text/plain")
            return
        if not os.path.isfile(p):
            self._send(404, b"not found", "text/plain")
            return

        ext = os.path.splitext(p)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        raw = open(p, "rb").read()
        etag = '"%x-%x"' % (len(raw), int(os.path.getmtime(p)))

        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        body = raw
        gz = False
        if ext in GZIP_EXT and len(raw) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(raw, 6)
            gz = True

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache or _CACHE)
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        u = urllib.parse.urlparse(self.path)
        path = u.path

        if path.startswith("/api/"):
            self._proxy("GET")
            return

        if path == "/tts":
            q = urllib.parse.parse_qs(u.query)
            text = (q.get("t") or [""])[0].strip()
            if not text:
                self._send(400, b"missing t", "text/plain")
                return
            text = text[:160]     # 限长，别被人拿来刷

            # 先拿到第一块再发头。拿不到就还来得及回 502 ——
            # 一旦把 200 头发出去，后面出错只能硬断，前端看到的是半个文件。
            try:
                chunks = tts_stream(text)
                first = next(chunks, b"")
            except Exception as e:
                self._send(502, ("tts error: %s" % e).encode("utf-8"), "text/plain")
                return
            if not first:
                self._send(502, b"tts empty", "text/plain")
                return

            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Access-Control-Allow-Origin", "*")
            # 同一句话（同一个老人常说的话）浏览器自己存着，第二次 0ms
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()

            def wchunk(b):
                if not b:
                    return
                self.wfile.write(b"%x\r\n" % len(b))
                self.wfile.write(b)
                self.wfile.write(b"\r\n")

            try:
                wchunk(first)
                for c in chunks:
                    wchunk(c)
                self.wfile.write(b"0\r\n\r\n")   # 收尾块
            except Exception:
                # 客户端提前走了（老人插话打断，<audio> 被换掉）。
                # 服务端没必要为此报错，磁盘缓存已经写好了，下次照样快。
                pass
            return

        if path in ("/", "/index.html"):
            self._file("index.html", "no-store, no-cache, must-revalidate")
            return

        if path in ("/demo", "/demo.html", "/demo/"):
            self._file("demo.html", "no-store, no-cache, must-revalidate")
            return

        if path == "/health":
            self._send(200, b"ok", "text/plain")
            return

        # 其余一律当静态资源：app.js / evolve.js / data.js / vendor/ / assets/
        self._file(path)

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy("POST")
            return
        self._send(404, b"not found", "text/plain")

    def do_PUT(self):
        # 药箱是 PUT /med。这里原来没接，直接 501 ——
        # 家人换了药，服务端一条也没收到，老人那边自然什么都没有。
        if self.path.startswith("/api/"):
            self._proxy("PUT")
            return
        self._send(404, b"not found", "text/plain")

    def _proxy(self, method):
        """/api/xxx → 上游 /xxx。只转认证头、正文和内容类型，别的头一概不带。"""
        if not _UP:
            self._send(404, b'{"ok":false,"why":"no upstream"}', "application/json")
            return
        rest = self.path[len("/api"):] or "/"
        url = _UP + rest
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        body = self.rfile.read(n) if n > 0 else None
        req = urllib.request.Request(url, data=body, method=method)
        for k in ("Content-Type", "Authorization"):
            v = self.headers.get(k)
            if v:
                req.add_header(k, v)
        try:
            with _OPENER.open(req, timeout=25) as r:
                self._send(getattr(r, "status", 200), r.read(),
                           r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(),
                       e.headers.get("Content-Type", "application/json"))
        except Exception as e:
            self._send(502, ('{"ok":false,"why":"proxy: %s"}' % e).encode("utf-8"),
                       "application/json")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    print("serving on 0.0.0.0:%d" % port, flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
