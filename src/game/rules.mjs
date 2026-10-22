/* 对局规则默认值。口径说明见 docs/ai-table-design.md */
import { DEFAULT_FAN } from '../core/core.mjs';

export const DEFAULT_RULES = Object.freeze({
  exchangeThree: true,     // 换三张
  multiHu: true,           // 一炮多响
  passHuLock: true,        // 过手胡：放弃点炮胡后，到自己下次摸牌前不能胡别人打的牌
  robGang: true,           // 抢杠胡
  gangPay: true,           // 刮风下雨
  gangPayMing: 2,          // 直杠：点杠者付（单位：底分）
  gangPayAn: 2,            // 暗杠：未胡的其他家各付
  gangPayBu: 1,            // 补杠：未胡的其他家各付
  callTransfer: true,      // 呼叫转移
  checkHuazhu: true,       // 查花猪
  checkDajiao: true,       // 查大叫
  taxRefund: true,         // 退税
  cap: 3,                  // 封顶番数（≤0 不封顶）
  base: 1,                 // 底分
  fan: DEFAULT_FAN
});

export function makeRules(overrides) {
  const r = { ...DEFAULT_RULES, ...(overrides || {}) };
  r.fan = { ...DEFAULT_FAN, ...((overrides && overrides.fan) || {}) };
  return Object.freeze(r);
}
