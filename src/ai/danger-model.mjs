/* ============================================================
   学习型危险度：用自对弈牌谱训练的两个模型（tools/py/train_danger.py 生成 danger-weights.mjs）
   - 听牌模型：对手此刻听牌的概率 → 代替启发式「威胁」
   - 放炮模型：打出这张牌被该对手胡的概率 → 代替启发式「危险度」
   接口与 danger.mjs 的 allThreats / tileDanger 相同，analyzer 按 opts.dangerModel 选用
   推理零依赖：逻辑回归 / 梯度提升树都在这里直接计算
   ============================================================ */
import { suitOf } from '../core/core.mjs';
import { voidCleared, suspectQing } from './danger.mjs';
import { opponentFeatures, tileFeatures, OPP_FEATURES, TILE_FEATURES, FEATURE_VERSION } from './danger-features.mjs';
import { TENPAI_MODEL, WAIT_MODEL, FEATURE_VERSION as WEIGHTS_VERSION } from './danger-weights.mjs';

if (WEIGHTS_VERSION !== FEATURE_VERSION
  || TENPAI_MODEL.features.join() !== OPP_FEATURES.join()
  || WAIT_MODEL.features.join() !== TILE_FEATURES.join()) {
  throw new Error('danger-weights.mjs 与 danger-features.mjs 的特征不一致：请重新导出数据并训练');
}

const sigmoid = z => 1 / (1 + Math.exp(-z));

/* 训练数据是 float32，比较阈值前先转成 float32，保证与 LightGBM 的切分完全一致 */
export function predict(model, x) {
  if (model.type === 'logistic') {
    let z = model.intercept;
    for (let i = 0; i < x.length; i++) z += model.coef[i] * (x[i] - model.mean[i]) / model.scale[i];
    return sigmoid(z);
  }
  const xf = x.map(Math.fround);
  let z = 0;
  for (const t of model.trees) {
    let n = t.f.length ? 0 : -1;
    while (n >= 0) n = xf[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
    z += t.v[~n];
  }
  return sigmoid(z);
}

export function learnedThreat(view, p) {
  if (p.won) return { threat: 0, voidCleared: true, suspectSuit: null, reasons: ['已胡'] };
  const features = opponentFeatures(view, p);
  const threat = predict(TENPAI_MODEL, features);
  return { threat, voidCleared: voidCleared(p), suspectSuit: suspectQing(p), reasons: [`听牌概率约 ${Math.round(threat * 100)}%`], features };
}

export function learnedThreats(view) {
  const out = {};
  for (const p of view.players) if (p.seat !== view.seat) out[p.seat] = learnedThreat(view, p);
  return out;
}

/* 打出 tile 被至少一家胡的概率（各家近似独立）；对手缺门花色的牌按规则为 0 */
export function learnedTileDanger(view, tile, threats, visible) {
  let safe = 1;
  const by = [];
  for (const p of view.players) {
    if (p.seat === view.seat || p.won || suitOf(tile) === p.voidSuit) continue;
    const oppF = (threats && threats[p.seat] && threats[p.seat].features) || opponentFeatures(view, p);
    const d = predict(WAIT_MODEL, tileFeatures(view, p, tile, visible, oppF));
    by.push({ seat: p.seat, danger: +d.toFixed(3) });
    safe *= 1 - d;
  }
  return { danger: +(1 - safe).toFixed(3), by };
}
