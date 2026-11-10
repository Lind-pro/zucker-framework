import { Injectable, Inject, Logger } from '@nestjs/common';
import { Script, createContext } from 'node:vm';
import { ValidationException, type DatabaseAdapter } from '@zucker-framework/core';
import type { FormDefinition, FieldDefinition } from './form-definition';
import { FieldTypeRegistry } from './field-type';

import { DATABASE_ADAPTER } from '@zucker-framework/crud';

export interface FormValidationResult {
  valid: boolean;
  errors: Record<string, string[]>;
}

/** Compiled regex cache to avoid re-compiling the same pattern in validation loops */
const regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_MAX_SIZE = 256;
/** Stored patterns are admin-supplied; bound their size and the size of the tested value. */
export const FORM_PATTERN_MAX_LENGTH = 512;
export const FORM_PATTERN_MAX_INPUT_LENGTH = 10_000;
/**
 * A quantified group that itself ends in a variable quantifier, e.g. `(a+)+`, `(\w*)*`, `(x|y+){2,}`.
 * A fixed inner count (`(?:\d{4})+`) is not variable and is allowed.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})\)\s*(?:[+*]|\{\d+,?\d*\})/;
/**
 * Upper bound for one pattern test. The static guard above misses cases such as `(a|a)*$` or
 * `(.*a){20}`; the test runs in a `node:vm` context whose timeout interrupts a backtracking match.
 */
export const FORM_PATTERN_TIMEOUT_MS = 50;
const patternContext = createContext({});
const patternTest = new Script('pattern.test(value)');

/**
 * Tests `value` against a compiled form pattern with a time limit. Returns `false` for a value that
 * does not match and `null` when the match was interrupted after {@link FORM_PATTERN_TIMEOUT_MS}.
 */
export function testFormPattern(pattern: RegExp, value: string): boolean | null {
  pattern.lastIndex = 0;
  const context = patternContext as { pattern?: RegExp; value?: string };
  context.pattern = pattern;
  context.value = value;
  try {
    return patternTest.runInContext(patternContext, { timeout: FORM_PATTERN_TIMEOUT_MS }) === true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw error;
  } finally {
    context.pattern = undefined;
    context.value = undefined;
  }
}

/**
 * Compiles a stored validator pattern, or returns null when it is invalid, too long or has a nested
 * quantifier (catastrophic backtracking would block the event loop on every submission).
 */
export function compileFormPattern(pattern: unknown): RegExp | null {
  if (typeof pattern !== 'string') return null;
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  let regex: RegExp | null = null;
  if (pattern.length <= FORM_PATTERN_MAX_LENGTH && !NESTED_QUANTIFIER.test(pattern)) {
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = null;
    }
  }
  if (regexCache.size >= REGEX_CACHE_MAX_SIZE) {
    const firstKey = regexCache.keys().next().value!;
    regexCache.delete(firstKey);
  }
  regexCache.set(pattern, regex);
  return regex;
}

/** How long a form definition stays cached per instance; other replicas see updates after this. */
const FORM_CACHE_TTL_MS = 30_000;

@Injectable()
export class FormService {
  private readonly logger = new Logger(FormService.name);
  private readonly cache = new Map<string, { form: FormDefinition; expiresAt: number }>();

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  async findById(id: string): Promise<FormDefinition | null> {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.form;
    this.cache.delete(id);

    const record = await this.db.model('formDefinition').findUnique({
      where: { id },
    });

    if (!record) return null;

    const form = record as unknown as FormDefinition;
    this.cache.set(id, { form, expiresAt: Date.now() + FORM_CACHE_TTL_MS });
    return form;
  }

  async findAll(): Promise<FormDefinition[]> {
    return this.db.model('formDefinition').findMany() as unknown as FormDefinition[];
  }

  async create(form: FormDefinition): Promise<FormDefinition> {
    assertValidPatterns(form.fields);
    const result = await this.db.model('formDefinition').create({
      data: form as unknown as Record<string, unknown>,
    });
    this.cache.delete(form.id);
    return result as unknown as FormDefinition;
  }

  async update(
    id: string,
    data: Partial<FormDefinition>,
  ): Promise<FormDefinition> {
    if (data.fields) assertValidPatterns(data.fields);
    const result = await this.db.model('formDefinition').update({
      where: { id },
      data: data as unknown as Record<string, unknown>,
    });
    this.cache.delete(id);
    return result as unknown as FormDefinition;
  }

  async delete(id: string): Promise<void> {
    await this.db.model('formDefinition').delete({ where: { id } });
    this.cache.delete(id);
  }

  /**
   * Validate data against a form definition.
   */
  validateData(
    form: FormDefinition,
    data: Record<string, unknown>,
  ): FormValidationResult {
    const errors: Record<string, string[]> = {};

    for (const field of form.fields) {
      const value = data[field.key];
      const fieldErrors = this.validateField(field, value);
      if (fieldErrors.length > 0) {
        errors[field.key] = fieldErrors;
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
    };
  }

  private validateField(
    field: FieldDefinition,
    value: unknown,
  ): string[] {
    const errors: string[] = [];

    // Required check
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.name} is required`);
      return errors;
    }

    // Skip further validation if empty and not required
    if (value === undefined || value === null) return errors;

    // Type validation via registry
    const provider = FieldTypeRegistry.get(field.type);
    if (provider) {
      const typeError = provider.validate(value);
      if (typeError) errors.push(typeError);
    } else {
      this.logger.warn(`Field type "${field.type}" has no registered provider, type validation skipped for field "${field.name}"`);
    }

    // Custom validators
    if (field.validators) {
      for (const validator of field.validators) {
        const error = this.runValidator(validator.type, value, validator.params);
        if (error) errors.push(validator.message || error);
      }
    }

    // Enum validation
    if (field.options?.length) {
      const validValues = field.options.map((o) => o.value);
      if (!validValues.includes(value as string | number)) {
        errors.push(`${field.name} must be one of: ${validValues.join(', ')}`);
      }
    }

    return errors;
  }

  private runValidator(
    type: string,
    value: unknown,
    params?: Record<string, unknown>,
  ): string | null {
    switch (type) {
      case 'minLength':
        if (typeof value === 'string' && value.length < (params?.min as number ?? 0)) {
          return `Minimum length is ${params?.min}`;
        }
        break;
      case 'maxLength':
        if (typeof value === 'string' && value.length > (params?.max as number ?? Infinity)) {
          return `Maximum length is ${params?.max}`;
        }
        break;
      case 'min':
        if (typeof value === 'number' && value < (params?.min as number ?? -Infinity)) {
          return `Minimum value is ${params?.min}`;
        }
        break;
      case 'max':
        if (typeof value === 'number' && value > (params?.max as number ?? Infinity)) {
          return `Maximum value is ${params?.max}`;
        }
        break;
      case 'pattern':
        if (typeof value === 'string' && params?.pattern) {
          const regex = compileFormPattern(params.pattern);
          if (!regex) {
            this.logger.warn('Form validator pattern is invalid or unsafe; value rejected');
            return `Does not match pattern`;
          }
          if (value.length > FORM_PATTERN_MAX_INPUT_LENGTH) return `Does not match pattern`;
          const matched = testFormPattern(regex, value);
          if (matched === null) {
            this.logger.warn(`Form validator pattern exceeded ${FORM_PATTERN_TIMEOUT_MS} ms; value rejected`);
            return `Does not match pattern`;
          }
          if (!matched) return `Does not match pattern`;
        }
        break;
    }
    return null;
  }

  /**
   * 保存表单定义（自动版本递增）
   */
  async saveWithVersion(form: FormDefinition): Promise<FormDefinition> {
    const existing = await this.findById(form.id);
    if (existing) {
      const newVersion = (existing.version ?? 0) + 1;
      return this.update(form.id, { ...form, version: newVersion });
    }
    return this.create({ ...form, version: form.version ?? 1 });
  }

  /**
   * 复制表单为模板
   */
  async cloneAsTemplate(
    sourceId: string,
    newId: string,
    newName: string,
  ): Promise<FormDefinition> {
    const source = await this.findById(sourceId);
    if (!source) {
      const { NotFoundException } = await import('@zucker-framework/core');
      throw new NotFoundException(`Form ${sourceId} not found`);
    }
    return this.create({
      ...source,
      id: newId,
      name: newName,
      version: 1,
    });
  }

  /**
   * 批量验证多条数据
   */
  validateBatch(
    form: FormDefinition,
    dataList: Record<string, unknown>[],
  ): Array<FormValidationResult & { index: number }> {
    return dataList.map((data, index) => ({
      ...this.validateData(form, data),
      index,
    }));
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function assertValidPatterns(fields: FieldDefinition[] | undefined): void {
  const errors: Record<string, string[]> = {};
  for (const field of fields ?? []) {
    for (const validator of field.validators ?? []) {
      if (validator.type === 'pattern' && !compileFormPattern(validator.params?.pattern)) {
        (errors[field.key] ??= []).push('Validator pattern is invalid, too long or has nested quantifiers');
      }
    }
  }
  if (Object.keys(errors).length) throw new ValidationException(errors, 'Invalid form validator pattern');
}
