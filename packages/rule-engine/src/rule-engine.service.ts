import { Injectable, Logger, Inject, Optional, OnModuleDestroy } from '@nestjs/common';
import type { TopicEventBus } from '@zucker-framework/event';
import { TOPIC_EVENT_BUS } from '@zucker-framework/event';
import { TermsEvaluator, type TermCondition } from './condition/terms-evaluator';
import { ExpressionEvaluator, type ExpressionCondition } from './condition/expression-evaluator';
import { BranchEvaluator, type Branch, type BranchActionGroup } from './condition/branch-evaluator';
import { NotifyAction, type NotifyActionConfig } from './action/notify-action';
import { HttpAction, type HttpActionConfig, type HttpActionOptions } from './action/http-action';
import { ScriptAction, type ScriptActionConfig } from './action/script-action';
import { DelayAction, type DelayActionConfig } from './action/delay-action';
import { DataMappingAction, type DataMappingActionConfig } from './action/data-mapping-action';
import { EventTrigger, type EventTriggerConfig } from './trigger/event-trigger';
import { TimerTrigger, type TimerTriggerConfig } from './trigger/timer-trigger';
import { RuleInstanceState } from './core/rule-instance-state';
import { RuleData } from './core/rule-data';

/** Types of conditions that can be evaluated in a rule. */
export enum RuleConditionType {
  TERMS = 'TERMS',
  EXPRESSION = 'EXPRESSION',
}

export enum RuleTriggerType {
  EVENT = 'EVENT',
  TIMER = 'TIMER',
  MANUAL = 'MANUAL',
}

export enum RuleActionType {
  NOTIFY = 'NOTIFY',
  HTTP = 'HTTP',
  SCRIPT = 'SCRIPT',
  DELAY = 'DELAY',
  DATA_MAPPING = 'DATA_MAPPING',
}

export interface RuleCondition {
  type: RuleConditionType;
  config: Record<string, unknown>;
}

export interface RuleAction {
  type: string;
  config: Record<string, unknown>;
  /** Output filter conditions — for serial execution, data must pass to continue. */
  terms?: TermCondition;
}

export interface RuleTrigger {
  type: RuleTriggerType;
  config: Record<string, unknown>;
}

/** Complete definition of a rule including its triggers, conditions, and actions. */
export interface RuleDefinition {
  id: string;
  name: string;
  triggers: RuleTrigger[];
  conditions: RuleCondition[];
  /** Top-level actions (flat execution). */
  actions: RuleAction[];
  /** Conditional branches with action groups (when/then). */
  branches?: Branch[];
  /** Whether top-level actions run in parallel (default: false = serial). */
  parallel?: boolean;
  enabled: boolean;
}

interface ActiveRule {
  definition: RuleDefinition;
  state: RuleInstanceState;
  eventTriggers: EventTrigger[];
  timerTriggers: TimerTrigger[];
  branchEvaluator?: BranchEvaluator;
}

/** Action executor function signature. */
type ActionHandler = (
  config: Record<string, unknown>,
  data: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** Core service for registering, evaluating, and executing rules with event/timer triggers. */
@Injectable()
export class RuleEngineService implements OnModuleDestroy {
  private readonly logger = new Logger(RuleEngineService.name);
  private activeRules = new Map<string, ActiveRule>();

  private termsEvaluator = new TermsEvaluator();
  private expressionEvaluator = new ExpressionEvaluator();
  private notifyAction = new NotifyAction();
  private httpAction = new HttpAction();
  private scriptAction = new ScriptAction();
  private delayAction = new DelayAction();
  private dataMappingAction = new DataMappingAction();

  /**
   * Configures HTTP actions (destination policy, private-network access, response size cap).
   * By default HTTP actions may only call public http/https destinations.
   */
  configureHttpAction(options: HttpActionOptions): void {
    this.httpAction = new HttpAction(options);
  }

  /** Strategy map for action execution — replaces switch/case in executeAction. */
  private readonly actionHandlers: Record<string, ActionHandler> = {
    [RuleActionType.NOTIFY]: (config, data) =>
      this.notifyAction.execute(config as unknown as NotifyActionConfig, data).then(() => undefined),
    [RuleActionType.HTTP]: (config, data) =>
      this.httpAction.execute(config as unknown as HttpActionConfig, data),
    [RuleActionType.SCRIPT]: (config, data) =>
      this.scriptAction.execute(config as unknown as ScriptActionConfig, data),
    [RuleActionType.DELAY]: (config, data) =>
      this.delayAction.execute(config as unknown as DelayActionConfig, data),
    [RuleActionType.DATA_MAPPING]: (config, data) =>
      this.dataMappingAction.execute(config as unknown as DataMappingActionConfig, data),
  };

  constructor(
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly eventBus?: TopicEventBus,
  ) {}

  onModuleDestroy(): void {
    this.stopAll();
  }

  async startRule(definition: RuleDefinition): Promise<void> {
    if (this.activeRules.has(definition.id)) {
      await this.stopRule(definition.id);
    }

    const activeRule: ActiveRule = {
      definition,
      state: RuleInstanceState.STARTED,
      eventTriggers: [],
      timerTriggers: [],
    };

    // Set up branch evaluator if branches are defined
    if (definition.branches && definition.branches.length > 0) {
      activeRule.branchEvaluator = new BranchEvaluator();
    }

    try {
      for (const trigger of definition.triggers) {
        this.setupTrigger(trigger, definition, activeRule);
      }
    } catch (error) {
      // Startup is atomic: even a later invalid trigger must release earlier subscriptions/timers.
      for (const trigger of [...activeRule.eventTriggers, ...activeRule.timerTriggers]) {
        try { trigger.stop(); } catch (cleanupError) {
          this.logger.warn('Failed to stop trigger after startup failure', cleanupError);
        }
      }
      throw error;
    }

    this.activeRules.set(definition.id, activeRule);
    this.logger.log(`Rule started: ${definition.name} (${definition.id})`);
  }

  async stopRule(id: string): Promise<void> {
    const activeRule = this.activeRules.get(id);
    if (!activeRule) return;

    activeRule.eventTriggers.forEach((t) => t.stop());
    activeRule.timerTriggers.forEach((t) => t.stop());
    activeRule.state = RuleInstanceState.DISABLED;
    this.activeRules.delete(id);
    this.logger.log(`Rule stopped: ${id}`);
  }

  async pauseRule(id: string): Promise<void> {
    const activeRule = this.activeRules.get(id);
    if (!activeRule) return;

    activeRule.state = RuleInstanceState.PAUSED;
    this.logger.log(`Rule paused: ${id}`);
  }

  async resumeRule(id: string): Promise<void> {
    const activeRule = this.activeRules.get(id);
    if (!activeRule || activeRule.state !== RuleInstanceState.PAUSED) return;

    activeRule.state = RuleInstanceState.STARTED;
    this.logger.log(`Rule resumed: ${id}`);
  }

  stopAll(): void {
    for (const id of this.activeRules.keys()) {
      this.stopRule(id);
    }
  }

  async executeRule(
    definition: RuleDefinition,
    data: Record<string, unknown>,
  ): Promise<void> {
    const activeRule = this.activeRules.get(definition.id);
    if (activeRule?.state === RuleInstanceState.PAUSED) {
      this.logger.debug(`Rule is paused, skipping: ${definition.name}`);
      return;
    }

    this.logger.debug(`Evaluating rule: ${definition.name}`);

    // Evaluate conditions
    if (!this.evaluateConditions(definition.conditions, data)) {
      this.logger.debug(`Rule conditions not met: ${definition.name}`);
      return;
    }

    // Execute branches if defined
    if (definition.branches && definition.branches.length > 0 && activeRule?.branchEvaluator) {
      await this.executeBranches(definition, activeRule.branchEvaluator, data);
      return;
    }

    // Execute top-level actions (parallel or serial)
    if (definition.parallel) {
      await this.executeActionsParallel(definition.actions, data);
    } else {
      await this.executeActionsSerial(definition.actions, data);
    }
  }

  /** Execute branch conditions and their associated action groups. */
  private async executeBranches(
    definition: RuleDefinition,
    branchEvaluator: BranchEvaluator,
    data: Record<string, unknown>,
  ): Promise<void> {
    const results = branchEvaluator.evaluate(definition.branches!, data);

    for (const result of results) {
      this.logger.debug(
        `Branch ${result.branchIndex} matched for rule ${definition.name}`,
      );

      for (const group of result.actionGroups) {
        await this.executeActionGroup(group, data);
      }
    }
  }

  /** Execute an action group (parallel or serial). */
  private async executeActionGroup(
    group: BranchActionGroup,
    data: Record<string, unknown>,
  ): Promise<void> {
    const actions: RuleAction[] = group.actions.map((a) => ({
      type: a.type,
      config: a.config,
    }));

    if (group.parallel) {
      await this.executeActionsParallel(actions, data);
    } else {
      await this.executeActionsSerial(actions, data);
    }
  }

  /** Execute actions in parallel. */
  private async executeActionsParallel(
    actions: RuleAction[],
    data: Record<string, unknown>,
  ): Promise<void> {
    const promises = actions.map(async (action) => {
      try {
        await this.executeAction(action, data);
      } catch (error) {
        this.logger.error(`Action failed: ${action.type}: ${error}`);
      }
    });
    await Promise.all(promises);
  }

  /** Execute actions serially, passing output from one to the next. */
  private async executeActionsSerial(
    actions: RuleAction[],
    data: Record<string, unknown>,
  ): Promise<void> {
    const ruleData = RuleData.of(data);
    let currentData = data;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // Check output filter terms from the previous action
      if (i > 0 && actions[i - 1].terms) {
        const previousTerms = actions[i - 1].terms!;
        if (!this.termsEvaluator.evaluate(currentData, previousTerms)) {
          this.logger.debug(`Serial action ${i} skipped: output filter not met`);
          break;
        }
      }

      try {
        const result = await this.executeAction(action, currentData);
        // Record action output in headers for downstream reference
        ruleData.setHeader(`action_${i + 1}`, result);

        // If the action returned data, use it as input for the next action
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          currentData = { ...currentData, ...(result as Record<string, unknown>) };
        }
      } catch (error) {
        this.logger.error(
          `Rule action failed: ${action.type} in serial chain at index ${i}: ${error}`,
        );
        break;
      }
    }
  }

  private async executeAction(
    action: RuleAction,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    const handler = this.actionHandlers[action.type];
    if (!handler) {
      this.logger.warn(`Unknown action type: ${action.type}`);
      return undefined;
    }
    return handler(action.config, data);
  }

  /** Set up a single trigger (event or timer) for a rule. */
  private setupTrigger(trigger: RuleTrigger, definition: RuleDefinition, activeRule: ActiveRule): void {
    if (trigger.type === RuleTriggerType.EVENT) {
      if (!this.eventBus) {
        this.logger.warn(
          `Event trigger skipped for rule "${definition.name}": no TopicEventBus provided`,
        );
        return;
      }
      const eventTrigger = new EventTrigger();
      activeRule.eventTriggers.push(eventTrigger);
      eventTrigger.start(
        trigger.config as unknown as EventTriggerConfig,
        this.eventBus,
        (payload) => this.executeRule(definition, payload as Record<string, unknown>),
      );
    } else if (trigger.type === RuleTriggerType.TIMER) {
      const timerTrigger = new TimerTrigger();
      activeRule.timerTriggers.push(timerTrigger);
      timerTrigger.start(
        trigger.config as unknown as TimerTriggerConfig,
        () => this.executeRule(definition, {}),
      );
    }
  }

  /** Evaluate all conditions for a rule — returns true if all pass. */
  private evaluateConditions(
    conditions: RuleCondition[],
    data: Record<string, unknown>,
  ): boolean {
    return conditions.every((condition) =>
      this.evaluateSingleCondition(condition, data),
    );
  }

  /** Evaluate a single condition by type. */
  private evaluateSingleCondition(
    condition: RuleCondition,
    data: Record<string, unknown>,
  ): boolean {
    if (condition.type === RuleConditionType.TERMS) {
      return this.termsEvaluator.evaluate(
        data,
        condition.config as unknown as TermCondition,
      );
    }
    if (condition.type === RuleConditionType.EXPRESSION) {
      return this.expressionEvaluator.evaluate(
        data,
        condition.config as unknown as ExpressionCondition,
      );
    }
    return false;
  }

  getActiveRules(): RuleDefinition[] {
    return Array.from(this.activeRules.values()).map((r) => r.definition);
  }

  isRuleActive(id: string): boolean {
    return this.activeRules.has(id);
  }

  getRuleState(id: string): RuleInstanceState | undefined {
    return this.activeRules.get(id)?.state;
  }
}
