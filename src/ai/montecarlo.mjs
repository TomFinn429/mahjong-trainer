/* ============================================================
   蒙特卡洛前瞻：对前几名候选打法，随机补全看不见的牌，模拟自己往后的摸打，
   估计「和牌率」和「期望得分」（单位：底分），用它给候选重新排序
   模型（有意做得简单，速度优先）：
   - 看不见的牌 = 108 − 自己手牌 − 所有副露 − 牌河 − 已胡者亮出的手牌，每次模拟随机洗一遍，
     依次当作「自己摸到的牌」和「其他未胡家打出的牌」（别家手牌和牌墙不区分）
   - 每轮：自己摸 1 张，其余每个未胡家各打出 1 张；只模拟自己，不模拟别家碰杠和胡牌
   - 自己的策略：能胡就胡（自摸 / 点炮）；听牌后摸什么打什么；未听时打出后向听最小，平手先打孤张、幺九；不碰不杠
   - 轮数 = 牌墙张数 ÷ 未胡人数（自己大约还能摸几次）
   - 所有候选共用同一批随机序列（公共随机数），候选之间的差异不被抽样噪声淹没
   ============================================================ */
import { shanten, toCounts, suitOf, isWinHand } from '../core/core.mjs';
import { evalWin } from '../game/engine.mjs';
import { visibleCounts } from './danger.mjs';
import { nextRand } from '../game/rng.mjs';

/* ronFactor：别家打出的牌中有多大比例「可以拿来点炮」。别家会扣住有用的牌、也会先胡走，
   均匀抽取会高估点炮机会，这个系数用自对弈牌谱校准（tools/calibrate-mc.mjs）。
   0.6：高手自对弈 300 局、1119 次首次听牌，实际和牌率 76.8%，预测 75.0%（对不防守的电脑；对会扣牌的人应更低）
   其余默认值取复式留出验证里最好的一组：只在听牌选择时用，期望高 10% 才改选（+0.03 ± 0.05，不显著） */
export const MC_DEFAULTS = Object.freeze({ samples: 96, maxCand: 4, maxShanten: 0, ronFactor: 0.6, minGain: 0.1 });

/* 平手时先打谁：孤张 < 有邻张；幺九 < 中张。值越小越先打 */
function keepValue(c, k) {
  const r = k % 9;
  let v = (c[k] - 1) * 4;
  for (const d of [-2, -1, 1, 2]) {
    const j = k + d;
    if (j < 0 || j >= 27 || Math.floor(j / 9) !== Math.floor(k / 9)) continue;
    if (c[j]) v += Math.abs(d) === 1 ? 2 : 1;
  }
  return v + (r === 0 || r === 8 ? 0 : r === 1 || r === 7 ? 0.5 : 1);
}

/* 模拟中的单家：counts 是门内手牌（含缺门），只记自己 */
function simulateOne(ctx, counts, { tiles: seq, ron }) {
  const { voidSuit, openN, rounds, others } = ctx;
  const c = counts.slice();
  let voidLeft = 0;
  if (voidSuit !== null) for (let k = voidSuit * 9; k < voidSuit * 9 + 9; k++) voidLeft += c[k];
  let waits = null;                         // 听牌时的听张（按当前 13 张），未听为 null
  const refreshWaits = () => {
    waits = null;
    if (voidLeft) return;
    if (shanten(c, openN) !== 0) return;
    waits = new Set();
    for (let k = 0; k < 27; k++) {
      if (suitOf(k) === voidSuit || c[k] >= 4) continue;
      c[k]++;
      if (isWinHand(c, openN)) waits.add(k);
      c[k]--;
    }
  };
  refreshWaits();
  let p = 0;
  for (let r = 0; r < rounds && p < seq.length; r++) {
    const t = seq[p++];
    if (waits && waits.has(t)) return winValue(ctx, c, t, true);
    c[t]++;
    if (suitOf(t) === voidSuit) voidLeft++;
    // 打牌：有缺门先打缺门，否则在使向听最小的打法里挑最该打的
    let out = -1;
    if (waits) {
      out = t;                               // 已听牌：摸什么打什么，保持听张（不模拟改听）
    } else if (voidLeft) {
      for (let k = voidSuit * 9; k < voidSuit * 9 + 9; k++) if (c[k]) { out = k; break; }
      voidLeft--;
    } else {
      const target = shanten(c, openN);
      const order = [];
      for (let k = 0; k < 27; k++) if (c[k]) order.push(k);
      order.sort((a, b) => keepValue(c, a) - keepValue(c, b));
      for (const k of order) {
        c[k]--;
        const ok = shanten(c, openN) === target;
        c[k]++;
        if (ok) { out = k; break; }
      }
    }
    c[out]--;
    if (out !== t) refreshWaits();          // 摸什么打什么时手牌没变，听张不变
    // 其他未胡家各打出一张，能点炮就胡
    for (let o = 0; o < others && p < seq.length; o++) {
      const d = seq[p];
      if (waits && ron[p] && waits.has(d)) return winValue(ctx, c, d, false);
      p++;
    }
  }
  return 0;
}

/* 胡牌得分（底分）：自摸由其他未胡家各付一次，点炮只由一家付 */
function winValue(ctx, c, tile, zimo) {
  const key = c.join('') + '|' + tile + '|' + (zimo ? 1 : 0);
  let pts = ctx.fanCache.get(key);
  if (pts === undefined) {
    const hand = [];
    for (let k = 0; k < 27; k++) for (let i = 0; i < c[k]; i++) hand.push(k);
    pts = evalWin(ctx.rules, hand, ctx.melds, tile, { zimo }).scored.points;
    ctx.fanCache.set(key, pts);
  }
  ctx.wins++;
  return zimo ? pts * ctx.others : pts;
}

/* 估计若干种打法的和牌率与期望得分：tiles 是候选打出的牌，返回 { [tile]: { winRate, ev, samples, rounds } }。
   rng 是 { rng: uint32 } 形式的随机数状态 */
export function estimateDiscards(view, tiles, rng, opts = {}) {
  const o = { ...MC_DEFAULTS, ...opts };
  const me = view.players[view.seat];
  const active = view.players.filter(p => !p.won).length;
  const rounds = Math.max(1, Math.floor(view.wallCount / Math.max(1, active)));
  const vis = visibleCounts(view);
  const unseen = [];
  for (let k = 0; k < 27; k++) for (let i = vis[k]; i < 4; i++) unseen.push(k);
  const ctx = {
    voidSuit: me.voidSuit ?? null, openN: me.melds.length, rounds, others: active - 1,
    rules: view.rules, melds: me.melds, fanCache: new Map(), wins: 0
  };
  const need = Math.min(unseen.length, rounds * active);
  const seqs = [];
  for (let s = 0; s < o.samples; s++) {
    const a = unseen.slice();
    for (let i = 0; i < need; i++) {           // 只洗用得到的前 need 张
      const j = i + Math.floor(nextRand(rng) * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    const ron = new Uint8Array(need);
    for (let i = 0; i < need; i++) ron[i] = nextRand(rng) < o.ronFactor ? 1 : 0;
    seqs.push({ tiles: a.slice(0, need), ron });
  }
  const full = toCounts(me.hand);
  const out = {};
  for (const tile of tiles) {
    const c = full.slice(); c[tile]--;
    let sum = 0;
    ctx.wins = 0;
    for (const seq of seqs) sum += simulateOne(ctx, c, seq);
    out[tile] = { winRate: +(ctx.wins / o.samples).toFixed(3), ev: +(sum / o.samples).toFixed(3), samples: o.samples, rounds };
  }
  return out;
}

/* 对 rows（evaluateDiscards 的结果）中向听最小的前 maxCand 名做模拟，写入 r.mc，
   按期望得分重新排序这几名（其余行不动） */
export function refineByMonteCarlo(view, rows, rng, opts = {}) {
  const o = { ...MC_DEFAULTS, ...opts };
  if (rows.length < 2) return rows;
  const me = view.players[view.seat];
  const bestSh = Math.min(...rows.map(r => r.shanten));
  if (bestSh > o.maxShanten) return rows;
  const pool = rows.filter(r => r.shanten === bestSh).slice(0, o.maxCand);
  if (pool.length < 2 || pool.every(r => suitOf(r.tile) === me.voidSuit)) return rows;
  const est = estimateDiscards(view, pool.map(r => r.tile), rng, o);
  for (const r of pool) r.mc = est[r.tile];
  // minGain：模拟期望至少比原第一名高出这个比例才改选，避免抽样噪声带来的翻转
  const top = pool.reduce((a, r) => (r.mc.ev > a.mc.ev ? r : a), pool[0]);
  if (top !== pool[0] && top.mc.ev < pool[0].mc.ev * (1 + o.minGain)) return rows;
  const idx = pool.map(r => rows.indexOf(r)).sort((a, b) => a - b);
  const ranked = pool.slice().sort((a, b) => b.mc.ev - a.mc.ev || rows.indexOf(a) - rows.indexOf(b));
  idx.forEach((pos, i) => { rows[pos] = ranked[i]; });
  return rows;
}
