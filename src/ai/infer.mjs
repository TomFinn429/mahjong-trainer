/* ============================================================
   读牌：从牌河、副露、定缺、摸切 / 手切推断对手暗手的牌型（roadmap T13，教学说明见 docs/hand-reading.md）
   只用观察者 view 里看得到的信息。四个模型都由 tools/fit-infer.mjs 从自对弈牌谱拟合（infer-weights.mjs）：
   - 花色分布 SUIT：对手暗手里的牌各属于哪门花色的比例（条件 logit，三门花色一起归一）
   - 牌张位置 TILE：同一门里，每种牌在他手里的期望张数（按看不见的张数分配，再按打过这张 / 打过邻牌 / 幺九修正）
   - 清一色 QING：他此刻的牌（暗手 + 副露）是否最多只有 1 张不在主花色（逻辑回归）
   - 放炮损失 LOSS：打这张牌点给他时要付几分（泊松回归，对数连接）
   硬规则（不靠模型）：有缺门牌时必须先打缺门，所以对手最后一张出牌不是缺门，他手里就一定没有缺门牌
   （轮到他、刚摸到缺门牌还没打出的那一刻除外；你自己做决定时对手都不在回合中）
   特征改动后要重新拟合：node tools/fit-infer.mjs fit <牌谱.jsonl> ...
   ============================================================ */
import { suitOf } from '../core/core.mjs';
import { visibleCounts } from './danger.mjs';
import { INFER_WEIGHTS } from './infer-weights.mjs';

export const INFER_VERSION = 1;
const SUIT_NAME = ['万', '条', '筒'];

const sigmoid = z => 1 / (1 + Math.exp(-z));
const dot = (w, x) => x.reduce((a, xi, i) => a + xi * w[i], 0);
const isVoidOf = (p, t) => p.voidSuit !== null && p.voidSuit !== undefined && suitOf(t) === p.voidSuit;

/* 缺门牌是否一定已经打完（硬规则）：打过牌，且最后一张不是缺门 */
export function voidSurelyCleared(p) {
  if (p.voidSuit === null || p.voidSuit === undefined) return false;
  const ds = p.discards;
  return ds.length > 0 && !isVoidOf(p, ds[ds.length - 1].tile);
}

/* 对手已经打过的非缺门牌（被碰走的也算他打的） */
function nonVoidDiscards(p) {
  return p.discards.filter(d => !isVoidOf(p, d.tile));
}

/* ---------- 花色分布：每门花色一行特征 ---------- */
export const SUIT_FEATURES = ['isVoid', 'discShare', 'early', 'recent', 'tedashi', 'middle', 'melds', 'meldsOther', 'visShare', 'voidLeftHint'];

/* vis：visibleCounts(view)（观察者看得到的所有牌）；返回 [suit0, suit1, suit2] 三行特征，已确定没有的花色为 null */
export function suitRows(view, p, vis) {
  const nv = nonVoidDiscards(p);
  const early = nv.slice(0, 5), recent = nv.slice(-4);
  const cleared = voidSurelyCleared(p);
  // 缺门牌还没打完时，缺门牌留在手里的线索：最近连续打缺门的张数
  let voidRun = 0;
  for (let i = p.discards.length - 1; i >= 0 && isVoidOf(p, p.discards[i].tile); i--) voidRun++;
  const voidLeftHint = p.discards.length ? Math.min(voidRun, 4) : 4;
  const meldS = [0, 1, 2].map(s => p.melds.filter(m => suitOf(m.tile) === s).length);
  const visS = [0, 1, 2].map(s => { let n = 0; for (let k = s * 9; k < s * 9 + 9; k++) n += vis[k]; return n; });
  return [0, 1, 2].map(s => {
    const isVoid = s === p.voidSuit ? 1 : 0;
    if (isVoid && cleared) return null;
    const inS = d => suitOf(d.tile) === s;
    return [
      isVoid,
      isVoid ? 0 : (nv.filter(inS).length + 0.5) / (nv.length + 1),
      isVoid ? 0 : early.filter(inS).length,
      isVoid ? 0 : recent.filter(inS).length,
      isVoid ? 0 : nv.filter(d => inS(d) && d.tsumogiri === false).length,
      isVoid ? 0 : nv.filter(d => inS(d) && d.tile % 9 >= 2 && d.tile % 9 <= 6).length,
      meldS[s],
      p.melds.length - meldS[s],
      visS[s] / 36,
      isVoid ? voidLeftHint : 0
    ];
  });
}

/* 每门花色占暗手的比例（三门之和为 1） */
export function suitShares(rows, w = INFER_WEIGHTS.suit) {
  const z = rows.map(x => (x ? Math.exp(dot(w, x)) : 0));
  const Z = z.reduce((a, b) => a + b, 0) || 1;
  return z.map(v => v / Z);
}

/* ---------- 牌张位置：同一门里每种牌一行特征（偏移量是 log 看不见的张数） ---------- */
export const TILE_FEATURES = ['discK', 'discNear', 'edge', 'nearEdge', 'tedashiNear'];

export function tileRow(p, k) {
  const r = k % 9;
  let discK = 0, discNear = 0, tedashiNear = 0;
  for (const d of p.discards) {
    if (suitOf(d.tile) !== suitOf(k)) continue;
    const dist = Math.abs(d.tile - k);
    if (dist === 0) discK++;
    else if (dist <= 2) { discNear++; if (d.tsumogiri === false) tedashiNear++; }
  }
  return [discK, discNear, r === 0 || r === 8 ? 1 : 0, r === 1 || r === 7 ? 1 : 0, tedashiNear];
}

/* 某个对手暗手里每种牌的期望张数（长度 27）；unseen[k]：观察者看不见的张数 */
export function tileExpect(p, shares, unseen, w = INFER_WEIGHTS.tile) {
  const out = new Array(27).fill(0);
  for (let s = 0; s < 3; s++) {
    if (!shares[s]) continue;
    const wt = [];
    let Z = 0;
    for (let k = s * 9; k < s * 9 + 9; k++) {
      const v = unseen[k] > 0 ? unseen[k] * Math.exp(dot(w, tileRow(p, k))) : 0;
      wt.push(v); Z += v;
    }
    if (!Z) continue;
    const n = p.handCount * shares[s];
    for (let i = 0; i < 9; i++) out[s * 9 + i] = Math.min(unseen[s * 9 + i], n * wt[i] / Z);
  }
  return out;
}

/* ---------- 清一色 / 放炮损失 ---------- */
export const QING_FEATURES = ['bias', 'topShare', 'topLogit', 'meldsTop', 'meldsOther', 'nvDiscards', 'discTop', 'draws'];

export function qingRow(p, shares) {
  const nonVoid = [0, 1, 2].filter(s => s !== p.voidSuit);
  const top = nonVoid.reduce((a, s) => (shares[s] > shares[a] ? s : a), nonVoid[0]);
  const sh = Math.min(0.999, Math.max(0.001, shares[top]));
  const nv = nonVoidDiscards(p);
  return {
    top,
    x: [1, sh, Math.log(sh / (1 - sh)), p.melds.filter(m => suitOf(m.tile) === top).length,
      p.melds.filter(m => suitOf(m.tile) !== top).length, Math.min(nv.length, 15),
      nv.length ? nv.filter(d => suitOf(d.tile) === top).length / nv.length : 0.5, Math.min(p.draws, 20)]
  };
}

export const LOSS_FEATURES = ['bias', 'pQing', 'tileInTop', 'pQingTile', 'melds', 'gangs', 'pongs', 'sameSuitMelds', 'single', 'draws'];

export function lossRow(p, info, tile) {
  const inTop = suitOf(tile) === info.top ? 1 : 0;
  const gangs = p.melds.filter(m => m.kind === 'gang').length;
  return [1, info.pQing, inTop, info.pQing * inTop, p.melds.length, gangs, p.melds.length - gangs,
    p.melds.length && p.melds.every(m => suitOf(m.tile) === suitOf(p.melds[0].tile)) ? p.melds.length : 0,
    p.handCount <= 2 ? 1 : 0, Math.min(p.draws, 20)];
}

/* 打出 tile 点给这个对手时要付的期望分数（底分） */
export function expectedLoss(p, info, tile, w = INFER_WEIGHTS.loss) {
  return Math.exp(dot(w, lossRow(p, info, tile)));
}

/* ---------- 汇总 ---------- */
/* 观察者看不见的每种牌张数 */
export function unseenCounts(view) {
  const vis = visibleCounts(view);
  return { vis, unseen: vis.map(v => Math.max(0, 4 - v)) };
}

/* 对一个未胡对手的完整推断 */
export function readOpponent(view, p, vu = unseenCounts(view)) {
  const rows = suitRows(view, p, vu.vis);
  const shares = suitShares(rows);
  const { top, x } = qingRow(p, shares);
  const pQing = sigmoid(dot(INFER_WEIGHTS.qing, x));
  const expect = tileExpect(p, shares, vu.unseen);
  const info = { seat: p.seat, shares, top, pQing, expect, voidCleared: voidSurelyCleared(p), handCount: p.handCount };
  info.lossTop = expectedLoss(p, info, top * 9 + 4);
  info.reasons = reasonsOf(p, info);
  return info;
}

/* 所有未胡对手；返回 { [seat]: info } */
export function readAll(view) {
  const vu = unseenCounts(view);
  const out = {};
  for (const p of view.players) if (p.seat !== view.seat && !p.won) out[p.seat] = readOpponent(view, p, vu);
  return out;
}

/* 每种牌在「所有对手暗手」里的期望张数；同一张牌几家加起来不超过看不见的张数 */
export function inHandsExpect(reads, unseen) {
  const out = new Array(27).fill(0);
  for (const r of Object.values(reads)) for (let k = 0; k < 27; k++) out[k] += r.expect[k];
  for (let k = 0; k < 27; k++) if (out[k] > unseen[k]) out[k] = unseen[k];
  return out;
}

/* 给人看的依据：只列模型用到的、能在牌桌上直接看到的事实 */
function reasonsOf(p, info) {
  const out = [];
  const nv = nonVoidDiscards(p);
  if (p.voidSuit !== null && p.voidSuit !== undefined) {
    out.push(info.voidCleared ? `缺${SUIT_NAME[p.voidSuit]}已打完（最后一张不是缺门，规则保证手里没有缺门牌）`
      : `缺${SUIT_NAME[p.voidSuit]}可能还没打完（最近打的还是缺门）`);
  }
  if (nv.length) {
    const cnt = [0, 1, 2].map(s => nv.filter(d => suitOf(d.tile) === s).length);
    out.push('非缺门出牌：' + [0, 1, 2].filter(s => s !== p.voidSuit).map(s => `${SUIT_NAME[s]} ${cnt[s]} 张`).join('、'));
    const mid = nv.slice(0, 6).filter(d => d.tile % 9 >= 2 && d.tile % 9 <= 6);
    if (mid.length) out.push(`早巡打过中张 ${mid.map(d => (d.tile % 9 + 1) + SUIT_NAME[suitOf(d.tile)]).join(' ')}（这门可能不要了）`);
    const ted = nv.slice(-4).filter(d => d.tsumogiri === false);
    if (ted.length >= 2) out.push(`最近 4 张里 ${ted.length} 张是手切（手牌在调整）`);
    else if (nv.length >= 4 && nv.slice(-4).every(d => d.tsumogiri === true)) out.push('最近 4 张都是摸切（手牌可能已成形）');
  }
  if (p.melds.length) out.push(`副露：${p.melds.map(m => (m.tile % 9 + 1) + SUIT_NAME[suitOf(m.tile)] + (m.kind === 'gang' ? '杠' : '碰')).join(' ')}`);
  out.push(`推断主花色：${SUIT_NAME[info.top]}（约占暗手 ${Math.round(info.shares[info.top] * 100)}%）`);
  return out;
}
