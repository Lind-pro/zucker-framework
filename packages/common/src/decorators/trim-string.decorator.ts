import { Transform } from 'class-transformer';

/**
 * 字符串字段预处理装饰器
 *
 * - trim 前后空白
 * - 空字符串 / 纯空白字符串 → undefined
 *
 * 配合 @IsOptional() 使用时：前端发 "" → 视为未提供，跳过后续验证
 * 配合 @IsNotEmpty() 使用时：前端发 "" → undefined → 触发 "不能为空" 错误
 */
export function TrimString() {
  return Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  });
}
