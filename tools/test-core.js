/* 从 index.html 抽出核心算法并在 Node 里做自检
   运行：node tools/test-core.js   （在 mahjong-trainer 目录下） */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\/ __CORE_START__([\s\S]*?)\/\/ __CORE_END__/);
if (!m) { console.error('找不到核心代码块'); process.exit(1); }

const coreMod = new Module('mj-core');
coreMod._compile(m[1], 'mj-core.js');
const C = coreMod.exports;

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`✗ ${name}\n    期望 ${JSON.stringify(want)}  实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond, extra) {
  if (cond) pass++; else { fail++; console.log(`✗ ${name} ${extra || ''}`); }
}

/* ---------- 工具：把 "123m456s99p" 转成 27 长度数组 ---------- */
const SUIT_IDX = { m: 0, s: 1, p: 2 };
function parse(str) {
  const c = new Array(27).fill(0);
  for (const seg of str.match(/\d+[msp]/g) || []) {
    const suit = SUIT_IDX[seg[seg.length - 1]];
    for (const d of seg.slice(0, -1)) c[suit * 9 + (+d) - 1]++;
  }
  return c;
}
function tilesOf(str) {
  const out = [];
  for (const seg of str.match(/\d+[msp]/g) || []) {
    const suit = SUIT_IDX[seg[seg.length - 1]];
    for (const d of seg.slice(0, -1)) out.push(suit * 9 + (+d) - 1);
  }
  return out;
}

/* ---------- 独立实现：和牌判定（用于交叉验证） ---------- */
function allMelds(c) {
  let i = 0; while (i < 27 && c[i] === 0) i++;
  if (i === 27) return true;
  if (c[i] >= 3) { c[i] -= 3; const r = allMelds(c); c[i] += 3; if (r) return true; }
  const rr = i % 9;
  if (rr <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    const r = allMelds(c);
    c[i]++; c[i + 1]++; c[i + 2]++;
    if (r) return true;
  }
  return false;
}
function isWin(c) {
  let n = 0; for (let i = 0; i < 27; i++) n += c[i];
  if (n !== 14) return false;
  for (let p = 0; p < 27; p++) {
    if (c[p] >= 2) { const d = c.slice(); d[p] -= 2; if (allMelds(d)) return true; }
  }
  // 七对（含龙七对：所有张数都是偶数）
  if (c.every(x => x % 2 === 0)) return true;
  return false;
}

/* ============================================================
   1. 已知牌型
   ============================================================ */
console.log('\n[1] 已知牌型向听数');
t('和牌 123m456m789m111s22s = -1', C.shanten(parse('123456789m111s22s')), -1);
t('和牌 七对 11223344556677m = -1', C.shanten(parse('11223344556677m')), -1);
t('和牌 龙七对 11112222333344m = -1', C.shanten(parse('11112222333344m')), -1);
t('听牌 123456789m11s22s = 0', C.shanten(parse('123456789m1122s')), 0);
t('听牌 七对 1122334455667m = 0', C.shanten(parse('1122334455667m')), 0);
t('听牌 龙七对方向 1111222233334m = 0', C.shanten(parse('1111222233334m')), 0);
t('1向听 3面子+2搭子无雀头 = 1', C.shanten(parse('123456789m125 6s'.replace(' ', ''))), 1);
t('极小牌 单张9m = 8', C.shantenStd(parse('9m')), 8);
t('清一色九莲宝灯型 1112345678999m = 0', C.shanten(parse('1112345678999m')), 0);

/* ============================================================
   2. 交叉验证：isWin 与 shanten === -1 一致
   ============================================================ */
console.log('[2] 随机 14 张：和牌判定一致性');
function randHand(n, k) {
  const pool = [];
  for (let i = 0; i < 27; i++) for (let j = 0; j < 4; j++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n).map(x => k === 2 ? (x % 18) : x);   // k=2 时限制在两门内
}
let winOk = true, winN = 0;
for (let i = 0; i < 4000; i++) {
  const hand = randHand(14, i % 2 ? 2 : 3);
  const c = new Array(27).fill(0); for (const x of hand) c[x]++;
  const a = isWin(c), b = C.shanten(c) === -1;
  if (a !== b) { winOk = false; console.log('   不一致:', hand.map(x => C.tileCN(x)).join(' '), 'isWin=', a, 'shanten=', C.shanten(c)); break; }
  winN++;
}
ok(`和牌判定一致（${winN} 组）`, winOk);

/* ============================================================
   3. 性质验证：单调性 / 下界
   ============================================================ */
console.log('[3] 性质：加一张牌不会变差；向听 k 时必有牌能降到 k-1');
let monoOk = true, stepOk = true, nonNegOk = true, deadTenpai = 0;
for (let i = 0; i < 600; i++) {
  const hand = randHand(13, i % 2 ? 2 : 3);
  const c = new Array(27).fill(0); for (const x of hand) c[x]++;
  const base = C.shanten(c);
  if (base < 0) { nonNegOk = false; console.log('   13 张出现负向听'); break; }

  // 加任意一张：向听不应上升
  for (let k = 0; k < 27; k++) {
    if (c[k] >= 4) continue;
    const d = c.slice(); d[k]++;
    if (C.shanten(d) > base) { monoOk = false; console.log('   单调性失败', hand.map(x => C.tileCN(x)).join(' '), '+', C.tileCN(k), base, '->', C.shanten(d)); break; }
  }
  if (!monoOk) break;

  // 存在一张牌使向听 -1；0 向听允许「空听」：4 面子 + 第 4 张浮牌，所需牌已全在手里
  let best = 99;
  for (let k = 0; k < 27; k++) {
    if (c[k] >= 4) continue;
    const d = c.slice(); d[k]++;
    best = Math.min(best, C.shanten(d));
  }
  if (best !== base - 1) {
    if (base === 0 && best === 0) { deadTenpai++; }
    else { stepOk = false; console.log('   递进性失败', hand.map(x => C.tileCN(x)).join(' '), 'base=', base, 'best=', best); break; }
  }
}
if (deadTenpai) console.log(`   0 向听空听（形式听牌、无有效牌）：${deadTenpai} 组，属已知边界`);
ok('单调性', monoOk);
ok('递进性（能一降到 base-1）', stepOk);
ok('13 张向听非负', nonNegOk);

/* ============================================================
   4. 听牌列表正确性
   ============================================================ */
console.log('[4] 听牌列表 = 真正能和的牌');
let tenOk = true;
for (let i = 0; i < 400; i++) {
  const hand = randHand(13, i % 2 ? 2 : 3);
  const c = new Array(27).fill(0); for (const x of hand) c[x]++;
  if (C.shanten(c) !== 0) continue;
  const keep = [true, true, true];
  const u = C.ukeire(c, keep);
  const real = [];
  for (let k = 0; k < 27; k++) {
    if (c[k] >= 4) continue;
    const d = c.slice(); d[k]++;
    if (isWin(d)) real.push(k);
  }
  if (JSON.stringify(u.list) !== JSON.stringify(real)) {
    tenOk = false;
    console.log('   听牌不一致', hand.map(x => C.tileCN(x)).join(' '),
      'ukeire=', u.list.map(x => C.tileCN(x)), 'real=', real.map(x => C.tileCN(x)));
    break;
  }
}
ok('听牌列表一致', tenOk);

/* ============================================================
   5. 缺一门约束
   ============================================================ */
console.log('[5] 缺一门约束');
{
  const c = parse('123456789m1256s');            // 万 + 条
  const keep = [true, true, false];
  const u = C.ukeire(c, keep);
  ok('有效牌不含筒', u.list.every(k => C.suitOf(k) !== 2));
}
{
  const c = parse('111222333m456s99s'.replace('99s', '99s'));  // 13 张
  const u = C.ukeire(c, [true, true, false]);
  ok('两门手牌有效牌只在两门内', u.list.every(k => C.suitOf(k) !== 2));
}

/* ============================================================
   6. 出题器
   ============================================================ */
console.log('[6] 出题器稳定性与性能');
{
  const t0 = Date.now();
  let fails = 0;
  for (let i = 0; i < 20; i++) {
    const q = C.genCut(2, true);
    if (!q) { fails++; continue; }
    const suits = new Set(q.hand.map(x => C.suitOf(x)));
    if (suits.size > 2) { fails++; console.log('   genCut 出现三门'); }
    if (q.hand.length !== 14) { fails++; }
    const best = q.options[0];
    if (best.shanten !== q.best.shanten || best.ukeire !== q.best.ukeire) { fails++; console.log('   best 不一致'); }
  }
  ok('genCut × 20', fails === 0, `失败 ${fails}`);
  console.log(`   genCut 平均耗时 ${((Date.now() - t0) / 20).toFixed(0)} ms/题`);
}
{
  const t0 = Date.now();
  let fails = 0;
  const cmp = (a, b) => a.k - b.k || a.sh - b.sh || b.uke - a.uke || b.shape - a.shape;
  for (let i = 0; i < 20; i++) {
    const q = C.genVoid(2);
    if (!q) { fails++; continue; }
    if (q.hand.length !== 13) fails++;
    if (new Set(q.hand.map(x => C.suitOf(x))).size !== 3) fails++;
    if (cmp(q.rows[0], q.rows[1]) > 0) fails++;      // rows 已按多目标排序
    if (!q.rows[0].best) fails++;
  }
  ok('genVoid × 20', fails === 0, `失败 ${fails}`);
  console.log(`   genVoid 平均耗时 ${((Date.now() - t0) / 20).toFixed(0)} ms/题`);
}
{
  // 定缺多目标排序手工用例：万 2 / 条 2 / 筒 9，必须在万、条之间选
  const rows = C.voidEval(tilesOf('12m34s555666777p'));
  const wan = rows.find(r => r.suit === 0), tiao = rows.find(r => r.suit === 1), tong = rows.find(r => r.suit === 2);
  ok('定缺：先比清缺速度（万/条 2 张 < 筒 9 张）', rows[0].suit === 0 && wan.k === 2 && tiao.k === 2 && tong.k === 9,
    rows.map(r => `${r.suit}:k${r.k}`).join(' '));
  ok('定缺：张数相同时比有效牌（34s 两面 > 12m 边张）', wan.uke > tiao.uke, `万 ${wan.uke} vs 条 ${tiao.uke}`);
  ok('定缺：好形分也是两面占优', wan.shape > tiao.shape, `万 ${wan.shape} vs 条 ${tiao.shape}`);
}
{
  // 空门 + 剩余两门走七对路线（decompose 会返回 seven 对象，没有 taatsu 字段）
  const rows = C.voidEval(tilesOf('122455899m2247s'));
  const kong = rows.find(r => r.suit === 2);
  ok('定缺：空门 + 剩余七对路线不报错', rows.length === 3 && kong && kong.k === 0, JSON.stringify(rows));
  let bad = 0;
  for (let i = 0; i < 500; i++) {
    try { C.voidEval(C.deal(13, [0, 1, 2])); } catch (e) { bad++; }
  }
  ok('voidEval × 500 随机牌不抛异常', bad === 0, `失败 ${bad}`);
}
{
  const t0 = Date.now();
  let fails = 0;
  for (let i = 0; i < 20; i++) {
    const q = C.genTen(2, true);
    if (!q) { fails++; continue; }
    if (q.hand.length !== 13) fails++;
    if (q.u.list.length < 1) fails++;
  }
  ok('genTen × 20', fails === 0, `失败 ${fails}`);
  console.log(`   genTen 平均耗时 ${((Date.now() - t0) / 20).toFixed(0)} ms/题`);
}

/* ============================================================
   7. 性能
   ============================================================ */
console.log('[7] 性能');
{
  const hands = [];
  for (let i = 0; i < 300; i++) hands.push(randHand(13, 2));
  const t0 = Date.now();
  for (const h of hands) { const c = new Array(27).fill(0); for (const x of h) c[x]++; C.shanten(c); }
  console.log(`   300 个新手牌：${Date.now() - t0} ms（含缓存冷启动）`);
  const t1 = Date.now();
  const q = C.genCut(2, true);
  console.log(`   单次完整出题（含 14×27 次向听）：${Date.now() - t1} ms`);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
