/* ============================================================
   牌谱：一局血战到底的可重放记录（纯 JSON）
   - 重放只需要 seed + dealer + rules + decisions（引擎是确定性的）
   - events 是全知视角的完整事件流，用于重放校验与统计；
     不需要另行保存 view：重放时用 viewFor() 按座位还原当时的可见信息
   - 统计读牌 / 模仿学习：decisionSamples() 逐个决定给出「当时可见信息 + 合法动作 + 实际动作」
   格式说明见 docs/game-record.md
   ============================================================ */
import { createGame, submit, viewFor } from './engine.mjs';

export const RECORD_FORMAT = 'mahjong-trainer/xuezhan-record';
export const RECORD_VERSION = 1;

/* meta.players：每个座位是谁，例如 [{ kind: 'human' }, { kind: 'bot', level: 3, opts: {...} }, ...] */
export function exportRecord(g, meta = {}) {
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    seed: g.seed,
    seedText: meta.seedText ?? null,
    dealer: g.dealer,
    rules: JSON.parse(JSON.stringify(g.rules)),
    players: meta.players ?? null,
    note: meta.note ?? null,
    decisions: g.history.map(h => ({ ...h, action: JSON.parse(JSON.stringify(h.action)) })),
    events: JSON.parse(JSON.stringify(g.log)),
    result: g.result ? JSON.parse(JSON.stringify(g.result)) : null
  };
}

export function checkRecord(rec) {
  if (!rec || rec.format !== RECORD_FORMAT) throw new Error('不是本项目的牌谱');
  if (rec.version !== RECORD_VERSION) throw new Error(`不支持的牌谱版本 ${rec.version}（当前 ${RECORD_VERSION}）`);
  if (!Array.isArray(rec.decisions)) throw new Error('牌谱缺少 decisions');
}

/* 按牌谱重放。onDecision({ g, seat, phase, action, index }) 在每个决定提交前调用，此时 g 是做决定那一刻的状态。
   events 存在时逐条比对，引擎改动导致不一致会报出第一处差异 */
export function replayRecord(rec, { onDecision, verify = true } = {}) {
  checkRecord(rec);
  const g = createGame({ seed: rec.seed, dealer: rec.dealer, rules: rec.rules });
  rec.decisions.forEach((d, index) => {
    if (verify && d.seq !== g.log.length) throw new Error(`重放不一致：第 ${index} 个决定应在事件 ${d.seq} 处，实际 ${g.log.length}`);
    if (onDecision) onDecision({ g, seat: d.seat, phase: d.phase, action: d.action, index });
    submit(g, d.seat, d.action);
  });
  if (verify && rec.events) {
    const n = Math.max(rec.events.length, g.log.length);
    for (let i = 0; i < n; i++) {
      const a = JSON.stringify(rec.events[i]), b = JSON.stringify(g.log[i]);
      if (a !== b) throw new Error(`重放不一致：事件 ${i}\n  牌谱：${a}\n  重放：${b}`);
    }
  }
  return g;
}

/* 决策样本：每个决定一条，只含该座位当时可见的信息（不含事件流和规则，牌河顺序已在 discards 里） */
export function decisionSamples(rec, { seats } = {}) {
  const out = [];
  replayRecord(rec, {
    onDecision({ g, seat, phase, action, index }) {
      if (seats && !seats.includes(seat)) return;
      const { log, actions, rules, ...view } = viewFor(g, seat);
      out.push({ index, seat, phase, view, legal: actions, action });
    }
  });
  return out;
}
