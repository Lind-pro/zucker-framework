// Service-level exports
export {
  RuleConditionType,
  RuleTriggerType,
  RuleActionType,
  type RuleCondition,
  type RuleAction,
  type RuleTrigger,
  type RuleDefinition,
  RuleEngineService,
} from './rule-engine.service';

// Condition evaluators
export { type Term, type TermCondition, TermsEvaluator } from './condition/terms-evaluator';
export { type ExpressionCondition, ExpressionEvaluator } from './condition/expression-evaluator';
export {
  type Branch,
  type BranchCondition,
  type BranchAction,
  type BranchActionGroup,
  type BranchEvaluationResult,
  BranchEvaluator,
} from './condition/branch-evaluator';

// Action executors
export { type NotifyActionConfig, type NotifyEvent, type NotifySender, NotifyAction } from './action/notify-action';
export { type HttpActionConfig, HttpAction } from './action/http-action';
export { type ScriptActionConfig, ScriptAction } from './action/script-action';
export {
  type DelayActionConfig,
  type DelayPauseType,
  type DelayTimeUnit,
  DelayAction,
} from './action/delay-action';
export {
  type DataMappingActionConfig,
  type DataMapping,
  DataMappingAction,
} from './action/data-mapping-action';

// Triggers
export { type EventTriggerConfig, EventTrigger } from './trigger/event-trigger';
export { type TimerTriggerConfig, TimerTrigger } from './trigger/timer-trigger';

// Core types
export { RuleData, type RuleDataHeaders } from './core/rule-data';
export {
  type ExecutionContext,
  type InputChannel,
  type OutputChannel,
  type JobContext,
} from './core/execution-context';
export {
  RuleConstants,
  TaskState,
  type TaskExecutionContext,
  type TaskExecutor,
  type TaskExecutorProvider,
  AbstractTaskExecutor,
} from './core/task-executor';
export { TaskExecutorRegistry } from './core/task-executor-registry';
export {
  RuleModel,
  type RuleNodeModel,
  type RuleLink,
  type ConditionSpec,
  type ExecutionMode,
} from './core/rule-model';
export { RuleInstanceState } from './core/rule-instance-state';
export {
  type ShakeLimitConfig,
  type ShakeLimitResult,
  createShakeLimit,
} from './core/shake-limit';

// Version management & testing
export { RuleVersionManager, RuleTestRunner } from './rule-version';
export type { RuleVersion, RuleTestCase, RuleTestResult } from './rule-version';

// Module
export { ZuckerRuleEngineModule } from './rule-engine.module';
