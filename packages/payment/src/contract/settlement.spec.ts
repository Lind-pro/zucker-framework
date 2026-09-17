import { describe, expect, it } from 'vitest';
import { reconcile, isMoneyMoved, isTerminal, SETTLEMENT_STATES } from './settlement';
import type { SettlementState } from './settlement';

const MONEY_MOVED: SettlementState[] = ['captured', 'refunded', 'partially_refunded'];

describe('结算状态裁决', () => {
  it('unknown 永不覆盖任何已知状态——查不到不等于没付', () => {
    for (const current of SETTLEMENT_STATES) {
      expect(reconcile(current, 'unknown')).toEqual({
        next: current,
        changed: false,
        rejected: 'not-observable',
      });
    }
  });

  it('钱已移动过的状态不被迟到的 failed/canceled 回退，并给出拒绝原因', () => {
    for (const current of MONEY_MOVED) {
      for (const observed of ['failed', 'canceled'] as const) {
        const decision = reconcile(current, observed);
        expect(decision.next).toBe(current);
        expect(decision.rejected).toBe('money-already-moved');
      }
    }
  });

  it('退款单向推进，已全额退款不回退', () => {
    for (const observed of ['captured', 'partially_refunded', 'authorized'] as const) {
      expect(reconcile('refunded', observed).next).toBe('refunded');
    }
    expect(reconcile('partially_refunded', 'captured').next).toBe('partially_refunded');
  });

  it('正常生命周期允许推进', () => {
    expect(reconcile('created', 'authorized').next).toBe('authorized');
    expect(reconcile('authorized', 'captured').next).toBe('captured');
    expect(reconcile('captured', 'partially_refunded').next).toBe('partially_refunded');
    expect(reconcile('partially_refunded', 'refunded').next).toBe('refunded');
  });

  it('未收款的失败/取消可被迟到的成功回调救回', () => {
    expect(reconcile('failed', 'captured').next).toBe('captured');
    expect(reconcile('canceled', 'captured').next).toBe('captured');
  });

  it('对全部状态组合：结果合法、changed 自洽、被拒必有原因', () => {
    for (const current of SETTLEMENT_STATES) {
      for (const observed of SETTLEMENT_STATES) {
        const decision = reconcile(current, observed);
        expect(SETTLEMENT_STATES).toContain(decision.next);
        expect(decision.changed).toBe(decision.next !== current);
        if (!decision.changed && current !== observed) {
          expect(decision.rejected).toBeDefined();
        }
      }
    }
  });

  it('钱已移动 / 终态的判定与状态表一致', () => {
    expect(SETTLEMENT_STATES.filter(isMoneyMoved)).toEqual(MONEY_MOVED);
    expect(SETTLEMENT_STATES.filter(isTerminal)).toEqual(['refunded', 'failed', 'canceled']);
  });
});
