import { Injectable } from '@nestjs/common';
import { FeatureFlagEvaluator } from '@zucker/feature-flags';

@Injectable()
export class FeatureFlagService extends FeatureFlagEvaluator {
  constructor() {
    // This adapter intentionally binds the runtime-agnostic evaluator to Node.
    // eslint-disable-next-line no-restricted-syntax
    super((key) => process.env[key]);
  }
}

export { FeatureFlagEvaluator, defaultFeatureFlagEnvKey } from '@zucker/feature-flags';
export type {
  FeatureFlagDecisionReason,
  FeatureFlagEnvironmentReader,
  FeatureFlagEvaluation,
  FlagContext,
  FlagDefinition,
  FlagRule,
  FlagRuleType,
} from '@zucker/feature-flags';
