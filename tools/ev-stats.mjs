/* 期望得分统计（roadmap T12 第 1 步）：从牌谱里测出「速度 × 打点 × 风险」各项的实际数字
   用法：node tools/ev-stats.mjs <牌谱.jsonl> [...更多文件] [--json 输出.json]
   取样：每个「打牌」决定打出之后的局面（只算缺门已打完的），看这一家从这一刻到本局结束的结果。
   表格：
     1. 听牌：待牌剩余张数 × 牌墙剩余 → 和牌率；以及按待牌种数（单门 / 两门 / 三门以上）、最大番分开
     2. 一向听 / 二向听：有效牌张数 × 牌墙剩余 → 听牌率、和牌率
     3. 局面价值：向听 × 牌墙剩余 → 本局剩余部分的平均得分变化（含杠钱、流局结算）
     4. 胡牌收入：番数 × 自摸 / 点炮 → 每次胡牌实际收到的分（不含杠钱）
     5. 点炮损失：按胡牌者番数、按胡牌者副露是否显出清一色迹象
     6. 流局：听牌者查大叫收入、未听牌者支出
   注意：同一家同一局会取多个样本，样本之间不独立；表中 n 是样本数，不能直接当独立样本算置信区间。
   数字只反映牌谱里那些电脑的打法，换对手池要重新统计（脚本按文件分别跑即可对比） */
import { readFileSync, writeFileSync } from 'node:fs';
import { replayRecord } from '../src/game/record.mjs';
import { viewFor } from '../src/game/engine.mjs';
import { handEfficiency } from '../src/ai/analyzer.mjs';
import { suitOf } from '../src/core/core.mjs';

const argv = process.argv.slice(2);
const ji = argv.indexOf('--json');
const jsonOut = ji >= 0 ? argv[ji + 1] : null;
const files = argv.filter((x, i) => ji < 0 || (i !== ji && i !== ji + 1));
if (!files.length) { console.error('用法：node tools/ev-stats.mjs <牌谱.jsonl> [...] [--json 输出.json]'); process.exit(1); }

function* records() {
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.jsonl')) { for (const line of text.split('\n')) if (line.trim()) yield JSON.parse(line); }
    else yield JSON.parse(text);
  }
}

/* ---------- 分桶 ---------- */
const bucket = (edges, labels) => x => labels[edges.findIndex(e => x <= e)] ?? labels[labels.length - 1];
const WALL = { labels: ['40+', '30–39', '20–29', '10–19', '0–9'], of: w => (w >= 40 ? '40+' : w >= 30 ? '30–39' : w >= 20 ? '20–29' : w >= 10 ? '10–19' : '0–9') };
const REMAIN = { labels: ['0', '1–2', '3–4', '5–6', '7–8', '9+'], of: bucket([0, 2, 4, 6, 8, Infinity], ['0', '1–2', '3–4', '5–6', '7–8', '9+']) };
const KINDS = { labels: ['单门', '两门', '三门+'], of: k => (k <= 1 ? '单门' : k === 2 ? '两门' : '三门+') };
const UKE = { labels: ['0–8', '9–16', '17–24', '25–32', '33+'], of: bucket([8, 16, 24, 32, Infinity], ['0–8', '9–16', '17–24', '25–32', '33+']) };
const SH = { labels: ['听牌', '一向听', '二向听', '三向听+'], of: s => ['听牌', '一向听', '二向听'][s] ?? '三向听+' };

/* ---------- 累加器 ---------- */
const tables = {};
function add(name, row, col, o) {
  const t = tables[name] ??= {};
  const c = (t[row] ??= {})[col] ??= { n: 0, hu: 0, zimo: 0, tenpai: 0, dealIn: 0, endTenpai: 0, delta: 0 };
  c.n++; c.hu += o.hu; c.zimo += o.zimo; c.tenpai += o.tenpai; c.dealIn += o.dealIn; c.endTenpai += o.endTenpai; c.delta += o.delta;
}
const huIncome = {};     // 番 → { zimo: {n, sum}, ron: {n, sum} }
const yakuCount = {};
const dealInLoss = { byFan: {}, bySign: {} };
const drawEnd = { tenpaiByFan: {}, notTenpai: { n: 0, sum: 0 }, huazhu: { n: 0, sum: 0 } };
const inc = (o, k, v) => { const c = (o[k] ??= { n: 0, sum: 0 }); c.n++; c.sum += v; };

let games = 0, samples = 0;
for (const rec of records()) {
  games++;
  const states = [[], [], [], []];
  const g = replayRecord(rec, {
    onDecision({ g, seat, action }) {
      if (action.type !== 'discard') return;
      const p = g.players[seat];
      const hand = p.hand.slice(); hand.splice(hand.indexOf(action.tile), 1);
      if (hand.some(t => suitOf(t) === p.voidSuit)) return;
      const eff = handEfficiency(viewFor(g, seat), hand);
      const waits = eff.waits || [];
      states[seat].push({
        logAt: g.log.length, score: p.score, wall: g.wall.length,
        active: g.players.filter(q => !q.won).length,
        shanten: eff.shanten, ukeire: eff.ukeireTotal,
        waitRemain: waits.reduce((a, w) => a + w.remain, 0), waitKinds: waits.length,
        maxFan: waits.length ? Math.max(...waits.map(w => w.fan)) : null
      });
    }
  });

  /* 每家从某一刻起有没有点炮：记下每次点炮在 log 里的位置 */
  const dealAt = [[], [], [], []];
  let curHu = null;
  for (let i = 0; i < g.log.length; i++) {
    const e = g.log[i];
    if (e.type === 'hu') {
      curHu = { seat: e.seat, fan: e.fan, zimo: e.zimo, sum: 0 };
      for (const y of e.yaku) yakuCount[y.key] = (yakuCount[y.key] || 0) + 1;
      const winner = g.players[e.seat];
      // 胡牌那一刻别家看得到的副露迹象：两组以上全是同一门才算清一色迹象
      const ms = winner.melds;
      curHu.sign = !ms.length ? '门清' : ms.length === 1 ? '1 组副露'
        : ms.every(m => suitOf(m.tile) === suitOf(ms[0].tile)) ? '2 组以上同一门' : '2 组以上多门';
      (huIncome[e.fan] ??= {});
      continue;
    }
    if (e.type === 'pay' && curHu && e.to === curHu.seat && ['zimo', 'dianPao', 'qiangGang'].includes(e.reason)) {
      curHu.sum += e.amount;
      if (e.reason !== 'zimo') {
        dealAt[e.from].push(i);
        inc(dealInLoss.byFan, curHu.fan, e.amount);
        inc(dealInLoss.bySign, curHu.sign, e.amount);
      }
      const nxt = g.log[i + 1];
      if (!(nxt && nxt.type === 'pay' && nxt.to === curHu.seat && nxt.reason === e.reason)) {
        inc(huIncome[curHu.fan], curHu.zimo ? 'zimo' : 'ron', curHu.sum);
        curHu = null;
      }
    }
  }

  /* 流局结算按人汇总 */
  if (g.result.reason === 'wall') {
    const settle = g.result.settle;
    for (let s = 0; s < 4; s++) {
      const p = g.players[s];
      if (p.won) continue;
      const got = settle.filter(x => x.type === 'dajiao' && x.to === s);
      const paid = settle.filter(x => x.type === 'dajiao' && x.from === s);
      const hz = settle.filter(x => x.type === 'huazhu' && x.from === s);
      if (got.length) inc(drawEnd.tenpaiByFan, got[0].fan, got.reduce((a, x) => a + x.amount, 0));
      else if (hz.length) { drawEnd.huazhu.n++; drawEnd.huazhu.sum -= hz.reduce((a, x) => a + x.amount, 0); }
      else if (paid.length) { drawEnd.notTenpai.n++; drawEnd.notTenpai.sum -= paid.reduce((a, x) => a + x.amount, 0); }
    }
  }

  for (let s = 0; s < 4; s++) {
    const p = g.players[s];
    const st = states[s];
    // 从这一刻起是否到过听牌：倒序扫，后面有听牌样本或最终胡牌即算
    let later = !!p.won;
    for (let i = st.length - 1; i >= 0; i--) { later = later || st[i].shanten === 0; st[i].tenpaiLater = later; }
    const endTenpai = g.result.reason === 'wall' && !p.won && g.result.settle.some(x => x.type === 'dajiao' && x.to === s) ? 1 : 0;
    for (const x of st) {
      samples++;
      const o = {
        hu: p.won ? 1 : 0, zimo: p.won && p.won.zimo ? 1 : 0, tenpai: x.tenpaiLater ? 1 : 0,
        dealIn: dealAt[s].some(i => i > x.logAt) ? 1 : 0, endTenpai, delta: p.score - x.score
      };
      add('value', SH.of(x.shanten), WALL.of(x.wall), o);
      if (x.shanten === 0) {
        add('tenpai', REMAIN.of(x.waitRemain), WALL.of(x.wall), o);
        add('tenpaiKinds', REMAIN.of(x.waitRemain), KINDS.of(x.waitKinds), o);
        add('tenpaiFan', `${x.maxFan} 番`, WALL.of(x.wall), o);
        add('tenpaiActive', REMAIN.of(x.waitRemain), `${x.active} 家未胡`, o);
      } else if (x.shanten <= 2) {
        add(x.shanten === 1 ? 'iishanten' : 'ryanshanten', UKE.of(x.ukeire), WALL.of(x.wall), o);
      }
    }
  }
}

/* ---------- 输出 ---------- */
const pct = (a, n) => (n ? (100 * a / n).toFixed(1) + '%' : '—');
const avg = (a, n, d = 2) => (n ? (a / n).toFixed(d) : '—');
const MIN_N = 30;   // 样本少于这个数的格子不报数字，只给 n

function grid(title, name, rows, cols, metric, note) {
  const t = tables[name] || {};
  const rowLabels = rows || Object.keys(t).sort((a, b) => parseFloat(a) - parseFloat(b));
  console.log(`\n### ${title}\n`);
  if (note) console.log(note + '\n');
  console.log(`| | ${cols.join(' | ')} | 合计 |`);
  console.log(`|---|${cols.map(() => '---').join('|')}|---|`);
  for (const r of rowLabels) {
    if (!t[r]) continue;
    const cells = cols.map(c => t[r][c]);
    const tot = cells.reduce((a, c) => { if (c) for (const k in c) a[k] = (a[k] || 0) + c[k]; return a; }, {});
    const fmt = c => (!c ? '' : c.n < MIN_N ? `（n=${c.n}）` : `${metric(c)}（${c.n}）`);
    console.log(`| ${r} | ${cells.map(fmt).join(' | ')} | ${fmt(tot.n ? tot : null)} |`);
  }
}

const hu = c => pct(c.hu, c.n);
console.log(`牌谱 ${games} 局，样本 ${samples} 个（打牌后的局面，缺门已打完）。格子里是「数值（样本数）」，样本少于 ${MIN_N} 的只给样本数。`);

grid('1a 听牌后和牌率：待牌剩余张数 × 牌墙剩余', 'tenpai', REMAIN.labels, WALL.labels, hu);
grid('1b 听牌后本局剩余平均得分变化（分）：待牌剩余张数 × 牌墙剩余', 'tenpai', REMAIN.labels, WALL.labels, c => avg(c.delta, c.n));
grid('1c 听牌后和牌率：待牌剩余张数 × 待牌种数（多门听是否更好）', 'tenpaiKinds', REMAIN.labels, KINDS.labels, hu);
grid('1d 听牌后和牌率：待牌剩余张数 × 未胡人数', 'tenpaiActive', REMAIN.labels, ['4 家未胡', '3 家未胡', '2 家未胡'], hu);
grid('1e 听牌后平均得分变化（分）：听牌最大番 × 牌墙剩余（打点的价值）', 'tenpaiFan', null, WALL.labels, c => avg(c.delta, c.n));
grid('1f 听牌后自摸占和牌比例：听牌最大番 × 牌墙剩余', 'tenpaiFan', null, WALL.labels, c => pct(c.zimo, c.hu));
grid('1g 听牌后到本局结束前又点炮的比例：待牌剩余张数 × 牌墙剩余', 'tenpai', REMAIN.labels, WALL.labels, c => pct(c.dealIn, c.n));

grid('2a 一向听 → 之后听牌率：有效牌张数 × 牌墙剩余', 'iishanten', UKE.labels, WALL.labels, c => pct(c.tenpai, c.n));
grid('2b 一向听 → 和牌率', 'iishanten', UKE.labels, WALL.labels, hu);
grid('2c 二向听 → 之后听牌率', 'ryanshanten', UKE.labels, WALL.labels, c => pct(c.tenpai, c.n));
grid('2d 二向听 → 和牌率', 'ryanshanten', UKE.labels, WALL.labels, hu);

grid('3a 局面价值：本局剩余平均得分变化（分）', 'value', SH.labels, WALL.labels, c => avg(c.delta, c.n));
grid('3b 局面 → 之后点炮比例', 'value', SH.labels, WALL.labels, c => pct(c.dealIn, c.n));

console.log('\n### 4 胡牌收入（每次胡牌实际收到的分，不含杠钱）\n');
console.log('| 番 | 自摸 次数 | 自摸 平均收入 | 点炮 次数 | 点炮 平均收入 |');
console.log('|---|---|---|---|---|');
for (const f of Object.keys(huIncome).sort((a, b) => a - b)) {
  const z = huIncome[f].zimo || { n: 0, sum: 0 }, r = huIncome[f].ron || { n: 0, sum: 0 };
  console.log(`| ${f} | ${z.n} | ${avg(z.sum, z.n)} | ${r.n} | ${avg(r.sum, r.n)} |`);
}
const totalHu = Object.values(huIncome).reduce((a, x) => a + (x.zimo?.n || 0) + (x.ron?.n || 0), 0);
console.log(`\n番种出现次数（共 ${totalHu} 次胡牌）：` + Object.entries(yakuCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}（${pct(v, totalHu)}）`).join('，'));

console.log('\n### 5 点炮损失（每次点炮赔的分）\n');
console.log('| 胡牌者番数 | 次数 | 平均损失 |');
console.log('|---|---|---|');
for (const f of Object.keys(dealInLoss.byFan).sort((a, b) => a - b)) { const c = dealInLoss.byFan[f]; console.log(`| ${f} | ${c.n} | ${avg(c.sum, c.n)} |`); }
console.log('\n| 胡牌者副露 | 次数 | 平均损失 |');
console.log('|---|---|---|');
for (const [k, c] of Object.entries(dealInLoss.bySign)) console.log(`| ${k} | ${c.n} | ${avg(c.sum, c.n)} |`);

console.log('\n### 6 流局结算（每人）\n');
console.log('| 情况 | 人次 | 平均得分 |');
console.log('|---|---|---|');
for (const f of Object.keys(drawEnd.tenpaiByFan).sort((a, b) => a - b)) { const c = drawEnd.tenpaiByFan[f]; console.log(`| 听牌 ${f} 番（查大叫收入） | ${c.n} | +${avg(c.sum, c.n)} |`); }
console.log(`| 未听牌（赔查大叫） | ${drawEnd.notTenpai.n} | ${avg(drawEnd.notTenpai.sum, drawEnd.notTenpai.n)} |`);
console.log(`| 花猪 | ${drawEnd.huazhu.n} | ${avg(drawEnd.huazhu.sum, drawEnd.huazhu.n)} |`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ files, games, samples, tables, huIncome, yakuCount, dealInLoss, drawEnd }, null, 1));
  console.log(`\n已写出 ${jsonOut}`);
}
