/* ============================================================
   局势分析器：只用 viewFor() 给出的可见信息
   - evaluateDiscards：每个可打的牌 → 向听 / 有效牌（扣除可见）/ 危险度 / 综合分
   - evaluateClaim：碰 / 杠 / 胡 的前后对比
   - analyze：给界面和 LLM 用的完整局势 JSON（含关键时刻提醒）
   电脑高手和分析器共用同一套评估，保证「分析建议」与「高手电脑」口径一致
   ============================================================ */
import { shanten, ukeire, toCounts, suitOf, isWinHand, tileCN, decompose, blockName } from '../core/core.mjs';
import { evalWin } from '../game/engine.mjs';
import { visibleCounts, allThreats, tileDanger } from './danger.mjs';

const SUIT_NAME = ['万', '条', '筒'];
const REL = ['你', '下家', '对家', '上家'];

function meOf(view) { return view.players[view.seat]; }

/* 去掉缺门牌后的计数：缺门牌是死牌，不参与组牌 */
function usable(counts, voidSuit) {
  const c = counts.slice();
  if (voidSuit !== null && voidSuit !== undefined) for (let k = voidSuit * 9; k < voidSuit * 9 + 9; k++) c[k] = 0;
  return c;
}

function keepSuits(voidSuit) {
  return [0, 1, 2].map(s => s !== voidSuit);
}

/* 其他人可见的张数（不含自己手牌），供 ukeire 扣减 */
function othersVisible(view) {
  const vis = visibleCounts(view);
  for (const t of meOf(view).hand) vis[t]--;
  return vis;
}

/* 一副 13(−3n) 张手牌的牌效：向听、有效牌、听牌时的听张与番数 */
export function handEfficiency(view, hand) {
  const me = meOf(view);
  const openN = me.melds.length;
  const counts = toCounts(hand);
  const voidLeft = hand.filter(t => suitOf(t) === me.voidSuit).length;
  const u = usable(counts, me.voidSuit);
  const vis = othersVisible(view);
  const uk = ukeire(u, keepSuits(me.voidSuit), openN, vis);
  const res = {
    shanten: uk.base,
    voidLeft,
    ukeire: uk.list.map(k => ({ tile: k, remain: Math.max(0, 4 - u[k] - vis[k]) })),
    ukeireTotal: uk.total
  };
  if (uk.base === 0 && voidLeft === 0) {
    res.waits = [];
    for (let k = 0; k < 27; k++) {
      if (suitOf(k) === me.voidSuit) continue;
      const c = counts.slice(); c[k]++;
      if (!isWinHand(c, openN)) continue;
      const w = evalWin(view.rules, hand, me.melds, k, {});
      res.waits.push({ tile: k, remain: Math.max(0, 4 - counts[k] - vis[k]), fan: w.scored.capped, yaku: w.yaku.map(y => y.key) });
    }
  }
  return res;
}

/* 攻守模式：根据自己的进度与对手威胁决定 */
export function stanceOf(bestShanten, threats, wallCount) {
  const max = Math.max(0, ...Object.values(threats).map(t => t.threat));
  if ((bestShanten >= 2 && max >= 0.45) || (bestShanten >= 1 && max >= 0.6 && wallCount <= 20)) return { stance: 'fold', maxThreat: max };
  if (max >= 0.35 && bestShanten >= 1) return { stance: 'balance', maxThreat: max };
  return { stance: 'attack', maxThreat: max };
}

const LAMBDA = { attack: 0, balance: 1.2, fold: 12 };

export function evaluateDiscards(view, opts = {}) {
  const me = meOf(view);
  const threats = allThreats(view);
  const visible = visibleCounts(view);
  const tilesToTry = [...new Set(view.actions.filter(a => a.type === 'discard').map(a => a.tile))];
  const rows = tilesToTry.map(tile => {
    const hand = me.hand.slice(); hand.splice(hand.indexOf(tile), 1);
    const eff = handEfficiency(view, hand);
    const dg = tileDanger(view, tile, threats, visible);
    return { tile, ...eff, danger: dg.danger, dangerBy: dg.by };
  });
  const bestSh = Math.min(...rows.map(r => r.shanten));
  const st = opts.defense === false ? { stance: 'attack', maxThreat: 0 } : stanceOf(bestSh, threats, view.wallCount);
  if (opts.balance === false && st.stance === 'balance') st.stance = 'attack';
  for (const r of rows) {
    const waitBonus = r.waits ? r.waits.reduce((a, w) => a + w.remain * (1 + w.fan * 0.5), 0) : 0;
    r.score = +(-r.shanten * 100 + r.ukeireTotal + waitBonus * 0.5 - LAMBDA[st.stance] * r.danger * 100).toFixed(2);
  }
  rows.sort((a, b) => b.score - a.score || a.shanten - b.shanten || b.ukeireTotal - a.ukeireTotal || a.tile - b.tile);
  return { rows, threats, ...st };
}

/* 一步前瞻（好形判断）：对向听相同、有效牌接近的前几名候选，
   计算「摸到每张有效牌后，再打一张能留下多少有效牌」的加权和。
   两面等好形在这里会明显胜过同样张数的嵌张 / 边张 */
export function refineByLookahead(view, rows, maxCand = 4) {
  if (!rows.length) return rows;
  const me = meOf(view);
  const top = rows[0];
  if (top.shanten < 1 || top.voidLeft) return rows;
  const vis = othersVisible(view);
  const keep = keepSuits(me.voidSuit);
  const openN = me.melds.length;
  const pool = rows.filter(r => r.shanten === top.shanten && r.ukeireTotal >= top.ukeireTotal * 0.7 && r.score >= top.score - 30).slice(0, maxCand);
  if (pool.length < 2) return rows;
  for (const r of pool) {
    const hand13 = me.hand.slice(); hand13.splice(hand13.indexOf(r.tile), 1);
    const c13 = usable(toCounts(hand13), me.voidSuit);
    let value = 0;
    for (const u of r.ukeire) {
      if (!u.remain) continue;
      const c14 = c13.slice(); c14[u.tile]++;
      let bestNext = 0;
      for (let t = 0; t < 27; t++) {
        if (!c14[t]) continue;
        c14[t]--;
        const uk = ukeire(c14, keep, openN, vis);
        if (uk.base < r.shanten && uk.total > bestNext) bestNext = uk.total;
        c14[t]++;
      }
      value += u.remain * bestNext;
    }
    r.lookahead = value;
  }
  const maxV = Math.max(...pool.map(r => r.lookahead));
  for (const r of pool) r.score = +(r.score + 12 * r.lookahead / (maxV || 1)).toFixed(2);
  rows.sort((a, b) => b.score - a.score || a.tile - b.tile);
  return rows;
}

/* 碰 / 明杠 / 胡 的对比 */
export function evaluateClaim(view) {
  const me = meOf(view);
  const tile = view.claim ? view.claim.tile : view.rob ? view.rob.tile : null;
  const out = { tile, options: {} };
  const before = handEfficiency(view, me.hand);
  out.before = { shanten: before.shanten, ukeireTotal: before.ukeireTotal };
  for (const a of view.actions) {
    if (a.type === 'hu') {
      const w = evalWin(view.rules, me.hand, me.melds, tile, { qiangGang: !!view.rob });
      out.options.hu = { fan: w.scored.capped, points: w.scored.points, yaku: w.yaku.map(y => y.key) };
    } else if (a.type === 'pong') {
      const hand = me.hand.slice();
      hand.splice(hand.indexOf(tile), 1); hand.splice(hand.indexOf(tile), 1);
      const fake = withMeld(view, hand, { kind: 'pong', tile });
      let best = null;
      for (const t of new Set(discardPool(hand, me.voidSuit))) {
        const h = hand.slice(); h.splice(h.indexOf(t), 1);
        const e = handEfficiency(fake, h);
        if (!best || e.shanten < best.shanten || (e.shanten === best.shanten && e.ukeireTotal > best.ukeireTotal)) best = { ...e, discard: t };
      }
      out.options.pong = best ? { shanten: best.shanten, ukeireTotal: best.ukeireTotal, discard: best.discard } : null;
    } else if (a.type === 'minggang') {
      const hand = me.hand.filter(t => t !== tile);
      const e = handEfficiency(withMeld(view, hand, { kind: 'gang', tile }), hand);
      out.options.minggang = { shanten: e.shanten, ukeireTotal: e.ukeireTotal };
    }
  }
  return out;
}

/* 自己回合的杠：暗杠 / 补杠后的牌效 vs 不杠时的最佳打法 */
export function evaluateTurnGang(view, act) {
  const me = meOf(view);
  const hand = act.type === 'angang' ? me.hand.filter(t => t !== act.tile) : me.hand.filter((t, i) => i !== me.hand.indexOf(act.tile));
  const fakeView = act.type === 'angang' ? withMeld(view, hand, { kind: 'gang', tile: act.tile })
    : { ...view, players: view.players.map(p => p.seat === view.seat ? { ...p, hand, melds: p.melds.map(m => m.tile === act.tile ? { ...m, kind: 'gang' } : m) } : p) };
  return handEfficiency(fakeView, hand);
}

function discardPool(hand, voidSuit) {
  const v = hand.filter(t => suitOf(t) === voidSuit);
  return v.length ? v : hand;
}

function withMeld(view, hand, meld) {
  return { ...view, players: view.players.map(p => p.seat === view.seat ? { ...p, hand, melds: [...p.melds, meld] } : p) };
}

/* ---------- 给界面 / LLM 的完整分析 ---------- */
export function analyze(view) {
  const me = meOf(view);
  const out = {
    seat: view.seat,
    phase: view.phase,
    wallCount: view.wallCount,
    myDraws: me.draws,
    me: {
      hand: me.hand.slice(),
      melds: me.melds.map(m => ({ kind: m.kind, tile: m.tile })),
      voidSuit: me.voidSuit,
      voidLeft: me.hand.filter(t => suitOf(t) === me.voidSuit).length,
      score: me.score,
      won: me.won
    },
    opponents: [],
    alerts: []
  };
  const threats = allThreats(view);
  for (const p of view.players) {
    if (p.seat === view.seat) continue;
    const t = threats[p.seat];
    out.opponents.push({
      seat: p.seat, voidSuit: p.voidSuit, won: p.won ? { fan: p.won.fan, zimo: p.won.zimo } : null,
      melds: p.melds.map(m => ({ kind: m.kind, tile: m.tile })),
      discards: p.discards.filter(d => !d.claimed).map(d => d.tile),
      draws: p.draws, score: p.score,
      threat: +t.threat.toFixed(2), voidCleared: t.voidCleared, suspectSuit: t.suspectSuit, reasons: t.reasons
    });
  }

  if (view.phase === 'turn' && view.turn === view.seat && view.actions.some(a => a.type === 'discard')) {
    const ev = evaluateDiscards(view);
    out.stance = ev.stance;
    out.maxThreat = +ev.maxThreat.toFixed(2);
    refineByLookahead(view, ev.rows);
    out.candidates = ev.rows.map((r, i) => ({ id: `c${i + 1}`, ...r }));
    out.recommend = out.candidates[0] ? { action: 'discard', tile: out.candidates[0].tile, id: 'c1' } : null;
    const d = decompose(usable(toCounts(me.hand), me.voidSuit), me.melds.length);
    out.me.blocks = d.seven
      ? { seven: true, pairs: d.pairs.map(blockName), floats: d.floats.map(tileCN) }
      : { melds: d.melds.map(blockName), taatsu: d.taatsu.map(blockName), pair: d.pair ? blockName(d.pair) : null, floats: d.floats.map(tileCN) };
    if (view.actions.some(a => a.type === 'hu')) out.alerts.push({ level: 'key', code: 'canZimo', text: '可以自摸' });
    for (const a of view.actions.filter(a => a.type === 'angang' || a.type === 'bugang')) {
      const e = evaluateTurnGang(view, a);
      out.gangOptions = out.gangOptions || [];
      out.gangOptions.push({ type: a.type, tile: a.tile, shanten: e.shanten, ukeireTotal: e.ukeireTotal });
      out.alerts.push({ level: 'key', code: 'canGang', text: `可以${a.type === 'angang' ? '暗杠' : '补杠'} ${tileCN(a.tile)}` });
    }
    const best = out.candidates[0];
    if (best && best.shanten === 0 && !best.voidLeft) out.alerts.push({ level: 'key', code: 'tenpai', text: `打 ${tileCN(best.tile)} 可听牌` });
    else if (best && best.shanten === 1) out.alerts.push({ level: 'info', code: 'oneShanten', text: '一向听' });
    if (ev.stance === 'fold') out.alerts.push({ level: 'key', code: 'fold', text: '对手威胁高、自己进度慢，建议转守' });
  } else if ((view.phase === 'claim' || view.phase === 'robGang') && view.actions.length) {
    out.claim = evaluateClaim(view);
    out.alerts.push({ level: 'key', code: 'claim', text: `可以${view.actions.filter(a => a.type !== 'pass').map(a => ({ hu: '胡', pong: '碰', minggang: '杠' })[a.type]).join(' / ')} ${tileCN(out.claim.tile)}` });
  }

  for (const o of out.opponents) {
    if (o.threat >= 0.5) out.alerts.push({ level: 'warn', code: 'oppThreat', text: `${REL[(o.seat - view.seat + 4) % 4]}威胁较高（${o.reasons.join('、')}）` });
  }
  const last = view.log[view.log.length - 1];
  const recentMeld = view.log.slice(-6).filter(e => (e.type === 'pong' || e.type === 'gang') && e.seat !== view.seat);
  if (recentMeld.length) out.alerts.push({ level: 'info', code: 'oppMeld', text: `${REL[(recentMeld[recentMeld.length - 1].seat - view.seat + 4) % 4]}刚${recentMeld[recentMeld.length - 1].type === 'pong' ? '碰' : '杠'}了牌` });
  if (view.wallCount <= 16 && view.phase !== 'end') out.alerts.push({ level: 'warn', code: 'late', text: `牌墙只剩 ${view.wallCount} 张` });
  if (out.me.voidLeft && me.draws >= 6) out.alerts.push({ level: 'warn', code: 'voidLeft', text: `还有 ${out.me.voidLeft} 张缺门牌未打（${SUIT_NAME[me.voidSuit]}），流局会被查花猪` });
  out.lastEvent = last ? last.type : null;
  return out;
}

/* 是否值得提醒玩家点「AI 讲解」 */
export function isKeyMoment(analysis) {
  return analysis.alerts.some(a => a.level === 'key' || a.level === 'warn');
}
