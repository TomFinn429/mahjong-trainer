/* ============================================================
   电脑对手：1 入门 / 2 进阶 / 3 高手
   只读 viewFor() 的可见信息，返回一个合法动作
   ============================================================ */
import { shanten, toCounts, suitOf, voidEval, ukeire } from '../core/core.mjs';
import { pending, submit, viewFor } from '../game/engine.mjs';
import { nextRand, randInt } from '../game/rng.mjs';
import { evaluateDiscards, evaluateClaim, evaluateTurnGang, refineByLookahead } from './analyzer.mjs';

export const LEVEL_NAME = { 1: '入门', 2: '进阶', 3: '高手' };

export function createBot(level, seed, opts) {
  return { level, rng: (seed >>> 0) || 1, opts: { defense: true, balance: true, qing: true, pongEqual: true, lookahead: true, ...(opts || {}) } };
}

export function decide(bot, view) {
  const acts = view.actions;
  if (!acts.length) return null;
  const me = view.players[view.seat];
  const has = t => acts.find(a => a.type === t);

  switch (acts[0].type) {
    case 'exchange': return chooseExchange(bot, me.hand);
    case 'void': return { type: 'void', suit: bot.level === 1 ? fewestSuit(me.hand) : voidEval(me.hand)[0].suit };
  }

  if (view.phase === 'robGang') return has('hu') || has('pass');

  if (view.phase === 'claim') {
    if (has('hu')) return has('hu');
    if (bot.level === 1) return has('minggang') || has('pong') || has('pass');
    const ev = evaluateClaim(view);
    const b = ev.before;
    const g = ev.options.minggang;
    if (g && g.shanten <= b.shanten) return has('minggang');
    const p = ev.options.pong;
    if (p) {
      if (p.shanten < b.shanten) return has('pong');
      // 高手：向听不变但手里对子多，碰了走对对胡
      if (bot.level === 3 && bot.opts.pongEqual && p.shanten === b.shanten && pairCount(me.hand) >= 4) return has('pong');
    }
    return has('pass');
  }

  // 自己回合
  if (has('hu')) return has('hu');
  const ev = evaluateDiscards(view, { defense: bot.level === 3 && bot.opts.defense, balance: bot.opts.balance });
  const rows = ev.rows;
  if (bot.level === 3 && bot.opts.lookahead) refineByLookahead(view, rows);
  for (const a of acts.filter(a => a.type === 'angang' || a.type === 'bugang')) {
    if (bot.level === 1) return a;
    const e = evaluateTurnGang(view, a);
    const bestSh = Math.min(...rows.map(r => r.shanten));
    if (e.shanten <= bestSh) return a;
  }
  let pick;
  if (bot.level === 1) {
    const minSh = Math.min(...rows.map(r => r.shanten));
    const pool = nextRand(bot) < 0.2 ? rows : rows.filter(r => r.shanten === minSh);
    pick = pool[randInt(bot, pool.length)];
  } else if (bot.level === 2) {
    pick = rows.slice().sort((a, b) => a.shanten - b.shanten || b.ukeireTotal - a.ukeireTotal || a.tile - b.tile)[0];
  } else {
    pick = bot.opts.qing ? withQingBias(rows, me) : rows[0];
  }
  return { type: 'discard', tile: pick.tile };
}

/* 高手：一门牌明显占优时倾向做清一色（2 番 = 4 倍），优先打掉另一门，只要向听不变差 */
function withQingBias(rows, me) {
  const n = [0, 1, 2].map(s => (s === me.voidSuit ? -1 : me.hand.filter(t => suitOf(t) === s).length + me.melds.filter(m => suitOf(m.tile) === s).length * 3));
  const major = n.indexOf(Math.max(...n));
  const minor = [0, 1, 2].find(s => s !== major && s !== me.voidSuit);
  if (minor === undefined || n[major] < 9 || me.melds.some(m => suitOf(m.tile) === minor)) return rows[0];
  const best = rows[0];
  const alt = rows.filter(r => suitOf(r.tile) === minor && r.shanten === best.shanten && r.score >= best.score - 8)[0];
  return alt || best;
}

function fewestSuit(hand) {
  const n = [0, 1, 2].map(s => hand.filter(t => suitOf(t) === s).length);
  return n.indexOf(Math.min(...n));
}

function pairCount(hand) {
  return toCounts(hand).filter(x => x >= 2).length;
}

/* 换三张：入门随便挑；进阶/高手挑张数最少（≥3）的一门，换出对剩余牌效影响最小的 3 张 */
function chooseExchange(bot, hand) {
  const suits = [0, 1, 2].filter(s => hand.filter(t => suitOf(t) === s).length >= 3);
  if (bot.level === 1) {
    const s = suits[randInt(bot, suits.length)];
    const pool = hand.filter(t => suitOf(t) === s);
    const out = [];
    while (out.length < 3) out.push(pool.splice(randInt(bot, pool.length), 1)[0]);
    return { type: 'exchange', tiles: out };
  }
  suits.sort((a, b) => hand.filter(t => suitOf(t) === a).length - hand.filter(t => suitOf(t) === b).length);
  const s = suits[0];
  const pool = hand.filter(t => suitOf(t) === s);
  let best = null;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
    const pick = [pool[i], pool[j], pool[k]];
    const rest = hand.slice();
    for (const t of pick) rest.splice(rest.indexOf(t), 1);
    const c = toCounts(rest);
    const sh = shanten(c, 0);
    const uk = ukeire(c, null, 0, null).total;
    if (!best || sh < best.sh || (sh === best.sh && uk > best.uk)) best = { pick, sh, uk };
  }
  return { type: 'exchange', tiles: best.pick };
}

/* 让电脑把能做的决定都做完；遇到人类座位需要决定或对局结束时返回 */
export function runBots(g, bots, opts = {}) {
  const events = [];
  let guard = 0;
  while (g.phase !== 'end') {
    const seats = Object.keys(pending(g).seats).map(Number);
    const botSeats = seats.filter(s => bots[s]);
    if (!botSeats.length) break;
    if (++guard > 5000) throw new Error('runBots 未收敛');
    for (const s of botSeats) {
      if (g.phase === 'end') break;
      if (!(s in pending(g).seats)) continue;
      const a = decide(bots[s], viewFor(g, s));
      events.push(...submit(g, s, a));
      if (opts.stepOnce) return events;
    }
  }
  return events;
}
