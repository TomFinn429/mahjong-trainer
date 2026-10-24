/* ============================================================
   电脑对手：1 入门 / 2 进阶 / 3 高手
   只读 viewFor() 的可见信息，返回一个合法动作
   ============================================================ */
import { shanten, toCounts, suitOf, voidEval, ukeire } from '../core/core.mjs';
import { pending, submit, viewFor } from '../game/engine.mjs';
import { nextRand, randInt } from '../game/rng.mjs';
import { evaluateDiscards, evaluateClaim, evaluateTurnGang, turnGangEV, refineByLookahead, withQingBias } from './analyzer.mjs';
import { refineByMonteCarlo } from './montecarlo.mjs';

export const LEVEL_NAME = { 1: '入门', 2: '进阶', 3: '高手' };

/* 对手池用的风格预设（都以高手为底，参数事先设定，不在评测种子上调）：
   createBot(3, seed, STYLES.defender) */
export const STYLES = Object.freeze({
  defender: { ev: false, defense: true, dangerModel: 'learned', lambda: { attack: 0, balance: 2, fold: 12 } },   // 防守型：对手可能听牌且自己慢就弃和
  bigHand: { ev: false, qingMin: 8, qingSlack: 25, pongEqual: true },                                           // 大牌型：清一色、对对胡倾向强
  speed: { ev: false, qing: false, pongMode: 'notWorse' }                                                       // 速度型：碰了不变差就碰，不做清一色
});

/* 高手默认策略来自复式自对弈（见 README「电脑难度实测」、docs/experiments.md）：
   听牌 / 一向听按期望得分（ev.mjs）选打，留出验证 +0.34 分/座/局；碰杠也按期望得分（evClaim），对多样对手 +0.15；
   更远的局面用一步前瞻 + 清一色倾向；
   危险度防守在当前对手池里没有收益，默认关闭。风格预设保持原打法（ev: false），让对手池有差异 */
export function createBot(level, seed, opts) {
  return { level, rng: (seed >>> 0) || 1, opts: { defense: false, balance: true, qing: true, pongEqual: false, lookahead: true, mc: false, ev: true, evClaim: true, ...(opts || {}) } };
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
    const evClaim = bot.level === 3 && bot.opts.ev && bot.opts.evClaim;
    const ev = evaluateClaim(view, { ev: evClaim });
    // 期望得分：不动和至少一种副露都算得出时，直接取最大；否则退回下面的向听规则
    if (evClaim && ev.evPass !== undefined) {
      const opts = [['pass', ev.evPass], ['pong', ev.options.pong?.ev], ['minggang', ev.options.minggang?.ev]].filter(([t, v]) => v !== undefined && has(t));
      if (opts.length > 1) return has(opts.reduce((a, o) => (o[1] > a[1] ? o : a))[0]);
    }
    const b = ev.before;
    const g = ev.options.minggang;
    if (g && g.shanten <= b.shanten) return has('minggang');
    const p = ev.options.pong;
    if (p) {
      if (p.shanten < b.shanten) return has('pong');
      if (bot.opts.pongMode === 'notWorse' && p.shanten <= b.shanten) return has('pong');
      // 高手：向听不变但手里对子多，碰了走对对胡
      if (bot.level === 3 && bot.opts.pongEqual && p.shanten === b.shanten && pairCount(me.hand) >= 4) return has('pong');
    }
    return has('pass');
  }

  // 自己回合
  if (has('hu')) return has('hu');
  const ev = evaluateDiscards(view, { defense: bot.level === 3 && bot.opts.defense, balance: bot.opts.balance, dangerModel: bot.opts.dangerModel, lambda: bot.opts.lambda, ev: bot.level === 3 && bot.opts.ev });
  const rows = ev.rows;
  const byEV = rows[0].ev !== undefined;   // 期望得分已经包含好形和打点，不再叠加前瞻、蒙特卡洛和清一色倾向
  if (bot.level === 3 && bot.opts.lookahead && !byEV) refineByLookahead(view, rows);
  if (bot.level === 3 && bot.opts.mc && !byEV) refineByMonteCarlo(view, rows, bot, bot.opts.mcOpts);
  for (const a of acts.filter(a => a.type === 'angang' || a.type === 'bugang')) {
    if (bot.level === 1) return a;
    if (byEV && bot.opts.evClaim) {
      const ge = turnGangEV(view, a);
      if (ge !== undefined) { if (ge > rows[0].ev) return a; continue; }
    }
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
    pick = bot.opts.qing && !byEV ? withQingBias(rows, me, { minTiles: bot.opts.qingMin, slack: bot.opts.qingSlack }) : rows[0];
  }
  return { type: 'discard', tile: pick.tile };
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
