import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, viewFor } from '../src/game/engine.mjs';
import { createBot, runBots } from '../src/ai/bots.mjs';
import { readAll, readOpponent, voidSurelyCleared, suitShares, suitRows, expectedLoss, inHandsExpect, unseenCounts } from '../src/ai/infer.mjs';
import { evaluateDiscards } from '../src/ai/analyzer.mjs';
import { suitOf } from '../src/core/core.mjs';
import { setup } from './helpers.mjs';

/* 跑一局，在每个状态上调用 fn(g) */
function eachState(seed, fn, every = 3) {
  const g = createGame({ seed, dealer: seed % 4 });
  const bots = [0, 1, 2, 3].map(s => createBot(3, seed * 10 + s));
  let i = 0;
  while (g.phase !== 'end') {
    if (g.phase === 'turn' && i++ % every === 0) fn(g);
    runBots(g, bots, { stepOnce: true });
  }
  return g;
}

test('摸切 / 手切：打出刚摸到的牌记为摸切，碰后出牌记为手切', () => {
  const g = eachState(701, () => {});
  const ds = g.log.filter(e => e.type === 'discard');
  assert.ok(ds.length > 10);
  assert.ok(ds.every(e => typeof e.tsumogiri === 'boolean'));
  for (let i = 1; i < g.log.length; i++) {
    const e = g.log[i];
    if (e.type !== 'discard') continue;
    const prev = g.log.slice(0, i).reverse().find(x => (x.type === 'draw' || x.type === 'pong') && x.seat === e.seat);
    if (prev && prev.type === 'pong') assert.equal(e.tsumogiri, false, '碰后出牌没有摸牌');
    if (prev && prev.type === 'draw' && prev.tile !== e.tile) assert.equal(e.tsumogiri, false);
  }
  assert.ok(ds.some(e => e.tsumogiri) && ds.some(e => !e.tsumogiri));
});

test('读牌硬规则：最后一张出牌不是缺门，（不在他的回合时）手里一定没有缺门牌', () => {
  let checked = 0;
  for (const seed of [11, 12, 13, 14]) {
    eachState(seed, g => {
      for (const q of g.players) {
        if (q.seat === g.turn) continue;   // 轮到他时可能刚摸到缺门牌、还没打出
        const p = viewFor(g, (q.seat + 1) % 4).players[q.seat];
        if (!voidSurelyCleared(p)) continue;
        checked++;
        assert.ok(!q.hand.some(t => suitOf(t) === q.voidSuit), `座位 ${q.seat} 规则判定已打完缺门，手里却有缺门牌`);
      }
    }, 1);
  }
  assert.ok(checked > 100);
});

test('读牌只用可见信息：改动对手暗手不改变推断', () => {
  eachState(21, g => {
    const before = JSON.stringify(readAll(viewFor(g, 0)));
    const q = g.players[1];
    const saved = q.hand.slice();
    q.hand = q.hand.map(t => (t + 9) % 27);   // 换成别的牌，张数不变
    const after = JSON.stringify(readAll(viewFor(g, 0)));
    q.hand = saved;
    assert.equal(after, before);
  }, 7);
});

test('读牌：花色比例三门之和为 1，已打完的缺门为 0；期望张数不超过看不见的张数', () => {
  eachState(31, g => {
    const view = viewFor(g, 0);
    const vu = unseenCounts(view);
    const reads = readAll(view);
    for (const [seat, r] of Object.entries(reads)) {
      const p = view.players[seat];
      assert.ok(Math.abs(r.shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
      if (voidSurelyCleared(p)) assert.equal(r.shares[p.voidSuit], 0);
      assert.ok(r.pQing >= 0 && r.pQing <= 1);
      assert.ok(r.expect.every((x, k) => x >= 0 && x <= vu.unseen[k] + 1e-9));
      assert.ok(r.reasons.length >= 1);
    }
    const all = inHandsExpect(reads, vu.unseen);
    assert.ok(all.every((x, k) => x <= vu.unseen[k] + 1e-9));
  }, 5);
});

test('读牌：打掉很多某门牌的对手，那门比例低；同门碰两组的对手，点他那门的牌损失更高', () => {
  // 对手 1 缺万（已打完），条子打了很多、筒子一张没打，碰了两组筒
  const g = setup({
    hands: ['123456789m 1122s', '1155p 99p 2p', '123m 456m 789m 1s', '123m 456m 789m 2s'],
    voids: [2, 0, 0, 0],
    melds: [[], [{ kind: 'pong', tile: 18 + 2, from: 0 }, { kind: 'pong', tile: 18 + 6, from: 0 }]],
    wall: '1s 2s 3s 4s 5s 6s 7s 8s 9s'
  });
  const p1 = g.players[1];
  p1.discards = [0, 4, 8, 10, 12, 14, 16].map(t => ({ tile: t, claimed: false, tsumogiri: false }));
  p1.draws = 8;
  const view = viewFor(g, 0);
  const vp = view.players[1];
  const r = readOpponent(view, vp);
  assert.ok(r.shares[1] < r.shares[2], '条子打得多，筒子应占更多');
  assert.equal(r.top, 2);
  assert.ok(expectedLoss(vp, r, 18 + 4) > expectedLoss(vp, r, 9 + 4), '点他筒子应比点条子贵');
  const rows = suitRows(view, vp, unseenCounts(view).vis);
  assert.equal(rows[0], null, '缺门已打完');
  assert.ok(Math.abs(suitShares(rows).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('期望得分扣放炮代价：evRisk 的期望 = 不扣时的期望 − 代价', () => {
  eachState(41, g => {
    if (g.turn !== 0) return;
    const view = viewFor(g, 0);
    const a = evaluateDiscards(view, { ev: true, dangerModel: 'learned' }).rows;
    const b = evaluateDiscards(view, { ev: true, dangerModel: 'learned', evRisk: true }).rows;
    for (const r of b) {
      if (r.ev === undefined) continue;
      const base = a.find(x => x.tile === r.tile);
      assert.ok(r.risk >= 0);
      assert.ok(Math.abs(base.ev - r.risk - r.ev) < 0.002, `${r.tile}：${base.ev} − ${r.risk} ≠ ${r.ev}`);
    }
  }, 1);
});
