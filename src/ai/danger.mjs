/* ============================================================
   危险度 / 对手威胁估计（只用可见信息，结果是「估计」而非概率真值）
   川麻要点：
   - 对手缺门的牌对他绝对安全（他手里有缺门牌不能胡，胡牌时也不可能含缺门）
   - 已胡的对手不再有威胁
   - 没有振听：对手打过的牌并不安全（与日麻不同）
   ============================================================ */
import { suitOf } from '../core/core.mjs';

/* 观察者可见的每种牌张数：自己手牌 + 所有副露 + 牌河 + 自摸者亮出的那张胡牌
   （胡牌者其余手牌扣着不亮；点炮 / 抢杠的胡牌留在出牌者牌河里，已经算在牌河中） */
export function visibleCounts(view) {
  const c = new Array(27).fill(0);
  for (const p of view.players) {
    if (p.hand) for (const t of p.hand) c[t]++;
    else if (p.won && p.won.zimo) c[p.won.tile]++;
    for (const m of p.melds) c[m.tile] += m.kind === 'gang' ? 4 : 3;
    for (const d of p.discards) if (!d.claimed) c[d.tile]++;
  }
  return c;
}

/* 对手是否已打完缺门：最近 3 张出牌都不是缺门，或者已经有副露（有缺门牌时打出的必须是缺门） */
export function voidCleared(p) {
  if (p.voidSuit === null || p.voidSuit === undefined) return false;
  const ds = p.discards;
  if (!ds.length) return false;
  const lastVoid = ds.map(d => suitOf(d.tile) === p.voidSuit).lastIndexOf(true);
  return ds.length - 1 - lastVoid >= 3 || (lastVoid < 0 && ds.length >= 2);
}

/* 是否像在做清一色：副露全是同一门，且该门很少出现在牌河里 */
export function suspectQing(p) {
  if (!p.melds.length) return null;
  const s = suitOf(p.melds[0].tile);
  if (!p.melds.every(m => suitOf(m.tile) === s)) return null;
  const nonVoid = p.discards.filter(d => suitOf(d.tile) !== p.voidSuit);
  const same = nonVoid.filter(d => suitOf(d.tile) === s).length;
  if (p.melds.length >= 2 && same <= 1) return s;
  if (p.melds.length >= 1 && nonVoid.length >= 4 && same === 0) return s;
  return null;
}

/* 对手听牌程度（0~1 的启发式分数） */
export function opponentThreat(view, p) {
  if (p.won) return { threat: 0, voidCleared: true, suspectSuit: null, reasons: ['已胡'] };
  const reasons = [];
  const cleared = voidCleared(p);
  let t = 0.03 + 0.045 * p.draws + 0.13 * p.melds.length;
  if (p.melds.length) reasons.push(`${p.melds.length} 组副露`);
  if (p.draws >= 8) reasons.push(`已摸 ${p.draws} 巡`);
  if (!cleared) { t *= 0.35; reasons.push('缺门可能未打完'); }
  const suspectSuit = suspectQing(p);
  if (suspectSuit !== null) { t += 0.1; reasons.push('疑似清一色'); }
  if (p.melds.some(m => m.kind === 'gang')) t += 0.05;
  return { threat: Math.max(0, Math.min(0.95, t)), voidCleared: cleared, suspectSuit, reasons };
}

/* 单张牌对某个对手的危险度（0~1） */
export function tileDangerVs(view, p, threatInfo, tile, visible) {
  if (p.won || threatInfo.threat === 0) return 0;
  if (suitOf(tile) === p.voidSuit) return 0;
  const r = tile % 9;
  let base = (r === 0 || r === 8) ? 0.55 : (r === 1 || r === 7) ? 0.8 : 1;
  if (visible[tile] >= 3) base *= 0.6;          // 对手手里最多 1 张：对倒 / 单钓概率小
  if (threatInfo.suspectSuit !== null) base *= suitOf(tile) === threatInfo.suspectSuit ? 1.5 : 0.3;
  return Math.min(1, threatInfo.threat * base);
}

/* 打出某张牌的综合危险度：对每个未胡对手的危险合成 */
export function tileDanger(view, tile, threats, visible) {
  let safe = 1;
  const by = [];
  for (const p of view.players) {
    if (p.seat === view.seat) continue;
    const d = tileDangerVs(view, p, threats[p.seat], tile, visible);
    if (d > 0) by.push({ seat: p.seat, danger: +d.toFixed(3) });
    safe *= 1 - d;
  }
  return { danger: +(1 - safe).toFixed(3), by };
}

export function allThreats(view) {
  const out = {};
  for (const p of view.players) if (p.seat !== view.seat) out[p.seat] = opponentThreat(view, p);
  return out;
}
