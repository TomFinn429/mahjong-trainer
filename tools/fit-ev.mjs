/* 拟合 / 检验期望得分模型（src/ai/ev.mjs）
   用法：
     node tools/fit-ev.mjs fit   <牌谱.jsonl> [...]   从听牌局面拟合 P(和)、自摸占比、得分校准，写 src/ai/ev-weights.mjs
     node tools/fit-ev.mjs check <牌谱.jsonl> [...]   用留出牌谱检验：预测和牌率、预测得分与实际的分桶对比
                                                       （一向听每 --every 个样本取 1 个，默认 5，算得慢）
   取样同 tools/ev-stats.mjs：每次打牌之后的局面，缺门已打完；结果看这一家从这一刻到本局结束。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { replayRecord } from '../src/game/record.mjs';
import { viewFor } from '../src/game/engine.mjs';
import { shanten, toCounts, suitOf } from '../src/core/core.mjs';
import { evContext, tenpaiWaits, pHuFeatures, expectedGain, handValue } from '../src/ai/ev.mjs';

const [mode, ...rest] = process.argv.slice(2);
const ei = rest.indexOf('--every');
const every = ei >= 0 ? +rest[ei + 1] : 5;
const files = rest.filter((x, i) => ei < 0 || (i !== ei && i !== ei + 1));
if (!['fit', 'check'].includes(mode) || !files.length) { console.error('用法：node tools/fit-ev.mjs fit|check <牌谱.jsonl> [...]'); process.exit(1); }

function* records() {
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) if (line.trim()) yield JSON.parse(line);
}

/* 收集样本：take(ctx, hand13, sh) 返回要保存的对象（或 null），结果字段在对局结束后补上 */
function collect(take) {
  const out = [];
  let games = 0, n1 = 0;
  for (const rec of records()) {
    games++;
    const states = [[], [], [], []];
    const g = replayRecord(rec, {
      onDecision({ g, seat, action }) {
        if (action.type !== 'discard') return;
        const p = g.players[seat];
        const hand = p.hand.slice(); hand.splice(hand.indexOf(action.tile), 1);
        if (hand.some(t => suitOf(t) === p.voidSuit)) return;
        const sh = shanten(toCounts(hand), p.melds.length);
        if (sh > 1) return;
        if (sh === 1 && n1++ % every) return;
        const s = take(evContext(viewFor(g, seat)), hand, sh);
        if (s) states[seat].push({ ...s, sh, score: p.score });
      }
    });
    for (let seat = 0; seat < 4; seat++) {
      const p = g.players[seat];
      for (const s of states[seat]) out.push({ ...s, hu: p.won ? 1 : 0, zimo: p.won && p.won.zimo ? 1 : 0, delta: p.score - s.score });
    }
  }
  return { out, games };
}

/* ---------- 小型线性代数 ---------- */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function logistic(X, y, iters = 25) {
  const d = X[0].length;
  let w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d }, () => new Array(d).fill(0)), gr = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const x = X[i], p = 1 / (1 + Math.exp(-x.reduce((a, xi, j) => a + xi * w[j], 0)));
      const s = p * (1 - p);
      for (let j = 0; j < d; j++) { gr[j] += (y[i] - p) * x[j]; for (let k = 0; k < d; k++) H[j][k] += s * x[j] * x[k]; }
    }
    for (let j = 0; j < d; j++) H[j][j] += 1e-6;
    const step = solve(H, gr);
    w = w.map((wj, j) => wj + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return w;
}

function ols(X, y) {
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0)), b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k]; }
  return solve(A, b);
}

const r4 = x => Math.round(x * 1e4) / 1e4;

if (mode === 'fit') {
  const { out, games } = collect((ctx, hand, sh) => {
    if (sh !== 0) return null;
    const waits = tenpaiWaits(ctx, toCounts(hand)).map(w => ({ remain: w.remain, ron: w.ron, zimo: w.zimo }));
    return { waits, R: waits.reduce((a, w) => a + w.remain, 0), wall: ctx.wall, active: ctx.active };
  });
  console.log(`牌谱 ${games} 局，听牌样本 ${out.length}`);
  const pz = {};
  for (const a of [2, 3, 4]) {
    const s = out.filter(x => x.active === a && x.hu);
    pz[a] = r4(s.reduce((acc, x) => acc + x.zimo, 0) / s.length);
  }
  const X = out.map(s => pHuFeatures(s.R, s.wall, s.active));
  const pHu = logistic(X, out.map(s => s.hu)).map(r4);
  const P = X.map(x => 1 / (1 + Math.exp(-x.reduce((a, xi, j) => a + xi * pHu[j], 0))));
  const G = out.map(s => expectedGain(s.waits, s.active, pz));
  const [a, b, c] = ols(out.map((s, i) => [P[i] * G[i], P[i], 1]), out.map(s => s.delta)).map(r4);
  const W = { pHu, pz, calib: { a, b, c } };
  // 第二段：用上面的权重算一向听的原始 V1，再线性校准到实际得分
  const one = collect((ctx, hand, sh) => {
    if (sh !== 1) return null;
    ctx.w = W;
    const v = handValue(ctx, hand);
    return v && { raw: v.raw };
  }).out.filter(s => s.sh === 1);
  const [a1, c1] = ols(one.map(s => [s.raw, 1]), one.map(s => s.delta)).map(r4);
  W.calib1 = { a: a1, c: c1 };
  console.log(`一向听样本 ${one.length}（每 ${every} 个取 1）`);
  console.log(JSON.stringify(W));
  writeFileSync(new URL('../src/ai/ev-weights.mjs', import.meta.url),
    `/* 由 tools/fit-ev.mjs 生成，勿手改。训练牌谱：${files.join('、')}（${games} 局，听牌样本 ${out.length}） */\n` +
    `export const EV_WEIGHTS = ${JSON.stringify(W)};\n`);
  console.log('已写出 src/ai/ev-weights.mjs');
} else {
  const t0 = performance.now();
  const { out, games } = collect((ctx, hand) => {
    const v = handValue(ctx, hand);
    return v && { ev: v.ev, pHu: v.pHu, pReach: v.pReach };
  });
  const ms = performance.now() - t0;
  const pct = x => (100 * x).toFixed(1) + '%';
  const deciles = (arr, key) => {
    const s = arr.slice().sort((x, y) => x[key] - y[key]);
    return Array.from({ length: 10 }, (_, i) => s.slice(Math.floor(i * s.length / 10), Math.floor((i + 1) * s.length / 10)));
  };
  const mean = (arr, f) => arr.reduce((a, x) => a + f(x), 0) / arr.length;
  console.log(`牌谱 ${games} 局；听牌样本 ${out.filter(s => s.sh === 0).length}，一向听样本 ${out.filter(s => s.sh === 1).length}（每 ${every} 个取 1）；总耗时 ${(ms / 1000).toFixed(1)} s`);

  const t = out.filter(s => s.sh === 0);
  console.log('\n### 听牌：预测和牌率 vs 实际（按预测值十等分）\n\n| 分桶 | 样本 | 预测 | 实际 | 差 |\n|---|---|---|---|---|');
  let worst = 0;
  deciles(t, 'pHu').forEach((b, i) => {
    const p = mean(b, x => x.pHu), y = mean(b, x => x.hu);
    worst = Math.max(worst, Math.abs(p - y));
    console.log(`| ${i + 1} | ${b.length} | ${pct(p)} | ${pct(y)} | ${((p - y) * 100).toFixed(1)} |`);
  });
  console.log(`\n最大偏差 ${(worst * 100).toFixed(1)} 个百分点（验收：≤ 5）`);

  for (const [name, sh] of [['听牌', 0], ['一向听', 1]]) {
    const s = out.filter(x => x.sh === sh);
    console.log(`\n### ${name}：预测本局剩余得分 vs 实际（按预测值十等分）\n\n| 分桶 | 样本 | 预测 | 实际 |\n|---|---|---|---|`);
    deciles(s, 'ev').forEach((b, i) => console.log(`| ${i + 1} | ${b.length} | ${mean(b, x => x.ev).toFixed(2)} | ${mean(b, x => x.delta).toFixed(2)} |`));
    const my = mean(s, x => x.delta), mp = mean(s, x => x.ev);
    const cov = mean(s, x => (x.ev - mp) * (x.delta - my));
    const sd = f => Math.sqrt(mean(s, x => f(x) ** 2) - mean(s, f) ** 2);
    console.log(`\n相关系数 ${(cov / (sd(x => x.ev) * sd(x => x.delta))).toFixed(3)}，平均预测 ${mp.toFixed(2)}，平均实际 ${my.toFixed(2)}`);
  }
}
