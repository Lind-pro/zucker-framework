// 从后端 @zucker-framework/form 提取的纯 TypeScript 类型（无 NestJS 装饰器）

export enum FieldType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  DATE = 'date',
  DATETIME = 'datetime',
  ENUM = 'enum',
  RELATION = 'relation',
  FILE = 'file',
  JSON = 'json',
  ARRAY = 'array',
}

export interface FieldOption {
  label: string;
  value: string | number | boolean;
  children?: FieldOption[];
}

export interface FieldValidator {
  type: string;
  message: string;
  params?: Record<string, unknown>;
}

export interface FieldDefinition {
  key: string;
  name: string;
  type: FieldType | string;
  required?: boolean;
  defaultValue?: unknown;
  options?: FieldOption[];
  validators?: FieldValidator[];
  description?: string;
  relationTarget?: string;
  elementType?: FieldType | string;
  extra?: Record<string, unknown>;
}

export interface FormLayout {
  columns?: number;
  labelWidth?: number | string;
  /** Server spelling (`@zucker-framework/form`). `top` renders a vertical form. */
  labelPosition?: 'top' | 'left' | 'right';
  /** Legacy client spelling; `labelPosition` is preferred. */
  labelAlign?: 'left' | 'right';
}

export interface FormDefinition {
  id: string;
  name: string;
  fields: FieldDefinition[];
  layout?: FormLayout;
  description?: string;
  version?: number;
}
