/* ============================================================
   川麻核心算法（训练器、对局引擎、Node 自检共用）
   - 浏览器经典脚本：<script src> 加载，顶层函数即全局（file:// 可用）
   - ES 模块：经 src/core/core.mjs 包装（读取 globalThis.MJCore）
   - Node：require() 拿 module.exports
   ============================================================ */
/* ============================================================
   核心算法：27 种牌 0..26
   0-8 = 万1-9 | 9-17 = 条1-9 | 18-26 = 筒1-9
   ============================================================ */
const SUIT_CN = ['万', '条', '筒'];
const SUIT_EN = ['m', 's', 'p'];
const suitOf = k => (k / 9) | 0;
const rankOf = k => (k % 9) + 1;
const tileCN = k => rankOf(k) + SUIT_CN[suitOf(k)];
const tileEN = k => rankOf(k) + SUIT_EN[suitOf(k)];

const _stdCache = new Map();
const STD_CACHE_MAX = 200000;

/* 标准型向听数：need 个面子 + 1 雀头（need = 4 − 副露数）
   公式 shanten = 2×need − 2×面子 − min(搭子, need−面子) − 雀头
   返回 -1 表示已和牌，0 表示听牌 */
function shantenStd(counts, need) {
  if (need === undefined) need = 4;
  const key = need + '|' + counts.join('');
  const hit = _stdCache.get(key);
  if (hit !== undefined) return hit;

  let best = 2 * need;
  const t = counts.slice();
  let rem = 0;
  for (let i = 0; i < 27; i++) rem += t[i];

  function dfs(i, m, ta, pair, rem) {
    // 乐观下界：剩余牌全变成面子，且总有雀头。若仍不如已知最优则剪掉
    const mF = Math.min(need, m + ((rem / 3) | 0));
    const opti = 2 * need - 2 * mF - Math.min(ta + ((rem / 2) | 0), need - mF) - 1;
    if (opti >= best) return;

    while (i < 27 && t[i] === 0) i++;
    if (i === 27) {
      const u = Math.min(ta, need - m);
      const sh = 2 * need - 2 * m - u - (pair ? 1 : 0);
      if (sh < best) best = sh;
      return;
    }
    const r = i % 9;
    if (m < need) {
      if (t[i] >= 3) {                       // 刻子
        t[i] -= 3; dfs(i, m + 1, ta, pair, rem - 3); t[i] += 3;
      }
      if (r <= 6 && t[i + 1] > 0 && t[i + 2] > 0) {   // 顺子
        t[i]--; t[i + 1]--; t[i + 2]--;
        dfs(i, m + 1, ta, pair, rem - 3);
        t[i]++; t[i + 1]++; t[i + 2]++;
      }
    }
    if (t[i] >= 2) {
      if (!pair) { t[i] -= 2; dfs(i, m, ta, true, rem - 2); t[i] += 2; }  // 作雀头
      t[i] -= 2; dfs(i, m, ta + 1, pair, rem - 2); t[i] += 2;             // 作对子搭子
    }
    if (r <= 7 && t[i + 1] > 0) {          // 两面/边张搭子
      t[i]--; t[i + 1]--; dfs(i, m, ta + 1, pair, rem - 2); t[i]++; t[i + 1]++;
    }
    if (r <= 6 && t[i + 2] > 0) {          // 嵌张搭子
      t[i]--; t[i + 2]--; dfs(i, m, ta + 1, pair, rem - 2); t[i]++; t[i + 2]++;
    }
    t[i]--; dfs(i, m, ta, pair, rem - 1); t[i]++;   // 弃置
  }
  dfs(0, 0, 0, false, rem);

  if (_stdCache.size >= STD_CACHE_MAX) _stdCache.clear();   // 防止长时间对局 / 自对弈时缓存无限增长
  _stdCache.set(key, best);
  return best;
}

/* 七对型向听数（川麻：4 张同牌算两对，即龙七对）
   13/14 张时：shanten = 6 - 总对数。牌数不足 13 时不做七对评估 */
function shanten7(counts) {
  let n = 0, pairs = 0;
  for (let i = 0; i < 27; i++) { n += counts[i]; pairs += (counts[i] / 2) | 0; }
  if (n < 13) return 99;
  return 6 - Math.min(pairs, 7);
}

function shanten(counts, openN) {
  if (openN === undefined) openN = 0;
  const need = 4 - openN;
  if (need < 0) return 99;
  let s = shantenStd(counts, need);
  if (openN === 0) s = Math.min(s, shanten7(counts));
  return s;
}

function ukeire(counts, keepSuits, openN, visible) {
  if (openN === undefined) openN = 0;
  const base = shanten(counts, openN);
  const list = [];
  let total = 0;
  for (let k = 0; k < 27; k++) {
    if (keepSuits && !keepSuits[suitOf(k)]) continue;
    const seen = counts[k] + (visible ? visible[k] : 0);
    if (seen >= 4) continue;
    const c = counts.slice();
    c[k]++;
    if (shanten(c, openN) < base) { list.push(k); total += 4 - seen; }
  }
  return { base, list, total };
}

/* ---------- 拆块：把牌拆成 面子 / 搭子 / 将 / 孤张 ----------
   目标：2×面子 + 搭子 + 将 最大（即向听最小）；平手时孤张最少
   约束：面子 + 搭子 ≤ 4；同一张牌只能用一次 */
function decompose(counts, openN) {
  if (openN === undefined) openN = 0;
  const need = 4 - openN;
  const total = counts.reduce((a, b) => a + b, 0);
  const cur = counts.slice();
  const melds = [], taatsu = [];
  let pair = null, best = null;

  function evaluate() {
    const m = melds.length;
    const t = Math.min(taatsu.length, Math.max(0, need - m));
    const p = pair ? 1 : 0;
    const shanten = 2 * need - 2 * m - t - p;
    const used = new Array(27).fill(0);
    melds.forEach(x => x.forEach(k => used[k]++));
    taatsu.slice(0, t).forEach(x => x.forEach(k => used[k]++));
    if (pair) pair.forEach(k => used[k]++);
    const floats = [];
    for (let i = 0; i < 27; i++) for (let j = 0; j < counts[i] - used[i]; j++) floats.push(i);

    if (!best || shanten < best.shanten ||
        (shanten === best.shanten && m > best.m) ||
        (shanten === best.shanten && m === best.m && floats.length < best.floats.length)) {
      best = {
        shanten, m, t, p,
        melds: melds.map(x => x.slice()),
        taatsu: taatsu.slice(0, t).map(x => x.slice()),
        pair: pair ? pair.slice() : null,
        floats
      };
    }
  }

  function dfs(i) {
    while (i < 27 && cur[i] === 0) i++;
    if (i === 27) { evaluate(); return; }
    const r = i % 9;
    if (melds.length < need) {
      if (cur[i] >= 3) { cur[i] -= 3; melds.push([i, i, i]); dfs(i); melds.pop(); cur[i] += 3; }
      if (r <= 6 && cur[i + 1] > 0 && cur[i + 2] > 0) {
        cur[i]--; cur[i + 1]--; cur[i + 2]--;
        melds.push([i, i + 1, i + 2]); dfs(i); melds.pop();
        cur[i]++; cur[i + 1]++; cur[i + 2]++;
      }
    }
    if (melds.length + taatsu.length < need || (need === 0 && !pair)) {
      if (cur[i] >= 2) {
        if (!pair) { cur[i] -= 2; pair = [i, i]; dfs(i); pair = null; cur[i] += 2; }
        cur[i] -= 2; taatsu.push([i, i]); dfs(i); taatsu.pop(); cur[i] += 2;
      }
      if (r <= 7 && cur[i + 1] > 0) {
        cur[i]--; cur[i + 1]--; taatsu.push([i, i + 1]); dfs(i); taatsu.pop(); cur[i]++; cur[i + 1]++;
      }
      if (r <= 6 && cur[i + 2] > 0) {
        cur[i]--; cur[i + 2]--; taatsu.push([i, i + 2]); dfs(i); taatsu.pop(); cur[i]++; cur[i + 2]++;
      }
    }
    cur[i]--; dfs(i); cur[i]++;
  }
  dfs(0);

  // 七对更近时改走七对视角（仅门清）
  const s7 = openN === 0 ? shanten7(counts) : 99;
  if (openN === 0 && total >= 13 && s7 < best.shanten) {
    const pairs = [], used = new Array(27).fill(0);
    for (let i = 0; i < 27; i++) for (let k = 0; k < ((counts[i] / 2) | 0); k++) { pairs.push([i, i]); used[i] += 2; }
    const floats = [];
    for (let i = 0; i < 27; i++) for (let k = 0; k < counts[i] - used[i]; k++) floats.push(i);
    return { shanten: s7, seven: true, pairs, floats, m: 0, t: 0, p: 0 };
  }
  return best;
}

/* 一张孤张的「改良路线」：能和它配成搭子/对子的牌 */
function floatPotential(f, counts) {
  const s = suitOf(f), out = [];
  const add = (c, label) => {
    if (c < 0 || c > 26 || suitOf(c) !== s) return;
    const rem = 4 - counts[c];
    if (rem <= 0) return;
    out.push({ tile: c, rem, label });
  };
  add(f, '成对');
  add(f - 1, '搭子'); add(f + 1, '搭子');
  add(f - 2, '嵌张'); add(f + 2, '嵌张');
  return out;
}

/* 块的可读名字，如 678万 / 333筒 */
function blockName(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  return a.map(k => (k % 9) + 1).join('') + SUIT_CN[suitOf(a[0])];
}

function toCounts(tiles) {
  const c = new Array(27).fill(0);
  for (const t of tiles) c[t]++;
  return c;
}

/* 手牌分组（按花色），返回 [[tile,...],[...],...] */
function groupSuits(tiles) {
  const g = [[], [], []];
  for (const t of tiles) g[suitOf(t)].push(t);
  for (const a of g) a.sort((x, y) => x - y);
  return g;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 从指定花色里发 n 张“像真的一样”的牌 */
function deal(n, suitIdxs) {
  const pool = [];
  for (let k = 0; k < 27; k++) {
    if (suitIdxs.indexOf(suitOf(k)) >= 0) for (let i = 0; i < 4; i++) pool.push(k);
  }
  shuffle(pool);
  return pool.slice(0, n).sort((a, b) => a - b);
}

/* ---------- 出题 ---------- */

// ② 何切：按缺一门约束发牌（手牌张数 = 14 − 3×副露数）
function genCut(diff, needVoid, withRiver, openN) {
  openN = openN || 0;
  const size = 14 - 3 * openN;
  if (size < 2) return null;
  const suits = needVoid ? pick2() : [0, 1, 2];
  const keep = [false, false, false];
  for (const s of suits) keep[s] = true;

  for (let attempt = 0; attempt < 320; attempt++) {
    const hand = deal(size, suits);
    if (shanten(toCounts(hand), openN) > 4) continue;
    const river = withRiver ? genRiver(hand, 12 + ((Math.random() * 10) | 0), suits) : null;
    const { options, best } = analyzeCut(hand, keep, openN, river);
    if (!best) continue;
    if (best.shanten < 0) continue;

    // 难度门槛
    if (diff === 1 && (best.shanten < 1 || best.shanten > 3)) continue;
    if (diff === 2 && (best.shanten > 2)) continue;
    if (diff === 3 && best.shanten > 2) continue;

    const minU = diff === 1 ? 6 : diff === 2 ? 4 : 2;
    if (best.ukeire < minU) continue;

    // 与同向听的次优解拉开差距，避免出“都对”的糊题
    const sameSh = options.filter(o => o.shanten === best.shanten);
    const sorted = sameSh.slice().sort((a, b) => b.ukeire - a.ukeire);
    const gap = sorted.length > 1 ? sorted[0].ukeire - sorted[1].ukeire : 99;
    const need = diff === 1 ? 3 : diff === 2 ? 1 : 0;
    if (gap < need) continue;

    return { hand, options, best, keep, river };
  }
  return null;
}

/* 定缺评分：多目标排序（越靠前权重越高）
   ① 清缺速度：缺门在手张数（少者优，因为要一张张打掉）
   ② 剩余牌效：剩下两门的向听数（低者优）
   ③ 有效牌数量：剩下两门能降向听的牌（多者优，已扣手上）
   ④ 搭子质量：拆块后的两面/对子/嵌张/边张（好者优） */
function voidEval(hand) {
  const rows = [0, 1, 2].map(s => {
    const rest = new Array(27).fill(0);
    const keep = [false, false, false];
    for (let i = 0; i < 3; i++) keep[i] = (i !== s);
    let k = 0;
    for (const t of hand) { if (suitOf(t) === s) k++; else rest[t]++; }
    const sh = Math.min(shantenStd(rest, 4), shanten7(rest));
    const u = ukeire(rest, keep, 0, null);
    const d = decompose(rest, 0);
    let shape;
    if (d.seven) {
      shape = d.pairs.length;                              // 七对路线：每对算 1 分
    } else {
      shape = d.pair ? 1 : 0;
      d.taatsu.forEach(tt => {
        if (tt[0] === tt[1]) shape += 2;                       // 对子（川麻可碰）
        else if (tt[1] - tt[0] === 1) shape += (tt[0] % 9 === 0 || tt[1] % 9 === 8) ? 1 : 2;  // 边张 1 / 两面 2
        else shape += 1;                                        // 嵌张
      });
    }
    return { suit: s, k, sh, uke: u.total, shape };
  });
  rows.sort((a, b) => a.k - b.k || a.sh - b.sh || b.uke - a.uke || b.shape - a.shape);
  const b = rows[0];
  rows.forEach(r => { r.best = (r.k === b.k && r.sh === b.sh && r.uke === b.uke && r.shape === b.shape); });
  return rows;
}

// ① 定缺：13 张三门。难度 = 最优方案靠哪一项胜出
// 入门(1) 比张数；进阶(2) 张数相同、比向听；高手(3) 张数/向听都相同、比有效牌与好形
function genVoid(diff) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const hand = deal(13, [0, 1, 2]);
    const rows = voidEval(hand);
    const a = rows[0], b = rows[1];
    const tier = a.k !== b.k ? 1
      : a.sh !== b.sh ? 2
      : (a.uke !== b.uke || a.shape !== b.shape) ? 3 : 0;
    if (tier !== diff) continue;
    if (a.k === 0) continue;      // 一门都没牌，太送分
    return { hand, rows };
  }
  return null;
}

// ③ 听牌点数：直接构造听牌型（3 面子 + 雀头 + 搭子，或 4 面子 + 单张）
function genTen(diff, needVoid, tenWaits, openN) {
  openN = openN || 0;
  const need = 4 - openN;
  if (need < 1) return null;
  const size = 13 - 3 * openN;
  const suits = needVoid ? pick2() : [0, 1, 2];
  let want = diff === 1 ? [1, 5] : diff === 2 ? [2, 9] : [3, 9];
  if (tenWaits === 1) want = [1, 1];
  else if (tenWaits === 2) want = [2, 2];
  else if (tenWaits === 3) want = [3, 9];
  const relaxAllowed = !(tenWaits === 1 || tenWaits === 2 || tenWaits === 3);

  for (let round = 0; round < 3; round++) {
    const pad = relaxAllowed ? round : 0;
    for (let attempt = 0; attempt < 260; attempt++) {
      const c = new Array(27).fill(0);
      const add = (arr) => {
        const tmp = c.slice();
        for (const k of arr) { if (tmp[k] >= 4) return false; tmp[k]++; }
        for (let i = 0; i < 27; i++) c[i] = tmp[i];
        return true;
      };
      const rnd = () => {
        const s = suits[(Math.random() * suits.length) | 0];
        return s * 9 + ((Math.random() * 9) | 0);
      };

      let bad = false;
      const nMeld = Math.random() < 0.35 ? need : need - 1;
      for (let i = 0; i < nMeld && !bad; i++) {
        let done = false;
        for (let tryN = 0; tryN < 40 && !done; tryN++) {
          const k = rnd();
          if (Math.random() < 0.45) { if (add([k, k, k])) done = true; }
          else if (k % 9 <= 6) { if (add([k, k + 1, k + 2])) done = true; }
        }
        if (!done) bad = true;
      }
      if (bad) continue;

      if (nMeld === need - 1) {
        let done = false;
        for (let tryN = 0; tryN < 40 && !done; tryN++) { const k = rnd(); if (add([k, k])) done = true; }
        if (!done) continue;
        let done2 = false;
        for (let tryN = 0; tryN < 80 && !done2; tryN++) {
          const k = rnd();
          const gap = 1 + ((Math.random() * 2) | 0);
          if (k % 9 + gap <= 8 && add([k, k + gap])) done2 = true;
        }
        if (!done2) continue;
      } else {
        let done = false;
        for (let tryN = 0; tryN < 40 && !done; tryN++) { const k = rnd(); if (add([k])) done = true; }
        if (!done) continue;
      }

      const hand = [];
      for (let i = 0; i < 27; i++) for (let j = 0; j < c[i]; j++) hand.push(i);
      if (hand.length !== size) continue;

      const keep = [false, false, false];
      for (const s of suits) keep[s] = true;
      const u = ukeire(c, keep, openN);
      if (u.base !== 0) continue;

      const lo = want[0] - pad, hi = want[1] + pad;
      if (u.list.length < Math.max(1, lo) || u.list.length > hi) continue;
      return { hand, u, keep };
    }
  }
  return null;
}

function pick2() {
  const p = shuffle([0, 1, 2]);
  return [p[0], p[1]];
}

/* 对 14 张手牌枚举所有可打的牌，返回每种打法的结果 */
function analyzeCut(hand, keepSuits, openN, visible) {
  if (openN === undefined) openN = 0;
  const counts = toCounts(hand);
  const options = [];
  for (let k = 0; k < 27; k++) {
    if (counts[k] === 0) continue;
    const c = counts.slice();
    c[k]--;
    const u = ukeire(c, keepSuits, openN, visible);
    options.push({ tile: k, shanten: u.base, ukeire: u.total, eff: u.list });
  }
  options.sort((a, b) => a.shanten - b.shanten || b.ukeire - a.ukeire || a.tile - b.tile);
  const best = options.length ? { shanten: options[0].shanten, ukeire: options[0].ukeire } : null;
  return { options, best };
}

/* 番型提示（用于训练时的附加认知） */
function shapeTags(counts) {
  const tags = [];
  let kinds = 0, pairs = 0, total = 0;
  for (let i = 0; i < 27; i++) { if (counts[i]) kinds++; total += counts[i]; }
  for (let i = 0; i < 27; i++) pairs += (counts[i] / 2) | 0;
  const suitsUsed = [0, 1, 2].filter(s => counts.slice(s * 9, s * 9 + 9).some(x => x > 0)).length;
  if (suitsUsed === 1) tags.push('清一色（×2）');
  if (pairs >= 5) tags.push('七对方向');
  if (kinds <= 7 && total >= 13) tags.push('对对胡方向');
  return tags;
}

/* ============================================================
   和牌判定 + 番型识别 + 计分（川麻）
   ============================================================ */

/* 把 counts 拆成 n 个面子。mode: 'any' 任意 | 'triplet' 全刻 | 'yao' 带幺 */
function tryMelds(c, n, mode) {
  let i = 0; while (i < 27 && c[i] === 0) i++;
  if (n === 0) return i >= 27;
  if (i >= 27) return false;
  const r = i % 9;
  if (mode !== 'yao' || r === 0 || r === 8) {
    if (c[i] >= 3) {
      c[i] -= 3;
      if (tryMelds(c, n - 1, mode)) { c[i] += 3; return true; }
      c[i] += 3;
    }
  }
  if (mode !== 'triplet' && (mode !== 'yao' || r === 0 || r === 6)) {
    if (r <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      if (tryMelds(c, n - 1, mode)) { c[i]++; c[i + 1]++; c[i + 2]++; return true; }
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
  }
  return false;
}

/* 和牌判定：counts 为门内手牌，openN 为副露面子数 */
function isWinHand(counts, openN) {
  if (openN === undefined) openN = 0;
  const need = 4 - openN;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== 3 * need + 2) return false;
  if (need === 0) return counts.some(x => x === 2);   // 4 副露后只剩将（金钩钓），两张必须成对
  if (openN === 0) {
    let allEven = true, pairs = 0;
    for (let i = 0; i < 27; i++) { if (counts[i] % 2) { allEven = false; break; } pairs += counts[i] / 2; }
    if (allEven && pairs === 7) return true;
  }
  for (let p = 0; p < 27; p++) {
    if (counts[p] >= 2) {
      const c = counts.slice(); c[p] -= 2;
      if (tryMelds(c, need, 'any')) return true;
    }
  }
  return false;
}

/* 番数表默认值（按你的牌桌约定） */
const DEFAULT_FAN = {
  ping_hu: 0, dui_dui_hu: 1, qi_dui: 2, long_qi_dui: 3,
  qing_yi_se: 2, quan_dai_yao: 2, duan_yao_jiu: 1, jin_gou_diao: 2,
  gen: 1, gang_shang_hua: 1, gang_shang_pao: 1, qiang_gang: 1,
  hai_di: 1, zi_mo: 1, tian_hu: 0, di_hu: 0
};
const FAN_LABEL = {
  ping_hu: '平胡', dui_dui_hu: '对对胡', qi_dui: '七对', long_qi_dui: '龙七对',
  qing_yi_se: '清一色', quan_dai_yao: '全带幺', duan_yao_jiu: '断幺九',
  jin_gou_diao: '金钩钓', gen: '根（四归一）', gang_shang_hua: '杠上花',
  gang_shang_pao: '杠上炮', qiang_gang: '抢杠胡', hai_di: '海底捞月',
  zi_mo: '自摸', tian_hu: '天胡', di_hu: '地胡'
};
const FAN_ORDER = ['ping_hu', 'dui_dui_hu', 'qi_dui', 'long_qi_dui', 'qing_yi_se',
  'quan_dai_yao', 'duan_yao_jiu', 'jin_gou_diao', 'gen',
  'gang_shang_hua', 'gang_shang_pao', 'qiang_gang', 'hai_di', 'zi_mo', 'tian_hu', 'di_hu'];
const HAND_YAKU = ['qi_dui', 'long_qi_dui', 'qing_yi_se', 'dui_dui_hu',
  'jin_gou_diao', 'duan_yao_jiu', 'quan_dai_yao'];

/* 番型识别。opts = { melds:[{kind,tile}], ctx:{zimo,gangShangHua,...} } */
function detectYaku(counts, opts) {
  opts = opts || {};
  const melds = opts.melds || [];
  const ctx = opts.ctx || {};
  const openN = melds.length;
  const need = 4 - openN;
  const out = [];
  const total = counts.reduce((a, b) => a + b, 0);

  let seven = false, longSeven = false;
  if (openN === 0 && total === 14) {
    let allEven = true, quads = 0;
    for (let i = 0; i < 27; i++) { if (counts[i] % 2) allEven = false; if (counts[i] >= 4) quads++; }
    if (allEven) { seven = true; longSeven = quads > 0; }
  }

  const suits = new Set();
  for (let i = 0; i < 27; i++) if (counts[i]) suits.add(suitOf(i));
  melds.forEach(m => suits.add(suitOf(m.tile)));
  const qing = suits.size === 1;

  let dui = false;
  if (!seven && melds.every(m => m.kind !== 'chow')) {
    for (let p = 0; p < 27 && !dui; p++) {
      if (counts[p] >= 2) {
        const c = counts.slice(); c[p] -= 2;
        if (tryMelds(c, need, 'triplet')) dui = true;
      }
    }
  }

  let duanYao = false, quanYao = false;
  if (!seven) {
    let hasYao = false;
    for (let i = 0; i < 27; i++) if (counts[i] && (i % 9 === 0 || i % 9 === 8)) hasYao = true;
    melds.forEach(m => { const r = m.tile % 9; if (r === 0 || r === 8) hasYao = true; });
    duanYao = !hasYao;
    if (!duanYao) {
      const okOpen = melds.every(m => {
        const r = m.tile % 9;
        return m.kind === 'chow' ? (r === 0 || r === 6) : (r === 0 || r === 8);
      });
      if (okOpen) {
        for (let p = 0; p < 27 && !quanYao; p++) {
          const r = p % 9;
          if ((r === 0 || r === 8) && counts[p] >= 2) {
            const c = counts.slice(); c[p] -= 2;
            if (tryMelds(c, need, 'yao')) quanYao = true;
          }
        }
      }
    }
  }

  const comb = counts.slice();
  melds.forEach(m => { comb[m.tile] += (m.kind === 'gang' ? 4 : 3); });
  let gen = 0;
  for (let i = 0; i < 27; i++) gen += Math.floor(comb[i] / 4);

  const jinGou = (openN === 4 && total === 2 && counts.some(x => x === 2));

  if (longSeven) {
    out.push({ key: 'long_qi_dui', times: 1 });
    gen = Math.max(0, gen - 1);            // 龙七对已含第一根，额外根才另计
  }
  else if (seven) out.push({ key: 'qi_dui', times: 1 });
  if (qing) out.push({ key: 'qing_yi_se', times: 1 });
  if (dui && !jinGou) out.push({ key: 'dui_dui_hu', times: 1 });   // 金钩钓已含对对胡，不重复计
  if (jinGou) out.push({ key: 'jin_gou_diao', times: 1 });
  if (!seven) {
    if (duanYao) out.push({ key: 'duan_yao_jiu', times: 1 });
    else if (quanYao) out.push({ key: 'quan_dai_yao', times: 1 });
  }
  if (gen > 0) out.push({ key: 'gen', times: gen });
  if (ctx.zimo) out.push({ key: 'zi_mo', times: 1 });
  if (ctx.gangShangHua) out.push({ key: 'gang_shang_hua', times: 1 });
  if (ctx.gangShangPao) out.push({ key: 'gang_shang_pao', times: 1 });
  if (ctx.qiangGang) out.push({ key: 'qiang_gang', times: 1 });
  if (ctx.haiDi) out.push({ key: 'hai_di', times: 1 });
  if (ctx.tianHu) out.push({ key: 'tian_hu', times: 1 });
  if (ctx.diHu) out.push({ key: 'di_hu', times: 1 });
  if (!out.some(o => HAND_YAKU.indexOf(o.key) >= 0)) out.push({ key: 'ping_hu', times: 1 });
  return out;
}

/* 计分：得分 = 底分 × 2^番数，可封顶（cap ≤ 0 表示不封顶） */
function scoreYaku(entries, table, cap, base) {
  const t = table || DEFAULT_FAN;
  const effCap = (typeof cap === 'number' && cap > 0) ? cap : 0;
  const effBase = (typeof base === 'number' && base > 0) ? base : 1;
  const details = {};
  let raw = 0;
  entries.forEach(e => {
    const v = (t[e.key] !== undefined ? t[e.key] : (DEFAULT_FAN[e.key] || 0)) * e.times;
    details[e.key] = (details[e.key] || 0) + v;
    raw += v;
  });
  const capped = effCap > 0 ? Math.min(raw, effCap) : raw;
  return { details, raw, capped, points: Math.pow(2, capped) * effBase, cap: effCap, base: effBase };
}

/* 文本解析：支持两种写法
   A) w1234t5678s123   （w/m=万 t/p/d=筒 s=条）
   B) 123456789m 111m 22m   或   1m2m3m... */
function parseHandText(str) {
  const s = String(str || '').toLowerCase().replace(/[\s,，、;；|]/g, '');
  const suitOfCh = ch =>
    (ch === 'w' || ch === 'm') ? 0 :
    (ch === 's') ? 1 :
    (ch === 't' || ch === 'p' || ch === 'd') ? 2 : -1;
  const tiles = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const suit = suitOfCh(ch);
    if (suit >= 0) {                       // A：字母在前
      i++;
      let n = 0;
      while (i < s.length && /[1-9]/.test(s[i])) { tiles.push(suit * 9 + (+s[i]) - 1); i++; n++; }
      if (n === 0) return null;
    } else if (/[1-9]/.test(ch)) {          // B：数字在前
      const digits = [];
      while (i < s.length && /[1-9]/.test(s[i])) { digits.push(+s[i]); i++; }
      if (i >= s.length) return null;
      const su = suitOfCh(s[i]);
      if (su < 0) return null;
      i++;
      digits.forEach(d => tiles.push(su * 9 + d - 1));
    } else {
      return null;
    }
  }
  if (!tiles.length || tiles.length > 14) return null;
  return tiles.sort((a, b) => a - b);
}

/* ============================================================
   牌河（场上已见牌）
   ============================================================ */

/* 生成一条牌河：从指定花色里随机抽 n 张（不与手牌冲突） */
function genRiver(hand, n, suits) {
  const inHand = toCounts(hand);
  const pool = [];
  for (let k = 0; k < 27; k++) {
    if (suits && suits.indexOf(suitOf(k)) < 0) continue;
    for (let j = inHand[k]; j < 4; j++) pool.push(k);
  }
  shuffle(pool);
  const river = new Array(27).fill(0);
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) river[pool[i]]++;
  return river;
}

/* ============================================================
   番型速算 / 牌河牌效 出题器
   ============================================================ */

function buildWinHand(opts) {
  opts = opts || {};
  const suits = opts.suits || [0, 1, 2];
  for (let attempt = 0; attempt < 260; attempt++) {
    const c = new Array(27).fill(0);
    const ok = arr => { for (const k of arr) if (c[k] >= 4) return false; return true; };
    const put = arr => { for (const k of arr) c[k]++; };
    let bad = false;
    for (let i = 0; i < 4 && !bad; i++) {
      let done = false;
      for (let t = 0; t < 90 && !done; t++) {
        const s = suits[(Math.random() * suits.length) | 0];
        const r = (Math.random() * 9) | 0;
        const k = s * 9 + r;
        let meld;
        if (opts.allTriplets || Math.random() < 0.45) {
          if (opts.allYao && r !== 0 && r !== 8) continue;
          if (opts.noYao && (r === 0 || r === 8)) continue;
          meld = [k, k, k];
        } else {
          if (r + 2 > 8) continue;
          if (opts.allYao && r !== 0 && r !== 6) continue;
          if (opts.noYao && (r === 0 || r + 2 === 8)) continue;
          meld = [k, k + 1, k + 2];
        }
        if (ok(meld)) { put(meld); done = true; }
      }
      if (!done) bad = true;
    }
    if (bad) continue;
    let done = false;
    for (let t = 0; t < 90 && !done; t++) {
      const s = suits[(Math.random() * suits.length) | 0];
      const r = (Math.random() * 9) | 0;
      const k = s * 9 + r;
      if (opts.allYao && r !== 0 && r !== 8) continue;
      if (opts.noYao && (r === 0 || r === 8)) continue;
      if (ok([k, k])) { put([k, k]); done = true; }
    }
    if (!done) continue;
    const tiles = [];
    for (let i = 0; i < 27; i++) for (let j = 0; j < c[i]; j++) tiles.push(i);
    if (tiles.length === 14 && isWinHand(c, 0)) return tiles;
  }
  return null;
}

/* 金钩钓牌型：4 组副露（碰）+ 手里一对（用于番型速算） */
function buildJinGou(oneSuit) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const suits = oneSuit ? [(Math.random() * 3) | 0] : [0, 1, 2];
    const c = new Array(27).fill(0);
    const melds = [];
    for (let i = 0; i < 4; i++) {
      let done = false;
      for (let t = 0; t < 160 && !done; t++) {
        const k = suits[(Math.random() * suits.length) | 0] * 9 + ((Math.random() * 9) | 0);
        if (c[k] === 0) { c[k] = 3; melds.push({ kind: 'pong', tile: k }); done = true; }
      }
      if (!done) break;
    }
    if (melds.length !== 4) continue;
    let pair = -1;
    for (let t = 0; t < 160 && pair < 0; t++) {
      const k = suits[(Math.random() * suits.length) | 0] * 9 + ((Math.random() * 9) | 0);
      if (c[k] === 0) { c[k] = 2; pair = k; }
    }
    if (pair < 0) continue;
    return { hand: [pair, pair], melds };
  }
  return null;
}

function buildSevenPairs(oneSuit) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const suits = oneSuit ? [(Math.random() * 3) | 0] : [0, 1, 2];
    const isLong = Math.random() < 0.45;          // 龙七对：6 种牌，其中 1 种 4 张
    const needKinds = isLong ? 6 : 7;
    const c = new Array(27).fill(0);
    let kinds = 0;
    for (let t = 0; t < 400 && kinds < needKinds; t++) {
      const s = suits[(Math.random() * suits.length) | 0];
      const k = s * 9 + ((Math.random() * 9) | 0);
      if (c[k] === 0) { c[k] = 2; kinds++; }
    }
    if (kinds !== needKinds) continue;
    if (isLong) {
      const cand = [];
      for (let i = 0; i < 27; i++) if (c[i] === 2) cand.push(i);
      c[cand[(Math.random() * cand.length) | 0]] = 4;
    }
    const tiles = [];
    for (let i = 0; i < 27; i++) for (let j = 0; j < c[i]; j++) tiles.push(i);
    if (tiles.length !== 14) continue;
    return tiles;
  }
  return null;
}

/* 番型速算题：一副已和的手牌 + 随机自摸/点炮
   cfg = { table, cap, base }：使用界面上的番数设置；不传时用默认番表 + 3 番封顶 */
function genFan(diff, cfg) {
  cfg = cfg || {};
  const fanT = cfg.table || DEFAULT_FAN;
  const cap = (typeof cfg.cap === 'number') ? cfg.cap : 3;
  const base = (typeof cfg.base === 'number') ? cfg.base : 1;
  for (let attempt = 0; attempt < 260; attempt++) {
    const relax = attempt > 150;            // 后期放宽难度，保证不返回空题
    const roll = Math.random();
    let hand = null, melds = null;
    if (roll < 0.15) {                      // 金钩钓：4 组副露 + 手里一对
      const jg = buildJinGou(Math.random() < 0.3);
      if (jg) { hand = jg.hand; melds = jg.melds; }
    }
    else if (roll < 0.35) hand = buildSevenPairs(Math.random() < 0.25);
    else if (roll < 0.58) hand = buildWinHand({ allTriplets: true });
    else if (roll < 0.78) hand = buildWinHand({ suits: [(Math.random() * 3) | 0] });
    else if (roll < 0.90) hand = buildWinHand({ allYao: true });
    else hand = buildWinHand({ noYao: true });
    if (!hand) hand = buildWinHand({});
    if (!hand) continue;
    const c = toCounts(hand);
    const ctx = { zimo: Math.random() < 0.5 };
    const yaku = detectYaku(c, { melds: melds || [], ctx });
    const scored = scoreYaku(yaku, fanT, cap, base);
    if (scored.capped > 8) continue;       // 不封顶时也把答案限制在 0~8，答题按钮才够用
    if (!relax) {
      if (diff === 1 && scored.capped > 1) continue;
      if (diff === 2 && scored.capped > 2) continue;
      if (diff === 3 && scored.capped < 2) continue;
    }
    return { hand, ctx, yaku, scored, table: fanT, melds, openN: melds ? melds.length : 0 };
  }
  return null;
}

/* 牌河牌效题：手牌 + 牌河（场上已见） */
function genDefense(diff, needVoid, openN) {
  openN = openN || 0;
  const size = 14 - 3 * openN;
  if (size < 2) return null;
  const suits = needVoid ? pick2() : [0, 1, 2];
  const keep = [false, false, false];
  for (const s of suits) keep[s] = true;
  for (let attempt = 0; attempt < 260; attempt++) {
    const hand = deal(size, suits);
    const river = genRiver(hand, 14 + ((Math.random() * 8) | 0), suits);
    const { options, best } = analyzeCut(hand, keep, openN, river);
    if (!best || best.shanten > 2) continue;
    if (best.ukeire < 3) continue;
    const sameSh = options.filter(o => o.shanten === best.shanten);
    const sorted = sameSh.slice().sort((a, b) => b.ukeire - a.ukeire);
    if (sorted.length < 2) continue;
    if (sorted[0].ukeire - sorted[1].ukeire < (diff === 1 ? 2 : 1)) continue;
    return { hand, river, options, best, keep };
  }
  return null;
}

const MJ_CORE_API = { shantenStd, shanten7, shanten, toCounts, ukeire, suitOf, rankOf, tileCN, tileEN, groupSuits, deal, analyzeCut, genCut, genVoid, voidEval, genTen, decompose, floatPotential, blockName,
    tryMelds, isWinHand, detectYaku, scoreYaku, parseHandText, genRiver, genFan, genDefense, buildWinHand, buildSevenPairs, buildJinGou,
    DEFAULT_FAN, FAN_LABEL, FAN_ORDER };
globalThis.MJCore = MJ_CORE_API;
if (typeof module !== 'undefined' && module.exports) module.exports = MJ_CORE_API;
