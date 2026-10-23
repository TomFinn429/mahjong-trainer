/* 从牌谱导出危险度模型的训练数据
   用法：node tools/export-danger-data.mjs <牌谱.jsonl> <输出目录>
   牌谱可用 tools/duplicate.mjs --records 产生。

   对每个「打牌」决定，以打牌者为观察者：
   - tenpai.bin：每个未胡对手一行。特征 = opponentFeatures；标签 = 该对手此刻是否听牌（手里无缺门且向听 0）
   - wait.bin：随机取最多 3 种可打的牌 × 每个未胡对手一行（跳过对手缺门花色的牌：规则上绝对安全）。
     特征 = tileFeatures；标签 = 打出这张牌对手能不能胡（含过手胡锁定）
   特征只来自观察者 viewFor()；标签来自重放时的全知状态。
   每行末尾附加：label、启发式分数（现有 danger.mjs，用于对照）、对局序号（按局切分训练 / 测试集）
   输出 float32 小端二进制 + meta.json（列名与行数） */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { viewFor } from '../src/game/engine.mjs';
import { replayRecord } from '../src/game/record.mjs';
import { shanten, toCounts, suitOf, isWinHand } from '../src/core/core.mjs';
import { visibleCounts, opponentThreat, tileDangerVs } from '../src/ai/danger.mjs';
import { OPP_FEATURES, TILE_FEATURES, FEATURE_VERSION, opponentFeatures, tileFeatures } from '../src/ai/danger-features.mjs';

const [, , input, outDir] = process.argv;
if (!input || !outDir) { console.error('用法：node tools/export-danger-data.mjs <牌谱.jsonl> <输出目录>'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const tenpaiRows = [], waitRows = [];
let rnd = 12345;
const rand = () => ((rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0) / 4294967296);

const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);
lines.forEach((line, gameIdx) => {
  const rec = JSON.parse(line);
  replayRecord(rec, {
    onDecision({ g, seat, action }) {
      if (action.type !== 'discard') return;
      const view = viewFor(g, seat);
      const visible = visibleCounts(view);
      const options = [...new Set(view.actions.filter(a => a.type === 'discard').map(a => a.tile))];
      for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
      const tilesToTry = options.slice(0, 3);
      for (const opp of g.players) {
        if (opp.seat === seat || opp.won) continue;
        const vp = view.players[opp.seat];
        const counts = toCounts(opp.hand);
        const hasVoid = opp.hand.some(t => suitOf(t) === opp.voidSuit);
        const tenpai = !hasVoid && shanten(counts, opp.melds.length) === 0;
        const th = opponentThreat(view, vp);
        const oppF = opponentFeatures(view, vp);
        tenpaiRows.push([...oppF, tenpai ? 1 : 0, th.threat, gameIdx]);
        for (const k of tilesToTry) {
          if (suitOf(k) === opp.voidSuit) continue;
          let ron = false;
          if (tenpai && !opp.huLock) { counts[k]++; ron = isWinHand(counts, opp.melds.length); counts[k]--; }
          waitRows.push([...tileFeatures(view, vp, k, visible, oppF), ron ? 1 : 0, tileDangerVs(view, vp, th, k, visible), gameIdx]);
        }
      }
    }
  });
  if ((gameIdx + 1) % 500 === 0) process.stderr.write(`  ${gameIdx + 1}/${lines.length} 局\n`);
});

function dump(name, rows, cols) {
  const w = cols.length + 3;
  const buf = new Float32Array(rows.length * w);
  rows.forEach((r, i) => buf.set(r, i * w));
  writeFileSync(join(outDir, name + '.bin'), Buffer.from(buf.buffer));
  return { file: name + '.bin', rows: rows.length, columns: [...cols, 'label', 'heuristic', 'game'] };
}
const meta = {
  featureVersion: FEATURE_VERSION, games: lines.length, source: input,
  tenpai: dump('tenpai', tenpaiRows, OPP_FEATURES),
  wait: dump('wait', waitRows, TILE_FEATURES)
};
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
const pos = rows => rows.filter(r => r[r.length - 3] === 1).length;
console.log(`对局 ${lines.length}；听牌样本 ${tenpaiRows.length}（正例 ${pos(tenpaiRows)}）；放炮样本 ${waitRows.length}（正例 ${pos(waitRows)}）→ ${outDir}`);
