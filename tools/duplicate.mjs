/* 复式自对弈：比较两种电脑配置
   同一副牌，A B A B 隔座坐，打完换成 B A B A 再打一次（复式），抵消牌运。
   每副牌的值 = A 两次四座得分之和减 B 的，再除以 4，即「每座每局优势」。报告均值和 95% 置信区间。

   用法：
     node tools/duplicate.mjs --a '{"level":3,"opts":{"mc":true}}' --b '{"level":3}' --decks 400
   参数：
     --a / --b        电脑配置 JSON：{ level, opts }
     --decks N        副牌数（默认 200）
     --start S        起始种子（默认 9001），同一组种子可复现
     --workers W      并行线程数（默认 CPU 核数 − 1）
     --rules JSON     规则覆盖，例如 '{"exchangeThree":false}'
     --records FILE   把每局牌谱写成 JSONL（每行一局），用于统计 / 训练 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { createWriteStream } from 'node:fs';
import { createGame } from '../src/game/engine.mjs';
import { createBot, runBots } from '../src/ai/bots.mjs';
import { exportRecord } from '../src/game/record.mjs';

function playDeck(seed, A, B, rules, withRecords) {
  let diff = 0, ms = 0;
  const records = [];
  for (const lineup of [[A, B, A, B], [B, A, B, A]]) {
    const g = createGame({ seed, dealer: seed % 4, rules });
    const bots = lineup.map((c, i) => createBot(c.level, seed * 10 + i, c.opts));
    const t0 = performance.now();
    runBots(g, bots);
    ms += performance.now() - t0;
    g.players.forEach((p, i) => { diff += (lineup[i] === A ? 1 : -1) * p.score; });
    if (withRecords) records.push(exportRecord(g, { players: lineup.map(c => ({ kind: 'bot', ...c })), note: `duplicate seed=${seed}` }));
  }
  return { seed, value: diff / 4, ms, records };
}

if (!isMainThread) {
  const { seeds, A, B, rules, withRecords } = workerData;
  for (const seed of seeds) parentPort.postMessage(playDeck(seed, A, B, rules, withRecords));
} else {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith('--') ? acc.concat([[x.slice(2), all[i + 1]]]) : acc), []));
  const A = JSON.parse(args.a ?? '{"level":3}');
  const B = JSON.parse(args.b ?? '{"level":2}');
  const decks = +(args.decks ?? 200);
  const start = +(args.start ?? 9001);
  const rules = args.rules ? JSON.parse(args.rules) : undefined;
  const workers = Math.max(1, Math.min(decks, +(args.workers ?? Math.max(1, cpus().length - 1))));
  const out = args.records ? createWriteStream(args.records) : null;

  const seeds = Array.from({ length: decks }, (_, i) => start + i);
  const parts = Array.from({ length: workers }, (_, w) => seeds.filter((_, i) => i % workers === w));
  const values = [];
  let ms = 0;
  const t0 = performance.now();
  await Promise.all(parts.map(part => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { seeds: part, A, B, rules, withRecords: !!out } });
    w.on('message', r => {
      values.push(r.value); ms += r.ms;
      if (out) for (const rec of r.records) out.write(JSON.stringify(rec) + '\n');
      if (values.length % 50 === 0) process.stderr.write(`  ${values.length}/${decks}\n`);
    });
    w.on('error', reject);
    w.on('exit', code => (code ? reject(new Error(`worker 退出码 ${code}`)) : resolve()));
  })));
  if (out) out.end();

  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const ci = 1.96 * sd / Math.sqrt(n);
  console.log(`A = ${JSON.stringify(A)}`);
  console.log(`B = ${JSON.stringify(B)}`);
  console.log(`副牌 ${n}（种子 ${start}–${start + decks - 1}）  A 相对 B：${mean >= 0 ? '+' : ''}${mean.toFixed(3)} ± ${ci.toFixed(3)} 分/座/局（95% CI）`);
  console.log(`对局耗时：平均每局 ${(ms / n / 2).toFixed(0)} ms（单线程计），总墙钟 ${((performance.now() - t0) / 1000).toFixed(1)} s，线程 ${workers}`);
}
