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
import { estimateDiscards } from './montecarlo.mjs';
import { evContext, handValue } from './ev.mjs';
import { learnedThreats, learnedTileDanger } from './danger-model.mjs';
import { seedFrom } from '../game/rng.mjs';

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

/* opts.dangerModel：'heuristic'（默认，danger.mjs）或 'learned'（danger-model.mjs）；
   opts.lambda：覆盖各攻守模式下危险度的权重；
   opts.ev：最好能到一向听以内时，听牌 / 一向听的候选改按期望得分（ev.mjs）排序，排在其他候选前面 */
export function evaluateDiscards(view, opts = {}) {
  const me = meOf(view);
  const learned = opts.dangerModel === 'learned';
  const threats = learned ? learnedThreats(view) : allThreats(view);
  const dangerOf = learned ? learnedTileDanger : tileDanger;
  const lambda = { ...LAMBDA, ...(opts.lambda || {}) };
  const visible = visibleCounts(view);
  const tilesToTry = [...new Set(view.actions.filter(a => a.type === 'discard').map(a => a.tile))];
  const rows = tilesToTry.map(tile => {
    const hand = me.hand.slice(); hand.splice(hand.indexOf(tile), 1);
    const eff = handEfficiency(view, hand);
    const dg = dangerOf(view, tile, threats, visible);
    return { tile, ...eff, danger: dg.danger, dangerBy: dg.by };
  });
  const bestSh = Math.min(...rows.map(r => r.shanten));
  const st = opts.defense === false ? { stance: 'attack', maxThreat: 0 } : stanceOf(bestSh, threats, view.wallCount);
  if (opts.balance === false && st.stance === 'balance') st.stance = 'attack';
  for (const r of rows) {
    const waitBonus = r.waits ? r.waits.reduce((a, w) => a + w.remain * (1 + w.fan * 0.5), 0) : 0;
    r.score = +(-r.shanten * 100 + r.ukeireTotal + waitBonus * 0.5 - lambda[st.stance] * r.danger * 100).toFixed(2);
  }
  rows.sort((a, b) => b.score - a.score || a.shanten - b.shanten || b.ukeireTotal - a.ukeireTotal || a.tile - b.tile);
  if (opts.ev && bestSh <= 1) attachEV(view, rows, lambda[st.stance]);
  return { rows, threats, ...st };
}

/* 期望得分排序：放炮代价按平均点炮损失 1.6 分折算（docs/experiments.md） */
const DEAL_IN_LOSS = 1.6;
function attachEV(view, rows, lambda) {
  const me = meOf(view);
  const ctx = evContext(view);
  for (const r of rows) {
    if (r.shanten > 1) continue;
    const hand = me.hand.slice(); hand.splice(hand.indexOf(r.tile), 1);
    const v = handValue(ctx, hand);
    if (!v) continue;
    r.ev = +(v.ev - lambda * r.danger * DEAL_IN_LOSS).toFixed(3);
    r.pHu = v.pHu, r.pReach = v.pReach;
  }
  const has = r => r.ev !== undefined;
  if (!rows.some(has)) return;
  rows.sort((a, b) => (has(b) - has(a)) || (has(a) ? b.ev - a.ev : 0) || b.score - a.score || a.tile - b.tile);
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

/* 高手：一门牌明显占优时倾向做清一色（2 番 = 4 倍），优先打掉另一门，只要向听不变差 */
/* opts.minTiles：主花色至少多少张（含副露）才开始做清一色；opts.slack：愿意比第一名少多少综合分 */
export function withQingBias(rows, me, opts = {}) {
  const minTiles = opts.minTiles ?? 9, slack = opts.slack ?? 8;
  const n = [0, 1, 2].map(s => (s === me.voidSuit ? -1 : me.hand.filter(t => suitOf(t) === s).length + me.melds.filter(m => suitOf(m.tile) === s).length * 3));
  const major = n.indexOf(Math.max(...n));
  const minor = [0, 1, 2].find(s => s !== major && s !== me.voidSuit);
  if (minor === undefined || n[major] < minTiles || me.melds.some(m => suitOf(m.tile) === minor)) return rows[0];
  const best = rows[0];
  const alt = rows.filter(r => suitOf(r.tile) === minor && r.shanten === best.shanten && r.score >= best.score - slack)[0];
  return alt || best;
}

/* 碰 / 明杠 / 胡 的对比；opts.ev：同时给出不动、碰、明杠的期望得分（算不出时为 undefined） */
export function evaluateClaim(view, opts = {}) {
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
  if (opts.ev && view.claim) {
    const e = claimEV(view);
    const r3 = x => (x === undefined ? undefined : +x.toFixed(3));
    out.evPass = r3(e.pass);
    if (out.options.pong && e.pong) Object.assign(out.options.pong, { ev: r3(e.pong.ev), evDiscard: e.pong.discard });
    if (out.options.minggang && e.minggang !== undefined) out.options.minggang.ev = r3(e.minggang);
  }
  return out;
}

/* ---------- 副露的期望得分（T12 第 3 步） ---------- */
/* 杠后马上收到的杠钱（刮风下雨），算进杠的期望得分 */
function gangIncome(view, gangType) {
  const r = view.rules;
  if (!r.gangPay) return 0;
  const others = view.players.filter(p => !p.won).length - 1;
  return r.base * (gangType === 'ming' ? r.gangPayMing : (gangType === 'an' ? r.gangPayAn : r.gangPayBu) * others);
}

/* 碰 / 明杠之后的假想视图：加上副露，被碰的那张从出牌者牌河里标记为已被拿走（否则可见张数会多算一张） */
function claimedView(view, hand, meld) {
  const from = view.claim.from;
  return {
    ...view,
    players: view.players.map(p => {
      if (p.seat === view.seat) return { ...p, hand, melds: [...p.melds, meld] };
      if (p.seat === from) return { ...p, discards: p.discards.map((d, i) => (i === p.discards.length - 1 ? { ...d, claimed: true } : d)) };
      return p;
    })
  };
}

const evOf = (view, hand) => { const v = handValue(evContext(view), hand); return v ? v.ev : undefined; };

/* 别人打出一张牌时：不动、碰（碰后打出期望得分最高的一张）、明杠（含杠钱）各自的期望得分 */
export function claimEV(view) {
  const me = meOf(view);
  const tile = view.claim.tile;
  const out = { pass: evOf(view, me.hand) };
  if (view.actions.some(a => a.type === 'pong')) {
    const hand = me.hand.slice();
    hand.splice(hand.indexOf(tile), 1); hand.splice(hand.indexOf(tile), 1);
    const ctx = evContext(claimedView(view, hand, { kind: 'pong', tile }));
    for (const t of new Set(discardPool(hand, me.voidSuit))) {
      const h = hand.slice(); h.splice(h.indexOf(t), 1);
      const v = handValue(ctx, h);
      if (v && (!out.pong || v.ev > out.pong.ev)) out.pong = { ev: v.ev, discard: t };
    }
  }
  if (view.actions.some(a => a.type === 'minggang')) {
    const hand = me.hand.filter(t => t !== tile);
    const v = evOf(claimedView(view, hand, { kind: 'gang', tile, gangType: 'ming' }), hand);
    if (v !== undefined) out.minggang = v + gangIncome(view, 'ming');
  }
  return out;
}

/* 自己回合的暗杠 / 补杠：杠后（等补摸）的期望得分 + 杠钱；算不出时返回 undefined */
export function turnGangEV(view, act) {
  const { hand, fakeView } = turnGangView(view, act);
  const v = evOf(fakeView, hand);
  return v === undefined ? undefined : v + gangIncome(view, act.type === 'angang' ? 'an' : 'bu');
}

/* 自己回合的杠：暗杠 / 补杠后的牌效 vs 不杠时的最佳打法 */
export function evaluateTurnGang(view, act) {
  const { hand, fakeView } = turnGangView(view, act);
  return handEfficiency(fakeView, hand);
}

function turnGangView(view, act) {
  const me = meOf(view);
  const hand = act.type === 'angang' ? me.hand.filter(t => t !== act.tile) : me.hand.filter((t, i) => i !== me.hand.indexOf(act.tile));
  const fakeView = act.type === 'angang' ? withMeld(view, hand, { kind: 'gang', tile: act.tile, gangType: 'an' })
    : { ...view, players: view.players.map(p => p.seat === view.seat ? { ...p, hand, melds: p.melds.map(m => m.tile === act.tile ? { ...m, kind: 'gang', gangType: 'bu' } : m) } : p) };
  return { hand, fakeView };
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
  // 威胁 / 危险度显示用学习模型（测试集上比启发式准，见 README）；启发式的理由保留作说明
  const threats = learnedThreats(view);
  const heur = allThreats(view);
  for (const p of view.players) {
    if (p.seat === view.seat) continue;
    const t = threats[p.seat];
    const reasons = p.won ? t.reasons : [...t.reasons, ...heur[p.seat].reasons];
    out.opponents.push({
      seat: p.seat, voidSuit: p.voidSuit, won: p.won ? { fan: p.won.fan, zimo: p.won.zimo } : null,
      melds: p.melds.map(m => ({ kind: m.kind, tile: m.tile })),
      discards: p.discards.filter(d => !d.claimed).map(d => d.tile),
      draws: p.draws, score: p.score,
      threat: +t.threat.toFixed(2), voidCleared: t.voidCleared, suspectSuit: t.suspectSuit, reasons
    });
  }

  if (view.phase === 'turn' && view.turn === view.seat && view.actions.some(a => a.type === 'discard')) {
    // 排序与高手电脑同口径（不含防守项）；攻守判断只作为提示
    const ev = evaluateDiscards(view, { defense: false, dangerModel: 'learned', ev: true });
    const st = stanceOf(Math.min(...ev.rows.map(r => r.shanten)), ev.threats, view.wallCount);
    out.stance = st.stance;
    out.maxThreat = +st.maxThreat.toFixed(2);
    if (ev.rows[0].ev === undefined) {   // 与高手电脑一致：期望得分已含好形和打点，只在更远的局面用前瞻和清一色倾向
      refineByLookahead(view, ev.rows);
      const q = withQingBias(ev.rows, me);
      if (q !== ev.rows[0]) { ev.rows.splice(ev.rows.indexOf(q), 1); ev.rows.unshift(q); q.qingBias = true; }
    }
    out.candidates = ev.rows.map((r, i) => ({ id: `c${i + 1}`, ...r }));
    attachMonteCarlo(view, out.candidates);
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
    if (st.stance === 'fold') out.alerts.push({ level: 'warn', code: 'fold', text: '对手可能已听牌、自己进度慢（估计）。复式自对弈里弃和没有被证实有收益，危险度列仅供参考' });
  } else if ((view.phase === 'claim' || view.phase === 'robGang') && view.actions.length) {
    out.claim = evaluateClaim(view, { ev: true });
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

/* 蒙特卡洛估计（只作参考，不改变排序：复式自对弈里用它改选没有显著收益，见 README）。
   一向听以内、向听最小的前 4 名各模拟 96 次；种子由局面决定，同一局面结果稳定 */
function attachMonteCarlo(view, cands) {
  const me = meOf(view);
  if (!cands.length || me.hand.some(t => suitOf(t) === me.voidSuit)) return;
  const bestSh = Math.min(...cands.map(c => c.shanten));
  if (bestSh > 1) return;
  const pool = cands.filter(c => c.shanten === bestSh).slice(0, 4);
  const rng = { rng: seedFrom(`${view.seat}|${view.log.length}|${me.hand.join(',')}`) };
  const est = estimateDiscards(view, pool.map(c => c.tile), rng, { samples: 96 });
  for (const c of pool) c.mc = est[c.tile];
}

/* 是否值得提醒玩家点「AI 讲解」 */
export function isKeyMoment(analysis) {
  return analysis.alerts.some(a => a.level === 'key' || a.level === 'warn');
}
