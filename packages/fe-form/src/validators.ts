import type { FormRule as Rule } from 'antd';
import type { FieldValidator } from './types';

/**
 * Read a validator parameter using the server's name (`@zucker-framework/form`: `min`, `max`,
 * `pattern`) and fall back to the legacy client spelling `value`.
 */
function param(params: Record<string, unknown> | undefined, name: string): unknown {
  return params?.[name] ?? params?.value;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Compile a caller-authored pattern; an invalid one is skipped instead of crashing the render. */
export function compilePattern(source: unknown): RegExp | undefined {
  if (source instanceof RegExp) return source;
  if (typeof source !== 'string') return undefined;
  try {
    return new RegExp(source);
  } catch {
    if (typeof console !== 'undefined') console.warn('[fe-form] Ignoring invalid validator pattern');
    return undefined;
  }
}

export function toAntdRules(
  validators: FieldValidator[] = [],
  required?: boolean,
  requiredMessage = '该字段为必填项',
): Rule[] {
  const rules: Rule[] = [];

  if (required) {
    rules.push({ required: true, message: requiredMessage });
  }

  for (const v of validators) {
    switch (v.type) {
      case 'required':
        rules.push({ required: true, message: v.message });
        break;
      case 'minLength': {
        const min = finiteNumber(param(v.params, 'min'));
        if (min !== undefined) rules.push({ min, message: v.message });
        break;
      }
      case 'maxLength': {
        const max = finiteNumber(param(v.params, 'max'));
        if (max !== undefined) rules.push({ max, message: v.message });
        break;
      }
      case 'min': {
        const min = finiteNumber(param(v.params, 'min'));
        if (min !== undefined) rules.push({ type: 'number', min, message: v.message });
        break;
      }
      case 'max': {
        const max = finiteNumber(param(v.params, 'max'));
        if (max !== undefined) rules.push({ type: 'number', max, message: v.message });
        break;
      }
      case 'pattern': {
        const pattern = compilePattern(param(v.params, 'pattern'));
        if (pattern) rules.push({ pattern, message: v.message });
        break;
      }
      case 'enum':
        if (Array.isArray(v.params?.values))
          rules.push({ type: 'enum', enum: v.params.values as unknown[], message: v.message });
        break;
      case 'email':
        rules.push({ type: 'email', message: v.message });
        break;
      case 'url':
        rules.push({ type: 'url', message: v.message });
        break;
      default:
        break;
    }
  }

  return rules;
}
