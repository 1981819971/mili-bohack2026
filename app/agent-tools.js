/* ============================================================================
 * 米粒的工具层 —— 智能体能碰到的全部真实能力
 *
 * 这个文件只干一件事：把手机上的真能力（21 个 Java 桥 + 网页能力）
 * 包成模型看得懂的 JSON Schema，并且把执行结果统一成 {ok, detail}。
 *
 * 为什么要统一成 {ok, detail}：
 *   之前 app.js 里的 ACTION_HINT 全是「你正在给她拨电话」这种进行时，
 *   模型根本看不到到底成没成，只能编一句「打好了」—— 这就是演戏的根。
 *   现在工具必须自报成败，模型只许照着说。
 *
 * 约定：
 *   run(args, E) -> {ok:boolean, detail:string, extra?:object}
 *     ok:true  → detail 是「办成了什么」，模型可以照着说
 *     ok:false → detail 是「为什么没办成」，模型必须照实说
 *   E 是 app.js 注入的环境（说话、动画、记忆、药箱……）
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------- 小工具 ---------- */

  /* Java 桥一律返回 JSON 字符串，解析不出来就当失败，绝不假设成功 */
  function NJ(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return null; }
  }

  /* 把 Java 的 {ok,did|why,say} 翻成统一的 {ok,detail}。
     say 是 Java 侧写好的老人话，直接当 detail 用，前端不再自己编。 */
  function fromJava(raw) {
    const r = NJ(raw);
    if (!r) return { ok: false, detail: '这台手机上没办成，没拿到结果。' };
    const ok = r.ok === true;
    return {
      ok: ok,
      detail: (r.say && String(r.say)) || (ok ? '办好了' : '没办成'),
      did: r.did || null,
      why: r.why || null,
    };
  }

  /* 没有原生桥时的统一回复。网页版不是「坏了」，是这台设备上没这个能力，
     说法要让老人听懂，也要让模型知道这不算办成。 */
  function noNative() {
    return { ok: false, detail: '这台设备上还办不了这个，得在手机上才行。' };
  }

  function n(E) { return E.native ? E.native() : null; }
  /* 无障碍被 MIUI 清掉时，Java 的 startActivity 照样成功、ok:true 照样回，
     但点搜索框/写字/点按钮全废 —— 这就是「报成功、屏幕没动」的根。
     所有要靠无障碍点手机的工具，动手前先问一句开关在不在。 */
  function accGuard(nn) {
    if (!nn) return { ok: false, detail: '这台设备上办不了。' };
    if (nn.accOn && !nn.accOn()) {
      return { ok: false, detail: '米粒的手被系统关了：请到「设置 → 无障碍」把米粒的开关打开，不然点不了手机。' };
    }
    return null;
  }

  /* 🚨 2026-11-10 菲尔特：「千万微信不要发错人了」。
     微信里找人、发消息、打视频语音，只能走 wechat_message / wechat_call 那条
     封装好的流程（搜索拼音首字母 → 点结果 → 发出去）。之前模型绕开它，
     自己 open_app 微信 + tap_at 在聊天列表里点，差点把消息发到「软件学院」群。
     这里把通用点屏工具在微信前台一律拦死，逼它回正路。 */
  function wxGuard(nn, toolName) {
    if (!nn || !nn.screenText) return null;
    try {
      const j = NJ(nn.screenText());
      if (j && String(j.pkg || '') === 'com.tencent.mm') {
        return {
          ok: false,
          detail: '现在在微信里，这一步不能自己点：给谁发消息、打视频语音，' +
            '直接调 wechat_message / wechat_call，它把搜人、点进去、发出去全包了。' +
            '别用 ' + toolName + ' 在聊天列表里乱点，会发错人。',
        };
      }
    } catch (e) {}
    return null;
  }

  /* 延时动作的结果验证：等窗口真的切过去，才算办成。
     每隔 400ms 看一次最近窗口，最多等 ms 毫秒。 */
  function waitWindow(nn, ms, want, since) {
    const wait = (x) => new Promise((r) => setTimeout(r, x));
    return (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          /* 只看这次动作发起之后的窗口事件，免得上一次搜的记录混进来。
             输入法弹窗会盖住「最后一次」，但盖不住整段历史里的 SearchActivity。 */
          const raw = nn.recentWindows ? String(nn.recentWindows() || '') : '';
          const lines = raw.split('\n');
          for (let k = 0; k < lines.length; k++) {
            const p = lines[k].indexOf('|');
            if (p <= 0) continue;
            const ts = Number(lines[k].slice(0, p));
            const w = lines[k].slice(p + 1);
            if (ts >= since && w.indexOf(want) >= 0) return true;
          }
          if (!raw && nn.lastWindow && String(nn.lastWindow() || '').indexOf(want) >= 0) return true;
        } catch (e) {}
        await wait(400);
      }
      return false;
    })();
  }



  /* ---------- 常用 App 包名 ---------- */
  const PKG = {
    '微信': 'com.tencent.mm',
    '爱奇艺': 'com.qiyi.video',
    '芒果TV': 'com.hunantv.imgo.activity',
    '芒果': 'com.hunantv.imgo.activity',
    '腾讯视频': 'com.tencent.qqlive',
    '优酷': 'com.youku.phone',
    '抖音': 'com.ss.android.ugc.aweme',
    '快手': 'com.smile.gifmaker',
    '悟空浏览器': 'com.cat.readall',
    '悟空': 'com.cat.readall',
    '夸克浏览器': 'com.quark.browser',
    '夸克': 'com.quark.browser',
    '哔哩哔哩': 'tv.danmaku.bili',
    'B站': 'tv.danmaku.bili',
    '央视频': 'cn.cctv.news',
    '红果短剧': 'com.phoenix.read',
    '红果': 'com.phoenix.read',
    '央视影音': 'com.cctv.cctv',
    '今日头条': 'com.ss.android.article.news',
    '头条': 'com.ss.android.article.news',
    '喜马拉雅': 'com.ximalaya.ting.android',
    '高德': 'com.autonavi.minimap',
    '高德地图': 'com.autonavi.minimap',
    '百度地图': 'com.baidu.BaiduMap',
    '支付宝': 'com.eg.android.AlipayGphone',
    '淘宝': 'com.taobao.taobao',
    '京东': 'com.jingdong.app.mall',
    '拼多多': 'com.xunmeng.pinduoduo',
    '电话': 'com.android.dialer',
    '短信': 'com.android.mms',
    '相机': 'com.android.camera',
    '相册': 'com.android.gallery3d',
    '设置': 'com.android.settings',
  };

  function pkgOf(name) {
    const s = String(name || '').trim();
    if (!s) return null;
    if (PKG[s]) return PKG[s];
    for (const k in PKG) if (s.indexOf(k) >= 0 || k.indexOf(s) >= 0) return PKG[k];
    return null;
  }

  /* ---------- 工具表 ----------
     描述写法的规矩（实测出来的）：
     · 一句话说清「老人怎么说这句话」→ 模型才认得出土话
     · 参数写 enum 就写死 enum，模型不会乱编
     · 参数说明里明说「从老人原话里取，别改字」，人名地名才不会被翻译
  */
  const T = {};

  function def(name, desc, params, required, run) {
    T[name] = { name: name, desc: desc, params: params, required: required || [], run: run };
  }

  /* ===== 打电话 ===== */
  def('call_phone',
    '给通讯录里的人打电话。老人说「给X打个电话」「拨个号给X」「找X」时用。',
    { who: { type: 'string', description: '人名，从老人原话里取，一个字都别改（如 闺女、老二、李大夫）' } },
    ['who'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.call) return noNative();
      if (!a.who) return { ok: false, detail: '没说是给谁打，得先知道打给谁。' };
      return fromJava(nn.call(a.who));
    });

  /* ===== 微信 ===== */
  def('wechat_message',
    '在微信里给某个人发消息。老人说「给X发微信说…」「跟X说…」时用。',
    {
      who: { type: 'string', description: '收消息的人，照老人原话抄。微信备注名常就是「女儿」「老伴」「闺女」这类称呼，直接填，不要换成别的名字、也不要先 recall 查是谁；不要带「给」「跟」' },
      text: { type: 'string', description: '只是要发出去的那句话本身。他说「给王炳皓发消息说我想你了」，text 就是「我想你了」——不带「说」「发消息」「告诉他」这些字' },
    },
    ['who', 'text'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.wxText) return noNative();
      /* 兜底：模型偶尔还是会把「说」带进来。这里再剥一层，
         宁可多发一层保险，也不要让老人看到自己发出去的是「说我想你了」。 */
      const who = String(a.who || '').replace(/^[给向跟和与找联系]/, '').trim();
      let text = String(a.text || '').trim();
      let prev = null;
      while (text !== prev) {
        prev = text;
        text = text.replace(/^[，,、：:\s]*(?:跟|和|对)?(?:他|她|您)?(?:说|讲|告诉|发消息说|发个消息说|发微信说|说一句|一下)[，,、：:\s]*/, '').trim();
      }
      if (!who) return { ok: false, detail: '没说是发给谁。' };
      if (!text) return { ok: false, detail: '没说要发什么话。' };
      const r = fromJava(nn.wxText(who, text));
      /* 🚨 2026-11-10 菲尔特：「模型把『我去办了』说成『发出去啦』」。
         微信是异步流程：这里只是把活派下去，消息到底发没发出去要等 WxFlow 跑完。
         以前把 detail 交回模型让它复述，它自己编一句「已经发好啦」—— 谎报。
         现在锁死回复：直接把原生给的「我去…了，你等一下啊」当最终那句，
         模型不再多跑一轮、也没有机会改口。办完了由流程自己回一声。 */
      if (r && r.ok && r.detail) r.fastReply = String(r.detail);
      return r;
    });

  def('wechat_call',
    '在微信里给某人打语音或视频通话。',
    {
      who: { type: 'string', description: '给谁打，照老人原话抄。「女儿」「老伴」「闺女」这类称呼就是微信备注名，直接填，不要改字、不要先 recall' },
      kind: { type: 'string', enum: ['voice', 'video'], description: 'voice 语音，video 视频' },
    },
    ['who', 'kind'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.wechat) return noNative();
      if (!a.who) return { ok: false, detail: '没说是给谁打。' };
      const r = fromJava(nn.wechat(a.who, a.kind === 'video' ? 'video' : 'call'));
      /* 同上：拨没拨通是异步的，不许模型复述成「已经打通了」。 */
      if (r && r.ok && r.detail) r.fastReply = String(r.detail);
      return r;
    });

  def('wechat_redpacket',
    '在微信里给某人发红包。金额老人说了就用，没说就留空让他自己在屏幕上填。',
    {
      who: { type: 'string', description: '发给谁' },
      amount: { type: 'string', description: '金额数字，如 88；老人没提金额就留空字符串' },
    },
    ['who'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.wxRed) return noNative();
      if (!a.who) return { ok: false, detail: '没说是发给谁。' };
      /* 老人没说金额 —— 不能让模型自己编一个数，交给屏幕让老人填 */
      if (!a.amount) {
        return fromJava(nn.wechat(a.who, 'redpacket'));
      }
      return fromJava(nn.wxRed(a.who, String(a.amount)));
    });

  /* ===== 短信 ===== */
  def('send_sms',
    '给某人发短信。老人明说「发短信」才用，说「发消息」一般指微信。',
    {
      who: { type: 'string', description: '发给谁' },
      text: { type: 'string', description: '短信内容，照原话' },
    },
    ['who', 'text'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.sms) return noNative();
      if (!a.who) return { ok: false, detail: '没说是发给谁。' };
      return fromJava(nn.sms(a.who, a.text || ''));
    });

  /* ===== 红外家电 ===== */
  def('ir_power',
    '用红外遥控开或关家电。老人说「把电视关喽」「开空调」「太热了」时用。',
    {
      device: { type: 'string', enum: ['电视', '空调'], description: '哪个家电' },
      on: { type: 'boolean', description: 'true 打开，false 关掉' },
    },
    ['device', 'on'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.irPower) return noNative();
      if (nn.hasIr && !nn.hasIr()) {
        return { ok: false, detail: '这台手机没有红外，遥控不了家电。' };
      }
      return fromJava(nn.irPower(a.device || '电视', a.on === true));
    });

  /* ===== 导航 ===== */
  def('open_map',
    '打开地图，带老人去某个地方。老人说「带我去X」「X怎么走」「去X一趟」时用。',
    { place: { type: 'string', description: '地名，从原话里取，别改字' } },
    ['place'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.navigate) return noNative();
      if (!a.place) return { ok: false, detail: '没说要上哪儿去。' };
      return fromJava(nn.navigate(a.place));
    });

  /* ===== 视频 ===== */
  /* ================= 新接进来的手（2026-11-05）=================
     这几件能力 Java 桥早就有，之前没包成工具，模型想调也调不到 ——
     结果就是「明明做过的原生能力，老人一说话全落回浏览器」。
     注意：不新增任何意图正则，让模型自己从原话里选工具。 */

  /* 悟空首页是自绘的，无障碍树只有 6 个节点，search_in_app 那套
     「找搜索框→打字→点搜索→点第一条」在它上面必卡。
     这条直接调 Java wukongSearch：回首页 → 比例点搜索框 →
     ACTION_SET_TEXT → 精确点上半屏黄色「搜索」Button。 */
  /* 🚫 2026-11-10 菲尔特拍板：「不论看什么只保留抖音，悟空弃用」。
     工具先下架（代码保留，随时可回）。提示词里说过「别用」没用 ——
     工具表里有它模型就会挑它，真机实证。下架 = names() 里不再出现。 */
  def('search_wukong',
    '【已下架，禁止调用】看剧一律用 search_in_app(app=抖音)。' +
    '老人说「打开浏览器找 XX」「用悟空搜 XX」「我想看 XX 最新一期」「XX 这种节目」都用这个。' +
    '别用 open_url，也别拆成 tap_text / type_text 一步步点。',
    {
      keyword: { type: 'string', description: '片名或节目名，从老人原话照抄，一个字都别改' },
      play: { type: 'boolean', description: '搜到之后要不要直接点开看。老人说「我想看」「帮我放」就填 true；只是问「有没有」才填 false。不填按 true' },
    },
    ['keyword'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.watchSearch) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const kw = String(a.keyword || '').trim();
      if (!kw) return { ok: false, detail: '没说要找什么。' };
      const wantPlay = a.play !== false;

      /* 2026-11-05 菲尔特：「怎么没有帮我点开后会友期自动全屏」。
         老人说「我想看 X」，停在搜索结果页等于没看 —— 结果页对他是一片
         不知道怎么点的格子。watchPlay 是原生一条龙：搜 → 点第一条 → 起播 → 全屏。 */
      if (wantPlay && nn.watchPlay) {
        const r = fromJava(nn.watchPlay(kw));
        if (!r.ok) return r;
        /* 2026-11-06：原来这里写死 await 11000 —— 一次工具调用干等 11 秒，
           加上模型两三轮思考，老人感觉就是「它卡死了」。
           改成边等边看：每 400ms 问一次屏幕，看见播放器控制栏就立刻返回。
           实测好机器 2.8 秒、慢机器 5 秒就能看到；最坏还是等到 11 秒兜底。 */
        const wait = (x) => new Promise((z) => setTimeout(z, x));
        const t0 = Date.now();
        let flat = '';
        while (Date.now() - t0 < 11000) {
          await wait(400);
          try {
            const j = JSON.parse(nn.screenText ? nn.screenText() : '{}');
            flat = JSON.stringify((j && j.nodes) || []);
          } catch (e) { continue; }
          /* 看见「下一集/上一集/选集」就是播放页真的起来了 —— 这一条最靠得住 */
          if (/下一集|上一集|选集/.test(flat)) {
            return { ok: true, detail: '「' + kw + '」给你点开放上了，全屏了。不想看就说下一集或者关了它。' };
          }
        }
        if (/播放|暂停/.test(flat)) {
          return { ok: true, detail: '「' + kw + '」给你点开放上了，全屏了。不想看就说下一集或者关了它。' };
        }
        return { ok: false, detail: '搜到「' + kw + '」了，但没点进播放页，可能是结果页变了。' };
      }

      const since = Date.now();
      /* 2026-11-08：不再用悟空浏览器。短剧走红果，其余走抖音搜索。 */
      const dd0 = window.MILI_TV && window.MILI_TV.resolve(kw);
      if (dd0 && dd0.type === 'app') return window.MILI_TV.openApp(dd0);
      return window.MILI_TV.openDl({
        url: 'snssdk1128://search?keyword=' + encodeURIComponent(kw),
        name: '抖音·' + kw
      });
      const r = fromJava(nn.watchSearch('抖音', kw));
      if (!r.ok) return r;
      /* Java 那句 ok 只代表「发起了延时任务」。真的要等悟空切到它自己的
         搜索页（SearchActivity）才算数；停在首页 BrowserMainActivity 就是没办成。 */
      /* 窗口事件的 className 在这台机上是 android.widget.FrameLayout，
         不是 Activity 名，靠它判断会误判（实测前台已是 SearchActivity 却报没进）。
         改成看屏幕上真出现了什么：搜索页有「搜索框」和黄色「搜索」按钮，
         结果页有片名。轮询期间只要看见一次就算进去了。 */
      const wait = (x) => new Promise((z) => setTimeout(z, x));
      const t0 = Date.now();
      let saw = false;
      while (Date.now() - t0 < 9000 && !saw) {
        try {
          const j = JSON.parse(nn.screenText ? nn.screenText() : '{}');
          const flat = JSON.stringify((j && j.nodes) || []);
          if (flat.indexOf('搜索框') >= 0 || (flat.indexOf(kw) >= 0 && flat.indexOf('搜索') >= 0)) saw = true;
        } catch (e) {}
        if (!saw) await wait(500);
      }
      if (!saw) {
        return { ok: false, detail: '悟空是打开了，但没进搜索页，可能是页面还没加载完或者被挡住了。' };
      }
      return { ok: true, detail: '在悟空浏览器里搜「' + kw + '」了，结果页带全集和播放器。' };
    });

  def('resume_show',
    '接着上次没看完的那部剧，直接进播放页。老人说「接着看」「继续看」「上次那个剧」「追剧」时用。',
    {}, [],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.resumeWukong) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const r = fromJava(nn.resumeWukong());
      if (!r.ok) return r;
      /* 观看历史是自绘卡片，点没点中要看播放页的控制栏有没有出来。
         同上：别盲等 5.2 秒，看见控制栏就走。 */
      const wait = (x) => new Promise((z) => setTimeout(z, x));
      const t0 = Date.now();
      let flat = '';
      while (Date.now() - t0 < 8000) {
        await wait(400);
        try {
          const j = JSON.parse(nn.screenText ? nn.screenText() : '{}');
          flat = JSON.stringify((j && j.nodes) || []);
        } catch (e) { continue; }
        if (/下一集|上一集|选集/.test(flat)) break;
      }
      if (/下一集|上一集|选集|播放/.test(flat)) {
        return { ok: true, detail: '接着上次那部剧，播放页开好了。' };
      }
      return { ok: false, detail: '打开了悟空，但没进播放页，可能是观看历史那一块位置变了。' };
    });

  def('grab_redpacket',
    '把别人发来的微信红包领了，并告诉老人是谁发的、多少钱。' +
    '老人说「领红包」「把红包收了」「有人给我发红包」时用。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.hongbao) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      return fromJava(nn.hongbao());
    });

  def('tv_next',
    '换到下一个电视频道。老人说「换个台」「下个台」时用；点名了频道号就用 tv_channel。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.tvNext) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      return fromJava(nn.tvNext());
    });

  /* ===== 播放控制 / 翻页 / 返回（2026-11-05 补的三只手） =====
     以前「下一集」「暂停」只接在常驻唤醒词里，说话走主流程和打字都调不到 ——
     菲尔特：「能不能上下集切换了啊」。现在它们都是工具，模型自己会选。 */
  def('player_control',
    '控制正在播的视频：暂停、继续、上一集、下一集、全屏。' +
    '老人说「暂停」「接着放」「下一集」「上一集」「全屏看」时用。' +
    '不要用 open_url 或 play_video 重新开一遍 —— 那样会从头播。',
    { cmd: { type: 'string', description: '只能是这几个之一：暂停、播放、上一集、下一集、全屏' } },
    ['cmd'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.playerControl) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const c = String(a.cmd || '').trim();
      if (!c) return { ok: false, detail: '没说要干什么。' };
      const r = fromJava(nn.playerControl(c));
      if (!r.ok) return { ok: false, detail: '屏幕上没找到播放器的按钮，可能已经退出来了。' };
      const said = c === '暂停' ? '暂停了。'
        : c === '播放' ? '接着放了。'
        : c === '下一集' ? '给你换下一集了。'
        : c === '上一集' ? '退回上一集了。'
        : '全屏了。';
      return { ok: true, detail: said };
    });

  /* ==========================================================================
   * 自己看界面、自己指坐标
   *
   * 以前只有 tap_text：按文字找按钮。文字对不上（图标按钮、图片、播放器、
   * 菜单藏在角落）就只会说「点不动」。业界做法（OpenGUI / Mobile-Agent）是
   * 把这一屏的元素连同坐标交给模型，模型自己指 —— 这里照做：
   *   ui_map   这一屏有什么，每处都带百分比坐标
   *   tap_at   按坐标点下去
   *   swipe_screen  上/下/左/右翻
   * 全程百分比，换分辨率不用改坐标。
   * ======================================================================== */

  /* ---------- 界面「变了没有」的指纹 ---------- */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* 点完这一下，屏幕到底变没变？拿节点文字拼一个指纹比一比。
     比的是「字变没变」而不是截图，省一次截屏，也足够判断有没有跳页。 */
  function screenSig(nn) {
    try {
      if (!nn || !nn.nodeMap) return '';
      const j = NJ(nn.nodeMap());
      if (!j || !j.nodes) return '';
      let s = '';
      for (let i = 0; i < j.nodes.length; i++) {
        const o = j.nodes[i] || {};
        s += (o.t || o.d || '') + '|';
      }
      return s.length + ':' + s.slice(0, 80) + s.slice(-80);
    } catch (e) { return ''; }
  }

  function pctNodes(j) {
    const W = Number(j.w || 0), H = Number(j.h || 0);
    if (!W || !H) return null;
    const seen = {};
    const out = [];
    const list = j.nodes || [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i] || {};
      const b = String(o.b || '').split(',').map(Number);
      if (b.length !== 4) continue;
      const w = b[2] - b[0], h = b[3] - b[1];
      if (w < 10 || h < 10) continue;              /* 太小，手指点不准 */
      const cx = Math.round((b[0] + b[2]) / 2 / W * 100);
      const cy = Math.round((b[1] + b[3]) / 2 / H * 100);
      if (cx < 1 || cx > 99 || cy < 1 || cy > 99) continue;
      const label = String(o.t || o.d || '').replace(/\s+/g, ' ').trim();
      const key = label + '|' + cx + '|' + cy;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ t: label, c: o.c === 1, e: o.e === 1, cx: cx, cy: cy });
      if (out.length >= 45) break;                 /* 别把上下文塞爆 */
    }
    return out;
  }

  def('ui_map',
    '看清这一屏上有哪些能用手指点/能打字的地方，每一处都带百分比坐标。' +
    '要做的事没有专门工具、或者 tap_text 说找不到 的时候，先用它看清，再用 tap_at 按坐标点。' +
    '返回一行一处：「● 文字 @x,y」（●能点、✎能打字、·只是字）。',
    {},
    [],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.nodeMap) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const j = NJ(nn.nodeMap());
      if (!j || j.err) return { ok: false, detail: '这一屏读不出来（有的 App 会把界面结构封掉）。改用 look_screen 拍照看。' };
      const ns = pctNodes(j);
      if (!ns || !ns.length) return { ok: false, detail: '这一屏没读到能点的东西。改用 look_screen 拍照看。' };
      const lines = [];
      let clicks = 0, edits = 0;
      for (const x of ns) {
        const mark = x.e ? '✎' : (x.c ? '●' : '·');
        if (x.e) edits++; else if (x.c) clicks++;
        const label = x.t ? x.t.slice(0, 24) : '（没字的图标）';
        lines.push(mark + ' ' + label + ' @' + x.cx + ',' + x.cy);
      }
      return {
        ok: true,
        detail: '这一屏 ' + j.pkg + '｜能点 ' + clicks + ' 处、能打字 ' + edits + ' 处\n' + lines.join('\n'),
        extra: { pkg: j.pkg, nodes: ns },
      };
    });

  def('tap_at',
    '按屏幕百分比坐标点一下。坐标从 ui_map 或 look_screen 里来（x、y 都是 0~100 的整数，' +
    '屏幕左上角是 0,0，右下角是 100,100）。tap_text 找不到、或者要点图标/图片/播放器时用它。',
    {
      x: { type: 'number', description: '横坐标百分比 0~100' },
      y: { type: 'number', description: '纵坐标百分比 0~100' },
      why: { type: 'string', description: '你要点的东西叫什么，说给老人听，如「选集按钮」' },
    },
    ['x', 'y'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.tapPercent) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const g = wxGuard(nn, 'tap_at'); if (g) return g;
      let x = Number(a.x), y = Number(a.y);
      if (!isFinite(x) || !isFinite(y)) return { ok: false, detail: '坐标不对，没点。' };
      if (x > 0 && x <= 1 && y > 0 && y <= 1) { x *= 100; y *= 100; }  /* 防它按 0~1 给 */
      if (x < 0 || x > 100 || y < 0 || y > 100) return { ok: false, detail: '坐标超出屏幕了，没点。' };
      const before = screenSig(nn);
      const r = NJ(nn.tapPercent(x / 100, y / 100));
      if (!r || r.ok !== true) return { ok: false, detail: '这一下没点动（系统没接），换个位置再试。' };
      await sleep(650);
      const changed = before !== screenSig(nn);
      const what = String(a.why || '').trim();
      return {
        ok: true,
        detail: (what ? '点了「' + what + '」' : '点了一下') + (changed ? '，屏幕变了。' : '，屏幕看着没变。'),
        extra: { changed: changed },
      };
    });

  def('swipe_screen',
    '把当前屏幕翻一下（上滑看后面的内容、下滑往回、左滑右滑换页）。' +
    '列表、聊天记录、商品页、设置页只看得到一半的时候用它。',
    { dir: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '往哪翻' } },
    ['dir'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.swipe) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const d = String(a.dir || 'up');
      const M = {
        up: [0.5, 0.78, 0.5, 0.30],
        down: [0.5, 0.30, 0.5, 0.78],
        left: [0.82, 0.5, 0.18, 0.5],
        right: [0.18, 0.5, 0.82, 0.5],
      };
      const p = M[d] || M.up;
      const r = fromJava(nn.swipe(p[0], p[1], p[2], p[3]));
      if (!r.ok) return r;
      await sleep(600);
      return { ok: true, detail: '翻了一屏（' + ({ up: '往上', down: '往下', left: '往左', right: '往右' }[d] || '往上') + '）。' };
    });

  /* ==========================================================================
   * 通用动作的第二层：等、找、按、长按、看清单、读通知
   *
   * 上一组（ui_map / tap_at / swipe_screen）解决「点得准」。
   * 这一组解决「接得上」—— 上面那一层最容易翻车的地方不是点错，是点完就急着往下走，
   * 页面还没出来。手机上的事是一步一步发生的，没有 wait_for 就只能靠 sleep 瞎猜。
   * ======================================================================== */

  def('wait_for',
    '等屏幕上出现某几个字再往下走（等页面打开、等搜索结果、等弹窗出来）。' +
    '点完、搜完、发完都应该用它确认真的到了，不要点完就当成了。',
    {
      text: { type: 'string', description: '要等的字，屏幕上任何位置出现就算到了' },
      sec: { type: 'number', description: '最多等几秒，默认 6，最长 20' },
    },
    ['text'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.nodeMap) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const key = String(a.text || '').trim();
      if (!key) return { ok: false, detail: '没说要等什么。' };
      let sec = Number(a.sec) || 6;
      if (sec > 20) sec = 20;
      const t0 = Date.now();
      while (Date.now() - t0 < sec * 1000) {
        const j = NJ(nn.nodeMap());
        const ns = j && !j.err ? pctNodes(j) : null;
        if (ns) {
          for (const x of ns) {
            if (x.t && x.t.indexOf(key) >= 0) {
              return { ok: true, detail: '到了：屏幕上出现「' + key + '」，在 ' + x.cx + ',' + x.cy + '。' };
            }
          }
        }
        await sleep(400);
      }
      return { ok: false, detail: '等了 ' + sec + ' 秒还没看到「' + key + '」。可以 look_screen 看一眼现在到哪了。' };
    });

  def('find_text',
    '在屏幕上找一段字，只找不点，告诉你它在哪个坐标（找到就从这儿 tap_at 点下去）。' +
    '想确认某句话在不在、按钮在哪、要不要往下翻，都用它。',
    { text: { type: 'string', description: '要找的字' } },
    ['text'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.nodeMap) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const key = String(a.text || '').trim();
      if (!key) return { ok: false, detail: '没说要找什么。' };
      const j = NJ(nn.nodeMap());
      const ns = j && !j.err ? pctNodes(j) : null;
      if (!ns) return { ok: false, detail: '这一屏读不出来。改用 look_screen 拍照看。' };
      const hits = ns.filter((x) => x.t && x.t.indexOf(key) >= 0);
      if (!hits.length) return { ok: false, detail: '这一屏上没有「' + key + '」。可能还没加载出来，也可能要往下翻。' };
      const h = hits[0];
      return {
        ok: true,
        detail: '「' + key + '」在 ' + h.cx + ',' + h.cy + (hits.length > 1 ? '（这一屏一共 ' + hits.length + ' 处）' : ''),
        extra: { hits: hits.slice(0, 8).map((x) => ({ t: x.t, x: x.cx, y: x.cy })) },
      };
    });

  def('press_key',
    '按手机的实体键：回桌面（home）、返回（back）、最近任务（recents）、下拉通知栏（notifications）。' +
    '没反映的时候别干等，先退一步看看现在到底在哪。',
    { key: { type: 'string', enum: ['home', 'back', 'recents', 'notifications'], description: '按哪个' } },
    ['key'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.pressKey) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const k = String(a.key || 'back');
      const r = NJ(nn.pressKey(k));
      if (!r || r.ok !== true) return { ok: false, detail: '这个键没按动。' };
      await sleep(k === 'home' ? 900 : 500);
      const M = { home: '回到桌面', back: '退回去一步', recents: '打开最近用的', notifications: '拉下通知栏' };
      return { ok: true, detail: (M[k] || '按了') + '。' };
    });

  def('long_press',
    '在某处按住不放（长按）。微信的复制、转发、删除、撤回，都在长按菜单里，' +
    '点一下是出不来的 —— 这种时候用它，坐标同样来自 ui_map 或 find_text。',
    {
      x: { type: 'number', description: '横坐标百分比 0~100' },
      y: { type: 'number', description: '纵坐标百分比 0~100' },
      why: { type: 'string', description: '你在长按什么，说给老人听' },
    },
    ['x', 'y'],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.longPress) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const g = wxGuard(nn, 'long_press'); if (g) return g;
      let x = Number(a.x), y = Number(a.y);
      if (!isFinite(x) || !isFinite(y)) return { ok: false, detail: '坐标不对，没按。' };
      if (x > 0 && x <= 1 && y > 0 && y <= 1) { x *= 100; y *= 100; }
      if (x < 0 || x > 100 || y < 0 || y > 100) return { ok: false, detail: '坐标超出屏幕了，没按。' };
      const r = NJ(nn.longPress(x / 100, y / 100));
      if (!r || r.ok !== true) return { ok: false, detail: '这一下没按住。' };
      await sleep(800);
      const what = String(a.why || '').trim();
      return { ok: true, detail: (what ? '长按了「' + what + '」' : '长按了') + '，看看有没有出菜单。' };
    });

  def('list_apps',
    '看看这台手机上都装了什么（能打开的都在）。老人说「那个看视频的」「我平时用的那个」，' +
    '或者你想打开一个 App 但不确定叫什么的时候，先用它看清楚再 open_app。',
    {},
    [],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.listApps) return noNative();
      const j = NJ(nn.listApps());
      if (!j || !j.ok || !j.apps) return { ok: false, detail: '这台手机上读不到装了哪些。' };
      const arr = j.apps.slice(0, 60);
      const names = arr.map((x) => x.name).join('、');
      return {
        ok: true,
        detail: '装了这些：' + names,
        extra: { apps: arr },
      };
    });

  def('read_notifications',
    '看最近谁给你发了消息、装了什么（微信、短信、各种 App 的通知都在）。' +
    '老人问「有人找我吗」「刚才谁发消息了」，或者你想知道刚才那条消息是谁发的，就用它。',
    { minutes: { type: 'number', description: '只看最近几分钟，默认 60' } },
    [],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.recentNotifs) return noNative();
      const mins = Number(a.minutes) || 60;
      const j = NJ(nn.recentNotifs(20, mins));
      if (!j || !j.ok) return { ok: false, detail: '通知读不出来（系统没给通知使用权）。' };
      const list = j.list || [];
      if (!list.length) return { ok: true, detail: '最近没有新消息。' };
      const lines = list.map((x) => {
        const m = Math.max(0, Math.round((Date.now() - Number(x.t || 0)) / 60000));
        const ago = m < 1 ? '刚刚' : (m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前');
        const who = String(x.title || '').replace(/\s+/g, ' ').slice(0, 20);
        const tx = String(x.text || '').replace(/\s+/g, ' ').slice(0, 40);
        return ago + ' · ' + who + '：' + tx;
      });
      return { ok: true, detail: '最近 ' + list.length + ' 条：\n' + lines.join('\n'), extra: { list } };
    });

  def('look_screen',
    '看一眼手机屏幕长什么样，能用来看懂界面（不只是读上面的字）。' +
    'screen_text 读不出东西、或者老人指着屏幕问「这是啥」「这怎么弄」的时候用。' +
    '它会回一段人话描述这个界面是什么、下一步能点哪里。',
    { question: { type: 'string', description: '想问这个界面的什么。不填就默认问「这是什么界面、下一步该点哪里」' } },
    [],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.shotScreen) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      if (!E.visionAsk) return { ok: false, detail: '这台手机上我看不了图。' };
      const j = NJ(nn.shotScreen());
      if (!j || !j.ok || !j.b64) return { ok: false, detail: '这回没看清屏幕。' };
      const q = String(a.question || '').trim()
        || '这是手机的当前界面。用两三句口语说清：这是什么界面、老人在这一步通常想干什么、该点屏幕上的哪个字或哪个位置。';
      const ans = await E.visionAsk(j.b64, q);
      if (!ans) return { ok: false, detail: '屏幕看到了，但没认出来是什么。' };
      return { ok: true, detail: ans };
    });

  def('scroll_screen',
    '把当前屏幕往下或往上翻一页。屏幕上看不到要找的东西时用 —— 列表很长、要往下看更多结果。',
    { dir: { type: 'string', description: 'down = 往下翻（看后面的），up = 往上翻（回前面）' } },
    [],
    async function (a, E) {
      const nn = n(E); if (!nn || !nn.swipe) return noNative();
      const bad = accGuard(nn); if (bad) return bad;
      const d = String(a.dir || 'down').toLowerCase();
      const r = fromJava(d === 'up' ? nn.swipe(0.5, 0.32, 0.5, 0.72) : nn.swipe(0.5, 0.72, 0.5, 0.32));
      if (!r.ok) return { ok: false, detail: '这一页翻不动。' };
      await new Promise((z) => setTimeout(z, 700));
      return { ok: true, detail: d === 'up' ? '往上翻了一页。' : '往下翻了一页。' };
    });

  def('go_back',
    '按一下手机的返回键。走错界面、要退回上一层时用。',
    {}, [],
    function (a, E) {
      /* 全屏电视开着时，返回键就是退出电视 */
      if (window.MILI_TV && window.MILI_TV.close()) return { ok: true, detail: '退出来啦。' };
      const nn = n(E); if (!nn || !nn.pressBack) return noNative();
      const r = fromJava(nn.pressBack());
      return r.ok ? { ok: true, detail: '退回上一层了。' } : { ok: false, detail: '退不动了。' };
    });

  /* ===== 接 / 挂（白名单自动接的人工补充）===== */
  def('answer_call',
    '接电话、接微信来电。老人说「接一下」「接了吧」「帮我接」时用。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.answerRing) return noNative();
      return fromJava(nn.answerRing());
    });
  def('hang_up',
    '挂断。老人说「挂了吧」「挂断」「别接了」「不接了」时用。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.endRing) return noNative();
      return fromJava(nn.endRing());
    });

  def('play_video',
    '打开视频软件给老人看片子。三种情况：说了片名就按片名找；只说了软件名就开那个软件；' +
    '都没说（比如「接着看上次那个」）就开默认软件继续上次看的。',
    {
      app: { type: 'string', description: '软件名，如 爱奇艺、芒果TV、抖音。老人没说就留空' },
      show: { type: 'string', description: '片子名，如 后会有期。老人没说就留空' },
    },
    [],
    function (a, E) {
      const nn = n(E); if (!nn) return noNative();
      const app = String(a.app || '').trim();
      const show = String(a.show || '').trim();

      /* 直达优先：新闻/戏曲/频道/短剧 这些预合成过的，一秒内出画面 */
      if (show) {
        const d = window.MILI_TV && window.MILI_TV.resolve(show);
        if (d) {
          if (d.type === 'tv') return window.MILI_TV.open(d.url, d.name);
          if (d.type === 'dl') return window.MILI_TV.openDl(d);
          if (d.type === 'app') return window.MILI_TV.openApp(d);
          return { ok: false, detail: '没找到。' };
        }
      }

      /* 软件 + 片名都有：在那个软件里搜 */
      if (app && show && nn.watchSearch) return fromJava(nn.watchSearch(app, show));
      /* 只有片名：2026-11-08 起不走浏览器、不走悟空。
         短剧/红果 → 红果 App；其余 → 抖音搜索深链（真机验证直达结果页）。 */
      if (show && window.MILI_TV) {
        const dd = window.MILI_TV.resolve(show);
        if (dd && dd.type === 'app') return window.MILI_TV.openApp(dd);
        return window.MILI_TV.openDl({
          url: 'snssdk1128://search?keyword=' + encodeURIComponent(show),
          name: '抖音·' + show
        });
      }
      if (show && nn.watchShow) return fromJava(nn.watchShow(show));
      /* 都没说：接着上次那部剧，别只把 App 首页打开 */
      if (!app && !show && nn.resumeWukong) return fromJava(nn.resumeWukong());
      if (nn.watch) return fromJava(nn.watch(app));
      return noNative();
    });

  def('watch_video',
    '老人说想看某个剧、短剧、视频（「我想看红果短剧」「我想看昨天那个片子」）时用这个。' +
    '它会先看手机上有没有对应的 App，有就直接打开；没有才用浏览器搜。',
    { name: { type: 'string', description: '想看的内容或 App 名字，如「红果短剧」「哔哩」「新闻联播」' } },
    ['name'],
    function (a, E) {
      /* 直达优先：预合成过的内容一秒内全屏 */
      const d = window.MILI_TV && window.MILI_TV.resolve(a.name);
      if (d) {
        if (d.type === 'tv') return window.MILI_TV.open(d.url, d.name);
        if (d.type === 'dl') return window.MILI_TV.openDl(d);
          if (d.type === 'app') return window.MILI_TV.openApp(d);
        if (d.type === 'app') return window.MILI_TV.openApp(d.pkg, d.name);
      }
      const nn = n(E); if (!nn || !nn.watchWhat) return noNative();
      return fromJava(nn.watchWhat(a.name));
    });

  def('volume',
    '调手机外放音量。老人说「声音大点」「声音小点」「太吵了」「听不见」时用。',
    { action: { type: 'string', description: 'up 或 down' } },
    ['action'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.volume) return noNative();
      const v = String(a.action || '').toLowerCase();
      return fromJava(nn.volume(v.indexOf('down') >= 0 || v.indexOf('小') >= 0 ? 'down' : 'up'));
    });

  def('media',
    '播放控制：暂停、接着放、下一集、上一集。' +
    '老人说「暂停」「别放了」「下一集」「上一集」「接着放」时用。任何播放器都吃这一套。',
    { action: { type: 'string', description: 'pause / play / next / prev' } },
    ['action'],
    function (a, E) {
      const nn = n(E); if (!nn) return noNative();
      const act = String(a.action || '').toLowerCase();
      /* 我们自己的全屏电视开着时：暂停/切集/上一集都等于「不看了」，直接退 */
      if (act !== 'play' && window.MILI_TV && window.MILI_TV.close()) {
        return { ok: true, detail: '退出来啦。' };
      }
      const bad0 = accGuard(nn); if (bad0) return bad0;
      /* 系统媒体键对网页视频、抖音、红果不生效 —— 先点播放器自己的按钮。
         实测悟空播剧时「上一集/下一集/播放」都是可读节点。 */
      const CN = { pause: '暂停', play: '播放', next: '下一集', prev: '上一集' };
      if (nn.playerControl && CN[act]) {
        const r = fromJava(nn.playerControl(CN[act]));
        if (r.ok) return { ok: true, detail: '点了播放器的「' + CN[act] + '」按钮。' };
      }
      if (nn.media) return fromJava(nn.media(act));
      return noNative();
    });

  def('tv_channel',
    '看 CCTV 的某个频道：中央一台、CCTV5、新闻频道、体育频道这些。' +
    '注意：老人只泛泛说「看电视」用 watch_news；点名了频道号或频道名才用这个。',
    { channel: { type: 'string', description: '频道，如 中央一台、CCTV5、新闻频道、体育' } },
    ['channel'],
    function (a, E) {
      const d = window.MILI_TV && window.MILI_TV.resolve(a.channel);
      if (d) {
        if (d.type === 'tv') return window.MILI_TV.open(d.url, d.name);
        if (d.type === 'dl') return window.MILI_TV.openDl(d);
          if (d.type === 'app') return window.MILI_TV.openApp(d);
        if (d.type === 'app') return window.MILI_TV.openApp(d.pkg, d.name);
      }
      const nn = n(E); if (!nn || !nn.tvChannel) return noNative();
      return fromJava(nn.tvChannel(String(a.channel || '')));
    });

  /* 一条龙：在某个 App 里搜内容并打开第一条。
     为什么要合成一个工具：拆成四步让模型自己串，实测它会说一句
     「我这就点搜索」然后就收工（模型的多轮不是每次都那么听话）。
     这四步是死的顺序、不需要判断，合成一个动作用时更短、也稳。 */
  def('search_in_app',
    '在某个 App 里搜内容，并点开第一条。' +
    '「抖音上搜 XX」「在红果里找某部剧」「爱奇艺搜 XX」都用这个。' +
    '「抖音上搜 XX」「在红果里找 XX」「爱奇艺搜 XX」都用这个。' +
    '老人只说片名没说平台（「我想看 XX」「XX 最新一期」）→ app 填抖音，就用这个。',
    {
      app: { type: 'string', description: '在哪个 App 里搜，如 抖音、红果、爱奇艺' },
      keyword: { type: 'string', description: '搜什么，就是老人说的那个内容名' },
    },
    ['keyword'],
    async function (a, E) {
      const nn = n(E); if (!nn) return noNative();
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const J = (x) => { try { return JSON.parse(x); } catch (e) { return { ok: false }; } };

      const app = String(a.app || '').trim();
      const kw = String(a.keyword || '').trim();
      if (!kw) return { ok: false, detail: '没说要搜什么。' };

      /* 🚨 2026-11-10 21:4x 菲尔特真机实弹：「抖音打开天天耍大牌，然后全屏」
         被模型拆成 open_app → ui_map → tap_at(搜索框) → tap_at(搜索)，
         停在 SearchResultActivity 结果页、全程 ROTATION_0，视频都没点开。
         抖音不要再走 20 秒的 UI 自动化，也不许模型自己点：一次桥调用
         playDouyin(kw) 就是原生一条龙（深链 → 点第一张卡 → 全屏 → 验横屏）。 */
      if (/抖音|douyin/i.test(app)) {
        const clean = String(kw)
          .replace(/抖音|打开|然后|全屏|搜一下|搜搜|搜索|给我|帮我|一下|[,，。.!！?？\s]/g, '')
          .trim() || kw;
        try {
          if (nn.playDouyin) {
            const r = JSON.parse(nn.playDouyin(clean) || '{}');
            if (r && r.ok) return { ok: true,
              detail: '「' + clean + '」已经在抖音横屏全屏播放了。任务到此完成，'
                    + '不要再调用任何工具（尤其不要 look_screen / player_control / ui_map），直接回一句给老人。' };
          }
        } catch (e) {}
      }

      if (app) {
        const p = pkgOf(app);
        if (!p) return { ok: false, detail: '不认得「' + app + '」这个软件。' };
        if (nn.hasApp && !nn.hasApp(p)) return { ok: false, detail: '这台手机上没装' + app + '。' };
        if (nn.launchApp) nn.launchApp(p);
        await wait(2600);
      }

      /* 1) 进搜索页。有的 App 要等一下才出搜索入口 */
      let hit = J(nn.tapText('搜索'));
      if (!hit.ok && nn.pressBack) {
        /* 常见情况：它还停在上次那个搜索结果页，界面上没有搜索入口。
           退两步回首页再找。 */
        nn.pressBack(); await wait(900);
        hit = J(nn.tapText('搜索'));
        if (!hit.ok) {
          nn.pressBack(); await wait(900);
          hit = J(nn.tapText('搜索'));
        }
      }
      if (!hit.ok) { await wait(1200); hit = J(nn.tapText('搜索')); }
      if (!hit.ok) {
        return { ok: false, detail: '这个界面上没找到搜索的地方，可能还没加载完。' };
      }
      await wait(1400);

      /* 2) 打字。搜索框可能还没焦点，先点一下再打。
         打完**必须验一遍**：有的输入框对「写字」返回成功，屏幕上却一个字没有
         （悟空浏览器的地址栏就是这样，交接文档里挂了三天）。
         验不到就当没打成，换粘贴再来 —— 这是「动作-验证」的最小闭环。 */
      const screenHas = (w) => {
        if (!nn.screenText) return true;      // 验不了就当成功，别把好路当坏路
        try {
          const j = J(nn.screenText());
          return JSON.stringify((j && j.nodes) || []).indexOf(w) >= 0;
        } catch (e) { return true; }
      };

      const silentFail = (r) => !(r && r.ok) || (nn.screenText && !screenHas(kw));

      /* 以前在这类框上白试过，就直接走粘贴 —— 这一步才是「学到了」的兑现：
         不是每次都重演一遍失败，是知道它不行就绕开。 */
      const known = !!(E.knownFail && E.knownFail('type_text', app));
      let typed = known ? { ok: false, why: 'known_bad' } : J(nn.typeText(kw));
      if (typed.ok && !screenHas(kw)) {
        typed = { ok: false, why: 'set_text_silent' };
        /* 这次是绕过去了，但必须记下来 —— 下次直接走粘贴，别再白试一遍 */
        if (E.noteFail) E.noteFail('type_text', { q: kw }, '返回成功但屏幕上没进字', 'paste_text');
      }
      if (!typed.ok) {
        nn.tapText('搜索');
        await wait(700);
        typed = J(nn.typeText(kw));
        if (typed.ok && !screenHas(kw)) typed = { ok: false };
      }
      if (!typed.ok && nn.pasteText) {
        nn.tapText('搜索');
        await wait(700);
        typed = J(nn.pasteText(kw));
      }
      if (!typed.ok) return { ok: false, detail: '搜索框里打不进字（写字和粘贴都试过了）。' };
      await wait(900);

      /* 3) 提交搜索：只点屏幕上半部的「搜索」，避开键盘上那个同名键 */
      let sub = { ok: false };
      if (nn.tapTextTop) sub = J(nn.tapTextTop('搜索', 1200));
      if (!sub.ok) nn.tapText('搜索');
      await wait(3500);
      /* 还停在联想页就再提交一次 */
      if (nn.tapTextTop && !sub.ok) { J(nn.tapTextTop('搜索', 1200)); await wait(2500); }

      /* 4) 点第一条 */
      const first = J(nn.tapResult());
      if (!first.ok) return { ok: false, detail: '搜到了，但没点开第一条。' };
      await wait(1200);
      return { ok: true, detail: '在' + (app || '这个 App') + '里搜「' + kw + '」，第一条点开了。' };
    });

  def('tap_result',
    '点搜索结果里的第一条。搜索结果都是图片/视频块、没有文字，tap_text 点不到，用这个。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.tapResult) return noNative();
      const raw = nn.tapResult();
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { return { ok: false, detail: '点不了。' }; }
      if (!j || !j.ok) return { ok: false, detail: '这个界面上没找到能点的结果块。先 screen_text 看一眼。' };
      return { ok: true, detail: '点了第一条' };
    });

  def('screen_text',
    '看当前手机屏幕上都有什么字和按钮。用它来确认「现在在哪个界面」「搜索框在哪」「第一条结果是什么」。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.screenText) return noNative();
      const raw = nn.screenText();
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { return { ok: false, detail: '读不到屏幕。' }; }
      if (!j || j.err) return { ok: false, detail: '读不到屏幕：' + ((j && j.err) || '未知') };
      const items = (j.nodes || []).slice(0, 28).map((x) =>
        (x.t || x.d ? (x.t || x.d) : '') + (x.e ? '[输入框]' : '') + (x.c ? '[可点]' : ''));
      return {
        ok: true,
        detail: '现在是 ' + j.pkg + '，屏幕上有：' + items.filter(Boolean).join(' / ').slice(0, 600),
        pkg: j.pkg,
      };
    });

  def('tap_text',
    '在当前界面上找这几个字，然后点它。找搜索框、点「搜索」按钮、点第一条视频、点「选集」，都用它。',
    { text: { type: 'string', description: '要点的那几个字，尽量短，如「搜索」「第一集」「选集」' } },
    ['text'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.tapText) return noNative();
      const g = wxGuard(nn, 'tap_text'); if (g) return g;
      const raw = nn.tapText(String(a.text || ''));
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { return { ok: false, detail: '点不了。' }; }
      if (!j || !j.ok) {
        return { ok: false, detail: '屏幕上没找到「' + (a.text || '') + '」。先 screen_text 看一眼现在是什么界面。' };
      }
      return { ok: true, detail: '点了「' + a.text + '」（' + (j.how || '') + '）' };
    });

  def('type_text',
    '往当前输入框里打一段字。搜索剧名、搜抖音内容时，点了搜索框之后用它。',
    { text: { type: 'string', description: '要打的字，如 甄嬛传、农村搞笑' } },
    ['text'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.typeText) return noNative();
      const g = wxGuard(nn, 'type_text'); if (g) return g;
      const raw = nn.typeText(String(a.text || ''));
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { return { ok: false, detail: '打不进去。' }; }
      if (!j || !j.ok) return { ok: false, detail: '没找到能打字的框。先 tap_text 点一下搜索框。' };
      return { ok: true, detail: '打上了「' + a.text + '」' };
    });

  /* 第二条路：直接写字的框返回成功也可能一个字没进（浏览器地址栏就是这样）。
     paste_text 绕开「写字」这个接口，把字放进剪贴板让输入框自己粘。 */
  def('paste_text',
    '往当前输入框里粘一段字。type_text 说打上了、但屏幕上还是空的时，用它再试一次。',
    { text: { type: 'string', description: '要粘的字，和刚才要打的一样' } },
    ['text'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.pasteText) return noNative();
      const g = wxGuard(nn, 'paste_text'); if (g) return g;
      const raw = nn.pasteText(String(a.text || ''));
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { return { ok: false, detail: '粘不进去。' }; }
      if (!j || !j.ok) return { ok: false, detail: '粘不进去。先 tap_text 点一下输入框，再用 paste_text。' };
      return { ok: true, detail: '粘上了「' + a.text + '」' };
    });

  def('watch_news',
    '看新闻联播、央视、电视直播。老人说「看新闻」「新闻联播」「看电视」「开电视」「放个电视」时都用这个。',
    {}, [],
    function (a, E) {
      const d = window.MILI_TV && window.MILI_TV.resolve('新闻联播');
      if (d && d.type === 'tv') return window.MILI_TV.open(d.url, d.name);
      const nn = n(E); if (!nn || !nn.tv) return noNative();
      return fromJava(nn.tv());
    });

  /* ===== 直达电视（预合成真源，最快路径）===== */
  def('play_direct',
    '放视频、开电视频道的最快方式。老人说「放一段豫剧」「看短剧」「打开中央一台」「看戏曲频道」「看新闻联播」都能走这个，一秒内全屏出画面。',
    { what: { type: 'string', description: '老人说的内容名，照原话取，如 新闻联播、豫剧、短剧、中央一台、CCTV5' } },
    ['what'],
    function (a, E) {
      const d = window.MILI_TV && window.MILI_TV.resolve(a.what);
      if (!d) return { ok: false, detail: '直达单子上没有「' + (a.what || '') + '」，换个说法或用别的办法找。' };
      if (d.type === 'tv') return window.MILI_TV.open(d.url, d.name);
      if (d.type === 'dl') return window.MILI_TV.openDl(d);
          if (d.type === 'app') return window.MILI_TV.openApp(d);
      if (d.type === 'app') return window.MILI_TV.openApp(d.pkg, d.name);
    });

  /* ===== 天气 ===== */
  def('get_weather',
    '查真实天气。老人问「冷不冷」「多少度」「要不要带伞」「明天天气怎么样」时用。' +
    '**必须调这个工具拿真数据，绝对不许凭感觉说天气。**' +
    '问明天就传 day=tomorrow，问后天就传 day=after，问今天或没说就留空。',
    { day: { type: 'string', description: 'today / tomorrow / after。老人问哪一天就填哪天' } },
    [],
    function (a, E) {
      const nn = n(E);
      if (!nn || !nn.weather) return { ok: false, detail: '这台设备上查不了天气。' };
      const w = NJ(nn.weather());
      if (!w || w.ok !== true) return { ok: false, detail: '这会儿天气没查到，别编数字。' };

      const d = String(a.day || '').toLowerCase();
      const isTom = d.indexOf('tom') >= 0 || d.indexOf('明') >= 0 || d.indexOf('明天') >= 0;
      const isAft = d.indexOf('aft') >= 0 || d.indexOf('后') >= 0 || d.indexOf('后天') >= 0;

      if (isTom || isAft) {
        const sfx = isAft ? 'aft' : 'tom';
        const max = w[sfx + 'Max'] || '';
        const min = w[sfx + 'Min'] || '';
        const sky = w[sfx + 'Desc'] || '';
        const rain = w[sfx + 'Rain'];
        if (!max) return { ok: false, detail: '预报里没有这一天的数据，别编。' };
        const who = isAft ? '后天' : '明天';
        let line = who + ' ' + (w.city || '') + '，最高 ' + max + ' 度，最低 ' + min + ' 度';
        if (sky) line += '，' + sky;
        if (typeof rain === 'number') line += '，下雨概率 ' + rain + '%';
        line += '。';
        return { ok: true, detail: line, city: w.city, day: who, max: max, min: min, sky: sky, rain: rain };
      }

      return {
        ok: true,
        detail: '现在 ' + (w.city || '') + ' ' + w.temp + ' 度，' + (w.desc || '') +
                '，湿度 ' + (w.hum || '') + '，风 ' + (w.wind || '') + '。' +
                (w.tip || ''),
        city: w.city, temp: w.temp, desc: w.desc,
        tomMax: w.tomMax, tomMin: w.tomMin,
      };
    });

  def('take_photo',
    '用摄像头看一眼。facing=back 看老人举到镜头前的东西（药盒、说明书、单据）；' +
    'facing=front 看老人自己。老人说「看看这个是啥」「帮我看看这个」时用 back。',
    { facing: { type: 'string', enum: ['front', 'back'], description: 'front 看老人，back 看东西' } },
    ['facing'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.shoot) return noNative();
      if (nn.canSee && !nn.canSee()) {
        try { nn.askSee && nn.askSee(); } catch (e) {}
        return { ok: false, detail: '还没得到用摄像头的许可，得先给一下。' };
      }
      /* 拍照是异步回调，包成 promise 让 loop 能等 */
      const id = (E.nextPhotoId ? E.nextPhotoId() : Date.now() % 100000);
      const facing = a.facing === 'front' ? 1 : 0;
      return new Promise(function (resolve) {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        /* app.js 的 __onPhoto 会把图回传，这里临时接管 */
        const prev = window.__onPhoto;
        window.__onPhoto = function (pid, b64, w, h, why) {
          if (pid !== id) { if (prev) try { prev(pid, b64, w, h, why); } catch (e) {} return; }
          window.__onPhoto = prev;
          if (!b64) {
            finish({ ok: false, detail: why === 'no_permission' ? '还没得到看东西的许可。' : '这一下没拍着。' });
            return;
          }
          /* 有图了：交给 E.seeImage 描述，它负责调视觉模型 */
          Promise.resolve(E.seeImage ? E.seeImage(b64, facing) : null).then(function (txt) {
            if (txt && txt.length > 1) finish({ ok: true, detail: txt, image: true });
            else finish({ ok: false, detail: '拍着了，但我没看清是啥。' });
          }).catch(function () {
            finish({ ok: false, detail: '拍着了，但没看懂。' });
          });
        };
        setTimeout(function () {
          finish({ ok: false, detail: '拍照没反应，可能被系统挡住了。' });
        }, 12000);
        try { nn.shoot(facing, id); } catch (e) { finish({ ok: false, detail: '拍照出错了。' }); }
      });
    });

  /* ===== 打开某个 App ===== */
  def('open_app',
    '按名字打开手机上装的某个软件。老人说「打开X」「给我开X」时用。',
    { name: { type: 'string', description: '软件名，如 微信、抖音、支付宝、高德地图' } },
    ['name'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.launchApp) return noNative();
      /* 微信是唯一例外：不能只把微信打开让模型自己点。
         真机实证那样会在聊天列表里点错人（发到「软件学院」群）。 */
      if (a.name && String(a.name).indexOf('微信') >= 0) {
        return { ok: false, detail: '微信里找人发消息、打视频语音，直接调 wechat_message / wechat_call，一步到位；不要先打开微信自己点。' };
      }
      const p = pkgOf(a.name);
      if (!p) return { ok: false, detail: '不认得「' + (a.name || '') + '」这个软件。' };
      if (nn.hasApp && !nn.hasApp(p)) {
        return { ok: false, detail: '这台手机上没装' + a.name + '。' };
      }
      try { nn.launchApp(p); } catch (e) {
        return { ok: false, detail: a.name + '打不开。' };
      }
      return { ok: true, detail: '打开了' + a.name + '。' };
    });

  /* ===== 开网页 ===== */
  def('open_url',
    '用浏览器打开一个网页。挂号、缴费、查社保这类具体页面用这个。',
    { url: { type: 'string', description: '完整网址，必须 http/https 开头' } },
    ['url'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.openUrl) return noNative();
      const u = String(a.url || '').trim();
      if (!/^https?:\/\//i.test(u)) return { ok: false, detail: '这个网址不对。' };
      return fromJava(nn.openUrl(u));
    });

  /* ===== 记事情（长期记忆的写入口） ===== */
  def('remember',
    '把老人交代的事长期记住。吃药时间、家里人的名字和事、他的喜好，都记。' +
    '老人说「记住…」「以后…」「我每天早上八点吃…」时用。',
    {
      fact: { type: 'string', description: '要记住的事实，照老人原话写' },
      kind: { type: 'string', enum: ['fact', 'preference', 'event'],
        description: 'fact 事实（如女儿叫小芳）；preference 喜好；event 要办的事/时间' },
    },
    ['fact', 'kind'],
    function (a, E) {
      if (!a.fact) return { ok: false, detail: '没说要记什么。' };
      const r = E.memoAdd ? E.memoAdd(a.kind || 'fact', a.fact) : null;
      if (!r) return { ok: false, detail: '这句没记下来。' };
      return { ok: true, detail: '记住了：' + a.fact };
    });

  /* ===== 查记忆 ===== */
  def('recall',
    '回想老人以前说过的事。他问「我上次说啥来着」「我女儿叫啥」时用。',
    { query: { type: 'string', description: '要回想的关键词' } },
    ['query'],
    function (a, E) {
      const hits = E.memoFind ? E.memoFind(a.query || '') : [];
      if (!hits || !hits.length) {
        return { ok: false, detail: '这个我这儿没记着。' };
      }
      return {
        ok: true,
        detail: '我记着：' + hits.slice(0, 3).map(function (x) { return x.text; }).join('；'),
        hits: hits.slice(0, 3),
      };
    });

  /* ==================================================================
     跨会话的待办
     ----------------------------------------------------------------
     为什么单独做一套：memory 记的是「事实」（女儿叫小芳），
     这里记的是「还没做完的动作」（明天上午去交电费）。
     事实记错了只是答错话，待办丢了就是答应的事没办 —— 老人会一直等。
     ================================================================== */

  def('add_task',
    '老人交代一件当场办不完的事，记下来，以后接着办。' +
    '比如「明天提醒我交电费」「下周三陪我去医院」「等他来了告诉他一声」。' +
    '只要不是现在就能办完的，都记。',
    {
      what: { type: 'string', description: '要办什么，用老人原话，别改写' },
      when: { type: 'string', description: '什么时候办，比如 2026-11-06 或 2026-11-06 09:00；没提时间就留空' },
    },
    ['what'],
    function (a, E) {
      if (!E.taskAdd) return { ok: false, detail: '这台机器记不了待办。' };
      const r = E.taskAdd({ what: a.what, when: a.when });
      if (!r || !r.ok) return { ok: false, detail: (r && r.detail) || '没记下来。' };
      return { ok: true, detail: '记下了：' + a.what + (a.when ? '（' + a.when + '）' : ''), task: r.task };
    });

  def('list_tasks',
    '看看还有哪些事没办。老人问「我还有啥事没办」「上次让你记的那个」时用；' +
    '每回开机也该自己看一眼，有到时间的就先提一句。',
    {},
    [],
    function (a, E) {
      if (!E.taskList) return { ok: false, detail: '这台机器读不了待办。' };
      const list = E.taskList() || [];
      if (!list.length) return { ok: true, detail: '没有没办完的事。', tasks: [] };
      return {
        ok: true,
        detail: '还有 ' + list.length + ' 件：' +
          list.slice(0, 5).map(function (t) { return t.what + (t.when ? '（' + t.when + '）' : ''); }).join('；'),
        tasks: list.slice(0, 8),
      };
    });

  def('finish_task',
    '一件事办完了就划掉，别让它一直挂着。',
    { id: { type: 'string', description: '待办的 id；只记得内容就写内容里的几个字也行' } },
    ['id'],
    function (a, E) {
      if (!E.taskDone) return { ok: false, detail: '这台机器改不了待办。' };
      const r = E.taskDone(a.id, '米粒');
      if (!r || !r.ok) return { ok: false, detail: (r && r.detail) || '没找到这件事。' };
      return { ok: true, detail: '办完了：' + (r.task.what || ''), task: r.task };
    });

  /* ===== 药箱 ===== */
  def('check_meds',
    '查药箱：该不该吃药了、吃几颗、上次什么时候吃的。老人问「该吃药了吗」时用。',
    { who: { type: 'string', description: '具体哪个药，老人没说就留空，留空表示问「该不该吃药」' } },
    [],
    function (a, E) {
      if (!E.medCheck) return { ok: false, detail: '药箱打不开。' };
      return E.medCheck(a.who || '');
    });

  /* ===== 设吃药提醒 ===== */
  def('set_alarm',
    '给老人设一个吃药提醒闹钟。老人说「每天几点提醒我吃X」时用。',
    {
      hour: { type: 'integer', description: '24 小时制的点，如早上八点就是 8' },
      minute: { type: 'integer', description: '分钟，没提就是 0' },
      who: { type: 'string', description: '药名或吃的人，如 降压药' },
      dose: { type: 'string', description: '剂量，如 一颗。老人没说就留空' },
    },
    ['hour', 'who'],
    function (a, E) {
      const nn = n(E); if (!nn || !nn.addAlarm) return noNative();
      let h = Number(a.hour);
      if (!isFinite(h) || h < 0 || h > 23) return { ok: false, detail: '没听清是几点。' };
      const m = Number(a.minute) || 0;
      try { nn.addAlarm(h, m, a.who || '', a.dose || ''); } catch (e) {
        return { ok: false, detail: '闹钟没设上。' };
      }
      return { ok: true, detail: '设好了，每天' + h + '点' + (m ? m + '分' : '') + '提醒吃' + (a.who || '药') + '。' };
    });

  /* ===== 上网查 ===== */
  /* 2026-11-06 菲尔特：「有病吧，我问什么它都去查」。
     原来这句写的是「凡是不确定的事实都必须查，不许凭印象答」——
     等于给了模型一张「遇事先查」的许可证，于是老人说「我血压有点高」，
     它把「我」当关键词扔进搜索引擎，回来三条：汉字「我」的甲骨文考据、
     张国荣的歌《我》、游戏《我的世界》。
     搜索是「问外面世界」的工具，不是「听懂老人」的工具。
     下面把边界写死：只有「外面的事」才查，老人自己的事一个字都不查。 */
  def('search_web',
    '上网查**外面世界**的、会变的、你不确定的事实：新闻、政策、价格、电话号码、' +
    '地名怎么走、某个人是谁、某样东西在哪个台播。\n' +
    '【绝对不要用它查这些】\n' +
    '· 老人自己的身体：「我血压有点高」「我头晕」「我睡不着」「我今天没胃口」' +
    '—— 这是在跟你说话，不是让你去搜。直接关心他、问两句、该记就 log_vital。\n' +
    '· 任何跟「病」有关的问题，包括「高血压该注意什么」「血糖高吃什么好」' +
    '—— 你不当大夫，别背医书。问清症状、劝他就医、提醒吃药，就够了。\n' +
    '· 老人自己的事：他吃了没、他几点睡、他家里谁来了。你不知道就说不知道，别查。\n' +
    '· 闲聊、打招呼、夸你、骂你、问你是谁。\n' +
    '· 你手上别的工具能办的（天气有 get_weather、看电视有 tv_channel / watch_video、' +
    '发消息有 wechat_message）。\n' +
    '【query 怎么写】\n' +
    '写成一个真正能被搜到的词组，至少两个字，**绝不能只有「我」「你」「他」「这个」「那个」**。\n' +
    '「我血压有点高」→ 不查，一个字都不查。\n' +
    '「最近养老金涨了吗」→ 「2026 养老金 上调 政策」。',
    { query: { type: 'string', description: '搜索词，两字以上的实词组合，不能是代词' } },
    ['query'],
    function (a, E) {
      if (!a.query) return { ok: false, detail: '没说要查什么。' };
      /* 兜底闸：代词/单字一律不打到搜索引擎去。
         模型偶尔还是会犯，这一道拦住，让它自己改成正经关键词重试。 */
      const q = String(a.query).trim();
      const junk = /^(我|你|他|她|它|我们|你们|他们|这个|那个|这|那|啥|什么|怎么|为什么|啊|嗯|哦)$/;
      if (junk.test(q) || q.length < 2) {
        return {
          ok: false,
          detail: '「' + q + '」不是能搜的词。老人说的是他自己的事，就别查了 —— ' +
                  '直接回他的话；真要查外面的信息，把关键词写成两三个字的实词再调一次。',
        };
      }
      /* 第二道闸：关键词里只要带身体相关的词，一律不查。
         原来这条要求「我」和身体词出现在 8 个字以内，结果老人只说
         「血压有点高」——没有「我」，闸就漏了，照搜不误。
         菲尔特截图里它去查字典就是这么来的。
         现在不看主语，只认词：这些词出现在 query 里，就不是「外面的事」。 */
      const healthish = /(血压|血糖|血脂|心率|血氧|体温|头晕|头疼|头昏|心慌|胸闷|喘不上|不舒服|难受|发烧|咳嗽|睡不着|失眠|没胃口|胃口|恶心|拉肚子|便秘|腿疼|腰疼|关节|骨头|感冒|吃什么药|怎么治|什么病)/;
      if (healthish.test(q)) {
        return {
          ok: false,
          detail: '这是身体的事，不是外面的事，不许查。' +
                  '先关心他一句、问清楚什么时候开始的、多高多难受；' +
                  '他说了具体数值就用 log_vital 记下来，明显不对劲就提一句给家里人打个电话。',
        };
      }
      if (!E.searchWeb) return { ok: false, detail: '这会儿查不了网。' };
      return Promise.resolve(E.searchWeb(a.query)).then(function (r) {
        if (!r || !r.text) return { ok: false, detail: '这个我查不到。' };
        return { ok: true, detail: r.text, src: r.src || null, results: r.results || null };
      }).catch(function () {
        return { ok: false, detail: '网没连上，查不了。' };
      });
    });

  /* ===== 看手机屏幕 ===== */
  def('read_screen',
    '看老人手机屏幕上现在是什么内容（短信、弹窗、别人发来的消息）。' +
    '老人说「这上面写的啥」「这条消息是啥意思」「是不是骗人的」时用。',
    {}, [],
    function (a, E) {
      const nn = n(E); if (!nn) return noNative();
      /* 无障碍服务读屏 */
      let raw = null;
      try { raw = nn.skill ? nn.skill() : null; } catch (e) {}
      const s = NJ(raw);
      if (!s) return { ok: false, detail: '看不见屏幕，无障碍服务可能没开。' };
      const txt = s.screen || s.text || s.content || '';
      if (!txt) return { ok: false, detail: '屏幕上没读到字。' };
      return { ok: true, detail: '屏幕上是：' + String(txt).slice(0, 200), screen: txt };
    });

  /* ===== 桌宠 ===== */
  def('pet_toggle',
    '把米粒自己放到手机桌面上陪着老人，或者收回来。',
    { on: { type: 'boolean', description: 'true 放桌面，false 收回来' } },
    ['on'],
    function (a, E) {
      const nn = n(E); if (!nn) return noNative();
      if (a.on === false) {
        try { nn.stopPet && nn.stopPet(); } catch (e) {}
        return { ok: true, detail: '我先收起来了。' };
      }
      if (nn.canOverlay && !nn.canOverlay()) {
        try { nn.askOverlay && nn.askOverlay(); } catch (e) {}
        return { ok: false, detail: '还没得到悬浮窗的许可，得先给一下。' };
      }
      try { nn.startPet && nn.startPet(); } catch (e) {}
      return { ok: true, detail: '我到桌面上陪你啦。' };
    });

  /* ===== 血压血糖 =====
     老人说「血压 148 92」「刚量了血糖 6.8」时用。
     工具只负责记数，不负责判断好坏 —— 判断在服务端，那边有阈值。
     也不主动催老人量 —— 催一次他就会烦，之后不肯量。 */
  def('log_vital',
    '记一次血压或血糖。老人说「血压多少多少」「量了血压」「血糖几点几」时用。' +
    '记完把结论念给他听（正常/偏高/很高），别只说「记下了」。',
    {
      kind: { type: 'string', description: 'bp 是血压，glu 是血糖。血压要带两个数，血糖只带一个' },
      sys: { type: 'number', description: '血压的高压（高的那个数）。血糖时不用填' },
      dia: { type: 'number', description: '血压的低压（低的那个数）。血糖时不用填' },
      val: { type: 'number', description: '血糖值，如 6.8。血压时不用填' },
    },
    ['kind'],
    function (a, E) {
      const w = window.MILI_VITAL;
      if (!w) return { ok: false, detail: '这台设备上还记不了体征。' };
      const kind = (a.kind === 'glu' || a.kind === '血糖') ? 'glu' : 'bp';
      if (kind === 'bp') {
        const s = Number(a.sys) || 0, d = Number(a.dia) || 0;
        if (!s || !d) return { ok: false, detail: '血压得有两个数，高的和低的都要。你再念一遍。' };
        return w.add('bp', s, d, 0);
      }
      const v = Number(a.val) || 0;
      if (!v) return { ok: false, detail: '血糖得有个数。你再念一遍。' };
      return w.add('glu', 0, 0, v);
    });

  def('vital_report',
    '把最近一次血压/血糖发给家里人。老人说「告诉家里人我这个数」「发给我闺女」时用。',
    {},
    [],
    function (a, E) {
      const w = window.MILI_VITAL;
      if (!w) return { ok: false, detail: '这台设备上还发不了。' };
      return w.tell();
    });

  /* ===== 扫码付款 =====
     注意：这个工具不碰钱。它只负责把相机打开、把码认出来。
     金额一定先念给老人听，等他自己点确认。 */
  def('scan_pay',
    '只有老人报了具体金额、需要核对那张卡时才用。老人说「付十二块五」「这个多少钱」时用，把金额填进 amount。' +
    '他只说「扫一扫」「我要付钱」「付款码」、没报金额 → 不要用这个：' +
    '扫一扫用 wechat_scan，付钱/付款码用 wechat_pay_code，那两个直接跳微信。' +
    '不管哪种，最后都会停在核对卡上 —— 绝不能替他点确认，也别自己报「付好了」。',
    {
      amount: { type: 'string', description: '老人说的金额数字，如 12.5。他没提钱数就留空' },
    },
    [],
    function (a, E) {
      const amt = String(a.amount || '').trim();
      if (amt && window.MILI_PAY) return window.MILI_PAY.ask(amt);
      const nn = n(E);
      if (nn && nn.scanCode) {
        try { nn.scanCode(); } catch (e) {}
        return { ok: true, detail: '相机开了，让老人对着码照一下。扫到之后再把金额念给他听。' };
      }
      if (window.MILI_PAY && amt) return window.MILI_PAY.ask(amt);
      return { ok: true, detail: '这台设备打不开相机。米粒自己问老人「多少钱？」，'
        + '他报了数再调 scan_pay(amount=那个数)。不许让老人去问商家。' };
    });

  /* ===== 收款码 =====
     老人说「别人给我钱」「把收款码打开」时用。这句话以前被模型选成
     read_notifications（去读通知），等于没办；现在是一个明确的工具。
     只开微信「二维码收款」那页，不碰钱、不报到账。 */
  def('receive_code',
    '别人要给老人钱、老人要收钱时用。老人说「别人给我钱」「我收个钱」' +
    '「把收款码打开」「让他们扫我」「人家转给我」「给我转钱」时用。' +
    '它只把微信的收款二维码打开，钱还是老人自己收。' +
    '别把它当成「看看谁给我转了钱」去读通知，也别调 scan_pay（那是付钱，方向相反）。',
    {},
    [],
    function (a, E) {
      const w = window.MILI_RECEIVE;
      if (!w) return { ok: false, detail: '这台设备上还开不了收款码。' };
      return w.open();
    });

  /* ===== 微信扫一扫 / 付款码（2026-11-10 菲尔特：「说扫一扫应该跳微信」「说我要付钱应该跳付款码」）=====
     原生桥 wxScan / wxPayCode 和前端 wxGo() 11-09 真机就通了，但模型看不见这两个入口：
     工具表里只有 scan_pay（米粒自己的相机＋核对卡）和 receive_code，
     提示词还特意叫它别用 scan_pay 付钱 —— 结果语音说了也跳不过去。
     这里把原来「点卡片」那条已验证的路原样包成两个一步工具，不另造链路。 */
  def('wechat_scan',
    '打开微信扫一扫。老人说「扫一扫」「扫个码」「扫一下」「我扫一下」时用，直接跳微信的扫一扫界面。' +
    '不要用 open_app 自己开微信点，也不要用 scan_pay（那是报了金额之后核对用的）。',
    {}, [],
    function () {
      if (typeof window.wxGo !== 'function') {
        return { ok: false, detail: '这台设备上还开不了微信扫一扫。' };
      }
      try { window.wxGo('scan'); } catch (e) {
        return { ok: false, detail: '微信扫一扫没打开。' };
      }
      return { ok: true, detail: '微信扫一扫已经打开了，让老人对着码照一下。',
               fastReply: '微信扫一扫打开了，您照一下。' };
    });

  def('wechat_pay_code',
    '打开微信付款码。老人说「我要付钱」「付钱」「买单」「付款码」「把付款码打开」「给商家扫我」时用，' +
    '直接跳微信收付款页里的付款码，让商家来扫。米粒不碰钱、不输密码。' +
    '别用 scan_pay（那是老人报了具体金额才用的核对卡），也别把它当成收款码。',
    {}, [],
    function () {
      if (typeof window.wxGo !== 'function') {
        return { ok: false, detail: '这台设备上还开不了付款码。' };
      }
      try { window.wxGo('pay'); } catch (e) {
        return { ok: false, detail: '付款码没打开。' };
      }
      return { ok: true, detail: '微信付款码已经打开了，让商家扫一下。',
               fastReply: '付款码打开了，给商家扫一下就行。' };
    });

  /* ===== 挂号 =====
     老人说「我要去医院」「帮我挂个号」「头晕要看什么科」时用。
     工具只到「帮他选科室」这一步 —— 真排班在医院的系统里，拿不到。
     所以它给的是一条能走的路，不是一个假成功的号。 */
  def('register_hospital',
    '帮老人挂号。老人说「去医院」「挂个号」「哪儿不舒服要看哪个科」时用。' +
    '先判断该挂哪个科，再打开挂号页。判断不了就问一句哪儿不舒服。',
    {
      dept: { type: 'string', description: '科室名，如 内科 / 骨科 / 眼科。拿不准就留空' },
      hosp: { type: 'string', description: '哪家医院。老人没说就留空，默认最近的' },
      when: { type: 'string', description: '什么时候去，如「明天上午」「后天下午」。老人没说就留空，默认明天上午' },
    },
    [],
    function (a, E) {
      const w = window.MILI_REG;
      if (!w) return { ok: false, detail: '这台设备上还挂不了号。' };
      return w.open(String(a.dept || ''), String(a.hosp || ''), String(a.when || ''));
    });

  /* ===== 点头 =====
     老人说「行」「好」「就这么办」的时候，真正把上一件事办掉。
     为什么单独做一个工具、而不是让模型重调一遍 register_hospital：
     重调只能再「准备」一次，钱和消息都不会真的出去 —— 那不叫办成。 */
  def('confirm_pending',
    '老人点头了（说「行」「好」「就这么办」「嗯」），把刚才那件等他答应的事真办掉。' +
    '只在提示词里写着「有一件……等着他点头」的时候才用，别自己造一件出来。',
    {},
    [],
    function (a, E) {
      if (!window.MILI_CONFIRM) return { ok: false, detail: '这会儿没有等着点头的事。' };
      return window.MILI_CONFIRM.run();
    });

  def('cancel_pending',
    '老人说「算了」「先不挂」「不用了」，把刚才那件等他点头的事撤掉。',
    {},
    [],
    function (a, E) {
      window.MILI_PENDING.clear();
      return { ok: true, detail: '撤了，没办。' };
    });

  /* ===== 语速 =====
     老人说「你说得太慢了」「快一点」「再慢点儿」的时候用。
     以前这种话只能回来改代码、重新打包、重新装 —— 老人等不起，
     而且每换一个人觉得不合适就得再来一遍。现在他自己一句话就能调。
     步长 15：一次能听出差别，又不会一下变成机关枪。
     范围 [-50,100] 由原生那侧卡住，这里不重复判断。 */
  def('set_speech_rate',
    '调米粒自己说话的语速。老人嫌慢就说快一点，嫌快就说慢一点。' +
    'faster=true 是加快，faster=false 是放慢。老人没说方向就别调。',
    {
      faster: { type: 'boolean', description: 'true 加快，false 放慢' },
      step: { type: 'number', description: '一次调多少，默认 15。老人说「快很多」可以给 30' },
    },
    ['faster'],
    function (a, E) {
      const n = window.MiliNative;
      if (!n || typeof n.ttsRate !== 'function') {
        return { ok: false, detail: '这台手机调不了语速。' };
      }
      const step = Math.abs(Number(a.step) || 15) || 15;
      const cur = Number(n.ttsRate(-999)) || 0;
      const next = n.ttsRate(cur + (a.faster ? step : -step));
      return {
        ok: true,
        detail: '语速调到 ' + next + ' 了。',
        rate: next,
      };
    });

  /* ==========================================================================
   * 对外接口
   * ======================================================================== */

  /* 给模型看的 schema 数组（OpenAI tools 格式） */
  function schema() {
    const out = [];
    for (const k in T) {
      const t = T[k];
      const props = {};
      for (const p in t.params) props[p] = t.params[p];
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.desc,
          parameters: { type: 'object', properties: props, required: t.required },
        },
      });
    }
    return out;
  }

  /* 按名字列表，给提示词用（比 schema 短得多） */
  /* 🚫 2026-11-10 悟空正式下架：从名单和 schema 里都摘掉，
     模型看不见它就永远不会调。代码保留（T 里先删，需要回滚时恢复这行即可）。 */
  delete T.search_wukong;
  function names() { return Object.keys(T); }

  /* 执行一个工具调用。永远 resolve，永远不抛 —— loop 不能因为一个工具挂了就崩 */
  function exec(name, args, E) {
    const t = T[name];
    if (!t) {
      return Promise.resolve({ ok: false, detail: '没有「' + name + '」这个本事。' });
    }
    let r;
    try {
      r = t.run(args || {}, E || {});
    } catch (e) {
      return Promise.resolve({ ok: false, detail: '这个动作出错了：' + ((e && e.message) || '不知道啥原因') });
    }
    return Promise.resolve(r).then(function (v) {
      if (!v || typeof v !== 'object') {
        return { ok: false, detail: '这个动作没给结果。' };
      }
      if (typeof v.ok !== 'boolean') v.ok = false;
      if (!v.detail) v.detail = v.ok ? '办好了' : '没办成';
      return v;
    }).catch(function (e) {
      return { ok: false, detail: '这个动作出错了。' };
    });
  }

  /* ===== 手电筒（2026-11-07 补，规范「快捷工具类」）=====
     以前只有桌面图标能点，老人说「亮个灯」模型没工具可选。
     用 torchSet(on) 精确开关，不用 toggle —— 说「关灯」时不能反而打开。 */
  def('torch',
    '开或关手电筒。老人说「开手电筒」「把灯打开」「亮个灯」「关掉手电」「关灯」时用。',
    { on: { type: 'boolean', description: 'true=开，false=关。老人没明说开关时填 true' } },
    [],
    function (a, E) {
      const nn = n(E);
      if (!nn || !nn.torchSet) return noNative();
      const r = fromJava(nn.torchSet(a.on !== false));
      /* 快通道：开关手电筒这种事，工具自己就知道成没成，
         不再让模型多跑一轮生成复述。真机实测原先慢就慢在那一轮往返。 */
      if (r.ok) r.fastReply = a.on === false ? '手电筒关了。' : '手电筒打开了。';
      return r;
    });

  /* ===== 紧急求助（2026-11-07 补，规范「安全与求助类」最高优先级）=====
     2026-11-10 菲尔特：「以后任何地方再也不要出现老人自己说自己摔倒」。
     摔倒这件事已经交给手机自己发现（原生 FallDetect + 跌落确认层），
     这里只保留「老人真的开口喊人」的那一类 —— 喘不上气、胸口疼、喊救命。
     MILI_SOS 由 app.js 挂到 window，走的是原来那颗真 sosBtn（拨第一位
     紧急联系人）+ 红色安抚层，不是新造的假链路。 */
  def('emergency',
    '紧急求助。老人喊「救命」「快来人」「快叫我儿子」「打紧急电话」，或者说自己难受得厉害、喘不上气、胸口疼、说不出话时立刻用，不要追问。',
    {},
    [],
    function () {
      if (typeof window.MILI_SOS !== 'function') {
        return { ok: false, detail: '这台手机还没接好紧急呼叫，得让家里人先设置。' };
      }
      const ok = window.MILI_SOS();
      return ok ? { ok: true, detail: '已经去叫人了，您别着急，我陪着您。' }
                : { ok: false, detail: '还没连上家里人。' };
    });

  /* ===== 跌落确认（2026-11-10）=====
     手机自己判出疑似跌倒，前端盖了一屏问「您还好吗」。
     老人回一句，由模型判断是「没事」还是「要叫人」—— 不写意图正则，
     因为「没事没事」和「起不来了」在字面上都像否定。
     没在问这句话的时候调它，直接告诉模型「这会儿没在等人回话」。 */
  def('fall_answer',
    '跌落确认。米粒刚问过「您还好吗」的时候才用：老人说没事、能起来、别叫人 → ok=true；说疼、起不来、快叫人来 → ok=false。平时不要调。',
    { ok: { type: 'boolean', description: 'true=老人说没事，撤销叫人；false=老人说疼、起不来、要叫人' } },
    ['ok'],
    function (a) {
      if (a.ok !== false) {
        if (typeof window.MILI_FALL_CANCEL === 'function') {
          window.MILI_FALL_CANCEL('voice');
          return { ok: true, detail: '好，那我就不叫人了。' };
        }
        return { ok: false, detail: '这会儿没在等人回话。' };
      }
      if (typeof window.MILI_FALL_NOW === 'function') {
        window.MILI_FALL_NOW('voice');
        return { ok: true, detail: '好，我这就叫家里人。' };
      }
      return { ok: false, detail: '叫人没叫成。' };
    });

  /* ===== 今天什么日子（本地算，不联网、不用模型瞎猜）=====
     菲尔特：「问他今天农历几号他也不知道」。Intl 的中文历法在 Android
     WebView 里可用；不可用就退回公历+星期，绝不说「不知道」。 */
  def('today_info',
    '问今天几号、星期几、农历几号、什么日子时用。直接返回这台手机上算出来的真实日期，不用联网、不用猜。' +
    '老人问「今天农历几号」「今天星期几」「几月几号了」一律调它，然后照着回一句人话。',
    {}, [],
    function () {
      const d = new Date();
      const wk = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][d.getDay()];
      let lun = '';
      try {
        lun = window.lunarCN ? window.lunarCN(d)
              : new Intl.DateTimeFormat('zh-CN-u-ca-chinese',{month:'long',day:'numeric'}).format(d);
      } catch (e) {}
      const g = '公历 ' + d.getFullYear() + ' 年 ' + (d.getMonth()+1) + ' 月 ' + d.getDate() + ' 日 ' + wk;
      return { ok: true, detail: lun ? (g + '，农历' + lun + '。') : (g + '。'), date: g, lunar: lun };
    });

  window.MILI_TOOLS = {
    schema: schema,
    names: names,
    exec: exec,
    has: (k) => !!T[k],
    count: () => Object.keys(T).length,
    /* 自测用：不执行，只看会不会被认出来 */
    desc: (k) => (T[k] ? T[k].desc : null),
  };
})();
