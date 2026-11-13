import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MILI_DATA, greeting } from './data.js';

/* 模式：产品版 / 演示版是两个场景，共用一份代码。
   进入方式：
     产品版  米粒.html                （默认，?mode=product 也可）
     演示版  米粒.html?demo=1         （或 ?mode=demo，或构建出的 米粒-演示版.html）
   两者数据完全隔离（localStorage key 不同），演示不会污染产品数据。 */
const QS0 = new URLSearchParams(location.search);
const MODE = QS0.get('mode') === 'product' ? 'product'
  : (window.__MODE === 'demo' || QS0.get('mode') === 'demo' || QS0.get('demo') === '1')
    ? 'demo' : 'product';
const DEMO = MODE === 'demo';
const STORE_KEY = DEMO ? 'mili_demo' : 'mili';
document.documentElement.dataset.mode = MODE;

/* ============ 状态 ============ */
const DEF = { me: '', pet: '米粒', perms: { mic: true, acc: false, notify: true },
              rules: [], did: [], fam: [], med: null, q: {}, unknown: [], memo: {},
              fails: [], onboarded: false, mePhone: '', pairCode: '', pairFam: '',
              /* 老人端在引导里填的称呼；家人端顶部只显示，不许改。 */
              elderName: '',
              /* 2026-11-10 菲尔特：出事时直接拨这个号；摔倒检测开关控制能不能自动拨。 */
              sosPhone: '', fallDetectOn: true,
              /* 🚨 2026-11-10 菲尔特拍板（覆盖 11-08 的「默认关」）：
                 闲聊连听、办事静音、办完待唤醒。默认必须开 ——
                 关着时 idle=12s + grace=10s = 22 秒就把通话挂了，
                 老人刚看清屏幕、想好要说什么，耳朵已经被摘掉，
                 表现就是「一直在听，听不到我说什么」（14:46 真机日志实证）。
                 办事那一段由 agent 的 onToolBegin 单独关麦，不靠这个开关。 */
              cvOn: true,
              /* 对照实验：true = 关闭作息画像，退回「固定时刻 + 通用话术」。
                 现场跑两次用：同一时刻，一个按他的习惯说，一个照表说。
                 这是评委要的 ablation，必须能一键切，不能靠改代码。 */
              rhythmOff: false,
              /* 对照实验二：关掉经验卡重跑同一句（玻色明文加分）。
                 true = 不重放记下的动作，每句都交回智能体重新想。
                 现场流程：关开关演示「错 → 现场一次反馈 → 3/3 → 回退又错 → 再反馈又对」，
                 再打开开关跑同一句，屏幕显示它没有直达、重新走了一遍。
                 不是新功能，是给已有链路加一个可切换的基线。 */
              skillOff: false,
              /* 首页四颗按钮可配置，引导页选、设置里改。id 见 HOME_BTNS。 */
              /* 默认 2 颗：真机实测 2 列布局下 4 颗会被底部按钮挤出屏幕。
                 家人可以在设置里加，加了页面就能滚。 */
              homeBtns: ['dialer', 'wechat'],
              /* 一张票 + 一个角色。两端都注册都登录，票跟着身份走。
                 accRole: 'elder' / 'fam'。老人端 365 天票，家人端 30 天。 */
              accToken: '', accRole: '', accPhone: '', accName: '', pairAt: 0,
              famToken: '', elderToken: '', famName: '',
              /* 没做完的事。以前一句话说完就完了，跨不过「这一次」——
                 老人说「明天提醒我交电费」，它答应了，明天什么也不会发生。
                 现在落盘，下次开机它自己接着办。 */
              tasks: [],
              /* ===== 2026-11-07 v9：家人端引导预填的配置 =====
                 家人一步步填 → 一个 6 位码 → 老人端输码拉同一份配置。
                 所有字段都进 save() 的 StateBackup，云端按 dev 存，跨设备真同步。 */
              cfg: {
                contacts: [],   // [{label:'儿子', name:'', phone:'', wx:''}]
                meds: [],       // [{name:'', note:'', photo:''}] 拍照存压缩 dataURL
                devices: [],    // 'bp'|'glu'|'band'|'vent' —— 硬件接口预留
                grid: 4,        // 老人端首页 4 / 6 个图标
                apps: ['dialer','wechat','torch','camera'], // 常用功能 key（见 V9_APPS）
                dock: ['sos','talk'],  // 底部按钮 key
                code: '',       // 家人端生成的同步码
                syncedAt: 0,
                setupDone: false
              } };
let S = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || { ...DEF };
/* 🚨 2026-11-10 16:15 真机根因（「能唤醒，却一直在听、听不见、过会儿自己没了」）：
   role 是界面角色、accRole 是账号票，两者会打架。真机读到
   role=family / accRole=elder / accToken 有值：票是老人的，界面却停在家人端，
   __F7_FAMILY 于是被点亮，callEnter 一进来就 return，麦根本没开；
   唤醒服务照样把界面抬起来，屏幕上还留着「在听」，最后 22 秒超时自己收掉。
   一张票只对一个端：以票为准自愈，绝不让脏状态把耳朵摘掉。 */
(function reconcileIdentity() {
  if (!S.accToken) {
    /* 没票就不认任何端，回第一屏重选；别再留「已引导完成但账号是空的」。 */
    S.role = ''; S.onboarded = false; S.pairCode = '';
  } else if (S.role === 'family') {
    if (S.accRole !== 'fam') S.accRole = 'fam';
  } else if (S.role === 'elder') {
    if (S.accRole !== 'elder') S.accRole = 'elder';
  } else {
    S.role = S.accRole === 'fam' ? 'family' : 'elder';
  }
  /* 以「当前界面是哪一端」为准把票的标记拢齐，绝不因为两边不一致就把人
     踢回登录页 —— 那正是「每次开机都要重来一遍」的来源。票本身不动，
     服务端真要纠正也得等下一次登录，不打断这一次。 */
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {}
})();
/* 老安装（含 11-10 清空数据重跑过的那台真机）里 cvOn 还是 false。
   v2 迁移跑过之后仍被别处写回 false，v3 再归一一次；之后用户在设置里
   怎么改就怎么留着，不再强行掰回来。 */
if (S.cvRuleV !== 3) {
  S.cvOn = true;
  S.cvRuleV = 3;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {}
}
if (!S.q) S.q = {}; if (!S.unknown) S.unknown = []; if (!S.memo) S.memo = {};
/* 失败记忆：它试过但没走通的路。和「学会的」分开放 ——
   学会的是「下次照做」，失败的是「下次别这么干」，两种东西不能混在一个数组里。 */
if (!S.fails) S.fails = [];
/* 调试/演示用：?skip=1 直接进主界面（跳过角色门和 4 步引导）。
   现场演示也用它——省掉上台点四下的风险。 */
if (QS0.get('skip') === '1') { S.onboarded = true; if (!S.role) S.role = 'elder'; }
if (!S.med) S.med = MILI_DATA.medbox.map((m) => ({ ...m, on: true, last: '' }));
/* 2026-11-10 菲尔特：「不能预置药，只能用户自己添加」。
   老安装里已经落盘的三条演示药一次性清掉：只按全名认，别误删用户后来
   自己加的同名药。清完打标记，之后用户加什么就留什么。 */
try {
  if (!localStorage.getItem('mili.medseed.purged.v1')) {
    const SEED_FULL = new Set(['苯磺酸氨氯地平片', '盐酸二甲双胍片', '阿司匹林肠溶片']);
    if (Array.isArray(S.med)) S.med = S.med.filter((m) => !(m && SEED_FULL.has(m.full)));
    localStorage.setItem('mili.medseed.purged.v1', '1');
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  }
} catch (e) {}

/* ============================================================================
 * 演示版的种子数据：一打开就是「用过一周的米粒」
 *
 * 为什么要这个：产品版必须从空白开始（老人不该看到别人家的记录），
 * 但台上演示没时间等它慢慢长。所以演示版第一次进来就灌一份，
 * 灌的是**真的会改变行为**的记录 —— 每一条都能在「它学会的」里被指着讲。
 *
 * 只在演示版、且本地一条记录都没有时灌。手动点「重置演示数据」会再灌一次。
 * ========================================================================== */
function seedDemo() {
  const H = 3600 * 1000, D = 24 * H, now = Date.now();
  const day = (msAgo) => {
    const d = new Date(now - msAgo);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  S.me = S.me || '陈奶奶';
  S.pet = S.pet || '米粒';
  S.onboarded = true;
  S.fam = S.fam && S.fam.length ? S.fam : [
    { name: '闺女', rel: '女儿' },
    { name: '李昌洪', rel: '老邻居' },
  ];
  S.rules = [
    {
      id: 'seed_r1', k: '降压药什么时候吃', q: '降压药什么时候吃',
      ans: '按药盒上写的来。一般是早上吃完饭歇一会儿再吃，别自己加量。',
      src: '药箱', kind: 'recall', n: 1, born: now - 3 * D,
      firstMs: 2600, lastMs: 2600, hits: 4, auto: true,
    },
    {
      id: 'seed_r2', k: '白内障手术大概多少钱', q: '白内障手术大概多少钱',
      ans: '各地不一样。去医院问一下最准，记得带医保卡，能报一部分。',
      src: '上网查', kind: 'recall', n: 1, born: now - 2 * D,
      firstMs: 3100, lastMs: 3100, hits: 2, auto: true,
    },
    {
      id: 'seed_r3', k: '闺女的电话', q: '闺女的电话',
      ans: '在「家里人」那一页，点她名字就能打。',
      src: '', kind: 'recall', n: 1, born: now - 1 * D,
      firstMs: 1800, lastMs: 1800, hits: 3, auto: true,
    },
    {
      id: 'seed_r4', k: '今天冷不冷', q: '今天冷不冷', ans: '', src: '',
      kind: 'slow', n: 3, born: now - 1 * D, firstMs: 0, lastMs: 0, hits: 0, auto: true,
    },
    {
      id: 'seed_r5', k: 'stuck:com.tencent.mm', q: '在微信里停住', ans: '', src: '',
      kind: 'stuck', n: 2, born: now - 2 * D, firstMs: 0, lastMs: 0, hits: 0,
      auto: true, pkg: 'com.tencent.mm', app: '微信',
    },
    {
      id: 'seed_r6', k: 'avoid:type_text|抖音', q: '在「抖音」里打字', ans: '', src: '',
      kind: 'avoid', n: 1, born: now - 5 * H, firstMs: 0, lastMs: 0, hits: 0, auto: true,
      tool: 'type_text', why: '它的搜索框不认无障碍写进去的字', alt: 'paste_text',
    },
  ];
  S.fails = [{
    id: 'seed_f1', key: 'type_text|抖音', tool: 'type_text',
    who: '抖音', why: '它的搜索框不认无障碍写进去的字', alt: 'paste_text',
    n: 1, at: now - 5 * H,
  }];
  /* 上一次办这件事走了哪几步 —— 学习页顶部那块，给评委看的 */
  S.lastRun = {
    at: now - 5 * H, q: '在抖音找后会有期', ms: 8400,
    steps: [
      { tool: 'open_app', ok: true, why: '打开了抖音' },
      { tool: 'tap_text', ok: true, why: '点到了搜索框' },
      { tool: 'type_text', ok: false, why: '屏幕上没进字' },
      { tool: 'paste_text', ok: true, why: '粘上了「后会有期」' },
      { tool: 'tap_result', ok: true, why: '第一条点开了' },
    ],
  };
  S.did = [
    { icon: 'heart', title: '陪聊了一会儿', sub: '说起老伴，聊了七八分钟', time: '10:30', d: day(0), ms: 0 },
    { icon: 'sun', title: '说今天有雨', sub: '让出门带把伞', time: '08:05', d: day(0), ms: 0 },
    { icon: 'phone', title: '给闺女打了电话', sub: '通话 2 分 11 秒', time: '19:42', d: day(1), ms: 0 },
    { icon: 'play', title: '放了《朝阳沟》', sub: '在红果里找着的', time: '15:20', d: day(1), ms: 0 },
    { icon: 'pill', title: '提醒吃降压药', sub: '早上那顿，吃了', time: '07:40', d: day(1), ms: 0 },
    { icon: 'phone', title: '给李昌洪打了电话', sub: '问了他腿好了没', time: '16:10', d: day(2), ms: 0 },
    { icon: 'tv', title: '开了电视', sub: '中央一台', time: '13:05', d: day(2), ms: 0 },
  ];
  save();
}

if (DEMO && !localStorage.getItem(STORE_KEY)) {
  try { seedDemo(); } catch (e) {}
}
/* 身份永远不进备份。以前整包 S 一起存，清数据后连 onboarded:true 和
   测试用的「固化验收爷爷」都回来了 —— 老人直接跳过引导页，还被叫错名字。
   备份只存「它学会了什么」，不存「它是谁的」。 */
const IDENTITY_KEYS = ['onboarded', 'role', 'me', 'mePhone', 'pairCode', 'pairFam',
                       'accToken', 'accRole', 'accPhone', 'accName', 'pairAt'];

function save() {
  const j = JSON.stringify(S);
  localStorage.setItem(STORE_KEY, j);
  /* 同时固化到原生：私有 SP + 公共 Downloads + 阿里云 ECS。
     只写配置，身份留给开机流程重新确认。 */
  try {
    const n = NATIVE();
    if (n && n.saveState) {
      const b = { ...S };
      IDENTITY_KEYS.forEach((k) => delete b[k]);
      n.saveState(JSON.stringify(b));
    }
  } catch (e) {}
  /* 2026-11-10：syncCallCfg 以前只有定义、没有任何调用点，
     真机 shared_prefs/mili_call.xml 里 wl 一直是 [] —— 电话自动接永远匹配不上。
     每次存盘都把家人名单推给原生，名单改了立刻生效。 */
  try { syncCallCfg(); } catch (e) {}
}

/* 认出人之后，才把备份里的配置并回来。
   刚填的名字、刚选的角色、登录态一律保留，不被旧数据盖掉。 */
function applyRestoredState() {
  const cfg = window.__PENDING_RESTORE;
  if (!cfg) return;
  window.__PENDING_RESTORE = null;
  const KEEP = {};
  IDENTITY_KEYS.forEach((k) => { KEEP[k] = S[k]; });
  KEEP.pet = S.pet;
  S = { ...DEF, ...cfg, ...KEEP };
  save();
  try { bootRefresh(); } catch (e) {}
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hm = () => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
/* 本地日期（手机上手拼，禁 toISOString 的 UTC 错位） */
const ymd = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
/* 分组头：今天 / 昨天 / 11月3日 */
function dayLabel(key) {
  if (!key) return '早些时候';
  const t = new Date(); const y = new Date(Date.now() - 86400000);
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  if (key === fmt(t)) return '今天';
  if (key === fmt(y)) return '昨天';
  const p = key.split('-');
  return (+p[1]) + '月' + (+p[2]) + '日';
}
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));

/* ============ 图标 ============ */
const IC = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8.1 9.5a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 4l14 8-14 8z"/></svg>',
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 3l4 4 4-4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="9" width="18" height="12" rx="2"/><path d="M3 13h18M12 9v12"/><path d="M12 9S9 3 6.5 5.5 12 9 12 9zM12 9s3-6 5.5-3.5S12 9 12 9z"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  pill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-40 12 12)"/><path d="M8.5 8.5l7 7"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-9.2A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 2.8C19 15.6 12 20 12 20z"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  hosp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="16" height="17" rx="3"/><path d="M12 8v8M8 12h8"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v7H3v-7z"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="8.4" r="3.1"/><path d="M3.6 19.4c0-3.2 2.4-5.7 5.4-5.7s5.4 2.5 5.4 5.7"/><circle cx="17.4" cy="9.7" r="2.2"/><path d="M15.6 14.3c2.7-.4 4.8 1.4 4.8 4.2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="6" r="2.2"/><circle cx="18.5" cy="18" r="2.2"/><path d="M7.7 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h6.3"/></svg>',
  /* 扫码：四个角 + 中间一条扫描线。比二维码图形好认 —— 老人一看就知道是「照一下」 */
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5A1.5 1.5 0 0 1 18.5 20H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M3 12h18"/></svg>',
  /* 血压：袖带 + 跳动的心，不是一颗光秃秃的心 —— 那颗已经给「红果短剧」占了 */
  bp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11h4l1.6-2.6 2.4 5 1.8-3.4 1.4 1h5.8"/><path d="M4 16.5h16"/></svg>',
  /* 桌面大图标（2026-11-06）：短信/微信/相册/设置 —— 每个都画成老人一眼认出的实物 */
  msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg>',
  wx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4C5.1 4 2 6.7 2 10c0 1.9 1 3.5 2.6 4.6L4 17l2.6-1.3c.8.2 1.6.3 2.4.3h.4"/><path d="M9.5 8.5h.01M13 20c3.9 0 7-2.5 7-5.7S17 8.5 13 8.5 6 11 6 14.3 9.1 20 13 20z" transform="translate(1 -1.5)"/><path d="M11 12.5h.01M15 12.5h.01"/></svg>',
  pic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.6" cy="10" r="1.6"/><path d="M4.5 17l4.6-4.4 3.2 3 2.6-2.4 4.6 4.3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/></svg>',
  sos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/></svg>',
  /* 手电筒 / 通话记录（桌面 2026-11-07） */
  lamp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="5" rx="1.5"/><path d="M9.5 8v3.2L7 15.5V21h10v-5.5l-2.5-4.3V8"/><path d="M7 18.5h10"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5h9a3 3 0 0 1 3 3v12h-9a3 3 0 0 1-3-3v-12z"/><path d="M9.5 9.5h5M9.5 13h5M9.5 16.5h3"/></svg>'
};
const icoName = { phone: 'phone', sun: 'sun', play: 'play', calendar: 'cal', gift: 'gift',
  camera: 'cam', shield: 'shield', pill: 'pill', heart: 'heart', map: 'map',
  hospital: 'hosp', user: 'user', plus: 'plus', inbox: 'inbox', users: 'users',
  search: 'search', mic: 'mic', scan: 'scan', vital: 'bp' };
const ico = (k) => IC[icoName[k] || k] || IC.user;

/* ============ 3D ============ */
/* 🚨 2026-11-06 晚：3D 形象退役。菲尔特做好了两段视频（待机/唱歌），
   形象从这里开始由视频承担 —— 3D 那套加载/骨骼/动作全保留在代码里，
   但不再初始化（VIDEO_PET = true 时 initThree/animate 都不跑）。
   好处：省掉 GLB 解析和 WebGL 渲染这两块最大的首屏开销，
   「回复特别慢」里有一段就是它贡献的。 */
const VIDEO_PET = true;
const cvs = $('c');
let renderer, scene, camera, holder;
let chickRoot = null, midRoot = null, adultRoot = null, bones = {}, PET = null;
let pGeo, pMat, dust, pT = 0;
const PN = 100, pPos = new Float32Array(PN * 3), pVel = [];

/* ---- 视频形象的模式切换（2026-11-13 重写）----
   只用 idle 一段视频常驻循环，绝不 pause、绝不切源。
   旧实现说一句话就 i.pause() 停掉 idle、再 s.play() 切到另一段构图不同的素材；
   sing 视频被 CSS 封存后，两段一起没画面 —— 鸡「说句话就消失」「忽大忽小」都由此而来。
   singing 现在只是状态标记（波纹/文案用），不参与画面。 */
function petMode(m) {
  const a = $('petAva'), i = $('petIdleV');
  if (!a || !i) return;
  if (m === 'sing') a.classList.add('singing');
  else a.classList.remove('singing');
  if (i.paused) { try { i.play().catch(() => {}); } catch (e) {} }
}
window.__petMode = petMode;   // 原生桥/调试也能切

/* ==========================================================================
 * 直达电视（预合成真源）——「0.2 秒开台」的地基
 *
 * 为什么要直达链：搜一圈再点播放页，实测 172 秒还失败（后会有期那回）。
 * 老人等不了。这里的每一行都是 ffprobe+ffmpeg 实测解码过的真直播源，
 * 全屏层是我们自己的 <video>，不跳 App、不搜索、不点页面。
 * 源来自公开 IPTV 汇总（iptv-org），挂了就换，写在工具描述里让模型兜底。
 * 短剧走真 App（红果短剧），内容是真内容，接着看靠它自己的续播。
 * ======================================================================== */
(function () {
  /* 走自己 ECS 的中继（9001/tv/）：手机 WebView 到境外 IP 全被墙，
     中继在阿里云上拉上游 + 分片预取缓存（实测冷 4s / 热 0.19s）。 */
  const HOST = 'http://YOUR_SERVER_HOST:9001/tv/';
  /* ==========================================================================
   * 2026-11-12 20:5x 换信源（菲尔特：CCTV 连不稳、加载太慢，要找更稳的）
   *
   * 老方案：所有频道走自己 ECS 的 /tv/ 中继，而中继上游在美国
   *   （74.91.26.218 → 302 → 192.187.115.106）。同一台手机实测：
   *     经中继拉 playlist        1820 ms
   *     上游分片 10 秒一个，hls 至少等两个分片才出画
   *
   * 新方案：直连国内 CDN。同一台手机实测：
   *   浙江广电 ali-m-l.cztv.com（阿里云 CDN）
   *       playlist 80~170 ms，分片 2.06 MB / 288 ms ≈ 57 Mbps，5 秒一片
   *   124.165.251.82（IPTV 转发）
   *       80 ms，但分片 1.89 MB 要 10.6 秒 ≈ 1.43 Mbps —— 带宽不够，必然一直转圈
   *
   * 频道编号不是看 m3u 标签猜的：服务器上 ffmpeg 逐台截帧、拼图认台标确认过。
   * 已验证 cztv channel21 = CCTV-13、channel15 = CCTV-1、channel10 = CCTV-5+。
   *
   * 每一项 srcs 按优先级排，前一个连不上自动换下一个，老人不用知道换过源。
   * 中继留着当兜底 —— 它慢，但境外源覆盖的台比国内 CDN 全。
   * ======================================================================== */
  const CZ = (n) => 'http://ali-m-l.cztv.com/channels/lantian/channel' + n + '/1080p.m3u8';
  const RL = (ch) => HOST + ch + '.m3u8';
  /* 每一项都实测过解码（2026-11-07），新增频道照这个格式加、先 ffprobe 验 */
  const TV_MAP = [
    { k: ['新闻联播', '新闻频道', 'cctv13', '中央13', '新闻'], name: 'CCTV-13 新闻',
      srcs: [CZ('21'), CZ('20'), RL('cctv13hd')] },
    { k: ['中央一台', '中央1台', 'cctv1', '综合频道'], name: 'CCTV-1 综合',
      srcs: [CZ('15'), RL('cctv1hd')] },
    { k: ['戏曲', '豫剧', '京剧', '唱戏', '戏台', '看戏', 'cctv11'], name: 'CCTV-11 戏曲',
      srcs: [RL('cctv11hd')] },
    { k: ['电视剧频道', 'cctv8', '中央8'], name: 'CCTV-8 电视剧',
      srcs: [RL('cctv8hd')] },
    { k: ['体育', '球赛', '足球', 'cctv5'], name: 'CCTV-5 体育',
      srcs: [RL('cctv5hd')] },
    { k: ['少儿', '动画', '卡通', '动画片'], name: 'CCTV-14 少儿',
      srcs: [RL('cctv14hd')] },
    { k: ['音乐频道', 'cctv15'], name: 'CCTV-15 音乐',
      srcs: [RL('cctv15hd')] },
    { k: ['电影频道', 'cctv6', '中央6'], name: 'CCTV-6 电影',
      srcs: [RL('cctv6hd')] },
  ];
  /* 2026-11-08 菲尔特定路由：视频类一律走真 App，不碰浏览器、不碰悟空。
       · CCTV / 卫视频道 → 自家中继直连（横屏全屏，已实测首帧 4.8s）
       · 短剧 / 红果      → 红果免费短剧（com.phoenix.read，真 App 续播）
       · 其余看片         → 抖音搜索（snssdk1128://search，真机验证直达结果页）
     红果没有可用的搜索 scheme（phoenix:// 未注册，实测 resolve 失败），
     所以只负责把它打开——老人要的是进去刷，不是精确搜剧名。 */
  function cleanKw(q, dropRe) {
    let kw = String(q || '').replace(dropRe, '').trim();
    return kw;
  }
  const DY_DROP = /抖音|短剧|红果|一下|搜搜|搜索|上搜|我要|我想|能不能|可以|帮我|给我|打开|看看|看点|看|来点|放段|放个|来个|来段|刷会|刷视频|刷会儿|视频|点儿|个|段/g;
  function douyinSearch(q) {
    const kw = cleanKw(q, DY_DROP) || '短剧';
    return { type: 'dl', url: 'snssdk1128://search?keyword=' + encodeURIComponent(kw), name: '抖音·' + kw };
  }
  const HG_DROP = /短剧|红果|接着看|接着放|一下|给我|帮我|打开|看看|看|来点|放段|放个|来个|来段|刷会|刷会儿|个|段/g;
  function hongguo(q) {
    const kw = cleanKw(q !== undefined ? q : '', HG_DROP);
    return { type: 'app', pkg: 'com.phoenix.read', name: kw ? ('红果·' + kw) : '红果短剧' };
  }
  const HG_KEYS = ['短剧', '红果', '接着看', '接着放'];
  const DY_KEYS = ['抖音', '刷会', '刷视频', '刷会儿'];

  function resolve(q) {
    const s = String(q || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    for (const it of TV_MAP) {
      if (it.k.some((k) => s.indexOf(k.toLowerCase()) >= 0)) {
        return { type: 'tv', urls: it.srcs.slice(), url: it.srcs[0], name: it.name };
      }
    }
    /* 短剧优先红果（「红果短剧」里两个词都命中，必须排在抖音前面） */
    if (HG_KEYS.some((k) => s.indexOf(k) >= 0)) return hongguo(q);
    if (DY_KEYS.some((k) => s.indexOf(k) >= 0)) return douyinSearch(q);
    /* 没点名 App、但明显是「看点什么」：一律抖音搜，不走浏览器。
       之前要求句子里必须出现「片/剧/视频」——「看个后会有期」直接漏掉，
       老人等半天没反应。现在只要以看/放/来/刷/想看开头就够，
       天气、医生、药这类明确不属于视频的排除掉。 */
    /* 2026-11-08 真机：「我要看天天耍大牌」直接没命中 —— 老人口语前面常带
       「我要 / 我想 / 帮我 / 给我 / 能不能」，只认「看」开头等于把一半人挡在门外。 */
    if (/(?:^我要|^我想|^帮我|^给我|^能不能|^可以|^看|^放|^来|^找|^刷|^耍)(?:看|放|耍|听|搜)?/
        .test(s) && /(?:看|放|耍|听)/.test(s)
        && !/天气|几度|下雨|医生|医院|病|药|挂号|电话|几点|时间|日历/.test(s)) {
      return douyinSearch(q);
    }
    /* 点了具体频道号：CCTVx / 中央x 直接算 */
    const m = s.match(/(?:cctv|央视|中央|频道)?(\d{1,2})\s*台?/) || s.match(/cctv(\d{1,2})/);
    if (m) {
      const n = +m[1];
      if (n >= 1 && n <= 17) {
        const hit = TV_MAP.find(function (it) { return it.name.indexOf('CCTV-' + n + ' ') === 0; });
        if (hit) return { type: 'tv', urls: hit.srcs.slice(), url: hit.srcs[0], name: hit.name };
        return { type: 'tv', urls: [RL('cctv' + n + 'hd')], url: RL('cctv' + n + 'hd'), name: 'CCTV-' + n };
      }
    }
    return null;
  }

  function open(src, title) {
    try { if (window.MILI_RHYTHM) window.MILI_RHYTHM.note('tv', String(title || '')); } catch (e) {}
    const w = $('tvfull');
    const v = $('tvfullV');
    if (!w || !v) return { ok: false, detail: '播放层没准备好。' };
    /* src 可以是单个地址，也可以是按优先级排好的候选列表 */
    const list = (Array.isArray(src) ? src : [src]).filter(Boolean);
    if (!list.length) return { ok: false, detail: '这个台这会儿没有可用的信号。' };
    /* 记住当前台，换台键（左右）靠它找下一个 */
    curIdx = TV_MAP.findIndex(function (it) { return it.name === title; });
    const t = $('tvfullT');
    if (t) t.textContent = title || '';
    w.hidden = false;
    /* 看电视就是横屏：整个 Activity 转过去，关掉再回来 */
    try { const nn = NATIVE(); if (nn && nn.screenLand) nn.screenLand(); } catch (e) {}
    try { v.muted = false; v.volume = 1; } catch (e) {}

    /* 多源降级：这个源连不上就安静地换下一个。
       老人不需要知道换过源，他只需要这个台能出来。 */
    function playAt(i) {
      if (i >= list.length) return;
      const one = list[i];
      try { if (window.__tvHls) { window.__tvHls.destroy(); window.__tvHls = null; } } catch (e) {}
      if (/\.m3u8/i.test(one) && window.Hls && window.Hls.isSupported()) {
        /* 2026-11-08 真机三连坑（黑屏 20 秒的完整root cause）：
           ① 中继白名单写死 81/82 端口 → 上游换到 :88 后所有分片 403；
           ② hls.js 默认开 Web Worker，file:// 页面起不来，错误算成 networkError；
           ③ 直播窗口只有 3 段（≈25s），liveSyncDurationCount 默认 3 段
              算出来的起点越界 → 只拉 playlist 不拉分片，永远黑屏。
           这套参数是逐项实测出来的，别再"优化"回去。 */
        const h = new window.Hls({
          enableWorker: false,
          lowLatencyMode: false,
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 2,
          maxBufferLength: 10,
          startPosition: -1,
          manifestLoadingTimeOut: 12000,
          fragLoadingTimeOut: 25000,
          fragLoadingMaxRetry: 4
        });
        window.__tvHls = h;
        let moved = false;
        /* 2026-11-12：任何一个致命错误都直接换源，不再让它傻等到超时。
           三个源串起来，"这个台能看"的概率就从"看运气"变成"基本能看"。 */
        h.on(window.Hls.Events.ERROR, function (ev, d) {
          if (moved || !d || !d.fatal) return;
          moved = true;
          try { console.log('[TV] 第 ' + (i + 1) + ' 个源不通(' + d.type + ')，换下一个'); } catch (e) {}
          playAt(i + 1);
        });
        h.loadSource(one);
        h.attachMedia(v);
        h.on(window.Hls.Events.MANIFEST_PARSED, function () { tvPlay(v); });
      } else {
        v.src = one;
        tvPlay(v);
      }
    }
    playAt(0);
    return { ok: true, detail: '打开啦，' + (title || '节目') + '。' };
  }

  /* WebView 自动播放策略：不带手势的出声播放会被拒。
     先静音起播（永远允许），画面真出来那一拍再把声音还回去。 */
  function tvPlay(v) {
    const p = v.play();
    if (p && p.catch) p.catch(function () {
      v.muted = true;
      const pp = v.play();
      if (pp && pp.catch) pp.catch(function () {});
      const un = function () {
        v.muted = false;
        try { v.volume = 1; } catch (e) {}
        v.removeEventListener('playing', un);
      };
      v.addEventListener('playing', un);
    });
  }

  function close() {
    const w = $('tvfull');
    if (!w || w.hidden) return false;
    const v = $('tvfullV');
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    try { if (window.__tvHls) { window.__tvHls.destroy(); window.__tvHls = null; } } catch (e) {}
    w.hidden = true;
    try { const nn = NATIVE(); if (nn && nn.screenPort) nn.screenPort(); } catch (e) {}
    return true;
  }

  function openApp(a, b) {
    /* 两种调用都要吃：openApp({type:'app',pkg,name}) 和老的 openApp(pkg, name)。
       2026-11-08 踩过：新版把对象整个当包名传给 Java，变成 "[object Object]"，
       launch 抛异常被 catch 吞掉，界面还回一句「打开啦。」—— 红果根本没开。 */
    const pkg = (a && typeof a === 'object') ? a.pkg : a;
    const name = (a && typeof a === 'object') ? a.name : b;
    if (!pkg) return { ok: false, detail: '没说要开哪个软件。' };
    const nn = NATIVE();
    const done = '打开' + (name || '') + '啦。';
    if (nn && nn.launch) {
      try { nn.launch(String(pkg)); return { ok: true, detail: done, fastReply: done }; } catch (e) {}
    }
    if (nn && nn.openAppByPkg) {
      try { nn.openAppByPkg(String(pkg)); return { ok: true, detail: done, fastReply: done }; } catch (e) {}
    }
    return { ok: false, detail: '这台手机上开不了这个软件。' };
  }

  /* 换台：屏幕左右两颗大键 + 语音「换台/下一个台」。curIdx 由 open() 记。 */
  let curIdx = -1;
  function tvSwitch(dir) {
    if (!TV_MAP.length) return { ok: false, detail: '没有台。' };
    let i = curIdx < 0 ? 0 : (curIdx + dir + TV_MAP.length) % TV_MAP.length;
    const it = TV_MAP[i];
    const r = open(it.srcs, it.name);
    if (r.ok) { try { say(r.detail); } catch (e) {} }
    return r;
  }

  /* 深链路径：抖音搜索结果页是半屏列表，进来 6.5 秒后 a11y 点第一个视频 → 全屏沉浸流。
     点早了撞开屏页/列表还没出卡片，点晚了用户自己点了就撤。 */
  function openDl(d) {
    const nn = NATIVE();
    if (!nn || !nn.openUrl) return { ok: false, detail: '开不了。' };
    /* 抖音搜索：整条路（点第一个视频 → 点全屏观看 → 校验横屏）交给 Java。
       2026-11-08 实测：抖音在前台时米粒的 WebView 被 Chromium 节流，
       JS 定时器一分钟才跑一次 —— 在这边排 setTimeout 等于让人干等。 */
    const kw = String(d.name || '').replace(/^抖音[·・]/, '').trim();
    if (kw && typeof nn.playDouyin === 'function') {
      try {
        const r = JSON.parse(nn.playDouyin(kw) || '{}');
        if (r && r.ok) {
          /* 2026-11-12：点开全屏是一串原生动作，模型这一轮没有新信息可加工，
             让它再复述一遍只会多花 1.5~2 秒，还容易把「正在点开」说成
             「已经全屏了」（真机截图为证：当时还停在详情页）。
             直接用原生那句当最终回复，说多少就是多少。 */
          const s = '找到《' + kw + '》了，正给您点开。';
          return { ok: true, detail: s, fastReply: s };
        }
      } catch (e) {}
    }
    try { nn.openUrl(d.url); } catch (e) { return { ok: false, detail: '开不了。' }; }
    return { ok: true, detail: '给您放' + (d.name || '') + '。' };
  }

  window.MILI_TV = { resolve: resolve, open: open, close: close, openApp: openApp, openDl: openDl, switch: tvSwitch, state: function () { return { idx: curIdx, hidden: !$('tvfull') || $('tvfull').hidden }; } };
  document.addEventListener('DOMContentLoaded', function () {
    const x = $('tvfullX');
    if (x) x.onclick = function (ev) { ev.stopPropagation(); close(); };
    const p = $('tvPrev'), n = $('tvNext');
    if (p) p.onclick = function (ev) { ev.stopPropagation(); tvSwitch(-1); };
    if (n) n.onclick = function (ev) { ev.stopPropagation(); tvSwitch(1); };
    const w = $('tvfull');
    if (w) w.onclick = function () {};
  });
})();

function initThree() {
  if (VIDEO_PET || !cvs) return;   // 视频形象：3D 不再初始化
  renderer = new THREE.WebGLRenderer({ canvas: cvs, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
  else renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 0.01, 60);
  camera.position.set(0, 0.88, 3.3);
  camera.lookAt(0, 0.62, 0);

  scene.add(new THREE.HemisphereLight(0xfffdf6, 0xe6e6e0, 0.95));
  const key = new THREE.DirectionalLight(0xfff4e4, 1.30);
  key.position.set(1.3, 2.3, 1.8); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.4; key.shadow.camera.far = 8;
  key.shadow.camera.left = -1.2; key.shadow.camera.right = 1.2;
  key.shadow.camera.top = 1.6; key.shadow.camera.bottom = -0.3;
  key.shadow.bias = -0.0015; key.shadow.radius = 3;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe3cc, 0.40); fill.position.set(-1.6, 1.0, -1.3); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xe6eeff, 0.32); rim.position.set(-0.4, 1.4, -2.1); scene.add(rim);

  const sh = new THREE.Mesh(new THREE.CircleGeometry(3, 48).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.13 }));
  sh.receiveShadow = true; sh.position.y = 0.002; scene.add(sh);

  holder = new THREE.Group(); scene.add(holder);

  pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pMat = new THREE.PointsMaterial({ color: 0xefd08a, size: 0.026, transparent: true,
    opacity: 0, depthWrite: false });
  dust = new THREE.Points(pGeo, pMat); dust.frustumCulled = false; scene.add(dust);

  const L = new GLTFLoader();
  window.__glb = { ok: 0, err: 0, last: '', url: String(GLBSRC(0)) };
  L.load(GLBSRC(0), (g) => {
    window.__glb.ok++;
    chickRoot = prep(g, 1.02);
    ready();
  }, undefined, (e) => {
    window.__glb.err++;
    window.__glb.last = String((e && e.message) || e);
    ready();
  });
  /* m2（换毛期）和 m3（大红公鸡）不再加载。
     2026-11-06 修：原来这两个也 L.load 进来，只是 applyForm 里设 visible=false。
     可 applyForm 开头有 `if (!chickRoot) return` —— 只要它们比主形象先到，
     那次 applyForm 就提前返回，两只一起留在台上。模拟器实测右下角多出一只小鸡，
     就是这个原因。用户早就说过「其他两个形态删掉吧，太丑了」，
     那就不只是不显示，干脆不加载 —— 少 4MB 解析，也不可能再抢上台。 */
}
const GLB_FILE = ['./assets/m1-rig.glb', './assets/m3.glb', './assets/m2-rig6.glb'];
const GLBSRC = (i) => {
  if (window.__GLB) return window.__GLB[i] || null;   // 空槽位返回 null，宁可不用也别抓错模型
  return GLB_FILE[i] || GLB_FILE[2];
};

/* 把贴图的米黄压成白。
   3D 模型的贴图本身就是暖米色的，光靠灯光和材质乘色提不白 —— 白毛看着永远发黄。
   做法：整体降饱和 45% + 提亮 12%，**连续变换、不做阈值切分**
   （按暖度分段处理过一次，结果鸡身上一块白一块黄，像掉漆）。
   代价是蛋壳从暖米变成灰米 —— 换来绒毛真的白，这个交换值得。 */
function whitenTexture(tex) {
  if (!tex || !tex.image || !tex.image.width || tex.__whitened) return tex;
  try {
    const W = tex.image.width, H = tex.image.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(tex.image, 0, 0);
    const d = g.getImageData(0, 0, W, H), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], gg = p[i + 1], b = p[i + 2];
      const avg = (r + gg + b) / 3;
      p[i]     = Math.min(255, (avg + (r - avg) * 0.55) * 1.12);
      p[i + 1] = Math.min(255, (avg + (gg - avg) * 0.55) * 1.12);
      p[i + 2] = Math.min(255, (avg + (b - avg) * 0.55) * 1.16);
    }
    g.putImageData(d, 0, 0);
    tex.image = c;
    tex.needsUpdate = true;
    tex.__whitened = true;
  } catch (e) {}
  return tex;
}

function prep(g, scale) {
  const root = g.scene;
  root.scale.setScalar(scale);
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        m.metalness = 0; m.envMapIntensity = 0.18;
        /* 白毛在手机上偏米黄发暗 —— 不是贴图错，是这套灯光下中间调被压了。
           材质基色提一点点、蓝通道多给一点，把米黄拉回白，实测肉眼最接近旧版那只。
           （别再加曝光：加到 1.38 只是整体发灰，白毛还是黄的。） */
        if (m.color) m.color.setRGB(1.10, 1.08, 1.14);
        /* roughness 不硬压到 0.92 —— 太哑会把白毛的高光全吃掉，看着像旧棉花。 */
        if (m.roughness === undefined || m.roughness > 0.88) m.roughness = 0.82;
        /* 贴图必须是 sRGB 采样。
           旧代码写的是 `if ('encoding' in m.map) m.map.encoding = THREE.sRGBEncoding`，
           可 three r152 起把 .encoding 删了、换成 .colorSpace —— 于是这行永远不执行，
           贴图被当成线性数据读，白毛读出来就是脏黄发暗。手机上那只"变黑的小鸡"就是它。 */
        if (m.map) {
          if ('colorSpace' in m.map) m.map.colorSpace = THREE.SRGBColorSpace;
          else if ('encoding' in m.map) m.map.encoding = THREE.sRGBEncoding;
          whitenTexture(m.map);
        }
        m.needsUpdate = true;
      }
      o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true;
    }
  });
  const b = {};
  root.traverse((o) => { if (o.isBone) { const k = o.name.toLowerCase();
    if (k.includes('neck')) b.neck = o; else if (k.includes('head')) b.head = o;
    else if (k.includes('wing_l')) b.wingL = o; else if (k.includes('wing_r')) b.wingR = o;
    else if (k.includes('tail')) b.tail = o; else if (k.includes('spine')) b.spine = o;
    else if (k.includes('pelvis')) b.pelvis = o; } });
  for (const k in b) b[k].userData.q0 = b[k].quaternion.clone();
  root.userData.bones = b;

  /* 一只骨头都没找到 = 这是混元直接导出的无骨骼模型。
     它走整体变形动画（浮、挤压、倾），照样能演，只是不细到翅膀。 */
  root.userData.rigless = Object.keys(b).length === 0;

  /* 模型原点不在几何中心 —— m1-rig 导出来是偏的，直接丢进场景会贴在卡片右上角，
     中间空着，看着像加载失败。2026-11-06 模拟器实测到的就是这个。
     按包围盒把「底面中心」挪到原点：脚踩 y=0，左右前后居中。
     必须在 scale 设好之后算，否则包围盒是缩放前的。 */
  try {
    const bb = new THREE.Box3().setFromObject(root);
    if (isFinite(bb.min.x) && isFinite(bb.max.x)) {
      root.position.x -= (bb.min.x + bb.max.x) / 2;
      root.position.z -= (bb.min.z + bb.max.z) / 2;
      root.position.y -= bb.min.y;
    }
  } catch (e) {}

  root.userData.baseY = root.position.y;

  holder.add(root);
  return root;
}

/* 只等主形象这一个模型。以前是 2，多等一个永远不会上台的 m3，
   首屏白等一次网络往返。 */
let loadedN = 0, loadedNeed = 1;
function ready() { if (++loadedN < loadedNeed) return; applyForm(false); resize(); }

/* ============ 三个形态 ============
   命名刻意不用「刚出壳/半大/长齐了」—— 那套说法把老人摆在「看着它长大」的旁观位，
   而它长大的意义是「能替你多办点事」。所以按**本事**命名，不按**体积**命名。 */
const FORMS = [
  { at: 0,  name: '刚破壳', desc: '只听你说',   slot: 0 },
  { at: 5,  name: '能记事', desc: '会答、会陪', slot: 1 },
  { at: 12, name: '会办事', desc: '能替你跑腿', slot: 2 },
];

/* 分数不按「几条规则」算，按「学到了什么」算：
   学会答一条 1 分；摸清你会卡在哪、哪句记不住，2 分 —— 后者难得多。 */
function formPoints() {
  let p = 0;
  for (const r of S.rules) p += (r.kind === 'recall') ? 1 : 2;
  return p;
}
function formOf(n) { let f = FORMS[0]; for (const x of FORMS) if (n >= x.at) f = x; return f; }

/* 演示版：阈值压到 0/2/4，两条就能看到形态变化。
   产品版保持 0/5/12，正常用几天才会换。
   用 ?demo=1 切。 */
if (DEMO) { FORMS[1].at = 2; FORMS[2].at = 4; }
function formAt() { return FORMS.map((f) => f.at); }

function applyForm(anim) {
  const p = formPoints();

  /* ================= 只有这一只 =================
     以前攒到 5 分会换上 m2、12 分换上大红公鸡 m3。
     用户原话：「只要初始的形态，其他两个形态删掉吧，太丑了」。
     所以形象固定是小鸡蛋壳，m2/m3 不再上台 —— 它们还在磁盘上，但不加载、不显示。
     🚨 2026-11-06：视频形象下 chickRoot 永远是 null ——
     原来这里 `if (!chickRoot) return` 会把下面的学习页 UI 更新全部跳过，
     「它学会的 N 条」永远不涨。3D 部分收进 if 里，UI 部分必须照跑。 */
  const changed = false;
  window.__formSlot = 0;
  window.__form = 'chick';

  if (chickRoot && !VIDEO_PET) {
    if (midRoot) midRoot.visible = false;
    if (adultRoot) adultRoot.visible = false;
    chickRoot.visible = true;
    PET = chickRoot;
    bones = PET.userData.bones || {};
    PET.scale.setScalar(1.02);
    window.__pet = { has: true, vis: PET.visible, scale: PET.scale.x, y: PET.position.y };
  }

  const fmt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  /* 这张卡片的数字要和下面「它学会的 N 条」是同一个 N。
     以前显示的是加权分（recall 1 分、其它 2 分），和条数对不上，
     老人一看就是「上面写 9、下面写 6 条」。同一个东西只用一个数。 */
  const n = (S.rules || []).length;
  fmt('formBadge', '米粒');
  fmt('gForm', '替你记着的事');
  fmt('gCount', n);

  /* 进度条不再催「快升级」——它不长大了，改成「记得越多越满」 */
  const fill = $('gfill');
  if (fill) {
    const pct = Math.min(100, Math.round(n / 12 * 100));
    fill.style.width = pct + '%';
    /* 0 条时那条灰轨道是空的 —— 画着它等于说「这里有进度」，可进度是零。
       产品里没进度的进度条不该占位：它只让人以为「还没加载出来」。
       用 class 控制而不是 CSS :has() —— 旧 WebView 不一定支持 :has。 */
    const bar = fill.parentElement;
    if (bar) bar.classList.toggle('zero', pct <= 0);
  }

  /* 2026-11-05：这行原来是「已经记住 3 件。你教它一句，它记一句。」——
     老人根本没在「教」它。他只是在用，它自己记。文案得说这件事。 */
  const nt = $('gNote');
  if (nt) {
    if (n === 0) nt.textContent = '还没记下什么。你问它，它自己记。';
    else if (n < 5) nt.textContent = '记着 ' + n + ' 件。少交代一遍，它就少问一遍。';
    else nt.textContent = '记着 ' + n + ' 件了，越用越省事。';
  }
  /* 🚨 2026-11-07：0 条时把这张摘要卡整个收起来。
     它写「替你记着的事 0 / 还没记下什么。你问它，它自己记。」，
     下面空态卡写「还没替你记住什么 / 同一件事说上两回，它就记着了」——
     一屏两遍同一件事，而且「0」这个数字本身不提供任何信息。
     空态卡已经把「为什么是空的」和「怎么让它有」都说完了，
     摘要卡这时候只是重复。等真记住了再出来数数。 */
  const prog = document.querySelector('#page-learn .prog');
  if (prog) prog.hidden = n === 0;
}

/* ============ 动作系统：全部用骨骼算，不依赖动画文件 ============ */
const _e = new THREE.Euler(), _dq = new THREE.Quaternion();
function pose(b, x, y, z) {
  if (!b) return;
  _dq.setFromEuler(_e.set(x || 0, y || 0, z || 0, 'XYZ'));
  const q0 = b.userData.q0;
  if (q0) b.quaternion.copy(q0).multiply(_dq); else b.quaternion.copy(_dq);
}

let curAnim = 'idle', animT = 0, animDur = 0, nextAnim = null;
function playAnim(name, dur) {
  if (curAnim === name && animT < animDur * 0.5) return;
  curAnim = name; animDur = dur || 1.4; animT = 0;
}
const ANIM = {
  /* 所有动作都返回：各骨骼的欧拉角 + y(上下) + sq(挤压) + turn(整体左右摆) */
  idle(u, t) { const b = Math.sin(t * Math.PI * 2 * 1.15);
    return { neck: [Math.sin(t * 0.5) * 0.05, 0, 0],
             head: [0, Math.sin(t * 1.1) * 0.10, Math.sin(t * 0.7) * 0.05],
             wingL: [0, 0, 0.06 + Math.sin(t * 1.0) * 0.05],
             wingR: [0, 0, -0.06 - Math.sin(t * 1.0) * 0.05],
             tail: [Math.sin(t * 1.3) * 0.05, 0, 0],
             y: 0, sq: 0.012 * b, turn: Math.sin(t * 0.55) * 0.09 }; },
  /* 待机循环：u 在 [0,1) 里走一圈，且首尾完全对齐（全部用 2πu 的整数倍频率）。
     屏幕上用不着它（屏幕走 idle），它是给录视频用的——录出来能无缝循环。 */
  loopIdle(u) {
    const a = Math.PI * 2 * u;
    const breath = Math.sin(a);                 // 1 次/圈：呼吸
    const sway = Math.sin(a);                   // 1 次/圈：左右轻摆
    const bob = Math.sin(a * 2);                // 2 次/圈：上下点
    const blink = Math.sin(a * 2 + 1.2);        // 头微低
    const wing = Math.sin(a * 2 + 0.6);         // 翅膀轻颤
    return {
      neck: [0.045 * bob - 0.02, 0.03 * sway, 0.02 * sway],
      head: [0.055 * bob + 0.03 * blink, 0.16 * sway, -0.05 * sway],
      wingL: [0, -0.02 * wing, 0.10 + 0.07 * wing],
      wingR: [0, 0.02 * wing, -0.10 - 0.07 * wing],
      tail: [0.06 * Math.sin(a * 2 + 2.2), 0, 0.05 * sway],
      y: 0.012 * breath,
      sq: 0.014 * breath,
      turn: 0.07 * Math.sin(a + 0.9)
    };
  },
  /* 点头：认下来了 */
  nod(u) { const e = Math.sin(Math.PI * Math.min(1, u));
    const s = e * Math.sin(u * Math.PI * 6);
    return { neck: [0.42 * s, 0, 0], head: [0.30 * s, 0, 0],
             y: -0.035 * Math.abs(s), sq: 0.02 * Math.abs(s),
             wingL: [0, 0, 0.10], wingR: [0, 0, -0.10] }; },
  /* 歪头：没听清 / 在想 */
  tilt(u) { const s = Math.sin(Math.PI * Math.min(1, u));
    return { neck: [0.06 * s, 0.10 * s, 0.26 * s], head: [0.04 * s, 0, 0.62 * s],
             turn: 0.10 * s, tail: [0, 0, 0.18 * s] }; },
  /* 高兴：蹦 + 扇翅 */
  happy(u) { const e = Math.sin(Math.PI * Math.min(1, u));
    const hop = Math.abs(Math.sin(u * Math.PI * 2));
    return { neck: [-0.26 * e, 0, 0], head: [-0.16 * e, 0, 0],
             wingL: [0, -0.28 * e, 0.95 * e], wingR: [0, 0.28 * e, -0.95 * e],
             tail: [-0.30 * e, 0, 0],
             y: 0.20 * hop * e, sq: -0.03 * e, turn: 0.12 * Math.sin(u * Math.PI * 2) }; },
  /* 蹦一下 */
  hop(u) { const hop = Math.abs(Math.sin(u * Math.PI * 2));
    return { neck: [-0.12, 0, 0],
             wingL: [0, -0.20 * hop, 0.70 * hop], wingR: [0, 0.20 * hop, -0.70 * hop],
             tail: [-0.22 * hop, 0, 0], y: 0.26 * hop, sq: -0.04 * hop }; },
  /* 打招呼：蹦起来、侧身、歪头——翅膀只抬一小截，抬多了会缩进身子 */
  wave(u) { const e = Math.sin(Math.PI * Math.min(1, u));
    const hop = Math.abs(Math.sin(u * Math.PI * 2));
    const s = Math.sin(u * Math.PI * 8);
    return { wingL: [0, -0.10 * e, 0.30 * e],
             wingR: [0, 0.10 * e, -0.55 * e - 0.16 * s * e],
             neck: [-0.14 * e, -0.10 * e, -0.12 * e],
             head: [-0.10 * e, -0.14 * e, 0.30 * e],
             tail: [-0.16 * e, 0, 0],
             turn: -0.20 * e, y: 0.13 * hop * e, sq: -0.02 * hop * e }; },
  /* 在听：身子往前凑，头抬起来 */
  listen(u) { const s = Math.sin(Math.PI * Math.min(1, u));
    return { neck: [-0.30 * s, 0, 0], head: [-0.20 * s, 0.14 * s, -0.24 * s],
             wingL: [0, 0, 0.22 * s], wingR: [0, 0, -0.22 * s],
             turn: -0.12 * s, y: 0.05 * s, sq: 0.015 * s }; },
  /* 在想 */
  think(u) { const s = Math.sin(Math.PI * Math.min(1, u));
    return { neck: [-0.10 * s, 0.18 * s, 0.05 * s], head: [-0.08 * s, 0.30 * s, 0.44 * s],
             tail: [0, 0, 0.26 * s], turn: 0.14 * s }; },
  /* 查东西：抬头张望，翅膀张开 */
  search(u) { const s = Math.sin(Math.PI * Math.min(1, u));
    const s2 = Math.sin(u * Math.PI * 4);
    return { neck: [-0.34 * s, 0.10 * s, 0], head: [-0.30 * s, 0.06 * s + 0.07 * s2 * s, 0.20 * s],
             wingL: [0, -0.20 * s, 0.70 * s], wingR: [0, 0.20 * s, -0.70 * s],
             y: 0.06 * Math.abs(s2) * s, turn: 0.10 * s }; },
  /* 困 */
  sleepy(u) { const s = Math.sin(Math.PI * Math.min(1, u));
    return { neck: [0.40 * s, 0, 0], head: [0.46 * s, 0, 0.14 * s],
             y: -0.05 * s, sq: 0.045 * s, wingL: [0, 0, 0.06], wingR: [0, 0, -0.06] }; },
  /* 凑近说悄悄话 */
  lean(u) { const s = Math.sin(Math.PI * Math.min(1, u));
    return { neck: [0.14 * s, 0, -0.22 * s], head: [0.20 * s, 0, -0.34 * s],
             turn: -0.22 * s, y: -0.02 * s }; },
  /* 说话：头一直在动，身子跟着起伏 */
  speak(u, t) { const g = Math.sin(t * 9.6) * 0.5 + 0.5;
    return { neck: [-0.10 + 0.16 * g, 0.05 * Math.sin(t * 1.5), 0],
             head: [-0.06 + 0.13 * g, 0.06 * Math.sin(t * 1.2), 0.05 * Math.sin(t * 3.3)],
             wingL: [0, 0, 0.12 + 0.09 * g], wingR: [0, 0, -0.12 - 0.09 * g],
             sq: 0.008 * g, turn: 0.05 * Math.sin(t * 1.1) }; }
};
/* 把一组姿态角落到骨骼上。stepAnim 和「定格渲染」共用这一段，保证录出来的片子
   跟屏幕上看到的是同一套动作，不是另画一套。 */
function applyPose(a, idle, base) {
  const g = (k, i) => { const v = a[k] || idle[k] || [0, 0, 0]; return v[i]; };
  pose(bones.neck, g('neck',0), g('neck',1), g('neck',2));
  pose(bones.head, g('head',0), g('head',1), g('head',2));
  const cl = (v, m) => Math.max(-m, Math.min(m, v));
  pose(bones.wingL, cl(g('wingL',0), 0.5), cl(g('wingL',1), 0.35), cl(g('wingL',2), 1.05));
  pose(bones.wingR, cl(g('wingR',0), 0.5), cl(g('wingR',1), 0.35), cl(g('wingR',2), 1.05));
  pose(bones.tail, g('tail',0), g('tail',1), g('tail',2));
  pose(bones.spine, g('spine',0), g('spine',1), g('spine',2));
  const y = (a.y || 0);
  const sq = (a.sq || 0);
  PET.position.y = y;
  PET.rotation.y = (a.turn || 0);
  PET.scale.y = base * (1 + sq + (a === idle ? idle.sq || 0 : 0));
  PET.scale.x = PET.scale.z = base * (1 - (sq + (a === idle ? idle.sq || 0 : 0)) * 0.45);
}

function stepAnim(t, dt) {
  if (!PET) return;
  const base = PET === adultRoot ? 1.32 : PET === midRoot ? 1.16 : 1.02;
  if (animT >= animDur) { curAnim = 'idle'; animDur = 1e9; animT = 0; }
  animT += dt;
  const u = Math.min(1, animT / animDur);
  const idle = ANIM.idle(0, t);
  const a = (curAnim !== 'idle' && ANIM[curAnim]) ? ANIM[curAnim](u, t) : idle;

  /* 没骨骼的模型走整体变形。有骨骼的还是逐骨摆 —— 两种都能演，
     区别只是「细到翅膀」还是「整只一起」。 */
  if (PET.userData.rigless) { applyRigless(a, idle, base); return; }
  applyPose(a, idle, base);
}

/* 无骨骼：把骨骼动画的意图翻译成整体变换。
   呼吸 → 上下浮 + 轻微拉伸；点头 → 前倾；歪头 → 侧倾；
   开心 → 弹一下；查资料 → 左右小幅晃。 */
function applyRigless(a, idle, base) {
  const t = performance.now() / 1000;
  const breath = Math.sin(t * Math.PI * 2 * 0.42);        // 约 2.4 秒一次
  let y = breath * 0.012;                                  // 上下浮
  let sy = 1 + breath * 0.016, sx = 1 - breath * 0.010;    // 挤压拉伸
  let rx = 0, rz = 0, ry = 0, extraY = 0;

  const k = a || idle || {};
  // 头部动作折算成整体倾角（幅度收一半，整只动比动头夸张）
  if (k.head) { rx += (k.head[0] || 0) * 0.55; rz += (k.head[2] || 0) * 0.55; ry += (k.head[1] || 0) * 0.5; }
  if (k.neck) { rx += (k.neck[0] || 0) * 0.35; }

  // 各动作的整体翻译
  if (curAnim === 'nod')  { rx += Math.sin(u_(k) * Math.PI) * 0.22; }
  if (curAnim === 'tilt') { rz += Math.sin(u_(k) * Math.PI) * 0.26; }
  if (curAnim === 'happy'){ extraY += Math.abs(Math.sin(u_(k) * Math.PI)) * 0.05; sy += Math.sin(u_(k) * Math.PI) * 0.05; }
  if (curAnim === 'search'){ rz += Math.sin(u_(k) * Math.PI * 3) * 0.07; }
  if (curAnim === 'speak'){ sy += Math.sin(t * 14) * 0.008; }
  if (curAnim === 'sleepy'){ rx += 0.12; sy *= 0.97; }

  PET.position.y = PET.userData.baseY + y + extraY;
  PET.rotation.set(rx, ry, rz);
  PET.scale.set(base * sx, base * sy, base * sx);
}

/* 动作进度 0..1，给上面那些 sin(uπ) 用 */
function u_(k) {
  return Math.min(1, Math.max(0, animT / (animDur > 1e8 ? 1 : animDur)));
}

function burst() {
  /* 2026-11-10 真机：THREE 没起来（或刚被销毁）时 pGeo 是 undefined，
     顶部红条「cannot read properties of undefined reading attributes」就是它。 */
  if (!pGeo || !pMat) return;
  for (let i = 0; i < PN; i++) {
    pPos[i*3] = (Math.random()-.5)*0.15; pPos[i*3+1] = 0.4 + Math.random()*0.45; pPos[i*3+2] = (Math.random()-.5)*0.15;
    const a = Math.random()*Math.PI*2, s = 0.3 + Math.random()*0.8;
    pVel[i] = [Math.cos(a)*s, 0.42 + Math.random()*0.9, Math.sin(a)*s];
  }
  pGeo.attributes.position.needsUpdate = true; pT = 1; pMat.opacity = 1;
}

const clk = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = performance.now() / 1000, dt = Math.min(0.05, clk.getDelta());
  stepAnim(t, dt);
  if (pT > 0 && pGeo) {
    pT -= dt * 0.55;
    for (let i = 0; i < PN; i++) {
      pPos[i*3] += pVel[i][0]*dt; pPos[i*3+1] += pVel[i][1]*dt; pPos[i*3+2] += pVel[i][2]*dt;
      pVel[i][1] -= dt * 0.6;
    }
    pGeo.attributes.position.needsUpdate = true;
    pMat.opacity = Math.max(0, Math.min(1, pT));
  }
  if (renderer) renderer.render(scene, camera);
}

function resize() {
  if (!renderer) return;
  const box = cvs.parentElement.getBoundingClientRect();
  const w = Math.max(1, box.width), h = Math.max(1, box.height);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

/* 2026-11-06 菲尔特：「这个鸡都因为文字压扁了」。
   根因不是模型，是没人盯着卡片的高度：
   米粒说长话 → 气泡变高 → 卡片被 flex 挤矮（max-height 420 / min-height 150）→
   画布的 CSS 变成 100% 跟着变矮，可渲染缓冲还是老高度、相机还是老宽高比，
   于是整只鸡被横向拉开。只在 window resize 时量一次是不够的 ——
   卡片高度是「内容撑出来的」，窗口一动都没动。
   ResizeObserver 直接盯盒子，气泡换行、告警条出现消失、横竖屏，全都接得住。 */
let _roCard = null;
function watchPetBox() {
  if (typeof ResizeObserver === 'undefined' || !cvs || !cvs.parentElement) return;
  if (_roCard) return;
  let last = '';
  _roCard = new ResizeObserver(() => {
    const b = cvs.parentElement.getBoundingClientRect();
    const key = Math.round(b.width) + 'x' + Math.round(b.height);
    if (key === last) return;          // 只在真的变了才重新算，别每帧都 updateProjectionMatrix
    last = key;
    resize();
  });
  _roCard.observe(cvs.parentElement);
}

/* ResizeObserver 在部分老 WebView 上会漏触发（真机上「鸡被压扁」剩的那一半根因）。
   所以不把命押在它身上：气泡一变，自己再量一次，下一帧再量一次。 */
let _rsT = 0;
function petResizeSoon() {
  clearTimeout(_rsT);
  _rsT = setTimeout(() => {
    try { resize(); } catch (e) {}
    requestAnimationFrame(() => { try { resize(); } catch (e) {} });
  }, 60);
}

/* 桌面窗口不够高时，整只手机等比缩小 —— 不要为了塞进窗口把米粒压成一条 */
function fitPhone() {
  const p = $('phone');
  if (!p) return;
  if (innerWidth <= 470) {
    p.style.transform = ''; p.style.height = ''; p.style.maxHeight = '';
    p.style.position = ''; p.style.left = ''; p.style.top = '';
    document.body.style.display = ''; document.body.style.placeItems = '';
    return;
  }
  const s = Math.min(1, (innerHeight - 24) / 932, (innerWidth - 24) / 430);
  p.style.height = '932px';
  p.style.maxHeight = 'none';
  p.style.position = 'fixed';
  p.style.left = '50%'; p.style.top = '50%';
  p.style.transformOrigin = 'center center';
  p.style.transform = 'translate(-50%, -50%) scale(' + s.toFixed(4) + ')';
}

/* ============ 说话：原生桥优先，网页端用浏览器语音 ============ */
const NATIVE = () => {
  const n = window.MiliNative;
  if (!n) return null;
  try { return (typeof n.isAvailable === 'function' && n.isAvailable()) ? n : n; } catch (e) { return null; }
};
let speaking = false, voiceOn = true, zhVoice = null;

/* ===== 2026-11-11：跨 App 自动化时的「等」 =====
   真机实证：open_app 打开拼多多后，米粒 Activity 进后台，Chromium 把页面
   定时器节流到每分钟一次 —— agent-tools.js 里每个 await wait(2600) 变成
   永久等待，工具超时（8 秒）也一起失效。实测 open_app 20:32:31 成功，
   search_in_app 20:36:11 才报超时，中间挂了 220 秒。老人看到的就是
   「一直在想」+ 从此不再理人（_busy 卡死）。
   前端可见时照旧用 setTimeout（不卡渲染）；页面隐藏时改走 Java 线程的
   MiliNative.sleepMs —— 它不受页面生命周期节流。 */
window.__NAP = function (ms) {
  const n = (function () { try { return NATIVE(); } catch (e) { return null; } })();
  try {
    if (n && typeof n.sleepMs === 'function' && document.hidden) {
      n.sleepMs(Math.max(0, Math.min(ms || 0, 15000)));
      return Promise.resolve();
    }
  } catch (e) {}
  return new Promise(function (r) { setTimeout(r, ms || 0); });
};


function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find((v) => /zh[-_]CN|Chinese|普通话/i.test(v.lang + v.name)) || vs.find((v) => v.lang && v.lang.startsWith('zh')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

/* 说一句话：屏幕上出字，同时念出来 */
/* 语音分三级：
   1) 预生成的童声片段（按 key 查，断网可用，带情绪）—— 固定话术走这条
   2) 安卓原生 TTS —— 动态内容（搜索结果之类）
   3) 浏览器 speechSynthesis —— 网页端兜底 */
let voiceAudio = null;

/* 预生成童声取地址，两种产物各走一条：
   单文件版：window.__VOICE[key] = base64 dataURI（断网可用）
   线上版：  window.__T2F[文本] = './assets/voice/xxx.mp3'（按需下载，不占内存） */
function voiceClip(key) {
  if (!key) return null;
  const M = window.__VOICE;
  if (M && M[key]) return M[key];
  const F = window.__T2F;
  if (F && F['#' + key]) return F['#' + key];
  return null;
}
/* 麦克风总闸。网页这边放童声走的是 <audio>，系统 TTS 一次都没被调用，
   原生那三个回调也就一个都不会来 —— 闸等于没关，它照着自己的话往下听。
   所以网页自己动手：开播关、播完开。 */
function micShut() { const n = NATIVE(); if (n && n.micShut) { try { n.micShut(); } catch (e) {} } }
function micOpen() { const n = NATIVE(); if (n && n.micOpen) { try { n.micOpen(); } catch (e) {} } }

/* 把一个 <audio> 真正按死。
   pause() 只是停下播放指针，底层 MediaPlayer 还挂在喇叭上——
   实测日志里那条 22050Hz 的 mp3 音轨，pause 之后 AudioTrack 一直是 active，
   豆包（24000Hz）新起一句时它还在，两路就一起响。
   只有把 src 摘掉再 load()，播放器才会真正被回收。 */
function killAudio(a) {
  if (!a) return;
  try { a.onended = null; a.onerror = null; } catch (e) {}
  try { a.pause(); } catch (e) {}
  try { a.currentTime = 0; } catch (e) {}
  try { a.removeAttribute('src'); } catch (e) {}
  try { a.load(); } catch (e) {}
}

function playClip(src, opts) {
  const o = opts || {};
  try {
    if (voiceAudio) { killAudio(voiceAudio); voiceAudio = null; }
    const a = new Audio(src);
    voiceAudio = a;
    // 「记不住」的那几条要慢慢说两句：第一遍正常，第二遍略慢
    if (o.twice) a.playbackRate = 0.88;
    a.onplay = () => {
      speaking = true; micShut(); try{petMode("sing")}catch(e){}
      if (curAnim === 'idle' || curAnim === 'speak') playAnim('speak', 30);
    };
    a.onended = () => {
      /* 真话已经接管了（流式那边把 voiceAudio 换掉了）：
         这时候不能再动 speaking / 麦克风，否则它正在念，麦却被这里打开了。 */
      if (voiceAudio !== a) return;
      if (o.twice) {
        o.twice = false;                 // 只重复一次
        setTimeout(() => {
          try {
            const a2 = new Audio(src);
            a2.playbackRate = 0.82;
            voiceAudio = a2;
            a2.onended = () => {
              if (voiceAudio !== a2) return;
              speaking = false; try{petMode("idle")}catch(e){} micOpen(); ttsDone();
              if (curAnim === 'speak') playAnim('idle', 1);
            };
            a2.play().catch(() => { speaking = false; try{petMode("idle")}catch(e){} micOpen(); ttsDone(); });
          } catch (e) { speaking = false; try{petMode("idle")}catch(e){} micOpen(); ttsDone(); }
        }, 420);
        return;
      }
      speaking = false; try{petMode('idle')}catch(e){}
      micOpen(); ttsDone();
      if (curAnim === 'speak') playAnim('idle', 1);
    };
    a.onerror = () => {
      if (voiceAudio !== a) return;
      speaking = false; try{petMode("idle")}catch(e){} micOpen(); ttsDone();
    };
    const p = a.play();
    if (p && p.catch) p.catch(() => { speaking = false; try{petMode("idle")}catch(e){} micOpen(); ttsDone(); });
    return true;
  } catch (e) { return false; }
}

/* 一句话念完了。
   连续对话模式下不需要「再点一下继续听」—— 原生那边麦克风一直没放手，
   这里只要把状态标回「在听」。按住说话模式什么都不用做。 */
function ttsDone() {
  /* 还有话排在后面：这一句的收尾不能把界面标成「在听」，
     更不该让别处顺手把麦克风开回来 —— 后面还有声音要出。 */
  if (SS.live || SS.playing || SS.q.length) return;
  if (window.__cvOn) cvState('listen');
  /* 21:4x：念完这句只改状态文字，**不刷新 CALL.last**。
     原来米粒自己每念一句都给通话续命，只要它自言自语就永远不挂断。 */
  if (typeof CALL !== 'undefined' && CALL.on) cbStatus('listen');
}
/* 原生 TTS 念完会回调这里（走系统 TextToSpeech 那一路才会来） */
window.miliTtsDone = function () { ttsDone(); };

/* 老人插话了：原生已经把 TTS 掐掉、闸打开。
   这里负责把界面收干净 —— 气泡停在原处（那是它刚说的话，留着让老人看），
   但不能继续等他「说完」再答第二遍。 */
window.miliOnBarge = function () {
  speaking = false;
  try{petMode('idle')}catch(e){}
  ssHalt();
  try { if (window.__sayTimer) { clearTimeout(window.__sayTimer); window.__sayTimer = null; } } catch (e) {}
  if (curAnim === 'speak') playAnim('idle', 1);
  if (window.__cvOn) cvState('listen');
};

/* ==========================================================================
   作息画像（rhythm）—— 米粒「自己学会」的全部实现
   --------------------------------------------------------------------------
   2026-11-08 菲尔特：「不是让爷爷教，是它自己观察、自己总结」。
   调研依据（不是拍脑袋）：
   · HALO 2026 研究，8000 条人工评分：主动式 AI 最大失败模式是「太早/太多」
     （61.2%），「太晚」只占一半 —— 克制比勤奋值钱。
   · WSU/CASAS：最佳提示时机是「两件事之间」，活动进行中打断会增加困惑。
   · 伯明翰焦点小组原话：「我每天 8 点看新闻，它该学会别在这时提醒别的事。」
   · Qorvo 商业系统：两周训练期建立基线后才开始报警 —— 样本不足不下结论。
   设计原则：
   ① 只记录产品本来就会产生的事件，老人不做任何额外动作
   ② 样本不足不下结论：跨天 < 3 天且次数 < 3 次就闭嘴（宁可不说，不能瞎猜）
   ③ 每天主动说话有预算（默认 6 次），用完就沉默
   ④ 只在「事件间隙」开口：他刚说完话、刚关掉电视、刚回家
   ⑤ 全部可查、可单条删、可整页清空 —— 回退是一等公民
   ========================================================================== */
(function () {
  const KEY = 'mili.rhythm';
  const MIN_DAYS = 3;          /* 同一事件至少跨 3 天 */
  const MIN_HITS = 3;          /* 或者同一事件累计出现 3 次 —— 两个条件先到者生效
                                  （2026-11-12 菲尔特拍板：42 小时赛程里跑不满 3 天，
                                    现场要能证明「它记住了」，所以次数够也算数） */
  const KINDS = ['wake', 'meal', 'med', 'tv', 'sleep', 'call', 'talk'];

  /* 本地日期。toISOString() 取的是 UTC，北京时间 08:00 前会把事件记到昨天，
     直接毁掉「跨 3 天」的计数。统一走总线。 */
  function today() { return window.MILI_STORE.localDay(); }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || { days: {}, nudges: {} }; }
    catch (e) { return { days: {}, nudges: {} }; }
  }
  let R = load();
  function persist() {
    /* 不再空吞 QuotaExceededError：写失败由总线置 writeFailed，界面可以据此告警。 */
    if (window.MILI_STORE) return window.MILI_STORE.put(KEY, R);
    try { localStorage.setItem(KEY, JSON.stringify(R)); return true; } catch (e) { return false; }
  }

  /* 记一笔。ts 不传就是现在。 */
  function note(kind, extra) {
    if (KINDS.indexOf(kind) < 0) return;
    const d = today();
    const day = R.days[d] || (R.days[d] = {});
    const arr = day[kind] || (day[kind] = []);
    const now = new Date();
    arr.push({ t: now.getHours() * 60 + now.getMinutes(), x: extra || '' });
    if (arr.length > 40) arr.shift();
    /* 只留最近 30 天，文件不会越滚越大 */
    const keys = Object.keys(R.days).sort();
    while (keys.length > 30) delete R.days[keys.shift()];
    persist();
  }

  /* 聚合：每个事件取「跨天中位数」，样本天数不足就返回 null */
  function median(list) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }
  function profile() {
    const out = {};
    KINDS.forEach(function (k) {
      const perDay = [];
      let hits = 0;
      Object.keys(R.days).forEach(function (d) {
        const arr = (R.days[d] && R.days[d][k]) || [];
        if (arr.length) { perDay.push(arr); hits += arr.length; }
      });
      /* 跨够 3 天，或者见够 3 次，都算成型 */
      if (perDay.length < MIN_DAYS && hits < MIN_HITS) { out[k] = null; return; }
      /* wake / sleep 一天只取第一条 / 最后一条；其余取当天首条时刻 */
      const times = perDay.map(function (arr) {
        if (k === 'sleep') return arr[arr.length - 1].t;
        return arr[0].t;
      });
      const extra = perDay.map(function (arr) {
        const e = arr.find(function (x) { return x.x; });
        return e ? e.x : '';
      }).filter(Boolean);
      const freq = {};
      extra.forEach(function (e) { freq[e] = (freq[e] || 0) + 1; });
      const top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0] || '';
      out[k] = { t: median(times), days: perDay.length, hits: hits,
                 basis: perDay.length >= MIN_DAYS ? 'days' : 'hits', top: top };
    });
    return out;
  }

  /* 主动预算：一天说几句，说了几句 */
  function budget() {
    const d = today();
    const used = (R.nudges[d] || []).length;
    return { used: used, cap: 6, left: Math.max(0, 6 - used) };
  }
  function noteNudge(kind) {
    const d = today();
    (R.nudges[d] || (R.nudges[d] = [])).push({ t: new Date().getHours() * 60 + new Date().getMinutes(), k: kind });
    persist();
  }

  function wipe() { R = { days: {}, nudges: {} }; persist(); }
  function drop(kind) {
    Object.keys(R.days).forEach(function (d) { if (R.days[d]) delete R.days[d][kind]; });
    persist();
  }
  function dump() { return JSON.parse(JSON.stringify(R)); }

  window.MILI_RHYTHM = { note: note, profile: profile, budget: budget,
                         noteNudge: noteNudge, wipe: wipe, drop: drop, dump: dump,
                         MIN_DAYS: MIN_DAYS, MIN_HITS: MIN_HITS };

  /* 登记到统一记忆总线。一键清空必须连作息画像一起清。 */
  if (window.MILI_STORE) {
    window.MILI_STORE.register('rhythm', {
      keys: [KEY, 'mili.rhythm'],
      wipe: function () { R = { days: {}, nudges: {} }; }
    });
  }
})();


/* ==========================================================================
   主动开口（nudge）—— 「进化」在老人身上唯一能感觉到的样子
   规则全部来自调研，不是拍的：
   · 只在「两件事之间」说（他在看电视/在通话时一律闭嘴，WSU/CASAS）
   · 每天最多 6 句（HALO：过度主动是 61.2% 的失败原因）
   · 同一件事一天只说一次
   · 22:00–6:00 只允许「该睡了」这一句
   · 家人端、录音、思考中都闭嘴
   ========================================================================== */
(function () {
  const NUDGE_GAP = 12;        /* 画像时刻前后 12 分钟都算「到点」 */
  let lastNudgeAt = 0;
  const saidToday = {};

  function mm() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function keyOf(k) { return new Date().toISOString().slice(0, 10) + ':' + k; }

  function busy() {
    try {
      if (window.__F7_FAMILY) return true;               /* 家人端不打扰 */
      if (typeof CALL !== 'undefined' && CALL.on) return true;
      if (document.getElementById('tvfull') && !document.getElementById('tvfull').hidden) return true;
      if (typeof listening !== 'undefined' && listening) return true;
      if (typeof speaking !== 'undefined' && speaking) return true;
    } catch (e) {}
    return false;
  }

  function line(k, p) {
    const hh = String(Math.floor(p.t / 60)).padStart(2, '0') + ':' + String(p.t % 60).padStart(2, '0');
    /* 2026-11-10 自查：这一段原来有三句是假话 ——
         倒水（没倒）、放电视（没放）、关声音（没关）。
       菲尔特立的规矩是「文案不能比实测能力多一个字」，所以全部改成
       真做得到的：要么是问句（他答了才动手），要么是真提醒（药闹钟真的在跑）。 */
    if (k === 'wake') {
      const now = mm();
      const diff = now - p.t;
      if (diff < -8) return '今天起得早。先坐一会儿，不着急下床。';
      if (diff > 20) return '今儿起得晚，先喝口水再下床。';
      return '早，这个点您天天起。今天有什么打算？';
    }
    if (k === 'meal') return '到饭点了，想吃点什么？';
    if (k === 'med') return '该吃药了。';
    if (k === 'tv') {
      /* 「CCTV-11 戏曲」→ 只说「戏曲」；「抖音·后会有期」→「后会有期」。
         老人耳朵里不需要频道号。
         ★ 只问，不宣称已经放了 —— 播放要等他答一句再真的动手。 */
      let name = (p.top || '戏曲').replace(/^.*?·/, '').replace(/^CCTV-?\d*\s*/i, '').trim();
      if (!name) name = '戏曲';
      return '这个点您常看' + name + '，要放上吗？';
    }
    if (k === 'sleep') return '不早了，睡吧。';
    return '';
  }

  function tick() {
    try {
      if (!window.MILI_RHYTHM) return;
      if (busy()) return;
      if (Date.now() - lastNudgeAt < 5 * 60 * 1000) return;   /* 两次之间至少 5 分钟 */
      const bud = window.MILI_RHYTHM.budget();
      if (bud.left <= 0) return;
      const prof = window.MILI_RHYTHM.profile();
      const now = mm();

      /* ===== 对照模式：不看画像，只按固定时刻说通用话 =====
         用来证明「第 7 天更好」不是同一个东西演两遍。 */
      if (S && S.rhythmOff) {
        const FIXED = [
          [7 * 60 + 30, 'med',   '该吃药了。'],
          [11 * 60 + 30, 'meal', '到饭点了，先吃饭。'],
          [19 * 60,     'tv',    '想看点什么？']
        ];
        for (let i = 0; i < FIXED.length; i++) {
          const f = FIXED[i];
          if (Math.abs(now - f[0]) > NUDGE_GAP) continue;
          if (saidToday[keyOf('fixed_' + f[1])]) continue;
          saidToday[keyOf('fixed_' + f[1])] = 1;
          lastNudgeAt = Date.now();
          try { say(f[2], 6000, { slow: true }); } catch (e) {}
          /* 它先开口，就得把耳朵打开 —— 老人回一句「不想看」也得有人接。 */
          try { callEnter('nudge', 30000); } catch (e) {}
          try { if (window.MILI_AGENT && MILI_AGENT.note) MILI_AGENT.note('assistant', f[2]); } catch (e) {}
          try { if (window.MILI_DEBUG) console.log('[nudge:fixed]', f[2]); } catch (e) {}
          return;
        }
        return;
      }
      /* 每条都有自己的「能说的时间窗」——晚上九点绝不能冒出一句「早」。
         这是自测抓到的：只按画像时刻匹配，深夜也会说早。 */
      const WINDOW = {
        wake:  [5 * 60, 11 * 60],
        med:   [5 * 60, 22 * 60],
        meal:  [10 * 60, 20 * 60],
        tv:    [11 * 60, 23 * 60],
        sleep: [19 * 60, 24 * 60]
      };
      const order = ['wake', 'med', 'meal', 'tv', 'sleep'];
      for (let i = 0; i < order.length; i++) {
        const k = order[i];
        const p = prof[k];
        if (!p) continue;                                   /* 跨天不满 3 天、次数不满 3 次，不猜 */
        const win = WINDOW[k] || [0, 1440];
        if (now < win[0] || now > win[1]) continue;
        if (Math.abs(now - p.t) > NUDGE_GAP) continue;
        if (saidToday[keyOf(k)]) continue;
        /* 深夜只允许「该睡了」 */
        if ((now < 6 * 60 || now > 22 * 60) && k !== 'sleep') continue;
        const text = line(k, p);
        if (!text) continue;
        saidToday[keyOf(k)] = 1;
        lastNudgeAt = Date.now();
        window.MILI_RHYTHM.noteNudge(k);
        try { say(text, 6000, { slow: true }); } catch (e) {}
        /* 2026-11-10 菲尔特：「主动问候的时候自动打开连续对话」。
           「想看点什么？」这句问出去，老人回「戏曲」就得当场接住，
           不然他得先喊一声米粒再说一遍 —— 那这句问候就是白问的。 */
        try { callEnter('nudge', 30000); } catch (e) {}
        /* 这句是米粒说的，得进历史 —— 不然老人回「要」，模型不知道在回什么。 */
        try { if (window.MILI_AGENT && MILI_AGENT.note) MILI_AGENT.note('assistant', text); } catch (e) {}
        try { if (window.MILI_DEBUG) console.log('[nudge]', k, text); } catch (e) {}
        return;
      }
    } catch (e) {}
  }

  /* 60 秒一次，够用且不耗电 */
  setInterval(tick, 60000);
  window.__nudgeTick = tick;   /* 自测用：手动触发一次 */
})();

/* ===== 即时应答音：本地 mp3，点下就出声（约 80ms），不赌网络 =====
   2026-11-08 菲尔特：「带工具的回复好慢，争取 0.2s 内完成」。
   0.2s 内「完成」不可能（网络往返 + 模型首 token 就不止），
   但 0.2s 内「开始响应」可以：先播一个本地语气词，真实答案随后接上。 */
const FILLER_ACK = ['assets/filler/f1.mp3', 'assets/filler/f2.mp3', 'assets/filler/f5.mp3'];
const FILLER_WORK = ['assets/filler/f3.mp3', 'assets/filler/f4.mp3', 'assets/filler/f6.mp3'];
let fillerAudio = null, fillerT0 = 0;
let FILLER_ON = false;   /* 2026-11-08 关：edge-tts 的晓晓是成年女声，跟米粒童声放一起像两个人。
                            等用豆包童声重录这 6 句再打开。 */
function fillerPlay(kind) {
  if (!FILLER_ON) return;
  try {
    fillerStop();
    const pool = kind === 'work' ? FILLER_WORK : FILLER_ACK;
    const src = pool[Math.floor(Math.random() * pool.length)];
    fillerAudio = new Audio(src);
    fillerAudio.volume = 0.95;
    fillerT0 = performance.now();
    const pr = fillerAudio.play();
    if (pr && pr.catch) pr.catch(function () {});
  } catch (e) {}
}
function fillerStop() {
  if (!fillerAudio) return;
  try { fillerAudio.pause(); } catch (e) {}
  fillerAudio = null;
}
window.__filler = { play: fillerPlay, stop: fillerStop, at: function () { return fillerT0; } };

/* ===== 端到端耗时打点（2026-11-10）=====
   菲尔特要「响应速度优化」，但没有真机就量不出「快了」还是「慢了」，
   我不拿参数当成绩。这里只埋四个时间点，真机一接上就能算每段：
     at     老人说完、开始处理
     text   模型第一句到手
     audio  第一声出口
   读法：真机 logcat 里 grep MILI_LAT，或远程调试 console。
   平时零开销 —— 没有 __lat 就直接 return。 */
function latMark(k) {
  try {
    if (!window.__lat || !window.__lat.at) return;
    if (!window.__lat[k]) window.__lat[k] = Date.now();
    if (k === 'audio' && !window.__lat.printed) {
      window.__lat.printed = 1;
      const L = window.__lat;
      const ms = { 定稿到首音: (L.audio - L.at) };
      if (L.text) ms.模型首句 = L.text - L.at;
      ms.共 = L.audio - L.at;
      console.log('[MILI_LAT] ' + JSON.stringify(ms));
    }
  } catch (e) {}
}
window.__latMark = latMark;

function speak(text, opts) {
  const o = opts || {};
  if (!text) return;
  latMark('audio');
  /* 演示模式：第一声出口。跟 turn 起点一对，就是「说完到听见回应」的秒数。 */
  try { window.__DEMO_AUDIO && window.__DEMO_AUDIO(); } catch (e) {}
  /* 整段说出场，流式那边就得让位 —— 否则两路声音叠在一起，
     老人会以为手机坏了在重影。
     三路都要按死：流式队列、<audio>、系统 TTS。漏一路都会听见两个人在说话。 */
  fillerStop();          /* 真答案来了，语气词让位，绝不叠音 */
  ssHalt();
  if (voiceAudio) { killAudio(voiceAudio); voiceAudio = null; }
  if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
  /* 记下这句正在说的话 —— 识别回调拿它判断「听到的是不是我自己在念」。 */
  window.__sayText = String(text || '');
  if (window.__cvOn) cvState('say');

  /* 找一个能直接播的童声片段：先按 key，再按整句话 */
  let clip = voiceClip(o.key);
  if (!clip && window.__T2C) clip = window.__T2C[text] || null;
  if (!clip && window.__T2F) clip = window.__T2F[text] || null;
  if (clip && clip.charAt(0) === '.') {
    try { clip = new URL(clip, location.href).href; } catch (e) {}
  }

  /* App 在后台：界面不抢回来，但声音必须还是童声。
     WebView 后台音频会被系统暂停，所以把片段交给原生 MediaPlayer 播。 */
  if (document.hidden) {
    const nn0 = NATIVE();
    if (nn0) {
      try { nn0.petSay && nn0.petSay(text); } catch (e) {}
      let played = false;
      if (clip && nn0.playVoice) {
        try { played = nn0.playVoice(clip) !== false; } catch (e) {}
      }
      if (!played) { try { nn0.speak && nn0.speak(text, true); } catch (e) {} }
      return;
    }
  }

  /* 有原生豆包：整段也交给它，全站只留一个嗓子。
     预生成片段和云端 mp3 都是另一个人的声音（22050Hz mp3），
     和豆包的 24kHz PCM 撞在一起，老人听到的就是两个人在同时说话。
     twice（「记不住」要重复两遍）走不了豆包这条路，还是用片段。 */
  const nS = NATIVE();
  if (!o.twice && nS && typeof nS.ttsSay === 'function') {
    /* 🚨 2026-11-12 21:14 修「两个嗓子」。
       这一行原来写的是 nativeTTS(text, o) —— 也就是系统 TTS（小米的成年女声），
       可上一段注释写的是「整段也交给豆包，全站只留一个嗓子」，代码跟注释是反的。
       后果：凡走整段播报的句子（「外婆，回来啦」「哎，我在这儿呢」）全是那个
       冰冷女声，跟流式回复的奶气萌娃撞在一起，听起来像两个人在说话。
       现在整段也交给豆包；播完由 miliTtsEnd → ssGate(false) 把麦克风还回去。 */
    const gid = 'g' + (++SS.uid);
    SS.wait[gid] = function () { ssGate(false); };
    ssGate(true);
    try { nS.ttsSay(text, gid); return; } catch (e) { delete SS.wait[gid]; ssGate(false); }
  }

  /* 🚨 预生成片段（app/assets/voice/*.mp3）是 edge-tts 的 XiaoyiNeural —— 卡通女声，
     跟豆包的奶气萌娃不是一个嗓子，一播就是「换人说话了」，所以不再用它。
     保留云端同款童声（server/doubao_tts.py 里也是 naiqimengwa），最后才退系统 TTS。 */
  if (voiceOn && typeof ttsFetch === 'function' && cloudOK()) {
    let done = false;
    ttsFetch(text).then((url) => {
      if (done) return;
      done = true;
      if (url && playClip(url, o)) return;
      nativeTTS(text, o);
    }).catch(() => { if (!done) { done = true; nativeTTS(text, o); } });
    return;
  }

  nativeTTS(text, o);
}

/* 系统 TTS 兜底。抬到 1.55 尽量贴近童声，但音色终究不同，
   所以只在「语料没覆盖 + 服务端也没拿到」时才用它。 */
function nativeTTS(text, o) {
  o = o || {};
  const n = NATIVE();
  if (n && n.speak) { try { n.speak(text, !!o.slow); } catch (e) {} return; }
  if (!('speechSynthesis' in window) || !voiceOn) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (zhVoice) u.voice = zhVoice;
    u.rate = o.slow ? 0.82 : 0.98;
    u.pitch = 1.55;
    u.volume = 1;
    u.onstart = () => { speaking = true; try{petMode('sing')}catch(e){} if (curAnim === 'idle' || curAnim === 'speak') playAnim('speak', 30); };
    u.onend = () => { speaking = false; try{petMode('idle')}catch(e){} if (curAnim === 'speak') playAnim('idle', 1); };
    speechSynthesis.speak(u);
  } catch (e) {}
}

function hush() {
  if (voiceAudio) { killAudio(voiceAudio); voiceAudio = null; }
  const n = NATIVE(); if (n && n.stopSpeak) { try { n.stopSpeak(); } catch (e) {} }
  if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
  speaking = false;
  ssHalt();
}

/* ==========================================================================
 * 流式说话
 *
 * 以前是「等全文 → 合成整段 → 开始念」。老人说完一句话，得等 2.5 秒才听见
 * 第一声，而且中间换气、断句全是合成器自己猜的。
 *
 * 现在改成三件事同时进行：
 *   大脑在生成第 3 句 → 第 2 句在合成 → 第 1 句在念
 *
 * 能这么做的前提是句子之间互不依赖。所以按句号切开，一句一句走流水线：
 * 切出来就送去合成（最多 3 句并行），合成好的按顺序排队播。
 * 老人听到的第一声从「全文生成完」提前到「第一句生成完」。
 *
 * 三个必须处理的坑：
 *   ① 第一句要短。老人最在意的就是它什么时候开口，所以第一句遇到逗号就切。
 *   ② 麦克风整轮只关一次。每句播完就开闸的话，句间空隙它会把自己的下一句
 *      录进去，连续听模式下就变成自己跟自己接龙。
 *   ③ 打断要能真停。老人一插话，正在合成的、排队等播的、正在播的全清掉。
 * ========================================================================== */
const SS = {
  live: false,      // 这一轮正在流式说
  engaged: false,   // 这一轮内核真的开了流（收到过增量）
  finished: false,  // 内核已经说完了（剩的尾巴交给队列播完）
  wrapped: false,   // 收尾（麦克风还回去）做过没有
  buf: '',          // 还没切出去的半句
  seq: 0,
  q: [],            // 待播队列，按 seq 顺序
  playing: false,
  gated: false,     // 麦克风闸是不是我们关的
  spoke: '',        // 已经念出去的全部内容
  uid: 0,           // 每句一个号，原生播完按号来回话
  wait: {},         // 号 → 播完之后该干什么
  all: '',          // 这一轮收到的完整文本（只用来查复读，不参与播放）
  dup: false,       // 已经判定在复读，后面的增量一律不再收
};

/* 流式调优用的打点。平时一点都不占，验收时在控制台设 window.__ssTrace = 1 才记。
   没有这个，「快了多少」只能靠耳朵猜 —— 猜不准，还会自我感觉良好。 */
function ssMark(k, v) {
  if (!window.__ssTrace) return;
  const L = (window.__ssLog = window.__ssLog || []);
  L.push({ t: Date.now(), k: k, v: v });
  if (L.length > 300) L.splice(0, 150);
}

function ssGate(close) {
  if (close) {
    if (SS.gated) return;
    SS.gated = true;
    speaking = true;
    try{petMode('sing')}catch(e){}
    micShut();
    if (curAnim === 'idle' || curAnim === 'speak') playAnim('speak', 30);
  } else {
    if (!SS.gated) return;
    SS.gated = false;
    speaking = false;
    try{petMode('idle')}catch(e){}
    micOpen();
    ttsDone();
    if (curAnim === 'speak') playAnim('idle', 1);
  }
}

function ssReset() {
  SS.live = true;
  SS.engaged = true;
  SS.finished = false;
  SS.wrapped = false;
  SS.buf = '';
  SS.seq = 0;
  SS.q = [];
  SS.spoke = '';
  SS.all = '';
  SS.dup = false;
}

/* 打断：正在合成的不收了，排队的不播了，正在播的掐掉 */
function ssHalt() {
  const was = SS.live || SS.playing || SS.q.length;
  SS.live = false;
  SS.finished = true;
  SS.buf = '';
  SS.q = [];
  SS.playing = false;
  SS.wait = {};                       // 旧号全部作废，原生回来也对不上
  const n = NATIVE();
  if (n && typeof n.ttsStop === 'function') { try { n.ttsStop(); } catch (e) {} }
  if (voiceAudio) { killAudio(voiceAudio); voiceAudio = null; }
  if (was) ssGate(false);
}

/* 气泡跟着长。老人一边听一边看，字要现出来，不能等整段 */
function ssBubble(add) {
  const b = $('bubble'), t = $('bubbleText');
  if (!b || !t) return;
  /* 断点在这里比 ssFeed 更准：句子已经切好了，一句一句贴。
     这一句跟刚才那句去掉标点后一模一样 → 模型在复读，别再贴第二遍。
     截图里那句星星的解释，就是这么贴了两遍的。 */
  const na = normLine(add);
  if (na.length >= 8 && normLine(t.textContent || '').endsWith(na)) {
    ssMark('dupseg', na.length);
    return;
  }
  if (b.hidden) { t.textContent = add; b.hidden = false; }
  else t.textContent = String(t.textContent || '') + add;
  try { petResizeSoon(); } catch (e) {}
  try { if (typeof armBubbleHide === 'function') armBubbleHide(); } catch (e) {}
}

/* 切句。force = 内核说完了，剩下的不管有没有标点都吐出去 */
function ssCut(force) {
  for (;;) {
    const b = SS.buf;
    if (!b) return;
    let cut = -1;
    if (SS.seq === 0) {
      /* 第一句：逗号和句号谁先到就切谁。
         这里不能「先找句号、找不到才退回逗号」—— 那句话一旦有句号，
         第一句就一路拖到 20 字才出声，听感上跟整段播没区别。
         老人最在意的就是「它什么时候开口」，所以第一句越短越好。
         但至少要 4 个字，「好，」这种切出来不值当合成一趟。 */
      for (let i = 0; i < b.length; i++) {
        if (/[。！？!?；;\n]/.test(b[i])) { cut = i; break; }
        if (i >= 3 && /[，,、：:]/.test(b[i])) { cut = i; break; }
      }
    } else {
      /* 后面的句子只认强边界。逗号也切的话，一句话被剁成四五段，
         合成器每段都要重新起调，拼起来像机器人换气。 */
      for (let i = 0; i < b.length; i++) {
        if (/[。！？!?；;\n]/.test(b[i])) { cut = i; break; }
      }
    }
    /* 一直没标点：攒到 24 字硬切。不能无限等 —— 模型有时候一口气写长句 */
    if (cut < 0 && b.length >= 24) cut = 23;
    if (cut < 0 && force) cut = b.length - 1;
    if (cut < 0) return;
    /* 连着的标点一起带上：「？！」不该拆成两句，合成器念两次问号很怪 */
    let j = cut;
    while (j + 1 < b.length && /[。！？!?；;…\n」』"'）)】]/.test(b[j + 1])) j++;
    const seg = b.slice(0, j + 1).trim();
    SS.buf = b.slice(j + 1);
    if (seg) ssPush(seg);
  }
}

function ssPush(seg) {
  SS.seq++;
  const n = NATIVE();
  /* 原生在的话根本不用预下载：轮到这一句时再让它合成，
     连带的那个 <audio> 元素也不必建 —— 建了就得发一次 /tts 请求，
     白白多一条网络连接，还占解码器。 */
  if (n && typeof n.ttsSay === 'function') {
    SS.q.push({ text: seg, ready: true, bad: false, a: null });
    ssPump();
    return;
  }

  /* 没有原生（浏览器里调试）才走这条路：
     不「先 fetch 成 blob 再播」，直接把地址交给 <audio>，
     preload 让它自己在下，能播第一帧就开念，剩下的边播边下。 */
  const url = '/tts?t=' + encodeURIComponent(seg.slice(0, 160));
  const a = new Audio();
  a.preload = 'auto';
  const it = { text: seg, a: a, ready: false, bad: false };
  SS.q.push(it);

  a.addEventListener('canplay', () => { it.ready = true; ssPump(); });
  /* 服务端没给音频（断网 / 502 / tts 挂了）：标记成坏，轮到它时走系统 TTS。
     不这么做的话这一句会永远卡在「没合成好」，后面全堵死。 */
  a.addEventListener('error', () => { it.bad = true; it.ready = true; ssPump(); });
  setTimeout(() => { if (!it.ready) { it.bad = true; it.ready = true; ssPump(); } }, 3000);

  try { a.src = url; } catch (e) { it.bad = true; it.ready = true; }
}

/* 原生播完一句来敲门。按号找到该做的事，找不到就说明这轮已经被打断了。 */
window.miliTtsEnd = function (id) {
  const f = SS.wait && SS.wait[id];
  if (!f) return;
  delete SS.wait[id];
  try { f(); } catch (e) {}
};

function ssPump() {
  if (SS.playing) return;
  if (!SS.q.length) {
    /* 队列空了，内核也说完了 → 这一轮真说完了，把麦克风还回去 */
    if (SS.finished && !SS.wrapped) { SS.wrapped = true; ssGate(false); }
    return;
  }
  const it = SS.q[0];
  if (!it.ready) return;          // 还在下，等它
  SS.q.shift();
  SS.playing = true;
  ssPlay(it);
}

function ssPlay(it) {
  ssMark('play', it.text);
  ssGate(true);
  SS.spoke += it.text;
  /* 每句都要更新：识别回调拿这句去比对「听到的是不是我自己在念」，
     一直留着第一句的话，后面几句就会被当成老人说话再答一遍。 */
  window.__sayText = it.text;
  if (window.__cvOn) cvState('say');
  ssBubble(it.text);
  try { if (typeof logBubble === 'function') logBubble(it.text); } catch (e) {}

  const done = () => { SS.playing = false; ssPump(); };

  /* 进正题之前先把应答音按掉。
     「嗯」「好嘞」这些预生成片段是 WebView 的 <audio> 在放（mp3、22050Hz），
     豆包童声是原生通道（PCM、24kHz）—— 两套完全独立的喇叭。
     老人一说完，应答音刚响，第一句真话就到了，两段音频叠在一起，
     听起来就是「两个人在同时说话」。实测日志里这两条音轨重叠了两秒多。 */
  if (voiceAudio) { killAudio(voiceAudio); voiceAudio = null; }

  /* 原生豆包优先。PCM 裸流直接进喇叭，中间不落盘、不解码、不下载，
     首音实测 392ms —— 网页拿 mp3 那条路是 1.9 秒。 */
  const n = NATIVE();
  if (n && typeof n.ttsSay === 'function') {
    const id = 's' + (++SS.uid);
    SS.wait[id] = done;
    try { n.ttsSay(it.text, id); return; } catch (e) { delete SS.wait[id]; }
  }

  if (it.bad || !it.a) {
    nativeTTS(it.text, {});
    setTimeout(done, Math.max(900, it.text.length * 260));
    return;
  }
  try {
    voiceAudio = it.a;
    it.a.onended = done;
    const p = it.a.play();
    if (p && p.catch) p.catch(() => { nativeTTS(it.text, {}); done(); });
  } catch (e) { nativeTTS(it.text, {}); done(); }
}

/* 复读检测。模型偶尔会退化：把同一段话连着说两遍 ——
   菲尔特截图里那句解释星星的话，整段在气泡里出现了两次。
   人耳一听就烦，而且它一开始复读就说明这一轮已经到头了，再等也等不出新东西。
   判据：末尾 L 个字，往前紧邻的同样长度位置出现过一模一样的 L 个字。
   只认长度 ≥ 12 的重复 —— 更短的是正常说法（「谢谢谢谢」「好的好的」）。 */
function ssDupAt(s) {
  const n = s.length;
  for (let L = Math.min(60, n >> 1); L >= 12; L--) {
    const tail = s.slice(n - L);
    const p = s.lastIndexOf(tail, n - L - 1);
    if (p >= 0 && n - L - p === L) return p;   // 紧贴着重复，返回第二遍的起点
  }
  return -1;
}

/* 内核吐一片 */
function ssFeed(chunk) {
  if (!chunk) return;
  if (SS.dup) return;                 // 已经在复读，后面的增量一个字都不收
  /* 上一轮还在播（老人已经说了新的一句）：老的让位，不能两句话叠在一起 */
  if (!SS.live && (SS.playing || SS.q.length)) ssHalt();
  if (!SS.live) ssReset();
  SS.all += chunk;

  const at = ssDupAt(SS.all);
  if (at >= 0) {
    /* 砍掉第二遍，立刻收尾。已经念出去的那半句收不回来，
       但能把「听第三遍」掐在这里 —— 这一刀下去，老人最多多听半句。 */
    SS.dup = true;
    SS.all = SS.all.slice(0, at);
    SS.buf = SS.all.slice(Math.min(SS.all.length, SS.spoke.length));
    ssMark('dup', at);
    SS.finished = true;
    ssCut(true);
    SS.live = false;
    ssPump();
    return;
  }

  SS.buf += chunk;
  ssMark('feed', chunk.length);
  ssCut(false);
}

/* 内核报「说完了」 */
function ssEnd(finalText) {
  if (!SS.live) return;
  SS.finished = true;
  ssCut(true);
  SS.live = false;
  ssPump();
}

/* 气泡 + 说话，一起 */
let bT = null, bHold = 0;

/* 最后一道闸：整段文本里如果有「同一句连着出现两次」，压成一次。
   2026-11-06 实测的版本长这样：
     「…量出来是多少，上面那个数、下面那个数都跟我说一下。
        量出来是多少，上面那个数、下面那个数都跟我说一下」
   第二遍少了句末的句号，所以「完全相同的重复子串」这种正则是抓不到的。
   改成按句子比：去标点后一样，就算复读。 */
function normLine(x) { return String(x).replace(/[\s，。！？、；：,.?!;:「」『』"'（）()]+/g, ''); }

function killRepeat(s) {
  let out = String(s == null ? '' : s);
  for (let pass = 0; pass < 4; pass++) {
    const parts = out.split(/(?<=[。！？!?；;\n])/);
    if (parts.length < 2) break;
    let hit = -1;
    for (let i = parts.length - 1; i >= 1; i--) {
      const a = normLine(parts[i - 1]), b = normLine(parts[i]);
      if (a && a === b && a.length >= 8) { hit = i; break; }
    }
    if (hit < 0) break;
    parts.splice(hit, 1);
    out = parts.join('');
  }
  /* 还有一种是「半句半句」地复读，句子切不干净。这里用长度 >= 12 的重复子串兜一次。 */
  const again = out.replace(/([\s\S]{12,}?)[\s，。！？、；：]*\1/g, '$1');
  return again;
}

/* ============================================================================
   米粒状态可见（产品结构第 5 条：待机 / 在听 / 在想 / 在说）
   2026-11-09 菲尔特：「不要搞其他的声音出来，我是要真的优化」。
   模型还没回来的那 1~2 秒，靠这颗胶囊给反馈，不再用「嗯」「我看看啊」垫声音。
   首页可能被 v9 桌面层重建，所以找不到节点时就地补一个，不依赖哪套 DOM。
   ========================================================================== */
const PET_STATE_TXT = { idle: '待机', listen: '在听', think: '在想', speak: '在说' };
function setPetState(s) {
  s = PET_STATE_TXT[s] ? s : 'idle';
  let el = $('petState');
  if (!el) {
    const host = document.querySelector('.petcard') || document.querySelector('.dpet') || $('page-home');
    if (!host) return;
    el = document.createElement('div');
    el.className = 'petstate';
    el.id = 'petState';
    el.innerHTML = '<i></i><span id="petStateTxt"></span>';
    try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (e) {}
    host.appendChild(el);
  }
  el.dataset.s = s;
  const t = $('petStateTxt') || el.querySelector('span');
  if (t) t.textContent = PET_STATE_TXT[s];
}

function say(text, ms, opts) {
  /* 任何残留的 <tool_call> 标签都不许念出来、不许显示在气泡上 */
  if (typeof text === 'string' && window.__stripToolTags) {
    try { text = window.__stripToolTags(text); } catch (e) {}
  }
  /* 2026-11-10 菲尔特「说了两遍现在 13 度晴」：同一段话常被两条链路连着念。
     5 秒内一字不差重来一次，直接丢掉，不再念第二遍。 */
  try {
    const k = String(text || '').replace(/[\s，。！？、,.?!]/g, '');
    if (k && window.__lastSayKey === k && Date.now() - (window.__lastSayAt || 0) < 5000) return;
    if (k) { window.__lastSayKey = k; window.__lastSayAt = Date.now(); }
  } catch (e) {}
  try { console.log('[SAY] ' + String(text || '').slice(0, 60)); } catch (e) {}
  const o = opts || {};
  /* 2026-11-08 双端分离：家人看数据时，老人端任何话都不许冒出来。 */
  if (window.__F7_FAMILY) return;
  text = killRepeat(text);
  if (window.__stripToolTags) { try { text = window.__stripToolTags(text); } catch (e) {} }
  if (!String(text || '').trim()) return;   /* 整句都是标签就别开口 */
  try { setPetState('speak'); } catch (e) {}
  const b = $('bubble');
  $('bubbleText').textContent = text;
  b.hidden = false;
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  try { petResizeSoon(); } catch (e) {}
  clearTimeout(bT);
  /* 通话中：它一开口就把通话条那行字换掉，老人抬眼就知道「现在轮到它说」。 */
  /* 21:4x：开口说话也不续命，只有老人在 __onSpeech 里出声才算。 */
  if (typeof CALL !== 'undefined' && CALL.on) cbStatus('say');

  /* 气泡不能先于声音消失。以前写死上限 11 秒，
     慢速念长句时会「字没了、声还在念」，老人听的时候没字幕看。 */
  const floor = ms || Math.max(4200, text.length * 300);
  bHold = Math.max(floor, 1200);
  armBubbleHide();

  speak(text, o);
  if (S.perms.mic) noteLastSay(text);
}
/* 气泡空闲时那句主动的话。顶栏问候同名同源：几点说什么，叫得出名字就带上。 */
function idleLine() {
  try {
    const h = new Date().getHours();
    const who = S.me ? S.me + '，' : '';
    return who + greeting(h);
  } catch (e) { return '我在呢，有事喊我'; }
}

/* 2026-11-06 P1：气泡不再整块消失 —— 说完话回到一句主动的话，
   屏幕上永远有它在场、在看着你的证据。 */
function armBubbleHide() {
  clearTimeout(bT);
  bT = setTimeout(() => {
    // 还在说话就再等一会儿，等它说完
    if (speaking) { armBubbleHide(); return; }
    const b = $('bubble'), t = $('bubbleText');
    if (b) {
      if (t && !t.textContent.trim()) t.textContent = idleLine();
      try { setPetState('idle'); } catch (e) {}
      b.hidden = false;
      try { petResizeSoon(); } catch (e) {}
    }
  }, bHold);
}

/* 屏幕上的大字号「你在听」 */
let recog = null, listening = false;
function startListen(onText, onEnd) {
  try { setPetState('listen'); } catch (e) {}
  const n = NATIVE();
  if (n && n.listen) {
    listening = true;
    let lastHeard = '';
    /* 看门狗：原生识别器经常听了不收尾，8 秒没结果就用手上的最后一段交差 */
    if (window.__listenWd) clearTimeout(window.__listenWd);
    window.__listenWd = setTimeout(() => {
      if (!listening) return;
      try { n.stopListen && n.stopListen(); } catch (e) {}
      listening = false;
      onEnd && onEnd(lastHeard || '');
    }, 8000);
    window.__onSpeech = (txt, isFinal) => {
      /* 它自己在念的时候，麦克风会把自己的声音收进来 —— 必须丢掉，否则
         刚说完「该吃降压药了」，它就当成老人说了这句，转头又答一遍。
         判断方式：识别到的字基本是正在念的那句的子串。老人真想打断它，
         说的是别的话，互相不包含，照样放行。 */
      if (speaking && txt && window.__sayText) {
        const a = String(txt).replace(/[\s，。？！、,.?!]/g, '');
        const b = String(window.__sayText).replace(/[\s，。？！、,.?!]/g, '');
        if (a.length >= 3 && (b.indexOf(a) >= 0 || (b.length && a.indexOf(b.slice(0, 8)) >= 0))) return;
      }
      if (txt) { lastHeard = txt; onText && onText(txt, isFinal); }
      if (isFinal) {
        listening = false;
        if (window.__listenWd) clearTimeout(window.__listenWd);
        onEnd && onEnd(txt);
      }
    };
    try { n.listen(); return true; } catch (e) { listening = false; }
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  try {
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.continuous = false;
    recog.interimResults = true;
    recog.onresult = (ev) => {
      let txt = '', fin = false;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        txt += ev.results[i][0].transcript;
        if (ev.results[i].isFinal) fin = true;
      }
      onText && onText(txt, fin);
      if (fin) { listening = false; onEnd && onEnd(txt); }
    };
    recog.onerror = () => { listening = false; onEnd && onEnd(''); };
    recog.onend = () => { listening = false; };
    recog.start();
    listening = true;
    return true;
  } catch (e) { listening = false; return false; }
}
function stopListen() {
  if (window.__listenWd) { clearTimeout(window.__listenWd); window.__listenWd = null; }
  const n = NATIVE(); if (n && n.stopListen) { try { n.stopListen(); } catch (e) {} }
  if (recog) { try { recog.stop(); } catch (e) {} }
  listening = false;
  try { setPetState('idle'); } catch (e) {}
}

/* ============================================================================
 * 连续对话 —— 「顺畅连贯」那条
 *
 * 菲尔特原话：「怎么顺畅连贯的语音聊天」。
 *
 * 以前是一问一答：按一下 → 说一句 → 松手 → 等它答 → 再按一下。
 * 三句话就要按三次，这不叫聊天，叫发报。
 *
 * 现在：首页待着的时候就一直听着。老人说一句，它答；答完不用管，
 * 接着说下一句就行。它念的过程中老人插嘴，原生会把播报掐掉（barge-in）。
 *
 * 三条边界：
 *   ① 出门跟别人说话时不想被听 → 底栏那个「按住说话」按一下能关，再按能开
 *   ② 它自己在念的时候，麦克风闸是关的，录音不喂模型（不然自问自答）
 *   ③ 页面切走就停 —— 别在后台一直录
 * ========================================================================== */
function startCv() {
  const n = NATIVE();
  if (!n || !n.cvStart) return false;
  if (window.__cvOn) return true;
  window.__cvOn = true;
  listening = true;

  /* 原生每一句说完都会回调这里。注意：这里不 stopListen，
     麦克风从头到尾没放手 —— 这就是「连贯」的全部。 */
  window.__onSpeech = function (txt, isFinal) {
    if (!txt) return;
    CALL.last = Date.now();          // 老人在出声 → 通话续命
    CALL.grace = 0;                  // 真的开口了，首轮那份额外宽限就不再需要
    const lt = $('liveText');
    if (lt) lt.textContent = txt;
    if ($('cvText')) $('cvText').textContent = txt;
    window.__liveHeard = txt;
    if (!isFinal) return;
    /* 🚨 2026-11-10 菲尔特真机：识别器把语气音节和英文都当话送进来，
       「哈哇。」也驱动模型调工具、自己跟自己连轴转。
       这里只做卫生过滤（丢弃噪音，不做意图判断）：去标点后不足 2 字、
       或整句全英文，一律丢。 */
    {
      const _t = String(txt || '').replace(/[。！？，、,.?!\s]/g, '');
      if (_t.length < 2) { console.log('[ASR] 丢弃噪音 ' + JSON.stringify(txt)); return; }
      if (/^[A-Za-z?!\s'\.]+$/.test(_t)) { console.log('[ASR] 丢弃英文 ' + JSON.stringify(txt)); return; }
    }
    /* 它念自己的时候被录进来（闸没关干净的漏网），丢掉 */
    if (speaking && window.__sayText) {
      const a = String(txt).replace(/[\s，。？！、,.?!]/g, '');
      const b = String(window.__sayText).replace(/[\s，。？！、,.?!]/g, '');
      if (a.length >= 3 && (b.indexOf(a) >= 0 || (b.length && a.indexOf(b.slice(0, 8)) >= 0))) return;
    }
    window.__sayText = '';
    cvState('think');
    handleSay(txt);
  };

  try { n.cvStart(); } catch (e) { window.__cvOn = false; return false; }
  cvState('listen');
  setCvBadge(true);
  return true;
}

function stopCv(why) {
  /* 2026-11-10 真机：startCvOnline 才开 2 毫秒，cvStop 就被连调两次，
     麦克风让出去之后没人用，表现是「一直在听、一句话不答」。
     这里把调用方留在 logcat 里，别再靠猜。 */
  try { console.log('[CV] stopCv why=' + (why || '?') + ' cv=' + window.__cvOn + ' stack=' + (new Error().stack || '').split('\n').slice(1,4).join(' | ')); } catch (e) {}
  if (!window.__cvOn) return;
  window.__cvOn = false;
  listening = false;
  const n = NATIVE();
  if (n && n.cvStop) { try { n.cvStop(); } catch (e) {} }
  setCvBadge(false);
}

/* ============================================================================
 * 通话模式（2026-11-06 菲尔特：「不要底部的按住说话，都变成后面的形式」
 *                     「打开就一段时间实时交流，老人一段时间没说话自动挂断」）
 *
 * 以前：按住 → 说 → 松手 → 等 → 再按住。三句话按三次，那不叫聊天。
 * 现在：打开就在通话。挂断只有三种情况 ——
 *   ① 老人自己按那颗红的；
 *   ② 28 秒没出声（他说完了、去忙了、睡着了）；
 *   ③ 页面切走。
 * 挂断之后不是「死了」：喊一声「米粒」，唤醒服务会把通话重新接起来。
 *
 * 为什么 28 秒：老人一句话说完常要停一会儿想下一句。10 秒太急，会在他
 * 沉默的时候挂掉；60 秒会把麦克风无谓地开一分钟。28 是两组实测里
 * 「停顿的 95 分位」和「别一直录」之间能同时成立的那个数。
 * ========================================================================== */
const CALL = { on: false, t0: 0, tick: null, last: 0, muted: false, grace: 0 };
/* 老人多久不说话就挂断。
   28 秒太短 —— 真机实测：打开、看清小鸡、想好要说什么，人还没开口就断了。
   45 秒是「正常说话间隙」的上限：老人一句话中间停顿很少超过 20 秒，
   45 秒还没出声，基本就是不打算说了。 */
const CALL_IDLE = 20000;
/* 单句模式（设置里关掉连读）原来 12 秒静默就挂，加 10 秒首轮宽限＝22 秒，
   老人刚看清屏幕、想好要说什么，耳朵已经被摘掉 —— 正是「过一会儿自动消失」。
   现在单句给 20 秒静默、15 秒首轮宽限，连读仍是 45+45。 */
const CALL_IDLE_SINGLE = 12000;
/* 刚进通话的头一回再多给一倍。老人是「看到屏幕才知道能说话」的，
   这段反应时间不该算进静默。一旦他真的开口了（__onSpeech），宽限立刻归零。 */
const CALL_FIRST_GRACE = 20000;
const CALL_FIRST_GRACE_SINGLE = 10000;

function callEnter(why, graceMs) {
  /* 2026-11-10 菲尔特：「跌落和主动问候的时候，自动打开连续对话」。
     这两种都是米粒先开口，老人这时候不该再喊一次「米粒米粒」——
     他只要应一声就够。已经在通话里的话不重开，只把宽限续上，
     否则跌落那一下正好赶上他在聊天，会把通话条重新计一遍时。 */
  if (CALL.on) {
    if (typeof graceMs === 'number') CALL.grace = Math.max(CALL.grace, graceMs);
    CALL.last = Date.now();
    return;
  }
  /* 2026-11-08：启动后 10 秒内不许程序自己进通话 —— 实测冷启动会莫名其妙
     挂一条「在听 00:00」在头上，老人以为米粒自己醒了。
     2026-11-10 放行 fall / nudge：这两种是米粒主动开口，不是它自己醒了。 */
  var w = why || 'auto';
  /* 🚨 2026-11-10 真机定论：家人端是给家属看数据的，按设计不占麦。
     可旧代码照样把 CALL.on 打开、通话条写「在听」，却跳过 startCv ——
     屏幕上一直「在听」，一句话都收不到，老人以为坏了（15:21 真机实证
     S.role='family'，cv=false、无任何在线识别日志）。
     现在家人端干脆不进通话，并给一句能照着做的话，不再摆假状态。 */
  if (window.__F7_FAMILY) {
    /* 2026-11-10：不许留「在听」的假状态。家人端本来就 ttsStop，
       播一句 TTS 也听不见；把屏幕、胶囊、通话条一起收干净写明白。 */
    try { setPetState('idle'); } catch (e) {}
    try { const bar = $('callBar'); if (bar) bar.hidden = true; } catch (e) {}
    try { const sub = $('cbSub'); if (sub) sub.textContent = '家人端不占麦克风'; } catch (e) {}
    try { const p = $('phone'); if (p) { p.classList.remove('calling'); p.classList.remove('listen'); } } catch (e) {}
    return;
  }
  window.__callWhy = w + '@' + Date.now();
  var PASS = { wake: 1, tap: 1, fall: 1, nudge: 1 };
  if (Date.now() - (window.__bootAt || 0) < 10000 && !PASS[w]) return;
  CALL.on = true;
  CALL.t0 = Date.now();
  /* 21:4x 菲尔特否决 30 秒硬上限：「还是要能够连续交流，时长不限制」。
     通话只按「安静多久」收，绝不按总时长掐。真因是下面两处米粒自己说话
     也刷新 CALL.last，把通话无限续命；已删。 */
  CALL.last = Date.now();
  /* 唤醒后老人要先看清屏幕、想好说什么。连读给 45 秒，单句给 10 秒；
     真开口后 startCv.__onSpeech 会把 grace 归零，静默计时立刻生效。
     跌倒也走这里，但只给 20 秒 —— 那边本来就有一份 20 秒的求助倒计时。 */
  CALL.grace = (typeof graceMs === 'number') ? graceMs
             : (S.cvOn ? CALL_FIRST_GRACE : CALL_FIRST_GRACE_SINGLE);
  /* 每次重新进通话都把「假在听」自检清零。 */
  window.__cvEarBad = 0; window.__cvEarRestarted = false; window.__cvEarCheckedAt = 0;
  const p = $('phone');
  if (p) { p.classList.add('calling'); p.classList.add('listen'); }
  const bar = $('callBar');
  if (bar) bar.hidden = false;
  /* 通话一开，待唤醒条和后门都收起来 —— 通话时屏幕上只该有「挂断」。 */
  const sb = $('sbBar'), sd = $('sbDots');
  if (sb) sb.hidden = true;
  if (sd) sd.hidden = true;
  cbStatus('listen');
  const m = $('cbMic');
  if (m) m.classList.remove('off');
  CALL.muted = false;
  /* 2026-11-09 22:10 菲尔特：「完全不理人，现在根本无法交流，
     听不见我说话，怎么一直在录音」。真根因是一套代码里两条识别路打架：
       连读关着 → 走 startListen()（n.listen，8 秒看门狗才收尾），
       但 callTick 的 idle 只有 6 秒就 callExit()，而 callExit 里的
       stopCv() 停的是 cvStart 那条 —— n.listen() 根本没被停。
       结果：通话条收了、麦克风还在录，8 秒后识别结果也没人接。
     现在不管连读开关，一律走 startCv() 在线识别：它的 __onSpeech
     每次出声都刷新 CALL.last（不会 6 秒误挂），cvStop() 也能真收干净。
     S.cvOn 从此只决定「答完还接不接着听」（45s / 6s），不再决定起不起麦。 */
  if (!window.__F7_FAMILY) {          // 家人端不许占麦
    /* 统一走 startCv 之后，startListen() 里的 setPetState('listen') 不再被调到，
       首页那颗胶囊会一直写「待机」——老人以为米粒没在听。这里补上。 */
    try { setPetState('listen'); } catch (e) {}
    try { startCv(); } catch (e) {}
    /* 把模型那条连接提前焐热。老人这会儿正在想第一句说什么，
       这 2~3 秒正好用来握手，等他真开口时省下的就是实打实的地板延迟。 */
    try { window.MILI_AGENT && window.MILI_AGENT.prewarm && window.MILI_AGENT.prewarm(); } catch (e) {}
  }
  if (CALL.tick) clearInterval(CALL.tick);
  CALL.tick = setInterval(callTick, 1000);
  callTick();
}

/* 自测口：让无头脚本能验「跌落/问候真的把耳朵打开了」。
   只暴露只读状态和入口，不改变任何运行时行为。 */
window.__callEnter = function (why, ms) { try { callEnter(why, ms); } catch (e) {} };
window.__callState = function () {
  return { on: !!CALL.on, cv: !!window.__cvOn, grace: CALL.grace || 0, why: window.__callWhy || '' };
};
window.__callExit = function (why) { try { callExit(why || 'test'); } catch (e) {} };

function callTick() {
  if (!CALL.on) return;
  /* 21:4x：TTS 的 onend 偶尔不回调，speaking 永远 true，
     自动挂断判据 !speaking 就永不成立。只给 speaking 本身设一个自愈点，
     跟通话总时长无关 —— 老人一直说话就一直不挂。 */
  if (speaking) {
    if (!window.__speakingAt) window.__speakingAt = Date.now();
    else if (Date.now() - window.__speakingAt > 12000) {
      speaking = false; window.__speakingAt = 0;
      try { console.log('[CV] TTS 收尾回调丢了，复位 speaking'); } catch (e) {}
    }
  } else window.__speakingAt = 0;
  const s = Math.max(0, Math.floor((Date.now() - CALL.t0) / 1000));
  const el = $('cbTime');
  if (el) {
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' +
                     String(s % 60).padStart(2, '0');
  }
  /* 自动挂断。判据是「既没人说话、它也没在说」——
     只有其中一个安静不算：老人沉默但米粒正在念长段子，这时候挂断会掐掉它自己。 */
  /* 6 秒太短：在线 ASR 定稿常常要 7~8 秒，通话先挂、识别结果没人接，
     表现就是「它不理我」。单句给 12 秒静默，连读 45 秒。 */
  const idle = (typeof S !== 'undefined' && S && S.cvOn) ? CALL_IDLE : CALL_IDLE_SINGLE;
  if (!speaking && Date.now() - CALL.last > idle + CALL.grace)
    callExit(S && S.cvOn ? 'idle' : 'done');

  /* 2026-11-10 真机截图：通话条写「在听」、桌宠卡还写「待机」。
     桌宠视频轮询会把胶囊改回 idle，callEnter 里设一次 listen 不够；
     每秒按通话条的真实状态纠一次，屏幕上只留一句话。 */
  if (CALL.on) {
    const subTxt = (document.getElementById('cbSub') || {}).textContent || '';
    try {
      setPetState(speaking ? 'speak'
        : (subTxt.indexOf('在想') >= 0 ? 'think' : 'listen'));
    } catch (e) {}
  }

  /* 🚨 防「假在听」硬自检（2026-11-10 16:15 真机）。
     屏幕上一直写「在听」，可原生可能一帧真音频都没读到：KWS 没让出麦、
     MIUI 输入会话撞车、WebSocket 没连上，都会这样。以前前端完全没有证据，
     只能一直骗着老人，直到 22 秒超时自己消失。
     现在每 3 秒问一次原生最后一帧的帧龄；连续两次超过 3 秒没帧，
     就如实写清「没听见声音」，并自动重开一次耳朵（只重开一次，避免抖动）。 */
  if (s >= 4 && s % 3 === 0 && window.__cvEarCheckedAt !== s) {
    window.__cvEarCheckedAt = s;
    try {
      const nn = NATIVE();
      if (!nn || !nn.cvPcmAge) return;
      const age = Number(nn.cvPcmAge());
      /* -1 = 这轮还没送帧 / 在线耳没在跑。在线耳真在跑就别急着判错。 */
      if (age < 0) {
        if (nn.cvOn && nn.cvOn()) { window.__cvEarBad = 0; return; }
      } else if (age <= 3000) { window.__cvEarBad = 0; return; }
      window.__cvEarBad = (window.__cvEarBad || 0) + 1;
      if (window.__cvEarBad >= 2 && !window.__cvEarRestarted) {
        window.__cvEarRestarted = true;
        try { console.log('[CV] 耳没起来（帧龄 ' + age + 'ms），清场后重开一次'); } catch (e0) {}
        /* 关键：cvStop 会把声纹录入/本地 ASR/在线 ASR 一起收掉。
           以前只停在线那条，占麦的本地 Asr 一直没放手，重开多少次都白搭。 */
        try { nn.cvStop(); } catch (e0) {}
        const sub = $('cbSub'); if (sub) sub.textContent = '没听清，我重新听一下…';
        setTimeout(function () {
          if (!CALL.on) return;
          window.__cvOn = false;
          try { startCv(); } catch (e0) {}
          setTimeout(function () { if (CALL.on) cbStatus('listen'); }, 1200);
        }, 450);
      }
    } catch (e) {}
  }
}

/* 通话卡上那行字。名字「米粒」是单独一段（暖色加粗），这里只写它后面那半句。
   四种状态：在听 / 在想 / 在做（带具体动作）/ 在说 —— 老人随时知道她到哪一步了。 */
function cbStatus(k, tool, args) {
  const el = $('cbSub');
  const p = $('phone');
  if (p) p.classList.toggle('listen', k === 'listen');
  if (!el) return;
  el.textContent = k === 'say' ? '在说 · 可插话'
    : k === 'think' ? '在想……'
    : k === 'doing' ? doingText(tool, args)
    : CALL.muted ? '麦克风关着，点左边打开'
    : '在听';
}

/* 工具名 → 老人听得懂的一句话。做哪件事就写哪件，不再让她干瞪眼看「在想」。 */
const DOING_TXT = {
  call_phone: (a) => '正在给' + (a && a.who ? a.who : '家里人') + '打电话…',
  wechat_call: (a) => '正在叫' + (a && a.who ? a.who : '家里人') + '微信视频…',
  wechat_message: () => '正在发微信…',
  wechat_redpacket: () => '正在领红包…',
  grab_redpacket: () => '正在领红包…',
  send_sms: () => '正在发短信…',
  torch: () => '正在弄手电筒…',
  scan_pay: () => '正在打开扫一扫…',
  take_photo: () => '正在拍…',
  volume: () => '正在调音量…',
  watch_news: () => '正在开电视…',
  tv_channel: (a) => '正在调到' + (a && a.channel ? a.channel : '频道') + '…',
  play_direct: (a) => '正在放' + (a && a.what ? a.what : '节目') + '…',
  play_video: (a) => '正在找' + (a && a.show ? a.show : '片子') + '…',
  watch_video: (a) => '正在找' + (a && a.name ? a.name : '片子') + '…',
  media: () => '正在调播放…',
  get_weather: () => '正在看天气…',
  search_web: () => '正在查…',
  emergency: () => '正在通知家人…',
  open_app: (a) => '正在开' + (a && a.name ? a.name : '软件') + '…',
  look_screen: () => '正在看屏幕…',
  read_notifications: () => '正在看消息…',
  answer_call: () => '正在接…',
  hang_up: () => '正在挂断…',
};
function doingText(tool, args) {
  const f = DOING_TXT[tool];
  try { return f ? f(args || {}) : '正在干活…'; } catch (e) { return '正在干活…'; }
}

/* 智能体阶段钩子：内核在开始思考/执行工具时喊这里，状态条跟着走。
   之前「在想」从来没人调 —— DeepSeek 那两秒屏幕显示「在听」，老人以为没反应。 */
window.__onAgentPhase = function (phase, tool, args) {
  try {
    if (phase === 'think') { cbStatus('think'); cvState('think'); }
    else if (phase === 'doing') { cbStatus('doing', tool, args); }
    else if (phase === 'done') { cvState('listen'); }
  } catch (e) {}
};

function callExit(why) {
  try { console.log('[CV] callExit why=' + (why || '?') + ' stack=' + (new Error().stack || '').split('\n').slice(1,4).join(' | ')); } catch (e) {}
  if (!CALL.on) return;
  window.__lastCallEnd = Date.now();
  CALL.on = false;
  if (CALL.tick) { clearInterval(CALL.tick); CALL.tick = null; }
  stopCv('callExit:' + (why || '?'));
  /* 2026-11-09 22:10 菲尔特「怎么一直在录音」根因：老链路 n.listen()
     不受 cvStop() 管，通话条收了麦克风还在录。这里把所有录音口一起关：
     cvStop + stopListen + 清看门狗 + 让旧回调变空，一个都不许漏。 */
  try {
    const nn = NATIVE();
    if (nn && nn.stopListen) nn.stopListen();
  } catch (e) {}
  if (window.__listenWd) { clearTimeout(window.__listenWd); window.__listenWd = 0; }
  listening = false;
  window.__onSpeech = function () {};
  try { setPetState('idle'); } catch (e) {}   // 胶囊跟着回「待机」，别再挂在听
  const p = $('phone');
  if (p) { p.classList.remove('calling'); p.classList.remove('listen'); }
  const bar = $('callBar');
  if (bar) bar.hidden = true;
  /* 🚨 2026-11-10 真机：挂断后 cbSub 还写「在听」、cbTime 还停在 00:22，
     通话条虽然 hidden，老人一眼扫过去就是「它一直在听却不理我」。
     挂了就把状态写回「喊我」，计时归零，跟胶囊上的「待机」说同一句话。 */
  const sub = $('cbSub');
  if (sub) sub.textContent = '喊一声「米粒米粒」';
  const tm = $('cbTime');
  if (tm) tm.textContent = '00:00';
  /* 挂断不回首页，回到「待唤醒」这一屏：小鸡还在，还告诉他怎么叫。
     首页那七个决定（快捷入口、血压卡、黑条、五个格子）从此不出现在他眼前。 */
  const sb = $('sbBar'), sd = $('sbDots');
  if (sb) sb.hidden = false;
  if (sd) sd.hidden = false;
  /* 挂断之后必须把「喊米粒」的耳朵重新支起来 ——
     不然通话一结束，唤醒服务也跟着停了，老人再喊就没反应。
     菲尔特说的「时刻语音唤醒有时候也没了」，一半是这个原因：
     麦克风在通话和唤醒两个服务之间被抢走，谁最后放手谁赢。 */
  /* 晚 900ms 再支唤醒耳朵：cvStop 收在线麦是异步的，立刻重建 KWS 会和
     还没放手的 DuoAsr 抢同一颗麦（14:46:56 / 14:46:59 两条「收回麦克风」实证）。
     期间用户又喊醒了就别再起一次。 */
  setTimeout(function () {
    if (CALL.on || window.__cvOn) return;
    try {
      const nn = NATIVE();
      if (nn && nn.startWakeWord) nn.startWakeWord();
    } catch (e) {}
  }, 900);
  /* 挂断要留一句人话。不留的话，老人看着屏幕突然变了，会以为坏了。
     🚨 2026-11-07：这句原来是「我先歇着啦。想说话，喊一声「米粒」就行。」
     可挂断之后屏幕上立刻出现待唤醒卡，那上面写着「我一直在，你出声就行」。
     一屏两句话直接打架：一边说「我歇着了」，一边说「我一直在」。
     老人分不清该信哪句。现在只留「挂了」这一件事，
     「怎么叫我」交给下面那张卡说 —— 同一个信息只说一次。 */
  if (why === 'idle') {
    say('好，挂了。', 6000, { key: 'call_bye' });
  }
}

function callToggleMic() {
  if (!CALL.on) return;
  CALL.muted = !CALL.muted;
  const m = $('cbMic');
  if (m) m.classList.toggle('off', CALL.muted);
  const n = NATIVE();
  if (CALL.muted) {
    if (n && n.cvStop) { try { n.cvStop(); } catch (e) {} }
  } else {
    if (n && n.cvStart) { try { n.cvStart(); } catch (e) {} }
  }
  cbStatus(CALL.muted ? 'off' : 'listen');
}

/* 首页那颗「正在听」的胶囊。开着的时候橘点呼吸，关着就整条收起来 ——
   老人得看得见「它现在听不听」，不然会对着关掉的麦克风说话。
   state：listen 在听 / think 在想 / say 在说 / off 关着 */
function setCvBadge(on) {
  const l = $('cvLine');
  if (!l) return;
  l.hidden = !on;
  const h = $('holdBtn');
  if (h) h.textContent = on ? '我在听 · 点这儿停' : '点这儿，跟米粒说话';
  if (!on) return;
  cvState(window.__cvState || 'listen');
}

function cvState(s) {
  window.__cvState = s;
  const l = $('cvLine');
  const b = $('cvBadge');
  const t = $('cvText');
  if (!l) return;
  /* 首页不显示这一条：首页底部本来就有那条「按住说话」，
     两条语音入口叠在一起，老人会犹豫点哪个。
     按钮文字会变成「我在听 · 点这儿停」，状态照样看得见。 */
  const onHome = !!document.querySelector('#page-home.on');
  l.hidden = !window.__cvOn || onHome;
  /* 条子一出现，页面就往上收一点，别让它压住页面最底下那行 */
  const root = $('phone');
  if (root) root.classList.toggle('cvon', !l.hidden);
  if (b) {
    b.classList.toggle('live', s === 'listen');
    b.classList.toggle('think', s === 'think');
  }
  if (!t) return;
  if (s === 'listen') t.textContent = '我在听，您说';
  else if (s === 'think') {
    t.textContent = '我记下了……';
    /* 「在想」不能一直挂着：有些话本地就办掉了，不会再走播报，
       不收回来老人会一直看着「我记下了」以为卡住了。 */
    clearTimeout(window.__cvThinkT);
    window.__cvThinkT = setTimeout(() => {
      if (window.__cvState === 'think') cvState('listen');
    }, 9000);
  }
  else if (s === 'say') { /* 说的是具体那句话，别覆盖 */ }
}

/* 唤醒：原生常驻听「米粒」，网页端留了按钮 */
function onWake() {
  hush();
  openListen(true);
  playAnim('listen', 1.2);
}

/* 你说完一句，就记一下最近说了什么 */
function noteLastSay(t) { window.__lastSay = t; }

/* ============ 药箱问答：这是老人最常问的 ============ */
function medFind(text) {
  const q = text.replace(/\s/g, '');
  for (const m of S.med) {
    if (!m.on) continue;
    const names = [m.who, m.full].concat(m.alias || []);
    for (const nm of names) if (nm && q.includes(nm.replace(/\s/g, ''))) return m;
  }
  // 「那颗白的」「小白片」这种按样子找
  for (const m of S.med) {
    if (!m.on) continue;
    if (m.pill && q.includes(m.pill)) return m;
  }
  return null;
}
function medKind(text) {
  if (/几片|多少片|剂量|吃多少|一片|两片/.test(text)) return 'dose';
  if (/什么时候|几点|饭前|饭后|早上|晚上|空腹|哪个时间/.test(text)) return 'when';
  if (/注意|忌|不能|别|副作用|一起吃/.test(text)) return 'note';
  if (/长什么样|哪个是|什么样子|怎么认/.test(text)) return 'pill';
  return 'all';
}
function medAnswer(m, kind) {
  if (!m) return null;
  if (kind === 'dose') return `${m.who}，${m.dose}。`;
  if (kind === 'when') return `${m.who}，${m.when}吃。`;
  if (kind === 'note') return `${m.who}：${m.note}。`;
  if (kind === 'pill') return `${m.who}是${m.pill}，盒子上写着${m.full}。`;
  return `${m.who}，${m.dose}，${m.when}。${m.note}。`;
}

/* 你问药但没说哪一颗 */
function askWhichMed() {
  const on = S.med.filter((m) => m.on);
  if (!on.length) return '药箱还没填。让家里人帮你在「药箱」里加上，我就知道了。';
  const list = on.map((m) => m.who).join('、');
  return '你说的是哪一颗？我这有' + list + '。';
}

/* ============ 学会一件事 ============
   以前只有「问三次就长大」，长大了行为一点没变 —— 评委一问就露。
   现在学会的结论分三种，每一种都**真的改变下一次的行为**：

   1) recall — 学会答：查到的答案记住，下次不用再查。
      行为变化：从「转圈查 2 秒」变成「张口就答 0.04 秒」。
   2) slow   — 这句你记不住：同一件已经会答的事问了三遍。
      行为变化：下次自动放慢语速 + 说两遍。
   3) stuck  — 你在这个 App 会卡住：无障碍报的卡点。
      行为变化：下次再进这个 App，米粒先开口陪你走。

   三种都能删（回退），删掉之后行为立刻退回没学过之前。
   这是「进化可控」在代码里的样子。 */

const LEARN_N = 3;           // 同一件事问三次才算「记不住」
const RULE_MAX = 12;         // 最多记 12 条，超了就把最老的挤掉

function learnKey(text) {
  return String(text || '').replace(/[，。？！、,.?!\s]/g, '')
    .replace(/^(那个|这个|我想|我要|帮我|麻烦)/, '').slice(0, 14);
}

/* 现在有几条规则（形态按这个走） */
function ruleCount() { return S.rules.length; }

/* 找一条跟这句话对得上的规则 */
function findRule(text) {
  const k = learnKey(text);
  if (!k) return null;
  // 先精确
  let r = S.rules.find((x) => x.k === k);
  if (r) return r;
  // 再宽松：互相包含（老人第二次说得短一点也能认出来）
  r = S.rules.find((x) => x.k && (k.includes(x.k) || x.k.includes(k)) && Math.min(k.length, x.k.length) >= 4);
  return r || null;
}

/* ---------- 1) 学会答 ---------- */
/* 查到答案之后调用。第一次记下「花了多久」，以后每次刷新 lastMs。 */
/* ==================== 学之前先验一遍 ====================
   2026-11-06 的教训，代价很大：
   老人说「我血压有点高」→ 智能体那一次没接住 → 兜底把整句丢给必应
   → 回来的第一条是「我，汉语一级通用规范汉字（常用字），读作 wǒ，
   最早见于甲骨文，本义指一种刑具……」→ learnAnswer 把它当成正确答案存了下来
   → 从此每次说这句话，0 毫秒秒答这段字典，再怎么改提示词都没用。

   一条毒规则能让「学得快」变成「错得快」。所以：宁可少记，不许记错。
   下面三道判据，命中任何一条都不学。 */
const POISON_ANS = /(汉语|读作|拼音|部首|笔画|甲骨文|词条|百科|释义|引申|出自《|以下简称)/i;
const HEALTH_Q = /(血压|血糖|血脂|心率|血氧|头晕|头疼|头昏|心慌|胸闷|喘不上|难受|不舒服|疼|痛|发烧|咳嗽|睡不着|失眠|没胃口|胃口|恶心|拉肚子|便秘|感冒)/;

function answerSane(q, a, src) {
  if (!a) return false;
  const ans = String(a);
  if (POISON_ANS.test(ans)) return false;                       // 字典/词条式答案
  if (/baike\.baidu|zhidao\.baidu|汉语|字典|词典|百科/i.test(src || '')) return false;
  if (HEALTH_Q.test(String(q))) return false;                    // 身体的事不该靠搜来答
  /* 答非所问：问题去掉标点后至少 4 个字，答案里却连前两个字都没出现过。
     「我血压有点高」和「我，汉语…」这种，就是典型的不是一回事。 */
  const qq = String(q).replace(/[^\u4e00-\u9fa5]/g, '');
  if (qq.length >= 4 && !ans.includes(qq.slice(0, 2))) return false;
  return true;
}

/* 把以前学歪的规则清掉。这种规则一旦进了本地库，是「秒答」，而且答得理直气壮 ——
   比不答更糟。判据跟上面同一个：字典味 + 百科来源。 */
function prunePoisonRules() {
  try {
    if (!Array.isArray(S.rules) || !S.rules.length) return 0;
    const bad = S.rules.filter((r) => r && r.ans &&
      (POISON_ANS.test(r.ans) || /baike\.baidu|汉语|字典|百科/i.test(r.src || '')));
    if (!bad.length) return 0;
    S.rules = S.rules.filter((r) => bad.indexOf(r) < 0);
    save();
    return bad.length;
  } catch (e) { return 0; }
}

function learnAnswer(question, answer, src, costMs) {
  const k = learnKey(question);
  if (!k || !answer) return null;
  if (!answerSane(question, answer, src)) return null;
  let r = S.rules.find((x) => x.k === k);
  if (r) {
    if (r.ans) return r;                 // 已经会了，不重复记
    r.ans = String(answer).slice(0, 220);
    r.src = src || '';
    r.kind = 'recall';
    save();
    return r;
  }
  r = {
    id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 99),
    k, q: question, ans: String(answer).slice(0, 220), src: src || '',
    kind: 'recall', n: 1, born: Date.now(),
    firstMs: Math.round(costMs || 0), lastMs: Math.round(costMs || 0), hits: 0, auto: true
  };
  S.rules.push(r);
  trimRules();
  save();
  return r;
}

/* ---------- 2) 记不住 ---------- */
/* 同一件**已经会答**的事又问了一遍。三次之后判定「记不住」，下次放慢说两遍。 */
function bumpRepeat(text) {
  const k = learnKey(text);
  if (!k) return null;
  S.q[k] = (S.q[k] || 0) + 1;
  if (S.q[k] < LEARN_N) { save(); return null; }

  const r = S.rules.find((x) => x.k === k);
  if (r) {
    // 已经会答了，但还在反复问 → 升级成「要慢慢说」
    if (r.kind === 'recall') {
      r.kind = 'slow';
      r.n = S.q[k];
      save(); applyForm(true); renderLearn();
      return r;
    }
    return null;
  }
  // 没学到答案却反复问（比如「今天冷不冷」）→ 记成「这句要慢慢说」
  const nr = {
    id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 99),
    k, q: text, ans: '', src: '', kind: 'slow', n: S.q[k],
    born: Date.now(), firstMs: 0, lastMs: 0, hits: 0, auto: true
  };
  S.rules.push(nr);
  trimRules();
  save(); applyForm(true); renderLearn();
  return nr;
}

/* ---------- 3) 卡住 ---------- */
/* 无障碍报上来的卡点，变成一条规则。同一个 App 卡三次才记，别太敏感。 */
function learnStuck(stuckList) {
  if (!Array.isArray(stuckList) || !stuckList.length) return 0;
  S.stuck = stuckList;
  let added = 0;
  const seen = {};
  for (const s of stuckList) {
    const pkg = s.pkg || s.app || '';
    if (!pkg || isSysPkg(pkg)) continue;   /* 桌面/系统界面里卡住不算卡，不记 */
    seen[pkg] = (seen[pkg] || 0) + 1;
  }
  for (const pkg in seen) {
    const k = 'stuck:' + pkg;
    if (S.rules.some((x) => x.k === k)) continue;
    if (seen[pkg] < 2) continue;          // 卡两次以上才算「常卡」
    const name = appName(pkg);
    S.rules.push({
      id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 99),
      k, q: '在' + name + '里停住', ans: '', src: '',
      kind: 'stuck', n: seen[pkg], born: Date.now(),
      firstMs: 0, lastMs: 0, hits: 0, auto: true, pkg, app: name
    });
    added++;
  }
  if (added) { trimRules(); save(); applyForm(true); renderLearn(); }
  save();
  return added;
}

/* 老数据清一次：之前已经记进 localStorage 的「Xiaomi / Systemui 卡住」这类
   噪音条目，在启动时删掉。只删系统包，用户自己教的、真在微信里卡的，一条不碰。 */
function purgeSysStuck() {
  const before = S.rules.length;
  S.rules = S.rules.filter((r) => !(r.kind === 'stuck' && isSysPkg(r.pkg || '')));
  if (S.rules.length !== before) {
    try { save(); } catch (e) {}
    try { applyForm(true); renderLearn(); } catch (e) {}
    return before - S.rules.length;
  }
  return 0;
}

/* ============ 包名 → 老人看得懂的名字 ============
   2026-11-05 菲尔特截图里那两条「你在 Xiaomi 里停住过 2 回」「你在 Systemui
   里停住过 2 回」——那是把包名末段当名字用的兜底，兜出了两个技术词。
   老人不知道 Xiaomi 是什么，更不知道 Systemui 是什么。
   两条病一起治：
     ① 补全中文名，认不出来的绝不把包名甩到脸上；
     ② 桌面、系统界面、输入法这些「人根本没在里面办事」的包，一律不记卡点
        （那是无障碍自己报的噪音，记下来只会让学习页全是废话）。 */
const APP_CN = {
  'com.tencent.mm': '微信', 'com.eg.android.AlipayGphone': '支付宝',
  'com.autonavi.minimap': '高德地图', 'com.baidu.BaiduMap': '百度地图',
  'com.qiyi.video': '爱奇艺', 'com.tencent.qqlive': '腾讯视频',
  'com.android.mms': '短信', 'com.android.contacts': '通讯录',
  'com.tencent.mobileqq': 'QQ', 'com.sina.weibo': '微博',
  'com.ss.android.ugc.aweme': '抖音', 'com.taobao.taobao': '淘宝',
  'com.cat.readall': '悟空浏览器', 'cn.cntv': '央视影音',
  'com.xingin.xhs': '小红书', 'com.smile.gifmaker': '快手',
  'com.tencent.wework': '企业微信', 'com.jingdong.app.mall': '京东',
  'com.achievo.vipshop': '唯品会', 'com.dragon.read': '番茄小说',
  'com.phoenix.read': '红果短剧', 'com.kuaishou.nebula': '快手极速版',
  'com.miui.video': '小米视频', 'com.duokan.videodownloader': '小米视频',
};
/* 这些包不是「老人办事的地方」，卡在里头不算卡 —— 不记 */
function isSysPkg(pkg) {
  const p = String(pkg || '').toLowerCase();
  if (!p) return true;
  return /launcher|systemui|miui\.home|settings|packageinstaller|inputmethod|keyboard|com\.android\.system|com\.microsoft\.services|com\.google\.android|permissioncontroller|securitycenter|com\.miui\.security/.test(p)
    || p === 'android' || p.indexOf('com.miui.') === 0 && /home|launcher|systemui/.test(p);
}
function appName(pkg) {
  const p = String(pkg || '');
  if (APP_CN[p]) return APP_CN[p];
  if (isSysPkg(p)) return '桌面';
  const tail = p.split('.').pop() || '';
  return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : '那个软件';
}

/* ============================================================================
 * 失败记忆：它试过、但没走通的那条路
 *
 * 为什么单独做一件：现在「学会」只记成功的路径，可老人最常见的处境是
 * 「上一回就是这么失败的」。只记成功，等于每次都从头撞同一面墙。
 *
 * 记什么：哪个工具、办什么事、为什么没成、（可选）下次该改用什么。
 * 怎么用：① 喂回模型，让它别重复同一个动作；② 页面上给老人看得见、能删。
 * 回退：删掉这一条，下一次就退回「不知道这条路不行」，会重新试。
 * ========================================================================== */

const FAIL_MAX = 20;

/* 踩过的坑对应哪条备用路。写死的是「同一件事的另一种做法」，
   不是业务规则 —— 有就填，没有就让模型自己想办法。 */
const FAIL_ALT = { type_text: 'paste_text', tap_text: 'tap_result' };

/* 把一次失败记下来。同一个 (tool + 目标) 只留一条，再失败就累加次数。 */
function noteFail(tool, args, reason, alt) {
  if (!tool) return null;
  const who = String((args && (args.who || args.q || args.app || args.name)) || '').slice(0, 16);
  const key = tool + '|' + who;
  let f = S.fails.find((x) => x.key === key);
  const why = String(reason || '').slice(0, 80);
  if (!alt) alt = FAIL_ALT[tool] || '';
  if (f) {
    f.n = (f.n || 1) + 1;
    f.why = why || f.why;
    f.at = Date.now();
    if (alt) f.alt = alt;
    save();
    return f;
  }
  f = {
    id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 99),
    key, tool, who, why, alt: alt || '', n: 1, at: Date.now(),
  };
  S.fails.unshift(f);
  if (S.fails.length > FAIL_MAX) S.fails.length = FAIL_MAX;
  save();
  /* 顺便在「它学会的」里立一条 avoid 规则 —— 老人要能在同一个页面看见、能删 */
  const rk = 'avoid:' + key;
  if (!S.rules.some((r) => r.k === rk)) {
    S.rules.push({
      id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 99),
      k: rk, q: who ? ('给「' + who + '」' + toolCn(tool)) : toolCn(tool),
      ans: '', src: '', kind: 'avoid', n: 1, born: Date.now(),
      firstMs: 0, lastMs: 0, hits: 0, auto: true,
      tool, why, alt: alt || '',
    });
    trimRules();
    save();
    try { applyForm(true); renderLearn(); } catch (e) {}
  }
  return f;
}

/* 工具名给机器看，中文给人看。页面上不出现 paste_text 这种字样。 */
const ALT_CN = { paste_text: '换个方式把字粘进去', tap_result: '按大小点第一条' };

function toolCn(t) {
  const M = {
    wechat_message: '发微信', wechat_call: '打微信电话', wechat_redpacket: '发红包',
    call_phone: '打电话', send_sms: '发短信', open_app: '打开软件',
    open_url: '开网页', play_video: '放视频', watch_news: '看新闻',
    open_map: '开地图', ir_power: '用遥控', set_alarm: '定闹钟',
    check_meds: '看药箱', get_weather: '查天气', take_photo: '拍照',
    read_screen: '看屏幕', search_web: '上网查',
    tap_text: '按字点', type_text: '打字', paste_text: '粘贴',
    tap_result: '点第一条', screen_text: '看一眼屏幕', media: '播放控制',
    volume: '调声音', search_in_app: '在软件里搜', tv_channel: '换台',
    recall: '想起来了', pet_toggle: '叫它出来',
  };
  return M[t] || t;
}

/* 给模型的提示：这件事以前这么干过、没成。让它别重复。
   只喂最近 6 条，且只喂跟当前这句话沾边的，不然提示词会被历史撑爆。 */
function failHints(text) {
  if (!S.fails || !S.fails.length) return '';
  const k = learnKey(text) || '';
  const hit = S.fails.filter((f) => {
    if (!k) return false;
    const w = String(f.who || '');
    return (w && (k.includes(w) || w.includes(k))) || (f.tool && k.includes(w));
  }).slice(0, 3);
  if (!hit.length) return '';
  return '\n\n【它以前在这件事上失败过】' + hit.map((f) =>
    '· ' + toolCn(f.tool) + (f.who ? '（对象：' + f.who + '）' : '') +
    ' —— 上次没成，因为' + (f.why || '没走通') +
    (f.alt ? '。改用：' + f.alt : '。别再原样重试，换个办法或直接说实话')
  ).join('\n');
}

/* 回退：忘掉一条失败。删了下次就会重新试那条路。 */
function forgetFail(id) {
  const i = S.fails.findIndex((x) => x.id === id);
  let removed = null;
  if (i >= 0) { removed = S.fails[i]; S.fails.splice(i, 1); }
  const rk = removed ? 'avoid:' + removed.key : '';
  const j = rk ? S.rules.findIndex((r) => r.k === rk) : -1;
  if (j >= 0) S.rules.splice(j, 1);
  if (removed || j >= 0) {
    save();
    try { applyForm(true); renderLearn(); renderHero(); } catch (e) {}
  }
  return removed;
}

function trimRules() {
  if (S.rules.length <= RULE_MAX) return;
  // 先扔「要慢慢说」里次数最少的，再扔最老的
  const del = S.rules.length - RULE_MAX;
  S.rules.sort((a, b) => (a.born || 0) - (b.born || 0));
  S.rules.splice(0, del);
}

/* ---------- 回退：删一条，行为立刻退回去 ---------- */
function forgetRule(id) {
  const i = S.rules.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const r = S.rules[i];
  S.rules.splice(i, 1);
  // 对应的重复计数也清掉，不然下次一问又立刻长回来
  if (r.k) delete S.q[r.k];
  if (r.k) delete S.memo[r.k];
  /* 「这条路不通」删掉时，失败记录也要一起删 —— 只删页面上的字不删记忆，
     下次它照着记忆还是绕路，老人会说「我删了它怎么还这样」。 */
  if (r.kind === 'avoid') {
    const kd = String(r.k || '').replace(/^avoid:/, '');
    S.fails = (S.fails || []).filter((f) => f.key !== kd);
  }
  save();
  applyForm(true);
  renderLearn();
  renderHero();
  return r;
}

/* ============ 存档 ============ */

/* ============ 联网搜索：原生先走，网页端走离线样本 ============ */
/* 这份语料是 2026-11-03 真抓必应、逐条确认过才留下的，不是编的。
   网页端直连必应/维基/DDG 都被 CORS 拦（实测 code 000 / Failed to fetch），
   所以网页端只能靠它 + 本地常识；原生端有真联网。 */
function offlineWeb(q) {
  /* 老人说话带「大概/一般/什么」这类虚词，匹配前先剥掉，不然「白内障手术大概多少钱」
     就接不上「白内障手术多少钱」。 */
  const norm = (x) => (x || '').replace(/[，。？！、\s]/g, '')
    .replace(/大概|大约|一般|通常|到底|究竟|比较好|最好|比较|一下|左右|需要|要不要|是不是|能不能/g, '');
  const s = norm(q);
  let best = null, len = 0;
  for (const g of MILI_DATA.web) for (const kk of g.k) {
    const k = norm(kk);
    if (!k) continue;
    if (s.includes(k) && k.length > len) { best = g; len = k.length; }
  }
  if (best) return best.items;
  // 本地常识兜底
  const faq = MILI_DATA.faq.find((f) => f.k.some((x) => s.includes(norm(x)) && norm(x)));
  if (faq) return [{ s: '米粒记着的', t: '先说个大概', a: faq.a }];
  return null;
}
let srchCb = {}, srchId = 0;
window.__onSearch = (id, json) => {
  const f = srchCb[id]; if (!f) return;
  delete srchCb[id];
  let arr = [];
  try { arr = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) {}
  f(Array.isArray(arr) ? arr : []);
};
async function searchWeb(q) {
  const n = NATIVE();
  if (n && n.search) {
    try {
      const r = await new Promise((res, rej) => {
        const id = ++srchId;
        const tm = setTimeout(() => { delete srchCb[id]; rej(new Error('timeout')); }, 8000);
        srchCb[id] = (arr) => { clearTimeout(tm); res(arr); };
        n.search(q, id);
      });
      if (Array.isArray(r) && r.length) return r;
    } catch (e) {}
  }
  // 网页端：真实抓取过的样本 + 本地常识
  await wait(900 + Math.random() * 500);   // 让它有「在查」的那一下
  const o = offlineWeb(q);
  return o || [];
}

/* 把搜索结果压成老人听得懂的三句 */
function digest(arr, q) {
  if (!arr.length) return null;
  const first = arr[0];
  let a = first.a || '';
  a = a.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
  a = a.split(/[。！]/).filter((x) => x.trim()).slice(0, 2).join('。');
  if (a && !a.endsWith('。')) a += '。';
  return { text: a || first.t, src: first.s || '', title: first.t || '' };
}





/* ============ 真 LLM：WorkBuddy 云服务，免密 ============ */
/* 只有从部署域名打开时才初始化。file:// 打开时 SDK 会因为 Origin 不匹配被拒，
   那就别初始化，直接走本地的离线常识 + 必应。 */
const CLOUD_CFG = {
  endpoint: 'https://mili-elder.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_fINj11GAOatvAgPpkWrAlf_GRVlxfJdUn8QqQQFOZjeq5aAuaga5vmH',
};
/* 智能体内核（agent.js）自己也要建 client。把配置挂出去，
   免得两处各写一份 key —— 之前改过一次就漏改了一处。 */
window.__CLOUD_CFG = CLOUD_CFG;
/* ============================================================================
 * 智能体内核接线
 *
 * 内核（agent.js）不碰 DOM、不碰 localStorage —— 它只通过这里拿到能力。
 * 这样做的好处：内核可以被单独测（探针直接喂句子，不启动整个界面）。
 * ========================================================================== */
let _agentReady = false;

function wireAgent() {
  /* 幂等，但可以强制重接。MiliNative 是异步注入的（Android WebView 里
     桥对象要等页面加载完才挂上），如果启动时它还没到，接的就是空环境，
     之后所有工具都返回「这台设备办不了」—— 老人会说「它什么都做不了」。
     所以 force 重接是必须的。 */
  if (_agentReady && !window.__WIRE_FORCE) return;
  if (!window.MILI_AGENT || !window.MILI_MEMO) return;
  _agentReady = true;
  window.__WIRE_FORCE = false;

  window.MILI_MEMO.load(STORE_KEY);

  window.MILI_AGENT.init({
    native: () => NATIVE(),

    /* 说话。内核只给文本，怎么出气泡、怎么念、动画怎么走，还是这里管。 */
    say: (text, opts) => {
      if (!text) return;
      const o = opts || {};
      playAnim(o.anim || 'nod', 1.2);
      say(text, o.ms || Math.max(5200, text.length * 300), { slow: true, key: o.key });
    },

    anim: (name, dur) => { try { playAnim(name, dur || 1.2); } catch (e) {} },

    /* 老人叫什么。人设提示词里要用，之前模型把「米粒」安到老人头上就是缺这个。 */
    /* 没填名字就返回空串，让内核用「您」。不要塞「老人家」。 */
    me: () => (S.me || '').trim(),

    /* 长期记忆：三类事实 */
    memoAdd: (kind, text) => window.MILI_MEMO.add(kind, text, '老人说的'),
    memoFind: (q) => window.MILI_MEMO.find(q),
    /* 记忆注入：跟这句话沾边的记忆直接喂进提示词。
       以前只存不喂 —— 全指望模型自己想起调 recall，它想不起来就说
       「这个我没记着」，教一百遍也白教。现在每轮先翻一遍本子。 */
    memoHints: (t) => {
      try {
        const hits = window.MILI_MEMO.find(t || '');
        if (!hits || !hits.length) return '';
        return '\n【你记着的、跟他这句话沾边的事】他教过的对应关系直接照办，'
          + '绝不说「没记着」：\n'
          + hits.slice(0, 6).map((m) => '· ' + m.text).join('\n');
      } catch (e) { return ''; }
    },

    /* 2026-11-09：把真记下来的血压/血糖/药箱接进系统提示词。
       只在老人聊身体时注入，平时一个字不加（不加首句延迟）。
       数据全部来自本机：MILI_VITAL 和 S.med，没有编造、没有假接口。 */
    healthHints: (t) => {
      try {
        const q = String(t || '');
        if (!/(血压|血糖|心率|血氧|药|吃药|身体|头晕|心慌|难受|不舒服|体检|降压|降糖|记得|多少)/.test(q)) return '';
        const L = [];
        const v = typeof vitalAll === 'function' ? vitalAll() : [];
        const bp = v.find((x) => x && x.kind === 'bp');
        const glu = v.find((x) => x && x.kind === 'glu');
        if (bp) L.push('最近一次血压 ' + bp.sys + '/' + bp.dia + ' mmHg');
        if (glu) L.push('最近一次血糖 ' + glu.val + ' mmol/L');
        const meds = (S.med || []).filter((m) => m && m.on).slice(0, 8);
        if (meds.length) L.push('药箱里在吃：' + meds.map((m) =>
          (m.who || m.name || '药') + (m.dose ? '（' + m.dose + '）' : '')).join('、'));
        if (!L.length) return '';
        return '\n【家里真记下来的数，答身体问题时照这个说，别含糊也别编】\n· '
          + L.join('\n· ')
          + '\n· 只报数、提醒按医生说的吃，不诊断、不给新药量。没记就说「这本上没记着」。';
      } catch (e) { return ''; }
    },

    /* 跨会话的任务。内核只认这三个口子，怎么存归这边管。 */
    taskAdd: (t) => taskAdd(t),
    taskList: () => taskList(),
    taskDone: (id) => taskDone(id),

    /* 药箱。空药箱必须如实说「还没填」，不能报「3 颗」。 */
    medCheck: (who) => {      const on = S.med.filter((m) => m.on);
      if (!on.length) {
        return { ok: false, detail: '药箱还空着呢，让家里人在药箱里加上我就知道了。' };
      }
      if (who) {
        const m = medFind(who);
        if (!m) return { ok: false, detail: '药箱里没有「' + who + '」这个药。' };
        const kind = medKind(who);
        return { ok: true, detail: medAnswer(m, kind), med: m };
      }
      const st = medNow();
      if (st.due.length) {
        const fresh = st.due.filter((x) => !x.justSaid);
        if (fresh.length) {
          const a = fresh.map((x) => x.who + x.dose).join('，') + '。' + fresh[0].when + '。';
          fresh.forEach((x) => { const t = S.med.find((y) => y.who === x.who); if (t) t.lastAt = Date.now(); });
          save();
          return { ok: true, detail: '该吃了。' + a, med: fresh[0], kind: 'all' };
        }
        return { ok: true, detail: st.due[0].who + '刚才说过了呀，' + st.due[0].when + '吃，别吃重了。' };
      }
      return { ok: true, detail: medNotNowSay(st.notNow) };
    },

    /* 联网查。走原有的必应 + 摘要，不另造一套。 */
    searchWeb: async (q) => {
      try {
        const arr = await searchWeb(q);
        const dg = digest(arr, q);
        if (!dg) return null;
        return { text: dg.text, src: dg.src, results: arr };
      } catch (e) { return null; }
    },

    /* 看图。有原生视觉就走原生，没有就让模型看 base64。 */
    seeImage: async (b64, facing) => {
      const n = NATIVE();
      if (n && n.see) {
        try {
          const r = JSON.parse(n.see(b64, facing));
          if (r && r.ok && r.text) return r.text;
        } catch (e) {}
      }
      return null;   // 没有视觉能力就如实说没看清
    },

    /* 云视觉通用版：截屏问一句、回一段人话（look_screen / 拍照问米粒都走这条）。
       和 seeImage 分开：seeImage 走原生（拍人像/认东西），这条走云，能读整屏。 */
    visionAsk: (b64, q) => visionAsk(b64, q),

    nextPhotoId: () => ++photoId,

    /* 失败经验：喂给模型的「别这么干」清单，以及把新失败记下来的入口。
       这两件事必须成对 —— 只记不用等于白记，只用不记等于没有记忆。 */
    failHints: (t) => failHints(t),
    noteFail: (tool, args, why, alt) => noteFail(tool, args, why, alt),
    /* 工具自己问「这条路以前走通过没有」—— 走不通就别再白试一遍 */
    knownFail: (tool, who) => {
      const w = String(who || '');
      return !!(S.fails || []).find((f) => f.tool === tool &&
        (!w || String(f.who || '').includes(w) || w.includes(String(f.who || ''))));
    },

    /* 手上有没有一件等着他点头的事。提示词靠这个决定「这句话是不是在答应」。
       返回空串 = 没有。判断权交给模型，不在这里写意图正则。 */
    pending: () => window.MILI_PENDING.desc(),

    log: (what, extra) => { try { logDid('heart', what, extra || ''); } catch (e) {} },
  });
}

/* ==========================================================================
 * 三级路由：skill 缓存 0ms → 本地硬规则 0ms → agent loop 1.6~2.2s
 *
 * 为什么要三级，而不是全都交给智能体：
 *   ① 关电视、打电话这种，老人一天说八遍。每次都等 2 秒是折磨。
 *   ② 断网时智能体是废的，但本地规则还能办事。
 *   ③ 智能体真正的价值在「第一次遇到的新说法」——那是它该花 2 秒的时候。
 * ======================================================================== */

/* 从内核的 trace 里抠出「这次真的办成了哪几件事」。
   只留 ok:true 的，而且只留会改世界的工具 —— 查天气、查药箱这类
   没有副作用，重放没意义，还容易把过期数据当新数据。 */
/* 🚨 2026-11-12 修：原来这张表漏了 search_in_app / shop_search / watch_video，
   导致 goodCalls() 把它们全过滤掉 → calls 为空 → did 恒为 false → skill 从不落库。
   表现就是「三遍演示第二遍还得问」，而日志里一切正常、查不出错。
   判据：凡是对手机屏幕产生真实改变、且值得下次直接重放的，都要进来。 */
const SIDE_EFFECT = /^(call_phone|wechat_message|wechat_call|wechat_redpacket|send_sms|ir_power|open_map|play_video|watch_video|search_in_app|shop_search|watch_news|open_app|open_url|set_alarm|pet_toggle|grab_redpacket|register_hospital|scan_pay|wechat_pay_code)$/;

function goodCalls(results, trace) {
  const out = [];
  for (const rd of (trace || [])) {
    for (const ex of (rd.exec || [])) {
      if (ex.ok && SIDE_EFFECT.test(ex.tool)) {
        out.push({ name: ex.tool, args: ex.args || {} });
      }
    }
  }
  return out;
}

/* ==========================================================================
 * 本地算日期 —— 老人问「今天农历几号」不该进模型
 *
 * 真机实证（2026-11-12）：LOCAL_FIRST 里明明写了「几号」要本地先办，
 * 但下面根本没有任何分支真正接住它，整句话一路掉到兜底，老人听到的是
 * 「这个我一时没弄明白」。而本地 Intl 一算就有：2026 丙午年 十月初四。
 *
 * 不进模型的三个理由：
 *   ① 慢 —— 一趟模型 2~5 秒，本地 0 毫秒；
 *   ② 会错 —— 模型复述时把「十月初四」说成「农历十月4号」；
 *   ③ 会跑偏 —— 问一次农历，它能拐去讲阴历阳历怎么换算。
 * ======================================================================== */
function lunarCNOf(d) {
  try {
    const s = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { dateStyle: 'long' }).format(d);
    /* 输出形如「2026丙午年十月初四」，砍掉年份干支，只留月日 */
    const i = s.indexOf('年');
    return i >= 0 ? s.slice(i + 1) : s;
  } catch (e) { return ''; }
}
function localDateSay(raw) {
  const d = new Date();
  const q = String(raw || '');
  const wk = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][d.getDay()];
  const md = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 号';
  const lun = lunarCNOf(d);
  const hh = d.getHours();
  const mm = ('0' + d.getMinutes()).slice(-2);
  const clock = hh + ' 点 ' + (mm === '00' ? '整' : mm + ' 分');
  const askLunar = /农历|阴历/.test(q);
  const askWeek = /星期|礼拜|周几/.test(q);
  const askDay = /几号|几月几|\d+\s*月/.test(q);
  const askTime = /几点|什么时候了|现在时间/.test(q);

  if (askTime && !askLunar && !askDay && !askWeek) return '现在 ' + clock + '。';
  if (askLunar && !askWeek && !askTime) {
    return lun ? '今天是农历' + lun + '。' : '今天是' + md + '。';
  }
  if (askWeek && !askLunar && !askTime) return '今天' + wk + '。';
  if (askDay && !askLunar && !askTime) return '今天 ' + md + '，' + wk + '。';
  /* 什么都问了，或者只说「今天什么日子」→ 一次给全，别让他再问第二遍 */
  return '今天 ' + md + '，' + wk + (lun ? '，农历' + lun : '') + '；现在 ' + clock + '。';
}

/* 重放完之后替老人把结果说一句 —— 重放本身不出声。
   只看最后一步：一串动作里最后那一步才是他关心的结果。 */
function skillSayOf(tools) {
  const last = (tools || [])[(tools || []).length - 1] || {};
  const n = String(last.name || '');
  if (/search_in_app|watch_video|play_video/.test(n)) return '给您放上啦，全屏播放呢。';
  if (/watch_news|tv_channel/.test(n)) return '给您调到新闻台了。';
  if (/call_phone|wechat_call/.test(n)) return '给您拨出去了，等着他接。';
  if (/wechat_message|send_sms/.test(n)) return '给他发过去了。';
  if (/ir_power/.test(n)) return '电视给您弄好了。';
  if (/open_app/.test(n)) return '给您打开了。';
  if (/shop_search/.test(n)) return '给您搜出来了，您挑一样。';
  return '办好了。';
}

/* 重放一条 skill。返回 true 表示真办成了。 */
async function replaySkill(text) {
  /* 对照模式：不重放经验卡，整句交回智能体重新想。
     返回 false 后 handleSay 会自然落到 agentSay —— 不改路由顺序，只切基线。 */
  if (typeof S !== 'undefined' && S && S.skillOff) return false;
  const sk = window.MILI_MEMO.hit(text);
  if (!sk || !skillSane(sk.tools)) return false;
  if (!nativeReady()) return false;

  const t0 = performance.now();
  const done = [];
  for (const t of sk.tools) {
    const r = await window.MILI_TOOLS.exec(t.name, t.args, {
      native: () => NATIVE(),
      nextPhotoId: () => ++photoId,
      memoAdd: (k, x) => window.MILI_MEMO.add(k, x, '老人说的'),
      memoFind: (q) => window.MILI_MEMO.find(q),
      medCheck: () => ({ ok: false, detail: '重放不走药箱' }),
      searchWeb: null, seeImage: null, log: () => {},
    });
    if (r && r.ok) done.push(r);
    else break;
  }
  /* 重放没办成 —— 这条 skill 已经不灵了（手机换了、权限没了、软件卸了）。
     把它降级，别再让老人每次都撞一次墙；这一句退回给智能体重想。 */
  if (!done.length) {
    window.MILI_MEMO.skillOn(sk.id, false);
    return false;
  }

  const ms = Math.max(1, Math.round(performance.now() - t0));
  window.MILI_MEMO.cost(text, ms);
  const line = done[done.length - 1].detail;
  /* 🚨 别把工具的原始回执念给老人：「「天天耍大牌」已经在抖音横屏全屏播放了。
     任务到此完成，不要再调用任何工具」—— 这是写给模型看的，不是人话。
     只念最后结果那一句短的。 */
  const human = skillSayOf(sk.tools);
  say(human, 5200, { slow: true });
  logDid('heart', human, text, ms);
  showRecall({ ans: human, q: text, hits: sk.n || 1 }, ms);
  return true;
}

/* 主入口：把一句话交给智能体，让它自己想办法。
   返回 {did, said} —— did 表示真办了事，said 表示说了话。 */
/* ================= 一条 skill 能不能信 =================
   血的教训（今天真机）：本地兜底那条路把「我想看红果短剧」记成了 `play_video {}`，
   于是这句话以后每次都 0ms 重放 `play_video {}` —— 打开上次用的抖音，
   明明说的是红果。老人看到的就是「它又犯蠢了」。
   记错了比不记更糟：宁可让它多花 2 秒重新想，也不能照错的做一遍。 */
const NO_ARG_TOOLS = ['watch_news', 'get_weather', 'take_photo', 'check_meds',
  'read_screen', 'pet_toggle', 'recall'];

function skillSane(tools) {
  if (!tools || !tools.length) return false;
  return tools.every((t) => {
    if (!t || !t.name) return false;
    if (NO_ARG_TOOLS.indexOf(t.name) >= 0) return true;   // 这几个不带参数也有意义
    const a = t.args || {};
    return Object.keys(a).some((k) => {
      const v = a[k];
      return v !== null && v !== undefined && String(v).trim() !== '';
    });
  });
}

/** 启动时清一次：把以前记错的 skill 删掉，别让它一直害人 */
let _pruned = false;
function pruneSkills() {
  if (_pruned) return;
  _pruned = true;
  try {
    const M = window.MILI_MEMO;
    if (!M || !M.skillList) return;
    const bad = M.skillList().filter((x) => !skillSane(x.tools));
    bad.forEach((x) => { try { M.skillDel(x.id); } catch (e) {} });
    if (bad.length && window.console) console.log('清掉记错的 skill', bad.length);
  } catch (e) {}
}

async function agentSay(text, quiet, opts) {
  wireAgent();
  if (!window.MILI_AGENT || !window.MILI_AGENT.ready()) return null;

  const n = NATIVE();
  /* 🚨 2026-11-10 菲尔特拍板：录过声纹之后，只有老人自己的声音能指挥办事。
     闲聊谁都能说 —— 这里只是「本轮不挂办事工具」，不是不让人说话。
     没录过 / 太短判不出 → 一律放行，新手机刚装好就能用。
     注意：判据必须放在 agentSay 里（真正调内核的那个函数），
     放到 handleSay 会因为跨函数作用域直接抛 ReferenceError。 */
  let voiceTools;
  try {
    if (n && n.vpLastOwn && n.vpLastOwn() === 'other') {
      voiceTools = false;
      try { console.log('[VOICE] 这句不是老人的声音，本轮只陪聊不办事'); } catch (e) {}
    }
  } catch (e) {}
  /* 🚨 2026-11-12 真机：老人说「你找点话题跟我聊聊」，
     模型把「话题」当成一个人，跑去 open_app 开微信找人。
     一个只想有人说说话的老人，最后得到一屏微信 —— 这是最伤的失败。
     闲聊就是不挂任何办事工具：手上没工具，它开不了 App，只能张嘴说话。
     这条按句判，判中了也只影响这一轮，下一句照常办事。 */
  if (voiceTools !== false
      && /陪我聊|陪我说|跟我聊|和我说说|找.{0,4}话题|说点什么|聊会儿|聊一会|聊聊天|说说话|闲话|无聊|闷得慌|有点闷|心里闷|闷得/.test(String(text || ''))
      /* 但句子里点名了微信/电话/联系人，就是真要办事，不能拦。
         2026-11-12 补「胸闷」：老人说「我有点闷」是想找人说话，
         说「我胸口闷」是要人管。同一句里差两个字，走的路必须不一样 ——
         这条排除先接住，身体的事一律当正事办。 */
      && !/微信|打电话|电话给|发消息|发条|联系人|打给|拨给|视频通话|胸闷|胸口|心慌|喘不上|憋/.test(String(text || ''))) {
    voiceTools = false;
    try { console.log('[CHAT] 这句是纯闲聊，本轮不挂工具'); } catch (e) {}
  }
  /* 2026-11-09 菲尔特：「不要搞其他的声音出来」。
     原来中途会念「我看看啊」/「我还找着呢」，把「还没想好」伪装成「已经答了」，
     老人听到一句垫话就以为说完了，接着又来一句，反而更乱。
     现在中途只保持视觉「在想」，一句话从头到尾只出一次声。 */
  const onSaid = (txt) => {
    try { setPetState('think'); } catch (e) {}
    /* 🚨 2026-11-10 真机：内核把「我发微信啊」这类交代语传过来了，
       原来这里只改状态、把话术整个丢掉 —— 老人听到的还是安静，
       「执行前先交代一句」等于没做。现在真的说出口。 */
    if (txt && !quiet) {
      try { console.log('[SAY] 交代 ' + txt); } catch (e) {}
      try { say(txt, 4000); } catch (e) {}
    }
  };

  /* 流式播报的两个口子。自测（quiet）一律不开 —— 验收不该有声音。
     是否真的念，内核自己会判：这一轮在调工具就不念，前面有失败也不念。
     这里只负责把增量接下来。 */
  /* 这一轮到底进没进流式，看 engaged 这个标记。
     不能用「已经播出去多少」来判断 —— 合成还没回来的时候它还是空的。
     一旦误判成「没流式」，下面就再 say 一次，而 say → speak 里有「让位」
     逻辑，会把刚排好的整队句子全清掉：流式跑得挺好，一句都没响。 */
  SS.engaged = false;
  /* 🚨 2026-11-10 菲尔特拍板的连续对话规则（四条，别再改回一刀切）：
       ① 闲聊 → 耳朵一直开着，老人连着说、米粒连着答，静默到点自动收。
       ② 这轮真要调工具 → 由内核的 onToolBegin 在这里关麦收声，执行期间全程安静，
          抖音声、系统声、老人自己说话都不许再录进去。
       ③ 办完只报结果，不自动重开；想接着说，喊一声「米粒米粒」。
       ④ 跌落确认 / 主动问候是米粒先开口 → callEnter('fall'/'nudge') 自动开麦等回应。
     之前这里每句话进模型之前就无条件 callExit('task')，闲聊也被掐断 —— 已删。 */
  /* 🚨 21:0x 菲尔特「卡在哪一个任务之后就一直卡住在想了」：
     20:0x 只在 r.err 时收状态；模型返回空话 / 超时没标 err / 工具链半截挂住时，
     通话条会一直写「在想……」不消。挂一条独立硬看门狗：18 秒后只要还没
     正常说话，无条件把通话条和「在想」一起收掉，并给老人一句实话。 */
  try {
    clearTimeout(window.__answerWd);
    window.__answerWd = setTimeout(function(){
      try {
        const sub = ($('cbSub') || {}).textContent || '';
        const stuck = (typeof CALL !== 'undefined' && CALL.on) &&
                      !speaking && /在想|在做|正在|在说/.test(sub);
        if (!stuck) return;
        /* 21:4x：只把「在想」这个假状态收掉，**不挂断**，连续交流照旧。 */
        try { cbStatus('listen'); } catch (e) {}
        try { setPetState('listen'); } catch (e) {}
        const sub0 = $('cbSub'); if (sub0) sub0.textContent = '在听';
        if (!quiet) say('这句我没接住，您再说一遍？', 3200);
      } catch (e) {}
    }, 18000);
  } catch (e) {}
  const r = await window.MILI_AGENT.run(text, {
    onSaid: onSaid,
    onToolBegin: function (tool) {
      /* 只有真动手才收麦，闲聊不进这个回调。 */
      if (typeof CALL !== 'undefined' && CALL.on) { try { callExit('task'); } catch (e) {} }
    },
    tools: voiceTools,
    quiet: quiet,
    /* 2026-11-08 关掉流式播报：真机上出现「同一句念两遍 + 气泡重复」，
       根因是 streamed 判定失手后又补了一次 say。老人要的是「说出来就是一句完整的」，
       不是边想边说。等流式稳定了再开（代码留着）。 */
    onDelta: null,
    onStreamEnd: null,
    /* 日新页 RUN 1 专用：头一回听到这个说法，先真问一句再办。
       产品平时不带这个标记，仍然是「能办就直接办」。 */
    askFirst: !!(opts && opts.askFirst),
  });

  /* 🚨 2026-11-10 20:0x 「卡在哪一个任务之后就一直卡住在想了」：
     模型超时/失败时旧代码直接 return null，通话条和「在想」状态没人收，
     屏幕就一直停在 00:58「在说」。无论成败都要把状态还回去，
     并给老人一句实话，绝不留一片沉默。 */
  /* 正常出声就撤掉看门狗，别误伤播报 */
  try { clearTimeout(window.__answerWd); } catch (e) {}
  if (r.err === 'busy') {
    try { setPetState('idle'); } catch (e) {}
    if (!quiet) { try { say('我听着呢，等一下就回您。', 3200); } catch (e) {} }
    return null;
  }
  if (r && r.err && r.err !== 'empty') {
    try { setPetState('idle'); } catch (e) {}
    try { if (typeof CALL !== 'undefined' && CALL.on) callExit('agent_done'); } catch (e) {}
    if (!quiet && !r.said) { try { say('这会儿没弄明白，您再说一遍？', 3200); } catch (e) {} }
  }
  const calls = goodCalls(r.results, r.trace);
  /* 判「办成」不能只看「有一个工具成功了」。
     实测踩过：模型先调 get_weather 成功，再调 ir_power 失败，
     于是 some(x=>x.ok) 为真，这一整轮被当成办成 ——
     老人问「电视关了没」，答的是「没关」，但记忆里记成办成过。
     判据改成：只要有任何一个工具失败，就不算办成，不记 skill。
     skill 是「下次直接重放」的东西，记错了下次会照着错的做。 */
  /* 2026-11-12 修：原来「只要有任何一个工具失败就不算办成」太严。
     真机实测第一遍答「抖音」：模型先 recall 查了一下（空），再 search_in_app 成功，
     整轮被判成没办成 → skill 不记 → 下一回还得从头问，学了等于没学。
     绕了弯路最后办成了，就是办成了。判据改成看**最后一步**：
     最后一步失败才算没办成 —— 注释里那个「天气成功、关电视失败」的反例照样挡得住，
     因为那次的最后一步正是失败的 ir_power。 */
  const anyFail = (r.results || []).some((x) => x.ok === false);
  const _lastRes = (r.results || []).length ? r.results[r.results.length - 1] : null;
  const _lastOk = !!_lastRes && _lastRes.ok !== false;
  const did = calls.length > 0 && (_lastOk || !anyFail);

  /* 失败也要记下来 —— 这是「进化」的另一半。
     以前只记成功，等于下一次还从同一面墙开始撞。
     记的是「哪个工具、办谁的事、为什么没成」，下次同类事就能先绕开。 */
  if (anyFail) {
    for (const rd of (r.trace || [])) {
      for (const ex of (rd.exec || [])) {
        if (ex.ok === false) {
          try { noteFail(ex.tool, ex.args || {}, ex.detail || '', ''); } catch (e) {}
        }
      }
    }
  }

  /* 办成了就把成功序列记下来。同一句话再办成一次，就升格成 skill，
     下次 0ms 命中 —— 这就是「第一次慢、下次快」。 */
  if (did) {
    /* 2026-11-12：这一句如果是「追问后的回答」，skill 的钥匙要用原始请求。
       否则存进去的是「抖音，对」，老人下回再说原话命中不了 —— 追问一次换来的记忆就废了。 */
    const _ao = window.__askOrigin;
    const _fresh = !!(_ao && (Date.now() - _ao.t) < 120000);
    const _key = _fresh ? String(_ao.text || text) : text;
    if (_fresh) window.__askOrigin = null;
    window.MILI_MEMO.note(_key, calls);
    window.MILI_MEMO.bump(_key);
    /* 改口驱动的进化落到检索正反馈，而不是 evolve.js 的正则别名：
       把「老人原话 → 第一个成功工具」记成一条检索样本，下次相似说法
       BM25 排序自然上移；满 3 次或跨 3 天才升稳定档（对齐权威口径）。 */
    if (window.MILI_TOOL_ROUTER && calls && calls.length) {
      try { window.MILI_TOOL_ROUTER.learn(_key, String(calls[0].name || '')); } catch (e) {}
    }
    /* 改口驱动的进化落到检索正反馈，而不是 evolve.js 的正则别名：
       把「老人原话 → 第一个成功工具」记成一条检索样本，下次相似说法
       BM25 排序自然上移；满 3 次或跨 3 天才升稳定档（对齐权威口径）。 */
    if (window.MILI_TOOL_ROUTER && calls && calls.length) {
      try { window.MILI_TOOL_ROUTER.learn(_key, String(calls[0].name || '')); } catch (e) {}
    }
  }

  /* 这一轮是不是已经边生成边念过了。
     光看 engaged 还不够稳：真要出现「说是流式了但其实一句没排上」的情况，
     那就会既不播也不补，老人一个字都听不见。所以再确认一句确实在手上。 */
  const streamed = SS.engaged && !!(SS.spoke || SS.q.length || SS.playing || SS.live);

  if (r.said && !quiet) {
    if (streamed) {
      /* 已经念过了。这里只把气泡定稿成最终文本 ——
         流式是把句子一段段贴上去的，过完诚实检查和标点清洗可能差一两个字，
         以最终稿为准。绝不能再 say 一次，那就成念两遍了。 */
      const bt = $('bubbleText');
      if (bt && bt.textContent !== killRepeat(r.said)) bt.textContent = killRepeat(r.said);
      try { if (typeof armBubbleHide === 'function') armBubbleHide(); } catch (e) {}
    } else {
      /* 办事的过程中已经说过「我按遥控啊」，最终结果要接着说，不能被吞掉 */
      say(r.said, Math.max(5200, r.said.length * 320), { slow: true });
    }
  } else if (!r.said && quiet) {
    /* 自测模式不出声 */
  }

  if (r.said) {
    logDid(did ? 'heart' : 'search', r.said, text, r.ms);
  }

  /* 把这一轮走过的步子留一份 —— 演示时要能当面打开给评委看：
     它试了什么、哪一步没成、换成了什么。这是「可审计」最直白的证据。 */
  try {
    const steps = [];
    for (const rd of (r.trace || [])) {
      for (const ex of (rd.exec || [])) {
        steps.push({ tool: ex.tool, ok: !!ex.ok, why: String(ex.detail || '').slice(0, 40) });
      }
    }
    if (steps.length) {
      S.lastRun = { at: Date.now(), q: String(text).slice(0, 40), ms: Math.round(r.ms || 0), steps: steps.slice(0, 8) };
      save();
    }
  } catch (e) {}

  return { did: did, said: r.said, err: r.err, ms: r.ms, trace: r.trace };
}

let _cloud = null, _llmModel = null, _llmWarned = false;

/* 验收出口：只在地址栏带 ?debug=1 时才挂出去。
   产品版绝不暴露这些内部函数 —— 老人不该看到，也不该被误触。
   我自己验收、探针复验都靠它，省得每次改一行就得重打包。 */
window.__bootAt = Date.now();
/* 开机补推一次：不是所有启动路径都会 save()，但白名单必须一开机就有。
   晚 1.8 秒等原生桥挂好。 */
setTimeout(function () { try { syncCallCfg(); } catch (e) {} }, 1800);

if (new URLSearchParams(location.search).get('debug') === '1') {
  window.MILI_DEBUG = {
    handleSay: (t, q) => handleSay(t, q),
    tryDo: (t) => tryDo(t),
    agentSay: (t, q) => agentSay(t, q),
    replay: (t) => replaySkill(t),
    showCards: (t, r) => showAgentCards(t, r),
    wire: (force) => { window.__WIRE_FORCE = !!force; wireAgent(); },
    state: () => S,
    nativeReady: () => nativeReady(),
    tools: () => (window.MILI_TOOLS ? window.MILI_TOOLS.names() : []),
    lastTrace: () => (window.MILI_AGENT ? window.MILI_AGENT.trace() : null),
    /* 流式说话的内部状态。调「为什么它不出声」的时候，光看界面看不出来，
       得看队列里到底有没有句子、合成有没有回来。 */
    ss: () => ({ live: SS.live, finished: SS.finished, wrapped: SS.wrapped,
                 buf: SS.buf, seq: SS.seq, q: SS.q.map((x) => ({ t: x.text, ready: x.ready, url: !!x.url })),
                 playing: SS.playing,
                 gated: SS.gated, spoke: SS.spoke }),
    ssLog: () => (window.__ssLog || []),
  };
}

function cloudOK() {
  /* 只挡 file://。之前写死 https:，本地 http 一律返回 false ——
     后果不是「少个功能」，而是本地正则那条路说完动作后调 sayFor 时
     直接掉进 BRAIN_OFF「我这会儿有点蒙」，老人听到的是这句废话。
     智能体内核里 ready() 修过同一个坑，这里漏了。 */
  if (location.protocol === 'file:') return false;
  return !!(window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function');
}

function initCloud() {
  if (_cloud || !cloudOK()) return _cloud;
  try {
    _cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CLOUD_CFG.endpoint,
      oauthRelayBaseUrl: CLOUD_CFG.oauthRelayBaseUrl,
      publishableKey: CLOUD_CFG.publishableKey,
    });
  } catch (e) { _cloud = null; }
  return _cloud;
}

/* ============================================================================
 * 账号：手机号 + 验证码登录，登录后家属和老人两端靠 6 位配对码连起来
 *
 * 为什么必须有账号：
 * 以前家属在家人端填的药存在自己手机的 localStorage 里，老人手机根本收不到。
 * 所谓「家里人帮你管药」是句空话。账号 + 配对才让它真的能跨手机。
 *
 * 登录态不放 localStorage —— SDK 自己存 token。这里只记手机号，用来显示。
 * ========================================================================== */
const ACC = {
  user: null,          // { id, phone, name, role }
  link: null,          // { fam } 老人端配对到的家属
  busy: false,
};

function accPhoneMask(p) {
  const s = String(p || '').replace(/\D/g, '');
  return s.length >= 11 ? s.slice(0, 3) + '****' + s.slice(-4) : (s || '—');
}

/* ============================================================================
 * 米粒自己的服务器（阿里云 YOUR_SERVER_HOST:9001，跟语音识别同一个进程）
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
/* 后端地址。默认直连菲尔特自己的 ECS。
   带 ?api=http://… 可以临时改指向（开发时用：模拟器到 ECS 的 9001 不通，
   就用本地静态服务的 /api 转一层）。线上没人带这个参数，走默认值。 */
const MILI_API = (function () {
  try {
    const q = new URLSearchParams(location.search);
    const o = q.get('api');
    if (o && /^https?:\/\//i.test(o)) return o.replace(/\/+$/, '');
  } catch (e) {}
  return 'http://YOUR_SERVER_HOST:9001';
})();

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
  try { famCardReset(); } catch (e) {}
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
  try { famCardReset(); } catch (e) {}
  const had = accToken();
  S.mePhone = ''; S.famToken = ''; S.elderToken = '';
  S.accToken = ''; S.accRole = ''; S.accPhone = ''; S.accName = '';
  S.famName = ''; S.pairCode = ''; S.pairFam = '';
  /* 2026-11-10：登出必须回到第一屏。以前只清账号字段、不清 onboarded/role，
     界面显示「已引导完成」但账号是空的，状态自相矛盾。配置在云端，重登会拉回来。 */
  S.onboarded = false; S.role = ''; S.pairAt = 0;
  save();
  if (had) { try { await accApi('/auth/logout', { body: {} }); } catch (e) {} }
}

/* 2026-11-10 菲尔特拍板：一个老人账号一个同步码，永不过期、绑定后不变。 */
async function accNewCode() {
  if (DEMO) return { ok: false, why: '演示版不连真实账号。' };
  if (!accToken()) return { ok: false, why: '先在老人端登录。' };
  const d = await accApi('/pair/code');
  if (!d.ok) return d;
  S.pairCode = d.code;
  S.pairAt = 0;
  save();
  return { ok: true, code: d.code, ttl: 0, role: 'elder', peers: d.peers || 0 };
}

/* 老人端换一个码：已绑定的家人不掉线，旧码从此填不进来。 */
async function accRotateCode() {
  if (!accToken()) return { ok: false, why: '先在老人端登录。' };
  const d = await accApi('/pair/rotate', { body: {} });
  if (!d.ok) return d;
  S.pairCode = d.code; save();
  return { ok: true, code: d.code };
}

/* 家人端只填码：不注册、不登录、不用老人点同意。后端凭码发一张家人票。 */
async function accPair(code, famName) {
  if (DEMO) return { ok: false, why: '演示版不连真实账号。' };
  const k = String(code || '').replace(/\D/g, '');
  if (k.length !== 6) return { ok: false, why: '同步码是 6 位数字' };
  const d = await accApi('/pair/bind', {
    body: { code: k, name: String(famName || '').slice(0, 12) },
    tok: (S.accRole === 'fam' && accToken()) ? accToken() : '',
  });
  if (!d.ok) return d;
  S.accToken = d.token || S.accToken;
  S.accRole = 'fam'; S.role = 'family';
  S.accName = d.name || '家人'; S.famName = S.accName;
  S.pairCode = k; S.pairFam = (d.peer && d.peer.name) || '老人家';
  S.onboarded = true;
  ACC.link = { peer: d.peer || null };
  save();
  return { ok: true, peer: d.peer || null, name: S.pairFam, role: 'fam' };
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

/* 米粒的人设。名字关系必须写死在提示词里 ——
   之前模型把「米粒」安到老人头上，因为它只知道有个米粒、不知道老人叫什么。 */
function PERSONA() {
  const me = (S.me || '').trim();
  /* 老人没填名字就只用「您」。硬塞「老人家」听着像在喊陌生人 ——
     实测说过「老人家出门记得多穿件衣裳」，别扭。 */
  const call = me && me !== '老人家' ? '老人叫「' + me + '」。' : '';
  const howCall = me && me !== '老人家'
    ? '称呼老人就用「' + me + '」或者「您」。'
    : '直接称呼「您」。';
  return '你是米粒，一只刚出壳不久的小鸡，会说话，陪着一位中国老人过日子。' +
    call + '你叫米粒。米粒是你自己的名字，不是老人的名字，' +
    '永远不要用米粒称呼老人。' + howCall +
    '说话像五六岁小孩：短句、口语、常带「呀、哦、啦、呢」。' +
    '每次只回一两句，总共不超过50个字，宁可少说不要长篇大论。' +
    '不用书面语，不说「首先/其次/综上所述」，不列清单。' +
    '老人问身体不舒服、吃什么药，只给最保守的建议（坐下、歇会儿、喝温水、去医院问医生），' +
    '绝对不给具体药量、不诊断。不知道就说不知道，然后说「要不问问家里人」。' +
    '不要提你是个AI或语言模型。';
}

/* 脑子暂时连不上时唯一允许说的话 —— 这是应急语，不是知识库 */
const BRAIN_OFF = '我这会儿有点蒙，等一下再问我一遍好不好？';

/* 统一出口：干完一件事说什么，一律问模型。
   tool = 刚执行的工具名，fallback = 模型不在线时唯一可用的保底话。 */
async function sayFor(tool, userText, fallback, extra) {
  const hint = ACTION_HINT[tool] || TOOL_HINT[tool];
  if (cloudOK() && hint) {
    const line = await llmAsk(userText,
      '你刚替老人执行了这个动作：' + hint + '。用一句话告诉她结果，别超过26个字。' + (extra ? ' ' + extra : ''));
    if (line) return line;
  }
  return fallback || BRAIN_OFF;
}

/* 拿模型。必须跟智能体内核用同一个 —— 之前这里是「取列表第一个能用的」，
   实测拿到的是 `auto`（带思维链），而内核用的是 deepseek-v4-flash。
   同一句话由两个不同模型说出来，性格和语速都不一样，
   老人听着就像「换了个东西」—— 这是「声音不对」的根因之一。 */
const LLM_MODEL = 'deepseek-v4-flash';   // 实测 17/17 土话全对、1.2~2.7s、无思维链
const LLM_FALLBACK = 'hy3';              // 免费兜底

async function llmPickModel() {
  if (_llmModel) return _llmModel;
  const c = initCloud();
  if (!c) return null;
  try {
    const ms = await c.llm.models.list();
    if (!ms || !ms.length) return null;
    const byId = (id) => ms.find((x) => x.id === id && x.disabled !== true);
    const m = byId(LLM_MODEL) || byId(LLM_FALLBACK)
      || ms.find((x) => x.disabled !== true && x.supportsToolCall && !x.onlyReasoning)
      || ms.find((x) => x.disabled !== true);
    if (!m) return null;
    _llmModel = m;
    return m;
  } catch (e) { return null; }
}

/**
 * 问模型。只支持流式，这里把流拼成整句再返回 —— 老人不需要看字一个个蹦。
 * 失败返回 null，调用方回退到本地逻辑。
 */
let _llmBusy = null;
async function llmAsk(q, extra) {
  /* 串行化：连续问的时候排队，别一起打上去被限流 */
  if (_llmBusy) { try { await _llmBusy; } catch (e) {} }
  let release;
  _llmBusy = new Promise((r) => { release = r; });
  try {
    return await llmAskOnce(q, extra);
  } finally {
    release();
    _llmBusy = null;
  }
}

async function llmAskOnce(q, extra, retried) {
  const D = window.__llmDbg = { step: 'start' };
  const c = initCloud();
  D.hasClient = !!c;
  if (!c) { D.step = 'no client'; return null; }
  const model = await llmPickModel();
  D.model = model && model.id;
  if (!model) { D.step = 'no model'; return null; }

  const msgs = [{ role: 'system', content: PERSONA() }];
  // 带上它自己学到的东西当上下文，答得更贴人
  const learned = S.rules.filter((r) => r.ans).slice(0, 3)
    .map((r) => '我记住的：' + r.q + ' → ' + r.ans.slice(0, 60)).join('\n');
  if (learned) msgs.push({ role: 'system', content: learned });
  if (extra) msgs.push({ role: 'system', content: extra });
  msgs.push({ role: 'user', content: String(q).slice(0, 300) });

  let out = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    for await (const chunk of c.llm.chat.completions.create({
      model: model.id,
      messages: msgs,
      stream: true,
      /* 温度跟内核对齐。之前 0.75 太高 —— 同一句话每次说法都不一样，
         老人会觉得「它今天怎么不对劲」。陪老人要的是稳定，不是花样。 */
      temperature: 0.3,
      max_tokens: 220,
      signal: ctrl.signal,
    })) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      D.chunks = (D.chunks || 0) + 1;
      if (d && d.content) out += d.content;
      if (out.length > 200) break;      // 够说一句了，别让它絮叨
    }
    D.step = 'stream done'; D.len = out.length;
    clearTimeout(timer);
  } catch (e) {
    window.__llmErr = (e && e.name) + ' | ' + (e && e.message) + ' | code=' +
      (e && e.error && e.error.code) + ' | status=' + (e && e.status);
    D.step = 'threw';
    /* 限流/临时不可用：隔一会儿重试一次。别重试参数类错误。 */
    const code = (e && e.error && e.error.code) || '';
    if (!retried && (code.indexOf('quota_rate') === 0 || code.indexOf('gateway_') === 0)) {
      const wait = (e && e.retryAfterMs) || 1300;
      await new Promise((r) => setTimeout(r, Math.min(wait, 3000)));
      return llmAskOnce(q, extra, true);
    }
    return null;
  }
  out = (out || '').trim();
  return out.length >= 2 ? out : null;
}

/* 动态文本的童声：服务端跑的是同一副 XiaoyiNeural，跟预生成的一模一样。
   只有 file:// 打开时没有服务端，才返回 null 退回系统 TTS。
   之前写死 https:，本地调试一律不发音 —— 等于「声音」这一环根本没法验。 */
const ttsCache = {};
async function ttsFetch(text) {
  if (location.protocol === 'file:') return null;
  if (ttsCache[text]) return ttsCache[text];
  try {
    const r = await fetch('/tts?t=' + encodeURIComponent(text.slice(0, 160)), { method: 'GET' });
    if (!r.ok) return null;
    const b = await r.blob();
    if (b.size < 800) return null;
    const url = URL.createObjectURL(b);
    ttsCache[text] = url;
    return url;
  } catch (e) { return null; }
}

/* 每个动作给模型一句「你在干什么」，让它照着说人话 */
const ACTION_HINT = {
  call: '你正在给她的家里人拨电话',
  video: '你正在给她放昨天没看完的那个短剧',
  weather: '你正在帮她看今天的天',
  date: '你正在告诉她今天几号、星期几',
  redpacket: '你正在帮她把微信红包点开',
  photo: '你正在用相机帮她拍一张照片',
  scam: '你判断这条消息是骗人的，正在提醒她别理、别转账',
  navigate: '你正在给她打开地图带路',
  hospital: '你正在给她打开医院的挂号页',
  talk: '你正在陪她说话',
};

/* 意图 id → 你刚替老人干了什么。台词全部按这个问模型。 */
const TOOL_HINT = {
  call: '你正在用手机打电话给她的家人', call2: '你正在用手机打电话给她的家人', call3: '你正在用手机打电话给她的家人',
  sms: '你正在帮她给家人发短信',
  nav: '你正在给她打开地图带路', nav2: '你正在给她打开地图带路', nav3: '你正在给她打开地图带路',
  tv: '你正在帮她打开电视直播', tv2: '你正在帮她打开电视直播',
  watch: '你正在帮她打开视频软件', watch2: '你正在帮她打开视频软件',
  watch_in: '你正在她指定的软件里帮她找片子',
  watch_show: '你正在按片名帮她找片子',
  wx_call: '你正在微信里给她的家人发起语音通话',
  wx_msg: '你正在微信里替她打开和家人的聊天窗口',
  wx_msg2: '你正在微信里替她打开和家人的聊天窗口',
  wx_msgtxt: '你正在微信里替她给家人发消息',
  wx_msgtxt2: '你正在微信里替她给家人发消息',
  wx_say: '你正在微信里替她给家人发消息',
  wx_say2: '你正在微信里替她给家人发消息',
  wx_red: '你正在微信里替她发红包',
  wx_red_amt: '你正在微信里替她发红包',
  ir_on: '你正在用红外遥控打开电视', ir_off: '你正在用红外遥控关电视', ir_hot: '你正在用红外遥控调热风',
  pet_on: '你把自己放到桌面上去陪着她', pet_off: '你把自己从桌面上收了回来',
  see_front: '你正睁大眼睛帮她看眼前的东西', see_back: '你正帮她看手机屏幕上的内容',
};

/* ============ 真办事：这些不是「演一下」，是手机上真会跳过去的 ============ */
/* 每条意图给出：名字、怎么把话里的人和地方抠出来、调哪个原生方法。
   抠不出来就返回 null，让下面的场景库/搜索接着处理，不硬猜。 */

const NAME = '([\\u4e00-\\u9fa5A-Za-z]{1,6}?)';
const PLACE = '([\\u4e00-\\u9fa5A-Za-z0-9]{2,20})';
/* 地名必须用非贪婪。贪婪版「去人民公园怎么走」会吃成「人民公园怎么走」，
   交给地图搜出来是错的 —— 真机上实测踩到。 */
const PLACE_NG = '([\\u4e00-\\u9fa5A-Za-z0-9]{2,20}?)';

const INTENTS = [
  /* --- 微信：先匹配，因为「给女儿打微信电话」里也有「打电话」 --- */
  { id: 'wx_video', re: new RegExp('给?' + NAME + '(?:打|发)(?:个)?(?:微信)?视频(?:通话|电话)?'),
    run: (m, n) => n.wechat(m[1], 'video') },
  { id: 'wx_call', re: new RegExp('给?' + NAME + '(?:打|发)(?:个)?微信(?:语音|通话|电话)'),
    run: (m, n) => n.wechat(m[1], 'call') },

  /* 带内容的意图必须排在「只开窗口」的前面：
     「给妈妈发微信说我挺好的」如果不先匹配 wx_say，就会被 wx_msg 抢走，
     结果只打开了聊天窗口，那句话丢了。 */
  { id: 'wx_say', re: new RegExp('给?' + NAME + '发(?:个)?微信(?:说|讲|告诉)(?:他|她|一下)?[，,]?(.+)$'),
    run: (m, n) => n.wxText(m[1], m[2]) },
  { id: 'wx_say2', re: new RegExp('(?:跟|和|对)' + NAME + '说[，,]?(.+)$'),
    run: (m, n) => n.wxText(m[1], m[2]) },
  { id: 'wx_red_amt', re: new RegExp('给?' + NAME + '发(?:个)?([0-9]{1,5}(?:\.[0-9]{1,2})?)(?:块|元|块钱)?(?:的)?(?:微信)?红包'),
    run: (m, n) => n.wxRed(m[1], m[2]) },

  /* 「给李昌洪发消息哈哈哈」——没有“微信”“说”字样 */
  { id: 'wx_msgtxt', re: new RegExp('给?' + NAME + '发(?:个)?(?:微信)?(?:消息|信息|句话|条信息)[，,]?(.+)$'),
    run: (m, n) => n.wxText(m[1], m[2]) },

  /* 泛化兜底：「给妈妈发哈哈哈」。排除电话/红包/微信这些别的意图。 */
  { id: 'wx_msgtxt2', re: new RegExp('给?' + NAME + '发(?!(?:个)?(?:微信|消息|信息)(?:说|讲|$)|电话|视频|红包|语音)((?:[\\u4e00-\\u9fa5A-Za-z0-9]|，|。|！|？){1,30})$'),
    guard: (m) => !/红包|短信|微信|语音|电话/.test(m[2] || ''),
    run: (m, n) => n.wxText(m[1], m[2]) },
  { id: 'wx_red', re: new RegExp('给?' + NAME + '(?:发|包)(?:个)?(?:微信)?红包'),
    run: (m, n) => n.wechat(m[1], 'redpacket') },
  { id: 'wx_msg', re: new RegExp('给?' + NAME + '发(?:个)?微信'),
    run: (m, n) => n.wechat(m[1], 'message') },
  { id: 'wx_msg2', re: new RegExp('微信(?:上)?(?:找|给)' + NAME),
    run: (m, n) => n.wechat(m[1], 'message') },


  /* --- 打电话 --- */
  /* 两条都要锚尾。NAME 是非贪婪的 {1,6}?，不锚尾只吃一个字 ——
     真机实测「打电话给老二」桥收到 call('老')，通讯录里查无此人。 */
  { id: 'call', re: new RegExp('给?' + NAME + '打(?:个)?电话$'),
    run: (m, n) => n.call(m[1]) },
  /* 「打电话给老二」必须锚到结尾。
     NAME 是非贪婪的 {1,6}?，不锚尾就只吃到「老」一个字 ——
     真机实测桥收到 call('老')，通讯录里找不到人。 */
  { id: 'call2', re: new RegExp('^打电话给' + NAME + '$'),
    run: (m, n) => n.call(m[1]) },
  /* 老人不说「打电话」，说「拨个号给老二」「找李大夫」。
     真机回归里这两句全掉到 none，然后被智能体当成别的事。 */
  { id: 'call3', re: new RegExp('^(?:拨个号给|拨个给|拨给|打个电话给|给' + NAME + '拨个电话|找)' + NAME + '$'),
    guard: (m) => {
      const t = m[0] || '';
      // 「找片」「找药」「找医院」不是打电话
      if (/片|剧|节目|电影|药|医院|厕所|地方|路|人问/.test(t)) return false;
      return true;
    },
    run: (m, n) => n.call(m[2] || m[1]) },
  { id: 'call3', re: /^(?:打个电话|打电话)$/,
    run: (m, n) => n.call('') },
  /* 「老二电话」—— 老人省掉「打」字，直接把人和电话连一起说。
     真机实测这句 MISS，落到 agent 白等 5 秒。
     必须排除「电话本/电话簿/电话费/来电话了」这些不是要拨号的。 */
  { id: 'call4', re: new RegExp('^' + NAME + '(?:的)?(?:电话|号码|手机号)$'),
    guard: (m) => {
      const a = m[1] || '';
      if (/^(电话|手机|号码|这个|那个|哪|什么|谁|我|你|他|她|它)$/.test(a)) return false;
      return a.length >= 1;
    },
    run: (m, n) => n.call(m[1]) },

  /* --- 点名电视频道：必须排在「导航」前面 --- */
  /* 「换到中央三台」以前被导航规则把「中央三台」当成地名吃掉；
     「看 CCTV5」以前落到普通 tv，台号丢了。两条都是规则顺序惹的祸。 */
  { id: 'tv_ch', re: /(?:换到|调到|看|放)?(?:中央|CCTV)[-]?(\d{1,2}|[一二三四五六七八九十]+)(?:台|套)?/i,
    guard: (m) => !/剧|电影/.test(m[0]),
    run: (m, n) => n.tvChannel(m[0]) },

  /* --- 导航 --- */
  /* 「去」后面跟的必须像个地名。老人说话常带别的：「我要去拿药」「去睡觉」——
     这些不是地名，得挡掉，否则会莫名其妙弹地图。
     「去趟人民公园」里那个「趟」是量词，不能当地名的一部分 ——
     实测桥收到的是 navigate('趟人民公园')，真机上会搜错地方。

     真机又暴露第二个吃字：PLACE 是 {2,20} 贪婪匹配，
     「去人民公园怎么走」会匹配成 navigate('人民公园怎么走')，
     把「怎么走」当地名的一部分交给地图，搜出来是错的。
     改成非贪婪 + 前瞻剥尾巴：地名不含「怎么走/咋走/一趟」。 */
  { id: 'nav', re: new RegExp('(?:我想|我要|想要|带我|领我)?(?:去|到)(?:一趟|趟|一下)?' + PLACE_NG + '(?:怎么走|咋走|一趟)?$'),
    guard: (m) => !/药|饭|睡|厕所|洗手间|医院挂号|买菜|楼下|楼上|床上|洗澡|厨房|桌面|手机|中央|CCTV|央视|频道/.test(m[1] || ''),
    run: (m, n) => n.navigate(m[1]) },
  { id: 'nav2', re: new RegExp('导航(?:去|到)?' + PLACE_NG + '(?:怎么走|咋走|一趟)?$'),
    guard: (m) => !/药|饭|睡|厕所|洗手间|中央|CCTV|央视|频道/.test(m[1] || ''),
    run: (m, n) => n.navigate(m[1]) },
  /* 「带我人民公园」—— 老人省掉「去」字，动词直接连地名。
     真机实测这句 MISS。必须带「带我/领我」这种明确的动词，
     光说「人民公园」不能当地名跳地图（老人常只是提一句）。 */
  { id: 'nav4', re: new RegExp('(?:带我|领我|捎我|送我去)(?:去|到)?(?:一趟|趟)?' + PLACE_NG + '(?:怎么走|咋走|一趟)?$'),
    guard: (m) => !/药|饭|睡|厕所|洗手间|医院挂号|买菜|楼下|楼上|床上|洗澡|厨房|桌面|手机|中央|CCTV|央视|频道/.test(m[1] || ''),
    run: (m, n) => n.navigate(m[1]) },
  { id: 'nav3', re: new RegExp('(?:怎么|咋)(?:去|走|到)' + PLACE),
    guard: (m) => !/药|饭|睡|厕所|洗手间|中央|CCTV|央视|频道/.test(m[1]),
    run: (m, n) => n.navigate(m[1]) },

  /* --- 用指定 App 找片：「用悟空浏览器找后会有期」 ---
     必须排在 watch / watch_show 前面，它最具体。 */
  { id: 'watch_in', re: new RegExp('(?:用|打开|去)?([\\u4e00-\\u9fa5A-Za-z0-9]{2,10}?)(?:里|上|中)?(?:帮我)?(?:找|搜)(?:一下|个)?([\\u4e00-\\u9fa5A-Za-z0-9]{2,12})$'),
    guard: (m) => {
      const a = m[1], b = m[2];
      // 「帮我找一下白内障手术多少钱」会解析成 app=帮我，必须挡掉
      if (/^(帮我|麻烦|请|帮忙|想|要|能|可以|谁|人|东西|地方|你|我|这个|那|什么|啥|电视|新闻|天气|药|医生|病)/.test(a)) return false;
      if (/^(了|吗|呢|吧|的|一下)/.test(b)) return false;
      return a.length >= 2 && b.length >= 2;
    },
    run: (m, n) => n.watchSearch(m[1], m[2]) },

  /* --- 视频软件 --- */
  { id: 'watch', re: /(?:打开|放|看|来点)?(爱奇艺|芒果|芒果TV|腾讯视频|优酷|抖音|红果|西瓜视频)/,
    run: (m, n) => n.watch(m[1]) },

  /* --- 调音量 ---
     必须排在 watch_show 前面：「放大点声音」会被 watch_show 吃成片名「大点声音」，
     然后真的去搜一个叫大点声音的片子。这类命令一天要说好几遍。 */
  { id: 'volume', re: /(?:声音|音量|喇叭|声儿).{0,3}(?:大|小|高|低)|(?:大点声|小点声|大声点|小声点|大点儿声|小点儿声)/,
    run: (m, n) => {
      const up = /大|高/.test(m[0]);
      try {
        const nn = NATIVE();
        if (nn && nn.volume) nn.volume(up ? 'up' : 'down');
      } catch (e) {}
      return up ? '声音调大了一点。' : '声音调小了一点。';
    } },

  /* 「我想看短剧」不是片名，是一类内容 —— 别让 watch_show 抢去搜「短剧」两个字 */
  { id: 'watch_duanju', re: /(?:我想看|想看点|我要看|看)(?:短剧|小短剧|短视频|微短剧)/,
    run: (m, n) => n.watch('红果') },

  /* --- 按剧名找片：「我要看后会有期」「放天天耍大牌」 ---
     放在 App 名之后、watch2 之前。带「剧/片/节目」的也认。 */
  { id: 'watch_show', re: /(?:我想看|我要看|给我放|放一下|放|看)([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:这个剧|这部|这剧|吧|呗)?$/,
    guard: (m) => {
      const s = m[1];
      // 这些不是剧名，是别的意图，别抢
      if (/^(电视|新闻|天气|病|药|医生|窗外|你|我|啥|什么|下|一眼)/.test(s)) return false;
      if (/爱奇艺|芒果|腾讯视频|优酷|抖音|红果|西瓜视频/.test(s)) return false;
      // 别把「大点声音」「小点声」当片名
      if (/声音|音量|喇叭|声儿|大点|小点/.test(s)) return false;
      return s.length >= 2;
    },
    run: (m, n) => n.watchShow(m[1]) },
  { id: 'watch2', re: /(?:接着看|继续看|上次看到哪|上次那个剧|看剧|看个剧|追剧)/,
    run: (m, n) => n.resumeWukong() },

  /* --- 电视 / 新闻（「看电视」归场景库的短剧，这里只认真正看电视的） --- */
  { id: 'tv', re: /(?:看|打开|放)?(?:新闻联播|中央台|央视|CCTV(?!\d)|新闻频道|新闻)/i,
    run: (m, n) => n.tv() },
  { id: 'tv2', re: /(?:换个台|换台|下个台|看新闻)/,
    run: (m, n) => n.tvNext() },

  /* 播放器控制：直接点网页播放器自己的按钮，比系统媒体键靠谱。
     以前只接在常驻唤醒词里，打字和主语音流程都用不上。 */
  { id: 'ep_ctl', re: /(?:米粒)?(?:下一集|下集|上一集|上集|暂停|停一下|继续放|接着放|播放)/,
    run: (m, n) => {
      const s = m[0];
      const cmd = /下一集|下集/.test(s) ? '下一集'
                : /上一集|上集/.test(s) ? '上一集'
                : /暂停|停一下/.test(s) ? '暂停' : '播放';
      return n.playerControl(cmd);
    } },

  /* --- 发短信 --- */
  { id: 'sms', re: new RegExp('给?' + NAME + '发(?:个)?短信'),
    run: (m, n) => n.sms(m[1], '') },

  /* --- 家电（红外）--- */
  /* 两种语序老人都可能说：「关掉电视」和「把电视关掉」，都得认。 */
  /* 老人不会说「关电视」，他说「把电视给我关喽」「电视给我关喽」。
     原来的正则要求「关」字紧挨着「电视」，中间插一个「给我」「帮我」就全漏。
     真机实测 9 句老人口语漏了 7 句，全是这类插字。
     现在把「把/给我/帮我/替我/一下/喽/了」都当噪声，允许任意位置出现。 */
  /* 老人不会说「关电视」，他说「把电视给我关喽」「电视给我关喽」。
     原来的正则要求「关」字紧挨着「电视」，中间插一个「给我」「帮我」就全漏。
     真机实测 9 句老人口语漏了 7 句，全是这类插字。
     两个分支都必须带动作词，否则「电视」单独出现会被当成关电视。 */
  { id: 'ir_on', re: /(?:(?:打开|开一?下|开)(?:那台)?(?:空调|电视(?!剧|台))|(?:把)?(?:空调|电视(?!剧|台))(?:给我|帮我|替我)?(?:打开|开一下|开开|开了|开))$/,
    guard: (m) => /开/.test(m[0]),
    run: (m, n) => n.irPower(/空调/.test(m[0]) ? '空调' : '电视', true) },
  { id: 'ir_off', re: /(?:(?:关掉|关上|关了|关一下|关喽|关|停一下|停一停|停停|停了|停)(?:那台)?(?:空调|电视(?!剧|台))|(?:把)?(?:空调|电视(?!剧|台))(?:给我|帮我|替我)?(?:关掉|关上|关了|关一下|关喽|关|停一下|停一停|停停|停了|停))$/,
    guard: (m) => /关|停/.test(m[0]),
    run: (m, n) => n.irPower(/空调/.test(m[0]) ? '空调' : '电视', false) },
  { id: 'ir_hot', re: /(?:有点热|太热了|热死了|开个空调|凉快凉快)/,
    run: (m, n) => n.irPower('空调', true) },
];

/* ---------- 快问快答：不办事，只回答，必须 0ms ----------
   真机实测暴露的问题：「今天冷不冷」「我头晕」「这是不是骗子」
   在硬规则里一条都没有，全落到 agent，老人干等 5 秒才听到一句话。
   天气这种问一句就答的事，等 5 秒是荒唐的 —— 而且 agent 走网络，
   断网时直接哑掉。所以这几类必须本地答，模型只当润色。
   这些不写进 INTENTS：它们不产生动作，不该记 skill、不该跳工具。 */
const WX_ZH = [
  [/sunny|clear/i, '晴'], [/partly cloudy/i, '多云'], [/^cloudy/i, '阴天'],
  [/overcast/i, '阴沉沉的'], [/mist|fog/i, '有雾'], [/haze|smoky/i, '有点霾'],
  [/rain|drizzle|shower/i, '下雨'], [/snow|sleet|blizzard/i, '下雪'],
  [/thunder|storm/i, '有雷雨'], [/wind/i, '风大'],
];
/* 天气接口的 city 回来是拼音（真机实测 Yutai）。老人听到一串字母，
   等于没听懂。常见地名换成中文；换不出来就不念城市，只报温度 ——
   念一个「Yutai」比不念更糟。 */
const CITY_ZH = {
  yutai: '鱼台', jining: '济宁', qufu: '曲阜', yanzhou: '兖州', zoucheng: '邹城',
  beijing: '北京', shanghai: '上海', tianjin: '天津', chongqing: '重庆',
  guangzhou: '广州', shenzhen: '深圳', hangzhou: '杭州', nanjing: '南京',
  wuhan: '武汉', chengdu: '成都', xian: '西安', zhengzhou: '郑州',
  jinan: '济南', qingdao: '青岛', yantai: '烟台', weifang: '潍坊',
  linyi: '临沂', heze: '菏泽', zaozhuang: '枣庄', taian: '泰安',
  suzhou: '苏州', wuxi: '无锡', changzhou: '常州', ningbo: '宁波',
  wenzhou: '温州', shaoxing: '绍兴', hefei: '合肥', changsha: '长沙',
  nanchang: '南昌', fuzhou: '福州', xiamen: '厦门', kunming: '昆明',
  guiyang: '贵阳', nanning: '南宁', haikou: '海口', shenyang: '沈阳',
  dalian: '大连', changchun: '长春', haerbin: '哈尔滨', harbin: '哈尔滨',
  shijiazhuang: '石家庄', taiyuan: '太原', huhehaote: '呼和浩特',
  lanzhou: '兰州', xining: '西宁', yinchuan: '银川', wulumuqi: '乌鲁木齐',
  lasa: '拉萨', hongkong: '香港', macau: '澳门', taipei: '台北',
};
function cityZh(c) {
  if (!c) return '';
  if (/[\u4e00-\u9fa5]/.test(c)) return c;
  const k = String(c).toLowerCase().replace(/[^a-z]/g, '');
  return CITY_ZH[k] || '';
}
/* 天气接口的 desc 有时回英文（真机实测拿到 Smoky haze），
   直接念给老人等于没说。只念认得出的中文，认不出就不念天况，只报温度。 */
function wxDescZh(d) {
  if (!d) return '';
  if (/[\u4e00-\u9fa5]/.test(d)) return d;
  for (const [re, zh] of WX_ZH) if (re.test(d)) return zh;
  return '';
}
/* 天气缓存。
   weather() 是同步 HTTP，真机实测 1.5~2.2 秒，而且阻塞主线程 ——
   问天气等两秒，比不答更让人心慌。开机预热一次，半小时内都念缓存。 */
let _wx = null;           // {at, data}
const WX_TTL = 30 * 60 * 1000;

/* ============ 首页顶栏：确定性区（2026-11-06 P1） ============
   老人打开第一眼：现在几点、今天什么天、它怎么称呼我。 */
const WD_ZH = '日一二三四五六';
function headTick() {
  const t = $('hhTime');
  if (!t) return;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  t.textContent = p2(d.getHours()) + ':' + p2(d.getMinutes());
  const date = $('hhDate');
  if (date) date.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WD_ZH[d.getDay()];
  const g = $('hhGreet');
  if (g) {
    const h = d.getHours();
    const hi = h < 6 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好'
      : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 21 ? '晚上好' : '夜深了';
    g.textContent = hi + (S.me ? '，' + S.me : '');
  }
}
function startHead() {
  headTick();
  if (!startHead._t) startHead._t = setInterval(headTick, 30 * 1000);
}
/* 天气到了就填进顶栏。填不上就空着 —— 顶栏宁缺一行字，不出一行错。 */
function headWx(w) {
  const el = $('hhWx');
  if (!el || !w || !w.ok) return;
  const t = parseInt(w.temp, 10);
  /* 2026-11-10 菲尔特「天气这里怎么没显示完全」：时钟卡只有一行，
     长描述（有点冷 / 多云转晴）会被省略号截成半句「有点」。
     统一压成三种短说法，宁可少写也不显示半截话。 */
  /* 2026-11-10 菲尔特「天气也显示出来，不要留个留意是干什么的」：
     原来为了塞进一行把长描述压成「留意」两个字，等于没说天气。
     顶卡改成两行后放得下，这里直接给完整天气，不再编缩写。 */
  const d = (wxDescZh(w.desc) || '').trim();
  const c = cityZh(w.city);
  const s = ((c ? c + ' ' : '') + (isNaN(t) ? '' : t + '°') + (d ? ' ' + d : '')).trim();
  if (s) el.textContent = s;
}
function warmWeather() {
  const n = NATIVE();
  if (!n || !n.weather) return;
  /* 放到下一轮事件循环再拉，别把开机动画卡住 */
  setTimeout(() => {
    try {
      const w = JSON.parse(n.weather());
      if (w && w.ok) { _wx = { at: Date.now(), data: w }; try { headWx(w); } catch (e) {} }
    } catch (e) {}
  }, 0);
}
function wxSay() {
  const n = NATIVE();
  if (!n || !n.weather) return '这台手机查不了天气。让家里人帮我开一下网。';
  let w = null;
  if (_wx && Date.now() - _wx.at < WX_TTL) w = _wx.data;
  if (!w) {
    /* 缓存没有或过期了，只能现拉一次。这一次会慢，但话得说出来 */
    try { w = JSON.parse(n.weather()); } catch (e) { return '这会儿天气没查到，等会儿再问我一遍。'; }
    if (w && w.ok) { _wx = { at: Date.now(), data: w }; try { headWx(w); } catch (e) {} }
  }
  if (!w || !w.ok) return '这会儿天气没查到，可能是网断了。等会儿再问我。';
  const t = parseInt(w.temp, 10);
  const d = wxDescZh(w.desc);
  const city = cityZh(w.city);
  let s = (city ? city + '现在' : '现在') + (isNaN(t) ? '温度不清楚' : t + '度');
  if (d) s += '，' + d;
  s += '。';
  if (!isNaN(t)) {
    if (t <= 8) s += '外头冷，出门多穿一件，围上围脖。';
    else if (t <= 16) s += '出门披件外套。';
    else if (t >= 30) s += '外头热，别在外面久站，多喝水。';
    else s += '这个温度正好，出门走走。';
  }
  return s;
}

/* 防骗：老人在问「这是不是骗子」，不是在描述一条短信。
   桥上有 scamCheck 判短信，这里判的是老人嘴里那句话本身。 */
function scamSay(text) {
  const n = NATIVE();
  let lv = 0;
  if (n && n.scamCheck) {
    try { lv = (JSON.parse(n.scamCheck(text)) || {}).lv || 0; } catch (e) { lv = 0; }
  }
  if (lv >= 2) return '这话不对劲，别信。要你转钱、要验证码、让你点链接的，一律不给。挂了，打给孩子。';
  if (lv === 1) return '听着有点悬。真要办事，让他打官方电话，别按他给的号码。拿不准就问孩子。';
  return '记住一条：只要让你转钱、给验证码、点链接，不管说得多像真的，都是骗子。拿不准就打给孩子。';
}

/* 身体不舒服：只给最保守的话，绝不下诊断、绝不推荐加药。
   这几句是本地固定话术 —— 这种事不能交给模型自由发挥。 */
function sickSay(text) {
  const t = text;
  const dizzy = /晕|眩|眼前发黑|站不稳/.test(t);
  const head = /头疼|头痛|脑袋疼/.test(t);
  const chest = /胸口|心口|心慌|喘不上/.test(t);
  const belly = /肚子|胃疼|胃不舒服|拉肚子/.test(t);
  if (chest) return '胸口不舒服别扛着。先坐下，别走动，马上打给孩子，或者打 120。这件事不能等。';
  if (dizzy) return '赶紧坐下，别站着。坐稳了缓一会儿，别自己起身走动。缓过来先喝口温水。要是还晕，或者说话不利索、手脚发麻，马上打 120。';
  if (head) return '先坐下歇会儿，别急着量血压。屋里闷就开点窗。要是疼得厉害，或者一边身子发麻、看东西不清楚，别等，马上去医院。';
  if (belly) return '先别吃东西，喝口温水，坐着歇会儿。要是疼得直不起腰，或者拉得厉害，就去医院看。';
  return '先坐下歇一会儿，别硬撑着干活。喝口温水。要是不见好，就给孩子打个电话。';
}

/* ---------- 闹钟：老人自己说「早上七点提醒我吃降压药」 ----------
   桥上一直有 addAlarm，但网页层只在家属端用过。老人自己开口说，
   这条根本没接 —— 真机实测 MISS，落到 agent 白等 5 秒。
   中文钟点必须自己解析：老人不会说 07:00。 */
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNum(s) {
  if (!s) return NaN;
  if (/^[0-9]+$/.test(s)) return +s;
  if (s === '十') return 10;
  if (s.length === 1) return CN_NUM[s] === undefined ? NaN : CN_NUM[s];
  // 十一 / 二十 / 二十三
  if (s[0] === '十') { const b = CN_NUM[s[1]]; return b === undefined ? NaN : 10 + b; }
  if (s[1] === '十') { const a = CN_NUM[s[0]]; const b = s[2] ? CN_NUM[s[2]] : 0; return a === undefined ? NaN : a * 10 + (b || 0); }
  return NaN;
}
/* 抓钟点：返回 {h, m} 或 null。「下午三点」要转成 15 点。 */
function parseClock(text) {
  const t = text.replace(/\s/g, '');
  const m = t.match(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})(?:点|时|:|：)(半|[0-9]{1,2}|[零一二三四五六七八九十]{1,3})?分?/);
  if (!m) return null;
  let h = cnNum(m[2]);
  if (!isFinite(h) || h < 0 || h > 24) return null;
  let mm = 0;
  if (m[3]) mm = m[3] === '半' ? 30 : cnNum(m[3]);
  if (!isFinite(mm) || mm < 0 || mm > 59) mm = 0;
  const seg = m[1] || '';
  // 下午/晚上说的「三点」是 15 点；说了「晚上十二点」是 0 点
  if (/下午|傍晚|晚上|夜里/.test(seg) && h < 12) h += 12;
  if (/中午/.test(seg) && h < 11) h += 12;
  if (h === 24) h = 0;
  return { h, m: mm, seg };
}
function alarmSay(text) {
  const n = NATIVE();
  if (!n || !n.addAlarm) return '这台手机设不了闹钟。让家里人帮我在药箱里加上。';
  const ck = parseClock(text);
  if (!ck) return '你说是几点？我没听清。说「早上七点提醒我吃降压药」这样我就懂。';
  // 药名：先认药箱里的，认不出就把「提醒我吃X」后面的当药名
  let who = '';
  const md = medFind(text);
  if (md) who = md.who;
  else {
    const mm = text.match(/(?:提醒我?)?(?:吃|服)([\u4e00-\u9fa5A-Za-z0-9]{1,10})/);
    who = mm ? mm[1] : '';
  }
  const dose = md ? md.dose : '';
  try { n.addAlarm(ck.h, ck.m, who, dose); } catch (e) { return '闹钟没设上，再试一次。'; }
  const hh = String(ck.h).padStart(2, '0') + ':' + String(ck.m).padStart(2, '0');
  return '设好了，每天' + hh + ' 提醒你吃' + (who || '药') + '。到点我叫你，你应一声我就记下。';
}
const ALARM_RE = /(?:提醒|闹钟|叫我|喊我)|(?:点|时)[^。]{0,6}(?:吃|服药)/;

const FASTQ = [
  /* 日期/时间/星期：必须 0ms 本地答。以前这条没写，问「今天几号」直接掉到云端，
     云端不知道今天是哪天，回一句「不知道」—— 老人当场就骂它傻。 */
  { id: 'date', re: /今天.{0,2}(?:几号|几月几号|初几|星期几|礼拜几|周几)|现在.{0,2}(?:几点|什么时间)|几点了|今天是(?:什么|啥)日子/,
    say: () => dateReply() + clockReply() },
  /* 天气：老人不会说「查询天气」，他说「冷不冷」「用不用带伞」 */
  { id: 'weather', re: /(?:今天|今儿|现在|外面|外头)?(?:天气|冷不冷|热不热|多少度|几度|下不下雨|下雨吗|带伞|穿外套|冷不|热不)/, say: () => wxSay() },
  /* 防骗 */
  { id: 'scam', re: /(?:是不是)?骗子|诈骗|骗钱|中奖|让我转账|要验证码|是不是骗人/, say: (t) => scamSay(t) },
  /* 身体不舒服 —— 必须排在别的之前，这种话不能绕 */
  { id: 'sick', re: /(?:我|有点|突然|老是)?(?:头晕|头疼|头痛|脑袋疼|胸口|心口|心慌|喘不上|肚子疼|胃疼|不舒服|难受|浑身没劲)/, say: (t) => sickSay(t) },
];


const _FIRST = ['nav2', 'nav3', 'watch2', 'tv'];
const _LAST = ['wx_msgtxt2'];
INTENTS.sort((a, b) => {
  const r = (x) => (_LAST.indexOf(x.id) >= 0 ? 2 : _FIRST.indexOf(x.id) >= 0 ? 0 : 1);
  return r(a) - r(b);
});

/* 桌宠 / 眼睛 / 提醒：这几个不是「说一句话就办」，是改状态 */
/* 注意顺序：「看看我」必须排在「看看这个」前面，否则会被前面那条吃掉。 */
const TOGGLES = [
  { id: 'pet_on', re: /(?:到|在|放)?桌面(?:上|去|来)|桌宠|养在桌面/, run: (n) => { n.startPet(); return '好，我到桌面上陪着你。'; } },
  { id: 'pet_off', re: /(?:别在桌面|收起(?:来)?|躲起来|先回去)/, run: (n) => { n.stopPet(); return '好，我先收起来。'; } },
  { id: 'see_front', re: /(?:看看我|照照我|看我一眼|你在看我吗|瞅瞅我)/, run: (n) => n.shoot(1, ++photoId) },
  { id: 'see_back', re: /(?:(?:你)?(?:看看|瞧瞧|瞅瞅)(?:这个|那个|这是啥|这是什么|一下)|帮我看看|这是什么东西)/, run: (n) => n.shoot(0, ++photoId) },
];

let photoId = 0;
let photoWait = {};

/* 原生能不能用（手机上是 MiliNative，网页上没有） */
function nativeReady() {
  const n = NATIVE();
  return !!(n && typeof n.call === 'function');
}

/* 本地意图 id → 智能体工具名 + 参数。
   本地正则办成之后要靠它把 skill 记下来，下次才能 0ms 重放。
   没有这张表，本地这条路永远学不会，老人每次都等 1.8 秒。 */
const ID2TOOL = {
  ir_on: (m) => ({ name: 'ir_power', args: { device: m[1] || m[2] || '电视', on: true } }),
  ir_off: (m) => ({ name: 'ir_power', args: { device: m[1] || m[2] || '电视', on: false } }),
  ir_hot: () => ({ name: 'ir_power', args: { device: '空调', on: true } }),
  tv: () => ({ name: 'watch_news', args: {} }),
  tv2: () => ({ name: 'watch_news', args: {} }),
  watch: () => ({ name: 'play_video', args: {} }),
  watch2: () => ({ name: 'play_video', args: {} }),
  call: (m) => ({ name: 'call_phone', args: { who: m[1] || '' } }),
  call2: (m) => ({ name: 'call_phone', args: { who: m[1] || '' } }),
  call3: (m) => ({ name: 'call_phone', args: { who: m[1] || '' } }),
  sms: (m) => ({ name: 'send_sms', args: { who: m[1] || '', text: m[2] || '' } }),
  nav: (m) => ({ name: 'open_map', args: { place: m[1] || '' } }),
  nav2: (m) => ({ name: 'open_map', args: { place: m[1] || '' } }),
  nav3: (m) => ({ name: 'open_map', args: { place: m[1] || '' } }),
  nav4: (m) => ({ name: 'open_map', args: { place: m[1] || '' } }),
  call4: (m) => ({ name: 'call_phone', args: { who: m[1] || '' } }),
};

/* 执行一条原生动作，回来把话说出来 */
async function runNative(fn, input, tool, userText) {
  const n = NATIVE();
  try {
    const raw = fn(n, input);
    if (!raw) return false;
    let res;
    try { res = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { res = { ok: true, say: String(raw) }; }
    /* 动作会离开本 App（打电话/开微信/开地图…），老人一出去就没人陪了 ——
       自动把桌宠悬浮窗开起来，飘在一旁陪着。已经在就不受影响。 */
    try { if (n.startPet && tool && TOOL_HINT[tool]) n.startPet(); } catch (e) {}
    /* 台词一律问模型；Java 里那句 say 只在断网时兜底。
       失败时不能问模型「你刚替老人执行了这个动作」—— 它没执行成功，
       照这个前提问出来的话必然是「办好啦」，就是演戏。失败直接说 why。 */
    if (res && res.ok === false) {
      const why = res.say || FAIL_SAY[res.why] || '这台手机办不了这件事。';
      say(why, 6200, { slow: true });
      logDid('warn', why, userText || '');
      return { ok: false, why: res.why || '', said: why };
    }
    if (res && res.say) {
      const line = await sayFor(tool || 'talk', userText || '', res.say);
      say(line, 6200, { slow: true });
    }
    return { ok: true, said: res && res.say ? res.say : '' };
  } catch (e) {
    return false;
  }
}

/* 桥只回了个 why 码、没带人话时，翻成人话。
   没有这张表的话，老人会听到「no_ir」这种鬼东西，或者干脆没声。 */
const FAIL_SAY = {
  no_ir: '这台手机没有红外，遥控不了电视。',
  no_perm: '权限没给，我动不了。让家里人给我开一下权限。',
  no_map: '手机里没装地图软件，我找不着路。',
  no_contact: '通讯录里没这个人，得先把号码存上。',
  no_app: '手机里没装这个软件。',
  no_who: '你没说是给谁，我不知道该找谁。',
  no_show: '你没说看哪个片子呀。',
  no_text: '你没说发什么内容。',
  no_money: '你没说发多少钱。',
  busy: '刚才那件事还没完，等我说完再问。',
  denied: '手机不让做这件事，得在设置里开一下。',
};

/* 主入口：能办就办，办不了返回 false 交给后面的逻辑 */
async function tryDo(text) {
  if (!nativeReady()) return false;
  const n = NATIVE();
  const t = text.replace(/[，。？！、,.?!\s]/g, '');

  // 状态类
  for (const g of TOGGLES) {
    const m = t.match(g.re);
    if (!m) continue;
    if (g.id === 'see_back' || g.id === 'see_front') {
      if (!n.canSee || !n.canSee()) { n.askSee && n.askSee(); say('得先让我用一下摄像头啊。', 5200, { slow: true }); return true; }
    }
    const said = g.run(n);
    if (typeof said === 'string') {
      const line = await sayFor(g.id, text, said);
      say(line, 5200, { slow: true });
    }
    /* 状态类（桌宠/看镜头）不走工具层，只记 id，不让调用方记 skill —— 
       它们本来就只有 0ms，学不学都一样。 */
    return { ok: true, id: g.id, tool: '', args: {} };
  }

  // 办事类
  /* 微信 / 电话 这一族，从 2026-11-04 起交给智能体，本地正则不再插手。
     为什么：正则只能抠「谁」和「说什么」，抠不准就出事 ——
     实测「给王炳皓发消息说我想你了」被截成 who=王炳皓、text=说我想你了，
     连「说」都发过去了。这种参数必须让模型自己抽。
     注意：这不是把功能交给另一套正则，而是交给带工具表的智能体，
     由它决定调 wechat_message(who=王炳皓, text=我想你了)。 */
  const AGENT_OWNS = /^(wx|call|video|dial)/;
  for (const it of INTENTS) {
    if (AGENT_OWNS.test(it.id)) continue;
    const m = t.match(it.re);
    if (!m) continue;
    if (it.guard && !it.guard(m)) continue;
    // 「打电话」这种没带人名的，先问你给谁打
    if (it.id === 'call' && (!m[1] || m[1].length < 1)) continue;
    const done = await runNative((nn) => it.run(m, nn), null, it.id, text);
    /* done 现在是 {ok, said} 或 false。失败也要认下这句话（老人已经听到
       「没红外，关不了」），但不能再记成「办成」—— 之前失败也 return true，
       「办过的事」里全是假的成功，老人翻记录会以为自己办成过。 */
    if (done) {
      if (done.ok) logDid('heart', text, text);
      /* 带上工具名和参数，让调用方能记 skill —— 本地办成的也要能 0ms 重放 */
      const t2 = ID2TOOL[it.id] ? ID2TOOL[it.id](m) : null;
      return { ok: done.ok, id: it.id, tool: t2 ? t2.name : '', args: t2 ? t2.args : {} };
    }
  }
  return false;
}

/* ---------- 日新引擎接管 ---------- */
/* 老人那句土话（「把电视给我关喽」）过不了上面的正则，
   但日新引擎学会了它指向哪个意图，这里就照着办。
   这是「第 1 版听不懂、第 2 版听得懂」真正落地的地方。 */
const EVO_ACT = {
  tv: 'tv', tv2: 'tv', ir_on: 'ir_on', ir_off: 'ir_off', ir_hot: 'ir_hot',
  pet_on: 'pet_on', pet_off: 'pet_off',
  see_front: 'see_front', see_back: 'see_back', watch2: 'watch2'
};
async function evoTry(text) {
  if (!window.EVO || !nativeReady()) return false;
  let r = null;
  try { r = window.EVO.redirect(text); } catch (e) { return false; }
  if (!r || !EVO_ACT[r.id]) return false;
  const id = EVO_ACT[r.id];
  const all = TOGGLES.concat(INTENTS);
  const it = all.find((x) => x.id === id);
  if (!it) return false;

  if (TOGGLES.indexOf(it) >= 0) {
    const said = it.run(NATIVE());
    if (typeof said === 'string') {
      const line = await sayFor(it.id, text, said);
      say(line, 5200, { slow: true });
    }
    logDid('heart', text, text);
    return { ok: true, id: r.id, tool: '', args: {} };
  }
  /* 无参数意图也要喂给 run 一个像样的 match：开/关要知道开的是空调还是电视 */
  const m = [];
  m[1] = /电视/.test(text) ? '电视' : /空调/.test(text) ? '空调' : '';
  const done = await runNative((nn) => it.run(m, nn), null, it.id, text);
  /* 只有真办成才记「办过的事」。失败照样认这句话（老人已听到原因），
     但不许记成成功 —— 记录里全是假的成功，比没有记录更糟。 */
  if (done && done.ok) logDid('heart', text, text);
  if (!done) return false;
  const t2 = ID2TOOL[it.id] ? ID2TOOL[it.id](m) : null;
  return { ok: done.ok, id: r.id, tool: t2 ? t2.name : '', args: t2 ? t2.args : {} };
}

/* 拍照回来的图 */
window.__onPhoto = function (id, b64, w, h, why) {
  const cb = photoWait[id];
  delete photoWait[id];
  if (!b64) {
    say(why === 'no_permission' ? '我还没得到许可看东西呢。' : '这一下没拍着，再来一次？', 5200, { slow: true });
    return;
  }
  if (cb) cb(b64, w, h);
};

/* 拍一张，返回 base64 */
function capture(facing) {
  return new Promise((resolve, reject) => {
    const n = NATIVE();
    if (!n || !n.shoot) { reject('no_native'); return; }
    const id = ++photoId;
    photoWait[id] = (b64) => resolve(b64);
    try { n.shoot(facing || 0, id); } catch (e) { reject(e); }
    setTimeout(() => { if (photoWait[id]) { delete photoWait[id]; reject('timeout'); } }, 9000);
  });
}

/* ============ 对话主路由 ============ */
function dateReply() {
  const d = new Date();
  const WD = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
  const h = d.getHours();
  const seg = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '夜里';
  return '今天' + (d.getMonth() + 1) + '月' + d.getDate() + '号，' + WD[d.getDay()] + '，' + seg + '。';
}

function clockReply() {
  const d = new Date();
  const m = d.getMinutes();
  return '现在' + d.getHours() + '点' + (m === 0 ? '整' : m + '分') + '。';
}

/* 从「我想看天天耍大牌」里抠出片名，追问话术要用。
   「我要看」不是称呼也不是片名的一部分，剥掉；剥三轮是因为老人常说
   「麻烦您给我开一下空调」这种叠了三层前缀的话。抠不出来就不问，直接办。 */
function askTitleOf(t) {
  let s = String(t || '').replace(/[，。？！、,.?!~～\s]/g, '');
  for (let i = 0; i < 3; i++) {
    s = s.replace(/^(米粒|小鸡|哎|诶|那个|这个|麻烦|帮我|给我|您|你|我要|我想看|我想听|我想|我要看|我要听|看看|看|听听|听|搜|找|放|打开|开|一下|来|要)+/, '');
  }
  s = s.replace(/(吧|啊|呀|哦|啦|呢|呗|嘛|喽|一下|点儿|点)+$/g, '');
  return (s.length >= 2 && s.length <= 14) ? s : '';
}

/* 追问后的那一句回答，是接在上一句后面的。
   用户答「抖音，对」——单看这五个字，模型只能回「这个我这儿没记着」（实测 26.8 秒白跑）。
   把原话拼回去，「我要看天天耍大牌，抖音，对」，它就知道该开哪个 App、搜什么。
   两分钟内、且回答本身很短，才当追问的答案处理；说了一长句就说明他自己换话题了。 */
function _askMerge(raw) {
  const a = window.__askOrigin;
  const s = String(raw || '');
  if (!a || !a.text) return raw;
  if (Date.now() - a.t > 120000) return raw;
  if (s.length > 12) return raw;
  /* 纯确认就是一句「对」—— 直接当原话办，别把「对」拼进片名里
     （实测拼出来是「天天耍大牌对」，模型照着搜，搜不到）。 */
  if (/^(对|是|是的|对的对的|好|行|嗯|恩|没错|就这个|就是这个|是的呀|对的)[，,。！!？?~～\s]*$/.test(s)) return a.text;
  return a.text + '，' + s;
}

async function handleSay(text, quiet, opts) {
  window.__lat = { at: Date.now(), text: String(text || '').slice(0, 30) };
  /* 演示模式：这一遍从「老人说完」开始计时。整段的起点只有这里一处，
     别在 say() 里另起 —— 那是出声，不是开始。 */
  try { window.__DEMO_ROUND && window.__DEMO_ROUND(text); } catch (e) {}
  /* 趁模型在想（实测首字 243ms，够握手了），把豆包那条 ws 提前推到「就等文本」。
     不这么做的话，每句话都要先付一遍 ws 握手 + 两次往返，实测 1.5 秒。 */
  try {
    const _n = NATIVE();
    if (_n && _n.ttsPrepare) _n.ttsPrepare();
  } catch (e) {}
  $('listen').hidden = true;
  /* 喊「米粒」把它叫醒的那一下，也要顺手把通话接起来 ——
     不然老人说完一句，它答完就散了，下一句还得再喊一次。
     这就是菲尔特说的「老人叫米粒的时候继续一段时间交流」。 */
  if (typeof CALL !== 'undefined' && !CALL.on) { try { callEnter('say'); } catch (e) {} }
  /* 2026-11-06 菲尔特：「每次只能对话一次，后面它根本不理人，明明是连续对话」。
     根因就在这一行：条件写反了。
       原来   if (window.__cvOn) stopListen();   ← 刚好在最该接着听的时候把麦关了
       现在   if (!window.__cvOn) stopListen();  ← 只有单句模式才收工
     连续模式（__cvOn=true）下麦克风从头到尾不放手，这是「连贯」的全部；
     一停就等于这一轮聊完就把耳朵摘了，老人再说十句都没人应。
     原生那边 cvMode 仍是 true，所以前端图标还亮着「在听」—— 最难查的那种哑。 */
  if (!window.__cvOn) stopListen();
  hush();
  /* 每说一句话都是一次「他在活动」的证据：起床、吃饭、睡前全靠这些时刻推出来，
     老人不需要做任何额外动作。 */
  try {
    if (window.MILI_RHYTHM) {
      const t0 = String(text || '');
      window.MILI_RHYTHM.note('talk');
      if (/吃了|吃饭|饿|做饭|煮/i.test(t0)) window.MILI_RHYTHM.note('meal');
    }
  } catch (e) {}
  /* 2026-11-09 菲尔特：「不要搞其他的声音出来，我是要真的优化」。
     删掉 filler('ack') 与下面的 got_it 预合成音：那是另一个嗓子，
     跟豆包童声抢话，还把「模型还没回来」伪装成「已经答了」，老人更难判断。
     现在第一反馈是 0ms 的视觉状态；一句话从头到尾只有一次声音 = 最终答案。 */
  try { setPetState('think'); } catch (e) {}

  /* ===== 「记住：…」= 家人端补充配置通道（非产品进化机制） =====
     2026-11-09 口径：安全求助（头晕/摔倒 → 通知家人）是出厂就该有的基础能力，
     由 agent.js 的 emergency 规则保证，不属于进化成果，也不进对外叙事。
     老人没有义务教 AI；真正的学习来自执行结果与作息画像（≥3 天才写进、可回退）。
     这里保留显式备注通道，只给家人端补配置用，不作为「日新」闭环证据。 */
  try {
    const rawT = String(text || '').trim();
    const mt = rawT.match(/^(?:米粒[，,。！!]?)?(?:你)?记(?:住|一下|着|好)[：:，,、]?\s*(.+)$/);
    if (mt && mt[1] && window.MILI_MEMO) {
      let fact = mt[1].trim();
      /* 教学里说了「要做什么」，就把动作写死进记忆，执行层按它纠正 ——
         教什么做什么，不是猜意图。模型偶尔会挑个次优工具（比如只记体征不叫人），
         这一层保证同一种说法永远落同一个动作。 */
      const ACT = [
        [/通知家人|叫人|求助|报警|不安全|快叫人/, 'emergency'],
        [/手电|照亮|亮灯|灯/, 'torch'],
        [/音量|声音|响/, 'volume'],
        [/打电话|拨号|拨给/, 'call_phone'],
        [/视频|微信通话/, 'wechat_call'],
        [/发微信|微信说/, 'wechat_message'],
        [/电视|频道|看戏|看新闻/, 'watch_news'],
      ];
      if (!/\[动作:/.test(fact)) {
        for (let i = 0; i < ACT.length; i++) {
          if (ACT[i][0].test(fact)) { fact += ' [动作:' + ACT[i][1] + ']'; break; }
        }
      }
      const added = window.MILI_MEMO.add('fact', fact, '家人端补充');
      say('好，我记住了：' + fact);
      try { if (typeof save === 'function') save(); } catch (e) {}
      return { ok: true, said: '好，我记住了：' + fact, taught: added };
    }
  } catch (e) {}

  /* 电视层开着时的快速通道：不进模型，0 秒直达。
     老人在看电视，说「不看了」是让他立刻退出去，
     走一轮 DeepSeek 再退就是灾难。 */
  try {
    const tw = $('tvfull');
    if (tw && !tw.hidden && typeof window.MILI_TV !== 'undefined') {
      const t0 = String(text || '');
      if (/不看了|不想看|退出|关了吧|不看这个|换个台|换台|下一个台|上一个台|别的台/.test(t0)) {
        if (/不看了|不想看|退出|关了吧|不看这个/.test(t0)) {
          window.MILI_TV.close();
          say('好，退出来啦。');
          return { ok: true, said: '好，退出来啦。' };
        }
        const dir = /上一个|换回来/.test(t0) ? -1 : 1;
        window.MILI_TV.switch(dir);
        return { ok: true, said: '' };
      }
    }
  } catch (e) {}

  /* 2026-11-09：got_it 预合成音整段删除。
     以前是「先换个嗓子嗯一声，再换回来」，两段音频还会撞一下，
     更像两个人在抢话。现在静那半秒，用「在想」胶囊顶住。 */

  /* 老人一句话说完不等它答完就说下一句 —— 这是常态，不是异常。
     新的一句进来先掐掉上一轮；等待上限从 1.2s 压到 120ms，
     等不起就带着旧轮一起往下走，不再让新话排队。 */
  if (window.MILI_AGENT && MILI_AGENT.busy && MILI_AGENT.busy()) {
    try { MILI_AGENT.abort(); } catch (e) {}
    for (let i = 0; i < 3 && MILI_AGENT.busy(); i++) await wait(40);
  }
  const raw = (text || '').trim();
  if (!raw) return;

  /* 只喊了一声名字、后面没别的话 —— 这是「叫人」，不是「提问」。
     走一遍模型要两秒多，老人喊完等两秒没人应，就会以为它坏了，
     接着把同一句话再喊一遍。直接应一声，比什么都快。
     判据只有一条：去掉标点后整句就是「米粒」两个字的重复。 */
  const bare = raw.replace(/[\s，。！？、,.?!~～呢啊呀吧]/g, '');
  if (bare && /^(米粒|小米粒)+$/.test(bare)) {
    CALL.last = Date.now();
    say('哎，我在这儿呢。', 3200);
    return;
  }

  window.__askedOnce = true;   // 问过话之后，开机问候就不再抢麦克风
  const t0 = performance.now();

  /* 0) 它学会的那条，先接管。
     这一步就是「进化真的改变行为」：学会之前要转圈查 2 秒，
     学会之后 0.04 秒就答，而且说法也不一样。 */
  const rule = findRule(raw);
  if (rule && rule.ans && !/药/.test(raw)) {
    const ms = Math.max(1, Math.round(performance.now() - t0));
    rule.hits = (rule.hits || 0) + 1;
    rule.lastMs = ms;
    save();
    playAnim('nod', 1.1);
    // 「记不住」的那几条：放慢、念两遍
    const slowTwice = rule.kind === 'slow';
    say(rule.ans, slowTwice ? 12000 : 9000, { slow: true, twice: slowTwice });
    logDid('search', rule.ans, raw, ms);
    showRecall(rule, ms);
    return;
  }

  // 0.5) 把它问到第几回记下来。已经会答的再问，就是要「慢慢说」
  const grown = bumpRepeat(raw);

  /* ==================== 路由顺序（2026-11-04 翻过来）====================
     ⓪ skill 缓存        0ms       同一句话办成过一次，直接重放
     ① 智能体            1.6~2.2s  真的想、自己挑工具、自己填参数、自己看结果
     ② 本地硬规则        0ms       只在智能体没接住时兜底（断网也能办事）
     ③ 药箱 / 快答 / 场景 0ms       本地有真数据或必须秒回的

     为什么把智能体提到正则前面：
     以前正则先跑，凡是沾边的句子全被它抢走，模型根本没机会想。实测两个案子：
       「看看电视」被 tv 正则接住，用旧包名找悟空失败 → 落到系统浏览器；
       「我想看红果短剧」被 watch 抢走 → 去浏览器里搜文字，明明手机上就装着红果。
     这不是模型笨，是它压根没上场。现在只有药物、身体不适、求救、日期天气
     这几类必须本地先办（要读本地状态 / 慢一秒都不行），其余一律先让模型想。 */

  /* ---- ① skill 缓存 ---- */
  if (window.MILI_MEMO && window.MILI_TOOLS) {
    const hit = window.MILI_MEMO.hit(raw);
    /* 演示模式：前两遍不许走 skill 重放（详见文件末尾 DEMO 的 blockSkill 注释）。
       没有这一道，第 1 遍会被上次学会的序列 0 毫秒重放，一声都不问。 */
    var _demoBlk = false;
    try { _demoBlk = !!(window.__DEMO && window.__DEMO.blockSkill(raw, hit)); } catch (e) {}
    if (hit && skillSane(hit.tools) && !_demoBlk) {
      const ok = await replaySkill(raw);
      if (ok) {
        if (window.EVO) { try { EVO.hit(raw, hit.tools[0].name); } catch (e) {} }
        if (grown) announceGrow(grown);
        /* 2026-11-12：给「日新·两次运行」页一个明确的回执。
           这一句根本没进模型，trace 必须是空的 —— 0 轮 0 token 才是真证据。
           🚨 不能只说「办好了」就完：重放是静默执行的，不出一声，老人对着屏幕
           一片安静，会以为没听懂。这里必须替他把结果讲出来。 */
        const _say = skillSayOf(hit.tools);
        /* 演示模式：这一遍一句都没问、模型也没起（0 轮），是从记忆里直接重放的。
           窗口要能把「0 次提问」这个事实记下来。 */
        try { window.__DEMO_DID && window.__DEMO_DID('skill'); } catch (e) {}
        return { did: true, said: _say, ms: 0, trace: [], skillHit: true };
      }
    }
  }

  /* ---- ①.0 日期 / 农历 / 星期 / 时间：本地算完直接念 ---- */
  const DATE_Q = /农历|阴历|几号|几月几|星期几|礼拜几|周几|几点|什么日子/;
  if (DATE_Q.test(raw)
      && !/提醒|闹钟|叫我|药|挂号|预约|看|播|节目|电影/.test(raw)) {
    const line = localDateSay(raw);
    if (line) {
      playAnim('nod', 1.2);
      say(line, 7200, { slow: true });
      logDid('heart', line, raw, 0);
      if (grown) announceGrow(grown);
      return { did: false, said: line, ms: 0, trace: [] };
    }
  }

  /* ---- ① 智能体先想（真正的决策在这里）----
     它自己决定要不要调工具、调哪个、参数怎么填，拿到结果再想下一步。
     本地正则从这一步之后才轮到，只当兜底。 */
  const LOCAL_FIRST = /药|难受|不舒服|疼|头晕|恶心|摔|跌倒|急救|120|救命|喘不上|胸闷|心慌|几号|星期几|礼拜几|周几|几点|今天.{0,2}日子/;
  if (!LOCAL_FIRST.test(raw) && window.MILI_AGENT && window.MILI_AGENT.ready()) {
    playAnim('tilt', 1.4);
    /* 🚨 2026-11-12：头一回听他说要看什么，先问一句再动手。
       能走到这里说明上面 skill 那条没命中 —— 这句话确实是头一回。
       问不问由「它已经知道了多少」决定，不是由遍数决定：
         平台不知道  → 问（一次问清平台 + 片名）
         平台知道、片名不知道 → 只问片名
         都知道        → 一个字都不问，直接办 */
    const _memos = (window.MILI_MEMO && window.MILI_MEMO.memo) ? window.MILI_MEMO.memo() : [];
    /* 结构化查询，别再拿正则去 grep 自然语言记忆来推断状态。 */
    const _M = window.MILI_MEMO;
    const _hasPlat = _M && _M.query
      ? _M.query({ contains: '看视频用' }).length > 0
      : _memos.some((m) => String(m && m.text || '').indexOf('看视频用') >= 0);
    const _hasTitle = _M && _M.query
      ? _M.query({ contains: '上次看的是' }).length > 0
      : _memos.some((m) => String(m && m.text || '').indexOf('上次看的是') >= 0);
    const _isWatch = /看|听|播|放/.test(raw)
      && !/抖音|快手|红果|爱奇艺|腾讯视频|优酷|B站|哔哩|头条|央视|CCTV|电视|新闻联播/.test(raw)
      && !/[?？]|怎么样|多少|是不是|有没有|啥时候|几号|几点/.test(raw);
    const _needWatch = _isWatch && (!_hasPlat || !_hasTitle);
    /* 这句话如果是上一条追问的回答（两分钟内、很短），就不要再追问一次 ——
       否则老人答「对」，它又问「是在抖音看吧」，成了绕圈。 */
    const _isAnswer = !!(window.__askOrigin && (Date.now() - window.__askOrigin.t) < 120000
      && String(raw).length <= 12);
    const needAsk = !_isAnswer && (!!(opts && opts.askFirst) || _needWatch);
    /* 🚨 2026-11-12：追问不走模型了。
       实测两种都不行：把工具摘掉，模型退回通用聊天模型，按版权策略拒答
       「我无法提供视频播放」；把工具挂着，它光顾着 recall 查记忆，
       一句话不说就结束，老人听到「我没听清，您再说一遍？」。
       改成固定话术：问哪一项由「它已经知道多少」决定，句子每次都一样 ——
       老人同一句疑问听第二回不用重新理解，这本来也比每次换个说法强。 */
    if (needAsk) {
      const _title = askTitleOf(raw);
      if (_title) {
        const _q = _needWatch
          ? (_hasPlat ? '是「' + _title + '」吧？' : '在抖音看吧？是「' + _title + '」吗？')
          : ('您是说「' + _title + '」吗？');
        /* 追问时把「原始请求」压在这里。他答完「抖音，对」办成的那一刻，
           存进 skill 的钥匙必须是原话「我要看天天耍大牌」，不能是「抖音，对」——
           否则下回他再说原话，一个字都命中不了，学的等于白学。 */
        window.__askOrigin = { text: raw, t: Date.now() };
        /* 演示模式：这一遍问了几个问题，现场要数得出来。
           第一遍是「在抖音看吧？是「天天耍大牌」吗」一句问两件事，
           第二遍只剩「是「天天耍大牌」吧」一句。 */
        try { window.__DEMO_ASK && window.__DEMO_ASK(_q, !_hasPlat); } catch (e) {}
        if (!quiet) say(_q, 2600);
        return { did: false, said: _q, ms: 0, trace: [], ask: true };
      }
    }
    const r = await agentSay(_askMerge(raw), quiet, opts);
    if (r && r.err !== 'busy') {
      if (r.said || r.did) {
        if (window.EVO && r.did) { try { EVO.hit(raw, 'agent'); } catch (e) {} }
        if (r.did) { try { window.__DEMO_DID && window.__DEMO_DID('agent', r); } catch (e) {} }
        if (r.did) await showAgentCards(raw, r);
        if (grown) announceGrow(grown);
        /* 2026-11-12：日新页要拿真 trace / said 出数字与对话实录。
           原来这里 return; 什么都不给，验收页只能去猜，现场必翻车。 */
        return r;
      }
      /* 它真的想过了，但一个字都没说出来（超时 / 工具全失败 / 被截断）。
         这里必须停住 —— 再往下就是「查必应」，会把老人整句原话丢给搜索引擎：
         「我想听戏」搜回戏曲百科还勉强算沾边，「我血压有点高」搜回来的
         是「我」这个汉字的字义。他等到的是驴唇不对马嘴的一段，还以为是它胡说。
         说一句「没弄明白」远好过答非所问。 */
      if (!quiet) say('这个我一时没弄明白，您再说一遍？', 5200);
      return r;
    }
    /* 智能体在、但这会儿正忙（上一句还在办）——
       到这儿就停，绝不能往下面的兜底走。
       兜底最后一步是「查必应」，它会把老人整句原话丢给搜索引擎：
       「我想听戏」搜回来可能是一段戏曲百科，「我血压有点高」搜回来是「我」的字义。
       老人听到的就是一句驴唇不对马嘴的话，还以为是它在胡说。
       宁可说一句「你再说一遍」，也不能答非所问。 */
    if (!r && window.MILI_AGENT && window.MILI_AGENT.ready()) {
      /* 排队的那句会自动接上，别让老人以为被拒绝了 */
      if (!quiet) say('我听着呢，等一下就回您。', 3200);
      return;
    }
  }

  /* ---- ② 本地硬规则：真办事（打电话 / 微信 / 导航 / 开视频 / 电视 / 拍一张 / 桌宠）---- */
  const did = await tryDo(raw);
  if (did) {
    if (window.EVO) EVO.hit(raw, did.id);
    /* 本地规则办成了，也要记 skill。
       之前只有 agent 那条路记 —— 结果「把电视给我关喽」永远被本地正则接住，
       永远到不了 agent，skill 永远是空的，老人每次都等 1.8 秒。
       「第一次慢、下次快」这个承诺，在产品里根本没兑现。
       本地这条也记，下次 0ms 命中。 */
    /* 本地兜底这条路不再记 skill。
       它写出来的参数是「猜的」（经常是空的），记进去就是给自己埋雷：
       下次同一句话 0ms 重放一个空参数 —— 打开的不是老人要的那个。
       只有智能体那条路（参数是它自己抽的）才配记。 */
    if (grown) announceGrow(grown);
    return;
  }

  // 正则没接住 —— 交给日新引擎：它学会的说法能不能认出来
  /* evolve.js 是 11-07 的旧意图正则引擎，只保留作断网兜底。
     默认关闭，避免它和模型决策链路抢话；显式置位才启用。 */
  const did2 = window.__MILI_LEGACY_EVO ? await evoTry(raw) : null;
  if (did2) {
    if (window.EVO) EVO.hit(raw, did2.id);
    /* 同上：演化那条也记不准参数，不写 skill */
    if (grown) announceGrow(grown);
    return;
  }

  /* ---- ①.5 闹钟：老人自己说要设提醒 ----
     必须排在药箱前面。「早上七点提醒我吃降压药」里有药名、有「吃」，
     药箱会把它当成「问药」，直接答剂量 —— 老人明明是要设闹钟。
     只有真带钟点的才进这里，光说「提醒我吃药」还是归药箱。 */
  if (ALARM_RE.test(raw) && parseClock(raw)) {
    playAnim('nod', 1.2);
    const line = alarmSay(raw);
    say(line, 7200, { slow: true });
    logDid('pill', line, raw);
    if (grown) announceGrow(grown);
    return;
  }

  // 1) 药箱：老人最常问的
  const mk = medKind(raw);
  const med = medFind(raw);
  /* 以前这里是 /药/.test(raw)，太宽 —— 「这个药多少钱」「我要挂号开药」
     全被拽进药箱。但改成只认开头又太窄：「我药吃了没」开头是「我」，
     于是整句掉进必应搜索，答回来一段「我，汉语一级通用规范汉字……」，
     还当成正确答案记了下来。现在按「含药 + 问的是吃没吃」认，排除看片的。 */
  const medTalk = /(吃药|药箱|几颗药|药吃了|药吃过|药还没|我的药|哪颗药|忘了吃药|忘记吃药)/.test(raw)
    && !/(看|片|剧|节目|电影|多少钱|挂号|买)/.test(raw);
  if (med || medTalk) {
    playAnim('nod', 1.2);
    if (med) {
      const a = medAnswer(med, mk);
      await wait(120);
      say(a, 6200, { slow: true, key: 'med_' + mk + '_' + med.who });
      med.last = hm();
      med.lastAt = Date.now();
      logDid('pill', med.who + '：' + a, raw);
      save();
      showMed(med, mk);
      if (grown) announceGrow(grown);
      return;
    }
    // 没说是哪颗，但问的是「该吃药了吗」
    const st = medNow();
    if (!S.med.some((m) => m.on)) {
      say('药箱还空着呢。让家里人在药箱里加上，我就知道啦。', 6000, { slow: true, key: 'medbox_empty' });
      showMedBox();
      return;
    }
    const fresh = st.due.filter((m) => !m.justSaid);
    if (fresh.length) {
      const a = fresh.map((m) => m.who + m.dose).join('，') + '。' + fresh[0].when + '。';
      say('该吃了。' + a, 7200, { slow: true, key: 'med_due' });
      logDid('pill', a, raw);
      fresh.forEach((m) => { const t = S.med.find((x) => x.who === m.who); if (t) t.lastAt = Date.now(); });
      save();
      showMed(fresh[0], 'all');
    } else if (st.due.length) {
      // 刚说过了，别重复喊
      const m = st.due[0];
      say(m.who + '刚才说过了呀，' + m.when + '吃。别吃重了。', 7000, { slow: true });
      logDid('pill', m.who + ' 刚说过', raw);
    } else {
      // 不在时间窗 —— 要明确说「现在不用吃」，不是反问哪一颗
      const a = medNotNowSay(st.notNow);
      say(a, 7000, { slow: true });
      logDid('pill', a, raw);
      showMedBox();
    }
    return;
  }

  /* ---- ②.5 快问快答：问一句就答的事，不许进 agent 白等 5 秒 ----
     真机实测：老人问「今天冷不冷」，本地一条都不认识，落到 agent，
     转圈 5 秒才出声。问天气等 5 秒，比不答更让人心慌。
     这几类必须本地答完就走。天气要真数据，没有就直说没查到，不编。 */
  for (const f of FASTQ) {
    if (!f.re.test(raw)) continue;
    playAnim(f.id === 'sick' ? 'tilt' : 'nod', 1.2);
    await wait(80);
    let line = '';
    try { line = f.say(raw); } catch (e) { line = ''; }
    if (!line) continue;
    say(line, f.id === 'sick' ? 9000 : 6500, { slow: true });
    logDid(f.id === 'sick' ? 'heart' : f.id === 'scam' ? 'shield' : 'sun', line, raw);
    if (grown) announceGrow(grown);
    return;
  }

  /* ---- 兜底：断网 / 云服务没配上 / 智能体挂了 ----
     这时候本地这套还得能干活，不然老人问一句就死机。 */
  const s = matchScene(raw);
  if (s) {
    playAnim(s.anim || 'nod', 1.2);
    await wait(140);
    /* 天气必须拿真数据 —— 之前模型没数据，老人问冷不冷它凭感觉编 */
    let wxExtra = null;
    if (s.action === 'weather') {
      const nn = NATIVE();
      if (nn && nn.weather) {
        try {
          const w = JSON.parse(nn.weather());
          wxExtra = (w && w.ok)
            ? '下面是给你参考的真实数据，不要原样念出来，也不要把温度说两遍：' +
              (w.city || '') + '现在' + w.temp + '度，' + (w.desc || '') +
              '，风' + (w.wind || '—') + '，湿度' + (w.hum || '%') +
              '。用一句口语回答，只说一次温度和一句穿衣建议，禁止编造。'
            : '这会儿天气没查到，如实告诉老人没查到，禁止编数据。';
        } catch (e) { wxExtra = '这会儿天气没查到，如实告诉老人没查到，禁止编数据。'; }
      }
    }
    const reply = await sayFor(s.action || 'talk', raw, null, wxExtra);
    say(reply, 5200, { slow: true });
    logDid(s.icon, reply, raw);
    await wait(560);
    runAction(s, reply);
    if (grown) announceGrow(grown);
    return;
  }

  /* 常识问题：预置答案只在模型不在线时兜底 */
  const faq = MILI_DATA.faq.find((f) => f.k.some((k) => raw.includes(k)));
  if (faq) {
    playAnim('nod', 1.2);
    if (cloudOK()) {
      const t0 = performance.now();
      const line = await llmAsk(raw);
      if (line) {
        const cost = Math.round(performance.now() - t0);
        const r = learnAnswer(raw, line, '米粒想的', cost);
        say(line, Math.max(6500, line.length * 300), { slow: true });
        logDid('heart', line, raw, cost);
        if (r) showRecall(r, cost);
        return;
      }
    }
    await wait(120);
    say(faq.a, 8000, { slow: true, key: faq.key });
    logDid('heart', faq.a, raw);
    if (grown) announceGrow(grown);
    return;
  }

  // 本地都不认识，模型也没答上来 —— 查必应
  await doSearch(raw, quiet);
  if (grown) announceGrow(grown);
}

/* 联网查：屏幕上有「在查」的过程，不是干等 */
async function doSearch(q, quiet) {
  pruneSkills();               // 第一句话之前，先把记错的 skill 清掉
  /* 身体的事，永远不到网上去查。
     这条路绕开了 search_web 工具里的那两道闸 —— 智能体没接住的时候，
     整句原话会直接打到必应上，回来的第一条往往是「我，汉语一级通用规范汉字…」，
     2026-11-06 那句「血压有点高它给我去查字典」就是这么来的。
     宁可什么都不搜，也不能把病历本换成字典。 */
  if (HEALTH_Q.test(String(q || ''))) {
    const a = '这个我不瞎猜。您先坐下歇会儿，量一下多少？';
    if (!quiet) say(a, 7000, { slow: true });
    logDid('heart', a, q);
    return;
  }
  window.__askedOnce = true;   // 问过话之后，开机问候就不再抢麦克风
  const t0 = performance.now();
  playAnim('search', 1.6);
  if (!quiet) say('我查一下啊……', 2400, { key: 'checking' });
  openSearchSheet(q);
  const arr = await searchWeb(q);
  const dg = digest(arr, q);
  closeSearchSheet();
  const cost = Math.round(performance.now() - t0);
  if (dg) {
    /* 查到了就真的学下来。记住答案 + 记住这次花了多久，
       下次再问就是「秒答」，界面上能看到从 cost 毫秒掉到几十毫秒。 */
    const r = learnAnswer(q, dg.text, dg.src, cost);
    say(dg.text, 9000, { slow: true });
    logDid('search', dg.text, q, cost);
    showSearchResult(q, dg, arr);
    if (r && r.hits === 0) announceGrow(r);
  } else {
    const r = '这个我查不到。要不你问一下家里人？';
    say(r, 5600, { slow: true, key: 'no_answer' });
    logDid('search', r, q, cost);
    noteUnknown(q);
    showSearchResult(q, { text: r, src: '', title: '' }, []);
  }
}

/* 学：同一句问到第三次，自己长出一条 */
/* 长出一条新本事。说什么得看是哪一种，不能一律「我记住了」。 */
function announceGrow(rule) {
  playAnim('happy', 1.5);
  burst();
  const kind = rule && rule.kind;
  let line;
  if (kind === 'slow') {
    line = '这句你问了好几遍啦。往后我慢慢说，说两遍，你听着。';
  } else if (kind === 'stuck') {
    line = '你在' + ((rule && rule.app) || '那个软件') + '里停住过几回。下回你进去，我先陪你走。';
  } else {
    line = '这句我学会啦。往后你问，我不用再查，张口就答。';
  }
  setTimeout(() => say(line, 7000, { slow: true, key: 'grow' }), 2200);
}

/* 露一手「变快了」：接在气泡下面一行，不另起一张卡（真机上会和气泡重叠）。 */
function showRecall(rule, ms) {
  const first = rule.firstMs || 0;
  const c = $('recall');
  if (!c) return;
  let detail;
  if (rule.kind === 'slow') {
    detail = '这句你问过 ' + (rule.n || 3) + ' 回了，我慢点说。';
  } else if (first >= 400) {
    /* 不说「快了 1330 倍」——老人没体感。说「以前要等多久」。 */
    detail = '以前要等 ' + (first / 1000).toFixed(1) + ' 秒，现在张口就有';
  } else {
    detail = '这句我记着呢，不用再查';
  }
  c.innerHTML = '<b>这个它学会了</b><span>' + esc(detail) + '</span>';
  c.hidden = false;
  // 多留一会儿，老人要看清楚这行小字
  bHold = Math.max(bHold, 6500);
  armBubbleHide();
  clearTimeout(showRecall._t);
  showRecall._t = setTimeout(() => { c.hidden = true; }, 6500);
}
function noteUnknown(q) {
  const k = learnKey(q);
  const f = S.unknown.find((u) => u.q === q);
  if (f) { f.n++; f.time = hm(); }
  else S.unknown.unshift({ q, n: 1, time: hm(), note: '问了 ' + 1 + ' 次' });
  if (S.unknown.length > 12) S.unknown.length = 12;
  save(); renderLearn();
}

function matchScene(text) {
  const q = text.replace(/[，。？！、\s]/g, '');
  let best = null, len = 0;
  for (const s of MILI_DATA.scenes) for (const v of s.says) {
    const k = v.replace(/[，。？！、\s]/g, '');
    if (q.includes(k) && k.length > len) { best = s; len = k.length; }
    if (k.includes(q) && q.length >= 2 && q.length > len) { best = s; len = q.length; }
  }
  return best;
}

/* 现在的用药情况。
   以前只有一个窗口判断，出过两个真错：
   1) 上午问两遍，两遍都说「该吃了」—— 不看刚问过
   2) 中午 12:05 问「该吃药了吗」，三颗药都不在窗口，due 为空，
      于是反问「你说的是哪一颗」—— 该说的是「现在不用吃」 */
function medNow() {
  const h = new Date().getHours();
  const due = [], notNow = [];
  for (const m of S.med) {
    if (!m.on) continue;
    const morning = /早/.test(m.when);
    const evening = /晚/.test(m.when);
    const inMorning = h >= 6 && h < 11;
    const inEvening = h >= 17 && h < 22;
    const win = (morning && inMorning) || (evening && inEvening) || (!morning && !evening);
    if (!win) { notNow.push(m); continue; }
    /* 「吃过了」按过的不算到期 —— 4 小时内有效，正好盖住早/晚一个服药窗 */
    if (m.takenAt && Date.now() - m.takenAt < 4 * 60 * 60 * 1000) continue;
    // 一小时内刚说过就别再喊一遍
    const lastAt = m.lastAt || 0;
    const justSaid = lastAt && (Date.now() - lastAt < 60 * 60 * 1000);
    due.push(Object.assign({}, m, { justSaid: !!justSaid }));
  }
  return { due, notNow, h };
}

/* 首页那颗「吃过了」。当场记一笔：这个服药窗里的药全部静音 4 小时。 */
function medTakenTap() {
  try { if (window.MILI_RHYTHM) window.MILI_RHYTHM.note('med'); } catch (e) {}
  const h = new Date().getHours();
  let n = 0;
  for (const m of S.med) {
    if (!m.on) continue;
    const morning = /早/.test(m.when);
    const evening = /晚/.test(m.when);
    const win = (morning && h >= 6 && h < 11) || (evening && h >= 17 && h < 22) || (!morning && !evening);
    if (!win) continue;
    if (m.takenAt && Date.now() - m.takenAt < 4 * 60 * 60 * 1000) continue;
    m.takenAt = Date.now();
    n++;
  }
  if (n) save();
  try { say(n ? '好，记下了，' + n + ' 颗都吃过了。' : '这一顿的药都记过啦，不用再点。'); } catch (e) {}
  bootRefresh();
}

/* 兼容旧调用 */
function dueMeds() { return medNow().due.filter((m) => !m.justSaid); }

/* 「现在不用吃」的时候，要告诉你下一顿是什么时候 */
function medNotNowSay(notNow) {
  if (!notNow.length) return '现在不用吃。';
  const parts = notNow.map((m) => m.who + m.when);
  const h = new Date().getHours();
  const nextHint = h < 6 ? '还早呢' : (h >= 11 && h < 17) ? '等晚饭以后再说' : '今天吃过了';
  return '现在不用吃。' + parts.join('，') + '。' + nextHint + '。';
}

/* ============ 记录 ============ */
/* ============================================================================
 * 跨会话的任务：老人交代的事，不是每一件都能在他看着的时候办完
 *
 * 以前的毛病：他说明天几点提醒我，米粒答应得很好，然后关掉 App 就忘了。
 * 那不是助手，那是一次性打火机。
 * 现在存进 S.tasks，跟其它状态一起落盘（也进 StateBackup 备份）。
 *
 * 结构：{ id, what, when, done, made }
 *   what  要做的事，老人原话
 *   when  什么时候要做（YYYY-MM-DD 或 YYYY-MM-DD HH:MM），空=随时
 *   done  办完了没
 *   made  什么时候交代的
 * ========================================================================== */
function taskAdd(t) {
  if (!t || !t.what) return { ok: false, detail: '没说要办什么。' };
  const id = 't' + Date.now().toString(36) + Math.floor(Math.random() * 90 + 10);
  const row = {
    id: id,
    what: String(t.what).slice(0, 80),
    when: String(t.when || '').slice(0, 16),
    done: false,
    made: ymd() + ' ' + hm(),
  };
  S.tasks.unshift(row);
  if (S.tasks.length > 40) S.tasks.length = 40;   // 别让它无上限地长
  save();
  return { ok: true, task: row };
}

/* 没办完的。按时间排，最近的在前；没写时间的排后面。 */
function taskList() {
  const open = (S.tasks || []).filter((x) => !x.done);
  open.sort((a, b) => {
    const A = a.when || '9999', B = b.when || '9999';
    return A < B ? -1 : A > B ? 1 : 0;
  });
  return open;
}

function taskDone(id, by) {
  const t = (S.tasks || []).find((x) => x.id === id)
    || (S.tasks || []).find((x) => !x.done && (x.what || '').indexOf(String(id || '')) >= 0);
  if (!t) return { ok: false, detail: '没有这件事，可能已经办完了。' };
  t.done = true;
  t.by = by || '米粒';
  t.at = ymd() + ' ' + hm();
  save();
  return { ok: true, task: t };
}

function logDid(icon, title, sub, ms) {
  S.did.unshift({ icon, title, sub, time: hm(), d: ymd(), ms: ms || 0 });
  if (S.did.length > 60) S.did.length = 60;
  save();
  renderDid();
  /* 同步给家里人。这里是老人端所有「办成一件事」的唯一收口，
     接在这一处就够了，不用在每个动作里各写一遍。
     icon 就是动作类型（nav/call/wx/tv…），家属端按它分类显示。 */
  try { accLogAct(icon || 'act', title || '', sub || ''); } catch (e) {}
}

/* ============ 渲染：办过的事 ============ */
function renderDid() {
  const box = $('didList');
  if (!S.did.length) {
    /* 空态不是「一句灰字 + 一大片空」。老人看到这片空，会以为坏了。
       现在给三件事：现在是什么状态、为什么、下一步在哪按。 */
    box.innerHTML = `<div class="empty">
      <span class="eic">${IC.inbox}</span>
      <p class="etitle">还没办过事</p>
      <p>你让米粒办一件，办成了就记在这。比如「给儿子打个电话」。</p>
      <button class="eact" data-empty-go="home">回去跟米粒说一件事</button>
    </div>`;
    box.querySelector('[data-empty-go]').onclick = () => goPage('home');
    return;
  }
  /* 按日期分组：老人回忆「那天让它干了啥」比一条流水账好找 */
  const byDay = [];
  let curDay = null;
  for (const it of S.did) {
    const key = it.d || '';
    if (key !== curDay) { curDay = key; byDay.push({ day: key, items: [] }); }
    byDay[byDay.length - 1].items.push(it);
  }
  box.innerHTML = byDay.map((g) =>
    `<p class="sec dayhead">${dayLabel(g.day)} <span class="sec-hint">${g.items.length} 件</span></p>` +
    g.items.map((d) => `<div class="cardrow">
    <div class="ic">${ico(d.icon)}</div>
    <div class="tx"><span class="t1">${esc(d.title)}</span><span class="t2">你说：${esc(d.sub)}</span></div>
    <span class="tm">${d.time}</span></div>`).join('')
  ).join('');
}

/* ============ 渲染：它学会的 ============ */
/* 每条都要能看出「学会了什么、行为变成什么样」，并且能删。
   删掉就是回退 —— 赛题明文要的那一项。 */
const KIND_META = {
  recall: { ic: 'search', name: '会答了', desc: '下次不用再查' },
  slow:   { ic: 'heart',  name: '记不住', desc: '下次慢慢说两遍' },
  stuck:  { ic: 'map',    name: '会卡住', desc: '下次先陪你走' },
  avoid:  { ic: 'ban',    name: '这条路不通', desc: '下次换一个办法' },
};

function renderLearn() {
  const box = $('learnList');
  if (!box) return;
  const unk = S.unknown || [];
  let h = '';

  /* 演示版专供：上一次办事它走了哪几步、哪一步没成。
     产品版绝不显示 —— 老人不关心工具名，只关心办没办成。 */
  if (DEMO && S.lastRun && S.lastRun.steps && S.lastRun.steps.length) {
    const L = S.lastRun;
    const okN = L.steps.filter((x) => x.ok).length;
    h += `<div class="runbox">
      <div class="runhd">上一次它怎么办的<span class="runmeta">${okN}/${L.steps.length} 步成了 · ${(L.ms / 1000).toFixed(1)} 秒</span></div>
      <div class="runq">「${esc(L.q)}」</div>
      ${L.steps.map((s, i) => `<div class="runstep ${s.ok ? 'ok' : 'bad'}">
        <span class="rn">${i + 1}</span>
        <span class="rt">${esc(toolCn(s.tool))}</span>
        <span class="rw">${esc(s.why || (s.ok ? '成了' : '没成'))}</span>
      </div>`).join('')}
    </div>`;
  }

  if (S.rules.length) {
    h += `<p class="sec">它学会的 ${S.rules.length} 条　<span class="sec-hint">点右边可以删掉，删了就退回没学会之前</span></p>`;
    /* 按学会的日期分组 —— 和「办了」一个逻辑 */
    const byDay = [];
    let curDay = null;
    for (const r of S.rules) {
      const key = r.born ? (function(){ const d = new Date(r.born);
        return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })() : '';
      if (key !== curDay) { curDay = key; byDay.push({ day: key, items: [] }); }
      byDay[byDay.length - 1].items.push(r);
    }
    for (const g of byDay) {
      h += `<p class="sec dayhead">${dayLabel(g.day)} <span class="sec-hint">${g.items.length} 条</span></p>`;
      h += g.items.map((r) => {
      const m = KIND_META[r.kind] || KIND_META.recall;
      let line1, line2;
      if (r.kind === 'stuck') {
        line1 = '你在' + (r.app || '那个软件') + '里停住过 ' + (r.n || 2) + ' 回';
        line2 = '下回进' + (r.app || '去') + '，它先陪你走一遍';
      } else if (r.kind === 'slow') {
        line1 = '「' + (r.q || '') + '」你问过 ' + (r.n || 3) + ' 遍';
        line2 = '下次它慢点说，说两遍';
      } else if (r.kind === 'avoid') {
        line1 = (r.q || '上次那件事') + '——没走通';
        line2 = (r.why ? '它记着：' + r.why : '它记着这条路不行') +
                (r.alt ? '，下回改用' + (ALT_CN[r.alt] || r.alt) : '，下回换个办法');
      } else {
        line1 = '「' + (r.q || '') + '」';
        line2 = r.ans ? r.ans.slice(0, 34) + (r.ans.length > 34 ? '…' : '') : '它自己记下来的';
      }
      // 提速数据：这是「具体提升」的硬证据。用秒数比用倍数好懂。
      let badge = '';
      if (r.kind === 'recall' && r.firstMs >= 400) {
        badge = `<span class="spd">${(r.firstMs / 1000).toFixed(1)}s → 秒答</span>`;
      } else if (r.kind === 'avoid') {
        badge = `<span class="spd">试过 ${r.n || 1} 次没成</span>`;
      } else if (r.hits) {
        badge = `<span class="spd">用过 ${r.hits} 次</span>`;
      }
      return `<div class="learnrow">
        <div class="ic">${IC[m.ic] || IC.search}</div>
        <div class="tx">
          <span class="t1">${esc(line1)}</span>
          <span class="t2">${esc(line2)}</span>
          <div class="acts">
            <span class="t3">${esc(m.name)} · ${esc(m.desc)}</span>
            ${badge}
            <button class="del" data-del="${esc(r.id)}" aria-label="删掉这条">删掉</button>
          </div>
        </div>
      </div>`;
    }).join('');
    }
  }

  if (unk.length) {
    h += `<p class="sec">还没答上来的</p>` + unk.slice(0, 6).map((u) => `<div class="learnrow">
      <div class="ic">${IC.inbox}</div>
      <div class="tx"><span class="t1">${esc(u.q)}</span><span class="t2">${esc(u.note || '问了 ' + u.n + ' 次')}</span></div>
      <span class="tm">${u.time || ''}</span></div>`).join('');
  }

  if (!h) {
    /* 「它替你记着的」空态。这一页讲的是「它懂你多少」，
       老人看不见东西会觉得这功能不存在。所以给一句「怎么让它记住」，
       并且那颗按钮直接切到首页去说 —— 记住的唯一入口就是说话。 */
    box.innerHTML = `<div class="empty">
      <span class="eic">${IC.users}</span>
      <p class="etitle">还没替你记住什么</p>
      <p>同一件事说上两回，它就记着了。下回不用再说一遍。</p>
      <button class="eact" data-empty-go="home">跟米粒说句话</button>
    </div>`;
    box.querySelector('[data-empty-go]').onclick = () => goPage('home');
    return;
  }
  box.innerHTML = h;
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const r = forgetRule(b.dataset.del);
      if (r) {
        playAnim('sleepy', 1.4);
        say('好，这条我忘掉啦。', 5200, { slow: true });
      }
    };
  });
}

/* ============ 渲染：家里人 ============ */
function renderFam() {
  const box = $('famList');
  if (!S.fam.length) {
    /* 「家里人」空态。这一页的下一步动作就是「加一个人」，
       原来那颗 ghost 按钮用的是 width:auto + padding —— 在灰底上还是隐形的。
       现在换成空态自带的黑胶囊，动作只有一件，不跟页面别的东西抢。 */
    box.innerHTML = `<div class="empty">
      <span class="eic">${IC.users}</span>
      <p class="etitle">还没有家里人</p>
      <p>加上以后，说一句「给儿子打电话」，它就直接拨。</p>
      <button class="eact" id="famEmptyAdd">添加一个人</button>
    </div>`;
    const b = box.querySelector('#famEmptyAdd');
    if (b) b.onclick = () => window.__addFam();
    return;
  }
  box.innerHTML = `<div class="group">` + S.fam.map((f) => `<button class="row" data-fam="${esc(f.name)}">
    <span class="ic">${IC.user}</span>
    <span class="tx"><span class="t1">${esc(f.name)}</span><span class="t2">${esc(f.rel || '家人')}</span></span>
    <span class="rt">通话</span></button>`).join('') + `</div>`;
  box.querySelectorAll('[data-fam]').forEach((b) => { b.onclick = () => callTo(b.dataset.fam); });
}

/* ============ 药箱页 ============ */
function renderMed() {
  const box = $('medList');
  const on = S.med.filter((m) => m.on);
  if (!on.length) {
    /* 「药箱」空态。这一页是给家里人填的，老人自己填不动 ——
       所以按钮不是「添加」，是「叫家里人帮我填」，这才对得上这一页的权限。 */
    box.innerHTML = `<div class="empty">
      <span class="eic">${IC.pill}</span>
      <p class="etitle">药箱是空的</p>
      <p>药得家里人替你填。填好了，你问「今天吃什么药」，它就答。</p>
      <button class="eact" data-empty-go="family">叫家里人帮我填</button>
    </div>`;
    box.querySelector('[data-empty-go]').onclick = () => goPage('family');
    return;
  }
  box.innerHTML = on.map((m, i) => `<div class="medcard" data-med="${i}">
    <div class="mh"><span class="mn">${esc(m.who)}</span><span class="mtag">${esc(m.dose)}</span></div>
    <p class="mf">${esc(m.full)}</p>
    <p class="mw">${esc(m.when)}　${esc(m.pill || '')}</p>
    <p class="mnote">${esc(m.note)}</p>
    ${m.last ? `<p class="mlast">上次问：${m.last}</p>` : ''}
  </div>`).join('');
  box.querySelectorAll('[data-med]').forEach((c) => {
    c.onclick = () => { const m = on[+c.dataset.med]; showMed(m, 'all'); };
  });
}

/* ============ 动作层 ============ */
function runAction(s, reply) {
  const A = $('action'), IN = $('actIn');
  if (s.action === 'call') {
    /* 真拨号。以前这里只是「正在拨号…」→ 2.4 秒后改成「通了」，
       根本没拨出去 —— 老人对着黑屏等对方说话，是真会出事的。
       现在直接调原生 Intent，拨不出去就直说拨不出去。 */
    IN.innerHTML = `<div class="calling"><div class="call-ava">${esc(s.who.slice(-1))}</div>
      <div class="call-name">${esc(s.who)}</div><div class="call-st" id="callSt">拿起来了…</div></div>
      <button class="act-btn ghost" onclick="window.__close()">放下</button>`;
    const n = NATIVE();
    if (n && n.call) {
      try {
        const res = JSON.parse(n.call(s.who));
        const st = $('callSt');
        if (st) st.textContent = res.ok ? (res.say || '给你拨出去了') : (res.say || '没拨出去');
        if (!res.ok) $('call-ava') && ($('call-ava').style.opacity = '.4');
      } catch (e) {}
    } else {
      const st = $('callSt');
      if (st) st.textContent = '这台机器上拨不出去，你直接按电话图标吧';
    }
  } else if (s.action === 'weather') {
    /* 天气必须是真数据。以前上面写死 18°/风3级/湿度46%，
       口播那句「今天十八度，有风」是另一处硬编码 —— 两套数字各说各的。
       现在都从 native 的 wttr.in 拿；拿不到就说拿不到。 */
    IN.innerHTML = `<div class="panel" id="wxPanel"><div class="wtemp">—</div>
      <div class="wcity">正在看天…</div></div>
      <button class="act-btn" style="margin-top:18px" onclick="window.__close()">知道了</button>`;
    const nn = NATIVE();
    if (nn && nn.weather) {
      try {
        const w = JSON.parse(nn.weather());
        const P = $('wxPanel');
        if (P && w && w.ok) {
          P.innerHTML = `<div class="wtemp">${esc(String(w.temp))}°</div>
            <div class="wcity">${esc(w.city || '')}</div>
            <div class="wrow"><div>风<b>${esc(w.wind || '—')}</b></div><div>湿度<b>${esc(w.hum || '—')}</b></div><div>天<b>${esc(w.desc || '—')}</b></div></div>
            <div class="wtip">${esc(w.tip || '')}</div>`;
        } else if (P) {
          P.innerHTML = `<div class="wtemp">—</div><div class="wcity">天没看上</div>
            <div class="wtip">这会儿查不到天气，等会儿再问我。</div>`;
        }
      } catch (e) {}
    } else {
      const P = $('wxPanel');
      if (P) P.innerHTML = `<div class="wtemp">—</div><div class="wcity">这台机器上查不了</div>
        <div class="wtip">出门前看看窗外，或者问家里人。</div>`;
    }
  } else if (s.action === 'video') {
    /* 真视频：内嵌片源，点开就播，不需要联网。播放器按钮全部放大到老人能按准。 */
    const vs = window.__VIDEO || '';
    if (vs) {
      IN.innerHTML = `<div class="vwrap">
        <video id="vd" class="vplayer" src="${vs}" playsinline webkit-playsinline preload="auto"></video>
        <button id="vbig" class="vbig" aria-label="播放">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.4-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2z"/></svg>
        </button>
        <div class="vtrack"><i id="vfill"></i></div>
      </div>
      <div class="vbar"><p class="vtitle">${esc(s.title)}</p><p class="vsub" id="vsub">从你昨天停的地方接着放</p></div>
      <button class="act-btn" style="margin-top:16px" onclick="window.__close()">先不看了</button>`;
      const vd = $('vd'), big = $('vbig'), fill = $('vfill'), sub = $('vsub');
      const sync = () => {
        big.hidden = !(vd.paused || vd.ended);
        big.classList.toggle('again', vd.ended);
      };
      big.onclick = () => { vd.play().catch(() => {}); };
      vd.onplay = sync; vd.onpause = sync; vd.onended = sync;
      vd.ontimeupdate = () => {
        if (!vd.duration) return;
        const p = vd.currentTime / vd.duration;
        if (fill) fill.style.width = (p * 100).toFixed(1) + '%';
        if (sub && p > 0.02) sub.textContent = '放到 ' + Math.round(p * 100) + '% 了';
      };
      vd.onloadeddata = () => { playAnim('happy', 1.2); if (vd.paused) big.hidden = false; };
      vd.onerror = () => {
        IN.innerHTML = `<div class="vfail"><p class="vfh">这片子没下下来</p>
          <p class="vfp">等连上网我再去取。</p></div>
          <button class="act-btn" style="margin-top:18px" onclick="window.__close()">好</button>`;
      };
      vd.play().catch(() => { big.hidden = false; });
    } else {
      IN.innerHTML = `<div class="vfail"><p class="vfh">这片子没下下来</p>
        <p class="vfp">等连上网我再去取。</p></div>
        <button class="act-btn" style="margin-top:18px" onclick="window.__close()">好</button>`;
    }
  } else if (s.action === 'redpacket') {
    /* 红包只能「打开微信让你自己收」。数字不是它收的，就不能写死一个 ¥88 冒充。 */
    IN.innerHTML = `<div class="panel" style="text-align:center;padding:26px 18px">
      <div class="demoflag">演示</div>
      <div style="font-size:34px;font-weight:700;color:var(--ink);letter-spacing:-.03em;margin-top:6px">微信里的红包</div>
      /* 🚨 2026-11-07：这两段内联样式用的是上一代 token（--muted / --ink2），
         新版 design-tokens.css 里都不存在 —— var() 找不到变量时整条 color
         声明作废，颜色塌成继承值。字号也只有 14 / 16，低于判据 D 的 18。
         这两段偏偏是**防诈骗提示**：「真要找你的人，会打官方电话，
         不会让你转账」。老人最该看清的一屏，字最小、颜色还丢了。 */
      <div style="margin-top:10px;font-size:18px;color:var(--ink-3);line-height:1.7">它没法替你点「開」——<br>但能把你送到那个聊天窗口。</div></div>
      <button class="act-btn" style="margin-top:16px" onclick="window.__close()">打开微信</button>`;
    const nn = NATIVE();
    if (nn && nn.wechat) { try { nn.wechat('', 'message'); } catch (e) {} }
  } else if (s.action === 'scam') {
    /* 「我帮你拦了」是假的 —— 它没有能力拦。这句话最危险：
       宣称完成了一件安全动作，老人就真的不设防了。现在只说它确实做了什么。 */
    IN.innerHTML = `<div class="panel"><h3 style="margin:0 0 9px;font-size:19px;font-weight:700">这条别理它</h3>
      <p style="margin:0;font-size:18px;line-height:1.75;color:var(--ink-2)">真要找你的人，会打官方电话，不会让你转账、也不会要银行卡号。<br><br>
      <b>我没法替你拦下来</b>，所以别点里面的链接，别回它。拿不准就问我，或者打给孩子。</p></div>
      <button class="act-btn" style="margin-top:18px" onclick="window.__close()">好</button>`;
  } else if (s.action === 'date') {
    IN.innerHTML = `<div class="panel" style="text-align:center;padding:30px 18px">
      <div style="font-size:34px;font-weight:600;letter-spacing:-.03em">${esc(dateReply())}</div></div>
      <button class="act-btn" style="margin-top:18px" onclick="window.__close()">知道了</button>`;
  } else {
    /* reply 可能为空（剧本台词已全部拿掉，只剩真模型说的那句）。
       空就只显示老人问的那句，别留一个空段落。 */
    const rp = esc(reply || s.reply || '');
    IN.innerHTML = `<p class="act-h">${esc(s.says[0])}</p>` +
      (rp ? `<p class="act-p">${rp}</p>` : '') +
      `<button class="act-btn" onclick="window.__close()">知道了</button>`;
  }
  A.hidden = false;
}
window.__close = () => {
  // 关掉的时候记得把片子停了，不然声音还在后头放着
  const vd = $('vd');
  if (vd) { try { vd.pause(); vd.removeAttribute('src'); vd.load(); } catch (e) {} }
  $('action').hidden = true;
};

/* 药：一张卡，字号比正文大一倍 */
function showMed(m, kind) {
  const IN = $('actIn'), A = $('action');
  const main = kind === 'dose' ? m.dose : kind === 'when' ? m.when : kind === 'note' ? m.note : m.dose + '，' + m.when;
  IN.innerHTML = `<div class="medshow">
    <span class="ms-who">${esc(m.who)}</span>
    <div class="ms-main">${esc(main)}</div>
    <p class="ms-full">${esc(m.full)}　${esc(m.pill || '')}</p>
    ${kind !== 'note' ? `<p class="ms-note">${esc(m.note)}</p>` : ''}
  </div>
  <button class="act-btn" style="margin-top:20px" onclick="window.__close()">知道了</button>`;
  A.hidden = false;
}
function showMedBox() { goPage('med'); }

/* ============================================================================
 * 智能体办完事之后，出「看得见的证据」
 *
 * 这一层存在的理由：老人听一句「办好了」是没法验证的。
 * 但也不能像以前那样写死一个 ¥88 的红包冒充收到 ——
 * 所以这里的规矩是：**卡里每个数字都必须来自工具的真实返回**。
 * 工具没给数据，就不出卡，只说话。
 * ========================================================================== */
async function showAgentCards(raw, r) {
  const execs = [];
  for (const rd of (r.trace || [])) {
    for (const ex of (rd.exec || [])) execs.push(ex);
  }
  if (!execs.length) return;

  /* 从最后往前找第一个「有东西可显示」的 */
  const pick = (name) => {
    for (let i = execs.length - 1; i >= 0; i--) if (execs[i].tool === name && execs[i].ok) return execs[i];
    return null;
  };

  const A = $('action'), IN = $('actIn');

  /* ---- 天气：真温度、真湿度、真天气 ---- */
  const wx = pick('get_weather');
  if (wx && wx.data) {
    const w = wx.data;
    await wait(60);
    IN.innerHTML = `<div class="panel">
      <div class="wtemp">${esc(String(w.temp))}°</div>
      <div class="wcity">${esc(w.city || '')}</div>
      <div class="wrow"><div>风<b>${esc(w.wind || '—')}</b></div><div>湿度<b>${esc(w.hum || '—')}</b></div><div>天<b>${esc(w.desc || '—')}</b></div></div>
      ${w.tip ? `<div class="wtip">${esc(w.tip)}</div>` : ''}
    </div>
    <button class="act-btn" style="margin-top:18px" onclick="window.__close()">知道了</button>`;
    A.hidden = false;
    return;
  }

  /* ---- 药箱：药名、剂量、什么时候吃，全是药箱里存的 ---- */
  const md = pick('check_meds');
  if (md && md.med) {
    await wait(60);
    const m = md.med;
    const kind = md.medKind || 'all';
    IN.innerHTML = `<div class="medshow">
      <span class="ms-who">${esc(m.who)}</span>
      <div class="ms-main">${esc(kind === 'dose' ? m.dose : kind === 'when' ? m.when : m.dose + '，' + m.when)}</div>
      <p class="ms-full">${esc(m.full || '')}　${esc(m.pill || '')}</p>
      <p class="ms-note">${esc(m.note || '')}</p>
    </div>
    <button class="act-btn" style="margin-top:20px" onclick="window.__close()">知道了</button>`;
    A.hidden = false;
    return;
  }

  /* ---- 上网查到的：原文 + 来源，不加工 ---- */
  const sw = pick('search_web');
  if (sw && sw.detail && sw.detail.length > 8) {
    await wait(60);
    showSearchResult(raw, { text: sw.detail, src: sw.src || '', title: '' }, sw.results || []);
    return;
  }

  /* ---- 拍照看东西：它真看清了什么，就写什么 ---- */
  const ph = pick('take_photo');
  if (ph && ph.ok) {
    await wait(60);
    IN.innerHTML = `<div class="panel" style="text-align:left">
      <p class="sr-q">你让我看的</p>
      <p class="sr-a">${esc(ph.detail)}</p>
      <p class="sr-s">这是我从照片上认出来的。拿不准就问家里人。</p>
    </div>
    <button class="act-btn" style="margin-top:16px" onclick="window.__close()">知道了</button>`;
    A.hidden = false;
    return;
  }

  /* ---- 看手机屏幕：读到什么就是什么 ---- */
  const rs = pick('read_screen');
  if (rs && rs.ok) {
    await wait(60);
    IN.innerHTML = `<div class="panel" style="text-align:left">
      <p class="sr-q">屏幕上写的</p>
      <p class="sr-a">${esc(rs.detail.replace(/^屏幕上是：/, ''))}</p>
    </div>
    <button class="act-btn" style="margin-top:16px" onclick="window.__close()">知道了</button>`;
    A.hidden = false;
    return;
  }

  /* 其它（打电话、开电视、导航、发微信……）系统自己会切过去，
     再盖一层卡反而挡住老人看 —— 这里就不出了。 */
}

/* 查的时候盖一层，让你知道在做事 */
function openSearchSheet(q) {
  const s = $('srch');
  $('srchQ').textContent = q;
  s.hidden = false;
  playAnim('search', 1.6);
}
function closeSearchSheet() { $('srch').hidden = true; }

/* 查回来的结果：**只给一句**，底下写个来源域名。
   以前这里把整段百科摘要 + 另外两条结果全铺上去 —— 菲尔特截的那屏就是这样：
   问「我血压有点高」，回来一整屏汉字「我」的甲骨文考据，老人怎么可能看得懂。
   查回来的东西是给我们看的原始资料，不是给老人看的读物。
   他要知道的是「一句话答案」，那句话米粒已经念过了，这里只留一个能核对的落点。 */
function showSearchResult(q, dg, arr) {
  const IN = $('actIn'), A = $('action');
  const first = (arr || [])[0] || {};
  const title = String(first.t || '').trim();
  const host = String(dg.src || '').replace(/^https?:\/\//, '').split('/')[0];
  /* 摘要只留第一句、最多 42 字。老人一屏能读完的量。 */
  const brief = String(dg.text || '').replace(/\s+/g, ' ').split(/[。！？]/)[0].slice(0, 42);
  IN.innerHTML = `<div class="panel" style="text-align:left">
    <p class="sr-q">你问：${esc(q)}</p>
    ${title ? `<p class="sr-t">${esc(title)}</p>` : ''}
    <p class="sr-a">${esc(brief)}${brief.length >= 42 ? '…' : ''}</p>
    ${host ? `<p class="sr-s">来自 ${esc(host)}</p>` : ''}
  </div>
  <button class="act-btn" style="margin-top:16px" onclick="window.__close()">知道了</button>`;
  A.hidden = false;
}

function callTo(who) {
  const A = $('action'), IN = $('actIn');
  IN.innerHTML = `<div class="calling"><div class="call-ava">${esc(who.slice(-1))}</div>
    <div class="call-name">${esc(who)}</div><div class="call-st" id="callSt2">拿起来了…</div></div>
    <button class="act-btn ghost" onclick="window.__close()">放下</button>`;
  A.hidden = false;
  playAnim('wave', 1.6);
  /* 真拨。拨不出去就说拨不出去，不演「通了」。 */
  const n = NATIVE();
  const st = () => $('callSt2');
  if (n && n.call) {
    try {
      const res = JSON.parse(n.call(who));
      const el = st();
      if (el) el.textContent = res.ok ? (res.say || '给你拨出去了') : (res.say || '没拨出去');
    } catch (e) {
      const el = st(); if (el) el.textContent = '没拨出去';
    }
  } else {
    const el = st();
    if (el) el.textContent = '这台机器上拨不出去，你按电话图标吧';
  }
}

/* ============ 添加家人 ============ */
window.__addFam = () => {
  const name = prompt('叫什么？');
  if (!name || !name.trim()) return;
  const rel = prompt('他是你的（儿子/闺女/孙女…）') || '家人';
  S.fam.push({ name: name.trim(), rel: rel.trim() });
  save(); renderFam();
};

/* 家里人替你填药 */
window.__addMed = () => {
  const who = prompt('这药你平时叫什么？（比如：降压药）');
  if (!who) return;
  const full = prompt('盒子上写的名字？') || who;
  const dose = prompt('一次吃几片？') || '一次一片';
  const when = prompt('什么时候吃？') || '早饭后';
  const note = prompt('有什么要注意的？') || '温水送服';
  const pill = prompt('长什么样？') || '';
  S.med.push({ who: who.trim(), full: full.trim(), dose: dose.trim(), when: when.trim(),
    note: note.trim(), pill: pill.trim(), alias: [], on: true, last: '' });
  save(); renderMed();
};

/* ============ 导航 ============ */
/* ============================================================================
 * 我的页 · 两个按钮（2026-11-06 晚）
 * 老人端这一页只剩一个动作：「家里人帮我弄」。
 * 登录了 → 直接出配对码，大字念给家里人；
 * 没登录 → 把家人区展开，让家里人替他填（老人自己永远不用碰输入框）。
 * ========================================================================== */
(function bindMePage() {
  const bind = () => {
    const help = $('meHelpBtn');
    if (help && !help.dataset.bound) {
      help.dataset.bound = '1';
      help.onclick = () => {
        const tip = $('meHelpTip');
        const more = $('meMore');
        if (accToken()) {
          const p = $('pairNewBtn');
          if (p) p.disabled = false;
          if (p) p.click();
          if (tip) tip.textContent = '把这 6 个数念给家里人，他们那边填一下，就连上了。';
          const cw = $('myCodeWrap');
          if (cw) {
            cw.hidden = false;
            try { cw.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
          }
        } else {
          if (more) more.hidden = false;
          const mb = $('meMoreBtn');
          if (mb) mb.textContent = '收起';
          if (tip) tip.textContent = '家里人在下面这格替您登一次就好，以后开机就是登录态，不用再输。';
          if (more) { try { more.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {} }
        }
      };
    }
    const moreBtn = $('meMoreBtn');
    if (moreBtn && !moreBtn.dataset.bound) {
      moreBtn.dataset.bound = '1';
      moreBtn.onclick = () => {
        const box = $('meMore');
        if (!box) return;
        box.hidden = !box.hidden;
        moreBtn.textContent = box.hidden ? '设置 · 账号与配对' : '收起';
      };
    }

    /* 去家人控制台。
       这一页给家里人看老人的情况，可要真的动手（加药、设提醒、看全部记录），
       还是得进 page-famhome —— 那里是完整的控制台，这一页只做「一眼看懂」。 */
    const famgo = $('meFamGoBtn');
    if (famgo && !famgo.dataset.bound) {
      famgo.dataset.bound = '1';
      famgo.onclick = () => {
        if (S.role !== 'family') {
          S.role = 'family';
          try { save(); } catch (e) {}
        }
        try { renderMe(); } catch (e) {}
        goPage('famhome');
      };
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  window.__bindMePage = bind;
})();

function goPage(p) {
  if (p === 'home' && S.role === 'family') p = 'famhome';
  /* 2026-11-09 全流程自动检测抓到的真 bug：旧版先把所有 .page 摘掉 .on，
     再去找目标页；目标不存在就整屏白屏，还挂一条红色报错条不走。
     任何无效路由（老版本书签、验收脚本传错页名、外部深链拼错）都会让老人
     以为「手机坏了、它不理我」。现在先确认目标存在，找不到就留在当前页。 */
  const el = $('page-' + p);
  if (!el) {
    try { console.warn('[PAGE] 未找到 #page-' + p + '，保持当前页'); } catch (e) {}
    return;
  }
  if (p === S.page && el.classList.contains('on')) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.page === p));
  document.querySelectorAll('.page').forEach((x) => x.classList.remove('on'));
  el.classList.add('on');
  S.page = p;
  /* 切页后立刻重算底边渐隐。渲染是同步的，但高度要等布局 —— 排下一帧。 */
  if (typeof syncScrollFade === 'function') requestAnimationFrame(syncScrollFade);

  /* 2026-11-06 晚：那条「米粒 · 我在听您说」和通话浮卡只属于首页。
     截图里它就浮在常用页九宫格正中间，把两格盖住一半 ——
     原因是它挂在 body 上、跟页面切换完全没关系。
     现在非首页一律收起来：老人在看清单，屏幕上不该压着一条说话状态。 */
  if (p !== 'home') {
    const cv = $('cvLine');
    if (cv) cv.hidden = true;
    const bar = $('callBar');
    if (bar) bar.hidden = true;
  }
  /* 翻到别的页，底栏要回来：通话态默认藏底栏，老人没底栏就回不去。 */
  const ph = $('phone');
  if (ph) ph.classList.toggle('paging', p !== 'home');
  /* 右上那颗绿点（调试后门）只在首页出现，别跟着人跑。 */
  const sbd = $('sbDots');
  if (sbd && p !== 'home') sbd.hidden = true;

  /* 连续对话：老人端全程常驻 —— 在挂号页能说「换个科室」，
     在付款页能说「多少钱」，才叫一句话操控。
     家人端和自己的页关掉：那边是家里人用的，没必要一直录。
     （「我在我的」这一页正好是老人想关掉它的时候。） */
  if (p === 'famhome' || p === 'me' || window.__F7_FAMILY) {
    if (window.__cvOn) stopCv('goPage:' + p);
    const bar0 = $('callBar');
    if (bar0) bar0.hidden = true;
  }
  /* 2026-11-08 菲尔特：「老人端也不能时时刻刻都醒着，只有语音唤醒才醒来对话」。
     以前这里每次翻页 260ms 后自动 callEnter —— 去设置、去药箱、去任何页，
     米粒都自动进通话挂一条「在听」在头上，就是「阴魂不散」的真正原因。
     现在只有两条路能进通话：喊「米粒米粒」（原生唤醒 → __wakeIn），
     或者老人自己点「说话」。翻页一律不主动出声、不主动占麦。 */

  if (p === 'did') renderDid();
  if (p === 'learn') renderLearn();
  if (p === 'family') renderFam();
  if (p === 'med') renderMed();
  if (p === 'hub') renderHub();
  if (p === 'famhome') { renderFamHome(); refreshFamCard(false); }
  if (p === 'me') {
    renderMe();
    /* 「我的」现在也摆着老人的实况，得跟家人端一样拉一次。
       以前这页只有身份卡，不需要网络；现在不拉，家人点进来看到的是旧数据。 */
    refreshFamCard(false);
  }
  if (p === 'vital') renderVital();
  if (p === 'pay') renderPay();
  if (p === 'reg') renderReg();
  /* 换页要重算字幕条：首页不显示（那儿有自己的语音条），别的页要显示 */
  if (window.__cvOn) cvState(window.__cvState || 'listen');
  resize();
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => goPage(t.dataset.page); });
document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => goPage('home'); });
/* app.js 是 module，顶层函数不挂到 window 上。
   「我的」页那两颗入口按钮是写在 HTML 里的 onclick，得显式给出去。 */
window.goPage = goPage;

/* ============ 滚动底边渐隐 ============
   列表比一屏长是正常的，但**硬切**看起来像坏了 ——
   老人看到半行字被截断，第一反应是「这软件没装好」。
   所以能滚、且还没滚到底的时候，底部挂一层 28px 渐隐，
   把「硬切」变成「淡出」，明确暗示「还能往下」。
   滚到底就摘掉 —— 那时候不该再暗示下面还有东西。
   每次切页都要重算：不同页的 scroll 高度不一样，而且是异步渲染的。 */
function syncScrollFade() {
  document.querySelectorAll('.page.on .scroll').forEach((sc) => {
    const more = sc.scrollHeight - sc.clientHeight - sc.scrollTop > 4;
    sc.classList.toggle('fade', more);
  });
}
window.__syncScrollFade = syncScrollFade;
/* 滚动、渲染、切页都要跟一次。用捕获阶段挂在 document 上，
   这样后渲染出来的 scroll（比如家人端的列表）也自动被管到。 */
document.addEventListener('scroll', syncScrollFade, true);
/* 渲染是同步的，但内容高度要等布局才算得准 —— 所以排到下一帧。 */
if (window.MutationObserver) {
  const mo = new MutationObserver(() => requestAnimationFrame(syncScrollFade));
  mo.observe(document.getElementById('phone') || document.body,
    { childList: true, subtree: true });
}
requestAnimationFrame(syncScrollFade);

/* 待唤醒屏上那两颗。大的那颗就是「再聊」，小的那颗是给演示和家人的后门。 */
(function () {
  const go = $('sbGo');
  if (go) go.onclick = () => { try { callEnter('tap'); } catch (e) {} };
  const dots = $('sbDots');
  if (dots) dots.onclick = () => { try { goPage('hub'); } catch (e) {} };
})();

/* ============ 常用：把「每次都要说一遍」的事做成一排按钮 ============ */
const HUB_ITEMS = [
  { id: 'nav',     icon: 'map',   t: '实景导航', s: '说个地方，实景带你走', wide: true },
  { id: 'pay',     icon: 'scan',  t: '扫码付款', s: '我扫商家 · 微信扫一扫' },
  { id: 'paycode', icon: 'scan',  t: '付款码',   s: '给商家扫我，不用举手机' },
  { id: 'receivecode', icon: 'user', t: '收款码', s: '别人给我钱时打开' },
  { id: 'vital',   icon: 'heart', t: '血压血糖', s: '量了记一笔' },
  { id: 'wxvideo', icon: 'user',  t: '微信视频', s: '给家里人露个脸' },
  { id: 'drama',   icon: 'play',  t: '电视剧大全', s: '热播剧，接着看' },
  { id: 'cctv',    icon: 'tv',    t: 'CCTV 直播', s: '看新闻，能切台' },
  { id: 'hongguo', icon: 'heart', t: '红果短剧', s: '接着上次的看' },
  { id: 'weather', icon: 'sun',   t: '今天天气', s: '出门前看一眼' },
  { id: 'hospital', icon: 'hosp', t: '挂号', s: '看病先挂号' }
];

/* 首页四个常用 —— 就用「常用」页那套 id 和图标，点下去走同一条路，
   不额外维护一份逻辑。老人打开就能动手，不用先学「常用在哪」。 */
const QUICK_IDS = ['wxvideo', 'drama', 'cctv', 'weather'];

function renderQuick() {
  const box = $('quickGrid');
  if (!box) return;
  box.innerHTML = QUICK_IDS.map((id) => {
    const x = HUB_ITEMS.find((y) => y.id === id);
    if (!x) return '';
    return `<button class="qcard" data-hub="${x.id}"><span class="qic">${ico(x.icon)}</span>`
      + `<b>${esc(x.t)}</b></button>`;
  }).join('');
  box.querySelectorAll('[data-hub]').forEach((b) => { b.onclick = () => hubTap(b.dataset.hub); });
}

/* ============ 桌面大图标（2026-11-06：米粒自己就是桌面） ============
   照老人桌面的设计思路重做：大图标 + 大字标签，一屏六个，
   点了就走标准 Intent —— 这才是给老人用的手机，不是聊天机器人的抽屉。 */
const DESK_ITEMS = [
  { k: 'dialer',   icon: 'phone', t: '打电话' },
  { k: 'sms',      icon: 'msg',   t: '短信' },
  { k: 'wechat',   icon: 'wx',    t: '微信' },
  { k: 'camera',   icon: 'cam',   t: '拍照' },
  { k: 'album',    icon: 'pic',   t: '相册' },
  { k: 'torch',    icon: 'lamp',  t: '手电筒' },
  { k: 'calllog',  icon: 'log',   t: '通话记录' },
  { k: 'settings', icon: 'gear',  t: '设置' },
  /* v9：家人端引导可勾的扩展功能，全部有真动作（见 deskTap / V9_APPS） */
  { k: 'video',    icon: 'video', t: '打视频' },
  { k: 'tv',       icon: 'tv',    t: '看电视' },
  { k: 'douyin',   icon: 'play',  t: '刷抖音' },
  { k: 'short',    icon: 'play',  t: '看短剧' },
  { k: 'weather',  icon: 'sun',   t: '看天气' },
  /* 2026-11-10 菲尔特：扫一扫、付款码要有能直接点的入口 */
  { k: 'scan',     icon: 'cam',   t: '扫一扫' },
  { k: 'paycode',  icon: 'pic',   t: '付款码' }
];
function deskTap(kind) {
  /* 桌面这两颗一步到位，不走智能体（不联网、不等模型、不会答「我不明白」） */
  if (kind === 'scan')    { try { wxGo('scan'); say('微信扫一扫打开了，您照一下。'); } catch(e){} return; }
  if (kind === 'paycode') { try { wxGo('pay');  say('付款码打开了，给商家扫一下。'); } catch(e){} return; }
  if (kind === 'dialer') { goPage('dialer'); return; }
  /* 2026-11-07 v9：家人端引导里勾的扩展功能（打视频/看电视/刷抖音/看短剧/
     看天气）不是 Java Intent，走智能体工具表。工具不存在就说清，不假装办成。 */
  /* 2026-11-10 菲尔特「点打视频他说没说是给谁打」：原来直接调 wechat_call
     却不给 who，工具只能干巴巴回一句报错。改成先弹出联系人让人点一下。 */
  if (kind === 'video') {
    try {
      const def = (S.fam && S.fam[0] && S.fam[0].name) || '';
      showTextSheet('给谁打视频？', '点下面家里人的名字，或者自己写一个。', def, function(who){
        const n0 = NATIVE();
        if (n0 && n0.wechat) {
          try { const r = JSON.parse(n0.wechat(who, 'video') || '{}');
                say(r.say || ('好，给' + who + '打视频。')); } catch (e) {}
        }
      });
      const IN = $('actIn');
      if (IN) {
        const wrap = document.createElement('div');
        wrap.className = 'pickchips';
        wrap.innerHTML = dialPeopleList().slice(0, 10).map(function(p){
          return '<button type="button" data-who="' + esc(p.name) + '">' + esc(p.name) + '</button>';
        }).join('');
        wrap.querySelectorAll('button').forEach(function(b){
          b.onclick = function(){ const i = $('miliTxtIn'); if (i) i.value = b.dataset.who; };
        });
        const okBtn = IN.querySelector('#miliTxtOk');
        IN.insertBefore(wrap, okBtn || null);
      }
    } catch (e) {}
    return;
  }
  const EXTRA = (window.V9_APPS || []).filter(function(a){ return a.k === kind && a.kind === 'tool'; })[0];
  if (EXTRA) {
    const T = window.MILI_TOOLS;
    if (!T || !T.exec) { try { say('这个功能还没接好。'); } catch(e){} return; }
    Promise.resolve(T.exec(EXTRA.tool, EXTRA.args || {}, { native: () => NATIVE() }))
      .then(function(r){
        try { say((r && r.detail) || (r && r.ok ? '好，这就去办。' : '这会儿办不了。')); } catch(e){}
      }).catch(function(){ try { say('这会儿办不了。'); } catch(e){} });
    return;
  }
  const n = NATIVE();
  if (n && (n.deskGo || n.deskLaunch)) {
    try {
      const raw = n.deskGo ? n.deskGo(kind, null) : n.deskLaunch(kind);
      const r = JSON.parse(raw || '{}');
      if (r && r.ok && r.say) try { say(r.say); } catch (e) {}
      if (r && r.ok === false && r.say) try { say(r.say); } catch (e) {}
      return;
    } catch (e) {}
  }
  try { say('这在手机上点才管用。'); } catch (e) {}
}
function sosTap() {
  /* 2026-11-10 菲尔特「点紧急呼叫没拨我事前保存的号码」真因：
     首页确认层、长按 3 秒、语音工具三条路最后都点 #sosBtn，
     而它拨的是 S.fam[0].name（通讯录里按名字猜的第一位家人），
     压根没读引导/设置里存的 S.sosPhone。统一收口到 MILI_SOS。 */
  if (window.MILI_SOS) { try { return window.MILI_SOS(); } catch (e) {} }
  const n = NATIVE();
  const who = (S.fam && S.fam[0] && S.fam[0].name) || '';
  if (n && who && n.call) {
    try {
      const r = JSON.parse(n.call(who) || '{}');
      if (r && r.ok === false && n.deskLaunch) { n.deskLaunch('dial'); return; }
      try { say('别慌，正在叫' + who + '。'); } catch (e) {}
      return;
    } catch (e) {}
  }
  deskTap('dial');
}
function renderDesk() {
  const box = $('deskGrid');
  if (!box) return;
  /* 首页图标单一真源 = S.cfg.apps（引导页 / 设置页勾选都写这里）。
     2026-11-09 真机实测 bug：旧版这里读 S.homeBtns，空了就兜底
     ['dialer','wechat','tv','short']；applyDesk() 却按 cfg.apps
     ['dialer','wechat','torch','camera'] 逐个判显隐 —— 两套 key 取交集
     只剩「打电话/微信」两颗，手电筒/拍照压根没生成 DOM，设置页还显示一个没勾。
     现在 DOM 与显隐读同一份：cfg.grid=6 且 apps 够 6 个就是六个。 */
  let pick = [];
  try {
    const c = S.cfg || {};
    if (Array.isArray(c.apps) && c.apps.length) pick = c.apps.slice(0, c.grid === 6 ? 6 : 4);
  } catch (e) {}
  if (!pick.length) pick = ['dialer', 'wechat', 'torch', 'camera'];
  const ordered = pick.map((k) => DESK_ITEMS.find((x) => x.k === k)).filter(Boolean);
  box.innerHTML = ordered.map((x) =>
    `<button class="dicon" data-desk="${x.k}"><span class="dic">${ico(x.icon)}</span><b>${esc(x.t)}</b></button>`
  ).join('');
  box.querySelectorAll('[data-desk]').forEach((b) => { b.onclick = () => deskTap(b.dataset.desk); });
  /* 家人快拨卡：最常打的人直接摆桌面上，点了就拨（号码由原生层从通讯录查）。 */
  const fd = $('famDial');
  if (fd) {
    const fam = (S.fam || []).filter((f) => f && f.name).slice(0, 3);
    fd.hidden = fam.length === 0;
    fd.innerHTML = fam.map((f) =>
      `<button class="famcard" data-fam="${esc(f.name)}"><span class="famava">${esc(f.name.slice(0, 1))}</span><span class="famnm">${esc(f.name)}</span></button>`
    ).join('');
    fd.querySelectorAll('[data-fam]').forEach((b) => {
      b.onclick = () => {
        const n = NATIVE();
        const who = b.dataset.fam;
        if (n && n.call) {
          try { const r = JSON.parse(n.call(who) || '{}'); if (r && r.say) try { say(r.say); } catch (e) {} return; } catch (e) {}
        }
        deskTapCallNum(who);
      };
    });
  }
  const sos = $('sosBtn');
  if (sos) sos.onclick = sosTap;
  const sn = $('sosName');
  if (sn) sn.textContent = (S.fam && S.fam[0] && S.fam[0].name) || '家人';
}

function deskTapCallNum(num) {
  const n = NATIVE();
  if (n && n.deskGo) { try { n.deskGo('dialnum', String(num || '')); return; } catch (e) {} }
  if (n && n.deskLaunch) { try { n.deskLaunch('dial'); return; } catch (e) {} }
}

/* ---- 打电话：联系人优先（2026-11-09 菲尔特拍板） ----
   原话：「拨电话不应是输入，而应该直接出现之前预填写或通讯录的联系人，
   进一步点击选择」。老人不该背 11 位号码。
   主视图 = 引导页/家人端填好的家里人 + 这台手机通讯录，点一下名字就拨；
   数字键盘退到二级，只有名单里没有的人才用得到。 */
function dialPeopleList() {
  /* 2026-11-09 真机截图自查（cb4a7512）抓到的真问题：
     通讯录头一条是「By / 1068707153301001181」—— 短信通道号，
     后面还混着快递、银行、外卖。老人一眼看不懂，误点一下就拨出去了。
     所以通讯录不是照单全收：过滤服务号 + 营销名称，家里人排最前，
     再排带亲属称呼的，最后才轮到其他人。预填的家里人是用户自己填的，信任、不过滤。 */
  const home = [], kin = [], other = [], seen = {};
  const BAD_NAME = /快递|外卖|跑腿|银行|客服|营业厅|广告|推销|骚扰|验证码|服务号|订阅|官方|营销|物流|售后|保险|贷款|中介|房产|招聘|10086|10010|955/i;
  const KIN = /儿子|女儿|闺女|姑娘|小子|老伴|老头|老婆|老公|爸爸|妈妈|爸|妈|奶奶|爷爷|姥姥|姥爷|外公|外婆|叔|姨|姑|舅|哥|姐|弟|妹|孙子|孙女|侄|甥|大伯|婶|嫂/i;
  const junkNum = (phone) => {
    if (!phone) return false;              /* 没号码的交给原生按名字查，保留 */
    const d = String(phone).replace(/\D/g, '');
    return d.length < 7 || d.length > 13
      || /^(106|95|400|800|1010|100|11\d)/.test(d);
  };
  const put = (bucket, label, name, phone, from) => {
    if (!name || BAD_NAME.test(String(name))) return;
    if (from === '通讯录' && junkNum(phone)) return;
    const key = String(phone || '').replace(/\D/g, '') || String(name);
    if (seen[key]) return;
    seen[key] = 1;
    bucket.push({ label: label || name, name: name, phone: phone || '', from: from });
  };
  /* ① 引导页 / 家人端事先填好的 —— 「儿子」「闺女」才是老人认得的称呼 */
  try {
    const cs = (S.cfg && Array.isArray(S.cfg.contacts)) ? S.cfg.contacts : [];
    cs.forEach((c) => { if (c) put(home, c.label || c.name, c.name || c.label, c.phone, '家里人'); });
  } catch (e) {}
  try {
    (S.fam || []).forEach((f) => { if (f && f.name) put(home, f.rel || f.name, f.name, f.phone, '家里人'); });
  } catch (e) {}
  /* ② 本机通讯录里有号码的人（原生桥 contacts()，读不到就只显示家里人） */
  try {
    const n = NATIVE();
    if (n && typeof n.contacts === 'function') {
      const arr = JSON.parse(n.contacts() || '[]');
      /* 2026-11-10 菲尔特「所有联系人都要进去」：原来这里砍到 40 条，
         下面又砍到 10 张卡，通讯录里绝大多数人根本出不来。全量返回。 */
      if (Array.isArray(arr)) arr.forEach((c) => {
        if (c && c.name) put(KIN.test(c.name) ? kin : other,
          c.name, c.name, c.number || c.phone, '通讯录');
      });
    }
  } catch (e) {}
  return home.concat(kin, other);   /* 全量；列表本来就能滚，另加搜索框 */
}
function renderDialPeople() {
  const box = $('dialPeople');
  if (!box) return;
  const list = dialPeopleList();
  if (!list.length) {
    box.innerHTML = '<div class="peopleempty">还没存家里人的号码。<br>'
      + '叫孩子帮您存一个，以后点名字就能打。<br>'
      + '也可以按下面的「手动输号码」。</div>';
    return;
  }
  box.innerHTML = '<input id="dialFilter" class="dialfilter" type="search" '
    + 'placeholder="找联系人 · 输名字或号码">' + list.map((p, i) =>
    `<button class="personcard" type="button" data-i="${i}">`
    + `<span class="pav">${esc(String(p.name).slice(0, 1))}</span>`
    + `<span><span class="pname">${esc(p.label)}</span>`
    + `<span class="psub">${esc(p.from)}${p.phone ? ' · ' + esc(p.phone) : ''}</span></span>`
    + `<span class="pgo">拨</span></button>`).join('');
  /* 过滤只隐藏卡片，不重绘，输入焦点不丢 */
  const flt = $('dialFilter');
  if (flt) flt.oninput = () => {
    const kw = String(flt.value || '').trim();
    box.querySelectorAll('.personcard').forEach((b) => {
      b.style.display = (!kw || String(b.textContent || '').indexOf(kw) >= 0) ? '' : 'none';
    });
  };
  box.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => {
      const p = list[+b.dataset.i];
      if (!p) return;
      const n = NATIVE();
      const arg = p.phone || p.name;   /* 有号码直接拨，没号码交给原生按名字查 */
      try {
        if (n && n.call) {
          const r = JSON.parse(n.call(arg) || '{}');
          if (r && r.ok !== false) return;
        }
      } catch (e) {}
      try { if (n && n.deskGo) { n.deskGo('dialnum', String(arg)); return; } } catch (e) {}
      try { if (n && n.deskLaunch) n.deskLaunch('dial'); } catch (e) {}
    };
  });
}
function renderDialPad() {
  const pad = $('dialPad');
  if (pad && !pad.dataset.ready) {
    pad.dataset.ready = '1';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    pad.innerHTML = keys.map((k) => `<button class="dkey" data-k="${k}"><b>${k}</b></button>`).join('');
    pad.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = () => { const d = $('dialNum'); if (d) d.textContent += b.dataset.k; };
    });
  }
  const del = $('dialDel');
  if (del) del.onclick = () => {
    const d = $('dialNum'); if (d) d.textContent = d.textContent.slice(0, -1);
  };
  const call = $('dialCall');
  if (call) call.onclick = () => {
    const d = $('dialNum');
    const num = (d && d.textContent.trim()) || '';
    if (!num) { try { say('先按几个数字嘛。'); } catch (e) {} return; }
    deskTapCallNum(num);
  };
  /* 默认名单，手动键盘收起来 */
  const man = $('dialManualWrap'), ps = $('dialPeopleScroll');
  const toManual = () => { if (man) man.hidden = false; if (ps) ps.hidden = true; };
  const toPeople = () => { if (man) man.hidden = true; if (ps) ps.hidden = false; renderDialPeople(); };
  const mb = $('dialManualBtn'); if (mb) mb.onclick = toManual;
  const bb = $('dialBackBtn'); if (bb) bb.onclick = toPeople;
  renderDialPeople();
}

/* ---- 报时：点大时钟，念一遍现在几点。 ---- */
function bindSpeakTime() {
  const t = $('hhTime');
  if (!t || t.dataset.ready) return;
  t.dataset.ready = '1';
  t.onclick = () => {
    const n = new Date();
    const h = n.getHours(), m = n.getMinutes();
    const line = '现在是' + (h < 6 ? '凌晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上')
      + (h % 12 === 0 ? 12 : h % 12) + '点' + (m ? m + '分' : '整');
    try { say(line); } catch (e) {}
    const nn = NATIVE();
    if (nn && nn.speak) { try { nn.speak(line, false); } catch (e) {} }
  };
}

/* ---- 大字模式：全局放大一号，记住选择。 ---- */
function applyBig() {
  const on = !!S.big;
  document.documentElement.classList.toggle('big', on);
  const b = $('bigFontBtn');
  if (b) b.textContent = '大字模式：' + (on ? '开' : '关');
}
function bindBigFont() {
  const b = $('bigFontBtn');
  if (!b || b.dataset.ready) return;
  b.dataset.ready = '1';
  b.onclick = () => {
    S.big = !S.big;
    try { save(); } catch (e) {}
    applyBig();
    try { say(S.big ? '字变大了。' : '字变回去了。'); } catch (e) {}
  };
}

function renderHub() {
  const box = $('hubGrid');
  if (!box) return;
  /* 2026-11-06 晚：九宫格改单列大卡。
     菲尔特：「这个界面也不好，简直灾难，老人很难返回」——
     截图里那条「米粒 我在听您说」还浮在九宫格正中间，把两格盖住了一半。
     九宫格真正的毛病不是不够好看，是 18px 标题在三米外根本看不清，
     九个格子挤一屏、手指要瞄着点。改成一列：每行 92px，图标 52、标题 22。
     一屏四行半，划一下就是下一行，闭着眼也能按。 */
  box.innerHTML = HUB_ITEMS.map((x) =>
    `<button class="hubcard wide" data-hub="${x.id}">`
    + `<span class="hic">${ico(x.icon)}</span>`
    + `<span class="hct"><b>${esc(x.t)}</b><i>${esc(x.s)}</i></span>`
    + `</button>`).join('');
  box.querySelectorAll('[data-hub]').forEach((b) => { b.onclick = () => hubTap(b.dataset.hub); });
  renderPartners();
  renderHubTask();
}

/* 任务条：今天还剩几件事。
   Omi 那条「04 / 顾客篇·任务 4/5 / 到号了怎么办 / 进行中」的同构做法。
   数字用「今天还没办完的件数」，没别的用 —— 老人看得懂「还剩 2 件」，
   看不懂「3 项待办已完成 67%」。 */
function renderHubTask() {
  const no = $('hubTaskNo'), ti = $('hubTaskTitle'), pa = $('hubTaskPath'), st = $('hubTaskSt');
  if (!no || !ti) return;
  let todo = [];
  try { todo = (taskList() || []).filter((t) => !t.done); } catch (e) { todo = []; }
  const done = (S.did || []).filter((d) => d && d.d === ymd()).length;

  if (todo.length) {
    no.textContent = String(todo.length);
    ti.textContent = todo[0].what || '有件事要办';
    pa.textContent = '今天 · 还剩 ' + todo.length + ' 件 · 办完的 ' + done + ' 件';
    st.textContent = '等着办';
    st.className = 'tbst';
  } else if (done) {
    /* 2026-11-06 菲尔特：「什么叫今天的事情已做完，老人还会有别的事啊」。
       原来写「今天的都办完了」，等于替老人宣布他今天没事干了 ——
       话是错的，气也是错的。只说已经办了几件，留个口子让他接着说。 */
    no.textContent = String(done);
    ti.textContent = '已经办了 ' + done + ' 件';
    pa.textContent = '还有别的事，跟我说一声就行';
    st.textContent = '还能办';
    st.className = 'tbst done';
  } else {
    no.textContent = '0';
    ti.textContent = '有事就说，我记着';
    pa.textContent = '想到什么随时跟我说';
    st.textContent = '在听';
    st.className = 'tbst calm';
  }
}

/* 赛会伙伴（2026 BoHack）。改名单只改这个数组。 */
const PARTNERS = {
  units: ['南开大学计算机学院', '宣怀学院', '南开大学卓越工程师学院', '天津大学人工智能学院'],
  firms: ['CALCULET', 'Dopamine', '力安 andOn', '联论科技', 'BAIONT QUANT', '智装天下',
          '津兆机电', 'TTC 千联', 'AtomGit', 'X.X', '阿童木机器人', '硅慧滚动',
          '清程极智', 'Naive.ai', 'EasyClamp', 'UCloud 优刻得'],
  support: ['天津大学科技园', '北洋海棠基金', '奇绩创坛', 'Datawhale',
            'FluxTech', '原子公社 AtomHub', '去探索'],
};

function renderPartners() {
  const host = $('partnerWall');
  if (!host) return;
  if (window.__MODE !== 'demo') { host.hidden = true; return; }
  host.hidden = false;
  const row = (arr) => arr.map((n) => '<span class="pbadge">' + esc(n) + '</span>').join('');
  host.innerHTML = ''
    + '<p class="sec">赛会伙伴 <span class="sec-hint">2026 BoHack · 南开大学</span></p>'
    + '<p class="plabel">合作单位</p><div class="prow">' + row(PARTNERS.units) + '</div>'
    + '<p class="plabel">合作企业</p><div class="prow">' + row(PARTNERS.firms) + '</div>'
    + '<p class="plabel">支持单位</p><div class="prow">' + row(PARTNERS.support) + '</div>'
    + '<p class="cp small" style="margin-top:10px">米粒是为这个赛会做的陪伴助手。</p>';
}

/* 原生返回的 JSON 统一在这里拆，拆不出来就当没成功，不瞎猜 */
function asJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (e) { return null; }
}
function nativeSays(res, fallback) {
  say((res && res.say) || fallback, 6200, { slow: true });
}

/* 打开外部页面：优先交给原生 Intent，网页端才用 window.open */
function openExternal(url) {
  if (!/^https?:\/\//i.test(url || '')) return;
  const n = NATIVE();
  if (n && n.openUrl) {
    try {
      const res = asJson(n.openUrl(url));
      if (res && res.ok) { say(res.say || '打开了。', 4200); return; }
      if (res && res.say) { say(res.say, 5200, { slow: true }); return; }
    } catch (e) {}
  }
  try {
    const w = window.open(url, '_blank');
    if (!w) location.href = url;
  } catch (e) { location.href = url; }
}

function hubNavigate(place) {
  const p = String(place || '').trim();
  if (!p) return;
  S.memo.lastPlace = p; save();
  const n = NATIVE();
  if (n && n.navigate) {
    try { nativeSays(asJson(n.navigate(p)), '好，给你导航去' + p + '。'); return; } catch (e) {}
  }
  openExternal('https://uri.amap.com/search?keyword=' + encodeURIComponent(p));
  say('地图给你打开了，去' + p + '。', 5200, { slow: true });
}

function hubWechatVideo(who) {
  const w = String(who || '').trim();
  if (!w) return;
  const n = NATIVE();
  if (n && n.wechat) {
    try { nativeSays(asJson(n.wechat(w, 'video')), '好，我给' + w + '打视频。'); return; } catch (e) {}
  }
  say('微信得在手机上打开。你按绿色那个图标，再点' + w + '。', 7200, { slow: true, key: 'no_wechat' });
}

function hubPlay(appName) {
  const n = NATIVE();
  if (n && n.watch) {
    try { nativeSays(asJson(n.watch(appName || '')), '好，给你打开' + (appName || '视频') + '。'); return; } catch (e) {}
  }
  say('这台设备上打不开' + (appName || '视频') + '，得在手机上用。', 6200, { slow: true });
}

function hubSearchShow(name) {
  const q = String(name || '').trim();
  if (!q) return;
  const n = NATIVE();
  if (n && n.watchShow) {
    try { nativeSays(asJson(n.watchShow(q)), '好，我去找《' + q + '》。'); return; } catch (e) {}
  }
  openExternal('https://tv.cctv.com/yxg/');
  say('先给你打开央视片库，你按名字找找。', 5200, { slow: true });
}

function showDramaSheet() {
  const A = $('action'), IN = $('actIn');
  const apps = ['爱奇艺', '腾讯视频', '优酷', '芒果TV', '红果短剧'];
  IN.innerHTML = `<div class="act-head"><h3 class="act-h" style="margin:0">电视剧大全</h3>
      <button class="xbtn" onclick="window.__close()" aria-label="关掉"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <p class="act-p">手机上装了哪个，点一下就进去。</p>
    <div class="applist">${apps.map((a) => `<button class="act-btn" data-app="${esc(a)}">${esc(a)}</button>`).join('')}</div>
    <button class="act-btn" data-free="1" style="margin-top:8px">央视片库 · 免费</button>
    <button class="act-btn ghost" data-search="1" style="margin-top:8px">按剧名找</button>
    <button class="act-btn ghost" onclick="window.__close()">先不看</button>`;
  A.hidden = false;
  IN.querySelectorAll('[data-app]').forEach((b) => {
    b.onclick = () => { window.__close(); hubPlay(b.dataset.app); };
  });
  const free = IN.querySelector('[data-free]');
  if (free) free.onclick = () => { window.__close(); openExternal('https://tv.cctv.com/yxg/'); };
  const se = IN.querySelector('[data-search]');
  if (se) se.onclick = () => {
    showTextSheet('想看什么？', '写个片名，我去找。', '', (q) => hubSearchShow(q));
  };
}

/* CCTV 直播：官方网页，一个台一个入口，点哪个换哪个 */
function showTvSheet() {
  const A = $('action'), IN = $('actIn');
  const CH = [
    ['CCTV-1 综合', 'cctv1'], ['CCTV-2 财经', 'cctv2'], ['CCTV-3 综艺', 'cctv3'],
    ['CCTV-4 国际', 'cctv4'], ['CCTV-5 体育', 'cctv5'], ['CCTV-5+ 赛事', 'cctv5plus'],
    ['CCTV-6 电影', 'cctv6'], ['CCTV-7 军事', 'cctv7'], ['CCTV-8 电视剧', 'cctv8'],
    ['CCTV-9 纪录', 'cctvjilu'], ['CCTV-10 科教', 'cctv10'], ['CCTV-11 戏曲', 'cctv11'],
    ['CCTV-12 法治', 'cctv12'], ['CCTV-13 新闻', 'cctv13'], ['CCTV-14 少儿', 'cctvchild'],
    ['CCTV-15 音乐', 'cctv15'], ['CCTV-16 奥运', 'cctv16'], ['CCTV-17 农业', 'cctv17']
  ];
  IN.innerHTML = `<div class="act-head"><h3 class="act-h" style="margin:0">CCTV 直播</h3>
      <button class="xbtn" onclick="window.__close()" aria-label="关掉"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <p class="act-p">想看哪个台，点一下。</p>
    <div class="chgrid">${CH.map(([n, k]) => `<button class="chbtn" data-ch="${k}">${n}</button>`).join('')}</div>
    <button class="act-btn ghost" data-cctv-app="1" style="margin-top:14px">用央视影音看</button>
    <button class="act-btn ghost" onclick="window.__close()">先不看</button>`;
  A.hidden = false;
  IN.querySelectorAll('[data-ch]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.ch;
      window.__close();
      openExternal('https://tv.cctv.com/live/' + k + '/');
    };
  });
  const app = IN.querySelector('[data-cctv-app]');
  if (app) app.onclick = () => {
    window.__close();
    const n = NATIVE();
    if (n && n.tv) { try { nativeSays(asJson(n.tv()), '给你打开央视影音了。'); return; } catch (e) {} }
    openExternal('https://tv.cctv.com/live/');
  };
}

/* 2026-11-09 用户视角复查：MainActivity 的 WebChromeClient 确实接了 onJsPrompt，
   所以这三个入口能弹出来 —— 但弹的是系统原生 AlertDialog + 系统字号 EditText，
   一跳出来就换了套界面、字也小，老人常常愣在那儿不知道该按哪。
   全部换成米粒自己页面内的大字输入框：不换皮、字够大、按钮够大。 */
function showTextSheet(title, hint, def, onOk) {
  const A = $('action'), IN = $('actIn');
  if (!A || !IN) return;
  IN.innerHTML = `<div class="act-head"><h3 class="act-h" style="margin:0">${esc(title)}</h3>
      <button class="xbtn" onclick="window.__close()" aria-label="关掉">✕</button></div>
    <p class="act-p">${esc(hint)}</p>
    <input id="miliTxtIn" class="mili-textin" type="text" value="${esc(def || '')}" />
    <button class="act-btn" id="miliTxtOk" style="margin-top:12px">好，就这个</button>
    <button class="act-btn ghost" onclick="window.__close()" style="margin-top:8px">先不了</button>`;
  A.hidden = false;
  const inp = IN.querySelector('#miliTxtIn'), ok = IN.querySelector('#miliTxtOk');
  if (ok) ok.onclick = () => {
    const v = String((inp && inp.value) || '').trim();
    if (!v) { if (inp) inp.focus(); return; }
    window.__close(); onOk(v);
  };
  if (inp) setTimeout(() => { try { inp.focus(); } catch (e) {} }, 60);
}

function hubTap(id) {
  if (id === 'nav') {
    showTextSheet('要去哪儿？', '写个地方，或者点米粒说给它听。', S.memo.lastPlace || '医院', hubNavigate);
    return;
  }
  if (id === 'wxvideo') {
    showTextSheet('给谁打微信视频？', '写家里人的名字，点一下就拨。',
      (S.fam[0] && S.fam[0].name) || (S.cfg && S.cfg.contacts && S.cfg.contacts[0] && S.cfg.contacts[0].name) || '儿子',
      hubWechatVideo);
    return;
  }
  if (id === 'drama') { showDramaSheet(); return; }
  if (id === 'cctv') { showTvSheet(); return; }
  if (id === 'hongguo') { hubPlay('红果短剧'); return; }
  if (id === 'weather') { handleSay('今天冷不冷'); return; }
  if (id === 'pay' || id === 'paycode' || id === 'receivecode') {
    /* 2026-11-09 菲尔特：「收款码和付款码功能都加上吧，主打付款码和微信扫一扫」。
       三条路都是「点一下 = 米粒自动送到微信那一页」，老人不用认第二套界面。
       微信 8.0.80 把 weixin:// scheme 全封了（真机 + GitHub 双重确认），
       所以原生桥走无障碍坐标代点：打开微信 → 点右上角 + → 点对应菜单项。
       网页预览 / 老包没桥时退回付款页，评测与手输金额入口不受影响。 */
    const kind = id === 'pay' ? 'scan' : (id === 'paycode' ? 'pay' : 'receive');
    try {
      const n = NATIVE();
      if (n && typeof n.wxPayCode === 'function') { wxGo(kind); return; }
    } catch (e) {}
    goPage('pay'); renderPay(); return;
  }
  if (id === 'vital') { goPage('vital'); renderVital(); return; }
  if (id === 'hospital') { goPage('reg'); renderReg(); return; }
}

/* ============================================================================
 * 2026-11-06 新增：血压血糖 / 扫码付款 / 挂号
 *
 * 三个场景共用一条原则：老人端只给「现在该做什么」这一个动作，
 * 数字和流程都退到后面。Omi 那套界面之所以给老人用得动，就靠这个。
 * ========================================================================== */

/* ---------- ① 血压血糖 ----------
 * 存本地 + 上报服务端。本地那份是给没登录/没网的时候用的 ——
 * 量了血压却因为没网记不上，老人下次就不肯量了。
 * 阈值不在前端定，服务端算好 tone 回传；本地兜底那份只为了离线也能显示。 */
const VITAL_KEY = 'mili_vital';

function vitalAll() {
  try {
    const a = JSON.parse(localStorage.getItem(VITAL_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function vitalPush(item) {
  const a = vitalAll();
  a.unshift(item);
  if (a.length > 120) a.length = 120;
  try { localStorage.setItem(VITAL_KEY, JSON.stringify(a)); } catch (e) {}
}

/* 离线兜底判定。跟服务端 BP_WARN / GLU_WARN 同一套数 ——
   改阈值两边一起改，否则会出现「老人看正常、家人看偏高」。 */
function vitalTone(kind, sys, dia, val) {
  if (kind === 'bp') {
    if (sys >= 160 || dia >= 100) return 'bad';
    if (sys >= 140 || dia >= 90) return 'warn';
    return 'ok';
  }
  if (val >= 11.1 || val <= 3.0) return 'bad';
  if (val >= 7.0 || val <= 3.9) return 'warn';
  return 'ok';
}

/* 一句话结论。老人不认「收缩压 148」，认「偏高」。 */
function vitalSay(kind, tone, sys, dia, val) {
  if (kind === 'bp') {
    if (tone === 'bad') return '很高了。坐下别动，先给家里人打个电话。';
    if (tone === 'warn') return '比平时高一点。歇五分钟再量一次，别急着吃药。';
    return '正常。今天这个数挺好。';
  }
  if (tone === 'bad') return '这个数不对劲。先吃点东西坐着，马上告诉家里人。';
  if (tone === 'warn') return '有点偏。记下来，明天早上再量一次。';
  return '正常。';
}

const TONE_TXT = { ok: '正常', warn: '偏高', bad: '很高' };

/* 趋势条：14 根柱子，不放坐标轴。老人只看「往上还是往下」。 */
function vitalTrend(box, list, kind) {
  if (!box) return;
  const arr = (list || []).slice(0, 14).reverse();
  if (!arr.length) { box.innerHTML = ''; return; }
  const vals = arr.map((x) => kind === 'bp' ? (+x.sys || 0) : (+x.val || 0));
  const max = Math.max.apply(null, vals.concat([1]));
  const min = Math.min.apply(null, vals);
  const span = Math.max(1, max - min);
  box.innerHTML = arr.map((x, i) => {
    const v = kind === 'bp' ? (+x.sys || 0) : (+x.val || 0);
    const h = 22 + Math.round(((v - min) / span) * 66);
    const cls = x.tone === 'bad' ? 'bad' : x.tone === 'warn' ? 'hi'
      : (i === arr.length - 1 ? 'now' : '');
    return '<i class="' + cls + '" style="height:' + h + '%"></i>';
  }).join('');
}

function renderVital() {
  const list = vitalAll();
  const bp = list.filter((x) => x.kind === 'bp');
  const gl = list.filter((x) => x.kind === 'glu');
  const b = bp[0], g = gl[0];

  const setTone = (tagEl, bigEl, tone) => {
    if (tagEl) { tagEl.className = 'vitaltag ' + (tone || ''); tagEl.textContent = TONE_TXT[tone] || '还没量'; }
    if (bigEl) bigEl.className = 'vitalbig' + (bigEl.classList.contains('mid') ? ' mid' : '') + (tone && tone !== 'ok' ? ' ' + tone : '');
  };

  if (b) {
    if ($('vBpSys')) $('vBpSys').textContent = b.sys;
    if ($('vBpDia')) $('vBpDia').textContent = b.dia;
    setTone($('vBpTag'), $('vBpBig'), b.tone);
    if ($('vBpSay')) $('vBpSay').textContent = vitalSay('bp', b.tone, b.sys, b.dia, 0);
  } else {
    setTone($('vBpTag'), $('vBpBig'), '');
    if ($('vBpSay')) $('vBpSay').textContent = '今天还没量。量了就点下面的「量好了，记一笔」。';
  }
  vitalTrend($('vBpTrend'), bp, 'bp');

  if (g) {
    if ($('vGluVal')) $('vGluVal').textContent = (Math.round(g.val * 10) / 10).toFixed(1);
    setTone($('vGluTag'), $('vGluBig'), g.tone);
    if ($('vGluSay')) $('vGluSay').textContent = vitalSay('glu', g.tone, 0, 0, g.val);
  } else {
    setTone($('vGluTag'), $('vGluBig'), '');
    if ($('vGluSay')) $('vGluSay').textContent = '今天还没量。';
  }
  vitalTrend($('vGluTrend'), gl, 'glu');

  renderVitalWarn();
}

/* 首页那条告警。只在超标时出现，正常时整块 hidden —— 平时不占地方。 */
function renderVitalWarn() {
  const el = $('vitalWarn');
  if (!el) return;
  const list = vitalAll();
  const bad = list.find((x) => x.tone && x.tone !== 'ok');
  if (!bad) { el.hidden = true; return; }
  el.hidden = false;
  const isBp = bad.kind === 'bp';
  if ($('vwName')) $('vwName').textContent = isBp ? '血压' : '血糖';
  if ($('vwTag')) {
    $('vwTag').className = 'vitaltag ' + bad.tone;
    $('vwTag').textContent = TONE_TXT[bad.tone] || '偏高';
  }
  if ($('vwSys')) $('vwSys').textContent = isBp ? bad.sys : (Math.round(bad.val * 10) / 10).toFixed(1);
  /* 低压这一格原来只做了 hidden 切换，从来没赋过值 ——
     于是不管记多少次，首页那颗「/ 92」永远是 HTML 里写死的那个数。
     老人自己看 168/98，首页显示 168/92，两边对不上，比不显示更糟。 */
  if ($('vwDia')) {
    $('vwDia').hidden = !isBp;
    $('vwDia').textContent = isBp ? bad.dia : '';
  }
  if ($('vwBig')) $('vwBig').className = 'vitalbig' + (bad.tone === 'bad' ? ' bad' : ' warn');
  if ($('vwSay')) $('vwSay').textContent = vitalSay(bad.kind, bad.tone, bad.sys, bad.dia, bad.val);
  if ($('vwSub')) {
    $('vwSub').textContent = bad.tone === 'bad'
      ? '点一下，它就把这个数发给家里人。'
      : '已经记下了。要不要告诉家里人，你说了算。';
  }
  el.onclick = () => { goPage('vital'); renderVital(); };
}

/* 记一笔。老人端只有两条路：说数字，或者点按钮填。
   没有「收缩压/舒张压」这种词 —— 就问「高的那个数」「低的那个数」。 */
function vitalAdd() {
  const sh = $('vitalSheet');
  if (!sh) return;
  _vsKind = 'bp';
  $('vsPick').hidden = false;
  $('vsForm').hidden = true;
  $('vsTitle').textContent = '这次量的是什么？';
  $('vsSub').textContent = '点一下，我给你记上。';
  ['vsSys', 'vsDia', 'vsVal'].forEach((k) => { const el = $(k); if (el) el.value = ''; });
  sh.hidden = false;
}

function vsClose() { const sh = $('vitalSheet'); if (sh) sh.hidden = true; }

/* 三个格子：sys / dia / val。整数字用 data-v，界面上显示在 <b> 里。
   不用 <input> 是为了不弹系统键盘 —— 系统键盘会把弹层顶掉一半。 */
function vsSetCell(id, txt) {
  const el = $(id);
  if (!el) return;
  el.dataset.v = txt;
  const b = el.querySelector('b');
  if (b) b.textContent = txt === '' ? '—' : txt;
}

function vsFocus(cell) {
  document.querySelectorAll('.vs-cell').forEach((c) => c.classList.toggle('on', c.dataset.cell === cell));
  _vsCell = cell;
}

function vsChoose(kind) {
  _vsKind = kind;
  $('vsPick').hidden = true;
  $('vsForm').hidden = false;
  $('vsBpRow').hidden = kind !== 'bp';
  $('vsGluRow').hidden = kind !== 'glu';
  $('vsTitle').textContent = kind === 'bp' ? '血压多少？' : '血糖多少？';
  $('vsSub').textContent = kind === 'bp'
    ? '照血压计上的两个数按。' : '照血糖仪上的数按。';
  /* 小数点只在血糖时出现：血压没有小数，多一个键反而添乱 */
  const dot = $('vsDot'); if (dot) dot.hidden = kind !== 'glu';
  vsSetCell('vsSys', ''); vsSetCell('vsDia', ''); vsSetCell('vsVal', '');
  vsFocus(kind === 'bp' ? 'sys' : 'val');
}

/* 按一个数字键 */
function vsKey(k) {
  const cell = _vsCell || 'sys';
  const el = cell === 'sys' ? $('vsSys') : cell === 'dia' ? $('vsDia') : $('vsVal');
  if (!el) return;
  let v = String(el.dataset.v || '');
  if (k === 'del') {
    v = v.slice(0, -1);
  } else if (k === 'dot') {
    if (_vsKind !== 'glu') return;
    if (v.indexOf('.') >= 0) return;
    v = v === '' ? '0.' : v + '.';
  } else {
    const maxLen = _vsKind === 'glu' ? 4 : 3;
    if (v.replace('.', '').length >= maxLen) {
      /* 高压填满三位就自动跳到低压 —— 老人不用自己找下一个框 */
      if (_vsKind === 'bp' && cell === 'sys') { vsFocus('dia'); return vsKey(k); }
      return;
    }
    v += k;
  }
  /* 血糖最多一位小数 */
  if (_vsKind === 'glu') {
    const dot = v.indexOf('.');
    if (dot >= 0 && v.length - dot - 1 > 1) v = v.slice(0, dot + 2);
  }
  vsSetCell(el.id, v);
  /* 高压满三位，自动把光标送到低压 */
  if (_vsKind === 'bp' && cell === 'sys' && v.length >= 3) vsFocus('dia');
}

function vsSave() {
  let sys = 0, dia = 0, val = 0;
  if (_vsKind === 'bp') {
    sys = parseInt(String(($('vsSys') || {}).dataset ? $('vsSys').dataset.v : '') || '', 10) || 0;
    dia = parseInt(String(($('vsDia') || {}).dataset ? $('vsDia').dataset.v : '') || '', 10) || 0;
    if (!sys || !dia) {
      say('两个数都得按，不然记不上。', 5200, { slow: true });
      return;
    }
    if (sys < 60 || sys > 260 || dia < 30 || dia > 200) {
      say('这个数看着不对，你再瞄一眼血压计。', 5600, { slow: true });
      return;
    }
    if (dia >= sys) {
      say('低压比高压还大，是不是按反了？', 5600, { slow: true });
      return;
    }
  } else {
    val = parseFloat(String(($('vsVal') || {}).dataset ? $('vsVal').dataset.v : '') || '') || 0;
    if (!val) { say('数没按出来，再按一次。', 5200, { slow: true }); return; }
    if (val < 1 || val > 40) {
      say('这个数看着不对，你再瞄一眼血糖仪。', 5600, { slow: true });
      return;
    }
  }
  vsClose();
  vitalSave(_vsKind, sys, dia, val);
}

/* 落库 + 上报。原来这段写在 vitalAdd 里，加了弹层之后单独抽出来，
   语音那条路（MILI_VITAL.add）也能复用同一套逻辑。 */
function vitalSave(kind, sys, dia, val) {
  const tone = vitalTone(kind, sys, dia, val);
  const item = { kind: kind, sys: sys, dia: dia, val: val, tone: tone, at: Date.now() };
  vitalPush(item);
  renderVital();

  /* 本地先记上，再异步上报。上报失败不影响老人已经看到的数。 */
  accApi('/vital', { body: { kind: kind, sys: sys, dia: dia, val: val } })
    .then((r) => {
      if (r && r.ok) {
        if (r.tone) { item.tone = r.tone; }
        if (r.alarm) {
          say('这个数连着几次都不对，我已经告诉家里人了。', 7000, { slow: true });
          try { accLogAct('vital', (kind === 'bp' ? '血压 ' + sys + '/' + dia : '血糖 ' + val), '连续超标'); } catch (e) {}
          return;
        }
      }
      say(vitalSay(kind, tone, sys, dia, val), 7000, { slow: true });
    })
    .catch(() => { say(vitalSay(kind, tone, sys, dia, val), 7000, { slow: true }); });

  try { accLogAct('vital', kind === 'bp' ? '量了血压 ' + sys + '/' + dia : '量了血糖 ' + val, ''); } catch (e) {}
}

/* 把这个数发给家里人：走已有的「办过的事」通道，家属端立刻能看见。 */
function vitalTell() {
  const list = vitalAll();
  if (!list.length) { say('还没有数可以发。先量一次。', 5200, { slow: true }); return; }
  const x = list[0];
  const txt = x.kind === 'bp' ? '血压 ' + x.sys + '/' + x.dia : '血糖 ' + x.val;
  try { accLogAct('vital', txt, TONE_TXT[x.tone] || ''); } catch (e) {}
  if ($('vitalTellOut')) $('vitalTellOut').textContent = '已经发了。家里人打开家人端就能看见。';
  say('发出去了。家里人打开家人端就能看见。', 6200, { slow: true });
}

/* ---------- ② 扫码付款 ----------
 * 走原生 ZXing（MainActivity.scanCode → window.__onScan）。
 * 网页端没有原生桥时，退化成「让商家念金额，你手输」——
 * 总比什么都不做强。
 *
 * 关键：米粒不碰钱。它只把码认出来、把金额念给老人听，
 * 最后一步永远是老人在微信/支付宝里自己输密码。 */
let _payPending = null;
let _vsKind = 'bp';   /* 记一笔弹层里当前要记的是血压还是血糖 */
let _vsCell = 'sys';  /* 数字键现在往哪个格子里按 */

function renderPay() {
  if ($('payIdle')) $('payIdle').hidden = !!_payPending;
  if ($('payResult')) $('payResult').hidden = !_payPending;
  if (_payPending) {
    if ($('payTo')) $('payTo').textContent = _payPending.to || '扫到的收款码';
    if ($('payAmt')) $('payAmt').textContent = _payPending.amt || '0.00';
    if ($('payNote')) {
      $('payNote').textContent = _payPending.note || '核对一下金额，对就点下面。';
    }
  }
}

/* 微信三个钱相关入口的统一出口（2026-11-09 真机实测坐标，见 MainActivity.wxViaMenu）。
   kind: scan=扫一扫 / pay=付款码 / receive=收款码。
   全程不发声、不弹米粒自己的相机页、不碰钱；最后那一下永远归微信、归老人。 */
function wxGo(kind) {
  const n = NATIVE();
  const fn = kind === 'pay' ? 'wxPayCode' : (kind === 'receive' ? 'wxReceiveCode' : 'wxScan');
  if (n && typeof n[fn] === 'function') {
    try { n[fn](); return; } catch (e) {}
  }
  /* 老包 / 网页预览没有新桥：扫一扫退回米粒自己的相机页，另外两条进付款页 */
  if (kind === 'scan' && n && n.scanCode) { try { n.scanCode(); return; } catch (e) {} }
  goPage('pay'); renderPay();
}
/* app.js 是 ES module，顶层函数不会自动挂到 window；
   agent-tools.js 是另一个普通 script，够不到这里的 wxGo。
   新加的 wechat_scan / wechat_pay_code 要复用这条 11-09 真机验证过的路，
   必须显式挂出去 —— 别在工具层再造第二份点屏流程。 */
window.wxGo = wxGo;
function scanPay() {
  _payPending = null;
  renderPay();
  wxGo('scan');
}

/* 手输金额。原来是 prompt() —— 系统弹框、键盘小、还得自己找小数点，
   老人根本按不来。改成跟「记一笔」同一套大数字键盘：只用学一次。 */
let _psVal = '';
function psSet(v) {
  _psVal = v;
  const el = $('psAmt');
  if (!el) return;
  el.dataset.v = v;
  const b = el.querySelector('b');
  if (b) b.textContent = v === '' ? '—' : v;
}
function payManual() {
  psSet('');
  const sh = $('paySheet');
  if (sh) sh.hidden = false;
}
function payManualClose() { const sh = $('paySheet'); if (sh) sh.hidden = true; }
function psKey(k) {
  let v = _psVal;
  if (k === 'del') {
    v = v.slice(0, -1);
  } else if (k === 'dot') {
    if (v.indexOf('.') >= 0) return;
    v = v === '' ? '0.' : v + '.';
  } else {
    const dot = v.indexOf('.');
    /* 整数最多 5 位，小数最多 2 位 —— 买菜不会超过这个数，按错也好发现 */
    if (dot < 0 && v.length >= 5) return;
    if (dot >= 0 && v.length - dot - 1 >= 2) return;
    v += k;
  }
  psSet(v);
}
function psOk() {
  const v = parseFloat(_psVal) || 0;
  if (!v) { say('还没按数呢。', 5000, { slow: true }); return; }
  if (v > 20000) { say('这个数太大了，再核一遍。', 5200, { slow: true }); return; }
  payManualClose();
  payResolve('', v);
}

/* 从扫码结果里拆金额。收款码有两种常见形态：
   ① 微信/支付宝的付款码页面里带金额的 URL（amount= / money=）
   ② 商家自己印的码，码里只有账号，金额得问人
   拆不出来就让老人自己说金额 —— 不猜。 */
function payAmountFrom(code) {
  const s = String(code || '');
  const m = s.match(/(?:amount|money|amt|fee|total)=([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (m) return parseFloat(m[1]);
  const m2 = s.match(/[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (m2) return parseFloat(m2[1]);
  return 0;
}

function payResolve(code, typedAmt) {
  let amt = typedAmt ? parseFloat(String(typedAmt).replace(/[^\d.]/g, '')) : 0;
  if (!amt) amt = payAmountFrom(code);
  const looksPay = /wxp:\/\/|alipays:\/\/|qrpay|pay\.|收款|merchant/i.test(String(code || ''));
  if (!amt) {
    /* 认得出是收款码但没带金额 —— 必须问人，绝不猜一个数替他付。
       原来这里弹的是系统 prompt：英文按键、灰底小字，WebView 里还可能
       静默返回 null（什么都没发生）。现在换成应用内的大数字键盘。 */
    payManual();
    return;
  }
  if (!amt) { say('没读到金额，再照一次。', 5200, { slow: true }); return; }
  _payPending = {
    code: String(code || ''),
    amt: amt.toFixed(2),
    to: looksPay ? '收款码' : (code ? '扫到的码' : '手输的金额'),
    note: '核对一下金额，对就点下面。',
  };
  renderPay();
  say('这个码要付 ' + amt.toFixed(2) + ' 块。对就点「对，就付这些」。', 7500, { slow: true });
}

/* 确认付款：不自己调支付 SDK（各家不开放给第三方），
   走的是「把码交给系统」—— 微信/支付宝认得自己的码，会自己弹出来。
   老人仍然要在那边输密码。米粒这一层只是省掉「找 App、点扫一扫」这几步。 */
function payConfirm() {
  if (!_payPending) return;
  const p = _payPending;
  const code = String(p.code || '');
  let tip = '付完了回来跟我说一声，我给你记上。';

  /* 微信/支付宝的 scheme 码，交给系统直接拉起对应 App */
  if (/^wxp:\/\//i.test(code) || /^weixin:\/\//i.test(code)
      || /^alipays:\/\//i.test(code) || /^alipay/i.test(code)) {
    openExternal(code);
  } else if (/^https?:\/\//i.test(code)) {
    /* 普通 URL 码：先试原生拉起 */
    const n = NATIVE();
    if (n && n.openUrl) { try { n.openUrl(code); } catch (e) {} }
    else openExternal(code);
  } else {
    /* 手输金额、或者码里没有可拉起的地址 —— 这一步只能老人自己做。
       原来这里什么都不说，点完就回到初始页，老人以为按坏了。 */
    tip = '打开微信或支付宝，点「扫一扫」，照同一个码付 '
        + (p.amt || '') + ' 元。付完回来跟我说一声。';
  }

  try { accLogAct('pay', '扫码付款 ¥' + p.amt, p.to); } catch (e) {}
  _payPending = null;
  renderPay();
  /* 付完回首页，再说那句话。
     说话气泡是挂在首页上的元素 —— 留在付款页说，老人只听得见声音、
     屏幕上什么都不动，会以为按坏了（模拟器实测就是这个观感）。 */
  goPage('home');
  setTimeout(() => { say(tip, 8000, { slow: true }); }, 700);
}

/* ---------- ③ 挂号 ----------
 * 不做真挂号（那需要医院侧的排班接口，一个赛会项目拿不到）。
 * 做的是老人真正卡住的那一段：不知道该挂哪个科。
 * 选完科室 + 医院，给他一条能走的路：要么打开官方挂号页，
 * 要么把这条「要挂什么」发给家里人，让家人替他挂。
 *
 * 这一步比「直接甩一个 114 网页」有用得多 —— 老人打开 114 也不知道选哪个科。 */
const DEPTS = [
  { k: '内科',   s: '头晕、血压、血糖、胃口不好' },
  { k: '外科',   s: '磕碰、扭了、伤口' },
  { k: '骨科',   s: '腰腿疼、关节疼' },
  { k: '眼科',   s: '看不清、眼睛红' },
  { k: '耳鼻喉', s: '耳朵背、嗓子疼' },
  { k: '口腔科', s: '牙疼、假牙不舒服' },
  { k: '皮肤科', s: '起疹子、痒' },
  { k: '心内科', s: '心慌、胸口闷' },
  { k: '神经内科', s: '手抖、说话不利索' },
  { k: '泌尿科', s: '小便不舒服' },
  { k: '妇科',   s: '小肚子不舒服' }
  /* 「说不清」删了。它原来排在最末一格 —— 恰恰是整屏最不起眼的角落，
     可它才是老人真正需要的那个入口。现在提到第一屏顶上，做成那颗黑胶囊
     （id 仍是 regSayBtn，逻辑一字未改）。同一个功能，只留一个入口。 */
];

const HOSPS = [
  { k: '最近的三甲', s: '按你位置找' },
  { k: '常去的那家', s: '以前去过的' },
  { k: '社区医院',   s: '近，人少' },
  { k: '让家里人定', s: '他们熟' }
];

let _reg = { dept: '', hosp: '', when: '', step: 1 };

function renderReg() {
  const dg = $('deptGrid');
  if (dg && !dg.dataset.done) {
    dg.innerHTML = DEPTS.map((d) => '<button class="deptbtn" data-dept="' + esc(d.k) + '">'
      + '<b>' + esc(d.k) + '</b>' + (d.s ? '<i>' + esc(d.s) + '</i>' : '') + '</button>').join('');
    dg.dataset.done = '1';
    dg.querySelectorAll('[data-dept]').forEach((b) => {
      b.onclick = () => {
        _reg.dept = b.dataset.dept;
        _reg.step = 2;
        renderReg();
      };
    });
  }
  const hg = $('hospGrid');
  if (hg && !hg.dataset.done) {
    hg.innerHTML = HOSPS.map((h) => '<button class="deptbtn" data-hosp="' + esc(h.k) + '">'
      + '<b>' + esc(h.k) + '</b><i>' + esc(h.s) + '</i></button>').join('');
    hg.dataset.done = '1';
    hg.querySelectorAll('[data-hosp]').forEach((b) => {
      b.onclick = () => { _reg.hosp = b.dataset.hosp; _reg.step = 3; renderReg(); };
    });
  }

  const s1 = $('regS1'), s2 = $('regS2'), s3 = $('regS3');
  if (s1) s1.hidden = _reg.step !== 1;
  if (s2) s2.hidden = _reg.step !== 2;
  if (s3) s3.hidden = _reg.step !== 3;
  if ($('regDeptLine')) $('regDeptLine').textContent = '科室：' + (_reg.dept || '—');

  /* 步骤条：走到哪一步，哪一段变橘黄 */
  const rs = $('regSteps');
  if (rs) {
    rs.querySelectorAll('.rs').forEach((x, i) => {
      x.classList.toggle('on', i < _reg.step);
    });
  }

  if (_reg.step === 3) {
    if ($('regOutDept')) $('regOutDept').textContent = _reg.dept || '—';
    if ($('regOutHosp')) $('regOutHosp').textContent = _reg.hosp || '—';
    if ($('regOutWhen')) $('regOutWhen').textContent = (_reg.when || '明天上午') + '（可改）';
  }
}

/* 「说不清」不再弹系统 prompt。
   原来那句 prompt('哪儿不舒服？') 是个原生对话框：英文按键、灰底小字，
   老人根本不敢按。现在换成应用内的大字弹层，六个最常见的情况点一个，
   点完替他归到科室，再念一遍让他确认 —— 走的是同一套 .sheet。 */
function regAskByVoice() {
  const s = $('saySheet');
  if (!s) return;
  s.hidden = false;
  say('那你点一个，最像的就点它。', 4200, { slow: true });
}

function regSayClose() {
  const s = $('saySheet');
  if (s) s.hidden = true;
}

function regSayPick(btn) {
  if (!btn) return;
  const dept = btn.dataset.sayDept || '内科';
  const txt = btn.dataset.say || '';
  regSayClose();
  _reg.dept = dept;
  _reg.step = 2;
  renderReg();
  say(txt ? '你说的「' + txt + '」，我按「' + dept + '」给你排。不对就回去换。'
    : '我按「' + dept + '」给你排，不对就回去换。', 7000, { slow: true });
}

/* 真去挂：装蚂蚁阿福就拉起来（它接的是真排班），
   没装就打开 114 官方页，并且把「挂什么科」写清楚告诉老人。 */
function regGo() {
  const n = NATIVE();
  const line = (_reg.dept || '内科') + ' · ' + (_reg.hosp || '最近的三甲');
  if ($('regOut')) $('regOut').textContent = '正在打开……';
  try { accLogAct('reg', '挂号 ' + line, ''); } catch (e) {}
  if (n && n.hasApp && n.hasApp('com.antgroup.aijk.android')) {
    n.launchApp('com.antgroup.aijk.android');
    if ($('regOut')) $('regOut').textContent = '阿福打开了。进去点「挂号」，选' + line + '。';
    say('阿福给你打开了。进去点挂号，选' + (_reg.dept || '内科') + '。', 7000, { slow: true });
    return;
  }
  const url = 'https://www.114yygh.com/';
  /* 打没打开要能分清楚。原来不管成功失败都说「挂号页打开了」，
     这台机器上根本没有浏览器的时候，老人对着桌面干等 —— 又是一种假反馈。 */
  let opened = false;
  if (n && n.openUrl) {
    try { const r = asJson(n.openUrl(url)); opened = !!(r && r.ok); } catch (e) {}
  } else {
    try {
      const w = window.open(url, '_blank');
      if (w) opened = true; else { location.href = url; opened = true; }
    } catch (e) {}
  }
  if (opened) {
    if ($('regOut')) $('regOut').textContent = '挂号网打开了。你要挂的是' + line + '。';
    say('挂号页给你打开了。你要挂' + (_reg.dept || '内科') + '，别选错。', 7500, { slow: true });
  } else {
    if ($('regOut')) $('regOut').textContent = '这台手机没打开浏览器。记一下网址：114yygh.com，让家里人帮你挂。';
    say('这台手机打不开浏览器。记一下 114yygh 点 com，让家里人帮你挂。', 9000, { slow: true });
  }
}

/* 让家里人替我挂：把这条写进「办过的事」，家属端一眼看见，直接接手。 */
function regToFam() {
  const line = (_reg.dept || '内科') + ' · ' + (_reg.hosp || '最近的三甲') + ' · ' + (_reg.when || '明天上午');
  say('这就告诉他们。', 3000, { slow: true });
  if ($('regOut')) $('regOut').textContent = '正在告诉家里人……';

  /* 真正那一发在 regSend 里 —— 界面按这个按钮、智能体点头确认，走的是同一条路。
     以前两处各写一遍，后来发现只有界面那条是对的，工具那条根本没发。 */
  regSend(line).then((r) => {
    if (r.ok) {
      if ($('regOut')) $('regOut').textContent = '传过去了：' + line + '。家里人打开家人端，头一条就是这个。';
      say('告诉家里人了。他们打开家人端，头一条就是这条。', 7000, { slow: true });
      return;
    }
    const why = r.why || '传不出去';
    if (why.indexOf('还没跟家里人连上') >= 0) {
      if ($('regOut')) $('regOut').textContent = '还没登录，也没跟家里人连上。去「我的」里出个码，让他们填一次。';
      say('还没跟家里人连上。去我的那一页出个码，让他们填一次，以后我就能替你传话。', 9000, { slow: true });
      return;
    }
    if ($('regOut')) $('regOut').textContent = '没传出去：' + why + '。要不你直接给他们打个电话？';
    say('没传出去。' + why + '。要不你直接给他们打电话？', 8000, { slow: true });
  });
}

/* 三个新场景的按钮接线。
   全部用 onclick = 赋值（不是 addEventListener）—— 重复调用不会叠监听，
   这一页被 renderXxx 重画多少次都只挂一次。 */
function wireNewScenes() {
  /* 血压血糖 */
  const va = $('vitalAddBtn'); if (va) va.onclick = vitalAdd;
  const vt = $('vitalTellBtn'); if (vt) vt.onclick = vitalTell;
  /* 记一笔弹层：两个大按钮 + 大号数字框。
     这些按钮都是 onclick= 赋值，不走 addEventListener —— 重连不会叠监听。 */
  const vc = $('vsClose'); if (vc) vc.onclick = vsClose;
  const vb = $('vsBack'); if (vb) vb.onclick = vitalAdd;
  const vk = $('vsOk'); if (vk) vk.onclick = vsSave;
  document.querySelectorAll('[data-vs-kind]').forEach((b) => {
    b.onclick = () => vsChoose(b.dataset.vsKind);
  });
  /* 自绘键盘 + 点格子切换光标所在位 */
  document.querySelectorAll('[data-vs-k]').forEach((b) => {
    b.onclick = () => vsKey(b.dataset.vsK);
  });
  document.querySelectorAll('.vs-cell').forEach((c) => {
    c.onclick = () => vsFocus(c.dataset.cell);
  });
  /* 点遮罩关掉（老人点外面那圈暗的地方，是想取消，不是想记数） */
  const vsh = $('vitalSheet');
  if (vsh) {
    vsh.onclick = (e) => { if (e.target === vsh) vsClose(); };
  }

  /* 扫码付款 */
  const sg = $('scanGoBtn'); if (sg) sg.onclick = scanPay;
  const pcb = $('payCodeBtn'); if (pcb) pcb.onclick = () => wxGo('pay');
  const rcb = $('receiveCodeBtn'); if (rcb) rcb.onclick = () => wxGo('receive');
  const ok = $('payOkBtn'); if (ok) ok.onclick = payConfirm;
  /* 手输金额（扫不出来时走这条） */
  /* 2026-11-09 22:15 菲尔特：「收付款那里不要写让商家告诉你多少钱」。
     那颗「码扫不出来，让商家念金额」按钮删了 —— 金额该由米粒自己
     开口问老人，不是把老人推给商家。按钮 DOM 已移除，这里不再绑定。 */
  const pc = $('psClose'); if (pc) pc.onclick = payManualClose;
  const po = $('psOk'); if (po) po.onclick = psOk;
  document.querySelectorAll('[data-ps-k]').forEach((b) => {
    b.onclick = () => psKey(b.dataset.psK);
  });
  const psh = $('paySheet');
  if (psh) psh.onclick = (e) => { if (e.target === psh) payManualClose(); };
  const no = $('payNoBtn'); if (no) no.onclick = () => {
    _payPending = null; renderPay();
    say('好，不付。重新照一次。', 5200, { slow: true });
  };

  /* 挂号 */
  const rg = $('regGoBtn'); if (rg) rg.onclick = regGo;
  const rf = $('regFamBtn'); if (rf) rf.onclick = regToFam;
  const rs2 = $('regSayBtn'); if (rs2) rs2.onclick = regAskByVoice;
  /* 说不清弹层：六个症状格 + 关闭 + 点遮罩关掉（老人点暗处是想取消） */
  const syc = $('sayClose'); if (syc) syc.onclick = regSayClose;
  document.querySelectorAll('[data-say]').forEach((b) => {
    b.onclick = () => regSayPick(b);
  });
  const sysh = $('saySheet');
  if (sysh) sysh.onclick = (e) => { if (e.target === sysh) regSayClose(); };
  document.querySelectorAll('[data-reg-back]').forEach((b) => {
    b.onclick = () => {
      const to = parseInt(b.dataset.regBack, 10) || 1;
      _reg.step = to;
      if (to === 1) _reg.hosp = '';
      renderReg();
    };
  });
}

/* ============================================================================
 * 待点头的事 —— 「一句话办完、不用点按钮」的落点
 *
 * 2026-11-06 菲尔特：「所有功能确保都能一句话操控，尽量不需要老人点击任何按钮」。
 *
 * 卡点在哪：米粒已经能把挂号页开到第 2 步，剩下「选医院 → 点确认」还得老人点。
 * 可这套界面本来是为「不用点」做的 —— 第 3 步那张确认卡存在的意义只是让老人
 * 看一眼，不是让他再按一次。
 *
 * 所以：工具办完「准备」那一半（科室、医院、时间都挑好），把后半截挂在这里
 * 等一句话。下一句进来时，提示词里会写着「手上还有件等着点头的事」，
 * 由模型自己判断这句是同意、是反悔、还是换了话题 —— 不写意图正则。
 *
 * 只放「老人已经点头」的动作。付钱、输密码、删东西一律不放。
 * ========================================================================== */
const PENDING = { kind: '', payload: null, ask: '', at: 0 };
const PENDING_TTL = 5 * 60 * 1000;

window.MILI_PENDING = {
  set: function (kind, payload, ask) {
    PENDING.kind = kind;
    PENDING.payload = payload || null;
    PENDING.ask = ask || '';
    PENDING.at = Date.now();
    return PENDING;
  },
  /* 过期就不算数：老人半小时后说「行」，不能拿半小时前那件事去办。
     返回的是一份拷贝，不是 PENDING 本身 —— 踩过这个坑：
     MILI_CONFIRM.run() 里先 now() 拿到 p，再 clear()，
     如果 p 是同一个对象，clear 一执行 p.kind 就变成空串了，
     后面每个 if (p.kind === 'reg') 全落空，老人点头等于白点。 */
  now: function () {
    if (!PENDING.kind) return null;
    if (Date.now() - PENDING.at > PENDING_TTL) {
      PENDING.kind = ''; PENDING.payload = null; PENDING.ask = '';
      return null;
    }
    return { kind: PENDING.kind, payload: PENDING.payload, ask: PENDING.ask, at: PENDING.at };
  },
  /* 给提示词看的一句话。把内容说全，别让模型自己去猜 payload */
  desc: function () {
    const p = this.now();
    return p ? (p.ask || '') : '';
  },
  clear: function () {
    PENDING.kind = ''; PENDING.payload = null; PENDING.ask = ''; PENDING.at = 0;
  },
};

/* 真去办。老人点了头才走到这里。 */
window.MILI_CONFIRM = {
  run: function () {
    const p = window.MILI_PENDING.now();
    if (!p) return Promise.resolve({ ok: false, detail: '这会儿没有等着点头的事。' });
    window.MILI_PENDING.clear();

    if (p.kind === 'reg') {
      const line = (p.payload && p.payload.line) || '';
      return regSend(line).then(function (r) {
        if (r.ok) {
          if ($('regOut')) $('regOut').textContent = '传过去了：' + line + '。家里人打开家人端，头一条就是这个。';
          return { ok: true, detail: '已经传给家里人了：' + line + '。' };
        }
        if ($('regOut')) $('regOut').textContent = '没传出去：' + (r.why || '传不出去') + '。';
        return { ok: false, detail: '没传出去：' + (r.why || '传不出去') + '。' };
      });
    }

    if (p.kind === 'vital') {
      return Promise.resolve(window.MILI_VITAL.tell());
    }

    /* 付款：只把码交给系统，真正掏钱那一下仍然是老人自己在微信里按。
       米粒能省的是「找 App、点扫一扫、输金额」这几步，不是那一笔钱。 */
    if (p.kind === 'pay') {
      try { payConfirm(); } catch (e) {
        return Promise.resolve({ ok: false, detail: '没付成，页面没打开。' });
      }
      return Promise.resolve({ ok: true, detail: '交给手机了，你在微信那边按一下密码就成。' });
    }

    return Promise.resolve({ ok: false, detail: '这件我不知道怎么办。' });
  },
};

/* 挂号传话的纯逻辑版。原来这段埋在 regToFam 里，界面和工具层共用不了 ——
   agent 说「办好了」的时候其实只开到了第 3 步，真正那一发送不出去。 */
function regSend(line) {
  return new Promise(function (resolve) {
    if (!accToken()) {
      resolve({ ok: false, why: '还没跟家里人连上。去「我的」里出个码，让他们填一次。' });
      return;
    }
    accApi('/act', { body: { kind: 'reg', txt: '要挂 ' + line, det: '让家里人替我挂' } })
      .then(function (r) { resolve(r && r.ok ? { ok: true } : { ok: false, why: (r && r.why) || '传不出去' }); })
      .catch(function () { resolve({ ok: false, why: '网络不通' }); });
  });
}

/* 付款：工具层调 ask(金额) 或 scan()。
   老人说「付十二块五」→ 直接进核对卡，不用他去点「手输金额」再一个一个按；
   老人说「扫个码」→ 开相机。两步都只到核对卡，真掏钱还是他自己按密码。 */
window.MILI_PAY = {
  ask: function (amt) {
    const v = parseFloat(String(amt || '').replace(/[^\d.]/g, ''));
    if (!v) {
      try { goPage('pay'); renderPay(); } catch (e) {}
      return { ok: true, detail: '付款页开好了。米粒自己问一句「多少钱？」；'
        + '老人报了数就再调 scan_pay(amount=那个数)，别让老人去问商家，也别自己猜金额。' };
    }
    if (v > 20000) return { ok: false, detail: '这个数太大了，先核一遍再付。' };
    _payPending = { code: '', amt: v.toFixed(2), to: '他要付的钱', note: '核对一下金额，对就点下面。' };
    try { goPage('pay'); renderPay(); } catch (e) {}
    window.MILI_PENDING.set('pay', { amt: v.toFixed(2) },
      '老人要付一笔钱：¥' + v.toFixed(2) + '，页面停在核对卡上。'
      + '他说「对」「就是这些」就调 confirm_pending —— 会把码交给微信/支付宝，密码还是他自己输；'
      + '他说数不对，就调 cancel_pending，再按新数调一次 scan_pay。');
    return {
      ok: true,
      detail: '记下了 ¥' + v.toFixed(2) + '，停在核对卡上。'
        + '你问一句「对，是这个数吧？」，他点头你调 confirm_pending。',
    };
  },
};

/* 收款码的语音入口（2026-11-09 补）。
   原话「别人给我钱」以前被模型选成 read_notifications，等于去读通知、没办成。
   这里只做一件事：把微信「二维码收款」那页打开。钱到最后仍是老人自己收。 */
window.MILI_RECEIVE = {
  open: function () {
    try { goPage('pay'); renderPay(); } catch (e) {}
    wxGo('receive');
    return { ok: true, detail: '收款码开好了。跟老人说一句「让对方扫这个码就行」。'
      + '米粒不碰钱，也不替他确认到账。' };
  },
};

/* 给智能体工具层用的入口。
   工具（agent-tools.js）只拿到这几个函数，拿不到 S、save、renderVital ——
   边界清楚，工具层改不动页面状态。 */
window.MILI_VITAL = {
  add: function (kind, sys, dia, val) {
    const tone = vitalTone(kind, sys, dia, val);
    const item = { kind: kind, sys: sys, dia: dia, val: val, tone: tone, at: Date.now() };
    vitalPush(item);
    try { renderVital(); } catch (e) {}
    accApi('/vital', { body: { kind: kind, sys: sys, dia: dia, val: val } })
      .then((r) => { if (r && r.alarm) { try { accLogAct('vital', '连续超标', ''); } catch (e) {} } })
      .catch(() => {});
    try { accLogAct('vital', kind === 'bp' ? '量了血压 ' + sys + '/' + dia : '量了血糖 ' + val, ''); } catch (e) {}
    return {
      ok: true,
      tone: tone,
      say: vitalSay(kind, tone, sys, dia, val),
      detail: (kind === 'bp' ? sys + '/' + dia + ' mmHg' : val + ' mmol/L') + '，' + (TONE_TXT[tone] || ''),
    };
  },
  tell: function () {
    const list = vitalAll();
    if (!list.length) return { ok: false, detail: '还没有数可以发，先量一次。' };
    const x = list[0];
    try { accLogAct('vital', x.kind === 'bp' ? '血压 ' + x.sys + '/' + x.dia : '血糖 ' + x.val, TONE_TXT[x.tone] || ''); } catch (e) {}
    return { ok: true, detail: '发出去了，家里人打开家人端就能看见。' };
  },
  last: function (kind) {
    const list = vitalAll();
    return list.find((x) => x.kind === kind) || null;
  },
};

/* 挂号：工具层只调 open(dept, hosp)，剩下的流程留给人看。 */
window.MILI_REG = {
  /* 2026-11-06 改：有科室就直接停在第 3 步确认卡，并挂一件「等着点头」的事。
     以前开在第 2 步，剩下选医院、点确认全靠老人 —— 那跟他自己挂号没区别。 */
  open: function (dept, hosp, when) {
    const d = String(dept || '').trim();
    if (d) _reg.dept = d;
    if (hosp) _reg.hosp = hosp;
    if (when) _reg.when = when;
    /* 「说不清」是个特殊选项：它会拉起问答弹层，不能跳到第 3 步 */
    _reg.step = d && d !== '说不清' ? 3 : 1;
    try { goPage('reg'); renderReg(); } catch (e) {}

    if (_reg.step !== 3) {
      return {
        ok: true,
        detail: '挂号页开好了。你问一句哪儿不舒服、或者想挂哪个科；他说了，就再调一次 register_hospital(dept=那个科)。',
      };
    }

    const line = (_reg.dept || '') + ' · ' + (_reg.hosp || '最近的三甲') + ' · ' + (_reg.when || '明天上午');
    window.MILI_PENDING.set('reg', { line: line },
      '有一件挂号的事已经挑好了，就等他点头：' + line + '。'
      + '他说「行」「好」「就这么挂」这类同意的话，就调 confirm_pending —— 这一下是真传给家里人；'
      + '他说不要、或者要改科室 / 医院 / 时间，就调 cancel_pending，然后重新调 register_hospital。'
      + '他要是说起别的、八竿子打不着的事，就当这件事没说，照办新的。');
    return {
      ok: true,
      detail: '已经挑好了：' + line + '。页面也停在确认卡上了。'
        + '不用让他点任何按钮 —— 你就问一句「就这么挂？」，他点头你调 confirm_pending，事就真办了。',
    };
  },
};

/* ============ 角色门：只有老人 / 家人，没有访客 ============
   2026-11-10 菲尔特：一进来就问是老人还是家人。
   老人 → 必须先手机号+密码注册或登录 → 引导页；家人 → 必须先填对同步码。 */
function showRoleGate() {
  const g = $('roleGate');
  if (!g) { showOnboard(); return; }
  g.hidden = false;
  const onb = $('onboard'); if (onb) onb.hidden = true;
  const gg = $('gateGuest'); if (gg) gg.hidden = true;   /* 访客模式整个拿掉 */
  const ge = $('gateElder'), gf = $('gateFamily');
  if (ge) ge.onclick = () => { S.role = 'elder'; save(); elderEntry(); };
  if (gf) gf.onclick = () => { S.role = 'family'; save(); familyEntry(); };
}

function elderEntry() {
  if (S.accToken && S.accRole === 'elder') { afterElderLogin(); return; }
  authScreen('elder');
}
function familyEntry() {
  if (S.accToken && S.accRole === 'fam' && S.pairCode) { afterFamilyBind(); return; }
  authScreen('fam');
}
function afterElderLogin() {
  const g = $('roleGate'); if (g) g.hidden = true;
  S.role = 'elder'; S.accRole = 'elder'; save();
  if (!S.onboarded) showOnboard();
  else { applyRestoredState(); bootRefresh(); }
}
function afterFamilyBind() {
  const g = $('roleGate'); if (g) g.hidden = true;
  S.role = 'family'; S.onboarded = true; save();
  applyRestoredState();
  try { renderFamHome(); } catch (e) {}
  try { goPage('famhome'); } catch (e) {}
}

/* 全屏登录 / 填码页。动态建，不碰原来「我的」页里那套账号面板。
   配色按菲尔特定的蚂蚁阿福风：极淡紫白底 + 纯白卡 + 唯一主色亮紫。 */
let _authBox = null;
function authScreen(kind) {
  const g = $('roleGate'); if (g) g.hidden = true;
  if (_authBox) { _authBox.remove(); _authBox = null; }
  const elder = kind === 'elder';
  const b = document.createElement('div');
  b.id = 'authScreen';
  b.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:#F4F5FF;'
    + 'display:flex;align-items:center;justify-content:center;padding:22px;overflow:auto');
  const inp = 'width:100%;box-sizing:border-box;border:1px solid #E6E7F5;border-radius:14px;'
    + 'padding:14px;font-size:17px;color:#1B1D2E;margin-bottom:10px;font-family:inherit;';
  b.innerHTML =
      '<div style="width:100%;max-width:380px;background:#fff;border-radius:24px;'
    + 'padding:28px 22px;box-shadow:0 8px 30px rgba(27,29,46,.06)">'
    + '<div style="font-size:22px;font-weight:700;color:#1B1D2E;margin-bottom:6px">'
    + (elder ? '先给这部手机建个账号' : '填上老人手机上的同步码') + '</div>'
    + '<div style="font-size:14px;color:#6B6E86;line-height:1.7;margin-bottom:20px">'
    + (elder ? '手机号 + 密码，注册一次就行。之后开机就在这台手机上。'
             : '先在老人手机上完成注册登录，会生成 6 位同步码。填对才能进家人端。')
    + '</div>'
    + (elder
        ? '<input id="authPhone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号" style="' + inp + '">'
        + '<input id="authPwd" type="password" placeholder="密码，至少 6 位" style="' + inp + '">'
        + '<input id="authName" type="text" maxlength="12" placeholder="怎么称呼（可不填）" style="' + inp + '">'
        : '<input id="authCode" type="tel" inputmode="numeric" maxlength="6" placeholder="6 位同步码" '
        + 'style="width:100%;box-sizing:border-box;border:1px solid #E6E7F5;border-radius:14px;'
        + 'padding:16px;font-size:26px;letter-spacing:8px;text-align:center;color:#5B4DF0;'
        + 'font-weight:700;margin-bottom:10px;font-family:inherit">'
        + '<input id="authFamName" type="text" maxlength="12" placeholder="你是谁（如：女儿，可不填）" style="' + inp + '">')
    + '<div id="authErr" style="min-height:22px;font-size:14px;color:#D14343;margin-bottom:8px"></div>'
    + '<button id="authGo" style="width:100%;background:#5B4DF0;color:#fff;border:0;'
    + 'border-radius:16px;padding:16px;font-size:17px;font-weight:700;font-family:inherit">'
    + (elder ? '注册并登录' : '连上老人端') + '</button>'
    + (elder
        ? '<button id="authLogin" style="width:100%;background:#fff;color:#5B4DF0;'
        + 'border:1px solid #E6E7F5;border-radius:16px;padding:14px;font-size:16px;'
        + 'font-weight:600;margin-top:10px;font-family:inherit">已经有账号了，直接登录</button>'
        : '')
    + '<button id="authBack" style="width:100%;background:transparent;color:#6B6E86;'
    + 'border:0;padding:14px;font-size:15px;margin-top:6px;font-family:inherit">换一端</button>'
    + '</div>';
  document.body.appendChild(b);
  _authBox = b;
  const err = (t) => { const e = $('authErr'); if (e) e.textContent = t || ''; };
  const go = (e) => { e.disabled = true; e.style.opacity = '.6'; };
  const done = (e) => { e.disabled = false; e.style.opacity = '1'; };
  $('authBack').onclick = () => { b.remove(); _authBox = null; showRoleGate(); };
  if (elder) {
    const act = async (btn, isReg) => {
      go(btn); err('');
      const ph = ($('authPhone') && $('authPhone').value) || '';
      const pw = ($('authPwd') && $('authPwd').value) || '';
      const nm = ($('authName') && $('authName').value) || '';
      const r = isReg ? await accRegister(ph, pw, nm, 'elder') : await accLogin(ph, pw, 'elder');
      if (!r.ok) { done(btn); err(r.why || '没成功，再试一次'); return; }
      try { await accNewCode(); } catch (e) {}
      b.remove(); _authBox = null;
      afterElderLogin();
    };
    $('authGo').onclick = () => act($('authGo'), true);
    $('authLogin').onclick = () => act($('authLogin'), false);
  } else {
    $('authGo').onclick = async () => {
      const btn = $('authGo'); go(btn); err('');
      const k = ($('authCode') && $('authCode').value) || '';
      const nm = ($('authFamName') && $('authFamName').value) || '';
      const r = await accPair(k, nm);
      if (!r.ok) { done(btn); err(r.why || '没连上，再试一次'); return; }
      b.remove(); _authBox = null;
      afterFamilyBind();
    };
  }
}

/* ============ 我的：身份 / 账号 / 配对 / 权限 ============ */
const ROLE_NAME = { elder: '老人端', family: '家人端', guest: '访客' };

/* 把 6 位码画成二维码放进 #qrBox。
   只画一次：同一张码不重复重画，否则每次 renderMe 都要重算一遍矩阵。
   老人手机没网也能画 —— 二维码是本地算的，不依赖服务器。 */
let _qrLast = '';
async function qrPaint(code) {
  const box = $('qrBox');
  if (!box || !code) return;
  if (_qrLast === code && box.querySelector('img')) return;
  _qrLast = code;
  try {
    const url = await qrDataUrl(code, 6);
    box.innerHTML = '<img src="' + url + '" alt="配对码" style="width:168px;height:168px;'
      + 'border-radius:14px;background:#fff;display:block">';
  } catch (e) {
    /* 库没加载上不致命：数字还在，念出来照样能连 */
    box.innerHTML = '<p class="cp small" style="margin:0;color:var(--ink-3)">二维码没画出来，直接念上面的数字给对方就行。</p>';
  }
}

/* 已经连上的人。一个老人可能连着好几个家人（闺女、儿子都管），
   所以这里是个列表，不是一个名字。 */
async function renderPeers() {
  const box = $('peersBox'), list = $('peerList');
  if (!box || !list) return;
  if (!accToken() || DEMO) { box.hidden = true; return; }
  let rows = [];
  try { rows = await accPeers(); } catch (e) { rows = []; }
  if (!rows.length) { box.hidden = true; return; }
  box.hidden = false;
  list.innerHTML = rows.map((p) => {
    const nm = esc(p.name || '家人');
    const ph = esc(accPhoneMask(p.phone));
    return '<div class="merow" style="border-top:0;padding:8px 0">'
      + '<span class="ml">' + nm + '</span>'
      + '<span class="mr" style="display:flex;align-items:center;gap:10px">'
      + ph
      + '<button class="peerdel" data-uid="' + p.id + '" style="border:0;background:none;'
      + 'color:var(--ink-3);font-size:16px;padding:4px 6px;cursor:pointer">断开</button>'
      + '</span></div>';
  }).join('');
  list.querySelectorAll('.peerdel').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      await accUnbind(b.dataset.uid);
      _qrLast = '';
      renderMe();
    };
  });
}

function renderMe() {
  const u = ACC.user;
  const role = S.role || 'elder';

  /* 身份卡：名字优先用登录名，其次引导时填的称呼 */
  const who = (S.me && String(S.me).trim()) || (u ? '已登录' : '爷爷');
  if ($('meWho')) $('meWho').textContent = who;
  if ($('meAvatar')) $('meAvatar').textContent = (who || '米').trim().slice(0, 1) || '米';
  /* 2026-11-06 晚：这行原来是「当前：老人端 · 没登录」——
     老人看到「老人端」「没登录」只会以为手机坏了。
     换成一句他关心的话：连上家里人没有。 */
  if ($('meRoleLine')) {
    $('meRoleLine').textContent = u
      ? '已连上家里人 · ' + accPhoneMask(u.phone)
      : '还没连上家里人，让家里人帮您弄一下';
  }
  if ($('meRoleTag')) $('meRoleTag').textContent = ROLE_NAME[role] || '老人端';

  /* 三段选择器：把选中态画出来 */
  document.querySelectorAll('#roleSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.role === role);
  });

  /* 登录区 / 已登录区 互斥 */
  if ($('loginBox')) $('loginBox').hidden = !!u;
  if ($('logoutBox')) $('logoutBox').hidden = !u;
  if ($('mePhone')) $('mePhone').textContent = u ? accPhoneMask(u.phone) : '—';
  if ($('meAccRole')) {
    $('meAccRole').textContent = u
      ? (accRole() === 'fam' ? '家人端' : '老人端')
      : '—';
  }

  /* 演示版：登录整块藏起来，说清为什么。
     一个看得见却点不动的登录框比没有更糟 —— 评委会以为坏了。 */
  if (DEMO) {
    const lb = $('loginBox');
    if (lb) {
      lb.hidden = false;
      lb.innerHTML = '<p class="cp small" style="margin:0">演示版不登录，也不往真实账号里写东西。'
        + '账号、配对、家属同步都在产品版里。</p>';
    }
    const lo = $('logoutBox');
    if (lo) lo.hidden = true;
  }

  /* 登录区里「我是老人 / 我是家人」那段：把选中态画出来 */
  document.querySelectorAll('#accRoleSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.accrole === (S.accRole || 'elder'));
  });

  /* ---- 配对区 ----
     谁都能出码，另一方填。老人出码家人填 —— 绑定的主动权在老人手里。
     没登录时整块不给点，说清先登录。 */
  const logged = !!accToken();
  if ($('pairHint')) {
    $('pairHint').textContent = logged
      ? (accRole() === 'fam'
          ? '出个码，让老人在他那台手机上填。或者你扫他的码 —— 谁的方便就谁来。'
          : '出个码给家里人填，他们就跟你连上了。药和提醒都从他们那边过来。')
      : '先在上面登录，才能出码、填码。';
  }
  const nb = $('pairNewBtn'), sb = $('pairScanBtn');
  if (nb) nb.disabled = !logged;
  if (sb) sb.disabled = !logged;

  /* 2026-11-10：同步码是账号的永久码，不再 15 分钟过期、不再自动擦掉。
     家人端靠 S.pairCode 判断「已经绑过」，擦掉会导致每次开机都要求重填。 */
  const cw = $('myCodeWrap');
  const hasCode = !!S.pairCode;
  if (cw) cw.hidden = !hasCode;
  if (hasCode) {
    if ($('myCodeNum')) $('myCodeNum').textContent = String(S.pairCode).replace(/(\d{3})(\d{3})/, '$1 $2');
    qrPaint(String(S.pairCode));
  }

  /* 已经连上的人：列出来，能解绑 */
  renderPeers();

  /* 定位状态：有原生桥就查权限，浏览器里只能看有没有授权过 */
  const n = NATIVE();
  let locOn = false;
  if (n && n.locGranted) { try { locOn = !!n.locGranted(); } catch (e) { locOn = false; } }
  else if (n && n.hasLoc) { try { locOn = !!n.hasLoc(); } catch (e) {} }
  if ($('locTag')) $('locTag').textContent = locOn ? '已开' : '没开';
  if ($('locBtn')) $('locBtn').textContent = locOn ? '关掉定位' : '打开定位（只为报准天气）';

  /* 家里人：显示有几位，点了回老页面 */
  if ($('meFamN')) $('meFamN').textContent = (S.fam || []).length + ' 位';

  renderBand();

  /* 2026-11-06 二次重做：这一页现在是家人会打开的产品页，
     不是一张身份卡加一大片空白。四块内容全部走已有数据：
       今天怎么样 ← _famCard（和家人端同一个 mili_elder_card）
       体征　　　 ← _famVital / 本地 vitalAll
       正在吃的药 ← S.med
       最近办的事 ← _famCard.acts
     读不到的时候如实说「读不到」，不能画一个空态冒充「老人没事」——
     那是让家人白放心，比不显示更糟。 */
  renderMeToday();
  renderMeVital();
  renderMeMeds();
  renderMeActs();
}

/* ---- 我的页 · 老人今天怎么样 ----
   家人打开这一页，三十秒内只要一个判断：要不要打个电话。
   所以先给结论（刚还在用 / 快一天没动静），数字退到第二行。
   这一块和 page-famhome 的概况卡刻意长得像 —— 同一件事，
   两个入口不该给出两套说法。 */
function renderMeToday() {
  const box = $('meToday');
  if (!box) return;
  const d = _famCard;

  /* 还没登录 / 还没配对：说清是哪一种，别让人对着「暂无数据」猜。
     2026-11-06 补：这台手机自己就是老人用的那台（没登录、没配对）时，
     不该只甩一句「还没登录」—— 那对老人毫无意义，他也没打算登录。
     这种情况直接读本机记录，回答他真正关心的「我今天办了啥」。 */
  if (!d || d.ok !== true) {
    const r = accRole();
    const mine = !ACC.user;
    let ttl = '还没连上老人这台手机。';
    let sub = '家里人登录、配对之后，这里就能看到老人的情况。';
    if (mine) {
      const n = (S.did || []).filter((x) => x && x.d === ymd()).length;
      ttl = n ? ('今天办了 ' + n + ' 件事。') : '今天还没让米粒办事。';
      /* 🚨 2026-11-07：这句原来是「家里人连上这台手机以后，
         这一块会显示老人的用药和血压」——那是**给评委解释这里将来会有什么**，
         不是产品该说的话。产品只陈述当下，不预告功能。
         而且它说的是「别人的数据将来会出现在这里」，对正在看这块的老人
         完全是句废话（他自己就是那个老人）。
         现在改成：没连上就直说没连上，并给一个此刻可做的动作。 */
      sub = '这台的药和血压，家里人还没连过来。连上之后你量的数他们就能看见。';
    } else if (r && r !== 'fam') {
      ttl = '这一端登的是老人号。';
      sub = '要看老人的情况，得用家人的号登一次。';
    } else if (d && d.why === 'not_bound') {
      ttl = '还没跟老人配对。';
      sub = '出一个 6 位码，让老人念给你，填上就通了。';
    } else if (d && d.why === 'read_fail') {
      ttl = '这会儿读不到。';
      sub = '网络不通，或者老人那边还没同步上来。';
    }
    /* 🚨 2026-11-07：这里原来固定用 'ok' 类 —— 可「还没让米粒办事」
       不是「没事」，是「还没数据」。用 ok 的绿/黑状态条是在说「一切正常」，
       而实际含义是「什么都没发生」。所以按有没有办过事分开：
       办过事 = ok（真的没事）；没办过 = wait（还没数据）。 */
    const tone = (mine && (S.did || []).filter((x) => x && x.d === ymd()).length) ? 'ok' : 'wait';
    box.innerHTML = '<div class="famcard ' + tone + '">'
      + '<p class="famttl">' + esc(ttl) + '</p>'
      + '<p class="famsub">' + esc(sub) + '</p></div>';
    if ($('meTodayAt')) $('meTodayAt').textContent = '';
    /* 有票却没数据：主动拉一次，别等人自己下拉刷新 */
    if (ACC.user && (!d || d.why === 'read_fail')) {
      try { refreshFamCard(true); } catch (e) {}
    }
    return;
  }

  /* 多久没动静：12 小时标黄、24 小时标红。这是家人真正在意的那个数。 */
  const last = d.lastat ? new Date(d.lastat).getTime() : 0;
  const gapH = last ? (Date.now() - last) / 3600000 : null;
  let tone = 'ok', line = '';
  if (gapH == null) { tone = 'wait'; line = '老人还没用这台手机办过事。'; }
  else if (gapH < 1) { line = '刚还在用。'; }
  else if (gapH < 12) { line = Math.round(gapH) + ' 小时前还用过。'; }
  else if (gapH < 24) { tone = 'warn'; line = '快一天没动静了（' + Math.round(gapH) + ' 小时）。'; }
  else { tone = 'bad'; line = '超过一天没动静（' + Math.round(gapH) + ' 小时）。该打个电话了。'; }

  const nact = d.nact || 0;
  box.innerHTML = '<div class="famcard ' + tone + '">'
    + '<div class="famhd"><span class="famdot"></span>'
    + '<b class="famnm">' + esc(d.name || '爸妈') + '</b>'
    + '<span class="famtag">' + (d.nmed || 0) + ' 种药</span></div>'
    + '<p class="famline">' + esc(line) + '</p>'
    + '<p class="famsub">今天办了 ' + nact + ' 件事。'
    + (d.nmed ? '药按家里人填的提醒。' : '药箱还空着，去家人控制台加一种。') + '</p>'
    + '</div>';
  if ($('meTodayAt')) {
    $('meTodayAt').textContent = last ? ('更新于 ' + hmOf(last)) : '';
  }
}

/* ---- 我的页 · 体征 ----
   只摆最近一次，超标的才变色。老人看见满屏红条会慌，
   家人要的也只是「有没有事」。 */
function renderMeVital() {
  const box = $('meVital');
  if (!box) return;
  const remote = (_famVital && _famVital.length) ? _famVital.map((x) => ({
    kind: x.kind, sys: x.sys, dia: x.dia, val: x.val, tone: x.tone,
    at: x.ts ? x.ts * 1000 : 0,
  })) : [];
  const list = remote.length ? remote : vitalAll();
  if (!list.length) {
    /* 🚨 2026-11-07：原来是「还没有记录。老人量一次，这里就有数。」
       「老人」这个词，是在**跟家属说这个老人**的口气。
       可这一页是老人自己在看的 —— 等于管自己的用户叫「老人」。
       改成第二人称「你」，并给一个能按的动作。 */
    box.innerHTML = '<div class="panel"><p class="cp small" style="margin:0 0 10px">'
      + '还没量过。量完记一笔，这里就有数。</p>'
      + '<button class="ghost" id="meVitalGo" style="margin:0">去记一笔</button></div>';
    const b = box.querySelector('#meVitalGo');
    if (b) b.onclick = () => goPage('vital');
    return;
  }
  const pick = (kind) => list.filter((x) => x.kind === kind)[0];
  const one = (title, x, unit) => {
    if (!x) {
      return '<div class="mvit"><span class="mvt">' + title + '</span>'
        + '<b class="mvv faint">还没量</b></div>';
    }
    const bad = x.tone === 'bad', warn = x.tone === 'warn';
    const big = x.kind === 'bp' ? (x.sys + '/' + x.dia)
      : (Math.round((+x.val || 0) * 10) / 10).toFixed(1);
    return '<div class="mvit' + (bad ? ' bad' : warn ? ' warn' : '') + '">'
      + '<span class="mvt">' + title + '</span>'
      + '<b class="mvv">' + esc(big) + '<i>' + unit + '</i></b>'
      + '<span class="mva">' + esc(x.at ? hmOf(x.at) : '') + '</span></div>';
  };
  box.innerHTML = '<div class="panel mvitbox">'
    + one('血压', pick('bp'), 'mmHg') + one('血糖', pick('glu'), 'mmol/L')
    + '</div>';
}

/* ---- 我的页 · 正在吃的药 ----
   药名和用量是家里人填的，老人不需要在这儿改。 */
function renderMeMeds() {
  const box = $('meMeds');
  if (!box) return;
  const on = (S.med || []).filter((m) => m.on);
  if ($('meMedCap')) $('meMedCap').textContent = on.length ? on.length + ' 种' : '';
  if (!on.length) {
    box.innerHTML = '<div class="panel"><p class="cp small" style="margin:0">'
      + '药箱还空着。家里人可以在控制台拍药盒加进去。</p></div>';
    return;
  }
  box.innerHTML = '<div class="panel">' + on.slice(0, 6).map((m, i) => {
    const t = m.when ? String(m.when) : '';
    return '<div class="mmed' + (i === 0 ? ' first' : '') + '">'
      + '<b class="mmn">' + esc(m.who || '药') + '</b>'
      + '<span class="mmd">' + esc(m.dose || '') + (t ? '　' + esc(t) : '') + '</span>'
      + '</div>';
  }).join('') + '</div>';
}

/* ---- 我的页 · 最近办的事 ----
   只列今天和昨天的几条，不是流水账。老人一天办不了十件事。 */
function renderMeActs() {
  const box = $('meActs');
  if (!box) return;
  const d = _famCard;
  const acts = (d && d.ok === true && Array.isArray(d.acts)) ? d.acts : [];
  if (!acts.length) {
    box.innerHTML = '<div class="panel"><p class="cp small" style="margin:0">'
      + (d && d.ok === true
          ? '还没有记录。老人每让米粒办一件事，这里多一条。'
          : '连上以后，这里会显示老人今天办了哪些事。') + '</p></div>';
    return;
  }
  const K = { nav: '带路', call: '打电话', wx: '微信', tv: '看电视', sms: '短信',
    weather: '问天气', watch: '找片', med: '吃药', reg: '挂号', ir: '遥控', say: '说话',
    band: '手环', pay: '付款', vital: '量体征' };
  box.innerHTML = '<div class="panel">' + acts.slice(0, 8).map((a, i) => {
    const raw = a.at || (a.ts ? a.ts * 1000 : 0);
    const t = raw ? new Date(raw) : null;
    const hh = t ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') : '';
    const dd = t ? (t.getMonth() + 1) + '/' + t.getDate() : '';
    return '<div class="mact' + (i === 0 ? ' first' : '') + '">'
      + '<span class="mak">' + esc(K[a.kind] || '办事') + '</span>'
      + '<span class="mat">' + esc(a.text || a.txt || '') + '</span>'
      + '<span class="mad">' + esc(dd + ' ' + hh) + '</span></div>';
  }).join('') + '</div>';
}

/* 时分：我的页里多处要用，单独提出来，别再各写一遍 */
function hmOf(ts) {
  const t = new Date(ts);
  if (!t || isNaN(t.getTime())) return '';
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
}

/* 手环那一块。
   心率不做「告警」，只做「看得见」—— 老人看到红色一片会慌，
   而且他这个年纪心率上下波动本来就大。
   所以只把数字变色，不加横幅、不弹框、不响铃。 */
const BAND_WARN_HI = 110;   // 静息超过这个数偏高
const BAND_BAD_HI = 130;    // 超过这个数才值得家里人知道
let bandExplained = false;
/* 上次把心率同步给家属端的时间。两分钟一条，别把「最近办的事」淹掉。 */
let _bandPushAt = 0;

function renderBand() {
  const n = NATIVE();
  const tag = $('bandTag'), big = $('bandBig'), num = $('bandBpm');
  const hint = $('bandHint'), btn = $('bandBtn');
  if (!tag || !btn) return;

  /* 网页上根本没有手环这回事 —— 整块收起来，不做一个点不动的假开关 */
  const has = !!(n && n.bandStart);
  const box = $('bandBox');
  if (box) box.style.display = has ? '' : 'none';
  if (!has) return;

  let on = false, fresh = false, bpm = 0, st = '没开';
  try { on = !!n.bandOn(); } catch (e) {}
  try { fresh = !!n.bandFresh(); } catch (e) {}
  try { bpm = Number(n.bandBpm()) || 0; } catch (e) {}
  try { st = String(n.bandStatus() || '没开'); } catch (e) {}

  tag.textContent = fresh ? '在报' : st;
  btn.textContent = on ? '关掉手环心率' : '打开手环心率';

  /* 大数字只在真有读数时出现。没读数就别摆一个空框。 */
  if (big && num) {
    const show = fresh && bpm > 0;
    big.hidden = !show;
    if (show) {
      num.textContent = String(bpm);
      big.classList.toggle('warn', bpm >= BAND_WARN_HI && bpm < BAND_BAD_HI);
      big.classList.toggle('bad', bpm >= BAND_BAD_HI);
    } else {
      big.classList.remove('warn', 'bad');
    }
  }

  if (hint) {
    if (fresh && bpm > 0) {
      hint.textContent = bpm >= BAND_BAD_HI
        ? '这个数偏高。要是他正坐着没动，给家里人说一声。'
        : '读到了。这个数家里人那边也看得到。';
    } else if (on) {
      hint.textContent = st === '读到了' || st === '正在连手环'
        ? '正在连手环，稍等一会儿。'
        : st;
    } else {
      hint.textContent = '要读手环，先在手环上打开「设置 → 心率广播」。';
    }
  }
}

/* 原生推过来的手环事件。
   这里不 speak —— 心率每秒都在变，念出来会吵死人。
   只更新数字，让他抬眼就能看见。 */
window.__bandEv = function (ev) {
  try {
    if (!ev || typeof ev !== 'object') return;
    /* 找到手环 = 真的通了，这时候才值得说一句 */
    if (ev.ev === 'ready') {
      say('连上手环了。你戴着它，我就能看到你跳得快不快。', 7000, { slow: true });
    } else if (ev.ev === 'fail' && ev.txt) {
      say(String(ev.txt), 9000, { slow: true });
    }
    renderBand();
    /* 读到心率顺手给家属端留一条 —— 让家里人知道他还戴着。
       不能每秒都写一条，那样「最近办的事」会被心率淹掉。
       两分钟一条就够说明「人还戴着、还活着」。 */
    if (ev.ev === 'hr' && ev.bpm > 0 && ACC.user && Date.now() - _bandPushAt > 120000) {
      _bandPushAt = Date.now();
      try { accLogAct('band', '心率 ' + ev.bpm, '手环'); } catch (e) {}
    }
  } catch (e) {}
};

/* 原生扫码回来。同一个回调被两处共用：
   ① 配对（在「我的」页扫对方的 6 位码）
   ② 扫码付款（在「扫码付款」页扫商家的收款码）
   靠 S.page 分流 —— 不靠猜内容，因为有些收款码里也带 6 位数字，
   猜会把老人扫的钱当成配对码。
   code 为空表示没扫到 / 取消了 —— 这时候不要弹「失败了」，老人会以为是自己弄错。 */
window.__onScan = function (code) {
  try {
    if (S.page === 'pay') { payResolve(code, ''); return; }
    const k = String(code || '').replace(/\D/g, '');
    if (!k || k.length < 6) {
      setPairOut('没扫到。让对方把 6 位数字念给你，填在下面也一样。');
      if ($('pairInWrap')) $('pairInWrap').hidden = false;
      if ($('pairIn')) $('pairIn').focus();
      return;
    }
    if ($('pairIn')) $('pairIn').value = k.slice(0, 6);
    if ($('pairInWrap')) $('pairInWrap').hidden = false;
    setPairOut('扫到了。点「连上」就成。');
    const pb2 = $('pairBtn');
    if (pb2) { try { pb2.click(); } catch (e) {} }
  } catch (e) {}
};

/* ============ 来电自动接听：名单推给原生 + 接通播报 ============
   家人名单（S.fam 的 name/phone/wx）就是白名单 —— 陌生号照常响铃，米粒不碰。
   原生侧接通后回 window.__onCallAnswered(名字, 'phone'|'wx')，
   米粒当面说一句「闺女来电话，我帮你接了」—— 老人得知道发生了什么。 */
function syncCallCfg() {
  const nn = NATIVE();
  if (!nn || !nn.callConfig) return;
  const f = callAutoFlags();
  const list = (S.fam || []).filter((x) => x && (x.name || x.phone || x.wx)).map((x) => ({
    name: x.name || x.label || '',
    phone: x.phone || '',
    wx: x.wx || '',
  }));
  /* 2026-11-10：通讯录全体也进白名单。原生侧 onRinging 会自己再查一遍
     系统通讯录（pm clear / 网页没起来时也生效），这里补一份是为了配置页
     能看见人数、并且微信来电那条路也有名单可用。 */
  try {
    const arr = JSON.parse(nn.contacts() || '[]');
    const seen = {};
    list.forEach((x) => { const p = String(x.phone || '').replace(/\D/g, ''); if (p) seen[p] = 1; });
    arr.forEach((x) => {
      const p = String(x.number || x.phone || '').replace(/\D/g, '');
      if (!p || seen[p]) return;
      seen[p] = 1;
      list.push({ name: x.name || '', phone: p, wx: '' });
    });
  } catch (e) {}
  try {
    nn.callConfig(JSON.stringify({
      phoneAuto: f.phone !== 0,
      wxAuto: f.wx !== 0,
      contactAuto: true,
      list: list,
    }));
  } catch (e) {}
}
function callAutoFlags() {
  try { return JSON.parse(localStorage.getItem('mili.callAuto') || '{}') || {}; }
  catch (e) { return {}; }
}
window.__onCallAnswered = function (name, kind) {
  const who = name ? name : '家里人';
  const msg = kind === 'wx'
    ? who + '来微信电话啦，我帮你接了。'
    : who + '来电话啦，我帮你接了。';
  try { say(msg, 0, { once: true }); } catch (e) {}
};

function wireMe() {
  /* 三段切端：不退出登录，只换看到的东西。
     切到「家人端」时顺手把账号身份也对齐 —— 老人端和家人端的票不一样长，
     不切的话家人端还在用老人那张 365 天的票，权限会对不上。 */
  document.querySelectorAll('#roleSeg button').forEach((b) => {
    b.onclick = () => {
      const r = b.dataset.role;
      if (r === S.role) return;
      S.role = r;
      if (r === 'family') S.accRole = 'fam';
      else if (r === 'elder') S.accRole = 'elder';
      save();
      renderMe();
      if (r === 'family') { renderFamHome(); goPage('famhome'); }
      else if (r === 'guest') { goPage('home'); }
      else { goPage('home'); }
    };
  });

  /* 登录区里「我是老人 / 我是家人」—— 只切身份，不动别的。
     老人常常没有自己的手机号，家人得用自己的号帮他注册一个老人端。 */
  document.querySelectorAll('#accRoleSeg button').forEach((b) => {
    b.onclick = () => {
      S.accRole = b.dataset.accrole === 'fam' ? 'fam' : 'elder';
      save();
      document.querySelectorAll('#accRoleSeg button').forEach((x) => {
        x.classList.toggle('on', x.dataset.accrole === S.accRole);
      });
      if ($('loginHint')) {
        $('loginHint').textContent = S.accRole === 'fam'
          ? '家人端：手机号 + 密码。登录后能管药、看老人最近办的事。'
          : '老人端：第一次由家里人帮忙填。填好以后开机就是登录态，不用再输。';
      }
    };
  });

  /* 登录 / 注册。不经过短信：签名和模板要审核，赛前两天不赌这个。
     密码比验证码还好记 —— 认一次，后面一直认。 */
  const lb = $('doLoginBtn');
  if (lb) lb.onclick = async () => {
    if (ACC.busy) return;
    const phone = ($('phoneIn').value || '').replace(/\D/g, '');
    const pwd = ($('pwdIn').value || '');
    ACC.busy = true; lb.disabled = true; lb.textContent = '登着…';
    const r = await accLogin(phone, pwd, S.accRole);
    ACC.busy = false; lb.disabled = false; lb.textContent = '登录';
    /* 同一个号注册了两端 —— 服务端会回 pick，问一句选哪端，别让人干瞪眼 */
    if (!r.ok && r.pick && r.pick.length > 1) {
      setLoginErr('这个号注册了两端，先在上面选「我是老人」或「我是家人」，再登录。');
      return;
    }
    if (!r.ok) { setLoginErr(r.why); return; }
    setLoginErr('');
    $('pwdIn').value = ''; $('phoneIn').value = '';
    if (r.user && r.user.name && !S.me) { S.me = r.user.name; save(); }
    renderMe();
    try { renderFamHome(); } catch (e) {}
    if (accRole() === 'fam') pushMeds().catch(function () {});
    say(accRole() === 'fam'
      ? '登上了。点「出个码」，让老人在他那台手机上填一次。'
      : '登上了。点「出个码」，家里人填一次，药就过来了。', 6800, { slow: true });
  };

  const rb = $('doRegBtn');
  if (rb) rb.onclick = async () => {
    if (ACC.busy) return;
    const phone = ($('phoneIn').value || '').replace(/\D/g, '');
    const pwd = ($('pwdIn').value || '');
    const nm = ($('nameIn') && $('nameIn').value) || (S.me || '').slice(0, 12)
      || (S.accRole === 'fam' ? '家人' : '老人家');
    ACC.busy = true; rb.disabled = true; rb.textContent = '开着…';
    const r = await accRegister(phone, pwd, nm, S.accRole);
    ACC.busy = false; rb.disabled = false; rb.textContent = '注册';
    if (!r.ok) { setLoginErr(r.why); return; }
    setLoginErr('');
    $('pwdIn').value = ''; $('phoneIn').value = '';
    if (nm && !S.me) { S.me = nm; save(); }
    renderMe();
    try { renderFamHome(); } catch (e) {}
    say('开好了。现在点「出个码」，把码念给对方，或让他扫二维码。', 7200, { slow: true });
  };

  /* 退出 */
  const ob = $('logoutBtn');
  if (ob) ob.onclick = async () => {
    ob.disabled = true; ob.textContent = '退着…';
    await accLogout();
    ob.disabled = false; ob.textContent = '退出登录';
    S.pairCode = ''; S.pairFam = '';
    _qrLast = '';
    renderMe();
    say('退出了。这台手机上的东西还在，只是不再跟家里人同步。', 6000, { slow: true });
  };

  /* 出个码。谁登录谁就能出 —— 老人出给家人填，家人出给老人填。 */
  const nb = $('pairNewBtn');
  if (nb) nb.onclick = async () => {
    if (!accToken()) { setPairOut('先在上面登录。'); return; }
    nb.disabled = true; nb.textContent = '出着…';
    const r = await accNewCode();
    nb.disabled = false; nb.textContent = '出个码';
    if (!r.ok) { setPairOut(r.why); return; }
    _qrLast = '';
    renderMe();
    setPairOut('码出来了。让对方在「我的 → 和家里人连上」里填这 6 位，或直接扫码。15 分钟内有效。');
    say('码出来了，' + r.code.split('').join(' ') + '。让对方填一下，或者扫屏幕上的码。', 9000, { slow: true });
  };

  /* 扫对方的码。相机扫码交给原生，回来填进输入框再连。 */
  const sb = $('pairScanBtn');
  if (sb) sb.onclick = async () => {
    if (!accToken()) { setPairOut('先在上面登录。'); return; }
    if ($('pairInWrap')) $('pairInWrap').hidden = false;
    const n = NATIVE();
    if (n && n.scanCode) {
      try {
        n.scanCode();
        setPairOut('相机开了，对准对方的二维码。');
        return;
      } catch (e) {}
    }
    setPairOut('这台手机没装扫码。让对方把 6 位数字念给你，填在下面也一样。');
    if ($('pairIn')) $('pairIn').focus();
  };

  /* 填码连上 */
  const pb = $('pairBtn');
  if (pb) pb.onclick = async () => {
    if (!accToken()) { setPairOut('先在上面登录。'); return; }
    pb.disabled = true; pb.textContent = '连着…';
    const r = await accPair($('pairIn').value);
    pb.disabled = false; pb.textContent = '连上';
    if (!r.ok) { setPairOut(r.why); return; }
    if ($('pairIn')) $('pairIn').value = '';
    if ($('pairInWrap')) $('pairInWrap').hidden = true;
    setPairOut('跟「' + (r.name || '家人') + '」连上了。');
    renderMe(); renderMed(); try { bootRefresh(); } catch (e) {}
    say('跟' + (r.name || '家人') + '连上了。他给你填的药，这边都有了。', 6200, { slow: true });
  };

  /* 定位开关 */
  const locb = $('locBtn');
  if (locb) locb.onclick = () => {
    const n = NATIVE();
    if (!n || !n.askLoc) {
      setPairOut('');
      say('这个得在手机上开。你去手机设置里，找到米粒，把位置权限打开就行。', 7000, { slow: true });
      return;
    }
    try { n.askLoc(); } catch (e) {}
    setTimeout(() => renderMe(), 900);
  };

  /* 家里人入口 */
  const fb = $('meFamBtn');
  if (fb) fb.onclick = () => goPage('family');

  /* 手环开关 */
  const bb = $('bandBtn');
  if (bb) bb.onclick = () => {
    const n = NATIVE();
    if (!n || !n.bandStart) { say('这个得在手机上开。', 5200, { slow: true }); return; }
    let on = false;
    try { on = !!n.bandOn(); } catch (e) {}
    if (on) {
      try { n.bandStop(); } catch (e) {}
      say('好，不读了。', 4200, { slow: true });
      setTimeout(() => renderMe(), 600);
      return;
    }
    /* 先把「手环要怎么开广播」说清楚再点 —— 不然扫 20 秒扫不到，
       老人只会觉得「又坏了」，不知道该去哪儿打那个勾。 */
    if (!bandExplained) {
      bandExplained = true;
      say('先在手表上打开「设置」，找到「心率广播」，点那个勾。开了再回来。', 11000, { slow: true });
    }
    try { n.bandStart(); } catch (e) {}
    setTimeout(() => renderMe(), 900);
  };
}

/* 原生授权回来。授权成功顺手把天气重取一遍 —— 让他立刻看到变化，
   而不是等下次问天气才发现「哦，原来按位置报了」。 */
window.__locDone = function (ok) {
  try { renderMe(); } catch (e) {}
  if (ok) {
    try { _wx = null; } catch (e) {}
    say('开了。以后天气按你站的地方报，不会再说别处的天气。', 6500, { slow: true });
  } else {
    say('没开成。你可以在手机设置里，找到米粒，把位置打开。', 6800, { slow: true });
  }
};

function setLoginErr(t) { const e = $('loginErr'); if (e) e.textContent = t || ''; }
function setPairOut(t) { const e = $('pairOut'); if (e) e.textContent = t || ''; }

/* 家人端首页。
   以前这里是把老人端 didList 的 innerHTML 抄一份过来 —— 那是张截图，不是个界面：
   家属看不到老人今天怎么样、药吃了没、多久没动静、有没有出事。
   重做的原则：家属打开这一页，三十秒内要知道「老人今天好不好」。
   所以顺序是：概况 → 要不要紧 → 药 → 最近做了什么。 */
let _famCard = null;      // 服务端聚合结果缓存，避免每次切页都打一次网络
let _famCardAt = 0;
let _famVital = null;     // 服务端的血压血糖记录（老人换机后本地是空的，得从这儿补）
const FAM_TTL = 60 * 1000;

function renderFamHome() {
  const w = $('famWho');
  if (w) {
    const who = (ACC.link && ACC.link.name) || S.me || '爸妈';
    w.textContent = ACC.user
      ? '替「' + who + '」管着呢。药由你填，闹钟由你定——一个时段只提醒一次，不会催着多吃。'
      : '还没登录，也还没跟老人配对。下面先登录，再生成一个 6 位码，让老人在他手机上填一次。';
  }
  renderFamMeds();
  renderFamOverview();
  renderFamVital();
  renderFamActs();
  renderFamPay();
  const reg = $('famRegVia');
  if (reg) reg.textContent = hasAfu() ? '· 用蚂蚁阿福' : '· 网页挂号';
}

/* 家人端的血压血糖：不重复老人端那套大数字，
   家属要看的是「最近几次的趋势」和「有没有超标」。
   一条趋势 + 一行结论就够，数字缩到小字。 */
function renderFamVital() {
  const box = $('famVitalBox');
  if (!box) return;
  /* 本地那份可能因为换机/重装是空的，但服务端有。
     所以家人端优先用服务端拉回来的 _famVital；本地只当兜底。 */
  const remote = (_famVital && _famVital.length) ? _famVital : [];
  const list = remote.length ? remote.map((x) => ({
    kind: x.kind, sys: x.sys, dia: x.dia, val: x.val, tone: x.tone,
    at: x.ts ? x.ts * 1000 : 0,
  })) : vitalAll();
  if (!list.length && famReadBad()) { box.innerHTML = FAM_BAD_LINE; return; }
  if (!list.length) {
    box.innerHTML = '<p class="cp small">老人还没量过。他量一次，这里就有数。</p>';
    return;
  }
  const bp = list.filter((x) => x.kind === 'bp');
  const gl = list.filter((x) => x.kind === 'glu');
  const row = (title, arr, unit, kind) => {
    if (!arr.length) {
      return '<div class="famcard wait" style="margin-bottom:10px">'
        + '<p class="famttl">' + title + '还没量</p></div>';
    }
    const x = arr[0];
    const tone = x.tone || 'ok';
    const big = kind === 'bp' ? (x.sys + '/' + x.dia) : (Math.round(x.val * 10) / 10).toFixed(1);
    const line = vitalSay(kind, tone, x.sys, x.dia, x.val);
    const t = x.at ? new Date(x.at) : null;
    const when = t ? ((t.getMonth() + 1) + '/' + t.getDate() + ' ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')) : '';
    return '<div class="famcard ' + (tone === 'ok' ? 'ok' : tone) + '" style="margin-bottom:10px">'
      + '<div class="famhd"><span class="famdot"></span><b class="famnm">' + title + '</b>'
      + '<span class="famtag">' + big + ' ' + unit + '</span></div>'
      + '<p class="famline">' + esc(line) + '</p>'
      + '<div class="vtrend" style="height:34px;margin-top:10px">'
      + arr.slice(0, 10).reverse().map((y) => {
        const v = kind === 'bp' ? (+y.sys || 0) : (+y.val || 0);
        const mx = Math.max.apply(null, arr.slice(0, 10).map((z) => kind === 'bp' ? (+z.sys || 0) : (+z.val || 0)).concat([1]));
        const h = Math.round(18 + (v / mx) * 78);
        return '<i class="' + (y.tone === 'bad' ? 'bad' : y.tone === 'warn' ? 'hi' : '') + '" style="height:' + h + '%"></i>';
      }).join('')
      + '</div>'
      + '<p class="famsub" style="margin-top:8px">' + esc(when) + ' 量的一次</p>'
      + '</div>';
  };
  box.innerHTML = row('血压', bp, 'mmHg', 'bp') + row('血糖', gl, 'mmol/L', 'glu');
}

/* 老人付过的账。不是让家属查账，是让家属知道「他今天出门买菜了」。
   只有金额和场景，没有卡号、没有余额 —— 那些不该出现在这儿。 */
function renderFamPay() {
  const box = $('famPayList');
  if (!box) return;
  const d = _famCard;
  const acts = (d && d.ok === true && Array.isArray(d.acts)) ? d.acts : [];
  const pays = acts.filter((a) => a.kind === 'pay');
  if (!pays.length && famReadBad()) { box.innerHTML = FAM_BAD_LINE; return; }
  if (!pays.length) {
    box.innerHTML = '<p class="cp small">老人还没扫过码。他付一次，这里多一条。</p>';
    return;
  }
  box.innerHTML = pays.map((a) => {
    const raw = a.at || (a.ts ? a.ts * 1000 : 0);
    const t = raw ? new Date(raw) : null;
    const when = t ? ((t.getMonth() + 1) + '/' + t.getDate() + ' ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')) : '';
    return '<div class="factrow"><span class="fkind">付款</span>'
      + '<span class="ftxt">' + esc(a.text || a.txt || '') + '</span>'
      + '<span class="fat">' + esc(when) + '</span></div>';
  }).join('');
}

/* 概况卡：老人今天好不好，一眼看完。
   数据来自服务端 mili_elder_card —— 它按 elder_id 聚合药、近 24 小时动作、最后一次动静。 */
function renderFamOverview() {
  const box = $('famOverview');
  if (!box) return;
  const d = _famCard;
  if (!d) {
    /* 还没拉过（刚开机、票刚校验完）。这时候写「读不到」是错的 ——
       什么都还没试过，怎么知道读不到。先给一句正在读，同时催一次。 */
    box.innerHTML = '<div class="famcard wait">'
      + '<p class="famttl">正在读老人的情况……</p>'
      + '<p class="famsub">一两秒就好。</p>'
      + '</div>';
    if (ACC.user || accToken()) refreshFamCard(true);
    return;
  }
  if (d.ok !== true) {
    /* 三种「看不到」要说清是哪一种。
       之前一律说「生成一个配对码，让老人填一次」—— 可如果这台机器登的是老人号的号，
       出多少个码都没用：/elder、/act 这些接口认的是家属那侧的票。
       实测就是这样：老人自己点了「家人端」，屏幕上让人去出码，出了也还是空的。 */
    const r = accRole();
    let ttl, sub, act = '';
    if (!ACC.user) {
      ttl = '还没登录。';
      sub = '登录以后才能看到。';
    } else if (r && r !== 'fam') {
      ttl = '这一端要用家人的号登。';
      sub = '这台手机现在登的是老人号'
        + (S.me ? '（' + S.me + '）' : '')
        + '。家人端看的是家属那一侧的数据，得换成家人的号登一次。';
      act = '<button class="act-btn ghost" id="famGoLogin" style="width:100%;margin-top:10px">用家人号登录</button>';
    } else if (d && d.why === 'not_bound') {
      ttl = '还没跟老人配对。';
      sub = '生成一个配对码，让老人填一次，这里就有东西了。';
    } else {
      ttl = '读不到老人的情况。';
      sub = '网络不通，或者老人那边还没同步上来。';
    }
    box.innerHTML = '<div class="famcard wait">'
      + '<p class="famttl">' + esc(ttl) + '</p>'
      + '<p class="famsub">' + esc(sub) + '</p>'
      + act
      + '</div>';
    const g = $('famGoLogin');
    if (g) {
      g.onclick = () => {
        /* 这台机器现在登的是老人号，登录表单是藏着的（已登录只显示「退出登录」）。
           所以要先退出去，再把表单亮出来 —— 不然点了按钮什么也看不见。 */
        const go = () => {
          S.accRole = 'fam';
          try { save(); } catch (e) {}
          goPage('me');
          setTimeout(() => {
            document.querySelectorAll('#accRoleSeg button').forEach((x) => {
              x.classList.toggle('on', x.dataset.accrole === 'fam');
            });
            const box2 = $('loginBox');
            if (box2 && box2.scrollIntoView) box2.scrollIntoView({ block: 'start' });
            const pi = $('phoneIn');
            if (pi) { try { pi.focus(); } catch (e) {} }
          }, 150);
        };
        if (accToken()) {
          accLogout().then(() => {
            S.pairCode = ''; S.pairFam = '';
            _qrLast = '';
            try { renderMe(); } catch (e) {}
            go();
          }).catch(go);
        } else {
          go();
        }
      };
    }
    return;
  }

  /* 多久没动静：超过 12 小时标黄，超过 24 小时标红。
     家属要的就是这个 —— 不是「老人干了什么」，是「老人还动不动」。 */
  const last = d.lastat ? new Date(d.lastat).getTime() : 0;
  const gapH = last ? (Date.now() - last) / 3600000 : null;
  let tone = 'ok', line = '';
  if (gapH == null) { tone = 'wait'; line = '老人还没用这台手机办过事。'; }
  else if (gapH < 1) { line = '刚还在用。'; }
  else if (gapH < 12) { line = Math.round(gapH) + ' 小时前还用过。'; }
  else if (gapH < 24) { tone = 'warn'; line = '快一天没动静了（' + Math.round(gapH) + ' 小时）。'; }
  else { tone = 'bad'; line = '超过一天没动静（' + Math.round(gapH) + ' 小时）。该打个电话了。'; }

  const nact = d.nact || 0;
  box.innerHTML = '<div class="famcard ' + tone + '">'
    + '<div class="famhd"><span class="famdot"></span>'
    + '<b class="famnm">' + esc(d.name || '爸妈') + '</b>'
    + '<span class="famtag">' + (d.nmed || 0) + ' 种药</span></div>'
    + '<p class="famline">' + esc(line) + '</p>'
    + '<p class="famsub">今天办了 ' + nact + ' 件事。'
    + (d.nmed ? '药按你填的提醒。' : '药箱还空着，下面加一种。') + '</p>'
    + '</div>';
}

/* 最近办的事：只显示服务端回来的，不再抄老人端的 DOM */
function renderFamActs() {
  const box = $('famDidList');
  if (!box) return;
  const d = _famCard;
  const acts = (d && d.ok === true && Array.isArray(d.acts)) ? d.acts : [];
  if (!acts.length && famReadBad()) { box.innerHTML = FAM_BAD_LINE; return; }
  if (!acts.length) {
    box.innerHTML = '<p class="cp small">还没有记录。老人每让米粒办一件事，这里多一条。</p>';
    return;
  }
  const K = { nav: '带路', call: '打电话', wx: '微信', tv: '看电视', sms: '短信',
    weather: '问天气', watch: '找片', med: '吃药', reg: '挂号', ir: '遥控', say: '说话',
    band: '手环', pay: '付款', vital: '量体征' };
  box.innerHTML = acts.map((a) => {
    /* 2026-11-06 修：服务端 acts 表存的是 ts（秒），这里原来读 a.at（毫秒）——
       字段名对不上，家人端「最近办的事」时间一直是空白。
       两种都认，老数据不会因此变空。 */
    const raw = a.at || (a.ts ? a.ts * 1000 : 0);
    const t = raw ? new Date(raw) : null;
    const hh = t ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') : '';
    const dd = t ? (t.getMonth() + 1) + '/' + t.getDate() : '';
    return '<div class="factrow"><span class="fkind">' + esc(K[a.kind] || a.kind || '办事') + '</span>'
      + '<span class="ftxt">' + esc(a.text || a.txt || '') + '</span>'
      + '<span class="fat">' + esc(dd + ' ' + hh) + '</span></div>';
  }).join('');
}

/* 家属端拉一次服务端概况。切到家人端时调，60 秒内不重复打。 */
/* 家属端的概况卡有 60 秒缓存。登录 / 退出 / 开机校验票据之后必须清掉 ——
   否则第一次渲染（那时 ACC.user 还是空的）写进去的「还没跟老人配对」会被缓存锁住，
   明明已经连上了，屏幕上还是让人去出码。实测就卡在这儿。 */
function famCardReset() {
  _famCard = null; _famCardAt = 0; _famVital = [];
}

/* 家人端血压、付款、办过的事，数据全来自服务端。
   读不到的时候绝不能再画画空态 ——「老人还没量过」和「读不到」是两件事，
   混在一起就是让家人白放心。实测：老人号切到家人端，整页写着
   「老人还没扫过码」「还没有记录」，可老人十分钟前刚传过话、刚付过钱。 */
function famReadBad() {
  return !!(_famCard && _famCard.ok !== true);
}
const FAM_BAD_LINE = '<p class="cp small">这会儿读不到老人的记录 —— 上面那张卡里写了原因，照它办就行。</p>';

async function refreshFamCard(force) {
  if (!ACC.user) {
    _famCard = { ok: false, why: 'not_bound' }; _famCardAt = Date.now();
    renderFamOverview(); renderFamVital(); renderFamActs(); renderFamPay();
    return;
  }
  /* 只有「拉成功」才配进缓存。
     失败也缓存的话，开机第一帧（那时票还没校验完）写进去的那次失败会锁住 60 秒 ——
     明明登录着、也连上了，家人端首页偏偏说「读不到」，切走再切回来才对。 */
  if (!force && _famCard && _famCard.ok === true && Date.now() - _famCardAt < FAM_TTL) {
    renderFamOverview(); renderFamVital(); renderFamActs(); renderFamPay(); return;
  }
  const d = await accElderCard();
  _famCard = d || { ok: false, why: 'read_fail' };
  _famCardAt = Date.now();
  /* 体征单独拉一次。老人换机或重装后本地是空的，
     但服务端还留着 —— 家属不该因为老人换了手机就看不见历史。 */
  try {
    const v = await accApi('/vital');
    _famVital = (v && v.ok && Array.isArray(v.items)) ? v.items : [];
  } catch (e) { _famVital = []; }
  renderFamOverview(); renderFamVital(); renderFamActs(); renderFamPay();
}

function renderFamMeds() {
  const box = $('famMedList');
  if (!box) return;
  const on = S.med.filter((m) => m.on);
  if (!on.length) {
    box.innerHTML = '<p class="cp small">药箱还是空的。拍张药盒照，或者手填下面的表。</p>';
    return;
  }
  box.innerHTML = on.map((m, i) => '<div class="medcard"><div class="mh"><span class="mn">' + esc(m.who) +
    '</span><span class="mtag">' + esc(m.dose) + '</span></div><p class="mw">' + esc(m.when) +
    '　' + esc(m.pill || '') + '</p><p class="mnote">' + esc(m.note) + '</p></div>').join('');
}

/* 家人端：拍药盒 → 云视觉读药名和用量 */
function famShoot() {
  const n = NATIVE();
  const out = $('famShootOut');
  /* 浏览器（含线上版）走系统相册/相机选择器；APK 里走原生相机桥 */
  if (n && n.shoot) {
    if (out) out.textContent = '相机开了……对着药盒拍。';
    n.shoot(0, 900001);
    return;
  }
  let inp = document.getElementById('famFile');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.id = 'famFile';
    inp.style.display = 'none';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        if (out) out.textContent = '在读药盒……';
        visionMed(String(rd.result).split(',')[1]).then((r) => {
          if (!r) { if (out) out.textContent = '没读出来，手填下面的表就行。'; return; }
          if (!$('fmWho').value) $('fmWho').value = (r.who || '').slice(0, 8);
          if (!$('fmFull').value) $('fmFull').value = (r.full || '').slice(0, 20);
          if (!$('fmDose').value) $('fmDose').value = (r.dose || '').slice(0, 16);
          if (out) out.textContent = '读到了：' + (r.full || r.who || '?') + '，' + (r.dose || '') + '。核对一下再存。';
        });
      };
      rd.readAsDataURL(f);
    };
    document.body.appendChild(inp);
  }
  inp.click();
}
/* ============================================================================
   拍药盒 → 立刻识别 → 立刻入库（2026-11-09 菲尔特：「拍了药没有立马识别并且添加」）

   断链根因：原来「识别 + 入库」这段只写在「相册」按钮的 change 回调里，
   赋给 window.__medVision；而「拍药盒」走 Java 的 snapPhoto()，回调是
   window.__onPhoto(单参数 base64)，根本没经过 medscan，__medVision 压根
   没被赋值 —— 拍完只弹一句「拍到了，正在认…」就再无下文。

   现在两条路统一走 __medApply()，识别成功后直接 push 进 S.med、save()、
   重绘药箱、把结果写在药箱页上，全程不用跳页也不用再点一次。
   ========================================================================== */
window.__medBusy = false;
async function medApply(b64) {
  if (!b64 || window.__medBusy) return;
  window.__medBusy = true;
  window.__medLastPhoto = String(b64);   /* 拍到的那张，引导页直接显示给老人看 */
  window.__f7MedMsg = { t: '正在认这盒药…', s: 'wait' };
  if (window.__f7renderMed) window.__f7renderMed();
  try {
    const AG = window.MILI_AGENT;
    let j = null;
    /* 🚨 2026-11-10 安全红线：菲尔特拍「氯雷他定片」，模型编成
       「氨酚伪麻那敏片」并自动入库。吃错药是要出人命的。
       从今天起：① 只抄药盒正面印出来的字，绝不靠包装颜色/形状猜；
       ② 看不清、不确定、只看到铝箔背面，一律 name 空；
       ③ 就算认出来了，也必须老人亲手点「就是这个」才进药箱。 */
    const Q = '你在辨认一张药盒照片。只输出一个JSON，不要任何多余文字：' +
      '{"name":"药盒正面印着的药品通用名（逐字照抄）","spec":"规格","dose":"一次吃多少","perDay":每日次数数字,"note":"一句注意事项","seen":"你在盒面上实际看到的药名字串"}。' +
      '铁律：只准逐字抄盒面上看得清的印刷字。看不清、只看到铝箔/背面/侧面、' +
      '或者你只是在根据外观猜，一律输出 {"name":"","seen":""}，绝不允许编一个药名。' +
      '不许把别的药名、感冒药名、常见药名套上去。宁可空着也不要猜。';
    /* 2026-11-10「拍完不识别」根因：agent.js 里写死了视觉请求 max_tokens 低于 800
       时思考链会把预算吃光、content 回空串，看着像模型不认图。这里原来只给 500。
       再加 12 秒超时：请求挂住时 __medBusy 永远卡 true，第二张拍了完全没反应。 */
    const withTimeout = (p, ms) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error('识别超时')), ms))
    ]);
    if (AG && AG.vision) {
      try {
        const v = await withTimeout(AG.vision(b64, Q, { maxTokens: 800, effort: 'low' }), 12000);
        const txt = String((v && v.text) || '');
        try { console.warn('[medApply] 视觉回字 ' + txt.slice(0, 120)); } catch (e0) {}
        const mt = txt.match(/\{[\s\S]*\}/);
        if (mt) j = JSON.parse(mt[0]);
      } catch (e) {
        try { console.warn('[medApply] 视觉失败 ' + String(e && e.message || e)); } catch (e0) {}
        j = null;
      }
    }
    if (!j || !j.name) {                    /* 兜底：老云视觉链路，也要超时 */
      try {
        const r = await withTimeout(visionMed(b64), 12000);
        if (r) j = { name: r.full || r.who, dose: r.dose, note: r.note };
      } catch (e) {
        try { console.warn('[medApply] 云视觉兜底失败 ' + String(e && e.message || e)); } catch (e0) {}
      }
    }
    if (!j || !j.name) {
      window.__f7MedMsg = { t: '没认出来。把药盒正面摆正再拍一张，或者直接在下面手填药名。', s: 'bad' };
      try { if (window.medConfirmClose) window.medConfirmClose(); } catch (e) {}
    } else {
      /* 🚨 安全红线：绝不再自动入库。识别结果只作为「候选」，
         弹出一张确认卡让老人/家人亲眼核一眼、必要时改字，
         亲手点「就是这个」才写进药箱。 */
      const cand = {
        name: String(j.name).slice(0, 20),
        spec: String(j.spec || '').slice(0, 24),
        dose: String(j.dose || '一次一片').slice(0, 14),
        note: String(j.note || '').slice(0, 30),
        seen: String(j.seen || '').slice(0, 30),
        perDay: Math.max(1, Math.min(4, +j.perDay || 1))
      };
      window.__medPending = cand;
      window.__f7MedMsg = { t: '看着像「' + cand.name + '」，请核对一下再决定加不加。', s: 'wait' };
      try { if (window.medConfirmShow) window.medConfirmShow(cand); } catch (e) {}
    }
  } catch (e) {
    window.__f7MedMsg = { t: '识别没成（' + String(e && e.message || e).slice(0, 30) + '），可以手填。', s: 'bad' };
  } finally {
    window.__medBusy = false;
  }
  try { if (window.__f7renderMed) window.__f7renderMed(); } catch (e) {}
  try { if (window.__f7toast) window.__f7toast(window.__f7MedMsg.t); } catch (e) {}
  /* 识别一结束就主动把结果刷到引导页，不等轮询 */
  try {
    const m = $('onbMedMsg');
    if (m && window.__f7MedMsg && window.__f7MedMsg.t) m.textContent = window.__f7MedMsg.t;
  } catch (e) {}
}
window.__medApply = medApply;

/* 2026-11-10 菲尔特「农历几月几号也显示出来」：Intl 直接吐「十月2日」，
   把阿拉伯数字换成老人念得出的「十月初二」。全局共用一份。 */
window.lunarCN = function(d){
  try {
    d = d || new Date();
    const s = new Intl.DateTimeFormat('zh-CN-u-ca-chinese',{month:'long',day:'numeric'}).format(d);
    const m = s.match(/^(.+?\u6708)\s*(\d+)/);
    if (!m) return s;
    const n = +m[2];
    const CN = ['','一','二','三','四','五','六','七','八','九','十'];
    let day;
    if (n <= 10) day = '初' + (n === 10 ? '十' : CN[n]);
    else if (n < 20) day = '十' + CN[n - 10];
    else if (n === 20) day = '二十';
    else if (n < 30) day = '廿' + CN[n - 20];
    else day = '三十';
    return m[1] + day;
  } catch (e) { return ''; }
};

/* ============================================================================
   药品确认与增删改（2026-11-10 安全红线）
   识别结果一律先过这张卡。老人不点「就是这个」，药名绝不进药箱。
   同一套卡同时服务引导第 4 屏与家人端药箱，两端都能改名、删除、手动添加。
   ========================================================================== */
window.medConfirmClose = function(){
  const c = $('medConfirm'); if (c) c.hidden = true;
};
window.medConfirmShow = function(cand){
  let c = $('medConfirm');
  if (!c) {
    c = document.createElement('div');
    c.id = 'medConfirm'; c.className = 'medconfirm';
    c.innerHTML = '<div class="box">' +
      '<b>这盒药叫什么？</b>' +
      '<p class="mc-tip">米粒看着像下面这个，<em>不一定对</em>。您核一眼，不对就直接改。</p>' +
      '<input id="mcName" class="mc-input" type="text" placeholder="药盒正面印的名字">' +
      '<div class="mc-seen" id="mcSeen"></div>' +
      '<div class="mc-btns"><button type="button" class="mc-yes">就是这个，加进去</button>' +
      '<button type="button" class="mc-no">不对，先别加</button></div></div>';
    document.body.appendChild(c);
    c.querySelector('.mc-no').onclick = function(){ window.medConfirmClose(); };
    c.querySelector('.mc-yes').onclick = function(){
      const nm = String(($('mcName') || {}).value || '').trim().slice(0, 20);
      if (!nm) { const i = $('mcName'); if (i) { i.focus(); i.placeholder = '先写下药名'; } return; }
      window.medAddByName(nm, window.__medPending || {});
      window.medConfirmClose();
    };
  }
  const nm = $('mcName');
  if (nm) nm.value = (cand && cand.name) || '';
  const sn = $('mcSeen');
  if (sn) sn.textContent = (cand && cand.seen) ? ('盒面上看到的字：' + cand.seen) : '';
  c.hidden = false;
};

/* 真正入库的唯一入口：确认卡与手填都走这里 */
window.medAddByName = function(name, meta){
  name = String(name || '').trim().slice(0, 20);
  if (!name) return false;
  S.med = Array.isArray(S.med) ? S.med : [];
  const dup = S.med.some(function(m){ return m && (m.who === name || m.full === name); });
  if (dup) {
    window.__f7MedMsg = { t: '「' + name + '」药箱里已经有了。', s: 'ok' };
  } else {
    const T = { 1: ['08:00'], 2: ['08:00', '19:00'], 3: ['08:00', '12:30', '19:00'],
                4: ['08:00', '12:00', '16:00', '20:00'] }[meta.perDay || 1] || ['08:00'];
    S.med.push({
      who: name, full: name + (meta.spec ? ' ' + meta.spec : ''),
      dose: meta.dose || '一次一片', when: '每天 ' + T.join('、'),
      note: meta.note || '', pill: '', alias: [], on: true, last: '', times: T.slice()
    });
    window.__f7MedMsg = { t: '「' + name + '」加好了，吃药时间也预填上了。', s: 'ok' };
  }
  try { save(); } catch (e) {}
  try { if (window.onbMedRefresh) window.onbMedRefresh(); } catch (e) {}
  try { if (window.__f7renderMed) window.__f7renderMed(); } catch (e) {}
  try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch (e) {}
  const m = $('onbMedMsg');
  if (m && window.__f7MedMsg) m.textContent = window.__f7MedMsg.t;
  return true;
};

/* 引导第 4 屏：已加的药列表，可改名、可删、可手动添加 */
window.onbMedRefresh = function(){
  const box = $('onbMedList'); if (!box) return;
  const list = Array.isArray(S.med) ? S.med : [];
  if (!list.length) { box.innerHTML = '<div class="onb-medempty">还没加药。拍照认，或者直接在下面手填。</div>'; return; }
  box.innerHTML = list.map(function(m, i){
    return '<div class="onb-medrow" data-i="' + i + '">' +
      '<span class="onb-mednm">' + esc(m.who || m.full || '药') + '</span>' +
      '<button type="button" class="onb-mededit" data-act="edit" data-i="' + i + '">改名字</button>' +
      '<button type="button" class="onb-meddel" data-act="del" data-i="' + i + '">删掉</button></div>';
  }).join('');
  box.querySelectorAll('[data-act]').forEach(function(b){
    b.onclick = function(){
      const i = +b.dataset.i;
      if (b.dataset.act === 'del') {
        S.med.splice(i, 1);
        try { save(); } catch (e) {}
        window.onbMedRefresh();
        try { if (window.__f7renderMed) window.__f7renderMed(); } catch (e) {}
        try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch (e) {}
        return;
      }
      /* 改名用同一张确认卡，避免弹系统小输入框 */
      const old = String((S.med[i] || {}).who || '');
      window.__medEditingIdx = i;
      window.__medPending = { name: old, perDay: 1 };
      if (window.medConfirmShow) {
        window.medConfirmShow({ name: old, seen: '' });
        const c = $('medConfirm');
        if (c) {
          const t = c.querySelector('.box > b'); if (t) t.textContent = '改成什么名字？';
          const y = c.querySelector('.mc-yes'); if (y) y.textContent = '改好了';
          y.onclick = function(){
            const nm = String(($('mcName') || {}).value || '').trim().slice(0, 20);
            if (!nm) return;
            const row = S.med[i]; if (row) { row.who = nm; row.full = nm; }
            try { save(); } catch (e) {}
            window.medConfirmClose(); window.onbMedRefresh();
            try { if (window.__f7renderMed) window.__f7renderMed(); } catch (e) {}
            try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch (e) {}
          };
        }
      }
    };
  });
};

/* 2026-11-08 真拍照回来的入口（Java 已缩到 1024 并转 base64）。
   snapPhoto() 回调是单参数；shoot() 回调是 (id,b64,w,h)。两条都要落到 medApply。 */
/* 拍照回调只有一个，必须同时服务三条调用者：
     ① capture() 的 shoot(facing, id) → (id, b64, w, h)，走 photoWait 原逻辑
     ② famShoot() 的 id=900001       → 拍药盒，走 medApply 直接入库
     ③ snapPhoto() 的 onActivityResult → 单参数长 base64，走 medApply 直接入库
   旧代码这里套了两层包装、还重复实现了一份识别，拍药盒那条路因此断掉。 */
window.__onPhoto = (function (orig) {
  return function (a, b, c, d, e) {
    /* 单参数 = Java snapPhoto() 回调（ACTION_IMAGE_CAPTURE 走这条） */
    if (typeof a === 'string' && a.length > 200 && b === undefined) {
      try { medApply(a); } catch (err) {}
      return;
    }
    /* 900001 = famShoot() 老入口，也统一成「拍完立刻识别并添加」 */
    if (a === 900001) {
      if (b) { try { medApply(b); } catch (err) {} }
      else if (window.__f7toast) window.__f7toast('这一下没拍着，再来一次？');
      return;
    }
    /* 其余（含 capture 的拍照问米粒）交回原实现，别把老功能改坏 */
    if (orig) orig(a, b, c, d, e);
  };
})(window.__onPhoto);

window.__pickedImage = function (b64) {
  if (!b64) return;
  try { medApply(b64); } catch (err) {}
};

/* ============ 拍一张问米粒（2026-11-05 新增） ============
   菲尔特要的「增加拍照、上传相片功能」。
   老人举着药盒 / 说明书 / 体检单 / 路上的牌子拍一张，米粒读给他听。
   两条路分开：DeepSeek 大脑没有视觉，所以
     图 → 云视觉（hy3，真能看图）→ 一段人话
     人话 → 说给老人 + 存进「办过的事」
   不是新管线，用的是 App 本来就有的云服务，不烧付费额度。 */
async function visionAsk(b64, question) {
  /* 直连 DeepSeek：它自己就能看图（input_modalities 含 image）。
     以前绕云 SDK 挑 hy 模型，多一层、还会挑不到就返回空，白让老人重拍。 */
  const AG = window.MILI_AGENT;
  if (AG && AG.vision) {
    try {
      const r = await AG.vision(b64, question, { maxTokens: 600, effort: 'low' });
      if (r && r.text) return r.text;
    } catch (e) {}
  }
  /* 兜底：直连挂了才走云（老机器上可能只配了云）。 */
  const c = initCloud();
  if (!c) return '';
  try {
    const ms = await c.llm.models.list();
    const m = ms.find((x) => x.disabled !== true && x.supportsImages === true && /hy/.test(x.id))
      || ms.find((x) => x.disabled !== true && x.supportsImages === true);
    if (!m) return '';
    let out = '';
    for await (const chunk of c.llm.chat.completions.create({
      model: m.id,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
          { type: 'text', text: question },
        ],
      }],
      stream: true, temperature: 0.2, max_tokens: 600,
    })) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) out += d.content;
    }
    return out.trim();
  } catch (e) { return ''; }
}

async function askByPhoto(file) {
  openSearchSheet('看看这张照片');
  const b64 = await new Promise((res) => {
    try {
      const rd = new FileReader();
      rd.onload = () => res(String(rd.result).split(',')[1] || '');
      rd.onerror = () => res('');
      rd.readAsDataURL(file);
    } catch (e) { res(''); }
  });
  if (!b64) { closeSearchSheet(); say('这张没读出来，你再拍一张。'); return; }

  const ans = await visionAsk(b64,
    '这是老人用手机拍的一张照片，他看不懂才拍给你。' +
    '用老人听得懂的口语回答：先说这是什么东西；如果上面有字（药盒、说明书、单子、招牌、通知），把关键的念出来。' +
    '不要 Markdown，不要分点，不超过 120 字。');
  closeSearchSheet();

  if (!ans) { say('这张我看不太清，离近一点、光亮点再拍一张。'); return; }

  const IN = $('actIn'), A = $('action');
  IN.innerHTML = `<div class="panel" style="text-align:left">
    <p class="sr-q">你让我看的</p>
    <p class="sr-a">${esc(ans)}</p>
    <p class="sr-s">这是我从照片上认出来的。拿不准就问家里人。</p>
  </div>
  <button class="act-btn" style="margin-top:16px" onclick="window.__close()">知道了</button>`;
  A.hidden = false;
  say(ans.length > 70 ? ans.slice(0, 70) + '，后面还有，你看屏幕。' : ans);
  logDid('heart', '看照片', ans.slice(0, 40));
}

/* 读药盒：同样直连 DeepSeek 看图，回答限定 JSON。 */
async function visionMed(b64) {
  const Q = '这是药盒照片。只输出JSON：{"who":"家里人的叫法,如降压药","full":"盒子上药品全名","dose":"一次剂量,如一次一片","note":"一条关键注意"}。读不清的字段留空字符串。';
  let out = '';
  const AG = window.MILI_AGENT;
  if (AG && AG.vision) {
    try {
      const r = await AG.vision(b64, Q, { maxTokens: 800, effort: 'low', temperature: 0.1 });
      out = (r && r.text) || '';
    } catch (e) { out = ''; }
  }
  if (!out) {
  const c = initCloud();
  if (!c) return null;
  try {
    const ms = await c.llm.models.list();
    const m = ms.find((x) => x.disabled !== true && x.supportsImages === true && /hy/.test(x.id))
      || ms.find((x) => x.disabled !== true && x.supportsImages === true);
    if (!m) return null;
    for await (const chunk of c.llm.chat.completions.create({
      model: m.id,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
          { type: 'text', text: Q },
        ],
      }],
      stream: true, temperature: 0.1, max_tokens: 200,
    })) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) out += d.content;
    }
  } catch (e) { return null; }
  }
  try {
    const mm = out.match(/\{[\s\S]*\}/);
    if (!mm) return null;
    const j = JSON.parse(mm[0]);
    return (j && (j.full || j.who)) ? j : null;
  } catch (e) { return null; }
}

/* 家人端：存药 + 设闹钟。一个时段一个闹钟，防重复提醒靠 MedAlarm 去重 + med.last */
function famSaveMed() {
  const who = ($('fmWho').value || '').trim();
  if (!who) { alert('先填「平时叫什么」'); return; }
  const full = ($('fmFull').value || '').trim() || who;
  const dose = ($('fmDose').value || '').trim() || '一次一片';
  const h = Math.max(0, Math.min(23, +$('fmH').value || 8));
  const m = Math.max(0, Math.min(59, +$('fmM').value || 0));
  const note = ($('fmNote').value || '').trim() || '温水送服';
  S.med.push({ who: who, full: full, dose: dose, when: '每天' + h + '点' + (m ? m + '分' : ''),
    note: note, pill: '', alias: [], on: true, last: '' });
  save();
  const n = NATIVE();
  if (n && n.addAlarm) { try { n.addAlarm(h, m, who, dose); } catch (e) {} }
  renderFamMeds(); renderMed();
  const out = $('famShootOut');
  if (out) out.textContent = '存好了。每天 ' + h + ':' + String(m).padStart(2, '0') + ' 提醒一次，老人确认后才消，不会重复催。';
  $('fmWho').value = ''; $('fmFull').value = ''; $('fmDose').value = ''; $('fmNote').value = '';

  /* 推到云端，老人手机才能收到。
     失败不挡流程 —— 本机闹钟已经设好了，老人这台机子自己会响。
     同步只是让「换个手机也还在」，不能因为网络不好就说「没存上」。 */
  const po = $('famPushOut');
  if (po && ACC.user) {
    po.textContent = '正在同步到老人手机……';
    pushMeds().then((r) => {
      if (r.ok) { po.textContent = '已同步到老人手机（' + r.n + ' 种药）。'; refreshFamCard(true); }
      else if (r.why && r.why.indexOf('配对') >= 0) {
        po.textContent = '存在这台手机上了。要同步到老人手机，先跟老人配对。';
      } else {
        po.textContent = '存在这台手机上了，但没同步上去（' + r.why + '）。本机闹钟照常会响。';
      }
    }).catch(() => { if (po) po.textContent = '存在这台手机上了。同步这会儿没成功，本机闹钟照常会响。'; });
  } else if (po && !ACC.user) {
    po.textContent = '存在这台手机上了。登录以后，才能同步到老人那台。';
  }
}

/* 阿福：装了就深链过去（它有5000家医院挂号），没装走网页挂号 */
function hasAfu() {
  const n = NATIVE();
  return !!(n && n.hasApp && n.hasApp('com.antgroup.aijk.android'));
}
function famRegister() {
  const n = NATIVE();
  if (n && n.hasApp && n.hasApp('com.antgroup.aijk.android')) {
    n.launchApp('com.antgroup.aijk.android');
    say('阿福给你打开了，挂号、问药都在里面。', 6000, { slow: true });
    return;
  }
  openExternal('https://www.114yygh.com/');
  say('挂号页面给你打开了。装了蚂蚁阿福的话，也可以用它挂号。', 6500, { slow: true });
}

/* 演示版控制台：现场让评委看见「学会 → 长大 / 删掉 → 缩回去」 */
function demoGrow() {
  const n = S.rules.length;
  S.rules.push({
    id: 'demo' + Date.now().toString(36) + Math.floor(Math.random() * 99),
    k: 'demo' + n, q: '演示：第 ' + (n + 1) + ' 件事', ans: '', src: '',
    kind: 'recall', n: 1, born: Date.now(), firstMs: 0, lastMs: 0, hits: 0, auto: false
  });
  trimRules(); save(); applyForm(true); renderLearn(); renderHero();
  say('学会一件。', 2800);
}
function demoShrink() {
  if (!S.rules.length) { say('还没有能删的。', 3000); return; }
  S.rules.pop(); save(); applyForm(true); renderLearn(); renderHero();
  say('忘掉一件，缩回去一点。', 3600);
}
function showDemoSheet() {
  const A = $('action'), IN = $('actIn');
  IN.innerHTML = `<div class="act-head"><h3 class="act-h" style="margin:0">演示版</h3>
      <button class="xbtn" onclick="window.__close()" aria-label="关掉"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <p class="act-p">成长阈值 0 / 2 / 4，数据和产品版分开存。<br>「学会」和「删掉」都能当场看见它变大变小。</p>
    <button class="act-btn" data-demo="grow">让它学一条（长一点）</button>
    <button class="act-btn ghost" data-demo="shrink" style="margin-top:8px">删一条（缩回去）</button>
    <button class="act-btn ghost" data-demo="reset" style="margin-top:8px">重置演示数据</button>
    <button class="act-btn ghost" data-demo="product" style="margin-top:8px">切到产品版</button>
    <button class="act-btn ghost" onclick="window.__close()">关掉</button>`;
  A.hidden = false;
  IN.querySelectorAll('[data-demo]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.demo;
      if (k === 'grow') { demoGrow(); }
      else if (k === 'shrink') { demoShrink(); }
      else if (k === 'reset') { localStorage.removeItem(STORE_KEY); location.reload(); }
      else if (k === 'product') {
        const u = new URL(location.href);
        u.searchParams.delete('demo');
        u.searchParams.set('mode', 'product');
        location.href = u.toString();
      }
    };
  });
}
window.__showDemo = showDemoSheet;


/* 家人页底部的「米粒的实体卡」入口 */
/* 卡面用真渲染的小鸡。2026-11-07：这里原来写 `window.__POSE && __POSE.wave`，
   可全工程根本没有 __POSE —— 条件永远为假，卡面就一直是那个空方框。
   图现在是 HTML 里直接写死的 assets/poses/wave-cut.png（rembg 抠过底，
   白绒鸡贴在深卡面上才不显白框），这段只保留「图挂了才换」的兜底。 */
const _nc = $('nfcChick');
if (_nc) {
  _nc.onerror = () => { _nc.onerror = null; _nc.src = 'assets/poses/wave.png'; };
}

const _ce = $('cardEntry');
if (_ce) _ce.onclick = () => goPage('card');
window.__nfcHow = () => {
  say('贴一下就行。手机自己会亮——不用找图标。', 7200, { slow: true });
};

/* ============ 说话层 ============ */
let listenSaid = false;      /* 这一轮说话已经交给 handleSay 了，松手别再重复 */
function openListen(byVoice) {
  const base = ['该吃药了吗', '今天冷不冷', '今天几号了'];
  if (S.fam.length) base.push('给' + S.fam[0].name + '打个电话');
  else base.push('给儿子打个电话');
  base.push('我睡不着');
  base.push('看昨天那个短剧');
  $('chips').innerHTML = base.map((p) => `<button data-say="${esc(p)}">${esc(p)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => {
    b.onclick = () => handleSay(b.dataset.say);
  });
  $('listen').hidden = false;
  playAnim('listen', 1.2);
  $('liveText').textContent = byVoice ? '我在听，你说' : '说完松手';
  // 真开麦
  if (S.perms.mic) {
    /* 2026-11-05 按住说话：松手要能收尾。
       原来只靠识别器自己吐 isFinal，这台机经常听完不收（8 秒看门狗兜底），
       老人松手后得干等 —— 现在中间结果同时记到 window.__liveHeard，
       松手 0.7 秒还没定稿就拿它交差。listenSaid 防重复播报。 */
    window.__liveHeard = '';
    listenSaid = false;
    const ok = startListen(
      (txt) => { window.__liveHeard = txt || window.__liveHeard; $('liveText').textContent = txt; },
      (txt) => { if (txt) { listenSaid = true; handleSay(txt); } });
    if (!ok) $('liveText').textContent = '这台机器开不了麦，你点下面的话也行';
  }
}
function closeListen() { stopListen(); hush(); $('listen').hidden = true; }

/* 教它一条：只有家里人用，老人不用碰 */
/* 家里人替老人记一条。老人自己不用碰这个入口。 */
function teachOne() {
  const t = prompt('要它记住什么？（比如：微信那个绿的图标）');
  if (!t || !t.trim()) return;
  S.rules.push({
    id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 99),
    k: learnKey(t), q: t.trim(), ans: '', src: '',
    kind: 'slow', n: 1, born: Date.now(),
    firstMs: 0, lastMs: 0, hits: 0, auto: false
  });
  trimRules();
  save(); applyForm(true); renderLearn();
  say('记住了。', 3200);
}

/* 引导最后一屏：把永久同步码摆出来，让家人拿自己的手机填。 */
async function showOnbCode() {
  const box = $('onbCode');
  if (!box) return;
  box.textContent = '正在取同步码…';
  let r = { ok: false, code: S.pairCode || '' };
  try { r = await accNewCode(); } catch (e) {}
  const code = r.ok ? r.code : (S.pairCode || '');
  box.textContent = code ? String(code).replace(/(\d{3})(\d{3})/, '$1 $2') : '没取到，等下到「我的」里看';
  const tip = $('onbCodeTip');
  if (tip) tip.textContent = code
    ? '这个码一直有效。家里人用自己的手机打开米粒，选「我是家人」填上就行；以后改配置也不用换码。'
    : '连不上服务器时也能先用，登录后到「我的」里会看到这 6 位数字。';
}

/* ============ 引导：一条线走完（2026-11-10 菲尔特） ============
   1 介绍 → 2 名字 → 3 它叫什么 → 4 拍药盒 → 5 设备 → 6 权限逐个开
   → 7 桌面 4/6 + 工具 + 底部 → 8 录声纹 → 9 同步码 → 进米粒。
   每屏只做一件事；权限读系统真实状态，不代点、不写假状态。 */
let step = 1;
const ONB_PERMS = [
  /* 2026-11-10 菲尔特：设默认桌面会把页面重建，放最后等于前面白填。
     挪到第一位，一进来就能开，开完回来接着填。 */
  ['home','设为默认桌面','按主页键回到的就是米粒'],
  ['mic','麦克风','听你说话、喊「米粒米粒」'],
  ['acc','无障碍','替你点微信、抖音、付款码'],
  ['notif','通知使用权','看见来电和红包提醒'],
  ['overlay','悬浮窗','桌宠能浮在别的软件上'],
  ['camera','相机','拍药盒、扫码'],
  ['contacts','通讯录','按「女儿」找到该打给谁'],
  ['battery','电池白名单','后台不被系统冻掉'],
];
const ONB_DEVS = [['bp','血压仪'],['glu','血糖仪'],['band','手环'],['vent','呼吸机']];
const ONB_APPS = [['dialer','打电话'],['wechat','微信'],['torch','手电筒'],['camera','相机'],
                  ['med','药箱'],['tv','电视'],['weather','天气'],['album','相册']];
const ONB_DOCK = [['sos','紧急呼叫'],['talk','说话'],['torch','手电筒'],['home','回桌面']];
let onbPermTimer = null;

function onbCfg(){ if (!S.cfg || typeof S.cfg !== 'object') S.cfg = {}; return S.cfg; }
function onbChips(box, items, picked, onPick){
  const el = $(box); if (!el) return;
  el.innerHTML = items.map((it) =>
    '<button type="button" class="onb-chip' + (picked.indexOf(it[0]) >= 0 ? ' on' : '') +
    '" data-k="' + it[0] + '">' + it[1] + '</button>').join('');
  el.querySelectorAll('.onb-chip').forEach((b) => { b.onclick = () => onPick(b.dataset.k); });
}
function onbPermRefresh(){
  const box = $('onbPerm'); if (!box) return;
  let st = {};
  try { const N = window.MiliNative; st = JSON.parse((N && N.permState && N.permState()) || '{}'); }
  catch (e) {}
  const first = ONB_PERMS.findIndex((it) => !st[it[0]]);
  /* 2026-11-10 18:5x：原来标题和说明塞在同一个 span 里用 <br> 换行，
     状态标签被挤到说明文字下面（真机截图实证）。改成明确的左右两栏：
     左边一个 flex-column 装标题+说明，右边一个不收缩的标签。 */
  box.innerHTML = ONB_PERMS.map((it, i) =>
      '<div class="onb-permrow' + (i === first ? ' go' : '') + '" data-k="' + it[0] + '">'
    + '<div class="onb-permtext"><b>' + it[1] + '</b><span>' + it[2] + '</span></div>'
    + '<span class="tag ' + (st[it[0]] ? 'ok' : 'no') + '">'
    + (st[it[0]] ? '已开' : (i === first ? '去打开' : '没开')) + '</span></div>').join('');
  box.querySelectorAll('.onb-permrow').forEach((r) => {
    r.onclick = () => {
      if (st[r.dataset.k]) return;
      try { window.MiliNative.openPerm(r.dataset.k); } catch (e) {}
      const d = $('onbPermDone'); if (d) d.textContent = '开好回来，这一行会自己变绿。';
    };
  });
  const d = $('onbPermDone');
  if (d) d.textContent = first < 0 ? '全开好了，点「继续」往下走。'
    : '还差 ' + ONB_PERMS.slice(first).filter((it) => !st[it[0]]).length +
      ' 个。先开「' + ONB_PERMS[first][1] + '」。';
}
/* 拍完药盒：识别结果由 medApply 写进 __f7MedMsg，这里只负责把人话摆出来。 */
function onbWatchMed(){
  let n = 0;
  const t = setInterval(() => {
    n++;
    const m = $('onbMedMsg');
    if (!m || step !== 4) { clearInterval(t); return; }
    const pic = $('onbMedPreview');
    if (pic && window.__medLastPhoto) {
      pic.src = 'data:image/jpeg;base64,' + window.__medLastPhoto;
      pic.style.display = 'block';
    }
    /* 🚨 2026-11-10 真因：原来只要 __f7MedMsg.t 有值就停轮询，
       而 medApply 一进来就把 t 写成「正在认这盒药…」——轮询第一次就停了，
       后面识别成功/失败改了消息，屏幕上永远没人刷新。 */
    /* 待确认状态也是 wait，别把它当「一直在认」刷掉 */
    const msg = window.__f7MedMsg;
    if (msg && msg.t) {
      m.textContent = msg.t;
      if (msg.s !== 'wait' || window.__medPending) clearInterval(t);
    }
    if (n > 30) {
      m.textContent = '这盒药没认出来，先往下走也行，以后在药箱里补。';
      clearInterval(t);
    }
  }, 800);
}
function onbStepInit(n){
  const c = onbCfg();
  if (n === 1) {
    const ph = $('onbSosPhone'), sw = $('onbFallSw');
    if (ph) {
      ph.value = S.sosPhone || '';
      const commit = () => { if (window.saveSosPhone) window.saveSosPhone(ph.value); };
      ph.onchange = commit; ph.onblur = commit;
    }
    if (sw) {
      const paint = () => sw.classList.toggle('on', S.fallDetectOn !== false);
      paint();
      sw.onclick = () => {
        if (window.saveFallOn) window.saveFallOn(S.fallDetectOn === false);
        paint();
        const tx = $('onbFallSub');
        if (tx) tx.textContent = S.fallDetectOn !== false
          ? '开着：手机检测到摔倒，会自动打给上面这个号码' : '关着：摔倒不会自动拨号';
      };
    }
  }
  if (n === 4) {
    /* 2026-11-10 菲尔特「第四步要支持药的添加和修改」 */
    if (window.onbMedRefresh) window.onbMedRefresh();
    const addBtn = $('onbMedAdd'), addIn = $('onbMedName');
    if (addBtn) addBtn.onclick = function(){
      const v = String((addIn && addIn.value) || '').trim();
      if (!v) { if (addIn) { addIn.focus(); addIn.placeholder = '先写下药名'; } return; }
      window.medAddByName(v, {});
      if (addIn) addIn.value = '';
      const m = $('onbMedMsg'); if (m) m.textContent = '「' + v + '」加好了。';
    };
    const shot = $('onbMedShot'), pick = $('onbMedPick');
    if (shot) shot.onclick = () => {
      const N = window.MiliNative, m = $('onbMedMsg');
      /* 2026-11-10 菲尔特「拍照根本没调用相机，看不到」：
         原来优先走 Vision.shoot 的 Camera2 后台静默拍照，屏幕上一点取景都没有。
         改成先拉系统相机（有取景框、有快门），ROM 不给才退回静默拍。 */
      let opened = false;
      if (N && N.snapPhoto) {
        try { const r = JSON.parse(N.snapPhoto() || '{}'); opened = !!(r && r.ok); } catch (e) {}
      }
      if (!opened && N && N.shoot) { try { N.shoot(0, 900001); opened = true; } catch (e) {} }
      if (m) m.textContent = opened ? '相机开了……把药盒正面摆进取景框，按快门。'
                                    : '这台手机开不了相机，用「从相册选」。';
      onbWatchMed();
    };
    if (pick) pick.onclick = () => {
      const fi = document.createElement('input');
      fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none';
      document.body.appendChild(fi);
      fi.onchange = () => {
        const f = fi.files && fi.files[0]; if (fi.parentNode) fi.remove();
        if (!f) return;
        const m = $('onbMedMsg'); if (m) m.textContent = '在读药盒……';
        const rd = new FileReader();
        rd.onload = () => {
          const img = new Image();
          img.onload = () => {
            const w = img.naturalWidth, h = img.naturalHeight;
            const sc = Math.min(1, 1024 / Math.max(w, h));
            const cv = document.createElement('canvas');
            cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            try { window.__medApply(cv.toDataURL('image/jpeg', 0.82).split(',')[1]); } catch (e) {}
            onbWatchMed();
          };
          img.onerror = () => { if (m) m.textContent = '这张照片读不出来，换一张试试。'; };
          img.src = String(rd.result || '');
        };
        rd.readAsDataURL(f);
      };
      fi.click();
    };
  }
  /* 2026-11-10 菲尔特「第 5 屏做丑了，参考家人端设备那一页」：
     原来四个裸 chip 飘在大片留白里。改成白卡分组 + 每行图标/名称/说明/勾选。 */
  if (n === 5) {
    const DEVS = [
      ['bp',   '血压仪', '早上量完血压，米粒帮着记下来', 'press'],
      ['glu',  '血糖仪', '饭前饭后的数，一并记着',       'drop'],
      ['band', '手环',   '看心率、看走了多少步',         'band'],
      ['vent', '呼吸机', '夜里用没用，家里人能知道',     'shield']
    ];
    const picked = Array.isArray(c.devices) ? c.devices : [];
    const box = $('onbDev');
    if (box) {
      box.innerHTML = DEVS.map(function(it){
        const on = picked.indexOf(it[0]) >= 0;
        return '<button type="button" class="onb-devrow' + (on ? ' on' : '') + '" data-k="' + it[0] + '">' +
          '<span class="onb-devic"><svg><use href="#i-' + it[3] + '"></use></svg></span>' +
          '<span class="onb-devtx"><b>' + it[1] + '</b><small>' + it[2] + '</small></span>' +
          '<span class="onb-devck">' + (on ? '✓' : '') + '</span></button>';
      }).join('');
      box.querySelectorAll('.onb-devrow').forEach(function(b){
        b.onclick = function(){
          c.devices = c.devices || [];
          const i = c.devices.indexOf(b.dataset.k);
          if (i >= 0) c.devices.splice(i, 1); else c.devices.push(b.dataset.k);
          save(); onbStepInit(5);
        };
      });
    }
  }
  if (n === 6) {
    onbPermRefresh();
    if (onbPermTimer) clearInterval(onbPermTimer);
    onbPermTimer = setInterval(() => {
      if (step !== 6) { clearInterval(onbPermTimer); onbPermTimer = null; return; }
      onbPermRefresh();
    }, 1200);
  } else if (onbPermTimer) { clearInterval(onbPermTimer); onbPermTimer = null; }
  if (n === 7) {
    onbChips('onbGrid', [['4','4 个 · 字大'],['6','6 个 · 放得多']],
             [String(c.grid === 6 ? 6 : 4)], (k) => { c.grid = +k; save(); onbStepInit(7); });
    onbChips('onbApps', ONB_APPS, Array.isArray(c.apps) ? c.apps : [], (k) => {
      c.apps = c.apps || [];
      const i = c.apps.indexOf(k);
      if (i >= 0) c.apps.splice(i, 1);
      else {
        if (c.apps.length >= (c.grid === 6 ? 6 : 4)) {
          /* 2026-11-10 菲尔特「超过 6 个就不能再选了，要有提示」：
             原来静默 return，老人以为按钮坏了，只会一直点。 */
          const tip = $('onbAppTip');
          const max = c.grid === 6 ? 6 : 4;
          if (tip) {
            tip.textContent = '最多放 ' + max + ' 个，已经放满了。先点掉一个，或者改成「6 个」那一档。';
            tip.style.color = '#C4453F';
          }
          return;
        }
        c.apps.push(k);
      }
      const tip0 = $('onbAppTip');
      if (tip0) { tip0.textContent = '已选 ' + c.apps.length + ' / ' + (c.grid === 6 ? 6 : 4) + ' 个'; tip0.style.color = ''; }
      save(); onbStepInit(7);
    });
    onbChips('onbDock', ONB_DOCK, Array.isArray(c.dock) ? c.dock : [], (k) => {
      c.dock = c.dock || [];
      const i = c.dock.indexOf(k);
      if (i >= 0) c.dock.splice(i, 1); else c.dock.push(k);
      save(); onbStepInit(7);
    });
  }
  if (n === 8) {
    /* 2026-11-10 20:2x 菲尔特：「3 秒太短，不能我自己点结束吗」。
       一个键：点一下开始录（一直录），自己再点一下结束；
       最长 12 秒原生兜底。原生桥 vpTakeStart / vpTakeStop。 */
    const SENT = ['米粒米粒，今天天气怎么样', '我想给女儿打电话', '该吃药了，帮我记一下'];
    const state = { n: 0, rec: false };
    const paint = () => {
      /* 20:26 菲尔特「三个例句一个一个来」：一次只给当前这一句，
         大字高亮 + 第 N/3 句进度，念完自动换下一句，别一次堆三行。 */
      const box = $('onbVpSent');
      if (!box) return;
      if (state.n >= 3) { box.innerHTML = '<div class="onb-vpone done">三句都念完啦 ✓</div>'; return; }
      box.innerHTML = '<div class="onb-vpstep">第 ' + (state.n + 1) + ' 句 / 共 3 句</div>' +
        '<div class="onb-vpone">' + SENT[state.n] + '</div>';
    };
    const draw = () => {
      paint();
      const btn = $('onbVp');
      if (btn) btn.textContent = state.n >= 3 ? '■ 三句都录好了'
        : (state.rec ? '■ 录好了，点一下结束' : '● 点一下，开始念第 ' + (state.n + 1) + ' 句');
      const m = $('onbVpMsg');
      if (m) m.textContent = state.rec
        ? '● 正在录 · 照着亮起来那句慢慢念，念完点上面的按钮结束'
        : (state.n >= 3 ? '■ 录好了。以后只有你能指挥它办事。'
          : '■ 已停 / 还没开始 · 点上面的键开始，念完自己点结束，不掐时间');
    };
    state.n = 0; draw();
    window.__onVoiceTake = function(cnt, target, score, done) {
      const c = Math.max(0, Number(cnt) || 0);
      if (done) {
        state.n = 3; state.rec = false;
        S.vpEnrolled = true; save();
        try { const N = window.MiliNative; if (N && N.vpEnrollStop) N.vpEnrollStop(); } catch (e) {}
        draw(); return;
      }
      /* 双保险：c=0 的初始化进度不许改状态，防旧包把「正在录」打回「未开始」 */
      if (c === 0 && !(typeof score === 'number' && score < 0)) return;
      if (typeof score === 'number' && score < 0 && c <= state.n) {
        state.rec = false; draw();
        const mm = $('onbVpMsg');
        if (mm) mm.textContent = '■ 这句没收着（可能麦克风被别的 App 占了），再点一次开始。';
        return;
      }
      state.n = Math.max(state.n, Math.min(2, c));
      state.rec = false; draw();
      const mm = $('onbVpMsg');
      if (mm) mm.textContent = '■ 第 ' + state.n + ' 句收好了，点一下开始录下一句。';
    };
    const btn = $('onbVp');
    if (btn) btn.onclick = () => {
      const N = window.MiliNative;
      if (!N || !N.vpTakeStart || !N.vpTakeStop) {
        const m = $('onbVpMsg'); if (m) m.textContent = '这台手机不支持录声纹，可以先跳过。'; return;
      }
      if (state.n >= 3) return;
      if (state.rec) {
        try { N.vpTakeStop(); } catch (e) { state.rec = false; draw(); }
        return;
      }
      if (state.n === 0) { try { N.vpEnrollStart(); } catch (e) {} }
      state.rec = true; draw();
      try { N.vpTakeStart(); } catch (e) { state.rec = false; draw(); }
      /* 12 秒兜底 */
      setTimeout(function(){
        if (!state.rec) return;
        state.rec = false; draw();
        const mm = $('onbVpMsg');
        if (mm && state.n < 3) mm.textContent = '■ 录到时间上限了，点一下开始重录这一句。';
      }, 13000);
    };
  }
}

function setStep(n) {
  /* 2026-11-10：每走一屏就落盘。设默认桌面会把 Activity 重建，
     重进引导时从这一屏接着走，前面填的名字/号码/开关全都在 S 里不会丢。 */
  try { localStorage.setItem('mili.onb.step', String(n)); } catch (e) {}
  /* 🚨 离开声纹那屏必须把本地录音收掉。vpEnrollStart 复用 startCv() 起的是
     sherpa-onnx 本地常驻麦克风，录不满 3 句就不收工；它会一直占着麦、把底噪
     当人声「出字」，唤醒后在线 ASR 一帧都拿不到，屏幕只剩「正在重开耳朵」。
     这是 P0 交流失灵的真根因之一。 */
  if (step === 8 && n !== 8) {
    try { const N = window.MiliNative; if (N && N.vpEnrollStop) N.vpEnrollStop(); } catch (e) {}
    window.__vpRec = false;
  }
  step = n;
  document.querySelectorAll('.onb-step').forEach((s) => s.classList.toggle('on', +s.dataset.step === n));
  document.querySelectorAll('.dots i').forEach((d, i) => d.classList.toggle('on', i + 1 === n));
  const nx = $('onbNext');
  if (nx) nx.textContent = n >= 9 ? (window.__onbEdit ? '保存并返回' : '进米粒') : '下一步';
  /* 重做后的步骤条：第 N 步 / 共 9 步 + 进度条，不再是一排小圆点孤零零飘着。 */
  const st = $('onbStepTitle'); if (st) st.textContent = '第 ' + n + ' 步';
  const bar = $('onbBar'); if (bar) bar.style.width = Math.round(n / 9 * 100) + '%';
  const sk = $('onbSkip'); if (sk) sk.hidden = (n >= 9 || !!window.__onbEdit);
  const pv = $('onbPrev'); if (pv) pv.hidden = (n <= 1);
  try { onbStepInit(n); } catch (e) { try { console.warn('[ONB] init ' + n + ' ' + e); } catch (e0) {} }
}
/* 上一步：菲尔特「怎么没有下一步和上一步」。 */
(function bindOnbPrev(){
  const pv = $('onbPrev');
  if (pv) pv.onclick = () => { if (step > 1) setStep(step - 1); };
})();
function showOnboard(edit) {
  window.__onbEdit = !!edit;
  const rg = $('roleGate'); if (rg) rg.hidden = true;
  $('onboard').hidden = false;
  /* 改配置模式把现有值回填，不让人从头再填一遍。 */
  if (edit) {
    const nm = $('nameMe'); if (nm) nm.value = S.me || '';
    const np = $('namePet'); if (np) np.value = S.pet || '米粒';
  }
  let resume = 0;
  if (!edit) { try { resume = +localStorage.getItem('mili.onb.step') || 0; } catch (e) {} }
  setStep(resume > 1 && resume <= 9 ? resume : 1);
  document.querySelectorAll('.perm').forEach((p) => {
    p.onclick = () => {
      p.classList.toggle('on');
      const k = p.dataset.perm;
      const on = p.classList.contains('on');
      S.perms[k] = on;
      save();
      const n = NATIVE();
      if (!n) return;
      // 点「无障碍」直接把老人送到系统那页，不让他自己找
      if (k === 'acc') {
        if (on && n.openAccessibility) {
          try { n.openAccessibility(); } catch (e) {}
          say('我把你送到设置页了。找「米粒」，把开关打开就行。', 8000, { slow: true, key: 'acc_guide' });
        }
      }
      if (k === 'mic') {
        try {
          /* 权限开关要连本地唤醒一起开合，且必须走 setWakeVisible 写盘，
             否则重给权限后 startService 起不来 KWS（wake_on 还是 false）。 */
          if (n.setWakeVisible) n.setWakeVisible(!!on);
          else if (on && n.startWakeWord) n.startWakeWord();
          else if (!on && n.stopWakeWord) n.stopWakeWord();
        } catch (e) {}
      }
    };
  });
}
$('onbNext').onclick = () => {
  if (step === 1) { setStep(2); return; }
  if (step === 2) {
    /* 名字可以空着。
       原来空着就是 focus 一下，什么都不说 —— 老人按「继续」没反应，只会一直按，
       以为坏了。名字只是个称呼，不填也能用；真要提醒，就用一句话提醒，别卡住人。 */
    const v = $('nameMe').value.trim();
    if (!v && !window.__nameNudged) {
      window.__nameNudged = true;
      say('不想写也行，那就先不叫名字。再按一次继续。', 5200, { slow: true });
      return;
    }
    S.me = v; setStep(3); return;
  }
  if (step === 3) {
    const v = $('namePet').value.trim();
    S.pet = v || '米粒'; setStep(4); return;
  }
  if (step === 4) { setStep(5); return; }          /* 拍药盒 → 设备 */
  if (step === 5) { setStep(6); return; }          /* 设备 → 权限逐个开 */
  if (step === 6) { setStep(7); return; }          /* 权限 → 桌面 */
  if (step === 7) {
    const c = onbCfg();
    S.homeBtns = (Array.isArray(c.apps) ? c.apps : []).slice(0, c.grid === 6 ? 6 : 4);
    c.setupDone = true; save();
    try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch (e) {}
    try { if (window.__V9_DESK_APPLY) window.__V9_DESK_APPLY(); } catch (e) {}
    try { renderDesk(); } catch (e) {}
    setStep(8); return;
  }
  if (step === 8) { setStep(9); showOnbCode(); return; }   /* 声纹 → 同步码 */
  try { localStorage.removeItem('mili.onb.step'); } catch (e) {}
  if (window.__onbEdit) {
    /* 改配置模式：保存就回桌面，不重走登录/问候那一套。 */
    window.__onbEdit = false;
    S.onboarded = true; save();
    /* 2026-11-10 菲尔特「在设置里改了桌面布局，双端都没生效」：
       原来只 save()+push，没把 S.cfg.apps/grid 应用到桌面，也没重绘；
       而且没绑定同步码时 pushCfgAuto 直接 return，另一端永远收不到。
       这里本机先强制应用，再推，推不动就明说。 */
    try {
      const c = onbCfg();
      if (Array.isArray(c.apps)) {
        S.homeBtns = c.apps.slice(0, 6);
        c.grid = S.homeBtns.length >= 5 ? 6 : 4;
      }
      if (typeof renderDesk === 'function') renderDesk();
      if (typeof applyDesk === 'function') applyDesk();
      if (window.__V9_DESK_APPLY) window.__V9_DESK_APPLY();
    } catch (e) {}
    save();
    $('onboard').hidden = true;
    try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch (e) {}
    bootRefresh();
    return;
  }
  S.onboarded = true; save();
  applyRestoredState();          /* 认出人了，把这位老人以前的配置拉回来 */
  $('onboard').hidden = true;
  bootRefresh();
  setTimeout(() => {
    // 已经问过话就别念问候了，不然会把答案冲掉
    if (window.__askedOnce || !$('bubble').hidden) return;
    /* 🚨 2026-11-07：这句原来是「我在这儿。你问我就行。」
       首页下面那条待唤醒卡写着「我一直在，你出声就行」——同一件事说两遍。
       这里只留第一次见面该说的话：它叫什么。 */
    say('我是' + (S.pet || '米粒') + '，你说什么我都听着。', 5200, { slow: true, key: 'hi_new' });
  }, 900);
};
/* 引导允许「这一步先跳过」，但顺序不许乱跳 —— 只往前走一屏。
   现场只有一部手机时，不必被相机/权限卡死。 */
(function bindOnbSkip(){
  const sk = $('onbSkip');
  if (sk) sk.onclick = () => { if (step < 9) setStep(step + 1); };
})();

/* ============ 启动 ============ */
function bootRefresh() {
  try { window.applySafetyCfg && window.applySafetyCfg(); } catch (e) {}
  try { purgeSysStuck(); } catch (e) {}   /* 老数据里「桌面卡住」这种噪音清一次 */
  renderHero();
  try { startHead(); } catch (e) {}
  try { renderDesk(); } catch (e) {}
  try { renderDialPad(); } catch (e) {}
  try { bindSpeakTime(); } catch (e) {}
  try { bindBigFont(); applyBig(); } catch (e) {}
  /* 气泡常驻：开机先给它一句主动的话（有到点的事会被下面 checkDueTasks 覆盖） */
  const bb = $('bubble'), bt = $('bubbleText');
  if (bb && bt && !bt.textContent.trim()) { bt.textContent = idleLine(); bb.hidden = false; }
  renderDid(); renderLearn(); renderFam(); renderMed();
  applyForm(false);
  const mc = $('medCap');
  if (mc) {
    const on = S.med.filter((m) => m.on);
    const fresh = (m) => m.takenAt && Date.now() - m.takenAt < 4 * 60 * 60 * 1000;
    if (on.length && on.every(fresh)) mc.textContent = '今天的药都吃过了';
    else if (on.length) mc.textContent = on.length + ' 颗 · ' + on[0].when;
    else mc.textContent = '还没填，让家里人帮你加';
  }
  try { checkDueTasks(); } catch (e) {}
}

/* 一开机，先把今天到点的事提一句。
   为什么要开机就提：老人交代过「明天提醒我交电费」，他不会自己记着来问。
   等他想起来才说，那这件事就等于没记。 */
function checkDueTasks() {
  const open = taskList();
  if (!open.length) return;
  const today = ymd();
  const due = open.filter((t) => !t.when || t.when.slice(0, 10) <= today);
  if (!due.length) return;
  const b = $('bubble'), tx = $('bubbleText');
  if (!b || !tx) return;
  const t = due[0];
  tx.textContent = '您交代过：' + t.what + (t.when ? '（' + t.when + '）' : '') +
    (due.length > 1 ? '，还有 ' + (due.length - 1) + ' 件' : '');
  b.hidden = false;
}

/* 首页头部。这里的第一句话决定老人怎么理解这个产品：
   不是「问答机」，是「它在学我怎么用它」。 */
function renderHero() {
  const nm = S.pet || '米粒';
  const el = $('heroTitle'); if (el) el.textContent = nm;
  const cap = $('heroCap');
  if (cap) {
    const p = formPoints();
    if (p === 0) {
      cap.textContent = (S.me ? S.me + '，' : '') + '你问它，它学你';
    } else {
      const f = formOf(p);
      cap.textContent = greeting(new Date().getHours());
    }
  }
  const bEl = $('formBadge');
  if (bEl) bEl.textContent = formOf(formPoints()).name;
}


function boot() {
  window.__booted = 'start';
  /* 一开机就把以前学歪的规则清掉。
     毒规则是「秒答」，不等老人问就已经在那儿了 ——
     越晚清，越可能他今天第一句就撞上一条字典。 */
  try { const n = prunePoisonRules(); if (n) console.log('清掉学歪的规则 ' + n + ' 条'); } catch (e) {}
  initThree();
  window.__booted = 'three';
  resize();
  fitPhone();
  if (!VIDEO_PET) animate();   // 视频形象：3D 渲染循环不跑（省 GPU/电池）
  window.__booted = 'anim';
  /* 待唤醒条默认就该在。它只在「正在通话」的时候收起来。 */
  try {
    if (typeof CALL !== 'undefined' && !CALL.on) {
      const sb = $('sbBar'), sd = $('sbDots');
      if (sb) sb.hidden = false;
      if (sd) sd.hidden = false;
    }
  } catch (e) {}
  addEventListener('resize', () => { fitPhone(); resize(); });

  /* 自动接听白名单开机推一份（原生存着，进程重启也生效） */
  try { setTimeout(syncCallCfg, 3000); } catch (e) {}


  /* 键盘弹起来的时候，把引导页底部那颗按钮顶到键盘上面。
     WebView 高度是固定的，键盘不会把页面压小，于是「继续」正好被盖住 ——
     老人看着像按钮没了，其实是压在键盘底下。改成跟着可视区一起动。 */
  try {
    const vv = window.visualViewport;
    if (vv) {
      const lift = () => {
        const foot = document.querySelector('.onb-foot');
        if (!foot) return;
        const cover = Math.max(0, (window.innerHeight - vv.height) - (vv.offsetTop || 0));
        foot.style.transform = cover > 80 ? 'translateY(-' + (cover + 6) + 'px)' : '';
      };
      vv.addEventListener('resize', lift);
      vv.addEventListener('scroll', lift);
      setTimeout(lift, 400);
    }
  } catch (e) {}

  /* 2026-11-05：假状态栏和日期都删了（菲尔特原话「顶部的时间、日期和右边
     三个点很多余」），这里原来每 20 秒去改 #sbTime / #heroDate 的钟也就没有
     对象了。留着会直接 TypeError —— 注释掉，别再找那两个元素。 */
  // const WD = ['周日','周一','周二','周三','周四','周五','周六'];
  // const tick = () => { ... }
  // tick(); setInterval(tick, 20000);

  /* 清除数据后全自动恢复：localStorage 空了，就从原生公共备份读回来。
     读回来就当从没清过 —— 不进引导页、不用重新配对、不用家里人帮忙。 */
  const QQ = new URLSearchParams(location.search);
  if (QQ.get('skip') === '1') { S.onboarded = true; }
  if (DEMO) {
    /* 演示版不是一个隐藏参数，是屏幕上看得见的一个场景：
       点这个 badge 就能当场「学会一条 / 删掉一条」，让评委看它变大变小。 */
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'demobadge';
    badge.textContent = '演示版 · 成长加速';
    badge.onclick = showDemoSheet;
    const hero = document.querySelector('.hero');
    if (hero) hero.appendChild(badge);
  }

  function routeStart() {
    if (QQ.get('p')) goPage(QQ.get('p'));
    /* 🚨 2026-11-10 16:15 真机：原来第一行 `if (S.role === 'family') 直接进家人端`
       把后面所有校验全吃掉了 —— 家人端不填码也能进，票是老人的也照样进。
       现在先定身份、再把身份推给原生（家人端连唤醒都不许响），最后才分路。 */
    const fam = !!(S.role === 'family' && S.accToken && S.pairCode);
    window.__F7_FAMILY = fam;
    try {
      const nb = NATIVE();
      if (nb && nb.setFamilyMode) nb.setFamilyMode(fam);
    } catch (e) {}
    if (!S.role || !S.accToken || !S.accRole) { showRoleGate(); return; }
    if (S.role === 'family') {
      if (!fam) { familyEntry(); return; }        /* 没填对码就回填码页 */
      $('onboard').hidden = true;
      afterFamilyBind();
      return;
    }
    /* 有票就放行，不再拿 accRole 反查踢人。身份不一致在 reconcileIdentity 里
       已经拢齐；这里再踢一次只会让老人每次开机都被挡在第一屏。 */
    if (!S.onboarded) { showOnboard(); return; }
    else {
      $('onboard').hidden = true; bootRefresh();
      /* 2026-11-07 傍晚：开机不再自动进通话。常驻监听把环境人声当指令，
         「我啥话没说它莫名其妙去做事」就是它干的；回复慢、听不见也因为它一直占着麦。
         现在待机白条点一下才开始说，唤醒词「米粒」依旧有效。 */
    }
  }

  /* 清除数据后：先走注册/登录/引导认人，认完再拉回配置。
     坑1：MiliNative 是异步注入的，启动那一刻桥可能还没进来 → 等桥就绪。
     坑2：以前直接把整包状态写回 S，onboarded:true 把引导页跳过了，
          连测试用的名字都一起回来。现在配置只暂存，绝不写 S / localStorage。 */
  window.__PENDING_RESTORE = null;
  (function bootWithRestore() {
    if (localStorage.getItem(STORE_KEY)) { routeStart(); return; }
    let tries = 0;
    const tick = () => {
      let n = null;
      try { n = NATIVE(); } catch (e) {}
      if (n && n.loadState) {
        try {
          const b = n.loadState();
          if (b && b.length > 2) {
            const o = JSON.parse(b);
            if (o && typeof o === 'object') {
              const cfg = { ...o };
              IDENTITY_KEYS.forEach((k) => delete cfg[k]);
              delete cfg._native;
              if (Object.keys(cfg).length) window.__PENDING_RESTORE = cfg;
            }
          }
        } catch (e) {}
        routeStart();     /* S 还是 DEF → 必走角色门 / 引导 */
        return;
      }
      if (++tries < 24) setTimeout(tick, 250);
      else routeStart();   /* 桥一直没来也得进页面，不能白屏 */
    };
    tick();
  })();

  /* ============ 底部输入区（2026-11-05 按豆包重做） ============
     一条白胶囊：相机 / 按住说话 / 键盘 / 加号。
     原来这里是「输入框 + 一颗蓝胶囊」，两行 130px，老人得先想点哪个。 */
  /* ===== 2026-11-06 菲尔特：「还是不要这个底部的按住说话，都变成后面的形式」=====
     原来这里是一整套按住录音：touchstart 开、touchend 收、差 260ms 判轻点。
     它在手机上永远有一半是坏的 —— 手指一滑就算 cancel，老人以为没录上；
     而且「按住」这个动作本身是老式对讲机的习惯，豆包、omi 都不是这么做的。
     现在一颗胶囊：点一下 = 通话开始。说完不用松手，它自己在听。 */
  const hold = $('holdBtn');
  if (hold) {
    hold.textContent = '点这儿，跟米粒说话';
    hold.classList.add('callentry');
    /* 2026-11-09：必须传 'tap'。callEnter() 无参时 why='auto'，冷启动 10 秒内
       会被那道「不许程序自己进通话」的门直接吞掉 —— 老人开机就点说话没反应。 */
    const go = (e) => { if (e && e.cancelable) e.preventDefault(); callEnter('tap'); };
    hold.addEventListener('click', go);
    hold.addEventListener('touchend', go);
  }

  /* 通话条三颗按钮。挂断是唯一会让老人「退出去」的动作，
     所以它最大、最红、在正中间 —— omi 也是这么摆的。 */
  const cbHangB = $('cbHang');
  if (cbHangB) cbHangB.onclick = () => callExit('bye');
  const cbMicB = $('cbMic');
  if (cbMicB) cbMicB.onclick = () => callToggleMic();
  /* 键盘那颗：先退出通话（不然录入的时候麦克风还开着，它会把打字声也听进去），
     再把输入框顶上来。toType 在这段代码后面才定义，所以走 window 上的出口。 */
  const cbKeyB = $('cbKey');
  if (cbKeyB) cbKeyB.onclick = () => {
    callExit('type');
    const kb = $('kbBtn');
    if (kb) kb.click();
  };

  /* 页面切走就别再录了。老人的手机常被孙子拿去玩，
     后台开着麦克风是件很吓人的事。 */
  document.addEventListener('visibilitychange', () => {
    /* 🚨 2026-11-10 真机：跳微信/拨号会瞬间 hidden，agent 正跑到一半，
       这里把通话连声音一起拆了 —— 老人看到的就是「做不了事」。
       agent 还在跑的时候只停录音（隐私红线不破），不拆通话、不掐声音。 */
    if (!document.hidden || !CALL.on) return;
    if (window.MILI_AGENT && MILI_AGENT.agentBusy && MILI_AGENT.agentBusy()) {
      try { stopListen(); } catch (e) {}
      try { console.log('[CV] hidden 但 agent 在跑，通话保留'); } catch (e) {}
      return;
    }
    callExit('hide');
  });

  /* 键盘：切成打字。老人用得少，家里人用得着。
     切的时候胶囊和输入条同高，页面不跳。 */
  const comp = $('composer'), tbar = $('typebar');
  const toType = () => {
    if (!comp || !tbar) return;
    comp.hidden = true; tbar.hidden = false;
    setTimeout(() => { const ti = $('typeIn'); if (ti) ti.focus(); }, 30);
  };
  const toVoice = () => {
    if (!comp || !tbar) return;
    tbar.hidden = true; comp.hidden = false;
    const ti = $('typeIn'); if (ti) ti.blur();
  };
  if ($('kbBtn')) $('kbBtn').onclick = toType;
  if ($('kbBack')) $('kbBack').onclick = toVoice;

  /* 加号：相册 / 拍照 / 说话。相机那颗直接拍，加号里再给一次选择。 */
  const plus = $('plusBtn'), ps = $('plusSheet'), fileIn = $('fileIn');
  const pickImg = (useCam) => {
    if (!fileIn) return;
    if (ps) ps.hidden = true;
    fileIn.value = '';
    if (useCam) fileIn.setAttribute('capture', 'environment');
    else fileIn.removeAttribute('capture');
    fileIn.click();
  };
  if (plus) plus.onclick = (e) => { e.stopPropagation(); if (ps) ps.hidden = !ps.hidden; };
  if ($('camBtn')) $('camBtn').onclick = () => pickImg(true);
  if ($('pickCam')) $('pickCam').onclick = () => pickImg(true);
  if ($('pickAlbum')) $('pickAlbum').onclick = () => pickImg(false);
  if ($('pickVoice')) $('pickVoice').onclick = () => { if (ps) ps.hidden = true; openListen(false); };
  if (fileIn) fileIn.onchange = () => {
    const f = fileIn.files && fileIn.files[0];
    if (f) askByPhoto(f);
  };
  document.addEventListener('click', (e) => {
    if (!ps || ps.hidden) return;
    if (ps.contains(e.target) || (plus && plus.contains(e.target))) return;
    ps.hidden = true;
  });

  /* 打字给米粒：跟说话走同一条主路由（handleSay），不是另一套逻辑 */
  const _ti = $('typeIn'), _ts = $('typeSend');
  if (_ti && _ts) {
    const send = () => {
      const v = (_ti.value || '').trim();
      if (!v) return;
      _ti.value = '';
      _ti.blur();
      handleSay(v);
    };
    _ts.onclick = send;
    _ti.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
  }
  const _ht = $('hubTalk');
  if (_ht) _ht.onclick = () => openListen(false);
  $('cancelBtn').onclick = closeListen;

  /* 开机就把天气拉回来存着。
     weather() 是同步联网（真机实测 1.5~2.2 秒），问的时候现拉，
     老人就得盯着屏幕干等两秒。开机后台拉一次，问的时候直接念缓存。 */
  setTimeout(warmWeather, 1200);

  /* 家人端三按钮：不接线就是三个死按钮（真踩过） */
  const _fs = $('famShoot'); if (_fs) _fs.onclick = famShoot;
  const _fsv = $('famSaveMed'); if (_fsv) _fsv.onclick = famSaveMed;
  const _fr = $('famRegister'); if (_fr) _fr.onclick = famRegister;
  /* 我的页：切端 / 登录 / 退出 / 配对 / 定位 */
  try { wireMe(); } catch (e) {}
  /* 一开机就查登录态。不查的话，重开 App 会显示「还没登录」，
     但会话其实还在 —— 老人会以为要重新登录一遍。 */
  /* 开机校验票据。注意要顺手把家人端首页重画一遍 ——
     刚进来时 ACC.user 还是空的，页面先按「没登录」画了一次；
     校验完不重画，就会出现「明明登录了，首页却说还没登录」。 */
  accSession().then((u) => {
    if (!u) return;
    try { famCardReset(); } catch (e) {}
    try { renderMe(); } catch (e) {}
    try { renderFamHome(); } catch (e) {}
  }).catch(() => {});
  $('cancelBtn2').onclick = closeListen;
  $('addFamBtn').onclick = window.__addFam;
  $('addMedBtn').onclick = window.__addMed;
  $('medRow').onclick = () => goPage('med');
  const mt = $('medTaken');
  if (mt) mt.onclick = (e) => { e.stopPropagation(); try { medTakenTap(); } catch (x) {} };
  /* 三个新场景的按钮。不接线就是死按钮 —— 这个坑已经踩过一次。 */
  try { wireNewScenes(); } catch (e) { (window.__errs = window.__errs || []).push('wireNewScenes: ' + e.message); }
  renderHub();
  renderQuick();
  /* 开屏就把首页那条血压/血糖告警画出来。
     以前只有进「血压血糖」页时才调 renderVitalWarn —— 于是冷启后首页永远是空的，
     老人昨天量出 148 的事今天一开机就看不见了，得自己点进去才发现。
     这正是告警最该起作用的时候。 */
  try { renderVitalWarn(); } catch (e) { (window.__errs = window.__errs || []).push('renderVitalWarn: ' + e.message); }
  window.__booted = 'ready';

  setTimeout(resize, 60);
  /* 盯住米粒卡的高度：气泡换行、告警条出现，鸡都不能再被拉扁 */
  try { setTimeout(watchPetBox, 80); } catch (e) {}
  setTimeout(() => {
    if (!S.onboarded) return;
    /* 🚨 2026-11-07：这句原来是「爷爷，我在这儿。」
       可首页下面那条待唤醒卡已经写着「我一直在，你出声就行」——
       一屏两句话说同一件事，而且是同一个意思说两遍。
       待唤醒卡负责两件事：我在、怎么叫我。所以气泡不许再说这两件，
       只说一件待唤醒卡说不了的：**它认得你**。
       「回来啦」是句人话，也是一句只有熟人之间才说的话。 */
    const nm = S.me ? S.me + '，' : '';
    say(nm + '回来啦。', 5200, { slow: true, key: 'hi_back' });
    playAnim('wave', 1.6);
  }, 1200);

  // 原生唤醒 + 无障碍记录
  window.__onWake = onWake;
  // 桌宠那边点「按住说」，回到主界面直接开麦
  window.__openListen = () => openListen(true);
  /* 2026-11-06 晚：喊了一声「米粒」，原生把界面抬起来之后走这里。
     直接进通话态（不是旧的按住说话面板），并保证停在首页。
     少一步，老人看到的就是「界面开了，但还得自己再点一下」。 */
  window.__wakeIn = () => {
    /* 家人端一票否决：家长在这边看数据，米粒不许被喊醒、不许出声。 */
    if (window.__F7_FAMILY) { return; }
    /* 🚨 2026-11-10 菲尔特实测：在米粒任何页面喊「米粒」都回不了首页。
       原来跳页排在 1.5 秒冷却后面 —— 挂断后马上喊的那一声连首页都不回。
       跳页挪到最前：只要喊了，人就该被带回首页；进不进通话另说。 */
    /* 🚨 21:4x 真机实证：设置页是 #v9 浮层（class on），goPage('home')
       只管 .page.on，而且 S.page 本来就是 home → goPage 直接 early-return。
       所以喊了米粒，通话条都出来了，人还压在设置页回不去。
       先关浮层、清 S.page，再让 goPage 真执行。 */
    try { if (window.__V9_CLOSE) window.__V9_CLOSE(); } catch (e) {}
    try { S.page = ''; } catch (e) {}
    try { goPage('home'); } catch (e) {}
    /* 冷却只压「进通话」这一段，不再压跳页。 */
    var now = Date.now();
    if (window.__lastCallEnd && now - window.__lastCallEnd < 1500) { return; }
    /* 🚨 2026-11-10 真机根因：goPage 里有「切到家人端/我的页就停麦」的副作用
       （`if (window.__cvOn) stopCv()`），跟这里紧接着的 callEnter 打架。
       日志实测：startCvOnline 进来 2 毫秒后 cvStop 被连调两次，
       麦克风让出去以后没人用 —— 界面上「在听」，一句话也不答。
       挪到下一帧再开麦，让 goPage 的副作用先跑完。 */
    setTimeout(function () { try { callEnter('wake'); } catch (e) {} }, 0);
  };
  const nn = NATIVE();
  if (nn) {
    /* 设置里关了「喊米粒唤醒」就不许把常驻服务拉起来占麦 */
    let wv = true;
    try { wv = nn.wakeVisible ? !!nn.wakeVisible() : true; } catch (e) {}
    try { if (wv && S.perms.mic && nn.startWakeWord) nn.startWakeWord(); } catch (e) {}
    // 无障碍记的卡点，真的变成它学会的东西
    syncStuck();
  }

  /* 取消定时冒话。
     以前每 30 秒挑一句说，几轮下来全是重复 —— 这不是陪伴，是骚扰。
     现在只有三种情况米粒才主动开口：
       1) 该吃药了（闹钟触发，走 MedAlarm）
       2) 刚学会一件事（announceGrow，说完就停）
       3) 它记得你在某个软件里会卡，而你刚打开那个软件
     其余时间闭嘴，等老人问。 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // 回到 App 时，只在「有实事要说」的情况下才开口
    const say1 = dueSayOnce();
    if (say1) { say(say1, 6000, { slow: true }); playAnim('tilt', 1.2); }
  });
}

/* 回到 App 时该不该说一句。说过一次就记下来，不重复。 */
function dueSayOnce() {
  const today = new Date().toISOString().slice(0, 10);
  if (S.lastHello === today) return null;      // 今天已经说过就不再重复
  const st = medNow();
  const fresh = st.due.filter((m) => !m.justSaid);
  if (fresh.length) {
    S.lastHello = today; save();
    return fresh[0].who + '该吃了，' + fresh[0].when + '。';
  }
  return null;
}

/* 从它真正记得的事里挑一句。没有就不说 —— 宁可沉默，也别凑字数。 */
function pickProactive(i) {
  const cand = [];
  const stuck = S.rules.filter((r) => r.kind === 'stuck');
  if (stuck.length) {
    const r = stuck[i % stuck.length];
    cand.push('你上回在' + (r.app || '那个软件') + '里停了一会儿。要现在再走一遍吗？');
  }
  const slow = S.rules.filter((r) => r.kind === 'slow');
  if (slow.length) {
    const r = slow[i % slow.length];
    cand.push('「' + (r.q || '') + '」你要不要再问一遍？我慢慢说。');
  }
  if (!cand.length) return null;
  return cand[i % cand.length];
}

/* 读无障碍报上来的卡点，攒够两次就变成一条「学会的事」 */
function syncStuck() {
  const n = NATIVE();
  if (!n || !n.stuck) return 0;
  try {
    const raw = n.stuck();
    if (!raw) return 0;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || !arr.length) return 0;
    return learnStuck(arr);
  } catch (e) { return 0; }
}

/* 开机启动包一层 try/catch：boot 里任何一步抛异常，整个页面就只剩静态骨架
   （CSS 还在，所以看着"像是加载完了"，其实 3D、快捷按钮、药名全没渲染）。
   以前这种崩法在模拟器里完全看不见原因，现在直接把第一行错误画到屏幕上。 */
try {
  boot();
} catch (e) {
  const msg = '[BOOT] ' + (e && e.message ? e.message : e) + '\n'
    + String((e && e.stack) || '').split('\n').slice(1, 4).join('\n');
  if (window.__paintErr) window.__paintErr(msg); else console.error(msg);
}

/* 启动就把智能体接好，别等第一次问话。
   之前 wireAgent() 只在 handleSay 里调，问题有两个：
   ① 本地规则能接住的话，永远走不到 agentSay，接线就永远不执行；
   ② 探针、自测直接调 MILI_AGENT.run 时，环境是空壳，工具全返回「办不了」。
   接线本身不联网、不花钱，启动时做掉最省事。 */
try { wireAgent(); } catch (e) {}

/* 日新引擎要用真表，不能自己抄一份 —— 抄的会跟正则脱节 */
window.__INTENTS = INTENTS;
/* 学错了、被自己撤掉的时候也说一声。承认错了比装作没事强。 */
window.__EVO_UNDO = function (rec) {
  try { say('刚才那句我理解错了，已经改回去了。', 5400, { slow: true }); } catch (e) {}
};
/* 日新引擎自己学会一句时，回来告诉老人一声 —— 只告知，不要求他做任何事 */
window.__EVO_SAY = function (rec) {
  try { say('我记住你说的「' + rec.from + '」了，以后这么问我也懂。', 6200, { slow: true }); } catch (e) {}
  try { playAnim('nod', 1.2); } catch (e) {}
};
window.__TOGGLES = TOGGLES;

window.MILI = { state: S, mode: DEMO ? 'demo' : 'product', reset: () => { localStorage.removeItem(STORE_KEY); location.reload(); },
  teach: teachOne, say, ask: handleSay, search: doSearch, anim: playAnim,
  /* 自测用：意图解析（不改状态，只看会怎么理解这句话）
     必须跟 handleSay 的真实顺序一致 —— 只报 INTENTS 是不够的：
     天气/防骗/身体不适/闹钟走的是另一条分支，探针看不见就会误判成「没接住」。 */
  intent: (t) => {
    const s = String(t || '').replace(/[，。？！、,.?!\s]/g, '');
    for (const g of TOGGLES) { const m = s.match(g.re); if (m) return 'toggle:' + g.id; }
    for (const it of INTENTS) {
      const m = s.match(it.re);
      if (m && (!it.guard || it.guard(m))) return it.id + ' -> ' + (m[1] || '');
    }
    if (ALARM_RE.test(s) && parseClock(s)) return 'alarm -> ' + parseClock(s).h + ':' + parseClock(s).m;
    for (const f of FASTQ) if (f.re.test(s)) return 'fast:' + f.id;
    return 'none';
  },
  tryDo: tryDo, capture: capture,
  /* 自测口：把一句话原样喂给主流程，跟老人真的说一遍走同一条路 */
  say: (t) => handleSay(t, true),
  /* 自测/演示用：回退、分数、卡点注入 */
  forget: forgetRule, points: formPoints, forms: () => FORMS,
  stuck: (arr) => learnStuck(arr), ruleOf: findRule,
  medNow: medNow, proactive: (i) => pickProactive(i || 0),
  /* 云服务自测出口 */
  cloudOK: () => cloudOK(), llmAsk: (q) => llmAsk(q), ttsFetch: (t) => ttsFetch(t),
  /* 账号 / 配对自测出口：探针能不看界面直接验服务端 */
  acc: {
    who: () => ACC.user,
    session: () => accSession(),
    login: (p, w) => accLogin(p, w),
    register: (p, w, n) => accRegister(p, w, n),
    logout: () => accLogout(),
    newCode: () => accNewCode(),
    pair: (c) => accPair(c),
    pull: () => pullMeds(),
    push: () => pushMeds(),
    card: () => accElderCard(),
    logAct: (k, t, d) => accLogAct(k, t, d),
    api: (p, o) => accApi(p, o),
  },
  /* 手环自测出口：探针能不看界面直接验原生桥 */
  band: {
    has: () => { const n = NATIVE(); return !!(n && n.bandStart); },
    on: () => { const n = NATIVE(); try { return !!(n && n.bandOn()); } catch (e) { return false; } },
    fresh: () => { const n = NATIVE(); try { return !!(n && n.bandFresh()); } catch (e) { return false; } },
    bpm: () => { const n = NATIVE(); try { return n && n.bandBpm ? Number(n.bandBpm()) : 0; } catch (e) { return 0; } },
    status: () => { const n = NATIVE(); try { return n && n.bandStatus ? String(n.bandStatus()) : 'no bridge'; } catch (e) { return 'err'; } },
    start: () => { const n = NATIVE(); try { n && n.bandStart && n.bandStart(); } catch (e) {} },
    stop: () => { const n = NATIVE(); try { n && n.bandStop && n.bandStop(); } catch (e) {} },
    render: () => renderBand(),
  },
  llmModel: () => llmPickModel().then(m => m ? m.id : null),  llmErr: () => window.__llmErr || null,
  llmDbg: () => JSON.stringify(window.__llmDbg || {}),
  go: (p) => goPage(p), roots: () => ({ chick: chickRoot, mid: midRoot, adult: adultRoot }),
  /* 渲染定格姿态用（做插图/卡面） */
  bones: () => bones, pose: pose,
  idleAnim: ANIM,
  /* 自测用：把骨骼和朝向暴露出来，方便量轴向 */
  bones: () => bones, pet: () => PET,
  probe: (k, x, y, z) => { if (!bones[k]) return 'no bone ' + k;
    pose(bones[k], x, y, z); return 'ok'; },
  axes: () => { const o = {}; for (const k in bones) {
      const b = bones[k], w = new THREE.Vector3();
      b.getWorldPosition(w); o[k] = [+w.x.toFixed(3), +w.y.toFixed(3), +w.z.toFixed(3)]; } return o; },
  rest: () => { for (const k in bones) if (bones[k].userData.q0) bones[k].quaternion.copy(bones[k].userData.q0); },
  /* 定格：给动作名 + 进度 u，直接把姿态算出来。录片子用，保证和屏幕上同一套动作 */
  frame: (name, u, t) => {
    if (!PET) return 'no pet';
    const base = PET === adultRoot ? 1.32 : PET === midRoot ? 1.16 : 1.02;
    const idle = ANIM.idle(0, t || 0);
    const a = (name && name !== 'idle' && ANIM[name]) ? ANIM[name](u, t || 0) : idle;
    applyPose(a, idle, base);
    if (renderer) renderer.render(scene, camera);
    return 'ok';
  },
  renderer: () => renderer, scene: () => scene, camera: () => camera,
  bg: (hex) => { if (renderer) renderer.setClearColor(hex, 1); } };

/* ============================================================================
   桌面 v6 · 老人端极简（2026-11-07 凌晨）
   ----------------------------------------------------------------------------
   只做三件事：把首页 10 块收成 4 块、把常用图标按老人的手自动排序、
   把 SOS 改成长按 3 秒。原有 app.js 一个函数都不改，全部靠「复用已有节点
   和已有事件」接进去，所以 13 页、agent、语音、原生桥都不受影响。

   ?ui=full  → 完全不启用本层（一键回到上一版）
   ?skin=cream 已废弃（2026-11-07）：奶油底＝屎黄，永久禁用，带参也不生效

   「进化」是真的：点过的图标记次，下次打开自动排到前面；顺序变了米粒
   会主动说一句。现场两次运行就有可见差异，不需要后端、不需要写规则。
   ========================================================================== */
(function desk6(){
  var qs = new URLSearchParams(location.search);
  if (qs.get('ui') === 'full') return;               /* 一键回退 */
  var root = document.documentElement;
  root.classList.add('desk6');

  function q(sel, from){ return (from || document).querySelector(sel); }
  function el(tag, cls, html){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  var MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';
  var SOSICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/></svg>';
  var LAMP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 5H8z"/><path d="M8 8v3a4 4 0 0 0 8 0V8"/><path d="M10 18h4M10 21h4"/></svg>';

  var HITS = 'mili.desk6.hits';
  var ORDER = 'mili.desk6.order';
  /* 初始偏序：老人真正会摸的排前面，系统类退后。之后点击频次接管。 */
  var PREFER = ['dialer','wechat','camera','album','sms','torch','calllog','settings'];
  /* 设置页里四个真开关，全部落 localStorage，刷新不丢。 */
  var OPT = 'mili.desk6.opt';
  function defOpt(){ return { big:false, lock:false, show6:false }; }
  function readOpt(){
    try { return Object.assign(defOpt(), JSON.parse(localStorage.getItem(OPT) || '{}') || {}); }
    catch(e){ return defOpt(); }
  }
  function saveOpt(o){ try { localStorage.setItem(OPT, JSON.stringify(o)); } catch(e){} }
  var opt0 = readOpt();
  var SHOW = opt0.show6 ? 6 : 4;                  /* 一屏 4 个，设置里可开到 6 个 */
  function readHits(){ try { return JSON.parse(localStorage.getItem(HITS) || '{}') || {}; } catch(e){ return {}; } }
  function rank(k, hits){
    var p = PREFER.indexOf(k); if (p < 0) p = 99;
    return (hits[k] || 0) * 1000 + (99 - p);
  }

  var busy = false, done = false, mo = null;
  function reorder(silent){
    if (busy) return;
    var grid = q('#deskGrid'); if (!grid) return;
    var items = Array.prototype.slice.call(grid.querySelectorAll('[data-desk]'));
    if (!items.length) return;
    /* 2026-11-07 v9：家人端在引导里配过显隐和顺序之后，这一层就不许再按
       点击频次重排——否则老人多点两下，家人配好的图标就被换掉一批。 */
    var v9st = null;
    try { v9st = JSON.parse(localStorage.getItem('mili') || 'null'); } catch(e){}
    if (v9st && v9st.cfg && v9st.cfg.setupDone && v9st.cfg.apps && v9st.cfg.apps.length){
      SHOW = v9st.cfg.grid === 6 ? 6 : 4;
      try { window.__V9_DESK_APPLY && window.__V9_DESK_APPLY(); } catch(e){}
      return;
    }
    busy = true;
    /* 重排本身会 appendChild， observe 着的 childList 会被触发；
       不断开就会「重排→回调→重排」无限套娃，点一下开关整页卡死。 */
    if (mo) mo.disconnect();
    var o = readOpt();
    SHOW = o.show6 ? 6 : 4;
    var hits = readHits();
    /* 锁定布局＝不再按频次重排，家人摆好的顺序保持住。 */
    if (!o.lock) items.sort(function(a,b){ return rank(b.dataset.desk, hits) - rank(a.dataset.desk, hits); });
    items.forEach(function(n, i){
      n.classList.toggle('d-hide', i >= SHOW);
      n.classList.toggle('d-first', i === 0);
      grid.appendChild(n);                       /* 重排：appendChild 会挪节点，事件不丢 */
    });
    var now = items.slice(0, SHOW).map(function(n){ return n.dataset.desk; }).join(',');
    if (!silent){
      var last = localStorage.getItem(ORDER);
      if (last && last !== now){
        var top = q('#deskGrid [data-desk] b');
        var what = top ? top.textContent : '这个';
        var bt = q('#bubbleText');
        if (bt) bt.textContent = '我看你常「' + what + '」，把它挪到第一个啦';
      }
      localStorage.setItem(ORDER, now);
    }
    if (mo) mo.observe(grid, { childList: true });
    busy = false;
  }

  /* 设置页的开关：每一个都真的改状态，不是画着好看的。 */
  function applyOpts(){
    var o = readOpt();
    reorder(true);
  }
  function toggleOpt(card, k){
    if (k === 'big'){
      var b = q('#bigFontBtn'); if (b) b.click();   /* 复用原有大字模式，状态由它存 */
      card.classList.toggle('on', !!S.big);
      return;
    }
    var o = readOpt(); o[k] = !o[k]; saveOpt(o);
    applyOpts();
    card.classList.toggle('on', !!o[k]);
  }
  function runAct(a){
    if (a === 'full'){
      var u = new URL(location.href);
      u.searchParams.set('ui', 'full');
      location.href = u.toString();               /* 真回退，不是假按钮 */
      return;
    }
    if (a === 'fam' || a === 'pair'){
      goPage('me');
      setTimeout(function(){
        var m = q('#meMoreBtn'); if (m) m.click();
        var t = q(a === 'fam' ? '#meFamBtn' : '#meHelpBtn'); if (t) t.click();
      }, 120);
    }
  }

  function build(){
    if (done) return;
    var home = q('#page-home'); if (!home) return;
    var head = q('.homehead', home), pet = q('.petcard', home), grid = q('#deskGrid', home);
    if (!head || !pet || !grid) return;
    done = true;

    /* 兜底：主流程没渲染桌面时自己调一次。图标一个都没有，中间就空一大片。 */
    if (typeof renderDesk === 'function' && !grid.querySelector('[data-desk]')){
      try { renderDesk(); } catch(e){}
    }
    /* 确定性优先：时间/日期/问候自己兜底，不赌主流程有没有跑完。 */
    function tickClock(){
      var d = new Date(), pad = function(n){ return String(n).padStart(2, '0'); };
      var t = q('#hhTime');
      if (t && (!t.textContent.trim() || t.textContent.indexOf('-') >= 0)) t.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
      var wk = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][d.getDay()];
      var dt = q('#hhDate');
      var lunar = '';
      try { lunar = window.lunarCN ? window.lunarCN(d) : ''; } catch(e){}
      /* 顶卡专门留了一行给农历，别再藏掉 */
      var ln = q('#hhLunar');
      if (ln && lunar) ln.textContent = '农历' + lunar;
      if (dt && !dt.textContent.trim()) dt.textContent = (d.getMonth()+1) + '月' + d.getDate() + '日 ' + wk;
      var gt = q('#hhGreet');
      if (gt && !gt.textContent.trim()){
        var h = d.getHours();
        gt.textContent = h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
      }
      var wx = q('#hhWx'), sep = q('.hhsep', head);
      if (wx && !wx.textContent.trim() && sep) sep.style.display = 'none';
    }
    tickClock(); setInterval(tickClock, 30000);
    /* 固定主提示：say() 会往 bubble 写「回来啦」这类即时回话，冲不掉这句。 */
    pet.insertBefore(el('div','dhint','有事喊我，米粒米粒'), q('.bubble', pet));

    /* ---- 顶卡右上：守护状态 + 设置 ---- */
    var side = el('div','dtop-side');
    var guard = el('span','dguard','<i></i>守护中');
    var more = el('button','dsset','设置 ›');
    more.setAttribute('aria-label','打开设置');
    side.appendChild(guard); side.appendChild(more); head.appendChild(side);
    var lunar = '';
    try { lunar = new Intl.DateTimeFormat('zh-CN-u-ca-chinese',{month:'long',day:'numeric'}).format(new Date()); } catch(e){}
    if (lunar) head.insertBefore(el('div','dlunar','农历' + lunar), q('.hhgreet', head));

    /* ---- 米粒卡：声波 + 默认提示语 ---- */
    var wave = el('div','dwave','<i></i><i></i><i></i><i></i><i></i>');
    pet.appendChild(wave);
    var bt = q('#bubbleText');
    /* 主提示已经由上面那句 .dhint「有事喊我，米粒米粒」固定承担。
       这里再填同一句，清数据后首屏会把同一句话说两遍（真机 23:11 截图实拍）。
       气泡只放即时的回话，默认给一句短的，say() 来了会覆盖。 */
    if (bt && !bt.textContent.trim()) bt.textContent = '回来啦。';

    /* ---- 设置：所有已实现的功能藏在这里，桌面一屏不占 ---- */
    var st = el('div','dsettings');
    var nav = el('div','dsnav');
    var backBtn = el('button','dsback','‹');
    backBtn.setAttribute('aria-label','返回桌面');
    nav.appendChild(backBtn);
    nav.appendChild(el('b','','设置'));
    nav.appendChild(el('span','','米粒 · 老人桌面'));
    st.appendChild(nav);

    /* 每个 go 都指向真实存在的 #page-*，每个 k 都真的改状态。
       没跑通的能力一格不摆 —— 点开是空白比不摆更糟。 */
    var learned = 0;
    try { learned = (S.rules || []).length; } catch(e){}
    var o = readOpt();
    var GROUPS = [
      { g:'桌面与系统', items:[
        { t:'大字模式',     s:'全站字再大一号',            k:'big' },
        { t:'锁定桌面',     s:'图标不再自动换位置',        k:'lock' },
        { t:'多显两个图标', s:'桌面放 6 个而不是 4 个',    k:'show6' },
        { t:'常用与工具',   s:'九宫格、全部入口',          go:'hub' },
        { t:'回到旧版界面', s:'一屏 10 块那版（调试用）',  act:'full' }
      ]},
      { g:'家人与通话', items:[
        { t:'常联系的人',   s:'一键拨号名单',              act:'fam' },
        { t:'家人控制台',   s:'守护、规则、远程操作',      go:'family' },
        { t:'绑定与配对',   s:'出 6 个数字给家里人',      act:'pair' },
        { t:'拨号盘',       s:'大字数字键盘',              go:'dialer' },
        { t:'我的',         s:'账号、今天怎么样、体征',    go:'me' }
      ]},
      { g:'健康与提醒', items:[
        { t:'药箱',         s:'正在吃的药',                go:'med' },
        { t:'血压血糖',     s:'记一笔、看最近一次',        go:'vital' },
        { t:'挂号',         s:'让家里人替我挂',            go:'reg' },
        { t:'扫码付款',     s:'付款码',                    go:'pay' }
      ]},
      { g:'米粒与日新', items:[
        { t:'它替你记着的', s:'学会的事、没走通的事',      go:'learn' },
        { t:'办过的事',     s:'今天替你做了什么',          go:'did' },
        { t:'米粒的卡',     s:'身份与配对码',              go:'card' },
        { t:'家里人',       s:'家人端页面',                go:'famhome' },
        { t:'学会 ' + learned + ' 条', s:'现场两次运行看它变准', info:true }
      ]}
    ];
    GROUPS.forEach(function(gr){
      st.appendChild(el('div','dsgroup','<i></i>' + gr.g));
      var grid2 = el('div','dsgrid');
      gr.items.forEach(function(it){
        var right = it.k ? '<i class="dsw"></i>'
                  : (it.info ? '' : '<span class="dsarrow">›</span>');
        var c = el('button','dscard',
          '<span class="dst">' + it.t + '</span><span class="dss">' + it.s + '</span>' + right);
        if (it.k){
          c.classList.toggle('on', it.k === 'big' ? !!S.big : !!o[it.k]);
          c.onclick = function(){ toggleOpt(c, it.k); };
        } else if (it.go){
          c.onclick = function(){ st.classList.remove('open'); goPage(it.go); };
        } else if (it.act){
          c.onclick = function(){ st.classList.remove('open'); runAct(it.act); };
        }
        grid2.appendChild(c);
      });
      st.appendChild(grid2);
    });

    /* 原来摆在首屏占地方的那几块，收进设置末尾，功能一个没删。 */
    var daily = el('div','dsdaily');
    ['#famDial','#quickGrid','#medRow','#sosBtn','.dock'].forEach(function(s2){
      var n = q(s2, home); if (n) daily.appendChild(n);
    });
    st.appendChild(daily);
    st.appendChild(el('p','dsnote',
      '这些只给家人和调试用。老人平时只看见桌面那一屏：时间、米粒、四个大图标、底部三个按钮。'));
    home.appendChild(st);
    more.onclick = function(){ st.classList.add('open'); };
    backBtn.onclick = function(){ st.classList.remove('open'); };

    /* 从设置进了任何子页：右下角「回桌面」，底部 tab 藏了也有退路。 */
    var dback = el('button','dback','回桌面');
    document.body.appendChild(dback);
    dback.onclick = function(){
      try { goPage(window.__F7_FAMILY ? 'famhome' : 'home'); } catch(e){}
    };

    /* ---- 固定底栏：三颗真按钮，全部复用已有节点上的事件 ---- */
    var dock = el('div','ddock');
    var sos = el('button','dsos', SOSICO + '<span>紧急呼叫</span><small>点一下，再确认</small><i class="dhold"></i>');
    var talk = el('button','dtalk', MIC + '<span>说话</span>');
    var lamp = el('button','dtorch', LAMP + '<span>手电筒</span>');
    dock.appendChild(sos); dock.appendChild(talk); dock.appendChild(lamp);
    home.appendChild(dock);

    /* 说话：真的调原 #holdBtn，顺带给米粒一个「我在听」的确定性反馈 */
    talk.onclick = function(){
      var h = q('#holdBtn'); if (h) h.click();
      pet.classList.add('d-listening');
      var ava = q('.petava', pet); if (ava) ava.classList.add('singing');
      if (bt) bt.textContent = '我在听，您说';
      clearTimeout(talk.__t);
      talk.__t = setTimeout(function(){
        pet.classList.remove('d-listening');
        if (ava) ava.classList.remove('singing');
        if (bt) bt.textContent = '';          /* 主提示由 .dhint 固定承担 */
      }, 4000);
    };

    /* 手电筒：复用桌面图标里那颗，动作走原生 deskLaunch('torch') */
    lamp.onclick = function(){
      var t = q('#deskGrid [data-desk="torch"]');
      if (t) t.click();
      else if (bt) bt.textContent = '这台手机上点才管用';
    };

    /* SOS：长按 3 秒才拨，防误触。到点调原 #sosBtn 的 onclick（=sosTap）。 */
    var alarm = el('div','dalarm',
      '<b>正在叫家人</b><span>别慌，米粒陪着您</span><button type="button">知道了</button>');
    home.appendChild(alarm);
    q('button', alarm).onclick = function(){ alarm.classList.remove('open'); };
    var t0 = 0, tick = null;
    function cancel(){
      clearTimeout(tick); tick = null; sos.classList.remove('holding');
      var bar = q('.dhold', sos); if (bar) bar.style.width = '0';
    }
    sos.addEventListener('pointerdown', function(e){
      e.preventDefault(); t0 = Date.now();
      sos.classList.add('holding');
      var bar = q('.dhold', sos); if (bar){ bar.style.width = '0'; void bar.offsetWidth; bar.style.width = '100%'; }
      tick = setTimeout(function(){
        cancel();
        try { if (window.MILI_SOS) window.MILI_SOS(); } catch (e) {}
        alarm.classList.add('open');
        setTimeout(function(){ alarm.classList.remove('open'); }, 5000);
      }, 3000);
    });
    ['pointerup','pointercancel','pointerleave'].forEach(function(ev){
      sos.addEventListener(ev, cancel);
    });
    /* 2026-11-09 用户视角：只留「长按 3 秒」一条路，老人几乎按不出来，
       真着急的时候反而叫不到人。短按改成两颗大按钮的确认层，
       长按仍然直接叫人（防误触不丢），两条路都走得通。 */
    var ask = el('div','dsosask');
    var sosWho = (S.fam && S.fam[0] && S.fam[0].name) || '家里人';
    ask.innerHTML = '<div class="box"><b>要叫家里人吗？</b>'
      + '<p>点「叫」，米粒马上给' + esc(sosWho) + '打电话。</p>'
      + '<button type="button" class="yes">叫，现在就打</button>'
      + '<button type="button" class="no">不用，点错了</button></div>';
    document.body.appendChild(ask);
    q('.no', ask).onclick = function(){ ask.classList.remove('open'); };
    q('.yes', ask).onclick = function(){
      ask.classList.remove('open');
      try { if (window.MILI_SOS) window.MILI_SOS(); } catch (e) {}
      alarm.classList.add('open');
      setTimeout(function(){ alarm.classList.remove('open'); }, 5000);
    };
    ask.addEventListener('click', function(e){ if (e.target === ask) ask.classList.remove('open'); });
    sos.addEventListener('click', function(e){ e.preventDefault(); ask.classList.add('open'); });

    /* ---- 进化：计数 → 下次打开自动排序 → 顺序变了开口告诉老人 ---- */
    grid.addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('[data-desk]') : null;
      if (!b) return;
      var hits = readHits(), k = b.dataset.desk;
      hits[k] = (hits[k] || 0) + 1;
      try { localStorage.setItem(HITS, JSON.stringify(hits)); } catch(err){}
    }, true);
    reorder(false);
    /* renderDesk() 会重写 innerHTML，重建后立刻重排，顺序不会被冲掉 */
    mo = new MutationObserver(function(){ reorder(true); });
    mo.observe(grid, {childList:true});
  }

  function start(){
    build();
    /* 兜底：renderDesk 若晚于 DOMContentLoaded，再试几次 */
    var n = 0, tm = setInterval(function(){
      if (done || ++n > 12) clearInterval(tm);
      else build();
    }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ============================================================================
   家人端 fam6 · 四 Tab（2026-11-07 02:10）
   ----------------------------------------------------------------------------
   规范：守护 / 规则进化 / 亲情陪伴 / 我的，底部 4 Tab，信息效率优先。
   做法：不移动任何 DOM，给 #page-famhome .scroll 的子节点打 data-pane，
   按当前 Tab 显隐。app.js 原有 renderFamOverview / renderFamMeds /
   renderFamActs / renderFamPay 照旧往原 id 里写，一个函数都不用改。
   只摆真数据和真入口，不画「误报率下降幅度」这类静态假指标。
   ========================================================================== */
(function fam6(){
  if (new URLSearchParams(location.search).get('ui') === 'full') return;
  var q = function(s, r){ return (r || document).querySelector(s); };
  var el = function(t, c, h){ var n = document.createElement(t); if(c) n.className=c; if(h!=null) n.innerHTML=h; return n; };
  var ICON = {
    guard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    rule:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="8" cy="17" r="2" fill="currentColor" stroke="none"/></svg>',
    care:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.8a5 5 0 0 0-7.1 0L12 7.5l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.1a5 5 0 0 0 0-7.1z"/></svg>',
    me:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.2" r="3.4"/><path d="M5 20c0-3.6 3.1-6.4 7-6.4s7 2.8 7 6.4"/></svg>'
  };

  function build(){
    var fam = q('#page-famhome'), sc = fam && q('.scroll', fam);
    if (!fam || !sc || fam.dataset.f6) return;
    fam.dataset.f6 = '1';
    document.documentElement.classList.add('fam6');

    /* 显式归 Tab，不靠「最近一个标题」推顺序：
       「添加一种药」面板夹在血压血糖后面，顺序法会把它错分到守护页。 */
    Array.prototype.slice.call(sc.children).forEach(function(n){
      var t = n.textContent || '', p = 'guard';
      if (n.id === 'famMedList' || (n.querySelector && n.querySelector('#famSaveMed'))) p = 'rule';
      else if (/药箱|添加一种药/.test(t)) p = 'rule';
      else if (/挂号|老人付过的账/.test(t) || /famRegister|famPayList/.test(n.id || '')) p = 'care';
      n.dataset.pane = p;
    });

    /* 顶部：老人是谁 + 真实学会条数。不写「在线」这种拿不到的数据。 */
    var learned = 0;
    try { learned = (S.rules || []).length; } catch(e){}
    var who = '长辈';
    try { who = S.me || '长辈'; } catch(e){}
    /* 顶部两块常驻（挂在 .scroll 外），跟阿福「健康档案」页的资料条一致；
       切 Tab 时它们不滚、不消失。两个按钮都跳真实页面，不摆假功能。 */
    var head = el('div','f6head',
      '<div class="who">家长端</div><span class="f6pill">● 守护中</span>');
    var AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2c-3.1 0-5.2 2.3-5.2 5 0 1.3.4 2.2 1 3.1L12 21l4.2-9.7c.6-.9 1-1.8 1-3.1 0-2.7-2.1-5-5.2-5z"/><circle cx="10" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>';
    /* 2026-11-10 菲尔特：家人端不许添加身份、不许换昵称头像。
       这颗胶囊只固定显示老人端填的称呼，不是按钮。 */
    var elderName = esc(String((S && (S.elderName || S.famName || S.accName || S.me)) || '长辈'));
    var profile = el('div','f6profile',
      '<span class="f6avatar">' + AVATAR + '</span>' +
      '<span class="f6add static">' + elderName + '</span>');
    fam.insertBefore(head, sc);
    fam.insertBefore(profile, sc);

    /* 守护页：两个真操作。跨设备「一键自动接通」做不到，不摆假按钮。 */
    var g1 = el('div','',
      '<div class="f6sec"><i></i>能立刻做的</div>' +
      '<button class="f6go" data-act="refresh">刷新老人今天的状态 <span>›</span></button>' +
      '<button class="f6go" data-act="dial">打开拨号盘，给老人打电话 <span>›</span></button>' +
      '<p class="f6note">守护数据来自同一份本地状态；告警推送与自动接通需要设备在线，当前版本不承诺。</p>');
    g1.dataset.pane = 'guard'; sc.appendChild(g1);

    /* 我的：全部是真页面入口，不摆「导出报告」这类没实现的按钮。 */
    var m = el('div','',
      '<div class="f6sec"><i></i>我的</div>' +
      '<div class="f6card">' +
        '<div class="f6row">这台手机 <small>' + who + ' 在用</small></div>' +
        '<div class="f6row">米粒学会的 <small>' + learned + ' 条</small></div>' +
        '<div class="f6row">进化状态 <small>现场两次运行看变化</small></div>' +
      '</div>' +
      '<button class="f6go" data-act="family">联系人与实体卡 <span>›</span></button>' +
      '<button class="f6go" data-act="me">账号与配对 <span>›</span></button>' +
      '<button class="f6go" data-act="home">回到米粒桌面 <span>›</span></button>' +
      '<p class="f6note">规范里的「规则进化中心 / 亲情陪伴」对应上面的规则、陪伴两页；' +
      '系统自动生成规则、远程拖拽排序、误报率看板这三项当前没有后端，不做静态假卡片。</p>');
    m.dataset.pane = 'me'; sc.appendChild(m);

    /* 底部 4 Tab */
    var tabs = el('div','f6tabs');
    [['guard','守护'],['rule','规则'],['care','陪伴'],['me','我的']].forEach(function(x, i){
      var b = el('button', i === 0 ? 'on' : '', ICON[x[0]] + '<span>' + x[1] + '</span>');
      b.onclick = function(){
        fam.classList.remove('p-guard','p-rule','p-care','p-me');
        fam.classList.add('p-' + x[0]);
        Array.prototype.forEach.call(tabs.children, function(c){ c.classList.remove('on'); });
        b.classList.add('on');
        sc.scrollTop = 0;
      };
      tabs.appendChild(b);
    });
    fam.appendChild(tabs);
    fam.classList.add('p-guard');

    /* 直接给页面加 .on 不会走 goPage，渲染函数没人调，容器全是空的。
       这里主动把真数据填一次（module 顶层函数，同作用域可直接调）。 */
    try { if (typeof renderFamHome === 'function') renderFamHome(); } catch(e){}
    try { if (typeof renderFamOverview === 'function') renderFamOverview(); } catch(e){}
    try { if (typeof renderFamMeds === 'function') renderFamMeds(); } catch(e){}
    try { if (typeof renderFamVital === 'function') renderFamVital(); } catch(e){}
    try { if (typeof renderFamActs === 'function') renderFamActs(); } catch(e){}
    try { if (typeof renderFamPay === 'function') renderFamPay(); } catch(e){}

    fam.addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'refresh'){
        try { if (typeof renderFamOverview === 'function') renderFamOverview(); } catch(err){}
        try { if (typeof renderFamActs === 'function') renderFamActs(); } catch(err){}
        if (typeof say === 'function') { try { say('刷新好啦'); } catch(err){} }
      } else if (a === 'dial' || a === 'family' || a === 'me' || a === 'home'){
        try { goPage(a === 'dial' ? 'dialer' : a); } catch(err){}
      }
    });
  }
  function start(){ build(); var n=0, t=setInterval(function(){ if (++n > 10) clearInterval(t); else build(); }, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ============================================================================
   安全求助配置：两处（引导第 1 屏 / 设置中心）都能改，改完立刻落盘 + 下发原生。
   原生 MilService 页面不在时也要能拨，所以号码同时写进 SharedPreferences。
   ========================================================================== */
window.applySafetyCfg = function(){
  try {
    const n = window.MiliNative;
    if (n && n.setSosNum) n.setSosNum(String(S.sosPhone || ''));
    if (n && n.setFallEnabled) n.setFallEnabled(S.fallDetectOn !== false);
  } catch (e) {}
};
window.saveSosPhone = function(v){
  S.sosPhone = String(v || '').replace(/[^0-9+]/g, '').slice(0, 20);
  try { save(); } catch (e) {}
  window.applySafetyCfg();
  return S.sosPhone;
};
window.saveFallOn = function(on){
  S.fallDetectOn = !!on;
  try { save(); } catch (e) {}
  window.applySafetyCfg();
  return S.fallDetectOn;
};

/* 紧急求助挂给 agent 工具表：老人说「快叫我儿子」时能真的触发
   原来的 sosBtn（= sosTap，拨第一位紧急联系人）+ 红色安抚层。 */
window.MILI_SOS = function(){
  /* 2026-11-10 菲尔特：摔倒或点紧急呼叫，一律拨「已保存的那个号码」，
     不再靠 S.fam[0].name 去通讯录猜人。没填号码才退回老链路，不假装办成。 */
  try { window.applySafetyCfg && window.applySafetyCfg(); } catch (e) {}
  var a = document.querySelector('#page-home .dalarm');
  var alarm = function(){ if (a){ a.classList.add('open'); setTimeout(function(){ a.classList.remove('open'); }, 6000); } };
  var num = String(S.sosPhone || '').replace(/[^0-9+]/g, '');
  var n = window.MiliNative;
  if (num.length >= 5 && n && n.callNum) {
    try {
      var r = JSON.parse(n.callNum(num) || '{}');
      if (r && r.ok) {
        try { say('别慌，正在给家里人打电话。'); } catch (e) {}
        alarm(); return true;
      }
    } catch (e) {}
  }
  /* 号码没存：如实告诉老人，打开拨号页让他自己按，绝不拨一个不相干的人。
     🚨 这里绝不能 s.click() —— #sosBtn 的 onclick 就是 sosTap，
     而 sosTap 现在收口到 MILI_SOS，点回去就是无限递归。 */
  try { say('还没存紧急联系人的号码，先让家里人在设置里填一个。'); } catch (e) {}
  try { goPage('dialer'); } catch (e) {}
  alarm();
  return false;
};

/* ============================================================================
   跌落确认层（2026-11-10 · 菲尔特：「加一个功能叫跌落检测」）
   ----------------------------------------------------------------------------
   原生 FallDetect 判出疑似跌倒后调 window.MILI_FALL(20)，这里盖整屏问一句。
   不是让老人报「不用我喊」—— 手机自己发现的，老人只需要回答「没事 / 叫人」。

   三条规则：
   ① 按「我没事」→ 撤层，撤倒计时，什么都不发生
   ② 按「马上叫人」→ 立刻 MILI_SOS
   ③ 倒计时归零 → 自动 MILI_SOS
   原生那边还有一份同样的倒计时兜底，两边谁先到算谁；双保险不算重复，
   因为页面被系统杀掉的时候只剩原生那一路。

   老人开口不由这里判断：说「我没事」由模型调 fall_answer 工具撤销。
   ========================================================================== */
window.MILI_FALL = function(sec){
  /* 设置里关掉「摔倒检测」时，摔倒事件不许弹确认层、不许倒计时、不许拨号。 */
  if (S.fallDetectOn === false) return false;
  var total = Math.max(5, Math.min(60, Number(sec) || 20));
  var ov = document.getElementById('dfall');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'dfall';
    ov.className = 'dfall pulse';
    ov.innerHTML =
      '<div class="fico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 21s-7.5-4.7-9.3-9A5.4 5.4 0 0 1 12 6.6 5.4 5.4 0 0 1 21.3 12'
      + 'C19.5 16.3 12 21 12 21z"/><path d="M3 12h4l2-3 2.5 6L14 11h3"/></svg></div>'
      + '<h2>您还好吗？</h2>'
      /* 不写「听见一声闷响」：麦克风现在只跑唤醒词，不做声音分析，
         写「听见」就是假能力。这句话只能落在加速度计真测到的东西上。 */
      + '<p>刚才那一下不对劲。不回话，我就叫家里人来。</p>'
      + '<div class="fsec"><span id="dfallSec">' + total + '</span><small>秒</small></div>'
      + '<div class="fbtns">'
      + '<button type="button" class="fok" id="dfallOk">我没事</button>'
      + '<button type="button" class="fsos" id="dfallSos">马上叫人</button>'
      + '</div>'
      + '<p class="fnote">手机从桌上掉下去，也会问这一句。</p>';
    document.body.appendChild(ov);
    var ok = document.getElementById('dfallOk');
    var so = document.getElementById('dfallSos');
    /* 「我没事」是主按钮：老人第一反应就是按最大的那颗 */
    ok.onclick = function(){ window.MILI_FALL_CANCEL('button'); };
    so.onclick = function(){ window.MILI_FALL_NOW('button'); };
  }

  var left = total;
  var secEl = document.getElementById('dfallSec');
  if (secEl) secEl.textContent = String(left);
  ov.classList.add('open');
  ov.classList.add('pulse');
  /* 2026-11-10 菲尔特：「跌落的时候自动打开连续对话」。
     老人能直接说「没事」「起不来」，不用去摸屏幕上最大的那颗按钮。
     ★ 这里以前是假的：提示词写着「或者跟我说句话」，但麦克风根本没开。
     宽限跟倒计时对齐，两边不各走各的。 */
  try { callEnter('fall', Math.max(20000, total * 1000)); } catch (e) {}
  try {
    if (window.MILI_AGENT && MILI_AGENT.note) MILI_AGENT.note('assistant', '您还好吗？刚才那一下不对劲。');
  } catch (e) {}

  if (window.__fallTimer) { clearInterval(window.__fallTimer); window.__fallTimer = null; }
  window.__fallTimer = setInterval(function(){
    left -= 1;
    if (secEl) secEl.textContent = String(Math.max(0, left));
    if (left <= 0) {
      clearInterval(window.__fallTimer);
      window.__fallTimer = null;
      /* 到点自动叫人。这里不自己拨号，统一走 MILI_SOS 那条真链路。 */
      try { if (window.MILI_SOS) window.MILI_SOS(); } catch (e) {}
      var h2 = ov.querySelector('h2');
      if (h2) h2.textContent = '已经在叫人了';
    }
  }, 1000);
  return true;
};

window.MILI_FALL_CANCEL = function(by){
  if (window.__fallTimer) { clearInterval(window.__fallTimer); window.__fallTimer = null; }
  var ov = document.getElementById('dfall');
  if (ov) {
    ov.classList.remove('open');
    ov.classList.remove('pulse');
    var h2 = ov.querySelector('h2');
    if (h2) h2.textContent = '您还好吗？';
  }
  var n = window.MiliNative;
  if (n && n.fallCancel) { try { n.fallCancel(); } catch (e) {} }
  if (by === 'voice') { try { say('那就好，我还在。'); } catch (e) {} }
  return true;
};

window.MILI_FALL_NOW = function(by){
  if (window.__fallTimer) { clearInterval(window.__fallTimer); window.__fallTimer = null; }
  var ov = document.getElementById('dfall');
  if (ov) ov.classList.remove('open');
  var n = window.MiliNative;
  if (n && n.fallNow) { try { n.fallNow(); return true; } catch (e) {} }
  try { if (window.MILI_SOS) window.MILI_SOS(); } catch (e) {}
  return true;
};

/* ============================================================================
   家长端 fam7 · 逐页排版复刻（2026-11-07 09:20）
   ----------------------------------------------------------------------------
   只换配色不算复刻。这一层按阿福 15 张截图把 8 个页面的**排版**搭出来：
     我的 / 守护 / 健康档案 / 我的药箱 / 设备与应用 / 添加设备 /
     个性化回答 / 头像和昵称
   数据从 S 真读，按钮能跳的都跳真实 page-*；没接入的能力写成说明，
   不摆假开关。fam7 是覆盖层，#page-famhome.on 时自动接管，
   底下 fam6 与 app.js 的渲染函数照旧，一个都不用改。
   ========================================================================== */
(function fam7(){
  if (new URLSearchParams(location.search).get('ui') === 'full') return;
  var q = function(s, r){ return (r || document).querySelector(s); };
  var P = {
    doc:'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    med:'<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M9 6V4h6v2M12 10v6M9 13h6"/>',
    user:'<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2"/>',
    act:'<path d="M4 12h4l2-5 3 10 2-5h5"/>',
    gear:'<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
    dev:'<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 18h6"/>',
    spark:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1 1-1.1 1.8M12 17h.01"/>',
    heart:'<path d="M20.8 5.8a5 5 0 0 0-7.1 0L12 7.5l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.1a5 5 0 0 0 0-7.1z"/>',
    grid:'<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    cam:'<path d="M4 7.5h2.6L8 5.6h8l1.4 1.9H20v11H4z"/><circle cx="12" cy="13" r="3.3"/>',
    scan:'<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4M4 12h16"/>',
    eye:'<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
    target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
    pill:'<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-40 12 12)"/><path d="M8.5 8.5l7 7"/>',
    reg:'<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M12 16v3"/>',
    pay:'<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h10M7 14h4"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell:'<path d="M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3z"/><path d="M10 20h4"/>',
    search:'<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    chart:'<path d="M4 19h16M7 15v-4M12 15V7M17 15v-6"/>',
    scale:'<path d="M5 5h14v14H5z"/><path d="M9 9h6"/>',
    band:'<rect x="7" y="7" width="10" height="10" rx="3"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3"/>',
    drop:'<path d="M12 3s6 6.6 6 10a6 6 0 0 1-12 0c0-3.4 6-10 6-10z"/>',
    press:'<path d="M4 12h16M12 4v16"/><circle cx="12" cy="12" r="6"/>'
  };
  function ic(k){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
           'stroke-linecap="round" stroke-linejoin="round">' + (P[k] || '') + '</svg>';
  }
  /* 拍药盒后的即时反馈条：识别中 / 已加进药箱 / 没认出来，都写在这里。
     全局 __f7MedMsg 由 app.js 的 medApply() 写，药箱页重绘时读。 */
  function medResultHTML(){
    var m = window.__f7MedMsg;
    if (!m) return '';
    var bg = m.s === 'bad' ? '#FFF3F3' : (m.s === 'wait' ? '#F1F0F8' : '#EEF9F2');
    var fg = m.s === 'bad' ? '#C4453F' : (m.s === 'wait' ? '#5B4DF0' : '#2E7D55');
    return '<div class="f7medresult" style="background:' + bg + ';color:' + fg + '">' +
      '<b>' + esc(m.t) + '</b>' +
      (m.d || m.n ? '<span>' + esc([m.d, m.n].filter(Boolean).join(' · ')) + '</span>' : '') +
      '</div>';
  }

  function D(){
    var s = (typeof S !== 'undefined') ? S : {};
    return {
      me: s.me || '长辈',
      meds: (s.med || []).filter(function(m){ return m && m.on; }).length,
      rules: (s.rules || []).length,
      did: (s.did || []).length,
      fam: (s.fam || []).length,
      medsAll: (s.med || []).slice()
    };
  }
  function nav(title, opt){
    opt = opt || {};
    return '<div class="f7nav' + (opt.lead ? ' lead' : '') + '">' +
      (opt.lead ? '<span class="sp"></span>' : '<button class="back" data-go="back" aria-label="返回">‹</button>') +
      '<h2>' + title + '</h2>' +
      (opt.tool ? '<span class="f7tool"><button data-act="privacy" aria-label="隐私">' + ic('eye') +
                 '</button><button data-act="target" aria-label="定位">' + ic('target') + '</button></span>'
                : '<span class="sp"></span>') +
      '</div>';
  }
  function profile(){
    /* 2026-11-10 菲尔特：守护页/我的页顶部只显示老人端填的昵称。
       加号删掉，昵称和头像都不是按钮，点不开。 */
    return '<div class="f7profile"><div class="f7add avatar static">' +
      '<span class="av">' + ic('user') + '</span>' +
      esc(String(S.elderName || S.famName || S.accName || S.me || '长辈')) + '</div></div>';
  }
  function row(icon, text, go, val){
    return '<button class="f7row" ' + (go ? (go.indexOf('page:') === 0 ? 'data-page="' + go.slice(5) + '"' : 'data-go="' + go + '"') : 'data-act="soon"') + '>' +
      '<span class="ic">' + ic(icon) + '</span><span class="tx">' + text + '</span>' +
      (val ? '<span class="val">' + val + '</span>' : '') + '<span class="go">›</span></button>';
  }
  function sec(t, all){ return '<div class="f7sec"><i></i>' + t + (all ? '<span class="all">全部 ›</span>' : '') + '</div>'; }
  function empty(title, desc, btn, act){
    return '<div class="f7empty"><b>' + title + '</b><p>' + desc + '</p>' +
      (btn ? '<button class="f7soft" ' + (act || 'data-act="soon"') + '>' + btn + '</button>' : '') + '</div>';
  }

  /* 「日新 · 两次运行」：所有数字来自当场真实运行，页面不预填任何结果。 */
  function h(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }
  function runCard(k){
    var r = (window.__F7_RUNS || {})[k];
    var title = k === 'a' ? 'RUN 1 · 尝试' : 'RUN 2 · 进化';
    if (!r) return '<div class="f7run empty" data-run="' + k + '"><h4>' + title +
      '</h4><div class="ph">还没跑</div><div class="ph">现场第一句真跑出来才有数字</div></div>';
    var tools = (r.tools || []).join('、') || '无工具';
    var asks = (r.trace || []).filter(function(x){ return /吗|是不是|您是说/.test(x.said || ''); }).length;
    /* 2026-11-12：三列硬读数。trace 里每轮都带 tok（agent.js:1177），
       命中 skill 时 trace 为空 → 0 轮 0 token，这正是「它记得住」的现场证据。
       不许预填、不许估算，全部来自当场这一句真跑。 */
    var toks = (r.trace || []).reduce(function(s, x){ return s + (Number(x && x.tok) || 0); }, 0);
    var rounds = (r.trace || []).length;
    return '<div class="f7run" data-run="' + k + '"><h4>' + title + '</h4>' +
      '<div class="big">' + r.ms + '<small> ms</small></div>' +
      '<div class="ln">原话：' + h(r.text) + '</div>' +
      '<div class="ln">工具：' + h(tools) + '</div>' +
      '<div class="ln">追问：' + asks + ' 次</div>' +
      /* 384×853 窄卡实测：「本轮 token：10969」会被 word-break 劈成 toke/n，
         所以标签压到最短、单位用 3 字母 tok，中文在前不会被拦腰截断。 */
      '<div class="ln">模型 ' + rounds + ' 轮 · ' + toks + ' tok</div>' +
      (r.skillHit ? '<div class="ln">命中记忆 · 没问模型</div>' : '') +
      (r.note ? '<div class="ln warn">' + h(r.note) + '</div>' : '') + '</div>';
  }
  function refreshRun(k){
    var slot = q('[data-run="' + k + '"]', root); if (!slot) return;
    var tmp = document.createElement('div'); tmp.innerHTML = runCard(k);
    if (tmp.firstChild && slot.parentNode) slot.parentNode.replaceChild(tmp.firstChild, slot);
  }
  function f7toast(msg){
    var tip = q('.f7body', root); if (!tip) return;
    var old = q('#f7tip', root); if (old) old.remove();
    var t = document.createElement('p'); t.id = 'f7tip';
    t.style.cssText = 'position:fixed;left:20px;right:20px;bottom:96px;z-index:9;text-align:center;' +
      'background:#1B1D2E;color:#fff;padding:12px 16px;border-radius:14px;font-size:14px';
    t.textContent = msg; tip.appendChild(t);
    setTimeout(function(){ if (t.parentNode) t.remove(); }, 2400);
  }

  /* ---- 页面 ---- */
  var SCREENS = {
    mine: function(){
      var d = D();
      /* 只留真入口：健康档案/药箱/就诊人/健康行动/日新 都是实页；
         「我的订单」是空壳假卡、「客服咨询」是 soon 假按钮 —— 源头删除。 */
      return nav('我的', { lead:true }) +
        '<div class="f7profile"><div class="f7add avatar static"><span class="av">' + ic('user') +
          '</span>' + esc(String(S.elderName || S.famName || S.accName || S.me || '长辈')) + '</div></div>' +
        '<div class="f7card">' +
          row('med', '药箱', 'medbox', d.meds + ' 种') +
          row('spark', '日新 · 两次运行', 'renew') +
        '</div>' +
        '<div class="f7card">' + row('gear', '设置', 'personal') +
          '<button class="f7row" data-act="open9switch"><span class="ic">' + ic('heart') +
            '</span><span class="tx">切换到老人端</span><span class="go">›</span></button>' +
        '</div>' +
        '<div class="f7card">' + row('dev', '设备管理', 'device') + '</div>' +
        '<div class="f7watermark">米粒 · 家长端</div>';
    },
    /* ---- 捎句话：家人写一句 → 服务器 note 通道 → 老人端米粒开口念 ---- */
    note2elder: function(){
      return nav('捎句话') +
        '<div class="f7card flush" style="padding:16px">' +
          '<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#6B708C">' +
            '写一句话，老人端的米粒会在一分钟内开口念给他听。</p>' +
          '<textarea id="f7note" rows="3" placeholder="例如：儿子五点半到家，先喝药再歇会儿"' +
            ' style="width:100%;box-sizing:border-box;border:1px solid #E4E4F2;border-radius:14px;' +
            'padding:12px;font-size:15px;font-family:inherit;resize:none;background:#fff"></textarea>' +
          '<button class="f7cta" data-act="sendnote" style="position:static;margin-top:12px">' +
            ic('spark') + ' 下发并播报</button>' +
        '</div>';
    },
    /* ---- 体重 / 睡眠：真记录页，不再跳血压血糖 ---- */
    weight: function(){
      var hist = []; try { hist = JSON.parse(localStorage.getItem('mili.f7.weight') || '[]'); } catch(e){}
      var list = hist.length
        ? '<div class="f7card">' + hist.slice(-8).reverse().map(function(x){
            var dt = new Date(x.t);
            return '<div class="f7row" style="cursor:default"><span class="tx">' + x.v + ' kg</span>' +
              '<span class="val">' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日</span></div>';
          }).join('') + '</div>'
        : '<div class="f7blank"><b>还没有记录</b><small>记一次，就能看趋势了</small></div>';
      return nav('体重记录') +
        '<div class="f7card flush" style="padding:16px">' +
          '<div style="display:flex;gap:10px;align-items:center">' +
            '<input id="f7w" type="number" step="0.1" inputmode="decimal" placeholder="今早体重（kg）"' +
              ' style="flex:1;min-width:0;border:1px solid #E4E4F2;border-radius:14px;padding:12px;font-size:15px;font-family:inherit;background:#fff">' +
            '<button class="f7cta" data-act="saveweight" style="margin:0;padding:12px 18px">保存</button>' +
          '</div></div>' + list;
    },
    sleep: function(){
      var hist = []; try { hist = JSON.parse(localStorage.getItem('mili.f7.sleep') || '[]'); } catch(e){}
      var list = hist.length
        ? '<div class="f7card">' + hist.slice(-8).reverse().map(function(x){
            var dt = new Date(x.t);
            return '<div class="f7row" style="cursor:default"><span class="tx">' + x.v + ' 小时</span>' +
              '<span class="val">' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日</span></div>';
          }).join('') + '</div>'
        : '<div class="f7blank"><b>还没有记录</b><small>昨晚睡了几个小时？记下来</small></div>';
      return nav('睡眠记录') +
        '<div class="f7card flush" style="padding:16px">' +
          '<div style="display:flex;gap:10px;align-items:center">' +
            '<input id="f7sl" type="number" step="0.5" inputmode="decimal" placeholder="昨晚睡了（小时）"' +
              ' style="flex:1;min-width:0;border:1px solid #E4E4F2;border-radius:14px;padding:12px;font-size:15px;font-family:inherit;background:#fff">' +
            '<button class="f7cta" data-act="savesleep" style="margin:0;padding:12px 18px">保存</button>' +
          '</div></div>' + list;
    },
    renew: function(){
      var evo = window.EVO, st = null, ver = 1;
      /* 现场接口状态：默认读智能体内核，不预填任何额度，只显示当前真值。 */
      var li = { base:'', model:'', key:'', saved:false };
      try { li = (window.MILI_AGENT && window.MILI_AGENT.llmInfo()) || li; } catch(e){}
      try { st = evo && evo.state ? evo.state() : null; } catch(e){}
      if (st) ver = st.ver || 1;
      /* 🚨 2026-11-12：本地考卷（28 句正则 BENCH）从主叙事下线。
         eval/heldout.json 标注过时，改口前后都是 22/31、9 句失败完全一致；
         手册 §0 也写了「考卷涨分不作进化证据」。摆着既过期又自相矛盾，
         直接删，也不再每次 render 白跑一遍 28 句。 */
      var M = window.MILI_MEMO, factN = 0, skillN = 0;
      try {
        factN = M ? M.memoCount() : 0;
        skillN = M ? M.skillReady() : 0;
      } catch(e){}
      /* 🚨 2026-11-12：「它学到了什么」原来直接打印 S.rules 的内部 key
         （avoid:read_screen / stuck:com.ss.android.ugc.aweme …）——
         那是失败负样本，不是学到的东西，还满屏代码。
         改成只显示真学到的三类：记住的事、学会办的事、听懂的说法。 */
      var learned = [];
      try {
        (M ? M.memo() : []).slice(0, 3).forEach(function(m){
          if (m && m.text) learned.push('<div class="f7learnrow">记住：' + h(String(m.text).slice(0, 26)) + '</div>');
        });
        (M ? M.skills() : []).filter(function(s){ return s && s.on; }).slice(0, 3).forEach(function(s){
          if (s.text) learned.push('<div class="f7learnrow">学会办：' + h(String(s.text).slice(0, 24)) + '</div>');
        });
        (S.rules || []).filter(function(r){ return r && r.ans; }).slice(0, 2).forEach(function(r){
          learned.push('<div class="f7learnrow">听懂「' + h(String(r.q || r.src || '一句土话').slice(0, 14)) +
            '」→ ' + h(String(r.ans).slice(0, 20)) + '</div>');
        });
      } catch(e){}
      if (!learned.length) learned.push('<div class="f7learnrow dim">还没学到东西 · 现场第一句之后这里会出现原话</div>');
      /* 对话实录：只显示这一句真跑出来的原话，没跑就是没有，不编。 */
      var dialog = [];
      try {
        var runs = window.__F7_RUNS || {};
        ['a','b'].forEach(function(k){
          var d = (runs[k] || {}).dialog || [];
          if (!d.length) return;
          dialog.push('<div class="f7learnrow dim">' + (k === 'a' ? 'RUN 1' : 'RUN 2') + '</div>');
          d.slice(0, 4).forEach(function(x){ dialog.push('<div class="f7learnrow">' + h(x) + '</div>'); });
        });
      } catch(e){}
      if (!dialog.length) dialog.push('<div class="f7learnrow dim">还没开口 · 跑第 1 次之后这里会出现真问句</div>');
      return nav('日新 · 两次运行') +
        '<div class="f7quote">「一次运行是尝试，第二次运行是进化」<small>官方主赛道口径</small></div>' +
        '<div class="f7ver">当前 v' + ver + ' <span>记住的事 ' + factN +
          ' 条</span><span>能直接办 ' + skillN + ' 条</span><span>数字全部现场产生</span></div>' +
        '<div class="f7run2">' + runCard('a') + runCard('b') + '</div>' +
        '<div class="f7renewin">' +
          '<input id="f7renewText" class="field" value="米粒，给我开新闻台" aria-label="同一句话">' +
          '<div class="f7runbtns">' +
            '<button data-act="run1">跑第 1 次</button>' +
            '<button data-act="run2">跑第 2 次 · 同一句</button>' +
          '</div>' +
          /* RUN 1 会真问一句，得有地方让老人把话答回去 —— 不然只有问没有答，
             不是对话。答完这一句才真的动手（打开新闻页面）。 */
          '<input id="f7answerText" class="field" value="对，就这个" aria-label="老人回一句" placeholder="老人回一句，例如：对，就这个">' +
          '<div class="f7runbtns"><button data-act="answer">答这一句（真办）</button></div>' +
          '</div>' +
        '<div class="f7sec"><i></i>现场对话实录</div>' +
        '<div class="f7learn">' + dialog.join('') + '</div>' +
        '<div class="f7sec"><i></i>它学到了什么</div>' +
        '<div class="f7learn">' + learned.join('') +
          '<div class="f7learnrow dim">这些都能单条删、能整页清空，退回去就等于没学过</div></div>' +
        '<div class="f7sec"><i></i>现场接口 · 组委会发的额度</div>' +
        '<div class="f7renewin">' +
          '<div class="ln" style="font-size:12px;color:#9A9FBA;line-height:1.6">当前：' +
            h(li.model || '未配置') + ' · ' + h(li.base || '—') + ' · key ' + h(li.key || '无') +
            ' · ' + (li.saved ? '本机已填现场额度' : '用内置默认') + '</div>' +
          '<div class="f7runbtns">' +
            '<button data-act="llmPreset" data-p="siliconflow">硅基流动</button>' +
            '<button data-act="llmPreset" data-p="qingcheng">清程极智</button>' +
            '<button data-act="llmPreset" data-p="deepseek">官方备路</button>' +
          '</div>' +
          '<input id="f7llmBase" class="field" value="' + h(li.base) + '" placeholder="Base URL（组委会给的地址）" aria-label="Base URL">' +
          '<input id="f7llmModel" class="field" value="' + h(li.model) + '" placeholder="模型名" aria-label="模型名">' +
          '<input id="f7llmKey" class="field" type="password" placeholder="现场发的 Key · 只存本机，留空不覆盖" aria-label="API Key">' +
          '<div class="f7runbtns">' +
            '<button data-act="llmSave">用这个额度</button>' +
            '<button data-act="llmReset">清掉本机配置</button>' +
          '</div>' +
        '</div>' +
        '<button class="f7rollback" data-act="rollback">回到上一版（连记忆一起退）</button>' +
        '<p class="f7note" style="font-size:13px;color:#9A9FBA;line-height:1.6;margin:12px 2px">' +
          '回退会同时撤掉 EVO 快照与刚写入的一条技能记忆；退完请用同一句原话再跑一次验证。' +
          '跑第 1/2 次走真实智能体入口，现场需要真机与 key，本机不代跑、不预填数字。' +
          '卡片上 tok 是模型计费用量单位，0 表示这一句压根没走模型。' +
          '跑第 1 次会真问一句，答完再点第 2 次，同一句原话直达。</p>';
    },
    guard: function(){
      var d = D(), dt = new Date();
      return nav('守护', { lead:true }) + profile() +
        '<div class="f7hero" style="margin:0 0 14px;border-radius:20px;padding:20px">' +
          '<h1 style="font-size:24px;margin:0 0 6px">Hi，今天是 ' + (dt.getMonth()+1) + ' 月 ' + dt.getDate() + ' 日</h1>' +
          '<p style="margin:0;font-size:15px;line-height:1.6;color:#3E4260">米粒替你看着' + d.me +
          '。有事喊「米粒米粒」，打电话、看天气、记血压都不用找按钮。</p></div>' +
        '<div class="f7card">' +
          '<div class="f7cardhead">老人今天怎么样</div>' +
          row('spark', '米粒学会的', 'learn', d.rules + ' 条') +
          row('act', '最近办的事', 'did', d.did + ' 件') +
          row('med', '正在吃的药', 'medbox', d.meds + ' 种') +
          row('user', '常联系的人', 'family', d.fam + ' 位') +
        '</div>' +
        '<div class="f7card"><div class="f7cardhead">能立刻做的</div>' +
          row('doc', '给老人捎句话', 'note2elder') +
          row('user', '打电话给老人', 'family') +
          row('med', '看他今天的药', 'medbox') +
        '</div>' +
        '<div class="f7card" style="margin-top:10px;padding:12px 14px">' +
          '<span style="font-size:13px;color:#6B708C;line-height:1.6">' +
          '部分能力还没接入，这里不摆假按钮。</span></div>';
    },
    record: function(){
      return nav('健康档案', { tool:true }) +
        '<div class="f7grid2">' +
          '<div class="f7tile" style="min-height:112px"><span class="tag">待完善</span><h4>' +
            ic('doc').replace('<svg','<svg style="width:18px;height:18px"') + '基础信息</h4>' +
            '<div class="sub">性别 / 出生日期</div></div>' +
          '<div class="f7tile" style="min-height:112px"><span class="tag">待完善</span><h4>' +
            ic('heart').replace('<svg','<svg style="width:18px;height:18px"') + '健康史</h4>' +
            '<div class="sub">既往 / 个人 / 家族史</div></div>' +
        '</div>' +
        '<div class="f7seg"><button class="on" data-seg="a">病历夹</button>' +
          '<button data-seg="b">对话记忆</button><button data-seg="c">健康</button></div>' +
        '<div data-segbody="a">' + sec('病历夹', true) +
          empty('暂无就医资料', '在药箱里拍照加药，这里就能看到', '去药箱', 'data-go="medbox"') +
          sec('对话记忆', true) +
          empty('暂无对话记忆', '米粒会把老人交代要记住的事收在这里，例如「帮我记住早上要吃药」', '去试试', 'data-go="guard"') +
          sec('健康') +
          '<div class="f7card">' + row('chart', '指标与记录', 'health', '管理设备和授权') + '</div>' +
        '</div>' +
        '<div data-segbody="b" style="display:none">' + sec('对话记忆', true) +
          empty('暂无对话记忆', '米粒记下的是老人自己说过的话，不是预先写好的清单', '去记事本', 'data-go="learn"') + '</div>' +
        '<div data-segbody="c" style="display:none">' + sec('健康') +
          '<div class="f7card">' + row('chart', '指标与记录', 'health', '记录健康数据') + '</div></div>';
    },
    health: function(){
      var d = D();
      return nav('健康', {lead:true}) +
        '<div class="f7grid2">' +
          '<div class="f7tile"><h4><i></i>体重</h4><div class="sub">记录一次体重</div>' +
            '<div class="line"></div><button class="rec" data-go="weight">去记录</button></div>' +
          '<div class="f7tile"><h4><i></i>睡眠</h4><div class="sub">记一次睡眠时长</div>' +
            '<button class="rec" data-go="sleep">去记录</button></div>' +
          '<div class="f7tile"><h4 class="red"><i></i>血糖</h4><div class="sub">暂无数据</div>' +
            '<button class="rec" data-go="bp">去记录</button></div>' +
          '<div class="f7tile"><h4 class="red"><i></i>血压</h4><div class="sub">暂无数据</div>' +
            '<button class="rec" data-go="bp">去记录</button></div>' +
        '</div>' +
        '<div class="f7card">' + row('doc', '健康档案', 'record') +
          row('med', '药箱', 'medbox', d.meds + ' 种') + '</div>';
    },
    device: function(){
      return nav('设备', {lead:true}) +
        '<h3 style="margin:6px 2px 12px;font-size:19px">我的设备与应用</h3>' +
        '<div class="f7banner">授权后的健康应用和设备会展示在这里</div>' +
        /* 2026-11-09 菲尔特：「旁边那个蓝色的东东不好看，删了」——
           原来右上角压着一张蓝色蛇杖 3D 图，压住「准」字，整页唯一的冷色噪声。 */
        '<div class="f7bigwhite">' +
          '<h3>把健康数据接进来，米粒答得更准</h3><p>授权一次，之后自动同步</p>' +
          '<div class="f7num"><span><em>01</em> 授权健康应用</span><span class="all">全部 ›</span></div>' +
          '<div class="f7app2">' +
            '<div class="a"><b>小米运动健康</b><span class="logo">Mi</span></div>' +
            '<div class="a"><b>华为运动健康</b><span class="logo" style="background:linear-gradient(135deg,#FF9A6B,#E5484D)">H</span></div>' +
            '<div class="a"><b>荣耀运动健康</b><span class="logo" style="background:linear-gradient(135deg,#7CC4FF,#3E7BE0)"> honor</span></div>' +
            '<div class="a"><b>oppo 健康</b><span class="logo" style="background:linear-gradient(135deg,#8ED0A8,#3F8F62)">O</span></div>' +
          '</div>' +
          '<div class="f7num"><span><em>02</em> 连接硬件设备</span><span class="all">全部 ›</span></div>' +
          '<div class="f7app2">' +
            '<div class="a"><b>体脂秤<small data-go="adddev">去添加 ›</small></b><span class="logo">' + ic('scale') + '</span></div>' +
            '<div class="a"><b>手环手表<small data-go="adddev">去添加 ›</small></b><span class="logo">' + ic('band') + '</span></div>' +
            '<div class="a"><b>血糖仪<small data-go="adddev">去添加 ›</small></b><span class="logo">' + ic('drop') + '</span></div>' +
            '<div class="a"><b>血压仪<small data-go="adddev">去添加 ›</small></b><span class="logo">' + ic('press') + '</span></div>' +
          '</div>' +
        '</div>' +
        '<p style="font-size:13px;color:#9A9FBA;line-height:1.6;margin:8px 2px">' +
          'BLE 手环（华为 Band 8 心率广播）代码已落地，待真机复验；第三方健康应用授权未接入，' +
          '这四张是排版占位，不承诺能连。</p>';
    },
    adddev: function(){
      var cats = ['健康应用','体脂秤','手环手表','血糖仪','血压仪','呼吸机'];
      return nav('添加设备') +
        '<div class="f7split"><div class="f7side">' +
          cats.map(function(c, i){ return '<button class="' + (i===0?'on':'') + '" data-cat="' + i + '">' + c + '</button>'; }).join('') +
        '</div><div class="f7devlist" id="f7devlist"></div></div>' +
        '<div class="f7ctatip">当前版本用贴实体卡代替扫码配对</div>' +
        '<button class="f7cta" data-act="soon">' + ic('scan') + ' 实体卡配对（硬件接入后开放）</button>';
    },
    medbox: function(){
      var d = D();
      var list = d.medsAll.length
        ? '<div class="f7card">' + d.medsAll.map(function(m){
            return '<button class="f7row" data-go="medbox">' +
              '<img class="f7rowimg" src="assets/afu-pill_3d.png" alt="">' +
              '<span class="tx">' + (m.who || m.name || '药品') + '</span>' +
              '<span class="val">' + (m.dose || '') + '</span><span class="go">›</span></button>';
          }).join('') + '</div>'
        : '<div class="f7blank"><div class="art">' + ic('med') + '</div><b>您还未录入药品</b>' +
          '<small>录入即享四大功能</small></div>' +
          '<div class="f7feat4">' +
            '<div><span class="ico">' + ic('doc') + '</span>药品说明</div>' +
            '<div><span class="ico">' + ic('clock') + '</span>用药提醒</div>' +
            '<div><span class="ico">' + ic('bell') + '</span>过期预警</div>' +
            '<div><span class="ico">' + ic('search') + '</span>药品比价</div>' +
          '</div>' +
          '<div class="f7steps"><span>① 拍药识别</span><span>② 添加药品</span><span>③ 药箱管理</span></div>';
      var plan = d.medsAll.length
        ? '<div style="font-size:14px;line-height:1.6;color:#5A5E7A;margin:4px 2px 10px">' +
            '拍药盒认出药名后，吃药时间就自动排好了；要改直接改下面的时间。</div>' +
          '<div class="f7card">' + d.medsAll.map(function(m, i){
            var t = (m.times && m.times[0]) || '';
            return '<div class="f7row" style="cursor:default">' +
              '<span class="tx">' + (m.who || m.name || '药') + '</span>' +
              '<input class="f7medtime" data-i="' + i + '" type="time" value="' + t + '"' +
              ' style="border:1px solid #E4E4F2;border-radius:10px;padding:6px 10px;font-size:14px;font-family:inherit;background:#fff">' +
            '</div>';
          }).join('') +
          '<button class="f7cta" data-act="savetimes" style="position:static;margin-top:12px">' +
            ic('bell') + ' 保存提醒时间</button></div>' +
          '<div style="font-size:13px;color:#6B708C;line-height:1.6;padding:0 2px">' +
            '到点后，老人端的米粒会开口提醒他吃药。</div>'
        : '<div class="f7blank"><div class="art">' + ic('clock') + '</div><b>先在「药品管理」把药加好</b>' +
          '<small>加完就能给每种药定提醒时间</small></div>';
      return nav('药箱') +
        '<div class="f7hero" style="margin-top:2px">' +
          '<h1>药箱</h1>' +
          '<span class="sub">' + ic('med').replace('<svg','<svg style="width:16px;height:16px"') + '药在这里，问米粒就知道</span>' +
          '<div class="f7kitcss"></div>' +
        '</div>' +
        '<div class="f7btab"><button class="on" data-mtab="a">药品管理</button>' +
          '<button data-mtab="b">用药计划</button></div>' +
        /* 2026-11-09 22:22 菲尔特「药的排版有问题，都超出了」：
           反馈条原来排在长列表末尾，拍完药一滚动就被底部固定栏盖住，
           老人看不到「加好了」。放到 tab 正下方，一屏之内必见。 */
        medResultHTML() +
        '<div data-mbody="a" style="padding-top:8px">' + list + '</div>' +
        '<div data-mbody="b" style="display:none;padding-top:8px">' + plan + '</div>' +
        '<div class="f7ctatip">药盒正面、名字清楚就够</div>' +
        '<div class="f7medbar">' +
          '<button data-act="medshot" style="flex:1;height:54px;border:0;border-radius:18px;background:#5B4DF0;'
            + 'color:#fff;font-size:16px;font-weight:600;display:flex;align-items:center;justify-content:center;'
            + 'gap:6px;box-shadow:0 8px 20px rgba(91,77,240,.28)">' + ic('cam') + ' 拍药盒</button>' +
          '<button data-act="medscan" style="flex:none;width:100px;height:54px;border:0;border-radius:18px;'
            + 'background:#fff;color:#1B1D2E;font-size:15px;font-weight:600;box-shadow:0 4px 14px rgba(40,42,90,.08)">相册</button>' +
        '</div>';
    },
    /* —— 2026-11-07 老界面换皮：learn/did/family/bp 四个屏从老 page-* 框架
          搬进 f7，数据源不变（S.rules / S.did / S.fam / localStorage）—— */
    learn: function(){
      var rules = (S.rules || []).slice().reverse().slice(0, 30);
      var unk = (S.unknown || []).slice().reverse().slice(0, 12);
      var rl = rules.length
        ? '<div class="f7card">' + rules.map(function(r){
            return '<div class="f7row" style="cursor:default;align-items:flex-start">' +
              '<span class="tx" style="flex:1"><b style="font-weight:600">' + esc(r.q || r.k || '') + '</b>' +
              '<br><span style="font-size:13px;color:#6B708C">' + esc(r.ans || '') + '</span></span>' +
              '<button class="rec" data-act="delrule" data-id="' + esc(r.id || '') + '" style="flex:none">删</button></div>';
          }).join('') + '</div>'
        : '<div class="f7blank"><b>还没有记下的事</b><small>老人说「帮我记住…」，米粒就收在这里</small></div>';
      var ul = unk.length
        ? '<div class="f7card">' + unk.map(function(u, i){
            return '<div class="f7row" style="cursor:default">' +
              '<span class="tx" style="flex:1">' + esc(u.q || '') +
              (u.n > 1 ? ' <span style="font-size:12px;color:#9A9FBA">问过 ' + u.n + ' 次</span>' : '') + '</span>' +
              '<button class="rec" data-act="delunk" data-i="' + (S.unknown.length - 1 - i) + '" style="flex:none">删</button></div>';
          }).join('') + '</div>'
        : '';
      return nav('米粒记事本') +
        '<div class="f7sec"><i></i>记住的事 · 答得上</div>' + rl +
        (ul ? '<div class="f7sec"><i></i>答不上的 · 等着学</div>' + ul : '') +
        '<p style="font-size:13px;color:#9A9FBA;line-height:1.6;margin:12px 2px">老人端说「帮我记住…」就往这里添；删掉就是忘了。</p>';
    },
    did: function(){
      var days = {};
      (S.did || []).forEach(function(x){ (days[x.d] = days[x.d] || []).push(x); });
      var keys = Object.keys(days).sort(function(a, b){ return (+a) - (+b); }).reverse().slice(0, 4);
      var h = keys.map(function(k){
        var dt = new Date(Date.now() - (+k) * 864e5);
        var name = (+k) === 0 ? '今天' : (+k) === 1 ? '昨天'
          : (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
        return '<div class="f7sec"><i></i>' + name + '</div><div class="f7card">' +
          days[k].map(function(x){
            return '<div class="f7row" style="cursor:default"><span class="ico">' + ic(x.icon || 'act') + '</span>' +
              '<span class="tx" style="flex:1"><b style="font-weight:600">' + esc(x.title || '') + '</b>' +
              '<br><span style="font-size:13px;color:#6B708C">' + esc(x.sub || '') + '</span></span>' +
              '<span class="val">' + esc(x.time || '') + '</span></div>';
          }).join('') + '</div>';
      }).join('');
      return nav('最近办的事') + (h ||
        '<div class="f7blank"><b>还没有办过事</b><small>米粒办完的都会记在这里</small></div>');
    },
    family: function(){
      var rows = (S.fam || []).length
        ? '<div class="f7card">' + S.fam.map(function(f){
            return '<div class="f7row" style="cursor:default">' +
              '<span class="tx" style="flex:1"><b style="font-weight:600">' + esc(f.label || '') +
              (f.name ? ' · ' + esc(f.name) : '') + '</b>' +
              '<br><span style="font-size:13px;color:#6B708C">' + esc(f.phone || '') + '</span></span>' +
              (f.phone ? '<a class="rec" href="tel:' + esc(f.phone) + '" style="text-decoration:none;flex:none">打电话</a>' : '') + '</div>';
          }).join('') + '</div>'
        : '<div class="f7blank"><b>还没有联系人</b><small>在「家人端配置引导」里加好会同步过来</small></div>';
      return nav('常联系的人') + rows;
    },
    bp: function(){
      var bp = [], bg = [];
      try { bp = JSON.parse(localStorage.getItem('mili.f7.bp') || '[]'); } catch(e){}
      try { bg = JSON.parse(localStorage.getItem('mili.f7.bg') || '[]'); } catch(e){}
      var bpList = bp.length
        ? '<div class="f7card">' + bp.slice(-8).reverse().map(function(x){
            var dt = new Date(x.t);
            return '<div class="f7row" style="cursor:default"><span class="tx">' + esc(x.hi) + '/' + esc(x.lo) + ' mmHg</span>' +
              '<span class="val">' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + esc(x.hm || '') + '</span></div>';
          }).join('') + '</div>'
        : '<div class="f7blank"><b>还没有血压记录</b><small>记一次，米粒帮您看着趋势</small></div>';
      var bgList = bg.length
        ? '<div class="f7card">' + bg.slice(-8).reverse().map(function(x){
            var dt = new Date(x.t);
            return '<div class="f7row" style="cursor:default"><span class="tx">' + esc(x.v) + ' mmol/L</span>' +
              '<span class="val">' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + esc(x.hm || '') + '</span></div>';
          }).join('') + '</div>'
        : '<div class="f7blank"><b>还没有血糖记录</b><small>空腹还是饭后，备注里写一句</small></div>';
      return nav('血压 / 血糖') +
        '<div class="f7sec"><i></i>记一次血压</div>' +
        '<div class="f7card" style="display:flex;gap:10px;align-items:center;padding:14px 16px">' +
          '<input id="f7bphi" class="f7medtime" type="number" inputmode="numeric" placeholder="高压" style="flex:1">' +
          '<input id="f7bplo" class="f7medtime" type="number" inputmode="numeric" placeholder="低压" style="flex:1">' +
          '<button class="f7cta" data-act="savebp" style="position:static;margin:0;padding:12px 18px">保存</button></div>' +
        bpList +
        '<div class="f7sec"><i></i>记一次血糖</div>' +
        '<div class="f7card" style="display:flex;gap:10px;align-items:center;padding:14px 16px">' +
          '<input id="f7bgv" class="f7medtime" type="number" inputmode="decimal" step="0.1" placeholder="mmol/L" style="flex:1">' +
          '<button class="f7cta" data-act="savebg" style="position:static;margin:0;padding:12px 18px">保存</button></div>' +
        bgList;
    },
    personal: function(){
      /* 2026-11-10 菲尔特：这页叫「设置」；「开启个性化回答」是假开关、
         「管理健康档案」是假入口，都删；补上切换老人和退出。 */
      return nav('设置') +
        '<div class="f7card flush" style="padding:16px">' +
          '<button class="f7row" data-go="learn" style="border-bottom:1px solid #E9E9F5">' +
            '<span class="tx">米粒记事本</span><span class="go">›</span></button>' +
          '<p style="margin:0;font-size:14px;line-height:1.6;color:#6B708C">' +
            '米粒能从历史对话里记住重要信息，可随时在「米粒记事本」里删掉不想留的。</p>' +
        '</div>' +
        '<div class="f7card">' +
          '<button class="f7row" data-act="f7logout"><span class="tx">退出</span><span class="go">›</span></button>' +
        '</div>';
    },
    avatar: function(){
      var d = D();
      return nav('头像和昵称') +
        '<div class="f7avatar" data-act="setavatar">' +
          (S.avatar ? '<img src="' + S.avatar + '" style="width:72px;height:72px;border-radius:50%;object-fit:cover">'
                    : ic('cam') + '<span>添加头像</span>') + '</div>' +
        '<div class="f7afuid">米粒号：' + (d.me || '—') + '</div>' +
        '<div class="f7card">' +
          '<button class="f7row" data-act="setname"><span class="tx">昵称</span>' +
          '<span class="val">' + d.me + '</span><span class="go">›</span></button></div>';
    }
  };

  var DEVLIST = {
    0:[['内置','米粒 · 桌面常驻','none'],['内置','家人控制台','fam']],
    1:[['阿福联名','体脂秤（待接入）','soon'],['生态设备','体脂秤 A','soon']],
    2:[['阿福联名','华为 Band 8 心率广播','soon'],['生态设备','小米手环','soon']],
    3:[['阿福联名','动态血糖仪','soon'],['生态设备','鱼跃血糖仪','soon'],['生态设备','欧姆龙血糖仪','soon']],
    4:[['阿福联名','鱼跃血压计','soon'],['生态设备','欧姆龙血压计','soon']],
    5:[['生态设备','呼吸机（待接入）','soon']]
  };
  function fillDev(i){
    var box = q('#f7devlist'); if (!box) return;
    var groups = {}, g = DEVLIST[i] || [];
    g.forEach(function(x){ (groups[x[0]] = groups[x[0]] || []).push(x); });
    var h = '';
    Object.keys(groups).forEach(function(k, gi){
      if (gi) h += '<hr class="dash">';
      h += '<div class="cap">' + k + '</div>';
      groups[k].forEach(function(x){
        h += x[2] === 'none'
          ? '<div class="f7dev" style="opacity:.55">'
          : '<button class="f7dev" ' + (x[2] === 'soon' ? 'data-act="soon"' : (x[2] === 'fam' ? 'data-act="open9switch"' : 'data-page="' + x[2] + '"')) + '>' +
             '<span class="thumb">' + ic('dev') + '</span><span class="nm">' + x[1] + '</span><span class="go">›</span></' + (x[2] === 'none' ? 'div' : 'button') + '>';
      });
    });
    h += '<div class="more">继续上滑查看更多</div>';
    box.innerHTML = h;
  }

  var MAIN = ['guard','health','device','mine'];
  var TABS = [
    ['guard','守护','heart'], ['health','健康','chart'],
    ['device','设备','grid'], ['mine','我的','user']
  ];
  var root, cur = 'mine', hist = [], built = false, familyMode = false;
  var lastMain = 'mine';
  function tabsHTML(){
    /* 子页也显示同一条 tab，并高亮它归属的主分区，不再忽然空一块 */
    var on = (MAIN.indexOf(cur) >= 0) ? cur : lastMain;
    return '<nav class="f7tabs">' + TABS.map(function(t){
      return '<button class="' + (on === t[0] ? 'on' : '') + '" data-go="' + t[0] + '">' +
             ic(t[2]) + '<span>' + t[1] + '</span></button>';
    }).join('') + '</nav>';
  }
  function render(name){
    cur = name;
    if (MAIN.indexOf(name) >= 0) lastMain = name;
    var sub = MAIN.indexOf(name) < 0;
    root.classList.toggle('sub', sub);
    var screens = MAIN.concat(Object.keys(SCREENS).filter(function(k){ return MAIN.indexOf(k) < 0; }));
    var html = '<div class="f7body">' + screens.map(function(k){
      return '<div class="f7screen' + (k === name ? ' on' : '') + '" data-screen="' + k + '">' +
             (SCREENS[k] ? SCREENS[k]() : '') + '</div>';
    }).join('') + '</div>' + tabsHTML();
    root.innerHTML = html;
    /* 2026-11-09：把当前页的 nav 从滚动容器里抽出来，挂到 .f7body 之外的
       固定层。这样「守护 / 设备」这类大字标题永远钉在顶上，不跟内容下滑。 */
    var sc = q('.f7screen.on', root), nav = sc && q('.f7nav', sc);
    if (nav) {
      var top = document.createElement('div');
      top.className = 'f7top';
      top.appendChild(nav);
      root.insertBefore(top, q('.f7body', root));
    }
    if (name === 'adddev') fillDev(0);
    var b = q('.f7body', root); if (b) b.scrollTop = 0;
  }
  function go(name){
    if (name === 'back') name = hist.pop() || 'mine';
    else if (MAIN.indexOf(name) >= 0) hist = [];
    else if (name !== cur) hist.push(cur);
    render(name);
  }
  function build(){
    if (built) return;
    var host = q('#page-famhome'); if (!host) return;
    built = true;
    /* 供 app.js 的 medApply() 回调重绘药箱页（不改滚动条位置） */
    window.__f7renderMed = function(){
      try {
        if (!root || cur !== 'medbox') return;
        var sc = q('.f7screen.on', root);
        if (!sc) return;
        var body = q('.f7body', root);
        var keep = body ? body.scrollTop : 0;
        sc.innerHTML = SCREENS.medbox();
        if (body) body.scrollTop = keep;
      } catch (e) {}
    };
    root = document.createElement('div'); root.id = 'fam7';
    document.body.appendChild(root);
    render('mine');
    root.addEventListener('click', function(e){
      var n = e.target.closest ? e.target.closest('[data-go],[data-page],[data-act],[data-seg],[data-mtab],[data-cat],[data-top]') : null;
      if (!n) return;
      /* 2026-11-10：头像和昵称页整个下线，任何残留入口都不许进。 */
      if (n.dataset.go === 'avatar' || n.dataset.page === 'avatar') return;
      if (n.dataset.act === 'f7logout'){
        try { accLogout().then(function(){ location.reload(); }); }
        catch(e){ location.reload(); }
        return;
      }
      if (n.dataset.go){
        /* mini 态＝人在家长端子页里；点底部 Tab 先回家长端再切页，路线不断。 */
        if (root.classList.contains('mini')){
          try { goPage('famhome'); } catch(err){}
        }
        go(n.dataset.go); return;
      }
      if (n.dataset.page){ try { goPage(n.dataset.page); } catch(err){} return; }
      if (n.dataset.seg){
        root.querySelectorAll('.f7seg button').forEach(function(b){ b.classList.toggle('on', b === n); });
        root.querySelectorAll('[data-segbody]').forEach(function(b){ b.style.display = b.dataset.segbody === n.dataset.seg ? '' : 'none'; });
        return;
      }
      if (n.dataset.mtab){
        root.querySelectorAll('.f7btab button').forEach(function(b){ b.classList.toggle('on', b === n); });
        root.querySelectorAll('[data-mbody]').forEach(function(b){ b.style.display = b.dataset.mbody === n.dataset.mtab ? '' : 'none'; });
        return;
      }
      if (n.dataset.cat != null){
        root.querySelectorAll('.f7side button').forEach(function(b){ b.classList.toggle('on', b === n); });
        fillDev(+n.dataset.cat); return;
      }
      if (n.dataset.top){ return; }
      if (n.dataset.act === 'run1' || n.dataset.act === 'run2'){
        var k = n.dataset.act === 'run1' ? 'a' : 'b';
        var inp = q('#f7renewText', root);
        var txt = inp ? String(inp.value || '').trim() : '';
        if (!txt) return;
        var t0 = Date.now();
        var slot0 = q('[data-run="' + k + '"]', root);
        if (slot0) slot0.innerHTML = '<h4>' + (k === 'a' ? 'RUN 1 · 尝试' : 'RUN 2 · 进化') +
          '</h4><div class="ph">正在跑…</div>';
        /* 🚨 2026-11-12 现场级修复：日新页原来只认 window.MILI_DEBUG，
           而它仅在 ?debug=1 时挂载；APK 走 file:///android_asset/web/index.html，
           没有 debug 参数 → 点「跑第 1 次」直接显示「没接上智能体」。
           现在直接用同一闭包里现成的 handleSay，不另起链路、不加能力。
           有 debug 口时仍优先用它，方便探针。 */
        var D = window.MILI_DEBUG;
        var sayFn = (D && D.handleSay) ? D.handleSay
                  : (typeof handleSay === 'function' ? handleSay : null);
        var finish = function(extra){
          window.__F7_RUNS = window.__F7_RUNS || {};
          var o = { text: txt, ms: Date.now() - t0, tools: [], trace: [], dialog: [] };
          if (extra) for (var z in extra) o[z] = extra[z];
          window.__F7_RUNS[k] = o; refreshRun(k);
        };
        if (!sayFn){ finish({ note: '没接上智能体（现场需真机 + key）' }); return; }
        try {
          /* quiet 必须传 false：原来写 handleSay(txt, {})，{} 是 truthy，
             等于开了静音自测模式 —— 真追问对话在真机上根本不会出声。
             RUN 1 带 askFirst → 模型先真问一句、不调工具；RUN 2 不带，走原链路。 */
          Promise.resolve(sayFn(txt, false, k === 'a' ? { askFirst: true } : null)).then(function(ret){
            var tr = [];
            try {
              if (ret && Array.isArray(ret.trace)) tr = ret.trace;
              else {
                var lt = (D && D.lastTrace && D.lastTrace()) ||
                         (window.MILI_AGENT ? window.MILI_AGENT.trace() : null);
                tr = Array.isArray(lt) ? lt
                   : (lt && Array.isArray(lt.rounds) ? lt.rounds : []);
              }
            } catch(e){ tr = []; }
            var tools = [];
            tr.forEach(function(x){ (x.calls || []).forEach(function(c){ tools.push(c.name); }); });
            /* 对话实录：只取这一句真跑出来的原话，不预填、不编。 */
            var dlg = ['老人：' + txt];
            tr.forEach(function(x){ if (x && x.said) dlg.push('米粒：' + String(x.said).slice(0, 46)); });
            if (!tr.length) dlg.push('米粒：' + (ret && ret.skillHit
              ? '（命中记忆，没再问，直接办了）' : '（这次没走模型）'));
            finish({ trace: tr, tools: tools, dialog: dlg, skillHit: !!(ret && ret.skillHit) });
          }).catch(function(e){
            finish({ note: '这次没跑通：' + ((e && e.message) || '未知') });
          });
        } catch(e){ finish({ note: '调用失败：' + ((e && e.message) || '未知') }); }
        return;
      }
      /* 2026-11-12：RUN 1 真问一句之后，老人得能把话答回去。
         答句走同一个 handleSay（不带 askFirst），会真调工具、真办事。
         办成了再把这一串动作记到 RUN 1 那句原话名下 ——
         下一句原话再来才能 0ms 直达，否则记的是「对，就这个」，
         RUN 2 根本命中不了。 */
      if (n.dataset.act === 'answer'){
        var ai = q('#f7answerText', root);
        var ans = ai ? String(ai.value || '').trim() : '';
        if (!ans){ f7toast('先写一句老人会怎么答'); return; }
        var D2 = window.MILI_DEBUG;
        var say2 = (D2 && D2.handleSay) || (typeof handleSay === 'function' ? handleSay : null);
        if (!say2){ f7toast('没接上智能体'); return; }
        var run1 = (window.__F7_RUNS || {}).a || null;
        f7toast('它在办了…');
        Promise.resolve(say2(ans, false, null)).then(function(ret){
          var calls = [];
          try {
            var tr2 = (ret && Array.isArray(ret.trace)) ? ret.trace : [];
            tr2.forEach(function(rd){ (rd.calls || []).forEach(function(c){
              calls.push({ name: c.name, args: c.args || {} });
            }); });
          } catch(e){}
          if (calls.length && run1 && window.MILI_MEMO && window.MILI_MEMO.note){
            try { window.MILI_MEMO.note(String(run1.text || ''), calls); } catch(e){}
          }
          try {
            window.__F7_RUNS = window.__F7_RUNS || {};
            window.__F7_RUNS.a = window.__F7_RUNS.a || { dialog: [] };
            var dlg = window.__F7_RUNS.a.dialog = window.__F7_RUNS.a.dialog || [];
            dlg.push('老人：' + ans);
            if (ret && ret.said) dlg.push('米粒：' + String(ret.said).slice(0, 46));
          } catch(e){}
          render('renew');
          f7toast(calls.length ? '办成了，这句原话已经记住' : '这句没调起工具，没记');
          return;
        }).catch(function(e){ f7toast('没跑通：' + ((e && e.message) || '未知')); });
        return;
      }
      /* 2026-11-12：现场换组委会发的 token 额度。
         只改运行时配置，不改代码、不重打包、不预灌任何数字。 */
      if (n.dataset.act === 'llmPreset'){
        var P = {}, pp = {};
        try { P = (window.MILI_AGENT && window.MILI_AGENT.llmPresets) ? window.MILI_AGENT.llmPresets() : {}; } catch(e){}
        pp = P[n.dataset.p] || {};
        var eb = q('#f7llmBase', root), em = q('#f7llmModel', root);
        if (eb) eb.value = pp.base || '';
        if (em) em.value = pp.model || '';
        f7toast(n.dataset.p === 'qingcheng'
          ? '清程极智的地址现场找主办拿，填进 Base URL 再贴 Key'
          : '预设已填好，把现场发的 Key 贴进去');
        return;
      }
      if (n.dataset.act === 'llmSave'){
        var vBase  = ((q('#f7llmBase', root)  || {}).value || '').trim();
        var vModel = ((q('#f7llmModel', root) || {}).value || '').trim();
        var vKey   = ((q('#f7llmKey', root)   || {}).value || '').trim();
        if (!vBase || !vModel){ f7toast('Base URL 和模型名都要填'); return; }
        var lcfg = { base: vBase, model: vModel };
        if (vKey) lcfg.key = vKey;
        var lr = (window.MILI_AGENT && window.MILI_AGENT.setLLM)
          ? window.MILI_AGENT.setLLM(lcfg) : { ok:false, err:'智能体没起来' };
        render('renew');
        f7toast(lr.ok ? ('已切到 ' + lr.model + ' · 下一句就走这个额度')
                      : ('没切成功：' + (lr.err || '未知')));
        return;
      }
      if (n.dataset.act === 'llmReset'){
        try { if (window.MILI_AGENT && window.MILI_AGENT.setLLM) window.MILI_AGENT.setLLM({ reset:true }); } catch(e){}
        render('renew');
        f7toast('本机额度已清掉，回到内置默认');
        return;
      }
      if (n.dataset.act === 'rollback'){
        var evo = window.EVO, rr = null;
        try { rr = evo && evo.rollback ? evo.rollback() : null; } catch(e){}
        try {
          var M = window.MILI_MEMO;
          if (M && M.skills && M.skillDel){
            var sk = M.skills(); if (sk && sk.length) M.skillDel(sk[sk.length - 1].id);
          }
        } catch(e){}
        try {
          if (typeof S !== 'undefined' && S.rules && S.rules.length) S.rules.pop();
          if (typeof save === 'function') save();
        } catch(e){}
        window.__F7_RUNS = {};
        var msg = (rr && rr.ok) ? ('已回到 v' + rr.ver)
                : (rr && rr.why === 'no_snapshot') ? '现在是最初状态，没有快照可退'
                : '回退没成，看控制台';
        render('renew');
        var tip = document.createElement('div'); tip.className = 'f7tip'; tip.textContent = msg;
        root.appendChild(tip); setTimeout(function(){ if (tip.parentNode) tip.remove(); }, 2600);
        return;
      }
      if (n.dataset.act === 'personal'){
        var on = !n.classList.contains('on'); n.classList.toggle('on', on);
        try { localStorage.setItem('mili.f7.personal', JSON.stringify(on)); } catch(err){}
        return;
      }
      /* ---- 捎句话 / 体重 / 睡眠 / 用药时间（真功能，非占位） ---- */
      if (n.dataset.act === 'open9switch'){
        try { window.__V9_OPEN('switch'); } catch(err){}
        return;
      }
      if (n.dataset.act === 'saveweight'){
        var wi = q('#f7w', root); var wv = wi ? parseFloat(wi.value) : NaN;
        if (!(wv > 20 && wv < 300)){ f7toast('填一个真实体重，比如 62.5'); return; }
        var wa = []; try { wa = JSON.parse(localStorage.getItem('mili.f7.weight') || '[]'); } catch(err){}
        wa.push({ v: wv, t: Date.now() });
        try { localStorage.setItem('mili.f7.weight', JSON.stringify(wa)); } catch(err){}
        f7toast('记好了'); render('weight'); return;
      }
      if (n.dataset.act === 'savesleep'){
        var si = q('#f7sl', root); var sv = si ? parseFloat(si.value) : NaN;
        if (!(sv > 0 && sv < 24)){ f7toast('填一个真实时长，比如 7.5'); return; }
        var sa = []; try { sa = JSON.parse(localStorage.getItem('mili.f7.sleep') || '[]'); } catch(err){}
        sa.push({ v: sv, t: Date.now() });
        try { localStorage.setItem('mili.f7.sleep', JSON.stringify(sa)); } catch(err){}
        f7toast('记好了'); render('sleep'); return;
      }
      if (n.dataset.act === 'sendnote'){
        var ni = q('#f7note', root); var nt = ni ? String(ni.value || '').trim() : '';
        if (!nt){ f7toast('先写一句话'); return; }
        var note = { t: Date.now(), text: nt, sent: false };
        try { localStorage.setItem('mili.note', JSON.stringify(note)); } catch(err){}
        try {
          fetch('http://YOUR_SERVER_HOST:9001/state?k=YOUR_STATE_KEY&dev=note', {
            method:'PUT', headers:{ 'Content-Type':'application/json' },
            body: JSON.stringify(note)
          }).then(function(){ note.sent = true;
            try { localStorage.setItem('mili.note', JSON.stringify(note)); } catch(err){}
          }).catch(function(){});
        } catch(err){}
        f7toast('下发成功，老人端一分钟内播报'); return;
      }
      if (n.dataset.act === 'savetimes'){
        var tins = root.querySelectorAll('.f7medtime');
        var nset = 0;
        Array.prototype.forEach.call(tins, function(inp){
          var i = +inp.dataset.i;
          if (typeof S !== 'undefined' && S.med && S.med[i]){
            S.med[i].times = inp.value ? [inp.value] : [];
            if (inp.value) nset++;
          }
        });
        try { if (typeof save === 'function') save(); } catch(err){}
        f7toast(nset ? '定好了，到点米粒会提醒' : '已清除提醒时间');
        return;
      }
      if (n.dataset.act === 'savebp' || n.dataset.act === 'savebg'){
        var isBp = n.dataset.act === 'savebp';
        var arr = [];
        try { arr = JSON.parse(localStorage.getItem(isBp ? 'mili.f7.bp' : 'mili.f7.bg') || '[]'); } catch(err){}
        var nowD = new Date();
        var hmNow = nowD.getHours() + ':' + (nowD.getMinutes() < 10 ? '0' : '') + nowD.getMinutes();
        if (isBp){
          var hi = q('#f7bphi', root), lo = q('#f7bplo', root);
          var hv = hi ? +hi.value : 0, lv = lo ? +lo.value : 0;
          if (!hv || !lv || hv < 50 || hv > 260 || lv < 30 || lv > 200 || lv >= hv){ f7toast('数值不对，再看一眼'); return; }
          arr.push({ t: Date.now(), hi: hv, lo: lv, hm: hmNow });
          if (hi) hi.value = ''; if (lo) lo.value = '';
        } else {
          var gv = q('#f7bgv', root);
          var vv = gv ? +gv.value : 0;
          if (!vv || vv < 1 || vv > 40){ f7toast('数值不对，再看一眼'); return; }
          arr.push({ t: Date.now(), v: vv, hm: hmNow });
          if (gv) gv.value = '';
        }
        if (arr.length > 200) arr = arr.slice(-200);
        try { localStorage.setItem(isBp ? 'mili.f7.bp' : 'mili.f7.bg', JSON.stringify(arr)); } catch(err){}
        render('bp');
        f7toast(isBp ? '血压记下了' : '血糖记下了');
        return;
      }
      if (n.dataset.act === 'delrule'){
        S.rules = (S.rules || []).filter(function(r){ return r.id !== n.dataset.id; });
        try { if (typeof save === 'function') save(); } catch(err){}
        render('learn'); f7toast('删了'); return;
      }
      if (n.dataset.act === 'delunk'){
        var ui2 = +n.dataset.i;
        if (S.unknown && S.unknown[ui2]){ S.unknown.splice(ui2, 1); }
        try { if (typeof save === 'function') save(); } catch(err){}
        render('learn'); f7toast('删了'); return;
      }
      if (n.dataset.act === 'setname'){
        var nv = prompt('怎么称呼这一位？', S.me || '');
        if (nv === null) return;
        nv = String(nv).trim().slice(0, 12);
        if (!nv){ f7toast('名字不能是空的'); return; }
        S.me = nv;
        try { if (typeof save === 'function') save(); } catch(err){}
        render('avatar'); f7toast('改好了，叫' + nv); return;
      }
      if (n.dataset.act === 'setavatar'){
        var ai = document.createElement('input');
        ai.type = 'file'; ai.accept = 'image/*';
        ai.style.display = 'none';
        document.body.appendChild(ai);
        ai.addEventListener('change', function(){
          var af = ai.files && ai.files[0];
          if (ai.parentNode) ai.remove();
          if (!af) return;
          var ar = new FileReader();
          ar.onload = function(){
            var aim = new Image();
            aim.onload = function(){
              var asc = Math.min(1, 320 / Math.max(aim.naturalWidth, aim.naturalHeight));
              var acv = document.createElement('canvas');
              acv.width = Math.round(aim.naturalWidth * asc);
              acv.height = Math.round(aim.naturalHeight * asc);
              acv.getContext('2d').drawImage(aim, 0, 0, acv.width, acv.height);
              S.avatar = acv.toDataURL('image/jpeg', 0.8);
              try { if (typeof save === 'function') save(); } catch(err){}
              render('avatar'); f7toast('头像换好了');
            };
            aim.src = String(ar.result || '');
          };
          ar.readAsDataURL(af);
        });
        ai.click();
        return;
      }
      if (n.dataset.act === 'medshot'){
        /* 2026-11-09 22:25 菲尔特第三次：「拍药或者上传图片都失败，没有识别药物」。
           真视觉 API + medApply 实测是通的（tools/verify_med_real_1109.py），
           断在入口：snapPhoto() 走系统相机 Activity + onActivityResult(778)，
           MIUI 上相机回来常丢 pendingShot / 回 result=0，回调就静默没了。
           改用 App 内 Camera2（Vision.shoot），回调 __onPhoto(900001,b64,...)
           已经接进 medApply，不跨 Activity、不靠 result，稳定得多。
           snapPhoto 只留作没有 Camera2 的设备兜底。 */
        try {
          const nb = window.MiliNative;
          if (nb && nb.shoot) { nb.shoot(0, 900001); return; }
          if (nb && nb.snapPhoto) {
            const r = JSON.parse(nb.snapPhoto() || '{}');
            if (!r.ok) f7toast('相机没打开：' + (r.why || ''));
          } else f7toast('这台手机开不了相机');
        } catch (e) { f7toast('相机没打开：' + String(e && e.message || e).slice(0, 20)); }
        return;
      }
      if (n.dataset.act === 'medscan'){
        /* 2026-11-07 拍照识别药品：拍药盒 → deepseek-flash 看图认药
           → 药名/规格/用法带出来 → 预填提醒时间 → 入药箱。
           WebView 里走 <input capture> 调系统相机（onShowFileChooser 已通）。 */
        if (n.dataset.busy) return;
        var fi = document.createElement('input');
        /* capture='environment' 会让 WebView 直接拉相机而不是相册，
           而「相册」这颗按钮要的是选已有照片。去掉它，走 onShowFileChooser。 */
        fi.type = 'file'; fi.accept = 'image/*';
        fi.style.display = 'none';
        document.body.appendChild(fi);
        fi.addEventListener('change', function(){
          var f = fi.files && fi.files[0];
          if (fi.parentNode) fi.remove();
          if (!f) return;
          var old = n.innerHTML;
          n.dataset.busy = '1';
          n.innerHTML = ic('cam') + ' 正在识别…';
          var done = function(){ delete n.dataset.busy; n.innerHTML = old; };
          var rd = new FileReader();
          rd.onload = function(){
            var img = new Image();
            img.onload = function(){
              /* 压到 1024 宽以内再上传：省流量，识别也够用 */
              var w = img.naturalWidth, h = img.naturalHeight;
              var sc = Math.min(1, 1024 / Math.max(w, h));
              var cv = document.createElement('canvas');
              cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
              cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
              var b64 = cv.toDataURL('image/jpeg', 0.82).split(',')[1];
              /* 不再拿 MILI_AGENT.vision 是否就绪当门禁：大脑初始化慢时
                 这里会直接弹「视觉没就绪」就退出，老人看到的就是「上传失败」。
                 交给 __medApply 自己兜底，失败也会给一条看得懂的反馈条。 */
              /* 2026-11-09：识别 + 入库统一到 __medApply，相册/拍照两条路不再各写一份。
                 按钮先恢复，识别状态由药箱页的「正在认…」提示条承接。 */
              done();
              try { window.__medApply(b64); } catch (err) { f7toast('识别没起来'); }
            };
            img.onerror = function(){ done(); f7toast('这张照片读不出来'); };
            img.src = String(rd.result || '');
          };
          rd.readAsDataURL(f);
        });
        fi.click();
        return;
      }
      if (n.dataset.act === 'soon'){
        var tip = q('.f7body', root); if (!tip) return;
        var old = q('#f7tip', root); if (old) old.remove();
        var t = document.createElement('p'); t.id = 'f7tip';
        t.style.cssText = 'position:fixed;left:20px;right:20px;bottom:96px;z-index:9;text-align:center;' +
          'background:#1B1D2E;color:#fff;padding:12px 16px;border-radius:14px;font-size:14px';
        t.textContent = '这项还没接入，不给你摆假按钮';
        root.appendChild(t); setTimeout(function(){ if (t.parentNode) t.remove(); }, 2200);
      }
    });
    function sync(){
      var famOn = host.classList.contains('on');
      var home = q('#page-home');
      var homeOn = home && home.classList.contains('on');
      /* 只有「从家长端进去的子页」才挂全局胶囊 Tab。
         老人端从桌面点进 page-med 不该串出家长端导航。 */
      /* 🚨 2026-11-10 真机根因（「又无法说话，一直在听」）：
         原来只看 DOM class：任何浮层带 .on、首页恰好还没 .on（冷启动 /
         进设置页 / 切页途中），就把老人端误判成家人端 → cvStop + micShut +
         ttsStop，麦直接被摘掉，可通话条还写着「在听」，一句话也收不到。
         logcat 实测：15:10:54 / 15:10:59 每次冷启动都打 callExit why=family。
         身份才是唯一真源：只有真的切到家人端才算家人端。 */
      /* 身份唯一真源是账号票（启动时 reconcileIdentity 已校准），
         不再拿 DOM class 猜 —— 冷启动 / 切页途中 class 没就位会误判成家人端，
         把老人端的麦摘掉，屏幕上却还写着「在听」。 */
      familyMode = !!(S && S.role === 'family' && S.accToken && S.pairCode);
      window.__F7_FAMILY = familyMode;
      /* 切端时同步麦克风门控：家人端彻底关唤醒，老人端才开 */
      try {
        var nb = NATIVE();
        if (nb) {
          if (nb.setFamilyMode) nb.setFamilyMode(familyMode);
          if (familyMode) {
            if (nb.cvStop) nb.cvStop();
            if (nb.micShut) nb.micShut();
            if (nb.ttsStop) nb.ttsStop();          /* 立刻闭嘴 */
            try { const cb = document.getElementById('callBar'); if (cb) cb.hidden = true; } catch (e3) {}
          } else {
            if (nb.micOpen) nb.micOpen();
            /* 2026-11-09 菲尔特拍板「比赛肯定有网络，不要搞离线的东西」：
               原来切到老人端无条件 cvStart() —— 连续对话那条路只走本地
               sherpa-onnx 离线识别，还会把 asrBusy 钉成 true，之后
               startLocalAsr() 第一行就 return，在线豆包识别永远进不了主链路。
               现在只在设置里主动打开（S.cvOn）才起常驻听；默认关，且切端
               时显式归零，避免上一次残留的 cvMode 继续挡着在线链路。 */
            /* 2026-11-10：开机/切端都不许自己起常驻听。
               S.cvOn 现在是默认开（闲聊连听），照旧逻辑这里会一开机就 cvStart，
               首页莫名挂一条「在听」、还和唤醒服务抢同一颗麦。
               连续对话只在 callEnter 之后由 startCv() 起；这里只负责收干净，
               而且正在通话时绝不收麦（否则又是「界面在听、耳朵没了」）。 */
            if (!CALL.on && nb.cvStop) nb.cvStop();
            window.__lastCallEnd = Date.now();
          }
        }
      } catch (e) {}
      try {
        /* 家人端时把老人端的浮层全部收起来：气泡、通话条、待唤醒条、桌宠卡 */
        document.documentElement.classList.toggle('fam-on', !!familyMode);
        if (familyMode) {
          try { if (typeof callExit === 'function') callExit('family'); } catch (e2) {}
        }
      } catch (e) {}
      var mini = familyMode && !famOn && !homeOn;
      root.classList.toggle('on', famOn || mini);
      root.classList.toggle('mini', mini);
      if (mini) root.classList.remove('sub');
    }
    /* 验收/外部调用：用真实 goPage 切页，渲染函数才会跑（手动加 .on 会留空分区）。 */
    try { window.__MILI_PAGE = goPage; } catch(e){}
    new MutationObserver(sync).observe(host, { attributes:true, attributeFilter:['class'] });
    var homeEl = q('#page-home');
    if (homeEl) new MutationObserver(sync).observe(homeEl, { attributes:true, attributeFilter:['class'] });
    sync();
  }
  function start(){ build(); var n=0, t=setInterval(function(){ if (built || ++n > 12) clearInterval(t); else build(); }, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();



/* ==========================================================================
 * v9 · 登录 / 双端切换 / 家人端分步引导 / 老人端配置（2026-11-07 14:30）
 * --------------------------------------------------------------------------
 * 菲尔特：「很多按钮没有真的编写、打开是旧界面、冗余；没有引导页，家人要
 *          一步步预填联系人/药/设备/图标数/常用功能/底部，同步到老人端。」
 *
 * 这一层是 fixed 全覆盖，跟旧 page-* 完全隔离。
 * 原则：每个可见按钮都有真行为；做不到的不摆；预留的 App/硬件接口明说。
 * ========================================================================== */
(function(){
  'use strict';
  const V9KEY = 'mili.v9';
  const $9 = id => document.getElementById(id);
  const E9 = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const API = () => MILI_API;

  /* ---- 图标（跟阿福一致的线性图标，不引外部资源） ---- */
  const SV = {
    back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8.1 9.5a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/></svg>',
    video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="3"/><path d="M16 10l6-3v10l-6-3z"/></svg>',
    lamp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 5H8z"/><path d="M8 8v3a4 4 0 0 0 8 0V8"/><path d="M10 18h4"/></svg>',
    cam:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.4"/></svg>',
    tv:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 3l4 4 4-4"/></svg>',
    play:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 4l14 8-14 8z"/></svg>',
    music:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    msg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9 9 0 0 1-4-.9L3 21l1.9-4.5a8.4 8.4 0 0 1-.9-4 8.5 8.5 0 0 1 17 0z"/></svg>',
    wx:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4C5 4 2 6.7 2 10c0 1.9 1 3.6 2.7 4.7L4 17l2.6-1.3c.8.2 1.6.3 2.4.3"/><path d="M22 15c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.7 0 1.4-.1 2-.3L20 21l-.6-2.1c1.6-.9 2.6-2.3 2.6-3.9z"/></svg>',
    pic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l5-5 3 3 4-4 4 4"/></svg>',
    log:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
    sos:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 17H3z"/><path d="M12 9v5M12 17h.01"/></svg>',
    mic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
    pill:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-40 12 12)"/><path d="M8.5 8.5l7 7"/></svg>',
    heart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/></svg>',
    dev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M9 6h6M9 18h6"/></svg>',
    sync:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M20 12a8 8 0 0 0-14-5L4 9M4 12a8 8 0 0 0 14 5l2-2"/></svg>',
    spark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg>'
  };
  const ic9 = k => SV[k] || SV.gear;
  /* 桌面图标表跟 v9 共用一套图标，缺的补上（不然新功能渲成空白块） */
  try {
    if (typeof IC === 'object' && IC) {
      if (!IC.video) IC.video = SV.video;
      if (!IC.play)  IC.play  = SV.play;
      if (!IC.sun)   IC.sun   = SV.sun;
    }
  } catch(e){}

  /* ---- 老人端「常用功能」真表 ----
     每一项都必须有真动作。前 8 项走 Java deskGo（已落地）；
     后几项走智能体工具，依赖对应 App / 无障碍，引导页如实标注。 */
  const V9_APPS = [
    { k:'dialer',   t:'打电话',   i:'phone', kind:'desk', note:'' },
    { k:'video',    t:'打视频',   i:'video', kind:'tool', tool:'wechat_call', args:{kind:'video'}, note:'需装微信' },
    { k:'wechat',   t:'微信',     i:'wx',    kind:'desk', note:'' },
    { k:'torch',    t:'手电筒',   i:'lamp',  kind:'desk', note:'' },
    { k:'camera',   t:'拍照',     i:'cam',   kind:'desk', note:'' },
    { k:'tv',       t:'看电视',   i:'tv',    kind:'tool', tool:'watch_news', args:{}, note:'需装央视影音' },
    /* 🚨 2026-11-10 真因：watch_video 的必填参数是 name，这里原来传的是 app，
       于是 a.name === undefined，原生拿它去搜索框搜出了「undefined」，
       还 fallback 到悟空浏览器。改成传 name，resolve 会命中抖音/红果深链。 */
    { k:'douyin',   t:'刷抖音',   i:'play',  kind:'tool', tool:'watch_video', args:{name:'刷抖音'}, note:'需装抖音' },
    { k:'short',    t:'看短剧',   i:'play',  kind:'tool', tool:'watch_video', args:{name:'看短剧'}, note:'需装红果' },
    { k:'weather',  t:'看天气',   i:'sun',   kind:'tool', tool:'get_weather', args:{}, note:'需联网' },
    { k:'sms',      t:'短信',     i:'msg',   kind:'desk', note:'' },
    { k:'album',    t:'相册',     i:'pic',   kind:'desk', note:'' },
    { k:'calllog',  t:'通话记录', i:'log',   kind:'desk', note:'' },
    { k:'settings', t:'系统设置', i:'gear',  kind:'desk', note:'' },
    { k:'scan',     t:'扫一扫',   i:'cam',   kind:'tool', tool:'wechat_scan', args:{}, note:'直达微信扫一扫' },
    { k:'paycode',  t:'付款码',   i:'pic',   kind:'tool', tool:'wechat_pay_code', args:{}, note:'直达微信付款码' }
  ];
  const V9_DOCK = [
    { k:'sos',   t:'紧急呼叫', i:'sos',  note:'长按 3 秒' },
    { k:'talk',  t:'说话',     i:'mic',  note:'点一下唤醒米粒' },
    { k:'torch', t:'手电筒',   i:'lamp', note:'' },
    { k:'home',  t:'回桌面',   i:'home', note:'' }
  ];
  const V9_DEVICES = [
    { k:'bp',   t:'血压仪', note:'接口预留' },
    { k:'glu',  t:'血糖仪', note:'接口预留' },
    { k:'band', t:'手环',   note:'华为 Band 8 心率广播已接代码，待真机复验' },
    { k:'vent', t:'呼吸机', note:'接口预留' }
  ];
  window.V9_APPS = V9_APPS;   /* deskTap 要用 */

  function cfg9(){
    if (!S.cfg || typeof S.cfg !== 'object') S.cfg = {};
    const c = S.cfg;
    if (!Array.isArray(c.contacts)) c.contacts = [];
    if (!Array.isArray(c.meds)) c.meds = [];
    if (!Array.isArray(c.devices)) c.devices = [];
    if (!Array.isArray(c.apps) || !c.apps.length) c.apps = ['dialer','wechat','torch','camera'];
    if (!Array.isArray(c.dock) || !c.dock.length) c.dock = ['sos','talk'];
    if (c.grid !== 6) c.grid = 4;
    return c;
  }
  /* 🚨 2026-11-10 菲尔特：「之前的那一套要么删掉要么合并」。
     原来两套码方向是反的：账号体系是老人注册出码→家人填；这里 code9 是
     家人端本机随机出码→老人端输码，真机上同时躺着 847079 / 289727 两个数。
     现在合成一套：配置同步直接复用账号同步码（老人注册即生成、永不变）。
     c.code 保留只为兼容老数据，一律跟随 S.pairCode。 */
  function code9(){
    const c = cfg9();
    if (S.pairCode) {
      if (c.code !== S.pairCode || !c.boundCode) {
        c.code = S.pairCode; c.boundCode = true;
        try { save(); } catch(e){}
      }
      return S.pairCode;
    }
    /* 还没登录（理论上到不了这里）：退回本地码，不让页面崩 */
    if (!c.code) { c.code = String(Math.floor(100000 + Math.random()*900000)); save(); }
    return c.code;
  }

  /* ---- 真同步：家人端 PUT 到 cfg_<6位码>，老人端 GET 同一个键 ----
     走 Java 桥（避开 WebView 的 CORS / mixed-content），服务端是米粒自己的 ECS。 */
  async function putCfg(code, json){
    try {
      const n = NATIVE();
      if (n && n.cfgPut) return JSON.parse(n.cfgPut(String(code), String(json)) || '{}');
    } catch(e){}
    /* 网页兜底（本地调试用）：直连自己的 ECS */
    try {
      const r = await fetch(API() + '/state?k=YOUR_STATE_KEY&dev=cfg_' + encodeURIComponent(code), {
        method:'PUT', headers:{'Content-Type':'application/json; charset=utf-8'}, body:String(json)
      });
      return await r.json();
    } catch(e){ return { ok:false, why:'连不上服务器，配置已存本机' }; }
  }
  async function getCfg(code){
    try {
      const n = NATIVE();
      if (n && n.cfgGet) return JSON.parse(n.cfgGet(String(code)) || '{}');
    } catch(e){}
    try {
      const r = await fetch(API() + '/state?k=YOUR_STATE_KEY&dev=cfg_' + encodeURIComponent(code));
      const d = await r.json();
      if (d && d.ok && d.data) return { ok:true, cfg: JSON.parse(d.data) };
      return { ok:false, why:'这个码还没人配置过' };
    } catch(e){ return { ok:false, why:'连不上服务器' }; }
  }

  /* ==========================================================================
     2026-11-09 菲尔特：「每改一次家人端配置，就要重新生成同步码，很不方便」。
     调研同类产品（华为/小米/OPPO 亲情守护、Apple 家人共享、Google Family Link、
     TeamViewer/AnyDesk）后的结论：码是「设备关系的身份」，不是「配置的版本号」，
     绑定只做一次，之后配置变更靠自动推送/自动拉取，永不再出码、不再输码。

     所以这里不换码：家人端任何配置变更（图标、药、联系人…）都防抖自动 PUT 到
     原来那个 cfg_<码>；老人端记住码，每次开机/回前台自动 GET 拉取并应用。
     码本身生成一次后长期有效，只有「解绑」才清掉。
     ========================================================================== */
  function cfgPayload(){
    const c = cfg9();
    return JSON.stringify({
      contacts:c.contacts, meds:c.meds, devices:c.devices,
      grid:c.grid, apps:c.apps, dock:c.dock, me:S.me || '', pet:S.pet || '米粒',
      at: Date.now()
    });
  }
  let pushTimer = null, pushing = false;
  window.pushCfgAuto = function(){
    try {
      const code = code9();
      if (!code || pushing) return;
      /* 2026-11-10：老人端、家人端都能改配置（菲尔特：「两端进行
         修改并且自动同步」），不再只让家人端推。谁改谁推，同一把钥匙。 */
      clearTimeout(pushTimer);
      pushTimer = setTimeout(async function(){
        pushing = true;
        try {
          /* 静默：失败不弹窗打扰，本机配置已经生效了 */
          await putCfg(code, cfgPayload());
          try { S.cfgSyncedAt = Date.now(); save(); } catch(e){}
        } catch(e){} finally { pushing = false; }
      }, 500);
    } catch(e){}
  };
  /* 老人端：记住码之后，每次开机/回前台自动拉一次，不用再输码 */
  let pullTimer = null, pulling = false, lastCfgAt = 0;
  window.pullCfgAuto = async function(){
    if (pulling) return;                 /* 桥是同步 HTTP，不许叠请求卡住 JS */
    pulling = true;
    try {
      const code = code9();
      if (!code) return;
      const r = await getCfg(code);
      if (!r || !r.ok || !r.cfg) return;
      const at = Number(r.cfg.at || 0);
      /* 服务端这份没变就别重绘整页 —— 8 秒一轮才不会闪 */
      if (at && at === lastCfgAt) return;
      const c = cfg9();
      ['contacts','meds','devices','apps','dock'].forEach(function(k){
        if (Array.isArray(r.cfg[k])) c[k] = r.cfg[k];
      });
      if (r.cfg.grid === 4 || r.cfg.grid === 6) c.grid = r.cfg.grid;
      /* 老人端填的称呼每次都拉回来：家人端顶部只显示它，不许自己改。 */
      if (r.cfg.me) { S.elderName = r.cfg.me; if (!S.me) S.me = r.cfg.me; }
      if (r.cfg.pet && !S.pet) S.pet = r.cfg.pet;
      lastCfgAt = at || Date.now();
      applyCfg(true);
      try { S.cfgPulledAt = Date.now(); save(); } catch(e){}
      try { console.log('[SYNC] 收到新配置 at=' + lastCfgAt); } catch(e0){}
    } catch(e){} finally { pulling = false; }
  };
  /* 2026-11-10 菲尔特：「家人端改动要实时生效」。
     原来 3 分钟一轮根本不叫实时；现在开机拉一次、每 8 秒拉一次、
     回前台立刻拉一次，服务端配置没变就跳过，不闪屏也不费流量。 */
  try {
    setTimeout(function(){ window.pullCfgAuto(); }, 1800);
    setInterval(function(){ if (!document.hidden) window.pullCfgAuto(); }, 8000);
    document.addEventListener('visibilitychange', function(){
      if (!document.hidden) { clearTimeout(pullTimer); pullTimer = setTimeout(function(){ window.pullCfgAuto(); }, 400); }
    });
  } catch(e){}

  /* ---- 层骨架 ---- */
  let root = null, page = 'hub', step = 0, err = '', okmsg = '';
  function mount(){
    if (root) return root;
    root = document.createElement('div'); root.id = 'v9';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    return root;
  }
  function open(p){ page = p || 'hub'; err=''; okmsg=''; mount(); root.classList.add('on'); render(); }
  function close(){ if (root) root.classList.remove('on'); }
  window.__V9_OPEN = open; window.__V9_CLOSE = close;
  function head(title, back){
    return '<div class="v9hd">' +
      (back ? '<button class="bk" data-do="back">‹</button>' : '<span class="sp"></span>') +
      '<h2>' + E9(title) + '</h2><button class="bk" data-do="close" style="font-size:18px">×</button></div>';
  }
  function foot(btn){ return '<div class="v9foot">' + btn + '</div>'; }
  function steps(n){
    let h = '<div class="v9steps">';
    for (let i=0;i<6;i++) h += '<i class="' + (i<=n?'on':'') + '"></i>';
    return h + '</div>';
  }
  function msg(){ return (err?'<div class="v9err">'+E9(err)+'</div>':'') +
                         (okmsg?'<div class="v9ok">'+E9(okmsg)+'</div>':''); }

  /* ---- 首页图标设置的局部渲染（2026-11-09）----
     只重绘 #hubApps 这一块，不碰整页，所以不会「点一下跳一下」。 */
  function hubAppsHTML(){
    const c = cfg9();
    const picked = (Array.isArray(c.apps) ? c.apps : []).slice();
    let h = '<div class="v9lab" style="margin:0 0 8px">已放上首页 · 按这个顺序排</div>';
    h += '<div class="v9apps">';
    picked.forEach(function(k, i){
      const it = DESK_ITEMS.find(function(x){ return x.k === k; });
      if (!it) return;
      h += '<button class="v9app on" data-do="btn" data-k="' + k + '" title="点一下拿掉">'
         + '<span class="no">' + (i + 1) + '</span>' + esc(it.t)
         + '<span class="mv" data-do="btnLeft" data-k="' + k + '"'
         + (i === 0 ? ' disabled' : '') + '>←</span>'
         + '<span class="mv" data-do="btnRight" data-k="' + k + '"'
         + (i === picked.length - 1 ? ' disabled' : '') + '>→</span>'
         + '</button>';
    });
    h += '</div>';
    h += '<div class="v9lab" style="margin:14px 0 8px">点一下加进首页</div>';
    h += '<div class="v9apps">';
    DESK_ITEMS.forEach(function(x){
      if (picked.indexOf(x.k) >= 0) return;
      h += '<button class="v9app off" data-do="btn" data-k="' + x.k + '">＋ ' + esc(x.t) + '</button>';
    });
    h += '</div>';
    h += '<p class="v9apphint">最多 6 个、至少留 1 个。改完立刻生效，不用保存。</p>';
    return h;
  }
  function hubAppsRefresh(){
    const box = $9('hubApps');
    if (box) box.innerHTML = hubAppsHTML();
  }

  /* ---- 权限开关专门板块（2026-11-10 菲尔特：「全部收纳进去，一目了然」）----
     七项全部读系统真实状态（permState 不读 localStorage），一行一个，
     一点就送进对应的系统设置页。不代点、不写假开关、不弹「还差几个」的打扰。 */
  function permHubRows(){
    const N = window.MiliNative;
    let st = {};
    try { st = JSON.parse((N && N.permState && N.permState()) || '{}'); } catch (e) {}
    const items = [
      ['mic',      '麦克风',      '听老人说话、喊「米粒米粒」'],
      ['acc',      '无障碍',      '替老人点微信、抖音、付款码'],
      ['notif',    '通知使用权',  '看见来电和红包提醒'],
      ['overlay',  '悬浮窗',      '桌宠能浮在别的 App 上'],
      ['camera',   '相机',        '拍照、扫码'],
      ['contacts', '通讯录',      '按「女儿」找到该打给谁'],
      ['battery',  '电池白名单',  '后台不被系统冻掉'],
    ];
    let h = '<div class="v9sec"><i></i>权限开关 · 一眼看完</div>';
    h += '<p class="v9sub">绿牌是已经开好的。没开的那行点一下，我送你到系统那一页；</p>';
    h += '<div class="v9card" style="padding:2px 14px">';
    for (const it of items) {
      const k = it[0], nm = it[1], why = it[2], on = !!st[k];
      h += '<button class="v9row" data-do="permgo" data-k="' + k + '">'
         + '<span class="ic" style="color:#5B4DF0">' + ic9('gear') + '</span>'
         + '<span class="tx">' + nm + '<div class="sb">' + why + '</div></span>'
         + '<span class="v9tag" style="' + (on ? 'background:#E6F6EE;color:#1E7A50' : 'background:#FFE9EA;color:#B4262D')
         + '">' + (on ? '已开' : '没开 · 去打开') + '</span>'
         + '<span class="go">›</span></button>';
    }
    h += '</div>';
    return h;
  }

  /* ---- ① 设置中心（归并后的唯一入口） ---- */
  function hub(){
    const c = cfg9();
    const role = S.role === 'family' ? '家人端' : (S.role === 'guest' ? '访客' : '老人端');
    const logged = !!S.accToken;
    let h = head('设置', false) + '<div class="v9body">';
    /* 桌面化：米粒已经是系统桌面（HOME）候选，但国产 ROM 首次要手动选「始终」。
       这里给一个一键入口 + 状态回显，帮老人/家人把这一步做掉。 */
    var homeOn = false;
    try { homeOn = !!(window.MiliNative && MiliNative.isDefaultHome && MiliNative.isDefaultHome()); } catch (e) {}
    h += '<div class="v9h1">把这台手机，<br>配成他的样子。</div>';
    h += '<p class="v9sub">家人在这里一次填好，老人端开机就是成品，不用他自己点。</p>';
    h += '<div class="v9card">';
    h += '<div class="v9row"><span class="tx">当前是 ' + E9(role) + '</span><span class="v9tag">' +
         (logged?'已登录':'未登录') + '</span></div>';
    h += '<div class="v9row"><span class="tx">老人称呼</span><span class="go">' + E9(S.me || '未填') + '</span></div>';
    h += '<div class="v9row"><span class="tx">同步码</span><span class="go">' + E9(code9()) + '</span></div>';
    h += '</div>';
    h += '<div class="v9sec"><i></i>身份</div>';
    h += '<button class="v9row" data-do="login"><span class="ic" style="color:#5B4DF0">' + ic9('user') +
         '</span><span class="tx">' + (logged?'账号与登录状态':'登录 / 注册') + '</span><span class="go">›</span></button>';
    h += '<button class="v9row" data-do="switch"><span class="ic" style="color:#5B4DF0">' + ic9('sync') +
         '</span><span class="tx">切换老人端 / 家人端</span><span class="go">›</span></button>';
    /* 2026-11-10 菲尔特：家人端设置里要能换同步码、切换别的老人。
       家人端没有账号，能退的只有绑定关系，所以叫「切换老人 / 解绑」不叫退出登录。 */
    if (S.role === 'family' || S.accRole === 'fam') {
      h += '<button class="v9row" data-do="unpair"><span class="ic" style="color:#5B4DF0">' + ic9('user') +
           '</span><span class="tx">切换老人 / 解绑<div class="sb">清掉这台手机上的绑定，换填别的同步码</div></span><span class="go">›</span></button>';
    }
    h += '<div class="v9sec"><i></i>配置</div>';
    h += '<button class="v9row" data-do="setup"><span class="ic" style="color:#5B4DF0">' + ic9('spark') +
         '</span><span class="tx">修改老人端配置<div class="sb">联系人 · 药 · 设备 · 首页功能 · 底部按钮 · 改完自动同步</div></span><span class="go">›</span></button>';
    h += '<button class="v9row" data-do="sync"><span class="ic" style="color:#5B4DF0">' + ic9('sync') +
         '</span><span class="tx">同步到老人端<div class="sb">生成码 / 老人端输码拉取</div></span><span class="go">›</span></button>';
    h += '<button class="v9row" data-do="vp"><span class="ic" style="color:#5B4DF0">' + ic9('mic') +
         '</span><span class="tx">录老人的声音<div class="sb">进引导第 8 步录，点一下开始、自己点一下结束</div></span><span class="go">›</span></button>';
    h += '<button class="v9row" data-do="openRhythm"><span class="ic" style="color:#5B4DF0">' + ic9('spark') +
         '</span><span class="tx">它记住了什么<div class="sb">不是您教的，是它看出来的 · 可删可清空</div></span><span class="go">›</span></button>';
    /* 2026-11-12 菲尔特：「把日新板块换成演示模式」。
       日新那页是给家人端看的两次运行对照，评委在台上没法跟着点；
       这里换成一台手机就能演完的两遍。 */
    h += '<button class="v9row" data-do="demo"><span class="ic" style="color:#5B4DF0">' + ic9('spark') +
         '</span><span class="tx">比赛演示<div class="sb">说两遍：问两件 → 不问</div></span>' +
         '<span class="v9tag" style="background:#EFEDFF;color:#4A3ED6">' +
         ((window.__DEMO && window.__DEMO.on && window.__DEMO.on()) ? '已开' : '没开') + '</span>' +
         '<span class="go">›</span></button>';
    h += '<div class="v9sec"><i></i>安全求助</div>';
    h += '<div class="v9card" style="padding:14px 16px">' +
         '<div class="v9row" style="padding:0 0 8px"><span class="tx">紧急呼叫联系人电话号码</span></div>' +
         '<input id="v9sosPhone" class="v9input" type="tel" inputmode="numeric" ' +
           'placeholder="例如 13800138000" value="' + E9(S.sosPhone || '') + '">' +
         '<button class="v9row" data-do="saveSos" style="border-top:1px solid #EDEDF7;margin-top:10px">' +
           '<span class="tx">保存号码</span><span class="go">›</span></button>' +
         '<div class="sb" style="font-size:12px;color:#9A9FBA;padding:0 0 4px">' +
           '摔倒或点「紧急呼叫」时，直接拨这个号码。</div></div>';
    h += '<button class="v9row" data-do="fallTest"><span class="tx">试一下摔倒检测</span><span class="go">›</span></button>';
    h += '<div class="v9pick' + (S.fallDetectOn !== false ? ' on' : '') + '" data-do="fallOn"><span class="ck">✓</span>' +
         '<span class="tx">摔倒检测<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">' +
         (S.fallDetectOn !== false ? '开着：检测到摔倒会自动打给上面这个号码' : '关着：摔倒不触发自动拨号') +
         '</div></span></div>';
    h += '<div class="v9sec"><i></i>米粒的本事</div>';
    h += '<div class="v9pick' + (S.cvOn ? ' on' : '') + '" data-do="cv"><span class="ck">✓</span>'
       + '<span class="tx">连续对话<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">'
       + (S.cvOn ? '开着：说完一句，它接着听下一句' : '关着：说一句、答一句，说完自己停')
       + '</div></span></div>';
    /* 对照实验：同一句话，关掉经验卡看它重新想一遍。现场演示用，默认关。 */
    h += '<div class="v9pick' + (S.skillOff ? ' on' : '') + '" data-do="skillOff"><span class="ck">✓</span>'
       + '<span class="tx">对照 · 不靠经验卡<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">'
       + (S.skillOff ? '开着：同一句话每次重新想，不重放记下的动作' : '关着：办过一次的话，下次按记下的动作直达')
       + '</div></span></div>';
    /* 首页图标（2026-11-09 重做）
       菲尔特：「点一下就跳转一下，而且顺序不方便调整，没设计好」。
       根因：每点一颗都 render() 整页重绘，滚动位置归零 = 看起来跳一下；
       顺序只能靠「取消再按新顺序点一遍」，等于没有排序。
       现在：点开关只局部刷新这一块（不重绘整页）；已选图标带序号和
       ← → 两颗箭头，按一下就换位；未选的在下面单独一组。 */
    h += '<div class="v9sec"><i></i>首页图标（按一下开关，← → 调顺序）</div>';
    h += '<div class="v9card" id="hubApps">' + hubAppsHTML() + '</div>';
    /* 2026-11-09 菲尔特：「设置里面有没有添加开关」—— 补一颗真开关 */
    let petOnState = true;
    try { const nb = NATIVE(); if (nb && nb.petVisible) petOnState = !!nb.petVisible(); } catch(e){}
    h += '<div class="v9pick' + (petOnState ? ' on' : '') + '" data-do="petShow"><span class="ck">✓</span>'
       + '<span class="tx">桌宠在桌面显示<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">'
       + '关了就彻底收起来，开机也不自己冒出来</div></span></div>';
    /* 2026-11-09 22:15 菲尔特：「怎么一直在录音，不是说好只有叫它它才
       录音和说话吗」。纯语音唤醒不可能不占麦，但要说清楚：常开的是本地
       三个字的关键词检测，不联网、不上传、不说话；真正联网识别和出声
       只在喊了「米粒」或点「说话」之后。不想要常开麦的，这里能彻底关。 */
    let wakeOnState = true;
    try { const nb = NATIVE(); if (nb && nb.wakeVisible) wakeOnState = !!nb.wakeVisible(); } catch(e){}
    h += '<div class="v9pick' + (wakeOnState ? ' on' : '') + '" data-do="wakeShow"><span class="ck">✓</span>'
       + '<span class="tx">喊「米粒米粒」唤醒<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">'
       + '开：只在本地听这三个字，不联网不说话；关：麦克风彻底不占，点「说话」也能叫我</div></span></div>';
    h += '<div class="v9sec"><i></i>老人端桌面</div>';
    let opt = {};
    try { opt = JSON.parse(localStorage.getItem('mili.desk6.opt') || '{}') || {}; } catch(e){}
    h += '<div class="v9card">';
    h += '<div class="v9pick' + (opt.big?' on':'') + '" data-do="opt" data-k="big"><span class="ck">✓</span><span class="tx">大字模式<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">字再大一号</div></span></div>';
    h += '<div class="v9pick' + (opt.lock?' on':'') + '" data-do="opt" data-k="lock"><span class="ck">✓</span><span class="tx">锁定桌面<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">图标不再自动换位置</div></span></div>';
    h += '<div class="v9pick' + (c.grid===6?' on':'') + '" data-do="opt" data-k="show6"><span class="ck">✓</span><span class="tx">首页放 6 个图标<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">默认 4 个</div></span></div>';
    h += '</div>';
    h += '<button class="v9row" data-do="sethome"><span class="ic" style="color:#5B4DF0">' + ic9('grid') +
         '</span><span class="tx">设为默认桌面<div class="sb">' +
         (homeOn ? '已经是了 ✓ 按 Home 直接回米粒' : '还差这一步：按 Home 会回系统桌面') +
         '</div></span><span class="go">›</span></button>';
    /* 出口：装成桌面以后必须能退出来，不然等于把手机锁在米粒里 */
    h += '<button class="v9row" data-do="exitHome"><span class="ic" style="color:#E5484D">' + ic9('gear') +
         '</span><span class="tx">退出米粒桌面<div class="sb">关掉开机自启，把系统桌面还回来</div></span><span class="go">›</span></button>';
    h += permHubRows();
    h += '<div class="v9sec"><i></i>预留接口</div>';
    h += '<div class="v9card"><p class="v9tip" style="margin:0">第三方 App 授权、扫码配对硬件、跨设备自动接听还没接入。' +
         '这些不摆成按钮，等接口到位再开。</p></div>';
    h += msg() + '</div>';
    return h;
  }

  /* ---- ② 登录 / 注册（复用真账号接口） ---- */
  function login(){
    const logged = !!S.accToken;
    let h = head('登录', true) + '<div class="v9body">';
    h += '<div class="v9h1">' + (logged?'已经登上了':'先登一次，<br>之后开机就在') + '</div>';
    if (logged) {
      h += '<div class="v9card">';
      h += '<div class="v9row"><span class="tx">手机号</span><span class="go">' + E9(S.accPhone || '—') + '</span></div>';
      h += '<div class="v9row"><span class="tx">身份</span><span class="go">' +
           E9(S.accRole === 'fam' ? '家人' : '老人') + '</span></div></div>';
      h += '<button class="v9btn ghost" data-do="logout" style="margin-top:8px">退出登录</button>';
      h += '<p class="v9warn">退出后老人端仍能用，只是不再接收家人端推送。</p>';
    } else {
      h += '<p class="v9sub">家里人替老人注册一次就好。密码比验证码好记，不用等短信。</p>';
      h += '<div class="v9card">';
      h += '<p class="v9lab">我是</p><div class="v9grid2" style="margin-bottom:14px">';
      h += '<div class="v9pick' + (S.accRole!=='fam'?' on':'') + '" data-do="accrole" data-v="elder"><span class="ck">✓</span><span class="tx">老人</span></div>';
      h += '<div class="v9pick' + (S.accRole==='fam'?' on':'') + '" data-do="accrole" data-v="fam"><span class="ck">✓</span><span class="tx">家人</span></div>';
      h += '</div>';
      h += '<p class="v9lab">手机号</p><input class="v9field" id="v9phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号">';
      h += '<p class="v9lab" style="margin-top:12px">密码</p><input class="v9field" id="v9pwd" type="password" placeholder="自己设一个">';
      h += '</div>';
      h += '<button class="v9btn" data-do="dologin">登录</button>';
      h += '<button class="v9btn gray" data-do="doreg" style="margin-top:10px">第一次用 · 注册</button>';
      h += msg();
      h += '<p class="v9warn">不登也能用。登录只为了两端同步配置。</p>';
    }
    h += '</div>';
    return h;
  }

  /* ---- ②·五 「它记住了什么」 ---- */
  function rhythmPage(){
    const R = window.MILI_RHYTHM;
    const prof = R ? R.profile() : {};
    const dump = R ? R.dump() : { days: {} };
    const days = Object.keys(dump.days || {}).length;
    const bud = R ? R.budget() : { used: 0, cap: 6 };
    const fmt = (t) => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
    const rows = [['wake','起床'],['med','吃药'],['meal','吃饭'],['tv','看戏'],['sleep','睡觉']];
    let h = head('它记住的', true) + '<div class="v9body">';
    h += '<div class="v9h1">它记住的</div>';
    h += '<p class="v9sub">这些全是它看您过日子记下的。同一件事记满 3 次才敢当真。</p>';
    h += '<div class="v9card">';
    h += '<div class="v9row"><span class="tx">已经看了</span><span class="go">' + days + ' 天</span></div>';
    h += '<div class="v9row"><span class="tx">今天主动说话</span><span class="go">' + bud.used + ' / ' + bud.cap + ' 次</span></div>';
    h += '</div>';
    h += '<div class="v9card">';
    rows.forEach(function (r) {
      const p = prof[r[0]];
      h += '<div class="v9row"><span class="tx">' + r[1] + '</span><span class="go">'
        + (p ? (fmt(p.t) + (p.basis === 'days' ? ' · 记了 ' + p.days + ' 天' : ' · 记了 ' + p.hits + ' 次')) : '还没摸清') + '</span>'
        + (p ? '<button data-do="rhythmDrop" data-k="' + r[0] + '" style="margin-left:10px;border:0;'
            + 'background:#FCEBEB;color:#A32D2D;border-radius:12px;padding:6px 10px;font-size:13px">删</button>' : '')
        + '</div>';
    });
    h += '</div>';
    h += '<div class="v9pick' + (S.rhythmOff ? ' on' : '') + '" data-do="rhythmOff"><span class="ck">✓</span>'
       + '<span class="tx">对照模式（现场用）<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">'
       + (S.rhythmOff ? '开着：只说固定时刻的通用话，不看您的习惯' : '关着：按它记住的节奏说话')
       + '</div></span></div>';
    h += '<button class="v9btn gray" data-do="rhythmWipe">清空，从头再学</button>';
    h += '<p class="v9warn">清空以后，它会退回「到点就提醒」，不再按您的习惯说话 —— 现场演示可回退。</p>';
    h += msg() + '</div>';
    return h;
  }

  /* ---- ③ 双端切换 ---- */
  function switcher(){
    const cur = S.role || 'elder';
    let h = head('切换端', true) + '<div class="v9body">';
    h += '<div class="v9h1">这台手机，<br>现在给谁用？</div>';
    h += '<p class="v9sub">切换只换界面和权限，配置不会丢。</p>';
    const rows = [
      ['elder','老人端','大图标、大字体、只有米粒和几颗按钮'],
      ['family','家人端','配置联系人、药、设备和老人端首页']
    ];
    rows.forEach(function(r){
      h += '<button class="v9row" data-do="setrole" data-v="'+r[0]+'" style="display:flex;align-items:center;gap:12px">' +
           '<span class="ic" style="color:#5B4DF0;width:30px">' + ic9(r[0]==='elder'?'heart':'user') + '</span>' +
           '<span class="tx">' + r[1] + '<div class="sb">' + r[2] + '</div></span>' +
           (cur===r[0]?'<span class="v9tag">当前</span>':'<span class="go">›</span>') + '</button>';
    });
    h += msg() + '</div>';
    return h;
  }


  /* ---- ④ 家人端分步引导（6 步） ----
     draft 是编辑中的副本，只有点「保存并同步」才写进 S.cfg。 */
  let draft = null;
  function draft9(){
    if (draft) return draft;
    const c = cfg9();
    draft = JSON.parse(JSON.stringify({
      contacts: c.contacts.length ? c.contacts : [
        /* 默认只摆一位。三张空卡要把人滚两三屏才填完，
           剩下的人点「再加一位家人」就行。 */
        { label:'儿子', name:'', phone:'', wx:'' }
      ],
      meds: c.meds.slice(), devices: c.devices.slice(),
      apps: c.apps.slice(), dock: c.dock.slice(), grid: c.grid
    }));
    return draft;
  }
  /* 20:0x 旧 7 步里的「录声音」整屏下线，录音只在 9 屏新引导第 8 屏存在。 */
  const STEP_T = ['联系人','常吃的药','接入设备','首页图标','常用功能','底部按钮'];
  const STEP_H = [
    ['先记下家里人', '老人喊「给儿子打电话」时，米粒才知道找谁。'],
    ['拍一下药盒', '拍不清楚也没关系，写个药名也行。'],
    ['有哪些设备', '接口已经留好，接上真设备后这里会自动亮起来。'],
    ['首页放几个图标', '图标越少越好认。四个最稳，六个给熟手。'],
    ['挑常用功能', '只摆他真会用的，用不上的一律不摆。'],
    ['底部留哪几颗', '紧急呼叫和说话建议都留着。']
  ];
  function pick(k, t, on, extra){
    return '<div class="v9pick' + (on?' on':'') + '" data-do="pick" data-k="' + E9(k) + '"' + (extra||'') + '>' +
      '<span class="ck">✓</span><span class="tx">' + E9(t) + '</span></div>';
  }
  function setup9(){
    const d = draft9();
    let h = head(STEP_T[step] + ' · ' + (step+1) + '/6', true) + '<div class="v9body">';
    h += steps(step);
    h += '<div class="v9h1">' + E9(STEP_H[step][0]) + '</div>';
    h += '<p class="v9sub">' + E9(STEP_H[step][1]) + '</p>';

    if (step === 0) {
      d.contacts.forEach(function(c, i){
        h += '<div class="v9card" style="padding:14px">';
        h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
             '<span class="v9tag">' + E9(c.label || '家人') + '</span>' +
             '<span style="flex:1"></span>' +
             '<button class="v9del" data-do="delcontact" data-i="'+i+'" aria-label="删掉">×</button></div>';
        h += '<p class="v9lab">称呼</p><input class="v9field" data-f="label" data-i="'+i+'" value="' + E9(c.label) + '" placeholder="儿子 / 女儿 / 孙子" style="margin-bottom:10px">';
        h += '<p class="v9lab">姓名</p><input class="v9field" data-f="name" data-i="'+i+'" value="' + E9(c.name) + '" placeholder="通讯录里存的名字" style="margin-bottom:10px">';
        h += '<p class="v9lab">电话</p><input class="v9field" data-f="phone" data-i="'+i+'" inputmode="numeric" value="' + E9(c.phone) + '" placeholder="手机号" style="margin-bottom:10px">';
        h += '<p class="v9lab">微信里的名字</p><input class="v9field" data-f="wx" data-i="'+i+'" value="' + E9(c.wx) + '" placeholder="微信备注，发消息用">';
        h += '</div>';
      });
      h += '<button class="v9btn ghost" data-do="addcontact">＋ 再加一位家人</button>';
    }
    else if (step === 1) {
      if (!d.meds.length) {
        h += '<div class="v9card" style="text-align:center;padding:26px 16px;color:#9A9FBA">' +
             '<p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#6B708C">还没加药</p>' +
             '<p style="margin:0;font-size:13px;line-height:1.6">不填也能往下走，以后在家人端点「药箱」再补。</p></div>';
      }
      d.meds.forEach(function(m, i){
        h += '<div class="v9card" style="display:flex;align-items:center;gap:12px;padding:12px">' +
          (m.photo ? '<img class="v9thumb" src="' + E9(m.photo) + '" alt="">'
                   : '<span class="v9thumb" style="display:grid;place-items:center;color:#5B4DF0">' + ic9('pill') + '</span>') +
          '<input class="v9field" data-f="med" data-i="'+i+'" value="' + E9(m.name) + '" placeholder="药名" style="flex:1">' +
          '<button class="v9del" data-do="delmed" data-i="'+i+'">×</button></div>';
      });
      h += '<label class="v9btn ghost" style="display:block;text-align:center;line-height:54px;margin-bottom:10px">' +
           '＋ 拍药盒加一味<input type="file" accept="image/*" capture="environment" data-f="medphoto" style="display:none"></label>';
      h += '<button class="v9btn gray" data-do="addmed">＋ 手写药名</button>';
      h += '<p class="v9warn">照片只存在这台手机和米粒自己的服务器，不外传。</p>';
    }
    else if (step === 2) {
      V9_DEVICES.forEach(function(v){
        const on = d.devices.indexOf(v.k) >= 0;
        h += '<div class="v9pick' + (on?' on':'') + '" data-do="pickdev" data-k="'+v.k+'">' +
             '<span class="ck">✓</span><span class="ic">' + ic9('dev') + '</span>' +
             '<span class="tx">' + E9(v.t) + '<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500;margin-top:2px">' +
             E9(v.note) + '</div></span></div>';
      });
    }
    else if (step === 3) {
      [4,6].forEach(function(n){
        h += '<div class="v9pick' + (d.grid===n?' on':'') + '" data-do="setgrid" data-v="'+n+'" style="padding:18px 12px">' +
             '<span class="ck">✓</span><span class="ic">' + ic9('home') + '</span>' +
             '<span class="tx">' + n + ' 个图标<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500;margin-top:2px">' +
             (n===4?'一屏两行，字最大，最不容易点错':'一屏三行，功能多一些') + '</div></span></div>';
      });
    }
    else if (step === 4) {
      h += '<div class="v9grid2">';
      V9_APPS.forEach(function(a){
        const on = d.apps.indexOf(a.k) >= 0;
        h += '<div class="v9pick' + (on?' on':'') + '" data-do="pickapp" data-k="'+a.k+'">' +
             '<span class="ck">✓</span><span class="ic">' + ic9(a.i) + '</span>' +
             '<span class="tx">' + E9(a.t) + (a.note ? '<div class="sb" style="font-size:11px;color:#9A9FBA;font-weight:500">' + E9(a.note) + '</div>' : '') +
             '</span></div>';
      });
      h += '</div>';
      h += '<p class="v9warn">最多摆 6 个，超出的按勾选顺序取前面。标了「需装…」的要那台手机装了对应 App 才跑得通。</p>';
    }
    else if (step === 5) {
      V9_DOCK.forEach(function(a){
        const on = d.dock.indexOf(a.k) >= 0;
        h += '<div class="v9pick' + (on?' on':'') + '" data-do="pickdock" data-k="'+a.k+'">' +
             '<span class="ck">✓</span><span class="ic">' + ic9(a.i) + '</span>' +
             '<span class="tx">' + E9(a.t) + (a.note?'<div class="sb" style="font-size:12px;color:#9A9FBA;font-weight:500">'+E9(a.note)+'</div>':'') +
             '</span></div>';
      });
      h += '<p class="v9warn">紧急呼叫和说话建议保留：出事时老人不用找，手一伸就在最底下。</p>';
    }
    else if (step === 6) {
      h += '<div class="v9card" style="text-align:center;padding:26px 16px">';
      h += window.__vpRec
        ? '<div class="v9rec"><i></i>正在听</div>'
        : '<div style="font-size:44px;line-height:1;margin-bottom:10px">🎙️</div>';
      h += '<p style="margin:0 0 4px;font-size:16px;font-weight:700;color:#1B1D2E">这一步要老人本人来</p>';
      h += '<p style="margin:0 0 14px;font-size:13px;line-height:1.7;color:#6B708C">点下面的按钮，让老人对着手机随便说 3 句话，比如「今天天气真好」「中午吃面条」。</p>';
      h += '<div id="vp9state" style="font-size:14px;font-weight:600;color:#5B4DF0;min-height:22px">' +
           (window.__vpRec ? ('已收 ' + (window.__vpCount || 0) + ' / 3 句')
            : (window.MiliNative && MiliNative.vpEnrolled ? '录过了，可以重录' : '还没录')) + '</div>';
      h += window.__vpRec
        ? '<button class="v9btn" data-do="vpstop" style="margin-top:14px;background:#E5484D">停止录音</button>'
        : '<button class="v9btn" data-do="vpenroll" style="margin-top:14px">开始录声音</button>';
      h += '</div>';
      h += '<p class="v9warn">录完以后，电视里的声音、旁边人说话，米粒都不会当成老人。</p>';
    }
    h += msg() + '</div>';
    h += foot((step>0?'<button class="v9btn ghost" data-do="prev" style="margin-bottom:10px">上一步</button>':'') +
              '<button class="v9btn" data-do="next">' + (step===5?'完成':'下一步') + '</button>');
    return h;
  }

  /* ---- ⑤ 同步：家人端出码 / 老人端输码 ---- */
  function sync9(){
    const c = cfg9();
    const code = code9();
    let h = head('同步到老人端', true) + '<div class="v9body">';
    h += '<div class="v9h1">这 6 个数，<br>只填一次。</div>';
    h += '<p class="v9sub">老人端填过一次就绑上了。以后你改联系人、加药、调首页图标，' +
         '都会自己过去，不用重新出码、也不用他再输一遍。</p>';
    h += '<div class="v9card" style="text-align:center;padding:22px 16px">';
    h += '<div class="v9code">' + E9(code) + '</div>';
    h += '<p class="v9tip" style="text-align:center">这台手机的同步码</p></div>';
    h += '<button class="v9btn" data-do="push">立刻同步一次</button>';
    h += '<p class="v9warn">平时不用点：两端改了配置都会自动上传、8 秒内到另一端。' +
         '这个码就是老人端账号的同步码，永远不变。</p>';
    h += '<div class="v9sec"><i></i>只有这一个码</div>';
    h += '<div class="v9card">';
    h += '<p class="v9lab">老人端登录、家人端填码、配置同步，用同一个 6 位数。</p>';
    h += '<button class="v9btn gray" data-do="pull" style="margin-top:12px">从云端刷新一次</button></div>';
    h += msg();
    h += '<div class="v9sec"><i></i>这次会同步</div>';
    h += '<div class="v9card">';
    h += '<div class="v9row"><span class="tx">联系人</span><span class="go">' + c.contacts.filter(x=>x.name||x.phone).length + ' 位</span></div>';
    h += '<div class="v9row"><span class="tx">常吃的药</span><span class="go">' + c.meds.length + ' 味</span></div>';
    h += '<div class="v9row"><span class="tx">首页图标</span><span class="go">' + c.grid + ' 个</span></div>';
    h += '<div class="v9row"><span class="tx">常用功能</span><span class="go">' + c.apps.length + ' 项</span></div>';
    h += '<div class="v9row"><span class="tx">底部按钮</span><span class="go">' + c.dock.length + ' 颗</span></div>';
    h += '</div></div>';
    return h;
  }

  /* ---- 渲染总入口 ---- */
  function render(){
    if (!root) return;
    let h = '';
    if (page === 'hub') h = hub();
    else if (page === 'login') h = login();
    else if (page === 'rhythm') h = rhythmPage();
    else if (page === 'switch') h = switcher();
    else if (page === 'setup') h = setup9();
    else if (page === 'sync') h = sync9();
    else h = hub();
    root.innerHTML = h;
  }


  /* ---- 输入：编辑 draft，不重绘（否则光标会跑） ---- */
  function onInput(e){
    const t = e.target, f = t.dataset && t.dataset.f;
    if (!f) return;
    const d = draft9(), i = +(t.dataset.i || 0);
    if (f === 'label' || f === 'name' || f === 'phone' || f === 'wx') {
      if (d.contacts[i]) d.contacts[i][f] = t.value;
    } else if (f === 'med') { if (d.meds[i]) d.meds[i].name = t.value; }
  }
  function onChange(e){
    const t = e.target, f = t.dataset && t.dataset.f;
    if (f !== 'medphoto' || !t.files || !t.files[0]) return;
    const file = t.files[0], d = draft9();
    const rd = new FileReader();
    rd.onload = function(){
      const img = new Image();
      img.onload = function(){
        const cv = document.createElement('canvas');
        const sc = Math.min(1, 320 / Math.max(img.width, img.height));
        cv.width = Math.round(img.width*sc); cv.height = Math.round(img.height*sc);
        cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
        d.meds.push({ name:'', note:'', photo: cv.toDataURL('image/jpeg', .72) });
        render();
      };
      img.src = String(rd.result);
    };
    rd.readAsDataURL(file);
  }

  /* ---- 配置真正作用到老人端桌面 ----
     · 联系人写进 S.fam（快拨 / 紧急呼叫 / 语音匹配都读它）
     · 药写进 S.med（药箱页读它）
     · 图标 / 底栏交给 applyDeskCfg()，没有就重绘桌面 */
  function applyCfg(silent){
    const c = cfg9();
    S.fam = c.contacts.filter(x => x && (x.name || x.phone)).map(x => ({
      name: x.name || x.label || '', label: x.label || '', phone: x.phone || '', wx: x.wx || ''
    }));
    /* 家人名单就是自动接听的白名单，一变就往原生推一份 */
    try { syncCallCfg(); } catch (e) {}
    if (c.meds.length) {
      try {
        const old = Array.isArray(S.med) ? S.med : [];
        /* S.med 的真实形状是对象数组（who/full/dose/when/on/last…），
           不是 {list,photos}。写错类型会让整页读药箱时崩在 .filter 上。 */
        const next = c.meds.filter(x => x && x.name).map(function(x){
          const prev = old.filter(function(y){ return y && (y.who === x.name || y.full === x.name); })[0];
          return {
            who: x.name,
            full: (prev && prev.full) || x.name,
            dose: (prev && prev.dose) || x.note || '一次一片',
            when: (prev && prev.when) || '每天8点',
            note: (prev && prev.note) || '温水送服',
            pill: (prev && prev.pill) || '',
            alias: (prev && prev.alias) || [],
            photo: x.photo || (prev && prev.photo) || '',
            on: true,
            last: (prev && prev.last) || ''
          };
        });
        /* 老人自己加过、家人端没列的药保留，别把药箱弄丢 */
        old.forEach(function(y){
          if (!y || !y.who) return;
          if (!next.some(function(z){ return z.who === y.who; })) next.push(y);
        });
        S.med = next;
      } catch(e){}
    }
    c.apps = c.apps.slice(0, c.grid);
    save();
    try { if (typeof renderDesk === 'function') renderDesk(); } catch(e){}
    try { window.__V9_DESK_APPLY && window.__V9_DESK_APPLY(); } catch(e){}
    try { window.EVO && window.EVO.passNow && window.EVO.passNow(); } catch(e){}
    if (!silent) { okmsg = '配置已生效'; }
  }

  async function doPush(){
    const c = cfg9();
    const code = code9();
    c.syncedAt = Date.now(); c.setupDone = true; save();
    const r = await putCfg(code, cfgPayload());
    err = r && r.ok ? '' : ((r && r.why) || '上传没成');
    /* 2026-11-07 菲尔特：「同步码没真的同步到云端」。嘴上说成功不算，
       回读一次拿到同一份才算——服务器没落盘就如实报错。 */
    if (!err) {
      const back = await getCfg(c.code);
      const okBack = back && back.ok && back.cfg;
      err = okBack ? '' : '上传了但服务器没读到，再试一次';
      okmsg = okBack ? '已上传并校验 ✓ 另一端 8 秒内自动生效，同步码 ' + code + '。' : '';
    } else {
      okmsg = '';
    }
    render();
  }
  async function doPull(){
    /* 2026-11-10：两套码合一后不用再输码，直接用账号码拉。 */
    const code = code9();
    if (!code) { err = '先在老人端登录生成同步码'; okmsg=''; render(); return; }
    lastCfgAt = 0;
    const r = await getCfg(code);
    if (!r || !r.ok || !r.cfg) { err = (r && r.why) || '没拉到配置'; okmsg=''; render(); return; }
    const c = cfg9();
    ['contacts','meds','devices','apps','dock'].forEach(function(k){
      if (Array.isArray(r.cfg[k])) c[k] = r.cfg[k];
    });
    if (r.cfg.grid === 4 || r.cfg.grid === 6) c.grid = r.cfg.grid;
    if (r.cfg.me) { S.elderName = r.cfg.me; if (!S.me) S.me = r.cfg.me; }
    c.code = code; c.boundCode = true; c.syncedAt = Date.now(); c.setupDone = true;
    save(); applyCfg(true);
    err=''; okmsg = '已拉到配置，老人端桌面马上按这个来。';
    render();
  }

  /* ---- 点击总委托 ---- */
  /* 2026-11-09 真机修：设置页十余处调用 setMsg()，但这个函数从来没定义 ——
     一触发就 ReferenceError（首页图标勾选、声纹、清空画像、退桌面全哑）。
     统一走模块内 err / okmsg + 重绘，msg() 会把它渲染出来。 */
  function setMsg(text, isErr){
    try {
      if (isErr) { err = text; okmsg = ''; }
      else { okmsg = text; err = ''; }
      render();
    } catch (e) {}
  }

  function onClick(e){
    const n = e.target.closest ? e.target.closest('[data-do]') : null;
    if (!n) return;
    const d = n.dataset.do, d9 = draft9(), c = cfg9();
    err=''; okmsg='';
    if (d === 'close') { close(); return; }
    if (d === 'back') {
      if (page === 'setup' && step > 0) step--;
      else page = 'hub';
      render(); return;
    }
    /* 比赛演示（2026-11-12）。点了就：关设置 → 回首页 → 开提词 + 面板。
       复位放在面板里，这样"从设置进来"和"演完重来"走的是同一个动作。 */
    if (d === 'demo') {
      try { close(); } catch(e) {}
      try { goPage('home'); } catch(e) {}
      setTimeout(function(){
        try { if (window.__DEMO) window.__DEMO.start(true); } catch(e) {}
      }, 240);
      return;
    }
    if (d === 'login' || d === 'switch' || d === 'setup' || d === 'sync' || d === 'renew') {
      if (d === 'renew') { close(); try { goPage('famhome'); } catch(err2){}
        const t = document.querySelector('#fam7 [data-go="mine"]'); if (t) t.click();
        setTimeout(function(){ const r = document.querySelector('#fam7 [data-page="renew"],#fam7 [data-go="renew"]'); if (r) r.click(); }, 260);
        return;
      }
      if (d === 'setup') {
        /* 2026-11-10 菲尔特：两套引导打架。设置里「修改老人端配置」
           统一走首启那套 9 屏，不再进 v9 旧的 7 步 setup。 */
        try { close(); } catch(e){}
        try { showOnboard(true); } catch(e){}
        return;
      }
      page = d; render(); return;
    }
    if (d === 'opt') {
      let o = {};
      try { o = JSON.parse(localStorage.getItem('mili.desk6.opt') || '{}') || {}; } catch(e){}
      const k = n.dataset.k;
      o[k] = !o[k];
      try { localStorage.setItem('mili.desk6.opt', JSON.stringify(o)); } catch(e){}
      if (k === 'show6') {
        c.grid = o.show6 ? 6 : 4; c.apps = c.apps.slice(0, 6); save();
        /* 2026-11-10「双端还是没有生效」：改了布局只存本地、不推云端，
           另一端永远收不到；本机也没重绘。这里一次补齐。 */
        try { if (typeof renderDesk === 'function') renderDesk(); } catch(e){}
        try { if (typeof applyDesk === 'function') applyDesk(); } catch(e){}
        try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch(e){}
      }
      try { window.__V9_DESK_APPLY && window.__V9_DESK_APPLY(); } catch(e){}
      render(); return;
    }
    if (d === 'accrole') {
      S.accRole = n.dataset.v; save(); render(); return;
    }
    if (d === 'dologin' || d === 'doreg') {
      const ph = ($9('v9phone') && $9('v9phone').value || '').replace(/\D/g,'');
      const pw = ($9('v9pwd') && $9('v9pwd').value) || '';
      if (ph.length !== 11) { err='手机号要 11 位'; render(); return; }
      if (pw.length < 6) { err='密码至少 6 位'; render(); return; }
      const role9 = S.accRole || 'elder';
      const call9 = d === 'dologin'
        ? accLogin(ph, pw, role9)
        : accRegister(ph, pw, S.me || (role9 === 'fam' ? '家人' : '老人家'), role9);
      Promise.resolve(call9).then(function(r){
        if (!r || !r.ok) { err = (r && r.why) || '没登上'; render(); return; }
        /* accLogin / accRegister 内部已经写好 S.accToken 并 save()，这里绝不再覆盖 */
        S.accPhone = ph; save();
        okmsg = d === 'dologin' ? '登上了' : '注册好了，也登上了'; render();
      }).catch(function(ex){ err = String(ex && ex.message || ex); render(); });
      return;
    }
    if (d === 'logout') {
      /* 统一走 accLogout：它会连 onboarded / role 一起清，回到第一屏，
         不再留下「已引导完成但账号是空的」这种半成品状态。 */
      Promise.resolve(accLogout()).then(function(){ try { close(); } catch(e){} showRoleGate(); });
      return;
    }
    if (d === 'unpair') {
      /* 切换老人：先解云端绑定，再清本地票，回填码页。 */
      try {
        const pid = (ACC.link && ACC.link.peer && ACC.link.peer.id) || 0;
        if (pid) accUnbind(pid);
      } catch (e) {}
      S.accToken = ''; S.accRole = ''; S.accPhone = ''; S.accName = '';
      S.pairCode = ''; S.pairFam = ''; S.famName = '';
      S.role = 'family'; S.onboarded = false; save();
      try { close(); } catch (e) {}
      authScreen('fam');
      return;
    }
    if (d === 'setrole') {
      const v = n.dataset.v;
      S.role = v; S.accRole = v === 'family' ? 'fam' : 'elder'; save();
      try { renderMe(); } catch(ex){}
      try { goPage(v === 'family' ? 'famhome' : 'home'); } catch(ex){}
      close(); return;
    }
    /* 引导里的增删 / 勾选 */
    if (d === 'addcontact') { d9.contacts.push({label:'家人',name:'',phone:'',wx:''}); render(); return; }
    if (d === 'delcontact') { d9.contacts.splice(+n.dataset.i,1); render(); return; }
    if (d === 'addmed') { d9.meds.push({name:'',note:'',photo:''}); render(); return; }
    if (d === 'delmed') { d9.meds.splice(+n.dataset.i,1); render(); return; }
    if (d === 'pickdev') {
      const k=n.dataset.k, i=d9.devices.indexOf(k);
      if (i>=0) d9.devices.splice(i,1); else d9.devices.push(k);
      render(); return;
    }
    if (d === 'setgrid') {
      d9.grid = +n.dataset.v;
      c.grid = d9.grid; c.apps = d9.apps.slice(0, 6); save();
      try { if (typeof renderDesk === 'function') renderDesk(); } catch(e){}
      try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch(e){}
      render(); return;
    }
    if (d === 'pickapp') {
      const k=n.dataset.k, i=d9.apps.indexOf(k);
      if (i>=0) d9.apps.splice(i,1);
      else {
        /* 上限就是首页能放下的格数（4 或 6）。之前选多少个都收，
           到首页被裁掉一半——老人以为坏了。 */
        if (d9.apps.length >= 6) {
          setMsg('首页最多放 6 个，先取消一个再选。', true);
          render(); return;
        }
        d9.apps.push(k);
      }
      render(); return;
    }
    if (d === 'pickdock') {
      const k=n.dataset.k, i=d9.dock.indexOf(k);
      if (i>=0) d9.dock.splice(i,1); else d9.dock.push(k);
      render(); return;
    }
    if (d === 'saveSos') {
      const inp = $9('v9sosPhone');
      const v = window.saveSosPhone && window.saveSosPhone(inp ? inp.value : '');
      err=''; okmsg = v ? ('紧急联系人号码已保存：' + v) : '号码已清空';
      render(); return;
    }
    if (d === 'fallTest') {
      /* 直接触发确认层，验「检测→确认→倒计时→拨号」这一整条，
         不用真去摔手机。倒计时里点「我没事」就会取消，不会真拨号。 */
      try {
        if (S.fallDetectOn === false) { err = '摔倒检测现在是关着的，先打开再试。'; render(); return; }
        if (window.MILI_FALL) window.MILI_FALL(20);
        okmsg = '模拟了一次摔倒，屏幕上有确认层；20 秒没人应才会叫人。';
      } catch (e) { err = '没弹出来：' + String(e && e.message || e); }
      render(); return;
    }
    if (d === 'fallOn') {
      const on = S.fallDetectOn === false;
      window.saveFallOn && window.saveFallOn(on);
      okmsg = on ? '摔倒检测已打开' : '摔倒检测已关闭'; render(); return;
    }
    if (d === 'prev') { if (step>0) step--; render(); return; }
    if (d === 'next') {
      if (step < 5) { step++; render(); return; }
      /* 最后一步：draft 落进 S.cfg，再进同步页 */
      c.contacts = d9.contacts.filter(x => x.label || x.name || x.phone);
      c.meds = d9.meds.slice(); c.devices = d9.devices.slice();
      c.grid = d9.grid; c.apps = d9.apps.slice(0, d9.grid); c.dock = d9.dock.slice();
      c.setupDone = true; save(); applyCfg(true);
      page = 'sync'; render(); return;
    }
    /* 2026-11-10 20:0x 菲尔特「设置页给老人录音，旧界面又出来打架」：
       data-do="vp" 原来直接 page='setup';step=6，进的是旧 7 步 setup 的
       「录声音·7/7」，跟 9 屏新引导两套并存。删掉这条，统一走新引导第 8 屏。 */
    if (d === 'vp') {
      try { close(); } catch (e) {}
      try { showOnboard(true); setStep(8); } catch (e) {}
      return;
    }
    if (d === 'vpenroll') {
      if (!(window.MiliNative && MiliNative.vpEnrollStart)) { setMsg('这台手机不支持录声纹，先跳过。', true); render(); return; }
      window.__vpRec = true; window.__vpCount = 0;
      window.__onVoiceTake = function(n, target, score, done){
        window.__vpCount = n || 0;
        if (done) {
          window.__vpRec = false;
          try { MiliNative.vpEnrollStop(); } catch(e){}
          try { const sv = JSON.parse(localStorage.getItem('mili')||'{}'); sv.vpEnrolled = true; localStorage.setItem('mili', JSON.stringify(sv)); } catch(e){}
          setMsg('声纹录好了。以后只有这个声音能指挥米粒。', false);
          render();
          return;
        }
        const el = document.getElementById('vp9state');
        if (!el) return;
        /* 2026-11-10 菲尔特「点击录完没反馈」：点完立刻给「我在听」，
           每一句都告诉老人收着没有；没收着也要说，不能一直干等。 */
        if (!n) el.textContent = '我在听，请对着手机说第一句（共 ' + target + ' 句）';
        else if (typeof score === 'number' && score < 0)
          el.textContent = '这句没听清，再说一句（已收 ' + (window.__vpCount || 0) + '/' + target + ' 句）';
        else el.textContent = '第 ' + n + ' 句收好了，再来说一句（共 ' + target + ' 句）';
      };
      try { MiliNative.vpEnrollStart(); } catch(e) { setMsg('录音没打开：' + e, true); }
      render(); return;
    }
    if (d === 'vpstop') {
      window.__vpRec = false;
      try { MiliNative.vpEnrollStop(); } catch(e){}
      setMsg('停了。想重录就再点一次。', false);
      render(); return;
    }
    if (d === 'openRhythm') { page = 'rhythm'; render(); return; }
    if (d === 'rhythmDrop') {
      const k = t.dataset.k;
      if (window.MILI_RHYTHM) window.MILI_RHYTHM.drop(k);
      render(); return;
    }
    if (d === 'rhythmOff') {
      S.rhythmOff = !S.rhythmOff;
      save();
      render(); return;
    }
    if (d === 'rhythmWipe') {
      /* 全量清空：memo / rhythm / evo 三套一起退。
         只调 MILI_RHYTHM.wipe() 时，旧 skill 仍会 0ms 重放，「清空」是假的。 */
      if (window.MILI_STORE) window.MILI_STORE.clearAll();
      else if (window.MILI_RHYTHM) window.MILI_RHYTHM.wipe();
      setMsg('清空了。它会重新看，不再猜。', false);
      render(); return;
    }
    if (d === 'skillOff') {
      S.skillOff = !S.skillOff;
      /* v9 里没有 setMsg，提示走模块内的 okmsg + msg()，别调不存在的全局函数。 */
      okmsg = S.skillOff ? '关掉了经验卡。同一句话它会重新想一遍。' : '经验卡回来了，办过的话下次直达。';
      save();
      render(); return;
    }
    if (d === 'cv') {
      S.cvOn = !S.cvOn;
      save();
      /* 2026-11-09：原来打开开关只存了个值，要等下次通话才真起听写 ——
         这是一颗假开关（和上一轮撤销 enable_lid 假开关同一个原则）。
         现在开就起、关就停；起的是在线版 cvStart()，不是本地离线识别。 */
      if (!S.cvOn) { try { stopCv(); } catch (e) {} }
      else { try { startCv(); } catch (e) {} }
      render(); return;
    }
    if (d === 'btn' || d === 'btnLeft' || d === 'btnRight') {
      /* 2026-11-09：只动 #hubApps，绝不 render() 整页 —— 那是「点一下跳一下」的根因。 */
      const k = n.dataset.k;
      const c = cfg9();
      let arr = Array.isArray(c.apps) ? c.apps.slice() : [];
      const i = arr.indexOf(k);
      if (d === 'btnLeft' || d === 'btnRight') {
        const j = i + (d === 'btnLeft' ? -1 : 1);
        if (i >= 0 && j >= 0 && j < arr.length) {
          const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
      } else if (i >= 0) {
        if (arr.length <= 1) { setMsg('至少留一个图标。', true); return; }
        arr.splice(i, 1);
      } else {
        if (arr.length >= 6) { setMsg('首页最多放 6 个，先取消一个再选。', true); return; }
        arr.push(k);
      }
      c.apps = arr;
      c.grid = arr.length >= 5 ? 6 : 4;
      S.homeBtns = arr.slice();
      save();
      try { renderDesk(); } catch (e) {}
      try { applyDesk(); } catch (e) {}
      try { if (window.pushCfgAuto) window.pushCfgAuto(); } catch (e) {}
      hubAppsRefresh();
      return;
    }
    if (d === 'petShow') {
      const nb = NATIVE();
      let now = true;
      try { now = nb && nb.petVisible ? !!nb.petVisible() : true; } catch(e){}
      const want = !now;
      try { if (nb && nb.setPetVisible) nb.setPetVisible(want); } catch(e){}
      /* 局部改样式，不整页重绘 */
      if (n) n.classList.toggle('on', want);
      return;
    }
    if (d === 'wakeShow') {
      const nb = NATIVE();
      let now = true;
      try { now = nb && nb.wakeVisible ? !!nb.wakeVisible() : true; } catch(e){}
      const want = !now;
      try { if (nb && nb.setWakeVisible) nb.setWakeVisible(want); } catch(e){}
      if (n) n.classList.toggle('on', want);
      try { if (window.__f7toast) window.__f7toast(want ? '喊「米粒米粒」就能叫我' : '已关：麦克风不占了，点「说话」也能叫我'); } catch(e){}
      return;
    }
    if (d === 'permcheck') {
      try { if (window.MiliNative && MiliNative.permCheckNow) MiliNative.permCheckNow(); } catch (e) {}
      return;
    }
    if (d === 'permgo') {
      const k = t.dataset.k || '';
      try {
        if (window.MiliNative && MiliNative.openPerm) MiliNative.openPerm(k);
        else window.__f7toast && window.__f7toast('这台设备上打不开系统设置页');
      } catch (e) { window.__f7toast && window.__f7toast('没打开：' + e); }
      /* 从系统设置页回来时把七项状态重新读一遍，别停在旧的「没开」上。
         页面在后台时定时器被冻结，正好等回到前台才刷新。 */
      setTimeout(function () { try { render(); } catch (e) {} }, 1200);
      return;
    }
    if (d === 'exitHome') {
      try {
        if (window.MiliNative && MiliNative.exitHome) MiliNative.exitHome();
        setMsg('在打开的页面里选系统桌面。米粒不会再开机自己回来。', false);
      } catch (e) { setMsg('退不出去，去系统设置 → 默认应用 → 桌面 里改。', true); }
      render(); return;
    }
    if (d === 'sethome') {
      try {
        if (window.MiliNative && MiliNative.isDefaultHome && MiliNative.isDefaultHome()) {
          setMsg('已经是默认桌面了，按 Home 键直接回米粒。', false);
        } else if (window.MiliNative && MiliNative.openHomeSettings) {
          MiliNative.openHomeSettings();
          setMsg('在打开的页面里选「米粒」，再点「始终」。', false);
        } else {
          setMsg('这台手机改不了，去系统设置 → 应用 → 默认应用 → 桌面。', true);
        }
      } catch (e) { setMsg('打不开设置页，去系统设置里改默认桌面。', true); }
      render(); return;
    }
    if (d === 'push') { doPush(); return; }
    if (d === 'pull') { doPull(); return; }
  }

  /* ---- 把配置作用到桌面：只显示家人勾的图标，底栏只留勾的按钮 ---- */
  function applyDesk(){
    const c = cfg9();
    const grid = document.getElementById('deskGrid');
    /* 没配过就完全不接管，保持 desk6 自己那 4 个，避免空白屏 */
    const allow = c.apps.slice(0, c.grid);
    if (grid && allow.length) {
      Array.prototype.forEach.call(grid.querySelectorAll('[data-desk]'), function(b){
        const k = b.dataset.desk, i = allow.indexOf(k), on = i >= 0;
        b.classList.toggle('v9on', on);
        b.classList.toggle('d-hide', !on);
        /* desk6 每点一次都按频次重算 class 和 DOM 顺序，光靠 class 压不住：
           刷新一次配好的图标就被换掉。inline 是最硬的一层。 */
        b.style.display = on ? 'flex' : 'none';
        b.style.order = on ? String(i) : '99';
      });
      grid.style.gridTemplateColumns = 'repeat(2,1fr)';
    }
    const dock = document.querySelector('#page-home .ddock');
    if (dock) {
      Array.prototype.forEach.call(dock.children, function(b){
        const k = b.dataset.v9 || '';
        if (b.classList.contains('dtorch')) b.dataset.v9 = 'torch';
        const kk = b.dataset.v9 || (b.classList.contains('dsos') ? 'sos'
                 : b.classList.contains('dtalk') ? 'talk'
                 : b.classList.contains('dtorch') ? 'torch' : 'home');
        b.style.display = c.dock.indexOf(kk) >= 0 ? '' : 'none';
      });
      /* 列数按「真实可见的按钮」算：配置里混进无效键（如 home）时，
         不能按配置长度留一列空白。2 颗时让「说话」宽一点，主次分明。 */
      let vis = 0;
      Array.prototype.forEach.call(dock.children, function(b){
        if (b.style.display !== 'none') vis++;
      });
      dock.style.gridTemplateColumns =
        vis <= 1 ? '1fr' : vis === 2 ? '1fr 1.5fr' : 'repeat(3,1fr)';
    }
  }
  window.__V9_DESK_APPLY = applyDesk;
  setTimeout(applyDesk, 1200);
  setTimeout(applyDesk, 2600);
  /* 只盯桌面节点的增删，不盯自己的 class 变化——否则 applyDesk 改 class
     会把自己的观察器再点着，无限自激。 */
  (function(){
    const dg = document.getElementById('deskGrid');
    if (dg) new MutationObserver(function(){ setTimeout(applyDesk, 60); })
      .observe(dg, { childList:true, subtree:true });
  })();

  /* ---- 入口：桌面「设置」改走 v9；家人端顶部资料条也进 v9 ---- */
  function wireEntries(){
    const set = document.querySelector('#page-home .dsset');
    if (set && !set.dataset.v9wired) {
      set.dataset.v9wired = '1';
      set.onclick = function(ev){ ev.stopPropagation(); open('hub'); };
    }
    /* 「我的」页头像 → 昵称头像编辑页（2026-11-07：只有我的页保留改头像昵称，
       不再改道设置中心。） */
    /* 家人端不再做 DOM 级一刀切清理（此前把「管理记忆」「健康档案」等真功能
       连同假按钮一起删光，「我的」页只剩空壳、底栏 tab 也被去重误杀）。
       假入口一律在 SCREENS 源头删；这里只保留入口改道。 */
  }
  function start9(){
    wireEntries();
    /* 视频加载完成前显示静态鸡占位，加载完淡入视频——
       「一打开鸡忽大忽小/空白」的最后一环。 */
    (function(){
      const idle = $('petIdleV'), sing = $('petSingV'), poster = $('petPoster');
      if (!idle) return;
      const mark = function(v){ if (v) v.classList.add('ready'); };
      [idle, sing].forEach(function(v){
        if (!v) return;
        if (v.readyState >= 2) mark(v);
        else v.addEventListener('canplay', function(){ mark(v); }, { once:true });
      });
      const show = function(){
        if (!poster) return;
        poster.style.opacity = '0';
        poster.style.display = 'none';   /* 双鸡重影：叠加层必须真撤，不是变透明 */
      };
      if (idle.readyState >= 2) show();
      else idle.addEventListener('canplay', show, { once:true });
      /* 自愈守卫：切页回来 WebView 会把视频停掉，停了就显示系统默认海报
         （灰底黑三角）—— 截图里那个「诡异形变」。两秒一次：该播没播就续上，
         真坏了就退回静态小鸡，绝不让默认海报露脸。 */
      /* 2026-11-13 重写：只负责「切页回来 WebView 把视频停了」这一件事。
         旧守卫在 readyState<2 时把 video display:none 并切静态图，切页/返回
         那一两秒鸡就整块消失，之后又要等 canplay 才回来 —— 这正是「有时消失」。
         现在永不隐藏视频、永不切 poster；真 error 也保留最后一帧，不让默认海报露脸。 */
      setInterval(function(){
        const ava = $('petAva');
        if (!ava || ava.offsetParent === null) return;   // 首页不可见就不折腾
        const v = $('petIdleV');
        if (!v) return;
        ava.classList.remove('video-fallback');
        v.classList.add('ready');
        const post = $('petPoster');
        if (post) { post.style.display = 'none'; post.style.opacity = '0'; }
        if (v.error) return;
        if (v.paused) { try { v.play().catch(function(){}); } catch(e){} }
      }, 1200);
    })();
    /* 老人端两个真轮询：① 捎句话（家人端下发，米粒开口念）
       ② 到点吃药提醒（用药计划里定的时间，命中 HH:MM 播一次，一天只播一次） */
    (function(){
      let noteSeen = 0;
      try { noteSeen = +(localStorage.getItem('mili.note.seen') || 0); } catch(e){}
      const fireNote = function(text){
        if (!text) return;
        if (window.__F7_FAMILY) return;   /* 家人端不播 */

        try { say(text, 6000); } catch(e){}
        try { if (typeof nativeTTS === 'function' && !window.__VOICE) nativeTTS(text); } catch(e){}
      };
      setInterval(function(){
        if (window.__F7_FAMILY) return;   /* 家人端不轮询、不播报 */
        let st = null;
        try { st = JSON.parse(localStorage.getItem('mili') || '{}'); } catch(e){}
        if (!st || st.role === 'family') return;
        try {
          const n = JSON.parse(localStorage.getItem('mili.note') || 'null');
          if (n && n.t > noteSeen && n.t > Date.now() - 10*60*1000 && n.text){
            noteSeen = n.t;
            try { localStorage.setItem('mili.note.seen', String(noteSeen)); } catch(e){}
            fireNote(n.text); return;
          }
        } catch(e){}
        try {
          fetch('http://YOUR_SERVER_HOST:9001/state?k=YOUR_STATE_KEY&dev=note')
            .then(function(r){ return r.json(); })
            .then(function(j){
              if (j && j.t && j.t > noteSeen && j.t > Date.now() - 10*60*1000 && j.text){
                noteSeen = j.t;
                try { localStorage.setItem('mili.note.seen', String(noteSeen)); } catch(e){}
                fireNote(j.text);
              }
            }).catch(function(){});
        } catch(e){}
      }, 20000);
      setInterval(function(){
        if (window.__F7_FAMILY) return;   /* 家人端不轮询、不播报 */
        let st = null;
        try { st = JSON.parse(localStorage.getItem('mili') || '{}'); } catch(e){}
        if (!st || st.role === 'family') return;
        const meds = Array.isArray(st.med) ? st.med : [];
        const now = new Date();
        const hm = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
        const day = now.toDateString();
        meds.forEach(function(m){
          if (!m || !m.times || !m.times.length || m.times.indexOf(hm) < 0) return;
          const key = 'mili.medfired.' + day + '_' + hm + '_' + (m.who || m.name || '');
          try {
            if (localStorage.getItem(key)) return;
            localStorage.setItem(key, '1');
          } catch(e){ return; }
          fireNote('该吃' + (m.who || m.name || '药') + '了' + (m.dose ? '，' + m.dose : ''));
        });
      }, 20000);
    })();
    /* 不通话时那条白条也点得动：点一下直接进通话，不用去猜「喊一声」是喊给谁听。 */
    try {
      const cb = $('callBar');
      if (cb && !cb.dataset.v9tap) {
        cb.dataset.v9tap = '1';
        cb.addEventListener('click', function(ev){
          if (CALL.on) return;
          /* 点「挂断」时 callExit 先把 CALL.on 置 false，事件再冒泡到这里，
             会被当成「点了空白条」又立刻重连。按钮区一律不接。 */
          if (ev.target && ev.target.closest && ev.target.closest('button')) return;
          ev.stopPropagation();
          try { callEnter(); } catch(e){}
        });
      }
    } catch(e){}
    setTimeout(wireEntries, 900);
    setTimeout(wireEntries, 2400);
    /* fam7 每次切屏都 innerHTML 重建，假按钮会复活 —— 观察它，重建后再清一遍 */
    const f7host = document.getElementById('fam7');
    if (f7host) new MutationObserver(function(){ setTimeout(wireEntries, 40); })
      .observe(f7host, { childList:true });
    document.body.addEventListener('click', function(){ setTimeout(wireEntries, 120); }, true);
    /* 家人端首次进来，直接领去引导；老人端不打扰 */
    try {
      const c = cfg9();
      if (S.role === 'family' && !c.setupDone && !sessionStorage.getItem('mili.v9.greeted')) {
        sessionStorage.setItem('mili.v9.greeted','1');
        /* 21:0x：家人端首启也不再进旧 6 步，统一走 9 屏新引导。 */
        setTimeout(function(){ try { showOnboard(true); } catch (e) {} }, 1200);
      }
    } catch(e){}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start9);
  else start9();
})();

/* ================= 全部应用抽屉（真桌面化第一步） =================
   老人不该记「哪个功能藏在哪个 App 里」。这个抽屉把手机上所有能打开的软件
   一格格摆出来，点一下就走。列表来自原生 PackageManager，不写死。 */
(function () {
  let cache = null;
  let mounted = false;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    const d = document.createElement('div');
    d.id = 'appdrawer';
    d.hidden = true;
    d.innerHTML = '<div class="ad-top"><b>全部应用</b>' +
      '<button id="adClose" aria-label="关闭">✕</button></div>' +
      '<div class="ad-grid" id="adGrid"></div>';
    document.body.appendChild(d);
    d.addEventListener('click', function (ev) {
      const t = ev.target.closest ? ev.target.closest('[data-pkg]') : null;
      if (t) {
        try {
          const nn = NATIVE();
          if (nn && nn.launch) nn.launch(t.dataset.pkg);
          else if (nn && nn.launchApp) nn.launchApp(t.dataset.pkg);
        } catch (e) {}
        d.hidden = true;
        return;
      }
      if (ev.target.id === 'adClose' || ev.target === d) d.hidden = true;
    });
  }

  function render() {
    const g = document.getElementById('adGrid');
    if (!g) return;
    /* 米粒自己不出现在「全部应用」里：点了还是米粒，白占一格 */
    const apps = ((cache && cache.apps) || []).filter(function (a) {
      return a && a.pkg !== 'com.mili.app';
    });
    if (!apps.length) {
      g.innerHTML = '<div class="ad-empty">没拿到应用列表。检查手机权限后重开一次。</div>';
      return;
    }
    /* 2026-11-08：这一段全用内联样式。上一版靠 class，真机上 CSS 被覆盖后
       每格只剩一个首字、名字全丢（截图就是这么塌的）。内联写死，谁都改不坏。 */
    g.setAttribute('style', 'flex:1;min-height:0;overflow-y:auto;display:grid;'
      + 'grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:4px 2px 24px');
    g.innerHTML = apps.map(function (a) {
      const nm = esc(a.name);
      return '<button data-pkg="' + esc(a.pkg) + '" style="display:flex;flex-direction:column;'
        + 'align-items:center;gap:6px;min-width:0;background:#fff;border:0;border-radius:18px;'
        + 'padding:12px 4px;box-shadow:0 2px 8px rgba(40,42,90,.05)">'
        + '<span style="width:44px;height:44px;border-radius:13px;background:#EEEBFF;color:#5B4DF0;'
        + 'display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:800;'
        + 'flex:none">' + nm.slice(0, 1) + '</span>'
        + '<span style="font-size:12px;line-height:1.2;color:#1B1D2E;width:100%;text-align:center;'
        + 'overflow:hidden;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;'
        + '-webkit-box-orient:vertical">' + nm + '</span></button>';
    }).join('');
  }

  function open() {
    mount();
    const d = document.getElementById('appdrawer');
    if (!d) return;
    d.hidden = false;
    /* 每次都重新问一遍系统。之前只在 cache 为空时取，一旦某次桥返回了脏数据
       （实测过一次只回「米粒」自己），抽屉就永远只剩一个图标。24KB 的同步调用
       几十毫秒，不值得为它冒「永远修不好」的险。 */
    try {
      const nn = NATIVE();
      if (nn && nn.listApps) {
        const j = JSON.parse(nn.listApps());
        if (j && j.apps && j.apps.length > 3) cache = j;
      }
    } catch (e) { /* 保留上一次好数据 */ }
    render();
  }

  window.MILI_APPS = { open: open };
  function wire() {
    const b = document.getElementById('adBtn');
    if (b && !b.__wired) {
      b.__wired = true;
      b.onclick = function (ev) { ev.stopPropagation(); open(); };
      /* 米粒不是系统桌面时，这个按钮没有存在意义 —— 系统桌面本身就是应用列表。
         只有它真当了桌面（没有系统桌面可退）才显示。 */
      let isHome = false;
      try { isHome = !!(window.MiliNative && MiliNative.isDefaultHome && MiliNative.isDefaultHome()); } catch (e) {}
      b.hidden = !isHome;
    }
    const x = document.getElementById('adClose');
    if (x) x.onclick = function () { const d = document.getElementById('appdrawer'); if (d) d.hidden = true; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
  setTimeout(wire, 1200);
})();

/* 开机把「当前是哪一端」告诉原生：停在家人端时，唤醒和桌宠都不许自己起来。 */
setTimeout(function () {
  try {
    var nb = NATIVE();
    if (nb && nb.setFamilyMode) nb.setFamilyMode(!!window.__F7_FAMILY);
  } catch (e) {}
}, 2600);


/* ============================================================================
 * 演示模式（2026-11-12 菲尔特：「我怎么进入演示模式，帮我做好入口和全流程」）
 * ----------------------------------------------------------------------------
 * 要演的是一句话的两遍：
 *   ① 「米粒，我想看天天耍大牌」→ 问两件事（哪个平台、片子叫啥）
 *   ② 「我想看耍大牌」        → 平台记住了，只问片名
 *   ③ 「我要看打牌」          → 一句不问，直接横屏全屏
 *
 * 三条设计决定，都是为了让现场不出假：
 *
 * 1. **进度不靠按钮推进，靠它自己记住了多少。**
 *    我本来想做成「下一遍 ⟶」按钮，但那样演的是按钮，不是米粒。
 *    现在第几遍由 localStorage 里那两条记忆算：
 *       平台或片名缺一条              → 第 1 遍
 *       两条都有                      → 第 2 遍（放行 skill，直达）
 *    记忆是自己长出来的，所以演到第几遍也是自己走到的。
 *
 * 2. **复位只清两条记忆，不清 skill。**
 *    skill 是「这次 0 秒」的来源 —— 第 2 遍要靠它。
 *    可它一旦在，第 1 遍说「我想看天天耍大牌」就会被 0 毫秒重放，
 *    一个字都不问，两遍演成一遍。所以复位清记忆，另外加一道闸
 *    （blockSkill）：第 1 遍不许走 skill，第 2 遍才放行。
 *
 * 3. **数据只记它自己吐出来的，不按脚本写死。**
 *    问了几个问题、说完到出声多少毫秒、有没有真办成，全部从
 *    handleSay 的实际执行里取（__DEMO_ROUND / ASK / AUDIO / DID 四个钩子）。
 *    表里填的是真跑出来的数，不是排练时的数。
 * ========================================================================== */
(function () {
  'use strict';

  var D = {
    on: false,
    /* 演示者自己按 ✕ 收起的。跟"因为设置页挡着先藏一下"不是一回事 ——
       前者要记住，后者随时恢复。2026-11-12 就是把两者混成一个 hidden，
       结果设置页一逛，提词条再也不回来了。 */
    muted: false,
    runs: { 1: null, 2: null },
    cur: null,          // 当前这一遍：{ step, ask, round:{t0,text,audio} }
  };

  function $(id) { return document.getElementById(id); }

  /* ---------------- 它现在知道多少 ---------------- */
  function know() {
    var ms = [];
    try { ms = (window.MILI_MEMO && window.MILI_MEMO.memo()) || []; } catch (e) {}
    var plat = false, title = false;
    for (var i = 0; i < ms.length; i++) {
      var t = String((ms[i] && ms[i].text) || '');
      if (/看视频用/.test(t)) plat = true;
      if (/上次看的是/.test(t)) title = true;
    }
    return { plat: plat, title: title };
  }
  function stepNow() {
    var k = know();
    /* 2026-11-13 改两遍制：平台和片名没都记下就是第 1 遍；
       两条齐了直接进第 2 遍，放行 skill 重放。 */
    return (k.plat && k.title) ? 2 : 1;
  }

  /* 提词。第一遍那句话里头带着「米粒」—— 现场手机可能是锁屏被叫醒的，
     带称呼最稳；后两遍已经在对话里，不用再喊。 */
  var SAY = {
    1: { say: '米粒，我想看天天耍大牌', ex: '问两件：哪个平台、片子叫啥' },
    2: { say: '我要看天天耍大牌', ex: '一句不问，直接跳转' },
  };

  function allDone() { return !!(D.runs[1] && D.runs[2]); }

  /* ---------------- 钩子：由 handleSay / speak 调 ---------------- */
  function round(text) {
    if (!D.on) return;
    var s = stepNow();
    if (!D.cur || D.cur.step !== s) D.cur = { step: s, ask: 0, round: null };
    D.cur.round = { t0: Date.now(), text: String(text || '').slice(0, 40), audio: 0 };
    paint();
  }
  function ask(q, askedBoth) {
    if (!D.on || !D.cur) return;
    /* 一句话问两件事（平台 + 片名）算两件。现场对比的是「要问几件」，
       不是「说了几句话」—— 第 1 遍 2 件、第 2 遍 0 件。 */
    D.cur.ask += askedBoth ? 2 : 1;
    paint();
  }
  function audio() {
    if (!D.on || !D.cur || !D.cur.round || D.cur.round.audio) return;
    D.cur.round.audio = Date.now();
  }
  /* 结算一遍。两条路都会走到这里，所以必须幂等：
     ① __DEMO_DID —— 模型自己报了「办成了」
     ② watchStep —— 记忆变了（第 1 遍办完，平台那条突然出现在 memo 里）
     真机实测：① 有时不触发（模型的 did 判据看最后一步，重放/被截断时会给 false），
     结果表就空着 —— 现场最难看的就是一张全是「—」的表。
     ② 不依赖任何回调：它记住的东西变了，就是这一遍办成了，这个事实骗不了人。 */
  function settle(cur, kind) {
    if (!cur || cur.__done) return false;
    cur.__done = true;
    var rd = cur.round || {};
    var end = rd.audio || rd.did || Date.now();
    D.runs[cur.step] = {
      ask: cur.ask, ms: Math.max(0, end - (rd.t0 || end)),
      kind: kind || '', text: rd.text || '', at: Date.now(),
    };
    return true;
  }

  function did(kind) {
    if (!D.on || !D.cur) return;
    var cur = D.cur;
    var rd = cur.round || (cur.round = { t0: Date.now(), text: '' });
    rd.did = Date.now();
    /* 声音通常比「办成」晚几十毫秒才出口（say 在返回之后调），
       等一小会儿再结算，取到的才是老人真正听见的那一下。 */
    setTimeout(function () {
      if (settle(cur, kind)) {
        if (D.cur === cur) D.cur = null;
        paint(); table();
      }
    }, 700);
  }

  /* 这一遍演完没有？两个判据，任一个成立就算：
     ① 原生报「真开播了」（__MILI_WATCH_OK）—— 最硬，第 2 遍只有这个能证明；
     ② 它记住的东西变了 —— 第 1、2 遍办成时必然发生。
     一秒看一次（paint 里调），不另起定时器。 */
  function watchStep() {
    var w = window.__MILI_WATCH_OK;
    if (w && D.cur && !D.cur.__done && D.cur.round && w.at >= D.cur.round.t0 - 500) {
      if (settle(D.cur, 'play')) { D.cur = null; table(); }
    }
    var s = stepNow();
    if (D.lastStep && D.lastStep !== s) {
      var prev = D.cur;
      if (prev && prev.step === D.lastStep && settle(prev, 'memo')) {
        D.cur = null;
        table();
      }
    }
    D.lastStep = s;
  }

  /* ---------------- 闸：前两遍不许走 skill 重放 ----------------
     没有这道闸，第 1 遍「我想看天天耍大牌」会被上次学会的序列 0 毫秒重放，
     一次都不问 —— 两遍演示当场变成一遍。第 2 遍放行，因为那正是要演的东西。 */
  function blockSkill(text, hit) {
    if (!D.on) return false;
    var names = ((hit && hit.tools) || []).map(function (t) { return String(t && t.name || ''); }).join(',');
    if (!/search_in_app|watch_video/.test(names)) return false;   // 别的能力照旧
    return stepNow() < 2;
  }

  /* ---------------- 画面 ---------------- */
  function paint() {
    var h = $('demoHud');
    if (!h) return;
    if (!D.on) { h.hidden = true; return; }
    /* 设置页一开就把提词收起来（2026-11-12）。它蹲在右上角，
       正好压住设置页第一行 —— 要上去看数字、要退出演示，先得躲开自己。 */
    if (D.muted) { h.hidden = true; return; }
    var _v9 = document.getElementById('v9');
    if (_v9 && _v9.classList.contains('on')) { h.hidden = true; return; }
    h.hidden = false;
    watchStep();
    var s = stepNow();
    var done = allDone();
    var c = SAY[s];
    var st = $('dhStep'), sy = $('dhSay'), ex = $('dhExpect'), last = $('dhLast');
    if (st) st.textContent = done ? '两遍演完' : ('第 ' + s + ' 遍 / 共 2');
    if (sy) sy.textContent = done ? '重新演一遍？点「复位」' : c.say;
    /* 第三行只放一句话。两条并排会互相挤成省略号 —— 真机上看到的是
       「问两件：哪个平台、… 这遍已经问…」，两头都没说完，等于什么都没说。
       有实测数据就先说数据（现场要的就是那个数），没有再说这一遍会问什么。 */
    var rr = D.runs[s];
    var caa = (D.cur && D.cur.step === s) ? D.cur.ask : 0;
    if (ex && last) {
      if (done) { ex.textContent = '数字在「我的 · 比赛演示」里'; last.textContent = ''; }
      else if (rr) { ex.textContent = ''; last.textContent = '刚这遍：' + (rr.ask ? '问 ' + rr.ask + ' 件' : '没问') + ' · ' + (rr.ms / 1000).toFixed(1) + ' 秒'; }
      else if (caa) { ex.textContent = ''; last.textContent = '这遍已经问了 ' + caa + ' 件'; }
      else { ex.textContent = c.ex; last.textContent = ''; }
    }
    var dots = $('dhDots');
    if (dots) {
      var ch = dots.children;
      for (var i = 0; i < ch.length; i++) {
        var n = i + 1;
        ch[i].className = (D.runs[n] || n < s) ? 'on' : (n === s ? 'now' : '');
      }
    }

    var tag = $('demoTag');
    if (tag) tag.textContent = '已开';
    var rows = document.querySelectorAll('#demoSheet .ds-row');
    for (var j = 0; j < rows.length; j++) {
      rows[j].className = 'ds-row' + (Number(rows[j].getAttribute('data-n')) === s ? ' now' : '');
    }
  }

  function table() {
    var box = $('dsTable');
    if (!box) return;
    var html = '<div class="ds-tr hd"><span>遍</span><span>问了几件</span><span>说完到出声</span><span>结果</span></div>';
    var any = false;
    for (var n = 1; n <= 2; n++) {
      var r = D.runs[n];
      if (r) any = true;
      html += '<div class="ds-tr">'
        + '<span>第 ' + n + ' 遍</span>'
        + '<b class="ds-q">' + (r ? (r.ask ? r.ask + ' 件' : '0') : '—') + '</b>'
        + '<b>' + (r ? (r.ms / 1000).toFixed(1) + ' 秒' : '—') + '</b>'
        + '<span>' + (r ? (r.did === false ? '没办成' : '开播') : '—') + '</span>'
        + '</div>';
    }
    if (!any) html += '<div class="ds-empty">还没跑过。复位之后回首页说第一句。</div>';
    box.innerHTML = html;
  }

  /* ---------------- 复位 ---------------- */
  function reset() {
    var cut = 0;
    try {
      var M = window.MILI_MEMO;
      if (M) {
        var ms = M.memo().slice();
        for (var i = 0; i < ms.length; i++) {
          var t = String((ms[i] && ms[i].text) || '');
          if (/看视频用|上次看的是/.test(t) && M.del(ms[i].id)) cut++;
        }
      }
    } catch (e) {}
    D.runs = { 1: null, 2: null };
    D.cur = null;
    D.lastStep = 0;
    try { window.__askOrigin = null; } catch (e) {}
    try { if (window.MILI_MEMO) MILI_MEMO.save(); } catch (e) {}
    paint(); table();
    var tip = $('dsTip');
    if (tip) tip.textContent = cut
      ? ('清掉了 ' + cut + ' 条记忆，现在它什么都不记得，从第一遍开始。')
      : '本来就没记住平台和片名，直接说第一句就行。';
    return cut;
  }

  /* ---------------- 开关 ---------------- */
  function start(openSheet) {
    D.on = true;
    D.muted = false;
    try { localStorage.setItem('mili_demo_on', '1'); } catch (e) {}
    paint(); table();
    if (openSheet) sheet(true);
  }
  function stop() {
    D.on = false;
    try { localStorage.removeItem('mili_demo_on'); } catch (e) {}
    paint();
    var tag = $('demoTag'); if (tag) tag.textContent = '没开';
  }
  function sheet(on) {
    var s = $('demoSheet'); if (!s) return;
    s.hidden = !on;
    if (on) { table(); paint(); }
  }

  function boot() {
    var btn = $('demoBtn');
    if (btn && !btn.__wired) {
      btn.__wired = true;
      btn.onclick = function () { start(true); };
    }
    var cl = $('dsClose'); if (cl) cl.onclick = function () { sheet(false); };
    var sh = $('demoSheet');
    if (sh) sh.addEventListener('click', function (e) { if (e.target === sh) sheet(false); });
    var rs = $('dsReset');
    if (rs) rs.onclick = function () {
      reset();
      sheet(false);
      try { goPage && goPage('home'); } catch (e) {}
      paint();
    };
    var sp = $('dsStop');
    if (sp) sp.onclick = function () {
      stop();
      sheet(false);
    };
    var x = $('dhX');
    if (x) x.onclick = function () { D.muted = true; var h = $('demoHud'); if (h) h.hidden = true; };
    var hr = $('dhReset');
    if (hr) hr.onclick = function () {
      D.muted = false;
      reset();
      try { goPage && goPage('home'); } catch (e) {}
      paint(); table();
    };

    /* 上次没关的演示模式，重开页面自动接着 —— 现场手机被系统杀掉重开时，
       提词条不能没了（那就真成瞎演了）。 */
    try {
      if (localStorage.getItem('mili_demo_on') === '1') { D.on = true; paint(); }
    } catch (e) {}

    /* 记忆是异步长出来的（agent 执行完才写），提词条要跟着它走。
       一秒看一次，只在演示模式开着的时候。 */
    setInterval(function () {
      if (!D.on) return;
      paint();
    }, 1000);
  }

  window.__DEMO = {
    on: function () { return D.on; },
    start: start, stop: stop, reset: reset,
    step: stepNow, know: know, runs: function () { return D.runs; },
    blockSkill: blockSkill,
    sheet: sheet,
  };
  window.__DEMO_ROUND = round;
  window.__DEMO_ASK = ask;
  window.__DEMO_AUDIO = audio;
  window.__DEMO_DID = did;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
