"""训练学习型危险度模型，导出为 JS 模块（运行时零依赖）

用法：
  tools/py/.venv/Scripts/python tools/py/train_danger.py work/danger
输入：tools/export-danger-data.mjs 导出的 meta.json + tenpai.bin + wait.bin
输出：
  src/ai/danger-weights.mjs   两个模型（听牌 / 放炮）+ 自检样本，由 src/ai/danger-model.mjs 读取
  <数据目录>/report.json       测试集指标（与现有启发式对照）

按对局切分：前 80% 的对局训练（其中最后 1/8 做早停验证），后 20% 测试，同一局的样本不会跨集合。
"""
import json
import sys
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[2]


def load(data_dir, part, meta):
    info = meta[part]
    cols = info["columns"]
    arr = np.fromfile(data_dir / info["file"], dtype="<f4").reshape(info["rows"], len(cols))
    n_feat = len(cols) - 3
    return arr[:, :n_feat], arr[:, n_feat], arr[:, n_feat + 1], arr[:, n_feat + 2], cols[:n_feat]


def metrics(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return {"auc": round(float(roc_auc_score(y, p)), 4), "logloss": round(float(log_loss(y, p)), 4),
            "brier": round(float(brier_score_loss(y, p)), 4), "mean_pred": round(float(p.mean()), 4)}


def calibration(y, p, bins=10):
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    out = []
    for i in range(bins):
        m = (p >= edges[i]) & (p <= edges[i + 1]) if i == bins - 1 else (p >= edges[i]) & (p < edges[i + 1])
        if m.sum():
            out.append({"pred": round(float(p[m].mean()), 4), "actual": round(float(y[m].mean()), 4), "n": int(m.sum())})
    return out


def export_tree(node, t):
    """LightGBM 的嵌套树 → 扁平数组；子节点 ≥0 为内部节点下标，<0 为 ~叶子下标"""
    if "leaf_value" in node:
        t["v"].append(node["leaf_value"])
        return ~(len(t["v"]) - 1)
    assert node["decision_type"] == "<=", node["decision_type"]
    i = len(t["f"])
    t["f"].append(node["split_feature"]); t["t"].append(node["threshold"]); t["l"].append(0); t["r"].append(0)
    t["l"][i] = export_tree(node["left_child"], t)
    t["r"][i] = export_tree(node["right_child"], t)
    return i


def train(part, X, y, heur, game, names, n_games):
    tr_mask = game < n_games * 0.8
    te_mask = ~tr_mask
    va_mask = tr_mask & (game >= n_games * 0.7)
    fit_mask = tr_mask & ~va_mask

    scaler = StandardScaler().fit(X[tr_mask])
    lr = LogisticRegression(max_iter=2000, C=1.0).fit(scaler.transform(X[tr_mask]), y[tr_mask])
    p_lr = lr.predict_proba(scaler.transform(X[te_mask]))[:, 1]

    gb = lgb.LGBMClassifier(n_estimators=400, learning_rate=0.05, num_leaves=15, min_child_samples=200,
                            subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
    gb.fit(X[fit_mask], y[fit_mask], eval_X=(X[va_mask],), eval_y=(y[va_mask],),
           callbacks=[lgb.early_stopping(30, verbose=False)])
    p_gb = gb.predict_proba(X[te_mask])[:, 1]

    rep = {
        "train_rows": int(tr_mask.sum()), "test_rows": int(te_mask.sum()), "positive_rate": round(float(y.mean()), 4),
        "heuristic": metrics(y[te_mask], np.clip(heur[te_mask], 0, 1)),
        "logistic": metrics(y[te_mask], p_lr),
        "lightgbm": {**metrics(y[te_mask], p_gb), "trees": int(gb.best_iteration_ or gb.n_estimators)},
    }
    use_gb = rep["lightgbm"]["auc"] > rep["logistic"]["auc"] + 0.005
    p_best = p_gb if use_gb else p_lr
    rep["chosen"] = "lightgbm" if use_gb else "logistic"
    rep["calibration"] = calibration(y[te_mask], p_best)
    rep["heuristic_calibration"] = calibration(y[te_mask], np.clip(heur[te_mask], 0, 1))
    if use_gb:
        imp = gb.booster_.feature_importance("gain")
        rep["importance"] = sorted(((names[i], round(float(v / imp.sum()), 4)) for i, v in enumerate(imp)), key=lambda x: -x[1])

    if use_gb:
        dump = gb.booster_.dump_model(num_iteration=gb.best_iteration_ or None)
        trees = []
        for ti in dump["tree_info"]:
            t = {"f": [], "t": [], "l": [], "r": [], "v": []}
            root = export_tree(ti["tree_structure"], t)
            assert root == 0 or root == ~0
            trees.append(t)
        model = {"type": "gbdt", "features": names, "trees": trees}
    else:
        model = {"type": "logistic", "features": names, "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                 "coef": lr.coef_[0].tolist(), "intercept": float(lr.intercept_[0])}
    # 自检样本：JS 端用同样的输入应算出同样的概率
    idx = np.linspace(0, te_mask.sum() - 1, 24).astype(int)
    Xt = X[te_mask][idx]
    model["selfTest"] = [{"x": [float(v) for v in Xt[i]], "p": float(p_best[j])} for i, j in enumerate(idx)]
    return model, rep


def main():
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "work" / "danger")
    meta = json.loads((data_dir / "meta.json").read_text(encoding="utf-8"))
    report, models = {"games": meta["games"], "featureVersion": meta["featureVersion"]}, {}
    for part in ("tenpai", "wait"):
        X, y, heur, game, names = load(data_dir, part, meta)
        models[part], report[part] = train(part, X, y, heur, game, names, meta["games"])
        r = report[part]
        print(f"[{part}] 训练 {r['train_rows']} 行 / 测试 {r['test_rows']} 行，正例 {r['positive_rate']:.1%}")
        for k in ("heuristic", "logistic", "lightgbm"):
            m = r[k]
            print(f"  {k:10s} AUC {m['auc']:.4f}  logloss {m['logloss']:.4f}  Brier {m['brier']:.4f}  平均预测 {m['mean_pred']:.4f}")
        print(f"  选用 {r['chosen']}")

    (data_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    head = ("/* 由 tools/py/train_danger.py 生成，不要手改。\n"
            f"   训练数据：{meta['games']} 局高手自对弈牌谱；特征版本 {meta['featureVersion']}（src/ai/danger-features.mjs）\n"
            f"   测试集 AUC：听牌 {report['tenpai'][report['tenpai']['chosen']]['auc']}"
            f"（启发式 {report['tenpai']['heuristic']['auc']}），"
            f"放炮 {report['wait'][report['wait']['chosen']]['auc']}（启发式 {report['wait']['heuristic']['auc']}） */\n")
    body = (f"export const FEATURE_VERSION = {meta['featureVersion']};\n"
            f"export const TENPAI_MODEL = {json.dumps(models['tenpai'], separators=(',', ':'))};\n"
            f"export const WAIT_MODEL = {json.dumps(models['wait'], separators=(',', ':'))};\n")
    out = ROOT / "src" / "ai" / "danger-weights.mjs"
    out.write_bytes((head + body).encode("utf-8"))
    print(f"已写出 {out.relative_to(ROOT)}（{out.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
