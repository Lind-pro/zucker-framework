import { SetMetadata } from '@nestjs/common';

export const PREVENT_DELETE_IF_REFERENCED = 'zucker:reference:preventDeleteIfReferenced';

/**
 * 装饰器：如果存在引用关系则阻止删除
 * 用于 Controller 的 delete 方法上，配合 ReferenceGuard 使用
 */
export const PreventDeleteIfReferenced = (dataType: string) =>
  SetMetadata(PREVENT_DELETE_IF_REFERENCED, dataType);
