import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';

/* 路径一律按脚本自身位置解析，跟从哪个目录执行无关 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.resolve(HERE, ...p);
const R = (p) => fs.readFileSync(P(p), 'utf8');

/* ============================================================
   两种产物，两条路，别再混在一起：
   ─────────────────────────────────────────────────────────
   线上版（server/）：
     页面就是 index.html 原样 + app.js 原样，走浏览器原生 module。
     模型、童声、姿态图全部是独立文件，用到才下载。
     首屏只拉 three.module.js(约 600KB) + app.js(约 90KB)。
     这是手机上跑的那一版 —— 之前 12.83MB 单文件塞进 WebView，
     光解析那个巨型 <script> 就够把内存顶满，所以「经常卡死」。

   单文件版（米粒.html）：
     全部内联，只为「断网/离线双击」场景保留。
     它不进 APK，也不进线上服务。
   ============================================================ */

const threeSrc  = R('./vendor/three/three.module.js');
const loaderSrc = R('./vendor/three/addons/loaders/GLTFLoader.js');
const dataSrc   = R('./data_src.js');
const bootSrc   = R('./app_boot.js');
const evolveSrc = R('./evolve.js');
const html      = R('./index.html');

/* ---------------- 线上版：资源外置 ----------------
   原来这里是 base64 内嵌。现在改成相对路径，浏览器按需拉。
   assets/ 目录整个拷到 server/ 下，由 app.py 的静态路由发出去。 */

const GLB_FILES = ['./assets/m1-rig.glb', './assets/m3.glb', './assets/m2-rig6.glb'];
let hasMid = false;
for (const f of ['./assets/m3.glb', './assets/m3-rig.glb']) {
  if (fs.existsSync(P(f))) { hasMid = true; break; }
}

/* 姿态图：4 张 PNG，卡面用。改成路径，不再 base64。 */
const poseNames = fs.existsSync(P('./assets/poses'))
  ? fs.readdirSync(P('./assets/poses')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))
  : [];

/* 语音库：只发「文本 → 文件名」的对照表（几十 KB），音频文件单独下载。
   这才是「声音不对」的正解 —— 原来的 text2clip 表靠 voice_bank 的 d 字段，
   但 87 条里只有 20 条有 d，剩下 67 条永远查不到，一律落到系统 TTS。
   现在改用「念出来的那句话」本身做键，87 条全能命中。 */
const voiceBank = JSON.parse(R('./voice_bank.json')).lines || {};
const voiceFiles = fs.existsSync(P('./assets/voice'))
  ? fs.readdirSync(P('./assets/voice')).filter((f) => f.endsWith('.mp3'))
  : [];

/* 文本 → 音频路径。用 v（实际念出来的文本）做主键，
   同一句口语版也登记，页面按 say 的文本直接查。 */
const t2f = {};
for (const f of voiceFiles) {
  const key = f.slice(0, -4);
  const b = voiceBank[key];
  const p = './assets/voice/' + f;
  if (b && b.v) t2f[b.v] = p;
  if (b && b.d) t2f[b.d] = p;      // 显示版也登记，万一传的是显示文本
  t2f['#' + key] = p;              // key 直查兜底（say 传了 key: 的场景）
}

console.log('语音对照表:', Object.keys(t2f).length, '条 /', voiceFiles.length, '个音频');

/* ---------------- 单文件版：仍然全内联 ---------------- */
const B64 = (p) => 'data:model/gltf-binary;base64,' + fs.readFileSync(P(p)).toString('base64');
const glb1 = B64('./assets/m1-rig.glb');
const glb2 = B64('./assets/m2-rig6.glb');
let glb3 = null;
for (const f of ['./assets/m3.glb', './assets/m3-rig.glb']) {
  try { glb3 = B64(f); break; } catch (e) {}
}

let idleSrc = '';
try {
  idleSrc = 'data:video/mp4;base64,' + fs.readFileSync(P('./assets/待机.mp4')).toString('base64');
} catch (e) {}

const voiceMap = {};
for (const f of voiceFiles) {
  voiceMap[f.slice(0, -4)] = 'data:audio/mpeg;base64,' +
    fs.readFileSync(P('./assets/voice', f)).toString('base64');
}
const poses = {};
for (const n of poseNames) {
  poses[n] = 'data:image/png;base64,' + fs.readFileSync(P('./assets/poses', n + '.png')).toString('base64');
}
const text2clip = {};
for (const [k, v] of Object.entries(voiceBank)) {
  if (!v || !v.d || !voiceMap[k]) continue;
  text2clip[v.d] = voiceMap[k];
  if (v.v && v.v !== v.d) text2clip[v.v] = voiceMap[k];
}

/* ============================================================
   产物 1：线上版（server/index.html + server/app.js + server/assets/）
   ============================================================ */

/* 线上版的 index.html 基本就是原样，只把内嵌 CSS 换成外链、
   并把资源对照表以一段小脚本注入（几十 KB，不含任何二进制）。 */
const css = R('./app.css');
const tokensCss = R('./design-tokens.css');

/* 把外置资源翻译成单文件版那套全局变量。
   app.js 里 window.__GLB / window.__VOICE / window.__POSE 的读法保持不变 ——
   一行都不用改，两种产物共用同一份 app.js。这是这次改造的关键：
   不再维护「线上版代码」和「离线版代码」两套。 */
const assetBoot = `
window.__ASSETS = ${JSON.stringify({
  glb: GLB_FILES,
  hasMid: hasMid,
  pose: poseNames.reduce((a, n) => (a[n] = './assets/poses/' + n + '.png', a), {}),
  t2f: t2f,
  voiceBank: voiceBank,
})};
(function(){
  var A = window.__ASSETS || {};
  if (!A.glb) return;
  window.__GLB = A.glb;          // 路径数组，GLTFLoader 直接 load
  window.__HAS_MID = !!A.hasMid;
  window.__POSE = A.pose || {};
  window.__T2F = A.t2f || {};    // 文本 → 音频路径
  window.__VBANK = A.voiceBank || {};
})();
window.__MODE = window.__MODE ||
  (new URLSearchParams(location.search).get("demo") === "1" ? "demo" : "product");
`;

const webHead = html.replace(
  '<script type="importmap">',
  '<script>' + assetBoot + '</script>\n<script type="importmap">'
);

/* ============================================================
   产物 2：单文件版（米粒.html / 米粒-演示版.html）
   ============================================================ */
const head0 = html.split('<script type="importmap">')[0];
/* 单文件版把两份 CSS 按原顺序内联：tokens 在前、app 在后。
   顺序不能反 —— app.css 全程引用 tokens 里的变量，
   反过来写就等于变量还没定义就被用了。 */
const head = head0
  .replace('<link rel="stylesheet" href="design-tokens.css">', '<style>/*TOKENS*/' + tokensCss + '</style>')
  .replace('<link rel="stylesheet" href="app.css">', '<style>/*INLINE_CSS*/' + css + '</style>');
const js = [
  threeSrc,
  loaderSrc,
  'window.__GLB = [' + JSON.stringify(glb1) + ',' + JSON.stringify(glb3) + ',' + JSON.stringify(glb2) + '];',
  'window.__HAS_MID = ' + (glb3 ? 'true' : 'false') + ';',
  'window.__IDLE_ANIM = ' + JSON.stringify(idleSrc) + ';',
  'window.__POSE = ' + JSON.stringify(poses) + ';',
  'window.__VOICE = ' + JSON.stringify(voiceMap) + ';',
  'window.__VBANK = ' + JSON.stringify(voiceBank) + ';',
  'window.__T2C = ' + JSON.stringify(text2clip) + ';',
  dataSrc,
  bootSrc,
  'window.__boot && window.__boot();',
  evolveSrc,
].join('\n;\n');

const single = head + '<script>\n' + js.replace(/<\/script>/g, '<\\/script>') + '\n</script>\n</body>\n</html>\n';
const singleDemo = single.replace('<script>', '<script>window.__MODE="demo";');

fs.writeFileSync(P('./米粒.html'), single);
fs.writeFileSync(P('./米粒-演示版.html'), singleDemo);

/* 2026-11-07 撤回一条错误改动：曾经把单文件版塞进 assets/mili.html，
   想让 MainActivity 的 hasLocal 为真、文件直读。结果是
   ① 绕开了 shouldInterceptRequest 的「包内优先」映射
      （host=mili.app.workbuddy.host → assets/web/<path>，本来就能断网跑）；
   ② 单文件版把 three.module.js / GLTFLoader 的 export 原样拼进普通
      <script>，语法直接报错，整页白屏（它一直只是「离线用，不进 APK」）。
   正确路径只有一条：build 同步 assets/web/，其余交给拦截映射。
   不要再往 assets 根目录放 mili.html。 */

/* ============================================================
   同步到 server/
   ============================================================ */

/* ★★★ 这里踩过一次大坑，必须留记号 ★★★
 *
 * 原来这一段是无条件 writeFileSync：只要跑了 build，server/ 里的一切
 * 就被 app/ 里同名文件**覆盖**，而且不报错、不提示。
 *
 * 结果：我直接在 server/ 上改的 app.js（3287 行，含智能体接线、ID2TOOL、
 * FAIL_SAY 一整套）被 app/ 里 00:01 的旧版（2876 行）盖掉了。等到发现
 * 「行数怎么变少了」，中间已经丢掉 200+ 行核心代码，而且页面上不报错，
 * 只是功能一个个变哑巴。这种错最难查 —— 它不崩，它只是慢慢变空。
 *
 * 现在的规矩：
 *   1. app/ 是唯一真源，server/ 是产物目录。**永远只改 app/**。
 *   2. 覆盖前先比内容。产物比真源「多出东西」就报警并拒绝覆盖 ——
 *      那说明有人在产物上直接改过，那些改动是真源里没有的，不能抹。
 *   3. 覆盖后回读校验行数，少一行就抛错，别等上线了才发现。
 */
const serverDir = P('../server');

/* 覆盖前的保险：产物里如果有真源没有的东西，就停下来喊人。
   判据不用 diff 算法 —— 只比行数和长度，多出来就报。
   少（产物更短）是正常的，说明真源更新了；多才是危险信号。

   🚨 2026-11-07 修：这个保险之前一直在误报。
   它拿「产物行数」跟「真源行数」比，可产物本身就比真源多两段
   —— build 自己注入的 `window.__ASSETS`（几十 KB 语音对照表，
   压成一行）和 `window.__MODE`。于是每次构建都喊「产物上直接改过东西」，
   设 FORCE_OVERWRITE=1 又等于把保险整个关掉：真有手改也照抹不误。
   现在改成：先把产物里那两段注入块剪掉，再比。剪完还多，才是真手改。 */
const ASSET_BLOCK_RE = /\n<script>\nwindow\.__ASSETS = [\s\S]*?window\.__MODE = window\.__MODE \|\|\n  \(new URLSearchParams\(location\.search\)\.get\("demo"\) === "1" \? "demo" : "product"\);\n<\/script>/;
function stripInjected(prod) {
  const a = prod.replace(ASSET_BLOCK_RE, '');
  /* demo.html 那版只改了一行 __MODE，单独处理 */
  return a.replace('window.__MODE = "demo" ||', 'window.__MODE = window.__MODE ||');
}
function guardOverwrite(prodPath, srcText, label) {
  if (!fs.existsSync(prodPath)) return;
  const prod = stripInjected(fs.readFileSync(prodPath, 'utf8'));
  const pl = prod.split('\n').length;
  const sl = srcText.split('\n').length;
  /* 2026-11-12：阈值从 +2 放宽到 +6。
     真源**删行**（改短一段 HTML）时，产物必然比真源长，而内容完全一致 ——
     这种情况每次都会报「产物上直接改过东西」，逼人加 FORCE_OVERWRITE，
     加着加着这东西就没人看了，真手改那天也不会有人当回事。
     注入块下面已经 strip 干净，剩下几行的差只可能是空行/格式。
     真手改通常是整段新增，几十行起步，+6 挡不住它。 */
  if (pl > sl + 6) {
    console.warn(
      '\n⚠️  [%s] 产物 %d 行 > 真源 %d 行 —— 产物上直接改过东西。\n' +
      '    拒绝覆盖（否则那些改动会被静默抹掉）。\n' +
      '    要么把产物上的改动搬回 app/，要么设 FORCE_OVERWRITE=1 强制覆盖。\n',
      label, pl, sl
    );
    if (process.env.FORCE_OVERWRITE !== '1') {
      throw new Error('产物比真源多，拒绝覆盖：' + label);
    }
  }
}

if (fs.existsSync(serverDir)) {
  const put = (name, text, label) => {
    const dst = path.join(serverDir, name);
    guardOverwrite(dst, text, label || name);
    /* 语法闸：.js 必须过严格 ES module 解析。
       🚨 2026-11-06 踩到的坑：`node --check app/app.js` 按 CommonJS 解析，
       一个没闭合的括号它放过，WebView 里却直接 SyntaxError —— 整个 app.js 不执行，
       页面看着有 CSS，实际所有 JS 全哑（3D 空白、快捷按钮不出现、全是静态骨架）。
       只有 --input-type=module 才按 module 严格解析，能对上浏览器的判法。 */
    if (/\.js$/.test(name)) {
      const r = spawnSync(process.execPath, ['--input-type=module', '--check'],
                          { input: text, encoding: 'utf8' });
      if (r.status !== 0) {
        console.error('\n❌ [%s] 严格 ESM 语法错误：\n%s', label || name, (r.stderr || '').split('\n').slice(0, 8).join('\n'));
        throw new Error('语法错误，拒绝构建：' + (label || name));
      }
    }
    fs.writeFileSync(dst, text);
    /* 回读校验：写进去的行数必须跟给的一模一样，少一行就是写坏了 */
    const back = fs.readFileSync(dst, 'utf8').split('\n').length;
    const want = text.split('\n').length;
    if (back !== want) {
      throw new Error('写入校验失败 ' + name + ': 期望 ' + want + ' 行，实际 ' + back + ' 行');
    }
  };

  /* 页面本体。
     🚨 2026-11-07：WebView 对 file:// 资源有强缓存 —— 磁盘上 CSS 改了，
     页面还在用上一版（「换台键还卡在屏幕中间」就是这么来的）。
     所有本地资源统一挂构建时间戳，每次构建强制换 URL。 */
  const VER = 'v' + Date.now().toString(36);
  const webHeadV = webHead
    .replace('href="app.css"', 'href="app.css?' + VER + '"')
    .replace('href="design-tokens.css"', 'href="design-tokens.css?' + VER + '"')
    .replace('src="app.js"', 'src="app.js?' + VER + '"')
    .replace('src="evolve.js"', 'src="evolve.js?' + VER + '"')
    .replace('src="agent-memo.js"', 'src="agent-memo.js?' + VER + '"')
    .replace('src="agent-tools.js"', 'src="agent-tools.js?' + VER + '"')
    .replace('src="agent.js"', 'src="agent.js?' + VER + '"')
    .replace('src="assets/vendor/hls.min.js"', 'src="assets/vendor/hls.min.js?' + VER + '"');
  put('index.html', webHeadV);
  put('demo.html', webHead.replace('window.__MODE = window.__MODE ||',
                                   'window.__MODE = "demo" ||'));

  /* 前端代码，原样拷（走原生 module） */
  put('app.js', R('./app.js'));
  put('app.css', css);
  /* 🚨 2026-11-07：design-tokens.css 必须跟 app.css 一起发。
     它是全站唯一一份变量定义 —— app.css 里 100% 的颜色/间距/字号
     都写成 var(--xxx)。少这一个文件，线上版所有 var() 全部落空：
     底色变透明、字变黑、卡片没圆角没阴影，整站塌成一张白纸。
     而且它不会报错（CSS 里未定义的 var 是静默失效），只会「看着不对劲」。 */
  put('design-tokens.css', tokensCss);
  put('evolve.js', evolveSrc);
  put('data.js', R('./data.js'));

  /* 智能体内核三件套。
     ★ 之前这三行根本不存在 —— server/ 里那三个文件是手写进去的，
       从来没被 build 管过，也没被 index.html 引用过。现在正式纳入构建。
       少拷一个，wireAgent() 就直接 return，页面上退回老正则。 */
  for (const f of ['agent-memo.js', 'agent-tools.js', 'agent.js']) {
    if (!fs.existsSync(P('./' + f))) {
      throw new Error('缺少内核文件 app/' + f + ' —— 智能体起不来，不能发布');
    }
    put(f, R('./' + f));
  }

  /* vendor：three + GLTFLoader + 它依赖的 BufferGeometryUtils
     —— 少拷一个文件就是 404，模型加载链直接断，页面上什么都不会有。
     之前线上版「米粒不显示」就是这个原因，别再漏。 */
  const vDir = path.join(serverDir, 'vendor');
  fs.mkdirSync(path.join(vDir, 'three', 'addons', 'loaders'), { recursive: true });
  fs.mkdirSync(path.join(vDir, 'three', 'addons', 'utils'), { recursive: true });
  fs.copyFileSync(P('./vendor/three/three.module.js'), path.join(vDir, 'three', 'three.module.js'));
  fs.copyFileSync(P('./vendor/three/addons/loaders/GLTFLoader.js'),
    path.join(vDir, 'three', 'addons', 'loaders', 'GLTFLoader.js'));
  fs.copyFileSync(P('./vendor/three/addons/utils/BufferGeometryUtils.js'),
    path.join(vDir, 'three', 'addons', 'utils', 'BufferGeometryUtils.js'));

  /* vendor/qrcode.js —— 老人自己出的那个 6 位码要画成二维码。
     56KB 纯 JS、无依赖，离线也能出码（老人手机没网时反而更稳）。
     少拷这一个文件，「出码」页就只剩数字，家人扫不了。 */
  const qrSrc = P('./vendor/qrcode.js');
  if (fs.existsSync(qrSrc)) fs.copyFileSync(qrSrc, path.join(vDir, 'qrcode.js'));
  else throw new Error('缺少 app/vendor/qrcode.js —— 二维码出不来，配对页会瘸一条腿');

  /* assets：模型 + 音频 + 姿态图，按需下载 */
  const aDir = path.join(serverDir, 'assets');
  fs.mkdirSync(path.join(aDir, 'voice'), { recursive: true });
  fs.mkdirSync(path.join(aDir, 'poses'), { recursive: true });
  fs.mkdirSync(path.join(aDir, 'vendor'), { recursive: true });
  for (const f of ['m1-rig.glb', 'm2-rig6.glb', 'm3.glb']) {
    const src = P('./assets/' + f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(aDir, f));
  }
  for (const f of voiceFiles) fs.copyFileSync(P('./assets/voice/' + f), path.join(aDir, 'voice', f));
  /* 2026-11-08：即时应答音（本地语气词，0.1s 出声）。目录新增，别忘了拷 —— 
     漏拷的后果是 filler 静默失败，页面还"看起来正常"。 */
  try {
    const fDir = path.join(aDir, 'filler');
    fs.mkdirSync(fDir, { recursive: true });
    for (const f of fs.readdirSync(P('./assets/filler'))) {
      if (f.endsWith('.mp3')) fs.copyFileSync(P('./assets/filler/' + f), path.join(fDir, f));
    }
  } catch (e) { console.warn('filler 拷贝失败', e.message); }
  for (const n of poseNames) fs.copyFileSync(P('./assets/poses/' + n + '.png'),
    path.join(aDir, 'poses', n + '.png'));
  try { fs.copyFileSync(P('./assets/待机.mp4'), path.join(aDir, '待机.mp4')); } catch (e) {}
  /* 2026-11-06 晚：视频形象两段（菲尔特制作）—— 不拷线上就 404，小鸡直接消失 */
  /* 2026-11-07：家长端阿福风的两张 3D 医疗图，来自
     microsoft/fluentui-emoji（MIT，GitHub raw 下载）。
     以前 assets 是硬编码清单，新素材漏拷＝线上和包里都 404，
     页面只剩空格。加进清单，构建自动带上。 */
  for (const f of ['chick-idle.mp4', 'chick-sing.mp4', 'chick-icon.png',
                   'afu-medical_symbol_3d.png', 'afu-pill_3d.png',
                   'vendor/hls.min.js']) {
    const src = P('./assets/' + f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(aDir, f));
    else console.warn('⚠️ 缺形象/插画素材 assets/' + f);
  }

  const sz = (p) => {
    let t = 0;
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        const st = fs.statSync(fp);
        if (st.isDirectory()) walk(fp); else t += st.size;
      }
    };
    walk(p); return t;
  };
  console.log('server 页面 %s KB | assets %s MB | app.js %s KB',
    (webHead.length / 1024).toFixed(1),
    (sz(aDir) / 1048576).toFixed(1),
    (R('./app.js').length / 1024).toFixed(0));
}

console.log('单文件版 %s MB（离线用，不进 APK、不上线）',
  (single.length / 1048576).toFixed(2));

/* ============================================================================
 * 同步进 APK 的 assets/web（2026-11-06 加）
 *
 * 为什么：APK 现在是「包里有就用包里的」，而包里的那份之前全靠人手 cp。
 * 手一漏就是「本地改好了、装上还是旧的」—— 这种坑查半天，其实是构建没带上。
 * 这里跟 server/ 一次写，两边不会各说各话。
 * assets/ 和 vendor/ 是整目录，按存在与否递归拷（跟 server 那边同源）。
 * ========================================================================== */
const webAs = P('../android/app/src/main/assets/web');
if (fs.existsSync(webAs)) {
  const pageFiles = ['index.html', 'app.js', 'app.css', 'design-tokens.css',
    'data.js', 'demo.html',
    'evolve.js', 'agent.js', 'agent-tools.js', 'agent-memo.js', 'requirements.txt'];
  let n = 0;
  for (const f of pageFiles) {
    const src = path.join(serverDir, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(webAs, f));
    n++;
  }
  const copyDir = (name) => {
    const src = path.join(serverDir, name);
    if (!fs.existsSync(src)) return;
    fs.cpSync(src, path.join(webAs, name), { recursive: true, force: true });
  };
  copyDir('assets');
  copyDir('vendor');
  console.log('APK assets/web 已同步 %d 个文件（+ assets/ vendor/ 整目录）', n);
}
