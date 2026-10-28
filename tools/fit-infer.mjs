/* 拟合 / 检验读牌模型（src/ai/infer.mjs，roadmap T13）
   用法：
     node tools/fit-infer.mjs fit   <牌谱.jsonl> [...] [--every N]   拟合四个模型，写 src/ai/infer-weights.mjs
     node tools/fit-infer.mjs check <牌谱.jsonl> [...] [--every N]   在留出牌谱上和朴素基线比较
   取样：每 N 个「打牌」决定取 1 个（默认 3），从打牌的人的视角看每个未胡对手；标签是那一刻对手真实的暗手（只在离线统计时用）。
   放炮损失的样本不抽样：每次点炮，取点炮那一手打牌时的视角，标签是付给胡牌者的分（不含呼叫转移）。
   同一局的样本之间不独立，表里的样本数不能直接当独立样本算置信区间。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { replayRecord } from '../src/game/record.mjs';
import { viewFor } from '../src/game/engine.mjs';
import { suitOf } from '../src/core/core.mjs';
import { suspectQing } from '../src/ai/danger.mjs';
import {
  suitRows, suitShares, tileRow, qingRow, lossRow, unseenCounts,
  SUIT_FEATURES, TILE_FEATURES, QING_FEATURES, LOSS_FEATURES, INFER_VERSION
} from '../src/ai/infer.mjs';
import { INFER_WEIGHTS } from '../src/ai/infer-weights.mjs';
import { logistic, poisson, condLogit, r4 } from './fit-lib.mjs';

const [mode, ...rest] = process.argv.slice(2);
const ei = rest.indexOf('--every');
const every = ei >= 0 ? +rest[ei + 1] : 3;
const files = rest.filter((x, i) => ei < 0 || (i !== ei && i !== ei + 1));
if (!['fit', 'check'].includes(mode) || !files.length) { console.error('用法：node tools/fit-infer.mjs fit|check <牌谱.jsonl> [...] [--every N]'); process.exit(1); }

function* records() {
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) if (line.trim()) yield JSON.parse(line);
}

const sigmoid = z => 1 / (1 + Math.exp(-z));
const dot = (w, x) => x.reduce((a, xi, i) => a + xi * w[i], 0);

/* 对手真实的花色张数 / 每种牌张数 / 是否在做清一色（暗手 + 副露，最多 1 张不在主花色） */
function truthOf(q) {
  const n = [0, 0, 0], k = new Array(27).fill(0);
  for (const t of q.hand) { n[suitOf(t)]++; k[t]++; }
  const tot = [0, 1, 2].map(s => n[s] + 3 * q.melds.filter(m => suitOf(m.tile) === s).length);
  const all = tot[0] + tot[1] + tot[2];
  return { n, k, qing: all - Math.max(...tot) <= 1 ? 1 : 0 };
}

/* 遍历牌谱：onSample(view, p, truth, ctx) 对每个被抽中的「观察者 × 对手」调用；
   onDealIn(sample, points) 对每次点炮调用（sample 是点炮那一手时 onSample 对胡牌者的返回值） */
function walk({ onSample, onDealIn, sampleAll = false }) {
  let games = 0, n = 0;
  for (const rec of records()) {
    games++;
    const kept = new Map();   // 打牌事件序号 → { [对手座位]: onSample 的返回值 }
    const g = replayRecord(rec, {
      onDecision({ g, seat, action }) {
        if (action.type !== 'discard') return;
        const take = n++ % every === 0;
        if (!take && !onDealIn) return;
        const view = viewFor(g, seat);
        const vu = unseenCounts(view);
        const bySeat = {};
        for (const p of view.players) {
          if (p.seat === seat || p.won) continue;
          const res = onSample(view, p, truthOf(g.players[p.seat]), { vu, tile: action.tile, take: take || sampleAll });
          if (res !== undefined) bySeat[p.seat] = res;
        }
        if (onDealIn) kept.set(g.log.length, bySeat);
      }
    });
    if (!onDealIn) continue;
    let lastDiscard = {};
    for (const e of g.log) {
      if (e.type === 'discard') lastDiscard[e.seat] = e.seq;
      if (e.type === 'hu' && !e.zimo && e.from !== null && e.from !== undefined) {
        const bySeat = kept.get(lastDiscard[e.from]);
        if (bySeat && bySeat[e.seat] && e.tile === g.log[lastDiscard[e.from]].tile) onDealIn(bySeat[e.seat], e.points);
      }
    }
  }
  return games;
}

/* ---------- 第一遍：花色分布 + 牌张位置 ---------- */
function suitAndTileGroups() {
  const suitG = [], tileG = [];
  let bad = 0;
  const games = walk({
    onSample(view, p, truth, { vu, take }) {
      if (!take || !p.handCount) return;
      const rows = suitRows(view, p, vu.vis);
      for (let s = 0; s < 3; s++) if (!rows[s] && truth.n[s]) bad++;
      suitG.push({ c: p.handCount, rows: rows.map((x, s) => x && { x, y: truth.n[s] / p.handCount }).filter(Boolean) });
      for (let s = 0; s < 3; s++) {
        if (!truth.n[s]) continue;
        const rs = [];
        for (let k = s * 9; k < s * 9 + 9; k++) if (vu.unseen[k] > 0) rs.push({ x: tileRow(p, k), off: Math.log(vu.unseen[k]), y: truth.k[k] / truth.n[s] });
        tileG.push({ c: truth.n[s], rows: rs, unseen: vu.unseen.slice(s * 9, s * 9 + 9) });
      }
    }
  });
  if (bad) console.warn(`警告：${bad} 个样本里「规则保证没有缺门牌」的对手手里有缺门牌，硬规则有误`);
  return { suitG, tileG, games };
}

/* ---------- 第二遍：清一色 + 放炮损失（需要花色分布的权重） ---------- */
function qingAndLoss(W) {
  const qing = [], loss = [];
  const games = walk({
    onSample(view, p, truth, { vu, tile, take }) {
      const shares = suitShares(suitRows(view, p, vu.vis), W.suit);
      const { top, x } = qingRow(p, shares);
      if (take) qing.push({ x, y: truth.qing, heur: suspectQing(p) !== null ? 1 : 0, top, shares, truth });
      return { x, top, p: { melds: p.melds, handCount: p.handCount, draws: p.draws }, tile };
    },
    onDealIn(s, points) { loss.push({ ...s, points }); }
  });
  return { qing, loss, games };
}

const lossX = (s, wq) => lossRow(s.p, { pQing: sigmoid(dot(wq, s.x)), top: s.top }, s.tile);

/* ---------- 指标 ---------- */
const mean = (a, f) => a.reduce((acc, x) => acc + f(x), 0) / a.length;
function auc(scores, ys) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 0, pos = 0, sum = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++;
    const avg = (i + j + 1) / 2;
    for (let t = i; t < j; t++) if (ys[idx[t]]) { sum += avg; pos++; }
    rank = j; i = j;
  }
  const neg = rank - pos;
  return (sum - pos * (pos + 1) / 2) / (pos * neg);
}
function deciles(arr, key) {
  const s = arr.slice().sort((x, y) => x[key] - y[key]);
  return Array.from({ length: 10 }, (_, i) => s.slice(Math.floor(i * s.length / 10), Math.floor((i + 1) * s.length / 10)));
}
/* 组内交叉熵（每张牌平均，单位 nat） */
function groupCE(groups, probsOf) {
  let ce = 0, n = 0;
  for (const gp of groups) {
    const p = probsOf(gp);
    gp.rows.forEach((r, i) => { if (r.y > 0) ce -= gp.c * r.y * Math.log(Math.max(1e-9, p[i])); });
    n += gp.c;
  }
  return ce / n;
}
const softmax = (rows, w) => { const z = rows.map(r => Math.exp(dot(w, r.x) + (r.off || 0))); const Z = z.reduce((a, b) => a + b, 0); return z.map(v => v / Z); };

if (mode === 'fit') {
  const t0 = performance.now();
  const { suitG, tileG, games } = suitAndTileGroups();
  console.log(`牌谱 ${games} 局；花色样本 ${suitG.length}，牌张样本 ${tileG.length}（每 ${every} 个决定取 1）`);
  const suit = condLogit(suitG, SUIT_FEATURES.length).map(r4);
  const tile = condLogit(tileG, TILE_FEATURES.length).map(r4);
  console.log('花色', JSON.stringify(Object.fromEntries(SUIT_FEATURES.map((f, i) => [f, suit[i]]))));
  console.log('牌张', JSON.stringify(Object.fromEntries(TILE_FEATURES.map((f, i) => [f, tile[i]]))));
  const W = { version: INFER_VERSION, suit, tile };
  const { qing, loss } = qingAndLoss(W);
  W.qing = logistic(qing.map(s => s.x), qing.map(s => s.y)).map(r4);
  W.loss = poisson(loss.map(s => lossX(s, W.qing)), loss.map(s => s.points)).map(r4);
  console.log(`清一色样本 ${qing.length}（正例 ${(100 * mean(qing, s => s.y)).toFixed(1)}%），放炮样本 ${loss.length}`);
  console.log('清一色', JSON.stringify(Object.fromEntries(QING_FEATURES.map((f, i) => [f, W.qing[i]]))));
  console.log('放炮损失', JSON.stringify(Object.fromEntries(LOSS_FEATURES.map((f, i) => [f, W.loss[i]]))));
  writeFileSync(new URL('../src/ai/infer-weights.mjs', import.meta.url),
    `/* 由 tools/fit-infer.mjs 生成，勿手改。训练牌谱：${files.join('、')}（${games} 局；花色样本 ${suitG.length}，放炮样本 ${loss.length}） */\n` +
    `export const INFER_WEIGHTS = ${JSON.stringify(W)};\n`);
  console.log(`已写出 src/ai/infer-weights.mjs，耗时 ${((performance.now() - t0) / 1000).toFixed(0)} s`);
} else {
  const W = INFER_WEIGHTS;
  const { suitG, tileG, games } = suitAndTileGroups();
  const { qing, loss } = qingAndLoss(W);
  const pct = x => (100 * x).toFixed(1) + '%';
  console.log(`牌谱 ${games} 局；花色样本 ${suitG.length}，牌张样本 ${tileG.length}，清一色样本 ${qing.length}，放炮样本 ${loss.length}（每 ${every} 个决定取 1）\n`);

  // 花色：模型 vs 「可能的花色平均分」 vs 「按看不见的张数分」
  const uniform = gp => gp.rows.map(() => 1 / gp.rows.length);
  const byUnseen = gp => { const u = gp.rows.map(r => Math.max(0.5, 36 * (1 - r.x[8]))); const Z = u.reduce((a, b) => a + b, 0); return u.map(v => v / Z); };
  const model = gp => softmax(gp.rows, W.suit);
  const ce0 = groupCE(suitG, uniform), ce1 = groupCE(suitG, byUnseen), ce2 = groupCE(suitG, model);
  const hit = suitG.filter(gp => gp.rows.length > 1).map(gp => {
    const p = model(gp), yi = gp.rows.reduce((a, r, i) => (r.y > gp.rows[a].y ? i : a), 0);
    return p.indexOf(Math.max(...p)) === yi ? 1 : 0;
  });
  const mae = mean(suitG, gp => { const p = model(gp); return gp.rows.reduce((a, r, i) => a + Math.abs(p[i] - r.y) * gp.c, 0); });
  const mae0 = mean(suitG, gp => { const p = uniform(gp); return gp.rows.reduce((a, r, i) => a + Math.abs(p[i] - r.y) * gp.c, 0); });
  console.log('### 花色分布（每张暗手牌的交叉熵，越小越好）\n\n| 方法 | 交叉熵 | 各门张数绝对误差之和 |\n|---|---|---|');
  console.log(`| 可能的花色平均分 | ${ce0.toFixed(4)} | ${mae0.toFixed(2)} 张 |\n| 按看不见的张数分 | ${ce1.toFixed(4)} | — |\n| 模型 | **${ce2.toFixed(4)}** | **${mae.toFixed(2)} 张** |`);
  console.log(`\n主花色猜中率（张数最多的那门，排除只剩一门可能的样本）：${pct(mean(hit, x => x))}（${hit.length} 个样本）`);

  const tce0 = groupCE(tileG, gp => softmax(gp.rows, new Array(TILE_FEATURES.length).fill(0)));
  const tce1 = groupCE(tileG, gp => softmax(gp.rows, W.tile));
  console.log(`\n### 牌张位置（同一门里每张牌的交叉熵）\n\n| 方法 | 交叉熵 |\n|---|---|\n| 按看不见的张数分 | ${tce0.toFixed(4)} |\n| 模型 | **${tce1.toFixed(4)}** |`);

  // 清一色
  const pq = qing.map(s => sigmoid(dot(W.qing, s.x)));
  qing.forEach((s, i) => { s.pq = pq[i]; });
  const heurP = mean(qing.filter(s => s.heur), s => s.y), heurR = qing.filter(s => s.heur && s.y).length / qing.filter(s => s.y).length;
  console.log(`\n### 清一色（暗手 + 副露最多 1 张不在主花色）\n\n实际占比 ${pct(mean(qing, s => s.y))}；模型 AUC **${auc(pq, qing.map(s => s.y)).toFixed(3)}**；` +
    `原启发式 suspectQing：命中率 ${pct(heurP)}，召回 ${pct(heurR)}（只在有副露时能判断）\n\n| 分桶 | 样本 | 预测 | 实际 |\n|---|---|---|---|`);
  deciles(qing, 'pq').forEach((b, i) => console.log(`| ${i + 1} | ${b.length} | ${pct(mean(b, x => x.pq))} | ${pct(mean(b, x => x.y))} |`));

  // 放炮损失
  for (const s of loss) s.pred = Math.exp(dot(W.loss, lossX(s, W.qing)));
  const avg = mean(loss, s => s.points);
  console.log(`\n### 放炮损失（点炮时付给胡牌者的分）\n\n平均实际 ${avg.toFixed(3)}，平均预测 ${mean(loss, s => s.pred).toFixed(3)}；` +
    `平均绝对误差：模型 **${mean(loss, s => Math.abs(s.pred - s.points)).toFixed(3)}**，常数（现用 1.6）${mean(loss, s => Math.abs(1.6 - s.points)).toFixed(3)}，` +
    `常数（本牌谱均值）${mean(loss, s => Math.abs(avg - s.points)).toFixed(3)}\n\n| 分桶 | 样本 | 预测 | 实际 |\n|---|---|---|---|`);
  deciles(loss, 'pred').forEach((b, i) => console.log(`| ${i + 1} | ${b.length} | ${mean(b, x => x.pred).toFixed(2)} | ${mean(b, x => x.points).toFixed(2)} |`));
}
