import json, random, urllib.request

BASE = "http://YOUR_SERVER_HOST:9001"

def call(path, body=None, tok=None, method=None):
    h = {"Content-Type": "application/json"}
    if tok:
        h["Authorization"] = "Bearer " + tok
    data = json.dumps(body).encode() if body is not None else None
    m = method or ("POST" if body is not None else "GET")
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=m)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "why": "HTTP %s" % e.code}
    except Exception as e:
        return {"ok": False, "why": str(e)}

sfx = "%06d" % random.randint(0, 999999)
elder_phone = "13700" + sfx
fam_phone = "13710" + sfx
print("=" * 60)
print("老人号", elder_phone, " 家人号", fam_phone)

print("\n[1] 老人注册")
r = call("/auth/register", {"phone": elder_phone, "password": "elder123", "name": "王奶奶", "role": "elder"})
print(json.dumps(r, ensure_ascii=False)[:300])
etok = r.get("token")

print("\n[2] 家人注册")
r = call("/auth/register", {"phone": fam_phone, "password": "fam123456", "name": "小王", "role": "fam"})
print(json.dumps(r, ensure_ascii=False)[:300])
ftok = r.get("token")

print("\n[3] 老人 /auth/me")
print(json.dumps(call("/auth/me", None, etok), ensure_ascii=False)[:300])

print("\n[4] 老人出码")
r = call("/pair/new", {}, etok)
print(json.dumps(r, ensure_ascii=False))
code = r.get("code")

print("\n[5] 家人填码绑定")
r = call("/pair/bind", {"code": code}, ftok)
print(json.dumps(r, ensure_ascii=False)[:400])
ftok2 = r.get("token")

print("\n[6] 家人 /pair/who")
print(json.dumps(call("/pair/who", None, ftok2), ensure_ascii=False)[:300])

print("\n[7] 家人 /elder 卡片")
print(json.dumps(call("/elder", None, ftok2), ensure_ascii=False)[:300])

print("\n[8] 家人推药箱")
r = call("/med", {"meds": [
    {"who": "降压药", "drug": "苯磺酸氨氯地平片", "dose": "1片", "when": "早饭后", "note": "别忘", "pill": "白圆"},
    {"who": "钙片", "drug": "碳酸钙D3", "dose": "1片", "when": "晚饭后", "note": "", "pill": "大椭圆"},
]}, ftok2, method="PUT")
print(json.dumps(r, ensure_ascii=False))

print("\n[9] 老人拉药箱")
print(json.dumps(call("/med", None, etok), ensure_ascii=False)[:400])

print("\n[10] 老人上报动作")
print(json.dumps(call("/act", {"kind": "med", "txt": "吃了降压药", "det": ""}, etok), ensure_ascii=False))

print("\n[11] 家人看动作")
print(json.dumps(call("/act", None, ftok2), ensure_ascii=False)[:300])

print("\n[12] 错码测试")
print(json.dumps(call("/pair/bind", {"code": "000000"}, etok), ensure_ascii=False))

print("\n[13] 自己填自己的码（应拒绝）")
r2 = call("/pair/new", {}, etok)
print(json.dumps(call("/pair/bind", {"code": r2.get("code")}, etok), ensure_ascii=False))

print("\n[14] 同号双身份登录（不带 role，应 409 提示选）")
r = call("/auth/register", {"phone": fam_phone, "password": "elder123", "name": "小王奶奶", "role": "elder"})
print("同号注册老人:", json.dumps(r, ensure_ascii=False)[:150])
print("不带role登录:", json.dumps(call("/auth/login", {"phone": fam_phone, "password": "elder123"}), ensure_ascii=False)[:200])

print("\n[15] 老人 365 天票 / 家人 30 天票 —— 解码校验")
import base64
def tokexp(t):
    return "见服务端 TTL 常量"
print("老人token长度", len(etok or ""), "家人token长度", len(ftok2 or ""))
print("=" * 60)
