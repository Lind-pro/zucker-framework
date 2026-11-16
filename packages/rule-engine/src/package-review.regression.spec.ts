import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuleEngineService, RuleTriggerType } from './rule-engine.service';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Package review regressions', () => {
  it('R09: failed rule startup releases every acquired trigger', async () => {
    const listeners = new Set<unknown>();
    const eventBus = { subscribe: (_topic: string, handler: unknown) => {
      listeners.add(handler); return { unsubscribe: () => listeners.delete(handler) };
    } };
    const service = new RuleEngineService(eventBus as never);
    await expect(service.startRule({ id: 'r', name: 'r', enabled: true, conditions: [], actions: [], triggers: [
      { type: RuleTriggerType.EVENT, config: { topic: 'test' } },
      { type: RuleTriggerType.TIMER, config: { cron: 'invalid' } },
    ] })).rejects.toThrow();
    expect(service.isRuleActive('r')).toBe(false);
    service.onModuleDestroy();
    expect(listeners.size).toBe(0);
    listeners.clear();
  });

});
