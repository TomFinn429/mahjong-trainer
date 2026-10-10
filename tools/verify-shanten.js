/* 独立参考实现：用「距离定义」算向听，和 index.html 里的递归分解对照
   定义：shanten = (补出某个和牌型还缺几张牌) - 1
   和牌型 = 4 面子 + 1 将，或 七对（4 张算两对）
   运行：node tools/verify-shanten.js */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/\/\/ __CORE_START__([\s\S]*?)\/\/ __CORE_END__/)[1];
const mod = new Module('c');
mod._compile(src, 'c.js');
const C = mod.exports;

/* ---------- 所有可能的面子 ---------- */
const MELDS = [];
for (let s = 0; s < 3; s++) {
  for (let r = 0; r < 9; r++) MELDS.push([s * 9 + r, s * 9 + r, s * 9 + r]);       // 刻子
  for (let r = 0; r + 2 < 9; r++) MELDS.push([s * 9 + r, s * 9 + r + 1, s * 9 + r + 2]); // 顺子
}

/* ---------- 距离定义的向听（13 张） ---------- */
function refShanten13(counts) {
  let best = 99;
  const cur = new Array(27).fill(0);

  const needed = () => {
    let n = 0;
    for (let i = 0; i < 27; i++) if (cur[i] > counts[i]) n += cur[i] - counts[i];
    return n;
  };

  function withPair() {
    for (let p = 0; p < 27; p++) {
      cur[p] += 2;
      const v = needed() - 1;
      if (v < best) best = v;
      cur[p] -= 2;
    }
  }

  function rec(left, from) {
    if (needed() - 1 >= best) return;          // 单调剪枝
    if (left === 0) { withPair(); return; }
    for (let i = from; i < MELDS.length; i++) {
      for (const k of MELDS[i]) cur[k]++;
      rec(left - 1, i);
      for (const k of MELDS[i]) cur[k]--;
    }
  }
  rec(4, 0);

  // 七对
  let pairsNeeded = 0, kinds = counts.filter(x => x > 0).length;
  let p = 0; for (let i = 0; i < 27; i++) p += (counts[i] / 2) | 0;
  // 需要凑到 7 对；4 张同牌算两对
  pairsNeeded = Math.max(0, 7 - Math.min(p, 7));
  const sevenPairs = Math.max(0, pairsNeeded) + Math.max(0, 7 - kinds - Math.max(0, 7 - p)) - 1;
  // 更直接：需要的牌数 = 每对缺的补张
  let needTiles = 0, havePairs = 0;
  for (let i = 0; i < 27; i++) {
    const c = counts[i];
    const pairCnt = (c / 2) | 0;
    havePairs += pairCnt;
    if (c % 2 === 1) needTiles += 1;            // 单张补成对
  }
  const extraPairs = Math.max(0, 7 - havePairs);
  const seven = needTiles + Math.max(0, extraPairs - needTiles) * 1 - 1;
  // 稳妥起见用搜索算七对
  const sp = searchSeven(counts);
  if (sp < best) best = sp;
  return best;
}

/* 七对：最少补几张牌能凑成 7 对（4 张算两对） */
function searchSeven(counts) {
  let n = 0, p = 0;
  for (let i = 0; i < 27; i++) { n += counts[i]; p += (counts[i] / 2) | 0; }
  if (n < 13) return 99;
  // 13 张：需要补到 7 对 → 缺 (7-p) 对；单张数为 odd
  // 每补一张到某个单张上就多一对；剩下还缺的对需要 2 张
  let odd = 0;
  for (let i = 0; i < 27; i++) if (counts[i] % 2 === 1) odd++;
  // 优先用单张补对：能用 min(odd, 7-p) 对
  const useSingles = Math.min(odd, Math.max(0, 7 - p));
  const remainPairs = Math.max(0, 7 - p - useSingles);
  const needTiles = useSingles + remainPairs * 2;
  return needTiles - 1;
}

/* 14 张：取所有弃牌后的最小值 */
function refShanten(counts, size) {
  if (size === 13) return refShanten13(counts);
  let best = 99;
  for (let i = 0; i < 27; i++) {
    if (counts[i] === 0) continue;
    const c = counts.slice(); c[i]--;
    best = Math.min(best, refShanten13(c));
  }
  return best;
}

/* ---------- 对照 ---------- */
function toCounts(tiles) { const c = new Array(27).fill(0); for (const t of tiles) c[t]++; return c; }
function name(counts) {
  const out = [];
  for (let s = 0; s < 3; s++) {
    const a = [];
    for (let r = 0; r < 9; r++) for (let k = 0; k < counts[s * 9 + r]; k++) a.push(r + 1);
    if (a.length) out.push(a.join('') + 'msp'[s]);
  }
  return out.join(' ');
}
function randHand(n, suitN) {
  const pool = [];
  const maxSuit = suitN === 2 ? 2 : 3;
  for (let i = 0; i < 27; i++) {
    if ((i / 9 | 0) >= maxSuit) continue;
    for (let j = 0; j < 4; j++) pool.push(i);
  }
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n).sort((a, b) => a - b);
}

console.log('=== 先验算你那张图的四个关键点 ===');
const cases = [
  ['2条55条6条8条9条 22筒3筒4筒6筒7筒8筒8筒 (14张)', [10, 13, 13, 14, 16, 17, 19, 19, 20, 21, 23, 24, 25, 25]],
  ['打9条后 (13张)', [10, 13, 13, 14, 16, 19, 19, 20, 21, 23, 24, 25, 25]],
  ['打9条后+摸4条 (14张)', [10, 12, 13, 13, 14, 16, 19, 19, 20, 21, 23, 24, 25, 25]],
  ['打9条后+摸7条 (14张)', [10, 13, 13, 14, 15, 16, 19, 19, 20, 21, 23, 24, 25, 25]],
];
for (const [label, hand] of cases) {
  const c = toCounts(hand);
  const size = hand.length;
  console.log(`  ${label}`);
  console.log(`     代码 shanten = ${C.shanten(c)}   参考实现 = ${refShanten(c, size)}`);
}

console.log('\n=== 随机对照（13 张）===');
let bad = 0, n = 0, shown = 0;
const t0 = Date.now();
for (let i = 0; i < 300; i++) {
  const hand = randHand(13, i % 2 ? 2 : 3);
  const c = toCounts(hand);
  const a = C.shanten(c), b = refShanten13(c);
  n++;
  if (a !== b) {
    bad++;
    if (shown < 8) { console.log(`  ✗ ${name(c)}  代码=${a} 参考=${b}`); shown++; }
  }
}
console.log(`  共 ${n} 组，不一致 ${bad} 组，用时 ${Date.now() - t0}ms`);
process.exit(0);
