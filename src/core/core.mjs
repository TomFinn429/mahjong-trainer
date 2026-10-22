/* 核心算法的 ES 模块入口。
   mj-core.js 是经典脚本（训练器 file:// 直接加载），执行后把 API 挂到 globalThis.MJCore；
   Node 下它是 CommonJS，同样会设置 globalThis.MJCore。 */
import './mj-core.js';

const C = globalThis.MJCore;
export default C;
export const {
  shanten, shantenStd, shanten7, toCounts, ukeire, suitOf, rankOf, tileCN, tileEN, groupSuits,
  decompose, blockName, floatPotential, voidEval, isWinHand, detectYaku, scoreYaku, parseHandText,
  DEFAULT_FAN, FAN_LABEL, FAN_ORDER
} = C;
