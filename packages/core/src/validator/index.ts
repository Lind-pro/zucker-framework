/**
 * 验证工具
 * 参考: hsweb-framework ValidatorUtils.java, CreateGroup, UpdateGroup
 *
 * 对比 hsweb:
 * - 保留分组常量
 * - 增加 tryValidate 工具函数（对齐 hsweb ValidatorUtils.tryValidate）
 * - 增加 validateProperty 单属性验证
 */

import { ValidationException } from '../exceptions';

export const CreateGroup = 'create';
export const UpdateGroup = 'update';

/** 验证规则定义 */
export interface ValidationRule {
  /** 验证函数，返回 true 表示通过 */
  validate: (value: unknown, obj?: Record<string, unknown>) => boolean;
  /** 错误消息 */
  message: string;
}

/** 属性验证规则映射 */
export type ValidationSchema = Record<string, ValidationRule[]>;

/**
 * 验证对象
 * 参考 hsweb ValidatorUtils.tryValidate(bean, group)
 *
 * @param obj 待验证的对象
 * @param schema 验证规则
 * @returns 通过验证的对象（原样返回）
 * @throws ValidationException 验证失败时抛出
 */
export function tryValidate<T extends Record<string, unknown>>(
  obj: T,
  schema: ValidationSchema,
): T {
  const errors: Record<string, string[]> = {};

  for (const [property, rules] of Object.entries(schema)) {
    const value = obj[property];
    for (const rule of rules) {
      if (!rule.validate(value, obj)) {
        if (!errors[property]) {
          errors[property] = [];
        }
        errors[property].push(rule.message);
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationException(errors);
  }

  return obj;
}

/**
 * 验证单个属性
 * 参考 hsweb ValidatorUtils.tryValidate(bean, property, group)
 */
export function validateProperty<T extends Record<string, unknown>>(
  obj: T,
  property: string,
  rules: ValidationRule[],
): T {
  const errors: Record<string, string[]> = {};
  const value = obj[property];

  for (const rule of rules) {
    if (!rule.validate(value, obj)) {
      if (!errors[property]) {
        errors[property] = [];
      }
      errors[property].push(rule.message);
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationException(errors);
  }

  return obj;
}

/**
 * 验证单个值（不需要完整对象）
 * 参考 hsweb ValidatorUtils.tryValidate(Class<T>, property, value, group)
 */
export function validateValue(
  property: string,
  value: unknown,
  rules: ValidationRule[],
): void {
  const errors: Record<string, string[]> = {};

  for (const rule of rules) {
    if (!rule.validate(value)) {
      if (!errors[property]) {
        errors[property] = [];
      }
      errors[property].push(rule.message);
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationException(errors);
  }
}

// ---- 常用内置验证规则（参考 javax.validation 常用注解） ----

export const Rules = {
  /** 非空验证（@NotNull / @NotBlank） */
  required(message = '不能为空'): ValidationRule {
    return {
      validate: (value) =>
        value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0),
      message,
    };
  },

  /** 最小长度（@Size(min=)） */
  minLength(min: number, message?: string): ValidationRule {
    return {
      validate: (value) =>
        typeof value === 'string' ? value.length >= min : true,
      message: message ?? `长度不能小于 ${min}`,
    };
  },

  /** 最大长度（@Size(max=)） */
  maxLength(max: number, message?: string): ValidationRule {
    return {
      validate: (value) =>
        typeof value === 'string' ? value.length <= max : true,
      message: message ?? `长度不能大于 ${max}`,
    };
  },

  /** 正则匹配（@Pattern） */
  pattern(regex: RegExp, message = '格式不正确'): ValidationRule {
    return {
      validate: (value) =>
        typeof value === 'string' ? regex.test(value) : true,
      message,
    };
  },

  /** 数值范围（@Min / @Max） */
  range(min: number, max: number, message?: string): ValidationRule {
    return {
      validate: (value) =>
        typeof value === 'number' ? value >= min && value <= max : true,
      message: message ?? `值必须在 ${min} 到 ${max} 之间`,
    };
  },

  /** 邮箱格式（@Email） */
  email(message = '邮箱格式不正确'): ValidationRule {
    return {
      validate: (value) =>
        typeof value === 'string' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : true,
      message,
    };
  },
};
