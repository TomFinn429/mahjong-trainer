/* ============================================================
   血战到底对局引擎
   - 状态是纯数据（可 JSON 序列化），随机数状态也在里面：同种子 + 同决策序列 = 同一局
   - 推进方式：pending(g) 看谁要做决定 → submit(g, seat, action) 提交 → 齐了自动推进
   - 所有变化写入 g.log 事件流；viewFor(g, seat) 只给出该座位可见的信息
   - 每个提交的决定按顺序写入 g.history：种子 + 规则 + history 就能完整重放（牌谱见 record.mjs）
   牌编号：0-8 万 / 9-17 条 / 18-26 筒（与 mj-core 一致）
   ============================================================ */
import { isWinHand, detectYaku, scoreYaku, shanten, toCounts, suitOf } from '../core/core.mjs';
import { makeRules } from './rules.mjs';
import { randInt, shuffleInPlace, seedFrom } from './rng.mjs';

export const SEATS = 4;
const next = s => (s + 1) % SEATS;
const sortTiles = a => a.sort((x, y) => x - y);

/* ---------- 创建 ---------- */
export function createGame(opts = {}) {
  const rules = makeRules(opts.rules);
  const seed = seedFrom(opts.seed);
  const g = {
    rules, seed, rng: seed,
    dealer: opts.dealer ?? 0,
    wall: [],
    players: [],
    phase: 'exchange',
    turn: null,            // 当前该打牌的座位
    ctx: {},               // 当前回合的标记：drawn / gangDraw / afterPong / afterGang
    claim: null,           // { tile, from, afterGang } 等待响应的打出牌
    rob: null,             // { tile, seat } 等待抢杠
    waiting: {},           // seat -> 合法动作列表
    decisions: {},         // seat -> 已提交的动作
    gangs: [],             // 杠的收入记录（退税 / 呼叫转移用）
    winCount: 0,
    firstRound: true,      // 地胡判定：还没有任何人碰杠（配合「闲家第一次摸牌」）
    log: [],
    history: [],           // 按提交顺序的决定 { seq, phase, seat, action }，seq = 提交时的事件数
    result: null
  };
  for (let s = 0; s < SEATS; s++) {
    g.players.push({ seat: s, hand: [], melds: [], discards: [], voidSuit: null, won: null,
      score: 0, huLock: false, draws: 0, exchange: null });
  }
  for (let k = 0; k < 27; k++) for (let i = 0; i < 4; i++) g.wall.push(k);
  shuffleInPlace(g, g.wall);
  for (let s = 0; s < SEATS; s++) {
    const p = g.players[(g.dealer + s) % SEATS];
    p.hand = sortTiles(g.wall.splice(0, s === 0 ? 14 : 13));
  }
  emit(g, { type: 'start', dealer: g.dealer, seed });
  if (rules.exchangeThree) {
    g.phase = 'exchange';
    for (let s = 0; s < SEATS; s++) g.waiting[s] = [{ type: 'exchange' }];
  } else enterVoid(g);
  return g;
}

/* ---------- 对外接口 ---------- */
export function pending(g) {
  const seats = {};
  for (const s of Object.keys(g.waiting)) if (!(s in g.decisions)) seats[s] = g.waiting[s];
  return { phase: g.phase, seats };
}

export function legalActions(g, seat) {
  return (seat in g.waiting && !(seat in g.decisions)) ? g.waiting[seat] : [];
}

export function submit(g, seat, action) {
  if (g.phase === 'end') throw new Error('对局已结束');
  const legal = legalActions(g, seat);
  if (!legal.length) throw new Error(`座位 ${seat} 当前无需决策`);
  validate(g, seat, action, legal);
  g.decisions[seat] = action;
  const mark = g.log.length;
  g.history.push({ seq: mark, phase: g.phase, seat, action: JSON.parse(JSON.stringify(action)) });
  if (Object.keys(g.waiting).every(s => s in g.decisions)) resolve(g);
  return g.log.slice(mark);
}

/* 某座位可见的信息（电脑和分析器只用这个） */
export function viewFor(g, seat) {
  const voidKnown = g.phase !== 'exchange' && g.phase !== 'void';
  return {
    seat, phase: g.phase, rules: g.rules, dealer: g.dealer, turn: g.turn,
    wallCount: g.wall.length,
    claim: g.claim ? { tile: g.claim.tile, from: g.claim.from } : null,
    rob: g.rob ? { ...g.rob } : null,
    players: g.players.map(p => ({
      seat: p.seat,
      hand: p.seat === seat ? p.hand.slice() : null,   // 胡牌者手牌扣着不亮，局终才摊牌
      handCount: p.hand.length,
      melds: p.melds.map(m => ({ ...m })),
      discards: p.discards.map(d => ({ ...d })),
      voidSuit: (p.seat === seat || voidKnown) ? p.voidSuit : null,
      won: p.won ? { ...p.won } : null,
      score: p.score,
      draws: p.draws
    })),
    drawn: g.turn === seat ? g.ctx.drawn ?? null : null,
    actions: legalActions(g, seat),
    log: g.log.map(e => maskEvent(e, seat)),
    result: g.result
  };
}

export function activeSeats(g) {
  return g.players.filter(p => !p.won).map(p => p.seat);
}

/* ---------- 校验 ---------- */
function sameAction(a, b) {
  return a.type === b.type && (a.tile === undefined || a.tile === b.tile) && (a.suit === undefined || a.suit === b.suit);
}

function validate(g, seat, action, legal) {
  if (!action || typeof action.type !== 'string') throw new Error('动作格式错误');
  if (action.type === 'exchange') {
    const tiles = action.tiles;
    if (!Array.isArray(tiles) || tiles.length !== 3) throw new Error('换三张需要选 3 张');
    if (new Set(tiles.map(suitOf)).size !== 1) throw new Error('换三张必须同一花色');
    const c = toCounts(g.players[seat].hand);
    for (const t of tiles) if (--c[t] < 0) throw new Error('换出的牌不在手里');
    return;
  }
  if (!legal.some(l => sameAction(l, action) && sameAction(action, l))) {
    throw new Error(`非法动作：${JSON.stringify(action)}`);
  }
}

/* ---------- 推进 ---------- */
function resolve(g) {
  const d = g.decisions;
  g.waiting = {}; g.decisions = {};
  switch (g.phase) {
    case 'exchange': return resolveExchange(g, d);
    case 'void': return resolveVoid(g, d);
    case 'turn': return resolveTurn(g, g.turn, d[g.turn]);
    case 'claim': return resolveClaim(g, d);
    case 'robGang': return resolveRob(g, d);
  }
}

function resolveExchange(g, d) {
  const dir = randInt(g, 3);             // 0 给下家，1 给上家，2 给对家
  const shift = [1, 3, 2][dir];
  const out = [];
  for (let s = 0; s < SEATS; s++) {
    const p = g.players[s];
    for (const t of d[s].tiles) p.hand.splice(p.hand.indexOf(t), 1);
    out[s] = d[s].tiles.slice();
  }
  for (let s = 0; s < SEATS; s++) {
    const from = (s - shift + SEATS) % SEATS;
    const p = g.players[s];
    p.hand.push(...out[from]); sortTiles(p.hand);
    p.exchange = { gave: out[s], got: out[from], from };
  }
  emit(g, { type: 'exchange', dir: ['next', 'prev', 'opposite'][dir], hidden: out.map((t, s) => ({ seat: s, gave: t, got: out[(s - shift + SEATS) % SEATS] })) });
  enterVoid(g);
}

function enterVoid(g) {
  g.phase = 'void';
  for (let s = 0; s < SEATS; s++) g.waiting[s] = [0, 1, 2].map(suit => ({ type: 'void', suit }));
}

function resolveVoid(g, d) {
  for (let s = 0; s < SEATS; s++) g.players[s].voidSuit = d[s].suit;
  emit(g, { type: 'void', suits: g.players.map(p => p.voidSuit) });
  g.turn = g.dealer;
  g.ctx = { drawn: null, tianHuChance: true };
  enterTurn(g);
}

/* 摸牌（牌墙空则流局） */
function draw(g, seat, gangDraw) {
  if (!g.wall.length) return finish(g, 'wall');
  const p = g.players[seat];
  const tile = g.wall.shift();
  p.hand.push(tile); sortTiles(p.hand);
  p.draws++;
  p.huLock = false;
  g.turn = seat;
  g.ctx = { drawn: tile, gangDraw: !!gangDraw, haiDi: g.wall.length === 0 };
  emit(g, { type: 'draw', seat, tile, gangDraw: !!gangDraw, wallCount: g.wall.length });
  enterTurn(g);
}

function enterTurn(g) {
  g.phase = 'turn';
  g.claim = null; g.rob = null;
  g.waiting = { [g.turn]: turnActions(g, g.turn) };
}

function hasVoid(p) {
  return p.voidSuit !== null && p.hand.some(t => suitOf(t) === p.voidSuit);
}

function turnActions(g, seat) {
  const p = g.players[seat];
  const acts = [];
  const counts = toCounts(p.hand);
  if (!g.ctx.afterPong && !hasVoid(p) && isWinHand(counts, p.melds.length)) acts.push({ type: 'hu' });
  if (g.wall.length) {
    for (let k = 0; k < 27; k++) {
      if (suitOf(k) === p.voidSuit) continue;
      if (counts[k] === 4) acts.push({ type: 'angang', tile: k });
      if (counts[k] >= 1 && p.melds.some(m => m.kind === 'pong' && m.tile === k)) acts.push({ type: 'bugang', tile: k });
    }
  }
  const voidTiles = p.hand.filter(t => suitOf(t) === p.voidSuit);
  const pool = voidTiles.length ? voidTiles : p.hand;
  for (const k of [...new Set(pool)]) acts.push({ type: 'discard', tile: k });
  return acts;
}

function resolveTurn(g, seat, act) {
  const p = g.players[seat];
  if (act.type === 'hu') {
    const tile = g.ctx.drawn ?? p.hand[p.hand.length - 1];
    const ctx = {
      zimo: true,
      gangShangHua: !!g.ctx.gangDraw,
      haiDi: !!g.ctx.haiDi,
      tianHu: !!g.ctx.tianHuChance && seat === g.dealer,
      diHu: g.firstRound && seat !== g.dealer && p.draws === 1
    };
    win(g, seat, tile, null, ctx);
    return afterWins(g, [seat], seat);
  }
  if (act.type === 'angang') {
    removeN(p.hand, act.tile, 4);
    p.melds.push({ kind: 'gang', tile: act.tile, gangType: 'an', from: seat });
    g.firstRound = false;
    emit(g, { type: 'gang', seat, tile: act.tile, gangType: 'an' });
    payGang(g, seat, 'an', null);
    return draw(g, seat, true);
  }
  if (act.type === 'bugang') {
    const robbers = g.rules.robGang ? activeSeats(g).filter(s => s !== seat && canHuOn(g, s, act.tile)) : [];
    if (robbers.length) {
      g.phase = 'robGang';
      g.rob = { tile: act.tile, seat };
      for (const s of robbers) g.waiting[s] = [{ type: 'hu' }, { type: 'pass' }];
      emit(g, { type: 'bugangDeclare', seat, tile: act.tile });
      return;
    }
    return completeBugang(g, seat, act.tile);
  }
  // discard
  removeN(p.hand, act.tile, 1);
  p.discards.push({ tile: act.tile, claimed: false });
  const afterGang = g.ctx.gangDraw ? g.gangs[g.gangs.length - 1] : null;
  emit(g, { type: 'discard', seat, tile: act.tile, afterGang: !!afterGang });
  openClaim(g, seat, act.tile, afterGang);
}

function completeBugang(g, seat, tile) {
  const p = g.players[seat];
  removeN(p.hand, tile, 1);
  const m = p.melds.find(x => x.kind === 'pong' && x.tile === tile);
  m.kind = 'gang'; m.gangType = 'bu';
  g.firstRound = false;
  emit(g, { type: 'gang', seat, tile, gangType: 'bu' });
  payGang(g, seat, 'bu', null);
  return draw(g, seat, true);
}

function canHuOn(g, seat, tile) {
  const p = g.players[seat];
  if (p.won || p.huLock || hasVoid(p) || suitOf(tile) === p.voidSuit) return false;
  const c = toCounts(p.hand); c[tile]++;
  return isWinHand(c, p.melds.length);
}

function openClaim(g, from, tile, afterGang) {
  g.phase = 'claim';
  g.claim = { tile, from, afterGang: afterGang ? g.gangs.indexOf(afterGang) : -1 };
  g.turn = null;
  for (const s of activeSeats(g)) {
    if (s === from) continue;
    const p = g.players[s];
    const acts = [];
    if (canHuOn(g, s, tile)) acts.push({ type: 'hu' });
    const n = p.hand.filter(t => t === tile).length;
    if (suitOf(tile) !== p.voidSuit) {
      if (n >= 2) acts.push({ type: 'pong' });
      if (n >= 3 && g.wall.length) acts.push({ type: 'minggang' });
    }
    if (acts.length) { acts.push({ type: 'pass' }); g.waiting[s] = acts; }
  }
  if (!Object.keys(g.waiting).length) return draw(g, nextActive(g, from));
}

function resolveClaim(g, d) {
  const { tile, from } = g.claim;
  const discarder = g.players[from];
  // 有胡选项却没胡 → 过手胡锁定
  for (const s of Object.keys(d)) {
    if (d[s].type !== 'hu' && g.rules.passHuLock && canHuOn(g, +s, tile)) g.players[s].huLock = true;
  }
  const order = orderFrom(from).filter(s => d[s]);
  let hus = order.filter(s => d[s].type === 'hu');
  if (hus.length) {
    if (!g.rules.multiHu) hus = hus.slice(0, 1);
    discarder.discards[discarder.discards.length - 1].huBy = hus.slice();   // 牌留在牌河，标记被谁胡
    const gangRec = g.claim.afterGang >= 0 ? g.gangs[g.claim.afterGang] : null;
    hus.forEach((s, i) => {
      win(g, s, tile, from, { zimo: false, gangShangPao: !!gangRec, haiDi: g.wall.length === 0 });
      if (i === 0 && gangRec && g.rules.callTransfer && gangRec.total > 0) {
        transfer(g, gangRec.seat, s, gangRec.total, 'callTransfer');
        gangRec.transferred = true;
      }
    });
    return afterWins(g, hus, from);
  }
  const taker = order.find(s => d[s].type === 'minggang') ?? order.find(s => d[s].type === 'pong');
  if (taker !== undefined) {
    const p = g.players[taker];
    discarder.discards[discarder.discards.length - 1].claimed = true;
    g.firstRound = false;
    if (d[taker].type === 'minggang') {
      removeN(p.hand, tile, 3);
      p.melds.push({ kind: 'gang', tile, gangType: 'ming', from });
      emit(g, { type: 'gang', seat: taker, tile, gangType: 'ming', from });
      payGang(g, taker, 'ming', from);
      return draw(g, taker, true);
    }
    removeN(p.hand, tile, 2);
    p.melds.push({ kind: 'pong', tile, from });
    emit(g, { type: 'pong', seat: taker, tile, from });
    g.turn = taker;
    g.ctx = { drawn: null, afterPong: true };
    return enterTurn(g);
  }
  return draw(g, nextActive(g, from));
}

function resolveRob(g, d) {
  const { tile, seat } = g.rob;
  for (const s of Object.keys(d)) {
    if (d[s].type !== 'hu' && g.rules.passHuLock) g.players[s].huLock = true;
  }
  let hus = orderFrom(seat).filter(s => d[s] && d[s].type === 'hu');
  if (!hus.length) return completeBugang(g, seat, tile);
  if (!g.rules.multiHu) hus = hus.slice(0, 1);
  removeN(g.players[seat].hand, tile, 1);
  g.players[seat].discards.push({ tile, claimed: false, robbed: true, huBy: hus.slice() });
  emit(g, { type: 'robbed', seat, tile });
  for (const s of hus) win(g, s, tile, seat, { zimo: false, qiangGang: true });
  return afterWins(g, hus, seat);
}

/* ---------- 胡牌与计分 ---------- */
export function evalWin(rules, hand, melds, tile, ctx) {
  const counts = toCounts(hand);
  if (tile !== null && tile !== undefined && hand.length % 3 === 1) counts[tile]++;
  const yaku = detectYaku(counts, { melds: melds.map(m => ({ kind: m.kind, tile: m.tile })), ctx });
  return { yaku, scored: scoreYaku(yaku, rules.fan, rules.cap, rules.base) };
}

/* 自摸：胡的牌已在手里；点炮 / 抢杠：胡的牌留在出牌者那边（一炮多响时多家共用同一张），
   只记在 won.tile，计番时补上 */
function win(g, seat, tile, from, ctx) {
  const p = g.players[seat];
  const { yaku, scored } = evalWin(g.rules, p.hand, p.melds, from === null ? null : tile, ctx);
  const order = ++g.winCount;
  p.won = { order, tile, from, zimo: !!ctx.zimo, yaku, fan: scored.capped, rawFan: scored.raw, points: scored.points };
  emit(g, { type: 'hu', seat, tile, from, zimo: !!ctx.zimo, yaku, fan: scored.capped, points: scored.points, order });
  if (ctx.zimo) {
    for (const s of activeSeats(g)) if (s !== seat) transfer(g, s, seat, scored.points, 'zimo');
  } else {
    transfer(g, from, seat, scored.points, ctx.qiangGang ? 'qiangGang' : 'dianPao');
  }
}

function afterWins(g, winners, origin) {
  if (activeSeats(g).length <= 1) return finish(g, 'allWon');
  // 下一个摸牌的人：从出牌者往后数，最后一个胡牌者的下家（自摸时就是胡牌者下家）
  const order = orderFrom(origin);
  const last = winners.reduce((a, s) => (order.indexOf(s) > order.indexOf(a) ? s : a), winners[0]);
  return draw(g, nextActive(g, last));
}

function payGang(g, seat, gangType, from) {
  if (!g.rules.gangPay) return;
  const rec = { seat, gangType, paid: [], total: 0 };
  const unit = g.rules.base;
  if (gangType === 'ming') {
    rec.paid.push({ seat: from, amount: unit * g.rules.gangPayMing });
  } else {
    const per = unit * (gangType === 'an' ? g.rules.gangPayAn : g.rules.gangPayBu);
    for (const s of activeSeats(g)) if (s !== seat) rec.paid.push({ seat: s, amount: per });
  }
  for (const x of rec.paid) { transfer(g, x.seat, seat, x.amount, 'gang'); rec.total += x.amount; }
  g.gangs.push(rec);
}

function transfer(g, from, to, amount, reason) {
  if (!amount) return;
  g.players[from].score -= amount;
  g.players[to].score += amount;
  emit(g, { type: 'pay', from, to, amount, reason });
}

/* ---------- 结束与流局结算 ---------- */
function finish(g, why) {
  g.phase = 'end';
  g.turn = null; g.claim = null; g.rob = null; g.waiting = {}; g.decisions = {};
  const r = g.rules;
  const settle = [];
  if (why === 'wall') {
    const act = activeSeats(g);
    if (act.length >= 2) {
      const capFan = r.cap > 0 ? r.cap : 6;
      const huazhu = act.filter(s => hasVoid(g.players[s]));
      const ting = {};
      for (const s of act) if (!huazhu.includes(s)) ting[s] = bestWaitFan(g, s);
      if (r.checkHuazhu) {
        for (const h of huazhu) for (const s of act) {
          if (huazhu.includes(s)) continue;
          const amt = r.base * Math.pow(2, capFan);
          transfer(g, h, s, amt, 'huazhu'); settle.push({ type: 'huazhu', from: h, to: s, amount: amt });
        }
      }
      if (r.checkDajiao) {
        for (const s of act) {
          if (huazhu.includes(s) || ting[s] !== null) continue;
          for (const t of act) {
            if (ting[t] === null || ting[t] === undefined) continue;
            const amt = r.base * Math.pow(2, ting[t]);
            transfer(g, s, t, amt, 'dajiao'); settle.push({ type: 'dajiao', from: s, to: t, amount: amt, fan: ting[t] });
          }
        }
      }
      if (r.taxRefund) {
        for (const s of act) {
          if (ting[s] !== null && ting[s] !== undefined) continue;
          for (const rec of g.gangs) {
            if (rec.seat !== s || rec.transferred) continue;
            for (const x of rec.paid) { transfer(g, s, x.seat, x.amount, 'taxRefund'); settle.push({ type: 'taxRefund', from: s, to: x.seat, amount: x.amount }); }
          }
        }
      }
    }
  }
  g.result = {
    reason: why,
    scores: g.players.map(p => p.score),
    hands: g.players.map(p => p.hand.slice()),
    winners: g.players.filter(p => p.won).sort((a, b) => a.won.order - b.won.order).map(p => p.seat),
    settle
  };
  emit(g, { type: 'end', reason: why, scores: g.result.scores });
}

/* 听牌时可能的最大番（不含自摸）；未听牌返回 null */
export function bestWaitFan(g, seat) {
  const p = g.players[seat];
  if (hasVoid(p)) return null;
  const counts = toCounts(p.hand);
  if (shanten(counts, p.melds.length) !== 0) return null;
  let best = null;
  for (let k = 0; k < 27; k++) {
    if (suitOf(k) === p.voidSuit || counts[k] >= 4) continue;
    const c = counts.slice(); c[k]++;
    if (!isWinHand(c, p.melds.length)) continue;
    const f = evalWin(g.rules, p.hand, p.melds, k, {}).scored.capped;
    if (best === null || f > best) best = f;
  }
  return best;
}

/* ---------- 工具 ---------- */
function orderFrom(from) {
  return [1, 2, 3].map(i => (from + i) % SEATS);
}

function nextActive(g, seat) {
  let s = next(seat);
  for (let i = 0; i < SEATS; i++, s = next(s)) if (!g.players[s].won) return s;
  return seat;
}

function removeN(hand, tile, n) {
  for (let i = 0; i < n; i++) {
    const idx = hand.indexOf(tile);
    if (idx < 0) throw new Error(`手里没有足够的 ${tile}`);
    hand.splice(idx, 1);
  }
}

function emit(g, e) {
  e.seq = g.log.length;
  g.log.push(e);
}

/* 隐藏别家的私密信息：别人摸到什么、换了哪三张 */
function maskEvent(e, seat) {
  if (e.type === 'draw' && e.seat !== seat) return { ...e, tile: null };
  if (e.type === 'exchange') {
    const mine = e.hidden.find(x => x.seat === seat);
    return { type: 'exchange', seq: e.seq, dir: e.dir, gave: mine ? mine.gave : null, got: mine ? mine.got : null };
  }
  return e;
}

/* 测试 / 复盘用：手工改了手牌或牌墙后，重新计算当前回合玩家的可选动作 */
export function refreshTurn(g) {
  g.phase = 'turn';
  g.waiting = { [g.turn]: turnActions(g, g.turn) };
  g.decisions = {};
}
