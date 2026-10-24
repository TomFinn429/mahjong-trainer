/* 复式自对弈：比较两种电脑配置
   同一副牌按若干座位排列各打一次（复式），抵消牌运。
   每副牌的值 = 「A 每座每局得分 − B 每座每局得分」在这些排列上的平均。报告均值和 95% 置信区间。

   用法：
     node tools/duplicate.mjs --a '{"level":3,"opts":{"mc":true}}' --b '{"level":3}' --decks 400
   参数：
     --a / --b        电脑配置 JSON：{ level, style, opts, seedOffset }
                      style 取 bots.mjs 的 STYLES（defender / bigHand / speed），opts 在其上覆盖；
                      seedOffset 改变电脑自身随机数，用于做无差距对照
     --field JSON     固定对手：A、B 各坐一个座位，另外两个座位坐这个配置；
                      也可以是两个配置的数组，依次坐两个对手座位（见下方 LINEUPS.field）
     --lineups NAME   座位排列：pair（默认，ABAB / BABA）、all6（两 A 两 B 的全部 6 种）
     --decks N        副牌数上限（默认 200）
     --start S        起始种子（默认 9001），同一组种子可复现
     --sprt m0,m1     序贯检验：H0 优势 = m0，H1 优势 = m1（单位同报告，分/座/局），α = β = 0.05；
                      至少打 --min-decks 副（默认 200）后开始判断，越过边界就停
     --workers W      并行线程数（默认 CPU 核数 − 1）
     --rules JSON     规则覆盖，例如 '{"exchangeThree":false}'
     --records FILE   把每局牌谱写成 JSONL（每行一局），用于统计 / 训练
     --note TEXT      写进登记行的备注
   实验结论请登记到 docs/experiments.md（脚本最后会打印一行可直接粘贴的表格行） */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { createWriteStream } from 'node:fs';
import { execSync } from 'node:child_process';
import { createGame } from '../src/game/engine.mjs';
import { createBot, runBots, STYLES } from '../src/ai/bots.mjs';
import { exportRecord } from '../src/game/record.mjs';

/* 每种排列：座位上坐谁（'A' / 'B' / 'F'），以及每局有几个 A 座位（用于折算成「每座」） */
const LINEUPS = {
  pair: [['A', 'B', 'A', 'B'], ['B', 'A', 'B', 'A']],
  all6: [['A', 'A', 'B', 'B'], ['A', 'B', 'A', 'B'], ['A', 'B', 'B', 'A'], ['B', 'A', 'A', 'B'], ['B', 'A', 'B', 'A'], ['B', 'B', 'A', 'A']],
  field: [['A', 'F', 'B', 'F'], ['B', 'F', 'A', 'F'], ['F', 'A', 'F', 'B'], ['F', 'B', 'F', 'A']]
};

const botOpts = c => ({ ...(c.style ? STYLES[c.style] : {}), ...(c.opts || {}) });

function playDeck(seed, cfg, lineups, rules, withRecords) {
  let sum = 0, ms = 0;
  const records = [];
  for (const lineup of lineups) {
    const g = createGame({ seed, dealer: seed % 4, rules });
    let f = 0;
    const seatCfg = lineup.map(who => (who === 'F' ? cfg.F[f++ % cfg.F.length] : cfg[who]));
    const bots = seatCfg.map((c, i) => createBot(c.level, seed * 10 + i + (c.seedOffset || 0), botOpts(c)));
    const t0 = performance.now();
    runBots(g, bots);
    ms += performance.now() - t0;
    const nA = lineup.filter(x => x === 'A').length;
    let a = 0, b = 0;
    g.players.forEach((p, i) => { if (lineup[i] === 'A') a += p.score; else if (lineup[i] === 'B') b += p.score; });
    sum += (a - b) / nA;
    if (withRecords) records.push(exportRecord(g, { players: seatCfg.map((c, i) => ({ kind: 'bot', role: lineup[i], ...c, opts: botOpts(c) })), note: `duplicate seed=${seed}` }));
  }
  return { seed, value: sum / lineups.length, ms, games: lineups.length, records };
}

if (!isMainThread) {
  const { cfg, lineups, rules, withRecords } = workerData;
  parentPort.on('message', seed => {
    if (seed === null) process.exit(0);
    parentPort.postMessage(playDeck(seed, cfg, lineups, rules, withRecords));
  });
  parentPort.postMessage({ ready: true });
} else {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith('--') ? acc.concat([[x.slice(2), all[i + 1]]]) : acc), []));
  const A = JSON.parse(args.a ?? '{"level":3}');
  const B = JSON.parse(args.b ?? '{"level":2}');
  const F = args.field ? JSON.parse(args.field) : null;
  const lineupName = F ? 'field' : (args.lineups ?? 'pair');
  if (!LINEUPS[lineupName]) throw new Error(`未知排列 ${lineupName}`);
  if (lineupName === 'field' && !F) throw new Error('field 排列需要 --field');
  const lineups = LINEUPS[lineupName];
  const decks = +(args.decks ?? 200);
  const start = +(args.start ?? 9001);
  const rules = args.rules ? JSON.parse(args.rules) : undefined;
  const sprt = args.sprt ? args.sprt.split(',').map(Number) : null;
  const minDecks = +(args['min-decks'] ?? 200);
  const workers = Math.max(1, Math.min(decks, +(args.workers ?? Math.max(1, cpus().length - 1))));
  const out = args.records ? createWriteStream(args.records) : null;
  const cfg = { A, B, F: F ? [].concat(F) : null };

  // 序贯检验（正态均值，方差用当前样本估计）：LLR = (m1 − m0) / σ² × (Σx − n(m0 + m1) / 2)
  const ALPHA = 0.05, BETA = 0.05;
  const lower = Math.log(BETA / (1 - ALPHA)), upper = Math.log((1 - BETA) / ALPHA);
  let n = 0, sx = 0, sxx = 0, ms = 0, games = 0, verdict = null, llr = 0;
  const stats = () => {
    const mean = sx / n;
    const sd = n > 1 ? Math.sqrt(Math.max(0, (sxx - n * mean * mean) / (n - 1))) : 0;
    return { mean, sd, ci: 1.96 * sd / Math.sqrt(n) };
  };

  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { cfg, lineups, rules, withRecords: !!out } });
    const feed = () => {
      if (verdict || next >= decks) { w.postMessage(null); return; }
      w.postMessage(start + next++);
    };
    w.on('message', r => {
      if (r.ready) return feed();
      if (!verdict) {
        n++; sx += r.value; sxx += r.value * r.value; ms += r.ms; games += r.games;
        if (out) for (const rec of r.records) out.write(JSON.stringify(rec) + '\n');
        if (sprt && n >= minDecks) {
          const { sd } = stats();
          const [m0, m1] = sprt;
          llr = sd > 0 ? (m1 - m0) / (sd * sd) * (sx - n * (m0 + m1) / 2) : 0;
          if (llr >= upper) verdict = 'H1';
          else if (llr <= lower) verdict = 'H0';
        }
        if (n % 100 === 0) process.stderr.write(`  ${n} 副${sprt && n >= minDecks ? `  LLR ${llr.toFixed(2)}（${lower.toFixed(2)} / ${upper.toFixed(2)}）` : ''}\n`);
      }
      feed();
    });
    w.on('error', reject);
    w.on('exit', code => (code ? reject(new Error(`worker 退出码 ${code}`)) : resolve()));
  })));
  if (out) out.end();

  const { mean, sd, ci } = stats();
  const fmt = x => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
  console.log(`A = ${JSON.stringify(A)}`);
  console.log(`B = ${JSON.stringify(B)}`);
  if (F) console.log(`对手池 = ${JSON.stringify(F)}`);
  console.log(`排列 ${lineupName}（每副 ${lineups.length} 局）；副牌 ${n}（种子从 ${start} 起）  A 相对 B：${fmt(mean)} ± ${ci.toFixed(3)} 分/座/局（95% CI），每副标准差 ${sd.toFixed(3)}`);
  if (sprt) console.log(`序贯检验 H0=${sprt[0]} / H1=${sprt[1]}：${verdict ? `接受 ${verdict}` : '未达到边界（打满上限）'}，LLR ${llr.toFixed(2)}`);
  console.log(`对局耗时：平均每局 ${(ms / games).toFixed(0)} ms（单线程计），共 ${games} 局，总墙钟 ${((performance.now() - t0) / 1000).toFixed(1)} s，线程 ${workers}`);
  let commit = '';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* 非仓库 */ }
  const dirty = (() => { try { return execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim() ? '+改动' : ''; } catch { return ''; } })();
  console.log(`登记行：| ${new Date().toISOString().slice(0, 10)} | ${commit}${dirty} | \`${JSON.stringify(A)}\` | \`${JSON.stringify(B)}\` | ${F ? `\`${JSON.stringify(F)}\`` : '—'} | ${lineupName} | ${start}+${n} | ${fmt(mean)} ± ${ci.toFixed(3)} | ${sprt ? (verdict ?? '未定') : '—'} | ${args.note ?? ''} |`);
}
