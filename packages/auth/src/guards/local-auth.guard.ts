import type { Type, CanActivate } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export interface LocalAuthGuardOptions {
  message?: string;
  /** Preserve infrastructure/strategy errors instead of disguising them as bad credentials. */
  errorPolicy?: 'unauthorized' | 'preserve';
}

export function createLocalAuthGuard(options: string | LocalAuthGuardOptions = 'Invalid username or password'): Type<CanActivate> {
  const { message = 'Invalid username or password', errorPolicy = 'unauthorized' } = typeof options === 'string' ? { message: options } : options;
  @Injectable()
  class LocalAuthGuard extends AuthGuard('local') {
    handleRequest<T>(error: Error | null, user: T | false): T {
      if (error && errorPolicy === 'preserve') throw error;
      if (error || !user) throw new UnauthorizedException(message);
      return user;
    }
  }
  return LocalAuthGuard;
}
