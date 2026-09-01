import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Inject,
  Logger,
} from '@nestjs/common';

export const CONFIG_SCOPE_REGISTRY = 'CONFIG_SCOPE_REGISTRY';

export interface ConfigScopeEntry {
  name: string;
  publicAccess: boolean;
}

/**
 * ConfigGuard — 配置访问守卫
 *
 * 检查请求的 scope 是否标记为 publicAccess，
 * 如果是公开的则跳过认证，否则要求请求已认证。
 */
@Injectable()
export class ConfigGuard implements CanActivate {
  private readonly logger = new Logger(ConfigGuard.name);

  constructor(
    @Inject(CONFIG_SCOPE_REGISTRY)
    private readonly scopeRegistry: Map<string, ConfigScopeEntry>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // 从请求参数或查询中提取 scope
    const scope: string | undefined =
      request.params?.scope ?? request.query?.scope;

    if (!scope) {
      // 没有指定 scope，需要认证
      return this.isAuthenticated(request);
    }

    const entry = this.scopeRegistry.get(scope);
    if (entry?.publicAccess) {
      this.logger.debug(`公开访问 scope: ${scope}`);
      return true;
    }

    return this.isAuthenticated(request);
  }

  private isAuthenticated(request: { user?: unknown }): boolean {
    // 检查请求中是否携带用户信息（由上游认证中间件设置）
    return !!request.user;
  }
}
