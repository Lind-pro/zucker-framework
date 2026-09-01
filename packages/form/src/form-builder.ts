import type { FormDefinition, FieldDefinition, FieldValidator, FieldOption, FormLayout } from './form-definition';

/**
 * FormBuilder — 流式 API 构建表单定义。
 * 对标 hsweb/jetlinks 表单构造器模式。
 *
 * @example
 * const form = FormBuilder.create('user-form', '用户表单')
 *   .layout({ columns: 2, labelPosition: 'left' })
 *   .group('基本信息')
 *     .string('username', '用户名', { required: true, minLength: 2, maxLength: 32 })
 *     .string('email', '邮箱', { pattern: '^[\\w.-]+@[\\w.-]+\\.\\w+$' })
 *     .number('age', '年龄', { min: 1, max: 200 })
 *   .group('权限设置')
 *     .enum('role', '角色', [{ label: '管理员', value: 'admin' }, { label: '用户', value: 'user' }])
 *     .boolean('enabled', '启用', { defaultValue: true })
 *   .condition('role', 'admin')
 *     .string('adminKey', '管理密钥', { required: true })
 *   .endCondition()
 *   .build();
 */
export class FormBuilder {
  private readonly fields: (FieldDefinition & { group?: string; condition?: FieldCondition })[] = [];
  private formLayout?: FormLayout;
  private description?: string;
  private version = 1;
  private currentGroup?: string;
  private currentCondition?: FieldCondition;

  private constructor(
    private readonly id: string,
    private readonly name: string,
  ) {}

  static create(id: string, name: string): FormBuilder {
    return new FormBuilder(id, name);
  }

  layout(layout: FormLayout): this {
    this.formLayout = layout;
    return this;
  }

  describe(desc: string): this {
    this.description = desc;
    return this;
  }

  setVersion(v: number): this {
    this.version = v;
    return this;
  }

  /** 开始一个字段分组 */
  group(groupName: string): this {
    this.currentGroup = groupName;
    return this;
  }

  /** 设置条件渲染：仅当 fieldKey === value 时显示后续字段 */
  condition(fieldKey: string, value: unknown): this {
    this.currentCondition = { fieldKey, operator: '==', value };
    return this;
  }

  /** 结束条件渲染块 */
  endCondition(): this {
    this.currentCondition = undefined;
    return this;
  }

  string(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'STRING', opts);
  }

  number(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'NUMBER', opts);
  }

  boolean(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'BOOLEAN', opts);
  }

  date(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'DATE', opts);
  }

  datetime(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'DATETIME', opts);
  }

  enum(key: string, name: string, options: FieldOption[], opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'ENUM', { ...opts, options });
  }

  json(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'JSON', opts);
  }

  array(key: string, name: string, elementType: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'ARRAY', { ...opts, elementType });
  }

  textarea(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'TEXTAREA', opts);
  }

  richtext(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'RICHTEXT', opts);
  }

  file(key: string, name: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'FILE', opts);
  }

  relation(key: string, name: string, target: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, 'RELATION', { ...opts, relationTarget: target });
  }

  /** 添加自定义类型字段 */
  custom(key: string, name: string, type: string, opts?: FieldBuilderOptions): this {
    return this.addField(key, name, type, opts);
  }

  private addField(key: string, name: string, type: string, opts?: FieldBuilderOptions): this {
    const validators: FieldValidator[] = [];
    if (opts?.minLength !== undefined) validators.push({ type: 'minLength', message: `最少 ${opts.minLength} 个字符`, params: { min: opts.minLength } });
    if (opts?.maxLength !== undefined) validators.push({ type: 'maxLength', message: `最多 ${opts.maxLength} 个字符`, params: { max: opts.maxLength } });
    if (opts?.min !== undefined) validators.push({ type: 'min', message: `最小值 ${opts.min}`, params: { min: opts.min } });
    if (opts?.max !== undefined) validators.push({ type: 'max', message: `最大值 ${opts.max}`, params: { max: opts.max } });
    if (opts?.pattern) validators.push({ type: 'pattern', message: opts.patternMessage ?? '格式不正确', params: { pattern: opts.pattern } });

    const field: FieldDefinition & { group?: string; condition?: FieldCondition } = {
      key,
      name,
      type,
      required: opts?.required ?? false,
      defaultValue: opts?.defaultValue,
      description: opts?.description,
      options: opts?.options,
      validators: validators.length > 0 ? validators : undefined,
      elementType: opts?.elementType,
      relationTarget: opts?.relationTarget,
      extra: {
        ...(opts?.extra ?? {}),
        ...(this.currentGroup ? { group: this.currentGroup } : {}),
        ...(this.currentCondition ? { condition: this.currentCondition } : {}),
        ...(opts?.placeholder ? { placeholder: opts.placeholder } : {}),
        ...(opts?.hidden ? { hidden: true } : {}),
        ...(opts?.readOnly ? { readOnly: true } : {}),
        ...(opts?.span ? { span: opts.span } : {}),
      },
    };

    this.fields.push(field);
    return this;
  }

  build(): FormDefinition {
    return {
      id: this.id,
      name: this.name,
      fields: this.fields.map(({ group: _g, condition: _c, ...field }) => field),
      layout: this.formLayout,
      description: this.description,
      version: this.version,
    };
  }
}

export interface FieldBuilderOptions {
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
  placeholder?: string;
  options?: FieldOption[];
  elementType?: string;
  relationTarget?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  patternMessage?: string;
  hidden?: boolean;
  readOnly?: boolean;
  /** 栅格跨度 (1-24) */
  span?: number;
  extra?: Record<string, unknown>;
}

export interface FieldCondition {
  fieldKey: string;
  operator: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'notIn';
  value: unknown;
}
