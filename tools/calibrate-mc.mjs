/* 校准蒙特卡洛前瞻的 ronFactor：
   自对弈若干局 → 用牌谱找出每家「第一次听牌」的那一手 → 比较实际和牌率与模拟预测。
   预测和实际最接近的 ronFactor 就是该对手池下的合理取值。

   用法：node tools/calibrate-mc.mjs [局数=300] [电脑配置 JSON='{"level":3}'] */
import { createGame, viewFor } from '../src/game/engine.mjs';
import { createBot, runBots } from '../src/ai/bots.mjs';
import { exportRecord, decisionSamples } from '../src/game/record.mjs';
import { estimateDiscards } from '../src/ai/montecarlo.mjs';
import { shanten, toCounts, suitOf } from '../src/core/core.mjs';

const games = +(process.argv[2] ?? 300);
const cfg = JSON.parse(process.argv[3] ?? '{"level":3}');
const FACTORS = [1, 0.6, 0.4, 0.3, 0.2, 0.1];

const points = [];   // { seat, won, est: { [factor]: winRate }, wall }
for (let seed = 1; seed <= games; seed++) {
  const g = createGame({ seed: 50000 + seed, dealer: seed % 4 });
  runBots(g, [0, 1, 2, 3].map(i => createBot(cfg.level, seed * 10 + i, cfg.opts)));
  const rec = exportRecord(g);
  const seen = new Set();
  for (const s of decisionSamples(rec)) {
    if (s.action.type !== 'discard' || seen.has(s.seat)) continue;
    const me = s.view.players[s.seat];
    const hand = me.hand.slice(); hand.splice(hand.indexOf(s.action.tile), 1);
    if (hand.some(t => suitOf(t) === me.voidSuit) || shanten(toCounts(hand), me.melds.length) !== 0) continue;
    seen.add(s.seat);
    const view = { ...s.view, rules: rec.rules };
    const est = {};
    for (const f of FACTORS) est[f] = estimateDiscards(view, [s.action.tile], { rng: seed * 7 + s.seat }, { samples: 64, ronFactor: f })[s.action.tile].winRate;
    points.push({ seat: s.seat, won: rec.result.winners.includes(s.seat), est, wall: s.view.wallCount });
  }
}

const n = points.length;
const actual = points.filter(p => p.won).length / n;
console.log(`对局 ${games}，首次听牌 ${n} 次，实际和牌率 ${(actual * 100).toFixed(1)}%`);
console.log('ronFactor  预测和牌率  平均偏差  Brier');
for (const f of FACTORS) {
  const pred = points.reduce((a, p) => a + p.est[f], 0) / n;
  const brier = points.reduce((a, p) => a + (p.est[f] - (p.won ? 1 : 0)) ** 2, 0) / n;
  console.log(`${String(f).padEnd(10)} ${(pred * 100).toFixed(1).padStart(8)}%  ${((pred - actual) * 100).toFixed(1).padStart(7)}%  ${brier.toFixed(4)}`);
}
console.log('\n按听牌时牌墙剩余分组（ronFactor 取 Brier 最小者）：');
const bestF = FACTORS.reduce((b, f) => {
  const s = x => points.reduce((a, p) => a + (p.est[x] - (p.won ? 1 : 0)) ** 2, 0);
  return s(f) < s(b) ? f : b;
}, FACTORS[0]);
for (const [lo, hi] of [[40, 99], [25, 39], [10, 24], [0, 9]]) {
  const grp = points.filter(p => p.wall >= lo && p.wall <= hi);
  if (!grp.length) continue;
  const a = grp.filter(p => p.won).length / grp.length;
  const pr = grp.reduce((x, p) => x + p.est[bestF], 0) / grp.length;
  console.log(`  牌墙 ${lo}–${hi}：${grp.length} 次，实际 ${(a * 100).toFixed(1)}%，预测 ${(pr * 100).toFixed(1)}%（ronFactor=${bestF}）`);
}
