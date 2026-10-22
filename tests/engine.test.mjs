import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, submit, pending, viewFor, legalActions } from '../src/game/engine.mjs';
import { suitOf } from '../src/core/core.mjs';
import { setup, tiles, tileCensus } from './helpers.mjs';

const M = 0, S = 1, P = 2;
const scores = g => g.players.map(p => p.score);

test('同一种子发出同样的牌', () => {
  const a = createGame({ seed: 42 }), b = createGame({ seed: 42 }), c = createGame({ seed: 43 });
  assert.deepEqual(a.players.map(p => p.hand), b.players.map(p => p.hand));
  assert.notDeepEqual(a.players.map(p => p.hand), c.players.map(p => p.hand));
  assert.equal(a.players[0].hand.length, 14);
  assert.equal(a.players[1].hand.length, 13);
  assert.equal(a.wall.length, 108 - 53);
});

test('换三张：三张同花色，按方向交给对应座位', () => {
  const g = createGame({ seed: 7 });
  const gave = [];
  for (let s = 0; s < 4; s++) {
    const h = g.players[s].hand;
    const suit = [0, 1, 2].find(x => h.filter(t => suitOf(t) === x).length >= 3);
    gave[s] = h.filter(t => suitOf(t) === suit).slice(0, 3);
    submit(g, s, { type: 'exchange', tiles: gave[s] });
  }
  assert.equal(g.phase, 'void');
  const shift = { next: 1, prev: 3, opposite: 2 }[g.log.find(e => e.type === 'exchange').dir];
  for (let s = 0; s < 4; s++) {
    assert.deepEqual(g.players[s].exchange.got, gave[(s - shift + 4) % 4]);
    assert.equal(g.players[s].hand.length, s === g.dealer ? 14 : 13);
  }
  // 别家看不到我换了什么
  const v = viewFor(g, 1).log.find(e => e.type === 'exchange');
  assert.ok(!('hidden' in v));
  assert.deepEqual(v.gave, gave[1]);
});

test('换三张拒绝不同花色', () => {
  const g = createGame({ seed: 7 });
  const h = g.players[0].hand;
  const mixed = [h.find(t => suitOf(t) === 0), h.find(t => suitOf(t) === 1), h.find(t => suitOf(t) === 2)];
  assert.throws(() => submit(g, 0, { type: 'exchange', tiles: mixed }), /同一花色/);
});

test('定缺：持有缺门牌时只能打缺门牌，且不能自摸', () => {
  const g = setup({
    hands: ['123m 456m 789m 11s 22s 3p', '1p', '2p', '3p'], voids: [P, M, M, M], wall: '9s'
  });
  const acts = legalActions(g, 0);
  assert.deepEqual(acts.map(a => a.type), ['discard']);
  assert.equal(acts[0].tile, tiles('3p')[0]);
});

test('点炮碰牌后不摸牌、不能胡，直接打牌', () => {
  const g = setup({
    hands: ['5m 111p 222p 333p 444p 5p', '55m 789s 123s 456s 99s', '11m 22m 33m 678s 678s 4s', '666p 777p 888p 999p 5p'],
    voids: [S, P, P, M], wall: '1s 2s 3s'
  });
  submit(g, 0, { type: 'discard', tile: tiles('5m')[0] });
  assert.deepEqual(Object.keys(pending(g).seats), ['1']);
  submit(g, 1, { type: 'pong' });
  assert.equal(g.turn, 1);
  assert.equal(g.players[1].hand.length, 11);
  assert.equal(g.wall.length, 3);
  assert.ok(legalActions(g, 1).every(a => a.type === 'discard'));
});

test('一炮多响：两家同时胡，点炮者分别赔付；血战继续', () => {
  const g = setup({
    hands: ['5m 111p 222p 333p 444p 5p', '123m 456s 789s 123s 5m', '34m 678s 678s 234s 99s', '666p 777p 888p 999p 5p'],
    voids: [S, P, P, M], wall: '9m 9m 8m'
  });
  const before = tileCensus(g);
  submit(g, 0, { type: 'discard', tile: tiles('5m')[0] });
  submit(g, 1, { type: 'hu' });
  submit(g, 2, { type: 'hu' });
  assert.deepEqual(scores(g), [-2, 1, 1, 0]);
  assert.equal(g.players[1].won.order, 1);
  assert.equal(g.players[2].won.order, 2);
  assert.equal(g.phase, 'turn');
  assert.equal(g.turn, 3, '最后一个胡牌者的下家摸牌');
  assert.deepEqual(tileCensus(g), before);
});

test('关闭一炮多响时只有离点炮者最近的一家胡', () => {
  const g = setup({
    hands: ['5m 111p 222p 333p 444p 5p', '123m 456s 789s 123s 5m', '34m 678s 678s 234s 99s', '666p 777p 888p 999p 5p'],
    voids: [S, P, P, M], wall: '9m', rules: { multiHu: false }
  });
  submit(g, 0, { type: 'discard', tile: tiles('5m')[0] });
  submit(g, 2, { type: 'hu' });
  submit(g, 1, { type: 'hu' });
  assert.ok(g.players[1].won && !g.players[2].won);
});

test('刮风下雨 + 呼叫转移：暗杠后打出的牌点炮，杠钱转给胡牌者', () => {
  const g = setup({
    hands: ['1111p 222p 333p 444p 5m', '123m 456s 789s 123s 5m', '11m 22m 33m 678s 678s 4s', '666p 777p 888p 999p 9s'],
    voids: [S, P, P, M], wall: '6p 7m 8m'
  });
  submit(g, 0, { type: 'angang', tile: tiles('1p')[0] });
  assert.deepEqual(scores(g), [6, -2, -2, -2]);
  assert.equal(g.ctx.gangDraw, true);
  submit(g, 0, { type: 'discard', tile: tiles('5m')[0] });
  submit(g, 1, { type: 'hu' });
  const won = g.players[1].won;
  assert.ok(won.yaku.some(y => y.key === 'gang_shang_pao'));
  // 杠上炮 1 番 = 2 分；呼叫转移 6 分
  assert.deepEqual(scores(g), [6 - 2 - 6, -2 + 2 + 6, -2, -2]);
  assert.ok(g.log.some(e => e.type === 'pay' && e.reason === 'callTransfer' && e.amount === 6));
});

test('直杠由点杠者付 2 分，杠后摸牌', () => {
  const g = setup({
    hands: ['5m 111p 222p 333p 444p 6p', '555m 789s 123s 456s 9s', '11m 22m 33m 678s 678s 4s', '666p 777p 888p 999p 7p'],
    voids: [S, P, P, M], wall: '1s 2s 3s 4s'
  });
  submit(g, 0, { type: 'discard', tile: tiles('5m')[0] });
  submit(g, 1, { type: 'minggang' });
  assert.deepEqual(scores(g), [-2, 2, 0, 0]);
  assert.equal(g.turn, 1);
  assert.equal(g.players[1].hand.length, 11);
});

test('抢杠胡：补杠的牌被抢，补杠作废，由补杠者赔付', () => {
  const g = setup({
    hands: ['5m 111p 222p 333p 6p', '123m 46m 789s 123s 99s', '11m 22m 33m 678s 678s 4s', '666p 777p 888p 999p 7p'],
    melds: [[{ kind: 'pong', tile: tiles('5m')[0], from: 2 }]],
    voids: [S, P, P, M], wall: '1s 2s'
  });
  const before = tileCensus(g);
  submit(g, 0, { type: 'bugang', tile: tiles('5m')[0] });
  assert.equal(g.phase, 'robGang');
  submit(g, 1, { type: 'hu' });
  assert.ok(g.players[1].won.yaku.some(y => y.key === 'qiang_gang'));
  assert.deepEqual(scores(g), [-2, 2, 0, 0]);
  assert.equal(g.players[0].melds[0].kind, 'pong', '补杠作废');
  assert.deepEqual(tileCensus(g), before);
});

test('过手胡：放弃点炮胡后，摸牌前不能再胡别人打的牌', () => {
  const g = setup({
    hands: ['5m 111p 222p 333p 444p 5p', '123m 456s 789s 123s 5m', '55m 11m 22m 678s 678s 4s', '666p 777p 888p 999p 8m'],
    voids: [S, P, P, M], wall: '1s 2s 3s 4s'
  });
  submit(g, 0, { type: 'discard', tile: tiles('5m')[0] });
  submit(g, 1, { type: 'pass' });
  submit(g, 2, { type: 'pong' });
  assert.equal(g.players[1].huLock, true);
  submit(g, 2, { type: 'discard', tile: tiles('4s')[0] });
  submit(g, 3, { type: 'discard', tile: tiles('8m')[0] });
  submit(g, 0, { type: 'discard', tile: tiles('2s')[0] });
  assert.equal(g.turn, 1);
  assert.equal(g.players[1].huLock, false, '自己摸牌后解锁');
});

test('流局：查花猪、查大叫、退税', () => {
  const g = setup({
    hands: ['147m 147s 258m 258s 3m 6m', '123m 456m 789m 123s 5s', '159m 159s 2468m 246s', '99m 99p 88p 77p 66p 55p 1s'],
    voids: [P, P, P, S], wall: ''
  });
  // 座位 2 有一个暗杠收入，未听牌应退税
  g.gangs.push({ seat: 2, gangType: 'an', paid: [{ seat: 0, amount: 2 }], total: 2 });
  submit(g, 0, { type: 'discard', tile: tiles('6m')[0] });
  assert.equal(g.phase, 'end');
  const st = g.result.settle;
  // 座位 3 留着缺门（条）→ 花猪，赔每家封顶 2^3 = 8
  assert.deepEqual(st.filter(x => x.type === 'huazhu').map(x => [x.from, x.to, x.amount]), [[3, 0, 8], [3, 1, 8], [3, 2, 8]]);
  // 座位 1 单钓 5 条，平胡 0 番 → 未听的 0、2 各赔 1
  assert.deepEqual(st.filter(x => x.type === 'dajiao').map(x => [x.from, x.to, x.amount]), [[0, 1, 1], [2, 1, 1]]);
  assert.deepEqual(st.filter(x => x.type === 'taxRefund').map(x => [x.from, x.to, x.amount]), [[2, 0, 2]]);
  assert.equal(scores(g).reduce((a, b) => a + b, 0), 0);
});

/* ---------- 随机整局：不变量 ---------- */
function autoPlay(seed, style) {
  const g = createGame({ seed });
  let guard = 0;
  while (g.phase !== 'end') {
    if (++guard > 2000) throw new Error('对局未结束');
    for (const [s, acts] of Object.entries(pending(g).seats)) {
      const seat = +s;
      if (g.phase === 'end') break;
      const p = g.players[seat];
      let a;
      if (acts[0].type === 'exchange') {
        const suit = [0, 1, 2].find(x => p.hand.filter(t => suitOf(t) === x).length >= 3);
        a = { type: 'exchange', tiles: p.hand.filter(t => suitOf(t) === suit).slice(0, 3) };
      } else if (acts[0].type === 'void') {
        const n = [0, 1, 2].map(x => p.hand.filter(t => suitOf(t) === x).length);
        a = { type: 'void', suit: n.indexOf(Math.min(...n)) };
      } else {
        const pick = t => acts.find(x => x.type === t);
        a = pick('hu') || (style % 2 ? pick('minggang') || pick('angang') || pick('bugang') || pick('pong') : null)
          || pick('pass') || acts[(seed + guard) % acts.length];
        if (a.type === 'hu' && style === 2 && pick('pass')) a = pick('pass');
      }
      submit(g, seat, a);
      const bad = tileCensus(g).some(x => x !== 4);
      if (bad) throw new Error(`牌数不守恒 seed=${seed} seq=${g.log.length}`);
    }
  }
  return g;
}

test('随机整局 300 局：牌数守恒、分数零和、正常结束', () => {
  let ended = { wall: 0, allWon: 0 }, hus = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const g = autoPlay(seed, seed % 3);
    assert.equal(scores(g).reduce((a, b) => a + b, 0), 0, `seed ${seed} 分数不为零和`);
    ended[g.result.reason]++;
    hus += g.result.winners.length;
    for (const p of g.players) if (p.won) assert.equal(p.hand.length % 3, p.won.zimo ? 2 : 1, '胡牌者手牌张数');
  }
  assert.ok(ended.wall > 0 && hus > 0, JSON.stringify({ ended, hus }));
});
