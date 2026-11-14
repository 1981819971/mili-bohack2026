/* 从 index.html 解析页面模块清单 —— 构建的唯一真源。
 *
 * 为什么单独抽出来：
 *   build.mjs 曾经在三个地方各手写一份清单（单文件版 / server / APK assets），
 *   新增 context.js、tool-router.js、stream-speak.js 时三处全漏，
 *   产物静默退回旧行为：没有 BM25、没有三层记忆、没有流式，而且不报错。
 *   手写清单必然会再次漂移，这里直接读 index.html 的 <script src>。
 *
 * 只收本地页面模块：vendor/assets 下的第三方库、http(s) 外链不在此列。
 * app.js 是 type="module" 加载，同样会被收进来（调用方按需替换成 boot 版）。
 */
export function pageModules(html) {
  const out = [];
  const re = /<script[^>]*\bsrc="([^"]+?\.js)(?:\?[^"]*)?"[^>]*>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const p = m[1];
    if (/^(?:https?:)?\/\//.test(p)) continue;
    if (p.startsWith('assets/') || p.startsWith('vendor/')) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
