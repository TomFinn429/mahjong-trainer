import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, viewFor, refreshTurn, submit, pending } from '../src/game/engine.mjs';
import { createBot, runBots, decide, STYLES } from '../src/ai/bots.mjs';
import { analyze, evaluateClaim } from '../src/ai/analyzer.mjs';
import { visibleCounts, opponentThreat, tileDangerVs } from '../src/ai/danger.mjs';
import { setup, tiles } from './helpers.mjs';

const M = 0, S = 1, P = 2;
const WALL40 = Array.from({ length: 40 }, (_, i) => '123456789'[i % 9] + 'ps'[i % 2]).join(' ');

test('三档电脑整局自动对战：动作都合法、对局能结束', () => {
  for (const level of [1, 2, 3]) {
    for (let seed = 1; seed <= 15; seed++) {
      const g = createGame({ seed: seed * 31 + level });
      runBots(g, [0, 1, 2, 3].map(i => createBot(level, seed + i)));
      assert.equal(g.phase, 'end');
      assert.equal(g.result.scores.reduce((a, b) => a + b, 0), 0);
    }
  }
});

/* 复式：同一副牌双方换座位各打一次，降低运气方差 */
function duplicate(A, B, seeds) {
  let sum = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    for (const lineup of [[A, B, A, B], [B, A, B, A]]) {
      const g = createGame({ seed: 9000 + seed, dealer: seed % 4 });
      runBots(g, lineup.map((l, i) => createBot(l, seed * 10 + i)));
      g.players.forEach((p, i) => { sum += (lineup[i] === A ? 1 : -1) * p.score; });
    }
  }
  return sum / (seeds * 4);
}

test('难度回归：进阶明显强于入门（复式 80 副牌）', () => {
  const adv = duplicate(2, 1, 80);
  assert.ok(adv > 0.4, `进阶相对入门每座每局优势 ${adv.toFixed(3)}`);
});

test('分析器：拆掉孤张而不是拆搭子', () => {
  // 123m 456m 789m 22s 45s + 孤张 9s：打 9s 听 36s
  const g = setup({ hands: ['123m 456m 789m 22s 45s 3p', '1p', '2p', '3p'], voids: [P, M, M, M], wall: '1s' });
  // 有缺门牌 3p 时只能打 3p
  let a = analyze(viewFor(g, 0));
  assert.deepEqual(a.candidates.map(c => c.tile), tiles('3p'));
  g.players[0].hand = tiles('123m 456m 789m 22s 45s 9s');
  refreshTurn(g);
  a = analyze(viewFor(g, 0));
  const best = a.candidates[0];
  assert.ok(best.shanten === 0, '打完应听牌');
  assert.equal(best.tile, tiles('9s')[0]);
  assert.deepEqual(best.waits.map(w => w.tile), tiles('3s 6s'));
  assert.ok(a.candidates[0].waits.length > 0);
  assert.ok(a.alerts.some(x => x.code === 'tenpai'));
});

test('危险度：对手缺门花色的牌对他绝对安全；已胡对手无威胁', () => {
  const g = setup({ hands: ['123m 456m 789m 22s 45s 9s', '1p', '2p', '3p'], voids: [P, M, S, M], wall: '1s' });
  for (const p of g.players) p.draws = 10;
  const view = viewFor(g, 0);
  const vis = visibleCounts(view);
  const opp1 = view.players[1];
  const th = opponentThreat(view, opp1);
  assert.equal(tileDangerVs(view, opp1, th, tiles('5m')[0], vis), 0, '下家缺万，万子对他安全');
  assert.ok(tileDangerVs(view, opp1, th, tiles('5s')[0], vis) >= 0);
  g.players[2].won = { order: 1, tile: 0, from: null, zimo: true, yaku: [], fan: 0, points: 1 };
  const v2 = viewFor(g, 0);
  assert.equal(opponentThreat(v2, v2.players[2]).threat, 0);
});

test('风格预设：防守型 / 大牌型 / 速度型整局动作合法、分数零和', () => {
  for (const style of Object.keys(STYLES)) {
    for (let seed = 1; seed <= 4; seed++) {
      const g = createGame({ seed: 880 + seed });
      runBots(g, [0, 1, 2, 3].map(i => createBot(3, seed + i, i % 2 ? STYLES[style] : undefined)));
      assert.equal(g.phase, 'end', style);
      assert.equal(g.result.scores.reduce((a, b) => a + b, 0), 0, style);
    }
  }
});

test('速度型：碰后向听不变也碰；按向听规则的高手不碰', () => {
  // 下家 11m 23m 56m 234s 678s 9s：一向听。碰 1m 后打 9s 仍是一向听
  const g = setup({ hands: ['1m 456m 789m 22s 456s 99s', '11m 23m 56m 234s 678s 9s', '1p', '2p'], voids: [P, P, M, M], wall: '3p 4p 5p' });
  submit(g, 0, { type: 'discard', tile: tiles('1m')[0] });
  assert.equal(g.phase, 'claim');
  assert.ok(pending(g).seats[1].some(a => a.type === 'pong'));
  const view = viewFor(g, 1);
  assert.equal(decide(createBot(3, 1, { evClaim: false }), view).type, 'pass');
  assert.equal(decide(createBot(3, 1, STYLES.speed), view).type, 'pong');
});

test('高手默认按期望得分决定碰不碰：选不动 / 碰中期望得分高的一个', () => {
  const g = setup({ hands: ['1m 456m 789m 22s 456s 99s', '11m 23m 56m 234s 678s 9s', '1p', '2p'], voids: [P, P, M, M], wall: WALL40 });
  submit(g, 0, { type: 'discard', tile: tiles('1m')[0] });
  const view = viewFor(g, 1);
  const ev = evaluateClaim(view, { ev: true });
  assert.ok(ev.evPass !== undefined && ev.options.pong.ev !== undefined);
  assert.equal(decide(createBot(3, 1), view).type, ev.options.pong.ev > ev.evPass ? 'pong' : 'pass');
});
