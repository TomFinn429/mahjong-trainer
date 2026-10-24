import test from 'node:test';
import assert from 'node:assert/strict';
import { viewFor } from '../src/game/engine.mjs';
import { evContext, handValue, tenpaiWaits, pHuFeatures } from '../src/ai/ev.mjs';
import { EV_WEIGHTS } from '../src/ai/ev-weights.mjs';
import { evaluateDiscards, turnGangEV } from '../src/ai/analyzer.mjs';
import { createBot, decide } from '../src/ai/bots.mjs';
import { toCounts } from '../src/core/core.mjs';
import { setup, tiles } from './helpers.mjs';

const P = 2;
const WALL = Array.from({ length: 40 }, (_, i) => '123456789'[i % 9] + 'mp'[i % 2]).join(' ');
const ctxOf = hand0 => {
  const g = setup({ hands: [hand0, '1p', '2p', '3p'], voids: [P, 0, 0, 0], wall: WALL });
  return { g, ctx: evContext(viewFor(g, 0)) };
};
const pHu = (remain, wall, active) => 1 / (1 + Math.exp(-pHuFeatures(remain, wall, active).reduce((a, x, i) => a + x * EV_WEIGHTS.pHu[i], 0)));

test('期望得分：待牌和剩余张数只用可见信息', () => {
  const { ctx } = ctxOf('123m 456m 789m 11s 23s 5s');
  const w = tenpaiWaits(ctx, toCounts(tiles('123m 456m 789m 11s 23s')));
  assert.deepEqual(w.map(x => x.tile), tiles('1s 4s'));
  assert.deepEqual(w.map(x => x.remain), [2, 4]);
  assert.ok(w.every(x => x.zimo > x.ron));
});

test('期望得分：和牌率随待牌张数增加、随牌墙减少和未胡人数减少而下降', () => {
  assert.ok(pHu(6, 40, 4) > pHu(2, 40, 4));
  assert.ok(pHu(4, 40, 4) > pHu(4, 10, 4));
  assert.ok(pHu(4, 30, 4) > pHu(4, 30, 2));
});

test('期望得分：同样的听牌形状，番数高的更值钱；张数多的比张数少的值钱', () => {
  const { ctx } = ctxOf('123m 456m 789m 11s 23s 5s');
  const ping = handValue(ctx, tiles('123m 456m 789m 11s 23s'));
  const kan = handValue(ctx, tiles('123m 456m 789m 11s 24s'));
  const qing = handValue(ctx, tiles('123s 456s 789s 11s 23s'));
  assert.equal(ping.shanten, 0);
  assert.ok(ping.ev > kan.ev, '两面（6 张）应好过嵌张（4 张）');
  assert.ok(qing.ev > ping.ev, '清一色应好过同形的平胡');
});

test('期望得分：一向听给出进张概率，二向听和手里有缺门牌返回 null', () => {
  const { ctx } = ctxOf('123m 456m 789m 11s 23s 5s');
  const one = handValue(ctx, tiles('123m 456m 789m 11s 2s 5s'));
  assert.equal(one.shanten, 1);
  assert.ok(one.pReach > 0 && one.pReach <= 1);
  assert.equal(handValue(ctx, tiles('123m 456m 79m 1s 5s 8s 9s 2s')), null);
  assert.equal(handValue(ctx, tiles('123m 456m 789m 11s 23s').slice(0, 12).concat(tiles('5p'))), null);
});

test('分析器：开启 ev 后听牌 / 一向听的候选按期望得分排在前面', () => {
  const { g } = ctxOf('123m 456m 789m 11s 23s 5s');
  const ev = evaluateDiscards(viewFor(g, 0), { ev: true });
  assert.ok(ev.rows[0].ev !== undefined);
  assert.equal(ev.rows[0].tile, tiles('5s')[0], '打 5s 听 1s / 4s');
  const withEV = ev.rows.filter(r => r.ev !== undefined);
  for (let i = 1; i < withEV.length; i++) assert.ok(withEV[i - 1].ev >= withEV[i].ev);
});

test('暗杠：按「杠后期望得分 + 杠钱」与不杠时最好打法的期望得分比较', () => {
  const { g } = ctxOf('1111m 456m 789m 23s 55s');
  const view = viewFor(g, 0);
  const act = view.actions.find(a => a.type === 'angang');
  assert.ok(act, '应能暗杠 1m');
  const gangEV = turnGangEV(view, act);
  const best = evaluateDiscards(view, { ev: true }).rows[0];
  assert.ok(gangEV !== undefined && best.ev !== undefined);
  const a = decide(createBot(3, 1), view);
  assert.equal(a.type === 'angang', gangEV > best.ev);
});

test('封顶：清一色七对（4 番）不封顶时比 3 番封顶更值钱，平胡不受影响', () => {
  const evUnder = (cap, hand13) => {
    const g = setup({ hands: ['123m 456m 789m 11s 23s 5s', '1p', '2p', '3p'], voids: [P, 0, 0, 0], wall: WALL, rules: { cap } });
    return handValue(evContext(viewFor(g, 0)), tiles(hand13)).ev;
  };
  assert.ok(evUnder(0, '11s 22s 33s 44s 55s 66s 7s') > evUnder(3, '11s 22s 33s 44s 55s 66s 7s'));
  assert.equal(evUnder(0, '123m 456m 789m 11s 23s'), evUnder(3, '123m 456m 789m 11s 23s'));
});
