import { createGame, submit, refreshTurn } from '../src/game/engine.mjs';

const SUIT = { m: 0, s: 1, p: 2 };

/* '123m 55s' → [0,1,2,13,13] */
export function tiles(str) {
  const out = [];
  for (const seg of str.replace(/\s+/g, '').match(/\d+[msp]/g) || []) {
    const base = SUIT[seg[seg.length - 1]] * 9;
    for (const d of seg.slice(0, -1)) out.push(base + (+d) - 1);
  }
  return out.sort((a, b) => a - b);
}

/* 跳过换三张/定缺，直接摆好四家手牌、副露和牌墙，从 turn 座位出牌开始 */
export function setup({ hands, voids, melds = [], wall = '', turn = 0, rules = {}, seed = 1 }) {
  const g = createGame({ seed, rules: { exchangeThree: false, ...rules } });
  for (let s = 0; s < 4; s++) submit(g, s, { type: 'void', suit: voids[s] });
  for (let s = 0; s < 4; s++) {
    g.players[s].hand = tiles(hands[s]);
    g.players[s].melds = (melds[s] || []).map(m => ({ ...m }));
  }
  g.wall = tiles(wall);
  g.turn = turn;
  g.ctx = { drawn: null };
  refreshTurn(g);
  return g;
}

/* 每种牌的总数应恒为 4 */
export function tileCensus(g) {
  const c = new Array(27).fill(0);
  for (const t of g.wall) c[t]++;
  for (const p of g.players) {
    for (const t of p.hand) c[t]++;
    for (const m of p.melds) c[m.tile] += m.kind === 'gang' ? 4 : 3;
    for (const d of p.discards) if (!d.claimed) c[d.tile]++;
  }
  return c;
}
