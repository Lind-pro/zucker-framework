import {
  AbstractTaskExecutor,
  RuleConstants,
  type TaskExecutionContext,
  type TaskExecutor,
  type TaskExecutorProvider,
} from '../core/task-executor';
import type { RuleData } from '../core/rule-data';

/**
 * 字段映射定义 — 对齐 jetlinks DataMappingTaskExecutorProvider.Mapping
 */
export interface DataMapping {
  /** 目标字段名 */
  target: string;
  /** 源字段名或表达式（支持 ${expr} 模板） */
  source: string;
  /** 目标类型（可选，用于类型转换） */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'date';
}

/**
 * 数据映射配置 — 对齐 jetlinks DataMappingTaskExecutorProvider.Config
 */
export interface DataMappingConfig {
  /** 字段映射列表 */
  mappings: DataMapping[];
  /** 是否保留源数据字段（默认 false） — 对齐 jetlinks keepSourceData */
  keepSourceData?: boolean;
}

/**
 * 类型转换 — 对齐 jetlinks Mapping.getTypeClass() + converter.convert()
 */
function convertType(value: unknown, type: string): unknown {
  switch (type) {
    case 'string':
      return String(value);
    case 'number':
    case 'double':
    case 'decimal':
      return Number(value);
    case 'integer':
    case 'int':
      return Math.round(Number(value));
    case 'boolean':
      return Boolean(value);
    case 'date':
      return value instanceof Date ? value : new Date(String(value));
    default:
      return value;
  }
}

/**
 * 获取嵌套属性值 — 支持点分路径
 */
function getNestedValue(data: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) {
    return data[path];
  }
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 表达式解析 — 对齐 jetlinks ExpressionUtils.analytical()
 * 支持 ${key} 模板
 */
function resolveExpression(
  source: string,
  data: Record<string, unknown>,
): unknown {
  if (source.includes('${')) {
    const result = source.replace(/\$\{([^}]+)}/g, (_, path: string) => {
      const value = getNestedValue(data, path.trim());
      return value !== undefined && value !== null ? String(value) : '';
    });
    return result;
  }
  return getNestedValue(data, source);
}

/**
 * 数据映射任务执行器 — 对齐 jetlinks DataMappingTaskExecutor
 */
class DataMappingTaskExecutor extends AbstractTaskExecutor {
  private config!: DataMappingConfig;

  constructor(context: TaskExecutionContext) {
    super(context);
    this.loadConfig();
  }

  getName(): string {
    return 'data-mapping';
  }

  validate(): void {
    const cfg = this.context.getConfiguration() as unknown as DataMappingConfig;
    if (!cfg.mappings || !Array.isArray(cfg.mappings) || cfg.mappings.length === 0) {
      throw new Error('At least one mapping is required');
    }
    for (const m of cfg.mappings) {
      if (!m.target || m.target.trim().length === 0) {
        throw new Error('Mapping target is required');
      }
      if (!m.source || m.source.trim().length === 0) {
        throw new Error('Mapping source is required');
      }
    }
  }

  protected async doStart(): Promise<(() => void) | undefined> {
    return undefined;
  }

  /**
   * 执行数据映射 — 对齐 jetlinks Config.mapping()
   */
  async execute(data: RuleData): Promise<void> {
    const sourceData = data.data as Record<string, unknown>;
    const newData: Record<string, unknown> = {};

    // 保留源数据 — 对齐 jetlinks keepSourceData
    if (this.config.keepSourceData) {
      Object.assign(newData, sourceData);
    }

    for (const mapping of this.config.mappings) {
      let value = resolveExpression(mapping.source, sourceData);
      if (value !== undefined && value !== null && mapping.type) {
        value = convertType(value, mapping.type);
      }
      if (value !== undefined && value !== null) {
        newData[mapping.target] = value;
      }
    }

    const ruleData = this.context.newRuleDataFrom(data, newData);
    await this.context.fireEvent(RuleConstants.Event.result, ruleData);
  }

  reload(): void {
    this.loadConfig();
    super.reload();
  }

  private loadConfig(): void {
    this.config = this.context.getConfiguration() as unknown as DataMappingConfig;
  }
}

/**
 * 数据映射任务执行器提供者 — 对齐 jetlinks DataMappingTaskExecutorProvider
 */
export class DataMappingExecutorProvider implements TaskExecutorProvider {
  static readonly EXECUTOR = 'data-mapping';

  getExecutor(): string {
    return DataMappingExecutorProvider.EXECUTOR;
  }

  async createTask(context: TaskExecutionContext): Promise<TaskExecutor> {
    return new DataMappingTaskExecutor(context);
  }
}
