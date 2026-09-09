import { Injectable, Inject, Logger } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { FormDefinition, FieldDefinition } from './form-definition';
import { FieldTypeRegistry } from './field-type';

import { DATABASE_ADAPTER } from '@zucker-framework/crud';

export interface FormValidationResult {
  valid: boolean;
  errors: Record<string, string[]>;
}

/** Compiled regex cache to avoid re-compiling the same pattern in validation loops */
const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_MAX_SIZE = 256;

function getCachedRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (regex) return regex;
  regex = new RegExp(pattern);
  if (regexCache.size >= REGEX_CACHE_MAX_SIZE) {
    const firstKey = regexCache.keys().next().value!;
    regexCache.delete(firstKey);
  }
  regexCache.set(pattern, regex);
  return regex;
}

@Injectable()
export class FormService {
  private readonly logger = new Logger(FormService.name);
  private readonly cache = new Map<string, FormDefinition>();

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  async findById(id: string): Promise<FormDefinition | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;

    const record = await this.db.model('formDefinition').findUnique({
      where: { id },
    });

    if (!record) return null;

    const form = record as unknown as FormDefinition;
    this.cache.set(id, form);
    return form;
  }

  async findAll(): Promise<FormDefinition[]> {
    return this.db.model('formDefinition').findMany() as unknown as FormDefinition[];
  }

  async create(form: FormDefinition): Promise<FormDefinition> {
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
          const regex = getCachedRegex(params.pattern as string);
          if (!regex.test(value)) return `Does not match pattern`;
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
