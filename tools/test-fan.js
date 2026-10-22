/* 番型识别 / 计分 / 文本解析 / 副露向听 的自检
   运行：node tools/test-fan.js */
const path = require('path');

const C = require(path.join(__dirname, '..', 'src', 'core', 'mj-core.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`✗ ${name}${extra !== undefined ? '  → ' + extra : ''}`); }
};

const SUIT_IDX = { m: 0, s: 1, p: 2 };
function parse(str) {
  const c = new Array(27).fill(0);
  for (const seg of str.match(/\d+[msp]/g) || []) {
    const suit = SUIT_IDX[seg[seg.length - 1]];
    for (const d of seg.slice(0, -1)) c[suit * 9 + (+d) - 1]++;
  }
  return c;
}
const keysOf = y => y.map(e => e.key).sort();

console.log('\n[1] 和牌判定 isWinHand');
ok('平胡 123m456m789m234s55s', C.isWinHand(parse('123456789m234s55s'), 0));
ok('七对 112233m4455s6677p', C.isWinHand(parse('112233m4455s6677p'), 0));
ok('龙七对 1111m22m33m44s55s66p', C.isWinHand(parse('1111m2233m4455s66p'), 0));
ok('非和牌 123m456m789m234s56s', !C.isWinHand(parse('123456789m234s56s'), 0));
ok('根型 1111m23m456m789m55s', C.isWinHand(parse('111123456789m55s'), 0));
ok('副露1组 need=3: 234m567m999s22s', C.isWinHand(parse('234567m999s22s'), 1));
ok('副露1组 张数不对应为 false', !C.isWinHand(parse('234567m99s'), 1));
ok('副露4组 只剩将 99s', C.isWinHand(parse('99s'), 4));
ok('副露4组 非对子 1m2m 应为 false', !C.isWinHand(parse('1m2m'), 4));
ok('副露4组 对子 11m', C.isWinHand(parse('11m'), 4));

console.log('[2] 番型识别');
{
  const y = C.detectYaku(parse('123456789m234s55s'), {});
  ok('平胡', keysOf(y).join() === 'ping_hu', keysOf(y));
}
{
  const y = C.detectYaku(parse('234567m234567s88s'), {});
  ok('断幺九', keysOf(y).indexOf('duan_yao_jiu') >= 0, keysOf(y));
}
{
  const y = C.detectYaku(parse('123456789m111m22m'), {});
  ok('清一色', keysOf(y).indexOf('qing_yi_se') >= 0, keysOf(y));
}
{
  const y = C.detectYaku(parse('111222333m444s55s'), {});
  ok('对对胡', keysOf(y).indexOf('dui_dui_hu') >= 0, keysOf(y));
}
{
  const y = C.detectYaku(parse('112233m4455s6677p'), {});
  ok('七对（非龙）', keysOf(y).join() === 'qi_dui', keysOf(y));
}
{
  const y = C.detectYaku(parse('1111m2233m4455s66p'), {});
  ok('龙七对', keysOf(y).indexOf('long_qi_dui') >= 0, keysOf(y));
  ok('龙七对已含第一根：不再另计 gen', !y.some(e => e.key === 'gen'), JSON.stringify(y));
  ok('龙七对 1 根 = 3 番', C.scoreYaku(y, null, 12).raw === 3, C.scoreYaku(y, null, 12).raw);
}
{
  const y = C.detectYaku(parse('1111m2222m3344m55s'), {});   // 2 个四张：1m、2m
  const g = y.find(e => e.key === 'gen');
  ok('龙七对 2 根：只另计 1 个 gen', g && g.times === 1, JSON.stringify(y));
  ok('龙七对 2 根 = 4 番', C.scoreYaku(y, null, 12).raw === 4, C.scoreYaku(y, null, 12).raw);
}
{
  const y = C.detectYaku(parse('123789m111999s11s'), {});
  ok('全带幺', keysOf(y).indexOf('quan_dai_yao') >= 0, keysOf(y));
}
{
  const y = C.detectYaku(parse('111123456789m55s'), {});
  ok('根 ×1', y.filter(e => e.key === 'gen').length === 1 && y.find(e => e.key === 'gen').times === 1, JSON.stringify(y));
}
{
  const y = C.detectYaku(parse('112233m4455s6677p'), { ctx: { zimo: true } });
  ok('自摸附加', keysOf(y).indexOf('zi_mo') >= 0, keysOf(y));
}
{
  const y = C.detectYaku(parse('99s'), { melds: [{ kind: 'pong', tile: 0 }, { kind: 'pong', tile: 1 }, { kind: 'pong', tile: 2 }, { kind: 'pong', tile: 3 }] });
  ok('金钩钓（4副露+将）', keysOf(y).indexOf('jin_gou_diao') >= 0, keysOf(y));
  ok('金钩钓不叠对对胡', keysOf(y).indexOf('dui_dui_hu') < 0, keysOf(y));
  ok('金钩钓 = 2 番', C.scoreYaku(y, null, 5).raw === 2, JSON.stringify(C.scoreYaku(y, null, 5)));
}

console.log('[3] 计分（你的牌桌规则）');
{
  const t = C.DEFAULT_FAN;
  ok('七对=2番', t.qi_dui === 2);
  ok('龙七对=3番', t.long_qi_dui === 3);
  ok('对对胡=1番', t.dui_dui_hu === 1);
  ok('金钩钓=2番', t.jin_gou_diao === 2);
  ok('自摸=1番', t.zi_mo === 1);
  // 龙七对 + 自摸 = 4 番 → 封顶 3
  const s = C.scoreYaku([{ key: 'long_qi_dui', times: 1 }, { key: 'zi_mo', times: 1 }], null, 3);
  ok('龙七对+自摸 原始4番', s.raw === 4, s.raw);
  ok('封顶3番', s.capped === 3, s.capped);
  ok('得分 2^3 = 8', s.points === 8, s.points);
  // 对对胡 + 根×2 + 自摸 = 1+2+1 = 4 → 3
  const s2 = C.scoreYaku([{ key: 'dui_dui_hu', times: 1 }, { key: 'gen', times: 2 }, { key: 'zi_mo', times: 1 }], null, 3);
  ok('对对胡+根2+自摸', s2.raw === 4 && s2.capped === 3, JSON.stringify(s2));
  // 平胡
  const s3 = C.scoreYaku([{ key: 'ping_hu', times: 1 }], null, 3);
  ok('平胡 0 番 1 分', s3.capped === 0 && s3.points === 1, JSON.stringify(s3));

  // 自定义番表 / 封顶 / 底分必须真实参与计分
  const s4 = C.scoreYaku([{ key: 'qi_dui', times: 1 }], { qi_dui: 5 }, 5, 2);
  ok('自定义番表+封顶+底分', s4.raw === 5 && s4.capped === 5 && s4.points === 64 && s4.cap === 5 && s4.base === 2, JSON.stringify(s4));
  const s5 = C.scoreYaku([{ key: 'qi_dui', times: 1 }], null, 0, 3);
  ok('封顶 0 = 不封顶', s5.capped === 2 && s5.points === 12 && s5.cap === 0, JSON.stringify(s5));
}

console.log('[4] 文本解析 parseHandText');
{
  const a = C.parseHandText('w1234t5678s123');
  ok('w1234t5678s123 共11张', a && a.length === 11, a && a.length);
  const b = C.parseHandText('123456789m111m22m');
  ok('123456789m111m22m 共14张', b && b.length === 14, b && b.length);
  const d = C.parseHandText('1m2m3m4m5m6m7m8m9m1s1s2s');
  ok('1m2m... 格式 共12张', d && d.length === 12, d && d.length);
  const e = C.parseHandText('w123456789w111w22');
  ok('两种写法等价', JSON.stringify(b) === JSON.stringify(e), JSON.stringify(e));
  ok('非法输入返回 null', C.parseHandText('xyz') === null);
  ok('超过14张返回 null', C.parseHandText('w111111111111111') === null);
}

console.log('[5] 副露版向听（need < 4）');
{
  // 副露 1 组：手牌 10 张 = 2面子 + 将 + 搭子 → 听牌(0)
  const c = parse('234567m99s23s');   // 234m 567m 99s 23s = 3+3+2+2 = 10
  ok('副露1 10张 听牌', C.shanten(c, 1) === 0, C.shanten(c, 1));
  // 副露 2 组：手牌 7 张 = 1面子 + 将 + 搭子 → 听牌(0)
  const c2 = parse('234m99s23s');     // 3+2+2 = 7
  ok('副露2 7张 听牌', C.shanten(c2, 2) === 0, C.shanten(c2, 2));
  // 副露 1 组：手牌 11 张 = 3面子 + 将 → 和牌(-1)
  const c3 = parse('234567m999s22s'); // 3+3+3+2 = 11
  ok('副露1 11张 和牌', C.shanten(c3, 1) === -1, C.shanten(c3, 1));
  // 门清时才有七对
  const c4 = parse('112233m4455s6677p');
  ok('门清认七对', C.shanten(c4, 0) === -1);

  // 副露 4 组（金钩钓）：拆块也要能认出雀头
  const d4 = C.decompose(parse('99s'), 4);
  ok('副露4组 拆块识别雀头', d4.shanten === -1 && !!d4.pair, JSON.stringify(d4));
  const d5 = C.decompose(parse('1m2m'), 4);
  ok('副露4组 非对子未和牌', d5.shanten === 0, JSON.stringify(d5));
}

console.log('[6] 牌河扣减有效牌');
{
  const hand = parse('23456789m2345s99s');  // 14 张
  const keep = [true, true, false];
  const noRiver = C.analyzeCut(hand, keep, 0, null);
  const river = new Array(27).fill(0);
  // 把最优解的有效牌全部见光
  const bestTile = noRiver.options[0].tile;
  const eff = noRiver.options[0].eff;
  eff.forEach(k => { river[k] = 4; });
  const withRiver = C.analyzeCut(hand, keep, 0, river);
  const after = withRiver.options.find(o => o.tile === bestTile);
  ok('有效牌被牌河扣完 → 0 张', after.ukeire === 0, after.ukeire);
}

console.log('[7] 出题器（番型 / 防守）');
{
  let bad = 0;
  for (let i = 0; i < 30; i++) {
    const q = C.genFan(2);
    if (!q) { bad++; continue; }
    if (q.melds && q.melds.length) {
      if (q.hand.length !== 2) bad++;
      if (!C.isWinHand(C.toCounts(q.hand), 4)) bad++;
    } else {
      if (q.hand.length !== 14) bad++;
      if (!C.isWinHand(C.toCounts(q.hand), 0)) bad++;
    }
    if (q.scored.capped !== Math.min(q.scored.raw, 3)) bad++;
  }
  ok('genFan × 30', bad === 0, `失败 ${bad}`);
}
{
  let bad = 0, n = 0;
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) {
    const q = C.genDefense(2, true);
    if (!q) { bad++; continue; }
    if (q.hand.length !== 14) bad++;
    if (q.river.reduce((a, b) => a + b, 0) < 10) bad++;
    if (!q.options.length) bad++;
    n++;
  }
  ok('genDefense × 15', bad === 0, `失败 ${bad}`);
  console.log(`   genDefense 平均 ${((Date.now() - t0) / Math.max(n, 1)).toFixed(0)} ms/题`);
}
{
  const t0 = Date.now();
  let bad = 0;
  for (let i = 0; i < 15; i++) {
    const q = C.genCut(2, true, true);
    if (!q) { bad++; continue; }
    if (!q.river) bad++;
    if (q.hand.length !== 14) bad++;
  }
  ok('genCut + 牌河 × 15', bad === 0, `失败 ${bad}`);
  console.log(`   genCut(带牌河) 平均 ${((Date.now() - t0) / 15).toFixed(0)} ms/题`);
}
{
  // 全 0 番表：题目原始番数必须为 0，证明 genFan 真的用了传入的番表
  const zero = {}; C.FAN_ORDER.forEach(k => { zero[k] = 0; });
  let bad = 0;
  for (let i = 0; i < 10; i++) {
    const q = C.genFan(1, { table: zero, cap: 5, base: 2 });
    if (!q) { bad++; continue; }
    if (q.scored.raw !== 0 || q.scored.capped !== 0 || q.scored.points !== 2) bad++;
    if (q.scored.cap !== 5 || q.scored.base !== 2) bad++;
  }
  ok('genFan 使用自定义番表/封顶/底分', bad === 0, `失败 ${bad}`);
}
{
  // 自定义封顶 5、底分 3：题目 raw/capped/points 自洽，且确实能出 >3 番的题
  let bad = 0, gt3 = 0;
  for (let i = 0; i < 80; i++) {
    const q = C.genFan(3, { table: C.DEFAULT_FAN, cap: 5, base: 3 });
    if (!q) { bad++; continue; }
    if (q.scored.capped !== Math.min(q.scored.raw, 5)) bad++;
    if (q.scored.points !== 3 * Math.pow(2, q.scored.capped)) bad++;
    if (q.scored.capped > 3) gt3++;
  }
  ok('genFan 自定义封顶 5 自洽', bad === 0, `失败 ${bad}`);
  ok('封顶 5 时能出 >3 番的题', gt3 > 0, `>3 番题数 ${gt3}`);
}
{
  // 金钩钓题：4 组副露 + 手里一对，识别正确且数值自洽
  let jg = 0, bad = 0;
  for (let i = 0; i < 200; i++) {
    const q = C.genFan(3, { table: C.DEFAULT_FAN, cap: 5, base: 1 });
    if (!q) { bad++; continue; }
    if (!q.melds || !q.melds.length) continue;
    jg++;
    if (q.melds.length !== 4) bad++;
    if (q.hand.length !== 2 || !C.isWinHand(C.toCounts(q.hand), 4)) bad++;
    const keys = q.yaku.map(e => e.key);
    if (keys.indexOf('jin_gou_diao') < 0 || keys.indexOf('dui_dui_hu') >= 0) bad++;
    if (q.scored.points !== Math.pow(2, q.scored.capped)) bad++;
  }
  ok('genFan 能出金钩钓题且不自相矛盾', jg > 0 && bad === 0, `金钩钓 ${jg} 题，问题 ${bad}`);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
