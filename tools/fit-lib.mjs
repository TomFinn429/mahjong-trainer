/* 拟合工具共用的小型线性代数与广义线性模型（牛顿法 / IRLS），零依赖。tools/fit-ev.mjs、tools/fit-infer.mjs 使用 */

export function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/* 逻辑回归；y 可以是 0–1 之间的小数（分数响应），wt 为样本权重 */
export function logistic(X, y, iters = 25, wt = null) {
  return newton(X[0].length, iters, (w, H, gr) => {
    for (let i = 0; i < X.length; i++) {
      const x = X[i], p = 1 / (1 + Math.exp(-x.reduce((a, xi, j) => a + xi * w[j], 0)));
      const c = wt ? wt[i] : 1, s = c * p * (1 - p);
      for (let j = 0; j < x.length; j++) { gr[j] += c * (y[i] - p) * x[j]; for (let k = 0; k < x.length; k++) H[j][k] += s * x[j] * x[k]; }
    }
  });
}

/* 泊松回归（对数连接）：E[y] = exp(w·x) */
export function poisson(X, y, iters = 30) {
  return newton(X[0].length, iters, (w, H, gr) => {
    for (let i = 0; i < X.length; i++) {
      const x = X[i], mu = Math.exp(x.reduce((a, xi, j) => a + xi * w[j], 0));
      for (let j = 0; j < x.length; j++) { gr[j] += (y[i] - mu) * x[j]; for (let k = 0; k < x.length; k++) H[j][k] += mu * x[j] * x[k]; }
    }
  });
}

/* 条件 logit（分组 softmax，分数响应）：每组若干行 { x, y, off }，组内 π ∝ exp(w·x + off)，y 是该行实际占比，c 是组权重
   用于「暗手里每门花色占多少」「同一门里每种牌占多少」这类组内份额 */
export function condLogit(groups, d, iters = 30) {
  return newton(d, iters, (w, H, gr) => {
    for (const { rows, c } of groups) {
      const z = rows.map(r => Math.exp(r.x.reduce((a, xi, j) => a + xi * w[j], 0) + (r.off || 0)));
      const Z = z.reduce((a, b) => a + b, 0);
      const p = z.map(v => v / Z);
      const m = new Array(d).fill(0);
      rows.forEach((r, i) => { for (let j = 0; j < d; j++) m[j] += p[i] * r.x[j]; });
      rows.forEach((r, i) => {
        for (let j = 0; j < d; j++) {
          gr[j] += c * (r.y - p[i]) * r.x[j];
          for (let k = 0; k < d; k++) H[j][k] += c * p[i] * (r.x[j] - m[j]) * (r.x[k] - m[k]);
        }
      });
    }
  });
}

function newton(d, iters, accumulate) {
  let w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d }, () => new Array(d).fill(0)), gr = new Array(d).fill(0);
    accumulate(w, H, gr);
    for (let j = 0; j < d; j++) H[j][j] += 1e-6;
    const step = solve(H, gr);
    w = w.map((wj, j) => wj + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return w;
}

export function ols(X, y) {
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0)), b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k]; }
  return solve(A, b);
}

export const r4 = x => Math.round(x * 1e4) / 1e4;
