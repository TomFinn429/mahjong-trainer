# 牌谱格式（xuezhan-record v1）

一局血战到底的可重放记录，纯 JSON。代码在 `src/game/record.mjs`。

用途：

- **复盘**：在对局页的结果面板点「下载牌谱」，或者用 `tools/duplicate.mjs --records` 批量导出自对弈牌谱；
- **统计读牌**：逐个决定还原「当时能看到什么」，统计对手牌河和副露与他实际待牌、点炮率的关系；
- **模仿学习**：每个决定是一条「可见信息 → 合法动作 → 实际动作」样本，可以直接交给训练程序。

## 为什么这样设计

引擎是确定性的：种子相同、决定序列相同，就是同一局。所以重放只需要 `seed + dealer + rules + decisions`，
别的都能算出来。`events` 是全知视角的事件流，保存它是为了两件事：

1. **重放校验**。引擎以后改了规则或随机数的用法，老牌谱重放出来会和 `events` 对不上，
   `replayRecord` 会报出第一处差异，不会悄悄得到另一局；
2. **不重放也能做简单统计**，比如和牌番型分布、点炮者是谁。

牌谱里不保存每个决定时的「视角」。需要时用 `viewFor()` 重放还原，信息隔离和对局时完全一致，
不会因为导出时少遮了什么而泄露别家手牌。

## 字段

```jsonc
{
  "format": "mahjong-trainer/xuezhan-record",
  "version": 1,
  "createdAt": "2026-10-23T08:00:00.000Z",
  "seed": 123456789,          // 引擎内部的 uint32 种子（createGame 的 seed 经 seedFrom 换算后）
  "seedText": "abc",          // 界面里输入的原始种子文本，可为 null
  "dealer": 0,
  "rules": { ... },           // 完整规则（含番表），见 src/game/rules.mjs
  "players": [                // 每个座位是谁；level / opts 是导出那一刻的电脑配置
    { "kind": "human" },
    { "kind": "bot", "level": 3, "opts": { ... } }
  ],
  "note": null,
  "decisions": [              // 按提交顺序的全部决定（包括「过」）
    { "seq": 1, "phase": "exchange", "seat": 1, "action": { "type": "exchange", "tiles": [3, 4, 8] } },
    { "seq": 2, "phase": "void", "seat": 0, "action": { "type": "void", "suit": 2 } },
    { "seq": 7, "phase": "turn", "seat": 0, "action": { "type": "discard", "tile": 18 } },
    { "seq": 8, "phase": "claim", "seat": 2, "action": { "type": "pass" } }
  ],
  "events": [ ... ],          // 引擎事件流 g.log（全知视角，含别家摸牌和换三张明细）
  "result": { ... }           // 引擎结算结果 g.result
}
```

- `seq`：提交这个决定时已有的事件数。重放时用来对齐，也能据此知道做决定时看到了哪些事件。
- 牌编号：0–8 万、9–17 条、18–26 筒；`suit`：0 万、1 条、2 筒。
- 动作类型：`exchange`、`void`、`discard`、`angang`、`bugang`、`hu`、`pong`、`minggang`、`pass`。

批量导出用 JSONL，每行一局：

```bash
node tools/duplicate.mjs --a '{"level":3}' --b '{"level":2}' --decks 500 --records work/selfplay.jsonl
```

## 接口

```js
import { exportRecord, replayRecord, decisionSamples } from './src/game/record.mjs';

const rec = exportRecord(g, { players, seedText });   // 对局结束后（中途也可以导出）
const g2 = replayRecord(rec);                          // 重放并逐条校验 events
const samples = decisionSamples(rec, { seats: [0] });  // [{ index, seat, phase, view, legal, action }]
```

`decisionSamples` 里的 `view` 是 `viewFor()` 去掉事件流 `log` 和 `rules` 以后的结果：
自己的手牌、各家副露、牌河（按顺序，含是否被碰 / 被胡）、缺门、分数、牌墙剩余张数。
别家手牌是 `null`，已胡者除外。

## 版本规则

- 只增加字段：`version` 不变，读取方忽略不认识的字段；
- 字段含义变化或引擎行为变化导致老牌谱无法重放：`version + 1`，`checkRecord` 拒绝旧版本。
  需要保留老数据时，另写转换脚本，不要让新引擎硬读旧牌谱。

## 已知限制

- 没有记录「摸切 / 手切」：手牌是排好序的，同一种牌分不出是不是刚摸的那张。读牌统计如果需要这个信息，
  要在引擎的 `discard` 事件里加字段（属于只增加字段，版本号不变）；
- 界面里中途换难度时，`players` 记的是导出那一刻的配置。
