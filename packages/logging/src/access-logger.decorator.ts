import { SetMetadata } from '@nestjs/common';

export const ACCESS_LOGGER_KEY = 'zucker:logging:accessLogger';

export interface AccessLoggerOptions {
  /** 操作描述，例如："生成软件名称"、"创建软件" */
  describe: string;
  /** 操作名称（可选，默认使用方法名） */
  action?: string;
  /** 所属模块（可选） */
  module?: string;
  /** 目标类型（可选），例如："Software"、"User" */
  targetType?: string;
  /** 是否记录请求参数（默认 true） */
  logParameters?: boolean;
  /** 是否记录响应结果（默认 false） */
  logResult?: boolean;
  /** 额外需要脱敏的字段（与内置敏感字段合并，不会替换内置列表） */
  excludeFields?: string[];
  /**
   * 是否忽略日志记录
   * 设置为 true 则跳过该类或方法的日志记录
   */
  ignore?: boolean;
  /**
   * 忽略的参数名列表
   * 使用 '*' 表示忽略全部参数，或指定具体参数名
   */
  ignoreParameter?: string[];
}

/**
 * 业务日志装饰器
 *
 * 支持类级别和方法级别组合。
 * - 类级别设置默认的 module / describe
 * - 方法级别可覆盖或补充
 *
 * AccessLoggerInterceptor 使用 Reflector.getAllAndOverride 合并两级元数据。
 *
 * 用法：
 * ```typescript
 * @AccessLogger({ describe: '软件管理', module: 'software' })
 * @Controller('software')
 * class SoftwareController {
 *
 *   @AccessLogger('创建软件')
 *   @Post()
 *   async create(@Body() dto: CreateSoftwareDto) { ... }
 * }
 * ```
 */
export const AccessLogger = (
  options: string | AccessLoggerOptions,
): ClassDecorator & MethodDecorator => {
  const metadata: AccessLoggerOptions =
    typeof options === 'string' ? { describe: options } : options;
  return SetMetadata(ACCESS_LOGGER_KEY, metadata);
};
