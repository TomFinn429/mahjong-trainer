/* ============================================================
   期望得分（roadmap T12 第 2 步）：把「速度 × 打点」换算成同一个单位——本局剩余部分的期望得分（底分）
   只用可见信息；只评估听牌和一向听（缺门已打完），更远的局面返回 null，由综合分处理
   - 听牌：V0 = a × P(和) × G + b × P(和) + c
       P(和)：逻辑回归，特征是待牌剩余张数、牌墙剩余、未胡人数（ev-weights.mjs，tools/fit-ev.mjs 从牌谱拟合）
       G：胡了平均收入，按每张待牌的剩余张数加权；自摸收 (未胡人数 − 1) 家、点炮收 1 家，自摸占比按未胡人数取实测值
       a、b、c：把「和牌率 × 收入」校准到实测的本局剩余得分（c 近似「一直不胡」时的得分，含别人胡牌时的支出）
   - 一向听：V1 = P(来得及听牌) × 平均[摸到每张有效牌后最好的 V0] + (1 − P(来得及听牌)) × c，再做一次线性校准（calib1）
       每次摸到有效牌的概率 = 有效牌剩余 / 看不见的牌，自己大约还能摸 牌墙剩余 ÷ 未胡人数 次；
       听牌时的牌墙按「平均要摸几次才进张」相应减少
   ============================================================ */
import { shanten, toCounts, suitOf, isWinHand } from '../core/core.mjs';
import { evalWin } from '../game/engine.mjs';
import { visibleCounts } from './danger.mjs';
import { EV_WEIGHTS } from './ev-weights.mjs';

const WALL0 = 55;   // 发完牌后牌墙张数，用来把牌墙剩余缩放到 0–1

/* 逻辑回归特征：和 tools/fit-ev.mjs 共用，改动时两边一起重拟合 */
export function pHuFeatures(remain, wall, active) {
  const r = Math.log1p(remain), w = wall / WALL0;
  return [1, r, w, w * w, r * w, active === 3 ? 1 : 0, active <= 2 ? 1 : 0];
}

const sigmoid = z => 1 / (1 + Math.exp(-z));

/* 当前视角下 EV 需要的公共信息（每个决定算一次） */
export function evContext(view) {
  const me = view.players[view.seat];
  const vis = visibleCounts(view);
  let seen = 0;
  for (let k = 0; k < 27; k++) seen += vis[k];
  for (const t of me.hand) vis[t]--;          // 只留别人那边看得到的张数，自己的牌按手牌计数扣
  return {
    rules: view.rules, melds: me.melds, openN: me.melds.length, voidSuit: me.voidSuit,
    vis, unseen: 108 - seen, wall: view.wallCount,
    active: view.players.filter(p => !p.won).length,
    w: EV_WEIGHTS, cache: new Map()
  };
}

function toTiles(counts) {
  const out = [];
  for (let k = 0; k < 27; k++) for (let i = 0; i < counts[k]; i++) out.push(k);
  return out;
}

/* 同花色前后两张以内有牌，才可能是待牌（顺子、刻子、对子、七对单张都满足） */
function near(counts, k) {
  const r = k % 9;
  for (let d = -2; d <= 2; d++) if (r + d >= 0 && r + d <= 8 && counts[k + d]) return true;
  return false;
}

/* 是否听牌：有一张牌能和就是听牌，比通用向听搜索快得多（自己已拿满 4 张的「空听」不算） */
function isTenpai(ctx, counts) {
  for (let k = 0; k < 27; k++) {
    if (suitOf(k) === ctx.voidSuit || counts[k] >= 4 || !near(counts, k)) continue;
    counts[k]++;
    const win = isWinHand(counts, ctx.openN);
    counts[k]--;
    if (win) return true;
  }
  return false;
}

/* 听牌的每张待牌：剩余张数、点炮收入、自摸时每家付的分 */
export function tenpaiWaits(ctx, counts) {
  const hand = toTiles(counts);
  const zimoFan = ctx.rules.fan.zi_mo ?? 1;
  const cap = ctx.rules.cap > 0 ? ctx.rules.cap : Infinity;
  const waits = [];
  for (let k = 0; k < 27; k++) {
    if (suitOf(k) === ctx.voidSuit || counts[k] >= 4 || !near(counts, k)) continue;
    counts[k]++;
    const win = isWinHand(counts, ctx.openN);
    counts[k]--;
    if (!win) continue;
    const s = evalWin(ctx.rules, hand, ctx.melds, k, {}).scored;
    waits.push({
      tile: k, remain: Math.max(0, 4 - counts[k] - ctx.vis[k]),
      ron: s.points, zimo: ctx.rules.base * Math.pow(2, Math.min(s.raw + zimoFan, cap))
    });
  }
  return waits;
}

/* 胡了的平均收入：按剩余张数加权；全部绝张时按简单平均（几乎胡不了，只影响很小的 P(和)） */
export function expectedGain(waits, active, pz) {
  const z = pz[active] ?? pz[3];
  const g = w => z * Math.max(1, active - 1) * w.zimo + (1 - z) * w.ron;
  const R = waits.reduce((a, w) => a + w.remain, 0);
  if (!waits.length) return 0;
  return R > 0 ? waits.reduce((a, w) => a + w.remain * g(w), 0) / R : waits.reduce((a, w) => a + g(w), 0) / waits.length;
}

function v0(ctx, counts, wall) {
  const hand = counts.join('');
  const key = hand + '|' + wall;
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  // 待牌和番数只取决于手牌，单独缓存：一向听的不同候选会用不同的牌墙查同一副听牌
  let waits = ctx.cache.get(hand);
  if (!waits) { waits = tenpaiWaits(ctx, counts); ctx.cache.set(hand, waits); }
  const R = waits.reduce((a, w) => a + w.remain, 0);
  const x = pHuFeatures(R, wall, ctx.active);
  const p = sigmoid(x.reduce((a, xi, i) => a + xi * ctx.w.pHu[i], 0));
  const G = expectedGain(waits, ctx.active, ctx.w.pz);
  const { a, b, c } = ctx.w.calib;
  const res = { ev: a * p * G + b * p + c, pHu: p, gain: G, remain: R, waits };
  ctx.cache.set(key, res);
  return res;
}

/* 进张概率与听牌时的牌墙：自己还能摸 D 次，每次进张概率 p */
function reach(u, unseen, wall, active) {
  const D = Math.max(1, Math.round(wall / Math.max(1, active)));
  const p = Math.min(1, u / Math.max(1, unseen));
  if (p <= 0) return { P: 0, wallAt: 0 };
  let P = 0, ek = 0, q = 1;
  for (let k = 1; k <= D; k++) { const hit = q * p; P += hit; ek += k * hit; q *= 1 - p; }
  return { P, wallAt: Math.max(0, wall - active * (ek / P)) };
}

function v1(ctx, counts) {
  // 先数有效牌，得到听牌时的牌墙，再按这个牌墙算每张有效牌之后最好的 V0
  const tiles = [];
  let u = 0;
  for (let t = 0; t < 27; t++) {
    if (suitOf(t) === ctx.voidSuit) continue;
    const remain = 4 - counts[t] - ctx.vis[t];
    if (remain <= 0) continue;
    counts[t]++;
    const discards = [];
    for (let d = 0; d < 27; d++) {
      if (!counts[d] || d === t) continue;
      counts[d]--;
      if (isTenpai(ctx, counts)) discards.push(d);
      counts[d]++;
    }
    counts[t]--;
    if (discards.length) { tiles.push({ t, remain, discards }); u += remain; }
  }
  const { P, wallAt } = reach(u, ctx.unseen, ctx.wall, ctx.active);
  let acc = 0;
  for (const { t, remain, discards } of tiles) {
    counts[t]++;
    let best = -Infinity;
    for (const d of discards) {
      counts[d]--;
      best = Math.max(best, v0(ctx, counts.slice(), Math.round(wallAt)).ev);
      counts[d]++;
    }
    counts[t]--;
    acc += remain * best;
  }
  const c = ctx.w.calib.c;
  const raw = u ? P * (acc / u) + (1 - P) * c : c;
  const k = ctx.w.calib1 || { a: 1, c: 0 };   // 一向听的线性校准（模型对一向听偏乐观，见 docs/experiments.md）
  return { ev: k.a * raw + k.c, raw, pReach: P, ukeire: u };
}

/* 一副 13(−3n) 张手牌的期望得分；向听 ≥ 2 或手里还有缺门牌时返回 null */
export function handValue(ctx, hand) {
  if (hand.some(t => suitOf(t) === ctx.voidSuit)) return null;
  const counts = toCounts(hand);
  const sh = shanten(counts, ctx.openN);
  if (sh === 0) return { shanten: 0, ...v0(ctx, counts, ctx.wall) };
  if (sh === 1) return { shanten: 1, ...v1(ctx, counts) };
  return null;
}
