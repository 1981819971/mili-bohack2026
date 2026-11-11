/* promptfoo 断言函数：一条 held-out 记录算不算过。
   判据与 eval/README.md 一致：只看 trace 里第一个工具，另加延迟、报错、打桩三道门禁。
   这里的 stub 是「没有真拨号 / 真发微信」的代理判据，不是能力证明。 */
module.exports = (output) => {
  let r;
  try { r = JSON.parse(output); } catch (e) {
    return { pass: false, score: 0, reason: '输出不是 JSON' };
  }

  const bad = [];
  const want = Array.isArray(r.want) ? r.want : [];
  const got = r.got || '';

  /* want 非空：首工具必须命中。want 为空：闲聊 / 兜底句根本不该动手 ——
     #28「把这个弄一下」调了 look_screen，eval/README.md 已把它列为真失败。 */
  if (want.length && want.indexOf(got) < 0) {
    bad.push('首工具 ' + (got || '(空)') + ' 不在 want ' + want.join('/'));
  }
  if (!want.length && got) {
    bad.push('兜底句不该调用工具，却调了 ' + got);
  }
  if (!(r.ms > 0 && r.ms < 8000)) {
    bad.push('延迟 ' + r.ms + 'ms 越界（0~8000）');
  }
  if (r.err) bad.push('运行报错：' + r.err);
  if (r.stub !== true) bad.push('非打桩运行，可能真拨号或真发微信');

  return {
    pass: bad.length === 0,
    score: bad.length === 0 ? 1 : 0,
    reason: bad.length
      ? bad.join('；')
      : r.phase + ' #' + r.id + ' ' + (got || '闲聊') + ' ' + r.ms + 'ms',
  };
};
