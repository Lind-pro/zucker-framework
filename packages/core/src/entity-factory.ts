import { generateId } from './id-generator';

/**
 * 实体工厂接口
 *
 * 职责：ID 生成、默认值填充、类型转换。
 * 允许全局或按实体类型定制实体创建逻辑。
 */
export interface EntityFactory<T = Record<string, unknown>> {
  /**
   * 创建实体实例，自动填充 ID 和默认值
   * @param data 用户提供的数据（可能不含 id）
   * @returns 填充完毕的实体数据
   */
  create(data: Partial<T>): T;

  /**
   * 生成实体 ID
   */
  generateId(): string;
}

/**
 * ID 生成策略
 */
export type IdGenerator = () => string;

/**
 * 默认实体工厂
 *
 * - 如果 data 没有 id，自动生成
 * - 如果 data 没有 createdAt/updatedAt，自动填充当前时间
 * - 支持自定义 ID 生成策略
 */
export class DefaultEntityFactory<T extends Record<string, any> = Record<string, unknown>> implements EntityFactory<T> {
  private readonly idGenerator: IdGenerator;
  private readonly defaults: Partial<T>;

  constructor(options?: {
    idGenerator?: IdGenerator;
    defaults?: Partial<T>;
  }) {
    this.idGenerator = options?.idGenerator ?? generateId;
    this.defaults = options?.defaults ?? ({} as Partial<T>);
  }

  create(data: Partial<T>): T {
    const now = new Date();
    return {
      ...this.defaults,
      id: this.generateId(),
      createdAt: now,
      updatedAt: now,
      ...data,  // 用户提供的值优先
    } as unknown as T;
  }

  generateId(): string {
    return this.idGenerator();
  }
}
