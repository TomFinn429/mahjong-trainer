/* ============================================================
   学习型危险度模型的特征（唯一定义处）
   导出训练数据（tools/export-danger-data.mjs）和对局中预测（danger-model.mjs）都用这里，
   保证训练和使用时的特征完全一致。只用观察者 view 里看得到的信息。
   - opponentFeatures：某个对手的整体状态 → 听牌模型
   - tileFeatures：某张牌对某个对手 → 放炮模型（= 对手整体特征 + 这张牌的特征）
   改动特征后必须重新导出数据、重新训练（tools/py/train_danger.py），否则模型和特征对不上
   ============================================================ */
import { suitOf } from '../core/core.mjs';
import { voidCleared, suspectQing } from './danger.mjs';

export const FEATURE_VERSION = 1;

export const OPP_FEATURES = [
  'draws', 'discards', 'melds', 'gangs', 'meldSuitMax', 'voidCleared', 'voidDiscards', 'sinceVoid',
  'suspectQing', 'recentMiddle', 'recentSameSuit', 'wallCount', 'activeCount', 'wonCount', 'claimedFrom'
];

export const TILE_FEATURES = [
  ...OPP_FEATURES,
  'rank', 'edge', 'visK', 'visM1', 'visP1', 'visM2', 'visP2',
  'discK', 'discSuji', 'discNear', 'suitShare', 'suitMelds', 'qingMatch', 'recentInSuit'
];

const isVoid = (p, t) => p.voidSuit !== null && p.voidSuit !== undefined && suitOf(t) === p.voidSuit;

export function opponentFeatures(view, p) {
  const ds = p.discards;
  let lastVoid = -1, voidN = 0;
  ds.forEach((d, i) => { if (isVoid(p, d.tile)) { lastVoid = i; voidN++; } });
  const nonVoid = ds.filter(d => !isVoid(p, d.tile));
  const recent = nonVoid.slice(-4);
  const suitMeld = [0, 0, 0];
  for (const m of p.melds) suitMeld[suitOf(m.tile)]++;
  const lastSuit = recent.length ? suitOf(recent[recent.length - 1].tile) : -1;
  return [
    p.draws,
    ds.length,
    p.melds.length,
    p.melds.filter(m => m.kind === 'gang').length,
    Math.max(...suitMeld),
    voidCleared(p) ? 1 : 0,
    voidN,
    ds.length - 1 - lastVoid,
    suspectQing(p) !== null ? 1 : 0,
    recent.filter(d => { const r = d.tile % 9; return r >= 2 && r <= 6; }).length,
    recent.filter(d => suitOf(d.tile) === lastSuit).length,
    view.wallCount,
    view.players.filter(x => !x.won).length,
    view.players.filter(x => x.won).length,
    ds.filter(d => d.claimed).length
  ];
}

/* visible：visibleCounts(view)；oppF：opponentFeatures 的结果（同一对手可复用） */
export function tileFeatures(view, p, tile, visible, oppF) {
  const s = suitOf(tile), r = tile % 9;
  const inSuit = d => (r + d >= 0 && r + d <= 8 ? tile + d : -1);
  const vis = d => { const k = inSuit(d); return k < 0 ? 4 : visible[k]; };   // 越界视为 4 张全可见
  const disc = new Array(27).fill(0);
  for (const d of p.discards) disc[d.tile]++;
  const dc = d => { const k = inSuit(d); return k < 0 ? 0 : disc[k]; };
  const nonVoid = p.discards.filter(d => !isVoid(p, d.tile));
  const qing = suspectQing(p);
  return [
    ...oppF,
    r + 1,
    Math.min(r, 8 - r),
    visible[tile], vis(-1), vis(1), vis(-2), vis(2),
    disc[tile],
    dc(-3) + dc(3),
    dc(-2) + dc(-1) + dc(1) + dc(2),
    nonVoid.length ? nonVoid.filter(d => suitOf(d.tile) === s).length / nonVoid.length : 0.5,
    p.melds.filter(m => suitOf(m.tile) === s).length,
    qing === null ? 0 : qing === s ? 1 : -1,
    nonVoid.slice(-3).filter(d => suitOf(d.tile) === s).length
  ];
}
