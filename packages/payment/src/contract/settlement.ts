/**
 * 结算状态的中立模型与迁移规则。
 *
 * 这是多渠道支付里最容易出错、也最值得统一的一层：各渠道的状态名不同
 * （Stripe 的 requires_capture / succeeded、PayPal 的 APPROVED / COMPLETED、
 * 微信的 NOTPAY / SUCCESS / CLOSED），但"钱有没有动"的语义是共通的。
 *
 * 适配器只负责把供应商状态映射成这里的 SettlementState，不做任何持久化决策；
 * 迁移是否允许由 reconcile() 统一裁决，保证所有渠道遵守同一套安全性质。
 */

export const SETTLEMENT_STATES = [
  /** 已创建，用户尚未授权 */
  "created",
  /** 用户已授权但尚未扣款（PayPal APPROVED / Stripe requires_capture） */
  "authorized",
  /** 已扣款 */
  "captured",
  /** 已全额退款 */
  "refunded",
  /** 已部分退款 */
  "partially_refunded",
  /** 终态失败 */
  "failed",
  /** 终态取消（用户放弃 / 商户撤单） */
  "canceled",
  /**
   * 无法判定。
   * 不是"失败"，也不是一个可持久化的终态——查询异常、供应商返回中间态、
   * 回调迟到都会落到这里，必须保留原状继续观察。
   */
  "unknown",
] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** 钱已经真实移动过的状态。这些状态不可被任何迟到的失败/取消通知回退。 */
const MONEY_MOVED: ReadonlySet<SettlementState> = new Set([
  "captured",
  "refunded",
  "partially_refunded",
]);

/** 不再会自行变化的状态。 */
const TERMINAL: ReadonlySet<SettlementState> = new Set([
  "refunded",
  "failed",
  "canceled",
]);

export function isMoneyMoved(state: SettlementState): boolean {
  return MONEY_MOVED.has(state);
}

export function isTerminal(state: SettlementState): boolean {
  return TERMINAL.has(state);
}

/** reconcile 的裁决结果，供调用方决定是否写库、是否告警。 */
export interface SettlementDecision {
  /** 应当持久化的状态；与 current 相同表示不必写库 */
  next: SettlementState;
  /** 是否发生了实际变化 */
  changed: boolean;
  /**
   * 观察到的状态被拒绝采纳时给出原因，调用方应据此告警而不是静默丢弃。
   * 例如已扣款的订单收到 failed 通知——这通常意味着两边对不上，需要人工核对。
   */
  rejected?: "money-already-moved" | "already-terminal" | "not-observable";
}

/**
 * 依据当前持久化状态与本次观察到的状态，裁决应当落库的状态。
 *
 * 安全性质（由测试锁定）：
 *   1. unknown 永不覆盖任何已知状态——查不到不等于没付。
 *   2. 钱已移动过的状态不会被 failed / canceled 回退——迟到的失败回调不能抹掉已收款。
 *   3. 终态不会被非终态覆盖——已退款的订单不会因为一条旧的 captured 回调变回已付。
 *   4. captured → partially_refunded → refunded 单向推进，不可逆。
 *   5. 幂等：同样的观察重复裁决，结果不变且 changed=false。
 */
export function reconcile(
  current: SettlementState,
  observed: SettlementState,
): SettlementDecision {
  if (observed === "unknown") {
    return { next: current, changed: false, rejected: "not-observable" };
  }
  if (observed === current) {
    return { next: current, changed: false };
  }
  if (isMoneyMoved(current) && (observed === "failed" || observed === "canceled")) {
    return { next: current, changed: false, rejected: "money-already-moved" };
  }
  // 退款是单向的：已全额退款不回退到部分退款或已扣款
  if (current === "refunded") {
    return { next: current, changed: false, rejected: "already-terminal" };
  }
  if (current === "partially_refunded" && observed === "captured") {
    return { next: current, changed: false, rejected: "already-terminal" };
  }
  if (isTerminal(current) && !isMoneyMoved(observed)) {
    return { next: current, changed: false, rejected: "already-terminal" };
  }
  return { next: observed, changed: true };
}
