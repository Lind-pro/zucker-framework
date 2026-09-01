import { SetMetadata } from '@nestjs/common';

export type CascadeAction = 'restrict' | 'cascade' | 'set-null' | 'no-action';

export interface CascadeDeleteConfig {
  /** 数据类型 */
  dataType: string;
  /** 删除策略 */
  action: CascadeAction;
}

export const CASCADE_DELETE_KEY = 'zucker:reference:cascadeDelete';

/**
 * 级联删除策略配置装饰器
 */
export const CascadeDeleteStrategy = (config: CascadeDeleteConfig) =>
  SetMetadata(CASCADE_DELETE_KEY, config);
