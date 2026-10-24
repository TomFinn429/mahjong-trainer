import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, viewFor, submit } from '../src/game/engine.mjs';
import { visibleCounts } from '../src/ai/danger.mjs';
import { createBot, runBots } from '../src/ai/bots.mjs';
import { evaluateDiscards, analyze } from '../src/ai/analyzer.mjs';
import { estimateDiscards, refineByMonteCarlo } from '../src/ai/montecarlo.mjs';
import { setup, tiles } from './helpers.mjs';

const P = 2;
const WALL = Array.from({ length: 60 }, (_, i) => '123456789'[i % 9] + 'msp'[i % 3]).join(' ');

test('蒙特卡洛：同一随机数状态结果完全相同', () => {
  const g = setup({ hands: ['123m 456m 789m 5s 6s 7s 8s 8s', '1p', '2p', '3p'], voids: [P, 0, 0, 0], wall: WALL });
  const v = viewFor(g, 0);
  const a = estimateDiscards(v, tiles('1m 9m 7s'), { rng: 3 }, { samples: 40 });
  const b = estimateDiscards(v, tiles('1m 9m 7s'), { rng: 3 }, { samples: 40 });
  assert.deepEqual(a, b);
});

test('蒙特卡洛：听牌的打法比一向听的和牌率高', () => {
  // 打 9s 听 3s 6s（两面）；打 4s 只剩一向听
  const g = setup({ hands: ['123m 456m 789m 22s 45s 9s', '1p', '2p', '3p'], voids: [P, 0, 0, 0], wall: WALL });
  g.wall = g.wall.slice(0, 40);
  const nine = tiles('9s')[0], four = tiles('4s')[0];
  const e = estimateDiscards(viewFor(g, 0), [nine, four], { rng: 11 }, { samples: 300 });
  assert.ok(e[nine].winRate > e[four].winRate, JSON.stringify(e));
});

test('蒙特卡洛：只重排向听最小的前几名，其余行不动；全是缺门牌时不模拟', () => {
  const g = setup({ hands: ['111m 456m 789m 2s 4s 6s 7s 8s', '1p', '2p', '3p'], voids: [P, 0, 0, 0], wall: WALL });
  const v = viewFor(g, 0);
  const rows = evaluateDiscards(v, { defense: false }).rows;
  const bestSh = Math.min(...rows.map(r => r.shanten));
  const tail = rows.filter(r => r.shanten !== bestSh).map(r => r.tile);
  refineByMonteCarlo(v, rows, { rng: 1 }, { samples: 30 });
  assert.deepEqual(rows.filter(r => r.shanten !== bestSh).map(r => r.tile), tail);
  assert.ok(rows.filter(r => r.mc).every(r => r.shanten === bestSh));

  const g2 = setup({ hands: ['123m 456m 789m 22s 45s 1p 3p', '1s', '2s', '3s'], voids: [P, 0, 0, 0], wall: WALL });
  const rows2 = evaluateDiscards(viewFor(g2, 0), { defense: false }).rows;
  refineByMonteCarlo(viewFor(g2, 0), rows2, { rng: 1 });
  assert.ok(rows2.every(r => !r.mc));
});

test('分析器：附加模拟估计但不改变推荐', () => {
  const g = setup({ hands: ['123m 456m 789m 5s 6s 7s 8s 8s', '1p', '2p', '3p'], voids: [P, 0, 0, 0], wall: WALL });
  const a = analyze(viewFor(g, 0));
  assert.ok(a.candidates.some(c => c.mc && c.mc.winRate >= 0 && c.mc.winRate <= 1));
  assert.equal(a.recommend.tile, a.candidates[0].tile);
  const again = analyze(viewFor(g, 0));
  assert.deepEqual(again.candidates.map(c => c.mc), a.candidates.map(c => c.mc), '同一局面结果稳定');
});

test('开启蒙特卡洛的高手电脑：整局动作合法、分数零和', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const g = createGame({ seed: 600 + seed });
    runBots(g, [0, 1, 2, 3].map(i => createBot(3, seed + i, { mc: true, mcOpts: { samples: 16 } })));
    assert.equal(g.phase, 'end');
    assert.equal(g.result.scores.reduce((x, y) => x + y, 0), 0);
  }
});

test('看不见的牌：不含胡牌者暗手，自摸亮出的那张算作可见', () => {
  const g = setup({ hands: ['9m 111p 222p 333p 444p 6p', '123m 456s 789s 123s 5m', '34m 678s 678s 234s 99s', '666p 777p 888p 999p 7p'], voids: [1, P, P, 0], wall: '5m 5m' });
  submit(g, 0, { type: 'discard', tile: tiles('9m')[0] });
  submit(g, 1, { type: 'hu' });
  assert.ok(g.players[1].won.zimo);
  const v = viewFor(g, 0);
  assert.equal(v.players[1].hand, null);
  const vis = visibleCounts(v);
  assert.equal(vis[tiles('5m')[0]], 1, '只有自摸亮出的 5m 可见');
  assert.equal(vis[tiles('1m')[0]], 0, '胡牌者暗手里的 1m 不可见');
});
