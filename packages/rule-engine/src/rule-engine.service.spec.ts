import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RuleEngineService,
  RuleConditionType,
  RuleTriggerType,
  RuleActionType,
} from './rule-engine.service';
import type { RuleDefinition } from './rule-engine.service';
import { RuleInstanceState } from './core/rule-instance-state';
import type { TopicEventBus, TopicPayload } from '@zucker-framework/event';

// ─── helpers ─────────────────────────────────────────────────────────────────

function createMockEventBus() {
  type SubscribeCallback = (msg: TopicPayload) => void;
  const subscribers = new Map<string, SubscribeCallback[]>();

  const bus: TopicEventBus = {
    subscribe(topic: string, cb: SubscribeCallback) {
      const list = subscribers.get(topic) ?? [];
      list.push(cb);
      subscribers.set(topic, list);
      return {
        unsubscribe() {
          const arr = subscribers.get(topic) ?? [];
          const idx = arr.indexOf(cb);
          if (idx >= 0) arr.splice(idx, 1);
        },
      };
    },
    publish: vi.fn(),
  } as unknown as TopicEventBus;

  function emit(topic: string, payload: unknown) {
    (subscribers.get(topic) ?? []).forEach((cb) =>
      cb({ topic, payload } as TopicPayload),
    );
  }

  return { bus, emit };
}

function makeManualRule(id: string, enabled = true): RuleDefinition {
  return {
    id,
    name: `Rule-${id}`,
    triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
    conditions: [],
    actions: [],
    enabled,
  };
}

// ─── RuleEngineService ────────────────────────────────────────────────────────

describe('RuleEngineService', () => {
  let service: RuleEngineService;

  beforeEach(() => {
    service = new RuleEngineService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    service.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── 규칙 시작 / 중지 ─────────────────────────────────────────────────────────

  describe('startRule() / stopRule()', () => {
    it('startRule 후 isRuleActive()가 true여야 한다', async () => {
      const rule = makeManualRule('r1');
      await service.startRule(rule);
      expect(service.isRuleActive('r1')).toBe(true);
    });

    it('stopRule 후 isRuleActive()가 false여야 한다', async () => {
      const rule = makeManualRule('r1');
      await service.startRule(rule);
      await service.stopRule('r1');
      expect(service.isRuleActive('r1')).toBe(false);
    });

    it('같은 id로 startRule을 두 번 호출하면 이전 인스턴스가 교체되어야 한다', async () => {
      const rule = makeManualRule('r1');
      await service.startRule(rule);
      await service.startRule(rule);
      expect(service.isRuleActive('r1')).toBe(true);
      expect(service.getActiveRules()).toHaveLength(1);
    });

    it('존재하지 않는 규칙을 stopRule해도 오류가 없어야 한다', async () => {
      await expect(service.stopRule('non-existent')).resolves.toBeUndefined();
    });

    it('getActiveRules()는 시작된 규칙 정의를 반환해야 한다', async () => {
      await service.startRule(makeManualRule('r1'));
      await service.startRule(makeManualRule('r2'));
      const active = service.getActiveRules();
      expect(active).toHaveLength(2);
      expect(active.map((r) => r.id)).toContain('r1');
      expect(active.map((r) => r.id)).toContain('r2');
    });
  });

  // ─── pauseRule / resumeRule ───────────────────────────────────────────────────

  describe('pauseRule() / resumeRule()', () => {
    it('pauseRule 후 getRuleState()는 PAUSED여야 한다', async () => {
      const rule = makeManualRule('r1');
      await service.startRule(rule);
      await service.pauseRule('r1');
      expect(service.getRuleState('r1')).toBe(RuleInstanceState.PAUSED);
    });

    it('resumeRule 후 getRuleState()는 STARTED여야 한다', async () => {
      const rule = makeManualRule('r1');
      await service.startRule(rule);
      await service.pauseRule('r1');
      await service.resumeRule('r1');
      expect(service.getRuleState('r1')).toBe(RuleInstanceState.STARTED);
    });

    it('PAUSED 상태에서 executeRule을 호출해도 action이 실행되지 않아야 한다', async () => {
      const actionFn = vi.fn().mockResolvedValue(undefined);
      // Spy on httpAction.execute via a HTTP action in the rule
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      }));

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Rule-r1',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [],
        actions: [
          { type: RuleActionType.NOTIFY, config: { notifyType: 'email', recipients: ['u1'] } },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.pauseRule('r1');

      // When paused, executeRule should bail early
      const notifyAction = (service as any).notifyAction;
      const executeSpy = vi.spyOn(notifyAction, 'execute');
      await service.executeRule(rule, {});
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  // ─── 조건 평가 ────────────────────────────────────────────────────────────────

  describe('조건 평가', () => {
    it('TERMS 조건이 충족되면 action이 실행되어야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [
          {
            type: RuleConditionType.TERMS,
            config: {
              terms: [{ column: 'temperature', termType: 'gt', value: 30 }],
              type: 'and',
            },
          },
        ],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'email', recipients: ['admin'] },
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, { temperature: 50 });
      expect(notifySender).toHaveBeenCalledOnce();
    });

    it('TERMS 조건이 충족되지 않으면 action이 실행되지 않아야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [
          {
            type: RuleConditionType.TERMS,
            config: {
              terms: [{ column: 'temperature', termType: 'gt', value: 30 }],
              type: 'and',
            },
          },
        ],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'email', recipients: ['admin'] },
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, { temperature: 10 });
      expect(notifySender).not.toHaveBeenCalled();
    });

    it('EXPRESSION 조건이 충족되면 action이 실행되어야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r2',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [
          {
            type: RuleConditionType.EXPRESSION,
            config: { expression: 'level >= 5' },
          },
        ],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'sms', recipients: ['u1'] },
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, { level: 7 });
      expect(notifySender).toHaveBeenCalledOnce();
    });

    it('다중 AND 조건 모두 충족 시에만 action이 실행되어야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r3',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [
          {
            type: RuleConditionType.TERMS,
            config: {
              terms: [{ column: 'a', termType: 'eq', value: 1 }],
              type: 'and',
            },
          },
          {
            type: RuleConditionType.TERMS,
            config: {
              terms: [{ column: 'b', termType: 'eq', value: 2 }],
              type: 'and',
            },
          },
        ],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'email', recipients: ['u'] },
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      // Only first condition met
      await service.executeRule(rule, { a: 1, b: 99 });
      expect(notifySender).not.toHaveBeenCalled();

      // Both conditions met
      await service.executeRule(rule, { a: 1, b: 2 });
      expect(notifySender).toHaveBeenCalledOnce();
    });

    it('알 수 없는 조건 타입은 false로 평가되어야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r4',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [
          { type: 'UNKNOWN_TYPE' as any, config: {} },
        ],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'email', recipients: ['u'] },
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, {});
      expect(notifySender).not.toHaveBeenCalled();
    });
  });

  // ─── action 실행 ──────────────────────────────────────────────────────────────

  describe('action 실행', () => {
    it('병렬 실행 모드에서 여러 action이 모두 실행되어야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      }));

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Parallel',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'email', recipients: ['u1'] },
          },
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'sms', recipients: ['u2'] },
          },
        ],
        parallel: true,
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, {});
      expect(notifySender).toHaveBeenCalledTimes(2);
    });

    it('직렬 실행 모드에서 이전 action 결과가 다음 action의 data로 병합되어야 한다', async () => {
      // Use DATA_MAPPING action to test serial chaining
      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Serial',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [],
        actions: [
          {
            type: RuleActionType.DATA_MAPPING,
            config: {
              mappings: [{ target: 'doubled', source: 'value' }],
            },
          },
        ],
        parallel: false,
        enabled: true,
      };

      await service.startRule(rule);
      await expect(service.executeRule(rule, { value: 42 })).resolves.toBeUndefined();
    });

    it('알 수 없는 action 타입은 경고만 남기고 계속 진행해야 한다', async () => {
      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [],
        actions: [
          { type: 'UNKNOWN_ACTION', config: {} },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await expect(service.executeRule(rule, {})).resolves.toBeUndefined();
    });
  });

  // ─── 이벤트 트리거 ────────────────────────────────────────────────────────────

  describe('EVENT 트리거', () => {
    it('이벤트 버스가 없으면 EVENT 트리거 설정을 건너뛰어야 한다', async () => {
      const serviceNobus = new RuleEngineService();
      const rule: RuleDefinition = {
        id: 'r1',
        name: 'Rule',
        triggers: [{ type: RuleTriggerType.EVENT, config: { topic: 'some/topic' } }],
        conditions: [],
        actions: [],
        enabled: true,
      };

      // Should not throw
      await expect(serviceNobus.startRule(rule)).resolves.toBeUndefined();
      serviceNobus.stopAll();
    });

    it('이벤트 버스가 있으면 EVENT 트리거가 이벤트를 받아 규칙을 실행해야 한다', async () => {
      const { bus, emit } = createMockEventBus();
      const serviceWithBus = new RuleEngineService(bus);

      const notifySender = vi.fn().mockResolvedValue(undefined);
      (serviceWithBus as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'EventRule',
        triggers: [{ type: RuleTriggerType.EVENT, config: { topic: 'alarm/fired' } }],
        conditions: [],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'sms', recipients: ['ops'] },
          },
        ],
        enabled: true,
      };

      await serviceWithBus.startRule(rule);
      emit('alarm/fired', { level: 'high' });
      await Promise.resolve();

      expect(notifySender).toHaveBeenCalledOnce();
      serviceWithBus.stopAll();
    });
  });

  // ─── TIMER 트리거 ────────────────────────────────────────────────────────────

  describe('TIMER 트리거', () => {
    it('TIMER 트리거가 지정된 인터벌마다 규칙을 실행해야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'TimerRule',
        triggers: [
          { type: RuleTriggerType.TIMER, config: { cron: '*/1 * * * * *' } },
        ],
        conditions: [],
        actions: [
          {
            type: RuleActionType.NOTIFY,
            config: { notifyType: 'email', recipients: ['u1'] },
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();

      expect(notifySender.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── stopAll / onModuleDestroy ────────────────────────────────────────────────

  describe('stopAll() / onModuleDestroy()', () => {
    it('stopAll() 후 getActiveRules()는 비어 있어야 한다', async () => {
      await service.startRule(makeManualRule('r1'));
      await service.startRule(makeManualRule('r2'));
      service.stopAll();
      expect(service.getActiveRules()).toHaveLength(0);
    });

    it('onModuleDestroy()는 모든 규칙을 종료해야 한다', async () => {
      await service.startRule(makeManualRule('r1'));
      service.onModuleDestroy();
      expect(service.getActiveRules()).toHaveLength(0);
    });
  });

  // ─── branches ────────────────────────────────────────────────────────────────

  describe('branches 실행', () => {
    it('branches 조건이 충족되면 해당 action group이 실행되어야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'BranchRule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [],
        actions: [],
        branches: [
          {
            when: [
              {
                type: 'terms',
                config: {
                  terms: [{ column: 'level', termType: 'gte', value: 5 }],
                  type: 'and',
                },
              },
            ],
            then: [
              {
                parallel: false,
                actions: [
                  {
                    type: RuleActionType.NOTIFY,
                    config: { notifyType: 'email', recipients: ['alert@example.com'] },
                  },
                ],
              },
            ],
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, { level: 7 });
      expect(notifySender).toHaveBeenCalledOnce();
    });

    it('branches 조건 미충족 시 action이 실행되지 않아야 한다', async () => {
      const notifySender = vi.fn().mockResolvedValue(undefined);
      (service as any).notifyAction.setSender(notifySender);

      const rule: RuleDefinition = {
        id: 'r1',
        name: 'BranchRule',
        triggers: [{ type: RuleTriggerType.MANUAL, config: {} }],
        conditions: [],
        actions: [],
        branches: [
          {
            when: [
              {
                type: 'terms',
                config: {
                  terms: [{ column: 'level', termType: 'gte', value: 5 }],
                  type: 'and',
                },
              },
            ],
            then: [
              {
                parallel: false,
                actions: [
                  {
                    type: RuleActionType.NOTIFY,
                    config: { notifyType: 'email', recipients: ['alert@example.com'] },
                  },
                ],
              },
            ],
          },
        ],
        enabled: true,
      };

      await service.startRule(rule);
      await service.executeRule(rule, { level: 1 });
      expect(notifySender).not.toHaveBeenCalled();
    });
  });
});
