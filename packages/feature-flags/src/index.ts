import { createHash } from 'node:crypto';

export interface FlagContext {
  userId?: string;
  tenantId?: string;
  roles?: string[];
  attributes?: Record<string, string | number | boolean>;
}

export type FlagRuleType = 'percentage' | 'allowlist' | 'blocklist' | 'attribute';

export interface FlagRule {
  type: FlagRuleType;
  percentage?: number;
  values?: string[];
  attribute?: {
    key: string;
    operator: 'eq' | 'neq' | 'in';
    value: unknown;
  };
}

export interface FlagDefinition {
  key: string;
  description?: string;
  defaultValue: boolean;
  rules?: FlagRule[];
  /** An explicit deployment variable, otherwise FF_<NORMALIZED_KEY> is used. */
  envKey?: string;
  /** Exact values that enable the flag. Defaults to ['true', '1']. */
  envEnabledValues?: readonly string[];
  /** Trim and lowercase environment values before comparison. Disabled by default. */
  normalizeEnvValue?: boolean;
  /** Disables rules and overrides while preserving environment emergency control. */
  enabled?: boolean;
}

export type FeatureFlagDecisionReason =
  | 'environment'
  | 'user-override'
  | 'tenant-override'
  | 'rule'
  | 'disabled'
  | 'default'
  | 'unregistered';

/**
 * Safe metadata for audit logs and metrics. It intentionally excludes subject
 * identifiers, attributes, roles, and raw environment values.
 */
export interface FeatureFlagEvaluation {
  key: string;
  enabled: boolean;
  reason: FeatureFlagDecisionReason;
  envKey?: string;
  ruleIndex?: number;
  ruleType?: FlagRuleType;
  bucket?: number;
}

export type FeatureFlagEnvironmentReader = (key: string) => string | undefined;

interface RuleEvaluation {
  enabled: boolean;
  bucket?: number;
}

const DEFAULT_ENV_ENABLED_VALUES = ['true', '1'] as const;

export function defaultFeatureFlagEnvKey(key: string): string {
  return `FF_${key.toUpperCase().replace(/[.-]/g, '_')}`;
}

export class FeatureFlagEvaluator {
  private readonly flags = new Map<string, FlagDefinition>();
  private readonly overrides = new Map<string, Map<string, boolean>>();

  constructor(private readonly readEnvironment: FeatureFlagEnvironmentReader = () => undefined) {}

  register(definition: FlagDefinition): void {
    this.flags.set(definition.key, definition);
  }

  registerAll(definitions: readonly FlagDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  isEnabled(key: string, context: FlagContext = {}): boolean {
    return this.evaluate(key, context).enabled;
  }

  evaluate(key: string, context: FlagContext = {}): FeatureFlagEvaluation {
    const flag = this.flags.get(key);
    const envKey = flag?.envKey ?? defaultFeatureFlagEnvKey(key);
    const envValue = this.readEnvironment(envKey);

    // Environment control remains first so operators can stop a rollout even
    // when an in-memory override or rule would otherwise enable it.
    if (envValue !== undefined) {
      return {
        key,
        enabled: this.isEnabledEnvironmentValue(envValue, flag),
        reason: 'environment',
        envKey,
      };
    }

    if (!flag) return { key, enabled: false, reason: 'unregistered' };
    if (flag.enabled === false) {
      return { key, enabled: flag.defaultValue, reason: 'disabled' };
    }

    const overrideMap = this.overrides.get(key);
    if (overrideMap) {
      if (context.userId && overrideMap.has(`user:${context.userId}`)) {
        const enabled = overrideMap.get(`user:${context.userId}`);
        return {
          key,
          enabled: enabled ?? false,
          reason: 'user-override',
        };
      }
      if (context.tenantId && overrideMap.has(`tenant:${context.tenantId}`)) {
        const enabled = overrideMap.get(`tenant:${context.tenantId}`);
        return {
          key,
          enabled: enabled ?? false,
          reason: 'tenant-override',
        };
      }
    }

    for (const [ruleIndex, rule] of (flag.rules ?? []).entries()) {
      const evaluation = this.evaluateRule(rule, key, context);
      if (!evaluation) continue;
      return {
        key,
        enabled: evaluation.enabled,
        reason: 'rule',
        ruleIndex,
        ruleType: rule.type,
        bucket: evaluation.bucket,
      };
    }

    return { key, enabled: flag.defaultValue, reason: 'default' };
  }

  getValue<T>(key: string, defaultValue: T): T {
    const flag = this.flags.get(key);
    if (!flag) return defaultValue;
    return (flag as unknown as { value?: T }).value ?? defaultValue;
  }

  setUserOverride(flagKey: string, userId: string, value: boolean): void {
    this.getOrCreateOverrideMap(flagKey).set(`user:${userId}`, value);
  }

  setTenantOverride(flagKey: string, tenantId: string, value: boolean): void {
    this.getOrCreateOverrideMap(flagKey).set(`tenant:${tenantId}`, value);
  }

  clearOverride(flagKey: string, contextKey: string): void {
    this.overrides.get(flagKey)?.delete(contextKey);
  }

  clearAllOverrides(flagKey?: string): void {
    if (flagKey) this.overrides.delete(flagKey);
    else this.overrides.clear();
  }

  getAllFlags(): FlagDefinition[] {
    return [...this.flags.values()];
  }

  getFlag(key: string): FlagDefinition | undefined {
    return this.flags.get(key);
  }

  private isEnabledEnvironmentValue(rawValue: string, flag: FlagDefinition | undefined): boolean {
    const normalize = flag?.normalizeEnvValue === true;
    const value = normalize ? rawValue.trim().toLowerCase() : rawValue;
    const enabledValues = flag?.envEnabledValues ?? DEFAULT_ENV_ENABLED_VALUES;

    return enabledValues.some((candidate) => {
      const normalizedCandidate = normalize ? candidate.trim().toLowerCase() : candidate;
      return value === normalizedCandidate;
    });
  }

  private evaluateRule(
    rule: FlagRule,
    flagKey: string,
    context: FlagContext,
  ): RuleEvaluation | undefined {
    switch (rule.type) {
      case 'percentage': {
        if (rule.percentage === undefined) return undefined;
        if (rule.percentage >= 100) return { enabled: true };
        if (rule.percentage <= 0) return { enabled: false };
        const identifier = context.userId ?? context.tenantId ?? 'anonymous';
        const bucket = this.stableBucket(`${flagKey}:${identifier}`);
        return { enabled: bucket < rule.percentage, bucket };
      }
      case 'allowlist': {
        if (!rule.values?.length) return undefined;
        const values = rule.values;
        const identifiers = [context.userId, context.tenantId].filter(Boolean) as string[];
        if (identifiers.some((identifier) => values.includes(identifier))) {
          return { enabled: true };
        }
        if (context.roles?.some((role) => values.includes(role))) {
          return { enabled: true };
        }
        return undefined;
      }
      case 'blocklist': {
        if (!rule.values?.length) return undefined;
        const values = rule.values;
        const identifiers = [context.userId, context.tenantId].filter(Boolean) as string[];
        return identifiers.some((identifier) => values.includes(identifier))
          ? { enabled: false }
          : undefined;
      }
      case 'attribute': {
        if (!rule.attribute || !context.attributes) return undefined;
        const attributeValue = context.attributes[rule.attribute.key];
        if (attributeValue === undefined) return undefined;

        switch (rule.attribute.operator) {
          case 'eq':
            return attributeValue === rule.attribute.value ? { enabled: true } : undefined;
          case 'neq':
            return attributeValue !== rule.attribute.value ? { enabled: true } : undefined;
          case 'in':
            return Array.isArray(rule.attribute.value) &&
              rule.attribute.value.includes(attributeValue)
              ? { enabled: true }
              : undefined;
          default:
            return undefined;
        }
      }
      default:
        return undefined;
    }
  }

  /** MD5 is retained only to preserve existing rollout buckets, not for security. */
  private stableBucket(input: string): number {
    const hash = createHash('md5').update(input).digest();
    return hash.readUInt16BE(0) % 100;
  }

  private getOrCreateOverrideMap(flagKey: string): Map<string, boolean> {
    let overrideMap = this.overrides.get(flagKey);
    if (!overrideMap) {
      overrideMap = new Map<string, boolean>();
      this.overrides.set(flagKey, overrideMap);
    }
    return overrideMap;
  }
}
