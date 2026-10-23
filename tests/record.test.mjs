import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/game/engine.mjs';
import { createBot, runBots } from '../src/ai/bots.mjs';
import { exportRecord, replayRecord, decisionSamples, RECORD_FORMAT } from '../src/game/record.mjs';

function botGame(seed, level = 3, rules) {
  const g = createGame({ seed, dealer: seed % 4, rules });
  const players = [0, 1, 2, 3].map(i => ({ kind: 'bot', level }));
  runBots(g, [0, 1, 2, 3].map(i => createBot(level, seed * 10 + i)));
  return exportRecord(g, { players, createdAt: '2026-10-23T00:00:00.000Z' });
}

test('牌谱：导出 → JSON 往返 → 重放，事件流与结果完全一致', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rec = JSON.parse(JSON.stringify(botGame(seed, 1 + seed % 3, { exchangeThree: seed % 2 === 0 })));
    assert.equal(rec.format, RECORD_FORMAT);
    const g = replayRecord(rec);
    assert.equal(g.phase, 'end');
    assert.deepEqual(g.result, rec.result);
    assert.deepEqual(g.history, rec.decisions);
  }
});

test('牌谱：动作被改动时重放报错', () => {
  const rec = botGame(5);
  const i = rec.decisions.findIndex(d => d.action.type === 'discard');
  const other = rec.decisions.find((d, j) => j > i + 4 && d.action.type === 'discard' && d.seat === rec.decisions[i].seat);
  rec.decisions[i] = { ...rec.decisions[i], action: { ...other.action } };
  assert.throws(() => replayRecord(rec), /重放不一致|非法动作|无需决策/);
});

test('牌谱：事件被改动时重放报出第一处差异', () => {
  const rec = botGame(6);
  rec.events[10] = { ...rec.events[10], tampered: true };
  assert.throws(() => replayRecord(rec), /事件 10/);
});

test('决策样本：每个决定一条，动作合法，看不到别家未胡的手牌', () => {
  const rec = botGame(7, 3, { exchangeThree: true });
  const samples = decisionSamples(rec);
  assert.equal(samples.length, rec.decisions.length);
  for (const s of samples) {
    if (s.action.type !== 'exchange') assert.ok(s.legal.some(l => l.type === s.action.type && (l.tile === undefined || l.tile === s.action.tile)), '动作应在合法列表里');
    assert.ok(Array.isArray(s.view.players[s.seat].hand));
    for (const p of s.view.players) if (p.seat !== s.seat && !p.won) assert.equal(p.hand, null);
    assert.equal(s.view.log, undefined);
  }
  assert.ok(decisionSamples(rec, { seats: [2] }).every(s => s.seat === 2));
});
