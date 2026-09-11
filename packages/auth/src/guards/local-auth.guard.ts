import type { Type, CanActivate } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export function createLocalAuthGuard(message = 'Invalid username or password'): Type<CanActivate> {
  @Injectable()
  class LocalAuthGuard extends AuthGuard('local') {
    handleRequest<T>(error: Error | null, user: T | false): T {
      if (error || !user) throw new UnauthorizedException(message);
      return user;
    }
  }
  return LocalAuthGuard;
}
