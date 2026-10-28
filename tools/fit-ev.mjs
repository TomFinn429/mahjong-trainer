/* 拟合 / 检验期望得分模型（src/ai/ev.mjs）
   用法：
     node tools/fit-ev.mjs fit   <牌谱.jsonl> [...]   从听牌局面拟合 P(和)、自摸占比、得分校准，写 src/ai/ev-weights.mjs
     node tools/fit-ev.mjs check <牌谱.jsonl> [...]   用留出牌谱检验：预测和牌率、预测得分与实际的分桶对比
                                                       （一向听每 --every 个样本取 1 个，默认 5，算得慢）
   选项：--live           读牌版：P(和) 多一个「待牌扣在对手暗手的比例」特征（infer.mjs），默认写 src/ai/ev-weights-live.mjs
         --out FILE       fit 时写到这个文件（离线比较用，不改动正式权重）
         --weights FILE   check 时用这个文件里的权重（导出 EV_WEIGHTS 或 EV_WEIGHTS_LIVE）
   取样同 tools/ev-stats.mjs：每次打牌之后的局面，缺门已打完；结果看这一家从这一刻到本局结束。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { replayRecord } from '../src/game/record.mjs';
import { viewFor } from '../src/game/engine.mjs';
import { shanten, toCounts, suitOf } from '../src/core/core.mjs';
import { evContext, tenpaiWaits, pHuFeatures, expectedGain, handValue, inHandsShare } from '../src/ai/ev.mjs';
import { logistic, ols, r4 } from './fit-lib.mjs';

const [mode, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
const every = +opt('--every', 5);
const live = rest.includes('--live');
const outFile = opt('--out', null);
const weightsFile = opt('--weights', null);
const files = rest.filter((x, i) => !x.startsWith('--') && !['--every', '--out', '--weights'].includes(rest[i - 1]));
const custom = weightsFile ? Object.values(await import(pathToFileURL(resolve(weightsFile)).href))[0] : null;
const ctxOf = view => evContext(view, { live, weights: custom || undefined });
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
        const s = take(ctxOf(viewFor(g, seat)), hand, sh);
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

if (mode === 'fit') {
  const { out, games } = collect((ctx, hand, sh) => {
    if (sh !== 0) return null;
    const raw = tenpaiWaits(ctx, toCounts(hand));
    const waits = raw.map(w => ({ remain: w.remain, ron: w.ron, zimo: w.zimo }));
    return { waits, R: waits.reduce((a, w) => a + w.remain, 0), wall: ctx.wall, active: ctx.active, inHands: live ? inHandsShare(ctx, raw) : undefined };
  });
  console.log(`牌谱 ${games} 局，听牌样本 ${out.length}`);
  const pz = {};
  for (const a of [2, 3, 4]) {
    const s = out.filter(x => x.active === a && x.hu);
    pz[a] = r4(s.reduce((acc, x) => acc + x.zimo, 0) / s.length);
  }
  const X = out.map(s => pHuFeatures(s.R, s.wall, s.active, s.inHands));
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
  const target = outFile ? resolve(outFile) : new URL(`../src/ai/${live ? 'ev-weights-live' : 'ev-weights'}.mjs`, import.meta.url);
  writeFileSync(target,
    `/* 由 tools/fit-ev.mjs 生成${live ? '（--live 读牌版）' : ''}，勿手改。训练牌谱：${files.join('、')}（${games} 局，听牌样本 ${out.length}） */\n` +
    `export const ${live ? 'EV_WEIGHTS_LIVE' : 'EV_WEIGHTS'} = ${JSON.stringify(W)};\n`);
  console.log(`已写出 ${target}`);
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
  const ll = -mean(t, x => (x.hu ? Math.log(Math.max(1e-9, x.pHu)) : Math.log(Math.max(1e-9, 1 - x.pHu))));
  console.log(`和牌率对数损失 ${ll.toFixed(4)}（越小越好）`);

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
