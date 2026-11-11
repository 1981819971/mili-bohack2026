# -*- coding: utf-8 -*-
"""临时起 8899 静态服务 → 跑一遍 31 句 RUN1/RUN2 → 立即关掉服务。

评测只需要产品前端：MILI_AGENT 直连 api.deepseek.com，不依赖 app.py 的 TTS/代理。
用 Python 内置 http.server，避免 app.py 缺 websockets 时整条链路起不来。
服务生命周期严格限制在本进程内，不留下长驻进程。"""
import os, sys, socket, subprocess, threading, functools
import http.server

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, 'server')
PORT = 8899

def ready():
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(('127.0.0.1', PORT))
        return True
    except Exception:
        return False
    finally:
        s.close()

if ready():
    print('8899 已有服务在跑，直接复用，不另起进程', flush=True)
    srv = None
else:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SERVER)
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    print('静态服务就绪：' + SERVER, flush=True)

print('开始评测', flush=True)
r = subprocess.run(['node', os.path.join(ROOT, '_chick', 'eval-run.mjs')], cwd=ROOT)
print('eval-run 退出码', r.returncode, flush=True)
if srv:
    srv.shutdown()
    srv.server_close()
    print('临时服务已关闭')
sys.exit(r.returncode)
