/* 打法风格统计：从牌谱里按「座位上是谁」分组，统计各家的打法指纹
   用法：node tools/style-stats.mjs <牌谱.jsonl 或 下载的 .json> [...更多文件]
   分组键：牌谱 players[i] 里的 kind / level / style，复式牌谱再加上 [A] / [B] 角色（人类记为 human），所以电脑风格和你自己的对局可以放在一起对比。
   指标（每人每局平均）：
     胡牌率、自摸占胡牌比例、胡牌平均番数、清一色 / 对对胡 / 七对（含龙七对）占胡牌比例、
     点炮次数、碰次数、杠次数、首次听牌时已摸张数（只算听牌过的局）、流局时听牌率（只算流局时未胡的人）、每局得分 */
import { readFileSync } from 'node:fs';
import { replayRecord } from '../src/game/record.mjs';
import { shanten, toCounts, suitOf } from '../src/core/core.mjs';
import { bestWaitFan } from '../src/game/engine.mjs';

const files = process.argv.slice(2);
if (!files.length) { console.error('用法：node tools/style-stats.mjs <牌谱文件> [...]'); process.exit(1); }

const keyOf = p => (!p ? '未知' : p.kind === 'human' ? 'human' : `L${p.level}${p.style ? '-' + p.style : ''}${p.role === 'A' || p.role === 'B' ? ` [${p.role}]` : ''}`);
const groups = new Map();
const acc = k => {
  if (!groups.has(k)) groups.set(k, { n: 0, hu: 0, zimo: 0, fan: 0, qing: 0, dui: 0, qidui: 0, dealIn: 0, pong: 0, gang: 0, tenpaiDraw: 0, tenpaiN: 0, drawEnd: 0, drawTenpai: 0, score: 0 });
  return groups.get(k);
};

function* records() {
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.jsonl')) { for (const line of text.split('\n')) if (line.trim()) yield JSON.parse(line); }
    else yield JSON.parse(text);
  }
}

let games = 0;
for (const rec of records()) {
  games++;
  const firstTenpai = [null, null, null, null];
  const g = replayRecord(rec, {
    onDecision({ g, seat, action }) {
      if (action.type !== 'discard' || firstTenpai[seat] !== null) return;
      const p = g.players[seat];
      const hand = p.hand.slice(); hand.splice(hand.indexOf(action.tile), 1);
      if (!hand.some(t => suitOf(t) === p.voidSuit) && shanten(toCounts(hand), p.melds.length) === 0) firstTenpai[seat] = p.draws;
    }
  });
  for (let s = 0; s < 4; s++) {
    const a = acc(keyOf(rec.players && rec.players[s]));
    const p = g.players[s];
    a.n++;
    a.score += p.score;
    if (p.won) {
      a.hu++; if (p.won.zimo) a.zimo++; a.fan += p.won.fan;
      if (p.won.yaku.some(y => y.key === 'qing_yi_se')) a.qing++;
      if (p.won.yaku.some(y => y.key === 'dui_dui_hu')) a.dui++;
      if (p.won.yaku.some(y => y.key === 'qi_dui' || y.key === 'long_qi_dui')) a.qidui++;
    }
    if (firstTenpai[s] !== null) { a.tenpaiN++; a.tenpaiDraw += firstTenpai[s]; }
    if (g.result.reason === 'wall' && !p.won) { a.drawEnd++; if (bestWaitFan(g, s) !== null) a.drawTenpai++; }
  }
  for (const e of g.log) {
    const who = s => acc(keyOf(rec.players && rec.players[s]));
    if (e.type === 'pay' && (e.reason === 'dianPao' || e.reason === 'qiangGang')) who(e.from).dealIn++;
    if (e.type === 'pong') who(e.seat).pong++;
    if (e.type === 'gang') who(e.seat).gang++;
  }
}

const pct = (x, y) => (y ? (100 * x / y).toFixed(1) + '%' : '—');
const avg = (x, y, d = 2) => (y ? (x / y).toFixed(d) : '—');
console.log(`牌谱 ${games} 局\n`);
console.log('| 座位上是谁 | 人局数 | 胡牌率 | 自摸占比 | 胡牌平均番 | 清一色占比 | 对对胡占比 | 七对占比 | 每局点炮 | 每局碰 | 每局杠 | 首次听牌巡目 | 流局时听牌率 | 每局得分 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [k, a] of [...groups].sort()) {
  console.log(`| ${k} | ${a.n} | ${pct(a.hu, a.n)} | ${pct(a.zimo, a.hu)} | ${avg(a.fan, a.hu)} | ${pct(a.qing, a.hu)} | ${pct(a.dui, a.hu)} | ${pct(a.qidui, a.hu)} | ${avg(a.dealIn, a.n)} | ${avg(a.pong, a.n)} | ${avg(a.gang, a.n)} | ${avg(a.tenpaiDraw, a.tenpaiN, 1)} | ${pct(a.drawTenpai, a.drawEnd)} | ${avg(a.score, a.n)} |`);
}
