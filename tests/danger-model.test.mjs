import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, viewFor } from '../src/game/engine.mjs';
import { createBot, runBots } from '../src/ai/bots.mjs';
import { exportRecord, replayRecord } from '../src/game/record.mjs';
import { shanten, toCounts, suitOf, isWinHand } from '../src/core/core.mjs';
import { visibleCounts, opponentThreat, tileDangerVs } from '../src/ai/danger.mjs';
import { predict, learnedThreats, learnedTileDanger } from '../src/ai/danger-model.mjs';
import { opponentFeatures, tileFeatures, OPP_FEATURES, TILE_FEATURES } from '../src/ai/danger-features.mjs';
import { TENPAI_MODEL, WAIT_MODEL } from '../src/ai/danger-weights.mjs';
import { setup, tiles } from './helpers.mjs';

test('学习模型：JS 推理与 Python 训练时的预测一致', () => {
  for (const m of [TENPAI_MODEL, WAIT_MODEL]) {
    assert.ok(m.selfTest.length >= 10);
    for (const c of m.selfTest) assert.ok(Math.abs(predict(m, c.x) - c.p) < 1e-6, `${m.type}: ${predict(m, c.x)} vs ${c.p}`);
  }
});

test('学习模型：特征长度与列名一致；缺门花色的牌对该对手为 0；已胡对手无威胁', () => {
  const g = setup({ hands: ['123m 456m 789m 22s 45s 9s', '1p', '2p', '3p'], voids: [2, 0, 1, 0], wall: '1s 2s 3s' });
  for (const p of g.players) p.draws = 9;
  const view = viewFor(g, 0);
  const vis = visibleCounts(view);
  const opp = view.players[1];
  const oppF = opponentFeatures(view, opp);
  assert.equal(oppF.length, OPP_FEATURES.length);
  assert.equal(tileFeatures(view, opp, tiles('5s')[0], vis, oppF).length, TILE_FEATURES.length);
  const th = learnedThreats(view);
  const d = learnedTileDanger(view, tiles('5m')[0], th, vis);
  assert.ok(!d.by.some(x => x.seat === 1 || x.seat === 3), '下家、上家缺万：5 万对他们安全');
  for (const s of [1, 2, 3]) assert.ok(th[s].threat > 0 && th[s].threat < 1);
  g.players[2].won = { order: 1, tile: 0, from: null, zimo: true, yaku: [], fan: 0, points: 1 };
  assert.equal(learnedThreats(viewFor(g, 0))[2].threat, 0);
});

/* AUC（按秩计算） */
function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 0, sumPos = 0, nPos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++;
    const r = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (labels[idx[k]]) { sumPos += r; nPos++; }
    i = j; rank = j;
  }
  const nNeg = rank - nPos;
  return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

test('学习模型：在训练没用过的新对局上，放炮预测的 AUC 高于启发式', () => {
  const learned = [], heuristic = [], labels = [];
  for (let seed = 1; seed <= 30; seed++) {
    const g0 = createGame({ seed: 777000 + seed });
    runBots(g0, [0, 1, 2, 3].map(i => createBot(3, seed * 10 + i)));
    replayRecord(exportRecord(g0), {
      onDecision({ g, seat, action }) {
        if (action.type !== 'discard') return;
        const view = viewFor(g, seat);
        const vis = visibleCounts(view);
        const th = learnedThreats(view);
        for (const opp of g.players) {
          if (opp.seat === seat || opp.won || suitOf(action.tile) === opp.voidSuit) continue;
          const c = toCounts(opp.hand);
          const tenpai = !opp.hand.some(t => suitOf(t) === opp.voidSuit) && shanten(c, opp.melds.length) === 0;
          let ron = false;
          if (tenpai && !opp.huLock) { c[action.tile]++; ron = isWinHand(c, opp.melds.length); }
          const vp = view.players[opp.seat];
          learned.push(predict(WAIT_MODEL, tileFeatures(view, vp, action.tile, vis, th[opp.seat].features)));
          heuristic.push(tileDangerVs(view, vp, opponentThreat(view, vp), action.tile, vis));
          labels.push(ron);
        }
      }
    });
  }
  const a = auc(learned, labels), b = auc(heuristic, labels);
  assert.ok(labels.some(Boolean));
  assert.ok(a > b, `学习模型 AUC ${a.toFixed(3)}，启发式 ${b.toFixed(3)}`);
});
