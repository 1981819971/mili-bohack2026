/* ============================================================================
 * 米粒自己的服务器（阿里云 your-ecs-host.example.com:9001，跟语音识别同一个进程）
 *
 * 为什么换了：原来用第三方 BaaS，2026-11-05 一换登录账号，整个 App 的云端就废了。
 * 数据不在自己手里，就是这样。现在账号、配对、药箱全在 `/root/mili-data/mili.db`，
 * 一个文件，随时 tar 走。
 *
 * 账号设计（2026-11-06 菲尔特定）：
 *   两端都注册、都登录。老人端由家人帮忙点一次，之后开机就是登录态。
 *   绑定的主动权在老人这边 —— 老人自己出一个 6 位码（还带二维码），家人填码就绑上。
 *   家人出码、老人填码也支持：谁不方便操作，就由方便的那方出码。
 *
 * 为什么不用短信：签名和模板要审核，赛前不赌这个。密码比验证码还好记。
 * ========================================================================== */
const MILI_API = 'http://your-ecs-host.example.com:9001';

/* 一张票走天下。角色存在 S.accRole 里（'elder' / 'fam'）。
   以前分 famToken / elderToken 两本，切端就得切票 —— 现在一个号两个身份，票跟着身份走。 */
function accToken() {
  return S.accToken || S.famToken || S.elderToken || '';
}

function accRole() {
  return S.accRole || (S.role === 'family' ? 'fam' : 'elder');
}

/* 统一出口。tok 传 '' 表示这次不带票（登录、注册、绑定时用）。 */
async function accApi(path, o) {
  o = o || {};
  const h = { 'Content-Type': 'application/json' };
  let tok = o.tok;
  if (tok === undefined) tok = accToken();
  if (tok) h['Authorization'] = 'Bearer ' + tok;
  const method = o.method || (o.body ? 'POST' : 'GET');
  try {
    const r = await fetch(MILI_API + path, {
      method: method,
      headers: h,
      body: o.body ? JSON.stringify(o.body) : undefined,
      cache: 'no-store',
    });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      const out = { ok: false, why: d.why || ('服务器说不行（' + r.status + '）') };
      if (d.pick) out.pick = d.pick;
      return out;
    }
    return d;
  } catch (e) {
    return { ok: false, why: '连不上米粒的服务器，看看是不是断网了' };
  }
}

/* 这段路得说清楚：页面是 https，服务器是 http。
   WebView 里已经放开混合内容，但用手机浏览器直接打开线上版会被浏览器自己拦掉。
   演示和真机都走 APK，所以不影响。 */
async function accSession() {
  if (DEMO) return null;
  if (!accToken()) { ACC.user = null; return null; }
  const d = await accApi('/auth/me');
  if (!d.ok || !d.user) { ACC.user = null; return null; }
  ACC.user = {
    id: d.user.id, phone: d.user.phone || S.mePhone || '',
    name: d.user.name || '', role: d.role || '',
  };
  ACC.link = d.peer ? { peer: d.peer } : null;
  if (d.role) S.accRole = d.role;
  if (d.user.name) S.accName = d.user.name;
  save();
  return ACC.user;
}

/* 登录。role 传了就认那个身份，不传让服务端自己认（同号两身份时它会回 409 + pick）。 */
async function accLogin(phone, pwd, role) {
  if (DEMO) return { ok: false, why: '演示版不登录。要看账号功能，用产品版。' };
  phone = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(phone)) return { ok: false, why: '手机号要 11 位，从 1 开头。' };
  if (!pwd || String(pwd).length < 6) return { ok: false, why: '密码至少 6 位。' };
  const body = { phone: phone, password: String(pwd) };
  if (role === 'fam' || role === 'elder') body.role = role;
  const d = await accApi('/auth/login', { body: body, tok: '' });
  if (!d.ok) return d;
  S.accToken = d.token || '';
  S.famToken = ''; S.elderToken = '';
  S.accRole = d.role || (role === 'fam' ? 'fam' : 'elder');
  S.accPhone = phone;
  S.mePhone = phone;
  S.accName = (d.user && d.user.name) || '';
  S.famName = S.accRole === 'fam' ? S.accName : '';
  save();
  ACC.user = d.user || null;
  ACC.link = d.peer ? { peer: d.peer } : null;
  /* 登录的是老人端 —— 把家人填的药拉下来；是家人端 —— 把本地药箱推上去 */
  if (S.accRole === 'elder') pullMeds().catch(function () {});
  return { ok: true, user: d.user, role: S.accRole, peer: d.peer || null };
}

async function accRegister(phone, pwd, name, role) {
  if (DEMO) return { ok: false, why: '演示版不注册。要看账号功能，用产品版。' };
  phone = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(phone)) return { ok: false, why: '手机号要 11 位，从 1 开头。' };
  if (!pwd || String(pwd).length < 6) return { ok: false, why: '密码至少 6 位。' };
  const r0 = (role === 'fam' || role === 'elder') ? role : 'elder';
  const d = await accApi('/auth/register', {
    body: { phone: phone, password: String(pwd), name: String(name || '').slice(0, 12), role: r0 }, tok: '',
  });
  if (!d.ok) return d;
  S.accToken = d.token || '';
  S.famToken = ''; S.elderToken = '';
  S.accRole = d.role || r0;
  S.accPhone = phone;
  S.mePhone = phone;
  S.accName = (d.user && d.user.name) || '';
  save();
  ACC.user = d.user || null;
  return { ok: true, user: d.user, role: S.accRole };
}

async function accLogout() {
  ACC.user = null; ACC.link = null;
  const had = accToken();
  S.mePhone = ''; S.famToken = ''; S.elderToken = '';
  S.accToken = ''; S.accRole = ''; S.accPhone = ''; S.accName = '';
  S.famName = ''; S.pairCode = ''; S.pairFam = '';
  save();
  if (had) { try { await accApi('/auth/logout', { body: {} }); } catch (e) {} }
}

/* 出码。谁登录谁就能出 —— 老人出给家人填，家人出给老人填。
   码在服务端生成：客户端算容易撞，也不可信。 */
async function accNewCode() {
  if (DEMO) return { ok: false, why: '演示版不连真实账号。' };
  if (!accToken()) return { ok: false, why: '先登录，再出码。' };
  const d = await accApi('/pair/new', { body: {} });
  if (!d.ok) return d;
  S.pairCode = d.code;
  S.pairAt = Date.now();
  save();
  return { ok: true, code: d.code, ttl: d.ttl || 900, role: d.role || accRole() };
}

/* 填码。填码方必须已登录。填完拿到一张长期票（老人 365 天）。 */
async function accPair(code) {
  if (DEMO) return { ok: false, why: '演示版不连真实账号。' };
  if (!accToken()) return { ok: false, why: '先登录，再填码。' };
  const k = String(code || '').replace(/\D/g, '');
  if (k.length !== 6) return { ok: false, why: '配对码是 6 位数字' };
  const d = await accApi('/pair/bind', { body: { code: k } });
  if (!d.ok) return d;
  S.accToken = d.token || S.accToken;
  S.pairFam = (d.peer && d.peer.name) || '家人';
  ACC.link = { peer: d.peer || null };
  save();
  if (accRole() === 'elder') await pullMeds();
  return { ok: true, peer: d.peer || null, name: S.pairFam, role: d.role || accRole() };
}

/* 我连上了谁。一个老人可能连着好几个家人。 */
async function accPeers() {
  if (!accToken()) return [];
  const d = await accApi('/pair/who');
  return (d && d.ok && d.peers) ? d.peers : [];
}

async function accUnbind(uid) {
  if (!accToken()) return { ok: false, why: '没登录' };
  const d = await accApi('/pair/unbind', { body: { uid: uid } });
  return d;
}

/* 老人端：把家人填的药拉下来，覆盖本地药箱。
   家人是药箱的唯一作者 —— 老人端只读，这样不会出现两边各改一半对不上的情况。 */
async function pullMeds() {
  if (!accToken() || accRole() !== 'elder') return 0;
  const d = await accApi('/med');
  if (!d.ok) return 0;
  const rows = d.meds || [];
  if (!rows.length) return 0;
  S.med = rows.map((x) => ({
    who: x.who || '', full: x.drug || x.who || '', dose: x.dose || '',
    when: x.whenx || '', note: x.note || '', pill: x.pill || '',
    alias: [], on: true, last: x.last || '',
  }));
  save();
  return S.med.length;
}

/* 家人端：把本地药箱推上去，给连上的老人手机用。 */
async function pushMeds(elderId) {
  if (!accToken() || accRole() !== 'fam') return { ok: false, why: '得家人登录' };
  const rows = (S.med || []).filter((m) => m.on).map((m) => ({
    who: m.who, drug: m.full || m.who, dose: m.dose,
    when: m.when, note: m.note, pill: m.pill || '', last: m.last || '',
  }));
  const body = { meds: rows };
  if (elderId) body.elder_id = elderId;
  const d = await accApi('/med', { body: body, method: 'PUT' });
  if (!d.ok) return d;
  return { ok: true, n: rows.length, elder_id: d.elder_id };
}

/* 家人端：拉老人的今日概况（几颗药 + 最近办的一件事） */
async function accElderCard(elderId) {
  if (!accToken() || accRole() !== 'fam') return null;
  const d = await accApi('/elder' + (elderId ? ('?elder_id=' + elderId) : ''));
  if (!d || d.ok !== true) return d || null;
  ACC.link = { peer: { id: d.elder_id, name: d.name } };
  return d;
}

/* 老人端：把「刚办成一件事」上报。家人端首页就能看见。
   没配对时静默失败 —— 上报不是主线，不能因为它报错就打断老人正在做的事。 */
function accLogAct(kind, text, detail) {
  if (DEMO || !accToken() || accRole() !== 'elder') return;
  try {
    accApi('/act', {
      body: { kind: String(kind || ''), txt: String(text || '').slice(0, 60),
        det: detail ? String(detail).slice(0, 200) : '' },
    }).catch(function () {});
  } catch (e) {}
}

/* ============================================================================
 * 二维码：纯前端生成，不走服务端
 *
 * 为什么不放服务端：ECS 上没装 qrcode / PIL，装库要动系统 Python 环境，
 * 为一个二维码不值得。qrcode-generator 是 56KB 纯 JS、无依赖、离线可用，
 * 老人这台手机没网也能把自己那个码显示出来 —— 反而更稳。
 * ========================================================================== */

/* 懒加载：只有真要用二维码时才去拿那 56KB，平时不拖慢开机。 */
let _qrLib = null;
function qrLoad() {
  if (_qrLib) return Promise.resolve(_qrLib);
  return new Promise(function (res, rej) {
    const s = document.createElement('script');
    s.src = 'vendor/qrcode.js';
    s.onload = function () {
      if (window.qrcode) { _qrLib = window.qrcode; res(_qrLib); }
      else rej(new Error('二维码库没加载上'));
    };
    s.onerror = function () { rej(new Error('二维码库没加载上')); };
    document.head.appendChild(s);
  });
}

/* 把一段文字画成二维码，返回 dataURL（可直接塞进 <img>）。
   cellSize 按屏幕密度算 —— 老人手机屏幕大小差别很大，固定像素会糊。 */
async function qrDataUrl(text, cell) {
  const Q = await qrLoad();
  const q = Q(0, 'M');
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  const c = cell || 4;
  const pad = 2;
  const size = (n + pad * 2) * c;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#1A1A1A';
  for (let r = 0; r < n; r++) {
    for (let c2 = 0; c2 < n; c2++) {
      if (q.isDark(r, c2)) {
        g.fillRect((c2 + pad) * c, (r + pad) * c, c, c);
      }
    }
  }
  return cv.toDataURL('image/png');
}
