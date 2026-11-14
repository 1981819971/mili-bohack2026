"""
米粒 · 账号与配对（跑在菲尔特自己的阿里云 ECS 上，跟 ASR 同一个进程）

为什么不用第三方 BaaS：
    2026-11-05 换一次登录账号，整个 App 的云端就废了 —— 数据不在自己手里就是这个代价。
    这里用 SQLite，一个文件，随时能 tar 走。

四条设计原则：
    1. 两端都注册、都登录。老人端由家人帮忙点，之后老人开机就是登录态（365 天票，
       不该每个月被踢一次）。
    2. 绑定的主动权在老人手里：老人登录后自己出 6 位码（+二维码），家人填码就绑上。
       反过来家人出码、老人填码也支持 —— 谁不方便操作，就由方便的那一方出码。
    3. 同一个手机号可以同时拥有「家人」和「老人」两个身份（UNIQUE(phone, role)）。
       老人常常没有自己的号，家人用自己的号帮他注册 —— 不这样就注册不了。
    4. 药箱只有一个作者（家人）。老人端只读 —— 两边都能改，最后一定对不上。

接口：
    POST /auth/register   {phone, password, name, role}  注册（role=fam 家人 / elder 老人）
    POST /auth/login      {phone, password, role?}       登录（role 省略时自动认）
    GET  /auth/me         Bearer                         我是谁
    POST /auth/logout     Bearer
    POST /pair/new        Bearer                         出码（老人出=家人来绑；家人出=老人来绑）
    POST /pair/bind       {code}  Bearer                 填码，换长期票
    GET  /pair/who        Bearer                         我连上了谁
    POST /pair/unbind     {uid}   Bearer                 解除绑定
    PUT  /med             Bearer(fam)   {elder_id, meds}
    GET  /med             Bearer(elder/fam)
    POST /act             Bearer(elder) {kind, txt, det}
    GET  /act             Bearer(fam)   ?elder_id=
    GET  /elder           Bearer(fam)                    家属首页那张卡
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse

DB_PATH = os.environ.get("MILI_DB", "/root/mili-data/mili.db")

# 票据有效期（秒）。家属 30 天，老人 365 天 —— 老人不该每个月被踢一次。
TTL_FAM = 30 * 86400
TTL_ELDER = 365 * 86400
PAIR_TTL = 900           # 老 /pair/new 兼容用；固定同步码不看这个
MAX_CODE_TRY = 5         # 固定码永久有效，同一个 IP 十分钟内最多试错 5 次

router = APIRouter()

ROLES = ("fam", "elder")


# ------------------------------------------------------------------ 库

def db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")     # 并发读不吃锁
    return c


def _cols(c, t):
    try:
        return [r[1] for r in c.execute("PRAGMA table_info(%s)" % t)]
    except Exception:
        return []


def _count(c, t):
    try:
        return c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
    except Exception:
        return 0


def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        salt TEXT NOT NULL,
        pwd TEXT NOT NULL,
        name TEXT DEFAULT '',
        role TEXT DEFAULT 'fam',
        created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens(
        token TEXT PRIMARY KEY,
        uid INTEGER,
        role TEXT NOT NULL,
        exp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        elder_uid INTEGER NOT NULL,
        fam_uid INTEGER NOT NULL,
        created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairs(
        code TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        owner_role TEXT NOT NULL,
        exp INTEGER NOT NULL,
        used INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meds(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        elder_id INTEGER NOT NULL,
        who TEXT, drug TEXT, dose TEXT, whenx TEXT,
        note TEXT, pill TEXT, active INTEGER DEFAULT 1, last TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS acts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        elder_id INTEGER NOT NULL,
        kind TEXT, txt TEXT, det TEXT, ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tries(ip TEXT, ts INTEGER);
    CREATE TABLE IF NOT EXISTS vitals(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        elder_id INTEGER NOT NULL,
        kind TEXT NOT NULL,          -- bp 血压 / glu 血糖
        sys INTEGER DEFAULT 0,      -- 高压
        dia INTEGER DEFAULT 0,      -- 低压
        val REAL DEFAULT 0,         -- 血糖值
        tone TEXT DEFAULT 'ok',     -- ok / warn / bad
        note TEXT DEFAULT '',
        ts INTEGER NOT NULL
    );
    """)

    # ---- 旧库迁移（2026-11-05 之前建的表结构）
    # users 没有 role 列 → 补上，旧账号一律当家人
    if "role" not in _cols(c, "users"):
        c.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'fam'")

    # 旧表是 phone TEXT UNIQUE —— 一个号只能一个身份。ALTER 拆不掉 UNIQUE 约束，
    # 必须重建表：老人常常没自己的号，得让家人用同一个号帮他注册老人端。
    sql = (c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
           .fetchone())
    if sql and "phone TEXT UNIQUE" in (sql[0] or ""):
        c.executescript("""
        ALTER TABLE users RENAME TO users_old;
        CREATE TABLE users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            salt TEXT NOT NULL,
            pwd TEXT NOT NULL,
            name TEXT DEFAULT '',
            role TEXT DEFAULT 'fam',
            created INTEGER NOT NULL
        );
        INSERT INTO users(id,phone,salt,pwd,name,role,created)
            SELECT id,phone,salt,pwd,name,COALESCE(role,'fam'),created FROM users_old;
        DROP TABLE users_old;
        """)

    # pairs 旧结构是 fam_uid，新结构是 owner_uid/owner_role。旧码本来就 15 分钟过期，直接清。
    if "owner_uid" not in _cols(c, "pairs") and _count(c, "pairs") >= 0:
        if "fam_uid" in _cols(c, "pairs"):
            c.execute("DROP TABLE pairs")
            c.execute("""CREATE TABLE pairs(
                code TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL,
                owner_role TEXT NOT NULL, exp INTEGER NOT NULL, used INTEGER DEFAULT 0)""")

    # 2026-11-10 菲尔特：一个老人账号一个固定同步码，永不过期、绑定后不销毁。
    # 旧库没有这一列，补上；空串不算冲突，用部分唯一索引。
    if "sync_code" not in _cols(c, "users"):
        c.execute("ALTER TABLE users ADD COLUMN sync_code TEXT DEFAULT ''")

    # 旧的 elders 表：把「家属名下的老人」搬成 links（老库通常是空的，搬不到就跳过）
    if "fam_uid" in _cols(c, "elders"):
        try:
            for r in c.execute("SELECT id, fam_uid, name FROM elders").fetchall():
                # 旧 elders 没有账号，只能给老人补一个「无号账号」，家人以后可帮他改
                ph = "e%06d" % r["id"]
                if not c.execute("SELECT 1 FROM users WHERE phone=?", (ph,)).fetchone():
                    salt = secrets.token_hex(16)
                    c.execute("""INSERT INTO users(phone,salt,pwd,name,role,created)
                                 VALUES(?,?,?,?,?,?)""",
                              (ph, salt, hash_pwd(secrets.token_hex(8), salt),
                               r["name"] or "老人家", "elder", int(time.time())))
                    nuid = c.execute("SELECT last_insert_rowid() i").fetchone()[0]
                    c.execute("INSERT INTO links(elder_uid,fam_uid,created) VALUES(?,?,?)",
                              (nuid, r["fam_uid"], int(time.time())))
        except Exception:
            pass
        c.execute("DROP TABLE IF EXISTS elders")

    c.executescript("""
    CREATE UNIQUE INDEX IF NOT EXISTS u_phone_role ON users(phone, role);
    CREATE UNIQUE INDEX IF NOT EXISTS u_sync_code ON users(sync_code) WHERE sync_code <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS u_link ON links(elder_uid, fam_uid);
    CREATE INDEX IF NOT EXISTS i_med ON meds(elder_id);
    CREATE INDEX IF NOT EXISTS i_act ON acts(elder_id, ts);
    CREATE INDEX IF NOT EXISTS i_link_e ON links(elder_uid);
    CREATE INDEX IF NOT EXISTS i_link_f ON links(fam_uid);
    """)
    c.commit()
    c.close()


# ------------------------------------------------------------------ 口令

def hash_pwd(pwd, salt):
    return hashlib.pbkdf2_hmac("sha256", pwd.encode(), bytes.fromhex(salt), 120000).hex()


def _new_sync_code(c):
    """给老人账号出一个全局不撞的 6 位永久同步码。"""
    for _ in range(64):
        cand = "%06d" % secrets.randbelow(1000000)
        if not c.execute("SELECT 1 FROM users WHERE sync_code=?", (cand,)).fetchone():
            return cand
    raise RuntimeError("同步码用完了")


def _sync_code_of(c, uid):
    """老账号补发一次码；之后永远返回同一个。"""
    u = c.execute("SELECT sync_code FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        return None
    if u["sync_code"]:
        return u["sync_code"]
    code = _new_sync_code(c)
    c.execute("UPDATE users SET sync_code=? WHERE id=?", (code, uid))
    c.commit()
    return code


def ok(**kw):
    d = {"ok": True}
    d.update(kw)
    return JSONResponse(d)


def bad(why, code=400):
    return JSONResponse({"ok": False, "why": why}, status_code=code)


def phone_ok(p):
    return bool(re.fullmatch(r"1\d{10}", p or ""))


def new_token(uid, role):
    t = secrets.token_urlsafe(32)
    exp = int(time.time()) + (TTL_ELDER if role == "elder" else TTL_FAM)
    c = db()
    c.execute("INSERT INTO tokens(token,uid,role,exp) VALUES(?,?,?,?)", (t, uid, role, exp))
    c.commit()
    c.close()
    return t


def who(authorization):
    """从 Authorization: Bearer xxx 认出是谁。认不出返回 None。"""
    t = (authorization or "").strip()
    if t.lower().startswith("bearer "):
        t = t[7:].strip()
    if not t:
        return None
    c = db()
    row = c.execute("SELECT * FROM tokens WHERE token=?", (t,)).fetchone()
    c.close()
    if not row or row["exp"] < time.time():
        return None
    return {"token": t, "uid": row["uid"], "role": row["role"]}


def client_ip(request):
    f = request.headers.get("x-forwarded-for", "")
    return (f.split(",")[0].strip() if f else (request.client.host if request.client else "")) or "?"


def user_row(uid):
    c = db()
    r = c.execute("SELECT id,phone,name,role FROM users WHERE id=?", (uid,)).fetchone()
    c.close()
    return dict(r) if r else None


# ------------------------------------------------------------------ 注册登录

@router.post("/auth/register")
async def register(request: Request):
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    phone = str(b.get("phone") or "").strip()
    pwd = str(b.get("password") or "")
    role = str(b.get("role") or "fam").strip()
    if role not in ROLES:
        role = "fam"
    name = str(b.get("name") or "").strip()[:12] or ("老人家" if role == "elder" else "家人")
    if not phone_ok(phone):
        return bad("手机号要 11 位，从 1 开头")
    if len(pwd) < 6:
        return bad("密码至少 6 位")

    c = db()
    if c.execute("SELECT 1 FROM users WHERE phone=? AND role=?", (phone, role)).fetchone():
        c.close()
        return bad("这个号已经注册过%s了，直接登录吧" % ("老人端" if role == "elder" else "家人端"))
    salt = secrets.token_hex(16)
    sync_code = _new_sync_code(c) if role == "elder" else ""
    try:
        c.execute("INSERT INTO users(phone,salt,pwd,name,role,created,sync_code) VALUES(?,?,?,?,?,?,?)",
                  (phone, salt, hash_pwd(pwd, salt), name, role, int(time.time()), sync_code))
        c.commit()
        uid = c.execute("SELECT id FROM users WHERE phone=? AND role=?", (phone, role)).fetchone()["id"]
    except sqlite3.IntegrityError:
        c.close()
        return bad("这个号已经注册过%s了，直接登录吧" % ("老人端" if role == "elder" else "家人端"))
    except Exception:
        c.close()
        return bad("注册没成功，再试一次")
    finally:
        try:
            c.close()
        except Exception:
            pass
    return ok(token=new_token(uid, role),
              role=role,
              user={"id": uid, "phone": phone, "name": name, "role": role})


@router.post("/auth/login")
async def login(request: Request):
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    phone = str(b.get("phone") or "").strip()
    pwd = str(b.get("password") or "")
    role = str(b.get("role") or "").strip()
    if not phone_ok(phone) or not pwd:
        return bad("手机号或密码没填全")

    # 防穷举：同一个 IP 十分钟内试错超过次数就先锁一会儿
    ip = client_ip(request)
    now = int(time.time())
    c = db()
    n = c.execute("SELECT COUNT(*) c FROM tries WHERE ip=? AND ts>?", (ip, now - 600)).fetchone()["c"]
    if n >= MAX_CODE_TRY:
        c.close()
        return bad("试错太多次了，过十分钟再来", 429)

    if role in ROLES:
        row = c.execute("SELECT * FROM users WHERE phone=? AND role=?", (phone, role)).fetchone()
    else:
        # 没指定角色：这个号只有一个身份就直接用；两个都有就让前端选
        rows = c.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchall()
        if len(rows) > 1:
            c.close()
            return JSONResponse({"ok": False, "why": "这个号注册了两种身份，先选用哪一端",
                                 "pick": [r["role"] for r in rows]}, status_code=409)
        row = rows[0] if rows else None

    if not row or hash_pwd(pwd, row["salt"]) != row["pwd"]:
        c.execute("INSERT INTO tries(ip,ts) VALUES(?,?)", (ip, now))
        c.commit()
        c.close()
        return bad("手机号或密码不对")
    c.execute("DELETE FROM tries WHERE ip=?", (ip,))
    c.commit()
    c.close()
    return ok(token=new_token(row["id"], row["role"]),
              role=row["role"],
              user={"id": row["id"], "phone": row["phone"], "name": row["name"], "role": row["role"]})


@router.get("/auth/me")
async def me(authorization: str = Header(default="")):
    w = who(authorization)
    if not w:
        return bad("没登录", 401)
    u = user_row(w["uid"])
    if not u:
        return bad("这个号没了", 401)
    peer = peer_of(w["uid"], w["role"])
    return ok(role=w["role"], user=u, peer=peer)


@router.post("/auth/logout")
async def logout(authorization: str = Header(default="")):
    w = who(authorization)
    if w:
        c = db()
        c.execute("DELETE FROM tokens WHERE token=?", (w["token"],))
        c.commit()
        c.close()
    return ok()


# ------------------------------------------------------------------ 配对
#
# 2026-11-10 菲尔特拍板：老人端注册登录 → 生成同步码；一个账号一个码，
# 绑定后码不变、改配置不换码。家人端不注册、不登录，只填这 6 位数字。
# 不加「老人点同意」那一步 —— 他现场只有一部手机，多一步就多一次手忙脚乱。
# 事后可控代替事前同意：老人端能看见已绑定的家人、能一键换码、能踢人；
# 换码只影响以后来填的人，已经绑上的家人不掉线。

def _peer_rows(uid, role):
    """我连上的人。老人 → 所有家人；家人 → 所有老人。"""
    c = db()
    if role == "elder":
        rows = c.execute("""SELECT u.id,u.phone,u.name,u.role FROM links l
                            JOIN users u ON u.id=l.fam_uid WHERE l.elder_uid=?""", (uid,)).fetchall()
    else:
        rows = c.execute("""SELECT u.id,u.phone,u.name,u.role FROM links l
                            JOIN users u ON u.id=l.elder_uid WHERE l.fam_uid=?""", (uid,)).fetchall()
    c.close()
    return [dict(r) for r in rows]


def peer_of(uid, role):
    rows = _peer_rows(uid, role)
    return rows[0] if rows else None


@router.get("/pair/code")
async def pair_code(authorization: str = Header(default="")):
    """老人端看自己的永久同步码。老账号第一次看时补发，之后永远同一个。"""
    w = who(authorization)
    if not w or w["role"] != "elder":
        return bad("要在老人端登录才能看同步码", 401)
    c = db()
    try:
        code = _sync_code_of(c, w["uid"])
        n = c.execute("SELECT COUNT(*) n FROM links WHERE elder_uid=?", (w["uid"],)).fetchone()["n"]
    finally:
        c.close()
    return ok(code=code, role="elder", peers=n, ttl=0)


@router.post("/pair/new")
async def pair_new(authorization: str = Header(default="")):
    """老 APK 兼容入口：现在也返回永久码，不再发 15 分钟临时码。"""
    return await pair_code(authorization)


@router.post("/pair/rotate")
async def pair_rotate(authorization: str = Header(default="")):
    """老人端换码。已绑定的家人不掉线，只是旧码从此填不进来。"""
    w = who(authorization)
    if not w or w["role"] != "elder":
        return bad("要在老人端登录才能换码", 401)
    c = db()
    try:
        code = _new_sync_code(c)
        c.execute("UPDATE users SET sync_code=? WHERE id=?", (code, w["uid"]))
        c.commit()
    finally:
        c.close()
    return ok(code=code)


@router.post("/pair/bind")
async def pair_bind(request: Request, authorization: str = Header(default="")):
    """家人端只填码：不用注册、不用登录、不用老人点同意。
    后端凭码找到老人，给他发一张家人票；同一台手机重复填同一个码不建第二个号。
    要请人用也不怕串号：每个家人都是一个独立的匿名 fam 账号。"""
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    code = re.sub(r"\D", "", str(b.get("code") or ""))
    if len(code) != 6:
        return bad("同步码是 6 位数字")

    ip = client_ip(request)
    now = int(time.time())
    c = db()
    n = c.execute("SELECT COUNT(*) c FROM tries WHERE ip=? AND ts>?", (ip, now - 600)).fetchone()["c"]
    if n >= MAX_CODE_TRY:
        c.close()
        return bad("试错太多次了，过十分钟再来", 429)

    elder = c.execute("SELECT id,name,phone FROM users WHERE sync_code=? AND role='elder'",
                      (code,)).fetchone()
    if not elder:
        c.execute("INSERT INTO tries(ip,ts) VALUES(?,?)", (ip, now))
        c.commit()
        c.close()
        return bad("没找到这个同步码，看看老人手机上那 6 位数字")

    fam_name = str(b.get("name") or "").strip()[:12] or "家人"
    w = who(authorization)
    if w and w["role"] == "fam":
        fam_uid = w["uid"]
        c.execute("UPDATE users SET name=? WHERE id=?", (fam_name, fam_uid))
    else:
        # 匿名家人账号：用户看不到注册界面，但后端继续复用原有 token / role 逻辑，
        # 这样 /auth/me、/pair/who、/elder、/med 一条都不用改。
        salt = secrets.token_hex(16)
        c.execute("""INSERT INTO users(phone,salt,pwd,name,role,created,sync_code)
                     VALUES(?,?,?,?,?,?,?)""",
                  ("f" + secrets.token_hex(7), salt,
                   hash_pwd(secrets.token_hex(12), salt), fam_name, "fam", now, ""))
        fam_uid = c.execute("SELECT last_insert_rowid() i").fetchone()["i"]
    c.execute("INSERT OR IGNORE INTO links(elder_uid,fam_uid,created) VALUES(?,?,?)",
              (elder["id"], fam_uid, now))
    c.execute("DELETE FROM tries WHERE ip=?", (ip,))
    c.commit()
    peer = {"id": elder["id"], "name": elder["name"], "phone": elder["phone"]}
    c.close()
    return ok(token=new_token(fam_uid, "fam"), role="fam",
              peer=peer, elder_id=elder["id"], name=fam_name)


@router.get("/pair/who")
async def pair_who(authorization: str = Header(default="")):
    w = who(authorization)
    if not w:
        return bad("没登录", 401)
    return ok(role=w["role"], peers=_peer_rows(w["uid"], w["role"]))


@router.post("/pair/unbind")
async def pair_unbind(request: Request, authorization: str = Header(default="")):
    w = who(authorization)
    if not w:
        return bad("没登录", 401)
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    uid = int(b.get("uid") or 0)
    c = db()
    if w["role"] == "elder":
        c.execute("DELETE FROM links WHERE elder_uid=? AND fam_uid=?", (w["uid"], uid))
    else:
        c.execute("DELETE FROM links WHERE fam_uid=? AND elder_uid=?", (w["uid"], uid))
    c.commit()
    c.close()
    return ok()


# ------------------------------------------------------------------ 药箱
#
# 药箱只有一个作者（家人）。老人端只读 —— 两边都能改，最后一定对不上。

def _first_elder_of_fam(c, fam_uid):
    r = c.execute("""SELECT u.id,u.name FROM links l JOIN users u ON u.id=l.elder_uid
                     WHERE l.fam_uid=? ORDER BY l.id DESC LIMIT 1""", (fam_uid,)).fetchone()
    return dict(r) if r else None


@router.put("/med")
async def med_put(request: Request, authorization: str = Header(default="")):
    w = who(authorization)
    if not w or w["role"] != "fam":
        return bad("得家人登录才能改药箱", 401)
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    c = db()
    eid = int(b.get("elder_id") or 0)
    if not eid:
        e = _first_elder_of_fam(c, w["uid"])
        if not e:
            c.close()
            return bad("还没连上老人的手机，先让老人出一个码")
        eid = e["id"]
    else:
        if not c.execute("SELECT 1 FROM links WHERE elder_uid=? AND fam_uid=?", (eid, w["uid"])).fetchone():
            c.close()
            return bad("这不是你家连上的老人", 403)

    meds = b.get("meds") or []
    c.execute("DELETE FROM meds WHERE elder_id=?", (eid,))
    for m in meds:
        if not isinstance(m, dict) or not (m.get("who") or m.get("drug")):
            continue
        c.execute("""INSERT INTO meds(elder_id,who,drug,dose,whenx,note,pill,active,last)
                     VALUES(?,?,?,?,?,?,?,1,?)""",
                  (eid, str(m.get("who") or "")[:20], str(m.get("drug") or "")[:40],
                   str(m.get("dose") or "")[:20], str(m.get("when") or "")[:40],
                   str(m.get("note") or "")[:120], str(m.get("pill") or "")[:20],
                   str(m.get("last") or "")[:20]))
    c.commit()
    c.close()
    return ok(n=len(meds), elder_id=eid)


@router.get("/med")
async def med_get(request: Request, authorization: str = Header(default="")):
    w = who(authorization)
    if not w:
        return bad("没登录", 401)
    c = db()
    if w["role"] == "elder":
        eid = w["uid"]
    else:
        eid = int(request.query_params.get("elder_id") or 0)
        if not eid:
            e = _first_elder_of_fam(c, w["uid"])
            if not e:
                c.close()
                return ok(meds=[], elder_id=None)
            eid = e["id"]
        elif not c.execute("SELECT 1 FROM links WHERE elder_uid=? AND fam_uid=?", (eid, w["uid"])).fetchone():
            c.close()
            return bad("这不是你家连上的老人", 403)
    rows = c.execute("SELECT * FROM meds WHERE elder_id=? AND active=1 ORDER BY id", (eid,)).fetchall()
    c.close()
    return ok(meds=[dict(r) for r in rows], elder_id=eid)


# ------------------------------------------------------------------ 办过的事

@router.post("/act")
async def act_post(request: Request, authorization: str = Header(default="")):
    w = who(authorization)
    if not w or w["role"] != "elder":
        return bad("得老人端才能上报", 401)
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    c = db()
    c.execute("INSERT INTO acts(elder_id,kind,txt,det,ts) VALUES(?,?,?,?,?)",
              (w["uid"], str(b.get("kind") or "")[:20], str(b.get("txt") or "")[:60],
               str(b.get("det") or "")[:200], int(time.time())))
    # 只留最近 200 条，别把盘塞满
    c.execute("DELETE FROM acts WHERE elder_id=? AND id NOT IN "
              "(SELECT id FROM acts WHERE elder_id=? ORDER BY id DESC LIMIT 200)",
              (w["uid"], w["uid"]))
    c.commit()
    c.close()
    return ok()


@router.get("/act")
async def act_get(request: Request, authorization: str = Header(default="")):
    w = who(authorization)
    if not w:
        return bad("没登录", 401)
    c = db()
    if w["role"] == "elder":
        eid = w["uid"]
    else:
        eid = int(request.query_params.get("elder_id") or 0)
        if not eid:
            e = _first_elder_of_fam(c, w["uid"])
            eid = e["id"] if e else 0
    rows = c.execute("SELECT * FROM acts WHERE elder_id=? ORDER BY id DESC LIMIT 40",
                     (eid,)).fetchall() if eid else []
    c.close()
    return ok(acts=[dict(r) for r in rows])


# ------------------------------------------------------------------ 家属首页那张卡

@router.get("/elder")
async def elder_card(request: Request, authorization: str = Header(default="")):
    """家属端首页：老人叫什么、几颗药、最后一条动静、连了几个家人。"""
    w = who(authorization)
    if not w or w["role"] != "fam":
        return bad("得家人登录", 401)
    c = db()
    eid = int(request.query_params.get("elder_id") or 0)
    if eid:
        if not c.execute("SELECT 1 FROM links WHERE elder_uid=? AND fam_uid=?", (eid, w["uid"])).fetchone():
            c.close()
            return bad("这不是你家连上的老人", 403)
        e = c.execute("SELECT id,name FROM users WHERE id=?", (eid,)).fetchone()
        e = dict(e) if e else None
    else:
        e = _first_elder_of_fam(c, w["uid"])
    if not e:
        c.close()
        return JSONResponse({"ok": False, "why": "还没连上老人的手机"})
    n = c.execute("SELECT COUNT(*) c FROM meds WHERE elder_id=? AND active=1", (e["id"],)).fetchone()["c"]
    a = c.execute("SELECT * FROM acts WHERE elder_id=? ORDER BY id DESC LIMIT 1", (e["id"],)).fetchone()
    fam_n = c.execute("SELECT COUNT(*) c FROM links WHERE elder_uid=?", (e["id"],)).fetchone()["c"]
    # 2026-11-06 修：前端读的是 nmed / lastat / nact / acts，这里原来返回 meds / last，
    # 名字对不上 → 家人端概况卡永远显示「0 种药」「老人还没用过」。
    # 现在两边对齐；meds / last 保留，旧调用方不至于挂。
    nact = c.execute("SELECT COUNT(*) c FROM acts WHERE elder_id=? AND ts>=?",
                     (e["id"], int(time.time()) - 86400)).fetchone()["c"]
    acts = c.execute("SELECT kind,txt,det,ts FROM acts WHERE elder_id=? ORDER BY id DESC LIMIT 12",
                     (e["id"],)).fetchall()
    v = c.execute("SELECT * FROM vitals WHERE elder_id=? ORDER BY id DESC LIMIT 1",
                  (e["id"],)).fetchone()
    c.close()
    return ok(elder_id=e["id"], name=e["name"],
              nmed=n, meds=n, fam_n=fam_n,
              nact=nact,
              lastat=(a["ts"] * 1000 if a else 0), last=(dict(a) if a else None),
              acts=[dict(x) for x in acts],
              vital=(dict(v) if v else None))


# ------------------------------------------------------------------ 血压血糖

# 阈值只在这里定一次。前端不重复一份 —— 两份阈值迟早对不上，
# 到时候老人看到「正常」、家人看到「偏高」，比没有还糟。
BP_WARN = (140, 90)     # 高压 >= 140 或 低压 >= 90 → 偏高
BP_BAD = (160, 100)     # → 很高，必须告诉家人
GLU_WARN = (7.0, 3.9)   # 空腹高于 7.0 或低于 3.9 → 异常
GLU_BAD = (11.1, 3.0)


def _vital_tone(kind: str, sys: int, dia: int, val: float) -> str:
    if kind == "bp":
        if sys >= BP_BAD[0] or dia >= BP_BAD[1]:
            return "bad"
        if sys >= BP_WARN[0] or dia >= BP_WARN[1]:
            return "warn"
        return "ok"
    if val >= GLU_BAD[0] or val <= GLU_BAD[1]:
        return "bad"
    if val >= GLU_WARN[0] or val <= GLU_WARN[1]:
        return "warn"
    return "ok"


@router.post("/vital")
async def vital_post(request: Request, authorization: str = Header(default="")):
    """老人端量完记一笔。超标要立刻能被家人看到，所以这一步不能静默失败。"""
    w = who(authorization)
    if not w or w["role"] != "elder":
        return bad("得老人端才能记", 401)
    try:
        b = await request.json()
    except Exception:
        return bad("没收到内容")
    kind = "bp" if str(b.get("kind") or "") == "bp" else "glu"
    try:
        sys_ = int(b.get("sys") or 0)
        dia = int(b.get("dia") or 0)
        val = float(b.get("val") or 0)
    except Exception:
        return bad("数字读不出来")
    if kind == "bp" and (sys_ <= 0 or dia <= 0):
        return bad("高压低压都要填")
    if kind == "glu" and val <= 0:
        return bad("血糖要填个数")
    tone = _vital_tone(kind, sys_, dia, val)
    c = db()
    c.execute("INSERT INTO vitals(elder_id,kind,sys,dia,val,tone,note,ts) VALUES(?,?,?,?,?,?,?,?)",
              (w["uid"], kind, sys_, dia, val, tone,
               str(b.get("note") or "")[:60], int(time.time())))
    # 只留最近 120 条
    c.execute("DELETE FROM vitals WHERE elder_id=? AND id NOT IN "
              "(SELECT id FROM vitals WHERE elder_id=? ORDER BY id DESC LIMIT 120)",
              (w["uid"], w["uid"]))
    c.commit()

    # 连着三次不 ok 就算「持续超标」—— 单次高可能是刚爬完楼，连着高才是事。
    last3 = c.execute("SELECT tone FROM vitals WHERE elder_id=? AND kind=? "
                      "ORDER BY id DESC LIMIT 3", (w["uid"], kind)).fetchall()
    alarm = len(last3) >= 3 and all(r["tone"] != "ok" for r in last3)
    c.close()
    return ok(tone=tone, alarm=bool(alarm))


@router.get("/vital")
async def vital_get(request: Request, authorization: str = Header(default="")):
    w = who(authorization)
    if not w:
        return bad("没登录", 401)
    c = db()
    if w["role"] == "elder":
        eid = w["uid"]
    else:
        eid = int(request.query_params.get("elder_id") or 0)
        if not eid:
            e = _first_elder_of_fam(c, w["uid"])
            if not e:
                c.close()
                return ok(items=[], elder_id=None)
            eid = e["id"]
        elif not c.execute("SELECT 1 FROM links WHERE elder_uid=? AND fam_uid=?",
                           (eid, w["uid"])).fetchone():
            c.close()
            return bad("这不是你家连上的老人", 403)
    rows = c.execute("SELECT * FROM vitals WHERE elder_id=? ORDER BY id DESC LIMIT 40",
                     (eid,)).fetchall()
    c.close()
    return ok(items=[dict(r) for r in rows], elder_id=eid)


# ------------------------------------------------------------------ 健康检查

@router.get("/auth/ping")
async def ping():
    return ok(srv="mili", t=int(time.time()))

# ------------------------------------------------------------------ 启动
# init() 只被定义、从来没有调用点 —— 直接 uvicorn 起这个模块时表不会建，
# 第一次注册就报 no such table。这里在导入时幂等执行一次；
# 失败不阻断导入（打印出来，由启动日志暴露），避免本机没写权限时连模块都加载不了。
# 设 MILI_AUTOINIT=0 可关掉（由外部入口自己调 init）。
if os.environ.get("MILI_AUTOINIT", "1") == "1":
    try:
        init()
    except Exception as _e:  # noqa: BLE001
        print("[mili_auth] init skipped:", _e)
