/**
 * CORS 配置
 *
 * CorsProperties 定义路径级 CORS 配置：
 *   - allowedOrigins / allowedMethods / allowedHeaders / exposedHeaders
 *   - allowCredentials / maxAge
 *   - 支持多路径规则 (configs 数组)
 *   - 未配置时使用默认值 (origins=*, methods=[GET,HEAD,POST], credentials=true, maxAge=1800)
 *
 * 提供配置接口和 NestJS 适配的 buildCorsOptions() 工厂方法。
 */

export interface CorsPathConfig {
  /** 匹配路径，默认 '/**' (全匹配) */
  path?: string;
  /** 允许的来源 */
  allowedOrigins?: string[];
  /** 允许的 HTTP 方法 */
  allowedMethods?: string[];
  /** 允许的请求头 */
  allowedHeaders?: string[];
  /** 暴露给浏览器的响应头 */
  exposedHeaders?: string[];
  /** 是否允许携带凭证 */
  allowCredentials?: boolean;
  /** 预检请求缓存时间（秒） */
  maxAge?: number;
}

export interface CorsProperties {
  /** 是否启用 CORS */
  enable: boolean;
  /** 路径级 CORS 配置列表 */
  configs?: CorsPathConfig[];
}

/**
 * 默认 CORS 配置
 */
export const DEFAULT_CORS_CONFIG: Required<CorsPathConfig> = {
  path: '/**',
  allowedOrigins: ['*'],
  allowedMethods: ['GET', 'HEAD', 'POST'],
  allowedHeaders: ['*'],
  exposedHeaders: [],
  allowCredentials: true,
  maxAge: 1800,
};

/**
 * 合并用户配置与默认值
 */
export function mergeCorsConfig(config: CorsPathConfig): Required<CorsPathConfig> {
  return {
    path: config.path ?? DEFAULT_CORS_CONFIG.path,
    allowedOrigins: config.allowedOrigins ?? DEFAULT_CORS_CONFIG.allowedOrigins,
    allowedMethods: config.allowedMethods ?? DEFAULT_CORS_CONFIG.allowedMethods,
    allowedHeaders: config.allowedHeaders ?? DEFAULT_CORS_CONFIG.allowedHeaders,
    exposedHeaders: config.exposedHeaders ?? DEFAULT_CORS_CONFIG.exposedHeaders,
    allowCredentials: config.allowCredentials ?? DEFAULT_CORS_CONFIG.allowCredentials,
    maxAge: config.maxAge ?? DEFAULT_CORS_CONFIG.maxAge,
  };
}

/**
 * 将 CorsProperties 转换为 NestJS 兼容的 CORS 选项对象。
 *
 * 若 configs 为空，使用 DEFAULT_CORS_CONFIG。
 * 多路径规则时返回第一个配置（NestJS enableCors 只支持单一规则）。
 *
 * @example
 * ```ts
 * const app = await NestFactory.create(AppModule);
 * app.enableCors(buildCorsOptions({ enable: true, configs: [...] }));
 * ```
 */
export function buildCorsOptions(properties: CorsProperties): {
  origin: string[] | boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: boolean;
  maxAge: number;
} | false {
  if (!properties.enable) {
    return false;
  }

  const configs = properties.configs?.length
    ? properties.configs
    : [DEFAULT_CORS_CONFIG];

  const merged = mergeCorsConfig(configs[0]);

  // NestJS CORS: origin 为 ['*'] 时应设为 true
  const originIsWildcard =
    merged.allowedOrigins.length === 1 && merged.allowedOrigins[0] === '*';

  return {
    origin: originIsWildcard ? true : merged.allowedOrigins,
    methods: merged.allowedMethods,
    allowedHeaders: merged.allowedHeaders,
    exposedHeaders: merged.exposedHeaders,
    credentials: merged.allowCredentials,
    maxAge: merged.maxAge,
  };
}
