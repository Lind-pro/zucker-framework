import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TWO_FACTOR_KEY } from '../decorators/constants';
import type { TwoFactorOptions } from '../decorators';
import { TwoFactorService } from '../two-factor/two-factor.service';

/**
 * TwoFactorGuard — 双因素认证守卫
 *
 * 消费 @TwoFactor 装饰器的元数据，在请求进入 handler 前
 * 验证双因素认证码。
 *
 * 支持类级别和方法级别组合（方法级别优先）。
 */
@Injectable()
export class TwoFactorGuard implements CanActivate {
  private readonly logger = new Logger(TwoFactorGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly twoFactorService: TwoFactorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<TwoFactorOptions | undefined>(
      TWO_FACTOR_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options || options.ignore) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      return true; // Let auth guards handle unauthenticated users
    }

    const parameterName = options.parameter ?? 'verifyCode';
    const provider = options.provider ?? 'default';
    const validator = this.twoFactorService.getValidator(
      user.id,
      options.operation,
      provider,
    );
    if (!validator) {
      throw new ForbiddenException(
        options.message ?? '验证码错误或已过期',
      );
    }

    if (!(await validator.expired())) {
      return true;
    }

    const code =
      request.body?.[parameterName] ??
      request.query?.[parameterName] ??
      request.headers?.[parameterName] ??
      request.headers?.['x-verify-code'];

    if (!code) {
      throw new ForbiddenException('validation.need_two_factor_verify');
    }

    const isValid = await validator.verify(
      String(code),
      options.timeout ?? 10 * 60 * 1000,
    );

    if (!isValid) {
      this.logger.warn(
        `Two-factor validation failed for user ${user.username ?? user.id}, operation: ${options.operation}`,
      );
      throw new ForbiddenException(
        options.message ?? '验证码错误或已过期',
      );
    }

    return true;
  }
}
