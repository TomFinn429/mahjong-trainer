# 代码审查报告（2026-10）· 修复状态回执

> **原报告**：2026-10-10 针对「单文件训练器」形态做的审查（原文件 `DEEPSEEK_CODE_REVIEW.md`），列出 3 个 P0 Bug、3 个规则模型问题、P1/P2 改进建议。
> **本回执**：2026-10-22 在 `feat/ai-table` 分支上逐条复核，标注当前状态、修复位置与回归测试。行号以当前代码为准。
> **复核口径**：只依据仓库当前代码与可运行的测试，不以原报告的叙述为依据；原报告中的行号因 `c5d8626` 抽取核心算法已全部失效。

## 1. 结论摘要

| 分类 | 条目 | 状态 |
|---|---|---:|
| P0 正确性 Bug | 3 | **全部已修复**，均有回归测试 |
| P1 规则表达 | 3 | **全部已处理** |
| P2 多阶段牌局 | 5 | **已在 AI 对局引擎实现**；训练器保持单手牌定位 |
| 遗留改进项 | 2 | 防守危险度、牌河可见性为启发式（有意保留，非缺陷） |

当前验证结果（`npm test`）：

| 自检 | 结果 |
|---|---|
| `tools/test-core.js` | 通过 24，失败 0 |
| `tools/test-fan.js` | 通过 58，失败 0 |
| `tools/verify-shanten.js` | 13 张随机牌 × 300 组，不一致 0 组（393ms） |
| `node --test tests/*.mjs` | 25 通过，0 失败（含随机整局 300 局守恒校验） |

---

## 2. P0：正确性 Bug（3/3 已修复）

### Bug 1：四组副露后任意两张牌被判和牌 —— 已修复

**原问题**：`openN === 4` 时 `need === 0`，旧代码直接 `return true`，没有校验剩余两张是否为对子。四副露 + 1万2万 会被误判为和牌。

**当前实现**（`src/core/mj-core.js:469-487`，关键在 `:474`）：

```js
function isWinHand(counts, openN) {
  if (openN === undefined) openN = 0;
  const need = 4 - openN;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== 3 * need + 2) return false;
  if (need === 0) return counts.some(x => x === 2);   // 4 副露后只剩将（金钩钓），两张必须成对
  // …七对与普通型判定
}
```

张数校验与成对校验分开，`openN === 4` 时只接受两张相同的牌。

**回归测试**（`tools/test-fan.js:32-34`）：

```js
ok('副露4组 只剩将 99s', C.isWinHand(parse('99s'), 4));
ok('副露4组 非对子 1m2m 应为 false', !C.isWinHand(parse('1m2m'), 4));
ok('副露4组 对子 11m', C.isWinHand(parse('11m'), 4));
```

另在 `genFan` 生成的 200 题中校验金钩钓题目（`tools/test-fan.js:235-248`）：`melds.length === 4`、手牌 2 张且 `isWinHand(counts, 4)` 为真、番型为金钩钓且不叠加对对胡。

> 修复落点：`45cf8a6` 初次提交即含正确实现，`c5d8626` 迁移到 `src/core/mj-core.js`。

### Bug 2：龙七对重复计算第一根 —— 已修复

**原问题**：龙七对 3 番与根 1 番同时计入，一组四张会算成 4 番；而牌桌约定「龙七对已含第一根」。

**当前实现**（`src/core/mj-core.js:566-583`，关键在 `:573`）：

```js
let gen = 0;
for (let i = 0; i < 27; i++) gen += Math.floor(comb[i] / 4);
// …
if (longSeven) {
  out.push({ key: 'long_qi_dui', times: 1 });
  gen = Math.max(0, gen - 1);            // 龙七对已含第一根，额外根才另计
}
if (gen > 0) out.push({ key: 'gen', times: gen });
```

**回归测试**（`tools/test-fan.js:59-67`）覆盖三条：

```js
ok('龙七对已含第一根：不再另计 gen', !y.some(e => e.key === 'gen'), …);
ok('龙七对 1 根 = 3 番', C.scoreYaku(y, null, 12).raw === 3, …);
ok('龙七对 2 根：只另计 1 个 gen', g && g.times === 1, …);
ok('龙七对 2 根 = 4 番', C.scoreYaku(y, null, 12).raw === 4, …);
```

番数表现已与牌桌一致：1 根 3 番、2 根 4 番、3 根 5 番。

### Bug 3：番数设置没有参与实际判题 —— 已修复

**原问题**：题目生成写死 `scoreYaku(yaku, null, 3)`，界面改番数、封顶、底分后不生效。

**当前实现**分三处打通，且用快照避免中途改设置导致展示错位：

| 环节 | 位置 | 做法 |
|---|---|---|
| 出题计分 | `index.html:406-407` | `scoreYaku(yaku, fanTable, state.cap, state.base)`，并把 `table` 存入题目 `q.table` |
| 题目生成 | `index.html:627` | `genFan(state.diff, { table: fanTable, cap: state.cap, base: state.base })` |
| 判题/解析展示 | `index.html:744` | `const ft = q.table || fanTable;` 使用出题时的番表快照 |

核心侧（`src/core/mj-core.js`）：`genFan` 接收 `{ table, cap, base }`（`:770-776`），`scoreYaku` 按传入表取值、`cap <= 0` 视为不封顶、`points = base × 2^capped`（`:596-609`）。

**回归测试**：

- `tools/test-fan.js:108-112`：自定义番表 + 封顶 + 底分参与计分；封顶 0 = 不封顶。
- `tools/test-fan.js:214-219`：`genFan` 题目的 `raw / capped / points / cap / base` 与传入配置自洽（零番表场景）。
- `tools/test-fan.js:222-231`：封顶 5 时能出 > 3 番的题。

---

## 3. P1：规则表达（3/3 已处理）

### 问题 1：README 与界面结束条件不一致 —— 已处理

README 已按「两种定位并存」改写，不再声称模拟整桌：

- `README.md:10`：「训练器只训练**单副手牌决策**…不模拟整局流程，也不绑定推倒胡或血战到底的结束规则」。
- `README.md:205`：色标对比表明确「推倒胡：一家胡牌结束；血战到底：胡者退出、其余继续」两种规则，并说明训练器只练单副手牌、早听早胡在两种规则下都成立。
- `README.md:29`：完整的「换三张 → 定缺 → 摸打/碰/杠 → 自摸/点炮 → 胡者退出、其余继续」对局改由 `table.html` 承载。

### 问题 2：防守模式未真正计算放炮风险 —— 已处理（改名 + 新增危险度模型）

- 训练器侧不再使用会误导的「防守」命名：`index.html:126` 现为「⑤ 牌河牌效（带牌河）」，只承诺按向听与有效牌排序并扣除牌河已见牌。
- 对局侧新增 `src/ai/danger.mjs`，按川麻口径估计对手威胁：可见牌统计（`visibleCounts`）、对手缺门是否打完（`voidCleared`）、清一色倾向（`suspectQing`）、综合威胁与逐张危险度（`opponentThreat` / `tileDanger`），并以已摸巡目、副露数、杠数作为进度权重；文件头明确标注「结果是估计而非概率真值」，与「训练器不承诺放炮概率」的定位一致。

### 问题 3：定缺评分仍是启发式 —— 已升级为多目标排序

`src/core/mj-core.js:285-312` 的 `voidEval` 已是字典序多目标：

```js
rows.sort((a, b) => a.k - b.k || a.sh - b.sh || b.uke - a.uke || b.shape - a.shape);
```

排序键依次为：缺门张数 `k` → 剩余两门向听 `sh` → 有效牌数 `uke` → 好形分 `shape`（对子 2 / 两面 2 / 边张嵌张 1，七对路线按对子计）。`genVoid` 再按「哪一项分胜负」定难度档位（`mj-core.js:314-329`）。

未纳入：牌河可见性、跨门权重调参。属于「启发式仍有提升空间」，而非正确性缺陷。

---

## 4. P2：多阶段牌局（已由 AI 对局引擎覆盖 5/5）

| 原建议 | 当前实现 |
|---|---|
| 建立玩家状态 `active / hu / out` | `src/game/engine.mjs:104-106` `activeSeats()` 按 `!p.won` 过滤；胡牌后该家不再摸打 |
| 胡者退出后继续摸打 | `src/game/engine.mjs:375-380` `afterWins()`：仍有 ≥2 家未胡时从胡牌者下家继续 |
| 剩余玩家数量与阶段牌墙 | `activeSeats(g).length <= 1` 才 `finish(g, 'allWon')`；牌墙摸空走 `finish(g, 'wall')` |
| 累计收益而非单手牌效率 | 每局 `transfer()` 结算分数，流局时按 `checkHuazhu` / `checkDajiao` / `taxRefund` 结算（规则见 `src/game/rules.mjs:4-20`） |
| 对手危险度与安全牌训练 | `src/ai/danger.mjs` + `src/ai/analyzer.mjs` 提供实时威胁与推荐 |

训练器（`index.html`）刻意保持单手牌定位，未改回「胡牌即整桌结束」，符合原报告第 8 条第 6 点。

---

## 5. 遗留与仍需确认

1. **危险度仍是估计**：`danger.mjs` 用可见信息做启发式排序，未做精确听牌推断与放炮概率建模。若要量化，需要对手手牌范围与自对弈标定。
2. **定缺未纳入牌河可见性**：`voidEval` 只看手牌结构，未结合牌河已见张数；可作为后续增强。
3. **结束条件需牌友确认**：原报告第 9 节的问题在实现中已取「牌墙摸完（`finish('wall')`）或只剩一家未胡（`finish('allWon')`）」两个终止条件，但线下牌桌是否还有「固定轮数后结束」的约定，仍需确认。

## 6. 复核方式

```bash
npm test
```

覆盖：核心算法自检、番型与番数自检、向听随机对照、对局引擎守恒与结束条件、机器人策略、讲解校验、`server.js` 静态服务与代理转发。

---

*原 `DEEPSEEK_CODE_REVIEW.md` 已迁移至本文件并更新状态，根目录不再保留副本。*
