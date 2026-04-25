import { z } from 'zod/v4';

/**
 * 类型安全配置系统
 *
 * 对标 Claude Code 的 6-layer config merge + source tracking:
 * 使用 Zod schema 同时提供运行时验证和编译时类型推断。
 *
 * 用法:
 * ```ts
 * const AppConfig = defineConfig({
 *   jwt: z.object({
 *     secret: z.string().min(16),
 *     expiresIn: z.string().default('7d'),
 *   }),
 *   database: z.object({
 *     url: z.string().url().optional(),
 *     maxConnections: z.number().default(10),
 *   }),
 * });
 *
 * // 类型安全的访问
 * const config = AppConfig.parse({ jwt: { secret: '...' } });
 * config.jwt.expiresIn; // string，自动推断
 *
 * // 分层合并
 * const merged = mergeConfigs(defaults, envOverrides, runtimeOverrides);
 * ```
 */

/**
 * 定义配置 schema（快捷方式，等价于 z.object()）
 */
export function defineConfig<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape);
}

/**
 * 配置源，用于追踪每个值的来源
 */
export interface ConfigSource {
  /** 来源名称（如 'defaults', 'env', 'database', 'runtime'） */
  name: string;
  /** 来源优先级（数字越大优先级越高） */
  priority: number;
}

/**
 * 深度合并多个配置对象（高优先级覆写低优先级）
 *
 * 对标 Claude Code 的 mergeWith(base, overlay, settingsMergeCustomizer)
 */
export function mergeConfigs<T extends Record<string, unknown>>(
  ...layers: Array<Partial<T> | undefined>
): T {
  const result: Record<string, unknown> = {};

  for (const layer of layers) {
    if (!layer) continue;
    deepMerge(result, layer);
  }

  return result as T;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (sourceVal === undefined) continue;

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      target[key] = sourceVal;
    }
  }
}

/**
 * 从环境变量加载配置
 *
 * 约定：使用 UPPER_SNAKE_CASE 前缀 + 双下划线分隔嵌套层级
 *
 * @example
 * JWT__SECRET=xxx → { jwt: { secret: 'xxx' } }
 * DATABASE__MAX_CONNECTIONS=10 → { database: { maxConnections: '10' } }
 */
export function loadFromEnv(
  prefix: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const prefixUpper = prefix.toUpperCase() + '__';

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefixUpper) || value === undefined) continue;

    const path = key
      .slice(prefixUpper.length)
      .toLowerCase()
      .split('__')
      .map((segment) =>
        // UPPER_SNAKE → camelCase
        segment.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      );

    let current = result;
    for (let i = 0; i < path.length - 1; i++) {
      if (!(path[i] in current) || typeof current[path[i]] !== 'object') {
        current[path[i]] = {};
      }
      current = current[path[i]] as Record<string, unknown>;
    }
    current[path[path.length - 1]] = value;
  }

  return result;
}

/**
 * 安全解析配置（不抛异常，返回 { success, data, errors }）
 */
export function safeParseConfig<T extends z.ZodType>(
  schema: T,
  data: unknown,
): { success: true; data: z.infer<T> } | { success: false; errors: string[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  return { success: false, errors };
}
